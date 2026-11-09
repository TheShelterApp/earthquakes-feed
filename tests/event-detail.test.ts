import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Resolver } from '../src/dedup.js';
import { detailHourJson, hourKey, liveSurvivor, movedByHour, writeDetailHours } from '../src/event-detail.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';
import { deterministicFeedId, feedIdTimeMs } from '../src/ulid.js';

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

// Share links (2026-11): `moved`, the ids an hour file's ULID hour names but which are not among its features.

function bare(id: string, timeMs: number, over: Partial<EventNode> = {}): EventNode {
  return {
    feedId: id,
    aliases: [],
    eventTimeMs: timeMs,
    firstIngestTime: iso(timeMs + 60_000),
    lastIngestTime: iso(timeMs + 120_000),
    lat: 10,
    lon: 120,
    depth: 10,
    mag: 4.5,
    magType: 'mb',
    status: 'reviewed',
    place: 'x',
    chosenProvider: 'usgs',
    provenance: [{ provider: 'usgs', nativeId: id, eventTimeMs: timeMs, mag: 4.5, magType: 'mb', status: 'reviewed', providerUpdatedMs: null, lat: 10, lon: 120, depth: 10, place: 'x', chosen: true, license: 'US-PD', attribution: 'USGS', doi: null, fields: {} }],
    revision: 1,
    firstSeenSeq: 1,
    lastSeq: 1,
    state: 'live',
    geohash: 'x',
    ...over,
  };
}

test('moved: retired ids point at their final live survivor\'s hour, a live id whose origin left its ULID hour points at itself', () => {
  const at = (s: string): number => Date.parse(`2026-10-05T${s}Z`);
  // The survivor: minted and still at 09:20 (its own hour, so not listed).
  const survivor = bare(deterministicFeedId(at('09:20:00'), 10, 120), at('09:20:00'));
  // Retired in two hops; the first was minted in hour 08 (an early, mis-timed solution).
  const mid = bare(deterministicFeedId(at('09:19:40'), 11, 121), at('09:19:40'), { state: 'superseded', supersededBy: survivor.feedId });
  const first = bare(deterministicFeedId(at('08:59:40'), 12, 122), at('08:59:40'), { state: 'superseded', supersededBy: mid.feedId });
  // Minted at 10:59:30 (bucket of 10:59:40), revised to 11:00:20: listed in hour 10, pointing at hour 11.
  const drifted = bare(deterministicFeedId(at('10:59:40'), 13, 123), at('11:00:20'));
  // Not listed: a tombstoned id, an id retired into a tombstoned one, one retired into an id outside the map, and one
  // whose ULID hour has no file (before the first published day).
  const gone = bare(deterministicFeedId(at('09:30:00'), 14, 124), at('09:30:00'), { state: 'tombstoned' });
  const intoGone = bare(deterministicFeedId(at('09:31:00'), 15, 125), at('09:31:00'), { state: 'superseded', supersededBy: gone.feedId });
  const intoNowhere = bare(deterministicFeedId(at('09:32:00'), 16, 126), at('09:32:00'), { state: 'superseded', supersededBy: 'efd_01M6Z5Z7N0YS0YZKJ7H5HDQMVE' });
  const early = bare(deterministicFeedId(Date.parse('2026-10-03T23:59:40Z'), 17, 127), at('00:10:00'));
  const all = [survivor, mid, first, drifted, gone, intoGone, intoNowhere, early];
  const window = { startMs: Date.parse('2026-10-04T00:00:00Z'), endMs: NOW + 600_000 };
  const moved = movedByHour(all, window);
  const flat = [...moved].flatMap(([h, m]) => [...m].map(([id, e]) => [h, id, e.to, e.hour]));
  assert.deepEqual(flat.sort(), [
    ['2026-10-05T08', first.feedId, survivor.feedId, '2026-10-05T09'],
    ['2026-10-05T09', mid.feedId, survivor.feedId, '2026-10-05T09'],
    ['2026-10-05T10', drifted.feedId, drifted.feedId, '2026-10-05T11'],
  ].sort());

  const dir = mkdtempSync(join(tmpdir(), 'detail-moved-'));
  try {
    const out = writeDetailHours(all, ['2026-10-04', '2026-10-05'], { publicV1: dir, nowMs: NOW });
    assert.equal(out?.moved, 3);
    type Fc = { features: { id: string }[]; moved?: Record<string, { to: string; hour: string }> };
    const read = (h: string): Fc => JSON.parse(readFileSync(join(dir, 'detail', `${h}.geojson`), 'utf8')) as Fc;
    assert.deepEqual(read('2026-10-05T10').moved, { [drifted.feedId]: { to: drifted.feedId, hour: '2026-10-05T11' } });
    assert.deepEqual(read('2026-10-05T11').features.map((f) => f.id), [drifted.feedId], 'the drifted event sits in its origin hour');
    const nine = read('2026-10-05T09');
    assert.deepEqual(nine.features.map((f) => f.id), [survivor.feedId]);
    assert.deepEqual(Object.keys(nine.moved!), [mid.feedId]);
    assert.equal(read('2026-10-05T07').moved, undefined, 'no member on an hour without entries');
    // Two reads at most: the ULID hour, then the hour `moved` names, which holds `to`.
    for (const id of [first.feedId, mid.feedId, drifted.feedId]) {
      const e = read(hourKey(feedIdTimeMs(id)!)).moved![id]!;
      assert.ok(read(e.hour).features.some((f) => f.id === e.to), id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Key order follows the ids: the bytes depend on the events alone.
  const m = new Map([['efd_01M6Z5Z7N0YS0YZKJ7H5HDQMVZ', { to: 'a', hour: 'h' }], ['efd_01M6Z5Z7N0YS0YZKJ7H5HDQMVA', { to: 'b', hour: 'h' }]]);
  assert.equal(detailHourJson('2026-10-05T09', [], m), detailHourJson('2026-10-05T09', [], new Map([...m].reverse())));
});

test('liveSurvivor: the end of a superseded chain when live; null for a tombstone, a loop or a missing link', () => {
  const t = Date.parse('2026-10-05T09:00:00Z');
  const live = bare('efd_01M6Z5Z7N0YS0YZKJ7H5HDQMV0', t);
  const a = bare('efd_01M6Z5Z7N0YS0YZKJ7H5HDQMV1', t, { state: 'superseded', supersededBy: live.feedId });
  const loop1 = bare('efd_01M6Z5Z7N0YS0YZKJ7H5HDQMV2', t, { state: 'superseded', supersededBy: 'efd_01M6Z5Z7N0YS0YZKJ7H5HDQMV3' });
  const loop2 = bare('efd_01M6Z5Z7N0YS0YZKJ7H5HDQMV3', t, { state: 'superseded', supersededBy: loop1.feedId });
  const tomb = bare('efd_01M6Z5Z7N0YS0YZKJ7H5HDQMV4', t, { state: 'tombstoned' });
  const byId = new Map([live, a, loop1, loop2, tomb].map((n) => [n.feedId, n]));
  assert.equal(liveSurvivor(live, byId), live);
  assert.equal(liveSurvivor(a, byId), live);
  assert.equal(liveSurvivor(loop1, byId), null);
  assert.equal(liveSurvivor(tomb, byId), null);
  assert.equal(liveSurvivor(bare('efd_01M6Z5Z7N0YS0YZKJ7H5HDQMV5', t, { state: 'superseded' }), byId), null);
});
