import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REVISED_ID_WINDOWS, SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { REHOMED_REASON_PREFIX, Resolver } from '../src/dedup.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// Round 14: CSN (Chile) publishes a revised solution as a new informe numbered right after the one it replaces and drops
// the old one from its day page. The feed sees no delete, and the same provider's two ids kept the quake as two events,
// EMSC's copy (auth CSN) moving between them. The fixture holds the real log lines of two such revisions (Valparaíso
// M4.2 2026-09-29: 384790 then 384789; Socaire M3.0 2026-09-21: 383921 then 383920), one pair CSN lists twice with
// informes 6 apart (377484 / 377490, 2026-08-01), and two quakes 57 s apart (384819 / 384821, 2026-09-29), which EMSC's one
// event id copied in turn.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const KM_PER_DEG = 111.195;
const north = (lat: number, km: number): number => lat + km / KM_PER_DEG;
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');

const LINES: Observation[] = readFileSync(here('fixtures/csn-revised-ids-2026.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);

/** The lines of one day replayed as the runs that logged them saw them (their hot window); a re-home's op:tombstone line
 *  is the effect of the observe line after it, as in scripts/replay-dedup.ts. */
function replayDay(day: string): Map<string, EventNode> {
  const lines = LINES.filter((o) => o.event_time.startsWith(day));
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, Date.parse(lines.at(-1)!.ingest_time));
  for (const o of lines) {
    if (o.op === 'tombstone') {
      if (!o.reason?.startsWith(REHOMED_REASON_PREFIX)) r.tombstoneProvider(observationToRaw(o), o.ingest_time);
      continue;
    }
    r.ingest(observationToRaw(o), o.ingest_time);
  }
  return map;
}

const T0 = Date.parse('2026-09-29T04:02:45Z');
const NOW = Date.parse('2026-09-29T05:00:00Z');
function obs(id: string, over: Partial<RawObs> = {}, provider = 'csn'): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: null,
    lat: -32.79,
    lon: -71.35,
    depth: 72,
    mag: 4.1,
    magType: 'Mlv',
    place: '14 km al NO de Quillota',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}
/** How many live events CSN's 384789 and a second CSN report `over` it make (the second one later). */
function pair(over: Partial<RawObs>, id = '384790'): number {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('384789'), '2026-09-29T04:10:00Z');
  r.ingest(obs(id, over), '2026-09-29T04:15:00Z');
  return live(map).length;
}

test('config: CSN only, 3 s, 45 km, |ΔM| ≤ 0.5, informes at most 2 apart', () => {
  assert.deepEqual([...REVISED_ID_WINDOWS.keys()], ['csn']);
  assert.deepEqual(REVISED_ID_WINDOWS.get('csn'), { dtMs: 3_000, km: 45, maxDeltaMag: 0.5, maxIdGap: 2 });
});

test('the two revisions are one event each, with EMSC’s copy; the double listing and the two quakes stay apart', () => {
  const valparaiso = live(replayDay('2026-09-29')).filter((n) => n.provenance.some((r) => r.nativeId === '384789' || r.nativeId === '384790'));
  assert.equal(valparaiso.length, 1, 'Valparaíso M4.2: one event');
  assert.equal(rowsOf(valparaiso[0]!), 'csn:384789 csn:384790 emsc:20260929_0000049');
  const socaire = live(replayDay('2026-09-21'));
  assert.equal(socaire.length, 1, 'Socaire M3.0: one event');
  assert.equal(rowsOf(socaire[0]!), 'csn:383920 csn:383921 emsc:20260921_0000152');
  const atacama = live(replayDay('2026-08-01'));
  assert.equal(atacama.length, 2, '377484 / 377490: informes 6 apart, two events as before');
  const tarapaca = live(replayDay('2026-09-29')).filter((n) => n.provenance.some((r) => r.nativeId === '384819' || r.nativeId === '384821'));
  assert.equal(tarapaca.length, 2, '384819 / 384821, 57 s apart: two quakes');
  assert.ok(tarapaca.some((n) => rowsOf(n) === 'csn:384821 emsc:20260929_0000098'), 'EMSC’s re-pointed copy sits with the row it copies');
});

