import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STALL_ALARM_FAILURES, STALL_WARN_FAILURES, dayStartMs } from '../src/backfill-cursor.js';
import {
  type BackfillCursorFile,
  type Job,
  type OpenDispatch,
  applyWindowResult,
  closeBeyondRetention,
  openDispatchLines,
  planDays,
  planJobs,
  planWindows,
  recordDispatchOutcome,
  saturatedReport,
  skipLine,
  stallReport,
} from '../src/backfill-plan.js';
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
/** The run's clock: the live floor (the oldest event_map shard) is about 45 days back. */
const NOW = LIVE + 45 * DAY + 10 * 3_600_000;
const INGEST = '2026-10-04T10:41:00.000Z';
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const rows = (n: number): RawObs[] => Array.from({ length: n }, () => ({}) as RawObs);
const ok = (n: number, overflow = false) => ({ overflow, status: { ok: true, events_returned: n }, obs: rows(n) });

const plan = (cursor: BackfillCursorFile, over: Partial<Parameters<typeof planJobs>[2]> = {}): Job[] =>
  planJobs([byId('usgs'), byId('emsc'), byId('isc'), byId('jma'), byId('afad')], cursor, { liveDay: LIVE_DAY, liveDayMs: LIVE, targetMs: TARGET, nowMs: NOW, dispatch: null, only: null, ...over });

