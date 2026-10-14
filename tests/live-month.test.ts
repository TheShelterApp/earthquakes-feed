import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Resolver } from '../src/dedup.js';
import { LIVE_MONTH_PATH, MONTH_MIN_MAG, MONTH_NEWEST_OFFSET_DAYS, liveMonthDays, writeLiveMonth, type LiveMonthIndex } from '../src/live-month.js';
import { LIVE_FEATURES_FORMAT, liveDayJson, liveWindowDays, sha256Hex } from '../src/live-sync.js';
import { LogBuffer } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { summaries, summaryFeats } from '../src/summaries.js';
import type { EventNode, RawObs } from '../src/types.js';

// PRB-2 (round 27): the month index publishes the month under the live week (all_month's M >= 2.5 days through
// today - 6) as per-day files with fingerprints. A client that holds the days must hold exactly what all_month carries
// for them, and a day whose events did not change must keep its bytes across runs.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.parse('2026-10-14T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const dayOf = (ms: number): string => iso(ms).slice(0, 10);

function obs(provider: string, id: string, timeMs: number, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: timeMs,
    providerUpdatedMs: null,
    status: 'automatic',
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

type State = { map: Map<string, EventNode>; seq: number };

/** Two events a day for 35 days, each first ingested an hour after its origin: one of M 2.5 + d/20 (in the month) and
 *  one of M 2.0 (below the floor). */
function world(): State {
  const map = new Map<string, EventNode>();
  let seq = 1000;
  for (let d = 35; d >= 0; d--) {
    for (const [k, mag, offset] of [['a', 2.5 + d / 20, 2 * H], ['b', 2.0, 5 * H]] as const) {
      const t = T0 - d * DAY - offset;
      const r = new Resolver(map, prio, cfg, t + H);
      const log = new LogBuffer(seq, iso(t + H));
      const raw = obs('usgs', `us${d}${k}`, t, { mag });
      log.record(raw, r.ingest(raw, iso(t + H)));
      seq = log.seq;
    }
  }
  return { map, seq };
}

function run(state: State, nowMs: number, raws: RawObs[], tombstone: RawObs[] = []): void {
  const r = new Resolver(state.map, prio, cfg, nowMs);
  const log = new LogBuffer(state.seq, iso(nowMs));
  for (const raw of raws) log.record(raw, r.ingest(raw, iso(nowMs)));
  for (const raw of tombstone) {
    const res = r.tombstoneProvider(raw, iso(nowMs));
    if (res) log.record(raw, res, 'tombstone');
  }
  state.seq = log.seq;
}

function publish(state: State, nowMs: number): { dir: string; index: LiveMonthIndex; files: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'month-'));
  const out = writeLiveMonth(summaryFeats([...state.map.values()], nowMs), { publicV1: join(dir, 'v1'), nowMs, headSeq: state.seq });
  return { dir, index: out.index, files: out.files };
}

type Fc = { metadata: Record<string, unknown>; features: { id: string; properties: { time: number; mag: number | null; feed: { state: string } } }[] };
const parse = (s: string): Fc => JSON.parse(s) as Fc;

