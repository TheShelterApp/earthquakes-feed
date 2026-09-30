import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { vanishedIds } from '../src/absence.js';
import { mergeCanonical } from '../src/canonical.js';
import { COMCAT_ID_PROVIDERS, SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { parseAec } from '../src/custom.js';
import { Resolver } from '../src/dedup.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { COMCAT_DELETE_REASON } from '../src/sweep.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';
import { knownAliasIdsOf } from '../src/util.js';

// PF-5b: AEC, the Alaska Earthquake Center, as a direct provider. Its `event_name` is the ComCat id, so the `usgs`
// row of the same event is joined by id, whatever the distance between the two solutions.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-30T18:40:00Z');
const INGEST = new Date(NOW).toISOString();
const T0 = NOW - 2 * 3_600_000;
const KM_PER_DEG = 111.195;
const north = (lat: number, km: number): number => lat + km / KM_PER_DEG;
const LAT = 53.0106;
const LON = -175.2871;

const fixture = JSON.parse(readFileSync(here('fixtures/aec-recent-events.sample.json'), 'utf8')) as unknown[];

/** An AEC automatic solution as parseAec returns it. */
function aec(id: string, over: Partial<RawObs> = {}): RawObs {
  const fields = { event_name: id, version: 1, magnitude_author: 'scmag', author: 'AK' };
  return {
    provider: 'aec',
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: 'automatic',
    lat: LAT,
    lon: LON,
    depth: 5,
    mag: 4.3,
    magType: 'ML',
    place: '88 km N of Koniuji Island',
    knownAliasIds: [`usgs:${id}`],
    fields,
    ...over,
  };
}

/** A ComCat row: `ids` lists every catalog id of the event, the preferred one first. */
function usgs(id: string, ids: string[] = [id], over: Partial<RawObs> = {}): RawObs {
  const fields = { ids: `,${ids.join(',')},`, net: id.slice(0, 2), code: id.slice(2), nst: 40, gap: 80, rms: 0.7 };
  return {
    provider: 'usgs',
    providerEventId: id,
    eventTimeMs: T0 + 900,
    providerUpdatedMs: T0 + 600_000,
    status: 'reviewed',
    lat: LAT,
    lon: LON,
    depth: 20,
    mag: 4.4,
    magType: 'ml',
    place: 'Andreanof Islands, Aleutian Islands, Alaska',
    knownAliasIds: knownAliasIdsOf('usgs', id, fields),
    fields,
    ...over,
  };
}

function emsc(id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider: 'emsc',
    providerEventId: id,
    eventTimeMs: T0 + 400,
    providerUpdatedMs: T0 + 300_000,
    status: 'automatic',
    lat: LAT,
    lon: LON,
    depth: 10,
    mag: 4.3,
    magType: 'ml',
    place: 'ANDREANOF ISLANDS, ALEUTIAN IS.',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

const newResolver = (map: Map<string, EventNode>): Resolver => new Resolver(map, prio, cfg, NOW);
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const providersOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');

/** Every live node pair that shares a ComCat id through an aec row (the dry run's gate: must be none). */
function idSharingPairs(map: Map<string, EventNode>): string[] {
  const out: string[] = [];
  const nodes = live(map);
  for (const a of nodes) {
    for (const ra of a.provenance.filter((r) => COMCAT_ID_PROVIDERS.has(r.provider))) {
      for (const b of nodes) {
        if (b === a) continue;
        const named = b.provenance.some((r) => r.provider === 'usgs' && (r.nativeId === ra.nativeId || String(r.fields['ids'] ?? '').split(',').includes(ra.nativeId)));
        if (named) out.push(`${a.feedId}~${b.feedId}:${ra.nativeId}`);
      }
    }
  }
  return out;
}

// --- the parser ---

test('aec parser: the real sample file', () => {
  const rows = parseAec(fixture, 'aec');
  assert.equal(rows.length, 11);
  const byId = new Map(rows.map((r) => [r.providerEventId, r]));
  const auto = byId.get('aka2026tjuoem')!;
  assert.equal(auto.eventTimeMs, 1_790_792_249_933, 'UTC epoch seconds with µs, to the millisecond');
  assert.equal(auto.status, 'automatic', 'version 1 / scmag');
  assert.equal(auto.lat, 59.9411);
  assert.equal(auto.lon, -153.2892);
  assert.equal(auto.depth, 154);
  assert.equal(auto.mag, 2);
  assert.equal(auto.magType, 'ML');
  assert.equal(auto.place, '15 km SW of Iliamna Volcano');
  assert.equal(auto.providerUpdatedMs, null, 'the file has no update time');
  assert.deepEqual(auto.knownAliasIds, ['usgs:aka2026tjuoem'], 'the AEC id is the ComCat id');
  assert.equal(auto.fields['event_type'], undefined, 'the "-" placeholder is no type');
  assert.equal(mergeCanonical([auto.fields])['type'], undefined, 'so the published type defaults to earthquake');
  assert.equal(auto.fields['number_phases'], '87', 'every other field is kept verbatim');

  assert.equal(byId.get('aka2026thitnz')!.status, 'reviewed', 'version 2 / analyst');
  assert.equal(byId.get('aka2026thitnz')!.fields['event_type'], 'earthquake');
  assert.equal(byId.get('aka2026snusmn')!.fields['event_type'], 'quarry blast', 'real types pass verbatim, as ComCat publishes them');
  assert.equal(byId.get('aka2026strndn')!.fields['event_type'], 'ice quake');
  assert.equal(byId.get('aka2026stplyl')!.fields['event_type'], 'landslide');
  assert.equal(byId.get('aka2026slmipb')!.magType, 'Mww');
  assert.equal(byId.get('aka2026slmipb')!.mag, 6.5);
  assert.equal(byId.get('aka2026tegabx')!.status, 'automatic');
  assert.equal(byId.get('aka2026tdqxmf')!.lon, 179.6922, 'west of the antimeridian');
  assert.equal(byId.get('aka2026tfcisz')!.lon, -179.8325, 'east of the antimeridian');

  const stale = byId.get('ak2025willqs')!;
  assert.equal(stale.magType, null, 'a timestamp in magnitude_type is no magnitude type');
  assert.equal(stale.mag, null);
  assert.equal(stale.status, 'reviewed', 'version 1 with an analyst magnitude');
  assert.equal(stale.fields['magnitude_type'], '2025112020', 'the raw field is still kept');
  assert.equal(byId.get('ak2025wwbijj')!.fields['event_type'], undefined, '"region name" is no type');
});

test('aec parser: rows without an id, a time or a location are skipped; a body that is not an array fails the fetch', () => {
  const ok = { event_name: 'aka2026aaaaaa', event_time_epoch: '1790792249.5', lat: '60.1', lng: '-150.2', version: 1, magnitude_author: 'scmag', magnitude: '1.20', magnitude_type: 'ML', event_type: '-' };
  const rows = parseAec(
    [
      { event: ok },
      { event: { ...ok, event_name: ' ' } },
      { event: { ...ok, event_name: 'aka2026bbbbbb', lat: null } },
      { event: { ...ok, event_name: 'aka2026cccccc', lng: '' } },
      { event: { ...ok, event_name: 'aka2026dddddd', event_time_epoch: 'x' } },
      null,
      { noevent: true },
      'junk',
    ],
    'aec',
  );
  assert.deepEqual(rows.map((r) => r.providerEventId), ['aka2026aaaaaa']);
  assert.equal(rows[0]!.eventTimeMs, 1_790_792_249_500);
  assert.throws(() => parseAec({ events: [] }, 'aec'), /not a JSON array/);
});

test('aec: the registry entry and the alias rule', () => {
  const p = cfg.get('aec')!;
  assert.equal(p.active, true);
  assert.equal(p.adapter, 'custom');
  assert.equal(p.supportsTimeRange, false);
  assert.equal(p.backfill?.enabled, false, 'forward-only: a rolling file cannot be walked back');
  assert.equal(p.license, 'unknown');
  assert.equal(p.doi, '10.7914/SN/AK');
  assert.match(p.attribution, /Alaska Regional Network/);
  assert.match(p.attribution, /G25AC00133/);
  assert.match(p.attribution, /2024208/);
  assert.deepEqual([...COMCAT_ID_PROVIDERS], ['aec']);
  assert.deepEqual(knownAliasIdsOf('aec', 'aka2026x', {}), ['usgs:aka2026x']);
  assert.deepEqual(knownAliasIdsOf('usgs', 'us7000a', { ids: ',us7000a,aka2026x,' }), ['usgs:aka2026x'], 'ComCat rows unchanged');
  assert.deepEqual(knownAliasIdsOf('emsc', '2026abc', {}), []);
});

// --- identity: exact id, both arrival orders ---

test('aec identity (i): ComCat first, then AEC 25 km and 20 s away: one event, whatever the distance', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  r.ingest(usgs('aka2026tegabx'), INGEST);
  r.ingest(aec('aka2026tegabx', { lat: north(LAT, 25), eventTimeMs: T0 + 20_000 }), INGEST);
  assert.equal(live(map).length, 1);
  assert.equal(providersOf(live(map)[0]!), 'aec:aka2026tegabx usgs:aka2026tegabx');
});

test('aec identity (ii): AEC first, then ComCat of its id 25 km away: one event through the usgs: alias on the node', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  const first = r.ingest(aec('aka2026tegabx', { lat: north(LAT, 25) }), INGEST);
  assert.deepEqual(first.node.aliases, ['aec:aka2026tegabx', 'usgs:aka2026tegabx']);
  const second = r.ingest(usgs('aka2026tegabx'), INGEST);
  assert.equal(second.node.feedId, first.node.feedId);
  assert.equal(live(map).length, 1);
  // The alias survives the run: a new Resolver over the saved map resolves ComCat's next revision by it.
  const next = newResolver(map).ingest(usgs('aka2026tegabx', undefined, { mag: 4.5, providerUpdatedMs: T0 + 900_000 }), INGEST);
  assert.equal(next.node.feedId, first.node.feedId);
  assert.equal(live(map).length, 1);
});

