import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { eventDayKey, loadEventMap, pruneEventMapShards, saveEventMap } from '../src/bitemporal.js';
import { dataPaths } from '../src/config.js';
import { SENTINEL_FILE, canonicalDay, emptyGeneration, liveFloor, moveToDayLayout, writeGeneration } from '../src/event-map-store.js';
import type { EventNode } from '../src/types.js';

// The event map's files. Round 17 (LANE G) wrote shards of one UTC hour of each event-day (`YYYY-MM-DD-HH.ndjson`);
// storage phase 3 writes one file per event-day again (`YYYY-MM-DD.ndjson`, the store keeps one blob per day) and the
// first phase-3a aggregate run moves every hour-sharded day to its day file. Every reader still takes the event-day
// from the first 10 characters of a name and reads both layouts alike; absence never reads as an empty map.

const DAY = '2026-10-05';
const at = (hhmm: string): number => Date.parse(`${DAY}T${hhmm}:00Z`);

function node(feedId: string, eventTimeMs: number, lastSeq = 1, place = 'x'): EventNode {
  return {
    feedId,
    aliases: [`usgs:${feedId}`],
    eventTimeMs,
    firstIngestTime: '2026-10-05T00:00:00.000Z',
    lastIngestTime: '2026-10-05T00:00:00.000Z',
    lat: 1,
    lon: 2,
    depth: 10,
    mag: 4.5,
    magType: 'mb',
    status: null,
    place,
    chosenProvider: 'usgs',
    provenance: [],
    revision: 1,
    firstSeenSeq: 1,
    lastSeq,
    state: 'live',
    geohash: 'g',
  };
}

const root = (): string => mkdtempSync(join(tmpdir(), 'efd-em-shards-'));
const files = (r: string): string[] => readdirSync(dataPaths(r).eventMapDir).sort();
const ids = (r: string, f: string): string[] =>
  readFileSync(join(dataPaths(r).eventMapDir, f), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as EventNode).feedId);
const mapOf = (...ns: EventNode[]): Map<string, EventNode> => new Map(ns.map((n) => [n.feedId, n]));

/** The round-17 layout, as the code before phase 3 wrote it: one file per UTC hour that has nodes, feed-id order. */
function writeHourShards(r: string, nodes: EventNode[]): void {
  const dir = dataPaths(r).eventMapDir;
  mkdirSync(dir, { recursive: true });
  const byFile = new Map<string, EventNode[]>();
  for (const n of nodes) {
    const f = `${eventDayKey(n.eventTimeMs)}-${String(new Date(n.eventTimeMs).getUTCHours()).padStart(2, '0')}.ndjson`;
    (byFile.get(f) ?? byFile.set(f, []).get(f)!).push(n);
  }
  for (const [f, ns] of byFile) writeFileSync(join(dir, f), ns.sort((a, b) => (a.feedId < b.feedId ? -1 : 1)).map((n) => JSON.stringify(n)).join('\n') + '\n');
}

