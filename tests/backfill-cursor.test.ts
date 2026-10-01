import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BackfillCfg } from '../src/backfill-cfg.js';
import { backfillCfg } from '../src/backfill-cfg.js';
import {
  STALL_ALARM_FAILURES,
  STALL_WARN_FAILURES,
  type ProviderCursor,
  advance,
  dayStartMs,
  narrowAfterOverflow,
  newCursor,
  nextWindow,
  recordAnswer,
  recordFailure,
  stallLevel,
} from '../src/backfill-cursor.js';
import { loadRegistry } from '../src/providers.js';

const DAY = 86_400_000;
const CFG: BackfillCfg = { earliestMs: dayStartMs('1990-01-01'), minmag: 3, maxWindowDays: 30, initialWindowDays: 14 };
const TARGET = dayStartMs('2023-07-06');
const LIVE = dayStartMs('2026-08-17');
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** ISC's cursor on 2026-10-01 (knowledge/index/backfill.json), its failure streak aside. */
const iscCursor = (): ProviderCursor => ({
  filledBackTo: '2025-08-03',
  windowDays: 21,
  done: false,
  failures: 0,
  lastCount: 4528,
  lastRun: '2026-10-01T08:43:04.622Z',
});

test('backfill cursor: the next window ends where the walk stands and spans windowDays', () => {
  const w = nextWindow(iscCursor(), CFG, TARGET, LIVE);
  assert.ok(w);
  assert.equal(day(w.startMs), '2025-07-13');
  assert.equal(day(w.endMs), '2025-08-03');
});

test('backfill cursor: the window never reaches below the target or the source earliest day, and an empty one is done', () => {
  const cur: ProviderCursor = { ...iscCursor(), filledBackTo: '2023-07-10' };
  const w = nextWindow(cur, CFG, TARGET, LIVE);
  assert.ok(w);
  assert.equal(day(w.startMs), '2023-07-06');
  const atTarget: ProviderCursor = { ...iscCursor(), filledBackTo: '2023-07-06' };
  assert.equal(nextWindow(atTarget, CFG, TARGET, LIVE), null);
  assert.equal(atTarget.done, true);
  const atEarliest: ProviderCursor = { ...iscCursor(), filledBackTo: '2015-01-01' };
  assert.equal(nextWindow(atEarliest, { ...CFG, earliestMs: dayStartMs('2015-01-01') }, dayStartMs('2010-01-01'), LIVE), null);
  assert.equal(atEarliest.done, true);
});

test('backfill cursor: a new provider starts at the live window with its initial window', () => {
  const cur = newCursor('2026-08-17', CFG);
  assert.deepEqual(cur, { filledBackTo: '2026-08-17', windowDays: 14, done: false, failures: 0, lastCount: 0, lastRun: '' });
});

test('backfill cursor: a failed fetch halves the window, counts the failure and keeps the error and the streak start', () => {
  const cur = iscCursor();
  recordFailure(cur, 'This operation was aborted', '2026-10-01T09:41:00.000Z');
  assert.equal(cur.windowDays, 10);
  assert.equal(cur.failures, 1);
  assert.equal(cur.lastError, 'This operation was aborted');
  assert.equal(cur.failingSince, '2026-10-01T09:41:00.000Z');
  recordFailure(cur, 'HTTP 503', '2026-10-01T10:41:00.000Z');
  assert.equal(cur.windowDays, 5);
  assert.equal(cur.failures, 2);
  assert.equal(cur.lastError, 'HTTP 503');
  assert.equal(cur.failingSince, '2026-10-01T09:41:00.000Z', 'the streak keeps its first failure');
  for (let i = 0; i < 10; i++) recordFailure(cur, 'HTTP 503', '2026-10-01T11:41:00.000Z');
  assert.equal(cur.windowDays, 1, 'never below one day');
  // The cursor does not move on a failure.
  assert.equal(cur.filledBackTo, '2025-08-03');
  assert.equal(cur.done, false);
});

test('backfill cursor: a streak counted before this field existed gets its start at the next failure', () => {
  const cur: ProviderCursor = { ...iscCursor(), failures: 1861 };
  recordFailure(cur, 'This operation was aborted', '2026-10-01T09:41:00.000Z');
  assert.equal(cur.failures, 1862);
  assert.equal(cur.failingSince, '2026-10-01T09:41:00.000Z');
});

test('backfill cursor: an answer ends the streak and records the row count', () => {
  const cur = iscCursor();
  recordFailure(cur, 'This operation was aborted', '2026-10-01T09:41:00.000Z');
  recordAnswer(cur, 2876);
  assert.equal(cur.failures, 0);
  assert.equal(cur.lastCount, 2876);
  assert.equal('lastError' in cur, false);
  assert.equal('failingSince' in cur, false);
  assert.equal(cur.windowDays, 10, 'the narrowed window stays until advance adapts it');
});

