import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Resolver } from '../src/dedup.js';
import { eventDayKey, loadEventMap, saveEventMap } from '../src/bitemporal.js';
import {
  LIVE_BASELINE_FILE,
  LIVE_BASELINE_SNAPSHOT_META,
  baselineDays,
  baselineRecord,
  partitionTexts,
  previousWindowLines,
  readBaselineRecord,
  readBaselineSnapshot,
  writeBaselineRecord,
  writeBaselineSnapshot,
} from '../src/live-baseline.js';
import { detectSilentChanges, liveWindowDays, silentChangesAgainst } from '../src/live-sync.js';
import { dayPartitionFile, dayPartitionText, writeDayPartition } from '../src/partitions.js';
import { LogBuffer } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';

// Round 25, storage option 4 phase 1: derive's silent-change check (PRB-2) takes the previous run's lines from the event
// map the job checked out (a snapshot, verified against the sha256 that run recorded), not from the day partitions it
// committed, so phase 2 can stop committing the unfrozen days. These tests hold the two sources to the same answer.

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

interface World {
  map: Map<string, EventNode>;
  seq: number;
}

/** One event a day for twelve days, each first ingested an hour after its origin, through the log's seq clock. */
function world(): World {
  const map = new Map<string, EventNode>();
  let seq = 1000;
  for (let d = 11; d >= 0; d--) {
    const t = T0 - d * DAY - 2 * H;
    const r = new Resolver(map, prio, cfg, t + H);
    const log = new LogBuffer(seq, iso(t + H));
    const raw = obs('usgs', `us${d}`, t, { mag: 3 + d / 10 });
    log.record(raw, r.ingest(raw, iso(t + H)));
    seq = log.seq;
  }
  return { map, seq };
}

/** One aggregate run at `nowMs`: the reports, logged with fresh seqs. */
function run(w: World, nowMs: number, raws: RawObs[]): void {
  const r = new Resolver(w.map, prio, cfg, nowMs);
  const log = new LogBuffer(w.seq, iso(nowMs));
  for (const raw of raws) log.record(raw, r.ingest(raw, iso(nowMs)));
  w.seq = log.seq;
}

/** A revision of a GEOFON row that represents nothing in the event: its feature changes, its lastSeq does not. */
function silentRevision(w: World, nowMs: number, target: EventNode, author: string): void {
  const r = new Resolver(w.map, prio, cfg, nowMs);
  const before = target.lastSeq;
  const res = r.ingest(obs('geofon', 'gfz1', target.eventTimeMs + 2_000, { lat: target.lat, lon: target.lon, mag: 3.05, fields: { Author: author } }), iso(nowMs));
  assert.equal(res.changed, false, 'setup: a row-only revision');
  assert.equal(target.lastSeq, before, 'setup: no new seq');
}

/** A derive run at `nowMs` on the data checkout `root`: the event map on disk (aggregate saved it), its partitions, the
 *  record and the manifest, as src/derive.ts writes them. */
function deriveRun(root: string, nowMs: number, headSeq: number): void {
  const nodes = [...loadEventMap(root, { nowMs }).values()];
  const byDay = new Map<string, EventNode[]>();
  for (const n of nodes) (byDay.get(eventDayKey(n.eventTimeMs)) ?? byDay.set(eventDayKey(n.eventTimeMs), []).get(eventDayKey(n.eventTimeMs))!).push(n);
  const want = new Set(baselineDays(nowMs));
  const written = new Map<string, string>();
  for (const [day, ns] of byDay) {
    const out = writeDayPartition(root, day, ns, { nowMs, headIngestTime: iso(nowMs) });
    if (want.has(day)) written.set(day, out.ndjson);
  }
  writeBaselineRecord(root, baselineRecord(nowMs, headSeq, written));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ generated: nowMs, head_seq: headSeq }));
}

/** The snapshot step on the checkout `root` at `nowMs` (src/live-baseline.ts main). */
function snapshot(root: string, dir: string, nowMs: number): void {
  const map = loadEventMap(root, { nowMs });
  const days = baselineDays(nowMs);
  writeBaselineSnapshot(dir, days, partitionTexts(map.values(), days), { taken_at: nowMs, head_seq: 0 });
}

