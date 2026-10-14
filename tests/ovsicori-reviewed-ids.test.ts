import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GRID_CELL_DEG, OVSICORI_PROVIDER, OVSICORI_REGION, OVSICORI_WINDOW, REVIEWED_ID_WINDOWS, SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { gridKey } from '../src/geo.js';
import { REDERIVED_REASON, runFeedSideSteps } from '../src/heal.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// Round 27: OVSICORI (Costa Rica) publishes its analyst's review of a quake under a new id and keeps listing the
// automatic solution, so the moderate-event window, which keeps one provider's two ids apart, left each such quake as two
// live events (the partitions held about 80 such pairs inside OVSICORI's box). Outside its network the automatic locator
// moves a quake toward its stations: 1450630, an automatic M6.5 inside the box (2026-10-12 23:20:56), is the M6.1 of
// Panama that its reviewed 1450632 placed 195 km away and 27 s earlier. The fixture holds the real log lines of the
// 2026-09-10 swarm off Puntarenas (seven automatic / reviewed pairs, three reviewed solutions of one quake, reviews under
// the same id) and of six pairs of 2026-10-10..12, with EMSC's copies (author UNA) of both.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const KM_PER_DEG = 111.195;
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const holding = (map: Map<string, EventNode>, key: string): EventNode[] => live(map).filter((n) => n.provenance.some((r) => `${r.provider}:${r.nativeId}` === key));
const chosenKey = (n: EventNode): string => {
  const c = n.provenance.find((r) => r.chosen)!;
  return `${c.provider}:${c.nativeId}`;
};
const LINES: Observation[] = readFileSync(here('fixtures/ovsicori-reviewed-ids-2026.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation)
  .sort((a, b) => a.seq - b.seq);

/** The fixture replayed as production ran it: one Resolver per aggregate run (ingest_time), each run ending with the
 *  feed-side steps (the re-derive, the regular heal, the held withdrawal). */
function replay(merge = true): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  const scratch = mkdtempSync(join(tmpdir(), 'ovsicori-reviewed-'));
  try {
    for (const at of [...new Set(LINES.map((o) => o.ingest_time))]) {
      const r = new Resolver(map, prio, cfg, Date.parse(at), merge ? {} : { merge: false });
      for (const o of LINES.filter((l) => l.ingest_time === at)) r.ingest(observationToRaw(o), at);
      if (merge) runFeedSideSteps(scratch, r, new LogBuffer(0, at), { healDue: false, loadDays: 10, ingestTime: at });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return map;
}

/** Automatic / reviewed pairs of the fixture, each one quake. */
const PAIRS = [
  ['1449704', '1449772'],
  ['1449703', '1449732'],
  ['1449702', '1449750'],
  ['1449701', '1449749'],
  ['1449700', '1449764'],
  ['1449699', '1449763'],
  ['1449713', '1449747'],
  ['1450374', '1450390'],
  ['1450512', '1450528'],
  ['1450513', '1450527'],
  ['1450544', '1450595'],
  ['1450561', '1450597'],
  ['1450573', '1450649'],
];

test('config: OVSICORI only; near 4 s, 45 km, |ΔM| 0.5; far outside its box 40 s, 300 km, |ΔM| 2.0 at 6–9 km/s', () => {
  assert.deepEqual([...REVIEWED_ID_WINDOWS.keys()], [OVSICORI_PROVIDER]);
  assert.deepEqual(REVIEWED_ID_WINDOWS.get(OVSICORI_PROVIDER), {
    boxes: OVSICORI_REGION,
    near: { dtMs: 4_000, km: 45, maxDeltaMag: 0.5 },
    far: { dtMs: 40_000, km: 300, maxDeltaMag: 2.0, minKmPerS: 6, maxKmPerS: 9 },
  });
});

test('real log: each automatic solution and its reviewed one under another id are one event, the reviewed one representing it', () => {
  const map = replay();
  for (const [auto, rev] of PAIRS) {
    const a = holding(map, `ovsicori:${auto}`);
    assert.equal(a.length, 1, auto);
    assert.deepEqual(holding(map, `ovsicori:${rev}`), a, `${auto} / ${rev}`);
    assert.equal(chosenKey(a[0]!), `ovsicori:${rev}`, `${auto} / ${rev}`);
  }
  // Not pairs: 1449695 (automatic M1.6) and 1449759 (reviewed M2.6, 3 s and 15.7 km) are |ΔM| 1.0 apart; 1450526 is a
  // second quake 50 s after 1450527; 1449751 and 1449771, two more reviewed solutions of 1449732's quake (2.5 km from
  // it), stay one event of their own (the provider's two reviewed ids are not a pair).
  assert.notDeepEqual(holding(map, 'ovsicori:1449695'), holding(map, 'ovsicori:1449759'));
  assert.notDeepEqual(holding(map, 'ovsicori:1450526'), holding(map, 'ovsicori:1450527'));
  assert.deepEqual(holding(map, 'ovsicori:1449751'), holding(map, 'ovsicori:1449771'));
  assert.notDeepEqual(holding(map, 'ovsicori:1449751'), holding(map, 'ovsicori:1449732'));
  // No row in two live events.
  const keys = live(map).flatMap((n) => n.provenance.map((r) => `${r.provider}:${r.nativeId}`));
  assert.equal(new Set(keys).size, keys.length);
});

test('real log without the merge pass (the backfill, the deep-history build): nothing changes', () => {
  const map = replay(false);
  // 1449701 / 1449749 (0 s, 1.6 km, M3.4 both) are one solution under two ids (sameSolution) whatever the rule.
  for (const [auto, rev] of PAIRS.filter(([a]) => a !== '1449701')) {
    assert.notDeepEqual(holding(map, `ovsicori:${auto}`), holding(map, `ovsicori:${rev}`), `${auto} / ${rev}`);
  }
});

// --- unit by unit ---

const T0 = Date.parse('2026-10-11T08:54:05Z');
const NOW = Date.parse('2026-10-11T13:00:00Z');
const LAT = 8.276;
const LON = -82.904;
function obs(id: string, over: Partial<RawObs> = {}, provider = OVSICORI_PROVIDER): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: 'automatic',
    lat: LAT,
    lon: LON,
    depth: 10,
    mag: 3.3,
    magType: null,
    place: 'Puntarenas',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}
const north = (km: number, lat = LAT): number => lat + km / KM_PER_DEG;
/** Live events after OVSICORI's automatic 1450513 and a later report `over` (reviewed 1450527 by default), either order,
 *  then the regular heal, as at the end of every run (none without the merge pass). */
function pair(over: Partial<RawObs>, opts: { revFirst?: boolean; merge?: boolean; seed?: (r: Resolver) => void } = {}): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW, opts.merge === false ? { merge: false } : {});
  opts.seed?.(r);
  const a = obs('1450513');
  const b = obs('1450527', { status: 'reviewed', ...over });
  for (const o of opts.revFirst ? [b, a] : [a, b]) r.ingest(o, '2026-10-11T12:46:00Z');
  r.heal('2026-10-11T12:46:00Z');
  return map;
}
const together = (map: Map<string, EventNode>, a = 'ovsicori:1450513', b = 'ovsicori:1450527'): boolean => {
  const x = holding(map, a);
  return x.length === 1 && holding(map, b)[0] === x[0];
};

