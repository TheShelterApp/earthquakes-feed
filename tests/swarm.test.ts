import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import type { EventNode, ProviderConfig, RawObs } from '../src/types.js';

const cfg = new Map<string, ProviderConfig>();
const prio = new Map<string, number>([
  ['usgs', 0],
  ['emsc', 1],
]);
const T0 = Date.parse('2026-07-05T12:00:00Z');

function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: 'automatic',
    lat: 38.1,
    lon: 21.9,
    depth: 10,
    mag: 2.0,
    magType: 'ml',
    place: 'swarm zone',
    knownAliasIds: [],
    extra: {},
    ...over,
  };
}

/** Fill one grid cell past the swarm threshold with distinct events. */
function fillDenseCell(r: Resolver): void {
  for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
    // Spread in time (>60s apart) so they are genuinely distinct events.
    r.ingest(obs('usgs', `us_swarm_${i}`, { eventTimeMs: T0 + i * 90_000, lat: 38.1 + (i % 5) * 0.001 }), '2026-07-05T12:00:10Z');
  }
}

test('swarm: two same-provider aftershocks with different native ids are NEVER merged', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0 + 86_400_000);
  fillDenseCell(r);
  const before = map.size;
  // A new distinct aftershock: 19s / ~2.3km from an existing one, same provider, new id.
  r.ingest(obs('usgs', 'us_new_aftershock', { eventTimeMs: T0 + 19_000, lat: 38.12, lon: 21.9 }), '2026-07-05T12:01:00Z');
  assert.equal(map.size, before + 1, 'distinct same-provider aftershock must mint a new event');
});

test('swarm: cross-provider report WITHOUT id linkage stays split in a dense cell (recoverable over-count)', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0 + 86_400_000);
  fillDenseCell(r);
  const before = map.size;
  r.ingest(obs('emsc', 'em_1', { eventTimeMs: T0 + 3_000, lat: 38.1002, lon: 21.9002 }), '2026-07-05T12:01:00Z');
  assert.equal(map.size, before + 1, 'no shared id in dense cell => assume distinct (design A2)');
});

test('swarm: cross-provider report WITH shared alias id merges even in a dense cell', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0 + 86_400_000);
  fillDenseCell(r);
  const before = map.size;
  r.ingest(obs('emsc', 'em_2', { eventTimeMs: T0 + 3_000, lat: 38.1002, lon: 21.9002, knownAliasIds: ['usgs:us_swarm_0'] }), '2026-07-05T12:01:00Z');
  assert.equal(map.size, before, 'shared provider id is trustworthy linkage — must merge');
});

test('sparse: same-provider different-id reports within the window still never merge', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0);
  r.ingest(obs('usgs', 'us_a'), '2026-07-05T12:00:10Z');
  r.ingest(obs('usgs', 'us_b', { eventTimeMs: T0 + 19_000, lat: 38.105 }), '2026-07-05T12:00:20Z');
  assert.equal(map.size, 2, 'provider pipeline says distinct => distinct');
});

test('revision: origin-time-only correction IS a revision (M1)', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0);
  const first = r.ingest(obs('usgs', 'us_rev'), '2026-07-05T12:00:10Z');
  assert.equal(first.revision, 1);
  const revised = r.ingest(obs('usgs', 'us_rev', { eventTimeMs: T0 + 40_000 }), '2026-07-05T12:05:00Z');
  assert.equal(revised.changed, true, 'origin-time change must be a revision');
  assert.equal(revised.revision, 2);
});

test('tombstone: deleting the only provider tombstones the event; re-observe un-hides it', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0);
  const first = r.ingest(obs('usgs', 'us_del'), '2026-07-05T12:00:10Z');
  assert.equal(first.node.state, 'live');
  const t = r.tombstoneProvider(obs('usgs', 'us_del'), '2026-07-05T12:05:00Z');
  assert.equal(t?.changed, true);
  assert.equal(first.node.state, 'tombstoned');
  assert.equal(first.node.provenance.length, 0);
  // A later observation of the same id un-hides it.
  const back = r.ingest(obs('usgs', 'us_del'), '2026-07-05T12:10:00Z');
  assert.equal(back.node.state, 'live');
  assert.equal(back.changed, true);
});

test('tombstone: deleting one of two providers keeps the event live', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0);
  r.ingest(obs('usgs', 'us_x', { status: 'reviewed' }), '2026-07-05T12:00:10Z');
  r.ingest(obs('emsc', 'em_x', { lat: 38.101, lon: 21.901 }), '2026-07-05T12:00:20Z');
  const node = [...map.values()][0]!;
  assert.equal(node.provenance.length, 2);
  const t = r.tombstoneProvider(obs('usgs', 'us_x'), '2026-07-05T12:05:00Z');
  assert.equal(t?.changed, true);
  assert.equal(node.state, 'live');
  assert.equal(node.provenance.length, 1);
  assert.equal(node.chosenProvider, 'emsc');
});

test('tombstone: delete for an unknown event is a no-op (never mints)', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0);
  assert.equal(r.tombstoneProvider(obs('usgs', 'ghost'), '2026-07-05T12:00:10Z'), null);
  assert.equal(map.size, 0);
});

test('no-op re-report mutates nothing (M2: replay purity)', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0);
  r.ingest(obs('usgs', 'us_pure'), '2026-07-05T12:00:10Z');
  const snapshot = JSON.stringify([...map.values()]);
  const again = r.ingest(obs('usgs', 'us_pure'), '2026-07-05T12:30:00Z');
  assert.equal(again.changed, false);
  assert.equal(JSON.stringify([...map.values()]), snapshot, 'unchanged re-report must be a byte-level no-op');
});
