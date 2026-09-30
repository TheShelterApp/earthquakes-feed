import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FETCH_LIMIT,
  FETCH_TIMEOUT_MS,
  HOT_WINDOW_DAYS,
  LIVE_INDEX_DAYS,
  SWEEP_EPOCH,
  SWEEP_MAX_PAGES,
  SWEEP_OVERLAP_MS,
  SWEEP_PAGE_OVERLAP,
  SWEEP_TIMEOUT_MS,
  dataPaths,
} from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { parseGeoJSON } from '../src/fdsn.js';
import { LogBuffer } from '../src/oplog.js';
import { type Fetcher, configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { byIngestOrder } from '../src/quality.js';
import { revisionSweep } from '../src/sweep.js';
import {
  type SweepCursor,
  type SweepSpec,
  fetchRunInputs,
  loadSweepCursors,
  nextCursors,
  runSweep,
  saveSweepCursors,
  sweepOriginFloorMs,
  sweepSpecs,
  sweepWindow,
} from '../src/sweep-cursor.js';
import type { EventNode, ProviderConfig } from '../src/types.js';
import type { FetchResult } from '../src/util.js';

// PF-5c: each sweep (usgs:updated, emsc:updated, usgs:deleted) has a cursor of its own that only a
// complete sweep advances, to the query's upper bound; a failed window is asked for again; a sweep
// pages when a page is full; the one-time 7-day catch-up (SWEEP_EPOCH) runs once; the sweeps go
// out before the live fetches, with their own budget.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const byId = (id: string): ProviderConfig => registry.find((p) => p.id === id)!;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-30T16:00:00Z');
const FLOOR = sweepOriginFloorMs(NOW, LIVE_INDEX_DAYS);
const iso = (ms: number): string => new Date(ms).toISOString();
/** The FDSN query time format (no fraction, no zone). */
const fdsn = (ms: number): string => iso(ms).slice(0, 19);
const USGS_UPDATED: SweepSpec = { provider: byId('usgs'), kind: 'updated' };
const USGS_DELETED: SweepSpec = { provider: byId('usgs'), kind: 'deleted' };
const EMSC_UPDATED: SweepSpec = { provider: byId('emsc'), kind: 'updated' };

/** A ComCat GeoJSON feature. */
function feature(id: string, originMs: number, updatedMs = NOW - 60_000, mag = 3.1): unknown {
  return {
    type: 'Feature',
    id,
    properties: { mag, place: 'somewhere', time: originMs, updated: updatedMs, status: 'reviewed', magType: 'ml', ids: `,${id},` },
    geometry: { type: 'Point', coordinates: [-112.5, 38.5, 5] },
  };
}
const body = (features: unknown[]): string => JSON.stringify({ type: 'FeatureCollection', features });
/** `n` distinct features numbered from `from`. */
const features = (from: number, n: number): unknown[] => Array.from({ length: n }, (_, i) => feature(`uu${String(from + i).padStart(8, '0')}`, NOW - DAY - (from + i) * 1000));

interface Call {
  url: URL;
  timeoutMs: number;
}
/** A fetcher that records every request and answers with `respond`. */
function recorder(respond: (url: URL, n: number) => FetchResult | Error): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, timeoutMs) => {
    const u = new URL(url);
    calls.push({ url: u, timeoutMs });
    const r = respond(u, calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetcher, calls };
}
const ok = (b: string): FetchResult => ({ status: 200, body: b, latencyMs: 5 });

test('a run makes three sweeps, in this order: usgs:updated, emsc:updated, usgs:deleted', () => {
  const specs = sweepSpecs(registry.filter((p) => p.active));
  assert.deepEqual(
    specs.map((s) => `${s.provider.id}:${s.kind}`),
    ['usgs:updated', 'emsc:updated', 'usgs:deleted'],
  );
});

