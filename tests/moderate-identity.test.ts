import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LARGE_EVENT_MAX_KM,
  MODERATE_EVENT_BASE_KM,
  MODERATE_EVENT_EXCLUDED_PROVIDERS,
  MODERATE_EVENT_KM_PER_MAG,
  MODERATE_EVENT_MAG,
  MODERATE_EVENT_MAX_DELTA,
  MODERATE_EVENT_MAX_DT_MS,
  SWARM_CELL_ABSOLUTE,
} from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// FEED-1: agencies' solutions of one M4–5.5 quake scatter by 15–40 km, and below M5.5 the identity windows stopped at
// 10 km, so on 2026-10-02 42 of the 58 live M ≥ 4.5 events had another live event within 60 s and 50 km. The
// moderate-event window (config MODERATE_EVENT_*) joins such pairs. The fixture holds the real log lines of three
// quakes production split: South of Fiji M5.0 (2026-10-02 04:27, three events: GEOFON / EMSC + USGS / GeoNet),
// Solomon Islands M5.1 (04:44, two: GEOFON / EMSC + USGS) and South Sandwich Islands M6.0 (2026-08-12 11:47, two:
// RéNaSS + RESIF beside the others).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const NOW = Date.parse('2026-10-02T06:00:00Z');
const KM_PER_DEG = 111.195;
const north = (lat: number, km: number): number => lat + km / KM_PER_DEG;
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const keysOf = (n: EventNode): string => [...new Set(n.provenance.map((r) => `${r.provider}:${r.nativeId}`))].sort().join(' ');

const LINES: Observation[] = readFileSync(here('fixtures/moderate-identity-2026.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);

function replay(lines: Observation[], nowMs: number): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs);
  for (const o of lines) {
    const raw = observationToRaw(o);
    if (o.op === 'tombstone') r.tombstoneProvider(raw, o.ingest_time);
    else r.ingest(raw, o.ingest_time);
  }
  return map;
}

const T0 = Date.parse('2026-10-02T04:27:05Z');
function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: 'automatic',
    lat: -24.8,
    lon: 178.8,
    depth: 10,
    mag: 4.8,
    magType: 'mb',
    place: 'south of the Fiji Islands',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}
/** How many live events two reports make, the second `km` north of the first. */
function pair(a: Partial<RawObs>, b: Partial<RawObs>, km: number, setup?: (r: Resolver) => void): number {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  setup?.(r);
  const base = live(map).length;
  r.ingest(obs('usgs', 'us6000aaaa', a), '2026-10-02T04:35:00Z');
  r.ingest(obs('geofon', 'gfz2026aaaa', { lat: north(-24.8, km), ...b }), '2026-10-02T04:36:00Z');
  return live(map).length - base;
}

test('config: M ≥ 4.0, 20 km at M4.0 + 20 km per magnitude unit up to the 50 km cap, 20 s, |ΔM| ≤ 0.5, NRCan out', () => {
  assert.equal(MODERATE_EVENT_MAG, 4.0);
  assert.equal(MODERATE_EVENT_BASE_KM, 20);
  assert.equal(MODERATE_EVENT_KM_PER_MAG, 20);
  assert.equal(LARGE_EVENT_MAX_KM, 50);
  assert.equal(MODERATE_EVENT_MAX_DT_MS, 20_000);
  assert.equal(MODERATE_EVENT_MAX_DELTA, 0.5);
  assert.deepEqual([...MODERATE_EVENT_EXCLUDED_PROVIDERS], ['nrcan']);
});

