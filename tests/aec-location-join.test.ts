import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOCATION_JOIN_DT_MS, LOCATION_JOIN_MAX_DM } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';
import { knownAliasIdsOf } from '../src/util.js';

// PF-5b review: an automatic AEC report joined to another agency's event by location gave that event the alias of
// AEC's id, so ComCat's later event of the same id welded into it (two quakes shown as one), and with a large
// magnitude gap a bigger automatic quake was shown as the smaller reviewed one. A location join with an AEC solution
// now needs origin times within LOCATION_JOIN_DT_MS and |ΔM| ≤ LOCATION_JOIN_MAX_DM, and a ComCat event that finds
// an event only through an AEC row while that event's ComCat row is another quake by ComCat's own ids stays apart.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const NOW = Date.parse('2026-09-30T18:40:00Z');
const INGEST = new Date(NOW).toISOString();
const T0 = NOW - 2 * 3_600_000;
const LAT = 53.0106;
const LON = -175.2871;
const KM_PER_DEG = 111.195;
const north = (km: number): number => LAT + km / KM_PER_DEG;

function aec(id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider: 'aec', providerEventId: id, eventTimeMs: T0, providerUpdatedMs: null, status: 'automatic',
    lat: LAT, lon: LON, depth: 5, mag: 4.5, magType: 'ML', place: 'x', knownAliasIds: knownAliasIdsOf('aec', id, {}),
    fields: { event_name: id, version: 1 }, ...over,
  };
}
function usgs(id: string, ids: string[] = [id], over: Partial<RawObs> = {}): RawObs {
  const fields = { ids: `,${ids.join(',')},` };
  return {
    provider: 'usgs', providerEventId: id, eventTimeMs: T0, providerUpdatedMs: T0 + 600_000, status: 'reviewed',
    lat: LAT, lon: LON, depth: 3, mag: 1.0, magType: 'ml', place: 'y', knownAliasIds: knownAliasIdsOf('usgs', id, fields),
    fields, ...over,
  };
}
const live = (m: Map<string, EventNode>): EventNode[] => [...m.values()].filter((n) => n.state === 'live');
const shown = (m: Map<string, EventNode>): string[] =>
  live(m)
    .map((n) => `${n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ')} M${n.mag}`)
    .sort();

test('location join: the limits are the measured gap between same-quake AEC joins and the pairs ComCat keeps apart', () => {
  assert.equal(LOCATION_JOIN_DT_MS, 8_000, 'same-quake joins ≤ 3.4 s, ComCat-distinct ak / av pairs ≥ 13 s');
  assert.equal(LOCATION_JOIN_MAX_DM, 1.5, 'same-quake location joins |ΔM| ≤ 1.25');
});

test('weld probe: AEC first, 15 s / 1 km from AVO’s reviewed M1.0, then ComCat publishes the AEC id apart — two events', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(usgs('av90000001', undefined, { mag: 1.0, eventTimeMs: T0 + 15_000 }), INGEST);
  const first = r.ingest(aec('aka2026zzzzzz', { mag: 1.9, lat: north(1) }), INGEST);
  assert.ok(first.withheld, 'not joined by location; withheld beside a same-size event, as an unmatched AEC report');
  assert.deepEqual(shown(map), ['usgs:av90000001 M1'], 'the AVO event carries no AEC row and no alias of its id');
  r.ingest(usgs('aka2026zzzzzz', undefined, { mag: 1.8, status: 'automatic', lat: north(1) }), INGEST);
  r.ingest(aec('aka2026zzzzzz', { mag: 1.9, lat: north(1) }), INGEST);
  assert.deepEqual(shown(map), ['aec:aka2026zzzzzz usgs:aka2026zzzzzz M1.8', 'usgs:av90000001 M1'], 'ComCat has two quakes; so has the feed');
  // Before AEC the same two ComCat events stayed apart by the same-provider rule.
  const m2 = new Map<string, EventNode>();
  const r2 = new Resolver(m2, prio, cfg, NOW);
  r2.ingest(usgs('av90000001', undefined, { mag: 1.0, eventTimeMs: T0 + 15_000 }), INGEST);
  r2.ingest(usgs('aka2026zzzzzz', undefined, { mag: 1.8, status: 'automatic', lat: north(1) }), INGEST);
  assert.equal(live(m2).length, 2);
});

