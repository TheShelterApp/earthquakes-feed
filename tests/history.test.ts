import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nodeToFeature } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import { type BuildInput, type RawHeader, type RawInput, HistoryBuildError, buildEdition, parseRawText, rawFileText } from '../src/history-build.js';
import {
  type HistoryConfig,
  type HistoryEra,
  allPeriods,
  configProblems,
  dayMs,
  editionAssetName,
  eraPeriods,
  loadHistoryConfig,
  nextEdition,
  nextRawGeneration,
  rawAssetName,
} from '../src/history-config.js';
import { type HttpAnswer, fetchRange, historyQueryUrl, parseRetryAfter } from '../src/history-fetch.js';
import { type HistoryIndex, emptyIndex, indexText, newerNeighbour, parseIndex, pendingUnits, periodsToSeal } from '../src/history-index.js';
import { LocalStore } from '../src/history-store.js';
import { verifyEdition } from '../src/history-verify.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, ProviderConfig, RawObs } from '../src/types.js';

const registry = loadRegistry();
const usgs = registry.find((p) => p.id === 'usgs')!;
const emsc = registry.find((p) => p.id === 'emsc')!;
const geofon = registry.find((p) => p.id === 'geofon')!;

const pilot: HistoryEra = { id: 'pilot', from: '2022-07-01', to: '2023-07-06', minMagnitude: null, sources: ['usgs'] };
const cfgOf = (eras: HistoryEra[], over: Partial<HistoryConfig> = {}): HistoryConfig => ({
  enabled: true,
  boundary: '2023-07-06',
  eras,
  maxUnitsPerRun: 4,
  maxSecondsPerRun: 600,
  requestSpacingMs: 1100,
  timeoutMs: 90_000,
  pageLimits: { usgs: 20000 },
  ...over,
});

// ---------- config ----------

test('history config: the shipped providers/history.json is valid and its switch is a boolean', () => {
  const cfg = loadHistoryConfig();
  assert.deepEqual(configProblems(cfg, registry), []);
  assert.equal(typeof cfg.enabled, 'boolean');
  assert.ok(cfg.requestSpacingMs >= 1000);
});

test('history config: a pilot year is 13 months, newest first, the newest clipped at the boundary', () => {
  const ps = eraPeriods(pilot);
  assert.equal(ps.length, 13);
  assert.equal(ps[0]!.key, '2023-07');
  assert.equal(ps[0]!.startMs, dayMs('2023-07-01'));
  assert.equal(ps[0]!.endMs, dayMs('2023-07-06'));
  assert.equal(ps[1]!.key, '2023-06');
  assert.equal(ps[1]!.endMs, dayMs('2023-07-01'));
  assert.equal(ps.at(-1)!.key, '2022-07');
  assert.equal(ps.at(-1)!.startMs, dayMs('2022-07-01'));
});

test('history config: refuses overlaps, days at or after the boundary, non-FDSN sources and a pace above 1 request/s', () => {
  const problems = configProblems(
    cfgOf(
      [
        { id: 'a', from: '2020-01-01', to: '2023-07-07', minMagnitude: null, sources: ['usgs'] },
        { id: 'b', from: '2021-01-01', to: '2022-01-01', minMagnitude: 4.5, sources: ['afad', 'nope'] },
      ],
      { requestSpacingMs: 500 },
    ),
    registry,
  );
  const text = problems.join('\n');
  assert.match(text, /after the boundary/);
  assert.match(text, /overlap/);
  assert.match(text, /afad is not an FDSN time-range service/);
  assert.match(text, /unknown source nope/);
  assert.match(text, /requestSpacingMs must be at least 1000/);
});

test('history config: eras start and end on month boundaries (only the boundary may cut a month), so no two eras share a YYYY-MM unit', () => {
  const problems = configProblems(
    cfgOf([
      { id: 'a', from: '2022-07-15', to: '2023-07-06', minMagnitude: null, sources: ['usgs'] },
      { id: 'b', from: '2022-01-01', to: '2022-07-15', minMagnitude: 4.5, sources: ['usgs'] },
    ]),
    registry,
  ).join('\n');
  assert.match(problems, /era a: from 2022-07-15 is not the first day of a month/);
  assert.match(problems, /era b: to 2022-07-15 is neither the first day of a month nor the boundary/);
  assert.deepEqual(configProblems(cfgOf([pilot, { id: 'b', from: '2022-01-01', to: '2022-07-01', minMagnitude: 4.5, sources: ['usgs'] }]), registry), []);
});

