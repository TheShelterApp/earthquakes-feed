import { type BackfillCfg, backfillCfg } from './backfill-cfg.js';
import { type ProviderCursor, advance, narrowAfterOverflow, newCursor, nextWindow, recordAnswer, recordFailure, stallLevel } from './backfill-cursor.js';
import { eventDayKey } from './bitemporal.js';
import type { WindowOutcome } from './providers.js';
import type { ProviderConfig } from './types.js';

/**
 * The backfill run's decisions (src/backfill.ts), pure over their inputs so they are tested without the network or a
 * data branch (FEED-TEST-1, tests/backfill-plan.test.ts): which window each provider is asked for, and how a window's
 * answer moves that provider's cursor. The orchestrator keeps the I/O (fetch, archives, partitions).
 */

const DAY = 86_400_000;

export interface BackfillCursorFile {
  targetStart: string;
  providers: Record<string, ProviderCursor>;
}

export interface Job {
  p: ProviderConfig;
  cfg: BackfillCfg;
  /** null for a dispatched one-off range: it never moves the walk's cursor. */
  cur: ProviderCursor | null;
  startMs: number;
  endMs: number;
}

/**
 * Each eligible provider's window for this run. A dispatched range (BACKFILL_STARTTIME/ENDTIME) is a one-off fill and
 * leaves every cursor alone; otherwise a provider without a cursor gets a new one (added to `cursor`), a finished or
 * windowless walk asks nothing.
 */
export function planJobs(
  providers: readonly ProviderConfig[],
  cursor: BackfillCursorFile,
  opts: { liveDay: string; liveDayMs: number; targetMs: number; dispatch: { startMs: number; endMs: number } | null; only: ReadonlySet<string> | null },
): Job[] {
  const jobs: Job[] = [];
  for (const p of providers) {
    if (opts.only && !opts.only.has(p.id)) continue;
    const cfg = backfillCfg(p);
    if (!cfg) continue;
    if (opts.dispatch) {
      jobs.push({ p, cfg, cur: null, startMs: opts.dispatch.startMs, endMs: opts.dispatch.endMs });
      continue;
    }
    const cur = (cursor.providers[p.id] ??= newCursor(opts.liveDay, cfg));
    if (cur.done) continue;
    const win = nextWindow(cur, cfg, opts.targetMs, opts.liveDayMs);
    if (!win) continue;
    jobs.push({ p, cfg, cur, ...win });
  }
  return jobs;
}

export type WindowVerdict =
  /** Overflow with room to narrow: nothing ingested, the window halves for the next run. */
  | { kind: 'narrowed' }
  /** The fetch failed: nothing ingested; a walk counts the failure and halves. */
  | { kind: 'failed'; error: string }
  /** Rows to ingest; `saturated` = a one-day window still overflowed (partial, recorded for remediation). */
  | { kind: 'answered'; saturated: boolean; advanced: boolean };

export const windowText = (j: Pick<Job, 'startMs' | 'endMs'>): string =>
  `${eventDayKey(j.startMs)}..${eventDayKey(j.endMs)} (${Math.round((j.endMs - j.startMs) / DAY)} d)`;

/**
 * How one window's answer moves its cursor (the walk), exactly as the run applies it. `untouchable` says whether the
 * window holds a day the run must leave unwritten (its only copy is in an archive that could not be read): the cursor
 * then stays where it is, so the same window is asked again once the Releases are readable. A dispatched range never
 * moves a cursor; its overflow or failure is a blocker (it is asked once, and filling nothing must not pass as done).
 */
export function applyWindowResult(
  j: Job,
  res: Pick<WindowOutcome, 'overflow' | 'status' | 'obs'>,
  opts: { ingestTime: string; targetMs: number; untouchable: boolean },
): { verdict: WindowVerdict; blocker?: string } {
  const cur = j.cur;
  if (cur) cur.lastRun = opts.ingestTime;
  if (res.overflow && (!cur || cur.windowDays > 1)) {
    if (cur) {
      narrowAfterOverflow(cur);
      return { verdict: { kind: 'narrowed' } };
    }
    return { verdict: { kind: 'narrowed' }, blocker: `backfill: dispatched window ${windowText(j)} of ${j.p.id} filled the page cap and was not ingested; dispatch narrower ranges` };
  }
  if (!res.status.ok) {
    const error = res.status.error ?? `HTTP ${res.status.http_status ?? '?'}`;
    if (cur) {
      recordFailure(cur, error, opts.ingestTime);
      return { verdict: { kind: 'failed', error } };
    }
    return { verdict: { kind: 'failed', error }, blocker: `backfill: dispatched window ${windowText(j)} of ${j.p.id} failed: ${error}` };
  }
  const saturated = res.overflow;
  if (saturated && cur) {
    (cur.saturatedDays ??= []).push(eventDayKey(j.startMs));
    if (cur.saturatedDays.length > 100) cur.saturatedDays.shift();
  }
  let advanced = false;
  if (cur) {
    recordAnswer(cur, res.obs.length);
    if (!opts.untouchable) {
      advance(cur, j.cfg, j.startMs, res.obs.length, saturated, opts.targetMs);
      advanced = true;
    }
  }
  return { verdict: { kind: 'answered', saturated, advanced } };
}

/** The stalled walks of this run: an alarm is a blocker (the run goes red), a warning an annotation. */
export function stallReport(jobs: readonly Job[]): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const j of jobs) {
    const cur = j.cur;
    if (!cur) continue;
    const level = stallLevel(cur);
    if (level === 'ok') continue;
    const msg =
      `backfill: ${j.p.id} has failed ${cur.failures} consecutive runs since ${cur.failingSince} (last error: ${cur.lastError}); ` +
      `its walk stands at ${cur.filledBackTo} with a ${cur.windowDays}-day window. Fix the source or set its registry backfill.enabled to false`;
    if (level === 'alarm') blockers.push(msg);
    else warnings.push(msg);
  }
  return { blockers, warnings };
}