test('the three quakes production split are one event each', () => {
  const fiji = LINES.filter((o) => o.event_time.startsWith('2026-10-02T04:2'));
  const solomon = LINES.filter((o) => o.event_time.startsWith('2026-10-02T04:4'));
  const sandwich = LINES.filter((o) => o.event_time.startsWith('2026-08-12'));
  assert.equal(fiji.length + solomon.length + sandwich.length, LINES.length);

  const f = live(replay(fiji, NOW));
  assert.equal(f.length, 1, 'South of Fiji: GEOFON 20 km and GeoNet (M5.2) 40 km from EMSC + USGS');
  assert.equal(keysOf(f[0]!), 'emsc:20261002_0000037 geofon:gfz2026tgyq geonet:2026p741044 usgs:us6000tyzi');

  const s = live(replay(solomon, NOW));
  assert.equal(s.length, 1, 'Solomon Islands: GEOFON M4.81 16 km and 2.8 s from EMSC + USGS M5.1');
  assert.equal(s[0]!.chosenProvider === 'usgs' || s[0]!.chosenProvider === 'emsc', true);

  const w = live(replay(sandwich, Date.parse('2026-08-12T14:00:00Z')));
  assert.equal(w.length, 1, 'South Sandwich Islands: RéNaSS M5.34 joins, and RESIF’s copy of its solution follows it');
  assert.ok(keysOf(w[0]!).includes('resif:fr2026ujmhpr'));
  assert.equal(w[0]!.mag, 6);
});

test('the window widens with the smaller magnitude and shrinks with ΔM', () => {
  // M4.0: 20 km; M4.5: 30; M5.0: 40; M5.4 / M5.5: 48 / 50 (the large-event window gives only 20 at M5.5).
  assert.equal(pair({ mag: 4.0 }, { mag: 4.0 }, 19), 1);
  assert.equal(pair({ mag: 4.0 }, { mag: 4.0 }, 21), 2);
  assert.equal(pair({ mag: 4.5 }, { mag: 4.5 }, 29), 1);
  assert.equal(pair({ mag: 4.5 }, { mag: 4.5 }, 31), 2);
  assert.equal(pair({ mag: 5.0 }, { mag: 5.0 }, 39), 1);
  assert.equal(pair({ mag: 5.5 }, { mag: 5.5 }, 49), 1);
  assert.equal(pair({ mag: 6.0 }, { mag: 6.0 }, 51), 2, 'nothing beyond the 50 km cap');
  // ΔM 0.5 at M4.5 / M5.0: 30 km × 0.85 = 25.5 km.
  assert.equal(pair({ mag: 5.0 }, { mag: 4.5 }, 25), 1);
  assert.equal(pair({ mag: 5.0 }, { mag: 4.5 }, 26), 2);
});

test('outside the guards the pair stays two events', () => {
  assert.equal(pair({ mag: 4.8 }, { mag: 4.8, eventTimeMs: T0 + 21_000 }, 15), 2, 'origins more than 20 s apart');
  assert.equal(pair({ mag: 4.8 }, { mag: 4.2 }, 15), 2, '|ΔM| 0.6 > 0.5');
  assert.equal(pair({ mag: 4.8 }, { mag: 3.9 }, 6), 1, 'M3.9 inside the base window (10 km × 0.73) still joins');
  assert.equal(pair({ mag: 4.8 }, { mag: 3.9 }, 15), 2, 'below M4.0 only the base window applies');
  // NRCan on either side: its splits with ComCat are left alone (owner decision 2026-10-02).
  const nrcan = (): number => {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, NOW);
    r.ingest(obs('usgs', 'us6000bbbb', { lat: 49, lon: -128 }), '2026-10-02T04:35:00Z');
    r.ingest(obs('nrcan', '20261002.0427001', { lat: north(49, 15), lon: -128 }), '2026-10-02T04:36:00Z');
    return live(map).length;
  };
  assert.equal(nrcan(), 2, 'NRCan never joins through the moderate-event window');
  // One provider's two ids are two events.
  const same = (): number => {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, NOW);
    r.ingest(obs('geofon', 'gfz2026cccc'), '2026-10-02T04:35:00Z');
    r.ingest(obs('geofon', 'gfz2026dddd', { lat: north(-24.8, 15) }), '2026-10-02T04:36:00Z');
    return live(map).length;
  };
  assert.equal(same(), 2, 'one provider under two ids');
  // A dense cell asks for a shared id (-24.7: inside one 0.2° cell, -24.8 is a cell edge).
  const dense = (r: Resolver): void => {
    for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
      r.ingest(obs('emsc', `2026100${i}_0000001`, { eventTimeMs: T0 - (i + 1) * 300_000, mag: 2, lat: -24.7 + ((i % 5) - 2) * 0.001 }), '2026-10-02T04:30:00Z');
    }
  };
  assert.equal(pair({ mag: 4.8, lat: -24.7 }, { mag: 4.8, lat: north(-24.7, 15) }, 15, dense), 2, 'not from a dense cell');
  assert.equal(pair({ mag: 4.8, lat: -24.7 }, { mag: 4.8, lat: north(-24.7, 15) }, 15), 1, 'the same pair outside it joins');
});

