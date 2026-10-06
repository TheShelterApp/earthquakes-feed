import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CATALOGUE_MIRRORS, SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';
import { catalogueOf, knownAliasIdsOf, mirrorKeys, mirrorsOf } from '../src/util.js';

// Round 17 (config CATALOGUE_MIRRORS): RESIF's FDSN event service serves RéNaSS's catalogue under the same event ids, so
// `resif:<id>` and `renass:<id>` are one report. Production 2026-07-05 → 10-06: 420 ids of the two stood in two live
// events (403 from the feed's first run in Mayotte's and the Antilles' dense cells, 17 since: dense cells, a RESIF row
// beside RéNaSS's other id of a quake, a world event's two rows in two agency events); a replay of the whole log with
// the round-16 rules leaves 6, with these rules 0.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const NOW = Date.parse('2026-10-06T12:00:00Z');
const INGEST = '2026-10-06T11:05:00.000Z';
const T = NOW - 3_600_000;
/** Montagne Pelée, where the swarm guard bites (fr2026uoryci, 2026-09-10). */
const PELEE = { lat: 14.81, lon: -61.17 };

const raw = (provider: string, id: string, over: Partial<RawObs> = {}): RawObs => ({
  provider,
  providerEventId: id,
  eventTimeMs: T,
  providerUpdatedMs: null,
  status: null,
  lat: PELEE.lat,
  lon: PELEE.lon,
  depth: 2,
  mag: 1.1,
  magType: 'MLv',
  place: 'Earthquake of magnitude 1.1, near Fort-de-France (Les Antilles)',
  // As the FDSN parser and the deep-history raw assets give them: no mirror key is stored.
  knownAliasIds: knownAliasIdsOf(provider, id, {}),
  fields: { EventID: id, Author: 'someone', Contributor: 'OVSM' },
  ...over,
});

/** A resolver over `map`, optionally with SWARM_CELL_ABSOLUTE + 5 IPGP events of the last days in the cell (dense). */
function resolver(dense: boolean, map = new Map<string, EventNode>()): { r: Resolver; map: Map<string, EventNode> } {
  const r = new Resolver(map, prio, cfg, NOW);
  if (dense) {
    for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
      r.ingest(raw('ipgp', `ovsm2026bg${String(i).padStart(3, '0')}`, { eventTimeMs: T - (i + 1) * 900_000, lat: PELEE.lat + ((i % 5) - 2) * 0.002, mag: 0.4 }), INGEST);
    }
  }
  return { r, map };
}

const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((p) => `${p.provider}:${p.nativeId}`).sort().join(' ');
const eventsHolding = (map: Map<string, EventNode>, id: string): string[] => live(map).filter((n) => n.provenance.some((p) => p.nativeId === id)).map(rowsOf);

test('mirrors: RESIF is RéNaSS\'s catalogue; the twin key is derived, never stored with the report', () => {
  assert.deepEqual([...CATALOGUE_MIRRORS], [['resif', 'renass']]);
  assert.equal(catalogueOf('resif'), 'renass');
  assert.equal(catalogueOf('renass'), 'renass');
  assert.equal(catalogueOf('ipgp'), 'ipgp');
  assert.deepEqual(mirrorsOf('resif'), ['renass']);
  assert.deepEqual(mirrorsOf('renass'), ['resif']);
  assert.deepEqual(mirrorsOf('usgs'), []);
  assert.deepEqual(mirrorKeys('resif', 'fr2026abc'), ['renass:fr2026abc']);
  assert.deepEqual(mirrorKeys('renass', 'fr2026abc'), ['resif:fr2026abc']);
  assert.deepEqual(mirrorKeys('renass', ''), []);
  // knownAliasIds go into the deep-history raw assets: unchanged for both sources.
  assert.deepEqual(knownAliasIdsOf('resif', 'fr2026abc', {}), []);
  assert.deepEqual(knownAliasIdsOf('renass', 'fr2026abc', {}), []);
});

