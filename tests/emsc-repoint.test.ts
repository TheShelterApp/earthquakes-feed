import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { REHOMED_REASON_PREFIX, Resolver, type IngestResult } from '../src/dedup.js';
import { runFeedSideSteps } from '../src/heal.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// FEED-2: EMSC sometimes points an event id at another agency event. On 2026-10-03 near Valencia EMSC
// 20261003_0000060 (auth IGN) copied IGN es2026tiyjb (05:09:14), then es2026tiyjg (05:09:28), then es2026tiyil
// (05:08:31); 20261003_0000066 copied es2026tiylm (05:12:04), then es2026tiymd (05:12:49). Production left each EMSC
// row in the event it joined first: that event moved to the other quake's solution (EMSC's row led it) while IGN's own
// row of that quake stood beside it as a second event, and the quake the event had been (tiyjb, tiylm) vanished from
// the map. The fixture holds the real log lines, in seq order.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');
const NOW = Date.parse('2026-10-03T06:30:00Z');

const LINES: Observation[] = readFileSync(here('fixtures/emsc-repoint-2026-10-03.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);
const bySeq = (seq: number): Observation => LINES.find((o) => o.seq === seq)!;

/** The events the fixture's quakes should end in: each IGN quake once, each EMSC row with the IGN row it copies last. */
const EXPECTED = [
  'emsc:20261003_0000060 ign:es2026tiyil',
  'emsc:20261003_0000066 ign:es2026tiymd',
  'ign:es2026tiyjb',
  'ign:es2026tiyjg',
  'ign:es2026tiylm',
];

/** Background events around Valencia: more than SWARM_CELL_ABSOLUTE in the cell when `dense`. */
function resolverFor(dense: boolean, merge = true): { map: Map<string, EventNode>; r: Resolver; base: number } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW, { merge });
  if (dense) {
    for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
      const id = `es2026bg${String(i).padStart(3, '0')}`;
      r.ingest(
        {
          provider: 'ign', providerEventId: id, eventTimeMs: Date.parse('2026-10-03T04:00:00Z') - i * 120_000, providerUpdatedMs: null, status: null,
          lat: 38.958 + ((i % 5) - 2) * 0.001, lon: -0.38 + ((i % 3) - 1) * 0.001, depth: 5, mag: 1.2, magType: 'mbLg',
          place: 'background', knownAliasIds: [], fields: { evid: id },
        },
        new Date(NOW).toISOString(),
      );
    }
  }
  return { map, r, base: live(map).length };
}

/** Production's runs: every logged line in seq order, then the next run's listing of each EMSC id's latest report. */
function run(r: Resolver, log?: LogBuffer): Map<number, IngestResult> {
  const results = new Map<number, IngestResult>();
  for (const o of LINES) {
    const raw = observationToRaw(o);
    const res = r.ingest(raw, o.ingest_time);
    results.set(o.seq, res);
    if (res.changed) log?.record(raw, res);
  }
  for (const seq of [200733, 200752]) {
    const o = bySeq(seq);
    const raw = observationToRaw(o);
    const res = r.ingest(raw, '2026-10-03T06:17:00.000Z');
    results.set(-seq, res);
    if (res.changed) log?.record(raw, res);
  }
  return results;
}

test('the 2026-10-03 Valencia sequence ends with each IGN quake once and each EMSC copy beside the row it copies', () => {
  for (const dense of [false, true]) {
    const { map, r, base } = resolverFor(dense);
    const res = run(r);
    const label = dense ? 'dense cell' : 'sparse cell';
    assert.equal(live(map).length, base + 5, label);
    assert.deepEqual(
      live(map)
        .filter((n) => n.provenance.some((x) => !x.nativeId.startsWith('es2026bg')))
        .map(rowsOf)
        .sort(),
      EXPECTED,
      label,
    );
    // 05:42 run: the revision copies tiyjg, which IGN has not published yet: applied where it stands, as before.
    assert.equal(res.get(200729)!.rehomed, undefined, label);
    assert.equal(res.get(200729)!.changed, true, label);
    // 05:52 run: tiyjg is in (its own event: IGN's tiyjb keeps it off EMSC's), but the revision now copies tiyil,
    // not in yet: applied where it stands again.
    assert.equal(res.get(200733)!.rehomed, undefined, label);
    // The next run lists that row again, unchanged, with tiyil in: re-homed.
    assert.ok(res.get(-200733)!.rehomed, label);
    // 06:12 run: tiymd came in the same run, before EMSC's revision (ingest order is event time): re-homed at once.
    assert.ok(res.get(200752)!.rehomed, label);
    assert.equal(r.rehomedCopies.length, 2, label);
    // The event EMSC's row left shows its own quake again.
    const tiyjb = live(map).find((n) => n.aliases.includes('ign:es2026tiyjb'))!;
    assert.equal(tiyjb.eventTimeMs, Date.parse('2026-10-03T05:09:14.000Z'), label);
    assert.equal(tiyjb.aliases.includes('emsc:20261003_0000060'), false, `${label}: the EMSC id is taken off the event it left`);
  }
});

