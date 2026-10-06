import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LARGE_EVENT_MAX_KM, MODERATE_EVENT_FULL_KM_MAG } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';

// PF-5h (5), round 15: regional agencies locate distant M5 quakes 38–48 km from where USGS, EMSC and GFZ put them, beyond
// the moderate-event window's 37–42 km at M5.0–5.2 (40 km at M5.0, shrunk by |ΔM|). From MODERATE_EVENT_FULL_KM_MAG on
// the window reaches LARGE_EVENT_MAX_KM whatever |ΔM|. The fixture is production's: the 7 pairs of the hot window the
// event map of origin/data dae9220725 held as two live events each, with every live or retired event within 2 min and
// 150 km of them.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const NOW = Date.parse('2026-10-06T02:52:07Z');
const INGEST = '2026-10-06T02:52:07.000Z';
const KM_PER_DEG = 111.195;
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const storedMap = (): Map<string, EventNode> =>
  new Map(
    readFileSync(here('fixtures/m5-scatter-2026-10-06-event-map.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as EventNode)
      .map((n) => [n.feedId, n]),
  );
/** Each fold of production's pairs: the loser and the survivor (the event a regional agency's solution stood beside). */
const PAIRS: [string, string][] = [
  ['efd_01M3PK3XXGQCMFFSGFNFKBKJB6', 'efd_01M3PJWKHGHMEYK8GH3ADWPX2Q'], // 2026-09-29 Tonga: GeoNet M5.1, 47.4 km
  ['efd_01M3RP35X0QMF2BKKJSJC3DRK5', 'efd_01M3RP436GDXWTD4BCEX14KTYC'], // 2026-09-30 New Britain: RéNaSS / RESIF M5.06, 40.8 km
  ['efd_01M3XDXWDGD73G65NDM4ZJPN1E', 'efd_01M3XDV4H0N8HJDTWF2NNEH7SQ'], // 2026-10-02 south of Fiji: GeoNet M5.2, 40.0 km
  ['efd_01M3YXTFCG2CGDH4S9BHQP7WST', 'efd_01M3YXTFCG4G7JJR09W313K2C1'], // 2026-10-02 Kamchatka: USGS M5.0 / GFZ M5.18, 38.3 km
  ['efd_01M3Z6ACJ0N4ZCKVRK7MPFX54Z', 'efd_01M3Z6B9VG8WRYPWFT3HAQNXQT'], // 2026-10-02 Kamchatka: GA M5.1, 45.7 km
  ['efd_01M3ZV6Q90YCBXHYZJMEPCFYVY', 'efd_01M3ZV6Q9011ZHEJZ5D27ZPTSR'], // 2026-10-03 Kamchatka: GA / RéNaSS M5.08, 44.8 km
  ['efd_01M41ZPG00FRHHN32R6THEQFHP', 'efd_01M41ZPG00PXAT4Q0673DXYEDD'], // 2026-10-03 Sumbawa: USP M5.44, 45.4 km
];

test('m5 scatter: the regular heal folds the 7 pairs of production in one run, then nothing', () => {
  assert.equal(MODERATE_EVENT_FULL_KM_MAG, 5.0);
  const map = storedMap();
  const before = live(map).length;
  const { merges } = new Resolver(map, prio, cfg, NOW).heal(INGEST);
  const folds = merges.filter((m) => !m.reason.startsWith('re-point'));
  assert.deepEqual(folds.map((m) => [m.loser.feedId, m.survivor.feedId]).sort(), [...PAIRS].sort());
  for (const m of folds) {
    assert.match(m.reason, /moderate window=50\.0 km\/20 s$/);
    const km = Number(/d=([\d.]+) km/.exec(m.reason)![1]);
    const s = Number(/dt=([\d.]+) s/.exec(m.reason)![1]);
    assert.ok(km > 38 && km < 48 && s <= 4, m.reason);
  }
  assert.equal(live(map).length, before - 7);
  assert.equal(new Resolver(map, prio, cfg, NOW + 300_000).heal(INGEST).merges.length, 0);
});

/** Two reports of different providers, M`m1` and M`m2`, `km` north and `dtS` later: how many events at first sight
 *  and after the heal. */
function pair(m1: number, m2: number, km: number, dtS = 2, p2 = 'geonet', p1 = 'usgs', lat0 = -20): number {
  const t = Date.parse('2026-10-05T12:00:00Z');
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  const report = (provider: string, id: string, over: Partial<RawObs>): RawObs => ({
    provider, providerEventId: id, eventTimeMs: t, providerUpdatedMs: null, status: null, lat: lat0, lon: -174, depth: 10,
    mag: 5, magType: 'mb', place: null, knownAliasIds: [], fields: {}, ...over,
  });
  r.ingest(report(p1, p1 === 'usgs' ? 'us7000aaaa' : 'a1', { mag: m1 }), INGEST);
  r.ingest(report(p2, p2 === 'usgs' ? 'us7000aaab' : 'b1', { mag: m2, lat: lat0 + km / KM_PER_DEG, eventTimeMs: t + dtS * 1000 }), INGEST);
  r.heal(INGEST);
  return live(map).length;
}

test('m5 scatter: both ≥ M5.0 within 50 km, 20 s and |ΔM| 0.5 are one event, at first sight or by the heal', () => {
  assert.equal(pair(5.0, 5.0, 49), 1);
  assert.equal(pair(5.0, 5.5, 49), 1, '|ΔM| 0.5 does not shrink the window');
  assert.equal(pair(5.3, 5.0, 45, 19), 1);
  // 49 km across three 0.2° grid cells (−20.01 is near the top of its cell): the candidate gather reaches 50 km (it
  // already did for M ≥ 4.0, TMD_WINDOW_KM).
  assert.equal(pair(5.0, 5.0, 49, 2, 'geonet', 'usgs', -20.01), 1);
  assert.equal(pair(5.0, 5.0, LARGE_EVENT_MAX_KM + 1), 2, 'beyond 50 km');
  assert.equal(pair(5.0, 5.0, 45, 21), 2, 'beyond 20 s');
  assert.equal(pair(5.0, 5.51, 30), 2, '|ΔM| beyond 0.5');
});

test('m5 scatter: below M5.0, NRCan, and one provider on both sides keep the windows of before', () => {
  // min M4.99: 39.8 km shrunk by |ΔM| 0.31 to 36.1 km.
  assert.equal(pair(4.99, 5.3, 37), 2);
  assert.equal(pair(4.99, 5.3, 35), 1);
  assert.equal(pair(5.0, 5.0, 45, 2, 'nrcan'), 2, 'NRCan stays out of the moderate window (owner decision 2026-10-02)');
  assert.equal(pair(5.0, 5.0, 45, 2, 'usgs'), 2, 'one provider under two ids');
});
