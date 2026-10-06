import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMSC_AUTHORED_COPIES, EMSC_COMCAT_NETWORK_COPIES, SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';
import { knownAliasIdsOf } from '../src/util.js';

// FEED-4: EMSC re-publishes the solutions of the US networks the feed reads only through ComCat (HV, TX, PR, AK, …) with
// `auth` naming the network. In the dense Kilauea cell a location join needs a shared id, so EMSC's HV copy and
// ComCat's `hv` row of the same quake stood as two events (10 times in the 11 days to 2026-10-04). Such a copy now
// counts as the identity of ComCat's row of that network (config EMSC_COMCAT_NETWORK_COPIES). The rows below are the
// real ones, as the observation log holds them.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const iso = (ms: number): string => new Date(ms).toISOString();
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');
const NOW = Date.parse('2026-10-03T06:00:00Z');

const OBS = new Map<string, RawObs>();
for (const l of readFileSync(here('fixtures/emsc-comcat-network-copies-2026-10.ndjson'), 'utf8').split('\n').filter(Boolean)) {
  const o = JSON.parse(l) as Observation;
  OBS.set(`${o.provider}:${o.provider_event_id}`, observationToRaw(o));
}
const obs = (key: string, over: Partial<RawObs> = {}): RawObs => {
  const raw = OBS.get(key);
  assert.ok(raw, key);
  return { ...raw, ...over, fields: { ...raw.fields, ...(over.fields ?? {}) } };
};

/** More live ComCat `hv` events than SWARM_CELL_ABSOLUTE around `at`, older by 2 min steps, none sharing an id with
 *  the rows under test: the Kilauea summit cell, where a location join needs a shared id (or an authored copy). */
function kilaueaCell(at: RawObs): { map: Map<string, EventNode>; r: Resolver; base: number } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
    const id = `hv7599${String(i).padStart(4, '0')}`;
    const fields = { ids: `,${id},`, net: 'hv', code: id.slice(2) };
    r.ingest(
      {
        provider: 'usgs', providerEventId: id, eventTimeMs: at.eventTimeMs - (i + 1) * 120_000, providerUpdatedMs: null, status: 'reviewed',
        lat: at.lat + ((i % 5) - 2) * 0.0005, lon: at.lon + ((i % 3) - 1) * 0.0005, depth: 0, mag: 1.9, magType: 'ml',
        place: 'background', knownAliasIds: knownAliasIdsOf('usgs', id, fields), fields,
      },
      iso(NOW),
    );
  }
  return { map, r, base: live(map).length };
}

test('config: EMSC copies of the US networks name ComCat’s network prefix; none is an agency the feed reads itself', () => {
  assert.deepEqual(
    [...EMSC_COMCAT_NETWORK_COPIES].sort(),
    [['AK', 'ak'], ['HV', 'hv'], ['MB', 'mb'], ['NEIC', 'us'], ['NN', 'nn'], ['OK', 'ok'], ['PR', 'pr'], ['TX', 'tx'], ['UU', 'uu'], ['UW', 'uw']],
  );
  for (const code of EMSC_COMCAT_NETWORK_COPIES.keys()) assert.equal(EMSC_AUTHORED_COPIES.has(code), false, code);
  // NEIC's copies of ComCat's `us` rows joined in round 14 (tests/emsc-neic-copies.test.ts).
});

test('HV: in the dense Kilauea cell ComCat hv75048812 and EMSC’s HV copy are one event, in both orders', () => {
  for (const [comcat, copy] of [['usgs:hv75048812', 'emsc:20261003_0000049'], ['usgs:hv75046892', 'emsc:20261001_0000358']] as const) {
    assert.equal(obs(copy).fields['auth'], 'HV');
    for (const order of [[comcat, copy], [copy, comcat]]) {
      const { map, r, base } = kilaueaCell(obs(comcat));
      for (const k of order) r.ingest(obs(k), iso(NOW));
      assert.equal(live(map).length, base + 1, order.join(' → '));
      const n = live(map).find((x) => x.aliases.includes(comcat))!;
      assert.equal(rowsOf(n), [copy, comcat].sort().join(' '), order.join(' → '));
      assert.equal(n.chosenProvider, 'usgs', 'ComCat’s row leads (richer, and the copy is rounded)');
    }
  }
});

test('HV: the pair minted apart under the old rules folds in the heal pass', () => {
  // Under the old rules the copy's code named nothing, so the dense cell kept it beside ComCat's row, as production did
  // on 2026-10-03. With the code read, the logged path's heal (Resolver.heal) folds the two through the copy.
  const comcat = obs('usgs:hv75048812');
  const { map, r, base } = kilaueaCell(comcat);
  r.ingest(comcat, iso(NOW));
  r.ingest(obs('emsc:20261003_0000049', { fields: { auth: 'not-a-code' } }), iso(NOW));
  assert.equal(live(map).length, base + 2);
  const copyNode = live(map).find((x) => x.aliases.includes('emsc:20261003_0000049'))!;
  copyNode.provenance[0]!.fields = { ...copyNode.provenance[0]!.fields, auth: 'HV' };
  const { merges } = new Resolver(map, prio, cfg, NOW).heal(iso(NOW));
  assert.equal(merges.length, 1);
  assert.equal(live(map).length, base + 1);
  assert.equal(rowsOf(merges[0]!.survivor), 'emsc:20261003_0000049 usgs:hv75048812');
});

test('HV: ComCat’s row of another network (us…) with the copy’s solution is not the network’s row: two events', () => {
  const copy = obs('emsc:20261003_0000049');
  const other = obs('usgs:hv75048812', { providerEventId: 'us6000tzaa', knownAliasIds: [], fields: { ids: ',us6000tzaa,', net: 'us', code: '6000tzaa' } });
  for (const order of [[copy, other], [other, copy]]) {
    const { map, r, base } = kilaueaCell(copy);
    for (const raw of order) r.ingest(raw, iso(NOW));
    assert.equal(live(map).length, base + 2, order.map((o) => `${o.provider}:${o.providerEventId}`).join(' → '));
  }
});

test('HV: a copy naming another network, or another solution of the network, does not join in a dense cell', () => {
  const comcat = obs('usgs:hv75048812');
  const cases: [string, RawObs][] = [
    ['auth TX on an hv row', obs('emsc:20261003_0000049', { fields: { auth: 'TX' } })],
    ['3 s later', obs('emsc:20261003_0000049', { eventTimeMs: comcat.eventTimeMs + 3_000 })],
    ['0.2 magnitude apart', obs('emsc:20261003_0000049', { mag: 2.25 })],
  ];
  for (const [label, copy] of cases) {
    const { map, r, base } = kilaueaCell(comcat);
    r.ingest(comcat, iso(NOW));
    r.ingest(copy, iso(NOW));
    assert.equal(live(map).length, base + 2, label);
  }
});