test('mirrors: in a dense cell the two rows of one id are one event, whichever source comes first', () => {
  for (const order of [['renass', 'resif'], ['resif', 'renass']] as const) {
    const { r, map } = resolver(true);
    const first = r.ingest(raw(order[0], 'fr2026uoryci'), INGEST);
    const second = r.ingest(raw(order[1], 'fr2026uoryci'), INGEST);
    assert.equal(second.node.feedId, first.node.feedId, order.join(' > '));
    assert.deepEqual(eventsHolding(map, 'fr2026uoryci'), ['renass:fr2026uoryci resif:fr2026uoryci'], order.join(' > '));
  }
  // Another catalogue's report of the same quake under its own id still needs a shared id there (the swarm guard).
  const { r, map } = resolver(true);
  r.ingest(raw('renass', 'fr2026uoryci'), INGEST);
  r.ingest(raw('ipgp', 'ovsm2026rsxfll'), INGEST);
  assert.deepEqual(eventsHolding(map, 'fr2026uoryci'), ['renass:fr2026uoryci']);
  assert.deepEqual(eventsHolding(map, 'ovsm2026rsxfll'), ['ipgp:ovsm2026rsxfll']);
});

test('mirrors: identity before proximity — RESIF a revision behind still joins its twin\'s event (Loyalty Islands, fr2026udvldw)', () => {
  // 2026-07-13: RéNaSS's M5.3 joined the event GEOFON's M6.3 leads; RESIF's row of the same id came on its own, beyond
  // the windows (|ΔM| over 1). RESIF often trails RéNaSS by a run (RéNaSS first for 513 ids, RESIF for 96, the same run
  // for 3,217 since 2026-07-05), so its row can carry the solution before RéNaSS's latest revision: the twin-row
  // match (sameSolution) misses it, and only the id ties the two.
  const { r, map } = resolver(false);
  const first = { lat: -22.72, lon: 171.49, mag: 5.3, magType: 'mb', depth: 71.5, place: 'Event of magnitude 5.3, near North Shore (Monde)', eventTimeMs: T + 9_000 };
  const ev = r.ingest(raw('geofon', 'gfz2026npti', { lat: -22.674, lon: 171.613, mag: 5.6, magType: 'Mw', depth: 28, place: 'Southeast of Loyalty Islands' }), INGEST);
  assert.equal(r.ingest(raw('renass', 'fr2026udvldw', first), INGEST).node.feedId, ev.node.feedId);
  // GEOFON's Mw revision makes the event the M6.5 it was; RéNaSS revises its solution 6 km away.
  r.ingest(raw('geofon', 'gfz2026npti', { lat: -22.674, lon: 171.613, mag: 6.5, magType: 'Mw', depth: 28, place: 'Southeast of Loyalty Islands' }), INGEST);
  r.ingest(raw('renass', 'fr2026udvldw', { ...first, lat: -22.77, mag: 5.0, eventTimeMs: T + 8_000 }), INGEST);
  // RESIF still serves RéNaSS's first solution: more than one unit below the event and not RéNaSS's current row.
  assert.equal(r.ingest(raw('resif', 'fr2026udvldw', first), INGEST).node.feedId, ev.node.feedId, 'RESIF follows its twin');
  assert.deepEqual(live(map).map(rowsOf), ['geofon:gfz2026npti renass:fr2026udvldw resif:fr2026udvldw']);
});

