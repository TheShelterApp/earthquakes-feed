import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resolver } from '../src/dedup.js';
import type { EventNode, ProviderConfig, RawObs } from '../src/types.js';
import { deterministicFeedId } from '../src/ulid.js';

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
    mag: 4.5,
    magType: 'ml',
    place: 'Greece',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

test('deterministic feed id is stable and prefixed', () => {
  const a = deterministicFeedId(T0, 38.1, 21.9);
  const b = deterministicFeedId(T0, 38.1, 21.9);
  assert.equal(a, b);
  assert.match(a, /^efd_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('same provider re-report keeps one id, no phantom revision', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0);
  const first = r.ingest(obs('usgs', 'us1'), '2026-07-05T12:00:10Z');
  const again = r.ingest(obs('usgs', 'us1'), '2026-07-05T12:05:10Z');
  assert.equal(map.size, 1);
  assert.equal(first.node.feedId, again.node.feedId);
  assert.equal(again.changed, false);
});

test('two providers of the same quake merge into one event with two provenance rows', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0);
  r.ingest(obs('usgs', 'us1', { status: 'reviewed', mag: 4.6 }), '2026-07-05T12:00:10Z');
  r.ingest(obs('emsc', 'em1', { lat: 38.11, lon: 21.91, eventTimeMs: T0 + 20_000 }), '2026-07-05T12:00:20Z');
  assert.equal(map.size, 1);
  const node = [...map.values()][0]!;
  assert.equal(node.provenance.length, 2);
  assert.equal(node.chosenProvider, 'usgs'); // reviewed wins
});

test('clustering is order-independent: same event count + provenance membership either way', () => {
  const set = [obs('usgs', 'us1', { status: 'reviewed' }), obs('emsc', 'em1', { lat: 38.11, lon: 21.91 })];
  // Canonical fingerprint = the multiset of per-event provider sets (ignores id strings).
  const run = (list: RawObs[]): string[] => {
    const m = new Map<string, EventNode>();
    const r = new Resolver(m, prio, cfg, T0);
    for (const o of list) r.ingest(o, '2026-07-05T12:00:10Z');
    return [...m.values()].map((n) => n.provenance.map((p) => p.provider).sort().join('+')).sort();
  };
  assert.deepEqual(run(set), run([...set].reverse()));
  assert.deepEqual(run(set), ['emsc+usgs']); // one event, both providers
});

// Byte-identical feed_id under adversarial first-sighting reordering needs the
// op:merge survivor-selection machinery (design §8.6). In real operation the log
// replays in seq order, so rebuilds are already deterministic; this is a v1 item.
test.todo('feed_id is byte-identical under adversarial first-sighting reordering (needs op:merge)');
