import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Resolver } from '../src/dedup.js';
import { eventDayKey, saveEventMap } from '../src/bitemporal.js';
import { PartitionReader, unfrozenFromEventMap } from '../src/first-solutions-collect.js';
import { PAGES_BASE } from '../src/manifest-v2.js';
import {
  FROZEN_AFTER_DAYS,
  PAGES_PARTITION_GRACE_DAYS,
  dayPartitionFile,
  dayPartitionText,
  frozenBefore,
  hasPagesPartition,
  isFrozenDay,
  manifestPartitions,
  partitionPath,
  pagesPartitionUrl,
  removeStalePagesPartitions,
  writeDayPartition,
  writePagesPartition,
  type Inventory,
} from '../src/partitions.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';

// Round 25, storage option 4: every unfrozen day partition is also on Pages, byte for byte, at the path the v2
// manifest's `pages` origin builds, and the manifest's `url` names that copy; frozen days keep jsDelivr. No consumer
// reads `url` for these days today (iOS 437-587 and the gateway take `pages_url`); the copy lets phase 2 stop
// committing them. Phase 2: the day that froze last keeps its Pages copy and `url` for a grace day (the `data` branch
// gains it only at its freezing, and jsDelivr `@data` resolves the branch to a commit up to about 12 h old).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-14T08:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const dayOf = (ms: number): string => iso(ms).slice(0, 10);

function obs(provider: string, id: string, timeMs: number, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: timeMs,
    providerUpdatedMs: null,
    status: 'automatic',
    lat: 10 + (timeMs % 997) / 100,
    lon: 120 + (timeMs % 991) / 100,
    depth: 10,
    mag: 3.1,
    magType: 'ml',
    place: `place ${id}`,
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

/** Two events a day over the last 14 days. */
function nodes(): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  for (let d = 13; d >= 0; d--) {
    for (const k of [0, 1]) {
      const t = NOW - d * DAY - (3 + 5 * k) * 3_600_000;
      new Resolver(map, prio, cfg, t + 3_600_000).ingest(obs('usgs', `us${d}x${k}`, t, { mag: 3 + d / 10 }), iso(t + 3_600_000));
    }
  }
  return map;
}

test('frozen days: the boundary is FROZEN_AFTER_DAYS back, and today is never frozen', () => {
  assert.equal(frozenBefore(NOW), dayOf(NOW - FROZEN_AFTER_DAYS * DAY));
  assert.equal(isFrozenDay(dayOf(NOW - FROZEN_AFTER_DAYS * DAY), NOW), false);
  assert.equal(isFrozenDay(dayOf(NOW - (FROZEN_AFTER_DAYS + 1) * DAY), NOW), true);
  assert.equal(isFrozenDay(dayOf(NOW), NOW), false);
  assert.equal(isFrozenDay(dayOf(NOW + DAY), NOW), false);
});

test('phase 2: the days with a Pages copy are the unfrozen ones and, for a grace day, the day that froze last', () => {
  assert.equal(PAGES_PARTITION_GRACE_DAYS, 1);
  const lastFrozen = dayOf(NOW - (FROZEN_AFTER_DAYS + 1) * DAY);
  assert.equal(isFrozenDay(lastFrozen, NOW), true);
  assert.equal(hasPagesPartition(lastFrozen, NOW), true, 'frozen at midnight: still on Pages today');
  assert.equal(hasPagesPartition(dayOf(NOW - (FROZEN_AFTER_DAYS + 2) * DAY), NOW), false);
  for (let d = 0; d <= FROZEN_AFTER_DAYS; d++) assert.equal(hasPagesPartition(dayOf(NOW - d * DAY), NOW), true);
  assert.equal(hasPagesPartition(dayOf(NOW + DAY), NOW), true, 'tomorrow (the future leeway)');
  // At 23:59 and 00:01: the day that freezes at midnight keeps its copy across it; the one before loses it at midnight.
  const before = Date.parse('2026-10-14T23:59:00Z');
  const after = Date.parse('2026-10-15T00:01:00Z');
  assert.equal(isFrozenDay('2026-10-04', before), false);
  assert.equal(isFrozenDay('2026-10-04', after), true);
  assert.equal(hasPagesPartition('2026-10-04', after), true);
  assert.equal(hasPagesPartition('2026-10-03', before), true);
  assert.equal(hasPagesPartition('2026-10-03', after), false);
});

