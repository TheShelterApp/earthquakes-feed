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
  PAGES_RECOVERY_BUDGET_MS,
  baselineDays,
  baselineRecord,
  partitionTexts,
  previousWindowLines,
  readBaselineRecord,
  readBaselineSnapshot,
  recoverFromPages,
  sha256Hex,
  whyRecordUnused,
  writeBaselineRecord,
  writeBaselineSnapshot,
} from '../src/live-baseline.js';
import { detectSilentChanges, liveWindowDays, silentChangesAgainst } from '../src/live-sync.js';
import { dayPartitionFile, dayPartitionText, partitionPath, writeDayPartition } from '../src/partitions.js';
import { LogBuffer } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';

// Round 25, storage option 4: derive's silent-change check (PRB-2) takes the previous run's lines from the event map the
// job checked out (a snapshot, verified against the sha256 that run recorded), not from the day partitions it committed.
// Phase 2 stops committing the unfrozen days: a day the previous derive did not publish from the checked-out event map
// (it failed after its aggregate commit) comes from that derive's Pages copy, verified the same way, or has no baseline.
// These tests hold the snapshot to the answer of the committed partitions (live-sync.ts detectSilentChanges, the
// reference) while they exist, and show it without them.

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

/** The snapshot step on the checkout `root` at `nowMs` (src/live-baseline.ts main), with the Pages fallback when a
 *  `pages` fetch is given (the previous derive's deployed copies). */
async function snapshot(root: string, dir: string, nowMs: number, pages?: typeof fetch): Promise<string[]> {
  const map = loadEventMap(root, { nowMs });
  const days = baselineDays(nowMs);
  const texts = partitionTexts(map.values(), days);
  const record = readBaselineRecord(root);
  const prev = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as { generated: number; head_seq: number };
  const recovered =
    pages && record && whyRecordUnused(record, prev, 'n/a') == null
      ? (await recoverFromPages({ days, texts, record, base: 'https://pages.test/', fetchImpl: pages })).recovered
      : [];
  writeBaselineSnapshot(dir, days, texts, { taken_at: nowMs, head_seq: 0, from_pages: recovered });
  return recovered;
}

/** A Pages origin serving the day partitions in `files` (path -> text); anything else is a 404. */
function pagesServing(files: Map<string, string>, asked: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    const path = String(url).replace('https://pages.test/', '');
    asked.push(path);
    const body = files.get(path);
    return body == null ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
  }) as typeof fetch;
}