/** derive's check at `nowMs`: the new baseline, and the committed partitions' check beside it. */
function check(root: string, snapDir: string | undefined, nowMs: number) {
  const prev = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as { generated: number; head_seq: number };
  const nodes = [...loadEventMap(root, { nowMs }).values()];
  const days = liveWindowDays(nowMs);
  const previous = previousWindowLines({ root, days, record: readBaselineRecord(root), prev, snapshot: readBaselineSnapshot(snapDir), compare: true });
  return {
    previous,
    fromBaseline: silentChangesAgainst(previous.lines, nodes, days, prev.head_seq),
    fromPartitions: detectSilentChanges(root, nodes, days, prev.head_seq),
  };
}

function setup(): { w: World; root: string; snap: string; target: EventNode; cleanup: () => void } {
  const w = world();
  const target = [...w.map.values()].find((n) => n.aliases.includes('usgs:us0'))!;
  // GEOFON reports today's quake: its row joins the ComCat event (a new seq) and fills `author`.
  run(w, T0 - 30 * 60_000, [obs('geofon', 'gfz1', target.eventTimeMs + 2_000, { lat: target.lat, lon: target.lon, mag: 3.0, fields: { Author: 'GFZ' } })]);
  assert.ok(target.provenance.some((r) => r.provider === 'geofon'), 'setup: the GEOFON row joined');
  const root = mkdtempSync(join(tmpdir(), 'baseline-data-'));
  const snap = mkdtempSync(join(tmpdir(), 'baseline-snap-'));
  return { w, root, snap, target, cleanup: () => [root, snap].forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

test('baselineDays covers the live window of any derive run within a day after the snapshot', () => {
  for (const t0 of [T0, Date.parse('2026-10-05T23:58:00Z'), Date.parse('2026-10-06T00:01:00Z'), Date.parse('2026-12-31T23:50:00Z')]) {
    const covered = new Set(baselineDays(t0));
    // The 8 days before today to tomorrow, and the day after in the last minutes of a day (the future leeway).
    assert.ok(covered.size === 10 || (covered.size === 11 && t0 % DAY > DAY - 11 * 60_000), `${iso(t0)}: ${covered.size} days`);
    for (let t = t0; t < t0 + DAY; t += 7 * 60_000) for (const d of liveWindowDays(t)) assert.ok(covered.has(d), `${iso(t0)}: ${d} of the window at ${iso(t)}`);
  }
});

test('the snapshot of the checked-out event map is byte for byte the partitions the previous derive committed', () => {
  const { w, root, snap, cleanup } = setup();
  try {
    saveEventMap(root, w.map);
    deriveRun(root, T0, w.seq);
    snapshot(root, snap, T0 + 2 * 60_000);
    const s = readBaselineSnapshot(snap)!;
    let days = 0;
    for (const day of baselineDays(T0 + 2 * 60_000)) {
      const file = dayPartitionFile(root, day);
      assert.equal(s.text(day), existsSync(file) ? readFileSync(file, 'utf8') : null, day);
      if (existsSync(file)) days++;
    }
    assert.ok(days >= 9, `setup: ${days} days with events`);
    // dayPartitionText does not depend on the order of its input.
    const nodes = [...w.map.values()].filter((n) => eventDayKey(n.eventTimeMs) === eventDayKey(T0));
    assert.equal(dayPartitionText([...nodes].reverse()), dayPartitionText(nodes));
  } finally {
    cleanup();
  }
});

test('a silent change is found from the snapshot alone, with or without the committed partitions', () => {
  const { w, root, snap, target, cleanup } = setup();
  try {
    saveEventMap(root, w.map);
    deriveRun(root, T0, w.seq);
    // The next job: the snapshot step, then an aggregate run that revises the GEOFON row (no new seq), then derive.
    snapshot(root, snap, T0 + 2 * 60_000);
    silentRevision(w, T0 + 3 * 60_000, target, 'GFZ-rev');
    saveEventMap(root, w.map);
    const nowMs = T0 + 4 * 60_000;
    const a = check(root, snap, nowMs);
    assert.equal(a.previous.recordUnused, null);
    assert.deepEqual(a.previous.fromSnapshot, liveWindowDays(nowMs), 'every window day from the snapshot');
    assert.deepEqual(a.previous.fromPartitions, []);
    assert.deepEqual(a.previous.partitionDiffers, []);
    assert.deepEqual(a.fromBaseline, [target.feedId]);
    assert.deepEqual(a.fromPartitions, a.fromBaseline, 'the committed partitions give the same');

    // Phase 2: the unfrozen partitions are not on `data` any more; the snapshot still finds it.
    for (const day of liveWindowDays(nowMs)) if (existsSync(dayPartitionFile(root, day))) unlinkSync(dayPartitionFile(root, day));
    const b = check(root, snap, nowMs);
    assert.deepEqual(b.fromBaseline, [target.feedId]);
    assert.deepEqual(b.fromPartitions, [], 'the old check finds nothing without the partitions');
  } finally {
    cleanup();
  }
});

test('after a derive that failed, the changed days fall back to the committed partitions, and nothing is lost', () => {
  const { w, root, snap, target, cleanup } = setup();
  try {
    saveEventMap(root, w.map);
    deriveRun(root, T0, w.seq); // run N-2: committed
    // Run N-1: the aggregate commits a silent revision, its derive fails (nothing of it is committed).
    silentRevision(w, T0 + 3 * 60_000, target, 'GFZ-rev');
    saveEventMap(root, w.map);
    // Run N checks out N-1's event map with N-2's partitions, record and manifest.
    snapshot(root, snap, T0 + 6 * 60_000);
    const nowMs = T0 + 8 * 60_000;
    const a = check(root, snap, nowMs);
    const day = eventDayKey(target.eventTimeMs);
    assert.deepEqual(a.previous.fromPartitions, [day], "the revised day's snapshot is not what N-2 wrote");
    assert.equal(a.previous.fromSnapshot.length, liveWindowDays(nowMs).length - 1);
    assert.deepEqual(a.fromBaseline, [target.feedId], 'the change N-1 never published is still found');
    assert.deepEqual(a.fromPartitions, a.fromBaseline);
    // Without the record's check the snapshot would have taken N-1's line as the previous one and missed it.
    const naive = new Map<string, string>();
    for (const line of readFileSync(join(snap, 'events', ...day.split('-')) + '.ndjson', 'utf8').split('\n')) if (line) naive.set((JSON.parse(line) as { id: string }).id, line);
    assert.deepEqual(silentChangesAgainst(naive, [target], liveWindowDays(nowMs), w.seq), []);
  } finally {
    cleanup();
  }
});

test('the record is used only with the manifest of its own run, and only with a snapshot', () => {
  const { w, root, snap, target, cleanup } = setup();
  try {
    saveEventMap(root, w.map);
    deriveRun(root, T0, w.seq);
    snapshot(root, snap, T0 + 2 * 60_000);
    silentRevision(w, T0 + 3 * 60_000, target, 'GFZ-rev');
    saveEventMap(root, w.map);
    const nowMs = T0 + 4 * 60_000;

    // A manifest of another run (a record left from an older derive): every day from the partitions.
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ generated: T0 + 1, head_seq: w.seq }));
    const other = check(root, snap, nowMs);
    assert.match(other.previous.recordUnused ?? '', /live_baseline\.json is from the run of/);
    assert.deepEqual(other.previous.fromSnapshot, []);
    assert.deepEqual(other.fromBaseline, [target.feedId]);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ generated: T0, head_seq: w.seq }));

    // No snapshot (the step failed): the partitions.
    const none = check(root, undefined, nowMs);
    assert.equal(none.previous.recordUnused, 'no snapshot');
    assert.deepEqual(none.fromBaseline, [target.feedId]);
    // A snapshot cut short (no metadata file) reads as none.
    rmSync(join(snap, LIVE_BASELINE_SNAPSHOT_META));
    assert.equal(readBaselineSnapshot(snap), null);

    // No record (the first run with this code): the partitions.
    rmSync(join(root, LIVE_BASELINE_FILE));
    assert.equal(readBaselineRecord(root), null);
    assert.equal(check(root, snap, nowMs).previous.recordUnused, `no ${LIVE_BASELINE_FILE}`);
  } finally {
    cleanup();
  }
});

