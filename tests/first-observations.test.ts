import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FirstObservationIndex } from '../src/first-observations.js';
import type { Observation } from '../src/types.js';

const line = (over: Partial<Observation>): Observation => ({
  seq: 1,
  op: 'observe',
  feed_id: 'efd_A',
  revision: 1,
  ingest_time: '2026-09-20T00:10:00.000Z',
  event_time: '2026-09-20T00:01:40.000Z',
  provider: 'emsc',
  provider_event_id: 'e1',
  provider_updated: null,
  status: null,
  lat: 10,
  lon: 20,
  depth: 10,
  mag: 4.1,
  magType: 'mb',
  place: 'X',
  fields: {},
  ...over,
});

/** EMSC reports first (M4.1), USGS 6 min later on another event, EMSC revises to M4.3, the two events fold, and a
 *  later correction re-reads the USGS row: the first line of each report is its earliest observation. */
const LOG: Observation[] = [
  line({ seq: 10, provider: 'emsc', provider_event_id: 'e1', feed_id: 'efd_A', mag: 4.1, ingest_time: '2026-09-20T00:10:00.000Z', provider_updated: '2026-09-20T00:08:00.000Z' }),
  line({ seq: 11, provider: 'usgs', provider_event_id: 'us1', feed_id: 'efd_B', mag: 4.4, magType: 'mww', ingest_time: '2026-09-20T00:16:00.000Z', provider_updated: '2026-09-20T00:15:00.000Z' }),
  line({ seq: 12, provider: 'emsc', provider_event_id: 'e1', feed_id: 'efd_A', mag: 4.3, ingest_time: '2026-09-20T00:30:00.000Z', provider_updated: '2026-09-20T00:29:00.000Z' }),
  line({ seq: 13, op: 'merge', feed_id: 'efd_A', superseded_by: 'efd_B', provider: 'emsc', provider_event_id: 'e1' }),
  line({ seq: 14, provider: 'usgs', provider_event_id: 'us1', feed_id: 'efd_B', mag: 4.4, ingest_time: '2026-10-01T02:00:00.000Z' }),
  line({ seq: 15, op: 'tombstone', provider: 'geonet', provider_event_id: 'g1', feed_id: 'efd_C' }),
  line({ seq: 16, provider: 'geonet', provider_event_id: 'g2', feed_id: 'efd_C', mag: 3 }),
];

const build = (lines: Observation[]): FirstObservationIndex => {
  const idx = new FirstObservationIndex();
  for (const l of lines) idx.add(l);
  return idx;
};

test('first observations: each report keeps its first line, merges resolve to the survivor', () => {
  const idx = build(LOG);
  const hit = idx.lookup('efd_A');
  assert.ok(hit);
  assert.equal(hit.feed_id, 'efd_B', 'a superseded id resolves to its survivor');
  assert.deepEqual(
    hit.reports.map((r) => [r.provider, r.seq, r.mag, r.ingest_time, r.provider_updated, r.lag_seconds]),
    [
      ['emsc', 10, 4.1, '2026-09-20T00:10:00.000Z', '2026-09-20T00:08:00.000Z', 500],
      ['usgs', 11, 4.4, '2026-09-20T00:16:00.000Z', '2026-09-20T00:15:00.000Z', 860],
    ],
  );
  assert.deepEqual(idx.lookup('emsc:e1'), hit, 'a report id names the same event');
  assert.deepEqual(idx.lookup('usgs:us1'), hit);
});

test('first observations: the order of lines in the input does not matter', () => {
  assert.deepEqual(build([...LOG].reverse()).lookup('efd_B'), build(LOG).lookup('efd_B'));
});

test('first observations: a report the log never held is not found (backfilled history)', () => {
  const idx = build(LOG);
  assert.equal(idx.lookup('usgs:us7000st0n'), null);
  assert.equal(idx.lookup('efd_Z'), null);
  assert.equal(idx.lookup('geonet:g1'), null, 'a tombstone line alone is no observation');
  assert.equal(idx.lookup('geonet:g2')?.reports.length, 1);
});

test('first observations: a report a later line moved to another event belongs to that event', () => {
  const idx = build([
    ...LOG,
    line({ seq: 20, provider: 'afad', provider_event_id: 'a1', feed_id: 'efd_D', ingest_time: '2026-09-21T00:00:00.000Z' }),
    line({ seq: 21, provider: 'afad', provider_event_id: 'a1', feed_id: 'efd_C', ingest_time: '2026-10-01T03:00:00.000Z' }),
  ]);
  assert.deepEqual(idx.lookup('efd_C')?.reports.map((r) => [r.provider, r.seq]), [['geonet', 16], ['afad', 20]]);
  assert.equal(idx.lookup('efd_D'), null);
});