test('history config: asset names are never reused (next generation / edition)', () => {
  assert.equal(rawAssetName('usgs', '2022-12'), 'raw-usgs-2022-12.ndjson.zst');
  const names = new Set([rawAssetName('usgs', '2022-12'), rawAssetName('usgs', '2022-12', 2), editionAssetName('2022-12', 1)]);
  assert.equal(nextRawGeneration(names, 'usgs', '2022-12'), 3);
  assert.equal(rawAssetName('usgs', '2022-12', 3), 'raw-usgs-2022-12.g3.ndjson.zst');
  assert.equal(nextEdition(names, '2022-12'), 2);
  assert.equal(nextEdition(names, '2022-12', 4), 4);
});

// ---------- fetch ----------

/** A fake source over a fixed list of rows, answering FDSN text (or ComCat count + GeoJSON) for any window. */
function fakeSource(p: ProviderConfig, times: number[], opts: { countSkew?: number; answers?: (url: string) => HttpAnswer | null } = {}) {
  const calls: { url: string; at: number }[] = [];
  let clock = 1_000_000;
  const fetcher = async (url: string): Promise<HttpAnswer> => {
    calls.push({ url, at: clock });
    clock += 100;
    const special = opts.answers?.(url);
    if (special) return special;
    const q = new URL(url).searchParams;
    const s = Date.parse(`${q.get('starttime')}Z`);
    const e = Date.parse(`${q.get('endtime')}Z`);
    const inWin = times.filter((t) => t >= s && t <= e);
    if (url.includes('/count?')) return { status: 200, body: JSON.stringify({ count: inWin.length + (opts.countSkew ?? 0) }), latencyMs: 1, retryAfterMs: null };
    const limit = Number(q.get('limit') ?? Infinity);
    const page = inWin.slice(0, limit);
    if (!page.length) return { status: 204, body: '', latencyMs: 1, retryAfterMs: null };
    if (p.parse === 'geojson') {
      const features = page.map((t) => ({ id: `us${t}`, properties: { time: t, mag: 1.5, place: 'x', updated: t }, geometry: { coordinates: [10, 20, 5] } }));
      return { status: 200, body: JSON.stringify({ features }), latencyMs: 1, retryAfterMs: null };
    }
    const lines = ['#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType'];
    for (const t of page) lines.push(`gf${t}|${new Date(t).toISOString()}|20|10|5|||||ml|1.5||x|earthquake`);
    return { status: 200, body: lines.join('\n'), latencyMs: 1, retryAfterMs: null };
  };
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    opts: {
      fetcher,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  };
}

const S = dayMs('2022-12-01');
const E = dayMs('2023-01-01');

test('history fetch: ComCat is counted first; a window over the page is split before any query; rows equal the counts', async () => {
  const times = Array.from({ length: 50 }, (_, i) => S + i * 13 * 3600_000); // every 13 h across December
  const f = fakeSource(usgs, times);
  const r = await fetchRange(usgs, S, E, { limit: 20, minMagnitude: null, spacingMs: 1100, timeoutMs: 1000, ...f.opts });
  assert.ok(r.ok, !r.ok ? r.error : '');
  if (!r.ok) return;
  assert.equal(r.rows.length, times.filter((t) => t < E).length);
  assert.equal(r.providerCount, r.responseRows);
  assert.ok(r.windows.every((w) => w.count === w.rows && w.rows < 20));
  // The first request is the whole month's count, never a query of 50 rows into a page of 20.
  assert.match(f.calls[0]!.url, /\/count\?/);
  const whole = f.calls.map((c) => decodeURIComponent(c.url)).filter((u) => u.includes('starttime=2022-12-01T00:00:00&endtime=2023-01-01T00:00:00'));
  assert.ok(whole.length >= 1 && whole.every((u) => u.includes('/count?')));
});

test('history fetch: a query whose rows differ from the count fails the whole range (nothing half-kept)', async () => {
  const f = fakeSource(usgs, [S + 1000, S + 2000], { countSkew: 1 });
  const r = await fetchRange(usgs, S, E, { limit: 20000, minMagnitude: null, spacingMs: 1100, timeoutMs: 1000, ...f.opts });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /rows where the count service said/);
});

