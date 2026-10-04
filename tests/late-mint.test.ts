import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOT_WINDOW_DAYS, LATE_MINT_PROVIDERS, LIVE_INDEX_DAYS, TEMPORAL_MS } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { haversineKm } from '../src/geo.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { FROZEN_AFTER_DAYS, manifestPartitions } from '../src/partitions.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { byIngestOrder } from '../src/quality.js';
import { lateMintReason, revisionSweep } from '../src/sweep.js';
import type { EventNode, RawObs } from '../src/types.js';

// PF-5a: ComCat publishes many events days after their origin, past the live query's 48 h
// lookback; the updatedafter sweep returns them, and a `usgs` row the feed has never seen is now
// minted while its origin is inside the hot window (7 days). Older rows stay skipped.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const INGEST = new Date(NOW).toISOString();
const HEAD_SEQ = 190_000;
const KM_PER_DEG = 111.195;
const north = (lat: number, km: number): number => lat + km / KM_PER_DEG;

/** A ComCat row as the sweep parses it: analyst-released `us` solution, published late. */
function usgs(id: string, ageDays: number, over: Partial<RawObs> = {}): RawObs {
  const eventTimeMs = NOW - ageDays * DAY;
  return {
    provider: 'usgs',
    providerEventId: id,
    eventTimeMs,
    providerUpdatedMs: NOW - 120_000,
    status: 'reviewed',
    lat: -24.6675,
    lon: -175.3398,
    depth: 10,
    mag: 4.9,
    magType: 'mb',
    place: 'south of Tonga',
    knownAliasIds: [],
    fields: { ids: `,${id},`, net: 'us', code: id.slice(2) },
    ...over,
  };
}

