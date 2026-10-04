import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { vanishedIds } from '../src/absence.js';
import { ABSENCE_LAST_ITEMS_PROVIDERS, ABSENCE_WATCH_PROVIDERS } from '../src/config.js';
import { mexicoTitle } from '../src/custom.js';
import { Resolver } from '../src/dedup.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { PRELIMINARY_SUPERSEDED_REASON, finalsIndex, isPreliminary, supersedingFinal } from '../src/preliminary.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// FEED-5: Mexico's SSN publishes "Preliminar: M 4.4, …" and replaces it minutes later with the reviewed item under
// another id (origin time and position are the adapter's id). The preliminary keeps its magnitude, and once the
// reviewed one is known it is withdrawn (op:tombstone with a reason) and never ingested again.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const NOW = Date.parse('2026-10-04T10:00:00Z');
const INGEST = new Date(NOW).toISOString();
const FLOOR = Date.parse('2026-09-24T00:00:00Z');
const newResolver = (map: Map<string, EventNode>): Resolver => new Resolver(map, prio, cfg, NOW);
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');

/** SSN items as the adapter returns them (2026-10-03: the preliminary 14:33:54 local, the reviewed one 14:33:48). */
function ssn(over: Partial<RawObs> & { title: string }): RawObs {
  const { title, ...rest } = over;
  const head = mexicoTitle(title);
  return {
    provider: 'mexico',
    providerEventId: 'x',
    eventTimeMs: Date.parse('2026-10-03T20:33:54Z'),
    providerUpdatedMs: null,
    status: head.preliminary ? 'automatic' : null,
    lat: 14.77,
    lon: -93.27,
    depth: 10,
    mag: head.mag,
    magType: null,
    place: head.place,
    knownAliasIds: [],
    fields: { title, description: 'Fecha:…' },
    ...rest,
  };
}
const PRELIM = ssn({ providerEventId: '2026-10-03143354_14.77_-93.27', title: 'Preliminar: M 4.4, 85 km al SUROESTE de MAPASTEPEC, CHIS' });
const FINAL = ssn({
  providerEventId: '2026-10-03143348_14.095_-93.375',
  eventTimeMs: Date.parse('2026-10-03T20:33:48Z'),
  lat: 14.095,
  lon: -93.375,
  depth: 16,
  title: '4.4, 188 km al SUROESTE de  MAPASTEPEC, CHIS',
});

test('mexicoTitle: a preliminary title keeps its magnitude and place; a reviewed one is read as before', () => {
  assert.deepEqual(mexicoTitle('Preliminar: M 4.4, 85 km al SUROESTE de MAPASTEPEC, CHIS'), { mag: 4.4, place: '85 km al SUROESTE de MAPASTEPEC, CHIS', preliminary: true });
  assert.deepEqual(mexicoTitle('Preliminar: M 5.3, 42 km al SUR de MANZANILLO, COL'), { mag: 5.3, place: '42 km al SUR de MANZANILLO, COL', preliminary: true });
  assert.deepEqual(mexicoTitle('4.2, 188 km al SUROESTE de  MAPASTEPEC, CHIS'), { mag: 4.2, place: '188 km al SUROESTE de  MAPASTEPEC, CHIS', preliminary: false });
  assert.deepEqual(mexicoTitle('Preliminar: sismo en revisión'), { mag: null, place: 'Preliminar: sismo en revisión', preliminary: true });
  assert.equal(PRELIM.status, 'automatic');
  assert.equal(FINAL.status, null);
  assert.ok(isPreliminary(PRELIM));
  assert.ok(!isPreliminary(FINAL));
  assert.ok(!isPreliminary({ provider: 'usgs', fields: { title: 'Preliminar: M 4' } }), 'only PRELIMINARY_PROVIDERS');
});

test('supersedingFinal: same provider, origin within 60 s and position within 150 km, the closest in time', () => {
  const finals = finalsIndex([FINAL, { ...FINAL, providerEventId: 'far', lat: 17.0 }, { ...FINAL, provider: 'usgs', providerEventId: 'us1' }, PRELIM]);
  assert.deepEqual(finals.map((f) => f.providerEventId), ['2026-10-03143348_14.095_-93.375', 'far'], 'reviewed rows of the provider only');
  assert.equal(supersedingFinal(PRELIM, finals)?.providerEventId, '2026-10-03143348_14.095_-93.375');
  assert.equal(supersedingFinal({ ...PRELIM, eventTimeMs: PRELIM.eventTimeMs + 61_000 }, finals), null, 'more than 60 s');
  assert.equal(supersedingFinal({ ...PRELIM, lat: 11.0 }, finals), null, 'more than 150 km');
});