test('history fetch: one request at a time, at least spacingMs apart, also across ranges sharing a pacer', async () => {
  const times = Array.from({ length: 30 }, (_, i) => S + i * 24 * 3600_000);
  const f = fakeSource(geofon, times);
  const pace = { lastEndMs: -Infinity };
  await fetchRange(geofon, S, E, { limit: 8, minMagnitude: null, spacingMs: 1100, timeoutMs: 1000, pace, ...f.opts });
  await fetchRange(geofon, dayMs('2022-11-01'), S, { limit: 8, minMagnitude: null, spacingMs: 1100, timeoutMs: 1000, pace, ...f.opts });
  assert.ok(f.calls.length > 3);
  for (let i = 1; i < f.calls.length; i++) assert.ok(f.calls[i]!.at - f.calls[i - 1]!.at >= 1100, `gap ${f.calls[i]!.at - f.calls[i - 1]!.at}`);
});

test('history fetch: overflow splits; a row on a window edge is kept once; only [start, end) is kept', async () => {
  const times = [S, S + 3600_000, S + 15.5 * 86_400_000, E - 1, E];
  const f = fakeSource(geofon, times);
  const r = await fetchRange(geofon, S, E, { limit: 3, minMagnitude: null, spacingMs: 1100, timeoutMs: 1000, ...f.opts });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(
    r.rows.map((x) => x.eventTimeMs).sort((a, b) => a - b),
    [S, S + 3600_000, S + 15.5 * 86_400_000, E - 1],
  );
  assert.equal(r.providerCount, null);
});

test('history fetch: 429 waits for Retry-After (at least the 5 s floor) and retries; a timeout splits the window', async () => {
  let first = true;
  const f = fakeSource(geofon, [S + 1000], {
    answers: (url) => {
      if (url.includes('/query?') && first) {
        first = false;
        return { status: 429, body: '', latencyMs: 1, retryAfterMs: 30_000 };
      }
      return null;
    },
  });
  const r = await fetchRange(geofon, S, E, { limit: 100, minMagnitude: null, spacingMs: 1100, timeoutMs: 1000, ...f.opts });
  assert.ok(r.ok);
  assert.ok(f.sleeps.includes(30_000));

  let timeouts = 0;
  const g = fakeSource(geofon, [S + 1000, E - 1000]);
  const slow = async (url: string): Promise<HttpAnswer> => {
    const q = new URL(url).searchParams;
    if (q.get('starttime') === '2022-12-01T00:00:00' && q.get('endtime') === '2023-01-01T00:00:00') {
      timeouts++;
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    return g.opts.fetcher(url);
  };
  const r2 = await fetchRange(geofon, S, E, { limit: 100, minMagnitude: null, spacingMs: 1100, timeoutMs: 1000, ...g.opts, fetcher: slow });
  assert.ok(r2.ok);
  assert.equal(timeouts, 1);
  if (r2.ok) assert.equal(r2.rows.length, 2);
  assert.equal(parseRetryAfter('120', 0), 120_000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0), 60_000);
});

test('history fetch: a Retry-After over the 2-minute cap ends the attempt at once and is handed back (never asked sooner)', async () => {
  const f = fakeSource(geofon, [S + 1000], { answers: (url) => (url.includes('/query?') ? { status: 503, body: '', latencyMs: 1, retryAfterMs: 3_600_000 } : null) });
  const r = await fetchRange(geofon, S, E, { limit: 100, minMagnitude: null, spacingMs: 1100, timeoutMs: 1000, ...f.opts });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.retryAfterMs, 3_600_000);
    assert.match(r.error, /Retry-After 3600 s/);
  }
  assert.equal(f.calls.length, 1);
  assert.ok(!f.sleeps.some((ms) => ms >= 5_000));
});

test('history fetch: the count URL drops limit/orderby and the query keeps the provider params', () => {
  const c = decodeURIComponent(historyQueryUrl(usgs, S, E, { limit: 20000, minMagnitude: 4, count: true }));
  assert.match(c, /\/fdsnws\/event\/1\/count\?format=geojson&starttime=2022-12-01T00:00:00&endtime=2023-01-01T00:00:00&minmagnitude=4$/);
  const q = decodeURIComponent(historyQueryUrl(usgs, S, E, { limit: 20000, minMagnitude: null }));
  assert.match(q, /\/query\?format=geojson&limit=20000&starttime=.*&orderby=time$/);
});

// ---------- build + verify ----------

const T0 = dayMs('2022-12-15') + 12 * 3600_000;
function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: 'reviewed',
    lat: 38.1,
    lon: 21.9,
    depth: 10,
    mag: 4.5,
    magType: 'ml',
    place: 'Greece',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}
