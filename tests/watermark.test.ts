import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resolver } from '../src/dedup.js';
import { LogBuffer } from '../src/oplog.js';
import { revisionSweep } from '../src/sweep.js';
import type { RawObs } from '../src/types.js';
import { advanceWatermark, WATERMARK_SKEW_MS } from '../src/watermark.js';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const IPMA_2099 = 4102358400000;

test('watermark: advances monotonically with ordinary stamps', () => {
  assert.equal(advanceWatermark(undefined, NOW - 1000, NOW), NOW - 1000);
  assert.equal(advanceWatermark(NOW - 1000, NOW - 5000, NOW), NOW - 1000);
  assert.equal(advanceWatermark(NOW - 5000, NOW + WATERMARK_SKEW_MS, NOW), NOW + WATERMARK_SKEW_MS);
});

test('watermark: a stamp in the future never pins it, and a stored future watermark heals', () => {
  assert.equal(advanceWatermark(NOW - 1000, IPMA_2099, NOW), NOW - 1000);
  assert.equal(advanceWatermark(undefined, IPMA_2099, NOW), 0);
  assert.equal(advanceWatermark(IPMA_2099, NOW - 2000, NOW), NOW - 2000);
  assert.equal(advanceWatermark(IPMA_2099, IPMA_2099, NOW), 0);
});

test('watermark: the revision sweep clamps a future update stamp too (2026-11-15 audit)', () => {
  const ingest = new Date(NOW).toISOString();
  const r = new Resolver(new Map(), new Map([['emsc', 0]]), new Map(), NOW);
  const row = (stamp: number): RawObs => ({
    provider: 'emsc', providerEventId: `e${stamp}`, eventTimeMs: NOW - 3_600_000, providerUpdatedMs: stamp, status: 'reviewed',
    lat: 38, lon: 22, depth: 10, mag: 3, magType: 'ml', place: 'x', knownAliasIds: [], fields: {},
  });
  const marks: Record<string, number> = { emsc: NOW - 60_000 };
  revisionSweep(r, new LogBuffer(0, ingest), [row(IPMA_2099)], marks, ingest, new Set());
  assert.equal(marks['emsc'], NOW - 60_000, 'a stamp in 2099 is ignored');
  revisionSweep(r, new LogBuffer(0, ingest), [row(NOW - 1000)], marks, ingest, new Set());
  assert.equal(marks['emsc'], NOW - 1000, 'an ordinary stamp advances it');
});
