import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { RETIRED_VISIBLE_MS } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { summaries, summaryFeats } from '../src/summaries.js';
import type { EventNode, RawObs } from '../src/types.js';

// The derive half of the visibility rule: which nodes the rolling summaries publish, flagged
// how, and what metadata.count / the manifest's summaries[].count and event_count count.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const NOW = Date.parse('2026-09-27T12:00:00Z');
const T = NOW - 3 * 3600_000; // every event three hours ago: inside the day, week and month windows
const iso = (ms: number): string => new Date(ms).toISOString();

function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: T,
    providerUpdatedMs: null,
    status: 'automatic',
    lat: -21.3,
    lon: 168.6,
    depth: 10,
    mag: 6.6,
    magType: 'mw',
    place: 'Loyalty Islands',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

/** live (the survivor), superseded an hour ago, superseded long ago, tombstoned an hour ago,
 *  tombstoned long ago, a live event in the future (an adapter clock bug) — each a real
 *  Resolver outcome. */
function scenario(): Record<'live' | 'superseded' | 'oldSuperseded' | 'tombstoned' | 'oldTombstoned' | 'future', EventNode> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, priorityMap(registry), configMap(registry), NOW);
  const at = iso(NOW - 3600_000);
  const live = r.ingest(obs('usgs', 'u1', { status: 'reviewed' }), iso(T + 60_000)).node;
  const superseded = r.ingest(obs('emsc', 'e1', { mag: 6.5, lat: -21.3 + 40 / 111.195 }), iso(T + 120_000)).node;
  const fold = r.ingest(obs('emsc', 'e1', { mag: 6.5, lat: -21.3 + 5 / 111.195 }), at);
  assert.equal(fold.merges.length, 1, 'setup: the revision folds emsc into usgs');
  assert.equal(superseded.state, 'superseded');
  const oldSuperseded: EventNode = {
    ...superseded,
    feedId: 'efd_01M3D76ES0OLDLOSER0000000001',
    provenance: superseded.provenance.map((p) => ({ ...p })),
    lastIngestTime: iso(NOW - RETIRED_VISIBLE_MS - 3600_000),
  };
  const tomb = obs('geofon', 'g1', { mag: 5.1, lat: 10, lon: 120, place: 'Philippines' });
  const tombstoned = r.ingest(tomb, iso(T + 60_000)).node;
  r.tombstoneProvider(tomb, at);
  assert.equal(tombstoned.state, 'tombstoned');
  const oldTombstoned: EventNode = { ...tombstoned, feedId: 'efd_01M3D76ES0OLDTOMBSTONE00001', lastIngestTime: iso(NOW - RETIRED_VISIBLE_MS - 3600_000) };
  const future = r.ingest(obs('usgs', 'u9', { eventTimeMs: NOW + 3600_000, lat: 38, lon: 22, mag: 4.8, place: 'Greece' }), at).node;
  return { live, superseded, oldSuperseded, tombstoned, oldTombstoned, future };
}

test('summaryFeats: live events full count, superseded and tombstoned ones for 48 h flagged non-live, future events never', () => {
  const s = scenario();
  const feats = summaryFeats(Object.values(s), NOW);
  const ids = feats.map((f) => (f.feature as { id: string }).id);
  assert.deepEqual(ids.sort(), [s.live.feedId, s.superseded.feedId, s.tombstoned.feedId].sort());
  const byId = new Map(feats.map((f) => [(f.feature as { id: string }).id, f]));
  assert.equal(byId.get(s.live.feedId)!.live, true);
  const marker = byId.get(s.superseded.feedId)!;
  assert.equal(marker.live, false, 'a superseded marker is not counted');
  const feed = (marker.feature as { properties: { feed: Record<string, unknown> } }).properties.feed;
  assert.equal(feed['state'], 'superseded');
  assert.equal(feed['superseded_by'], s.live.feedId);
  assert.ok(!('provenance' in feed), 'compact');
  const deleted = byId.get(s.tombstoned.feedId)!;
  assert.equal(deleted.live, false, 'a tombstone marker is not counted');
  const deletedFeed = (deleted.feature as { properties: { feed: Record<string, unknown> } }).properties.feed;
  assert.equal(deletedFeed['state'], 'tombstoned');
  assert.equal(deletedFeed['tombstone'], true);
  assert.ok(!('provenance' in deletedFeed), 'compact');
  // The manifest's event_count is this live count (derive.ts).
  assert.equal(feats.filter((f) => f.live).length, 1);
  // 48 h after the fold / the delete the markers are gone from the summaries too.
  const later = summaryFeats(Object.values(s), Date.parse(s.superseded.lastIngestTime) + RETIRED_VISIBLE_MS + 1);
  assert.ok(!later.some((f) => (f.feature as { id: string }).id === s.superseded.feedId));
  assert.ok(!later.some((f) => (f.feature as { id: string }).id === s.tombstoned.feedId));
});

test('summaries: files carry the retired markers, metadata.count and summaries[].count count live features only', () => {
  const s = scenario();
  const root = mkdtempSync(join(tmpdir(), 'efd-summ-'));
  try {
    const out = summaries(summaryFeats(Object.values(s), NOW), NOW, root, iso(NOW - 3600_000));
    // The tombstoned event is an M5.1: under significant's M6 / sig 600 predicate.
    for (const name of ['all_day', 'all_week', 'all_month', '4.5_week', 'significant_week']) {
      const fc = JSON.parse(readFileSync(join(root, `${name}.geojson`), 'utf8')) as {
        metadata: { count: number };
        features: { id: string; properties: { feed: { state: string } } }[];
      };
      assert.deepEqual(
        fc.features.map((f) => [f.id, f.properties.feed.state]).sort(),
        [
          [s.live.feedId, 'live'],
          [s.superseded.feedId, 'superseded'],
          ...(name === 'significant_week' ? [] : [[s.tombstoned.feedId, 'tombstoned']]),
        ].sort(),
        `${name}: the live event and the fresh retired markers, nothing else`,
      );
      assert.equal(fc.metadata.count, 1, `${name}: metadata.count is live-only`);
      assert.equal(out[name]!.count, 1, `${name}: the manifest's summaries[].count is live-only`);
    }
    const hour = JSON.parse(readFileSync(join(root, 'all_hour.geojson'), 'utf8')) as { metadata: { count: number }; features: unknown[] };
    assert.equal(hour.features.length, 0, 'three hours ago is outside the hour window');
    assert.equal(out['all_hour']!.count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
