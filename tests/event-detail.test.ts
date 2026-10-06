import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Resolver } from '../src/dedup.js';
import { detailHourJson, hourKey, writeDetailHours } from '../src/event-detail.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';

// EVT-5: one full-fat file per UTC hour of the published days, so the event page reads its event's hour, not the day.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const H = 3_600_000;
const NOW = Date.parse('2026-10-05T12:30:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function obs(provider: string, id: string, timeMs: number, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: timeMs,
    providerUpdatedMs: null,
    status: 'reviewed',
    lat: 38 + (timeMs % 977) / 1000,
    lon: 22 + (timeMs % 983) / 1000,
    depth: 10,
    mag: 4.2,
    magType: 'mb',
    place: `place ${id}`,
    knownAliasIds: [],
    fields: { sig: 300 },
    ...over,
  };
}

function nodes(): { all: EventNode[]; live: EventNode; sibling: EventNode; retired: EventNode; future: EventNode } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, priorityMap(registry), configMap(registry), NOW);
  const t = Date.parse('2026-10-05T09:59:30Z');
  const live = r.ingest(obs('usgs', 'u1', t), iso(t + 60_000)).node;
  // Another agency's report of another quake 45 s later (far away, so its own event): it falls in the next hour.
  const sibling = r.ingest(obs('geofon', 'g1', t + 45_000, { lat: 40, lon: 25 }), iso(t + 90_000)).node;
  const gone = obs('emsc', 'e1', Date.parse('2026-10-04T03:10:00Z'), { lat: -20, lon: 170 });
  const retired = r.ingest(gone, iso(NOW - 2 * H)).node;
  r.tombstoneProvider(gone, iso(NOW - H));
  const future = r.ingest(obs('usgs', 'u9', NOW + 2 * H, { lat: 0.5, lon: 100 }), iso(NOW)).node;
  return { all: [...map.values()], live, sibling, retired, future };
}

test('every hour of the published days up to now has a file; each live event sits full-fat in its own hour', () => {
  const n = nodes();
  const dir = mkdtempSync(join(tmpdir(), 'detail-'));
  try {
    const out = writeDetailHours(n.all, ['2026-10-04', '2026-10-05'], { publicV1: dir, nowMs: NOW });
    assert.ok(out);
    assert.equal(out.pointer.first_hour, '2026-10-04T00');
    assert.equal(out.pointer.last_hour, '2026-10-05T12');
    assert.equal(out.files, 24 + 13);
    assert.equal(readdirSync(join(dir, 'detail')).length, 37);
    assert.equal(out.pointer.url_template.replace('{hour}', '2026-10-05T09'), 'https://earthquakes-feed.theshelter.app/v1/detail/2026-10-05T09.geojson');

    type Fc = { metadata: { hour: string; count: number; generated: number }; features: { id: string; properties: { feed: { state: string; provenance?: unknown[] } } }[] };
    const read = (h: string): Fc => JSON.parse(readFileSync(join(dir, 'detail', `${h}.geojson`), 'utf8')) as Fc;
    const nine = read('2026-10-05T09');
    assert.deepEqual(nine.features.map((f) => f.id), [n.live.feedId]);
    assert.ok(Array.isArray(nine.features[0]!.properties.feed.provenance) && nine.features[0]!.properties.feed.provenance.length > 0, 'full-fat');
    assert.deepEqual(read('2026-10-05T10').features.map((f) => f.id), [n.sibling.feedId], 'the 45 s later report crossed the hour');
    assert.equal(read('2026-10-04T03').features.length, 0, 'a withdrawn event is not in the detail files');
    assert.equal(read('2026-10-05T11').metadata.count, 0, 'an empty hour still has its file');
    assert.ok(!existsSync(join(dir, 'detail', `${hourKey(n.future.eventTimeMs)}.geojson`)), 'nothing past the future leeway');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an hour file holds no run clock: the same events give the same bytes at any later run', () => {
  const n = nodes();
  const a = detailHourJson('2026-10-05T09', [n.live]);
  const b = detailHourJson('2026-10-05T09', [n.live]);
  assert.equal(a, b);
  const meta = (JSON.parse(a) as { metadata: { generated: number } }).metadata;
  assert.equal(meta.generated, Date.parse(n.live.lastIngestTime), 'generated = the newest ingest among its events');
  assert.equal((JSON.parse(detailHourJson('2026-10-05T11', [])) as { metadata: { generated: number } }).metadata.generated, Date.parse('2026-10-05T11:00:00Z'));
  assert.equal(writeDetailHours(n.all, [], { publicV1: '/nonexistent', nowMs: NOW }), null);
});
