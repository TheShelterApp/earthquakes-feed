import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { appendObservations } from '../src/bitemporal.js';
import { CORRECTION_EPOCH, dataPaths } from '../src/config.js';
import { ROWS_LOGGED_REASON, correctedEpoch, correctionFloor, runCorrection, unloggedRows } from '../src/correction.js';
import { REHOMED_REASON_PREFIX, Resolver, rowAsReport } from '../src/dedup.js';
import { LogBuffer, ROW_REVISED_REASON, observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { revisionSweep } from '../src/sweep.js';
import type { EventNode, Observation, ProvenanceRow, RawObs } from '../src/types.js';

// PF-5h (2), round 15: a revision of a row that represents nothing in its event was stored in the event map without a
// log line, so a replay of the log kept the older version. The fixture is production's: every log line of the Loyalty
// Islands M5.3 of 2026-09-29 03:23 UTC (efd_01M3NK1M40P3V0TNX2A4CWW2SH, ComCat's reviewed us6000tya5 represents it) and
// the event as the event map of origin/data dae9220725 holds it. GEOFON's row went from M5.71 to M5.3, GeoNet's from
// M5.5 at 03:23:58 to M5.6 at 03:23:54, EMSC's moved 0.3 s and RéNaSS's went from 5.306 to 5.326, all without a line.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);

const LINES: Observation[] = readFileSync(here('fixtures/row-revisions-2026-09-29.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);
const STORED = JSON.parse(readFileSync(here('fixtures/row-revisions-2026-09-29-node.json'), 'utf8')) as EventNode;
const FEED_ID = 'efd_01M3NK1M40P3V0TNX2A4CWW2SH';
/** A run time that keeps the event inside the hot window (and its day not frozen). */
const NOW = Date.parse('2026-10-06T02:47:07Z');
const INGEST = '2026-10-06T02:52:00.000Z';
const HEAD_SEQ = 207_668;
/** The rows the event map holds in a version no line carries. */
const SILENT = ['emsc:20260929_0000040', 'geofon:gfz2026tbkb', 'geonet:2026p732821', 'renass:fr2026usmnvz'];

const keyOf = (r: { provider: string; nativeId: string }): string => `${r.provider}:${r.nativeId}`;
const solution = (r: ProvenanceRow): unknown[] => [r.eventTimeMs, r.lat, r.lon, r.depth, r.mag, r.magType, r.status, r.place, r.providerUpdatedMs, r.fields];
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A replay of log lines as the replay tools make it: op:observe and op:tombstone lines in seq order through one
 *  Resolver (a re-home's op:tombstone is the effect of the op:observe line after it); op:merge and op:correction lines
 *  are not replayed. */
function replay(lines: readonly Observation[]): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  for (const o of [...lines].sort((a, b) => a.seq - b.seq)) {
    if (o.op === 'tombstone') {
      if (!o.reason?.startsWith(REHOMED_REASON_PREFIX)) r.tombstoneProvider(observationToRaw(o), o.ingest_time);
    } else if (o.op === 'observe') r.ingest(observationToRaw(o), o.ingest_time);
  }
  return map;
}

/** Each live row of the replayed map, by provider id. */
function rowsOf(map: Map<string, EventNode>): Map<string, ProvenanceRow> {
  const out = new Map<string, ProvenanceRow>();
  for (const n of map.values()) if (n.state === 'live') for (const r of n.provenance) out.set(keyOf(r), r);
  return out;
}

/** The stored rows whose version the replay of `lines` does not reproduce. */
function differing(lines: readonly Observation[]): string[] {
  const got = rowsOf(replay(lines));
  return STORED.provenance.filter((r) => !got.has(keyOf(r)) || JSON.stringify(solution(got.get(keyOf(r))!)) !== JSON.stringify(solution(r))).map(keyOf).sort();
}

test('row revisions: the log production wrote replays to older versions of four rows than the event map holds', () => {
  assert.deepEqual(differing(LINES), SILENT);
  // All four represent nothing: ComCat's reviewed row leads the event.
  assert.equal(STORED.chosenProvider, 'usgs');
  for (const k of SILENT) assert.equal(STORED.provenance.find((r) => keyOf(r) === k)!.chosen, false, k);
});

/** Production's runs over the fixture: every logged line, then each stored version of a SILENT row as the report that
 *  revised it, all through recordIngest (aggregate's and the sweep's path). */
function produce(): { map: Map<string, EventNode>; log: LogBuffer; results: { key: string; rowOnly: boolean; changed: boolean }[] } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  for (const o of LINES) if (o.op === 'observe') r.ingest(observationToRaw(o), o.ingest_time);
  const log = new LogBuffer(HEAD_SEQ, INGEST);
  const results: { key: string; rowOnly: boolean; changed: boolean }[] = [];
  for (const k of SILENT) {
    const raw = rowAsReport(STORED.provenance.find((x) => keyOf(x) === k)!);
    const res = r.ingest(raw, INGEST);
    log.recordIngest(raw, res);
    results.push({ key: k, rowOnly: res.rowOnly === true, changed: res.changed });
  }
  return { map, log, results };
}

test('row revisions: a revision of a row that represents nothing gets an op:observe line; the event does not change', () => {
  const { map, log, results } = produce();
  const node = [...map.values()].find((n) => n.state === 'live' && n.provenance.some((x) => keyOf(x) === 'usgs:us6000tya5'))!;
  const before = { revision: node.revision, lastSeq: node.lastSeq, lastIngestTime: node.lastIngestTime, mag: node.mag, chosen: node.chosenProvider };
  assert.deepEqual(results, SILENT.map((key) => ({ key, rowOnly: true, changed: false })));
  assert.equal(log.rowsRevised, 4);
  assert.equal(log.lines.length, 4);
  assert.deepEqual(log.lines.map((l) => l.seq), [1, 2, 3, 4].map((i) => HEAD_SEQ + i));
  for (const l of log.lines) {
    assert.ok(vObs(l), JSON.stringify(vObs.errors));
    assert.equal(l.op, 'observe');
    assert.equal(l.reason, ROW_REVISED_REASON);
    assert.equal(l.feed_id, node.feedId);
    assert.equal(l.revision, node.revision, 'the line carries the event at its unchanged revision');
  }
  // The event's revision, ingest_seq, ingest time and solution are what they were: derive publishes the same change-log.
  assert.deepEqual({ revision: node.revision, lastSeq: node.lastSeq, lastIngestTime: node.lastIngestTime, mag: node.mag, chosen: node.chosenProvider }, before);
  // Each line carries the stored row.
  for (const l of log.lines) {
    const row = node.provenance.find((x) => x.provider === l.provider && x.nativeId === l.provider_event_id)!;
    assert.deepEqual(solution(rowAsReport(row) as unknown as ProvenanceRow), solution(rowAsReport(STORED.provenance.find((x) => keyOf(x) === keyOf(row))!) as unknown as ProvenanceRow));
  }
});

test('row revisions: the log with the row lines replays to the rows the event map holds', () => {
  const { log } = produce();
  assert.deepEqual(differing([...LINES, ...log.lines]), []);
  // Without them (before round 15) the replay keeps the older versions.
  assert.deepEqual(differing(LINES), SILENT);
});

test('row revisions: an unchanged re-report writes nothing; a revision of the representative is a change', () => {
  const { map } = produce();
  const r = new Resolver(map, prio, cfg, NOW);
  const log = new LogBuffer(HEAD_SEQ, INGEST);
  const node = map.get([...map.values()].find((n) => n.state === 'live' && n.provenance.some((x) => keyOf(x) === 'usgs:us6000tya5'))!.feedId)!;
  const geofon = rowAsReport(node.provenance.find((x) => x.provider === 'geofon')!);
  const same = r.ingest(geofon, INGEST);
  assert.deepEqual([same.changed, same.rowOnly ?? false, log.recordIngest(geofon, same)], [false, false, false]);
  assert.equal(log.lines.length, 0);
  const usgs = rowAsReport(node.provenance.find((x) => x.chosen)!);
  const revision = node.revision;
  const moved = r.ingest({ ...usgs, mag: 5.4, providerUpdatedMs: (usgs.providerUpdatedMs ?? 0) + 60_000 }, INGEST);
  assert.equal(moved.changed, true);
  assert.equal(moved.rowOnly, undefined);
  assert.equal(log.recordIngest(usgs, moved), true);
  assert.equal(node.revision, revision + 1);
  assert.equal(node.lastSeq, HEAD_SEQ + 1);
  assert.equal(log.rowsRevised, 0);
  assert.equal(log.lines[0]!.reason, undefined);
});

test('row revisions: the revision sweep logs a row-only revision and does not count it as a revision', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  const t = Date.parse('2026-10-05T12:00:00Z');
  const report = (provider: string, id: string, over: Partial<RawObs> = {}): RawObs => ({
    provider, providerEventId: id, eventTimeMs: t, providerUpdatedMs: t + 600_000, status: 'automatic', lat: 38.1, lon: 20.5,
    depth: 10, mag: 4.6, magType: 'mb', place: 'Greece', knownAliasIds: [], fields: {}, ...over,
  });
  // NOA's reviewed solution leads; ComCat's and GEOFON's automatic ones join it.
  for (const x of [report('noa', 'noa2026tst', { status: 'reviewed', magType: 'ML' }), report('usgs', 'us7000tst1', { lat: 38.12 }), report('geofon', 'gfz2026tst', { lat: 38.09 })]) {
    r.ingest(x, INGEST);
  }
  const node = [...map.values()].find((n) => n.state === 'live')!;
  assert.deepEqual([map.size, node.provenance.length, node.chosenProvider], [1, 3, 'noa']);
  const revision = node.revision;
  const log = new LogBuffer(HEAD_SEQ, INGEST);
  // GEOFON is no LATE_MINT_PROVIDERS source (Resolver.reviseExisting), ComCat is (reviseOrMintInHotWindow).
  const geofon = report('geofon', 'gfz2026tst', { lat: 38.09, mag: 4.7, providerUpdatedMs: t + 900_000 });
  const usgs = report('usgs', 'us7000tst1', { lat: 38.12, depth: 12, providerUpdatedMs: t + 900_000 });
  const sweep = revisionSweep(r, log, [geofon, usgs], {}, INGEST);
  assert.equal(sweep.revisions, 0);
  assert.equal(log.rowsRevised, 2);
  assert.deepEqual(log.lines.map((l) => [l.provider, l.reason, l.revision, l.mag, l.depth]), [
    ['geofon', ROW_REVISED_REASON, revision, 4.7, 10],
    ['usgs', ROW_REVISED_REASON, revision, 4.6, 12],
  ]);
  assert.equal(node.revision, revision);
});

/** A data root holding the fixture's lines as the data branch holds them. */
function dataRoot(lines: readonly Observation[]): string {
  const root = mkdtempSync(join(tmpdir(), 'row-revisions-'));
  mkdirSync(dataPaths(root).observationsDir, { recursive: true });
  appendObservations(root, [...lines]);
  return root;
}

test('correction epoch 3: the stored rows the log does not carry get a line each; nothing else changes', () => {
  assert.equal(CORRECTION_EPOCH, 3);
  const root = dataRoot(LINES);
  try {
    const map = new Map<string, EventNode>([[FEED_ID, clone(STORED)]]);
    const before = clone(STORED);
    const log = new LogBuffer(HEAD_SEQ, INGEST);
    const marker = runCorrection(root, map, prio, cfg, log, { nowMs: NOW, ingestTime: INGEST, fromEpoch: 2 });
    assert.equal(correctedEpoch(root), 3);
    assert.equal(marker.from_epoch, 2);
    assert.deepEqual([marker.afad, marker.comcat_id, marker.nrcan], [null, null, null]);
    assert.deepEqual(marker.rows, { checked: 8, logged: 4, no_line: 0 });
    assert.deepEqual(log.lines.map((l) => `${l.provider}:${l.provider_event_id}`).sort(), SILENT);
    assert.deepEqual([marker.first_seq, marker.last_seq], [HEAD_SEQ + 1, HEAD_SEQ + 4]);
    for (const l of log.lines) {
      assert.ok(vObs(l), JSON.stringify(vObs.errors));
      assert.deepEqual([l.op, l.feed_id, l.revision, l.reason], ['observe', FEED_ID, STORED.revision, ROWS_LOGGED_REASON]);
    }
    assert.equal(log.rowsRevised, 0, 'not a revision of this run');
    // The event map is untouched: same rows, revision, ingest_seq.
    assert.deepEqual(map.get(FEED_ID), before);
    // The replay of the log with these lines reproduces every stored row.
    assert.deepEqual(differing([...LINES, ...log.lines]), []);

    // Idempotent: with the lines on the branch, a second pass finds nothing.
    appendObservations(root, log.lines);
    const { floorMs } = correctionFloor(NOW);
    assert.deepEqual(unloggedRows(map, floorMs, [...LINES, ...log.lines]).rows, []);
    const again = new LogBuffer(log.seq, INGEST);
    const second = runCorrection(root, map, prio, cfg, again, { nowMs: NOW + 300_000, ingestTime: INGEST, fromEpoch: 2 });
    assert.deepEqual(second.rows, { checked: 8, logged: 0, no_line: 0 });
    assert.equal(again.lines.length, 0);
    // A branch at epoch 3 makes no step.
    const none = new LogBuffer(log.seq, INGEST);
    assert.equal(runCorrection(root, map, prio, cfg, none, { nowMs: NOW, ingestTime: INGEST, fromEpoch: 3 }).rows, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('correction epoch 3: frozen days and rows no line carries are left alone', () => {
  const root = dataRoot(LINES);
  try {
    // Ten days later the event's day is frozen: nothing to check.
    const later = NOW + 4 * 86_400_000;
    const frozen = runCorrection(root, new Map([[FEED_ID, clone(STORED)]]), prio, cfg, new LogBuffer(HEAD_SEQ, INGEST), { nowMs: later, ingestTime: INGEST, fromEpoch: 2 });
    assert.ok(Date.parse(`${correctionFloor(later).fromDay}T00:00:00Z`) > STORED.eventTimeMs);
    assert.deepEqual(frozen.rows, { checked: 0, logged: 0, no_line: 0 });
    // A row with no line at all (backfill and onboarding write none) is counted, not logged.
    const node = clone(STORED);
    node.provenance.push({ ...clone(node.provenance.find((x) => x.provider === 'ga')!), provider: 'bgs', nativeId: 'bgs-backfilled', chosen: false });
    const log = new LogBuffer(HEAD_SEQ, INGEST);
    const marker = runCorrection(root, new Map([[FEED_ID, node]]), prio, cfg, log, { nowMs: NOW, ingestTime: INGEST, fromEpoch: 2 });
    assert.deepEqual(marker.rows, { checked: 9, logged: 4, no_line: 1 });
    assert.ok(!log.lines.some((l) => l.provider === 'bgs'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('correction epoch 3: lines this run wrote before the step count as carrying their rows', () => {
  const root = dataRoot(LINES);
  try {
    const map = new Map<string, EventNode>([[FEED_ID, clone(STORED)]]);
    const log = new LogBuffer(HEAD_SEQ, INGEST);
    // An earlier step of the same run logged GEOFON's stored row (as the NRCan fills of epoch 2 would).
    const geofon = map.get(FEED_ID)!.provenance.find((x) => x.provider === 'geofon')!;
    log.recordRow(rowAsReport(geofon), { node: map.get(FEED_ID)!, changed: false, revision: STORED.revision, merges: [] }, 'an earlier step');
    const marker = runCorrection(root, map, prio, cfg, log, { nowMs: NOW, ingestTime: INGEST, fromEpoch: 2 });
    assert.equal(marker.rows?.logged, 3);
    assert.equal(log.lines.filter((l) => l.provider === 'geofon').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