function emsc(id: string, eventTimeMs: number, over: Partial<RawObs> = {}): RawObs {
  return {
    provider: 'emsc',
    providerEventId: id,
    eventTimeMs,
    providerUpdatedMs: eventTimeMs + 600_000,
    status: 'automatic',
    lat: -24.6675,
    lon: -175.3398,
    depth: 10,
    mag: 4.8,
    magType: 'mb',
    place: 'SOUTH OF TONGA',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

function sweep(rows: RawObs[], map = new Map<string, EventNode>()) {
  const resolver = new Resolver(map, prio, cfg, NOW);
  const log = new LogBuffer(HEAD_SEQ, INGEST);
  const watermarks: Record<string, number> = {};
  const sorted = [...rows].sort(byIngestOrder);
  const result = revisionSweep(resolver, log, sorted, watermarks, INGEST);
  return { map, resolver, log, watermarks, result };
}

/** A map holding events the live path ingested earlier (at their own first-seen time). */
function seeded(rows: RawObs[]): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  const log = new LogBuffer(HEAD_SEQ - 100, INGEST);
  for (const raw of rows) log.record(raw, r.ingest(raw, new Date(raw.eventTimeMs + 300_000).toISOString()));
  return map;
}

const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');

test('late mint: usgs is the only provider whose sweep mints', () => {
  assert.deepEqual([...LATE_MINT_PROVIDERS], ['usgs']);
  assert.equal(HOT_WINDOW_DAYS, 7, 'the mint window is the hot window');
});

test('late mint: an unknown usgs sweep row 3 days old creates an event, appended now with its true origin time', () => {
  const row = usgs('us7000late', 3);
  const { map, log, watermarks, result } = sweep([row]);

  assert.equal(result.lateMinted.length, 1, 'one late mint');
  assert.equal(result.revisions, 0, 'a mint is not a revision');
  const [node] = live(map);
  assert.ok(node, 'the event exists');
  assert.equal(map.size, 1);
  assert.deepEqual(node.aliases, ['usgs:us7000late']);
  assert.equal(node.eventTimeMs, row.eventTimeMs, 'origin time is the report’s, not the ingest time');
  assert.equal(node.firstIngestTime, INGEST, 'the feed learned of it in this run');
  assert.equal(node.lastIngestTime, INGEST);
  assert.equal(node.revision, 1);
  assert.equal(node.mag, 4.9);

  assert.equal(log.lines.length, 1, 'one log line');
  const line = log.lines[0]!;
  assert.equal(line.op, 'observe');
  assert.equal(line.seq, HEAD_SEQ + 1, 'the next seq of this run');
  assert.equal(line.feed_id, node.feedId);
  assert.equal(line.revision, 1);
  assert.equal(line.ingest_time, INGEST, 'appended now');
  assert.equal(line.event_time, new Date(row.eventTimeMs).toISOString(), 'with the event’s own origin time');
  assert.equal(line.reason, lateMintReason(3));
  assert.match(line.reason!, /updatedafter sweep, 3\.0 d after origin/);
  assert.equal(node.firstSeenSeq, line.seq);
  assert.equal(node.lastSeq, line.seq);
  assert.equal(watermarks['usgs'], row.providerUpdatedMs, 'the watermark advances as before');

  const m = result.lateMinted[0]!;
  assert.equal(m.feedId, node.feedId);
  assert.equal(m.providerEventId, 'us7000late');
  assert.equal(m.mag, 4.9);
  assert.equal(m.lagDays.toFixed(1), '3.0');

  // The logged line replays to the same event (replay feeds every line to Resolver.ingest).
  const replayed = new Map<string, EventNode>();
  new Resolver(replayed, prio, cfg, NOW).ingest(observationToRaw(line), line.ingest_time);
  assert.deepEqual([...replayed.keys()], [node.feedId], 'replay mints the same feed id');
});

test('late mint: the same row 8 days old is skipped (below the hot floor only ids match)', () => {
  const row = usgs('us7000late', 8);
  const { map, log, watermarks, result } = sweep([row]);
  assert.equal(result.lateMinted.length, 0);
  assert.equal(result.revisions, 0);
  assert.equal(map.size, 0, 'no event');
  assert.equal(log.lines.length, 0, 'nothing appended');
  assert.equal(watermarks['usgs'], row.providerUpdatedMs, 'the watermark still counts it as seen');
});

test('late mint: the boundary is the hot floor itself', () => {
  const inside = usgs('us7000edge', HOT_WINDOW_DAYS - 1 / 24);
  const outside = usgs('us7000past', HOT_WINDOW_DAYS + 1 / 24, { lat: 10, lon: 140 });
  const { map, result } = sweep([inside, outside]);
  assert.deepEqual(result.lateMinted.map((m) => m.providerEventId), ['us7000edge']);
  assert.equal(map.size, 1);
});

test('late mint: a row less than one identity window above the hot floor is skipped, since its twin may sit just below the floor, outside the spatial index', () => {
  // Another agency's copy of the quake 30 s older than the late ComCat row, 5 km away: the copy is
  // 10 s below the hot floor, so neither findExisting nor lateTwin can see it; minting the row
  // would put a second live event beside it.
  const floor = NOW - HOT_WINDOW_DAYS * DAY;
  const map = seeded([emsc('20260923_0000777', floor - 10_000, { lat: 36.4, lon: 70.7, mag: 4.4, place: 'HINDU KUSH REGION, AFGHANISTAN' })]);
  const row = usgs('us7000edgt', HOT_WINDOW_DAYS, { eventTimeMs: floor + 20_000, lat: north(36.4, 5), lon: 70.7, mag: 4.5, place: '35 km SE of Jurm, Afghanistan' });
  const { log, result } = sweep([row], map);
  assert.equal(result.lateMinted.length, 0, 'not minted');
  assert.equal(result.lateWithheld.length, 0);
  assert.equal(live(map).length, 1, 'still one live event');
  assert.equal(log.lines.length, 0, 'nothing appended');

  // One identity window above the floor every event the row could be matched against is indexed.
  const clear = usgs('us7000edgu', HOT_WINDOW_DAYS, { eventTimeMs: floor + TEMPORAL_MS, lat: 10, lon: 140 });
  assert.equal(sweep([clear]).result.lateMinted.length, 1, 'a row TEMPORAL_MS above the floor mints');
});

test('late mint: the spatial match and the twin check work across the antimeridian', () => {
  const origin = NOW - 4 * DAY;
  const fiji = (): Map<string, EventNode> => seeded([emsc('20260926_0000555', origin, { lat: -17.9, lon: 179.97, mag: 4.8, place: 'FIJI ISLANDS REGION' })]);

  // ComCat's solution 3 s later and ~6 km away on the other side of 180°: one event.
  const nearMap = fiji();
  const near = usgs('us7000fjin', 4, { eventTimeMs: origin + 3_000, lat: -17.9, lon: -179.97, mag: 4.7, place: 'Fiji region' });
  assert.ok(haversineKm(-17.9, 179.97, near.lat, near.lon) < 7);
  const a = sweep([near], nearMap);
  assert.equal(a.result.lateMinted.length, 0);
  assert.equal(a.result.revisions, 1, 'folded into the EMSC event across 180°');
  assert.equal(live(nearMap).length, 1);

  // 17 km away across 180° and 25 s later: past every identity window (the moderate-event window of FEED-1 takes
  // 20 s at most), so the twin check withholds it.
  const farMap = fiji();
  const far = usgs('us7000fjif', 4, { eventTimeMs: origin + 25_000, lat: -17.9, lon: -179.87, mag: 4.7, place: 'Fiji region' });
  const km = haversineKm(-17.9, 179.97, far.lat, far.lon);
  assert.ok(km > 15 && km < 20, `${km} km`);
  const b = sweep([far], farMap);
  assert.equal(b.result.lateMinted.length, 0, 'not minted');
  assert.equal(b.result.lateWithheld.length, 1, 'withheld beside the EMSC event across 180°');
  assert.equal(live(farMap).length, 1);
});

test('late mint: a day the 5-minute run can still add to is never flagged frozen', () => {
  assert.equal(FROZEN_AFTER_DAYS, LIVE_INDEX_DAYS, 'frozen once aggregate no longer loads the day');
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const inv: Record<string, { count: number; bytes: number; min_mag: number | null; max_mag: number | null }> = {};
  for (let d = 0; d <= LIVE_INDEX_DAYS + 3; d++) inv[day(NOW - d * DAY)] = { count: 1, bytes: 1, min_mag: 1, max_mag: 1 };
  const parts = new Map(manifestPartitions(inv, NOW).map((p) => [p.date, p.frozen]));
  // The oldest origin a late mint can have, and the oldest day aggregate loads (revisions, deletes).
  assert.equal(parts.get(day(NOW - HOT_WINDOW_DAYS * DAY + TEMPORAL_MS)), false, 'the hot floor day is not frozen');
  assert.equal(parts.get(day(NOW - LIVE_INDEX_DAYS * DAY)), false, 'the oldest loaded day is not frozen');
  assert.equal(parts.get(day(NOW - (LIVE_INDEX_DAYS + 1) * DAY)), true, 'the day before it is');
  assert.equal(parts.get(day(NOW - 4 * DAY)), false, 'a 4-day-old day (frozen before 2026-09-30) is not');
});

test('late mint: a known id is still only a revision, inside and past the hot window', () => {
  const recent = usgs('us7000knwn', 3, { status: 'automatic', mag: 4.6, providerUpdatedMs: NOW - 3 * DAY + 600_000 });
  const old = usgs('us7000olde', 8, { lat: 10, lon: 140, status: 'automatic', mag: 4.2, providerUpdatedMs: NOW - 8 * DAY + 600_000 });
  const map = seeded([old, recent]);
  const ids = [...map.keys()].sort();
  assert.equal(ids.length, 2);

  const { log, result } = sweep(
    [
      { ...recent, status: 'reviewed', mag: 4.9, providerUpdatedMs: NOW - 60_000 },
      { ...old, status: 'reviewed', mag: 4.4, providerUpdatedMs: NOW - 60_000 },
    ],
    map,
  );
  assert.equal(result.lateMinted.length, 0, 'nothing minted');
  assert.equal(result.revisions, 2, 'both revised');
  assert.deepEqual([...map.keys()].sort(), ids, 'no new feed id');
  for (const l of log.lines) {
    assert.equal(l.op, 'observe');
    assert.equal(l.revision, 2);
    assert.equal(l.reason, undefined, 'a revision carries no late-mint reason');
  }
  assert.equal(map.get(log.lines.find((l) => l.provider_event_id === 'us7000knwn')!.feed_id)!.mag, 4.9);
});

test('late mint: an unknown usgs row that matches another provider’s event by location folds into it', () => {
  const origin = NOW - 3 * DAY;
  const map = seeded([emsc('20260927_0000042', origin)]);
  const [emscNode] = live(map);
  assert.ok(emscNode);

  // ComCat's solution 4 s and ~6 km away, published three days late under an id the feed never saw.
  const row = usgs('us7000fold', 3, { eventTimeMs: origin + 4_000, lat: north(-24.6675, 6) });
  const { log, result } = sweep([row], map);
  assert.equal(result.lateMinted.length, 0, 'no mint');
  assert.equal(result.revisions, 1, 'it revises the event that holds it');
  assert.equal(live(map).length, 1, 'still one live event');
  assert.equal(map.size, 1, 'no duplicate node');
  assert.deepEqual([...emscNode.aliases].sort(), ['emsc:20260927_0000042', 'usgs:us7000fold']);
  assert.equal(emscNode.chosenProvider, 'usgs', 'the reviewed ComCat solution leads');
  assert.equal(log.lines.length, 1);
  assert.equal(log.lines[0]!.feed_id, emscNode.feedId);
  assert.equal(log.lines[0]!.reason, undefined);
});

test('late mint: an unknown row beside another provider’s event, past the identity window, is withheld, not minted', () => {
  // us6000tx60 (dry run 2026-09-30): ComCat M4.6 published 6.8 d late, 15.8 km and 1.4 s from the
  // GEOFON + EMSC M4.7 the feed already showed. Until FEED-1 the identity window (±10 km below M5.5) kept them apart
  // and the twin check withheld the row; since FEED-1 the moderate-event window (M4.6: 32 km × 0.97) makes it the
  // same event, a revision.
  const origin = NOW - 6.8 * DAY;
  const colombia = (): Map<string, EventNode> =>
    seeded([emsc('20260923_0000331', origin - 1_400, { lat: 6.28, lon: -75.61, mag: 4.7, place: 'NORTHERN COLOMBIA' })]);
  const joined = colombia();
  const real = sweep([usgs('us6000tx60', 6.8, { eventTimeMs: origin, lat: north(6.28, 15.8), lon: -75.61, mag: 4.6, place: '9 km S of San Antonio, Colombia' })], joined);
  assert.equal(real.result.lateMinted.length, 0);
  assert.equal(real.result.lateWithheld.length, 0);
  assert.equal(real.result.revisions, 1, 'one event with the EMSC copy');
  assert.equal(live(joined).length, 1);
  // The same row 25 s from EMSC's: past every identity window, so the twin check withholds it.
  const map = colombia();
  const before = map.size;
  const row = usgs('us6000tx60', 6.8, { eventTimeMs: origin + 23_600, lat: north(6.28, 15.8), lon: -75.61, mag: 4.6, place: '9 km S of San Antonio, Colombia' });
  const { log, result } = sweep([row], map);
  assert.equal(result.lateMinted.length, 0, 'not minted');
  assert.equal(result.revisions, 0);
  assert.equal(result.lateWithheld.length, 1);
  const w = result.lateWithheld[0]!;
  assert.equal(w.providerEventId, 'us6000tx60');
  assert.deepEqual(w.nearProviders, ['emsc']);
  assert.equal(w.km.toFixed(1), '15.8');
  assert.equal(w.dtS, -25);
  assert.equal(map.size, before, 'no new event');
  assert.equal(log.lines.length, 0, 'nothing appended');
});

test('late mint: the twin check stops at ±60 s, 50 km and |ΔM| ≤ 1, and never at the provider’s own distinct id', () => {
  const origin = NOW - 4 * DAY;
  const lat = 33.2;
  const lon = -115.6;
  // A live SCEDC + ComCat event (ci41338503) the late ComCat row does not name: ComCat keeps the two
  // apart itself (two small quakes 6 s apart in a swarm), so the late row mints beside it.
  const swarm = seeded([
    { ...usgs('ci41338503', 4, { eventTimeMs: origin, lat, lon, mag: 1.31, status: 'reviewed', place: 'Niland, CA' }) },
    emsc('20260926_0000001', origin + 0, { lat, lon, mag: 1.3, place: 'SOUTHERN CALIFORNIA' }),
  ]);
  const own = sweep([usgs('ci10254542', 4, { eventTimeMs: origin + 6_440, lat: north(lat, 0.9), lon, mag: 1.2, place: 'Niland, CA' })], swarm);
  assert.equal(own.result.lateMinted.length, 1, 'a distinct id of the same provider mints');

  const base = (): Map<string, EventNode> => seeded([emsc('20260926_0000002', origin, { lat: 40, lon: 25, mag: 4.5 })]);
  const cases: [string, Partial<RawObs>, 'minted' | 'withheld'][] = [
    ['61 s apart', { eventTimeMs: origin + 61_000, lat: north(40, 15), lon: 25, mag: 4.5 }, 'minted'],
    ['55 km apart', { eventTimeMs: origin + 2_000, lat: north(40, 55), lon: 25, mag: 4.5 }, 'minted'],
    ['ΔM 1.2', { eventTimeMs: origin + 2_000, lat: north(40, 15), lon: 25, mag: 3.3 }, 'minted'],
    ['ΔM 1.0 at 49 km', { eventTimeMs: origin + 59_000, lat: north(40, 49), lon: 25, mag: 3.5 }, 'withheld'],
    ['no magnitude', { eventTimeMs: origin + 2_000, lat: north(40, 15), lon: 25, mag: null }, 'withheld'],
  ];
  for (const [label, over, want] of cases) {
    const { result } = sweep([usgs('us7000case', 4, over)], base());
    assert.equal(result.lateMinted.length, want === 'minted' ? 1 : 0, `${label}: minted`);
    assert.equal(result.lateWithheld.length, want === 'withheld' ? 1 : 0, `${label}: withheld`);
  }
});

test('late mint: an unknown usgs row that shares a ComCat id with a known event is a revision', () => {
  const map = seeded([usgs('ak0261abcd', 4, { lat: 60.1, lon: -152.8, status: 'automatic', mag: 3.1, place: 'Southern Alaska', fields: { ids: ',ak0261abcd,' } })]);
  const row = usgs('us7000alsk', 4, { lat: 60.2, lon: -152.7, mag: 3.3, place: 'Southern Alaska', fields: { ids: ',us7000alsk,ak0261abcd,' }, knownAliasIds: ['usgs:ak0261abcd'] });
  const { result } = sweep([row], map);
  assert.equal(result.lateMinted.length, 0);
  assert.equal(result.revisions, 1);
  assert.equal(live(map).length, 1);
});

test('late mint: other providers’ sweep rows never mint (unchanged behaviour)', () => {
  const { map, log, watermarks, result } = sweep([emsc('20260927_0000099', NOW - 3 * DAY, { providerUpdatedMs: NOW - 60_000 })]);
  assert.equal(result.lateMinted.length, 0);
  assert.equal(result.revisions, 0);
  assert.equal(map.size, 0);
  assert.equal(log.lines.length, 0);
  assert.equal(watermarks['emsc'], NOW - 60_000);
});

test('late mint: late_minted counts only the mints, in ingest order, with one seq each', () => {
  const known = usgs('us7000knwn', 2.5, { lat: 36.1, lon: 70.9, status: 'automatic', mag: 4.3, place: 'Hindu Kush', providerUpdatedMs: NOW - 2.5 * DAY + 600_000 });
  const map = seeded([known, emsc('20260926_0000007', NOW - 4 * DAY, { lat: 11.945, lon: 143.9047 })]);
  const rows = [
    usgs('us7000aaaa', 5, { lat: -6.1, lon: 147.2, mag: 4.5, place: 'Papua New Guinea' }),
    usgs('ak0261late', 2.2, { lat: 51.8, lon: -176.4, mag: 3.0, place: 'Andreanof Islands, Aleutian Islands, Alaska' }),
    usgs('us7000olde', 9, { lat: 19.2, lon: -155.4, mag: 3.1, place: 'Hawaii' }),
    { ...known, status: 'reviewed', mag: 4.5, providerUpdatedMs: NOW - 30_000 },
    usgs('us7000guam', 4, { eventTimeMs: NOW - 4 * DAY + 2_000, lat: 11.95, lon: 143.91, mag: 4.7, place: 'south of Guam' }),
    emsc('20260929_0000123', NOW - 3 * DAY, { lat: 40, lon: 20 }),
    // M3.9: below the moderate-event window of FEED-1, so 20 km keeps it off the EMSC copy (M4.8).
    usgs('us7000twin', 4, { eventTimeMs: NOW - 4 * DAY - 1_000, lat: north(11.945, 20), lon: 143.9047, mag: 3.9, place: 'south of Guam' }),
  ];
  const before = map.size;
  const { log, result } = sweep(rows, map);
  assert.deepEqual(
    result.lateMinted.map((m) => m.providerEventId),
    ['us7000aaaa', 'ak0261late'],
    'the 5-day and 2.2-day unknown ids mint, in event-time order; the 9-day one does not',
  );
  assert.equal(result.revisions, 2, 'the known id and the Guam row that folded into EMSC’s copy');
  assert.deepEqual(result.lateWithheld.map((w) => w.providerEventId), ['us7000twin'], 'the row 20 km from that copy is withheld');
  assert.equal(map.size, before + 2);
  const mintLines = log.lines.filter((l) => l.reason);
  assert.equal(mintLines.length, 2);
  assert.deepEqual(
    log.lines.map((l) => l.seq),
    log.lines.map((_, i) => HEAD_SEQ + 1 + i),
    'every line its own seq, no gaps',
  );
  for (const l of mintLines) assert.equal(l.revision, 1);
});
