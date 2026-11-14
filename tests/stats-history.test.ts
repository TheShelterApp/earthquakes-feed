import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ArchiveEntry } from '../src/archive.js';
import { nodeToFeature } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import type { EditionEntry, HistoryIndex } from '../src/history-index.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EditionRef, RemediationIndex } from '../src/remediation.js';
import { checkCollapsedInto, parseStatsConfig, type StatsConfig } from '../src/stats.js';
import {
  type ComcatCount,
  type InputIndex,
  type InputLookup,
  InputReader,
  type StatsIo,
  type StatsHistoryState,
  YearAccumulator,
  buildOrder,
  buildYear,
  chooseDayInput,
  comcatGate,
  dupSuspects,
  emptyState,
  inputLookup,
  planYear,
  runStatsHistory,
  staleReason,
  stateText,
  statsThrough,
  verifyMonths,
  verifyRow,
  yearDays,
} from '../src/stats-history.js';
import { STATS_BUILDER_VERSION, cellOf } from '../src/stats-table.js';
import type { EventNode, RawObs } from '../src/types.js';

// The stats builder (src/stats-history.ts; APIs.md, Statistics): inputs per day, digests, order and budget, the area and
// year accumulation, the in-memory re-merge of unmerged inputs (owner decision A6), the ComCat gate, the ledger.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const config: StatsConfig = parseStatsConfig(JSON.parse(readFileSync(here('../providers/stats.json'), 'utf8')));
const DAY = 86_400_000;
const SHA = (c: string): string => c.repeat(64).slice(0, 64);
const IT = '2026-11-08T00:00:00.000Z';
const KM_PER_DEG = 111.195;

const monthDays = (period: string): string[] => {
  const [y, m] = period.split('-').map(Number);
  const out: string[] = [];
  for (let t = Date.UTC(y!, m! - 1, 1); t < Date.UTC(y!, m!, 1); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const archive = (period: string, over: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  period,
  tag: `archive-${period}`,
  asset: `events-${period}.tar.zst`,
  url: '',
  bytes: 1,
  sha256: SHA(period.slice(-1)),
  count: 0,
  days: monthDays(period),
  ...over,
});
const edition = (period: string, over: Partial<EditionEntry> = {}): EditionEntry => ({
  period,
  edition: 1,
  era: 'A',
  tag: `history-${period.slice(0, 4)}`,
  asset: `events-${period}.e1.tar.zst`,
  url: '',
  sha256: SHA('e'),
  bytes: 1,
  events: 0,
  days: monthDays(period),
  sources: [],
  min_magnitude: null,
  built_from: [],
  context: null,
  joined_newer: 0,
  ...over,
});
const remEdition = (day: string, edition: number, over: Partial<EditionRef> = {}): EditionRef =>
  ({ day, edition, tag: `remediation-${day.slice(0, 4)}`, asset: `events-${day}.e${edition}.ndjson.gz`, url: '', sha256: SHA(String(edition)), bytes: 1, built_on: { tag: '', asset: '', sha256: null }, built_from: [], stats: {}, built_at: '' }) as unknown as EditionRef & typeof over;
const history = (editions: EditionEntry[]): HistoryIndex => ({ version: 1, boundary: '2023-07-06', raw: [], editions, unused: [], attempts: {} }) as unknown as HistoryIndex;
const remediation = (editions: EditionRef[]): RemediationIndex => ({ version: 1, raw: [], editions, refill_queue: [] });

// --- features ---

type F = Record<string, unknown>;
let seq = 0;
function feat(timeMs: number, mag: number, o: { lat?: number; lon?: number; provider?: string; type?: string; state?: string; id?: string } = {}): F {
  const n = ++seq;
  const id = o.id ?? `efd_01M6Q2J4WG${String(n).padStart(16, '0')}`;
  const provider = o.provider ?? 'usgs';
  return {
    type: 'Feature',
    id,
    geometry: { coordinates: [o.lon ?? 120, o.lat ?? 10, 10] },
    properties: {
      mag,
      place: `p${n}`,
      time: timeMs,
      updated: timeMs + 60_000,
      type: o.type ?? 'earthquake',
      tsunami: 0,
      feed: { feed_id: id, state: o.state ?? 'live', tombstone: false, chosen_provider: provider, first_ingest_time: new Date(timeMs + 60_000).toISOString(), provenance: [{ provider, status: 'reviewed', chosen: true, fields: {} }] },
    },
  };
}
const ndjson = (fs: F[]): string => fs.map((f) => JSON.stringify(f)).join('\n') + (fs.length ? '\n' : '');

/** A fake Release store: asset key -> members. */
function fakeIo(assets: Map<string, Map<string, string>>, gz: Map<string, string> = new Map(), parts: Map<string, string> = new Map(), fail: Set<string> = new Set()): StatsIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    assetMembers(tag, asset) {
      calls.push(`${tag}/${asset}`);
      if (fail.has(`${tag}/${asset}`)) throw new Error(`download of ${tag}/${asset} failed`);
      return assets.get(`${tag}/${asset}`) ?? new Map();
    },
    gzipText(tag, asset) {
      calls.push(`${tag}/${asset}`);
      return gz.get(`${tag}/${asset}`) ?? '';
    },
    partitionText(day) {
      calls.push(`partition ${day}`);
      return parts.get(day) ?? '';
    },
  };
}

// --- chooseDayInput ---

