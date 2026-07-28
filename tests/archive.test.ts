import assert from 'node:assert/strict';
import test from 'node:test';
import { isTransientGhError, isTransientNetGhError, withinShrinkTolerance } from '../src/gh.js';

// Real strings recorded in failed runs — each one aborted an archive/backfill run before it was
// classified transient. Regressing any of them costs a month's roll, so they are pinned here.
const TRANSIENT = [
  'HTTP 404: Not Found (https://uploads.github.com/repos/TheShelterApp/earthquakes-feed/releases/123/assets?name=events-2026-01.tar.zst)',
  'read tcp 10.1.0.5:443: connection reset by peer',
  'dial tcp: i/o timeout',
  'HTTP 502: Bad Gateway',
  'no assets to download',
];
// Real answers: retrying only delays the red run (and, on upload, keeps the asset deleted).
const FATAL = ['HTTP 401: Bad credentials', 'HTTP 422: Validation Failed', 'sha256 mismatch'];

test('isTransientGhError retries every recorded transient gh failure', () => {
  for (const msg of TRANSIENT) assert.equal(isTransientGhError(msg), true, msg);
});

test('isTransientGhError never retries a real error', () => {
  for (const msg of FATAL) assert.equal(isTransientGhError(msg), false, msg);
});

test('ghRetryNet excludes the not-found family (an absent release fails fast)', () => {
  assert.equal(isTransientNetGhError('HTTP 404: Not Found'), false);
  assert.equal(isTransientNetGhError('no assets to download'), false);
  assert.equal(isTransientNetGhError('release not found'), false);
  assert.equal(isTransientNetGhError('read tcp 10.1.0.5:443: connection reset by peer'), true);
  assert.equal(isTransientNetGhError('HTTP 502: Bad Gateway'), true);
  for (const msg of FATAL) assert.equal(isTransientNetGhError(msg), false, msg);
});

test('withinShrinkTolerance blocks the 2026-07 truncations, allows benign churn', () => {
  // The four months archive re-rolled smaller than they were (net −34470 events).
  assert.equal(withinShrinkTolerance(45181, 29319), false, '2025-12');
  assert.equal(withinShrinkTolerance(41818, 26264), false, '2026-01');
  assert.equal(withinShrinkTolerance(31900, 29261), false, '2025-02');
  assert.equal(withinShrinkTolerance(33191, 32776), false, '2024-05 (−415, the smallest one)');
  // Equal or growing is always fine — that is every honest re-roll.
  assert.equal(withinShrinkTolerance(45181, 45181), true);
  assert.equal(withinShrinkTolerance(45181, 46000), true);
  // 0.5% of the old count, rounded up: 226 events of slack at 45181.
  assert.equal(withinShrinkTolerance(45181, 45181 - 226), true);
  assert.equal(withinShrinkTolerance(45181, 45181 - 227), false);
  // Minimum one event of slack, so tiny months aren't tripped by a single retraction.
  assert.equal(withinShrinkTolerance(10, 9), true);
  assert.equal(withinShrinkTolerance(10, 8), false);
  assert.equal(withinShrinkTolerance(0, 0), true, 'first roll of a month has nothing to compare');
});