test('near: within 4 s, 45 km and |ΔM| 0.5 one event, either order, the reviewed one representing it; beyond, two', () => {
  for (const revFirst of [false, true]) {
    const map = pair({ lat: north(11.6), eventTimeMs: T0 + 1000, mag: 3.1 }, { revFirst });
    assert.ok(together(map), `revFirst=${revFirst}`);
    assert.equal(chosenKey(holding(map, 'ovsicori:1450527')[0]!), 'ovsicori:1450527');
    assert.ok(together(pair({ lat: north(44.5), eventTimeMs: T0 - 4000, mag: 3.8 }, { revFirst })), `edge, revFirst=${revFirst}`);
    assert.ok(!together(pair({ lat: north(46), mag: 3.3 }, { revFirst })), `46 km, revFirst=${revFirst}`);
    assert.ok(!together(pair({ eventTimeMs: T0 + 5000, lat: north(12) }, { revFirst })), `5 s, revFirst=${revFirst}`);
    assert.ok(!together(pair({ mag: 3.9, lat: north(12) }, { revFirst })), `|ΔM| 0.6, revFirst=${revFirst}`);
  }
});

test('a pair is one automatic and one reviewed solution, the reviewed one under the higher id', () => {
  const near = { lat: north(12), eventTimeMs: T0 + 1000 };
  assert.ok(!together(pair({ ...near, status: 'automatic' })), 'two automatic');
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('1450527'), '2026-10-11T12:46:00Z');
  r.ingest(obs('1450513', { ...near, status: 'reviewed' }), '2026-10-11T12:46:00Z');
  assert.ok(!together(map), 'the reviewed id lower');
  assert.ok(!together(pair({ ...near }, { merge: false })), 'without the merge pass');
});

