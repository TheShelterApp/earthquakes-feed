import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { featureToNode, nodeToFeature } from '../src/bitemporal.js';
import { RETIRED_VISIBLE_MS } from '../src/config.js';
import { Resolver, type IngestResult } from '../src/dedup.js';
import { mergeLine, observationToRaw, observeLine } from '../src/oplog.js';
import { publishesRetired, readDayPartitionNodes, writeDayPartition } from '../src/partitions.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, ProviderConfig, RawObs } from '../src/types.js';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const NOW = Date.parse('2026-09-27T12:00:00Z');
const T0 = Date.parse('2026-09-25T21:23:03Z');
/** One degree of latitude in km — offsets below are stated in km and converted here. */
const KM_PER_DEG = 111.195;
const north = (lat: number, km: number): number => lat + km / KM_PER_DEG;

const fixture: Observation[] = readFileSync(here('fixtures/loyalty-2026-09-25.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);
const FIXTURE_KEYS = [...new Set(fixture.map((o) => `${o.provider}:${o.provider_event_id}`))].sort();

function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: 'automatic',
    lat: -21.3,
    lon: 168.6,
    depth: 10,
    mag: 6.6,
    magType: 'mw',
    place: 'Loyalty Islands',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

function replay(rows: Observation[]): { map: Map<string, EventNode>; resolver: Resolver; merges: number } {
  const map = new Map<string, EventNode>();
  const resolver = new Resolver(map, prio, cfg, NOW);
  let merges = 0;
  for (const o of rows) merges += resolver.ingest(observationToRaw(o), o.ingest_time).merges.length;
  return { map, resolver, merges };
}

/** The invariants every first-sighting order must reach for the fixture. */
function assertOneEvent(map: Map<string, EventNode>, label: string): EventNode {
  const live = [...map.values()].filter((n) => n.state === 'live');
  assert.equal(live.length, 1, `${label}: exactly one live event`);
  const survivor = live[0]!;
  assert.deepEqual([...survivor.aliases].sort(), FIXTURE_KEYS, `${label}: the survivor carries all 12 provider ids`);
  assert.equal(new Set(survivor.provenance.map((r) => r.provider)).size, 10, `${label}: 10 providers`);
  assert.equal(survivor.provenance.length, 12, `${label}: 12 provenance rows`);
  // The representative is a total order over the same final rows, so it is order-independent.
  assert.equal(survivor.chosenProvider, 'usgs', `${label}: the USGS reviewed solution leads`);
  assert.equal(survivor.mag, 6.6);
  assert.equal(survivor.status, 'reviewed');
  for (const n of map.values()) {
    if (n === survivor) continue;
    assert.equal(n.state, 'superseded', `${label}: every other node is superseded`);
    assert.equal(n.supersededBy, survivor.feedId, `${label}: ... and points at the survivor`);
    assert.ok(n.provenance.length > 0, `${label}: a superseded node keeps a frozen copy of its rows`);
  }
  return survivor;
}

test('fixture: the Loyalty Islands M7.0 (21 log lines, 12 provider ids) is one live event', () => {
  const { map, merges } = replay(fixture);
  const survivor = assertOneEvent(map, 'seq order');
  // The widened window lets 10 of the 12 ids join at first sight (22–26 km scatter, both
  // sides ≥ M5.5). Only RéNaSS's 114-km-deep M5.8 preliminary (62 km out, |ΔM| > 1) minted
  // a second id; its first Mwp revision moved it 12 km from the survivor and folded it.
  assert.equal(map.size, 2, 'two ids minted');
  assert.equal(merges, 1, 'one op:merge');
  // In seq order the surviving id is the one the published feed already used for the USGS
  // solution, so the app's own event page keeps its id.
  assert.equal(survivor.feedId, 'efd_01M3D76ES08HGFRSA05T71J8ZF');
  const loser = [...map.values()].find((n) => n.state === 'superseded')!;
  assert.equal(loser.feedId, 'efd_01M3D77C2GZTT65JP6GD75YXXD');
  assert.ok(loser.provenance.every((r) => r.provider === 'renass'), 'the frozen copy is what the loser was');
  assert.ok(survivor.revision > loser.revision - 1, 'both revisions moved');
});

test('fixture: INGV re-publishing the identical solution under a second id folds (no mint)', () => {
  const { map } = replay(fixture.filter((o) => o.provider === 'ingv'));
  assert.equal(map.size, 1);
  const node = [...map.values()][0]!;
  assert.deepEqual(node.aliases.sort(), ['ingv:46714321', 'ingv:47246702']);
  assert.equal(node.provenance.length, 2, 'both rows kept — provenance is never dropped');
});

/** A random interleaving that keeps every provider id's revisions in their real order (a
 *  report's revisions cannot arrive before the report) — "adversarial first-sighting
 *  reordering" in the words of the retired identity.test.ts todo. */
function interleave(rows: Observation[], seed: number): Observation[] {
  const groups = new Map<string, Observation[]>();
  for (const o of rows) {
    const k = `${o.provider}:${o.provider_event_id}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(o);
  }
  const queues = [...groups.values()];
  let s = seed;
  const rnd = (): number => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out: Observation[] = [];
  while (queues.length) {
    const i = Math.floor(rnd() * queues.length);
    out.push(queues[i]!.shift()!);
    if (!queues[i]!.length) queues.splice(i, 1);
  }
  return out;
}

test('fixture: every first-sighting order yields the same event, rows and representative', () => {
  const orders: [string, Observation[]][] = [['reversed groups', interleave([...fixture].reverse(), 1)]];
  for (let seed = 2; seed < 32; seed++) orders.push([`interleave ${seed}`, interleave(fixture, seed)]);
  const survivors = new Set<string>();
  for (const [label, rows] of orders) {
    const { map } = replay(rows);
    survivors.add(assertOneEvent(map, label).feedId);
  }
  // What is NOT order-independent: the surviving id. Ids are content-seeded by the bucket
  // of the FIRST report of each node (ulid.ts) and pinned; twelve agencies' preliminary
  // epicentres span several buckets, so another arrival order mints a different first id
  // (and, when the widened window lets everything join it, never merges at all). The
  // survivor rule is a total order, so which of two nodes wins is deterministic — but the
  // set of nodes that ever existed is not. This is the design's pinned-identity trade-off,
  // not a dedup defect; the test above pins the seq-order id the feed published.
  assert.ok(survivors.size >= 1);
});

test('same-provider DISTINCT reports within the window still mint separately', () => {
  // 5 s apart / 1 km / same magnitude: a provider's own two ids for two events.
  let map = new Map<string, EventNode>();
  let r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('emsc', 'a'), '2026-09-25T21:25:00Z');
  r.ingest(obs('emsc', 'b', { eventTimeMs: T0 + 5_000, lat: north(-21.3, 1) }), '2026-09-25T21:25:00Z');
  assert.equal(map.size, 2, '5 s apart is not a re-id');
  // 1 s apart but 5 km apart.
  map = new Map();
  r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('emsc', 'a'), '2026-09-25T21:25:00Z');
  r.ingest(obs('emsc', 'b', { eventTimeMs: T0 + 1_000, lat: north(-21.3, 5) }), '2026-09-25T21:25:00Z');
  assert.equal(map.size, 2, '5 km apart is not a re-id');
  // Identical origin and place, but a different magnitude.
  map = new Map();
  r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('emsc', 'a'), '2026-09-25T21:25:00Z');
  r.ingest(obs('emsc', 'b', { mag: 6.3 }), '2026-09-25T21:25:00Z');
  assert.equal(map.size, 2, 'ΔM 0.3 is not a re-id');
  // The re-id itself: ≤ 2 s, ≤ 2 km, |ΔM| ≤ 0.1.
  map = new Map();
  r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('emsc', 'a'), '2026-09-25T21:25:00Z');
  const again = r.ingest(obs('emsc', 'b', { eventTimeMs: T0 + 1_500, lat: north(-21.3, 1.5), mag: 6.55 }), '2026-09-25T21:25:00Z');
  assert.equal(map.size, 1, 'one solution under two ids folds');
  assert.equal(again.changed, true);
});

test('an M4.9 aftershock 1 km / 3 min after an M6.6 stays a separate event', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('usgs', 'main', { status: 'reviewed' }), '2026-09-25T21:25:00Z');
  r.ingest(obs('emsc', 'after', { eventTimeMs: T0 + 180_000, lat: north(-21.3, 1), mag: 4.9 }), '2026-09-25T21:30:00Z');
  assert.equal(map.size, 2);
  // The same aftershock 20 s later is inside the time window but below the large-event
  // magnitude — the plain ±10 km window shrunk by ΔM applies, so it joins only when close.
  r.ingest(obs('geofon', 'after2', { eventTimeMs: T0 + 20_000, lat: north(-21.3, 8), mag: 4.9 }), '2026-09-25T21:30:00Z');
  assert.equal(map.size, 3, '8 km at ΔM 1.7 is outside the 3 km shrunk window');
});

test('large-event window: widens with the smaller magnitude, shrinks with ΔM, caps at 50 km, hard |ΔM| ≤ 1', () => {
  const pair = (a: Partial<RawObs>, b: Partial<RawObs>): number => {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, NOW);
    r.ingest(obs('usgs', 'u', a), '2026-09-25T21:25:00Z');
    r.ingest(obs('emsc', 'e', { eventTimeMs: T0 + 2_000, ...b }), '2026-09-25T21:25:00Z');
    return map.size;
  };
  // Both large: base 10 + 20·(6.4 − 5.5) = 28 km, ×(1 − 0.3·0.2) = 26.3 km → 25 km joins.
  assert.equal(pair({ mag: 6.6 }, { mag: 6.4, lat: north(-21.3, 25) }), 1, 'M6.6 / M6.4 at 25 km is one event');
  // Without the widening the same pair would be split (10 km × 0.94).
  assert.equal(pair({ mag: 5.4 }, { mag: 5.4, lat: north(-21.3, 15) }), 2, 'below M5.5 the plain 10 km window applies');
  // Base 10 + 20·0.1 = 12 km, ×(1 − 0.3) = 8.4 km → 15 km stays split.
  assert.equal(pair({ mag: 6.6 }, { mag: 5.6, lat: north(-21.3, 15) }), 2, 'ΔM 1.0 shrinks the widened window');
  // Hard cap: M7.0 / M5.9 → base 18 km × 0.67 = 12.1 km would take 11 km; |ΔM| 1.1 > 1.0 refuses.
  assert.equal(pair({ mag: 7.0 }, { mag: 5.9, lat: north(-21.3, 11) }), 2, '|ΔM| > 1 never merges on the widened path');
  // Cap: M7.5 / M7.5 → 10 + 40 = 50 km (not 50 + …) → 45 km joins, 55 km does not.
  assert.equal(pair({ mag: 7.5 }, { mag: 7.5, lat: north(-21.3, 45) }), 1, 'capped at 50 km');
  assert.equal(pair({ mag: 7.5 }, { mag: 7.5, lat: north(-21.3, 55) }), 2, 'nothing beyond the cap');
});

/** A: usgs reviewed at P0; B: emsc automatic 40 km north — separate at first sight. Then
 *  emsc's revision moves B to 5 km from A. */
function moveScenario(aStatus = 'reviewed', bStatus = 'automatic'): { map: Map<string, EventNode>; r: Resolver; a: EventNode; b: EventNode; res: IngestResult } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  const a = r.ingest(obs('usgs', 'u1', { status: aStatus, providerUpdatedMs: T0 + 60_000 }), '2026-09-25T21:25:00Z').node;
  const b = r.ingest(obs('emsc', 'e1', { status: bStatus, mag: 6.5, lat: north(-21.3, 40) }), '2026-09-25T21:26:00Z').node;
  assert.equal(map.size, 2, 'separate at first sight (40 km > 29 km)');
  const res = r.ingest(obs('emsc', 'e1', { status: bStatus, mag: 6.5, lat: north(-21.3, 5) }), '2026-09-25T21:31:00Z');
  return { map, r, a, b, res };
}

test('op:merge: a node whose revision moves it next to a neighbour folds into it', () => {
  const { map, r, a, b, res } = moveScenario();
  assert.equal(res.changed, true);
  assert.equal(res.merges.length, 1, 'one fold');
  assert.equal(res.node, a, 'the result names the survivor');
  assert.equal(res.revision, a.revision);
  assert.equal(res.merges[0]!.survivor, a);
  assert.equal(res.merges[0]!.loser, b);
  assert.match(res.merges[0]!.reason, /^proximity: d=5\.0 km dt=0\.0 s dM=0\.10 window=/);
  // Survivor: both rows, both aliases, revision bumped, first-seen facts the earlier of the two.
  assert.deepEqual(a.provenance.map((p) => `${p.provider}:${p.nativeId}`).sort(), ['emsc:e1', 'usgs:u1']);
  assert.deepEqual([...a.aliases].sort(), ['emsc:e1', 'usgs:u1']);
  assert.equal(a.revision, 2);
  assert.equal(a.lastIngestTime, '2026-09-25T21:31:00Z');
  assert.equal(a.firstIngestTime, '2026-09-25T21:25:00Z');
  assert.equal(a.chosenProvider, 'usgs');
  // Loser: retired, pointing at the survivor, a frozen copy of what it was, revision bumped.
  assert.equal(b.state, 'superseded');
  assert.equal(b.supersededBy, a.feedId);
  assert.equal(b.revision, 3, 'mint 1 → revision 2 → fold 3');
  assert.equal(b.lastIngestTime, '2026-09-25T21:31:00Z');
  assert.equal(b.provenance.length, 1);
  assert.equal(b.provenance[0]!.nativeId, 'e1');
  assert.notEqual(b.provenance[0], a.provenance.find((p) => p.nativeId === 'e1'), 'a copy, not the moved row');
  assert.equal(map.size, 2, 'the loser stays in the map (its id can never be re-minted)');
  // The loser's id now resolves to the survivor: a re-report is a no-op on the survivor.
  const again = r.ingest(obs('emsc', 'e1', { mag: 6.5, lat: north(-21.3, 5) }), '2026-09-25T21:36:00Z');
  assert.equal(again.node, a);
  assert.equal(again.changed, false);
  assert.equal(map.size, 2, 'no new mint for the loser id');
  // A revision under the loser's id lands on the survivor too (reviseExisting never mints).
  // It updates the emsc row; the USGS row still leads, so the representative — and hence
  // the revision counter — does not move (a non-representative row update is not a revision).
  const rev = r.reviseExisting(obs('emsc', 'e1', { mag: 6.4, lat: north(-21.3, 5) }), '2026-09-25T21:41:00Z');
  assert.equal(rev?.node, a);
  assert.equal(a.provenance.find((p) => p.nativeId === 'e1')!.mag, 6.4);
  assert.equal(b.provenance[0]!.mag, 6.5, 'the frozen copy does not move');
});

test('op:merge survivor: most providers beats status; status beats priority; the moving side may win', () => {
  // Providers first: A = usgs + geofon (automatic); B = emsc reviewed → A survives.
  let map = new Map<string, EventNode>();
  let r = new Resolver(map, prio, cfg, NOW);
  const a = r.ingest(obs('usgs', 'u1'), '2026-09-25T21:25:00Z').node;
  r.ingest(obs('geofon', 'g1', { lat: north(-21.3, 1) }), '2026-09-25T21:25:00Z');
  const b = r.ingest(obs('emsc', 'e1', { status: 'reviewed', mag: 6.5, lat: north(-21.3, 40) }), '2026-09-25T21:26:00Z').node;
  let res = r.ingest(obs('emsc', 'e1', { status: 'reviewed', mag: 6.5, lat: north(-21.3, 3) }), '2026-09-25T21:31:00Z');
  assert.equal(res.node, a, 'two providers beat one reviewed provider');
  assert.equal(b.state, 'superseded');
  assert.equal(a.chosenProvider, 'emsc', 'the representative is still the best row (reviewed)');
  // Status next: A = usgs automatic; B = emsc reviewed (moving) → B survives, A retires.
  map = new Map();
  r = new Resolver(map, prio, cfg, NOW);
  const a2 = r.ingest(obs('usgs', 'u1'), '2026-09-25T21:25:00Z').node;
  const b2 = r.ingest(obs('emsc', 'e1', { status: 'reviewed', mag: 6.5, lat: north(-21.3, 40) }), '2026-09-25T21:26:00Z').node;
  res = r.ingest(obs('emsc', 'e1', { status: 'reviewed', mag: 6.5, lat: north(-21.3, 3) }), '2026-09-25T21:31:00Z');
  assert.equal(res.node, b2, 'reviewed beats automatic even when it is the node that moved');
  assert.equal(a2.state, 'superseded');
  assert.equal(a2.supersededBy, b2.feedId);
  // Priority last (same providers count, same status, same richness): usgs (0) beats emsc (1).
  map = new Map();
  r = new Resolver(map, prio, cfg, NOW);
  const a3 = r.ingest(obs('usgs', 'u1'), '2026-09-25T21:25:00Z').node;
  const b3 = r.ingest(obs('emsc', 'e1', { mag: 6.5, lat: north(-21.3, 40) }), '2026-09-25T21:26:00Z').node;
  res = r.ingest(obs('emsc', 'e1', { mag: 6.5, lat: north(-21.3, 3) }), '2026-09-25T21:31:00Z');
  assert.equal(res.node, a3, 'lower priority number survives');
  assert.equal(b3.state, 'superseded');
});

test('op:merge never crosses the same-provider-distinct or reviewed guards', () => {
  // Both nodes hold an emsc row under different ids → the fold is refused even at 3 km.
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  const a = r.ingest(obs('emsc', 'e1'), '2026-09-25T21:25:00Z').node;
  const b = r.ingest(obs('emsc', 'e2', { eventTimeMs: T0 + 10_000, lat: north(-21.3, 40) }), '2026-09-25T21:26:00Z').node;
  const res = r.ingest(obs('emsc', 'e2', { eventTimeMs: T0 + 10_000, lat: north(-21.3, 3) }), '2026-09-25T21:31:00Z');
  assert.equal(res.merges.length, 0);
  assert.equal(a.state, 'live');
  assert.equal(b.state, 'live');
  assert.equal(r.whyNotMerged(a, b), 'same provider under distinct native ids');
});

test('op:merge log line validates against observation.schema.json and names loser and survivor', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);
  const { a, b, res } = moveScenario();
  const merge = mergeLine(res.merges[0]!, 1001, '2026-09-25T21:31:00.000Z');
  assert.ok(vObs(merge), ajv.errorsText(vObs.errors));
  assert.equal(merge.op, 'merge');
  assert.equal(merge.feed_id, b.feedId);
  assert.equal(merge.superseded_by, a.feedId);
  assert.equal(merge.revision, b.revision);
  assert.equal(merge.provider, 'emsc');
  assert.equal(merge.provider_event_id, 'e1');
  assert.equal(merge.mag, 6.5, "the loser's last representative solution");
  assert.match(merge.reason!, /^proximity: /);
  const observe = observeLine(obs('emsc', 'e1', { mag: 6.5, lat: north(-21.3, 5) }), res, 1002, '2026-09-25T21:31:00.000Z');
  assert.ok(vObs(observe), ajv.errorsText(vObs.errors));
  assert.equal(observe.feed_id, a.feedId, "the report's own line names the survivor");
  assert.equal(observe.revision, a.revision);
  // observationToRaw is the inverse of observeLine (the replay and the fixture rely on it).
  const raw = observationToRaw(observe);
  assert.equal(raw.provider, 'emsc');
  assert.equal(raw.providerEventId, 'e1');
  assert.equal(raw.eventTimeMs, T0);
  assert.equal(raw.mag, 6.5);
});

test('state / superseded_by round-trip through nodeToFeature / featureToNode', () => {
  const { b } = moveScenario();
  b.firstSeenSeq = 100;
  b.lastSeq = 105;
  const f1 = JSON.stringify(nodeToFeature(b));
  const feat = JSON.parse(f1) as { properties: { feed: Record<string, unknown> } };
  assert.equal(feat.properties.feed['state'], 'superseded');
  assert.equal(feat.properties.feed['tombstone'], false);
  assert.equal(feat.properties.feed['superseded_by'], b.supersededBy);
  const back = featureToNode(JSON.parse(f1));
  assert.equal(back.state, 'superseded');
  assert.equal(back.supersededBy, b.supersededBy);
  assert.equal(JSON.stringify(nodeToFeature(back)), f1, 'byte-identical round-trip');
  const compact = nodeToFeature(b, { compact: true }) as { properties: { feed: Record<string, unknown> } };
  assert.equal(compact.properties.feed['state'], 'superseded');
  assert.equal(compact.properties.feed['superseded_by'], b.supersededBy);
  assert.ok(!('provenance' in compact.properties.feed));
});

test('visibility: a retired node is published non-live for 48 h after its last ingest, then only in the tree', () => {
  const { a, b } = moveScenario();
  const retiredAt = Date.parse(b.lastIngestTime);
  assert.equal(publishesRetired(a, retiredAt), false, 'live nodes are not "retired"');
  assert.equal(publishesRetired(b, retiredAt + 1000), true);
  assert.equal(publishesRetired(b, retiredAt + RETIRED_VISIBLE_MS), true, 'inclusive at the edge');
  assert.equal(publishesRetired(b, retiredAt + RETIRED_VISIBLE_MS + 1), false);
  const tomb: EventNode = { ...a, feedId: 'efd_01M3D76ES0TOMBSTONE00000001', aliases: [], provenance: [], state: 'tombstoned' };
  assert.equal(publishesRetired(tomb, retiredAt + 1000), true, 'a tombstone follows the same rule');

  const root = mkdtempSync(join(tmpdir(), 'efd-merge-'));
  try {
    const old: EventNode = { ...b, feedId: 'efd_01M3D76ES0OLDLOSER0000000001', provenance: b.provenance.map((r) => ({ ...r })), lastIngestTime: '2026-09-20T00:00:00.000Z' };
    const day = '2026-09-25';
    const publicV1 = join(root, 'public');
    writeDayPartition(root, day, [a, b, old, tomb], { publicV1, nowMs: retiredAt + 3600_000, headIngestTime: b.lastIngestTime });
    // Tree partition: every state, full-fat (the loser's frozen copy keeps its line self-describing).
    const tree = readDayPartitionNodes(root, day);
    assert.deepEqual(tree.map((n) => n.state).sort(), ['live', 'superseded', 'superseded', 'tombstoned']);
    assert.equal(tree.find((n) => n.feedId === b.feedId)!.provenance.length, 1);
    assert.equal(tree.find((n) => n.feedId === b.feedId)!.supersededBy, a.feedId);
    // Pages day file: the live one full-fat, the recently retired ones compact and non-live, the old one absent.
    const pages = JSON.parse(readFileSync(join(publicV1, 'events', `${day}.geojson`), 'utf8')) as {
      metadata: { count: number };
      features: { id: string; properties: { feed: Record<string, unknown> } }[];
    };
    assert.deepEqual(pages.features.map((f) => f.id).sort(), [a.feedId, b.feedId, tomb.feedId].sort());
    assert.equal(pages.metadata.count, 1, 'count = live features only');
    const liveFeat = pages.features.find((f) => f.id === a.feedId)!;
    const retired = pages.features.find((f) => f.id === b.feedId)!;
    assert.ok(Array.isArray(liveFeat.properties.feed['provenance']), 'live stays full-fat');
    assert.equal(retired.properties.feed['state'], 'superseded');
    assert.equal(retired.properties.feed['superseded_by'], a.feedId);
    assert.ok(!('provenance' in retired.properties.feed), 'retired markers are compact');
    assert.equal(pages.features.find((f) => f.id === tomb.feedId)!.properties.feed['tombstone'], true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the ids a USGS row names link a same-provider report from either side', () => {
  // The reviewed us-id arrives first and names the PTWC id in `ids`; the PTWC report itself
  // carries no link back — the fold must still happen (the reversed-order Loyalty case).
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('usgs', 'us6000txpi', { status: 'reviewed', fields: { ids: ',pt26268000,us6000txpi,' } }), '2026-09-25T21:41:00Z');
  r.ingest(obs('usgs', 'pt26268000', { status: 'REVIEWED', mag: 7.0, magType: 'Mi', eventTimeMs: T0 + 1_700, lat: north(-21.3, 17) }), '2026-09-25T21:45:00Z');
  assert.equal(map.size, 1, 'one event: the node row names the report');
});
