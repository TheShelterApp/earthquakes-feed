import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODERATE_EVENT_MAG, MODERATE_EVENT_MAX_DELTA, MODERATE_EVENT_MAX_DT_MS, TMD_PROVIDER, TMD_WINDOW_KM, TMD_WINDOW_PARTNERS } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// Round 14: TMD (Thai Meteorological Department) locates the region's moderate quakes 20–50 km from USGS, EMSC and GFZ,
// beyond the moderate-event window at M4.0–4.5, so its report stood beside their event. The fixture holds the real log
// lines of two quakes production kept apart: Vietnam M4.4 (2026-09-30 11:24, TMD's M4.7 34 km and 3.4 s from ComCat's)
// and Myanmar M4.8 (2026-08-05 00:11, TMD 45.6 km and 5.2 s from ComCat's).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const KM_PER_DEG = 111.195;
const north = (lat: number, km: number): number => lat + km / KM_PER_DEG;
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const providersOf = (n: EventNode): string => [...new Set(n.provenance.map((r) => r.provider))].sort().join('+');

const LINES: Observation[] = readFileSync(here('fixtures/tmd-window-2026.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);

function replay(lines: Observation[], nowMs: number): { map: Map<string, EventNode>; r: Resolver } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs);
  for (const o of lines) r.ingest(observationToRaw(o), o.ingest_time);
  return { map, r };
}

const T0 = Date.parse('2026-09-30T11:24:41Z');
const NOW = Date.parse('2026-09-30T12:30:00Z');
function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: null,
    lat: 15.0,
    lon: 108.2,
    depth: 10,
    mag: 4.4,
    magType: 'mb',
    place: 'Vietnam',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}
/** How many live events a USGS report and a TMD report `km` north of it (and `over` on TMD's) make, either order. */
function pair(km: number, over: Partial<RawObs> = {}, partner = 'usgs', tmdFirst = false): number {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  const a = obs(partner, `${partner}-1`);
  const b = obs(TMD_PROVIDER, 't20260930112445', { lat: north(15.0, km), mag: 4.7, eventTimeMs: T0 + 3_400, ...over });
  for (const o of tmdFirst ? [b, a] : [a, b]) r.ingest(o, '2026-09-30T12:00:00Z');
  return live(map).length;
}

test('config: TMD only against USGS, EMSC or GFZ, 50 km, inside the moderate-event guards', () => {
  assert.equal(TMD_PROVIDER, 'tmd');
  assert.deepEqual([...TMD_WINDOW_PARTNERS].sort(), ['emsc', 'geofon', 'usgs']);
  assert.equal(TMD_WINDOW_KM, 50);
  assert.equal(MODERATE_EVENT_MAG, 4.0);
  assert.equal(MODERATE_EVENT_MAX_DT_MS, 20_000);
  assert.equal(MODERATE_EVENT_MAX_DELTA, 0.5);
});

test('the two quakes production split are one event each, the TMD row with ComCat’s', () => {
  // Each quake replayed as the runs that logged it saw it (their hot window).
  const quake = (day: string): Observation[] => LINES.filter((o) => o.event_time.startsWith(day));
  const vietnamLines = quake('2026-09-30');
  const { map } = replay(vietnamLines, Date.parse(vietnamLines.at(-1)!.ingest_time));
  const vietnam = live(map);
  assert.equal(vietnam.length, 1, 'Vietnam M4.4: one event');
  assert.equal(providersOf(vietnam[0]!), 'emsc+geofon+tmd+usgs');
  const myanmarLines = quake('2026-08-05');
  const m = replay(myanmarLines, Date.parse(myanmarLines.at(-1)!.ingest_time));
  const myanmar = live(m.map);
  assert.equal(myanmar.length, 1, 'Myanmar M4.8: one event');
  assert.equal(providersOf(myanmar[0]!), 'emsc+geofon+tmd+usgs');
});