test('aec identity (iii): ComCat preferring another id (us7000…) that lists the AEC id, in both orders and across runs', () => {
  const ids = ['us7000abcd', 'aka2026tegabx'];
  for (const order of ['usgs-first', 'aec-first'] as const) {
    const map = new Map<string, EventNode>();
    const r = newResolver(map);
    const a = aec('aka2026tegabx', { lat: north(LAT, 30), eventTimeMs: T0 - 15_000 });
    const u = usgs('us7000abcd', ids);
    for (const raw of order === 'usgs-first' ? [u, a] : [a, u]) r.ingest(raw, INGEST);
    assert.equal(live(map).length, 1, order);
    assert.equal(providersOf(live(map)[0]!), 'aec:aka2026tegabx usgs:us7000abcd', order);
    assert.equal(live(map)[0]!.chosenProvider, 'usgs', `${order}: the reviewed ComCat solution leads`);
    assert.deepEqual(idSharingPairs(map), []);
  }
  // Across runs: the ComCat event is in the saved map; AEC's report comes in the next run.
  const map = new Map<string, EventNode>();
  newResolver(map).ingest(usgs('us7000abcd', ids), INGEST);
  newResolver(map).ingest(aec('aka2026tegabx', { lat: north(LAT, 30) }), INGEST);
  assert.equal(live(map).length, 1, 'the ComCat index is rebuilt from the saved map');
});