test("the manifest's url: the Pages copy for the days published this run, jsDelivr @data otherwise", () => {
  const inv: Inventory = {};
  for (let d = 0; d <= 14; d++) inv[dayOf(NOW - d * DAY)] = { count: 2, bytes: 100, min_mag: 3, max_mag: 4 };
  inv['2024-01-02'] = { count: 1, bytes: 10, min_mag: 2, max_mag: 2 };
  const unfrozen = Object.keys(inv).filter((d) => !isFrozenDay(d, NOW));
  assert.equal(unfrozen.length, FROZEN_AFTER_DAYS + 1, 'today and the 10 days before it');
  // derive puts every day it copied in the set: the unfrozen ones and the grace day (here one unfrozen day is missing).
  const graceDay = dayOf(NOW - (FROZEN_AFTER_DAYS + 1) * DAY);
  const published = new Set([...unfrozen.filter((d) => d !== dayOf(NOW - 3 * DAY)), graceDay]);
  const parts = manifestPartitions(inv, NOW, new Set(Object.keys(inv)), published);
  assert.equal(parts.find((p) => p.date === graceDay)!.frozen, true, 'the grace day is frozen and on Pages');
  for (const p of parts) {
    assert.equal(p.path, partitionPath(p.date));
    const onPages = published.has(p.date);
    if (onPages) {
      assert.equal(p.url, `https://earthquakes-feed.theshelter.app/${p.path}`);
      assert.equal(p.url, PAGES_BASE + p.path, "the v2 manifest's `pages` origin builds the same URL");
      assert.equal(p.url, pagesPartitionUrl(p.date));
    } else {
      assert.equal(p.url, `https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/${p.path}`, p.date);
    }
  }
  assert.equal(parts.filter((p) => p.url.startsWith(PAGES_BASE)).length, FROZEN_AFTER_DAYS + 1, 'one unfrozen day was not published, the grace day was');
  // Nothing else in an entry moves: without the set the catalog is what it was before round 25.
  const before = manifestPartitions(inv, NOW, new Set(Object.keys(inv)));
  assert.ok(before.every((p) => p.url.startsWith('https://cdn.jsdelivr.net/')));
  assert.deepEqual(
    parts.map(({ url: _u, ...rest }) => rest),
    before.map(({ url: _u, ...rest }) => rest),
  );
});

test('the Pages copy is byte for byte the partition written to the data checkout', () => {
  const map = nodes();
  const root = mkdtempSync(join(tmpdir(), 'pages-part-'));
  try {
    const day = dayOf(NOW);
    const ns = [...map.values()].filter((n) => eventDayKey(n.eventTimeMs) === day);
    const out = writeDayPartition(join(root, 'data'), day, ns, { publicV1: join(root, 'public', 'v1'), nowMs: NOW, headIngestTime: iso(NOW) });
    assert.equal(writePagesPartition(join(root, 'public'), day, out.ndjson), true);
    const onPages = readFileSync(join(root, 'public', partitionPath(day)));
    assert.ok(onPages.equals(readFileSync(dayPartitionFile(join(root, 'data'), day))));
    assert.equal(onPages.byteLength, out.stat.bytes);
    assert.equal(out.ndjson, dayPartitionText([...ns].reverse()), 'the same bytes from the nodes alone, in any order');
    assert.equal(writePagesPartition(join(root, 'public'), day, out.ndjson), false, 'unchanged: not rewritten');
    // A copy of a day that froze since (left by an earlier local run) goes; nothing else under public/ is touched.
    writePagesPartition(join(root, 'public'), '2026-09-01', 'old\n');
    writeFileSync(join(root, 'public', 'events', 'README'), 'x');
    assert.deepEqual(removeStalePagesPartitions(join(root, 'public'), new Set([day])), ['2026-09-01']);
    assert.ok(!existsSync(join(root, 'public', partitionPath('2026-09-01'))), 'the stale copy is gone from the deploy');
    assert.ok(existsSync(join(root, 'public', partitionPath(day))));
    assert.ok(existsSync(join(root, 'public', 'events', 'README')));
    assert.ok(existsSync(join(root, 'public', 'v1', 'events', `${day}.geojson`)), 'the GeoJSON day file stays');
    assert.deepEqual(removeStalePagesPartitions(join(root, 'nothing'), new Set()), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('first-solutions reads an unfrozen day from the event map, a frozen one from the tree', async () => {
  const map = nodes();
  const root = mkdtempSync(join(tmpdir(), 'fs-unfrozen-'));
  try {
    saveEventMap(root, map);
    const unfrozenDay = dayOf(NOW - 2 * DAY);
    const frozenDay = dayOf(NOW - 12 * DAY);
    // The tree holds stale copies of both days (as after phase 2 it would hold none of the unfrozen one).
    for (const d of [unfrozenDay, frozenDay]) {
      writeDayPartition(root, d, [], { nowMs: NOW, headIngestTime: iso(NOW) });
      writeFileSync(dayPartitionFile(root, d), 'stale\n');
    }
    const reader = new PartitionReader(root, [], undefined, undefined, unfrozenFromEventMap(root, NOW));
    const expected = dayPartitionText([...map.values()].filter((n) => eventDayKey(n.eventTimeMs) === unfrozenDay));
    assert.match(expected, /us2x0/);
    assert.equal(await reader.dayText(unfrozenDay), expected);
    assert.equal(await reader.dayText(frozenDay), 'stale\n', 'frozen days keep the tree (or the archives)');
    // Phase 2: the day that froze last may not be committed yet (the first derive after midnight commits it): it is
    // read from the event map too.
    const lastFrozen = dayOf(NOW - (FROZEN_AFTER_DAYS + 1) * DAY);
    assert.equal(
      await reader.dayText(lastFrozen),
      dayPartitionText([...map.values()].filter((n) => eventDayKey(n.eventTimeMs) === lastFrozen)),
    );
    assert.match(await reader.dayText(lastFrozen), /us11x0/);
    assert.equal(await reader.dayText(dayOf(NOW + 3 * DAY)), '', 'an unfrozen day without events');
    // Without the event-map reader (the class's default) the tree is read, as before.
    assert.equal(await new PartitionReader(root, []).dayText(unfrozenDay), 'stale\n');
    reader.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
