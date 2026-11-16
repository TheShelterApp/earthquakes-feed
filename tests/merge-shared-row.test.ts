import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Resolver } from '../src/dedup.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';

// 2026-11-15 audit, dedup L3: when two live events that both hold a row of the same provider id fold, the survivor kept
// its own copy of that row even when the loser's was newer. Later reports of the id reach only the node its alias
// resolves to, which can be the loser, so the copy updated last is the one to keep.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const T0 = Date.parse('2026-11-14T08:15:30Z');
const NOW = T0 + 2 * 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: T0 + 600_000,
    status: 'automatic',
    lat: 36.42,
    lon: 70.71,
    depth: 200,
    mag: 4.6,
    magType: 'mb',
    place: 'Hindu Kush region, Afghanistan',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

/** One event of `primary` holding a GEOFON row stamped `geofonUpdated` (null = no stamp), minted in a map of its own. */
function eventWith(primary: RawObs, geofonUpdated: number | null, geofonMag: number): EventNode {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW, { merge: false });
  r.ingest(primary, iso(NOW));
  const res = r.ingest(obs('geofon', 'gfz2026wxyz', { providerUpdatedMs: geofonUpdated, mag: geofonMag, eventTimeMs: T0 + 1_500, status: 'manual' }), iso(NOW));
  assert.equal(map.size, 1, 'setup: the GEOFON row joined');
  return res.node;
}

/** Two live events that share the GEOFON row, folded by the heal pass. */
function fold(a: EventNode, b: EventNode): { survivor: EventNode; loser: EventNode } {
  const map = new Map<string, EventNode>([[a.feedId, a], [b.feedId, b]]);
  const { merges } = new Resolver(map, prio, cfg, NOW).heal(iso(NOW));
  assert.equal(merges.length, 1, 'setup: the two events fold');
  return { survivor: merges[0]!.survivor, loser: merges[0]!.loser };
}

const geofonRow = (n: EventNode) => n.provenance.filter((r) => r.provider === 'geofon' && r.nativeId === 'gfz2026wxyz');

for (const newerOn of ['usgs', 'emsc'] as const) {
  test(`a fold keeps the newer copy of a shared row (newer copy on the ${newerOn} event)`, () => {
    const usgs = eventWith(obs('usgs', 'us7000abcd', { mag: 4.7 }), newerOn === 'usgs' ? T0 + 3_000_000 : T0 + 900_000, newerOn === 'usgs' ? 4.8 : 4.5);
    const emsc = eventWith(obs('emsc', '20261114_0000101', { mag: 4.6, lat: 36.44, lon: 70.69 }), newerOn === 'emsc' ? T0 + 3_000_000 : T0 + 900_000, newerOn === 'emsc' ? 4.8 : 4.5);
    const { survivor, loser } = fold(usgs, emsc);
    const rows = geofonRow(survivor);
    assert.equal(rows.length, 1, 'one copy of the row');
    assert.equal(rows[0]!.providerUpdatedMs, T0 + 3_000_000);
    assert.equal(rows[0]!.mag, 4.8);
    assert.equal(survivor.provenance.filter((r) => r.chosen).length, 1, 'chosen re-derived');
    // The loser's frozen copy still says what it held.
    assert.equal(geofonRow(loser)[0]!.mag, newerOn === 'usgs' ? (loser === usgs ? 4.8 : 4.5) : loser === emsc ? 4.8 : 4.5);
  });
}

test('a row without a stamp never replaces one; two unstamped rows keep the survivor’s', () => {
  for (const [usgsStamp, emscStamp] of [[T0 + 900_000, null], [null, T0 + 900_000]] as const) {
    const usgs = eventWith(obs('usgs', 'us7000abcd', { mag: 4.7 }), usgsStamp, usgsStamp == null ? 4.4 : 4.8);
    const emsc = eventWith(obs('emsc', '20261114_0000101', { mag: 4.6, lat: 36.44, lon: 70.69 }), emscStamp, emscStamp == null ? 4.4 : 4.8);
    const { survivor } = fold(usgs, emsc);
    assert.deepEqual(geofonRow(survivor).map((r) => [r.providerUpdatedMs, r.mag]), [[T0 + 900_000, 4.8]]);
  }
  const usgs = eventWith(obs('usgs', 'us7000abcd', { mag: 4.7 }), null, 4.4);
  const emsc = eventWith(obs('emsc', '20261114_0000101', { mag: 4.6, lat: 36.44, lon: 70.69 }), null, 4.9);
  const before = new Map([usgs, emsc].map((n) => [n.feedId, geofonRow(n)[0]!.mag]));
  const { survivor } = fold(usgs, emsc);
  assert.deepEqual(geofonRow(survivor).map((r) => r.mag), [before.get(survivor.feedId)]);
});