/** derive's check at `nowMs`: the baseline, and the committed partitions' check (the reference) beside it. */
function check(root: string, snapDir: string | undefined, nowMs: number) {
  const prev = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as { generated: number; head_seq: number };
  const nodes = [...loadEventMap(root, { nowMs }).values()];
  const days = liveWindowDays(nowMs);
  const previous = previousWindowLines({ days, record: readBaselineRecord(root), prev, snapshot: readBaselineSnapshot(snapDir) });
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

test('the snapshot of the checked-out event map is byte for byte the partitions the previous derive wrote', async () => {
  const { w, root, snap, cleanup } = setup();
  try {
    saveEventMap(root, w.map);
    deriveRun(root, T0, w.seq);
    // A Pages fallback is never asked when every day matches the record.
    const asked: string[] = [];
    assert.deepEqual(await snapshot(root, snap, T0 + 2 * 60_000, pagesServing(new Map(), asked)), []);
    assert.deepEqual(asked, []);
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

test('a silent change is found from the snapshot alone, with or without the committed partitions', async () => {
  const { w, root, snap, target, cleanup } = setup();
  try {
    saveEventMap(root, w.map);
    deriveRun(root, T0, w.seq);
    // The next job: the snapshot step, then an aggregate run that revises the GEOFON row (no new seq), then derive.
    await snapshot(root, snap, T0 + 2 * 60_000);
    silentRevision(w, T0 + 3 * 60_000, target, 'GFZ-rev');
    saveEventMap(root, w.map);
    const nowMs = T0 + 4 * 60_000;
    const a = check(root, snap, nowMs);
    assert.equal(a.previous.recordUnused, null);
    assert.deepEqual(a.previous.fromSnapshot, liveWindowDays(nowMs), 'every window day from the snapshot');
    assert.deepEqual(a.previous.missing, []);
    assert.deepEqual(a.fromBaseline, [target.feedId]);
    assert.deepEqual(a.fromPartitions, a.fromBaseline, 'the committed partitions (the reference) give the same');

    // Phase 2: the unfrozen partitions are not on `data` (a fresh checkout has none); the snapshot still finds it.
    for (const day of liveWindowDays(nowMs)) if (existsSync(dayPartitionFile(root, day))) unlinkSync(dayPartitionFile(root, day));
    const b = check(root, snap, nowMs);
    assert.deepEqual(b.fromBaseline, [target.feedId]);
    assert.deepEqual(b.fromPartitions, [], 'the old check finds nothing without the partitions');
  } finally {
    cleanup();
  }
});

test("after a derive that failed, the changed day comes from that run's Pages copy, verified by the record", async () => {
  const { w, root, snap, target, cleanup } = setup();
  try {
    saveEventMap(root, w.map);
    deriveRun(root, T0, w.seq); // run N-2: committed and deployed
    const day = eventDayKey(target.eventTimeMs);
    // What N-2 deployed to Pages: its partitions of the unfrozen days (partitions.ts writePagesPartition).
    const deployed = new Map<string, string>();
    for (const d of baselineDays(T0)) if (existsSync(dayPartitionFile(root, d))) deployed.set(partitionPath(d), readFileSync(dayPartitionFile(root, d), 'utf8'));
    // Run N-1: the aggregate commits a silent revision, its derive fails (nothing of it is committed or deployed).
    silentRevision(w, T0 + 3 * 60_000, target, 'GFZ-rev');
    saveEventMap(root, w.map);
    // Run N checks out N-1's event map with N-2's record and manifest, and no unfrozen partition (phase 2).
    for (const d of baselineDays(T0)) if (existsSync(dayPartitionFile(root, d))) unlinkSync(dayPartitionFile(root, d));
    const nowMs = T0 + 8 * 60_000;

    // Without the Pages fallback the revised day has no baseline, and the change is not found: the phase-2 loss.
    await snapshot(root, snap, T0 + 6 * 60_000);
    const bare = check(root, snap, nowMs);
    assert.deepEqual(bare.previous.missing, [day], "the revised day's snapshot is not what N-2 wrote");
    assert.equal(bare.previous.fromSnapshot.length, liveWindowDays(nowMs).length - 1);
    assert.deepEqual(bare.fromBaseline, []);

    // With it: only the mismatched day is fetched, its sha256 is the record's, and the change is found.
    const asked: string[] = [];
    assert.deepEqual(await snapshot(root, snap, T0 + 6 * 60_000, pagesServing(deployed, asked)), [day]);
    assert.deepEqual(asked, [partitionPath(day)]);
    assert.deepEqual([...readBaselineSnapshot(snap)!.fromPages], [day]);
    const a = check(root, snap, nowMs);
    assert.deepEqual(a.previous.missing, []);
    assert.deepEqual(a.previous.fromSnapshot, liveWindowDays(nowMs));
    assert.deepEqual(a.fromBaseline, [target.feedId], 'the change N-1 never published is still found');

    // Pages one run older than the record (N-2 committed, its deploy failed): not used, the day has no baseline.
    const older = new Map(deployed);
    older.set(partitionPath(day), deployed.get(partitionPath(day))!.replace('"GFZ"', '"GFZ-older"'));
    assert.deepEqual(await snapshot(root, snap, T0 + 6 * 60_000, pagesServing(older)), []);
    assert.deepEqual(check(root, snap, nowMs).previous.missing, [day]);

    // Without the record's check the snapshot would have taken N-1's line as the previous one and missed it.
    await snapshot(root, snap, T0 + 6 * 60_000);
    const naive = new Map<string, string>();
    for (const line of readFileSync(join(snap, 'events', ...day.split('-')) + '.ndjson', 'utf8').split('\n')) if (line) naive.set((JSON.parse(line) as { id: string }).id, line);
    assert.deepEqual(silentChangesAgainst(naive, [target], liveWindowDays(nowMs), w.seq), []);
  } finally {
    cleanup();
  }
});

test('the record is used only with the manifest of its own run, and only with a snapshot', async () => {
  const { w, root, snap, target, cleanup } = setup();
  try {
    saveEventMap(root, w.map);
    deriveRun(root, T0, w.seq);
    await snapshot(root, snap, T0 + 2 * 60_000);
    silentRevision(w, T0 + 3 * 60_000, target, 'GFZ-rev');
    saveEventMap(root, w.map);
    const nowMs = T0 + 4 * 60_000;
    const window = liveWindowDays(nowMs);

    // A manifest of another run (a record left from an older derive): no day has a baseline.
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ generated: T0 + 1, head_seq: w.seq }));
    const other = check(root, snap, nowMs);
    assert.match(other.previous.recordUnused ?? '', /live_baseline\.json is from the run of/);
    assert.deepEqual(other.previous.fromSnapshot, []);
    assert.deepEqual(other.previous.missing, window);
    assert.deepEqual(other.fromBaseline, []);
    // ...and the snapshot step does not ask Pages for a record of another run.
    const asked: string[] = [];
    await snapshot(root, snap, T0 + 2 * 60_000, pagesServing(new Map(), asked));
    assert.deepEqual(asked, []);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ generated: T0, head_seq: w.seq }));
    await snapshot(root, snap, T0 + 2 * 60_000);

    // No snapshot (the step failed): no baseline.
    const none = check(root, undefined, nowMs);
    assert.equal(none.previous.recordUnused, 'no snapshot');
    assert.deepEqual(none.previous.missing, window);
    // A snapshot cut short (no metadata file) reads as none.
    rmSync(join(snap, LIVE_BASELINE_SNAPSHOT_META));
    assert.equal(readBaselineSnapshot(snap), null);

    // No record: no baseline.
    rmSync(join(root, LIVE_BASELINE_FILE));
    assert.equal(readBaselineRecord(root), null);
    assert.equal(check(root, snap, nowMs).previous.recordUnused, `no ${LIVE_BASELINE_FILE}`);
  } finally {
    cleanup();
  }
});