test('a preliminary event is tombstoned once its reviewed solution is in the map; the log replays; it is idempotent', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  const log = new LogBuffer(0, INGEST);
  for (const raw of [PRELIM, FINAL]) log.record(raw, r.ingest(raw, INGEST));
  // 76 km apart: two events, as in production on 2026-10-03.
  assert.equal(live(map).length, 2);
  const prelimNode = live(map).find((n) => n.provenance.some((x) => x.nativeId === PRELIM.providerEventId))!;
  assert.equal(prelimNode.mag, 4.4, 'the preliminary event had its magnitude');
  const out = r.withdrawSupersededPreliminaries(FLOOR, INGEST);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.by, FINAL.providerEventId);
  assert.equal(out[0]!.raw.providerEventId, PRELIM.providerEventId);
  assert.equal(out[0]!.result.node.state, 'tombstoned');
  for (const w of out) log.record(w.raw, w.result, 'tombstone', PRELIMINARY_SUPERSEDED_REASON);
  assert.deepEqual(live(map).map((n) => n.provenance.map((x) => x.nativeId)), [[FINAL.providerEventId]]);
  assert.deepEqual(r.withdrawSupersededPreliminaries(FLOOR, INGEST), [], 'nothing left to withdraw');
  const last = log.lines.at(-1)!;
  assert.equal(last.op, 'tombstone');
  assert.equal(last.reason, PRELIMINARY_SUPERSEDED_REASON);
  // Replaying the lines (op:tombstone through tombstoneProvider) rebuilds the same live state.
  const replayed = new Map<string, EventNode>();
  const rr = newResolver(replayed);
  for (const o of log.lines as Observation[]) {
    const raw = observationToRaw(o);
    if (o.op === 'tombstone') rr.tombstoneProvider(raw, o.ingest_time);
    else rr.ingest(raw, o.ingest_time);
  }
  assert.deepEqual(live(replayed).map((n) => n.provenance.map((x) => x.nativeId)), [[FINAL.providerEventId]]);
});

test('a preliminary row that joined another agency leaves the event, which stays live with the other row', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  const usgs: RawObs = {
    provider: 'usgs', providerEventId: 'us7000abcd', eventTimeMs: PRELIM.eventTimeMs - 1_000, providerUpdatedMs: NOW - 3_600_000,
    status: 'reviewed', lat: 14.78, lon: -93.26, depth: 10, mag: 4.5, magType: 'mb', place: 'offshore Chiapas, Mexico',
    knownAliasIds: [], fields: { ids: ',us7000abcd,', net: 'us', code: '7000abcd' },
  };
  r.ingest(usgs, INGEST);
  r.ingest(PRELIM, INGEST);
  const joined = live(map).find((n) => n.provenance.some((x) => x.provider === 'usgs'))!;
  assert.ok(joined.provenance.some((x) => x.nativeId === PRELIM.providerEventId), 'the preliminary joined the ComCat event');
  r.ingest(FINAL, INGEST);
  const out = r.withdrawSupersededPreliminaries(FLOOR, INGEST);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.result.node.state, 'live');
  assert.ok(!live(map).some((n) => n.provenance.some((x) => x.nativeId === PRELIM.providerEventId)), 'no live event holds the preliminary row');
  assert.ok(live(map).some((n) => n.provenance.some((x) => x.provider === 'usgs')), 'the ComCat event is still live');
});

test('a frozen day is never touched, and a preliminary without its reviewed solution stays', () => {
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  r.ingest(PRELIM, INGEST);
  r.ingest(FINAL, INGEST);
  assert.deepEqual(r.withdrawSupersededPreliminaries(PRELIM.eventTimeMs + 1, INGEST), [], 'the event day is older than the floor');
  const alone = new Map<string, EventNode>();
  const ra = newResolver(alone);
  ra.ingest(PRELIM, INGEST);
  assert.deepEqual(ra.withdrawSupersededPreliminaries(FLOOR, INGEST), []);
  assert.equal(live(alone).length, 1);
});

test('mexico absence watch: ids younger than the oldest item the RSS still lists are counted, older ones aged out', () => {
  assert.ok(ABSENCE_WATCH_PROVIDERS.includes('mexico'));
  assert.ok(ABSENCE_LAST_ITEMS_PROVIDERS.has('mexico'));
  assert.ok(!ABSENCE_LAST_ITEMS_PROVIDERS.has('aec'), "AEC's file spans more than the window");
  const map = new Map<string, EventNode>();
  const r = newResolver(map);
  const old = ssn({ providerEventId: 'old', eventTimeMs: Date.parse('2026-10-02T08:00:00Z'), lat: 18, lon: -101, title: '3.1, x' });
  r.ingest(old, INGEST);
  r.ingest(PRELIM, INGEST);
  r.ingest(FINAL, INGEST);
  const listing = [FINAL, ssn({ providerEventId: 'oldest-listed', eventTimeMs: Date.parse('2026-10-03T16:05:49Z'), lat: 16, lon: -95, title: '3.0, y' })];
  // The preliminary (20:33:54) vanished from a listing that reaches back to 16:05: counted. `old` aged out: not.
  assert.deepEqual(vanishedIds(map, [{ provider: 'mexico', obs: listing, status: { ok: true } }], NOW), { mexico: { count: 1, ids: [PRELIM.providerEventId] } });
  assert.deepEqual(vanishedIds(map, [{ provider: 'mexico', obs: [], status: { ok: true } }], NOW), {}, 'an empty listing says nothing');
});
