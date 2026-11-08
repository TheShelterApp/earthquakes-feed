import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadRegistry, priorityMap } from '../src/providers.js';
import {
  AREA_COLUMNS,
  CELL_COUNT,
  DAY_COLUMNS,
  MAG_EDGES_E2,
  YEAR_COLUMNS,
  buildEventTable,
  cellCentre,
  cellOf,
  dayRows,
  dayTableFromRows,
  dayTableJson,
  isNonEarthquake,
  magBin,
  parseNdjson,
  reconcileRows,
  statsEventOf,
  tableTimes,
  type StatsEvent,
} from '../src/stats-table.js';

// The row rule and the event table (APIs.md, Statistics): what the app's Statistics screen reads instead of whole day
// files. The golden is 189 real lines of the 2026-11-06 partition (origin/data 2030118872a, 2026-11-08): every
// non-live, filtered and skipped line, one line per chosen provider and per SeisComP author kind, the rest by stride.

const DAY = '2026-11-06';
const T0 = Date.parse(`${DAY}T00:00:00Z`);
const ID = (n: number): string => `efd_01M6Q2J4WG${String(n).padStart(16, '0')}`;

type F = { id: string; type: 'Feature'; geometry: { coordinates: number[] }; properties: Record<string, unknown> };
function feat(n: number, over: { props?: Record<string, unknown>; feed?: Record<string, unknown>; coords?: number[] } = {}): F {
  const time = T0 + n * 60_000;
  return {
    type: 'Feature',
    id: ID(n),
    geometry: { coordinates: over.coords ?? [12.34567, -45.67891, 10.25] },
    properties: {
      mag: 3.27,
      place: `place ${n}`,
      time,
      updated: time + 60_000,
      status: 'automatic',
      type: 'earthquake',
      tsunami: 0,
      felt: null,
      cdi: null,
      mmi: null,
      alert: null,
      nst: 12,
      rms: 0.4567,
      ...over.props,
      feed: {
        feed_id: ID(n),
        state: 'live',
        tombstone: false,
        chosen_provider: 'usgs',
        first_ingest_time: new Date(time + 95_400).toISOString(),
        provenance: [{ provider: 'usgs', status: 'reviewed', chosen: true, fields: {} }],
        ...over.feed,
      },
    },
  };
}

test('isNonEarthquake: the app\'s cases word for word', () => {
  const g = JSON.parse(readFileSync('tests/fixtures/stats-nonearthquake.json', 'utf8')) as { nonEarthquake: string[]; earthquake: (string | null)[] };
  for (const t of g.nonEarthquake) assert.equal(isNonEarthquake(t), true, t);
  for (const t of g.earthquake) assert.equal(isNonEarthquake(t), false, String(t));
  assert.equal(isNonEarthquake('  Quarry Blast\t'), true, 'spaces and tabs trimmed, case folded');
  assert.equal(isNonEarthquake(' km '), true);
  assert.equal(isNonEarthquake('km\n'), false, 'only spaces and tabs are trimmed, as Swift .whitespaces');
  assert.equal(isNonEarthquake(undefined), false);
  assert.equal(isNonEarthquake(3), false);
});

