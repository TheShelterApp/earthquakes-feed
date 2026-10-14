import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LARGE_EVENT_MAG,
  LARGE_EVENT_MAX_KM,
  NOA_PROVIDER,
  NOA_REGION,
  OVSICORI_HOLD_FROM_MAG,
  OVSICORI_PROVIDER,
  OVSICORI_REGION,
  OVSICORI_WINDOW,
  REGION_RULES,
  REGIONAL_WINDOWS,
  SWARM_CELL_ABSOLUTE,
  USP_PROVIDER,
} from '../src/config.js';
import { HELD_REASON, Resolver } from '../src/dedup.js';
import { PLACEHOLDER_PLACE, parseFdsnText } from '../src/fdsn.js';
import { runFeedSideSteps } from '../src/heal.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { dayMagRange } from '../src/partitions.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// Round 26 (FIND-1, FIND-3): the 2026-10-09 Panama sequence (ComCat us6000u18k, M7.7, 17:56:06 UTC; its M6.6 aftershock
// us6000u19w at 20:25:39 and M6.1 us6000u1wn on 10-12 at 23:20:36). OVSICORI (Costa Rica) located it from outside its
// network: its reviewed solutions 45–135 km and up to 17 s from ComCat's with magnitudes 0.5–0.7 higher (1450322 M8.2,
// 1450349 M7.1, 1450632 M6.8), its automatic ones hundreds of km off, many with no quake behind them (1450556, M6.7
// automatic, 2026-10-11 21:18:30, at 4.78 N 78.93 W). USP's solution of the M7.7 lay 75 km from it, SCEDC's of the M6.1 was
// ComCat's to the second in a dense aftershock cell, and NOA's automatic teleseismic solutions carried no magnitude. The
// fixture holds every log line of the 45 ids of those quakes and of the phantom (±150 s, 2–12 N, 88–76 W).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const KM_PER_DEG = 111.195;
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const holding = (map: Map<string, EventNode>, key: string): EventNode[] => live(map).filter((n) => n.provenance.some((r) => `${r.provider}:${r.nativeId}` === key));
const LINES: Observation[] = readFileSync(here('fixtures/panama-2026-10.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation)
  .sort((a, b) => a.seq - b.seq);

/** The log replayed as production ran it: one Resolver per aggregate run (ingest_time), every run ending with the
 *  feed-side steps (the regular heal, then the held withdrawal). `seed` runs first in the map (a dense cell). Returns the
 *  map and the lines the feed-side steps logged. */
function replay(seed?: (map: Map<string, EventNode>) => void): { map: Map<string, EventNode>; side: Observation[] } {
  const map = new Map<string, EventNode>();
  seed?.(map);
  const side: Observation[] = [];
  const scratch = mkdtempSync(join(tmpdir(), 'region-rules-'));
  try {
    const runs = [...new Set(LINES.map((o) => o.ingest_time))];
    for (const at of runs) {
      const r = new Resolver(map, prio, cfg, Date.parse(at));
      for (const o of LINES.filter((l) => l.ingest_time === at)) {
        if (o.op === 'tombstone') {
          if (o.reason?.startsWith('re-homed:')) continue;
          r.tombstoneProvider(observationToRaw(o), at);
        } else r.ingest(observationToRaw(o), at);
      }
      const log = new LogBuffer(0, at);
      runFeedSideSteps(scratch, r, log, { healDue: false, loadDays: 10, ingestTime: at });
      side.push(...log.lines);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { map, side };
}

test('config: OVSICORI and NOA regions are the alerts gateway boxes; the window and the holds', () => {
  assert.deepEqual(OVSICORI_REGION, [[8, 11.5, -86, -82.5]]);
  assert.deepEqual(NOA_REGION, [[34, 42, 19, 30]]);
  assert.deepEqual([...REGION_RULES.keys()].sort(), [NOA_PROVIDER, OVSICORI_PROVIDER]);
  assert.equal(REGION_RULES.get(OVSICORI_PROVIDER)!.window, OVSICORI_WINDOW);
  assert.equal(REGION_RULES.get(NOA_PROVIDER)!.window, undefined);
  assert.deepEqual([...OVSICORI_WINDOW.partners].sort(), ['emsc', 'geofon', 'usgs']);
  assert.equal(OVSICORI_WINDOW.minPartnerMag, LARGE_EVENT_MAG);
  assert.equal(OVSICORI_WINDOW.baseKm, LARGE_EVENT_MAX_KM);
  assert.equal(OVSICORI_WINDOW.maxKm, 200);
  assert.equal(OVSICORI_WINDOW.maxDtMs, 30_000);
  assert.equal(OVSICORI_WINDOW.maxDeltaMag, 2.0);
  assert.deepEqual(REGION_RULES.get(OVSICORI_PROVIDER)!.hold, { automaticFromMag: OVSICORI_HOLD_FROM_MAG });
  assert.deepEqual(REGION_RULES.get(NOA_PROVIDER)!.hold, { magless: true });
  assert.deepEqual(REGIONAL_WINDOWS.get(USP_PROVIDER)!.largeKm, { fromMag: 6.0, kmPerMag: 50, maxKm: 100 });
});

test('Panama replay: OVSICORI joins ComCat’s events, USP the M7.7, SCEDC’s twin the M6.1; the phantom and NOA are held', () => {
  const { map, side } = replay();
  const m77 = holding(map, 'usgs:us6000u18k');
  assert.equal(m77.length, 1);
  for (const k of ['ovsicori:1450322', 'usp:usp2026tutw']) assert.deepEqual(holding(map, k), m77, k);
  assert.equal(m77[0]!.chosenProvider, 'usgs');
  assert.equal(m77[0]!.mag, 7.7);
  const m66 = holding(map, 'usgs:us6000u19w');
  assert.equal(m66.length, 1);
  assert.deepEqual(holding(map, 'ovsicori:1450349'), m66);
  assert.equal(m66[0]!.mag, 6.6);
  const m61 = holding(map, 'usgs:us6000u1wn');
  assert.equal(m61.length, 1);
  for (const k of ['ovsicori:1450632', 'scedc:10256694']) assert.deepEqual(holding(map, k), m61, k);
  assert.equal(m61[0]!.mag, 6.1);
  // Held: the 10-11 phantom and NOA's magnitude-less rows, each withdrawn with the reason.
  for (const k of ['ovsicori:1450556', 'noa:noa2026tvbrh', 'noa:noa2026uatzl']) {
    assert.equal(holding(map, k).length, 0, k);
    assert.ok(side.some((l) => l.op === 'tombstone' && `${l.provider}:${l.provider_event_id}` === k && l.reason === HELD_REASON), k);
  }
  // OVSICORI's automatic 1450630 lies inside its region (8.66 N 82.54 W): no rule here touches it.
  assert.equal(holding(map, 'ovsicori:1450630').length, 1);
  assert.equal(holding(map, 'ovsicori:1450630')[0]!.provenance.length, 1);
  // No row in two live events; nothing above M7.7.
  const keys = live(map).flatMap((n) => n.provenance.map((r) => `${r.provider}:${r.nativeId}`));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(Math.max(...live(map).map((n) => n.mag ?? -Infinity)) <= 7.7);
});

test('Panama replay in a dense cell: OVSICORI’s M6.8 and SCEDC’s exact twin still join the M6.1', () => {
  const seed = (map: Map<string, EventNode>): void => {
    const r = new Resolver(map, prio, cfg, Date.parse('2026-10-12T23:00:00Z'));
    for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
      r.ingest(
        {
          provider: 'emsc',
          providerEventId: `20261012_9${String(i).padStart(6, '0')}`,
          eventTimeMs: Date.parse('2026-10-12T12:00:00Z') + i * 300_000,
          providerUpdatedMs: null,
          status: null,
          lat: 7.69 + ((i % 7) - 3) * 0.004,
          lon: -81.49 + ((i % 5) - 2) * 0.004,
          depth: 10,
          mag: 3.0,
          magType: 'mb',
          place: 'PANAMA-COLOMBIA BORDER REGION',
          knownAliasIds: [],
          fields: {},
        },
        '2026-10-12T23:00:00Z',
      );
    }
  };
  const { map } = replay(seed);
  const m61 = holding(map, 'usgs:us6000u1wn');
  assert.equal(m61.length, 1);
  for (const k of ['ovsicori:1450632', 'scedc:10256694']) assert.deepEqual(holding(map, k), m61, k);
});

// --- the out-of-region window, unit by unit ---

const T0 = Date.parse('2026-10-09T17:56:06Z');
const NOW = Date.parse('2026-10-09T20:00:00Z');
const AT = '2026-10-09T19:00:00Z';
const LAT = 7.59;
const LON = -80.77;
function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: 'reviewed',
    lat: LAT,
    lon: LON,
    depth: 20,
    mag: 7.7,
    magType: 'mww',
    place: 'south of Panama',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}
const south = (km: number): number => LAT - km / KM_PER_DEG;
/** Live events made by a partner's report (M `pm`) and an OVSICORI report `km` south of it (M `om`), either order. */
function pair(km: number, om: number, pm = 7.7, opts: { partner?: string; dtS?: number; ovsFirst?: boolean; over?: Partial<RawObs>; partnerOver?: Partial<RawObs>; merge?: boolean; heal?: boolean } = {}): number {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW, opts.merge === false ? { merge: false } : {});
  const partner = opts.partner ?? 'usgs';
  const a = obs(partner, `${partner}-1`, { mag: pm, ...opts.partnerOver });
  const b = obs(OVSICORI_PROVIDER, '1450322', { lat: south(km), mag: om, magType: null, eventTimeMs: T0 - (opts.dtS ?? 17) * 1000, ...opts.over });
  for (const o of opts.ovsFirst ? [b, a] : [a, b]) r.ingest(o, AT);
  if (opts.heal) r.heal(AT);
  return live(map).length;
}

test('OVSICORI outside its region joins a partner of M5.5 or more within the distance the partner’s magnitude sets', () => {
  for (const ovsFirst of [false, true]) {
    const heal = ovsFirst; // a partner minted after OVSICORI's event folds it in the merge pass
    assert.equal(pair(135, 8.2, 7.7, { ovsFirst, heal }), 1, `the M8.2 phantom, ovsFirst=${ovsFirst}`);
    assert.equal(pair(199, 8.2, 7.0, { ovsFirst, heal }), 1, `M7.0 → 200 km, ovsFirst=${ovsFirst}`);
    assert.equal(pair(149, 6.8, 6.5, { ovsFirst, heal }), 1, `M6.5 → 150 km, ovsFirst=${ovsFirst}`);
    assert.equal(pair(49, 7.0, 5.5, { ovsFirst, heal }), 1, `M5.5 → 50 km, ovsFirst=${ovsFirst}`);
    assert.equal(pair(45, 6.8, 6.1, { ovsFirst, heal, dtS: 30 }), 1, `dt 30 s, ovsFirst=${ovsFirst}`);
    assert.equal(pair(100, 4.1, 6.1, { ovsFirst, heal }), 1, `|ΔM| 2.0 below, ovsFirst=${ovsFirst}`);
  }
  for (const partner of ['emsc', 'geofon']) assert.equal(pair(135, 8.2, 7.7, { partner }), 1, partner);
});

test('outside the window, inside the region, beside another agency, or without the merge pass the pair stays two events', () => {
  assert.equal(pair(201, 8.2, 7.7), 2, '201 km at M7.7');
  assert.equal(pair(151, 6.8, 6.5), 2, '151 km at M6.5');
  assert.equal(pair(51, 6.0, 5.5), 2, '51 km at M5.5');
  assert.equal(pair(60, 6.0, 5.4), 2, 'partner below M5.5');
  assert.equal(pair(45, 6.8, 6.1, { dtS: 31 }), 2, 'dt 31 s');
  assert.equal(pair(100, 3.9, 6.1, { over: { status: 'reviewed' } }), 2, '|ΔM| 2.2');
  assert.equal(pair(135, 8.2, 7.7, { partner: 'cenc' }), 2, 'CENC is no partner');
  // Inside OVSICORI's region (8–11.5 N, 86–82.5 W) its own solution stands as before.
  assert.equal(pair(60, 6.6, 6.1, { over: { lat: 9.0, lon: -83.5 }, partnerOver: { lat: 9.4, lon: -83.1 } }), 2, 'inside the region');
  assert.equal(pair(135, 8.2, 7.7, { merge: false }), 2, 'merge pass off (backfill, history)');
  // EMSC's copy of an OVSICORI solution (auth UNA) is not a partner's solution.
  assert.equal(pair(135, 8.2, 7.7, { partner: 'emsc', partnerOver: { fields: { auth: 'UNA' } } }), 2, 'EMSC copy of UNA');
});

test('the window joins in a dense cell, and only the mutual best of two OVSICORI events beside one partner', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
    r.ingest(obs('emsc', `2026100${i}_9`, { eventTimeMs: T0 - (i + 1) * 300_000, mag: 3, status: null, lat: LAT + ((i % 5) - 2) * 0.003, lon: LON + ((i % 3) - 1) * 0.003 }), AT);
  }
  const before = live(map).length;
  r.ingest(obs('usgs', 'us6000u1wn', { mag: 6.1 }), AT);
  r.ingest(obs(OVSICORI_PROVIDER, '1450632', { lat: south(45), mag: 6.8, eventTimeMs: T0 - 7000 }), AT);
  r.ingest(obs(OVSICORI_PROVIDER, '1450633', { lat: south(100), mag: 6.5, status: 'automatic', eventTimeMs: T0 + 20_000 }), AT);
  r.heal(AT);
  const log = new LogBuffer(0, AT);
  const held = r.retractHeld(AT);
  for (const h of held) log.record(h.raw, h.result, 'tombstone', HELD_REASON);
  assert.deepEqual(holding(map, 'ovsicori:1450632'), holding(map, 'usgs:us6000u1wn'));
  // The second OVSICORI id is OVSICORI's other quake by its ids: not in the partner's event, and, automatic outside its
  // region with nothing to join, held.
  assert.equal(holding(map, 'ovsicori:1450633').length, 0);
  assert.deepEqual(held.map((h) => h.raw.providerEventId), ['1450633']);
  assert.equal(live(map).length, before + 1);
});