test('aec identity: ComCat associating the AEC id later folds the two events (op:merge, exact id), even when only its ids changed', () => {
  // AEC's automatic solution comes first (minutes after origin); NEIC's, 30 km away, later, not yet linking the id.
  const split = (): Map<string, EventNode> => {
    const map = new Map<string, EventNode>();
    const r = newResolver(map);
    r.ingest(aec('aka2026tegabx', { lat: north(LAT, 30), eventTimeMs: T0 - 25_000 }), INGEST);
    r.ingest(usgs('us7000abcd'), INGEST);
    assert.equal(live(map).length, 2, 'no id link yet, too far apart for the proximity windows');
    return map;
  };
  for (const over of [{}, { mag: 4.6 }]) {
    const map = split();
    const later = newResolver(map).ingest(usgs('us7000abcd', ['us7000abcd', 'aka2026tegabx'], over), INGEST);
    assert.equal(later.changed, true);
    assert.equal(later.merges.length, 1);
    assert.match(later.merges[0]!.reason, /^exact id: ComCat us7000abcd names aka2026tegabx, the id of the aec report/);
    assert.equal(live(map).length, 1);
    assert.equal(providersOf(live(map)[0]!), 'aec:aka2026tegabx usgs:us7000abcd');
    assert.equal(later.merges[0]!.loser.supersededBy, live(map)[0]!.feedId);
    assert.deepEqual(idSharingPairs(map), []);
  }
  assert.equal(newResolver(split()).ingest(usgs('us7000abcd'), INGEST).changed, false, 'an unchanged ComCat re-report stays a no-op');
});

