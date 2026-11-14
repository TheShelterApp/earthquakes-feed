import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { outsideAuthority } from '../src/authority.js';
import { AUTHORITY_WINDOW, ISC_COPY_DT_MS, ISC_COPY_KM, type IdentityRules, LIVE_IDENTITY_RULES, REMERGE_EPOCH, SWARM_CELL_ABSOLUTE, identityRules, liveIdentityRules } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { anchorCounts, remergeGateProblems, remergeNodes, snapshotUnit, swarmCellsAsOf } from '../src/remerge.js';
import { isOutOfRegion } from '../src/stats-table.js';
import type { EventNode, RawObs } from '../src/types.js';

// Dedup epoch 2 (SHLTR-148; config identityRules): ISC's copies of NEIC's, GFZ's, GA's and RSPR's origins, the authoritative-
// region window, a pair's density as of the pair (the re-merge only) and large quakes in swarm cells. Each rule is off
// at epoch 1 (the live feed and every published unit today) and on from epoch 2.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const IT = '2026-11-08T00:00:00.000Z';
const DAY = 86_400_000;
const START = Date.parse('2025-08-01T00:00:00Z');
const END = Date.parse('2025-09-01T00:00:00Z');
const T = START + 10 * DAY + 12 * 3_600_000;
const KM_PER_DEG = 111.195;

function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider, providerEventId: id, eventTimeMs: T, providerUpdatedMs: null, status: null, lat: 39.25, lon: 28.05, depth: 10,
    mag: 6.1, magType: 'mww', place: 'test', knownAliasIds: [], fields: {}, ...over,
  };
}
const usgs = (id: string, over: Partial<RawObs> = {}): RawObs => obs('usgs', id, { status: 'reviewed', fields: { ids: `,${id},` }, ...over });
const isc = (id: string, author: string, over: Partial<RawObs> = {}): RawObs => obs('isc', id, { magType: 'mb', fields: { Author: author, MagAuthor: author }, ...over });

/** One event per report, as a backfilled archive holds a quake whose sources were walked one by one. */
function split(rows: RawObs[]): EventNode[] {
  const out: EventNode[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const one = new Map<string, EventNode>();
    new Resolver(one, prio, cfg, END, { hotFloorMs: 0, merge: false }).ingest(row, IT);
    for (const n of one.values()) {
      while (ids.has(n.feedId)) n.feedId = `${n.feedId}X`;
      ids.add(n.feedId);
      out.push(n);
    }
  }
  return out;
}
/** The re-merge of a month of `rows` (split first) to `epoch`; returns the unit after it and the gates' problems. */
function remerge(rows: RawObs[], epoch: number): { own: EventNode[]; problems: string[]; reasons: string[] } {
  const own = split(rows);
  const before = snapshotUnit(own);
  const res = remergeNodes({
    own,
    memberDay: new Map(own.map((n) => [n.feedId, new Date(n.eventTimeMs).toISOString().slice(0, 10)])),
    startMs: START,
    endMs: END,
    older: [],
    newer: [],
    anchored: new Set(),
    registry,
    ingestTime: IT,
    epoch,
  });
  return { own, problems: remergeGateProblems(before, own, res), reasons: res.merges.map((m) => m.reason) };
}
const liveHolding = (own: EventNode[], key: string): EventNode => {
  const n = own.find((x) => x.state === 'live' && x.provenance.some((r) => `${r.provider}:${r.nativeId}` === key));
  assert.ok(n, `${key} is live somewhere`);
  return n;
};
const together = (own: EventNode[], a: string, b: string): boolean => liveHolding(own, a).feedId === liveHolding(own, b).feedId;
/** Small quakes of one agency filling the 0.2-degree cell of (lat, lon) from 6 days before `at` to 5 days after it (a
 *  swarm): the cell is dense as of `at` and at the end of every re-merge window that holds `at`. */
