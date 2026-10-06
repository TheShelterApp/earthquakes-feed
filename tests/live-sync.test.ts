import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Resolver } from '../src/dedup.js';
import {
  LIVE_DELTAS,
  deltaBoundViolations,
  deltaFromSeq,
  detectSilentChanges,
  liveWindowDays,
  nextSilentLog,
  writeLiveIndex,
  type LiveIndex,
} from '../src/live-sync.js';
import { writeDayPartition } from '../src/partitions.js';
import { eventDayKey } from '../src/bitemporal.js';
import { LogBuffer } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { summaries, summaryFeats } from '../src/summaries.js';
import type { EventNode, RawObs } from '../src/types.js';

// PRB-2: the live index publishes the week summary's content as per-day files with fingerprints plus head_seq deltas.
// A client that holds the window at one head and applies a delta must hold exactly what the day files of the later
// run hold, and an unchanged day must keep its bytes across runs.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.parse('2026-10-05T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

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

/** A small world: one event a day for ten days (two of them outside the window), each first ingested an hour after
 *  its origin, through the log's seq clock like aggregate. */
function world(): { map: Map<string, EventNode>; seq: number } {
  const map = new Map<string, EventNode>();
  let seq = 1000;
  for (let d = 9; d >= 0; d--) {
    const t = T0 - d * DAY - 2 * H;
    const r = new Resolver(map, prio, cfg, t + H);
    const log = new LogBuffer(seq, iso(t + H));
    const raw = obs('usgs', `us${d}`, t, { mag: 3 + d / 10 });
    log.record(raw, r.ingest(raw, iso(t + H)));
    seq = log.seq;
  }
  return { map, seq };
}

/** One later aggregate run at `nowMs`: the given reports, logged with fresh seqs. */
function run(state: { map: Map<string, EventNode>; seq: number }, nowMs: number, raws: RawObs[], tombstone: RawObs[] = []): void {
  const r = new Resolver(state.map, prio, cfg, nowMs);
  const log = new LogBuffer(state.seq, iso(nowMs));
  for (const raw of raws) log.record(raw, r.ingest(raw, iso(nowMs)));
  for (const raw of tombstone) {
    const res = r.tombstoneProvider(raw, iso(nowMs));
    if (res) log.record(raw, res, 'tombstone');
  }
  state.seq = log.seq;
}

function publish(state: { map: Map<string, EventNode>; seq: number }, nowMs: number): { dir: string; index: LiveIndex; files: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'live-'));
  const nodes = [...state.map.values()];
  const out = writeLiveIndex(summaryFeats(nodes, nowMs), nodes, { publicV1: join(dir, 'v1'), nowMs, headSeq: state.seq });
  return { dir, index: out.index, files: out.files };
}

type Fc = { features: { id: string; properties: { time: number; feed: { ingest_seq: number; state: string } } }[] };
const parse = (s: string): Fc => JSON.parse(s) as Fc;

/** What a client holds: every feature of the day files, by id. */
function holdFromDays(files: Record<string, string>, index: LiveIndex): Map<string, string> {
  const held = new Map<string, string>();
  for (const d of index.days) for (const f of parse(files[d.path]!).features) held.set(f.id, JSON.stringify(f));
  return held;
}