test('aec identity: an exact-id fold never welds events a shared provider keeps apart under two ids', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  r.ingest(aec('aka2026tegabx', { lat: north(LAT, 40), eventTimeMs: T0 - 40_000 }), INGEST);
  r.ingest(emsc('20260930_0000002', { lat: north(LAT, 40), eventTimeMs: T0 - 40_000 }), INGEST);
  r.ingest(usgs('us7000abcd'), INGEST);
  r.ingest(emsc('20260930_0000001'), INGEST);
  assert.equal(live(map).length, 2);
  newResolver(map).ingest(usgs('us7000abcd', ['us7000abcd', 'aka2026tegabx'], { providerUpdatedMs: T0 + 3_600_000 }), INGEST);
  assert.equal(live(map).length, 2, 'EMSC holds them as two events: no fold');
});

test('aec identity: an unmatched AEC solution beside another agency’s event is withheld, not minted, until ComCat publishes its id', () => {
  // 2026-09-28: AEC's automatic aka2026tghflj M2.2 sat 14.7 km and 2.1 s from AVO's reviewed av94453501 M1.96.
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  const av = usgs('av94453501', undefined, { mag: 1.96, lat: 58.2, lon: -154.9, eventTimeMs: T0 + 2_100 });
  r.ingest(av, INGEST);
  const a = aec('aka2026tghflj', { mag: 2.2, lat: north(58.2, 14.7), lon: -154.9 });
  const held = r.ingest(a, INGEST);
  assert.equal(held.changed, false);
  assert.ok(held.withheld, 'withheld');
  assert.equal(held.node.feedId, live(map)[0]!.feedId, 'the result names the event beside it');
  assert.equal(held.withheld!.km.toFixed(1), '14.7');
  assert.equal(map.size, 1, 'no second event');
  // Every run looks again: still withheld.
  assert.ok(newResolver(map).ingest(a, INGEST).withheld);
  // AEC's own second quake beside it is a distinct event: the neighbour holds an aec row, so it mints.
  const map2 = new Map<string, EventNode>();
  const r2 = newResolver(map2);
  r2.ingest(aec('aka2026aaaaaa'), INGEST);
  r2.ingest(usgs('aka2026aaaaaa'), INGEST);
  const second = r2.ingest(aec('aka2026bbbbbb', { lat: north(LAT, 20), eventTimeMs: T0 + 30_000, mag: 3.9 }), INGEST);
  assert.equal(second.withheld, undefined);
  assert.equal(live(map2).length, 2);
  // ComCat publishes the AEC id: its event is found by id from then on.
  const cc = r.ingest(usgs('aka2026tghflj', undefined, { mag: 2.1, lat: north(58.2, 14.7), lon: -154.9, eventTimeMs: T0 }), INGEST);
  const joined = r.ingest(a, INGEST);
  assert.equal(joined.withheld, undefined);
  assert.equal(joined.node.feedId, cc.node.feedId);
  assert.equal(providersOf(joined.node), 'aec:aka2026tghflj usgs:aka2026tghflj');
});