test('mirrors: a RESIF report beside RéNaSS\'s OTHER id is another quake there too (fr2026uqkmma, 2026-09-18)', () => {
  // RéNaSS uqkmlz (03:30:13, M0.3) and uqkmma (03:29:58, M0.4, 2.7 km away) near Aosta. RESIF listed only uqkmma; its row
  // joined the event of RéNaSS's uqkmlz, and RéNaSS's own uqkmma then stood alone: one id in two events.
  const { r, map } = resolver(false);
  const aosta = { lat: 45.855, lon: 6.914 };
  r.ingest(raw('renass', 'fr2026uqkmlz', { ...aosta, eventTimeMs: T + 14_559, mag: 0.32, depth: 0 }), INGEST);
  r.ingest(raw('resif', 'fr2026uqkmma', { lat: 45.862, lon: 6.88, mag: 0.44, depth: 2.8 }), INGEST);
  assert.equal(live(map).length, 2, 'RESIF\'s uqkmma is not put beside RéNaSS\'s uqkmlz');
  // Nor folded there by the merge pass: RESIF's row alone against RéNaSS's other id is the same catalogue's two ids.
  const [x, y] = live(map);
  assert.equal(r.whyNotMerged(x!, y!), 'same provider under distinct native ids');
  r.ingest(raw('renass', 'fr2026uqkmma', { lat: 45.862, lon: 6.88, mag: 0.44, depth: 2.8 }), INGEST);
  assert.deepEqual(eventsHolding(map, 'fr2026uqkmma'), ['renass:fr2026uqkmma resif:fr2026uqkmma']);
  assert.deepEqual(eventsHolding(map, 'fr2026uqkmlz'), ['renass:fr2026uqkmlz']);
  // The merge pass keeps them apart for the same reason.
  const [a, b] = live(map);
  assert.equal(r.whyNotMerged(a!, b!), 'same provider under distinct native ids');
});

test('mirrors: RéNaSS listing one quake twice (fr2026uptopb / uptopc, one solution) stays one event with RESIF\'s row', () => {
  const { r, map } = resolver(false);
  const aosta = { lat: 45.8906, lon: 6.9175, mag: 0.656, depth: 4.2 };
  r.ingest(raw('renass', 'fr2026uptopb', aosta), INGEST);
  r.ingest(raw('resif', 'fr2026uptopc', aosta), INGEST);
  r.ingest(raw('renass', 'fr2026uptopc', aosta), INGEST);
  assert.deepEqual(live(map).map(rowsOf), ['renass:fr2026uptopb renass:fr2026uptopc resif:fr2026uptopc']);
});

test('mirrors: the moderate-event window does not put a RESIF report beside RéNaSS\'s other id', () => {
  // Two M5.1 world solutions of RéNaSS 10 s apart (two quakes in its catalogue); RESIF's report of the second, 30 km
  // from the first, is past the base windows and inside the moderate one (50 km, 20 s from M5.0).
  const { r, map } = resolver(false);
  const world = { lat: -8.2, lon: 120.5, mag: 5.1, magType: 'mb', depth: 10, place: 'Event of magnitude 5.1, near Ujungpandang (Monde)' };
  r.ingest(raw('renass', 'fr2026ukxudo', world), INGEST);
  r.ingest(raw('resif', 'fr2026ukxudp', { ...world, lat: -8.47, eventTimeMs: T + 10_000 }), INGEST);
  assert.deepEqual(eventsHolding(map, 'fr2026ukxudp'), ['resif:fr2026ukxudp']);
  assert.deepEqual(eventsHolding(map, 'fr2026ukxudo'), ['renass:fr2026ukxudo']);
});

test('mirrors: the merge pass folds an event holding one source\'s row into the event of its twin, even in a dense cell', () => {
  // The state production left in Mayotte and the Antilles: the two rows of one id in two live events (two separate
  // runs here, so the second resolver never saw the first's node), in a cell the swarm guard calls dense.
  const { r: r1, map } = resolver(true);
  r1.ingest(raw('renass', 'fr2026tvuwsm'), INGEST);
  const other = new Map<string, EventNode>();
  new Resolver(other, prio, cfg, NOW).ingest(raw('resif', 'fr2026tvuwsm'), INGEST);
  const twin = [...other.values()][0]!;
  twin.feedId = 'efd_01KT0Q9Q303W5XCGVG29Y4MPB6';
  map.set(twin.feedId, twin);
  assert.equal(eventsHolding(map, 'fr2026tvuwsm').length, 2, 'split before');
  const r2 = new Resolver(map, prio, cfg, NOW);
  const { merges } = r2.heal(INGEST);
  assert.equal(merges.length, 1);
  assert.deepEqual(eventsHolding(map, 'fr2026tvuwsm'), ['renass:fr2026tvuwsm resif:fr2026tvuwsm']);
  // Nothing else in the dense cell folds: the background events share no id.
  assert.equal(live(map).length, SWARM_CELL_ABSOLUTE + 5 + 1);
});
