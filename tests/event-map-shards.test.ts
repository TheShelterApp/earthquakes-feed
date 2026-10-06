import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { earliestEventMapDay, eventMapShardName, loadEventMap, pruneEventMapShards, saveEventMap } from '../src/bitemporal.js';
import { EVENT_MAP_SHARD_HOURS, dataPaths, parseShardHours } from '../src/config.js';
import type { EventNode } from '../src/types.js';

// Round 17 (LANE G, repository growth): the event_map is written in shards of EVENT_MAP_SHARD_HOURS hours of each
// event-day (`YYYY-MM-DD-HH.ndjson`), and a save rewrites only the shards whose bytes change. Every reader takes the
// event-day from the first 10 characters of the name, so the day files written until round 17 and the hour files read
// alike — also by the code before round 17 (the rollback path).

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

test('the default is one-hour shards; the shard length must divide a day', () => {
  assert.equal(EVENT_MAP_SHARD_HOURS, 1);
  for (const h of [1, 2, 3, 4, 6, 8, 12, 24]) assert.equal(parseShardHours(String(h)), h);
  for (const bad of ['0', '5', '7', '25', '1.5', 'x', '']) assert.throws(() => parseShardHours(bad), /a divisor of 24/);
});

test('eventMapShardName: the bucket of the UTC hour, the whole day at 24', () => {
  assert.equal(eventMapShardName(DAY, at('00:00')), `${DAY}-00.ndjson`);
  assert.equal(eventMapShardName(DAY, at('13:59')), `${DAY}-13.ndjson`);
  assert.equal(eventMapShardName(DAY, at('23:59'), 4), `${DAY}-20.ndjson`);
  assert.equal(eventMapShardName(DAY, at('05:00'), 6), `${DAY}-00.ndjson`);
  assert.equal(eventMapShardName(DAY, at('13:00'), 24), `${DAY}.ndjson`);
});

test('save: one file per hour that has nodes, lines in feed-id order; a later save rewrites only the changed hours', () => {
  const r = root();
  try {
    saveEventMap(r, mapOf(node('efd_b', at('00:10')), node('efd_a', at('00:50')), node('efd_c', at('13:00')), node('efd_d', at('23:59'))));
    assert.deepEqual(files(r), [`${DAY}-00.ndjson`, `${DAY}-13.ndjson`, `${DAY}-23.ndjson`]);
    assert.deepEqual(ids(r, `${DAY}-00.ndjson`), ['efd_a', 'efd_b']);
    // Read-only files would throw on a write: only 13h changes, so only 13h may be written.
    const dir = dataPaths(r).eventMapDir;
    chmodSync(join(dir, `${DAY}-00.ndjson`), 0o444);
    chmodSync(join(dir, `${DAY}-23.ndjson`), 0o444);
    const m = loadEventMap(r);
    m.get('efd_c')!.place = 'revised';
    m.get('efd_c')!.lastSeq = 2;
    saveEventMap(r, m);
    assert.match(readFileSync(join(dir, `${DAY}-13.ndjson`), 'utf8'), /"place":"revised"/);
    // A node whose event time moves to another hour leaves its old shard; an hour every node left is removed.
    chmodSync(join(dir, `${DAY}-23.ndjson`), 0o644);
    m.get('efd_d')!.eventTimeMs = at('14:30');
    saveEventMap(r, m);
    assert.deepEqual(files(r), [`${DAY}-00.ndjson`, `${DAY}-13.ndjson`, `${DAY}-14.ndjson`]);
    assert.deepEqual([...loadEventMap(r).keys()].sort(), ['efd_a', 'efd_b', 'efd_c', 'efd_d']);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('migration: a day written as one file becomes hour shards on its next save; a day not saved keeps its file', () => {
  const r = root();
  try {
    const old = mapOf(node('efd_a', at('01:00')), node('efd_b', at('22:00')), node('efd_z', Date.parse('2026-10-04T12:00:00Z')));
    saveEventMap(r, old, 24);
    assert.deepEqual(files(r), ['2026-10-04.ndjson', `${DAY}.ndjson`]);
    // aggregate loads both days but saves what it holds: here only 10-05 is in the map.
    const loaded = loadEventMap(r);
    assert.equal(loaded.size, 3);
    loaded.delete('efd_z');
    saveEventMap(r, loaded);
    assert.deepEqual(files(r), ['2026-10-04.ndjson', `${DAY}-01.ndjson`, `${DAY}-22.ndjson`]);
    assert.deepEqual([...loadEventMap(r).keys()].sort(), ['efd_a', 'efd_b', 'efd_z']);
    // Rollback: EVENT_MAP_SHARD_HOURS = 24 writes the day as one file again and removes its hour shards.
    saveEventMap(r, loadEventMap(r), 24);
    assert.deepEqual(files(r), ['2026-10-04.ndjson', `${DAY}.ndjson`]);
    assert.deepEqual(ids(r, `${DAY}.ndjson`), ['efd_a', 'efd_b']);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('a feed id in two shard files keeps the higher lastSeq, whichever file is read last', () => {
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

test('hour shards read the same with the code before round 17 (a reverted deploy loses nothing)', () => {
  const r = root();
  try {
    const nowMs = Date.parse('2026-10-06T12:00:00Z');
    const m = mapOf(
      node('efd_a', at('00:10')),
      node('efd_b', at('13:00')),
      node('efd_c', Date.parse('2026-09-30T23:00:00Z')),
      node('efd_d', Date.parse('2026-08-01T05:00:00Z')),
    );
    saveEventMap(r, m);
    for (const sinceDays of [undefined, 10, 45]) {
      const a = loadEventMap(r, { sinceDays, nowMs });
      const b = loadEventMapBeforeRound17(r, { sinceDays, nowMs });
      assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort(), `sinceDays=${sinceDays}`);
    }
    assert.deepEqual([...loadEventMap(r, { sinceDays: 10, nowMs }).keys()].sort(), ['efd_a', 'efd_b', 'efd_c']);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('prune removes every shard of a day before the horizon and names each day once; the live floor reads hour shards', () => {
  const r = root();
  try {
    saveEventMap(r, mapOf(node('efd_a', Date.parse('2026-08-01T01:00:00Z')), node('efd_b', Date.parse('2026-08-01T02:00:00Z')), node('efd_c', at('03:00'))));
    assert.equal(files(r).length, 3);
    assert.equal(earliestEventMapDay(r, Date.parse('2026-10-06T00:00:00Z')), '2026-08-01');
    assert.deepEqual(pruneEventMapShards(r, Date.parse('2026-08-21T00:00:00Z')), ['2026-08-01']);
    assert.deepEqual(files(r), [`${DAY}-03.ndjson`]);
    assert.equal(earliestEventMapDay(r, Date.parse('2026-10-06T00:00:00Z')), DAY);
    assert.equal(existsSync(dataPaths(r).eventMapLegacy), false);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});