const swarm = (lat: number, lon: number, at: number, n = SWARM_CELL_ABSOLUTE + 10): RawObs[] =>
  Array.from({ length: 2 * n }, (_, i) =>
    obs('afad', `sw${i}`, { eventTimeMs: i < n ? at - 3 * DAY - i * 3_600_000 : at + 3_600_000 + (i - n) * 7_200_000, lat: lat + (i % 5) * 0.01, lon: lon + (i % 3) * 0.01, mag: 2.1, magType: 'ml' }),
  );

test('identityRules: epoch 1 adds nothing, epoch 2 adds all four rules; the live Resolver runs the current epoch without the offline density', () => {
  assert.deepEqual(identityRules(0), { iscCopies: false, authorityWindow: false, densityAsOfPair: false, largeQuakesInSwarms: false });
  assert.deepEqual(identityRules(1), { iscCopies: false, authorityWindow: false, densityAsOfPair: false, largeQuakesInSwarms: false });
  assert.deepEqual(identityRules(2), { iscCopies: true, authorityWindow: true, densityAsOfPair: true, largeQuakesInSwarms: true });
  assert.deepEqual(LIVE_IDENTITY_RULES, { ...identityRules(REMERGE_EPOCH), densityAsOfPair: false });
  assert.deepEqual(liveIdentityRules(2), { ...identityRules(2), densityAsOfPair: false });
});

// --- ISC's copies ---

test('ISC copy: an ISC row authored NEIC at 0 s / 0 km of ComCat’s us… row joins its event, also in a swarm cell (epoch 2 only)', () => {
  const rows = [...swarm(39.25, 28.05, T), usgs('us6000qzh9', { mag: 4.6, magType: 'mb' }), isc('643893330', 'NEIC', { mag: 5.6, magType: 'mw' })];
  const e1 = remerge(rows, 1);
  assert.equal(together(e1.own, 'usgs:us6000qzh9', 'isc:643893330'), false, 'epoch 1: the swarm cell keeps them apart');
  const e2 = remerge(rows, 2);
  assert.deepEqual(e2.problems, []);
  assert.ok(together(e2.own, 'usgs:us6000qzh9', 'isc:643893330'), 'epoch 2: one event, whatever ISC’s magnitude');
  assert.ok(e2.reasons.some((r) => r.startsWith('ISC copy: isc 643893330 (Author NEIC) of usgs us6000qzh9')), e2.reasons.join('\n'));
  // ComCat's row represents the event (ISC's copy never outranks the agency's own).
  assert.equal(liveHolding(e2.own, 'usgs:us6000qzh9').chosenProvider, 'usgs');
});

test('ISC copy: within 1 s and 5 km of the named agency’s row; authored GFZ joins GEOFON’s, authored AUST GA’s (AusPass)', () => {
  const dLat = (ISC_COPY_KM - 0.5) / KM_PER_DEG;
  const rows = [
    ...swarm(39.25, 28.05, T),
    obs('geofon', 'gfz2025ppbq', { mag: 5.0, magType: 'mb' }),
    isc('645000001', 'GFZ', { eventTimeMs: T + ISC_COPY_DT_MS - 100, lat: 39.25 + dLat, mag: 5.6 }),
    obs('auspass', 'smi:local/ga2025xyz', { eventTimeMs: T + 3_600_000, lat: 39.27, mag: 4.8, magType: 'mb' }),
    isc('645000002', 'AUST', { eventTimeMs: T + 3_600_000, lat: 39.27, mag: null, magType: null }),
  ];
  const e1 = remerge(rows, 1);
  assert.equal(together(e1.own, 'geofon:gfz2025ppbq', 'isc:645000001'), false, 'epoch 1: the swarm cell keeps GFZ’s copy apart');
  assert.equal(together(e1.own, 'auspass:smi:local/ga2025xyz', 'isc:645000002'), false, 'epoch 1: the swarm cell keeps AUST’s copy apart');
  const { own, problems } = remerge(rows, 2);
  assert.deepEqual(problems, []);
  assert.ok(together(own, 'geofon:gfz2025ppbq', 'isc:645000001'));
  assert.ok(together(own, 'auspass:smi:local/ga2025xyz', 'isc:645000002'));
});