test('chooseDayInput: remediation > partition > archive > edition; the 2023-07 split month (edition days 01-05, archive from the 6th)', () => {
  const idx: InputIndex = {
    remediation: remediation([remEdition('2025-08-11', 1), remEdition('2025-08-11', 2), remEdition('2026-07-01', 1)]),
    partitions: new Map([['2026-07-01', 'a'.repeat(40)], ['2026-07-02', 'b'.repeat(40)]]),
    archives: [archive('2023-07', { days: monthDays('2023-07').slice(5) }), archive('2025-08', { merge_epoch: 1, merge_rules: 3 })],
    history: history([edition('2023-07', { edition: 2, era: 'pilot', days: monthDays('2023-07').slice(0, 5) }), edition('2023-07', { edition: 1, era: 'pilot', sha256: SHA('1') }), edition('1985-03', { era: 'B', min_magnitude: 4.5 })]),
  };
  const lk = inputLookup(idx, 1);
  const r = chooseDayInput('2025-08-11', lk)!;
  assert.deepEqual([r.kind, r.key, r.merged], ['remediation', 'remediation-2025/events-2025-08-11.e2.ndjson.gz', false], 'the highest remediation edition, unmerged (no stats.remerge)');
  assert.equal(chooseDayInput('2025-08-12', lk)!.kind, 'archive');
  assert.equal(chooseDayInput('2025-08-12', lk)!.merged, true, 'merge_epoch 1');
  assert.equal(chooseDayInput('2026-07-01', lk)!.kind, 'remediation', 'a remediation edition supersedes the partition (Q1)');
  const p = chooseDayInput('2026-07-02', lk)!;
  assert.deepEqual([p.kind, p.key, p.fp, p.merged], ['partition', '2026-07-02', 'b'.repeat(40), false]);
  const e5 = chooseDayInput('2023-07-05', lk)!;
  assert.deepEqual([e5.kind, e5.asset, e5.era], ['edition', 'events-2023-07.e1.tar.zst', 'pilot']);
  assert.equal(e5.fp, SHA('e'), 'the current edition (2) by its sha');
  assert.equal(chooseDayInput('2023-07-06', lk)!.kind, 'archive');
  const b = chooseDayInput('1985-03-10', lk)!;
  assert.deepEqual([b.kind, b.era, b.minMag, b.merged], ['edition', 'B', 4.5, false]);
  const one = inputLookup({ ...idx, history: history([edition('1985-03', { era: 'B', min_magnitude: 4.5, sources: ['usgs'] })]) }, 1);
  assert.equal(chooseDayInput('1985-03-10', one)!.merged, true, 'a single-source edition is never re-merged (eraIsRemerged)');
  assert.equal(chooseDayInput('1985-04-01', lk), null, 'no input: a missing day');
  const quiet = inputLookup({ ...idx, history: history([edition('1981-10', { era: 'B', min_magnitude: 4.5, sources: ['usgs'], days: monthDays('1981-10').filter((d) => d !== '1981-10-30') })]) }, 1);
  assert.equal(chooseDayInput('1981-10-30', quiet)?.kind, 'edition', 'a quiet day of an edition month (no member) is that edition\'s');
  assert.equal(planYear(1981, '2026-10-28', quiet, 2).missing.filter((d) => d.startsWith('1981-10')).length, 0);
  // Remediation editions merged at build time or refreshed by the archive re-merge carry their epoch.
  const refreshed = (sha: string): InputLookup => inputLookup({ ...idx, remediation: remediation([{ ...remEdition('2025-08-11', 3), built_on: { tag: 'archive-2025-08', asset: 'events-2025-08.tar.zst', sha256: sha }, stats: { remerge: { epoch: 1, from_edition: 2 } } } as unknown as EditionRef]) }, 1);
  assert.equal(chooseDayInput('2025-08-11', refreshed(SHA('8')))!.merged, true, 'refreshed on the merged month asset');
  assert.equal(chooseDayInput('2025-08-11', refreshed(SHA('0')))!.merged, false, 'built on an earlier asset of the month');
  // An archive merged under older rules (REMERGE_RULES: the input normalization) is re-merged in memory.
  const oldRules = inputLookup({ ...idx, archives: [archive('2025-08', { merge_epoch: 1, merge_rules: 2 })] }, 1);
  assert.equal(chooseDayInput('2025-08-12', oldRules)!.merged, false);
});

test('statsThrough: the last frozen day (frozenBefore - 1); yearDays stops there', () => {
  assert.equal(statsThrough(Date.parse('2026-11-08T12:00:00Z')), '2026-10-28');
  assert.equal(yearDays(2026, '2026-01-03').join(), '2026-01-01,2026-01-02,2026-01-03');
  assert.equal(yearDays(2024, '2026-10-28').length, 366);
});

// --- digest, staleness, order ---