test('a revision joins the old id’s event at first sight, ahead of a nearer event', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  // The old id 14 km north (beyond the 10 km window of an M3.5), and GFZ's event of another quake 3 km south of where the
  // revision lands, 8 s off: inside the window, nearer than the old id.
  const old = r.ingest(obs('384789', { lat: north(-32.79, 14), mag: 3.5 }), '2026-09-29T04:07:00Z');
  r.ingest(obs('gfz2026zzzz', { lat: north(-32.79, -3), eventTimeMs: T0 + 9_000, mag: 3.5 }, 'geofon'), '2026-09-29T04:08:00Z');
  const res = r.ingest(obs('384790', { mag: 3.5, eventTimeMs: T0 + 1_000 }), '2026-09-29T04:12:00Z');
  assert.equal(res.node.feedId, old.node.feedId);
  assert.deepEqual(live(map).map(rowsOf).sort(), ['csn:384789 csn:384790', 'geofon:gfz2026zzzz']);
});

test('outside the window the two ids stay two events', () => {
  assert.equal(pair({ lat: north(-32.79, 14), eventTimeMs: T0 + 1_000 }), 1, 'inside: 14 km, 1 s');
  assert.equal(pair({ lat: north(-32.79, 14), eventTimeMs: T0 + 4_000 }), 2, '4 s');
  assert.equal(pair({ lat: north(-32.79, 46) }), 2, '46 km');
  assert.equal(pair({ lat: north(-32.79, 14), mag: 4.7 }), 2, '|ΔM| 0.6');
  assert.equal(pair({ lat: north(-32.79, 14), mag: null }), 2, 'no magnitude');
  assert.equal(pair({ lat: north(-32.79, 14) }, '384792'), 2, 'informes 3 apart');
  assert.equal(pair({ lat: north(-32.79, 14) }, 'x384790'), 2, 'not a whole number');
});

test('another provider’s two ids keep the old rule', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(obs('100', {}, 'inpres'), '2026-09-29T04:10:00Z');
  r.ingest(obs('101', { lat: north(-32.79, 14) }, 'inpres'), '2026-09-29T04:15:00Z');
  assert.equal(live(map).length, 2);
});

test('the merge pass folds two events holding a CSN revision pair and says so', () => {
  // As production holds them: each id minted its own event before this rule (two separate maps, loaded together).
  const map = new Map<string, EventNode>();
  new Resolver(map, prio, cfg, NOW).ingest(obs('384790', { lat: north(-32.79, 14), mag: 4.2, eventTimeMs: T0 + 1_000 }), '2026-09-29T04:07:00Z');
  const other = new Map<string, EventNode>();
  new Resolver(other, prio, cfg, NOW).ingest(obs('384789'), '2026-09-29T04:12:00Z');
  for (const [k, n] of other) map.set(k, n);
  assert.equal(live(map).length, 2);
  const { merges } = new Resolver(map, prio, cfg, NOW).heal('2026-09-29T04:20:00Z');
  assert.equal(merges.length, 1);
  assert.match(merges[0]!.reason, /^revised id: csn 38(4789|4790) \/ 38(4789|4790) d=14\.\d km dt=1\.0 s/);
  assert.equal(live(map).length, 1);
  assert.equal(new Resolver(map, prio, cfg, NOW).heal('2026-09-29T04:25:00Z').merges.length, 0, 'idempotent');
});

test('in a dense cell a revision pair stays two events', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
    r.ingest(obs(`b${i}`, { eventTimeMs: T0 - (i + 1) * 120_000, lat: -32.79 + ((i % 5) - 2) * 0.005, mag: 2.5 }, 'inpres'), '2026-09-29T04:00:00Z');
  }
  const base = live(map).length;
  r.ingest(obs('384790', { lat: north(-32.79, 5), eventTimeMs: T0 + 1_000 }), '2026-09-29T04:07:00Z');
  r.ingest(obs('384789'), '2026-09-29T04:12:00Z');
  assert.equal(live(map).length, base + 2);
});