test('first sight: OVSICORI’s report joins the partner it is the mutual best of, and the fold says which window', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('usgs', 'us6000u18k'), AT);
  const res = r.ingest(obs(OVSICORI_PROVIDER, '1450322', { lat: south(135), mag: 8.2, eventTimeMs: T0 - 17_000 }), AT);
  assert.equal(live(map).length, 1);
  assert.equal(res.node.chosenProvider, 'usgs');
  // Minted apart first (no merge pass at a mint), the heal folds them and names the window.
  const m2 = new Map<string, EventNode>();
  const r2 = new Resolver(m2, prio, cfg, NOW);
  r2.ingest(obs(OVSICORI_PROVIDER, '1450322', { lat: south(135), mag: 8.2, eventTimeMs: T0 - 17_000 }), AT);
  r2.ingest(obs('usgs', 'us6000u18k'), AT);
  const { merges } = r2.heal(AT);
  assert.equal(merges.length, 1);
  assert.match(merges[0]!.reason, /OVSICORI out-of-region window=200\.0 km\/30 s/);
  assert.equal(merges[0]!.survivor.chosenProvider, 'usgs');
});

// --- the hold ---

function heldRun(reports: RawObs[], nowMs = NOW): { map: Map<string, EventNode>; held: string[] } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs);
  for (const o of reports) r.ingest(o, AT);
  r.heal(AT);
  return { map, held: r.retractHeld(AT).map((h) => `${h.raw.provider}:${h.raw.providerEventId}`) };
}