test('digest: changes with an input checksum, a partition blob, the builder or through; stable otherwise', () => {
  const base: InputIndex = { remediation: remediation([]), partitions: new Map(), archives: monthsOf(2024).map((p) => archive(p, { merge_epoch: 1, merge_rules: 3 })), history: null };
  const d0 = planYear(2024, '2026-10-28', inputLookup(base, 1), 1).digest;
  assert.equal(planYear(2024, '2026-10-28', inputLookup(base, 1), 1).digest, d0);
  assert.notEqual(planYear(2024, '2026-10-28', inputLookup(base, 1), 2).digest, d0, 'builder');
  const changed = { ...base, archives: base.archives.map((a) => (a.period === '2024-05' ? { ...a, sha256: SHA('z') } : a)) };
  assert.notEqual(planYear(2024, '2026-10-28', inputLookup(changed, 1), 1).digest, d0, 'an archive re-rolled or re-merged');
  const parts = { ...base, partitions: new Map([['2024-12-31', 'a'.repeat(40)]]) };
  const p1 = planYear(2024, '2026-10-28', inputLookup(parts, 1), 1);
  const p2 = planYear(2024, '2026-10-28', inputLookup({ ...base, partitions: new Map([['2024-12-31', 'c'.repeat(40)]]) }, 1), 1);
  assert.notEqual(p1.digest, p2.digest, 'a new partition blob');
  assert.deepEqual(p1.unmergedMonths, ['2024-12'], 'a partition counts as unmerged');
  assert.equal(p1.context.length, 14, 'an unmerged year names its 7 days of context on each side (newer: up to through)');
  assert.equal(planYear(2024, '2025-01-03', inputLookup(parts, 1), 1).context.length, 10, 'newer context only up to through');
  assert.equal(planYear(2024, '2026-10-28', inputLookup(base, 1), 1).context.length, 0, 'a merged year has no context');
  const open = planYear(2026, '2026-10-28', inputLookup(base, 1), 1);
  assert.notEqual(open.digest, planYear(2026, '2026-10-29', inputLookup(base, 1), 1).digest, 'the open year changes with through');
});

const monthsOf = (y: number): string[] => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);

test('staleReason: never built, inputs changed, a missing file, a failed gate on the same inputs, a waiting year', () => {
  const lk = inputLookup({ remediation: remediation([]), partitions: new Map(), archives: monthsOf(2024).map((p) => archive(p, { merge_epoch: 1, merge_rules: 3 })), history: null }, 1);
  const plan = planYear(2024, '2026-10-28', lk, 1);
  const files = { fileExists: () => true, wantsYearFile: true, forced: false };
  assert.equal(staleReason(plan, undefined, files), 'never built');
  const st = { inputs_digest: plan.digest, through: plan.through, complete: true, remerged_in_memory: false, inputs: { remediation: 0, partition: 0, archive: 366, edition: 0, unmerged_months: 0 }, area: { bytes: 1, sha256: SHA('a'), records: 1, m6: 0 }, year: { bytes: 1, sha256: SHA('b') } };
  assert.equal(staleReason(plan, st, files), null);
  assert.equal(staleReason(plan, st, { ...files, forced: true }), 'named by the run');
  assert.equal(staleReason(plan, { ...st, inputs_digest: SHA('0') }, files), 'inputs changed');
  assert.equal(staleReason(plan, { ...st, inputs_digest: SHA('0'), failed_digest: plan.digest }, files), null, 'the gate failed on these inputs: not retried');
  assert.equal(staleReason(plan, st, { ...files, fileExists: () => false }), 'area file missing');
  assert.equal(staleReason(plan, { ...st, year: undefined }, files), 'year file missing');
  assert.equal(staleReason(plan, { ...st, year: undefined }, { ...files, wantsYearFile: false }), null);
  assert.equal(staleReason(plan, { ...st, error: 'download failed' }, files)?.startsWith('last build failed'), true);
  const holes = planYear(2025, '2026-10-28', lk, 1);
  assert.ok(holes.missing.length > 0);
  assert.equal(staleReason(holes, undefined, files), null, 'a year with days without an input waits');
});

test('buildOrder: the current year and the two before it first, then newest first (era B last); max; named years only', () => {
  assert.deepEqual(buildOrder([1980, 2001, 2024, 2026, 2010, 2025], 2026, 10), [2026, 2025, 2024, 2010, 2001, 1980]);
  assert.deepEqual(buildOrder([1980, 2001, 2024, 2026, 2010], 2026, 3), [2026, 2024, 2010]);
  assert.deepEqual(buildOrder([1985, 2010, 2026], 2026, 6, new Set([2010, 1985])), [2010, 1985]);
});

// --- accumulation ---

test('cellOf edges: lat 90 -> row 1799, lat -90 -> row 0, lon 180 -> col 0, lon -180.0001 wraps', () => {
  assert.equal(Math.floor(cellOf(900_000, 0) / 3600), 1799);
  assert.equal(Math.floor(cellOf(-900_000, 0) / 3600), 0);
  assert.equal(cellOf(0, 1_800_000) % 3600, 0);
  assert.equal(cellOf(0, -1_800_000) % 3600, 0);
  assert.equal(cellOf(0, Math.round(-180.0001 * 1e4)) % 3600, 3599);
});