const dec = eraPeriods({ ...pilot, sources: ['usgs', 'emsc'] }).find((p) => p.key === '2022-12')!;
const header = (source: string, rows: number, over: Partial<RawHeader> = {}): RawHeader => ({
  kind: 'earthquakes-feed/history-raw',
  version: 1,
  source,
  period: '2022-12',
  start: new Date(dec.startMs).toISOString(),
  end: new Date(dec.endMs).toISOString(),
  fetch_min_magnitude: null,
  fetched_at: '2026-10-02T00:00:00.000Z',
  rows,
  response_rows: rows,
  parsed_rows: rows,
  duplicate_ids: 0,
  provider_count: source === 'usgs' ? rows : null,
  requests: 2,
  windows: [{ start: new Date(dec.startMs).toISOString(), end: new Date(dec.endMs).toISOString(), rows, count: source === 'usgs' ? rows : null, http: 200, ms: 1 }],
  user_agent: 'test',
  ...over,
});
const raw = (source: string, rows: RawObs[], over: Partial<RawHeader> = {}): RawInput => ({ asset: rawAssetName(source, '2022-12'), sha256: 'x', header: header(source, rows.length, over), rows });

function input(over: Partial<BuildInput> = {}): BuildInput {
  return {
    period: dec,
    era: { ...pilot, sources: ['usgs', 'emsc'] },
    edition: 1,
    raws: [
      raw('usgs', [obs('usgs', 'us1'), obs('usgs', 'us2', { eventTimeMs: T0 + 3600_000, lat: 40, lon: 25 }), obs('usgs', 'us3', { eventTimeMs: dayMs('2022-12-31') + 86_399_000, lat: 10, lon: 10 })]),
      raw('emsc', [obs('emsc', 'em1', { eventTimeMs: T0 + 20_000, lat: 38.11, lon: 21.91, status: null }), obs('emsc', 'em2', { eventTimeMs: T0 + 7200_000, lat: -20, lon: 170 })]),
    ],
    context: null,
    registry,
    boundary: '2023-07-06',
    archivedDays: new Set(['2023-07-06']),
    ...over,
  };
}

test('history build: two sources of one quake are one event; every row accounted; the output verifies', () => {
  const out = buildEdition(input());
  assert.equal(out.meta.events, 4);
  assert.equal(out.meta.rows.fetched, 5);
  assert.equal(out.meta.rows.written, 5);
  const merged = out.nodes.find((n) => n.provenance.length === 2)!;
  assert.deepEqual(merged.provenance.map((r) => r.provider).sort(), ['emsc', 'usgs']);
  assert.ok(out.nodes.every((n) => n.firstSeenSeq === 0 && n.lastSeq === 0));
  const check = verifyEdition(out.dayFiles, { period: dec, boundary: '2023-07-06', archivedDays: new Set(), meta: out.meta, raws: input().raws });
  assert.deepEqual(check.errors, []);
  assert.deepEqual(out.meta.days, ['2022-12-15', '2022-12-31']);
});

test('history build: the same raw assets give byte-identical day files (ids seeded by time and place)', () => {
  const a = buildEdition(input());
  const b = buildEdition(input());
  assert.deepEqual([...a.dayFiles.entries()], [...b.dayFiles.entries()]);
});

test('history build: a row that joins the frozen newer neighbour is listed, never written', () => {
  // The neighbour holds a ComCat event at 00:00:05 on the day after the month; EMSC put the same quake at 23:59:58.
  const next = dayMs('2023-01-01');
  const map = new Map<string, EventNode>();
  new Resolver(map, priorityMap(registry), configMap(registry), next, { hotFloorMs: 0, merge: false }).ingest(obs('usgs', 'usN', { eventTimeMs: next + 5000, lat: 10, lon: 10 }), '2026-07-10T00:00:00.000Z');
  const ctxNodes = [...map.values()];
  const inp = input({
    raws: [raw('usgs', [obs('usgs', 'us1')]), raw('emsc', [obs('emsc', 'emEdge', { eventTimeMs: next - 2000, lat: 10.01, lon: 10.01 })])],
    context: { label: 'archive-2023-01/events-2023-01.tar.zst#01.ndjson', day: '2023-01-01', nodes: ctxNodes, sha256: 'ab'.repeat(32) },
  });
  const out = buildEdition(inp);
  assert.equal(out.meta.context?.sha256, 'ab'.repeat(32));
  assert.equal(out.meta.rows.joined_newer, 1);
  assert.deepEqual(out.meta.joined_newer[0], { provider: 'emsc', native_id: 'emEdge', feed_id: ctxNodes[0]!.feedId });
  assert.equal(out.meta.events, 1);
  assert.ok(!out.nodes.some((n) => n.feedId === ctxNodes[0]!.feedId));
  assert.deepEqual(verifyEdition(out.dayFiles, { period: dec, boundary: '2023-07-06', archivedDays: new Set(), meta: out.meta, raws: inp.raws }).errors, []);
});

