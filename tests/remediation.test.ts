import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { featureToNode, nodeToFeature } from '../src/bitemporal.js';
import { LocalStore } from '../src/history-store.js';
import { NO_PARTITION_FORMAT, dayPartitionText } from '../src/partitions.js';
import { BOOTSTRAP_2026_07_05, type DayRunDeps, remediateDay, resolveProviders } from '../src/remediate.js';
import type { WindowOutcome } from '../src/providers.js';
import { Resolver } from '../src/dedup.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import {
  MAX_REFILL_DAYS,
  MIN_WINDOW_MS,
  RAW_REMEDIATION_KIND,
  buildDayEdition,
  editionProblems,
  editionAssetName,
  EDITION_FORMAT,
  emptyRemediationIndex,
  enqueueRefill,
  fetchDayInWindows,
  indexText,
  nextFree,
  pruneQueue,
  queuePlan,
  rangeDays,
  refillTasks,
  type RemediationIndex,
  tasksByDay,
  parseRawText,
  rawAssetName,
  rawText,
  remediationTag,
  remediationTasks,
  saturatedPlan,
  type WindowFetcher,
} from '../src/remediation.js';
import { beyondRetention } from '../src/retention.js';
import type { EventNode, RawObs } from '../src/types.js';

// FEED-DQ-1 / DQ-3: saturated backfill days are asked again in sub-day windows and published as additive day editions
// (src/remediation.ts); the archived day is never rewritten.

const registry = loadRegistry();
const DAY = '2025-07-30';
const D0 = Date.parse(`${DAY}T00:00:00Z`);
const HOUR = 3_600_000;

const kagsr = (id: string, tMs: number, over: Partial<RawObs> = {}): RawObs => ({
  provider: 'kagsr', providerEventId: id, eventTimeMs: tMs, providerUpdatedMs: null, status: null,
  lat: 52.5, lon: 160.3, depth: 20, mag: 4.6, magType: 'ML', place: 'Kamchatka', knownAliasIds: [], fields: { eventId: id }, ...over,
});

test('tasks: frozen saturated days only, Kamchatka first, then the Sındırgı days (AFAD), done ones skipped', () => {
  const cursor = {
    providers: {
      imo: { saturatedDays: ['2025-05-24', '2023-11-11'] },
      afad: { saturatedDays: ['2025-08-12', '2025-08-11', '2025-11-12'] },
      kagsr: { saturatedDays: ['2025-07-30'] },
      usgs: { saturatedDays: ['2026-09-30'] },
    },
  };
  const t = remediationTasks(cursor, '2026-09-24', new Set(['afad:2025-08-12']));
  assert.deepEqual(t.map((x) => `${x.provider}:${x.day}`), ['kagsr:2025-07-30', 'afad:2025-08-11', 'afad:2025-11-12', 'imo:2023-11-11', 'imo:2025-05-24']);
});

test('saturated plan: archived, askable days only; a day before its month\'s archive waits; raws without an edition are built (SHLTR-151)', () => {
  const cursor = {
    providers: {
      kagsr: { saturatedDays: ['2025-07-30'] },
      afad: { saturatedDays: ['2025-08-11', '2025-08-12', '2025-08-13'] },
      imo: { saturatedDays: ['2026-08-20'] },
      usgs: { saturatedDays: ['2026-11-12'] },
    },
  };
  const archived = new Set(['2025-07-30', '2025-08-11', '2025-08-12', '2025-08-13']);
  const raw = (provider: string, day: string) => ({ provider, day, tag: 'remediation-2025', asset: `raw-${provider}-${day}.ndjson.gz`, url: '', sha256: 'x', bytes: 1, rows: 1, requests: 1, partial: false, fetched_at: '2026-11-08T00:00:00.000Z', reason: 'saturated' as const });
  const ed = (day: string, from: string[]) => ({ day, edition: 1, tag: 'remediation-2025', asset: `events-${day}.e1.ndjson.gz`, url: '', sha256: 'y', bytes: 1, built_on: { tag: 'a', asset: 'b', sha256: null }, built_from: from, reason: 'saturated' as const, stats: {} as never, built_at: '' });
  const idx = emptyRemediationIndex();
  // 08-12: its raw is in the day's edition (done). 08-13: a run uploaded its raw and built no edition.
  idx.raw.push(raw('afad', '2025-08-12'), raw('afad', '2025-08-13'));
  idx.editions.push(ed('2025-08-12', ['raw-afad-2025-08-12.ndjson.gz']));
  // AFAD 08-11 is older than the source's retention: never asked, never a task (saturatedReport warns about it).
  const skip = (p: string, d: string): boolean => p === 'afad' && d === '2025-08-11';
  const plan = saturatedPlan(cursor, '2026-11-04', idx, archived, skip);
  assert.deepEqual(plan.tasks.map((t) => `${t.provider}:${t.day}`), ['kagsr:2025-07-30'], 'the retention day and the unarchived IMO day take no slot');
  assert.deepEqual(plan.editionOnly, ['2025-08-13']);
  assert.deepEqual(plan.waiting, ['2026-08-20'], 'frozen, its month not archived yet; USGS 11-12 is not frozen');
  // Once 08-13's edition holds its raw, the day is done; IMO's month archives and its day is taken.
  idx.editions.push(ed('2025-08-13', ['raw-afad-2025-08-13.ndjson.gz']));
  const later = saturatedPlan(cursor, '2026-11-04', idx, new Set([...archived, '2026-08-20']), skip);
  assert.deepEqual([later.tasks.map((t) => `${t.provider}:${t.day}`), later.editionOnly, later.waiting], [['kagsr:2025-07-30', 'imo:2026-08-20'], [], []]);
});