test('a re-home is logged as the withdrawal (op:tombstone with a reason) then the report in its new event', () => {
  const { r } = resolverFor(false);
  const log = new LogBuffer(200716, '2026-10-03T06:17:00.000Z');
  run(r, log);
  for (const l of log.lines) assert.ok(vObs(l), JSON.stringify(vObs.errors));
  assert.deepEqual(log.lines.map((l) => l.seq), log.lines.map((_, i) => 200717 + i), 'one seq per line, in order');
  const rehomes = log.lines.filter((l) => l.op === 'tombstone');
  assert.equal(rehomes.length, 2);
  for (const t of rehomes) {
    assert.ok(t.reason?.startsWith(REHOMED_REASON_PREFIX), t.reason);
    const next = log.lines[log.lines.indexOf(t) + 1]!;
    assert.equal(next.op, 'observe');
    assert.equal(next.provider_event_id, t.provider_event_id, 'the report itself follows its withdrawal');
    assert.notEqual(next.feed_id, t.feed_id, 'into another event');
  }
  const [first, second] = rehomes;
  assert.match(first!.reason!, /EMSC 20261003_0000066 \(auth IGN\) copies ign es2026tiymd/, 'the 06:12 run');
  assert.match(second!.reason!, /EMSC 20261003_0000060 \(auth IGN\) copies ign es2026tiyil/, 'the run after');
  // The withdrawal line carries the row as it was (its last revision, applied in place), the observe line the row.
  assert.equal(second!.event_time, '2026-10-03T05:08:31.970Z');
  assert.equal(log.lines[log.lines.indexOf(second!) + 1]!.event_time, '2026-10-03T05:08:31.970Z');

  // Replaying the logged lines (skipping the re-home withdrawals, which the following observe line re-does) rebuilds
  // the same events: the log stays the production decision path.
  const replay = new Map<string, EventNode>();
  const rr = new Resolver(replay, prio, cfg, NOW);
  for (const l of log.lines) {
    if (l.op === 'tombstone' && l.reason?.startsWith(REHOMED_REASON_PREFIX)) continue;
    if (l.op === 'tombstone') rr.tombstoneProvider(observationToRaw(l), l.ingest_time);
    else if (l.op === 'observe') rr.ingest(observationToRaw(l), l.ingest_time);
  }
  assert.deepEqual(live(replay).map(rowsOf).sort(), EXPECTED);
});

test('a revision that still copies a row of its event (EMSC follows the agency) is applied in place', () => {
  const { map, r } = resolverFor(false);
  const ign = observationToRaw(bySeq(200721));
  const copy = observationToRaw(bySeq(200717));
  r.ingest(copy, '2026-10-03T05:32:09.151Z');
  r.ingest(ign, '2026-10-03T05:36:54.000Z');
  // IGN revises its solution (0.05 magnitude units down, 300 m) and EMSC follows: the copy still copies a row there.
  r.ingest({ ...ign, mag: 1.5, lat: ign.lat + 0.003 }, '2026-10-03T05:40:00.000Z');
  const res = r.ingest({ ...copy, mag: 1.5, lat: copy.lat + 0.003 }, '2026-10-03T05:41:00.000Z');
  assert.equal(res.rehomed, undefined);
  assert.equal(res.changed, true);
  assert.equal(live(map).length, 1);
  assert.equal(rowsOf(live(map)[0]!), 'emsc:20261003_0000060 ign:es2026tiyjb');
});

test('a copy of a solution no live event holds stays where it is, as before', () => {
  // EMSC copies GeoNet's origin of the moment and seldom follows a revision: such a copy matches none of its event's
  // rows, and with no other event holding what it copies it stays.
  const { map, r } = resolverFor(false);
  const ign = observationToRaw(bySeq(200721));
  const copy = observationToRaw(bySeq(200717));
  r.ingest(copy, '2026-10-03T05:32:09.151Z');
  r.ingest(ign, '2026-10-03T05:36:54.000Z');
  r.ingest({ ...ign, eventTimeMs: ign.eventTimeMs + 4_000 }, '2026-10-03T05:40:00.000Z');
  const res = r.ingest({ ...copy, eventTimeMs: copy.eventTimeMs + 9_000, mag: 1.7 }, '2026-10-03T05:41:00.000Z');
  assert.equal(res.rehomed, undefined);
  assert.equal(res.changed, true);
  assert.equal(live(map).length, 1);
});

test('paths that write no log line (merge=false: backfill, onboard) never re-home', () => {
  const { map, r, base } = resolverFor(false, false);
  run(r);
  assert.equal(r.rehomedCopies.length, 0);
  assert.notDeepEqual(live(map).map(rowsOf).sort(), EXPECTED);
  assert.ok(live(map).length >= base + 4);
});

