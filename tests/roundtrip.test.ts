import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataPaths } from '../src/config.js';
import { featureToNode, loadEventMap, nodeToFeature, pruneEventMapShards, saveEventMap } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import type { EventNode, ProviderConfig, RawObs } from '../src/types.js';

const cfg = new Map<string, ProviderConfig>([
  ['usgs', { id: 'usgs', license: 'US-PD', attribution: 'USGS', doi: null } as ProviderConfig],
  ['emsc', { id: 'emsc', license: 'CC-BY-4.0', attribution: 'EMSC', doi: null } as ProviderConfig],
]);
const prio = new Map([
  ['usgs', 0],
  ['emsc', 1],
]);
const T0 = Date.parse('2026-07-05T12:00:00Z');

function buildNode(): EventNode {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, T0);
  r.ingest(
    { provider: 'usgs', providerEventId: 'us7000nabc', eventTimeMs: T0, providerUpdatedMs: T0 + 120_000, status: 'reviewed', lat: 38.114, lon: 21.907, depth: 12.4, mag: 4.6, magType: 'ml', place: 'Western Greece', knownAliasIds: [], extra: { nst: 41, gap: 71, sig: 326, tsunami: 0, type: 'earthquake' } },
    '2026-07-05T12:02:11Z',
  );
  r.ingest(
    { provider: 'emsc', providerEventId: '20260705_0000117', eventTimeMs: T0 + 4000, providerUpdatedMs: T0 + 60_000, status: 'automatic', lat: 38.11, lon: 21.91, depth: 12, mag: 4.7, magType: 'mb', place: 'WESTERN GREECE', knownAliasIds: [], extra: {} },
    '2026-07-05T12:03:00Z',
  );
  const node = [...map.values()][0]!;
  node.firstSeenSeq = 100;
  node.lastSeq = 103;
  return node;
}

test('nodeToFeature <-> featureToNode is byte-identical round-trip', () => {
  const node = buildNode();
  const f1 = JSON.stringify(nodeToFeature(node));
  const back = featureToNode(JSON.parse(f1));
  const f2 = JSON.stringify(nodeToFeature(back));
  assert.equal(f2, f1, 'reconstructed node must reproduce the exact same Feature');
  assert.equal(back.provenance.length, 2);
  assert.equal(back.chosenProvider, 'usgs');
});

test('event_map shards: save by day, load by window, prune, migrate legacy', () => {
  const root = mkdtempSync(join(tmpdir(), 'efd-shard-'));
  try {
    const nowMs = Date.parse('2026-07-05T12:00:00Z');
    const mk = (feedId: string, ageDays: number): EventNode => {
      const n = buildNode();
      n.feedId = feedId;
      n.eventTimeMs = nowMs - ageDays * 86_400_000;
      return n;
    };
    const map = new Map<string, EventNode>([
      ['efd_recent', mk('efd_recent', 1)],
      ['efd_mid', mk('efd_mid', 20)],
      ['efd_old', mk('efd_old', 60)],
    ]);
    saveEventMap(root, map);
    const dir = dataPaths(root).eventMapDir;
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.ndjson')).length, 3, 'one shard per event-day');

    // aggregate-style narrow load (10 days) sees only the recent one.
    const narrow = loadEventMap(root, { sinceDays: 10, nowMs });
    assert.deepEqual([...narrow.keys()], ['efd_recent']);

    // derive-style wide load (45 days) sees recent + mid, not the 60-day-old one.
    const wide = loadEventMap(root, { sinceDays: 45, nowMs });
    assert.deepEqual([...wide.keys()].sort(), ['efd_mid', 'efd_recent']);

    // prune past 45 days removes the old shard only.
    const pruned = pruneEventMapShards(root, nowMs - 45 * 86_400_000);
    assert.equal(pruned.length, 1);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.ndjson')).length, 2);

    // legacy monolithic file migrates on load then is retired by save.
    rmSync(dir, { recursive: true });
    mkdirSync(dataPaths(root).indexDir, { recursive: true });
    writeFileSync(dataPaths(root).eventMapLegacy, [...map.values()].map((n) => JSON.stringify(n)).join('\n') + '\n');
    const migrated = loadEventMap(root, {});
    assert.equal(migrated.size, 3, 'legacy file read fully');
    saveEventMap(root, migrated);
    assert.equal(existsSync(dataPaths(root).eventMapLegacy), false, 'legacy file retired after shard write');
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.ndjson')).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