test('a committed partition that differs from the verified snapshot is named (phase 1 check)', () => {
  const { w, root, snap, cleanup } = setup();
  try {
    saveEventMap(root, w.map);
    deriveRun(root, T0, w.seq);
    snapshot(root, snap, T0 + 2 * 60_000);
    const day = eventDayKey(T0 - DAY);
    writeFileSync(dayPartitionFile(root, day), readFileSync(dayPartitionFile(root, day), 'utf8').replace('"mag":', '"mag": '));
    const a = check(root, snap, T0 + 4 * 60_000);
    assert.deepEqual(a.previous.partitionDiffers, [day]);
    assert.ok(a.previous.fromSnapshot.includes(day), 'the snapshot, verified by the record, is still used');
  } finally {
    cleanup();
  }
});

test('the record: the days around the window, null for a day without a partition, about a kilobyte', () => {
  const texts = new Map([[eventDayKey(T0), 'a\n']]);
  const r = baselineRecord(T0, 7, texts);
  assert.deepEqual(Object.keys(r.days), baselineDays(T0));
  assert.match(r.days[eventDayKey(T0)]!, /^[0-9a-f]{64}$/);
  assert.equal(r.days[eventDayKey(T0 + DAY)], null);
  const root = mkdtempSync(join(tmpdir(), 'baseline-rec-'));
  try {
    assert.equal(writeBaselineRecord(root, r), true);
    assert.equal(writeBaselineRecord(root, r), false, 'unchanged: not rewritten');
    assert.deepEqual(readBaselineRecord(root), r);
    const full = baselineRecord(T0, 7, new Map(baselineDays(T0).map((d) => [d, d])));
    writeBaselineRecord(root, full);
    assert.ok(readFileSync(join(root, LIVE_BASELINE_FILE)).byteLength < 1_200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wiring: the snapshot step runs before anything writes the checkout, and derive reads the directory it wrote', () => {
  const yml = (rel: string): string => readFileSync(here(rel), 'utf8');
  const dir = 'LIVE_BASELINE_DIR: ${{ runner.temp }}/live-baseline';
  /** The step named `name` in a workflow or action file: its text up to the next step. */
  const step = (body: string, name: string): string => {
    const at = body.indexOf(`- name: ${name}\n`);
    assert.ok(at >= 0, `no step "${name}"`);
    const next = body.indexOf('\n      - ', at + 1);
    return body.slice(at, next < 0 ? undefined : next);
  };
  for (const [file, before] of [
    ['../.github/workflows/aggregate.yml', '- name: Aggregate\n'],
    ['../.github/workflows/derive.yml', 'uses: ./.github/actions/derive-publish'],
  ] as const) {
    const body = yml(file);
    const snap = step(body, 'Snapshot the silent-change baseline');
    assert.ok(body.indexOf(snap) < body.indexOf(before), `${file}: the snapshot comes before "${before.trim()}"`);
    assert.ok(body.indexOf(snap) > body.indexOf('ref: data'), `${file}: the snapshot comes after the data checkout`);
    assert.match(snap, /continue-on-error: true/, `${file}: a failed snapshot never stops the run`);
    assert.match(snap, /timeout-minutes: \d+/, `${file}: bounded`);
    assert.ok(snap.includes(dir), `${file}: ${dir}`);
    assert.match(snap, /run: npx --no-install tsx src\/live-baseline\.ts/);
  }
  const action = yml('../.github/actions/derive-publish/action.yml');
  const derive = action.slice(action.indexOf('- name: Derive views'), action.indexOf('- name: Validate output'));
  assert.ok(derive.includes(dir), 'derive reads the snapshot the workflow wrote');
});
