import { test } from 'node:test';
import assert from 'node:assert/strict';
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