/** A source holding `times` on the day that answers at most `cap` rows per window (overflow = full). */
function source(times: number[], cap: number, fail?: (s: number) => boolean) {
  const calls: [number, number][] = [];
  const fetchWindow: WindowFetcher = async (s, e) => {
    calls.push([s, e]);
    if (fail?.(s)) return { obs: [], status: { ok: false, error: 'HTTP 503' }, overflow: false };
    // Like fetchProviderWindow: rows within the window ±60 s, overflow when the answer reaches the cap.
    const inWin = times.filter((t) => t >= s - 60_000 && t <= e + 60_000).map((t) => kagsr(`k${t}`, t));
    return { obs: inWin.slice(0, cap), status: { ok: true }, overflow: inWin.length >= cap };
  };
  return { calls, fetchWindow };
}

test('windows: a full window is halved until no window fills the cap; rows are deduplicated and kept to the day', async () => {
  // 600 events in the first hour (the aftershock storm), one an hour after; one row just before midnight.
  const times = [...Array.from({ length: 600 }, (_, i) => D0 + i * 6_000), ...Array.from({ length: 23 }, (_, i) => D0 + (i + 1) * HOUR + 30 * 60_000), D0 - 30_000];
  const src = source(times, 490);
  let clock = 0;
  const r = await fetchDayInWindows(DAY, src.fetchWindow, { spacingMs: 1_100, sleep: async (ms) => void (clock += ms), now: () => clock });
  assert.ok(r.ok);
  assert.equal(r.partial, false);
  assert.equal(r.rows.length, 623, 'every event of the day once, the row of the day before left out');
  assert.ok(r.rows.every((o) => o.eventTimeMs >= D0 && o.eventTimeMs < D0 + 24 * HOUR));
  assert.ok(r.windows.some((w) => w.split), 'the first 6-hour window was split');
  assert.equal(r.requests, src.calls.length);
  assert.ok(src.calls.every(([s, e]) => e > s && s >= D0 && e <= D0 + 24 * HOUR));
  assert.ok(clock >= (r.requests - 1) * 1_100 - 1, 'at least 1.1 s between requests');
});

test('windows: a window still full at the smallest size keeps its rows and marks the day partial; a failure fails the day', async () => {
  const dense = Array.from({ length: 2000 }, (_, i) => D0 + i * 150); // 2000 events in 5 minutes
  const r = await fetchDayInWindows(DAY, source(dense, 490).fetchWindow, { spacingMs: 0, sleep: async () => {} });
  assert.ok(r.ok);
  assert.equal(r.partial, true);
  assert.ok(r.windows.some((w) => w.saturated && Date.parse(w.end) - Date.parse(w.start) <= MIN_WINDOW_MS));
  const failed = await fetchDayInWindows(DAY, source([D0 + HOUR], 490, (s) => s >= D0 + 12 * HOUR).fetchWindow, { spacingMs: 0, sleep: async () => {} });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.rows, []);
  assert.match(failed.error!, /2025-07-30T12:00:00.000Z\.\.2025-07-30T18:00:00.000Z: HTTP 503/);
});

/** The archived day as a Resolver would have left it: nodes from the given reports. */
function archivedDay(raws: RawObs[]): Map<string, EventNode[]> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, priorityMap(registry), configMap(registry), D0 + 400 * 24 * HOUR, { hotFloorMs: 0, merge: false });
  for (const raw of raws) r.ingest(raw, '2026-07-20T00:00:00.000Z');
  const byDay = new Map<string, EventNode[]>();
  for (const n of map.values()) {
    const d = new Date(n.eventTimeMs).toISOString().slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(n);
  }
  return byDay;
}