test('aec identity (iv): a dense cell never leaves two live events sharing the id', () => {
  const fill = (r: Resolver): void => {
    for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
      r.ingest(usgs(`ak2026swarm${i}`, undefined, { eventTimeMs: T0 - (i + 1) * 90_000, lat: LAT + (i % 5) * 0.001, mag: 2 }), INGEST);
    }
  };
  for (const order of ['usgs-first', 'aec-first'] as const) {
    const map = new Map<string, EventNode>();
    const r = newResolver(map);
    fill(r);
    const before = live(map).length;
    // 2 km and 5 s apart: inside the normal windows, outside the dense cell's 3 km / 20 s only by the id rule.
    const a = aec('aka2026tegabx', { lat: north(LAT, 2), eventTimeMs: T0 + 5_000, mag: 2.1 });
    const u = usgs('us7000abcd', ['us7000abcd', 'aka2026tegabx'], { mag: 2.2 });
    for (const raw of order === 'usgs-first' ? [u, a] : [a, u]) r.ingest(raw, INGEST);
    assert.equal(live(map).length, before + 1, order);
    assert.deepEqual(idSharingPairs(map), [], order);
  }
});

test('aec identity: two AEC ids near each other are two events (the provider keeps them apart)', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  r.ingest(aec('aka2026aaaaaa'), INGEST);
  r.ingest(aec('aka2026bbbbbb', { eventTimeMs: T0 + 12_000, lat: north(LAT, 3), mag: 3.1 }), INGEST);
  assert.equal(live(map).length, 2);
});

// --- representative choice ---

test('aec identity (vi): the reviewed solution leads; ComCat wins a tie of status', () => {
  const pick = (rows: RawObs[]): string => {
    const map = new Map<string, EventNode>();
    const r = newResolver(map);
    for (const raw of rows) r.ingest(raw, INGEST);
    assert.equal(live(map).length, 1);
    return live(map)[0]!.chosenProvider;
  };
  assert.equal(pick([aec('aka2026x'), usgs('aka2026x')]), 'usgs', 'reviewed ComCat over automatic AEC');
  assert.equal(pick([aec('aka2026x', { status: 'reviewed' }), usgs('aka2026x', undefined, { status: 'automatic' })]), 'aec', 'reviewed AEC over automatic ComCat');
  assert.equal(pick([aec('aka2026x', { status: 'reviewed' }), usgs('aka2026x')]), 'usgs', 'both reviewed: ComCat is richer');
  assert.equal(pick([usgs('aka2026x', undefined, { status: 'automatic' }), aec('aka2026x')]), 'usgs', 'both automatic: ComCat is richer');
});

// --- deletes ---

function deleteRun(map: Map<string, EventNode>, id: string): { resolver: Resolver; log: LogBuffer; withdrawn: number } {
  const resolver = newResolver(map);
  const log = new LogBuffer(1000, INGEST);
  const del = usgs(id);
  const r = resolver.tombstoneProvider(del, INGEST);
  if (r?.changed) log.record(del, r, 'tombstone');
  let withdrawn = 0;
  for (const w of resolver.withdrawComcatTwins(del, INGEST)) {
    log.record(w.raw, w.result, 'tombstone', COMCAT_DELETE_REASON);
    withdrawn++;
  }
  return { resolver, log, withdrawn };
}

test('aec deletes (v): a ComCat delete of the id withdraws the AEC row too; AEC listing it later changes nothing', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  r.ingest(aec('aka2026tegabx'), INGEST);
  r.ingest(usgs('aka2026tegabx'), INGEST);
  const { resolver, log, withdrawn } = deleteRun(map, 'aka2026tegabx');
  assert.equal(withdrawn, 1);
  assert.deepEqual(log.lines.map((l) => [l.op, l.provider, l.reason ?? null]), [
    ['tombstone', 'usgs', null],
    ['tombstone', 'aec', COMCAT_DELETE_REASON],
  ]);
  const node = [...map.values()][0]!;
  assert.equal(node.state, 'tombstoned');
  // The same run: AEC's file still lists the id.
  assert.equal(resolver.ingest(aec('aka2026tegabx'), INGEST).changed, false);
  // Later runs: still nothing, and no new event beside the tombstone.
  const again = newResolver(map).ingest(aec('aka2026tegabx', { mag: 4.4 }), INGEST);
  assert.equal(again.changed, false);
  assert.equal(map.size, 1);
  assert.equal(live(map).length, 0);
  // A repeated delete finds nothing to withdraw.
  assert.equal(deleteRun(map, 'aka2026tegabx').withdrawn, 0);
});