test('row rule: live only; filtered by type; skipped without a usable magnitude or position', () => {
  assert.equal(statsEventOf(feat(1, { feed: { state: 'superseded', superseded_by: ID(2) } })), null);
  assert.equal(statsEventOf(feat(1, { feed: { state: 'tombstoned', tombstone: true } })), null);
  assert.equal(statsEventOf(feat(1, { feed: { state: 'live', tombstone: true } })), null);
  assert.deepEqual(statsEventOf(feat(1, { props: { type: 'quarry blast' } })), { kind: 'filtered', timeMs: T0 + 60_000 });
  // A filtered event needs no magnitude.
  assert.deepEqual(statsEventOf(feat(1, { props: { type: 'explosion', mag: null } })), { kind: 'filtered', timeMs: T0 + 60_000 });
  for (const props of [{ mag: null }, { mag: -2.01 }, { mag: 10.51 }, { mag: Number.NaN }]) assert.deepEqual(statsEventOf(feat(1, { props })), { kind: 'skip' }, JSON.stringify(props));
  for (const m of [-2, 10.5]) assert.equal(statsEventOf(feat(1, { props: { mag: m } }))?.kind, 'event', `mag ${m} is in range`);
  for (const coords of [[0, 90.1], [180.1, 0], [-180.1, 0], [0, -90.1], [0]]) assert.deepEqual(statsEventOf(feat(1, { coords })), { kind: 'skip' }, JSON.stringify(coords));
  assert.deepEqual(statsEventOf(feat(1, { coords: [0, 0], props: { mag: 0 } })), { kind: 'skip' }, 'the 0,0 M0 placeholder');
  assert.equal(statsEventOf(feat(1, { coords: [0, 0], props: { mag: 0.1 } }))?.kind, 'event');
  assert.equal(statsEventOf(feat(1, { coords: [180, 90] }))?.kind, 'event');
});

test('row rule: integer scales, rounding and the derived columns', () => {
  const r = statsEventOf(feat(3, { props: { mag: 4.355, mmi: 5.46, cdi: 3.1, felt: 12, tsunami: 1, alert: 'green', place: '' } }));
  assert.equal(r?.kind, 'event');
  const ev = (r as { ev: StatsEvent }).ev;
  assert.deepEqual(ev, {
    id: ID(3),
    timeMs: T0 + 180_000,
    latE4: -456789,
    lonE4: 123457,
    magE2: Math.round(4.355 * 100),
    depthE2: 1025,
    place: null,
    provider: 'usgs',
    felt: 12,
    intensityE1: 55,
    alert: 'green',
    tsunami: 1,
    status: 1,
    upd: 0,
    nst: 12,
    rmsE3: 457,
    delay: 95,
    sources: ['usgs'],
  });
  // cdi when there is no mmi; no depth without a third coordinate.
  const c = statsEventOf(feat(3, { props: { cdi: 3.14 }, coords: [1, 2] })) as { ev: StatsEvent };
  assert.equal(c.ev.intensityE1, 31);
  assert.equal(c.ev.depthE2, null);
});

test('upd: strictly more than one hour between time and updated', () => {
  const upd = (dt: number | null): unknown => (statsEventOf(feat(1, { props: { updated: dt == null ? null : T0 + 60_000 + dt } })) as { ev: StatsEvent }).ev.upd;
  assert.equal(upd(3_600_000), 0);
  assert.equal(upd(3_600_001), 1);
  assert.equal(upd(0), 0);
  assert.equal(upd(null), null);
});

test('status from the chosen provenance row: usgs status, SeisComP authors, unsaid', () => {
  const status = (feed: Record<string, unknown>, props: Record<string, unknown> = {}): unknown => (statsEventOf(feat(1, { feed, props })) as { ev: StatsEvent }).ev.status;
  assert.equal(status({ provenance: [{ provider: 'usgs', status: 'automatic', chosen: true, fields: {} }] }), 0);
  assert.equal(status({ provenance: [{ provider: 'usgs', status: 'reviewed', chosen: true, fields: {} }] }), 1);
  // The chosen row decides, not the first.
  assert.equal(status({ provenance: [{ provider: 'emsc', status: null, chosen: false }, { provider: 'usgs', status: 'automatic', chosen: true }] }), 0);
  // RéNaSS: the Author column.
  assert.equal(status({ chosen_provider: 'renass', provenance: [{ provider: 'renass', status: null, chosen: true, fields: { Author: 'scautoloc@renass' } }] }), 0);
  assert.equal(status({ chosen_provider: 'renass', provenance: [{ provider: 'renass', status: null, chosen: true, fields: { Author: 'jdupont' } }] }), 1);
  assert.equal(status({ chosen_provider: 'renass', provenance: [{ provider: 'renass', status: null, chosen: true, fields: { Author: '--' } }] }), null);
  // EMSC says nothing.
  assert.equal(status({ chosen_provider: 'emsc', provenance: [{ provider: 'emsc', status: null, chosen: true, fields: {} }] }), null);
  // No provenance (a compact feature): the top-level status.
  assert.equal(status({ provenance: undefined }, { status: 'reviewed' }), 1);
});

