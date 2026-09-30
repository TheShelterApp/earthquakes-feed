import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMCAT_ID_PREFIX, SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { runCorrection } from '../src/correction.js';
import { Resolver } from '../src/dedup.js';
import { parseFdsnText } from '../src/fdsn.js';
import { LogBuffer } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';
import { comcatIdOf, knownAliasIdsOf, nativeIdOfComcat } from '../src/util.js';

// PF-5d: NCEDC's and SCEDC's event ids are the NC and CI networks' own ids, which ComCat carries as `nc<id>` /
// `ci<id>`. Until this change nothing linked the two, so in a dense cell (The Geysers), where a location join needs a
// shared id, the regional row and ComCat's row of the same event stood as two events (286 + 18 in 10 days).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const iso = (ms: number): string => new Date(ms).toISOString();
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');

const GEYSERS_LAT = 38.8015;
const GEYSERS_LON = -122.78117;
const T0 = Date.parse('2026-09-30T12:00:00Z');
const NOW = T0 + 3_600_000;

/** An NCEDC row as parseFdsnText returns it. */
function ncedc(id: string, over: Partial<RawObs> = {}): RawObs {
  const fields = { EventID: id, Author: 'NC', Catalog: 'NCSS', Contributor: 'NC', MagType: 'md', Magnitude: '0.7' };
  return {
    provider: 'ncedc', providerEventId: id, eventTimeMs: T0 + 610, providerUpdatedMs: null, status: null,
    lat: GEYSERS_LAT, lon: GEYSERS_LON, depth: 2.1, mag: 0.7, magType: 'md', place: 'The Geysers, CA',
    knownAliasIds: knownAliasIdsOf('ncedc', id, fields), fields, ...over,
  };
}
/** A ComCat row: `ids` lists every catalog id of the event, the preferred one first. */
function usgs(id: string, ids: string[] = [id], over: Partial<RawObs> = {}): RawObs {
  const fields = { ids: `,${ids.join(',')},`, net: id.slice(0, 2), code: id.slice(2) };
  return {
    provider: 'usgs', providerEventId: id, eventTimeMs: T0 + 610, providerUpdatedMs: T0 + 300_000, status: 'automatic',
    lat: GEYSERS_LAT + 0.0000015, lon: GEYSERS_LON + 0.0000033, depth: 2.08, mag: 0.73, magType: 'md',
    place: '6 km NW of The Geysers, CA', knownAliasIds: knownAliasIdsOf('usgs', id, fields), fields, ...over,
  };
}
/** A cell with more live events than SWARM_CELL_ABSOLUTE (The Geysers every day): a location join needs a shared id. */
function geysers(): { map: Map<string, EventNode>; r: Resolver } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
    r.ingest(usgs(`nc7543${String(i).padStart(4, '0')}`, undefined, { eventTimeMs: T0 - (i + 1) * 90_000, lat: GEYSERS_LAT + (i % 5) * 0.002 }), iso(NOW));
  }
  return { map, r };
}

test('comcat id: NCEDC and SCEDC ids name ComCat’s nc / ci event; AEC’s is the ComCat id itself', () => {
  assert.deepEqual([...COMCAT_ID_PREFIX], [['aec', ''], ['ncedc', 'nc'], ['scedc', 'ci']]);
  assert.equal(comcatIdOf('ncedc', '75438707'), 'nc75438707');
  assert.equal(comcatIdOf('scedc', '41341119'), 'ci41341119');
  assert.equal(comcatIdOf('aec', 'aka2026tegabx'), 'aka2026tegabx');
  assert.equal(comcatIdOf('emsc', '20260930_0000241'), null);
  assert.equal(nativeIdOfComcat('ncedc', 'nc75438707'), '75438707');
  assert.equal(nativeIdOfComcat('ncedc', 'ci41341119'), null);
  assert.equal(nativeIdOfComcat('scedc', 'ci41341119'), '41341119');
  assert.equal(nativeIdOfComcat('ncedc', 'nc'), null);
  assert.deepEqual(knownAliasIdsOf('ncedc', '75438707', {}), ['usgs:nc75438707']);
  assert.deepEqual(knownAliasIdsOf('scedc', '41341119', {}), ['usgs:ci41341119']);
  const body = [
    '#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType',
    '75438707|2026-09-20T00:47:01.610|38.8015|-122.78117|2.1|NC|NCSS|NC|75438707|md|0.7|NC|The Geysers, CA|earthquake',
  ].join('\n');
  assert.deepEqual(parseFdsnText(body, 'ncedc')[0]!.knownAliasIds, ['usgs:nc75438707'], 'the FDSN text parser names it');
  assert.deepEqual(parseFdsnText(body, 'resif')[0]!.knownAliasIds, [], 'other text providers name nothing');
});

test('comcat id: in The Geysers, NCEDC and ComCat’s row of the same id are one event in both orders', () => {
  for (const order of ['usgs-first', 'ncedc-first'] as const) {
    const { map, r } = geysers();
    const before = live(map).length;
    const n = ncedc('75438707');
    const u = usgs('nc75438707');
    for (const raw of order === 'usgs-first' ? [u, n] : [n, u]) r.ingest(raw, iso(NOW));
    assert.equal(live(map).length, before + 1, order);
    const node = live(map).find((x) => x.provenance.some((p) => p.provider === 'ncedc'))!;
    assert.equal(rowsOf(node), 'ncedc:75438707 usgs:nc75438707', order);
  }
});