test('edition: missing rows become events, known rows join or stay unchanged, the day is serialized like a partition', () => {
  const kept = kagsr('k1', D0 + HOUR);
  const usgs: RawObs = { ...kagsr('us7000abcd', D0 + 2 * HOUR + 1_000), provider: 'usgs', fields: { ids: ',us7000abcd,' }, mag: 5.0, magType: 'mb', providerUpdatedMs: D0 + 3 * HOUR };
  // EMSC's event 20 s before midnight, on the day before.
  const late: RawObs = { ...kagsr('20250729_0000999', D0 - 20_000), provider: 'emsc', fields: { unid: '20250729_0000999' } };
  const context = archivedDay([kept, usgs, late]);
  const rows = [kept, kagsr('k2', D0 + 2 * HOUR), kagsr('k3', D0 + 5 * HOUR, { lat: 53.9, lon: 158.9 }), kagsr('k4', D0 + 10_000)];
  const out = buildDayEdition({ day: DAY, context, rows, registry, nowMs: Date.parse('2026-10-04T12:00:00Z'), ingestTime: '2026-10-04T12:00:00.000Z', seqMarker: 202_999, fmt: NO_PARTITION_FORMAT });
  const s = out.stats;
  assert.deepEqual(
    { archived: s.archived_events, events: s.events, live: [s.live_before, s.live_after], changed: s.changed, unchanged: s.unchanged, new: s.new_events, retired: s.retired, off: s.off_day, neighbour: s.neighbour_joins },
    // k1 already there; k2 joins the ComCat event 1 s away; k3 is a new event; k4 joins EMSC's event of the day before
    // (23:59:40), which this edition does not carry.
    { archived: 2, events: 3, live: [2, 3], changed: 3, unchanged: 1, new: 1, retired: 0, off: 0, neighbour: 1 },
  );
  assert.deepEqual(s.provider_rows.kagsr, { before: 1, after: 3 });
  assert.equal(s.afad_retimed, 0);
  const lines = out.text.trim().split('\n').map((l) => JSON.parse(l) as { properties: { time: number } });
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((f) => f.properties.time), [...lines.map((f) => f.properties.time)].sort((a, b) => a - b), 'in event-time order');
  assert.ok(out.nodes.filter((n) => n.lastSeq === 202_999).length >= 2, 'changed nodes carry the run marker');
  // The saturated path's bytes as the editions of 2026-10-04 were built (before the per-day loop and review_status).
  assert.equal(createHash('sha256').update(out.text).digest('hex'), 'a99c5e155c5a1c168d83e9cc86c6c4c4109d39df3ee567a6cf32637bb21e99a0');
  assert.equal(out.text, dayPartitionText(out.nodes, DAY, NO_PARTITION_FORMAT), 'without review_status an edition is a day partition byte for byte');
  const withStatus = dayPartitionText(out.nodes, DAY, EDITION_FORMAT);
  assert.equal(withStatus.split('\n').length, out.text.split('\n').length, 'one line per event either way');
  // review_status wherever the event's rows give one (decision A4), the same line as nodeToFeature's with the option.
  assert.deepEqual(withStatus.split('\n').filter(Boolean), [...out.nodes].sort((a, b) => a.eventTimeMs - b.eventTimeMs || (a.feedId < b.feedId ? -1 : 1)).map((n) => JSON.stringify(nodeToFeature(n, { reviewStatus: true }))));
  assert.deepEqual(withStatus.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id), out.text.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id));
  assert.deepEqual(editionProblems(DAY, out.nodes), []);
  const twice = structuredClone(out.nodes[0]!);
  twice.feedId = 'efd_twice';
  assert.match(editionProblems(DAY, [...out.nodes, twice]).join('\n'), /is in two live events/);
  assert.match(editionProblems('2025-07-31', out.nodes).join('\n'), /is on 2025-07-30, not 2025-07-31/);
});

test('edition: AFAD rows the archive holds 3 h early are re-read first, so the re-asked day has one time base', () => {
  const AFAD_DAY = '2025-08-11';
  const A0 = Date.parse(`${AFAD_DAY}T00:00:00Z`);
  const afad = (id: string, trueMs: number, legacy: boolean): RawObs => {
    const fields = { eventID: id, date: new Date(trueMs).toISOString().slice(0, 19), latitude: '39.2', longitude: '28.1', depth: '7', type: 'ML', magnitude: '2.1', location: 'Sındırgı (Balıkesir)' };
    return { provider: 'afad', providerEventId: id, eventTimeMs: trueMs - (legacy ? 3 * HOUR : 0), providerUpdatedMs: null, status: null, lat: 39.2, lon: 28.1, depth: 7, mag: 2.1, magType: 'ML', place: 'Sındırgı (Balıkesir)', knownAliasIds: [], fields };
  };
  // The archive: one AFAD row stored 3 h early (true 10:00), one whose true time is 01:00 the NEXT day (stored 22:00),
  // and on the day BEFORE one whose true time is 01:00 on this day (stored 22:00 the day before).
  const archive = archivedDay([afad('900001', A0 + 10 * HOUR, true), afad('900002', A0 + 25 * HOUR, true), afad('900000', A0 + HOUR, true)]);
  assert.deepEqual([...archive.keys()].sort(), ['2025-08-10', AFAD_DAY]);
  // The source, asked again: the first one, the one of 01:00 and a missing one, at their real times.
  const rows = [afad('900000', A0 + HOUR, false), afad('900001', A0 + 10 * HOUR, false), afad('900003', A0 + 12 * HOUR, false)];
  const context = new Map([...archive].map(([d, ns]) => [d, ns.map((n) => structuredClone(n))]));
  const out = buildDayEdition({ day: AFAD_DAY, context, rows, registry, nowMs: Date.parse('2026-10-04T12:00:00Z'), ingestTime: '2026-10-04T12:00:00.000Z', seqMarker: 1, fmt: NO_PARTITION_FORMAT });
  const s = out.stats;
  assert.equal(s.afad_retimed, 2, 'the archived day\'s two legacy rows re-read; the day before is not re-published, so not re-read');
  assert.equal(s.unchanged, 1, 'the re-asked row matches its re-read archived copy');
  assert.equal(s.new_events, 1);
  assert.equal(s.neighbour_joins, 1, '900000 is the day before\'s event (its archive keeps publishing it)');
  assert.equal(s.off_day, 1, 'the row whose real time is on the next day stays in this edition, the day its archive gave it');
  // Every archived event is in exactly one published day: 900000 in the day before's archive, 900002 here.
  assert.deepEqual(out.nodes.map((n) => [n.provenance[0]!.nativeId, new Date(n.eventTimeMs).toISOString()]), [
    ['900001', '2025-08-11T10:00:00.000Z'],
    ['900003', '2025-08-11T12:00:00.000Z'],
    ['900002', '2025-08-12T01:00:00.000Z'],
  ]);
  assert.deepEqual(editionProblems(AFAD_DAY, out.nodes, archive), []);
  assert.match(editionProblems(AFAD_DAY, out.nodes).join('\n'), /is on 2025-08-12, not 2025-08-11/, 'without the archive, only the day counts');
});