test('event table: sort by (time, id), delta times round trip, providers indexed, columns per kind', () => {
  const evs = [5, 1, 3, 3].map((n, i) => ({ ...(statsEventOf(feat(n, { feed: { chosen_provider: ['usgs', 'emsc', 'jma', 'emsc'][i] } })) as { ev: StatsEvent }).ev, id: ID(10 - i) }));
  const t = buildEventTable('day', T0, evs, DAY_COLUMNS);
  assert.deepEqual(t.id, [ID(9), ID(7), ID(8), ID(10)], 'two rows at the same time sort by id');
  assert.deepEqual(tableTimes(t), [T0 + 60_000, T0 + 180_000, T0 + 180_000, T0 + 300_000]);
  assert.deepEqual(t.t, [60_000, 120_000, 0, 120_000]);
  assert.deepEqual(t.providers, ['emsc', 'jma', 'usgs']);
  assert.deepEqual(t.prov!.map((i) => t.providers[i]), ['emsc', 'emsc', 'jma', 'usgs']);
  assert.deepEqual(Object.keys(t), ['format', 'kind', 't0', 'count', 'providers', 'id', 't', 'lat', 'lon', 'mag', 'depth', 'place', 'prov', 'felt', 'intensity', 'alert', 'tsunami', 'status', 'upd', 'nst', 'rms', 'delay']);
  assert.deepEqual(Object.keys(buildEventTable('year', T0, evs, YEAR_COLUMNS)).slice(10), ['depth', 'place', 'prov', 'felt', 'intensity', 'alert', 'tsunami', 'status', 'upd', 'nst', 'rms']);
  assert.deepEqual(Object.keys(buildEventTable('area', T0, evs, [...AREA_COLUMNS].reverse())).slice(10), ['depth', 'place', 'prov'], 'fixed order whatever the given order');
  assert.throws(() => buildEventTable('day', T0 + 120_000, evs, []), /before t0/);
  const empty = buildEventTable('day', T0, [], DAY_COLUMNS);
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.delay, []);
});

test('day table: the count invariant, byte determinism, another day is an error', () => {
  const feats = [
    feat(1),
    feat(2, { props: { type: 'explosion' } }),
    feat(3, { props: { mag: null } }),
    feat(4, { feed: { state: 'superseded' } }),
    feat(5, { feed: { state: 'tombstoned', tombstone: true } }),
    feat(6, { props: { type: 'quarry blast' } }),
    feat(7),
  ];
  const a = dayTableJson(DAY, feats);
  assert.deepEqual([a.count, a.filtered, a.skipped, a.collapsed], [2, 2, 1, 0]);
  const live = feats.filter((f) => (f.properties['feed'] as { state: string }).state === 'live' && (f.properties['feed'] as { tombstone: boolean }).tombstone !== true).length;
  assert.equal(a.count + a.filtered + a.skipped + a.collapsed, live);
  const doc = JSON.parse(a.body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(doc).slice(0, 4), ['format', 'kind', 'date', 't0']);
  assert.deepEqual(Object.keys(doc).slice(-4), ['filtered', 'skipped', 'collapsed', 'attribution']);
  assert.deepEqual(doc['filtered'], [120_000, 360_000]);
  assert.equal(dayTableJson(DAY, [...feats].reverse()).body, a.body, 'input order does not matter');
  assert.throws(() => dayTableJson('2026-11-05', feats), /another day/);
});