function allMonth(state: State, nowMs: number): Fc {
  const dir = mkdtempSync(join(tmpdir(), 'month-summary-'));
  try {
    summaries(summaryFeats([...state.map.values()], nowMs), nowMs, dir, iso(nowMs));
    return parse(readFileSync(join(dir, 'all_month.geojson'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the days run from the day of now - 30 d through today - 6, and overlap the live window by its two oldest days', () => {
  const days = liveMonthDays(T0);
  assert.equal(days[0], dayOf(T0 - 30 * DAY));
  assert.equal(days.at(-1), dayOf(T0 - MONTH_NEWEST_OFFSET_DAYS * DAY));
  assert.equal(days.length, 25);
  for (let i = 1; i < days.length; i++) assert.equal(Date.parse(days[i]!) - Date.parse(days[i - 1]!), DAY, 'consecutive');
  const live = liveWindowDays(T0);
  assert.deepEqual(days.filter((d) => live.includes(d)), live.slice(0, 2), 'the live window starts at today - 7');
  // Just before and after a UTC midnight the newest day moves with it.
  assert.equal(liveMonthDays(Date.parse('2026-10-14T23:59:00Z')).at(-1), '2026-10-08');
  assert.equal(liveMonthDays(Date.parse('2026-10-15T00:01:00Z')).at(-1), '2026-10-09');
});

test('the day files hold exactly the all_month features of their days, at its floor, written to disk byte for byte', () => {
  const s = world();
  // A withdrawal of an in-month event 10 days back: all_month publishes it non-live for 48 h, so the day file does too.
  run(s, T0 - H, [], [obs('usgs', 'us10a', T0 - 10 * DAY - 2 * H, { mag: 3.0 })]);
  const { dir, index, files } = publish(s, T0);
  try {
    assert.deepEqual(index.days.map((d) => d.date), liveMonthDays(T0));
    assert.equal(index.min_mag, MONTH_MIN_MAG);
    assert.equal(index.features_format, LIVE_FEATURES_FORMAT);
    assert.equal(index.newest_offset_days, MONTH_NEWEST_OFFSET_DAYS);
    assert.equal(index.window_days, 30);
    const month = allMonth(s, T0);
    assert.equal(month.metadata['min_mag'], MONTH_MIN_MAG, 'setup: all_month at its own floor');
    const wanted = new Set(index.days.map((d) => d.date));
    const expected = new Map(month.features.filter((f) => wanted.has(dayOf(f.properties.time))).map((f) => [f.id, JSON.stringify(f)]));
    const held = new Map<string, string>();
    for (const d of index.days) {
      const fc = parse(files[d.path]!);
      for (const f of fc.features) held.set(f.id, JSON.stringify(f));
      assert.equal(fc.metadata['min_mag'], MONTH_MIN_MAG);
      assert.equal(fc.metadata['date'], d.date);
      const onDisk = readFileSync(join(dir, d.path), 'utf8');
      assert.equal(onDisk, files[d.path]);
      assert.equal(Buffer.byteLength(onDisk), d.bytes);
      assert.equal(sha256Hex(onDisk), d.sha256);
      assert.equal(d.count, fc.features.filter((f) => f.properties.feed.state === 'live').length);
    }
    // all_month covers 30 x 24 h; the oldest day file holds that whole day, so one event older than the window rides
    // along (the client's own time filter drops it, as with the live days).
    const extra = [...held.keys()].filter((id) => !expected.has(id));
    assert.deepEqual(extra.map((id) => dayOf(parse(`{"features":[${held.get(id)}]}`).features[0]!.properties.time)), [dayOf(T0 - 30 * DAY)]);
    for (const [id, f] of expected) assert.equal(held.get(id), f, `${id}: the same compact feature as all_month`);
    assert.ok([...held.values()].every((f) => (JSON.parse(f) as Fc['features'][number]).properties.mag! >= MONTH_MIN_MAG), 'nothing below the floor');
    const marker = [...held.values()].map((f) => JSON.parse(f) as Fc['features'][number]).find((f) => f.properties.feed.state === 'tombstoned');
    assert.ok(marker, 'the 48-hour marker of the withdrawal rides along, non-live');
    assert.equal(index.count, index.days.reduce((n, d) => n + d.count, 0));
    assert.equal(index.count, 24, 'one live in-month event per day, minus the withdrawn one');
    assert.deepEqual(JSON.parse(files[LIVE_MONTH_PATH]!), index);
    assert.equal(readFileSync(join(dir, LIVE_MONTH_PATH), 'utf8'), files[LIVE_MONTH_PATH]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unchanged day keeps its bytes and sha256 from run to run; a revised day does not, nor does one that left the floor', () => {
  const s = world();
  const a = publish(s, T0);
  run(s, T0 + 5 * 60_000, [obs('usgs', 'us12a', T0 - 12 * DAY - 2 * H, { mag: 3.4, status: 'reviewed' })]);
  run(s, T0 + 6 * 60_000, [obs('usgs', 'us15a', T0 - 15 * DAY - 2 * H, { mag: 2.2 })]);
  // A revision of a below-floor event moves nothing in the month.
  run(s, T0 + 7 * 60_000, [obs('usgs', 'us20b', T0 - 20 * DAY - 5 * H, { mag: 2.1 })]);
  const b = publish(s, T0 + 10 * 60_000);
  try {
    const shaA = new Map(a.index.days.map((d) => [d.date, d.sha256]));
    const changed = b.index.days.filter((d) => shaA.get(d.date) !== d.sha256).map((d) => d.date);
    assert.deepEqual(changed, [dayOf(T0 - 15 * DAY), dayOf(T0 - 12 * DAY)]);
    const left = parse(b.files[b.index.days.find((d) => d.date === dayOf(T0 - 15 * DAY))!.path]!);
    assert.equal(left.features.length, 0, 'the event revised below M 2.5 leaves its day, as it leaves all_month');
    assert.notEqual(a.files[LIVE_MONTH_PATH], b.files[LIVE_MONTH_PATH], 'the index is rewritten every run');
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test('the live index day files keep their round-15 bytes: no floor, no month title', () => {
  const s = world();
  const feats = summaryFeats([...s.map.values()], T0).filter((f) => dayOf(f.timeMs) === dayOf(T0));
  const live = JSON.parse(liveDayJson(dayOf(T0), feats)) as Fc;
  assert.equal(live.metadata['title'], `earthquakes-feed live day ${dayOf(T0)}`);
  assert.equal('min_mag' in live.metadata, false);
  assert.deepEqual(Object.keys(live.metadata), ['generated', 'generated_iso', 'title', 'api', 'date', 'count', 'schema_version', 'attribution']);
  const month = JSON.parse(liveDayJson(dayOf(T0), feats, { title: 'm', minMag: 2.5 })) as Fc;
  assert.deepEqual(Object.keys(month.metadata), ['generated', 'generated_iso', 'title', 'api', 'date', 'count', 'min_mag', 'schema_version', 'attribution']);
  assert.deepEqual(month.features, live.features, 'the same features either way');
});
