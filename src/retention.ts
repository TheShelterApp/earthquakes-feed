import { eventDayKey } from './bitemporal.js';
import type { ProviderConfig } from './types.js';

/**
 * SHLTR-146: a source's retention. Some sources answer a time-range query only for their recent past: AFAD's event API
 * (`apiv2/event/filter`) answers from its newest 1,000 events (measured 2026-11-14: a query for 2026-11-02 .. 11-15
 * returned exactly 1,000 rows from 2026-11-02 21:18:10 on, every older day 0 rows, also with `minmag=4` and
 * `limit=2000`; about 11.8 days at its rate of about 85 events a day, fewer days during a swarm). An older window is
 * answered with no rows and HTTP 200, which the backfill and the remediation used to record as "nothing to fill".
 *
 * The registry's `retentionDays` names how far back a source is asked at all: a window older than that is never asked
 * and is reported with the reason `retention` (backfill-plan.ts planWindows, remediate.ts remediateDay), never as
 * filled. Day-based, like first-solutions' retentionStart: the first whole UTC day inside the retention.
 */

const DAY = 86_400_000;

/** The reason a window or a source-day is not asked. */
export const RETENTION = 'retention';

const addDay = (day: string, n: number): string => eventDayKey(Date.parse(`${day}T00:00:00Z`) + n * DAY);

/** The first whole UTC day the source still answers for at `nowMs`, or null when it keeps everything. */
export function retainedFrom(p: Pick<ProviderConfig, 'retentionDays'>, nowMs: number): string | null {
  const n = p.retentionDays;
  if (n == null || !(n > 0)) return null;
  return addDay(eventDayKey(nowMs - n * DAY), 1);
}

/** The start of that day (ms), or null. */
export function retainedFromMs(p: Pick<ProviderConfig, 'retentionDays'>, nowMs: number): number | null {
  const d = retainedFrom(p, nowMs);
  return d == null ? null : Date.parse(`${d}T00:00:00Z`);
}

/** Whether a UTC day lies before the source's retention (asking it would answer with nothing, or with part of it). */
export function beyondRetention(p: Pick<ProviderConfig, 'retentionDays'>, day: string, nowMs: number): boolean {
  const from = retainedFrom(p, nowMs);
  return from != null && day < from;
}

/** The note a skipped window or source-day carries: what the source keeps and from which day it is asked. */
export function retentionNote(p: Pick<ProviderConfig, 'id' | 'retentionDays'>, nowMs: number): string {
  return `${p.id} answers time-range queries for its last ${p.retentionDays} days only (registry retentionDays); nothing before ${retainedFrom(p, nowMs)} is asked`;
}
