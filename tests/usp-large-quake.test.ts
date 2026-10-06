import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LARGE_EVENT_MAG,
  LARGE_EVENT_MAX_DELTA,
  MODERATE_EVENT_MAX_DELTA,
  REGIONAL_WINDOWS,
  SWARM_CELL_ABSOLUTE,
  TMD_PROVIDER,
  USP_LOW_MAG_FROM,
  USP_LOW_MAG_MAX_DELTA,
  USP_PROVIDER,
} from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// Round 22 (R21-OWNER (3)): USP's magnitudes of large quakes are body-wave magnitudes (mb, mB, Mw(mB)) that run low
// against ComCat's moment magnitude: in the 55 deep-history months of 2019-01..2023-07, USP was more than 0.5 below
// ComCat in 26 % of the quakes of ComCat M5.5-6.0 and 29 % of M6.0-6.5 (2 % and 6 % at M4.5-5.0 and M5.0-5.5), and more
// than 1.0 below in 1.5 % from M5.5 on; above it by more than 0.5 in 2 of 1,577. So in USP's regional window, against a
// partner of M >= 5.5 whose magnitude is above USP's, |ΔM| may reach 1.0. The fixture holds the real log lines of the two
// quakes the whole-log replay leaves apart only by |ΔM|, each one quake by ComCat: Papua New Guinea M6.4 (2026-07-13
// 08:53, USP Mw(mB) 5.88, 25.0 km from the event) and western China M5.7 (2026-07-28 03:16, USP M 4.84, 8.1 km).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const KM_PER_DEG = 111.195;
const north = (lat: number, km: number): number => lat + km / KM_PER_DEG;
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const providersOf = (n: EventNode): string => [...new Set(n.provenance.map((r) => r.provider))].sort().join('+');

const LINES: Observation[] = readFileSync(here('fixtures/usp-large-quakes-2026.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);

const T0 = Date.parse('2026-07-13T08:53:30.3Z');
const NOW = Date.parse('2026-07-13T10:00:00Z');
const AT = '2026-07-13T09:30:00Z';
const LAT = -5.9;
function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: null,
    lat: LAT,
    lon: 147.3,
    depth: 60,
    mag: 6.4,
    magType: 'mww',
    place: 'Papua New Guinea',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}
/** Live events made by a partner's report (M `pm`) and a USP report `km` north of it (M `um`, `over`), either order. */
function pair(km: number, um: number, pm = 6.4, opts: { partner?: string; provider?: string; uspFirst?: boolean; over?: Partial<RawObs>; prepare?: (r: Resolver) => void } = {}): number {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  opts.prepare?.(r);
  const before = live(map).length;
  const partner = opts.partner ?? 'usgs';
  const a = obs(partner, `${partner}-1`, { mag: pm });
  const b = obs(opts.provider ?? USP_PROVIDER, opts.provider === TMD_PROVIDER ? 'tmd-1' : 'usp2026nphr', { lat: north(LAT, km), mag: um, magType: 'mb', eventTimeMs: T0 + 1_200, ...opts.over });
  for (const o of opts.uspFirst ? [b, a] : [a, b]) r.ingest(o, AT);
  return live(map).length - before;
}

test('config: USP alone gets the allowance, from the large-event magnitude, up to the large-event |ΔM|', () => {
  assert.equal(USP_LOW_MAG_FROM, LARGE_EVENT_MAG);
  assert.equal(USP_LOW_MAG_FROM, 5.5);
  assert.equal(USP_LOW_MAG_MAX_DELTA, LARGE_EVENT_MAX_DELTA);
  assert.equal(USP_LOW_MAG_MAX_DELTA, 1.0);
  assert.deepEqual(REGIONAL_WINDOWS.get(USP_PROVIDER)!.lowMag, { fromMag: 5.5, maxDelta: 1.0 });
  for (const [provider, w] of REGIONAL_WINDOWS) if (provider !== USP_PROVIDER) assert.equal(w.lowMag, undefined, provider);
  assert.equal(MODERATE_EVENT_MAX_DELTA, 0.5);
});

test('the two quakes the replay left apart by |ΔM| are one event each, the partner’s solution representing it', () => {
  for (const [uid, providers] of [
    ['usp2026nphr', 'cenc+emsc+ga+geofon+geonet+ingv+renass+resif+usgs+usp'],
    ['usp2026oqhc', 'cenc+emsc+ga+geofon+ingv+ncs+renass+resif+usgs+usp'],
  ] as const) {
    const usp = LINES.find((o) => o.provider_event_id === uid)!;
    const t = Date.parse(usp.event_time);
    const lines = LINES.filter((o) => Math.abs(Date.parse(o.event_time) - t) <= 90_000);
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, Date.parse(lines[0]!.ingest_time));
    for (const o of lines) r.ingest(observationToRaw(o), o.ingest_time);
    r.heal(lines.at(-1)!.ingest_time);
    const holding = live(map).filter((n) => n.provenance.some((p) => p.nativeId === uid));
    assert.equal(holding.length, 1, uid);
    assert.equal(providersOf(holding[0]!), providers, uid);
    assert.notEqual(holding[0]!.chosenProvider, USP_PROVIDER, uid);
  }
});