test('backfill cursor: advance moves to the window start, grows a sparse window by half, resets after a saturated day', () => {
  const cur: ProviderCursor = { ...iscCursor(), windowDays: 10 };
  advance(cur, CFG, dayStartMs('2025-07-24'), 2876, false, TARGET);
  assert.equal(cur.filledBackTo, '2025-07-24');
  assert.equal(cur.windowDays, 10, 'a window of 2,876 rows is not sparse (< 1,500)');
  advance(cur, CFG, dayStartMs('2025-07-14'), 900, false, TARGET);
  assert.equal(cur.windowDays, 15);
  advance(cur, CFG, dayStartMs('2025-06-29'), 100, false, TARGET);
  assert.equal(cur.windowDays, 23);
  advance(cur, CFG, dayStartMs('2025-06-06'), 100, false, TARGET);
  assert.equal(cur.windowDays, 30, 'capped at maxWindowDays');
  advance(cur, CFG, dayStartMs('2025-05-07'), 5000, true, TARGET);
  assert.equal(cur.windowDays, 14, 'a saturated day resets to the initial window');
  advance(cur, CFG, TARGET, 100, false, TARGET);
  assert.equal(cur.done, true);
});

test('backfill cursor: an overflow halves the window without counting a failure', () => {
  const cur = iscCursor();
  narrowAfterOverflow(cur);
  assert.equal(cur.windowDays, 10);
  assert.equal(cur.failures, 0);
});

test('backfill cursor: a window too large to stream within the timeout recovers in one run (the ISC stall)', () => {
  // ISC on 2026-10-01: 5,000 rows in 17.5 days of July 2025 at M >= 3 (about 286 a day); a 5,000-row answer streamed
  // in about 35 s against ISC's 30 s timeout, so every window wider than about 15 days timed out before the overflow
  // check could see it. Before the fix the window stayed 21 days for 1,861 runs.
  const perDay = 286;
  const fetch = (w: { startMs: number; endMs: number }): { ok: boolean; rows: number } => {
    const rows = Math.round(((w.endMs - w.startMs) / DAY) * perDay);
    return rows > 4300 ? { ok: false, rows: 0 } : { ok: true, rows };
  };
  const cur = iscCursor();
  const log: string[] = [];
  for (let run = 0; run < 6; run++) {
    const w = nextWindow(cur, CFG, TARGET, LIVE);
    assert.ok(w);
    const r = fetch(w);
    if (!r.ok) {
      recordFailure(cur, 'This operation was aborted', `run ${run}`);
      log.push(`fail ${day(w.startMs)}..${day(w.endMs)}`);
      continue;
    }
    recordAnswer(cur, r.rows);
    advance(cur, CFG, w.startMs, r.rows, false, TARGET);
    log.push(`ok ${day(w.startMs)}..${day(w.endMs)} ${r.rows}`);
  }
  assert.deepEqual(log, [
    'fail 2025-07-13..2025-08-03',
    'ok 2025-07-24..2025-08-03 2860',
    'ok 2025-07-14..2025-07-24 2860',
    'ok 2025-07-04..2025-07-14 2860',
    'ok 2025-06-24..2025-07-04 2860',
    'ok 2025-06-14..2025-06-24 2860',
  ]);
  assert.equal(cur.failures, 0);
});

test('backfill cursor: a failure streak warns from 24 runs and alarms about once a day at a one-day window from 72', () => {
  const cur = (failures: number, windowDays: number): ProviderCursor => ({ ...iscCursor(), failures, windowDays });
  assert.equal(stallLevel(cur(0, 21)), 'ok');
  assert.equal(stallLevel(cur(STALL_WARN_FAILURES - 1, 1)), 'ok');
  assert.equal(stallLevel(cur(STALL_WARN_FAILURES, 1)), 'warn');
  assert.equal(stallLevel(cur(STALL_ALARM_FAILURES - 1, 1)), 'warn');
  assert.equal(stallLevel(cur(STALL_ALARM_FAILURES, 1)), 'alarm');
  assert.equal(stallLevel(cur(STALL_ALARM_FAILURES + 1, 1)), 'warn', 'not every run');
  assert.equal(stallLevel(cur(STALL_ALARM_FAILURES + STALL_WARN_FAILURES, 1)), 'alarm');
  assert.equal(stallLevel(cur(STALL_ALARM_FAILURES, 2)), 'warn', 'a window that can still narrow only warns');
  // ISC's streak as it stood (1,861 failures at a 21-day window) would have warned every run from the 24th on.
  assert.equal(stallLevel(cur(1861, 21)), 'warn');
});

test('backfill cursor: ISC is paused in the registry, every other walk keeps its configuration', () => {
  const all = loadRegistry();
  const isc = all.find((p) => p.id === 'isc');
  assert.ok(isc);
  assert.equal(backfillCfg(isc), null, 'ISC backfill paused: every day it has left is a frozen archived day');
  const walking = all.filter((p) => p.active && backfillCfg(p) != null).map((p) => p.id).sort();
  assert.deepEqual(walking, [
    'afad', 'auspass', 'csn', 'emsc', 'ethz', 'geofon', 'geonet', 'igp', 'imo', 'ingv', 'ipgp', 'kagsr', 'knmi', 'lmu',
    'ncedc', 'noa', 'nrcan', 'renass', 'resif', 'scedc', 'usgs', 'usp',
  ]);
});