test('comcat id: across runs — a new Resolver over the saved events still finds the row by the other id', () => {
  for (const order of ['usgs-first', 'ncedc-first'] as const) {
    const { map, r } = geysers();
    const before = live(map).length;
    r.ingest(order === 'usgs-first' ? usgs('nc75438707') : ncedc('75438707'), iso(NOW));
    const next = new Resolver(map, prio, cfg, NOW + 300_000);
    next.ingest(order === 'usgs-first' ? ncedc('75438707') : usgs('nc75438707'), iso(NOW + 300_000));
    assert.equal(live(map).length, before + 1, order);
  }
});

test('comcat id: ComCat preferring another id (us7000…) that lists the nc id is the same event', () => {
  const { map, r } = geysers();
  const before = live(map).length;
  r.ingest(usgs('us7000abcd', ['us7000abcd', 'nc75438707'], { status: 'reviewed', mag: 3.1, eventTimeMs: T0 + 1_200 }), iso(NOW));
  r.ingest(ncedc('75438707', { mag: 3.0 }), iso(NOW));
  assert.equal(live(map).length, before + 1);
});

test('comcat id: two NCEDC ids are two events, whatever ComCat lists', () => {
  const { map, r } = geysers();
  const before = live(map).length;
  r.ingest(ncedc('75438707'), iso(NOW));
  r.ingest(ncedc('75438708', { eventTimeMs: T0 + 4_000, lat: GEYSERS_LAT + 0.004 }), iso(NOW));
  r.ingest(usgs('nc75438708', undefined, { eventTimeMs: T0 + 4_000, lat: GEYSERS_LAT + 0.004 }), iso(NOW));
  assert.equal(live(map).length, before + 2);
  const second = live(map).find((x) => x.provenance.some((p) => p.nativeId === '75438708'))!;
  assert.equal(rowsOf(second), 'ncedc:75438708 usgs:nc75438708');
});

test('comcat id: a ComCat delete leaves the NCEDC row alone; NCEDC’s own zeroing withdraws it, and a re-located id comes back', () => {
  const { map, r } = geysers();
  r.ingest(ncedc('75438707'), iso(NOW));
  r.ingest(usgs('nc75438707'), iso(NOW));
  const del = usgs('nc75438707', undefined, { status: 'deleted' });
  r.tombstoneProvider(del, iso(NOW));
  assert.deepEqual(r.withdrawComcatTwins(del, iso(NOW)), [], 'only AEC follows ComCat deletes');
  const node = live(map).find((x) => x.provenance.some((p) => p.provider === 'ncedc'))!;
  assert.equal(rowsOf(node), 'ncedc:75438707');
  const zeroed = ncedc('75438707', { lat: 0, lon: 0, mag: 0, magType: 'MU' });
  assert.equal(r.withdrawZeroed(zeroed, iso(NOW))?.changed, true);
  assert.equal(node.state, 'tombstoned');
  const back = r.ingest(ncedc('75438707'), iso(NOW + 60_000));
  assert.equal(back.node.feedId, node.feedId);
  assert.equal(node.state, 'live', 'a later located report of the id brings it back, as before');
});

test('comcat id: an NCEDC report beside another agency’s event is never withheld (that rule is AEC’s)', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  r.ingest(usgs('nc75430001', undefined, { mag: 1.1 }), iso(NOW));
  // 12 km away: outside the location windows, inside AEC's twin guard (±60 s, 50 km, ΔM ≤ 1).
  const res = r.ingest(ncedc('75430002', { lat: GEYSERS_LAT + 0.108, mag: 1.2 }), iso(NOW));
  assert.equal(res.withheld, undefined);
  assert.equal(live(map).length, 2);
});

// --- the one-time correction on the splits production published ---

const SPLITS = readFileSync(here('fixtures/ncedc-scedc-splits-2026-09.ndjson'), 'utf8').split('\n').filter(Boolean);
const RUN = Date.parse('2026-09-30T20:52:00Z');

test('correction: the published NCEDC / SCEDC events fold into ComCat’s event of the same id (exact id)', () => {
  const map = new Map<string, EventNode>();
  for (const l of SPLITS) {
    const n = JSON.parse(l) as EventNode;
    map.set(n.feedId, n);
  }
  assert.equal(live(map).length, 4);
  const root = mkdtempSync(join(tmpdir(), 'correction-'));
  const log = new LogBuffer(191_992, iso(RUN));
  const marker = runCorrection(root, map, prio, cfg, log, { nowMs: RUN, ingestTime: iso(RUN) });
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(marker.comcat_id, { merged: 2, survivors: 2 });
  assert.deepEqual(live(map).map(rowsOf).sort(), ['ncedc:75438707 usgs:nc75438707', 'scedc:41335375 usgs:ci41335375']);
  // ComCat's event (the one with more status) keeps its id; the regional one follows it.
  assert.deepEqual(live(map).map((n) => n.feedId).sort(), ['efd_01M2Y4FNX0ZE9HCVAXNX0W81RS', 'efd_01M2YJ9W9GPA5207V0D0SW9NX0']);
  const merges = log.lines.filter((l) => l.op === 'merge');
  assert.equal(merges.length, 2);
  for (const m of merges) assert.match(m.reason!, /^exact id: ComCat (nc75438707|ci41335375) names \1, the id of the (ncedc|scedc) report$/);
  assert.deepEqual(log.lines.map((l) => l.op), ['merge', 'merge', 'correction', 'correction']);
  // Idempotent.
  const again = new Resolver(map, prio, cfg, RUN + 300_000, { hotFloorMs: Date.parse('2026-09-20T00:00:00Z') }).foldExactIdTwins(iso(RUN + 300_000));
  assert.deepEqual(again.merges, []);
});