test('ISC copy: authored RSPR joins ComCat’s pr… row (not a us… row at the same origin), also in a swarm cell (epoch 2 only)', () => {
  const rows = [
    ...swarm(18.05, -66.85, T),
    usgs('pr71500001', { lat: 18.05, lon: -66.85, mag: 3.2, magType: 'md' }),
    isc('648000001', 'RSPR', { eventTimeMs: T + 300, lat: 18.05, lon: -66.85, mag: 3.5 }),
    // An RSPR copy at the origin of ComCat's us… row of another quake: RSPR's own row is the pr… one, so not a copy.
    usgs('us7000prx1', { eventTimeMs: T + 7_200_000, lat: 18.05, lon: -66.85, mag: 3.4, magType: 'mb' }),
    isc('648000002', 'RSPR', { eventTimeMs: T + 7_200_000, lat: 18.05, lon: -66.85, mag: 3.4 }),
  ];
  assert.equal(together(remerge(rows, 1).own, 'usgs:pr71500001', 'isc:648000001'), false, 'epoch 1: the swarm cell keeps them apart');
  const { own, problems, reasons } = remerge(rows, 2);
  assert.deepEqual(problems, []);
  assert.ok(together(own, 'usgs:pr71500001', 'isc:648000001'));
  assert.ok(reasons.some((r) => r.startsWith('ISC copy: isc 648000001 (Author RSPR) of usgs pr71500001')), reasons.join('\n'));
  assert.equal(together(own, 'usgs:us7000prx1', 'isc:648000002'), false);
});

test('ISC copy: another author’s row at GA’s or the pr… row’s origin is no copy (AUST and RSPR are not unnamed)', () => {
  const pr = remerge(
    [...swarm(18.05, -66.85, T), usgs('pr71500002', { lat: 18.05, lon: -66.85, mag: 3.2, magType: 'md' }), isc('649000001', 'IDC', { eventTimeMs: T + 300, lat: 18.05, lon: -66.85, mag: 3.3 })],
    2,
  );
  assert.deepEqual(pr.problems, []);
  assert.equal(together(pr.own, 'usgs:pr71500002', 'isc:649000001'), false);
  // In GA's own region (Western Australia), where the authoritative-region window does not apply.
  const ga = remerge(
    [
      ...swarm(-31.15, 116.85, T),
      obs('auspass', 'smi:local/ga2025abc', { lat: -31.13, lon: 116.86, mag: 4.8, magType: 'mb' }),
      isc('649000002', 'IDC', { eventTimeMs: T + 300, lat: -31.13, lon: 116.86, mag: 4.7 }),
    ],
    2,
  );
  assert.deepEqual(ga.problems, []);
  assert.equal(together(ga.own, 'auspass:smi:local/ga2025abc', 'isc:649000002'), false);
});

test('ISC copy: another author’s ISC row equal to NEIC’s within 1 s / 5 km joins when the magnitudes are within 1.0, not beyond', () => {
  const rows = [...swarm(39.25, 28.05, T), usgs('us7000near', { mag: 4.6, magType: 'mb' }), isc('646000001', 'IDC', { eventTimeMs: T + 400, mag: 4.3 })];
  assert.ok(together(remerge(rows, 2).own, 'usgs:us7000near', 'isc:646000001'));
  const far = [...swarm(39.25, 28.05, T), usgs('us7000near', { mag: 4.6, magType: 'mb' }), isc('646000001', 'IDC', { eventTimeMs: T + 400, mag: 2.9 })];
  assert.equal(together(remerge(far, 2).own, 'usgs:us7000near', 'isc:646000001'), false);
});

test('ISC copy: a genuinely distinct ISC event stays apart (beyond 1 s / 5 km in a swarm cell, or a ComCat row of another network)', () => {
  const rows = [
    ...swarm(39.25, 28.05, T),
    // A neighbouring aftershock NEIC located 2.5 s and 8 km away: a separate ISC event, not a copy.
    usgs('us7000main', { mag: 4.8, magType: 'mb' }),
    isc('647000001', 'NEIC', { eventTimeMs: T + 2_500, lat: 39.25 + 8 / KM_PER_DEG, mag: 4.7 }),
    // NEIC's copy beside ComCat's `ak` row of another quake at the same origin: not NEIC's row.
    usgs('ak0251abcd', { eventTimeMs: T + 7_200_000, mag: 3.1, magType: 'ml' }),
    isc('647000002', 'NEIC', { eventTimeMs: T + 7_200_000, mag: 3.0 }),
  ];
  const { own, problems } = remerge(rows, 2);
  assert.deepEqual(problems, []);
  assert.equal(together(own, 'usgs:us7000main', 'isc:647000001'), false);
  assert.equal(together(own, 'usgs:ak0251abcd', 'isc:647000002'), false);
});