test('mutual best: of two automatic solutions beside one reviewed one, the nearer is its twin; the other stays', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('1450512', { lat: north(20), eventTimeMs: T0 - 1000 }), '2026-10-11T09:00:00Z');
  r.ingest(obs('1450513'), '2026-10-11T09:00:00Z');
  r.ingest(obs('1450527', { status: 'reviewed', lat: north(5), mag: 3.1 }), '2026-10-11T12:46:00Z');
  r.heal('2026-10-11T12:46:00Z');
  assert.ok(together(map));
  assert.equal(holding(map, 'ovsicori:1450512').length, 1);
  assert.notEqual(holding(map, 'ovsicori:1450512')[0], holding(map, 'ovsicori:1450527')[0]);
  // The reviewed one first and both automatic ones after it in one run, then the heal: the same (an automatic report
  // does not join its reviewed twin at first sight; the merge pass folds the mutual best).
  const map2 = new Map<string, EventNode>();
  const r2 = new Resolver(map2, prio, cfg, NOW);
  r2.ingest(obs('1450527', { status: 'reviewed', lat: north(5), mag: 3.1 }), '2026-10-11T12:46:00Z');
  r2.ingest(obs('1450512', { lat: north(20), eventTimeMs: T0 - 1000 }), '2026-10-11T12:46:00Z');
  r2.ingest(obs('1450513'), '2026-10-11T12:46:00Z');
  r2.heal('2026-10-11T12:46:00Z');
  assert.ok(together(map2));
  assert.notEqual(holding(map2, 'ovsicori:1450512')[0], holding(map2, 'ovsicori:1450527')[0]);
});

// The far window: OVSICORI's automatic 1450630 inside its box (8.6647 N 82.5415 W, 23:20:56, M6.5) and its reviewed
// 1450632 outside it (7.2868 N 81.4482 W, 23:20:29, M6.8): 194.9 km and 27 s, 7.2 km/s.
const P_AUTO = { lat: 8.6647, lon: -82.5415, eventTimeMs: Date.parse('2026-10-12T23:20:56Z'), mag: 6.5 };
const P_REV = { lat: 7.2868, lon: -81.4482, eventTimeMs: Date.parse('2026-10-12T23:20:29Z'), mag: 6.8, status: 'reviewed' };
function far(rev: Partial<RawObs>, auto: Partial<RawObs> = {}, seed?: (r: Resolver) => void, autoLast = false): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, Date.parse('2026-10-13T00:30:00Z'));
  seed?.(r);
  const a = obs('1450630', { ...P_AUTO, ...auto });
  const b = obs('1450632', { ...P_REV, ...rev });
  for (const o of autoLast ? [b, a] : [a, b]) r.ingest(o, '2026-10-12T23:56:52Z');
  r.heal('2026-10-12T23:56:52Z');
  return map;
}
const farTogether = (map: Map<string, EventNode>): boolean => together(map, 'ovsicori:1450630', 'ovsicori:1450632');