test('save: one file per event-day, lines in feed-id order; a later save rewrites only the changed days', () => {
  const r = root();
  try {
    saveEventMap(r, mapOf(node('efd_b', at('00:10')), node('efd_a', at('00:50')), node('efd_c', Date.parse('2026-10-06T13:00:00Z')), node('efd_d', at('23:59'))));
    assert.deepEqual(files(r), [`${DAY}.ndjson`, '2026-10-06.ndjson']);
    assert.deepEqual(ids(r, `${DAY}.ndjson`), ['efd_a', 'efd_b', 'efd_d']);
    // A read-only file would throw on a write: only 10-06 changes, so only 10-06 may be written.
    const dir = dataPaths(r).eventMapDir;
    chmodSync(join(dir, `${DAY}.ndjson`), 0o444);
    const m = loadEventMap(r);
    m.get('efd_c')!.place = 'revised';
    m.get('efd_c')!.lastSeq = 2;
    saveEventMap(r, m);
    assert.match(readFileSync(join(dir, '2026-10-06.ndjson'), 'utf8'), /"place":"revised"/);
    chmodSync(join(dir, `${DAY}.ndjson`), 0o644);
    // The day file is canonicalDay's bytes of the day: what the store keeps.
    const text = readFileSync(join(dir, `${DAY}.ndjson`), 'utf8');
    assert.equal(canonicalDay([text]).text, text);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('the layout move: a saved day leaves its hour shards; moveToDayLayout writes every other day as its canonical day file', () => {
  const r = root();
  try {
    const all = [node('efd_a', at('01:00')), node('efd_b', at('22:00')), node('efd_c', at('22:30')), node('efd_z', Date.parse('2026-10-04T12:00:00Z')), node('efd_y', Date.parse('2026-10-04T02:00:00Z'))];
    writeHourShards(r, all);
    assert.deepEqual(files(r), ['2026-10-04-02.ndjson', '2026-10-04-12.ndjson', `${DAY}-01.ndjson`, `${DAY}-22.ndjson`]);
    // aggregate loads the window and saves what it holds: here only 10-05 is in the map.
    const loaded = loadEventMap(r);
    assert.equal(loaded.size, 5);
    loaded.delete('efd_z');
    loaded.delete('efd_y');
    saveEventMap(r, loaded);
    assert.deepEqual(files(r), ['2026-10-04-02.ndjson', '2026-10-04-12.ndjson', `${DAY}.ndjson`]);
    // Then the move: 10-04 as one file, byte for byte what saveEventMap writes for it.
    assert.deepEqual(moveToDayLayout(r), ['2026-10-04']);
    assert.deepEqual(files(r), ['2026-10-04.ndjson', `${DAY}.ndjson`]);
    const moved = readFileSync(join(dataPaths(r).eventMapDir, '2026-10-04.ndjson'), 'utf8');
    const other = root();
    try {
      saveEventMap(other, mapOf(...all.filter((n) => eventDayKey(n.eventTimeMs) === '2026-10-04')));
      assert.equal(moved, readFileSync(join(dataPaths(other).eventMapDir, '2026-10-04.ndjson'), 'utf8'));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    assert.deepEqual(moveToDayLayout(r), [], 'nothing left to move');
    assert.deepEqual([...loadEventMap(r).keys()].sort(), ['efd_a', 'efd_b', 'efd_c', 'efd_y', 'efd_z']);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('a feed id in two files of a day keeps the higher lastSeq, the later file on a tie; canonicalDay agrees with the loader', () => {
  const r = root();
  try {
    const dir = dataPaths(r).eventMapDir;
    mkdirSync(dir, { recursive: true });
    // The day file sorts after the day's hour files ('.' > '-'), so it is read last.
    writeFileSync(join(dir, `${DAY}-01.ndjson`), JSON.stringify(node('efd_a', at('01:00'), 7, 'newer')) + '\n');
    writeFileSync(join(dir, `${DAY}.ndjson`), JSON.stringify(node('efd_a', at('01:00'), 5, 'older')) + '\n');
    assert.equal(loadEventMap(r).get('efd_a')!.place, 'newer');
    // Same lastSeq (a silent row revision does not move it): the file read last wins, as before round 17.
    writeFileSync(join(dir, `${DAY}.ndjson`), JSON.stringify(node('efd_a', at('01:00'), 7, 'day file')) + '\n');
    assert.equal(loadEventMap(r).get('efd_a')!.place, 'day file');
    const c = canonicalDay([readFileSync(join(dir, `${DAY}-01.ndjson`), 'utf8'), readFileSync(join(dir, `${DAY}.ndjson`), 'utf8')]);
    assert.equal(c.nodes, 1);
    assert.match(c.text, /"place":"day file"/);
    moveToDayLayout(r);
    assert.deepEqual(files(r), [`${DAY}.ndjson`]);
    assert.equal(loadEventMap(r).get('efd_a')!.place, 'day file');
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

/** loadEventMap as it was before round 17 (a byte copy of its loop): the rollback reads hour shards with it. */
function loadEventMapBeforeRound17(r: string, opts: { sinceDays?: number; nowMs: number }): Map<string, EventNode> {
  const dir = dataPaths(r).eventMapDir;
  const cutoffDay = opts.sinceDays != null ? new Date(opts.nowMs - opts.sinceDays * 86_400_000).toISOString().slice(0, 10) : null;
  const map = new Map<string, EventNode>();
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.ndjson')) continue;
    if (cutoffDay && f.slice(0, 10) < cutoffDay) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const n = JSON.parse(t) as EventNode;
      map.set(n.feedId, n);
    }
  }
  return map;
}

test('prune removes every file of a day before the horizon, never the sentinel; the live floor follows', () => {
  const r = root();
  try {
    writeHourShards(r, [node('efd_a', Date.parse('2026-08-01T01:00:00Z')), node('efd_b', Date.parse('2026-08-01T02:00:00Z'))]);
    saveEventMap(r, mapOf(node('efd_c', at('03:00'))));
    writeFileSync(join(dataPaths(r).eventMapDir, SENTINEL_FILE), 'phase 3b sentinel: not JSON\n');
    assert.equal(files(r).length, 4);
    assert.equal(liveFloor(r), '2026-08-01');
    assert.deepEqual(pruneEventMapShards(r, Date.parse('2026-08-21T00:00:00Z')), ['2026-08-01']);
    assert.deepEqual(files(r), [SENTINEL_FILE, `${DAY}.ndjson`]);
    assert.equal(liveFloor(r), DAY);
    // The sentinel is no day: the loader skips it.
    assert.deepEqual([...loadEventMap(r).keys()], ['efd_c']);
    assert.equal(existsSync(dataPaths(r).eventMapLegacy), false);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('the map iterates in the same order in either layout: day by day, feed ids in order (round 17 review)', () => {
  // The Resolver indexes the map in its iteration order and keeps the first candidate at an equal distance, so the
  // order must not follow the hour shards' names (hour, then feed id): efd_a at 13h and efd_b at 01h read as b, a.
  const day = root();
  const hours = root();
  try {
    const m = mapOf(
      node('efd_a', at('13:00')),
      node('efd_b', at('01:00')),
      node('efd_c', at('01:30')),
      node('efd_0', Date.parse('2026-10-04T23:00:00Z')),
      node('efd_z', Date.parse('2026-10-06T00:30:00Z')),
    );
    saveEventMap(day, m);
    writeHourShards(hours, [...m.values()]);
    assert.deepEqual(files(hours), [`2026-10-04-23.ndjson`, `${DAY}-01.ndjson`, `${DAY}-13.ndjson`, `2026-10-06-00.ndjson`]);
    const order = (r: string): string[] => [...loadEventMap(r).keys()];
    assert.deepEqual(order(day), ['efd_0', 'efd_a', 'efd_b', 'efd_c', 'efd_z']);
    assert.deepEqual(order(hours), order(day));
    assert.deepEqual(order(hours), [...loadEventMapBeforeRound17(day, { nowMs: Date.now() }).keys()], 'the order of the code before round 17');
    // Two copies of one feed id in a day keep the lastSeq rule and, on a tie, the later file.
    writeFileSync(join(dataPaths(hours).eventMapDir, `${DAY}.ndjson`), JSON.stringify(node('efd_b', at('01:00'), 1, 'day file')) + '\n');
    assert.equal(loadEventMap(hours).get('efd_b')!.place, 'day file');
    assert.deepEqual(order(hours), order(day));
  } finally {
    rmSync(day, { recursive: true, force: true });
    rmSync(hours, { recursive: true, force: true });
  }
});

test('fail closed: no map and no generation throws; the generation names the days that must be on disk', () => {
  const r = root();
  try {
    assert.throws(() => loadEventMap(r), /refusing to read it as empty/);
    assert.throws(() => liveFloor(r, Date.parse('2026-10-06T00:00:00Z'), {}), /no live floor/);
    // A fresh data branch: EVENT_MAP_BOOTSTRAP=1, or an empty generation (scripts/bootstrap-data-branch.sh).
    assert.equal(loadEventMap(r, { bootstrap: true }).size, 0);
    assert.equal(liveFloor(r, Date.parse('2026-10-06T00:00:00Z'), { EVENT_MAP_BOOTSTRAP: '1' }), '2026-10-06');
    writeGeneration(r, emptyGeneration());
    assert.equal(loadEventMap(r).size, 0);
    // A generation day missing from the checkout throws, within the load's window; a day before the window does not count.
    const entry = { sha256: 'a'.repeat(64), bytes: 1, nodes: 1, blob: 'b'.repeat(64), blob_bytes: 1 };
    writeGeneration(r, { ...emptyGeneration(), days: { '2026-09-01': entry, [DAY]: entry } });
    assert.throws(() => loadEventMap(r), /the checkout has no knowledge\/index\/event_map/);
    saveEventMap(r, mapOf(node('efd_a', at('01:00'))));
    assert.throws(() => loadEventMap(r), /lists 1 day\(s\) the checkout lacks \(2026-09-01\)/);
    assert.deepEqual([...loadEventMap(r, { sinceDays: 10, nowMs: Date.parse('2026-10-06T00:00:00Z') }).keys()], ['efd_a']);
    assert.equal(liveFloor(r), '2026-09-01', 'the generation comes first');
    // The floor merge never writes a generation day from moved nodes alone.
    assert.throws(() => saveEventMap(r, mapOf(node('efd_m', Date.parse('2026-09-01T05:00:00Z'))), { floorDay: '2026-10-01' }), /refusing to write the day from that node alone/);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

// 2026-11-15 audit: aggregate loads LIVE_INDEX_DAYS of event-days, but the updatedafter sweep reaches further back. A
// revision that moves a node across midnight onto a day below the loaded window must not rewrite that (unloaded) day
// from the map alone — that deleted the day's other shards and emptied its frozen partition.
test('a node moved below the load floor merges into the unloaded day, which keeps its other events', () => {
  const root = mkdtempSync(join(tmpdir(), 'evmap-floor-'));
  const nowMs = Date.parse('2026-10-12T12:00:00Z');
  const dayMs = (i: number): number => Date.parse('2026-10-01T00:00:00Z') + i * 86_400_000;
  const all = new Map<string, EventNode>();
  for (let d = 0; d < 12; d++) {
    for (const h of [1, 7, 13, 19]) {
      const n = node(`d${d}h${h}`, dayMs(d) + h * 3_600_000);
      all.set(n.feedId, n);
    }
  }
  saveEventMap(root, all);
  const sinceDays = 10;
  const loaded = loadEventMap(root, { sinceDays, nowMs });
  const floorDay = '2026-10-02';
  assert.ok(![...loaded.values()].some((n) => n.eventTimeMs < Date.parse(`${floorDay}T00:00:00Z`)));
  assert.ok(loaded.has('d1h1'));
  // A revision moves the oldest loaded day's first event across midnight onto the day before (not loaded).
  const moved = loaded.get('d1h1')!;
  moved.eventTimeMs = dayMs(1) - 30 * 60_000;
  moved.lastSeq = 2;
  saveEventMap(root, loaded, { floorDay });
  const after = loadEventMap(root);
  for (const h of [1, 7, 13, 19]) assert.ok(after.has(`d0h${h}`), `d0h${h} survives`);
  assert.equal(after.get('d1h1')!.eventTimeMs, dayMs(1) - 30 * 60_000);
  assert.equal(after.get('d1h1')!.lastSeq, 2);
  assert.equal([...after.values()].filter((n) => n.feedId === 'd1h1').length, 1);
  const day0 = readdirSync(dataPaths(root).eventMapDir).filter((f) => f.startsWith('2026-10-01'));
  const day0Ids = day0.flatMap((f) =>
    readFileSync(join(dataPaths(root).eventMapDir, f), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as EventNode).feedId),
  );
  assert.deepEqual(day0Ids.sort(), ['d0h1', 'd0h13', 'd0h19', 'd0h7', 'd1h1'].sort());
  // The oldest loaded day lost the moved node and kept the rest.
  const day1 = loadEventMap(root, { sinceDays: 11, nowMs });
  for (const h of [7, 13, 19]) assert.ok(day1.has(`d1h${h}`));
  rmSync(root, { recursive: true, force: true });
});