test('catch-up: with no cursor the first sweep asks from now − HOT_WINDOW_DAYS over a fixed origin floor, and a complete one records the epoch', async () => {
  const { fetcher, calls } = recorder(() => ok(body(features(0, 3))));
  const run = await runSweep(USGS_UPDATED, undefined, { nowMs: NOW, originFloorMs: FLOOR, fetcher, clock: () => NOW });
  assert.equal(calls.length, 1);
  const q = calls[0]!.url.searchParams;
  assert.equal(q.get('updatedafter'), fdsn(NOW - HOT_WINDOW_DAYS * DAY));
  assert.equal(q.get('starttime'), fdsn(NOW - (LIVE_INDEX_DAYS + 1) * DAY), 'every loaded event-map day is inside the origin floor');
  assert.equal(q.get('limit'), String(FETCH_LIMIT));
  assert.equal(q.get('offset'), null, 'the first page asks from the first record');
  assert.equal(q.get('orderby'), 'time', "ComCat's own params still apply");
  assert.equal(q.get('includedeleted'), null);
  assert.equal(run.complete, true);
  assert.equal(run.catchUp, true);
  assert.deepEqual(run.cursor, { through: iso(NOW), epoch: SWEEP_EPOCH });
  assert.equal(run.status.catch_up, true);
  assert.equal(run.status.since, iso(NOW - HOT_WINDOW_DAYS * DAY));
  assert.equal(run.status.through, iso(NOW));
  assert.equal(run.status.epoch, SWEEP_EPOCH);
  assert.equal(run.status.pages, 1);
  assert.equal(run.status.events_returned, 3);
  assert.equal(run.obs.length, 3);
});

