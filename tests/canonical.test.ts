import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCanonical, qualityCount } from '../src/canonical.js';

test('qualityCount tolerates a missing field-map (never crashes dedup)', () => {
  assert.equal(qualityCount(undefined), 0);
  assert.equal(qualityCount(null), 0);
  assert.equal(qualityCount({}), 0);
  assert.equal(qualityCount({ nst: 5, gap: 90, dmin: 0.1, rms: 0.3 }), 4);
  assert.equal(qualityCount({ nst: 5, other: 'x' }), 1);
});

test('mergeCanonical is fill-only and tolerates nullish rows', () => {
  // chosen first; present value wins; gaps fill; a null/undefined row is skipped.
  const merged = mergeCanonical([
    { nst: 41, gap: 71 }, // chosen (USGS)
    undefined as unknown as Record<string, never>,
    { nst: 99, felt: 12, source_catalog: 'EMSC-RTS' }, // EMSC
  ]);
  assert.equal(merged['nst'], 41, 'chosen value is not overwritten by a later row');
  assert.equal(merged['gap'], 71);
  assert.equal(merged['felt'], 12, 'gap filled from a later row');
  assert.equal(merged['catalog'], 'EMSC-RTS', 'aliased source_catalog -> catalog');
});

test('mergeCanonical coerces numeric aliases and normalizes spellings', () => {
  // FDSN-text values arrive as strings; canonical numeric keys are coerced.
  const merged = mergeCanonical([{ MagAuthor: 'GFZ', EventType: 'earthquake', felt: '7' }]);
  assert.equal(merged['magAuthor'], 'GFZ');
  assert.equal(merged['type'], 'earthquake');
  assert.equal(merged['felt'], 7, 'string "7" coerced to number');
});