test('aec deletes: an AEC-only event (ComCat never reached the feed) is tombstoned by the ComCat delete of its id', () => {
  const map = new Map<string, EventNode>();
  newResolver(map).ingest(aec('aka2026tegabx'), INGEST);
  const { log, withdrawn } = deleteRun(map, 'aka2026tegabx');
  assert.equal(withdrawn, 1);
  assert.deepEqual(log.lines.map((l) => l.provider), ['aec']);
  assert.equal([...map.values()][0]!.state, 'tombstoned');
});

test('aec deletes: another agency keeps the event live, and the AEC row stays out', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  r.ingest(aec('aka2026tegabx'), INGEST);
  r.ingest(emsc('20260930_0000001'), INGEST);
  r.ingest(usgs('aka2026tegabx'), INGEST);
  deleteRun(map, 'aka2026tegabx');
  const node = live(map)[0]!;
  assert.equal(providersOf(node), 'emsc:20260930_0000001');
  assert.equal(newResolver(map).ingest(aec('aka2026tegabx'), INGEST).changed, false, 'the lost row does not come back');
  assert.equal(providersOf(live(map)[0]!), 'emsc:20260930_0000001');
});

test('aec deletes: a ComCat event deleted before AEC was read keeps AEC from minting it', () => {
  const map = new Map<string, EventNode>();
  newResolver(map).ingest(usgs('aka2026tegabx'), INGEST);
  deleteRun(map, 'aka2026tegabx');
  assert.equal(live(map).length, 0);
  const r = newResolver(map).ingest(aec('aka2026tegabx'), INGEST);
  assert.equal(r.changed, false);
  assert.equal(map.size, 1, 'no new event');
});

test('aec deletes: the log replays to the same state (the AEC op:tombstone goes back through tombstoneProvider)', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  const log = new LogBuffer(0, INGEST);
  for (const raw of [aec('aka2026tegabx'), emsc('20260930_0000001'), usgs('aka2026tegabx')]) log.record(raw, r.ingest(raw, INGEST));
  const del = deleteRun(map, 'aka2026tegabx');
  const lines: Observation[] = [...log.lines, ...del.log.lines];
  const replayed = new Map<string, EventNode>();
  const rr = newResolver(replayed);
  for (const o of lines) {
    const raw = observationToRaw(o);
    if (o.op === 'tombstone') rr.tombstoneProvider(raw, o.ingest_time);
    else rr.ingest(raw, o.ingest_time);
  }
  assert.deepEqual(observationToRaw(log.lines[0]!).knownAliasIds, ['usgs:aka2026tegabx'], 'an aec line names its ComCat id');
  assert.deepEqual(live(replayed).map(providersOf), live(map).map(providersOf));
  assert.deepEqual(live(replayed).map((n) => [...n.aliases].sort()), live(map).map((n) => [...n.aliases].sort()));
});

// --- absence (log only) ---

test('aec absence: live ids younger than 5 days missing from a complete file are counted; a failed fetch counts nothing', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  r.ingest(aec('aka2026keep01'), INGEST);
  r.ingest(aec('aka2026gone01', { eventTimeMs: NOW - DAY, lat: 60, lon: -150 }), INGEST);
  r.ingest(aec('aka2026old001', { eventTimeMs: NOW - 6 * DAY, lat: 61, lon: -151 }), INGEST);
  const listed = [aec('aka2026keep01')];
  assert.deepEqual(vanishedIds(map, [{ provider: 'aec', obs: listed, status: { ok: true } }], NOW), { aec: { count: 1, ids: ['aka2026gone01'] } });
  assert.deepEqual(vanishedIds(map, [{ provider: 'aec', obs: [], status: { ok: false, error: 'timeout' } }], NOW), {});
});