test('accumulator: bins and the M4.5/M5/M6 cuts on mag x 100, mmax per cell, filtered and skipped, era B floor', () => {
  const days = yearDays(2024, '2024-01-02');
  const acc = new YearAccumulator(2024, days, true);
  const t = Date.parse('2024-01-01T01:00:00Z');
  for (const m of [1.9, 2.0, 4.496, 4.5, 4.99, 5.0, 5.99, 6.0, 7.2]) acc.add(feat(t, m), null);
  acc.add(feat(t, 3, { type: 'quarry blast' }), null);
  acc.add(feat(t, 3, { state: 'superseded' }), null);
  acc.add(feat(t, 11), null);
  acc.add(feat(Date.parse('2024-01-03T00:00:00Z'), 3), null);
  assert.equal(acc.pending.length, 7, 'M3.5+ rows wait for the reconciliation');
  acc.finish({ dropped: new Map(), outOfRegion: new Set() });
  assert.deepEqual(acc.bins[0], [1, 1, 0, 0, 0, 0, 3, 2, 1, 1], '4.496 rounds to 450: M4.5+; 4.99 to 499: under M5');
  assert.equal(acc.total[0], 9);
  assert.equal(acc.filtered[0], 1);
  assert.equal(acc.skipped, 1);
  assert.equal(acc.outside, 1, 'a row after the year\'s last day');
  assert.equal(acc.m5.length, 4, 'M5+ rows: 5.0, 5.99, 6.0, 7.2');
  assert.equal(acc.m6.length, 2);
  const rec = acc.area.get(cellOf(100_000, 1_200_000))!;
  assert.deepEqual(rec, [9, 7, 720]);
  assert.deepEqual([...acc.providers[0]!], ['usgs']);
  // Era B: an input with the M4.5 floor leaves out what is under it, and its filtered events.
  const b = new YearAccumulator(1985, yearDays(1985, '1985-01-01'), false);
  const tb = Date.parse('1985-01-01T03:00:00Z');
  for (const m of [4.4, 4.5, 6.1]) b.add(feat(tb, m), 4.5);
  b.add(feat(tb, 5, { type: 'explosion' }), 4.5);
  b.finish({ dropped: new Map(), outOfRegion: new Set() });
  assert.equal(b.belowFloor, 1);
  assert.deepEqual([...b.area.values()][0], [2, 2, 610]);
});

test('collapsed_into of the year and area tables: the pairs whose representative is a row of the year at or above the table\'s floor', () => {
  const days = yearDays(2024, '2024-01-02');
  const acc = new YearAccumulator(2024, days, true);
  const t = Date.parse('2024-01-01T01:00:00Z');
  const rows = [feat(t, 6.2), feat(t, 5.6), feat(t, 5.2), feat(t, 4.6), feat(t, 4.9), feat(t, 4.2), feat(t, 6.1)];
  for (const f of rows) acc.add(f, null);
  const id = (i: number): string => rows[i]!['id'] as string;
  // 5.6 into 6.2 (an M6 representative), 4.6 into 5.2 (M5), 4.2 into 4.9 (below both floors); a context row of the
  // year before (the day before New Year) into the 6.2; the year's own 6.1 into a context row of the year before,
  // which only the year before can list (its file holds the representative's row).
  const prevCtx = 'efd_01HK0ZZZZZZZZZZZZZZZZZZZZZ';
  const prevRep = 'efd_01HK0YYYYYYYYYYYYYYYYYYYYY';
  const dropped = new Map([[id(1), id(0)], [id(3), id(2)], [id(5), id(4)], [prevCtx, id(0)], [id(6), prevRep]]);
  acc.finish({ dropped, outOfRegion: new Set() });
  assert.deepEqual(acc.collapsedIntoAtLeast(600).sort(), [[id(1), id(0)], [prevCtx, id(0)]].sort());
  assert.deepEqual(acc.collapsedIntoAtLeast(500).sort(), [[id(1), id(0)], [id(3), id(2)], [prevCtx, id(0)]].sort());
  assert.equal(acc.collapsedTotal, 4, 'the counters hold the year\'s own rows only');
  assert.deepEqual(acc.m6.map((e) => e.id), [id(0)]);
  assert.deepEqual(acc.m5.map((e) => e.id).sort(), [id(0), id(2)].sort());
  // Every pair of a table names a representative that is a row of that table.
  for (const [floor, table] of [[600, acc.m6], [500, acc.m5]] as const) {
    const ids = new Set(table.map((e) => e.id));
    assert.ok(acc.collapsedIntoAtLeast(floor).every(([k, rep]) => ids.has(rep) && !ids.has(k)));
  }
});

test('the builder version: providers/stats.json and STATS_BUILDER_VERSION agree (3: collapsed_into)', () => {
  assert.equal(config.builder, STATS_BUILDER_VERSION);
  assert.equal(STATS_BUILDER_VERSION, 3);
});

test('dupSuspects: M4.5+ pairs of different providers within 60 s and 100 km', () => {
  const t = Date.parse('2024-03-01T00:00:00Z');
  const rows = [
    { t, lat: 10, lon: 120, prov: 'usgs', id: 'a' },
    { t: t + 30_000, lat: 10.5, lon: 120, prov: 'emsc', id: 'b' },
    { t: t + 59_000, lat: 10, lon: 120, prov: 'usgs', id: 'c' },
    { t: t + 61_000, lat: 10, lon: 120, prov: 'geofon', id: 'd' },
    { t: t + 200_000, lat: 12, lon: 120, prov: 'emsc', id: 'e' },
  ];
  const d = dupSuspects(rows);
  assert.deepEqual(d.pairs.map((p) => `${p.a}-${p.b}`), ['a-b', 'b-c', 'b-d', 'c-d']);
  assert.equal(d.count, 4);
});

// --- the in-memory re-merge (A6) ---