test('golden: 189 real lines of 2026-11-06 give the committed table byte for byte', () => {
  const feats = parseNdjson(readFileSync('tests/fixtures/stats-2026-11-06.ndjson', 'utf8'));
  const got = dayTableJson(DAY, feats, priorityMap(loadRegistry('providers/registry.json')));
  const want = readFileSync('tests/fixtures/stats-2026-11-06.expected.json', 'utf8');
  assert.equal(got.body, want);
  let live = 0;
  for (const f of feats as { properties: { feed: { state: string; tombstone?: boolean } } }[]) if (f.properties.feed.state === 'live' && f.properties.feed.tombstone !== true) live++;
  assert.equal(got.count + got.filtered + got.skipped + got.collapsed, live);
  assert.ok(got.filtered > 0 && got.skipped > 0 && live < feats.length, 'the fixture covers filtered, skipped and retired lines');
  const doc = JSON.parse(want) as { status: (number | null)[]; upd: number[]; providers: string[] };
  assert.ok(doc.status.includes(0) && doc.status.includes(1) && doc.status.includes(null));
  assert.ok(doc.upd.includes(0) && doc.upd.includes(1));
  assert.ok(doc.providers.length >= 20);
});

test('magBin: the year bins on mag x 100', () => {
  assert.deepEqual([...MAG_EDGES_E2], [200, 250, 300, 350, 400, 450, 500, 600, 700]);
  assert.deepEqual([-200, 199, 200, 249, 250, 449, 450, 499, 500, 599, 600, 699, 700, 1050].map(magBin), [0, 0, 1, 1, 2, 5, 6, 6, 7, 7, 8, 8, 9, 9]);
});

test('cellOf: poles, antimeridian and the centre', () => {
  assert.equal(Math.floor(cellOf(900_000, 0) / 3600), 1799, 'lat 90 joins the top row');
  assert.equal(Math.floor(cellOf(-900_000, 0) / 3600), 0);
  assert.equal(cellOf(0, 1_800_000) % 3600, 0, 'lon 180 wraps to column 0');
  assert.equal(cellOf(0, -1_800_000) % 3600, 0);
  assert.equal(cellOf(0, -1_800_001) % 3600, 3599, 'just west of -180 wraps to the last column');
  assert.equal(cellOf(0, 1_799_999) % 3600, 3599);
  assert.ok(cellOf(900_000, 1_799_999) < CELL_COUNT);
  const c = cellOf(355_000, 1_397_000);
  const { lat, lon } = cellCentre(c);
  assert.ok(Math.abs(lat - 35.55) < 1e-9 && Math.abs(lon - 139.75) < 1e-9, `${lat},${lon}`);
});

// --- the statistical reconciliation (rule v1) ---

const KM = 1 / 111.195;
function row(n: number, provider: string, o: { dt?: number; dkm?: number; mag?: number; sources?: string[] } = {}): StatsEvent {
  const ev = (statsEventOf(feat(n, { props: { mag: o.mag ?? 5.0, time: T0 + 3_600_000 + (o.dt ?? 0) }, coords: [120, 10 + (o.dkm ?? 0) * KM, 10], feed: { chosen_provider: provider, provenance: (o.sources ?? [provider]).map((p, i) => ({ provider: p, status: 'reviewed', chosen: i === 0, fields: {} })) } })) as { ev: StatsEvent }).ev;
  return ev;
}
const prio = new Map([['usgs', 0], ['emsc', 1], ['geofon', 2], ['jma', 3]]);

test('reconcile: one quake reported by two catalogues counts once; the usgs holder is the representative', () => {
  const a = row(1, 'emsc', { mag: 6.2 });
  const b = row(2, 'geofon', { dt: 3_000, dkm: 20, mag: 6.0, sources: ['geofon', 'usgs'] });
  const d = reconcileRows([a, b], prio);
  assert.deepEqual([...d], [[a.id, b.id]], 'the member with a usgs row stays even though emsc ranks first');
});