test('masking probe: an automatic AEC M4.5 20 s / 2 km from AVO’s reviewed M1.5 is shown as M4.5, not hidden', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(usgs('av90000002', undefined, { mag: 1.5, eventTimeMs: T0 + 20_000 }), INGEST);
  const res = r.ingest(aec('aka2026yyyyyy', { mag: 4.5, lat: north(2) }), INGEST);
  assert.equal(res.withheld, undefined, 'ΔM 3: not the same quake, so not withheld either');
  assert.deepEqual(shown(map), ['aec:aka2026yyyyyy M4.5', 'usgs:av90000002 M1.5']);
  // ComCat's later event of the AEC id joins the AEC event by id, not the AVO one.
  r.ingest(usgs('aka2026yyyyyy', undefined, { mag: 4.4, status: 'automatic', lat: north(2) }), INGEST);
  assert.deepEqual(shown(map), ['aec:aka2026yyyyyy usgs:aka2026yyyyyy M4.4', 'usgs:av90000002 M1.5']);
});

test('masking inside the time limit: 3 s / 2 km but ΔM 3 is no location join either', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(usgs('av90000003', undefined, { mag: 1.5, eventTimeMs: T0 + 3_000 }), INGEST);
  r.ingest(aec('aka2026xxxxxx', { mag: 4.5, lat: north(2) }), INGEST);
  assert.equal(live(map).length, 2);
});

test('same-quake joins still join: aka2026tcukyg (0.26 s, 1.4 km, ΔM 1.17) and aka2026tilooe (0.41 s, 2.4 km, ΔM 1.25)', () => {
  for (const [id, av, dt, km, mAec, mAv] of [
    ['aka2026tcukyg', 'av94450521', 259, 1.37, 1.9, 0.73],
    ['aka2026tilooe', 'av94455051', 409, 2.37, 1.6, 0.35],
  ] as const) {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, NOW);
    r.ingest(usgs(av, undefined, { mag: mAv, eventTimeMs: T0 + dt }), INGEST);
    r.ingest(aec(id, { mag: mAec, lat: north(km) }), INGEST);
    assert.deepEqual(shown(map), [`aec:${id} usgs:${av} M${mAv}`], id);
  }
});

test('reverse order: an AEC-only event, then ComCat’s AVO event 15 s later and the AEC id — two events', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(aec('aka2026wwwwww', { mag: 1.9 }), INGEST);
  r.ingest(usgs('av90000004', undefined, { mag: 1.0, eventTimeMs: T0 + 15_000, lat: north(1) }), INGEST);
  assert.equal(live(map).length, 2, "ComCat's AVO event does not join the AEC one by location");
  r.ingest(usgs('aka2026wwwwww', undefined, { mag: 1.8, status: 'automatic' }), INGEST);
  assert.deepEqual(shown(map), ['aec:aka2026wwwwww usgs:aka2026wwwwww M1.8', 'usgs:av90000004 M1']);
});

test('merge pass: an AEC-only event and AVO’s event 15 s apart never fold on a later revision', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  // Minted 40 km apart, then AVO's revision moves its event 1 km from AEC's.
  r.ingest(aec('aka2026vvvvvv', { mag: 1.9 }), INGEST);
  r.ingest(usgs('av90000005', undefined, { mag: 1.0, eventTimeMs: T0 + 15_000, lat: north(40) }), INGEST);
  const rev = r.ingest(usgs('av90000005', undefined, { mag: 1.1, eventTimeMs: T0 + 15_000, lat: north(1), providerUpdatedMs: T0 + 900_000 }), INGEST);
  assert.deepEqual(rev.merges, []);
  assert.equal(live(map).length, 2);
  const [a, b] = live(map);
  assert.match(r.whyNotMerged(a!, b!)!, /^AEC solution beyond ±8 s or \|dM\| 1\.5 of a location join$/);
});

