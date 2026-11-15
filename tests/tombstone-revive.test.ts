import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resolver } from '../src/dedup.js';
import type { EventNode, ProviderConfig, RawObs } from '../src/types.js';

// 2026-11-15 audit (dedup MEDIUM 1): a tombstoned event is un-hidden by a later located report of its id in a LATER
// run too (a new Resolver over the persisted map), not only within the run that tombstoned it. Before, the new
// Resolver's alias map held live nodes only, so the report minted a second feed id beside the tombstoned one.

const cfg = new Map<string, ProviderConfig>();
const prio = new Map<string, number>([
  ['usgs', 0],
  ['emsc', 1],
  ['ncedc', 2],
  ['aec', 3],
]);
const T0 = Date.parse('2026-11-14T12:00:00Z');
const NOW = T0 + 3_600_000;

function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T0,
    providerUpdatedMs: null,
    status: 'reviewed',
    lat: 38.1,
    lon: -122.2,
    depth: 10,
    mag: 3.2,
    magType: 'ml',
    place: 'somewhere',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

/** Run N: the event is observed, then withdrawn upstream (tombstoned). Returns the persisted map and the node. */
function tombstonedInEarlierRun(provider = 'usgs', id = 'us_del'): { map: Map<string, EventNode>; node: EventNode } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  const node = r.ingest(obs(provider, id), '2026-11-14T12:01:00Z').node;
  const t = r.tombstoneProvider(obs(provider, id), '2026-11-14T12:30:00Z');
  assert.equal(t?.changed, true);
  assert.equal(node.state, 'tombstoned');
  return { map, node };
}

test('a later run: a re-report of a tombstoned id un-hides the same feed id, no second id is minted', () => {
  const { map, node } = tombstonedInEarlierRun();
  const r = new Resolver(map, prio, cfg, NOW);
  const back = r.ingest(obs('usgs', 'us_del', { mag: 3.4 }), '2026-11-14T13:00:00Z');
  assert.equal(back.node.feedId, node.feedId);
  assert.equal(back.node.state, 'live');
  assert.equal(back.changed, true);
  assert.equal(back.node.mag, 3.4);
  assert.equal(map.size, 1, 'no second event');
  // Its ids are back on the alias map: the next report of the id is an ordinary revision of the same event.
  const again = r.ingest(obs('usgs', 'us_del', { mag: 3.5 }), '2026-11-14T13:05:00Z');
  assert.equal(again.node.feedId, node.feedId);
  assert.equal(map.size, 1);
  // And a third run sees it live by id as usual.
  const r3 = new Resolver(map, prio, cfg, NOW);
  assert.equal(r3.ingest(obs('usgs', 'us_del', { mag: 3.5 }), '2026-11-14T13:10:00Z').node.feedId, node.feedId);
});

test('a later run: the revision sweep (ComCat restoring a deleted id) revives the same feed id instead of minting', () => {
  const { map, node } = tombstonedInEarlierRun();
  const r = new Resolver(map, prio, cfg, NOW);
  const out = r.reviseOrMintInHotWindow(obs('usgs', 'us_del'), '2026-11-14T13:00:00Z');
  assert.equal(out.kind, 'revised');
  assert.equal(out.kind === 'revised' && out.result.node.feedId, node.feedId);
  assert.equal(node.state, 'live');
  assert.equal(map.size, 1);
});

test('a later run: another agency live copy nearby still takes the report (spatial match first); the tombstone stays', () => {
  const { map, node } = tombstonedInEarlierRun();
  const r0 = new Resolver(map, prio, cfg, NOW);
  const emsc = r0.ingest(obs('emsc', 'em1', { eventTimeMs: T0 + 2_000, lat: 38.11 }), '2026-11-14T12:40:00Z').node;
  assert.notEqual(emsc.feedId, node.feedId);
  const r = new Resolver(map, prio, cfg, NOW);
  const back = r.ingest(obs('usgs', 'us_del'), '2026-11-14T13:00:00Z');
  assert.equal(back.node.feedId, emsc.feedId);
  assert.equal(node.state, 'tombstoned');
  assert.equal(map.size, 2);
});

test('a later run: a COMCAT_LIFECYCLE_PROVIDERS id ComCat deleted still never comes back', () => {
  const { map, node } = tombstonedInEarlierRun('aec', 'ak0261');
  const r = new Resolver(map, prio, cfg, NOW);
  const res = r.ingest(obs('aec', 'ak0261'), '2026-11-14T13:00:00Z');
  assert.equal(res.changed, false);
  assert.equal(node.state, 'tombstoned');
  assert.equal(map.size, 1);
});

test('the offline re-merge never revives a frozen or pinned context node', () => {
  for (const kind of ['frozen', 'pinned'] as const) {
    const { map, node } = tombstonedInEarlierRun();
    const r = new Resolver(map, prio, cfg, NOW, { [kind]: new Set([node.feedId]) });
    const res = r.ingest(obs('usgs', 'us_del'), '2026-11-14T13:00:00Z');
    assert.notEqual(res.node.feedId, node.feedId, kind);
    assert.equal(node.state, 'tombstoned', kind);
  }
});