test('history build: refuses any day at or after the boundary or already archived, and raws of another month or floor', () => {
  const archived = input({ archivedDays: new Set(['2022-12-10']) });
  assert.throws(() => buildEdition(archived), (e: unknown) => e instanceof HistoryBuildError && /already in an archive/.test(e.message));
  const late = input({ boundary: '2022-12-20' });
  assert.throws(() => buildEdition(late), /not before the boundary/);
  const wrongFloor = input({ raws: [raw('usgs', [obs('usgs', 'us1')], { fetch_min_magnitude: 4 }), raw('emsc', [])] });
  assert.throws(() => buildEdition(wrongFloor), /fetched from M4/);
  const missing = input({ raws: [raw('usgs', [obs('usgs', 'us1')])] });
  assert.throws(() => buildEdition(missing), /no raw asset of emsc/);
});

test('history build: a magnitude floor keeps an event any source puts at or above it and counts the rest', () => {
  const era = { id: 'b', from: '1973-01-01', to: '2023-07-06', minMagnitude: 4.5, sources: ['usgs', 'emsc'] };
  const inp = input({
    era,
    raws: [
      raw('usgs', [obs('usgs', 'us1', { mag: 4.4 }), obs('usgs', 'small', { mag: 4.1, eventTimeMs: T0 + 9e6, lat: 0, lon: 50 })], { fetch_min_magnitude: 4 }),
      raw('emsc', [obs('emsc', 'em1', { mag: 4.6, eventTimeMs: T0 + 20_000, lat: 38.11, lon: 21.91 })], { fetch_min_magnitude: 4 }),
    ],
  });
  const out = buildEdition(inp);
  assert.equal(out.meta.events, 1); // 4.4 (ComCat) + 4.6 (EMSC) = one quake that reaches 4.5
  assert.equal(out.meta.below_floor_events, 1);
  assert.equal(out.meta.rows.below_floor, 1);
  assert.deepEqual(verifyEdition(out.dayFiles, { period: dec, boundary: '2023-07-06', archivedDays: new Set(), meta: out.meta, raws: inp.raws }).errors, []);
});

test('history verify: catches a source id in two events, a feature on the wrong day and a stated count that is off', () => {
  const out = buildEdition(input());
  const files = new Map(out.dayFiles);
  const line = (files.get('2022-12-15') ?? '').split('\n')[0]!;
  const dup = JSON.parse(line) as { id: string; properties: { feed: { feed_id: string } } };
  dup.id = dup.properties.feed.feed_id = 'efd_00000000000000000000000000';
  files.set('2022-12-31', (files.get('2022-12-31') ?? '') + JSON.stringify(dup) + '\n');
  const errs = verifyEdition(files, { period: dec, boundary: '2023-07-06', archivedDays: new Set(), meta: out.meta }).errors.join('\n');
  assert.match(errs, /is in two events/);
  assert.match(errs, /is not on 2022-12-31/);
  assert.match(errs, /says 4 events, the day files hold 5/);
});

test('history raw file: header + rows round-trip, and a row count that disagrees with the header is refused', () => {
  const rows = [obs('usgs', 'b', { eventTimeMs: T0 + 1 }), obs('usgs', 'a')];
  const text = rawFileText(header('usgs', 2), rows);
  const back = parseRawText(text);
  assert.deepEqual(
    back.rows.map((r) => r.providerEventId),
    ['a', 'b'],
  );
  assert.throws(() => parseRawText(rawFileText(header('usgs', 3), rows)), /holds 2 rows where its header says 3/);
});

// ---------- index ----------