test('a report joins through the window only as the event’s own best match (mutual best)', () => {
  // A (USGS) and B (GEOFON) are one quake 12 km apart, left unfolded (the merge pass is off while they are placed);
  // C (BMKG) arrives 24 km from A, farther than B: A's best partner is B, not C, so C does not join A at first
  // sight. The merge pass sorts the three out once a logged revision runs.
  const map = new Map<string, EventNode>();
  const quiet = new Resolver(map, prio, cfg, NOW, { merge: false });
  quiet.ingest(obs('usgs', 'us6000eeee', { mag: 4.8 }), '2026-10-02T04:35:00Z');
  quiet.ingest(obs('geofon', 'gfz2026eeee', { mag: 4.8, lat: north(-24.8, 40) }), '2026-10-02T04:35:00Z');
  const b = live(map).find((n) => n.chosenProvider === 'geofon')!;
  quiet.ingest(obs('geofon', 'gfz2026eeee', { mag: 4.8, lat: north(-24.8, -12) }), '2026-10-02T04:36:00Z');
  assert.equal(live(map).length, 2, 'A and B stand apart (merge pass off)');
  const r = new Resolver(map, prio, cfg, NOW);
  const a = live(map).find((n) => n.chosenProvider === 'usgs')!;
  assert.equal(r.whyNotMerged(a, b), null, 'A and B are mergeable');
  const c = r.ingest(obs('bmkg', 'bmkg:20261002T042705Z', { mag: 4.8, lat: north(-24.8, 24) }), '2026-10-02T04:37:00Z');
  assert.notEqual(c.node.feedId, a.feedId, 'C is not A’s best match');
  // Without B, C joins A.
  const solo = new Map<string, EventNode>();
  const s = new Resolver(solo, prio, cfg, NOW);
  const a2 = s.ingest(obs('usgs', 'us6000eeee', { mag: 4.8 }), '2026-10-02T04:35:00Z').node;
  assert.equal(s.ingest(obs('bmkg', 'bmkg:20261002T042705Z', { mag: 4.8, lat: north(-24.8, 24) }), '2026-10-02T04:37:00Z').node.feedId, a2.feedId);
});

test('the merge pass folds a moderate pair and says so; a pair kept apart names both gates', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  const a = r.ingest(obs('usgs', 'us6000ffff', { mag: 4.8 }), '2026-10-02T04:35:00Z').node;
  // B starts 60 km away (beyond every window), then its revision moves it to 25 km: a moderate fold (M4.7:
  // 34 km × 0.97).
  r.ingest(obs('geofon', 'gfz2026ffff', { mag: 4.7, lat: north(-24.8, 60) }), '2026-10-02T04:35:00Z');
  const res = r.ingest(obs('geofon', 'gfz2026ffff', { mag: 4.7, lat: north(-24.8, 25) }), '2026-10-02T04:40:00Z');
  assert.equal(res.merges.length, 1);
  assert.equal(res.node.feedId, a.feedId);
  assert.match(res.merges[0]!.reason, /^proximity: d=25\.0 km dt=0\.0 s dM=0\.10 moderate window=33\.0 km\/20 s$/);
  // A rejected pair names both the base gate and the moderate one.
  const m2 = new Map<string, EventNode>();
  const r2 = new Resolver(m2, prio, cfg, NOW);
  const x = r2.ingest(obs('usgs', 'us6000gggg', { mag: 4.8 }), '2026-10-02T04:35:00Z').node;
  const y = r2.ingest(obs('geofon', 'gfz2026gggg', { mag: 4.8, eventTimeMs: T0 + 25_000, lat: north(-24.8, 15) }), '2026-10-02T04:35:00Z').node;
  assert.match(r2.whyNotMerged(x, y)!, /^d 15\.0 km > 10\.0 km; moderate: dt 25\.0 s > 20\.0 s$/);
});
