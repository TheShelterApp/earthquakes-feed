import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STALL_ALARM_FAILURES, STALL_WARN_FAILURES, dayStartMs } from '../src/backfill-cursor.js';
import { type BackfillCursorFile, type Job, applyWindowResult, planJobs, stallReport } from '../src/backfill-plan.js';
import { loadRegistry } from '../src/providers.js';
import type { ProviderConfig, RawObs } from '../src/types.js';

// FEED-TEST-1: the backfill run's decisions (src/backfill-plan.ts, used by src/backfill.ts): which window each
// provider is asked for, and how an answer, a failure, an overflow or an unreadable archive moves its cursor.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const byId = (id: string): ProviderConfig => registry.find((p) => p.id === id)!;
const DAY = 86_400_000;
const LIVE_DAY = '2026-09-20';
const LIVE = dayStartMs(LIVE_DAY);
const TARGET = dayStartMs('2023-07-06');
const INGEST = '2026-10-04T10:41:00.000Z';
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const rows = (n: number): RawObs[] => Array.from({ length: n }, () => ({}) as RawObs);
const ok = (n: number, overflow = false) => ({ overflow, status: { ok: true, events_returned: n }, obs: rows(n) });

const plan = (cursor: BackfillCursorFile, over: Partial<Parameters<typeof planJobs>[2]> = {}): Job[] =>
  planJobs([byId('usgs'), byId('emsc'), byId('isc'), byId('jma'), byId('afad')], cursor, { liveDay: LIVE_DAY, liveDayMs: LIVE, targetMs: TARGET, dispatch: null, only: null, ...over });

test('plan: a new walk starts at the live edge with its initial window; forward-only and disabled sources ask nothing', () => {
  const cursor: BackfillCursorFile = { targetStart: '2023-07-06', providers: {} };
  const jobs = plan(cursor);
  // ISC is paused (backfill.enabled false), JMA has no time-range query.
  assert.deepEqual(jobs.map((j) => j.p.id), ['usgs', 'emsc', 'afad']);
  const usgs = jobs.find((j) => j.p.id === 'usgs')!;
  assert.equal(day(usgs.endMs), LIVE_DAY);
  assert.equal(usgs.endMs - usgs.startMs, usgs.cfg.initialWindowDays * DAY);
  assert.deepEqual(Object.keys(cursor.providers).sort(), ['afad', 'emsc', 'usgs'], 'cursors are created for the walks');
});

test('plan: a finished walk and a walk at the target ask nothing', () => {
  const cursor: BackfillCursorFile = {
    targetStart: '2023-07-06',
    providers: {
      usgs: { filledBackTo: '2023-07-06', windowDays: 30, done: false, failures: 0, lastCount: 0, lastRun: '' },
      emsc: { filledBackTo: '2023-07-06', windowDays: 30, done: true, failures: 0, lastCount: 0, lastRun: '' },
    },
  };
  assert.deepEqual(plan(cursor, { only: new Set(['usgs', 'emsc']) }).map((j) => j.p.id), []);
});

test('plan: a dispatched range asks every eligible provider for exactly it and creates or moves no cursor', () => {
  const cursor: BackfillCursorFile = { targetStart: '2023-07-06', providers: {} };
  const dispatch = { startMs: dayStartMs('2025-07-30'), endMs: dayStartMs('2025-07-31') };
  const jobs = plan(cursor, { dispatch, only: new Set(['usgs', 'jma']) });
  assert.deepEqual(jobs.map((j) => [j.p.id, j.cur, j.startMs, j.endMs]), [['usgs', null, dispatch.startMs, dispatch.endMs]]);
  assert.deepEqual(cursor.providers, {});
});

const walk = (windowDays = 8, filledBackTo = '2025-08-03'): Job => {
  const cursor: BackfillCursorFile = { targetStart: '2023-07-06', providers: { usgs: { filledBackTo, windowDays, done: false, failures: 0, lastCount: 0, lastRun: '' } } };
  return plan(cursor, { only: new Set(['usgs']) })[0]!;
};