test('USP lower by up to 1.0 than a partner of M5.5 or more joins inside 50 km, either order and against each partner', () => {
  for (const uspFirst of [false, true]) {
    assert.equal(pair(25, 5.88, 6.4, { uspFirst }), 1, `PNG-like, uspFirst=${uspFirst}`);
    assert.equal(pair(8, 4.84, 5.7, { uspFirst }), 1, `western-China-like, uspFirst=${uspFirst}`);
    assert.equal(pair(30, 5.4, 6.4, { uspFirst }), 1, `|ΔM| 1.0 exactly, uspFirst=${uspFirst}`);
    // 8.3 − 7.3 = 1.0000000000000009 in binary floats: the allowance reads REID_MAG_TOLERANCE like every magnitude limit.
    assert.equal(pair(45, 7.3, 8.3, { uspFirst }), 1, `|ΔM| 1.0 in floats, uspFirst=${uspFirst}`);
    assert.equal(pair(49, 5.5, 6.2, { uspFirst }), 1, `49 km, uspFirst=${uspFirst}`);
  }
  for (const partner of ['emsc', 'geofon']) assert.equal(pair(25, 5.6, 6.4, { partner }), 1, partner);
});

test('outside the allowance the pair stays two events', () => {
  assert.equal(pair(25, 5.3, 6.4), 2, '|ΔM| 1.1');
  assert.equal(pair(25, 4.7, 5.4), 2, 'partner below M5.5 (|ΔM| 0.7)');
  assert.equal(pair(25, 6.4, 5.7, { over: { magType: 'Mw' } }), 2, 'USP above the partner (|ΔM| 0.7)');
  assert.equal(pair(51, 5.6, 6.4), 2, '51 km');
  assert.equal(pair(25, 5.6, 6.4, { over: { eventTimeMs: T0 + 21_000 } }), 2, 'dt 21 s');
  assert.equal(pair(25, 5.6, 6.4, { partner: 'csn' }), 2, 'CSN is not a USP partner');
  assert.equal(pair(25, 5.6, 6.4, { provider: TMD_PROVIDER }), 2, 'TMD has no allowance (its window keeps |ΔM| ≤ 0.5)');
  assert.equal(pair(25, 6.0, 6.4, { provider: TMD_PROVIDER }), 1, 'TMD inside 0.5 joins as before');
});

