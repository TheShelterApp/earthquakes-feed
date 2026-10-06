import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MODERATE_EVENT_MAG,
  MODERATE_EVENT_MAX_DELTA,
  MODERATE_EVENT_MAX_DT_MS,
  REGIONAL_WINDOWS,
  SWARM_CELL_ABSOLUTE,
  TMD_PROVIDER,
  TMD_WINDOW_KM,
  USP_PROVIDER,
  USP_WINDOW_KM,
  USP_WINDOW_PARTNERS,
} from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// Round 21: USP (Centro de Sismologia, Universidade de São Paulo) locates the world's moderate quakes from Brazil, 26 km
// from ComCat's solution at the median and beyond the moderate-event window's 20–40 km at M4.0–5.0 in about a third of
// them, with origin times and magnitudes close to the other agencies'. Its SeisComP ids share GEOFON's time-slot suffix
// (usp2026toln / gfz2026toln), which is no identity: the rule reads time, place and magnitude only. The fixture holds the
// real log lines of three quakes production kept as two events, each USP row confirmed by ComCat as the other event's
// quake: Bolivia M4.5 (2026-10-06 06:54, USP 29 km and 1.2 s from ComCat's, the one pair of the hot window when the rule
// was written), the central Mid-Atlantic Ridge M4.9 (2026-08-22 07:21, 42.7 km from EMSC's and ComCat's) and northern
// Chile M4.3 (2026-07-16 02:09, 30 km from ComCat's, CSN's and EMSC's event).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const KM_PER_DEG = 111.195;
const north = (lat: number, km: number): number => lat + km / KM_PER_DEG;
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const providersOf = (n: EventNode): string => [...new Set(n.provenance.map((r) => r.provider))].sort().join('+');

const LINES: Observation[] = readFileSync(here('fixtures/usp-window-2026.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);

function replay(lines: Observation[], nowMs: number): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs);
  for (const o of lines) r.ingest(observationToRaw(o), o.ingest_time);
  return map;
}

const T0 = Date.parse('2026-10-06T06:54:10.6Z');
const NOW = Date.parse('2026-10-06T12:30:00Z');
const LAT = -20.0;
function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: null,
    lat: LAT,
    lon: -67.42,
    depth: 190,
    mag: 4.5,
    magType: 'mb',
    place: 'Bolivia',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}
/** How many live events a partner's report and a USP report `km` north of it (and `over` on USP's) make, either order.
 *  At M4.5 against USP's M4.3 the moderate-event window is 26 × 0.94 = 24.4 km. */
function pair(km: number, over: Partial<RawObs> = {}, partner = 'usgs', uspFirst = false, prepare?: (r: Resolver) => void): number {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  prepare?.(r);
  const before = live(map).length;
  const a = obs(partner, `${partner}-1`);
  const b = obs(USP_PROVIDER, 'usp2026toln', { lat: north(LAT, km), mag: 4.3, eventTimeMs: T0 + 1_200, ...over });
  for (const o of uspFirst ? [b, a] : [a, b]) r.ingest(o, '2026-10-06T12:00:00Z');
  return live(map).length - before;
}

test('config: USP only against USGS, EMSC or GFZ, 50 km, inside the moderate-event guards; TMD unchanged', () => {
  assert.equal(USP_PROVIDER, 'usp');
  assert.deepEqual([...USP_WINDOW_PARTNERS].sort(), ['emsc', 'geofon', 'usgs']);
  assert.equal(USP_WINDOW_KM, 50);
  assert.deepEqual([...REGIONAL_WINDOWS.keys()].sort(), [TMD_PROVIDER, USP_PROVIDER].sort());
  assert.equal(REGIONAL_WINDOWS.get(TMD_PROVIDER)!.km, TMD_WINDOW_KM);
  assert.equal(MODERATE_EVENT_MAG, 4.0);
  assert.equal(MODERATE_EVENT_MAX_DT_MS, 20_000);
  assert.equal(MODERATE_EVENT_MAX_DELTA, 0.5);
});

test('the three quakes production split are one event each, the USP row with the others', () => {
  // Each quake replayed as the runs that logged it saw it (their hot window).
  const quake = (day: string): Observation[] => LINES.filter((o) => o.event_time.startsWith(day));
  for (const [day, providers] of [
    ['2026-10-06', 'emsc+geofon+usgs+usp'],
    ['2026-08-22', 'emsc+geofon+usgs+usp'],
    ['2026-07-16', 'csn+emsc+geofon+usgs+usp'],
  ] as const) {
    const lines = quake(day);
    const events = live(replay(lines, Date.parse(lines.at(-1)!.ingest_time)));
    assert.equal(events.length, 1, `${day}: one event`);
    assert.equal(providersOf(events[0]!), providers, day);
    assert.notEqual(events[0]!.chosenProvider, USP_PROVIDER, `${day}: the partner's solution represents the event`);
  }
});

test('USP joins inside 50 km whatever the order; beyond it the pair stays apart', () => {
  for (const uspFirst of [false, true]) {
    assert.equal(pair(29, {}, 'usgs', uspFirst), 1, `29 km, uspFirst=${uspFirst}`);
    assert.equal(pair(49, {}, 'usgs', uspFirst), 1, `49 km, uspFirst=${uspFirst}`);
    assert.equal(pair(51, {}, 'usgs', uspFirst), 2, `51 km, uspFirst=${uspFirst}`);
  }
  for (const partner of ['emsc', 'geofon']) assert.equal(pair(45, {}, partner), 1, partner);
});