test('held: OVSICORI automatic from M4.0 outside its region with nothing to join; NOA without a magnitude outside Greece', () => {
  const phantom = obs(OVSICORI_PROVIDER, '1450556', { status: 'automatic', mag: 6.7, lat: 4.78, lon: -78.93 });
  assert.deepEqual(heldRun([phantom]).held, ['ovsicori:1450556']);
  assert.deepEqual(heldRun([{ ...phantom, mag: 4.0 }]).held, ['ovsicori:1450556'], 'M4.0');
  assert.deepEqual(heldRun([{ ...phantom, mag: 3.9 }]).held, [], 'M3.9 stays');
  assert.deepEqual(heldRun([{ ...phantom, status: 'reviewed' }]).held, [], 'reviewed stays');
  assert.deepEqual(heldRun([{ ...phantom, lat: 9.5, lon: -84 }]).held, [], 'inside the region stays');
  const noa = obs(NOA_PROVIDER, 'noa2026uatzl', { status: null, mag: null, magType: null, lat: 7.97, lon: -81.46 });
  assert.deepEqual(heldRun([noa]).held, ['noa:noa2026uatzl']);
  assert.deepEqual(heldRun([{ ...noa, mag: 6.0 }]).held, [], 'NOA with a magnitude stays');
  assert.deepEqual(heldRun([{ ...noa, lat: 38.2, lon: 23.9 }]).held, [], 'NOA inside Greece stays');
  // An event that takes the solution keeps it: NOA's row 3 km from ComCat's M6.6 joins it (the base window).
  const { map, held } = heldRun([obs('usgs', 'us6000u19w', { mag: 6.6 }), { ...noa, lat: south(3), lon: LON, eventTimeMs: T0 + 1000 }]);
  assert.deepEqual(held, []);
  assert.equal(live(map).length, 1);
});