test('not in a dense cell, and not for a USP row that shares its event with another agency', () => {
  const dense = (r: Resolver): void => {
    for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
      r.ingest(obs('emsc', `2026071${i}_0000001`, { eventTimeMs: T0 - (i + 1) * 300_000, mag: 2, lat: LAT + 0.05 + ((i % 5) - 2) * 0.001 }), '2026-07-13T08:00:00Z');
    }
  };
  assert.equal(pair(25, 5.88, 6.4, { prepare: dense }), 2, 'the partner in a dense cell');
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs(USP_PROVIDER, 'usp2026nphr', { lat: north(LAT, 25), mag: 5.88, magType: 'Mw(mB)', eventTimeMs: T0 + 1_200 }), AT);
  r.ingest(obs('cenc', 'cenc-1', { lat: north(LAT, 26), mag: 5.6, magType: 'Ms', eventTimeMs: T0 + 1_000 }), AT);
  assert.equal(live(map).length, 1, 'USP and CENC one event');
  r.ingest(obs('usgs', 'us7000t0aa'), AT);
  assert.equal(live(map).length, 2, 'that event keeps the usual windows');
});

test('the merge pass folds a USP event beside a large partner and names the allowance', () => {
  const map = new Map<string, EventNode>();
  new Resolver(map, prio, cfg, NOW).ingest(obs(USP_PROVIDER, 'usp2026nphr', { lat: north(LAT, 25), mag: 5.88, magType: 'Mw(mB)', eventTimeMs: T0 + 1_200 }), AT);
  const other = new Map<string, EventNode>();
  new Resolver(other, prio, cfg, NOW).ingest(obs('usgs', 'us7000t0aa'), AT);
  for (const [k, n] of other) map.set(k, n);
  assert.equal(live(map).length, 2);
  const healer = new Resolver(map, prio, cfg, NOW);
  const [a, b] = live(map);
  assert.equal(healer.whyNotMerged(a!, b!), null);
  const { merges } = healer.heal('2026-07-13T09:40:00Z');
  assert.equal(merges.length, 1);
  assert.match(merges[0]!.reason, /dM=0\.52 USP large-quake window=50\.0 km\/20 s/);
  assert.equal(live(map).length, 1);
  assert.equal(providersOf(live(map)[0]!), 'usgs+usp');
  assert.equal(healer.heal('2026-07-13T09:45:00Z').merges.length, 0, 'the next run folds nothing');

  // Outside the allowance the merge pass names the moderate-event gate.
  const map2 = new Map<string, EventNode>();
  new Resolver(map2, prio, cfg, NOW).ingest(obs(USP_PROVIDER, 'usp2026nphr', { lat: north(LAT, 25), mag: 5.3, eventTimeMs: T0 + 1_200 }), AT);
  const other2 = new Map<string, EventNode>();
  new Resolver(other2, prio, cfg, NOW).ingest(obs('usgs', 'us7000t0aa'), AT);
  for (const [k, n] of other2) map2.set(k, n);
  const [c, d] = live(map2);
  assert.match(new Resolver(map2, prio, cfg, NOW).whyNotMerged(c!, d!) ?? '', /moderate: magnitudes/);
});

test('without the merge pass (the backfill and the deep-history build) the allowance is off; the USP window itself is not', () => {
  // The deep build ingests a month with merge: false. A USP event the allowance made mergeable would never be folded
  // there, and as a mutual-best rival it would keep the partner's other reports out of the partner event.
  const run = (um: number, km: number): number => {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, NOW, { hotFloorMs: 0, merge: false });
    r.ingest(obs('usgs', 'us7000t0aa'), AT);
    r.ingest(obs(USP_PROVIDER, 'usp2026nphr', { lat: north(LAT, km), mag: um, magType: 'mb', eventTimeMs: T0 + 1_200 }), AT);
    return live(map).length;
  };
  assert.equal(run(5.88, 25), 2, '|ΔM| 0.52: no allowance without the merge pass');
  assert.equal(run(6.0, 40), 1, '|ΔM| 0.4: the USP window joins as before');
  // The same pair with the merge pass on joins.
  assert.equal(pair(25, 5.88, 6.4), 1);
});