function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return { provider, providerEventId: id, eventTimeMs: Date.parse('2024-06-11T00:00:00Z'), providerUpdatedMs: null, status: 'reviewed', lat: 10, lon: 120, depth: 10, mag: 6.1, magType: 'mww', place: 'test', knownAliasIds: [], fields: {}, ...over };
}
/** One M6 quake as three feed events (the backfill: each report alone, merge pass off). */
function splitM6(t: number): F[] {
  const rows = [
    obs('usgs', 'us6000test', { eventTimeMs: t, mag: 6.1, fields: { ids: ',us6000test,' } }),
    obs('geofon', 'gfz2024test', { eventTimeMs: t + 2_000, lat: 10 + 22 / KM_PER_DEG, mag: 6.0, magType: 'mw' }),
    obs('emsc', '20240611_test', { eventTimeMs: t + 3_000, lat: 10 - 18 / KM_PER_DEG, mag: 5.9, magType: 'mw' }),
  ];
  const out: F[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const one = new Map<string, EventNode>();
    new Resolver(one, priorityMap(registry), configMap(registry), t + 30 * DAY, { hotFloorMs: 0, merge: false }).ingest(row, IT);
    for (const n of one.values()) {
      while (ids.has(n.feedId)) n.feedId = `${n.feedId.slice(0, -1)}${String.fromCharCode(n.feedId.charCodeAt(n.feedId.length - 1) === 90 ? 48 : n.feedId.charCodeAt(n.feedId.length - 1) + 1)}`;
      ids.add(n.feedId);
      out.push(nodeToFeature(n) as F);
    }
  }
  return out;
}

function yearOf2024(mergeEpoch: number | undefined, june: F[]): { idx: InputIndex; io: ReturnType<typeof fakeIo> } {
  const archives = monthsOf(2024).map((p) => archive(p, mergeEpoch == null ? {} : { merge_epoch: mergeEpoch, merge_rules: 3 }));
  const byDay = new Map<string, F[]>();
  for (const f of june) {
    const d = new Date((f['properties'] as { time: number }).time).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(f);
  }
  const members = new Map([...byDay].map(([d, fs]) => [`${d.slice(8, 10)}.ndjson`, ndjson(fs)]));
  const io = fakeIo(new Map([['archive-2024-06/events-2024-06.tar.zst', members]]));
  return { idx: { remediation: remediation([]), partitions: new Map(), archives, history: null }, io };
}

test('in-memory re-merge: an unmerged archive month counts one M6 quake once (remerged_in_memory); a merged one is read as it is', () => {
  const t = Date.parse('2024-06-11T05:00:00Z');
  const june = splitM6(t);
  assert.equal(june.length, 3, 'three split feed events');
  {
    const { idx, io } = yearOf2024(undefined, june);
    const lk = inputLookup(idx, 1);
    const plan = planYear(2024, '2024-12-31', lk, 1);
    assert.equal(plan.unmergedMonths.length, 12);
    const b = buildYear(plan, new InputReader(io), { builder: 1, detailed: true, registry, lookup: lk, through: '2024-12-31' });
    assert.equal(b.acc.m6.length, 1, 'one M6 after the re-merge');
    assert.equal(b.acc.m6[0]!.provider, 'usgs', 'the survivor carries ComCat\'s solution');
    assert.equal(b.folds, 2);
    assert.equal(b.remergedMonths.length, 12);
    const area = JSON.parse(b.areaBody) as { m6: { count: number }; records: number; total: number[] };
    assert.equal(area.m6.count, 1);
    assert.equal(area.total.reduce((s, x) => s + x, 0), 1);
  }
  {
    const { idx, io } = yearOf2024(1, june);
    const lk = inputLookup(idx, 1);
    const plan = planYear(2024, '2024-12-31', lk, 1);
    assert.equal(plan.unmergedMonths.length, 0);
    const b = buildYear(plan, new InputReader(io), { builder: 1, detailed: false, registry, lookup: lk, through: '2024-12-31' });
    assert.equal(b.acc.collapsed.reduce((a, x) => a + x, 0), 2, 'merged inputs are read as published; the reconciliation collapses the split lines');
    assert.equal(b.acc.m6.length, 1);
    assert.equal(b.acc.m6[0]!.provider, 'usgs', 'the representative holds the usgs row');
    assert.equal(b.yearBody, null);
    // Share links: the collapsed ids name the representative, the row the area M6+ table keeps.
    const area = JSON.parse(b.areaBody) as { m6: { id: string[]; collapsed_into: Record<string, string> } };
    const into = Object.entries(area.m6.collapsed_into);
    assert.equal(into.length, 2);
    assert.ok(into.every(([id, rep]) => rep === area.m6.id[0] && !area.m6.id.includes(id)));
    assert.deepEqual(Object.keys(area.m6.collapsed_into), Object.keys(area.m6.collapsed_into).sort(), 'keys in feed-id order');
    assert.deepEqual(checkCollapsedInto(area.m6, 'area 2024 m6'), []);
  }
});

test('in-memory re-merge: the newer context is pinned (a duplicate across the month boundary is counted once, in the next month)', () => {
  const t = Date.parse('2024-06-30T23:59:58Z');
  const pair = splitM6(t).slice(0, 2); // usgs on 06-30, geofon on 07-01 00:00:00
  const june = pair.filter((f) => (f['properties'] as { time: number }).time < Date.parse('2024-07-01T00:00:00Z'));
  const july = pair.filter((f) => !june.includes(f));
  assert.equal(june.length, 1);
  assert.equal(july.length, 1);
  const archives = monthsOf(2024).map((p) => archive(p));
  const io = fakeIo(
    new Map([
      ['archive-2024-06/events-2024-06.tar.zst', new Map([['30.ndjson', ndjson(june)]])],
      ['archive-2024-07/events-2024-07.tar.zst', new Map([['01.ndjson', ndjson(july)]])],
    ]),
  );
  const lk = inputLookup({ remediation: remediation([]), partitions: new Map(), archives, history: null }, 1);
  const b = buildYear(planYear(2024, '2024-12-31', lk, 1), new InputReader(io), { builder: 1, detailed: true, registry, lookup: lk, through: '2024-12-31' });
  assert.equal(b.acc.m6.length, 1, 'counted once over the two months');
});