test('edition check: a report the archived day did not hold live, live in a neighbouring archived day, is refused', () => {
  const late: RawObs = { ...kagsr('20250729_0000999', D0 - 20_000), provider: 'emsc', fields: { unid: '20250729_0000999' } };
  const archive = archivedDay([kagsr('k1', D0 + HOUR), late]);
  const edition = archive.get(DAY)!.map((n) => structuredClone(n));
  assert.deepEqual(editionProblems(DAY, edition, archive), []);
  // The day before's EMSC report pulled into this day's event (a fold across midnight): published twice.
  const pulled = structuredClone(archive.get('2025-07-29')![0]!);
  pulled.feedId = 'efd_pulled';
  pulled.eventTimeMs = D0 + 1_000;
  assert.match(editionProblems(DAY, [...edition, pulled], archive).join('\n'), /emsc:20250729_0000999 would be live twice: in efd_pulled here and in efd_\w+ \(2025-07-29\)/);
});

test('raw asset: header + rows round-trip; a count that disagrees is refused; names never repeat', () => {
  const rows = [kagsr('a', D0 + 1), kagsr('b', D0 + 2)];
  const h = { kind: RAW_REMEDIATION_KIND as typeof RAW_REMEDIATION_KIND, version: 1 as const, provider: 'kagsr', day: DAY, fetched_at: 'x', rows: 2, requests: 5, partial: false, windows: [] };
  assert.deepEqual(parseRawText(rawText(h, rows)), { header: h, rows });
  assert.throws(() => parseRawText(rawText({ ...h, rows: 3 }, rows)), /holds 2 rows, its header says 3/);
  assert.equal(remediationTag(DAY), 'remediation-2025');
  assert.equal(rawAssetName('kagsr', DAY), 'raw-kagsr-2025-07-30.ndjson.gz');
  assert.equal(rawAssetName('kagsr', DAY, 2), 'raw-kagsr-2025-07-30.g2.ndjson.gz');
  assert.equal(editionAssetName(DAY, 3), 'events-2025-07-30.e3.ndjson.gz');
  const names = new Set(['events-2025-07-30.e1.ndjson.gz', 'events-2025-07-30.e2.ndjson.gz']);
  assert.equal(nextFree(names, (n) => editionAssetName(DAY, n)), 3);
  assert.equal(nextFree(names, (n) => editionAssetName(DAY, n), 2), 3);
});

// ---- The 2026-06-28..07-03 seam: explicit refills, one edition per day, the persistent queue (2026-11-08 plan C1). ----

test('refill: ranges are inclusive, at most 31 days, malformed ones throw; tasks skip done keys, by day then provider', () => {
  assert.deepEqual(rangeDays('2026-06-28..2026-07-03'), ['2026-06-28', '2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03']);
  assert.deepEqual(rangeDays('2026-06-30'), ['2026-06-30']);
  assert.equal(rangeDays('2026-01-01..2026-01-31').length, MAX_REFILL_DAYS);
  assert.throws(() => rangeDays('2026-01-01..2026-02-01'), /32 days, at most 31/);
  assert.throws(() => rangeDays('2026-07-03..2026-06-28'), /ends before it starts/);
  assert.throws(() => rangeDays('2026-06-31..2026-07-01'), /bad refill range/);
  assert.throws(() => rangeDays('2026-6-28..2026-07-01'), /bad refill range/);
  assert.throws(() => rangeDays(''), /bad refill range/);
  const t = refillTasks('2026-06-29..2026-06-30', ['usgs', 'emsc', 'usgs'], new Set(['emsc:2026-06-30']));
  assert.deepEqual(t.map((x) => `${x.provider}:${x.day}`), ['emsc:2026-06-29', 'usgs:2026-06-29', 'usgs:2026-06-30']);
  assert.ok(t.every((x) => x.reason === 'seam'));
  const g = tasksByDay([{ provider: 'usgs', day: '2026-06-30' }, { provider: 'afad', day: '2025-08-11' }, { provider: 'emsc', day: '2026-06-30' }]);
  assert.deepEqual([...g.keys()], ['2025-08-11', '2026-06-30']);
  assert.deepEqual(g.get('2026-06-30')!.map((x) => x.provider), ['usgs', 'emsc']);
});

test('refill providers: the bootstrap set expands to its 15 sources; unknown, inactive or forward-only ids are refused', () => {
  assert.equal(BOOTSTRAP_2026_07_05.length, 15);
  assert.deepEqual(resolveProviders('bootstrap-2026-07-05', registry), [...BOOTSTRAP_2026_07_05].sort());
  assert.deepEqual(resolveProviders('usgs, emsc', registry), ['emsc', 'usgs']);
  assert.throws(() => resolveProviders('usgs,nosuch', registry), /nosuch is not in the registry/);
  assert.throws(() => resolveProviders('', registry), /no providers/);
  const fwd = registry.find((p) => p.active && p.adapter !== 'fdsn' && !['afad', 'kagsr'].includes(p.id) && p.backfill?.enabled !== true)!;
  assert.throws(() => resolveProviders(fwd.id, registry), /forward-only/);
  const inactive = registry.find((p) => !p.active);
  if (inactive) assert.throws(() => resolveProviders(inactive.id, registry), /not active/);
});