test('far: the reviewed solution outside the box, the automatic one later, up to 40 s and 300 km off at 6–9 km/s, one event', () => {
  const map = far({});
  assert.ok(farTogether(map));
  assert.equal(chosenKey(holding(map, 'ovsicori:1450630')[0]!), 'ovsicori:1450632');
  // 4.8 km/s (40 s for 195 km), 12 km/s (16 s), a reviewed solution inside the box, |ΔM| 2.1: two events.
  assert.ok(!farTogether(far({ eventTimeMs: P_AUTO.eventTimeMs - 40_000 })), '4.9 km/s');
  assert.ok(!farTogether(far({ eventTimeMs: P_AUTO.eventTimeMs - 16_000 })), '12 km/s');
  assert.ok(!farTogether(far({ lat: 8.2, lon: -82.6 }, { lat: 9.95, lon: -83.7, eventTimeMs: P_REV.eventTimeMs + 27_000 })), 'reviewed inside the box');
  assert.ok(!farTogether(far({ mag: 8.7 })), '|ΔM| 2.2');
  // Round 27 review: the automatic origin time is the later one (the locator moved the quake toward the stations); the
  // same 195 km and 27 s with the automatic one earlier are two quakes.
  assert.ok(!farTogether(far({ eventTimeMs: P_AUTO.eventTimeMs + 27_000 })), 'the automatic one 27 s earlier');
  assert.ok(farTogether(far({ eventTimeMs: P_AUTO.eventTimeMs - 22_000 })), '22 s, 8.9 km/s');
});

test('far: in a dense cell the twins still fold, into the global agencies’ event the reviewed one joined', () => {
  const T = Date.parse('2026-10-12T23:20:36Z');
  const seed = (r: Resolver): void => {
    for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
      r.ingest(
        obs(`20261012_9${String(i).padStart(6, '0')}`, { eventTimeMs: T - 3_600_000 + i * 60_000, status: null, lat: 7.69 + ((i % 7) - 3) * 0.004, lon: -81.49 + ((i % 5) - 2) * 0.004, mag: 3.0, magType: 'mb' }, 'emsc'),
        '2026-10-12T23:00:00Z',
      );
    }
    r.ingest(obs('us6000u1wn', { eventTimeMs: T, status: 'reviewed', lat: 7.6896, lon: -81.4896, mag: 6.1, magType: 'mww' }, 'usgs'), '2026-10-12T23:30:00Z');
  };
  // Either order: the automatic one first (the reviewed report joins it, then the pair joins the M6.1), or after the
  // reviewed one joined the M6.1 (the merge pass folds the twins across the dense cell).
  for (const autoLast of [false, true]) {
    const map = far({}, {}, seed, autoLast);
    const m61 = holding(map, 'usgs:us6000u1wn');
    assert.equal(m61.length, 1, `autoLast=${autoLast}`);
    assert.deepEqual(holding(map, 'ovsicori:1450632'), m61, `autoLast=${autoLast}`);
    assert.deepEqual(holding(map, 'ovsicori:1450630'), m61, `autoLast=${autoLast}`);
    assert.equal(chosenKey(m61[0]!), 'usgs:us6000u1wn', `autoLast=${autoLast}`);
  }
});