test('recoverFromPages: only days that differ from a recorded partition, verified, bounded, never throwing', async () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
  const good = 'a\n';
  const record = {
    generated: T0,
    head_seq: 1,
    days: { '2026-10-01': sha256Hex(good), '2026-10-02': null, '2026-10-03': sha256Hex(good), '2026-10-04': sha256Hex(good), '2026-10-05': sha256Hex(good) },
  };
  // 10-01 matches already; 10-02 had no partition; 10-03 is on Pages; 10-04 is on Pages with other bytes; 10-05 fails.
  const texts = new Map([
    ['2026-10-01', good],
    ['2026-10-02', 'new\n'],
    ['2026-10-03', 'changed\n'],
    ['2026-10-04', 'changed\n'],
    ['2026-10-05', 'changed\n'],
  ]);
  const asked: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const path = String(url).replace('https://pages.test/', '');
    asked.push(path);
    if (path === partitionPath('2026-10-03')) return new Response(good, { status: 200 });
    if (path === partitionPath('2026-10-04')) return new Response('other\n', { status: 200 });
    throw new Error('connection reset');
  }) as typeof fetch;
  const r = await recoverFromPages({ days, texts, record, base: 'https://pages.test/', fetchImpl });
  assert.deepEqual(asked, ['2026-10-03', '2026-10-04', '2026-10-05'].map(partitionPath));
  assert.deepEqual(r.recovered, ['2026-10-03']);
  assert.deepEqual(r.failed, ['2026-10-04 (the Pages copy is not the recorded partition)', '2026-10-05 (connection reset)']);
  assert.equal(texts.get('2026-10-03'), good);
  assert.equal(texts.get('2026-10-04'), 'changed\n', 'an unverified copy never replaces the rebuild');
  assert.equal(texts.get('2026-10-02'), 'new\n', 'a day recorded without a partition is not fetched');

  // An HTTP error, and the time budget: once spent, no more requests.
  let t = 0;
  const slow = (async () => {
    t += PAGES_RECOVERY_BUDGET_MS;
    return new Response('gone', { status: 404 });
  }) as typeof fetch;
  const texts2 = new Map(days.map((d) => [d, 'changed\n']));
  const r2 = await recoverFromPages({ days, texts: texts2, record, base: 'https://pages.test/', fetchImpl: slow, nowMs: () => t });
  assert.deepEqual(r2.recovered, []);
  assert.deepEqual(r2.failed, ['2026-10-01 (HTTP 404)', '2026-10-03 (no time left)', '2026-10-04 (no time left)', '2026-10-05 (no time left)']);
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