test('ComCat’s own ids outrank an AEC location join: AEC 3 s from AVO joins it, ComCat publishing the AEC id apart does not weld', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(usgs('av90000006', undefined, { mag: 1.0, eventTimeMs: T0 + 3_000 }), INGEST);
  r.ingest(aec('aka2026uuuuuu', { mag: 1.4, lat: north(1) }), INGEST);
  assert.deepEqual(shown(map), ['aec:aka2026uuuuuu usgs:av90000006 M1'], 'inside the limits: one event');
  r.ingest(usgs('aka2026uuuuuu', undefined, { mag: 1.3, status: 'automatic', lat: north(1) }), INGEST);
  assert.deepEqual(shown(map), ['aec:aka2026uuuuuu usgs:av90000006 M1', 'usgs:aka2026uuuuuu M1.3'], 'ComCat has two; the AVO event keeps one ComCat id');
  // Across runs too.
  const next = new Resolver(map, prio, cfg, NOW + 300_000);
  next.ingest(usgs('aka2026uuuuuu', undefined, { mag: 1.4, status: 'automatic', lat: north(1), providerUpdatedMs: T0 + 900_000 }), INGEST);
  assert.equal(live(map).length, 2);
  // ComCat associating the two ids later (a revision of its preferred event) makes them one event again.
  next.ingest(usgs('av90000006', ['av90000006', 'aka2026uuuuuu'], { mag: 1.1, eventTimeMs: T0 + 3_000, providerUpdatedMs: T0 + 1_200_000 }), INGEST);
  assert.equal(live(map).length, 1);
});

// Review of the fix: the limits hold only while the AEC row stands without ComCat's row of its id. Once ComCat's row is
// in the same event, that event joins other agencies' reports by the usual rules, as before AEC was a source.
function agency(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider, providerEventId: id, eventTimeMs: T0, providerUpdatedMs: null, status: null,
    lat: LAT, lon: LON, depth: 10, mag: 4.5, magType: 'mb', place: 'z', knownAliasIds: [], fields: {}, ...over,
  };
}

test('ComCat-confirmed AEC event: another agency’s report 12 s off joins it (GEOFON’s us7000tgk1 was 15.6 s from ComCat’s)', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(aec('aka2026tttttt', { mag: 4.4 }), INGEST);
  r.ingest(usgs('aka2026tttttt', undefined, { mag: 4.5, eventTimeMs: T0 + 1_000 }), INGEST);
  r.ingest(agency('geofon', 'gfz2026zzzz', { eventTimeMs: T0 + 13_000, lat: north(8), mag: 4.41 }), INGEST);
  assert.deepEqual(shown(map), ['aec:aka2026tttttt geofon:gfz2026zzzz usgs:aka2026tttttt M4.5']);
});

test('ComCat-confirmed AEC event: a split made while AEC stood alone folds once ComCat’s row of the id arrives', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(aec('aka2026ssssss', { mag: 4.4 }), INGEST);
  r.ingest(agency('geofon', 'gfz2026yyyy', { eventTimeMs: T0 + 12_000, lat: north(5), mag: 4.5 }), INGEST);
  assert.equal(live(map).length, 2, 'AEC alone: 12 s is outside the location-join limit');
  const res = r.ingest(usgs('aka2026ssssss', undefined, { mag: 4.5, eventTimeMs: T0 + 1_000 }), INGEST);
  assert.equal(res.merges.length, 1);
  assert.deepEqual(shown(map), ['aec:aka2026ssssss geofon:gfz2026yyyy usgs:aka2026ssssss M4.5']);
});

test('ComCat-confirmed AEC event: an automatic magnitude far below the final one does not split a great quake', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(aec('aka2026rrrrrr', { mag: 6.2 }), INGEST);
  r.ingest(usgs('us7000zzzz', ['us7000zzzz', 'aka2026rrrrrr'], { mag: 7.9, magType: 'mww', eventTimeMs: T0 + 2_000, lat: north(15) }), INGEST);
  r.ingest(agency('emsc', '20260930_0000999', { mag: 7.8, magType: 'mw', eventTimeMs: T0 + 3_000, lat: north(20) }), INGEST);
  assert.deepEqual(shown(map), ['aec:aka2026rrrrrr emsc:20260930_0000999 usgs:us7000zzzz M7.9']);
});
