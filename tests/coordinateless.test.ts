import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Resolver } from '../src/dedup.js';
import { RETRACTION_REASON, healedEpoch, runFeedSideSteps } from '../src/heal.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { writeDayPartition } from '../src/partitions.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { emptyTally, isCoordinateless, screen } from '../src/quality.js';
import { summaryFeats } from '../src/summaries.js';
import type { EventNode, RawObs } from '../src/types.js';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const NOW = Date.parse('2026-09-28T14:00:00Z');
const T = Date.parse('2026-09-27T10:00:00Z');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);

function raw(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T,
    providerUpdatedMs: null,
    status: null,
    lat: 38.1,
    lon: -122.2,
    depth: 8,
    mag: 2.1,
    magType: 'md',
    place: null,
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

/** NCEDC's unlocated placeholder, as the feed logged it (Latitude/Longitude "0.00000", MU 0.0). */
const placeholder = (id: string, over: Partial<RawObs> = {}): RawObs =>
  raw('ncedc', id, {
    lat: 0,
    lon: 0,
    depth: 0,
    mag: 0,
    magType: 'MU',
    fields: { EventID: id, Latitude: '0.00000', Longitude: '0.00000', 'Depth/km': '0.000', MagType: 'MU', Magnitude: '0.0' },
    ...over,
  });

test('the rule is exact: lat 0 AND lon 0 with magnitude 0 or none', () => {
  assert.equal(isCoordinateless({ lat: 0, lon: 0, mag: 0 }), true, "NCEDC's placeholder");
  assert.equal(isCoordinateless({ lat: 0, lon: 0, mag: null }), true, 'no magnitude either');
  assert.equal(isCoordinateless({ lat: -0, lon: 0, mag: 0 }), true, '-0 is 0');
  assert.equal(isCoordinateless({ lat: 0, lon: 0, mag: 2.1 }), false, 'a real event at 0°N 0°E keeps its magnitude');
  assert.equal(isCoordinateless({ lat: 0, lon: 0, mag: 0.1 }), false);
  assert.equal(isCoordinateless({ lat: 0.0001, lon: 0, mag: 0 }), false, 'a located M0 near the origin stays');
  assert.equal(isCoordinateless({ lat: 0, lon: 0.5, mag: null }), false);
  assert.equal(isCoordinateless({ lat: 1.2, lon: 0, mag: 0 }), false);
});

test('ingest screen: coordinate-less and out-of-range reports are dropped and counted; the delete path keeps placeholders', () => {
  const tally = emptyTally();
  const kept = screen([placeholder('1'), raw('emsc', 'e'), raw('jma', 'j', { lat: 3512.3 }), placeholder('2', { mag: null }), raw('ncedc', '3', { lat: 0, lon: 0, mag: 1.4 })], tally);
  assert.deepEqual(kept.map((r) => `${r.provider}:${r.providerEventId}`), ['emsc:e', 'ncedc:3']);
  assert.equal(tally.coordinateless, 2);
  assert.equal(tally.bad_coords, 1);
  assert.deepEqual(tally.byProvider.coordinateless, { ncedc: 2 });
  assert.deepEqual(tally.byProvider.bad_coords, { jma: 1 });
  const del = emptyTally();
  assert.equal(screen([placeholder('1'), raw('jma', 'j', { lat: 3512.3 })], del, new Set(['coordinateless'])).length, 1, 'a delete of a placeholder still applies');
  assert.equal(del.bad_coords, 1);
});

/** Published before the rule: a lone placeholder, a real EMSC event that a placeholder joined
 *  through USGS's cross-id (NCEDC 75437222, 2026-09-17), and an unrelated live event. */
function publishedBeforeTheRule(): { map: Map<string, EventNode>; lone: EventNode; joined: EventNode; other: EventNode } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  const lone = r.ingest(placeholder('75417877'), '2026-09-27T10:05:00.000Z').node;
  const joined = r.ingest(raw('emsc', '20260927_0000196', { lat: 41.2735, lon: -122.3692, mag: 3.4, magType: 'ml' }), '2026-09-27T10:05:00.000Z').node;
  joined.aliases.push('usgs:nc75437222'); // a USGS row once named it, and was later withdrawn
  // A later run (the constructor registers every live alias) resolves the placeholder there.
  const r2 = new Resolver(map, prio, cfg, NOW);
  r2.ingest(placeholder('75437222', { knownAliasIds: ['usgs:nc75437222'] }), '2026-09-27T10:06:00.000Z');
  const other = r2.ingest(raw('usgs', 'us1', { eventTimeMs: T + 3600_000, lat: 35, lon: 139, mag: 4.4, status: 'reviewed' }), '2026-09-27T11:05:00.000Z').node;
  for (const n of map.values()) {
    n.firstSeenSeq = n.lastSeq = 100;
  }
  assert.equal(joined.provenance.length, 2, 'the placeholder rode along on a real event');
  assert.equal(map.size, 3);
  return { map, lone, joined, other };
}

