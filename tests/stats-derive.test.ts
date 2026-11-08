import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { eventDayKey } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import { LogBuffer } from '../src/oplog.js';
import { dayPartitionFile, writeDayPartition } from '../src/partitions.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import {
  STATS_INDEX_PATH,
  checkStats,
  deriveStats,
  loadStatsConfig,
  parseStatsConfig,
  statsDays,
  writeStats,
  type StatsConfig,
  type StatsIndex,
} from '../src/stats.js';
import { AREA_COLUMNS, STATS_ATTRIBUTION, YEAR_COLUMNS, buildEventTable, dayRows, dayTableJson, parseNdjson, statsEventOf, type DayRows, type StatsEvent } from '../src/stats-table.js';
import type { EventNode, RawObs } from '../src/types.js';

// derive's stats step (APIs.md, Statistics): 61 day tables, the event-map days from the partition loop's features, the
// days the 45-day map does not hold from the data checkout's partitions, the stats builder's year and area files copied
// only when the ledger names their bytes, and never a blocked deploy: any failure drops the run's stats.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const config: StatsConfig = parseStatsConfig(JSON.parse(readFileSync(here('../providers/stats.json'), 'utf8')));
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

function obs(id: string, timeMs: number, over: Partial<RawObs> = {}): RawObs {
  return {
    provider: 'usgs',
    providerEventId: id,
    eventTimeMs: timeMs,
    providerUpdatedMs: null,
    status: 'reviewed',
    lat: 10 + (timeMs % 997) / 100,
    lon: 120 + (timeMs % 991) / 100,
    depth: 10,
    mag: 3.1,
    magType: 'ml',
    place: `place ${id}`,
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

/** Two events a day, today - 62 .. today, first ingested an hour after their origin. */
function nodes(): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  let seq = 1000;
  for (let d = 62; d >= 0; d--) {
    for (const [k, mag, offset] of [['a', 4.6, 2 * H], ['b', 2.2, 5 * H]] as const) {
      const t = Date.parse(`${eventDayKey(NOW - d * DAY)}T12:00:00Z`) - offset;
      const r = new Resolver(map, prio, cfg, t + H);
      const log = new LogBuffer(seq, iso(t + H));
      const raw = obs(`us${d}${k}`, t, { mag });
      log.record(raw, r.ingest(raw, iso(t + H)));
      seq = log.seq;
    }
  }
  return map;
}

interface World {
  dataDir: string;
  publicDir: string;
  shadowDir: string;
  tables: Map<string, DayRows>;
}

/** Writes every day's partition into a temp data checkout (all but `skip`), and keeps the tables of the map days
 *  (today - 45 .. today) as derive's partition loop does. */
function world(skip: string[] = []): World {
  const root = mkdtempSync(join(tmpdir(), 'stats-derive-'));
  const dataDir = join(root, 'data');
  const publicDir = join(root, 'public');
  const shadowDir = join(root, 'shadow');
  mkdirSync(dataDir);
  const byDay = new Map<string, EventNode[]>();
  for (const n of nodes().values()) (byDay.get(eventDayKey(n.eventTimeMs)) ?? byDay.set(eventDayKey(n.eventTimeMs), []).get(eventDayKey(n.eventTimeMs))!).push(n);
  const mapFrom = eventDayKey(NOW - 45 * DAY);
  const tables = new Map<string, DayRows>();
  for (const [day, ns] of byDay) {
    if (skip.includes(day)) continue;
    const out = writeDayPartition(dataDir, day, ns, { nowMs: NOW, headIngestTime: iso(NOW), fmt: { version: 1, review_status_from: eventDayKey(NOW - 20 * DAY) } });
    if (day >= mapFrom) tables.set(day, dayRows(day, out.feats));
  }
  return { dataDir, publicDir, shadowDir, tables };
}

const readIndex = (dir: string): StatsIndex => JSON.parse(readFileSync(join(dir, STATS_INDEX_PATH), 'utf8')) as StatsIndex;
const quiet = (): ((m: string) => void) & { lines: string[] } => {
  const lines: string[] = [];
  return Object.assign((m: string) => void lines.push(m), { lines });
};

test('statsDays: today - 60 .. today', () => {
  const days = statsDays(NOW);
  assert.equal(days.length, 61);
  assert.equal(days[0], '2026-09-09');
  assert.equal(days.at(-1), '2026-11-08');
  assert.deepEqual(statsDays(Date.parse('2026-11-08T00:00:00Z')), days);
  assert.deepEqual(statsDays(Date.parse('2026-11-08T23:59:59.999Z')), days);
});

test('61 days: the map days from the loop, older ones from the data checkout, a missing one named', () => {
  const missingDay = eventDayKey(NOW - 50 * DAY);
  const w = world([missingDay]);
  assert.equal(w.tables.size, 46);
  const warn = quiet();
  const out = writeStats(w.tables, { publicDir: w.publicDir, dataDir: w.dataDir, nowMs: NOW, headSeq: 4242, config, warn });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(warn.lines, []);
  const idx = readIndex(w.publicDir);
  assert.equal(idx.days.length, 60);
  assert.deepEqual(idx.missing_days, [missingDay]);
  assert.equal(out.fromData.length, 14);
  assert.deepEqual([idx.generated, idx.head_seq, idx.format, idx.through], [NOW, 4242, 1, null]);
  assert.deepEqual([idx.years, idx.area], [[], []]);
  assert.deepEqual(idx.completeness, config.epochs);
  assert.equal(idx.attribution, STATS_ATTRIBUTION);
  assert.deepEqual(out.pointer, { path: 'v1/stats/index.json', url: 'https://earthquakes-feed.theshelter.app/v1/stats/index.json', head_seq: 4242, format: 1 });
  for (const d of idx.days) {
    const body = readFileSync(join(w.publicDir, d.path));
    assert.equal(body.byteLength, d.bytes);
    assert.equal(sha(body), d.sha256);
    assert.deepEqual([d.count, d.filtered], [2, 0], d.date);
  }
  // A map day's table equals the one rebuilt from its partition file: the two paths give the same bytes.
  const mapDay = eventDayKey(NOW - 3 * DAY);
  const fromFile = dayTableJson(mapDay, parseNdjson(readFileSync(dayPartitionFile(w.dataDir, mapDay), 'utf8')));
  assert.equal(readFileSync(join(w.publicDir, `v1/stats/days/${mapDay}.json`), 'utf8'), fromFile.body);
  assert.deepEqual(checkStats(w.publicDir, NOW), []);
  assert.match(checkStats(w.publicDir, NOW + 1)[0]!, /generated/, 'the index belongs to one run');
});

function yearDoc(): string {
  const ev = (statsEventOf({ type: 'Feature', id: 'efd_01M6Q2J4WG0000000000000001', geometry: { coordinates: [140, 35, 10] }, properties: { mag: 5.3, time: Date.parse('2026-03-01T00:00:00Z'), type: 'earthquake', feed: { state: 'live', chosen_provider: 'usgs' } } }) as { ev: StatsEvent }).ev;
  return JSON.stringify({
    format: 1, kind: 'year', year: 2026, builder: 2, first: '2026-01-01', through: '2026-11-05', complete: false,
    mag_edges_e2: [200, 250, 300, 350, 400, 450, 500, 600, 700], provider_names: ['usgs'],
    days: { total: [1], filtered: [0], collapsed: [0], bins: [[0, 0, 0, 0, 0, 0, 0, 1, 0, 0]], providers: [[0]], missing: [] },
    events: buildEventTable('year', Date.parse('2026-01-01T00:00:00Z'), [ev], YEAR_COLUMNS),
    reconciled: { rule: 'v2', collapsed: 0 },
    inputs_digest: 'a'.repeat(64), attribution: STATS_ATTRIBUTION,
  });
}
function areaDoc(year: number, minMag: number | null = null): string {
  const ev = (statsEventOf({ type: 'Feature', id: 'efd_01M6Q2J4WG0000000000000002', geometry: { coordinates: [140, 35, 10] }, properties: { mag: 6.4, time: Date.parse(`${year}-03-01T00:00:00Z`), type: 'earthquake', feed: { state: 'live', chosen_provider: 'usgs' } } }) as { ev: StatsEvent }).ev;
  return JSON.stringify({
    format: 1, kind: 'area', year, builder: 2, min_mag: minMag, through: `${year}-12-31`, complete: true, cell_deg: 0.1, records: 2,
    cell: [4_500_000, 5], total: [3, 1], m45: minMag ? [3, 1] : [1, 0], mmax: [640, 300],
    m6: buildEventTable('area', Date.parse(`${year}-01-01T00:00:00Z`), [ev], AREA_COLUMNS),
    reconciled: { rule: 'v2', collapsed: 0 },
    inputs_digest: 'b'.repeat(64), attribution: STATS_ATTRIBUTION,
  });
}

test('year and area files: copied byte for byte when the ledger names their sha256, dropped otherwise', () => {
  const w = world();
  const put = (path: string, body: string): void => {
    mkdirSync(join(w.dataDir, path, '..'), { recursive: true });
    writeFileSync(join(w.dataDir, path), body);
  };
  const year = yearDoc();
  const a2010 = areaDoc(2010);
  const a1985 = areaDoc(1985, 4.5);
  put('v1/stats/year/2026.json', year);
  put('v1/stats/area/2010.json', a2010);
  put('v1/stats/area/1985.json', a1985);
  put('v1/stats/area/2011.json', areaDoc(2011));
  put('v1/stats/area/1999.json', areaDoc(1999));
  put('knowledge/stats/state.json', JSON.stringify({
    version: 1, builder: 1, through: '2026-11-05',
    years: {
      '2026': { inputs_digest: 'a'.repeat(64), year: { bytes: Buffer.byteLength(year), sha256: sha(year) } },
      '2010': { inputs_digest: 'b'.repeat(64), area: { bytes: Buffer.byteLength(a2010), sha256: sha(a2010) } },
      '1985': { inputs_digest: 'b'.repeat(64), area: { bytes: Buffer.byteLength(a1985), sha256: sha(a1985) } },
      // The committed bytes are not the ones the ledger names (a commit race): dropped.
      '2011': { inputs_digest: 'b'.repeat(64), area: { bytes: 10, sha256: 'c'.repeat(64) } },
      // Listed but not on data.
      '2012': { inputs_digest: 'b'.repeat(64), area: { bytes: 10, sha256: 'c'.repeat(64) } },
    },
  }));
  const warn = quiet();
  const out = writeStats(w.tables, { publicDir: w.publicDir, dataDir: w.dataDir, nowMs: NOW, headSeq: 1, config, warn });
  assert.deepEqual(out.errors, []);
  const idx = readIndex(w.publicDir);
  assert.equal(idx.through, '2026-11-05');
  assert.deepEqual(idx.years, [{ year: 2026, path: 'v1/stats/year/2026.json', bytes: Buffer.byteLength(year), sha256: sha(year), first: '2026-01-01', through: '2026-11-05', complete: false, mirrorable: true }]);
  assert.deepEqual(idx.area.map((a) => [a.year, a.min_mag, a.records, a.m6, a.complete, a.mirrorable]), [[1985, 4.5, 2, 1, true, true], [2010, null, 2, 1, true, true]]);
  assert.equal(readFileSync(join(w.publicDir, 'v1/stats/area/2010.json'), 'utf8'), a2010);
  assert.deepEqual(out.dropped.sort(), ['v1/stats/area/2011.json', 'v1/stats/area/2012.json']);
  assert.ok(!existsSync(join(w.publicDir, 'v1/stats/area/2011.json')));
  assert.ok(!existsSync(join(w.publicDir, 'v1/stats/area/1999.json')));
  assert.equal(warn.lines.length, 3, warn.lines.join('\n'));
  assert.ok(warn.lines.some((l) => /area\/1999\.json is on data but not in/.test(l)));
  assert.ok(warn.lines.some((l) => /area\/2011\.json not published: not the bytes/.test(l)));
  assert.deepEqual(checkStats(w.publicDir, NOW), []);
});

test('the area invariants: increasing cells, m45 <= total, era B m45 == total', () => {
  const w = world();
  const bad = JSON.parse(areaDoc(1990, 4.5)) as Record<string, unknown>;
  bad['m45'] = [2, 1];
  const body = JSON.stringify(bad);
  mkdirSync(join(w.dataDir, 'v1/stats/area'), { recursive: true });
  writeFileSync(join(w.dataDir, 'v1/stats/area/1990.json'), body);
  mkdirSync(join(w.dataDir, 'knowledge/stats'), { recursive: true });
  writeFileSync(join(w.dataDir, 'knowledge/stats/state.json'), JSON.stringify({ version: 1, through: '2026-11-05', years: { '1990': { area: { bytes: Buffer.byteLength(body), sha256: sha(body) } } } }));
  const out = writeStats(w.tables, { publicDir: w.publicDir, dataDir: w.dataDir, nowMs: NOW, headSeq: 1, config, warn: quiet() });
  assert.ok(out.errors.some((e) => /min_mag 4\.5 but m45 != total/.test(e)), out.errors.join('\n'));
});

test('shadow writes nothing to PUBLIC_DIR and gives no pointer; on gives the pointer; off does nothing', () => {
  const w = world();
  const base = { config, tables: w.tables, publicDir: w.publicDir, shadowDir: w.shadowDir, dataDir: w.dataDir, nowMs: NOW, headSeq: 7, warn: quiet() };
  const shadow = deriveStats({ ...base, mode: 'shadow' });
  assert.equal(shadow.pointer, null);
  assert.ok(shadow.stats && shadow.stats.errors.length === 0);
  assert.ok(!existsSync(join(w.publicDir, 'v1')));
  assert.equal(readIndex(w.shadowDir).days.length, 61);
  const off = deriveStats({ ...base, mode: 'off' });
  assert.deepEqual(off, { stats: null, pointer: null, reason: null });
  const on = deriveStats({ ...base, mode: 'on' });
  assert.equal(on.pointer?.path, 'v1/stats/index.json');
  assert.equal(readIndex(w.publicDir).head_seq, 7);
  assert.equal(deriveStats({ ...base, mode: 'on', config: null }).pointer, null, 'no config: off');
});

test('a throw, a guard timeout, a failed check or a loop error leaves no public/v1/stats and no pointer', () => {
  const w = world();
  const base = { mode: 'on' as const, config, tables: w.tables, publicDir: w.publicDir, shadowDir: w.shadowDir, dataDir: w.dataDir, nowMs: NOW, headSeq: 7 };
  const cases: Array<[string, Partial<Parameters<typeof deriveStats>[0]>, RegExp]> = [
    ['throw', { write: (t, o) => { writeStats(t, o); throw new Error('boom'); } }, /threw: boom/],
    ['timeout', { write: (t, o) => ({ ...writeStats(t, o), ms: 9_000 }), loopMs: 1_500 }, /over the 10000 ms budget/],
    ['check', { tables: new Map([...w.tables].map(([d, r]) => [d, d === eventDayKey(NOW) ? { ...r, rows: r.rows.map((x) => ({ ...x, id: 'not-a-feed-id' })) } : r])) }, /check failed/],
    ['loop', { loopError: new Error('bad feature') }, /threw: bad feature/],
  ];
  for (const [name, over, why] of cases) {
    const warn = quiet();
    const r = deriveStats({ ...base, ...over, warn });
    assert.equal(r.pointer, null, name);
    assert.equal(r.stats, null, name);
    assert.match(r.reason ?? '', why, name);
    assert.ok(!existsSync(join(w.publicDir, 'v1', 'stats')), `${name}: v1/stats removed`);
    assert.equal(warn.lines.length, 1, name);
    assert.match(warn.lines[0]!, /^stats dropped: /, name);
  }
});

test('leftovers of an earlier local run are removed', () => {
  const w = world();
  mkdirSync(join(w.publicDir, 'v1/stats/days'), { recursive: true });
  writeFileSync(join(w.publicDir, 'v1/stats/days/2020-01-01.json'), '{}');
  mkdirSync(join(w.publicDir, 'v1/stats/area'), { recursive: true });
  writeFileSync(join(w.publicDir, 'v1/stats/area/1980.json'), '{}');
  writeStats(w.tables, { publicDir: w.publicDir, dataDir: w.dataDir, nowMs: NOW, headSeq: 1, config, warn: quiet() });
  assert.equal(readdirSync(join(w.publicDir, 'v1/stats/days')).length, 61);
  assert.ok(!existsSync(join(w.publicDir, 'v1/stats/area/1980.json')));
});

test('providers/stats.json: derive_publish read from the file; missing or invalid = off with a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-cfg-'));
  const good = JSON.parse(readFileSync(here('../providers/stats.json'), 'utf8')) as Record<string, unknown>;
  // The committed switches parse (flipping them is a one-line change of the file, no test change).
  assert.ok(['off', 'shadow', 'on'].includes(good['derive_publish'] as string));
  assert.equal(typeof good['history_enabled'], 'boolean');
  const f = join(dir, 'stats.json');
  writeFileSync(f, JSON.stringify({ ...good, derive_publish: 'shadow' }));
  assert.deepEqual([loadStatsConfig(f, {}).mode, loadStatsConfig(f, {}).warning], ['shadow', null]);
  assert.equal(loadStatsConfig(f, { STATS_PUBLISH: 'on' }).mode, 'on', 'a local run may override');
  assert.equal(loadStatsConfig(f, { STATS_PUBLISH: 'loud' }).mode, 'shadow');
  const missing = loadStatsConfig(join(dir, 'none.json'), { STATS_PUBLISH: 'on' });
  assert.deepEqual([missing.mode, missing.config], ['off', null]);
  assert.match(missing.warning!, /is missing: stats off/);
  for (const bad of [{ ...good, derive_publish: 'yes' }, { ...good, epochs: [] }, { ...good, gate: { eraB: {}, default: {} } }, '{']) {
    writeFileSync(f, typeof bad === 'string' ? bad : JSON.stringify(bad));
    const r = loadStatsConfig(f, {});
    assert.equal(r.mode, 'off');
    assert.match(r.warning!, /is invalid/);
  }
});