test('two quakes the global agencies list stay two events whatever OVSICORI’s two ids pair (round 27 review)', () => {
  // A quake inside the box (ComCat M4.6 at the automatic solution's place, 0 s) and the M6.1 159 km and 20 s away: the
  // automatic one is the M4.6's, the reviewed one the M6.1's, and the far window pairs them (195 km, 27 s, 7.2 km/s,
  // |ΔM| 1.4). ComCat's two ids keep the quakes apart, each represented by its own solution, whatever the order (the
  // reviewed row sits in the M4.6's event when it comes after the automatic one, which it joins at first sight, and in
  // the M6.1's when it comes first: a provenance row, never the representative).
  const seed = (r: Resolver): void => {
    r.ingest(obs('us7000x001', { eventTimeMs: P_AUTO.eventTimeMs, status: 'reviewed', lat: P_AUTO.lat, lon: P_AUTO.lon, mag: 4.6, magType: 'mb' }, 'usgs'), '2026-10-12T23:40:00Z');
    r.ingest(obs('us6000u1wn', { eventTimeMs: Date.parse('2026-10-12T23:20:36Z'), status: 'reviewed', lat: 7.6896, lon: -81.4896, mag: 6.1, magType: 'mww' }, 'usgs'), '2026-10-12T23:40:00Z');
  };
  for (const autoLast of [false, true]) {
    const map = far({ mag: 6.0 }, { mag: 4.6 }, seed, autoLast);
    const x = holding(map, 'usgs:us7000x001');
    const y = holding(map, 'usgs:us6000u1wn');
    assert.equal(x.length, 1, `autoLast=${autoLast}`);
    assert.equal(y.length, 1, `autoLast=${autoLast}`);
    assert.notEqual(x[0], y[0], `autoLast=${autoLast}`);
    assert.equal(chosenKey(x[0]!), 'usgs:us7000x001', `autoLast=${autoLast}`);
    assert.equal(chosenKey(y[0]!), 'usgs:us6000u1wn', `autoLast=${autoLast}`);
    const keys = live(map).flatMap((n) => n.provenance.map((r) => `${r.provider}:${r.nativeId}`));
    assert.equal(new Set(keys).size, keys.length, `autoLast=${autoLast}`);
  }
});

test('an automatic solution beside its reviewed twin never represents the event, whatever the other rows', () => {
  // EMSC's own solution (no status) and OVSICORI's reviewed one outside the box (outranked beside a partner): without the
  // rule the automatic solution inside the box (status rank 1 against EMSC's 0) would place the M6.1 at its phantom spot.
  const T = Date.parse('2026-10-12T23:20:37Z');
  const seed = (r: Resolver): void => {
    r.ingest(obs('20261012_0000435', { eventTimeMs: T, status: null, lat: 7.7, lon: -81.52, mag: 6.1, magType: 'mw', fields: { auth: 'EMSC' } }, 'emsc'), '2026-10-12T23:25:00Z');
  };
  const map = far({}, {}, seed);
  const ev = holding(map, 'emsc:20261012_0000435');
  assert.equal(ev.length, 1);
  assert.deepEqual(holding(map, 'ovsicori:1450630'), ev);
  assert.equal(chosenKey(ev[0]!), 'emsc:20261012_0000435');
});