test('a held solution stays out while still held, joins an event that takes it, and comes back once reviewed', () => {
  const phantom = obs(OVSICORI_PROVIDER, '1450322', { status: 'automatic', mag: 8.5, lat: 5.81, lon: -78.75, eventTimeMs: T0 - 33_000 });
  const map = new Map<string, EventNode>();
  let r = new Resolver(map, prio, cfg, NOW);
  r.ingest(phantom, AT);
  assert.equal(r.retractHeld(AT).length, 1);
  const node = [...map.values()][0]!;
  assert.equal(node.state, 'tombstoned');
  // Later runs: the same report changes nothing.
  r = new Resolver(map, prio, cfg, NOW + 600_000);
  const again = r.ingest(phantom, AT);
  assert.equal(again.changed, false);
  assert.equal(again.node, node);
  assert.equal(live(map).length, 0);
  assert.equal(r.retractHeld(AT).length, 0);
  // OVSICORI reviews it under the same id (135 km, 17 s from ComCat's M7.7): it joins ComCat's event.
  r.ingest(obs('usgs', 'us6000u18k'), AT);
  r = new Resolver(map, prio, cfg, NOW + 1_200_000);
  const reviewed = r.ingest(obs(OVSICORI_PROVIDER, '1450322', { mag: 8.2, lat: south(135), eventTimeMs: T0 - 17_000 }), AT);
  assert.equal(reviewed.changed, true);
  assert.deepEqual(holding(map, 'ovsicori:1450322'), holding(map, 'usgs:us6000u18k'));
  assert.equal(node.state, 'tombstoned');
  // With nothing to join, the reviewed solution brings its own event back.
  const m2 = new Map<string, EventNode>();
  let r2 = new Resolver(m2, prio, cfg, NOW);
  r2.ingest(phantom, AT);
  r2.retractHeld(AT);
  r2 = new Resolver(m2, prio, cfg, NOW + 600_000);
  const back = r2.ingest({ ...phantom, status: 'reviewed' }, AT);
  assert.equal(back.changed, true);
  assert.equal(back.node.feedId, [...m2.keys()][0]);
  assert.equal(back.node.state, 'live');
  assert.equal(m2.size, 1);
});