test('ISC copy: two ISC ids of one quake (NEIC’s origin and IDC’s) do not keep its events apart; two ComCat events never weld', () => {
  // The Kamchatka M6.0 of 2025-08-09 14:04: ISC listed NEIC's origin (643893330) and IDC's (643893547) as two events.
  const rows = [
    ...swarm(50.07, 159.74, T),
    usgs('us6000qzh9', { lat: 50.0723, lon: 159.7364, mag: 6.0 }),
    isc('643893330', 'NEIC', { lat: 50.0723, lon: 159.7364, mag: 6.0 }),
    isc('643893547', 'IDC', { eventTimeMs: T + 1_519, lat: 50.1188, lon: 159.6632, mag: 6.03 }),
    // Another ComCat quake 20 s later, 15 km away, with its own NEIC copy: never welded to the first.
    usgs('us6000qzhb', { eventTimeMs: T + 20_000, lat: 50.2, lon: 159.74, mag: 5.6 }),
    isc('643893600', 'NEIC', { eventTimeMs: T + 20_000, lat: 50.2, lon: 159.74, mag: 5.6 }),
  ];
  const own = split(rows);
  const anchorBefore = anchorCounts(own);
  const { own: after, problems } = remerge(rows, 2);
  assert.deepEqual(problems, []);
  assert.ok(together(after, 'usgs:us6000qzh9', 'isc:643893547'), 'IDC’s ISC event joins the quake');
  assert.ok(together(after, 'usgs:us6000qzhb', 'isc:643893600'));
  assert.equal(together(after, 'usgs:us6000qzh9', 'usgs:us6000qzhb'), false);
  assert.deepEqual(anchorCounts(after), { ...anchorBefore, e45: anchorCounts(after).e45, e6: anchorCounts(after).e6 });
  assert.equal(anchorCounts(after).u45, 2);
});

// --- the authoritative-region window ---

test('authority window: shares the statistics’ region test (stats isOutOfRegion = authority.ts outsideAuthority)', () => {
  const cases: [string[], number, number, boolean][] = [
    [['geonet'], -22.29, -177.7, true], // Tonga: outside GeoNet's box and its 5° margin
    [['geonet'], -30.85, -177.44, false], // Kermadec: inside the margin (lon 182.56)
    [['geonet', 'usgs'], -22.29, -177.7, false], // a global network's row: never outside
    [['renass', 'resif'], -69.89, -13.77, true],
    [['ingv'], 42, 13, false],
    [['nosuchprovider'], 0, 0, false], // no region: global
  ];
  for (const [sources, lat, lon, outside] of cases) {
    assert.equal(outsideAuthority(sources, lat, lon), outside, sources.join('+'));
    assert.equal(isOutOfRegion({ magE2: 450, latE4: Math.round(lat * 1e4), lonE4: Math.round(lon * 1e4), sources }), outside, sources.join('+'));
    assert.equal(isOutOfRegion({ magE2: 449, latE4: Math.round(lat * 1e4), lonE4: Math.round(lon * 1e4), sources }), false);
  }
});

