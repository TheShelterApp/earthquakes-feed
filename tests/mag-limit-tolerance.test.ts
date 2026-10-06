import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LARGE_EVENT_MAX_DELTA, LOCATION_JOIN_MAX_DM, MAG_MERGE_MAX_DELTA, REID_MAG_TOLERANCE } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';

// PF-5h (4), round 15: the same float edge as PF-5g's REID_MAG_DELTA at the other magnitude limits of the identity
// rules. A difference of exactly the limit in published magnitudes lands on either side of it as a binary float
// (5.4 − 4.6 = 0.8000000000000007, 8.3 − 7.3 = 1.0000000000000009, 4.4 − 3.4 = 1.0000000000000004,
// 2.2 − 0.7 = 1.5000000000000002), so a pair at the limit was one event or two by the luck of the digits. Every limit
// now carries REID_MAG_TOLERANCE: exactly the limit passes, one hundredth more does not.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const T = Date.parse('2026-10-05T12:00:00Z');
const NOW = T + 3_600_000;
const INGEST = new Date(NOW).toISOString();
const KM_PER_DEG = 111.195;
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');

function report(provider: string, id: string, over: Partial<RawObs>): RawObs {
  return {
    provider, providerEventId: id, eventTimeMs: T, providerUpdatedMs: null, status: 'automatic', lat: 10, lon: 120, depth: 10,
    mag: 5, magType: 'mb', place: null, knownAliasIds: [], fields: {}, ...over,
  };
}

/** Ingest the reports in order on an empty map: the live events and the last result. */
function run(...reports: RawObs[]): { events: number; last: ReturnType<Resolver['ingest']> } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  let last!: ReturnType<Resolver['ingest']>;
  for (const x of reports) last = r.ingest(x, INGEST);
  return { events: live(map).length, last };
}

test('the four limits and the float error at each of them', () => {
  assert.deepEqual([MAG_MERGE_MAX_DELTA, LARGE_EVENT_MAX_DELTA, LOCATION_JOIN_MAX_DM], [0.8, 1.0, 1.5]);
  assert.ok(5.4 - 4.6 > MAG_MERGE_MAX_DELTA && 5.4 - 4.6 <= MAG_MERGE_MAX_DELTA + REID_MAG_TOLERANCE);
  assert.ok(8.3 - 7.3 > LARGE_EVENT_MAX_DELTA && 8.3 - 7.3 <= LARGE_EVENT_MAX_DELTA + REID_MAG_TOLERANCE);
  assert.ok(4.4 - 3.4 > LARGE_EVENT_MAX_DELTA && 4.4 - 3.4 <= LARGE_EVENT_MAX_DELTA + REID_MAG_TOLERANCE);
  assert.ok(2.2 - 0.7 > LOCATION_JOIN_MAX_DM && 2.2 - 0.7 <= LOCATION_JOIN_MAX_DM + REID_MAG_TOLERANCE);
});

test('MAG_MERGE_MAX_DELTA: two reviewed solutions exactly 0.8 apart are one event; 0.81 apart are two', () => {
  // 3 km and 2 s apart: inside the windows (10 km and 60 s, shrunk by ΔM to 7.6 km and 48 s); the reviewed-vs-reviewed
  // guard decides, and nothing else (the moderate window stops at |ΔM| 0.5, the twin row at 0.1) joins them.
  const a = report('usgs', 'us7000tol1', { status: 'reviewed', mag: 5.4 });
  const at = (mag: number): RawObs => report('ingv', '46000001', { status: 'reviewed', mag, eventTimeMs: T + 2_000, lat: 10 + 3 / KM_PER_DEG });
  assert.equal(run(a, at(4.6)).events, 1);
  assert.equal(run(at(4.6), a).events, 1, 'either arrival order');
  assert.equal(run(a, at(4.59)).events, 2);
  // Below the limit as a float already, as before.
  assert.equal(run(report('usgs', 'us7000tol2', { status: 'reviewed', mag: 4.9 }), report('ingv', '46000002', { status: 'reviewed', mag: 4.1, eventTimeMs: T + 2_000, lat: 10 + 3 / KM_PER_DEG })).events, 1);
});

test('LARGE_EVENT_MAX_DELTA on the widened window: two M ≥ 5.5 solutions exactly 1.0 apart are one event; 1.01 apart are two', () => {
  // 20 km and 2 s apart: beyond the 10 km base window, inside the widened one (50 km at M7.3, 35 km after the ΔM shrink).
  const a = report('usgs', 'us7000tol3', { mag: 8.3 });
  const at = (mag: number): RawObs => report('geofon', 'gfz2026tol3', { mag, eventTimeMs: T + 2_000, lat: 10 + 20 / KM_PER_DEG });
  assert.equal(run(a, at(7.3)).events, 1);
  assert.equal(run(at(7.3), a).events, 1, 'either arrival order');
  assert.equal(run(a, at(7.29)).events, 2);
});

test('LOCATION_JOIN_MAX_DM: an AEC solution exactly 1.5 from the event joins it by location; 1.51 does not', () => {
  // AVO's solution, then AEC's automatic one of another magnitude 1 km and 1 s away (no ComCat id links them).
  const avo = report('usgs', 'av91234567', { mag: 0.7, magType: 'ml', lat: 61.3, lon: -152.25 });
  const aec = (mag: number): RawObs => report('aec', 'aka2026tol1', { mag, magType: 'ml', eventTimeMs: T + 1_000, lat: 61.3 + 1 / KM_PER_DEG, lon: -152.25 });
  const joined = run(avo, aec(2.2));
  assert.equal(joined.events, 1);
  assert.equal(joined.last.changed, true);
  // 1.51 apart: the location join is refused; the report is withheld beside the event (lateTwin, |ΔM| ≤ 1 does not
  // hold either), so it mints an event of its own.
  assert.equal(run(avo, aec(2.21)).events, 2);
});

test('lateTwin: an AEC report exactly 1.0 from the event beside it is withheld; 1.01 is minted', () => {
  // ComCat's M3.4 and AEC's M4.4 20 km and 5 s apart: beyond every window (7 km after the ΔM shrink; the moderate one
  // needs both ≥ M4.0), so the report would mint, unless lateTwin calls it the quake the feed already shows.
  const usgs = report('usgs', 'ak0261234567', { mag: 3.4, magType: 'ml', lat: 60, lon: -150 });
  const aec = (mag: number): RawObs => report('aec', 'aka2026tol2', { mag, magType: 'ml', eventTimeMs: T + 5_000, lat: 60 + 20 / KM_PER_DEG, lon: -150 });
  const held = run(usgs, aec(4.4));
  assert.equal(held.events, 1);
  assert.ok(held.last.withheld, 'withheld beside the ComCat event');
  assert.equal(held.last.changed, false);
  const minted = run(usgs, aec(4.41));
  assert.equal(minted.events, 2);
  assert.equal(minted.last.withheld, undefined);
});

test('lateTwin through the revision sweep: a late ComCat report exactly 1.0 from another source\'s event is withheld', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(report('emsc', '20261005_0000999', { mag: 3.4, magType: 'ml' }), INGEST);
  const late = (mag: number): RawObs => report('usgs', 'us7000tol4', { mag, eventTimeMs: T + 5_000, lat: 10 + 20 / KM_PER_DEG });
  assert.equal(r.reviseOrMintInHotWindow(late(4.4), INGEST).kind, 'withheld');
  assert.equal(r.reviseOrMintInHotWindow(late(4.41), INGEST).kind, 'minted');
});