test('TMD joins inside 50 km whatever the order; beyond it the pair stays apart', () => {
  for (const tmdFirst of [false, true]) {
    assert.equal(pair(34, {}, 'usgs', tmdFirst), 1, `34 km, tmdFirst=${tmdFirst}`);
    assert.equal(pair(49, {}, 'usgs', tmdFirst), 1, `49 km, tmdFirst=${tmdFirst}`);
    assert.equal(pair(51, {}, 'usgs', tmdFirst), 2, `51 km, tmdFirst=${tmdFirst}`);
  }
  for (const partner of ['emsc', 'geofon']) assert.equal(pair(45, {}, partner), 1, partner);
});

test('outside the moderate-event guards, or against another agency, the pair stays two events', () => {
  assert.equal(pair(34, { eventTimeMs: T0 + 21_000 }), 2, 'dt 21 s');
  assert.equal(pair(34, { mag: 5.0 }), 2, '|ΔM| 0.6');
  assert.equal(pair(34, { mag: 3.9 }), 2, 'TMD below M4.0');
  assert.equal(pair(34, {}, 'ncs'), 2, 'NCS is not a TMD partner (its own moderate window: 28 km at M4.4)');
  assert.equal(pair(34, {}, 'bmkg'), 2, 'BMKG is not a TMD partner');
});

test('a TMD row that already shares its event with another agency gets the usual windows', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  // TMD and NCS one event (2 km apart), then ComCat 34 km south: TMD's window is for a TMD-only event.
  r.ingest(obs(TMD_PROVIDER, 't1', { lat: north(15.0, 34), mag: 4.7, eventTimeMs: T0 + 3_400 }), '2026-09-30T12:00:00Z');
  r.ingest(obs('ncs', 'n1', { lat: north(15.0, 36), mag: 4.6, eventTimeMs: T0 + 3_000 }), '2026-09-30T12:00:00Z');
  assert.equal(live(map).length, 1);
  r.ingest(obs('usgs', 'u1'), '2026-09-30T12:05:00Z');
  assert.equal(live(map).length, 2);
});

test('the merge pass folds a TMD event into the partner event and says so (mutual best)', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('usgs', 'u1'), '2026-09-30T12:00:00Z');
  // A second partner event 60 km further north: TMD lies between the two, nearer the first.
  r.ingest(obs('geofon', 'g1', { lat: north(15.0, 80), eventTimeMs: T0 + 2_000 }), '2026-09-30T12:00:00Z');
  const res = r.ingest(obs(TMD_PROVIDER, 't1', { lat: north(15.0, 34), mag: 4.7, eventTimeMs: T0 + 3_400 }), '2026-09-30T12:01:00Z');
  const events = live(map);
  assert.equal(events.length, 2);
  assert.equal(providersOf(res.node), 'tmd+usgs', 'the best-scored partner takes it');
  // Heal path: a TMD event minted beside the partner event before this rule (production's state) folds on the next run's
  // merge pass with the TMD window reason. The two events are minted on separate maps, then loaded together.
  const map2 = new Map<string, EventNode>();
  new Resolver(map2, prio, cfg, NOW).ingest(obs(TMD_PROVIDER, 't1', { lat: north(15.0, 34), mag: 4.7, eventTimeMs: T0 + 3_400 }), '2026-09-30T12:00:00Z');
  const other = new Map<string, EventNode>();
  new Resolver(other, prio, cfg, NOW).ingest(obs('usgs', 'u1'), '2026-09-30T12:00:00Z');
  for (const [k, n] of other) map2.set(k, n);
  assert.equal(live(map2).length, 2);
  const { merges } = new Resolver(map2, prio, cfg, NOW).heal('2026-09-30T12:10:00Z');
  assert.equal(merges.length, 1);
  assert.match(merges[0]!.reason, /TMD window=50\.0 km\/20 s/);
  assert.equal(live(map2).length, 1);
});

test('a pair the windows keep apart names the TMD gate', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('usgs', 'u1'), '2026-09-30T12:00:00Z');
  r.ingest(obs(TMD_PROVIDER, 't1', { lat: north(15.0, 55), mag: 4.7, eventTimeMs: T0 + 3_400 }), '2026-09-30T12:00:00Z');
  const [a, b] = live(map);
  assert.match(r.whyNotMerged(a!, b!) ?? '', /moderate: d 55\.0 km > 50\.0 km/);
});
