import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EVENT_MAP_HORIZON_DAYS, LIVE_INDEX_DAYS } from '../src/config.js';
import { eventDayKey } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import { LogBuffer } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { deriveLoadFloorMs, revisionSweep, splitBelowDeriveFloor } from '../src/sweep.js';
import { sweepOriginFloorMs } from '../src/sweep-cursor.js';
import type { EventNode, RawObs } from '../src/types.js';

// 2026-11-15 audit, feed-live F1 residual: a run that loads the whole event-map horizon (a heal epoch) asks the sweeps
// from one day below derive's load floor. A revision of an event at 00:00:10 UTC of the floor day F that moves it to
// 23:59:50 of F-1 put it on a day derive never loads: derive rewrote F without it and pruned F-1, so the event left the
// published feed. aggregate now leaves such a revision unapplied.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');
const INGEST = new Date(NOW).toISOString();
const FLOOR = deriveLoadFloorMs(NOW);
const FLOOR_DAY = eventDayKey(NOW - EVENT_MAP_HORIZON_DAYS * DAY);

function geofon(eventTimeMs: number, updatedMs: number): RawObs {
  return {
    provider: 'geofon',
    providerEventId: 'gfz2026abcd',
    eventTimeMs,
    providerUpdatedMs: updatedMs,
    status: 'manual',
    lat: 38.1,
    lon: 142.9,
    depth: 20,
    mag: 5.1,
    magType: 'mb',
    place: 'Near East Coast of Honshu, Japan',
    knownAliasIds: [],
    fields: {},
  };
}

function nodeOnFloorDay(): { map: Map<string, EventNode>; resolver: Resolver; node: EventNode } {
  const map = new Map<string, EventNode>();
  const resolver = new Resolver(map, priorityMap(registry), configMap(registry), NOW);
  const r = resolver.ingest(geofon(FLOOR + 10_000, FLOOR + 600_000), INGEST);
  return { map, resolver, node: r.node };
}

test("derive's load floor is 00:00 UTC of the oldest event-day derive loads", () => {
  assert.equal(new Date(FLOOR).toISOString(), `${FLOOR_DAY}T00:00:00.000Z`);
  assert.equal(deriveLoadFloorMs(Date.parse(`${FLOOR_DAY}T00:00:00Z`) + EVENT_MAP_HORIZON_DAYS * DAY), FLOOR);
  // A heal run's sweeps reach below it; a regular run's stay far above it.
  assert.ok(sweepOriginFloorMs(NOW, EVENT_MAP_HORIZON_DAYS) < FLOOR);
  assert.ok(sweepOriginFloorMs(NOW, LIVE_INDEX_DAYS) > FLOOR + 30 * DAY);
});

test('a heal-run revision across the floor day midnight is not applied: the event stays on the floor day', () => {
  const row = geofon(FLOOR - 10_000, FLOOR + 3_600_000);
  const onFloor = geofon(FLOOR + 5_000, FLOOR + 3_600_000);
  assert.deepEqual(splitBelowDeriveFloor([row, onFloor], FLOOR), { kept: [onFloor], dropped: [row] });

  // Without the split the revision moves the node to the day derive never loads (the hazard).
  const unfiltered = nodeOnFloorDay();
  revisionSweep(unfiltered.resolver, new LogBuffer(100, INGEST), [row], {}, INGEST, new Set(), NOW);
  assert.ok(eventDayKey(unfiltered.node.eventTimeMs) < FLOOR_DAY);

  // With it the node keeps its day and solution.
  const filtered = nodeOnFloorDay();
  const before = JSON.stringify(filtered.node);
  const { kept, dropped } = splitBelowDeriveFloor([row], FLOOR);
  assert.deepEqual(dropped, [row]);
  const sweep = revisionSweep(filtered.resolver, new LogBuffer(100, INGEST), kept, {}, INGEST, new Set(), NOW);
  assert.equal(sweep.revisions, 0);
  assert.equal(eventDayKey(filtered.node.eventTimeMs), FLOOR_DAY);
  assert.equal(JSON.stringify(filtered.node), before);
});

test('a revision at or above the floor still applies', () => {
  const { resolver, node } = nodeOnFloorDay();
  const row = geofon(FLOOR + 2_000, FLOOR + 3_600_000);
  const { kept, dropped } = splitBelowDeriveFloor([row], FLOOR);
  assert.deepEqual(dropped, []);
  const sweep = revisionSweep(resolver, new LogBuffer(100, INGEST), kept, {}, INGEST, new Set(), NOW);
  assert.equal(sweep.revisions, 1);
  assert.equal(node.eventTimeMs, FLOOR + 2_000);
});
