import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envNumber } from '../src/config.js';

// FEED-CONFIG-ENV (2026-11-16 audit): `Number(process.env.X ?? def)` read an empty value as 0 and a typo as NaN. The
// reachable cases are the hand-typed workflow_dispatch inputs (HISTORY_MAX_UNITS, REMERGE_MONTHS, REMEDIATION_MAX_DAYS,
// STATS_MAX_YEARS): a NaN limit never stops a loop (`done >= NaN` is false), so a typo meant no limit at all.

test('envNumber: unset, empty or blank gives the default; a valid value is taken', () => {
  assert.equal(envNumber('X', 7, {}, {}), 7);
  assert.equal(envNumber('X', 7, {}, { X: '' }), 7);
  assert.equal(envNumber('X', 7, {}, { X: '  ' }), 7, 'whitespace is blank, not 0');
  assert.equal(envNumber('X', 7, {}, { X: '12' }), 12);
  assert.equal(envNumber('X', 7, {}, { X: ' 12 ' }), 12);
  assert.equal(envNumber('X', 0, { min: 0 }, { X: '0' }), 0, 'min 0 accepts 0');
  assert.equal(envNumber('X', 3, { integer: false }, { X: '2.5' }), 2.5);
});

test('envNumber: garbage, a value below the minimum or a fraction where an integer is needed throws, naming the variable', () => {
  for (const [raw, opts] of [
    ['abc', {}],
    ['12abc', {}],
    ['0', {}],
    ['-3', {}],
    ['1.5', {}],
    ['Infinity', {}],
    ['-1', { min: 0 }],
    ['0.5', { integer: false }],
  ] as const) {
    assert.throws(() => envNumber('HISTORY_MAX_UNITS', 4, opts, { HISTORY_MAX_UNITS: raw }), (err: Error) => err.message.startsWith(`HISTORY_MAX_UNITS=${JSON.stringify(raw)} is not `), raw);
  }
});
