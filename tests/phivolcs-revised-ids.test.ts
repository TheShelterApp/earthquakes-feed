import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Resolver } from '../src/dedup.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';

// PHIVOLCS ids are the bulletin's UTC origin stamp, to the minute or (most bulletins since about 2026-10-29) to the
// second. A quake's B1 can carry the minute stamp and its later B2 the seconds stamp, the page then listing only the B2
// (page of 2026-11-16: 2026_1114_0919_B1, 18.71/121.16 M2.8, re-issued as 2026_1114_091912_B2, 18.76/121.05 M3.3). The
// two are one quake re-issued under a revised id (config REVISED_ID_WINDOWS); two seconds stamps never pair.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const KM_PER_DEG = 111.195;
const north = (lat: number, km: number): number => lat + km / KM_PER_DEG;
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');

const NOW = Date.parse('2026-11-14T10:00:00Z');
/** A PHIVOLCS row whose origin time is read from its stamp, as parsePhivolcs does. */
function obs(id: string, lat: number, lon: number, mag: number): RawObs {
  const [, mmdd, hhmmss] = id.split('_') as [string, string, string];
  const t = Date.parse(`2026-${mmdd.slice(0, 2)}-${mmdd.slice(2)}T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4) || '00'}Z`);
  return {
    provider: 'phivolcs',
    providerEventId: id,
    eventTimeMs: t,
    providerUpdatedMs: null,
    status: null,
    lat,
    lon,
    depth: 10,
    mag,
    magType: null,
    place: null,
    knownAliasIds: [],
    fields: {},
  };
}
const B1 = obs('2026_1114_0919', 18.71, 121.16, 2.8);
const B2 = obs('2026_1114_091912', 18.76, 121.05, 3.3);

function ingestAll(rows: RawObs[]): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  rows.forEach((row, i) => r.ingest(row, new Date(NOW - (rows.length - i) * 60_000).toISOString()));
  return map;
}

test('a minute-stamped B1 and the seconds-stamped B2 of its minute are one event', () => {
  const events = live(ingestAll([B1, B2]));
  assert.equal(events.length, 1);
  assert.equal(rowsOf(events[0]!), 'phivolcs:2026_1114_0919 phivolcs:2026_1114_091912');
});

test('two seconds-stamped quakes of one minute stay two events', () => {
  const a = obs('2026_1114_091912', 18.76, 121.05, 3.3);
  const b = obs('2026_1114_091940', north(18.76, 20), 121.05, 3.1);
  assert.equal(live(ingestAll([a, b])).length, 2);
});

test('a minute row, its seconds B2, then a far seconds quake of the same minute: two events', () => {
  const far = obs('2026_1114_091950', 9.68, 126.29, 3.0);
  const events = live(ingestAll([B1, B2, far]));
  assert.deepEqual(events.map(rowsOf).sort(), ['phivolcs:2026_1114_0919 phivolcs:2026_1114_091912', 'phivolcs:2026_1114_091950']);
});

test('outside the pair rule a minute row and a seconds row stay two events', () => {
  // Another minute's seconds stamp 15 s before the minute row, 13 km off.
  assert.equal(live(ingestAll([B1, obs('2026_1114_091845', 18.76, 121.05, 3.0)])).length, 2, 'another minute');
  assert.equal(live(ingestAll([B1, obs('2026_1114_091912', north(18.71, 51), 121.16, 3.0)])).length, 2, '51 km');
  assert.equal(live(ingestAll([B1, obs('2026_1114_091912', 18.76, 121.05, 3.5)])).length, 2, '|ΔM| 0.7');
});

test('the merge pass folds a minute-id event and the seconds-id event of its minute', () => {
  // As a run without the pair rule would leave them: each id minted its own event.
  const map = new Map<string, EventNode>();
  new Resolver(map, prio, cfg, NOW).ingest(B1, '2026-11-14T09:30:00Z');
  const other = new Map<string, EventNode>();
  new Resolver(other, prio, cfg, NOW).ingest(B2, '2026-11-14T09:45:00Z');
  for (const [k, n] of other) map.set(k, n);
  assert.equal(live(map).length, 2);
  const { merges } = new Resolver(map, prio, cfg, NOW).heal('2026-11-14T09:50:00Z');
  assert.equal(merges.length, 1);
  assert.match(merges[0]!.reason, /^revised id: phivolcs /);
  assert.equal(live(map).length, 1);
});