test('re-derive: a stored event led by a row the rules now rank behind another is re-derived once, through the heal path', () => {
  // efd_01M4W5P9F0ZAGGCN86AH8ZGDTR (2026-10-14 03:00): EMSC's own M4.7 and OVSICORI's automatic M4.2 outside its box,
  // stored with OVSICORI's row representing it (positioned before the round 26 review's rule), and GFZ's M4.74 14 km from
  // EMSC's standing apart.
  const T = Date.parse('2026-10-14T03:00:54.570Z');
  const NOW14 = Date.parse('2026-10-14T19:00:00Z');
  const map = new Map<string, EventNode>();
  new Resolver(map, prio, cfg, NOW14).ingest(
    obs('20261014_0000044', { eventTimeMs: T, status: null, lat: 7.7774, lon: -80.4248, mag: 4.7, magType: 'mb', fields: { auth: 'EMSC' } }, 'emsc'),
    '2026-10-14T03:12:30Z',
  );
  const ev = holding(map, 'emsc:20261014_0000044')[0]!;
  // The stored state the old rules left: OVSICORI's row in EMSC's event and representing it.
  const ovs = { ...ev.provenance[0]!, provider: OVSICORI_PROVIDER, nativeId: '1450726', eventTimeMs: Date.parse('2026-10-14T03:01:13Z'), status: 'automatic', lat: 8.2242, lon: -81.9484, mag: 4.2, magType: null, chosen: true, fields: {} };
  ev.provenance[0]!.chosen = false;
  ev.provenance.push(ovs);
  ev.aliases.push('ovsicori:1450726');
  Object.assign(ev, { lat: ovs.lat, lon: ovs.lon, mag: 4.2, status: 'automatic', chosenProvider: OVSICORI_PROVIDER, eventTimeMs: ovs.eventTimeMs, geohash: gridKey(ovs.lat, ovs.lon, GRID_CELL_DEG) });
  // GFZ's report then finds nothing within its windows of that representative and stands apart.
  new Resolver(map, prio, cfg, NOW14).ingest(obs('gfz2026uctv', { eventTimeMs: T - 1290, status: null, lat: 7.687, lon: -80.517, mag: 4.74, magType: 'mb' }, 'geofon'), '2026-10-14T03:12:30Z');
  assert.equal(live(map).length, 2);
  const scratch = mkdtempSync(join(tmpdir(), 'ovsicori-rederive-'));
  try {
    const run = (at: string): { lines: Observation[]; rederived: number } => {
      const log = new LogBuffer(100, at);
      const res = runFeedSideSteps(scratch, new Resolver(map, prio, cfg, Date.parse(at)), log, { healDue: false, loadDays: 10, ingestTime: at });
      return { lines: log.lines, rederived: res.rederived };
    };
    const first = run('2026-10-14T19:00:00Z');
    assert.equal(first.rederived, 1);
    const corr = first.lines.filter((l) => l.op === 'correction' && l.reason === REDERIVED_REASON);
    assert.equal(corr.length, 1);
    assert.equal(corr[0]!.feed_id, ev.feedId);
    assert.equal(corr[0]!.provider, 'emsc');
    // EMSC's solution represents it, and GFZ's event, 14 km away, now folds into it.
    const after = holding(map, 'emsc:20261014_0000044');
    assert.equal(after.length, 1);
    assert.equal(chosenKey(after[0]!), 'emsc:20261014_0000044');
    assert.deepEqual(holding(map, 'geofon:gfz2026uctv'), after);
    assert.equal(live(map).length, 1);
    // A second run changes nothing.
    const second = run('2026-10-14T19:05:00Z');
    assert.equal(second.rederived, 0);
    assert.equal(second.lines.length, 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// --- the out-of-region window's partner floor (round 27) ---

// OVSICORI's reviewed 1450391 (M6.0, 2026-10-09 23:09:55, 7.0388 N 80.0793 W) and ComCat's us6000u1ax (M5.0, 23:10:02.9,
// 7.3962 N 80.5284 W): 63.5 km and 7.9 s, 8.0 km/s.
const Q_OVS = { lat: 7.0388, lon: -80.0793, eventTimeMs: Date.parse('2026-10-09T23:09:55Z'), mag: 6.0, status: 'reviewed' };
const Q_US = { lat: 7.3962, lon: -80.5284, eventTimeMs: Date.parse('2026-10-09T23:10:02.875Z'), mag: 5.0, status: 'reviewed', magType: 'mb' };
function low(ovs: Partial<RawObs> = {}, us: Partial<RawObs> = {}, ovsFirst = false): number {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, Date.parse('2026-10-10T06:00:00Z'));
  const a = obs('us6000u1ax', { ...Q_US, ...us }, 'usgs');
  const b = obs('1450391', { ...Q_OVS, ...ovs });
  for (const o of ovsFirst ? [b, a] : [a, b]) r.ingest(o, '2026-10-10T05:11:00Z');
  r.heal('2026-10-10T05:11:00Z');
  return live(map).length;
}

test('config: the out-of-region window takes a reviewed solution’s partner from M4.5, within 50 km or up to 120 km at 6–10 km/s', () => {
  assert.deepEqual(OVSICORI_WINDOW.low, { fromMag: 4.5, km: 120, minKmPerS: 6, maxKmPerS: 10, slackMs: 2_000 });
});

test('a reviewed OVSICORI solution outside its region joins a partner of M4.5–5.5 at the P-wave speed, either order', () => {
  for (const ovsFirst of [false, true]) {
    assert.equal(low({}, {}, ovsFirst), 1, `1450391 and us6000u1ax, ovsFirst=${ovsFirst}`);
    assert.equal(low({}, { mag: 4.5 }, ovsFirst), 1, `partner M4.5, ovsFirst=${ovsFirst}`);
    assert.equal(low({ eventTimeMs: Q_US.eventTimeMs - 2000 }, {}, ovsFirst), 2, `63.5 km in 2.9 s, ovsFirst=${ovsFirst}`);
    assert.equal(low({ eventTimeMs: Q_US.eventTimeMs - 14_000 }, {}, ovsFirst), 2, `63.5 km in 14 s, ovsFirst=${ovsFirst}`);
    assert.equal(low({}, { mag: 4.4 }, ovsFirst), 2, `partner M4.4, ovsFirst=${ovsFirst}`);
    assert.equal(low({ status: 'automatic', mag: 5.4 }, {}, ovsFirst), 2, `automatic, ovsFirst=${ovsFirst}`);
  }
  // Within 50 km the time difference is at most the distance at 6 km/s plus 2 s (round 27 review): 40 km, 8.6 s is one
  // quake, 40 km, 9 s two (a larger partner's window leaves it free up to 30 s).
  for (const ovsFirst of [false, true]) {
    assert.equal(low({ lat: Q_US.lat - 40 / KM_PER_DEG, lon: Q_US.lon, eventTimeMs: Q_US.eventTimeMs - 1000 }, {}, ovsFirst), 1, `40 km, 1 s, ovsFirst=${ovsFirst}`);
    assert.equal(low({ lat: Q_US.lat - 40 / KM_PER_DEG, lon: Q_US.lon, eventTimeMs: Q_US.eventTimeMs - 8600 }, {}, ovsFirst), 1, `40 km, 8.6 s, ovsFirst=${ovsFirst}`);
    assert.equal(low({ lat: Q_US.lat - 40 / KM_PER_DEG, lon: Q_US.lon, eventTimeMs: Q_US.eventTimeMs - 9000 }, {}, ovsFirst), 2, `40 km, 9 s, ovsFirst=${ovsFirst}`);
    assert.equal(low({ lat: Q_US.lat - 40 / KM_PER_DEG, lon: Q_US.lon, eventTimeMs: Q_US.eventTimeMs + 25_000 }, {}, ovsFirst), 2, `40 km, 25 s, ovsFirst=${ovsFirst}`);
  }
  // 121 km at 8 km/s: two.
  assert.equal(low({ lat: Q_US.lat - 121 / KM_PER_DEG, lon: Q_US.lon, eventTimeMs: Q_US.eventTimeMs - 15_125 }), 2, '121 km');
});

test('an automatic OVSICORI solution outside its region does not take a partner below M5.5', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, Date.parse('2026-10-10T06:00:00Z'));
  r.ingest(obs('us6000u1ax', Q_US, 'usgs'), '2026-10-10T05:11:00Z');
  r.ingest(obs('1450391', { ...Q_OVS, status: 'automatic', mag: 5.4 }), '2026-10-10T05:11:00Z');
  r.heal('2026-10-10T05:11:00Z');
  assert.equal(live(map).length, 2);
  // Held: automatic, M ≥ 4.0, outside the box, and no event takes it.
  r.retractHeld('2026-10-10T05:11:00Z');
  assert.equal(live(map).length, 1);
  assert.equal(holding(map, 'ovsicori:1450391').length, 0);
});