const SEAM = '2026-06-29';
const S0 = Date.parse(`${SEAM}T00:00:00Z`);
const ARCHIVES = [{ period: '2026-06', tag: 'archive-2026-06', asset: 'events-2026-06.tar.zst', days: ['2026-06-28', '2026-06-29', '2026-06-30'], sha256: '49460d9f' }];
const usgsRow = (id: string, tMs: number, over: Partial<RawObs> = {}): RawObs => ({
  provider: 'usgs', providerEventId: id, eventTimeMs: tMs, providerUpdatedMs: tMs + HOUR, status: 'reviewed',
  lat: 35.1, lon: -117.6, depth: 8, mag: 2.1, magType: 'ml', place: 'California', knownAliasIds: [], fields: { ids: `,${id},` }, ...over,
});
const emscRow = (id: string, tMs: number, over: Partial<RawObs> = {}): RawObs => ({
  provider: 'emsc', providerEventId: id, eventTimeMs: tMs, providerUpdatedMs: null, status: null,
  lat: 38.3, lon: 21.8, depth: 10, mag: 2.6, magType: 'ml', place: 'Greece', knownAliasIds: [], fields: { unid: id }, ...over,
});

/** Stub sources: each provider's rows, answered per window like fetchProviderWindow; `fail` providers answer HTTP 503. */
function stubSources(rows: RawObs[], fail: ReadonlySet<string> = new Set()): DayRunDeps['fetchWindow'] {
  return async (p, s, e) => {
    if (fail.has(p.id)) return { provider: p.id, obs: [], status: { ok: false, error: 'HTTP 503' }, overflow: false } as WindowOutcome;
    const obs = rows.filter((r) => r.provider === p.id && r.eventTimeMs >= s - 60_000 && r.eventTimeMs <= e + 60_000);
    return { provider: p.id, obs, status: { ok: true, events_returned: obs.length }, overflow: false } as WindowOutcome;
  };
}

function seamDeps(dir: string, arch: Map<string, EventNode[]>, fetchWindow: DayRunDeps['fetchWindow']): DayRunDeps {
  return {
    store: new LocalStore(join(dir, 'releases')), registry, fetchWindow, archives: ARCHIVES, arch: { days: arch, failedMonths: new Set() },
    work: dir, nowMs: Date.parse('2026-11-08T12:00:00Z'), seqMarker: 500_000, spacingMs: 0, sleep: async () => {},
  };
}

/** The seam as archived: a forward-only list source on each day, no usgs or emsc rows. */
const seamArchive = (): Map<string, EventNode[]> =>
  archivedDay([
    { ...emscRow('cenc1', S0 - 10 * HOUR), provider: 'cenc', fields: {} },
    { ...emscRow('cenc2', S0 + 10 * HOUR, { lat: 30.1, lon: 103.2 }), provider: 'cenc', fields: {} },
    { ...emscRow('cenc3', S0 + 34 * HOUR, { lat: 30.1, lon: 103.2 }), provider: 'cenc', fields: {} },
  ]);