test('plan: a new walk starts at the live edge with its initial window; forward-only and disabled sources ask nothing', () => {
  const cursor: BackfillCursorFile = { targetStart: '2023-07-06', providers: {} };
  const jobs = plan(cursor);
  // ISC is paused (backfill.enabled false), JMA has no time-range query, AFAD keeps 7 days only (its walk is done, below).
  assert.deepEqual(jobs.map((j) => j.p.id), ['usgs', 'emsc']);
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

test('stalls: from 72 failures at a one-day window a stall is a blocker on every run (the marker states it until the source answers); done walks and dispatch jobs never', () => {
  const alarm = walk(1);
  Object.assign(alarm.cur!, { failures: STALL_ALARM_FAILURES + 1, failingSince: '2026-10-01T10:41:00Z', lastError: 'HTTP 500' });
  assert.equal(stallReport([alarm]).blockers.length, 1, 'not only on every 24th failure');
  const wide = walk(2);
  Object.assign(wide.cur!, { failures: STALL_ALARM_FAILURES + 1 });
  assert.deepEqual(stallReport([wide]).blockers, [], 'a window that can still narrow only warns');
  Object.assign(alarm.cur!, { done: true });
  assert.deepEqual(stallReport([alarm, { p: byId('usgs'), cur: null }]), { blockers: [], warnings: [] });
});

test('dispatched windows: an overflow, a failure or a held-back day stays open until dispatched ranges that answered in full cover it', () => {
  const cursor: BackfillCursorFile = { targetStart: '2023-07-06', providers: {} };
  const dispatch = (from: string, to: string, ids = ['usgs']): Job => plan(cursor, { dispatch: { startMs: Date.parse(from), endMs: Date.parse(to) }, only: new Set(ids) })[0]!;
  const opts = { ingestTime: INGEST, untouchable: false };
  const answered = { kind: 'answered', saturated: false, advanced: false } as const;
  const usgs = new Set(['usgs', 'emsc']);
  // The 2026-11-08 case: 2026-06-01..07-01 of usgs filled the page cap.
  let open: OpenDispatch[] = recordDispatchOutcome([], dispatch('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'), { kind: 'narrowed' }, opts);
  assert.deepEqual(open, [{ provider: 'usgs', start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z', since: INGEST, reason: 'overflow' }]);
  assert.deepEqual(openDispatchLines(open, usgs), [`backfill: dispatched window 2026-06-01..2026-07-01 (30 d) of usgs (open since ${INGEST}) filled the page cap and was not ingested; dispatch narrower ranges inside it`]);
  // Another provider's answer over the same range closes nothing of usgs.
  open = recordDispatchOutcome(open, dispatch('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', ['emsc']), answered, opts);
  assert.equal(open.length, 1);
  // A narrower answer splits it; one that overflowed again stays open over its own range.
  open = recordDispatchOutcome(open, dispatch('2026-06-10T00:00:00Z', '2026-06-20T00:00:00Z'), answered, opts);
  assert.deepEqual(open.map((o) => [o.start.slice(0, 10), o.end.slice(0, 10)]), [['2026-06-01', '2026-06-10'], ['2026-06-20', '2026-07-01']]);
  open = recordDispatchOutcome(open, dispatch('2026-06-01T00:00:00Z', '2026-06-10T00:00:00Z'), { kind: 'narrowed' }, opts);
  assert.equal(open.length, 2);
  // An answer that held back a day (an unreadable archive) keeps its range open; a failure keeps its error.
  open = recordDispatchOutcome(open, dispatch('2026-06-01T00:00:00Z', '2026-06-10T00:00:00Z'), answered, { ...opts, untouchable: true });
  assert.deepEqual(open.map((o) => o.reason).sort(), ['held', 'overflow']);
  open = recordDispatchOutcome(open, dispatch('2026-06-01T00:00:00Z', '2026-06-10T00:00:00Z'), { kind: 'failed', error: 'HTTP 503' }, opts);
  assert.match(openDispatchLines(open, usgs).join('\n'), /2026-06-01\.\.2026-06-10 \(9 d\) of usgs .* failed \(HTTP 503\); dispatch it again/);
  // Full answers close the rest; an end at 23:59:59 leaves no one-second piece behind.
  open = recordDispatchOutcome(open, dispatch('2026-06-01T00:00:00Z', '2026-06-09T23:59:59Z'), answered, opts);
  open = recordDispatchOutcome(open, dispatch('2026-06-20T00:00:00Z', '2026-07-01T00:00:00Z'), answered, opts);
  assert.deepEqual(open, []);
  // A walk job (a cursor) never touches the list; a provider no longer eligible is not reported.
  const kept: OpenDispatch[] = [{ provider: 'jma', start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z', reason: 'overflow', since: INGEST }];
  assert.deepEqual(recordDispatchOutcome(kept, walk(8), { kind: 'narrowed' }, opts), kept);
  assert.deepEqual(openDispatchLines(kept, usgs), []);
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

test('backfill home day (C6): an event a re-merged archive kept off its time-day is written back to the day it was read from; others follow their time', async () => {
  const { homeDayOf, rememberHomeDay } = await import('../src/backfill-plan.js');
  const home = new Map<string, string>();
  const off = { feedId: 'efd_off', eventTimeMs: Date.parse('2024-07-01T00:00:05Z') };
  const on = { feedId: 'efd_on', eventTimeMs: Date.parse('2024-06-30T12:00:00Z') };
  rememberHomeDay(home, '2024-06-30', off);
  rememberHomeDay(home, '2024-06-30', on);
  assert.equal(homeDayOf(home, off), '2024-06-30', 'kept in its member day');
  assert.equal(homeDayOf(home, on), '2024-06-30');
  // A repositioned event that was on its day moves with its time, as before.
  assert.equal(homeDayOf(home, { ...on, eventTimeMs: Date.parse('2024-07-01T00:00:01Z') }), '2024-07-01');
  // Read again on its own day: no longer off.
  rememberHomeDay(home, '2024-07-01', off);
  assert.equal(home.has('efd_off'), false);
});

// --- SHLTR-146: a source's retention (registry retentionDays). AFAD's event API answers from its newest 1,000 events
// only; an older window answers 0 rows with HTTP 200, which read as "nothing to fill". ---

test('retention: AFAD keeps 7 days in the registry; a dispatch over 2026-06 lists every day as retention and asks nothing', () => {
  const afad = byId('afad');
  assert.equal(afad.retentionDays, 7);
  const nowMs = Date.parse('2026-11-14T16:34:00Z');
  const cursor: BackfillCursorFile = { targetStart: '2023-07-06', providers: {} };
  const dispatch = { startMs: dayStartMs('2026-06-01'), endMs: dayStartMs('2026-07-01') };
  const { jobs, skipped } = planWindows([byId('usgs'), afad], cursor, {
    liveDay: '2026-09-30', liveDayMs: dayStartMs('2026-09-30'), targetMs: TARGET, nowMs, dispatch, only: new Set(['afad']),
  });
  assert.deepEqual(jobs, [], 'no AFAD request');
  assert.equal(skipped.length, 1);
  const k = skipped[0]!;
  assert.deepEqual([k.provider, k.reason, k.retainedFrom, k.walk, k.startMs, k.endMs], ['afad', 'retention', '2026-11-08', false, dispatch.startMs, dispatch.endMs]);
  const days = planDays(jobs, skipped);
  assert.equal(days.length, 30);
  assert.ok(days.every((d) => d.provider === 'afad' && d.action === 'retention'));
  assert.deepEqual([days[0]!.day, days.at(-1)!.day], ['2026-06-01', '2026-06-30']);
  assert.match(skipLine(k), /^backfill: afad 2026-06-01\.\.2026-07-01 \(30 d\) skipped \(retention\): afad answers time-range queries for its last 7 days only/);
  assert.deepEqual(cursor.providers, {}, 'a dispatch moves no cursor');
  // The same dispatch for a source without a retention is asked as before.
  const usgs = planWindows([byId('usgs'), afad], cursor, { liveDay: '2026-09-30', liveDayMs: dayStartMs('2026-09-30'), targetMs: TARGET, nowMs, dispatch, only: null });
  assert.deepEqual(usgs.jobs.map((j) => [j.p.id, j.startMs, j.endMs]), [['usgs', dispatch.startMs, dispatch.endMs]]);
  assert.deepEqual(usgs.skipped.map((s) => s.provider), ['afad']);
});

test('retention: a window across the edge is asked from the edge on; a walk wholly before it is done, by retention', () => {
  const afad = byId('afad');
  const nowMs = Date.parse('2026-11-14T16:34:00Z');
  const opts = { liveDay: '2026-11-04', liveDayMs: dayStartMs('2026-11-04'), targetMs: TARGET, nowMs, only: null };
  // A dispatched 2026-11-01 .. 11-12: the days from 2026-11-08 are asked, 11-01 .. 11-07 are retention.
  const across = planWindows([afad], { targetStart: '2023-07-06', providers: {} }, { ...opts, dispatch: { startMs: dayStartMs('2026-11-01'), endMs: dayStartMs('2026-11-12') } });
  assert.deepEqual(across.jobs.map((j) => [day(j.startMs), day(j.endMs), j.cur]), [['2026-11-08', '2026-11-12', null]]);
  assert.deepEqual(across.skipped.map((s) => [day(s.startMs), day(s.endMs)]), [['2026-11-01', '2026-11-08']]);
  const days = planDays(across.jobs, across.skipped);
  assert.deepEqual(days.filter((d) => d.action === 'retention').map((d) => d.day), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
  assert.deepEqual(days.filter((d) => d.action === 'fetch').map((d) => d.day), ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']);
  // A walk: its next window ends at the live floor, 10 days back; wholly before the edge, so the walk is done.
  const cursor: BackfillCursorFile = { targetStart: '2023-07-06', providers: { afad: { filledBackTo: '2026-11-04', windowDays: 3, done: false, failures: 0, lastCount: 0, lastRun: '' } } };
  const walk = planWindows([afad], cursor, { ...opts, dispatch: null });
  assert.deepEqual(walk.jobs, []);
  assert.deepEqual(walk.skipped.map((s) => [s.walk, day(s.startMs), day(s.endMs)]), [[true, '2026-11-01', '2026-11-04']]);
  assert.match(skipLine(walk.skipped[0]!), /; its walk is done$/);
  assert.deepEqual([cursor.providers.afad!.done, cursor.providers.afad!.stoppedBy, cursor.providers.afad!.filledBackTo], [true, 'retention', '2026-11-04'], 'nothing reads as filled');
  assert.deepEqual(planWindows([afad], cursor, { ...opts, dispatch: null }), { jobs: [], skipped: [] }, 'a done walk asks nothing and reports nothing');
});

test('retention: an open dispatched window before the edge leaves the open list; its part inside the retention stays', () => {
  const nowMs = Date.parse('2026-11-14T16:34:00Z');
  const providers = [byId('afad'), byId('usgs')];
  const open: OpenDispatch[] = [
    { provider: 'afad', start: '2026-06-01T00:00:00.000Z', end: '2026-06-08T00:00:00.000Z', reason: 'failed', error: 'HTTP 503', since: INGEST },
    { provider: 'afad', start: '2026-11-05T00:00:00.000Z', end: '2026-11-10T00:00:00.000Z', reason: 'overflow', since: INGEST },
    { provider: 'usgs', start: '2026-06-01T00:00:00.000Z', end: '2026-06-08T00:00:00.000Z', reason: 'failed', error: 'HTTP 503', since: INGEST },
  ];
  const r = closeBeyondRetention(open, providers, nowMs);
  assert.deepEqual(r.open.map((o) => [o.provider, o.start, o.end, o.reason]), [
    ['afad', '2026-11-08T00:00:00.000Z', '2026-11-10T00:00:00.000Z', 'overflow'],
    ['usgs', '2026-06-01T00:00:00.000Z', '2026-06-08T00:00:00.000Z', 'failed'],
  ]);
  assert.equal(r.closed.length, 2);
  assert.match(r.closed[0]!, /^backfill: dispatched window 2026-06-01\.\.2026-06-08 \(7 d\) of afad .* closed \(retention\)/);
  // Nothing of afad's closed part stands on the board any more.
  assert.deepEqual(openDispatchLines(r.open, new Set(['afad'])).length, 1);
});

// --- SHLTR-151: a saturated day (a one-day window filled the cap: the day holds the capped rows only) is a block on
// every run until a remediation edition completes it. ---

test('saturated days: a block until a complete raw of the day is in its current edition; partial or beyond retention: a warning', () => {
  const nowMs = Date.parse('2026-11-14T16:34:00Z');
  const cur = (days: string[]) => ({ filledBackTo: '2023-07-06', windowDays: 30, done: true, failures: 0, lastCount: 0, lastRun: '', saturatedDays: days });
  const walks = [
    { p: byId('kagsr'), cur: cur(['2025-07-30']) },
    { p: byId('afad'), cur: cur(['2025-08-11', '2026-06-28']) },
    { p: byId('usgs'), cur: null },
  ];
  const raw = (provider: string, day: string, partial = false, asset = `raw-${provider}-${day}.ndjson.gz`) =>
    ({ provider, day, tag: `remediation-${day.slice(0, 4)}`, asset, url: '', sha256: 'x', bytes: 1, rows: 1, requests: 24, partial, fetched_at: '2026-10-04T12:00:00.000Z' });
  const edition = (day: string, from: string[], n = 1) =>
    ({ day, edition: n, tag: `remediation-${day.slice(0, 4)}`, asset: `events-${day}.e${n}.ndjson.gz`, url: '', sha256: 'y', bytes: 1, built_on: { tag: 'a', asset: 'b', sha256: null }, built_from: from, stats: {} as never, built_at: '' });
  // Today: AFAD's 2025-08-11 was completed on 2026-10-04; KAGSR's 2025-07-30 never was; AFAD 2026-06-28 (hypothetical)
  // has no raw and lies before AFAD's retention.
  const today = { raw: [raw('afad', '2025-08-11')], editions: [edition('2025-08-11', ['raw-afad-2025-08-11.ndjson.gz'])] };
  const r = saturatedReport(walks, today, nowMs);
  assert.deepEqual(r.blockers, [
    'backfill: kagsr 2025-07-30 filled the source\'s page cap even as a one-day window, so the day holds part of its rows until a remediation edition completes it (remediate.yml asks the day again in hour windows; its daily run takes saturated days)',
  ]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /^backfill: afad 2026-06-28 .*afad answers time-range queries for its last 7 days only .*: it cannot be refilled$/);
  // A raw uploaded but in no edition yet (another source of the day failed): still a block.
  const unbuilt = { raw: [...today.raw, raw('kagsr', '2025-07-30')], editions: today.editions };
  assert.equal(saturatedReport(walks, unbuilt, nowMs).blockers.length, 1);
  // The edition built from it: done. A partial one (a 5-minute window still full): a warning, never a block.
  const done = { raw: unbuilt.raw, editions: [...today.editions, edition('2025-07-30', ['raw-kagsr-2025-07-30.ndjson.gz'])] };
  assert.deepEqual(saturatedReport(walks, done, nowMs).blockers, []);
  const partial = { raw: [...today.raw, raw('kagsr', '2025-07-30', true)], editions: done.editions };
  const p = saturatedReport(walks, partial, nowMs);
  assert.deepEqual(p.blockers, []);
  assert.match(p.warnings.join('\n'), /kagsr 2025-07-30 .*its remediation edition is partial too/);
  // The parser of the health board files the block under kagsr: walks:backfill:kagsr.
  assert.match(r.blockers[0]!, /^backfill: kagsr /);
});