test('outside the moderate-event guards, or against another agency, the pair stays two events', () => {
  assert.equal(pair(34, { eventTimeMs: T0 + 21_000 }), 2, 'dt 21 s');
  assert.equal(pair(34, { mag: 3.9 }), 2, 'USP below M4.0');
  assert.equal(pair(34, { mag: 5.1 }), 2, '|ΔM| 0.6');
  assert.equal(pair(34, {}, 'csn'), 2, 'CSN is not a USP partner (its own moderate window: 24.4 km)');
  assert.equal(pair(34, {}, 'inpres'), 2, 'INPRES is not a USP partner');
  assert.equal(pair(20, {}, 'csn'), 1, 'inside the moderate-event window CSN joins as before');
});

test('the suffix is no identity: GEOFON’s row of the same suffix 60 km away stays apart, another suffix 30 km away joins', () => {
  const run = (gfzId: string, km: number): number => {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, NOW);
    r.ingest(obs('geofon', gfzId), '2026-10-06T12:00:00Z');
    r.ingest(obs(USP_PROVIDER, 'usp2026toln', { lat: north(LAT, km), mag: 4.3, eventTimeMs: T0 + 1_200 }), '2026-10-06T12:00:00Z');
    return live(map).length;
  };
  assert.equal(run('gfz2026toln', 60), 2, 'same suffix, 60 km');
  assert.equal(run('gfz2026tolm', 30), 1, 'another suffix, 30 km');
});

test('a USP row that already shares its event with another agency gets the usual windows', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  // USP and CSN one event (2 km apart), then ComCat 34 km south: USP's window is for a USP-only event.
  r.ingest(obs(USP_PROVIDER, 'usp2026toln', { lat: north(LAT, 34), mag: 4.3, eventTimeMs: T0 + 1_200 }), '2026-10-06T12:00:00Z');
  r.ingest(obs('csn', '378000', { lat: north(LAT, 36), mag: 4.4, eventTimeMs: T0 + 1_000 }), '2026-10-06T12:00:00Z');
  assert.equal(live(map).length, 1);
  r.ingest(obs('usgs', 'us6000tzva'), '2026-10-06T12:05:00Z');
  assert.equal(live(map).length, 2);
});

test('not in a dense cell', () => {
  // 55 small quakes in the partner's 0.2° cell (-20.0 … -19.8; the USP row 34 km north, at -19.69, is in the next one).
  const dense = (r: Resolver): void => {
    for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
      r.ingest(obs('emsc', `2026100${i}_0000001`, { eventTimeMs: T0 - (i + 1) * 300_000, mag: 2, lat: LAT + 0.05 + ((i % 5) - 2) * 0.001 }), '2026-10-06T11:00:00Z');
    }
  };
  assert.equal(pair(34, {}, 'usgs', false, dense), 2, 'the partner in a dense cell');
  assert.equal(pair(34, {}, 'usgs', false), 1, 'the same pair outside it joins');
});

test('the merge pass folds a USP event into the partner event and says so (mutual best)', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('usgs', 'us6000tzva'), '2026-10-06T12:00:00Z');
  // A second partner event 80 km further north: USP lies between the two, nearer the first.
  r.ingest(obs('geofon', 'gfz2026tolq', { lat: north(LAT, 80), eventTimeMs: T0 + 2_000 }), '2026-10-06T12:00:00Z');
  const res = r.ingest(obs(USP_PROVIDER, 'usp2026toln', { lat: north(LAT, 34), mag: 4.3, eventTimeMs: T0 + 1_200 }), '2026-10-06T12:01:00Z');
  assert.equal(live(map).length, 2);
  assert.equal(providersOf(res.node), 'usgs+usp', 'the best-scored partner takes it');
  // Heal path: a USP event minted beside the partner event before this rule (production's state) folds on the next run's
  // merge pass with the USP window reason. The two events are minted on separate maps, then loaded together.
  const map2 = new Map<string, EventNode>();
  new Resolver(map2, prio, cfg, NOW).ingest(obs(USP_PROVIDER, 'usp2026toln', { lat: north(LAT, 29), mag: 4.23, eventTimeMs: T0 + 1_200 }), '2026-10-06T12:00:00Z');
  const other = new Map<string, EventNode>();
  new Resolver(other, prio, cfg, NOW).ingest(obs('usgs', 'us6000tzva'), '2026-10-06T12:00:00Z');
  for (const [k, n] of other) map2.set(k, n);
  assert.equal(live(map2).length, 2);
  const healer = new Resolver(map2, prio, cfg, NOW);
  const { merges } = healer.heal('2026-10-06T12:10:00Z');
  assert.equal(merges.length, 1);
  assert.match(merges[0]!.reason, /USP window=50\.0 km\/20 s/);
  assert.equal(live(map2).length, 1);
  assert.equal(healer.heal('2026-10-06T12:15:00Z').merges.length, 0, 'the next run folds nothing');
});

test('a pair the windows keep apart names the moderate-event gate at USP’s distance', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('usgs', 'us6000tzva'), '2026-10-06T12:00:00Z');
  r.ingest(obs(USP_PROVIDER, 'usp2026toln', { lat: north(LAT, 55), mag: 4.3, eventTimeMs: T0 + 1_200 }), '2026-10-06T12:00:00Z');
  const [a, b] = live(map);
  assert.match(r.whyNotMerged(a!, b!) ?? '', /moderate: d 55\.0 km > 50\.0 km/);
});