// --- USP against a large partner, SCEDC's placeholder place, the day's magnitude range ---

test('USP’s window grows with the partner’s magnitude: 75 km from an M7.7 joins, beyond the scaled distance it does not', () => {
  const uspPair = (km: number, pm: number, merge = true): number => {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, NOW, merge ? {} : { merge: false });
    r.ingest(obs('usgs', 'us6000u18k', { mag: pm }), AT);
    r.ingest(obs(USP_PROVIDER, 'usp2026tutw', { lat: south(km), mag: pm - 0.03, status: null, eventTimeMs: T0 + 1000 }), AT);
    return live(map).length;
  };
  assert.equal(uspPair(75, 7.7), 1, '75 km, M7.7');
  assert.equal(uspPair(99, 7.0), 1, '99 km, M7.0');
  assert.equal(uspPair(74, 6.5), 1, '74 km, M6.5');
  assert.equal(uspPair(76, 6.5), 2, '76 km, M6.5');
  assert.equal(uspPair(51, 5.9), 2, '51 km, M5.9');
  assert.equal(uspPair(101, 7.7), 2, '101 km, M7.7');
  assert.equal(uspPair(75, 7.7, false), 2, 'merge pass off');
});

test('a place made of placeholders is no place; the field keeps it', () => {
  const body = [
    '#EventID|Time|Latitude|Longtitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|ET|GT',
    '10256694|2026/10/12 23:20:36.0300|7.6939|-81.4911|10|CI|SCEDC||||6.1|CI|###.# km ( ###.# mi) ESE (az= 121.8) from Fortuna Foothills, AZ|eq|r',
    '41345735|2026/10/09 17:07:36.8800|33.62433|-116.6828333|13.07|CI|SCEDC||||0.88|CI|7.7 km (   4.8 mi) N (az= 353.6) from Anza, CA|eq|l',
  ].join('\n');
  const [a, b] = parseFdsnText(body, 'scedc');
  assert.equal(a!.place, null);
  assert.equal(a!.fields['EventLocationName'], '###.# km ( ###.# mi) ESE (az= 121.8) from Fortuna Foothills, AZ');
  assert.equal(b!.place, '7.7 km (   4.8 mi) N (az= 353.6) from Anza, CA');
  assert.ok(PLACEHOLDER_PLACE.test('###.# km'));
  assert.ok(!PLACEHOLDER_PLACE.test('#1 street'));
});

test('a day’s magnitude range counts its live events while it can change and stays once frozen', () => {
  const node = (mag: number, state: EventNode['state']): EventNode => ({ mag, state }) as EventNode;
  const day = [node(7.7, 'live'), node(8.2, 'superseded'), node(6.7, 'tombstoned'), node(1.2, 'live')];
  assert.deepEqual(dayMagRange(day, undefined, false), { min_mag: 1.2, max_mag: 7.7 });
  assert.deepEqual(dayMagRange(day, { count: 4, bytes: 1, min_mag: 1.2, max_mag: 8.2 }, false), { min_mag: 1.2, max_mag: 7.7 });
  assert.deepEqual(dayMagRange(day, { count: 4, bytes: 1, min_mag: 1.2, max_mag: 8.2 }, true), { min_mag: 1.2, max_mag: 8.2 });
  assert.deepEqual(dayMagRange(day, undefined, true), { min_mag: 1.2, max_mag: 7.7 });
  assert.deepEqual(dayMagRange([node(8.2, 'superseded')], undefined, false), { min_mag: null, max_mag: null });
});