test('retraction: the upstream-delete path — a lone placeholder is tombstoned, a joined row withdrawn, others untouched', () => {
  const { map, lone, joined, other } = publishedBeforeTheRule();
  const r = new Resolver(map, prio, cfg, NOW);
  const loneRev = lone.revision;
  const out = r.retractCoordinateless('2026-09-28T14:00:00.000Z');
  // Event time, then feed id: both share the origin time here, so the id order decides.
  const expected = [lone, joined].sort((a, b) => (a.feedId < b.feedId ? -1 : 1)).map((n) => (n === lone ? 'ncedc:75417877' : 'ncedc:75437222'));
  assert.deepEqual(out.map((x) => `${x.raw.provider}:${x.raw.providerEventId}`), expected);
  assert.equal(lone.state, 'tombstoned');
  assert.equal(lone.provenance.length, 0);
  assert.equal(lone.revision, loneRev + 1);
  assert.equal(joined.state, 'live', 'a real event keeps its other rows and stays live');
  assert.deepEqual(joined.provenance.map((p) => p.provider), ['emsc']);
  assert.equal(joined.lat, 41.2735);
  assert.ok(joined.aliases.includes('ncedc:75437222'), 'the alias stays, so a located NCEDC revision lands here');
  assert.equal(other.revision, 1, 'untouched');
  assert.deepEqual(r.retractCoordinateless('2026-09-28T14:05:00.000Z'), [], 'idempotent: nothing left the second time');
});

test('retraction lines: op:tombstone with a reason, schema-valid, and a replay of them reproduces the state', () => {
  const { map } = publishedBeforeTheRule();
  const r = new Resolver(map, prio, cfg, NOW);
  const log = new LogBuffer(500, '2026-09-28T14:00:00.000Z');
  for (const { raw: w, result } of r.retractCoordinateless('2026-09-28T14:00:00.000Z')) log.record(w, result, 'tombstone', RETRACTION_REASON);
  assert.deepEqual(log.lines.map((l) => [l.seq, l.op, l.reason]), [
    [501, 'tombstone', RETRACTION_REASON],
    [502, 'tombstone', RETRACTION_REASON],
  ]);
  for (const l of log.lines) assert.ok(vObs(l), ajv.errorsText(vObs.errors));
  // A rebuild replays op:tombstone through tombstoneProvider (scripts/replay-dedup.ts).
  const again = publishedBeforeTheRule();
  const rr = new Resolver(again.map, prio, cfg, NOW);
  for (const l of log.lines) rr.tombstoneProvider(observationToRaw(l), l.ingest_time);
  const shape = (m: Map<string, EventNode>): unknown => [...m.values()].map((n) => [n.state, n.revision, n.provenance.map((p) => p.nativeId)]);
  assert.deepEqual(shape(again.map), shape(map));
});

test('retracted events leave the live surfaces at once: summaries and the Pages day file; the tree partition keeps them', () => {
  const { map, lone, joined, other } = publishedBeforeTheRule();
  new Resolver(map, prio, cfg, NOW).retractCoordinateless('2026-09-28T14:00:00.000Z');
  const ids = summaryFeats(map.values(), NOW).map((f) => (f.feature as { id: string }).id);
  assert.deepEqual(ids.sort(), [joined.feedId, other.feedId].sort());
  const root = mkdtempSync(join(tmpdir(), 'efd-coordless-'));
  try {
    const publicV1 = join(root, 'public', 'v1');
    writeDayPartition(root, '2026-09-27', [...map.values()], { publicV1, nowMs: NOW, headIngestTime: '2026-09-28T14:00:00.000Z' });
    const day = JSON.parse(readFileSync(join(publicV1, 'events', '2026-09-27.geojson'), 'utf8')) as { features: { id: string; geometry: { coordinates: number[] } }[]; metadata: { count: number } };
    assert.ok(!day.features.some((f) => f.id === lone.feedId), 'not on the Pages day file');
    assert.ok(!day.features.some((f) => f.geometry.coordinates[0] === 0 && f.geometry.coordinates[1] === 0));
    assert.equal(day.metadata.count, 2);
    const tree = readFileSync(join(root, 'events', '2026', '09', '27.ndjson'), 'utf8');
    assert.match(tree, new RegExp(`"id":"${lone.feedId}".*"state":"tombstoned"`), 'the archive keeps it, tombstoned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFeedSideSteps without a heal due: retraction only, no marker', () => {
  const { map } = publishedBeforeTheRule();
  const root = mkdtempSync(join(tmpdir(), 'efd-coordless-'));
  try {
    const log = new LogBuffer(100, '2026-09-28T14:00:00.000Z');
    const res = runFeedSideSteps(root, new Resolver(map, prio, cfg, NOW), log, { healDue: false, loadDays: 10, ingestTime: '2026-09-28T14:00:00.000Z' });
    assert.equal(res.retracted, 2);
    assert.deepEqual(res.retractedByProvider, { ncedc: 2 });
    assert.equal(res.heal, null);
    assert.equal(healedEpoch(root), 0, 'no marker');
    assert.equal(log.seq, 102);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
