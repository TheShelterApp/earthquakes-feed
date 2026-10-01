import { eventDayKey } from './bitemporal.js';

const DAY = 86_400_000;

/** The live observation log's first day: from here on the log holds what the feed first saw of every report. */
export const LOG_START_DAY = '2026-07-05';

/** One source's progress (knowledge/first_solutions/cursor.json `sources.<provider>`). */
export interface SourceCursor {
  /** Event days whose every report of the source is in an uploaded chunk, as merged inclusive ranges, ascending. */
  done: Array<[string, string]>;
  /** A day collected in part: its first `offset` reports (native ids in code-point order) are in uploaded chunks. A
   *  `day` source's day the node answered with no content `empty` times (first-solutions-collect.ts EMPTY_DAY_RETRIES). */
  pending?: { day: string; offset: number; empty?: number };
  /** `day` sources: the last day the node answered with events. A day it answers with no content is checked against
   *  this one (first-solutions-collect.ts): content there now means the node is up and the empty day is real. */
  contentDay?: string;
  /** Consecutive runs that stopped on a failed request (0 after a run without one). */
  failures: number;
  lastError?: string;
  failingSince?: string;
  /** Deep-history months (before the 3-year layer, `history-YYYY` editions) collected, each with the raw assets of this
   *  source its edition was built from (first-solutions-collect.ts deepKey). A month whose current edition was built from
   *  other raw assets of the source (the source joined the era, or was fetched again) is collected again. */
  deep?: Record<string, string>;
  /** Requests sent and records written, over all runs. */
  requests: number;
  records: number;
  lastRun?: string;
}

export interface FirstSolutionsCursor {
  schema: 1;
  sources: Record<string, SourceCursor>;
}

export const newCursor = (): FirstSolutionsCursor => ({ schema: 1, sources: {} });
export const newSourceCursor = (): SourceCursor => ({ done: [], failures: 0, requests: 0, records: 0 });

export const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: string, n: number): string => eventDayKey(dayMs(day) + n * DAY);

export function isDone(cur: SourceCursor, day: string): boolean {
  return cur.done.some(([a, b]) => a <= day && day <= b);
}

/** Add a day to the done ranges, merging neighbours. */
export function markDone(cur: SourceCursor, day: string): void {
  if (isDone(cur, day)) return;
  const ranges: Array<[string, string]> = [...cur.done, [day, day]];
  ranges.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const out: Array<[string, string]> = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && addDays(last[1], 1) >= r[0]) {
      if (r[1] > last[1]) last[1] = r[1];
    } else out.push([r[0], r[1]]);
  }
  cur.done = out;
}

/** Take the days `from`..`to` (inclusive) out of the done ranges. */
export function unmarkRange(cur: SourceCursor, from: string, to: string): void {
  const out: Array<[string, string]> = [];
  for (const [a, b] of cur.done) {
    if (b < from || a > to) {
      out.push([a, b]);
      continue;
    }
    if (a < from) out.push([a, addDays(from, -1)]);
    if (b > to) out.push([addDays(to, 1), b]);
  }
  cur.done = out;
  if (cur.pending && cur.pending.day >= from && cur.pending.day <= to) delete cur.pending;
}

/** The days a source's walk may take, and in which order (nextDay). */
export interface WalkPlan {
  /** The earliest event day to cover: the backfill cursor's targetStart (the 3-year layer's first day), or the first
   *  day of the deep-history months built so far back from it without a gap (first-solutions-collect.ts deepHistory). */
  targetStart: string;
  /** The live log's first day (LOG_START_DAY). */
  logStart: string;
  /** The latest day to take: the last frozen day (later days can still change, partitions.ts FROZEN_AFTER_DAYS). */
  settledEnd: string;
  /** The first day the provider still keeps histories for (retentionDays), or null when it keeps them all. */
  retentionStart: string | null;
}

/**
 * The next day to collect: a pending day first. For a provider that drops histories after a while (GeoNet), the oldest
 * day it still keeps, onward to the last settled day, racing the expiry. For the others, the days since the log began,
 * oldest first, and then history, from the day before the log backward to the target. Recent days go first because a
 * history thins out with time: read on the same day (2026-10-01), 40 of the 61 AK events of 2026-09-11 still had both
 * an automatic and a reviewed origin in ComCat, but only 22 of the 76 of 2026-06-15 (TX: 23 of 33, 5 of 19), while
 * history before the log changes no more. Once caught up, every run takes the newly settled day first.
 */
export function nextDay(cur: SourceCursor, plan: WalkPlan): string | null {
  if (cur.pending) return cur.pending.day;
  if (plan.retentionStart != null) {
    const start = plan.retentionStart > plan.targetStart ? plan.retentionStart : plan.targetStart;
    for (let d = start; d <= plan.settledEnd; d = addDays(d, 1)) if (!isDone(cur, d)) return d;
    return null;
  }
  for (let d = plan.logStart; d <= plan.settledEnd; d = addDays(d, 1)) if (!isDone(cur, d)) return d;
  for (let d = addDays(plan.logStart, -1); d >= plan.targetStart; d = addDays(d, -1)) if (!isDone(cur, d)) return d;
  return null;
}

/** How many days a source has left under a plan (for the run summary). */
export function daysLeft(cur: SourceCursor, plan: WalkPlan): number {
  const start = plan.retentionStart != null && plan.retentionStart > plan.targetStart ? plan.retentionStart : plan.targetStart;
  let n = 0;
  for (let d = start; d <= plan.settledEnd; d = addDays(d, 1)) if (!isDone(cur, d)) n++;
  return n;
}

/** From this many consecutive failed runs a run prints a warning for the source. */
export const STALL_WARN_FAILURES = 24;
/** From this many, on every STALL_WARN_FAILURES-th, the run turns red (about once a day at the hourly pace). */
export const STALL_ALARM_FAILURES = 72;

export function recordFailure(cur: SourceCursor, error: string, at: string): void {
  if (cur.failures === 0 || !cur.failingSince) cur.failingSince = at;
  cur.failures++;
  cur.lastError = error.replace(/\s+/g, ' ').slice(0, 300);
}

export function recordAnswer(cur: SourceCursor): void {
  cur.failures = 0;
  delete cur.lastError;
  delete cur.failingSince;
}

export function stallLevel(cur: SourceCursor): 'ok' | 'warn' | 'alarm' {
  if (cur.failures < STALL_WARN_FAILURES) return 'ok';
  if (cur.failures >= STALL_ALARM_FAILURES && cur.failures % STALL_WARN_FAILURES === 0) return 'alarm';
  return 'warn';
}