test('authority window: an out-of-region regional-only M4.5+ solution joins the global agencies’ event (epoch 2 only)', () => {
  // GeoNet's solution of a Tonga quake, 150 km and 4 s from ComCat's, M6.5 for ComCat's M5.7 (2013-02-26 style).
  const rows = [
    usgs('usp000tonga', { lat: -22.29, lon: -177.7, mag: 5.7, magType: 'mb' }),
    obs('geonet', '2013p153604', { eventTimeMs: T + 4_000, lat: -22.29 + 150 / KM_PER_DEG, lon: -177.7, mag: 6.5, magType: 'mw' }),
  ];
  assert.equal(together(remerge(rows, 1).own, 'usgs:usp000tonga', 'geonet:2013p153604'), false);
  const { own, problems, reasons } = remerge(rows, 2);
  assert.deepEqual(problems, []);
  assert.ok(together(own, 'usgs:usp000tonga', 'geonet:2013p153604'));
  assert.equal(liveHolding(own, 'usgs:usp000tonga').chosenProvider, 'usgs', 'ComCat’s solution represents the quake');
  assert.ok(reasons.some((r) => r.includes('authoritative-region window (geonet outside its region)')), reasons.join('\n'));
});

test('authority window: limits (30 s, 200 km, |ΔM| 1.0; 300 km and 1.5 from M7) and a global partner only', () => {
  const base = (over: Partial<RawObs>, partner: RawObs = usgs('us7000part', { lat: -22.29, lon: -177.7, mag: 5.7, magType: 'mb' })): RawObs[] => [
    partner,
    obs('geonet', '2025pgeo', { eventTimeMs: T + 4_000, lat: -22.29 + 150 / KM_PER_DEG, lon: -177.7, mag: 6.2, magType: 'mw', ...over }),
  ];
  const joined = (rows: RawObs[]): boolean => together(remerge(rows, 2).own, `${rows[0]!.provider}:${rows[0]!.providerEventId}`, 'geonet:2025pgeo');
  assert.ok(joined(base({})));
  assert.equal(joined(base({ eventTimeMs: T + AUTHORITY_WINDOW.maxDtMs + 1_000 })), false, 'beyond 30 s');
  assert.equal(joined(base({ lat: -22.29 + 230 / KM_PER_DEG })), false, 'beyond 200 km');
  assert.equal(joined(base({ mag: 6.9 })), false, '|ΔM| 1.2 > 1.0');
  // A great quake: 280 km and |ΔM| 1.4 still join.
  assert.ok(joined(base({ lat: -22.29 + 280 / KM_PER_DEG, mag: 7.4 }, usgs('us7000great', { lat: -22.29, lon: -177.7, mag: 6.0 }))));
  // The partner must be a global agency's own solution: another regional agency's event (SSN's, out of its region too) is not one.
  const regionalPartner = obs('mexico', 'ssn2025x', { lat: -22.29, lon: -177.7, mag: 5.9, magType: 'mw' });
  assert.equal(joined(base({}, regionalPartner)), false);
});

test('authority window: a regional solution inside its own region is never joined by it (a GeoNet M5 in New Zealand stays apart)', () => {
  const rows = [
    usgs('us7000nz01', { lat: -41.7, lon: 174.1, mag: 4.9, magType: 'mb' }),
    obs('geonet', '2025pnz01', { eventTimeMs: T + 6_000, lat: -41.7 + 120 / KM_PER_DEG, lon: 174.1, mag: 5.0, magType: 'ml' }),
  ];
  const { own, problems } = remerge(rows, 2);
  assert.deepEqual(problems, []);
  assert.equal(together(own, 'usgs:us7000nz01', 'geonet:2025pnz01'), false);
  assert.equal(own.filter((n) => n.state === 'live').length, 2);
});

test('authority window: never folds a ComCat-anchored event away and joins the regional solution to the nearer of two ComCat quakes', () => {
  const rows = [
    usgs('us7000aaaa', { lat: -22.0, lon: -177.0, mag: 5.6, magType: 'mb' }),
    usgs('us7000bbbb', { eventTimeMs: T + 10_000, lat: -22.6, lon: -177.0, mag: 5.5, magType: 'mb' }),
    // Both ComCat quakes are inside GeoNet's window (20 s / 107 km and 10 s / 40 km): the nearer takes it.
    obs('geonet', '2025ptwo', { eventTimeMs: T + 20_000, lat: -22.6 + 40 / KM_PER_DEG, lon: -177.0, mag: 6.1, magType: 'mw' }),
  ];
  const before = anchorCounts(split(rows));
  const { own, problems } = remerge(rows, 2);
  assert.deepEqual(problems, []);
  assert.ok(together(own, 'usgs:us7000bbbb', 'geonet:2025ptwo'));
  assert.equal(together(own, 'usgs:us7000aaaa', 'usgs:us7000bbbb'), false);
  assert.equal(anchorCounts(own).u45, before.u45);
  assert.equal(anchorCounts(own).welds45, 0);
  for (const n of own.filter((x) => x.provenance.some((r) => r.provider === 'usgs'))) assert.equal(n.state, 'live', `${n.feedId} keeps its ComCat row live`);
});

