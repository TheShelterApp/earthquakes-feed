import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { HOT_WINDOW_DAYS } from '../src/config.js';
import { REHOMED_REASON_PREFIX, Resolver } from '../src/dedup.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// Round 15 (round 14's finding (a)): ComCat publishes one quake under several ids when several networks locate it, and
// associates them into one event later; its `ids` then list every id. The feed may hold an id as an event of its own,
// minted before the association. Nevada, 2026-10-03 13:58 UTC: Nevada's automatic nn00925220 (M2.65), Utah's
// automatic uu80158431 (M3.04, 148 km away, with EMSC's copy 20261003_0000160) and NEIC's reviewed us6000tzcn (M3.3)
// each minted an event; on 2026-10-05 ComCat's revised nn00925220 (reviewed M3.29) listed
// ",uu80158431,us6000tzcn,nn00925220,", folded with us6000tzcn's event by proximity, and Utah's row stayed a second
// live event of the quake 148 km and 22.9 s away. The fixture is production's: every log line of the four ids, and the
// two live events as the event map of origin/data dae9220725 holds them.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);

const LINES: Observation[] = readFileSync(here('fixtures/comcat-siblings-2026-10-03.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);
const STORED: EventNode[] = readFileSync(here('fixtures/comcat-siblings-2026-10-03-event-map.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as EventNode);
const NEIC_EVENT = 'efd_01M410XCJ040XZ7F9A5Y6PYHBX';
const UTAH_EVENT = 'efd_01M410Y9VGK3TVKK541G72DRZE';
const NOW = Date.parse('2026-10-06T02:47:07Z');
const INGEST = '2026-10-06T02:52:00.000Z';
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const storedMap = (): Map<string, EventNode> => new Map(STORED.map((n) => [n.feedId, clone(n)]));

/** Production's runs: the logged lines in seq order, each run's merges and re-homes included (op:merge and
 *  op:correction lines are the rules' own effects; a re-home's op:tombstone is the effect of the line after it). */
function replay(nowMs = NOW): { map: Map<string, EventNode>; reasons: string[] } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs);
  const reasons: string[] = [];
  for (const o of LINES) {
    if (o.op === 'tombstone' && !o.reason?.startsWith(REHOMED_REASON_PREFIX)) r.tombstoneProvider(observationToRaw(o), o.ingest_time);
    if (o.op !== 'observe') continue;
    for (const m of r.ingest(observationToRaw(o), o.ingest_time).merges) reasons.push(m.reason);
  }
  return { map, reasons };
}

test('comcat siblings: production holds the quake as two live events, ComCat\'s row of one listing the other\'s id', () => {
  const map = storedMap();
  assert.deepEqual(live(map).map(rowsOf).sort(), ['emsc:20261003_0000160 usgs:nn00925220 usgs:us6000tzcn', 'usgs:uu80158431']);
  const nn = map.get(NEIC_EVENT)!.provenance.find((r) => r.nativeId === 'nn00925220')!;
  assert.equal(nn.fields['ids'], ',uu80158431,us6000tzcn,nn00925220,');
});

test('comcat siblings: the log replays to one event; the revision that lists the ids folds Utah\'s event by identity', () => {
  const { map, reasons } = replay();
  assert.deepEqual(live(map).map(rowsOf), ['emsc:20261003_0000160 usgs:nn00925220 usgs:us6000tzcn usgs:uu80158431']);
  assert.ok(reasons.some((x) => x === "exact id: ComCat nn00925220 lists uu80158431, ComCat's own row of the other event"), reasons.join(' | '));
});

test('comcat siblings: the regular heal folds the two live events of production, once, with an op:merge and an op:correction line', () => {
  const map = storedMap();
  const r = new Resolver(map, prio, cfg, NOW);
  const { merges, survivors } = r.heal(INGEST);
  assert.equal(merges.length, 1);
  assert.equal(merges[0]!.reason, "exact id: ComCat nn00925220 lists uu80158431, ComCat's own row of the other event");
  assert.deepEqual([merges[0]!.survivor.feedId, merges[0]!.loser.feedId], [NEIC_EVENT, UTAH_EVENT]);
  assert.deepEqual(live(map).map(rowsOf), ['emsc:20261003_0000160 usgs:nn00925220 usgs:us6000tzcn usgs:uu80158431']);
  // The survivor keeps the reviewed solution it showed.
  const s = map.get(NEIC_EVENT)!;
  assert.deepEqual([s.chosenProvider, s.mag, s.status], ['usgs', 3.29, 'reviewed']);
  assert.equal(map.get(UTAH_EVENT)!.state, 'superseded');
  assert.equal(map.get(UTAH_EVENT)!.supersededBy, NEIC_EVENT);
  const log = new LogBuffer(207_668, INGEST);
  log.recordFolds(merges, survivors, 'heal');
  assert.deepEqual(log.lines.map((l) => [l.op, l.feed_id]), [['merge', UTAH_EVENT], ['correction', NEIC_EVENT]]);
  for (const l of log.lines) assert.ok(vObs(l), JSON.stringify(vObs.errors));
  // Idempotent: the next run folds nothing.
  assert.equal(new Resolver(map, prio, cfg, NOW + 300_000).heal(INGEST).merges.length, 0);
  // Utah's id resolves to the survivor from now on.
  const again = new Resolver(map, prio, cfg, NOW + 600_000);
  const utah = LINES.find((o) => o.provider_event_id === 'uu80158431')!;
  assert.equal(again.ingest(observationToRaw(utah), INGEST).node.feedId, NEIC_EVENT);
});

test('comcat siblings: nothing folds outside the hot window, and without a listing ComCat row the events stay apart', () => {
  // Eight days later the quake is outside the hot window: the heal leaves both events (their days freeze as they are).
  const late = storedMap();
  assert.equal(new Resolver(late, prio, cfg, NOW + (HOT_WINDOW_DAYS - 2) * 86_400_000).heal(INGEST).merges.length, 0);
  assert.equal(live(late).length, 2);
  // A fold never reaches an event outside the hot window, even from one inside it (here Utah's event as if it were
  // five days older: 2026-09-28 13:58, below the hot floor of 2026-09-29 02:47).
  const older = storedMap();
  const utah = older.get(UTAH_EVENT)!;
  utah.eventTimeMs -= 5 * 86_400_000;
  for (const r of utah.provenance) r.eventTimeMs -= 5 * 86_400_000;
  assert.equal(new Resolver(older, prio, cfg, NOW).heal(INGEST).merges.length, 0);
  assert.equal(live(older).length, 2);
  // ComCat's row lists only its own id: no identity, and 148 km is beyond every window.
  const unlinked = storedMap();
  unlinked.get(NEIC_EVENT)!.provenance.find((r) => r.nativeId === 'nn00925220')!.fields['ids'] = ',nn00925220,';
  assert.equal(new Resolver(unlinked, prio, cfg, NOW).heal(INGEST).merges.length, 0);
  assert.equal(live(unlinked).length, 2);
});

test('comcat siblings: another provider that holds the two as distinct ids keeps them apart', () => {
  const map = storedMap();
  // EMSC lists a quake of its own in Utah's event under another id, another solution than its copy in the other event.
  const utah = map.get(UTAH_EVENT)!;
  const own = utah.provenance[0]!;
  utah.provenance.push({ ...clone(own), provider: 'emsc', nativeId: '20261003_0000161', chosen: false, fields: {}, mag: 2.9, eventTimeMs: own.eventTimeMs + 40_000 });
  utah.aliases.push('emsc:20261003_0000161');
  assert.equal(new Resolver(map, prio, cfg, NOW).heal(INGEST).merges.length, 0);
  assert.equal(live(map).length, 2);
});

test('comcat siblings: a ComCat report whose `ids` alone changed is stored and folds its sibling at once', () => {
  const map = storedMap();
  const nn = map.get(NEIC_EVENT)!.provenance.find((r) => r.nativeId === 'nn00925220')!;
  // ComCat's report as stored, then the stored row before the association: the same solution, without Utah's id.
  const report: RawObs = {
    provider: nn.provider, providerEventId: nn.nativeId, eventTimeMs: nn.eventTimeMs, providerUpdatedMs: nn.providerUpdatedMs,
    status: nn.status, lat: nn.lat, lon: nn.lon, depth: nn.depth, mag: nn.mag, magType: nn.magType, place: nn.place,
    knownAliasIds: ['usgs:uu80158431', 'usgs:us6000tzcn'], fields: clone(nn.fields),
  };
  nn.fields['ids'] = ',us6000tzcn,nn00925220,';
  const r = new Resolver(map, prio, cfg, NOW);
  const res = r.ingest(report, INGEST);
  assert.equal(res.changed, true);
  assert.equal(res.merges.length, 1);
  assert.equal(res.merges[0]!.loser.feedId, UTAH_EVENT);
  assert.equal(res.node.feedId, NEIC_EVENT);
  assert.equal(map.get(NEIC_EVENT)!.provenance.find((x) => x.nativeId === 'nn00925220')!.fields['ids'], ',uu80158431,us6000tzcn,nn00925220,');
});

test('comcat siblings: the heal folds an exact-id pair only when both events are inside the hot window', () => {
  // Since round 15 the heal's passes run foldComcatTwins with `hotOnly`: an NCEDC event and ComCat's row of the same id
  // (nc…) fold by identity there, but never with an event below the hot floor (the heal's scope; the ingest path keeps
  // its own rule). Two separately minted events, 30 km apart (beyond every window), straddling the floor by 5 s.
  const floor = NOW - HOT_WINDOW_DAYS * 86_400_000;
  const report = (provider: string, id: string, eventTimeMs: number, lat: number, fields: RawObs['fields']): RawObs => ({
    provider, providerEventId: id, eventTimeMs, providerUpdatedMs: null, status: 'automatic', lat, lon: -121.5, depth: 5,
    mag: 2.1, magType: 'md', place: null, knownAliasIds: [], fields,
  });
  const two = (ncedcMs: number, usgsMs: number): Map<string, EventNode> => {
    const a = new Map<string, EventNode>();
    new Resolver(a, prio, cfg, NOW, { hotFloorMs: 0 }).ingest(report('ncedc', '75990001', ncedcMs, 37.5, { EventID: '75990001' }), INGEST);
    const b = new Map<string, EventNode>();
    new Resolver(b, prio, cfg, NOW, { hotFloorMs: 0 }).ingest(report('usgs', 'nc75990001', usgsMs, 37.5 + 30 / 111.195, { ids: ',nc75990001,' }), INGEST);
    return new Map([...a, ...b]);
  };
  // Both inside: one event, by identity.
  const inside = two(floor + 60_000, floor + 65_000);
  const folded = new Resolver(inside, prio, cfg, NOW).heal(INGEST).merges;
  assert.equal(folded.length, 1);
  assert.match(folded[0]!.reason, /^exact id/);
  assert.equal(live(inside).length, 1);
  // ComCat's row 5 s below the floor: the heal leaves both.
  const straddling = two(floor + 5_000, floor - 5_000);
  assert.equal(new Resolver(straddling, prio, cfg, NOW).heal(INGEST).merges.length, 0);
  assert.equal(live(straddling).length, 2);
});