test('every run re-homes copies left in the wrong event before the rule (rehomeMisplacedCopies via runFeedSideSteps)', () => {
  // Production's state on 2026-10-03: the rules before FEED-2 left each EMSC row where it joined first.
  const { map, base } = resolverFor(false, false);
  run(new Resolver(map, prio, cfg, NOW, { merge: false }));
  const misplaced = live(map).filter((n) => n.provenance.length > 1).map(rowsOf).sort();
  assert.deepEqual(misplaced, ['emsc:20261003_0000060 ign:es2026tiyjb', 'emsc:20261003_0000066 ign:es2026tiylm']);
  const scratch = mkdtempSync(join(tmpdir(), 'rehome-'));
  try {
    const r = new Resolver(map, prio, cfg, NOW);
    const log = new LogBuffer(300_000, '2026-10-03T06:30:00.000Z');
    const side = runFeedSideSteps(scratch, r, log, { healDue: false, loadDays: 10, ingestTime: '2026-10-03T06:30:00.000Z' });
    assert.equal(side.rehomed, 2);
    assert.equal(side.retracted, 0);
    assert.deepEqual(log.lines.map((l) => l.op), ['tombstone', 'observe', 'tombstone', 'observe']);
    for (const l of log.lines) assert.ok(vObs(l), JSON.stringify(vObs.errors));
    assert.equal(live(map).length, base + 5);
    assert.deepEqual(
      live(map)
        .filter((n) => n.provenance.some((x) => !x.nativeId.startsWith('es2026bg')))
        .map(rowsOf)
        .sort(),
      EXPECTED,
    );
    // Idempotent: nothing is misplaced any more.
    const again = new LogBuffer(log.seq, '2026-10-03T06:35:00.000Z');
    assert.equal(runFeedSideSteps(scratch, new Resolver(map, prio, cfg, NOW), again, { healDue: false, loadDays: 10, ingestTime: '2026-10-03T06:35:00.000Z' }).rehomed, 0);
    assert.equal(again.lines.length, 0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a re-homed copy reported again in the same run (the revision sweep after the live fetch) is found by id', () => {
  // Review of FEED-2: the re-home left the row's id unregistered until the next run, so the sweep's copy of the same
  // report went to the space match, which here prefers the event the row left (its representative, CSN's old
  // solution, is nearer than the new event's, a reviewed ComCat row): the row then stood in two events, and an older
  // copy was not recognised as older (isOlderThanStored). Chile, synthetic: CSN publishes another solution under a new
  // id (100 → 105, 8 km north; informes 5 apart, so not one of CSN's revised ids, config REVISED_ID_WINDOWS) and EMSC's
  // copy follows it.
  const T = NOW - 3_600_000;
  const at = (km: number): number => -33 + km / 111.195;
  const row = (provider: string, id: string, over: Partial<RawObs> = {}): RawObs => ({
    provider, providerEventId: id, eventTimeMs: T, providerUpdatedMs: null, status: null, lat: -33, lon: -71.5, depth: 30,
    mag: 3.0, magType: 'ml', place: 'Chile', knownAliasIds: [], fields: {}, ...over,
  });
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  const t1 = '2026-10-03T05:30:00.000Z';
  const comcat = r.ingest(row('usgs', 'us7000chl1', { status: 'reviewed', lat: at(17), eventTimeMs: T + 3_000 }), t1).node;
  const old = r.ingest(row('csn', '100'), t1).node;
  assert.equal(r.ingest(row('emsc', '20261003_0000501', { fields: { auth: 'CSN' }, providerUpdatedMs: T + 60_000 }), t1).node, old);
  assert.equal(r.ingest(row('csn', '105', { lat: at(8), eventTimeMs: T + 2_000 }), t1).node, comcat, 'CSN 105 joins ComCat’s event');
  const t2 = '2026-10-03T05:35:00.000Z';
  const revised = row('emsc', '20261003_0000501', { fields: { auth: 'CSN' }, lat: at(8), eventTimeMs: T + 2_000, providerUpdatedMs: T + 300_000 });
  const moved = r.ingest(revised, t2);
  assert.ok(moved.rehomed, 'the revision copies CSN 105: re-homed');
  assert.equal(moved.node, comcat);
  // The sweep, same run: an older copy of the row is recognised as older, and the same report is a no-op in its new event.
  assert.equal(r.isOlderThanStored({ ...revised, providerUpdatedMs: T + 200_000 }), true);
  const again = r.reviseExisting(revised, t2);
  assert.equal(again?.node, comcat);
  assert.equal(again?.changed, false);
  const holders = live(map).filter((n) => n.provenance.some((x) => x.provider === 'emsc')).map((n) => n.feedId);
  assert.deepEqual(holders, [comcat.feedId], 'the row stands in one event');
});