test('the day files hold exactly the week summary features of their days, written to disk byte for byte', () => {
  const s = world();
  const { dir, index, files } = publish(s, T0);
  try {
    assert.deepEqual(index.days.map((d) => d.date), liveWindowDays(T0));
    assert.equal(index.days.length, 8, 'today and the 7 days before it');
    const weekDir = mkdtempSync(join(tmpdir(), 'week-'));
    const feats = summaryFeats([...s.map.values()], T0);
    summaries(feats, T0, weekDir, iso(T0));
    const week = parse(readFileSync(join(weekDir, 'all_week.geojson'), 'utf8'));
    rmSync(weekDir, { recursive: true, force: true });
    const held = holdFromDays(files, index);
    // all_week covers 7 x 24 h; the day files cover whole days, so they hold every week feature and older ones of the
    // oldest day (here: the event 7 days and 2 h old).
    for (const f of week.features) assert.equal(held.get(f.id), JSON.stringify(f), `${f.id}: same compact feature`);
    assert.equal(held.size, week.features.length + 1);
    for (const d of index.days) {
      const onDisk = readFileSync(join(dir, d.path), 'utf8');
      assert.equal(onDisk, files[d.path]);
      assert.equal(Buffer.byteLength(onDisk), d.bytes);
    }
    assert.equal(index.count, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unchanged day keeps its bytes and sha256 from run to run; a revised day does not', () => {
  const s = world();
  const a = publish(s, T0);
  run(s, T0 + 5 * 60_000, [obs('usgs', 'us3', T0 - 3 * DAY - 2 * H, { mag: 3.9, status: 'reviewed' })]);
  const b = publish(s, T0 + 5 * 60_000);
  try {
    const shaA = new Map(a.index.days.map((d) => [d.date, d.sha256]));
    const changed = b.index.days.filter((d) => shaA.get(d.date) !== d.sha256).map((d) => d.date);
    assert.deepEqual(changed, [iso(T0 - 3 * DAY - 2 * H).slice(0, 10)], 'only the revised event day');
    assert.notEqual(a.files['v1/live/index.json'], b.files['v1/live/index.json'], 'the index is rewritten every run');
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test('a client at the earlier head that applies the smallest covering delta holds what the later day files hold', () => {
  const s = world();
  const t1 = T0;
  const a = publish(s, t1);
  const cursor = a.index.head_seq;
  const held = holdFromDays(a.files, a.index);

  // Twenty minutes later: a new event, a revision of a 3-day-old one, a withdrawal of a 2-day-old one, and a second
  // agency's report that joins today's event.
  const t2 = t1 + 20 * 60_000;
  run(s, t1 + 5 * 60_000, [obs('emsc', 'e-new', t1 + 2 * 60_000, { mag: 4.4 })]);
  run(s, t1 + 10 * 60_000, [obs('usgs', 'us3', T0 - 3 * DAY - 2 * H, { mag: 3.8, status: 'reviewed' })]);
  run(s, t1 + 15 * 60_000, [], [obs('usgs', 'us2', T0 - 2 * DAY - 2 * H, { mag: 3.2 })]);
  const today = [...s.map.values()].find((n) => n.aliases.includes('usgs:us0'))!;
  run(s, t2, [obs('emsc', 'e-join', today.eventTimeMs + 3_000, { lat: today.lat, lon: today.lon, mag: 3.1 })]);
  const b = publish(s, t2);
  try {
    const delta = b.index.deltas.find((d) => d.from_seq <= cursor);
    assert.ok(delta, 'a delta covers a client 20 minutes behind');
    assert.equal(delta.name, '1h', 'the 15-minute delta starts after the client cursor');
    const fc = parse(b.files[delta.path]!);
    assert.ok(fc.features.every((f) => f.properties.feed.ingest_seq > delta.from_seq));
    for (const f of fc.features) held.set(f.id, JSON.stringify(f));
    assert.deepEqual(new Map([...held].sort()), new Map([...holdFromDays(b.files, b.index)].sort()));
    const withdrawn = fc.features.find((f) => f.properties.feed.state === 'tombstoned');
    assert.ok(withdrawn, 'the withdrawal travels as a non-live marker');
    assert.equal(b.index.days.find((d) => d.date === iso(T0 - 2 * DAY).slice(0, 10))!.count, 0, 'and is not counted live');
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test('from_seq is the newest seq changed at least the window ago; a cursor older than every delta has none', () => {
  const s = world();
  const nodes = [...s.map.values()];
  const now = T0 + 30 * 60_000;
  // Today's event was ingested at T0 - 1 h; yesterday's a day earlier.
  const today = nodes.find((n) => n.aliases.includes('usgs:us0'))!;
  const yesterday = nodes.find((n) => n.aliases.includes('usgs:us1'))!;
  assert.equal(deltaFromSeq(nodes, now, 15 * 60_000), today.lastSeq, 'nothing changed in the last 15 min');
  assert.equal(deltaFromSeq(nodes, now, 2 * H), yesterday.lastSeq);
  assert.equal(deltaFromSeq(nodes, now, 30 * DAY), 0);
  const p = publish(s, now);
  try {
    assert.deepEqual(p.index.deltas.map((d) => d.name), LIVE_DELTAS.map((d) => d.name));
    assert.equal(p.index.deltas[0]!.count, 0, 'an empty 15-minute delta: the client is already current at its from_seq');
    const twoDaysAgo = nodes.find((n) => n.aliases.includes('usgs:us2'))!.lastSeq - 1;
    assert.ok(p.index.deltas.every((d) => d.from_seq > twoDaysAgo), 'two days behind: day files, not a delta');
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test('the window reaches into tomorrow only while the future leeway does', () => {
  assert.deepEqual(liveWindowDays(Date.parse('2026-10-05T12:00:00Z')).at(-1), '2026-10-05');
  const late = liveWindowDays(Date.parse('2026-10-05T23:55:00Z'));
  assert.equal(late.at(-1), '2026-10-06');
  assert.equal(late.length, 9);
  assert.equal(late[0], '2026-09-28');
});

test('a revision of a row that represents nothing changes the feature without a seq: detected, and every covering delta carries it', () => {
  const s = world();
  const today = [...s.map.values()].find((n) => n.aliases.includes('usgs:us0'))!;
  // GEOFON reports today's quake: its row joins the ComCat event and fills `author`, which ComCat's row lacks.
  run(s, T0 - 30 * 60_000, [obs('geofon', 'gfz1', today.eventTimeMs + 2_000, { lat: today.lat, lon: today.lon, mag: 3.0, fields: { Author: 'GFZ' } })]);
  assert.ok(today.provenance.some((r) => r.provider === 'geofon'), 'setup: the GEOFON row joined');
  assert.equal(today.chosenProvider, 'usgs', 'setup: ComCat represents the event');

  const root = mkdtempSync(join(tmpdir(), 'silent-'));
  try {
    // The previous run committed its partitions (derive) at head `prevHead`.
    const prevHead = s.seq;
    const byDay = new Map<string, EventNode[]>();
    for (const n of s.map.values()) (byDay.get(eventDayKey(n.eventTimeMs)) ?? byDay.set(eventDayKey(n.eventTimeMs), []).get(eventDayKey(n.eventTimeMs))!).push(n);
    for (const [day, nodes] of byDay) writeDayPartition(root, day, nodes, { nowMs: T0, headIngestTime: iso(T0) });
    const client = publish(s, T0);
    const cursor = client.index.head_seq;

    // The event's representative and lastSeq stay (no new seq), its feature changes.
    const seqBefore = today.lastSeq;
    const r = new Resolver(s.map, prio, cfg, T0 + 5 * 60_000);
    // GEOFON revises its magnitude and author (a solution change of a row that is not the representative).
    const res = r.ingest(obs('geofon', 'gfz1', today.eventTimeMs + 2_000, { lat: today.lat, lon: today.lon, mag: 3.05, fields: { Author: 'GFZ-rev' } }), iso(T0 + 5 * 60_000));
    assert.equal(res.changed, false, 'setup: a row-only revision');
    assert.equal(today.lastSeq, seqBefore, 'setup: no new seq');
    const nowMs = T0 + 5 * 60_000;

    const detected = detectSilentChanges(root, s.map.values(), liveWindowDays(nowMs), prevHead);
    assert.deepEqual(detected, [today.feedId]);
    const silent = nextSilentLog([], detected, prevHead, nowMs, 0);
    const nodes = [...s.map.values()];
    const out = writeLiveIndex(summaryFeats(nodes, nowMs), nodes, { publicV1: join(root, 'pub', 'v1'), nowMs, headSeq: s.seq, silent });
    const delta = out.index.deltas.find((d) => d.from_seq <= cursor)!;
    const carried = parse(out.files[delta.path]!).features.find((f) => f.id === today.feedId);
    assert.ok(carried, 'the covering delta carries the silently changed feature');
    assert.match(JSON.stringify(carried), /GFZ-rev/);
    // It keeps its older seq, at or below the delta's from_seq: validate accepts it because the silent log names it
    // (round 15 review: without the log check validate failed the run and blocked derive while the entry lived).
    assert.ok(carried.properties.feed.ingest_seq <= delta.from_seq, 'setup: the silent feature sits at or below from_seq');
    const deltaFeatures = parse(out.files[delta.path]!).features;
    assert.deepEqual(deltaBoundViolations(deltaFeatures, delta.from_seq, silent), []);
    assert.deepEqual(deltaBoundViolations(deltaFeatures, delta.from_seq, []), [today.feedId]);
    assert.deepEqual(
      deltaBoundViolations(deltaFeatures, delta.from_seq, [{ id: today.feedId, head_before: delta.from_seq - 1, at: nowMs }]),
      [today.feedId],
      'an entry older than the bound does not excuse it',
    );
    // Without the silent log the same delta would have missed it: the client would keep the old author.
    const bare = writeLiveIndex(summaryFeats(nodes, nowMs), nodes, { publicV1: join(root, 'pub2', 'v1'), nowMs, headSeq: s.seq });
    const bareDelta = bare.index.deltas.find((d) => d.from_seq <= cursor)!;
    assert.ok(!parse(bare.files[bareDelta.path]!).features.some((f) => f.id === today.feedId));
    rmSync(client.dir, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the silent log keeps the newest head per id and drops what no delta can need', () => {
  const log = nextSilentLog([{ id: 'efd_a', head_before: 10, at: 1 }, { id: 'efd_b', head_before: 50, at: 2 }], ['efd_a', 'efd_c'], 60, 3, 0);
  assert.deepEqual(log, [
    { id: 'efd_b', head_before: 50, at: 2 },
    { id: 'efd_a', head_before: 60, at: 3 },
    { id: 'efd_c', head_before: 60, at: 3 },
  ]);
  assert.deepEqual(nextSilentLog(log, [], 60, 4, 55).map((e) => e.id), ['efd_a', 'efd_c']);
});