test('seam day: two sources, one edition built from both raws, reason seam and the context on every entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efd-seam-'));
  try {
    const idx = emptyRemediationIndex();
    const rows = [usgsRow('ci1', S0 + 2 * HOUR), usgsRow('ci2', S0 + 20 * HOUR), emscRow('e1', S0 + 3 * HOUR), emscRow('e0', S0 - 5 * HOUR)];
    const tasks = refillTasks(SEAM, ['usgs', 'emsc'], new Set());
    const r = await remediateDay(SEAM, tasks, idx, seamDeps(dir, seamArchive(), stubSources(rows)));
    assert.deepEqual(r.failed, []);
    assert.equal(idx.editions.length, 1, 'one edition for the day, not one per source');
    const ed = idx.editions[0]!;
    assert.equal(ed.asset, 'events-2026-06-29.e1.ndjson.gz');
    assert.deepEqual(ed.built_from, ['raw-emsc-2026-06-29.ndjson.gz', 'raw-usgs-2026-06-29.ndjson.gz']);
    assert.equal(ed.reason, 'seam');
    assert.ok(idx.raw.every((x) => x.reason === 'seam'));
    assert.deepEqual(ed.built_on, { tag: 'archive-2026-06', asset: 'events-2026-06.tar.zst', sha256: '49460d9f' });
    assert.deepEqual(Object.keys(ed.context!).sort(), ['2026-06-28', '2026-06-29', '2026-06-30']);
    assert.ok(Object.values(ed.context!).every((c) => c.tag === 'archive-2026-06'));
    assert.deepEqual(ed.stats.provider_rows.usgs, { before: 0, after: 2 });
    assert.deepEqual(ed.stats.provider_rows.emsc, { before: 0, after: 1 }, 'the row of the day before is not the day\'s');
    assert.equal(ed.stats.live_after, 4);
    const text = gunzipSync(readFileSync(join(dir, 'releases', 'remediation-2026', ed.asset))).toString('utf8');
    assert.equal(createHash('sha256').update(readFileSync(join(dir, 'releases', 'remediation-2026', ed.asset))).digest('hex'), ed.sha256);
    assert.equal(text, dayPartitionText(text.split('\n').filter(Boolean).map((l) => featureToNode(JSON.parse(l))), SEAM, EDITION_FORMAT), 'the edition is dayPartitionText(nodes, day, EDITION_FORMAT)');
    assert.ok(text.includes('"review_status"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seam day: a failed source uploads only the other raws and no edition; the next run fetches it and builds e1 from both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efd-seam-'));
  try {
    const idx = emptyRemediationIndex();
    enqueueRefill(idx, '2026-06-28..2026-07-01', ['usgs', 'emsc'], 'seam', '2026-11-08T00:00:00.000Z');
    const rows = [usgsRow('ci1', S0 + 2 * HOUR), emscRow('e1', S0 + 3 * HOUR)];
    const first = await remediateDay(SEAM, refillTasks(SEAM, ['usgs', 'emsc'], new Set()), idx, seamDeps(dir, seamArchive(), stubSources(rows, new Set(['emsc']))));
    assert.match(first.failed.join('\n'), /emsc:2026-06-29: .*HTTP 503/);
    assert.match(first.failed.join('\n'), /1 raw\(s\) uploaded, no edition/);
    assert.deepEqual(idx.raw.map((x) => x.asset), ['raw-usgs-2026-06-29.ndjson.gz']);
    assert.equal(idx.editions.length, 0);
    // The queue asks for the missing source only, and keeps the day.
    const plan = queuePlan(idx, new Set(ARCHIVES[0]!.days));
    assert.deepEqual(plan.tasks.filter((t) => t.day === SEAM).map((t) => t.provider), ['emsc']);
    assert.deepEqual(plan.waiting, ['2026-07-01']);
    pruneQueue(idx);
    assert.equal(idx.refill_queue![0]!.range, '2026-06-28..2026-07-01');
    const second = await remediateDay(SEAM, plan.tasks.filter((t) => t.day === SEAM), idx, seamDeps(dir, seamArchive(), stubSources(rows)));
    assert.deepEqual(second.failed, []);
    assert.equal(second.edition!.edition, 1);
    assert.deepEqual(second.edition!.built_from, ['raw-emsc-2026-06-29.ndjson.gz', 'raw-usgs-2026-06-29.ndjson.gz']);
    assert.deepEqual(second.edition!.stats.provider_rows.usgs, { before: 0, after: 1 }, 'the usgs rows come from its raw asset');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seam day: the neighbour context is the neighbour\'s current edition; against it, an archive-only build is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efd-seam-'));
  try {
    const idx = emptyRemediationIndex();
    const arch = seamArchive();
    // 06-28's edition: its archived day plus EMSC's event 10 s before midnight.
    const lateRow = emscRow('late', S0 - 10_000);
    const prevDay = '2026-06-28';
    const r28 = await remediateDay(prevDay, refillTasks(prevDay, ['emsc'], new Set()), idx, seamDeps(dir, arch, stubSources([lateRow])));
    assert.deepEqual(r28.failed, []);
    assert.equal(r28.edition!.stats.new_events, 1);
    // EMSC has since revised the event to 5 s after midnight: asked for 06-29, it answers it there.
    const revised = { ...lateRow, eventTimeMs: S0 + 5_000, providerUpdatedMs: Date.parse('2026-07-10T00:00:00Z') };
    const r29 = await remediateDay(SEAM, refillTasks(SEAM, ['emsc'], new Set()), idx, seamDeps(dir, arch, stubSources([revised])));
    assert.deepEqual(r29.failed, []);
    assert.deepEqual(r29.edition!.context![prevDay], { tag: 'remediation-2026', asset: 'events-2026-06-28.e1.ndjson.gz', sha256: r28.edition!.sha256 });
    assert.equal(r29.edition!.context![SEAM]!.tag, 'archive-2026-06', 'the day itself is always its archived day');
    assert.equal(r29.edition!.stats.neighbour_joins, 1, 'the row joins the event the 06-28 edition publishes');
    assert.equal(r29.edition!.stats.new_events, 0);
    // Built on the archives alone, the row would mint a second event: refused against what consumers read.
    const archiveOnly = buildDayEdition({ day: SEAM, context: new Map([...arch].map(([d, ns]) => [d, ns.map((n) => structuredClone(n))])), rows: [revised], registry, nowMs: Date.parse('2026-11-08T12:00:00Z'), ingestTime: '2026-11-08T12:00:00.000Z', seqMarker: 1, fmt: EDITION_FORMAT });
    assert.equal(archiveOnly.stats.new_events, 1);
    const edNodes = gunzipSync(readFileSync(join(dir, 'releases', 'remediation-2026', 'events-2026-06-28.e1.ndjson.gz'))).toString('utf8').split('\n').filter(Boolean).map((l) => featureToNode(JSON.parse(l)));
    const consumerContext = new Map([[prevDay, edNodes], [SEAM, arch.get(SEAM)!], ['2026-06-30', arch.get('2026-06-30')!]]);
    assert.match(editionProblems(SEAM, archiveOnly.nodes, consumerContext).join('\n'), /emsc:late would be live twice/);
    assert.deepEqual(editionProblems(SEAM, archiveOnly.nodes, arch), [], 'the archives alone do not see it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refill queue: persistent, deduplicated; archived days are taken, the others stay queued; done days leave it', () => {
  const idx: RemediationIndex = { version: 1, raw: [], editions: [] }; // an index of 2026-10-04: no queue yet
  assert.equal(enqueueRefill(idx, '2026-06-28..2026-07-03', ['usgs', 'emsc'], 'seam', '2026-11-08T00:00:00.000Z'), true);
  assert.equal(enqueueRefill(idx, '2026-06-28..2026-07-03', ['emsc', 'usgs'], 'seam', '2026-11-09T00:00:00.000Z'), false, 'queued once');
  assert.throws(() => enqueueRefill(idx, '2026-07-03..2026-06-28', ['usgs'], 'seam', 'x'), /ends before/);
  const june = new Set(['2026-06-27', '2026-06-28', '2026-06-29', '2026-06-30']);
  let plan = queuePlan(idx, june);
  assert.deepEqual(plan.tasks.map((t) => `${t.provider}:${t.day}`), ['emsc:2026-06-28', 'usgs:2026-06-28', 'emsc:2026-06-29', 'usgs:2026-06-29', 'emsc:2026-06-30', 'usgs:2026-06-30']);
  assert.deepEqual(plan.waiting, ['2026-07-01', '2026-07-02', '2026-07-03'], 'not archived yet: stays queued');
  // 06-28 done (both raws, an edition built from both); 06-29 has both raws but no edition (a run died between them).
  const raw = (provider: string, day: string) => ({ provider, day, tag: 'remediation-2026', asset: `raw-${provider}-${day}.ndjson.gz`, url: '', sha256: 'x', bytes: 1, rows: 1, requests: 1, partial: false, fetched_at: '2026-11-08T00:00:00.000Z', reason: 'seam' as const });
  idx.raw.push(raw('usgs', '2026-06-28'), raw('emsc', '2026-06-28'), raw('usgs', '2026-06-29'), raw('emsc', '2026-06-29'));
  const ed = (day: string, from: string[]) => ({ day, edition: 1, tag: 'remediation-2026', asset: `events-${day}.e1.ndjson.gz`, url: '', sha256: 'y', bytes: 1, built_on: { tag: 'a', asset: 'b', sha256: null }, built_from: from, reason: 'seam' as const, stats: {} as never, built_at: '' });
  idx.editions.push(ed('2026-06-28', ['raw-emsc-2026-06-28.ndjson.gz', 'raw-usgs-2026-06-28.ndjson.gz']));
  plan = queuePlan(idx, june);
  assert.deepEqual(plan.tasks.map((t) => `${t.provider}:${t.day}`), ['emsc:2026-06-30', 'usgs:2026-06-30']);
  assert.deepEqual(plan.editionOnly, ['2026-06-29']);
  assert.deepEqual(pruneQueue(idx), []);
  assert.equal(idx.refill_queue![0]!.range, '2026-06-29..2026-07-03', 'the done day left the range');
  // The same dispatch again: its days are done or still queued, so no second entry.
  assert.equal(enqueueRefill(idx, '2026-06-28..2026-07-03', ['usgs', 'emsc'], 'seam', '2026-11-10T00:00:00.000Z'), false);
  assert.equal(enqueueRefill(idx, '2026-06-28..2026-07-04', ['usgs', 'emsc'], 'seam', '2026-11-10T00:00:00.000Z'), true, 'a new day is queued');
  idx.refill_queue!.pop();
  // A queue written with the same refill twice collapses to one entry.
  idx.refill_queue!.push({ ...idx.refill_queue![0]!, range: '2026-06-28..2026-07-03' });
  pruneQueue(idx);
  assert.deepEqual(idx.refill_queue!.map((e) => e.range), ['2026-06-29..2026-07-03']);
  // July rolls: its days are taken. Everything done: the entry leaves the queue.
  const julyToo = new Set([...june, '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
  assert.deepEqual(queuePlan(idx, julyToo).waiting, []);
  assert.equal(queuePlan(idx, julyToo).tasks.length, 8);
  for (const d of ['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03']) {
    if (d !== '2026-06-29') idx.raw.push(raw('usgs', d), raw('emsc', d));
    idx.editions.push(ed(d, [`raw-emsc-${d}.ndjson.gz`, `raw-usgs-${d}.ndjson.gz`]));
  }
  assert.deepEqual(pruneQueue(idx).map((e) => e.range), ['2026-06-29..2026-07-03']);
  assert.deepEqual(idx.refill_queue, []);
  assert.deepEqual(JSON.parse(indexText(idx)).refill_queue, []);
});

test('index text: the queue is kept; the index of 2026-10-04 (no queue, no reason) still reads', () => {
  const idx = emptyRemediationIndex();
  enqueueRefill(idx, '2026-07-01..2026-07-03', ['usgs'], 'seam', '2026-11-08T00:00:00.000Z');
  const back = JSON.parse(indexText(idx)) as RemediationIndex;
  assert.deepEqual(back.refill_queue, [{ range: '2026-07-01..2026-07-03', providers: ['usgs'], reason: 'seam', queued_at: '2026-11-08T00:00:00.000Z' }]);
  const old = { version: 1 as const, raw: [], editions: [] };
  assert.deepEqual(queuePlan(old, new Set(['2026-07-01'])), { tasks: [], editionOnly: [], waiting: [] });
  assert.deepEqual(pruneQueue(old), []);
});

// --- SHLTR-146: AFAD answers from its newest 1,000 events only. The seam refill of 2026-07-01..03 (queued for AFAD among
// 15 sources, taken once July is archived) must not ask it, must not read its empty answer as "nothing to fill", and
// must say so in the edition; the queue must not wait for AFAD forever. ---

test('retention: the refill queue skips AFAD for a day older than its retention, notes it in the edition, and lets the day go', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efd-seam-'));
  try {
    const afad = registry.find((p) => p.id === 'afad')!;
    const deps0 = seamDeps(dir, seamArchive(), stubSources([]));
    const skip = (provider: string, day: string): boolean => beyondRetention(registry.find((p) => p.id === provider)!, day, deps0.nowMs);
    assert.ok(skip('afad', SEAM) && !skip('usgs', SEAM));
    const idx = emptyRemediationIndex();
    enqueueRefill(idx, '2026-06-29..2026-06-30', ['afad', 'usgs'], 'seam', '2026-11-08T00:00:00.000Z');
    enqueueRefill(idx, '2026-06-28', ['afad'], 'seam', '2026-11-08T00:00:00.000Z');
    const archived = new Set(ARCHIVES[0]!.days);
    const plan = queuePlan(idx, archived, skip);
    // AFAD rides along with the days that are built (so the edition notes it); alone (06-28) it is no work at all.
    assert.deepEqual(plan.tasks.map((t) => `${t.provider}:${t.day}`), ['afad:2026-06-29', 'usgs:2026-06-29', 'afad:2026-06-30', 'usgs:2026-06-30']);
    const asked: string[] = [];
    const rows = [usgsRow('ci1', S0 + 2 * HOUR)];
    const fetchWindow: DayRunDeps['fetchWindow'] = async (p, s, e, m) => {
      asked.push(p.id);
      return stubSources(rows)(p, s, e, m);
    };
    const r = await remediateDay(SEAM, plan.tasks.filter((t) => t.day === SEAM), idx, { ...deps0, fetchWindow });
    assert.deepEqual(r.failed, []);
    assert.ok(asked.length > 0 && asked.every((id) => id === 'usgs'), 'no AFAD request');
    assert.deepEqual(r.notFetched.map((n) => [n.provider, n.reason, n.retained_from]), [['afad', 'retention', '2026-11-02']]);
    const ed = r.edition!;
    assert.deepEqual(ed.built_from, ['raw-usgs-2026-06-29.ndjson.gz'], 'no AFAD raw: nothing reads as "AFAD had nothing that day"');
    assert.deepEqual(ed.not_fetched, r.notFetched);
    assert.match(ed.not_fetched![0]!.note, /^afad answers time-range queries for its last 7 days only/);
    assert.match(r.line!, /; not asked \(retention\): afad$/);
    assert.ok(!idx.raw.some((x) => x.provider === 'afad'));
    // Asked again with AFAD alone (a later run): no second edition of a finished day.
    const again = await remediateDay(SEAM, [{ provider: 'afad', day: SEAM, reason: 'seam' }], idx, { ...deps0, fetchWindow });
    assert.equal(again.edition, undefined);
    assert.equal(idx.editions.length, 1);
    // The queue: 06-28 (AFAD alone) and 06-29 are done; 06-30 is left. Without the retention the queue would wait for
    // AFAD's raw for good.
    assert.deepEqual(pruneQueue(structuredClone(idx)).map((e) => e.range), []);
    assert.deepEqual(pruneQueue(idx, skip).map((e) => e.range), ['2026-06-28']);
    assert.deepEqual(idx.refill_queue!.map((e) => e.range), ['2026-06-30..2026-06-30']);
    assert.equal(afad.retentionDays, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- SHLTR-151: KAGSR 2025-07-30 (saturated: a one-day backfill window filled the cap) is asked again in hour windows,
// and the edition holds every row the hour windows answer. ---

test('saturated day: asked in hour windows from the start, every hour\'s rows in the edition (the KAGSR 2025-07-30 case)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efd-saturated-'));
  try {
    // The archive holds part of the day (as the backfill's capped answer left it); the source lists more now.
    const all = Array.from({ length: 48 }, (_, i) => kagsr(`k${i}`, D0 + i * 30 * 60_000 + 7_000, { lat: 50 + (i % 7) * 0.5, lon: 155 + (i % 5) }));
    const archived = all.slice(0, 30);
    const windows: Array<[number, number]> = [];
    const fetchWindow: DayRunDeps['fetchWindow'] = async (p, s, e) => {
      windows.push([s, e]);
      const obs = all.filter((r) => r.eventTimeMs >= s && r.eventTimeMs < e);
      return { provider: p.id, obs, status: { ok: true, events_returned: obs.length }, overflow: false } as WindowOutcome;
    };
    const archives = [{ period: '2025-07', tag: 'archive-2025-07', asset: 'events-2025-07.e3.tar.zst', days: ['2025-07-29', DAY, '2025-07-31'], sha256: 'ea352f9c' }];
    const deps: DayRunDeps = {
      store: new LocalStore(join(dir, 'releases')), registry, fetchWindow, archives, arch: { days: archivedDay(archived), failedMonths: new Set() },
      work: dir, nowMs: Date.parse('2026-11-15T04:43:00Z'), seqMarker: 500_000, spacingMs: 0, sleep: async () => {},
    };
    const idx = emptyRemediationIndex();
    const tasks = remediationTasks({ providers: { kagsr: { saturatedDays: [DAY] } } }, '2026-11-04', new Set(idx.raw.map((r) => `${r.provider}:${r.day}`)));
    assert.deepEqual(tasks, [{ provider: 'kagsr', day: DAY }]);
    const r = await remediateDay(DAY, tasks, idx, deps);
    assert.deepEqual(r.failed, []);
    assert.equal(windows.length, 24, 'one request per hour');
    assert.ok(windows.every(([s, e], i) => s === D0 + i * HOUR && e === s + HOUR));
    assert.deepEqual([r.raws[0]!.rows, r.raws[0]!.partial, r.raws[0]!.requests], [48, false, 24]);
    assert.deepEqual(r.edition!.stats.provider_rows.kagsr, { before: 30, after: 48 }, 'the day holds every row the source lists');
    assert.equal(r.edition!.stats.new_events, 18);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
