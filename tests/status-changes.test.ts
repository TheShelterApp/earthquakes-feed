import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { geohashEncode } from '../src/geohash.js';
import { appendChanges, nodeToChangeRecord, type ChangeRecord } from '../src/changes.js';
import { enrichStatusV2, updateProviderHealth, type AggregateStatus } from '../src/status-v2.js';
import type { EventNode, ProvenanceRow } from '../src/types.js';

// --- geohash: bit-exact with ShelterShared / @shelter/domain (same anchors) ---
test('geohashEncode matches the cross-language golden anchors', () => {
  assert.equal(geohashEncode(57.64911, 10.40744, 11), 'u4pruydqqvj');
  assert.equal(geohashEncode(0, 0, 1), 's');
  assert.equal(geohashEncode(51.5074, -0.1278, 6), 'gcpvj0');
  assert.equal(geohashEncode(-33.8688, 151.2093, 4), 'r3gx');
  assert.equal(geohashEncode(35.6762, 139.6503, 3), 'xn7');
});

// --- change-log ---
const prov = (over: Partial<ProvenanceRow> = {}): ProvenanceRow => ({
  provider: 'usgs', nativeId: 'us1', eventTimeMs: 1_757_000_000_000, providerUpdatedMs: null, status: 'reviewed',
  lat: 38.1, lon: 27.5, depth: 10, mag: 5.1, magType: 'mw', place: 'İzmir', chosen: true, license: 'US-PD',
  attribution: 'USGS', doi: null, fields: { tsunami: 0 }, ...over,
});
const node = (over: Partial<EventNode> = {}): EventNode => ({
  feedId: 'efd_1', aliases: [], eventTimeMs: 1_757_000_000_000, firstIngestTime: '2026-09-05T00:00:00.000Z',
  lastIngestTime: '2026-09-05T00:05:00.000Z', lat: 38.1234, lon: 27.5678, depth: 10.2, mag: 5.1, magType: 'mw',
  status: 'reviewed', place: 'İzmir', chosenProvider: 'usgs', provenance: [prov()], revision: 1, firstSeenSeq: 100,
  lastSeq: 100, state: 'live', geohash: '190:137', ...over,
});

test('nodeToChangeRecord is the compact EventRecord with cell3 and no provenance', () => {
  const r = nodeToChangeRecord(node({ revision: 3, provenance: [prov({ fields: { tsunami: 1 } })] }));
  assert.deepEqual(Object.keys(r).sort(), ['cell3', 'depthKm', 'id', 'lat', 'lon', 'mag', 'magType', 'mergedInto', 'place', 'rev', 'seq', 'state', 'time', 'tombstonedAt', 'tsunami', 'updatedAt'].sort());
  assert.equal(r.state, 'updated'); // revision > 1
  assert.equal(r.tsunami, true);
  assert.equal(r.cell3, geohashEncode(38.1234, 27.5678, 3));
  assert.equal((r as unknown as { provenance?: unknown }).provenance, undefined);
  const t = nodeToChangeRecord(node({ state: 'tombstoned' }));
  assert.equal(t.state, 'tombstoned');
  assert.equal(t.tombstonedAt, Date.parse('2026-09-05T00:05:00.000Z'));
  const m = nodeToChangeRecord(node({ state: 'superseded', supersededBy: 'efd_9' }));
  assert.equal(m.mergedInto, 'efd_9');
});

test('appendChanges is append-only, cursor-driven and idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ch-'));
  const file = join(dir, '2026-09-05.ndjson');
  try {
    const nodes = [node({ feedId: 'a', lastSeq: 101 }), node({ feedId: 'b', lastSeq: 103 }), node({ feedId: 'c', lastSeq: 102 })];
    const r1 = appendChanges(file, nodes, 100);
    assert.equal(r1.appended, 3);
    assert.deepEqual([r1.firstSeq, r1.lastSeq, r1.cursor], [101, 103, 103]);
    const seqs = readFileSync(file, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as ChangeRecord).seq);
    assert.deepEqual(seqs, [101, 102, 103], 'ordered by seq');

    // re-run same cursor → nothing appended (idempotent)
    assert.equal(appendChanges(file, nodes, 103).appended, 0);

    // an event changes again → new line appended with the higher seq, old line stays
    const r2 = appendChanges(file, [node({ feedId: 'a', lastSeq: 104, revision: 2 })], 103);
    assert.equal(r2.appended, 1);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ChangeRecord);
    assert.equal(lines.length, 4);
    assert.equal(lines.filter((l) => l.id === 'a').length, 2, 'two lines for the same id at different seqs');
    // fan-out dedup by (id, rev): keep the highest rev per id
    const byId = new Map<string, ChangeRecord>();
    for (const l of lines) if (!byId.has(l.id) || l.rev >= byId.get(l.id)!.rev) byId.set(l.id, l);
    assert.equal(byId.get('a')!.rev, 2);
    assert.equal(byId.get('a')!.seq, 104);
    assert.equal(r2.firstSeq, 101, 'firstSeq of the whole file is preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- status v2 (additive) ---
const rawStatus = (): AggregateStatus => ({
  generated: '2026-09-05T10:02:00.000Z',
  head_seq: 8_812_345,
  events_indexed: 12_000,
  degraded: ['bmkg'],
  providers: {
    usgs: { ok: true, http_status: 200, latency_ms: 273, events_returned: 448 },
    bmkg: { ok: false, http_status: 503, events_returned: 0, error: 'HTTP 503' },
  },
});

test('enrichStatusV2 is additive: keeps every existing field and adds the v2 shape', () => {
  const generatedMs = Date.parse('2026-09-05T10:02:00.000Z');
  const health = updateProviderHealth({ bmkg: generatedMs - 3600_000 }, rawStatus().providers, generatedMs);
  assert.equal(health.usgs, generatedMs, 'ok provider last-success = now');
  assert.equal(health.bmkg, generatedMs - 3600_000, 'failing provider keeps its old last-success');

  const v2 = enrichStatusV2(rawStatus(), { generatedMs, expectedIntervalSeconds: 300, staleAfterSeconds: 1800, health, runId: 'gha:1' }) as Record<string, any>;
  // existing fields preserved
  assert.equal(v2.generated, '2026-09-05T10:02:00.000Z');
  assert.equal(v2.head_seq, 8_812_345);
  assert.deepEqual(v2.degraded, ['bmkg']);
  assert.equal(v2.providers.usgs.http_status, 200);
  // v2 additions
  assert.equal(v2.generatedAt, generatedMs);
  assert.equal(v2.expectedIntervalSeconds, 300);
  assert.equal(v2.staleAfterSeconds, 1800);
  assert.equal(v2.runId, 'gha:1');
  assert.deepEqual(v2.degradedProviders, ['bmkg']);
  assert.deepEqual(v2.providers.usgs, { ok: true, http_status: 200, latency_ms: 273, events_returned: 448, observations: 448, lastSuccessAt: generatedMs, lagSeconds: 0, error: null });
  assert.equal(v2.providers.bmkg.observations, 0);
  assert.equal(v2.providers.bmkg.lagSeconds, 3600);
  assert.deepEqual(v2.providers.bmkg.error, { kind: 'http', message: 'HTTP 503', since: generatedMs - 3600_000 });
});