// --- the gate ---

/** ComCat answering m6 / m45 for `year` (every year when null), 0 for the others. */
const counter = (m6: number, m45: number, year: number | null = null): ComcatCount & { asked: string[] } => {
  const asked: string[] = [];
  const f = (async (s: number, e: number, mag: number) => {
    asked.push(`${new Date(s).toISOString().slice(0, 10)}..${new Date(e).toISOString().slice(0, 10)} M${mag}`);
    if (year != null && new Date(s).getUTCFullYear() !== year) return 0;
    return mag >= 6 ? m6 : m45;
  }) as ComcatCount & { asked: string[] };
  f.asked = asked;
  return f;
};

test('comcatGate: era B within +-2 %, 2000+ within the default bands, the open year warns only, a failed count is an error', async () => {
  const g = config.gate;
  const c = counter(174, 7214);
  const ok = await comcatGate({ year: 2010, through: '2026-10-28', eraB: false, currentYear: false, feed: { m6: 180, m45: 8000 }, gate: g, count: c });
  assert.equal(ok.gate, 'ok');
  assert.deepEqual(c.asked, ['2010-01-01..2011-01-01 M6', '2010-01-01..2011-01-01 M4.5']);
  assert.equal((await comcatGate({ year: 2010, through: '2026-10-28', eraB: false, currentYear: false, feed: { m6: 300, m45: 8000 }, gate: g, count: c })).gate, 'fail', 'M6+ 1.72x');
  assert.equal((await comcatGate({ year: 2010, through: '2026-10-28', eraB: false, currentYear: false, feed: { m6: 174, m45: 11000 }, gate: g, count: c })).gate, 'fail', 'M4.5+ 1.52x');
  assert.equal((await comcatGate({ year: 1985, through: '2026-10-28', eraB: true, currentYear: false, feed: { m6: 174, m45: 7400 }, gate: g, count: c })).gate, 'fail', 'era B: +2.6 %');
  assert.equal((await comcatGate({ year: 1985, through: '2026-10-28', eraB: true, currentYear: false, feed: { m6: 176, m45: 7300 }, gate: g, count: c })).gate, 'ok');
  const cur = counter(10, 100);
  const w = await comcatGate({ year: 2026, through: '2026-10-28', eraB: false, currentYear: true, feed: { m6: 30, m45: 100 }, gate: g, count: cur });
  assert.equal(w.gate, 'warn');
  assert.deepEqual(w.window, { start: '2026-01-01', end: '2026-10-29' });
  const err = await comcatGate({ year: 2010, through: '2026-10-28', eraB: false, currentYear: false, feed: { m6: 1, m45: 1 }, gate: g, count: async () => { throw new Error('HTTP 503'); } });
  assert.equal(err.gate, 'error');
  assert.match(err.message!, /HTTP 503/);
});

