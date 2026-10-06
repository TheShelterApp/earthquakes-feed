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

// Adversarial first-sighting reordering of a scattered large event: the event count, the
// provider membership and the representative solution are order-independent — the merge
// pass (op:merge, tests/merge.test.ts) heals whatever the arrival order split. The feed_id
// itself is content-seeded by the FIRST report's bucket and pinned (ulid.ts), so it is the
// one thing another order can change; the log replays in seq order, so rebuilds stay
// byte-identical.
test('a scattered large event clusters the same way under every first-sighting order', () => {
  const big = (provider: string, id: string, lat: number, lon: number, mag: number): RawObs =>
    obs(provider, id, { lat, lon, mag, magType: 'mw', place: 'offshore' });
  // Three preliminary epicentres 20–27 km apart (different id buckets), all ≥ M6.
  const set = [big('usgs', 'u1', -21.246, 168.453, 7.0), big('geofon', 'g1', -21.215, 168.663, 6.4), big('geonet', 'n1', -21.038, 168.571, 6.6)];
  const perms: RawObs[][] = [];
  const permute = (rest: RawObs[], acc: RawObs[]): void => {
    if (!rest.length) perms.push(acc);
    for (let i = 0; i < rest.length; i++) permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]!]);
  };
  permute(set, []);
  for (const order of perms) {
    const m = new Map<string, EventNode>();
    const r = new Resolver(m, prio, cfg, T0);
    for (const o of order) r.ingest(o, '2026-07-05T12:00:10Z');
    const live = [...m.values()].filter((n) => n.state === 'live');
    assert.equal(live.length, 1, `one live event for order ${order.map((o) => o.provider).join(',')}`);
    assert.deepEqual(live[0]!.provenance.map((p) => p.provider).sort(), ['geofon', 'geonet', 'usgs']);
    assert.equal(live[0]!.chosenProvider, 'usgs');
    for (const n of m.values()) if (n !== live[0]) assert.equal(n.supersededBy, live[0]!.feedId);
  }
});

// Still open: the surviving feed_id itself. op:merge makes the event, its rows and its
// representative order-independent (above), not the id — that would need re-keying a node
// after first sight, which the pinned-identity design (ulid.ts) rules out today. Measured
// over the observation log (FEED-DQ-2, APIs.md "What stable means for feed_id"): with each
// provider id 0–2 runs late, 3.4–5.3 % of the multi-provider events get another id.
test.todo('feed_id is byte-identical under adversarial first-sighting reordering (needs re-keying beyond op:merge)');
