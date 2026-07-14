import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { featureToNode, nodeToFeature } from '../src/bitemporal.js';
import { readDayPartitionNodes, writeDayPartition } from '../src/partitions.js';
import type { EventNode } from '../src/types.js';

const node = (): EventNode => ({
  feedId: 'efd_TEST0000000000000000000001',
  eventTimeMs: Date.parse('2026-07-01T12:00:00Z'),
  lat: 10.5,
  lon: 20.25,
  depth: 8,
  mag: 4.2,
  magType: 'mb',
  place: 'Testville',
  status: 'reviewed',
  state: 'live',
  chosenProvider: 'usgs',
  aliases: ['usgs:test1', 'emsc:test2'],
  firstSeenSeq: 1,
  lastSeq: 2,
  revision: 1,
  firstIngestTime: '2026-07-01T12:01:00.000Z',
  lastIngestTime: '2026-07-01T12:05:00.000Z',
  provenance: [
    { provider: 'usgs', nativeId: 'test1', eventTimeMs: Date.parse('2026-07-01T12:00:00Z'), mag: 4.2, magType: 'mb', status: 'reviewed', providerUpdatedMs: null, lat: 10.5, lon: 20.25, depth: 8, place: 'Testville', chosen: true, license: 'US-PD', attribution: 'USGS', doi: null, fields: { nst: 12, code: 'test1' } },
    { provider: 'emsc', nativeId: 'test2', eventTimeMs: Date.parse('2026-07-01T12:00:01Z'), mag: 4.3, magType: 'mb', status: null, providerUpdatedMs: null, lat: 10.51, lon: 20.26, depth: 9, place: null, chosen: false, license: 'CC-BY-4.0', attribution: 'EMSC', doi: null, fields: { flynn_region: 'TEST' } },
  ],
} as unknown as EventNode);

test('compact omits ONLY feed.provenance; everything else identical', () => {
  const full = nodeToFeature(node()) as { properties: { feed: Record<string, unknown> } };
  const compact = nodeToFeature(node(), { compact: true }) as { properties: { feed: Record<string, unknown> } };
  assert.ok('provenance' in full.properties.feed);
  assert.ok(!('provenance' in compact.properties.feed));
  assert.deepEqual(compact.properties.feed['aliases'], full.properties.feed['aliases']);
  assert.equal(compact.properties.feed['chosen_provider'], 'usgs');
  const { provenance: _p, ...fullRest } = full.properties.feed;
  assert.deepEqual(compact.properties.feed, fullRest);
  const fullNoFeed = { ...(full as Record<string, unknown>), properties: { ...(full as { properties: Record<string, unknown> }).properties, feed: null } };
  const compactNoFeed = { ...(compact as Record<string, unknown>), properties: { ...(compact as { properties: Record<string, unknown> }).properties, feed: null } };
  assert.deepEqual(compactNoFeed, fullNoFeed);
});

test('featureToNode crashes loudly on a compact feature (never silently mints provenance-less nodes)', () => {
  const compact = nodeToFeature(node(), { compact: true });
  assert.throws(() => featureToNode(compact));
});

test('writeDayPartition -> readDayPartitionNodes round-trips full-fat (provenance + fields survive)', () => {
  const root = mkdtempSync(join(tmpdir(), 'efd-compact-test-'));
  try {
    const n = node();
    writeDayPartition(root, '2026-07-01', [n], { nowMs: Date.parse('2026-07-02T00:00:00Z'), headIngestTime: '2026-07-02T00:00:00.000Z' });
    const back = readDayPartitionNodes(root, '2026-07-01');
    assert.equal(back.length, 1);
    assert.equal(back[0]!.provenance.length, 2);
    assert.deepEqual(back[0]!.provenance.map((r) => r.fields), n.provenance.map((r) => r.fields));
    // Ignore `geohash` — a derived index featureToNode recomputes; the fixture has none.
    const norm = (x: unknown): Record<string, unknown> => { const o = JSON.parse(JSON.stringify(x)) as Record<string, unknown>; delete o['geohash']; return o; };
    assert.deepEqual(norm(back[0]), norm(n));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