test('reconcile: the limits (60 s, 100 km, |dM| 1.0, one member M4.5+) and never two events of one provider', () => {
  const base = row(1, 'usgs', { mag: 5.0 });
  const link = (o: Parameters<typeof row>[2]): number => reconcileRows([base, row(2, 'emsc', o)], prio).size;
  assert.equal(link({ dt: 60_000 }), 1);
  assert.equal(link({ dt: 60_001 }), 0);
  assert.equal(link({ dkm: 99.9 }), 1);
  assert.equal(link({ dkm: 100.5 }), 0);
  assert.equal(link({ mag: 4.0 }), 1, '|dM| exactly 1.0');
  assert.equal(link({ mag: 3.99 }), 0);
  assert.equal(reconcileRows([row(1, 'usgs', { mag: 4.49 }), row(2, 'emsc', { mag: 4.4 })], prio).size, 0, 'no member M4.5+');
  assert.equal(reconcileRows([row(1, 'usgs', { mag: 4.5 }), row(2, 'emsc', { mag: 3.5 })], prio).size, 1);
  assert.equal(link({ sources: ['emsc', 'usgs'] }), 0, 'they share a provider');
  assert.equal(reconcileRows([row(1, 'emsc'), row(2, 'emsc', { dt: 5_000 })], prio).size, 0, 'one catalogue is self-consistent');
});

test('reconcile: single link under the shared-provider constraint; without usgs the provider priority, then time, then id', () => {
  // usgs A, emsc B 10 s later, usgs C 20 s after A: B joins A (closest first); C shares usgs with the group and stays.
  const a = row(1, 'usgs');
  const b = row(2, 'emsc', { dt: 10_000 });
  const c = row(3, 'usgs', { dt: 20_000 });
  assert.deepEqual([...reconcileRows([c, b, a], prio)], [[b.id, a.id]]);
  // Chains: jma - geofon - emsc, each pair 30 s apart: one group, emsc ranks first.
  const j = row(4, 'jma');
  const g = row(5, 'geofon', { dt: 30_000 });
  const e = row(6, 'emsc', { dt: 60_000 });
  const d = reconcileRows([j, g, e], prio);
  assert.deepEqual([...d].sort(), [[g.id, e.id], [j.id, e.id]].sort());
  // Two unranked providers: the earlier origin stays.
  const x = row(7, 'aaa', { dt: 1_000 });
  const y = row(8, 'bbb');
  assert.deepEqual([...reconcileRows([x, y], prio)], [[x.id, y.id]]);
  assert.deepEqual([...reconcileRows([y, x], prio)], [[x.id, y.id]], 'input order does not matter');
});

test('reconcile: across midnight in the window; the day table counts collapsed and keeps the invariant', () => {
  const late = feat(1, { props: { mag: 5.5, time: T0 + 86_399_000 }, feed: { chosen_provider: 'emsc', provenance: [{ provider: 'emsc', chosen: true, fields: {} }] } });
  const nextDay = '2026-11-07';
  const early = feat(2, { props: { mag: 5.6, time: T0 + 86_400_000 + 5_000 } });
  const d1 = dayRows(DAY, [late, feat(3)]);
  const d2 = dayRows(nextDay, [early]);
  const dropped = reconcileRows([...d1.rows, ...d2.rows], prio);
  const t1 = dayTableFromRows(d1, dropped);
  const t2 = dayTableFromRows(d2, dropped);
  assert.deepEqual([t1.count, t1.collapsed, t2.count, t2.collapsed], [1, 1, 1, 0], 'the usgs report on the 7th stays');
  assert.equal(t1.count + t1.filtered + t1.skipped + t1.collapsed, 2);
  assert.equal((JSON.parse(t1.body) as { collapsed: number }).collapsed, 1);
});