test('the catch-up runs once: the next run asks from its cursor (less the overlap); an older epoch catches up again', async () => {
  const cursor: SweepCursor = { through: iso(NOW - 300_000), epoch: SWEEP_EPOCH };
  assert.deepEqual(sweepWindow(cursor, NOW, FLOOR), { sinceMs: NOW - 300_000 - SWEEP_OVERLAP_MS, catchUp: false });
  assert.deepEqual(sweepWindow(undefined, NOW, FLOOR), { sinceMs: NOW - HOT_WINDOW_DAYS * DAY, catchUp: true });
  assert.deepEqual(sweepWindow({ ...cursor, epoch: SWEEP_EPOCH - 1 }, NOW, FLOOR), { sinceMs: NOW - HOT_WINDOW_DAYS * DAY, catchUp: true });
  // A cursor far behind (sweeps failing for weeks) is held at the origin floor; one ahead of this clock at now − overlap.
  assert.equal(sweepWindow({ through: iso(NOW - 40 * DAY), epoch: SWEEP_EPOCH }, NOW, FLOOR).sinceMs, FLOOR);
  assert.equal(sweepWindow({ through: iso(NOW + 3_600_000), epoch: SWEEP_EPOCH }, NOW, FLOOR).sinceMs, NOW - SWEEP_OVERLAP_MS);

  // Two runs through the persisted file: the first is the catch-up, the second is not.
  const root = mkdtempSync(join(tmpdir(), 'sweeps-'));
  try {
    assert.deepEqual(loadSweepCursors(root), {});
    const { fetcher, calls } = recorder(() => ok(body([])));
    const first = await runSweep(USGS_UPDATED, loadSweepCursors(root)['usgs:updated'], { nowMs: NOW, originFloorMs: FLOOR, fetcher, clock: () => NOW });
    saveSweepCursors(root, nextCursors(loadSweepCursors(root), [first]));
    assert.deepEqual(JSON.parse(readFileSync(dataPaths(root).sweepCursors, 'utf8')), { 'usgs:updated': { through: iso(NOW), epoch: SWEEP_EPOCH } });
    const later = NOW + 300_000;
    const second = await runSweep(USGS_UPDATED, loadSweepCursors(root)['usgs:updated'], { nowMs: later, originFloorMs: FLOOR + 300_000, fetcher, clock: () => later });
    assert.equal(second.catchUp, false);
    assert.equal(second.status.catch_up, undefined);
    assert.equal(calls[1]!.url.searchParams.get('updatedafter'), fdsn(NOW - SWEEP_OVERLAP_MS));
    assert.deepEqual(second.cursor, { through: iso(later), epoch: SWEEP_EPOCH });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the cursor advances only when the sweep completes: an HTTP error or an abort keeps it', async () => {
  const cursor: SweepCursor = { through: iso(NOW - 600_000), epoch: SWEEP_EPOCH };
  for (const answer of [{ status: 503, body: '', latencyMs: 40 } as FetchResult, new Error('This operation was aborted')]) {
    const { fetcher } = recorder(() => answer);
    const run = await runSweep(USGS_DELETED, cursor, { nowMs: NOW, originFloorMs: FLOOR, fetcher, clock: () => NOW });
    assert.equal(run.complete, false);
    assert.equal(run.status.ok, false);
    assert.equal(run.status.error, answer instanceof Error ? answer.message : 'HTTP 503');
    assert.deepEqual(run.cursor, cursor, 'unchanged');
    assert.equal(run.status.through, cursor.through);
    assert.deepEqual(nextCursors({ 'usgs:deleted': cursor }, [run]), { 'usgs:deleted': cursor });
  }
  // undici's generic error names its cause in the status.
  const reset = recorder(() => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
  const r = await runSweep(EMSC_UPDATED, cursor, { nowMs: NOW, originFloorMs: FLOOR, fetcher: reset.fetcher, clock: () => NOW });
  assert.equal(r.status.error, 'fetch failed (UND_ERR_SOCKET other side closed)');
  assert.deepEqual(r.cursor, cursor);
  // A first sweep that fails leaves no cursor at all, so the catch-up is still due.
  const { fetcher } = recorder(() => new Error('This operation was aborted'));
  const run = await runSweep(USGS_UPDATED, undefined, { nowMs: NOW, originFloorMs: FLOOR, fetcher, clock: () => NOW });
  assert.equal(run.cursor, undefined);
  assert.equal(run.status.through, null);
  assert.equal(run.status.catch_up, true);
  assert.deepEqual(nextCursors({}, [run]), {});
});

test('a failed window is asked for again: the next run starts where the failed one did, and its success moves the cursor to its own bound', async () => {
  const cursor: SweepCursor = { through: iso(NOW - 900_000), epoch: SWEEP_EPOCH };
  const failing = recorder(() => new Error('This operation was aborted'));
  const a = await runSweep(EMSC_UPDATED, cursor, { nowMs: NOW, originFloorMs: FLOOR, fetcher: failing.fetcher, clock: () => NOW });
  const later = NOW + 300_000;
  const working = recorder(() => ok(JSON.stringify({ type: 'FeatureCollection', features: [] })));
  const b = await runSweep(EMSC_UPDATED, a.cursor, { nowMs: later, originFloorMs: FLOOR + 300_000, fetcher: working.fetcher, clock: () => later });
  const since = (c: Call): string | null => c.url.searchParams.get('updatedafter');
  assert.equal(since(failing.calls[0]!), fdsn(NOW - 900_000 - SWEEP_OVERLAP_MS));
  assert.equal(since(working.calls[0]!), since(failing.calls[0]!), 'the same window, not one the live rows moved past');
  assert.deepEqual(b.cursor, { through: iso(later), epoch: SWEEP_EPOCH });
});

test('paging: a full page asks for the next one (overlapping by SWEEP_PAGE_OVERLAP, same updatedafter and origin floor) until a short page', async () => {
  const step = FETCH_LIMIT - SWEEP_PAGE_OVERLAP;
  const { fetcher, calls } = recorder((u) => {
    const offset = Number(u.searchParams.get('offset') ?? 1);
    // 5,000 + 4,900 + 1,000 records in all (0-based index = offset − 1); a full page is FETCH_LIMIT.
    const total = 2 * step + 1_000 + SWEEP_PAGE_OVERLAP;
    const from = offset - 1;
    return ok(body(features(from, Math.min(FETCH_LIMIT, total - from))));
  });
  const run = await runSweep(USGS_UPDATED, { through: iso(NOW - 300_000), epoch: SWEEP_EPOCH }, { nowMs: NOW, originFloorMs: FLOOR, fetcher, clock: () => NOW });
  assert.deepEqual(
    calls.map((c) => c.url.searchParams.get('offset')),
    [null, String(1 + step), String(1 + 2 * step)],
  );
  for (const c of calls) {
    assert.equal(c.url.searchParams.get('updatedafter'), calls[0]!.url.searchParams.get('updatedafter'));
    assert.equal(c.url.searchParams.get('starttime'), fdsn(FLOOR));
  }
  assert.equal(run.complete, true);
  assert.equal(run.status.pages, 3);
  assert.equal(run.obs.length, 2 * step + 1_000 + SWEEP_PAGE_OVERLAP, 'the overlapping records once each');
  assert.equal(run.status.events_returned, run.obs.length);
});

test('paging: a failed second page keeps the cursor but hands on the first page; a sweep past SWEEP_MAX_PAGES is unfinished', async () => {
  const cursor: SweepCursor = { through: iso(NOW - 300_000), epoch: SWEEP_EPOCH };
  const failing = recorder((_u, n) => (n === 1 ? ok(body(features(0, FETCH_LIMIT))) : new Error('This operation was aborted')));
  const a = await runSweep(USGS_UPDATED, cursor, { nowMs: NOW, originFloorMs: FLOOR, fetcher: failing.fetcher, clock: () => NOW });
  assert.equal(a.complete, false);
  assert.deepEqual(a.cursor, cursor);
  assert.equal(a.status.error, 'page 2: This operation was aborted');
  assert.equal(a.obs.length, FETCH_LIMIT, 'rows that arrived are applied (a re-read changes nothing)');

  const endless = recorder((u) => ok(body(features(Number(u.searchParams.get('offset') ?? 1) - 1, FETCH_LIMIT))));
  const b = await runSweep(USGS_UPDATED, cursor, { nowMs: NOW, originFloorMs: FLOOR, fetcher: endless.fetcher, clock: () => NOW });
  assert.equal(endless.calls.length, SWEEP_MAX_PAGES);
  assert.equal(b.complete, false);
  assert.deepEqual(b.cursor, cursor);
  assert.equal(b.status.error, `unfinished: more than ${SWEEP_MAX_PAGES} pages of ${FETCH_LIMIT}`);
});

test('timeouts per kind: live FDSN fetches keep FETCH_TIMEOUT_MS or their own; a sweep has SWEEP_TIMEOUT_MS for all its pages', async () => {
  assert.ok(SWEEP_TIMEOUT_MS > FETCH_TIMEOUT_MS);
  const live = ['usgs', 'emsc', 'geofon', 'resif'].map(byId);
  const { fetcher, calls } = recorder(() => ok(body([])));
  const specs = sweepSpecs(live);
  await fetchRunInputs(live, specs, {}, { nowMs: NOW, originFloorMs: FLOOR, fetcher, clock: () => NOW });
  const isSweep = (c: Call): boolean => c.url.searchParams.has('updatedafter');
  const timeouts = calls.map((c) => [isSweep(c) ? `sweep ${c.url.hostname}` : `live ${c.url.hostname}`, c.timeoutMs]);
  assert.deepEqual(timeouts, [
    ['sweep earthquake.usgs.gov', SWEEP_TIMEOUT_MS],
    ['sweep www.seismicportal.eu', SWEEP_TIMEOUT_MS],
    ['sweep earthquake.usgs.gov', SWEEP_TIMEOUT_MS],
    ['live earthquake.usgs.gov', FETCH_TIMEOUT_MS],
    ['live www.seismicportal.eu', FETCH_TIMEOUT_MS],
    ['live geofon.gfz.de', FETCH_TIMEOUT_MS],
    ['live ws.resif.fr', byId('resif').timeoutMs],
  ]);

  // Later pages get what is left of the budget; none starts once it is spent.
  let t = NOW;
  const slow = recorder((u) => {
    t += 12_000;
    return ok(body(features(Number(u.searchParams.get('offset') ?? 1) - 1, FETCH_LIMIT)));
  });
  const run = await runSweep(USGS_UPDATED, { through: iso(NOW - 300_000), epoch: SWEEP_EPOCH }, { nowMs: NOW, originFloorMs: FLOOR, fetcher: slow.fetcher, clock: () => t });
  assert.deepEqual(slow.calls.map((c) => c.timeoutMs), [SWEEP_TIMEOUT_MS, SWEEP_TIMEOUT_MS - 12_000, SWEEP_TIMEOUT_MS - 24_000]);
  assert.equal(run.complete, false);
  assert.match(run.status.error ?? '', /budget ran out after 3 page/);
  assert.equal(run.status.latency_ms, 36_000);
});

test('ordering: the sweeps are issued before any live fetch', async () => {
  const live = registry.filter((p) => p.active && p.adapter === 'fdsn' && p.liveActive !== false);
  const { fetcher, calls } = recorder(() => ok(body([])));
  const out = await fetchRunInputs(live, sweepSpecs(live), {}, { nowMs: NOW, originFloorMs: FLOOR, fetcher, clock: () => NOW });
  const kinds = calls.map((c) => (c.url.searchParams.get('includedeleted') === 'only' ? 'deleted' : c.url.searchParams.has('updatedafter') ? 'updated' : 'live'));
  assert.deepEqual(kinds.slice(0, 3), ['updated', 'updated', 'deleted']);
  assert.ok(kinds.slice(3).every((k) => k === 'live'));
  assert.equal(kinds.length, 3 + live.length);
  assert.equal(out.live.length, live.length);
  assert.deepEqual(out.sweeps.map((s) => s.key), ['usgs:updated', 'emsc:updated', 'usgs:deleted']);
});

test('the catch-up lands a missed window once: a late event minted and a revision made in the first run, nothing again from the next', async () => {
  const prio = priorityMap(registry);
  const cfg = configMap(registry);
  const map = new Map<string, EventNode>();
  // The live path saw uu1 at M3.0; the sweep window holds its revision (M3.5) and a late event uu2.
  const seed = new Resolver(map, prio, cfg, NOW - 3 * DAY);
  const uu1Origin = NOW - 3 * DAY;
  const [seen] = parseGeoJSON(body([feature('uu00000001', uu1Origin, uu1Origin + 600_000, 3.0)]), 'usgs');
  seed.ingest(seen!, iso(NOW - 3 * DAY + 600_000));
  const window = body([feature('uu00000001', uu1Origin, NOW - 2 * DAY, 3.5), feature('uu00000002', NOW - 4 * DAY, NOW - DAY, 2.9)]);

  const apply = async (nowMs: number, cursor: SweepCursor | undefined) => {
    const { fetcher, calls } = recorder(() => ok(window));
    const run = await runSweep(USGS_UPDATED, cursor, { nowMs, originFloorMs: sweepOriginFloorMs(nowMs, LIVE_INDEX_DAYS), fetcher, clock: () => nowMs });
    const resolver = new Resolver(map, prio, cfg, nowMs);
    const log = new LogBuffer(1000, iso(nowMs));
    const out = revisionSweep(resolver, log, [...run.obs].sort(byIngestOrder), {}, iso(nowMs));
    return { run, out, calls };
  };
  const first = await apply(NOW, undefined);
  assert.equal(first.run.catchUp, true);
  assert.equal(first.out.revisions, 1);
  assert.deepEqual(first.out.lateMinted.map((m) => m.providerEventId), ['uu00000002']);
  // The next run overlaps the cursor by SWEEP_OVERLAP_MS; here the provider even repeats the whole window.
  const second = await apply(NOW + 300_000, first.run.cursor);
  assert.equal(second.run.catchUp, false);
  assert.equal(second.calls[0]!.url.searchParams.get('updatedafter'), fdsn(NOW - SWEEP_OVERLAP_MS));
  assert.equal(second.out.revisions, 0);
  assert.equal(second.out.lateMinted.length, 0);
});
