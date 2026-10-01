import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REID_MAG_DELTA, REID_MAG_TOLERANCE } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// PF-5g: Resolver.sameSolution's |ΔM| ≤ REID_MAG_DELTA passed or failed at exactly 0.1 depending on floating point
// (2.3 − 2.2 = 0.09999999999999964 passed, 1.5 − 1.4 = 0.10000000000000009 failed), so one provider's solution
// published under two ids folded or stayed two events by the luck of the digits, and so did an EMSC copy. The test now
// carries REID_MAG_TOLERANCE. The real pairs below are production observation-log lines; each stayed two events in
// a replay of 2026-09-21..10-01 under the old rule.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const iso = (ms: number): string => new Date(ms).toISOString();
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');

const LINES = new Map<number, RawObs>();
for (const l of readFileSync(here('fixtures/reid-mag-tolerance-2026-09.ndjson'), 'utf8').split('\n').filter(Boolean)) {
  const o = JSON.parse(l) as Observation;
  LINES.set(o.seq, observationToRaw(o));
}
const line = (seq: number): RawObs => {
  const raw = LINES.get(seq);
  assert.ok(raw, `seq ${seq}`);
  return raw;
};

/** Two reports of one provider under two ids, the same time and place, magnitudes `m1` and `m2`: how many events. */
function eventsFor(m1: number, m2: number): number {
  const t = Date.parse('2026-09-25T12:00:00Z');
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, t + 3_600_000);
  const report = (id: string, mag: number): RawObs => ({
    provider: 'geofon', providerEventId: id, eventTimeMs: t, providerUpdatedMs: null, status: null, lat: 38.1, lon: 15.6,
    depth: 10, mag, magType: 'mb', place: null, knownAliasIds: [], fields: {},
  });
  r.ingest(report('gfz2026aaaa', m1), iso(t + 3_600_000));
  r.ingest(report('gfz2026aaab', m2), iso(t + 3_600_000));
  return live(map).length;
}

test('config: the tolerance is far above float error and far below a published magnitude step', () => {
  assert.equal(REID_MAG_DELTA, 0.1);
  assert.ok(REID_MAG_TOLERANCE > 1e-12 && REID_MAG_TOLERANCE < 1e-3);
  // The two sides of the old edge.
  assert.ok(1.5 - 1.4 > REID_MAG_DELTA);
  assert.ok(2.3 - 2.2 < REID_MAG_DELTA);
});

test('every pair of published magnitudes exactly 0.1 apart is one solution; 0.11 and 0.2 apart are not', () => {
  // 0.1 steps (most agencies) and 0.01 steps (ComCat, SCEDC, GEOFON), from M0 to M9.
  for (let k = 0; k < 90; k++) {
    const m = k / 10;
    const up = (k + 1) / 10;
    assert.equal(eventsFor(m, up), 1, `${m} / ${up}`);
    assert.equal(eventsFor(up, m), 1, `${up} / ${m}`);
    assert.equal(eventsFor(m, (k + 2) / 10), 2, `${m} / ${(k + 2) / 10}`);
  }
  for (let k = 0; k < 890; k += 7) {
    const m = k / 100;
    assert.equal(eventsFor(m, (k + 10) / 100), 1, `${m} / ${(k + 10) / 100}`);
    assert.equal(eventsFor(m, (k + 11) / 100), 2, `${m} / ${(k + 11) / 100}`);
  }
});

test('IPMA: one Azores quake published under two ids (ML 2.4 and 2.5, 0.9 km apart) is one event', () => {
  // IPMA's id is built from the origin, so its relocation 0.9 km north came as a second id.
  const a = line(175314);
  const b = line(175393);
  assert.ok(b.mag! - a.mag! > REID_MAG_DELTA, '2.5 − 2.4 is above 0.1 in floating point');
  const nowMs = b.eventTimeMs + 3_600_000;
  for (const order of [[a, b], [b, a]]) {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, nowMs);
    for (const raw of order) r.ingest(raw, iso(nowMs));
    assert.equal(live(map).length, 1);
  }
});

test('ComCat: TexNet’s two ids of one Midland quake (ML 2.1 and 2.2, 0.3 s and 0.2 km apart) are one event', () => {
  const map = new Map<string, EventNode>();
  const nowMs = line(170166).eventTimeMs + 3_600_000;
  const r = new Resolver(map, prio, cfg, nowMs);
  for (const s of [170145, 170147, 170166]) r.ingest(line(s), iso(nowMs));
  assert.equal(live(map).length, 1);
  assert.equal(rowsOf(live(map)[0]!), 'usgs:tx2026spjoic usgs:tx2026spjpfy');
});

test('AFAD: 729543 and 729544 (ML 1.0 and 1.1, the same second, 0.3 km apart in Sındırgı) are one event', () => {
  const a = line(192537);
  const b = line(192538);
  assert.ok(b.mag! - a.mag! > REID_MAG_DELTA, '1.1 − 1.0 is above 0.1 in floating point');
  const nowMs = b.eventTimeMs + 3_600_000;
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs);
  r.ingest(a, iso(nowMs));
  const res = r.ingest(b, iso(nowMs));
  assert.equal(live(map).length, 1);
  assert.equal(rowsOf(res.node), 'afad:729543 afad:729544');
});

test('the merge pass folds such a pair minted apart earlier (what the heal preview folds on 2026-10-01)', () => {
  // As production holds them: two live events, one row each. Any later revision of either (or a heal) folds them.
  const a = line(192537);
  const b = line(192538);
  const nowMs = b.eventTimeMs + 3_600_000;
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs);
  r.ingest(a, iso(nowMs));
  // Mint b apart, as the old rule did: far away first, then its real place (a revision that triggers the merge pass).
  r.ingest({ ...b, lat: b.lat + 1 }, iso(nowMs));
  assert.equal(live(map).length, 2);
  const res = r.ingest(b, iso(nowMs));
  assert.equal(live(map).length, 1);
  assert.equal(res.merges.length, 1);
  assert.match(res.merges[0]!.reason, /^proximity: d=0\.3 km dt=0\.0 s dM=0\.10 /);
});
