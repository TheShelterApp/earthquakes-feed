import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMSC_COMCAT_NETWORK_COPIES, EMSC_COPIES_KEPT_IN_PLACE, SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';
import { knownAliasIdsOf } from '../src/util.js';

// Round 14: EMSC copies NEIC's solution, ComCat's `us…` row, with `auth: "NEIC"` (99.9 % of the 2,107 versions beside a
// `us` row equal it in time and place, 93.0 % in magnitude too). In the dense cell of the 2026-08 Flores sequence the copy
// and ComCat's row of the same quake stood as two events (a location join there needs a shared id). The copy now counts
// as the `us` row's identity (config EMSC_COMCAT_NETWORK_COPIES), but it is never moved to the row it copies
// (EMSC_COPIES_KEPT_IN_PLACE): EMSC takes an event's solution first from the regional agency and then from NEIC, and
// moving the row left the regional agency's row behind. The rows below are the real ones, as the observation log holds
// them.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');

const LINES: Observation[] = readFileSync(here('fixtures/emsc-neic-copies-2026-08.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);
const first = (key: string): RawObs => observationToRaw(LINES.find((o) => `${o.provider}:${o.provider_event_id}` === key)!);

/** More live ComCat events than SWARM_CELL_ABSOLUTE around `at`, older by 2 min steps: the Flores swarm cell. */
function swarmCell(at: RawObs, nowMs: number): { map: Map<string, EventNode>; r: Resolver; base: number } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs);
  for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
    const id = `us6000zz${String(i).padStart(2, '0')}`;
    const fields = { ids: `,${id},`, net: 'us', code: id.slice(2) };
    r.ingest(
      {
        provider: 'usgs', providerEventId: id, eventTimeMs: at.eventTimeMs - (i + 1) * 120_000, providerUpdatedMs: null, status: 'reviewed',
        lat: at.lat + ((i % 5) - 2) * 0.005, lon: at.lon + ((i % 3) - 1) * 0.005, depth: 10, mag: 3.5, magType: 'mb',
        place: 'background', knownAliasIds: knownAliasIdsOf('usgs', id, fields), fields,
      },
      new Date(nowMs).toISOString(),
    );
  }
  return { map, r, base: live(map).length };
}

test('config: NEIC copies count against ComCat’s `us` rows and stay where they joined', () => {
  assert.equal(EMSC_COMCAT_NETWORK_COPIES.get('NEIC'), 'us');
  assert.deepEqual([...EMSC_COPIES_KEPT_IN_PLACE], ['NEIC']);
});

test('Flores swarm: ComCat us6000tls7 and EMSC’s NEIC copy are one event in the dense cell, in both orders', () => {
  const comcat = first('usgs:us6000tls7');
  const copy = first('emsc:20260819_0000150');
  assert.equal(copy.fields['auth'], 'NEIC');
  const nowMs = Date.parse('2026-08-19T06:00:00Z');
  for (const order of [[comcat, copy], [copy, comcat]]) {
    const { map, r, base } = swarmCell(comcat, nowMs);
    for (const raw of order) r.ingest(raw, '2026-08-19T05:16:53.745Z');
    assert.equal(live(map).length, base + 1, order.map((o) => o.provider).join(' → '));
    const n = live(map).find((x) => x.aliases.includes('usgs:us6000tls7'))!;
    assert.equal(rowsOf(n), 'emsc:20260819_0000150 usgs:us6000tls7');
    assert.equal(n.chosenProvider, 'usgs');
  }
});

test('Flores swarm: a NEIC copy of another solution, or naming another network’s row, stays apart', () => {
  const comcat = first('usgs:us6000tls7');
  const nowMs = Date.parse('2026-08-19T06:00:00Z');
  const cases: [string, RawObs, RawObs][] = [
    ['3 s later', comcat, { ...first('emsc:20260819_0000150'), eventTimeMs: comcat.eventTimeMs + 3_000 }],
    ['0.2 magnitude apart', comcat, { ...first('emsc:20260819_0000150'), mag: 5.0 }],
    ['ComCat’s row of another network', { ...comcat, providerEventId: 'pt26231000', knownAliasIds: [], fields: { ids: ',pt26231000,', net: 'pt' } }, first('emsc:20260819_0000150')],
  ];
  for (const [label, a, b] of cases) {
    const { map, r, base } = swarmCell(comcat, nowMs);
    r.ingest(a, '2026-08-19T05:16:53.745Z');
    r.ingest(b, '2026-08-19T05:16:53.745Z');
    assert.equal(live(map).length, base + 2, label);
  }
});

test('Chiapas 2026-08-22: EMSC moves its event from SSN’s solution to NEIC’s; the row stays and ComCat’s event folds in', () => {
  // SSN M4.3 (14.419, -93.305), ComCat M4.5 33 km south (beyond the moderate-event window), EMSC's event first copies
  // SSN (auth UNM), then NEIC. Moving the copy to ComCat's event (the FEED-2 re-home) would leave SSN's row alone.
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, Date.parse('2026-08-22T23:00:00Z'));
  for (const o of LINES.filter((l) => l.event_time.startsWith('2026-08-22'))) {
    const res = r.ingest(observationToRaw(o), o.ingest_time);
    assert.equal(res.rehomed, undefined, `${o.provider}:${o.provider_event_id} is not re-homed`);
  }
  const events = live(map);
  assert.equal(events.length, 1);
  assert.equal(rowsOf(events[0]!), 'emsc:20260822_0000272 mexico:2026-08-22155344_14.419_-93.305 usgs:us6000tmuq');
  assert.deepEqual(r.rehomeMisplacedCopies('2026-08-22T23:00:00Z'), [], 'the every-run pass leaves a NEIC copy where it is');
});