function idxWith(cfg: HistoryConfig, rawPeriods: string[], editions: { period: string; built_from: string[] }[] = []): HistoryIndex {
  const idx = emptyIndex(cfg.boundary);
  for (const period of rawPeriods)
    for (const s of cfg.eras.find((e) => allPeriods(cfg).some((p) => p.key === period && p.eraId === e.id))!.sources)
      idx.raw.push({ source: s, period, tag: `history-${period.slice(0, 4)}`, asset: rawAssetName(s, period), url: '', sha256: 'x', bytes: 1, rows: 1, provider_count: null, start: '', end: '', fetch_min_magnitude: null, fetched_at: '' });
  for (const e of editions)
    idx.editions.push({ period: e.period, edition: 1, era: 'pilot', tag: '', asset: editionAssetName(e.period, 1), url: '', sha256: 'x', bytes: 1, events: 1, days: [], sources: [], min_magnitude: null, built_from: e.built_from, context: null, joined_newer: 0 });
  return idx;
}

test('history index: the walk goes newest month first, all sources of a month before the next month', () => {
  const cfg = cfgOf([{ ...pilot, sources: ['usgs', 'emsc'] }]);
  const units = pendingUnits(cfg, idxWith(cfg, ['2023-07']));
  assert.deepEqual(
    units.slice(0, 4).map((u) => `${u.source}:${u.period.key}`),
    ['usgs:2023-06', 'emsc:2023-06', 'usgs:2023-05', 'emsc:2023-05'],
  );
});

test('history index: a month is sealed only once its newer neighbour is frozen (the boundary day or a current edition)', () => {
  const cfg = cfgOf([pilot]);
  const idx = idxWith(cfg, ['2023-07', '2023-06']);
  const [jul, jun] = allPeriods(cfg);
  assert.deepEqual(newerNeighbour(cfg, idx, jul!), { kind: 'boundary', day: '2023-07-06' });
  assert.equal(newerNeighbour(cfg, idx, jun!).kind, 'wait');
  assert.deepEqual(
    periodsToSeal(cfg, idx).map((p) => p.key),
    ['2023-07', '2023-06'],
  );
  const sealed = idxWith(cfg, ['2023-07', '2023-06'], [{ period: '2023-07', built_from: [rawAssetName('usgs', '2023-07')] }]);
  const nb = newerNeighbour(cfg, sealed, jun!);
  assert.equal(nb.kind, 'edition');
  if (nb.kind === 'edition') assert.equal(nb.day, '2023-07-01');
  assert.deepEqual(
    periodsToSeal(cfg, sealed).map((p) => p.key),
    ['2023-06'],
  );
  // A source joining the era makes every edition stale: a new edition per month, newest first.
  const grown = cfgOf([{ ...pilot, sources: ['usgs', 'emsc'] }]);
  assert.equal(newerNeighbour(grown, sealed, jun!).kind, 'wait');
});

test('history index: one line per entry, stable order, parse round trip', () => {
  const cfg = cfgOf([pilot]);
  const idx = idxWith(cfg, ['2023-06', '2023-07']);
  idx.attempts['usgs:2023-05'] = { failures: 2, since: 't', last_error: 'HTTP 503' };
  const text = indexText(idx);
  assert.equal(text, indexText(parseIndex(text)));
  const lines = text.split('\n');
  assert.ok(lines.findIndex((l) => l.includes('raw-usgs-2023-06')) < lines.findIndex((l) => l.includes('raw-usgs-2023-07')));
  assert.equal(lines.filter((l) => l.includes('"source":"usgs"')).length, 2);
});

test('history store: a local store never overwrites an asset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'efd-history-test-'));
  try {
    const store = new LocalStore(join(dir, 'releases'));
    const f = join(dir, 'raw-usgs-2022-12.ndjson.zst');
    writeFileSync(f, 'a');
    store.upload('history-2022', f);
    assert.throws(() => store.upload('history-2022', f), /never overwrites/);
    assert.deepEqual(
      store.list('history-2022').map((a) => a.name),
      ['raw-usgs-2022-12.ndjson.zst'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history build: day files use the partition feature format (nodeToFeature) that archive readers already parse', () => {
  const out = buildEdition(input());
  const first = (out.dayFiles.get('2022-12-15') ?? '').split('\n')[0]!;
  const node = out.nodes.find((n) => JSON.stringify(nodeToFeature(n)) === first);
  assert.ok(node);
  void emsc;
});

test('history fetch: a run whose time budget ends mid-range fails it as budget, not as a source failure', async () => {
  const f = fakeSource(geofon, [S + 1000]);
  const r = await fetchRange(geofon, S, E, { limit: 100, minMagnitude: null, spacingMs: 1100, timeoutMs: 1000, deadlineMs: 0, ...f.opts });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.budget, true);
});