test('window: an answer moves the walk to the window start and records the count', () => {
  const j = walk();
  const r = applyWindowResult(j, ok(120), { ingestTime: INGEST, targetMs: TARGET, untouchable: false });
  assert.deepEqual(r, { verdict: { kind: 'answered', saturated: false, advanced: true } });
  assert.equal(j.cur!.filledBackTo, day(j.startMs));
  assert.equal(j.cur!.lastCount, 120);
  assert.equal(j.cur!.lastRun, INGEST);
  assert.equal(j.cur!.failures, 0);
});

test('window: an overflow with room halves the window and ingests nothing; at one day it is a saturated, partial day', () => {
  const j = walk(8);
  const before = j.cur!.filledBackTo;
  assert.deepEqual(applyWindowResult(j, ok(5000, true), { ingestTime: INGEST, targetMs: TARGET, untouchable: false }), { verdict: { kind: 'narrowed' } });
  assert.equal(j.cur!.windowDays, 4);
  assert.equal(j.cur!.filledBackTo, before, 'the walk does not move');
  const one = walk(1, '2025-07-31');
  const r = applyWindowResult(one, ok(5000, true), { ingestTime: INGEST, targetMs: TARGET, untouchable: false });
  assert.deepEqual(r.verdict, { kind: 'answered', saturated: true, advanced: true });
  assert.deepEqual(one.cur!.saturatedDays, ['2025-07-30'], 'recorded for the sub-day remediation (FEED-DQ-1)');
  assert.equal(one.cur!.filledBackTo, '2025-07-30');
});

test('window: a failure counts, keeps the error and halves; a dispatched failure or overflow is a blocker', () => {
  const j = walk(8);
  const r = applyWindowResult(j, { overflow: false, status: { ok: false, error: 'timeout' }, obs: [] }, { ingestTime: INGEST, targetMs: TARGET, untouchable: false });
  assert.deepEqual(r, { verdict: { kind: 'failed', error: 'timeout' } });
  assert.equal(j.cur!.failures, 1);
  assert.equal(j.cur!.lastError, 'timeout');
  assert.equal(j.cur!.failingSince, INGEST);
  assert.equal(j.cur!.windowDays, 4);
  const cursor: BackfillCursorFile = { targetStart: '2023-07-06', providers: {} };
  const [d] = plan(cursor, { dispatch: { startMs: dayStartMs('2025-07-29'), endMs: dayStartMs('2025-08-02') }, only: new Set(['usgs']) });
  const failed = applyWindowResult(d!, { overflow: false, status: { ok: false, http_status: 503 }, obs: [] }, { ingestTime: INGEST, targetMs: TARGET, untouchable: false });
  assert.match(failed.blocker!, /dispatched window 2025-07-29\.\.2025-08-02 \(4 d\) of usgs failed: HTTP 503/);
  const full = applyWindowResult(d!, ok(20000, true), { ingestTime: INGEST, targetMs: TARGET, untouchable: false });
  assert.match(full.blocker!, /filled the page cap and was not ingested/);
});

test('window: a window holding an unreadable archived day is ingested but the walk does not move (asked again)', () => {
  const j = walk(8);
  const before = { ...j.cur! };
  const r = applyWindowResult(j, ok(30), { ingestTime: INGEST, targetMs: TARGET, untouchable: true });
  assert.deepEqual(r.verdict, { kind: 'answered', saturated: false, advanced: false });
  assert.equal(j.cur!.filledBackTo, before.filledBackTo);
  assert.equal(j.cur!.windowDays, before.windowDays);
  assert.equal(j.cur!.lastCount, 30, 'the answer still ends a failure streak');
});

test('stalls: a walk failing 24 runs warns, from 72 at a one-day window it turns the run red', () => {
  const warn = walk(4);
  Object.assign(warn.cur!, { failures: STALL_WARN_FAILURES, failingSince: '2026-10-03T10:41:00Z', lastError: 'timeout' });
  const alarm = walk(1);
  Object.assign(alarm.cur!, { failures: STALL_ALARM_FAILURES, failingSince: '2026-10-01T10:41:00Z', lastError: 'HTTP 500' });
  const r = stallReport([warn, alarm]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /usgs has failed 24 consecutive runs since 2026-10-03T10:41:00Z \(last error: timeout\)/);
  assert.equal(r.blockers.length, 1);
  assert.match(r.blockers[0]!, /has failed 72 consecutive runs/);
  assert.deepEqual(stallReport([walk()]), { blockers: [], warnings: [] });
});