test('authority window: of two global partners the one of the regional solution’s size wins over a nearer smaller one', () => {
  // GeoNet's M4.7 of a Tonga quake: ComCat's M4.7 event 90 km away, and an ISC-only event of IDC's M3.7 (the same quake,
  // IDC's mb runs low) 80 km away. Without the magnitude in the ranking the ISC event took the GeoNet solution and the
  // pair stayed beside ComCat's event.
  const rows = [
    usgs('us7000sumg', { lat: -22.29, lon: -177.7, mag: 4.7, magType: 'mb' }),
    isc('650000001', 'IDC', { eventTimeMs: T + 200, lat: -22.29 + 12 / KM_PER_DEG, lon: -177.7, mag: 3.7 }),
    obs('geonet', '2026pfar01', { eventTimeMs: T + 2_000, lat: -22.29 + 90 / KM_PER_DEG, lon: -177.7, mag: 4.7, magType: 'mb' }),
  ];
  const { own, problems } = remerge(rows, 2);
  assert.deepEqual(problems, []);
  assert.ok(together(own, 'usgs:us7000sumg', 'geonet:2026pfar01'));
  assert.equal(together(own, 'isc:650000001', 'geonet:2026pfar01'), false);
});

test('authority window, live merge pass: a GeoNet solution revised to M4.5+ is found by ComCat’s event that arrives later', () => {
  // The regional sides are tracked as the index changes (Resolver.authoritySideIds): a revision in place (same grid
  // cell) lifts GeoNet's distant solution to M6.2 and makes it one; ComCat's event, minted after it (a fresh mint runs no
  // merge pass), finds it from the global side on its own next revision.
  const run = (rules: IdentityRules): boolean => {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, T + 3_600_000, { rules });
    const at = { eventTimeMs: T + 4_000, lat: -22.29 + 150 / KM_PER_DEG, lon: -177.7, magType: 'mw' };
    r.ingest(obs('geonet', '2025plive', { ...at, mag: 4.3, providerUpdatedMs: T + 60_000 }), IT);
    r.ingest(obs('geonet', '2025plive', { ...at, mag: 6.2, providerUpdatedMs: T + 600_000 }), IT);
    const comcat = { lat: -22.29, lon: -177.7, magType: 'mb' };
    r.ingest(usgs('us7000live', { ...comcat, mag: 5.7, providerUpdatedMs: T + 700_000 }), IT);
    r.ingest(usgs('us7000live', { ...comcat, mag: 5.8, providerUpdatedMs: T + 900_000 }), IT);
    const holding = (k: string): string => [...map.values()].find((n) => n.state === 'live' && n.aliases.includes(k))!.feedId;
    return holding('geonet:2025plive') === holding('usgs:us7000live');
  };
  assert.equal(run(liveIdentityRules(1)), false);
  assert.equal(run(liveIdentityRules(2)), true);
});

// --- density as of the pair, large quakes in swarm cells ---