test('verify: the sample takes the last 13 months and 6 older ones; a month passes on the era band and M6+ within max(2, 20 %)', () => {
  const all = Array.from({ length: 60 }, (_, i) => `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  const s = verifyMonths(all, 'sample', 42);
  assert.equal(s.length, 19);
  assert.deepEqual(s.slice(-13), all.slice(-13));
  assert.deepEqual(verifyMonths(all, 'sample', 42), s, 'seeded');
  assert.equal(verifyMonths(all, 'full', 1).length, 60);
  const b = config.gate.default;
  assert.equal(verifyRow('2020-01', { n45: 500, m6: 10, dup: 0 }, { m45: 480, m6: 12 }, b, false).ok, true);
  assert.equal(verifyRow('2020-01', { n45: 900, m6: 10, dup: 0 }, { m45: 480, m6: 12 }, b, false).ok, false);
  assert.equal(verifyRow('2020-01', { n45: 500, m6: 3, dup: 0 }, { m45: 480, m6: 6 }, b, false).ok, false);
  assert.equal(verifyRow('2020-01', { n45: 900, m6: 3, dup: 0 }, { m45: 480, m6: 6 }, b, true).ok, true, 'the open month reports only');
});

// --- the run ---

function run2024(o: { state: StatsHistoryState; io: StatsIo; comcat: ComcatCount; fileExists?: (p: string) => boolean; forced?: Set<number>; maxYears?: number; mergeEpoch?: number }) {
  const archives = [...monthsOf(2023), ...monthsOf(2024)].map((p) => archive(p, { merge_epoch: o.mergeEpoch ?? 1, merge_rules: 3, sha256: SHA(p.slice(2, 4)) }));
  const lookup = inputLookup({ remediation: remediation([]), partitions: new Map(), archives, history: null }, 1);
  return runStatsHistory({
    nowMs: Date.parse('2025-01-11T12:00:00Z'),
    config,
    lookup,
    state: o.state,
    fileExists: o.fileExists ?? (() => true),
    forced: o.forced ?? new Set(),
    maxYears: o.maxYears ?? 6,
    budgetMs: 60_000,
    reader: new InputReader(o.io),
    registry,
    comcat: o.comcat,
    runId: '1',
  });
}

test('runStatsHistory: builds the stale years newest first, writes area and year files and the ledger; a second run has nothing to do', async () => {
  const t = Date.parse('2024-06-11T05:00:00Z');
  const io = fakeIo(new Map([['archive-2024-06/events-2024-06.tar.zst', new Map([['11.ndjson', ndjson([feat(t, 6.2), feat(t + 3_600_000, 4.6)])]])]]));
  const r = await run2024({ state: emptyState(1), io, comcat: counter(1, 2, 2024) });
  assert.equal(r.through, '2024-12-31');
  assert.deepEqual(r.reports.map((x) => [x.year, x.result]), [[2024, 'built'], [2023, 'built']]);
  assert.deepEqual([...r.writes.keys()].sort(), ['v1/stats/area/2023.json', 'v1/stats/area/2024.json', 'v1/stats/year/2023.json', 'v1/stats/year/2024.json']);
  const s24 = r.state.years['2024']!;
  assert.equal(s24.check!.gate, 'ok');
  assert.equal(s24.remerged_in_memory, false);
  assert.deepEqual(s24.months!['2024-06'], { n45: 2, m6: 1, dup: 0 });
  assert.equal(r.state.through, '2024-12-31');
  assert.equal(r.changed, true);
  const year = JSON.parse(r.writes.get('v1/stats/year/2024.json')!) as { days: { total: number[] }; first: string; through: string; complete: boolean };
  assert.equal(year.days.total.length, 366);
  assert.deepEqual([year.first, year.through, year.complete], ['2024-01-01', '2024-12-31', true]);
  // The ledger text parses back and lists years one per line.
  const text = stateText(r.state);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(r.state)));
  const again = await run2024({ state: JSON.parse(text) as StatsHistoryState, io, comcat: counter(1, 2, 2024) });
  assert.equal(again.changed, false);
  assert.equal(again.reports.length, 0);
});

test('runStatsHistory: a failed input keeps the previous files and records the error; a failed gate keeps them and is not retried on the same inputs', async () => {
  const t = Date.parse('2024-06-11T05:00:00Z');
  const good = fakeIo(new Map([['archive-2024-06/events-2024-06.tar.zst', new Map([['11.ndjson', ndjson([feat(t, 6.2)])]])]]));
  const first = await run2024({ state: emptyState(1), io: good, comcat: counter(1, 1, 2024) });
  const prevArea = first.state.years['2024']!.area!;
  // A re-rolled June (a new checksum) whose download fails.
  const failing = fakeIo(new Map(), new Map(), new Map(), new Set(['archive-2024-06/events-2024-06.tar.zst']));
  const r = await run2024({ state: first.state, io: failing, comcat: counter(1, 1, 2024), forced: new Set([2024]) });
  assert.equal(r.reports[0]!.result, 'error');
  assert.equal(r.writes.size, 0);
  assert.deepEqual(r.state.years['2024']!.area, prevArea, 'the previous files stay listed');
  assert.match(r.state.years['2024']!.error!, /download/);
  assert.equal(r.blocked.length, 1);
  // The gate fails: old files stay, the digest is remembered, the next run does not retry.
  const g = await run2024({ state: first.state, io: good, comcat: counter(50, 1, 2024), forced: new Set([2024]) });
  assert.equal(g.reports[0]!.result, 'gate-failed');
  assert.equal(g.writes.size, 0);
  assert.deepEqual(g.state.years['2024']!.area, prevArea);
  assert.equal(g.state.years['2024']!.check!.gate, 'fail');
  assert.ok(g.blocked.some((b) => b.startsWith('stats 2024: ComCat gate fail')));
  // Inputs changed (a merged June lands) after the failed gate: rebuilt; same inputs: not.
  const g2 = await run2024({ state: { ...g.state, years: { ...g.state.years, '2024': { ...g.state.years['2024']!, inputs_digest: SHA('0'), failed_digest: SHA('0') } } }, io: good, comcat: counter(1, 1, 2024) });
  assert.equal(g2.reports.find((x) => x.year === 2024)?.result, 'built');
  const g3 = await run2024({ state: { ...g.state, years: { ...g.state.years, '2024': { ...g.state.years['2024']!, inputs_digest: SHA('0') } } }, io: good, comcat: counter(1, 1, 2024) });
  assert.equal(g3.reports.find((x) => x.year === 2024), undefined, 'the failed digest is not retried');
  assert.ok(g3.blocked.some((b) => b.startsWith('stats 2024: ComCat gate failed')), 'the marker keeps alarming');
});

test('runStatsHistory: a first build that fails its gate publishes nothing; max_years and the budget leave the rest stale', async () => {
  const io = fakeIo(new Map());
  const r = await run2024({ state: emptyState(1), io, comcat: counter(5, 5), maxYears: 1 });
  assert.equal(r.reports.length, 1);
  assert.equal(r.reports[0]!.year, 2024);
  assert.equal(r.reports[0]!.result, 'gate-failed');
  assert.equal(r.state.years['2024']!.area, undefined, 'never published');
  assert.equal(r.state.through, null);
  assert.equal(r.state.years['2023'], undefined, 'max_years: 2023 waits');
});

test('runStatsHistory: digest change when the merged assets land rebuilds the year without remerged_in_memory', async () => {
  const t = Date.parse('2024-06-11T05:00:00Z');
  const june = splitM6(t);
  const members = new Map([['11.ndjson', ndjson(june)]]);
  const io = fakeIo(new Map([['archive-2024-06/events-2024-06.tar.zst', members]]));
  const unmerged = await run2024({ state: emptyState(1), io, comcat: counter(1, 1, 2024), mergeEpoch: 0, forced: new Set([2024]) });
  assert.equal(unmerged.state.years['2024']!.remerged_in_memory, true);
  assert.equal(unmerged.state.years['2024']!.area!.m6, 1);
  // (These test inputs are the same split lines, now listed as merged: the reconciliation leaves one.)
  const merged = await run2024({ state: unmerged.state, io, comcat: counter(1, 1, 2024), mergeEpoch: 1 });
  const rep = merged.reports.find((x) => x.year === 2024)!;
  assert.equal(rep.reason, 'inputs changed');
  assert.equal(rep.result, 'built');
  assert.equal(merged.state.years['2024']!.remerged_in_memory, false);
  assert.equal(merged.state.years['2024']!.area!.m6, 1);
  assert.equal(merged.state.years['2024']!.collapsed, 2);
});

test('InputReader: a month\'s remediated days never push its archive out of the cache; partition blobs are prefetched in one go', () => {
  const rems = monthDays('2025-08').slice(10, 25).map((d) => remEdition(d, 1));
  const idx: InputIndex = { remediation: remediation(rems), partitions: new Map([['2025-08-31', 'f'.repeat(40)]]), archives: [archive('2025-08')], history: null };
  const lk = inputLookup(idx, 1);
  const io = fakeIo(new Map());
  const prefetched: string[][] = [];
  io.prefetchPartitions = (oids) => void prefetched.push(oids);
  const reader = new InputReader(io);
  const inputs = monthDays('2025-08').map((d) => chooseDayInput(d, lk));
  reader.prefetch(inputs);
  monthDays('2025-08').forEach((d, i) => reader.dayText(d, inputs[i]!));
  assert.deepEqual(prefetched, [['f'.repeat(40)]]);
  assert.equal(io.calls.filter((c) => c === 'archive-2025-08/events-2025-08.tar.zst').length, 1, 'the archive is downloaded once');
  assert.equal(reader.downloads, 16, 'the archive and 15 remediation editions');
});

test('late_usgs (SHLTR-150): an unarchived frozen day reads its current edition built on the partition, not the partition; the month counts follow', () => {
  const day = '2026-09-15';
  const t = Date.parse(`${day}T06:00:00Z`);
  // The partition as the day froze: ComCat's early M4.4; the late_usgs edition: the same quake at M4.6 and a late M4.8.
  const node = (row: RawObs): F => {
    const one = new Map<string, EventNode>();
    new Resolver(one, priorityMap(registry), configMap(registry), t + 30 * DAY, { hotFloorMs: 0, merge: false }).ingest(row, IT);
    return nodeToFeature([...one.values()][0]!) as F;
  };
  const early = node(obs('usgs', 'us7000late1', { eventTimeMs: t, mag: 4.4, magType: 'mb', fields: { ids: ',us7000late1,' } }));
  const upgraded = JSON.parse(JSON.stringify(early)) as F;
  const up = upgraded['properties'] as { mag: number; feed: { provenance: { mag: number }[] } };
  up.mag = 4.6;
  up.feed.provenance[0]!.mag = 4.6;
  const late = node(obs('usgs', 'us7000late2', { eventTimeMs: t + 3_600_000, lat: -20, lon: -175, mag: 4.8, magType: 'mb', fields: { ids: ',us7000late2,' } }));
  const partBlob = 'c'.repeat(40);
  const ed = { ...remEdition(day, 1), reason: 'late_usgs', built_on: { tag: 'data', asset: 'events/2026/09/15.ndjson', sha256: SHA('p'), blob: partBlob }, stats: { remerge: { epoch: 1, from_edition: 0 } } } as unknown as EditionRef;
  const idx: InputIndex = { remediation: remediation([ed]), partitions: new Map([[day, partBlob], ['2026-09-16', 'd'.repeat(40)]]), archives: [], history: null };
  const lk = inputLookup(idx, 1);
  const r = chooseDayInput(day, lk)!;
  assert.deepEqual([r.kind, r.key, r.merged], ['remediation', `remediation-2026/events-${day}.e1.ndjson.gz`, true], 'the current edition, whatever its reason; merged (epoch 1, no archive yet)');
  assert.equal(chooseDayInput('2026-09-16', lk)!.kind, 'partition', 'a day without an edition keeps its partition');
  const plan = planYear(2026, '2026-09-16', lk, 1);
  assert.equal(plan.inputs.filter((i) => i?.kind === 'remediation').length, 1);
  assert.equal(plan.inputs.filter((i) => i?.kind === 'partition').length, 1);
  const io = fakeIo(new Map(), new Map([[`remediation-2026/events-${day}.e1.ndjson.gz`, ndjson([upgraded, late])]]), new Map([[day, ndjson([early])], ['2026-09-16', '']]));
  const b = buildYear(plan, new InputReader(io), { builder: 1, detailed: false, registry, lookup: lk, through: '2026-09-16' });
  assert.ok(io.calls.includes(`remediation-2026/events-${day}.e1.ndjson.gz`), 'the edition is read');
  assert.ok(!io.calls.includes(`partition ${day}`), 'its partition is not');
  assert.equal(b.acc.months.get('2026-09')!.n45, 2, 'the verify table counts the month from the same inputs');
  // Without the edition (a dry run publishes nothing), the partition's M4.4 counts nothing.
  const bare = inputLookup({ ...idx, remediation: remediation([]) }, 1);
  const b0 = buildYear(planYear(2026, '2026-09-16', bare, 1), new InputReader(fakeIo(new Map(), new Map(), new Map([[day, ndjson([early])], ['2026-09-16', '']]))), { builder: 1, detailed: false, registry, lookup: bare, through: '2026-09-16' });
  assert.equal(b0.acc.months.get('2026-09')?.n45 ?? 0, 0);
});