test('large quakes in a swarm cell: two agencies’ M6.1 solutions 4 km apart join; small swarm members stay apart', () => {
  // The Sındırgı M6.1 of 2025-08-10 16:53: a cell with 64 events in the week before it.
  const rows = [
    ...swarm(39.25, 28.05, T),
    usgs('us6000r0yz', { lat: 39.3709, lon: 28.0168, mag: 6.1 }),
    obs('geofon', 'gfz2025ppbq', { eventTimeMs: T + 110, lat: 39.28, lon: 28.052, mag: 6.13, magType: 'mw' }),
    obs('emsc', '20250810_0000200', { eventTimeMs: T + 630, lat: 39.278, lon: 28.0679, mag: 6.1, magType: 'mw' }),
    // Two small quakes of the swarm a second apart, 2 km: still the swarm guard's (no shared id).
    obs('emsc', '20250803_small', { eventTimeMs: T - 2 * DAY, lat: 39.26, lon: 28.06, mag: 2.3, magType: 'ml' }),
    obs('geofon', 'gfz2025small', { eventTimeMs: T - 2 * DAY + 1_000, lat: 39.27, lon: 28.06, mag: 2.4, magType: 'ml' }),
  ];
  const e1 = remerge(rows, 1);
  assert.equal(together(e1.own, 'usgs:us6000r0yz', 'geofon:gfz2025ppbq'), false, 'epoch 1: kept apart by the swarm guard');
  const { own, problems } = remerge(rows, 2);
  assert.deepEqual(problems, []);
  assert.ok(together(own, 'usgs:us6000r0yz', 'geofon:gfz2025ppbq'));
  assert.ok(together(own, 'usgs:us6000r0yz', 'emsc:20250810_0000200'));
  assert.equal(together(own, 'emsc:20250803_small', 'geofon:gfz2025small'), false);
});

test('density as of the pair: a quake’s own aftershocks no longer make its cell a swarm cell for its M4.8 solutions (re-merge only)', () => {
  // A moderate quake, then 60 aftershocks within the next hours: the cell is dense at the window's end, not at the quake.
  const after = Array.from({ length: SWARM_CELL_ABSOLUTE + 10 }, (_, i) => obs('afad', `as${i}`, { eventTimeMs: T + 60_000 + i * 120_000, lat: 39.25 + (i % 4) * 0.01, mag: 2.0, magType: 'ml' }));
  const rows = [...after, usgs('us7000mod1', { mag: 4.8, magType: 'mb' }), obs('emsc', '20250811_mod1', { eventTimeMs: T + 3_000, lat: 39.25 + 12 / KM_PER_DEG, mag: 4.9, magType: 'mb' })];
  assert.equal(together(remerge(rows, 1).own, 'usgs:us7000mod1', 'emsc:20250811_mod1'), false);
  assert.ok(together(remerge(rows, 2).own, 'usgs:us7000mod1', 'emsc:20250811_mod1'));
  // swarmCellsAsOf counts the 7 days up to the time asked, both ends inclusive of the origin itself.
  const dense = swarmCellsAsOf(split(after));
  assert.equal(dense(39.25, 28.05, T), false);
  assert.equal(dense(39.25, 28.05, T + 60_000 + (SWARM_CELL_ABSOLUTE - 1) * 120_000), true);
  assert.equal(dense(39.25, 28.05, T + 8 * DAY + 60_000 + (SWARM_CELL_ABSOLUTE - 1) * 120_000), false, 'older than 7 days: not counted');
});

test('live Resolver: the epoch’s rules (none at epoch 1, the default while REMERGE_EPOCH is 1): an ISC copy in a swarm cell joins in a live heal from epoch 2', () => {
  const heal = (rules?: IdentityRules): boolean => {
    const map = new Map<string, EventNode>();
    for (const n of split([...swarm(39.25, 28.05, T), usgs('us6000qzh9', { mag: 4.6, magType: 'mb' }), isc('643893330', 'NEIC', { mag: 4.7 })])) map.set(n.feedId, n);
    new Resolver(map, prio, cfg, T + DAY, rules ? { rules } : {}).heal(IT);
    const holding = (k: string): string => [...map.values()].find((n) => n.state === 'live' && n.aliases.includes(k))!.feedId;
    return holding('usgs:us6000qzh9') === holding('isc:643893330');
  };
  assert.equal(heal(liveIdentityRules(1)), false, 'epoch 1 rules: apart');
  // The epoch 2 rules (what raising REMERGE_EPOCH does live): the same heal joins them.
  assert.equal(heal(liveIdentityRules(2)), true, 'epoch 2 rules: one event');
  // The default is the current epoch's.
  assert.equal(heal(), REMERGE_EPOCH >= 2);
});
