import type { BackfillCfg } from './backfill-cfg.js';
import { eventDayKey } from './bitemporal.js';

const DAY = 86_400_000;

/** One provider's walk backward through history (knowledge/index/backfill.json `providers.<id>`). */
export interface ProviderCursor {
  /** The walk holds every day from here up to the live window. */
  filledBackTo: string;
  windowDays: number;
  done: boolean;
  /** Consecutive runs whose window fetch failed (0 after any answer). */
  failures: number;
  lastCount: number;
  lastRun: string;
  /** Days denser than the provider's page cap even at a 1-day window — captured partially,
   *  recorded here (bounded) for optional later sub-day remediation. */
  saturatedDays?: string[];
  /** The last failed fetch's error, kept until the provider answers again. */
  lastError?: string;
  /** Ingest time of the first failure of the current streak. */
  failingSince?: string;
}

/** From this many consecutive failures a run prints a warning annotation for the provider. */
export const STALL_WARN_FAILURES = 24;
/** From this many consecutive failures at a one-day window a stall turns the run red (see stallLevel). */
export const STALL_ALARM_FAILURES = 72;

export const dayStartMs = (dayKey: string): number => Date.parse(`${dayKey}T00:00:00Z`);

export function newCursor(liveDay: string, cfg: BackfillCfg): ProviderCursor {
  return { filledBackTo: liveDay, windowDays: cfg.initialWindowDays, done: false, failures: 0, lastCount: 0, lastRun: '' };
}

/** The window a provider's walk asks for next: from `windowDays` before where it stands up to there, never below the
 *  target or the source's earliest day. Null (and the cursor marked done) once nothing is left. */
export function nextWindow(cur: ProviderCursor, cfg: BackfillCfg, targetMs: number, liveDayMs: number): { startMs: number; endMs: number } | null {
  const endMs = Math.min(dayStartMs(cur.filledBackTo), liveDayMs);
  const startMs = Math.max(targetMs, cfg.earliestMs, endMs - cur.windowDays * DAY);
  if (startMs >= endMs) {
    cur.done = true;
    return null;
  }
  return { startMs, endMs };
}

const halve = (cur: ProviderCursor): void => {
  cur.windowDays = Math.max(1, Math.floor(cur.windowDays / 2));
};

/** A window whose answer filled the page cap while it can still narrow: ingest nothing, ask for half next run. */
export const narrowAfterOverflow = halve;

/**
 * A window fetch that failed (timeout, HTTP error, refused connection): count it, keep its error, and halve the window,
 * as an overflow does. A window whose answer is too large to stream within the timeout fails as a timeout, never as an
 * overflow, so before this the window never shrank: ISC's 21-day window (more than 5,000 rows, about 35 s against its
 * 30 s timeout) failed 1,861 runs in a row, from July 2026 to 2026-10-01, while the cursor still asked for 21 days. Halved,
 * such a window recovers within a few runs. A source that is down keeps failing at one day and, once it answers again,
 * grows back by half per sparse window (advance).
 */
export function recordFailure(cur: ProviderCursor, error: string, ingestTime: string): void {
  if (cur.failures === 0 || !cur.failingSince) cur.failingSince = ingestTime;
  cur.failures++;
  cur.lastError = error.slice(0, 300);
  halve(cur);
}

/** A window that answered (ingested, saturated, or held back by an unreadable archive): the failure streak ends. */
export function recordAnswer(cur: ProviderCursor, rows: number): void {
  cur.failures = 0;
  cur.lastCount = rows;
  delete cur.lastError;
  delete cur.failingSince;
}

/** Move the walk to the window's start and adapt the window: back to the initial size after a saturated day, half
 *  again as wide (up to the maximum) after a sparse one. Done once the start reaches the target or the earliest day. */
export function advance(cur: ProviderCursor, cfg: BackfillCfg, startMs: number, rows: number, saturated: boolean, targetMs: number): void {
  cur.filledBackTo = eventDayKey(startMs);
  if (saturated) cur.windowDays = cfg.initialWindowDays;
  else if (rows < 0.3 * 5000) cur.windowDays = Math.min(cfg.maxWindowDays, Math.ceil(cur.windowDays * 1.5));
  if (dayStartMs(cur.filledBackTo) <= Math.max(targetMs, cfg.earliestMs)) cur.done = true;
}

/**
 * How a run reports a provider's failure streak. `warn` from STALL_WARN_FAILURES consecutive failures: a warning
 * annotation every run. `alarm` from STALL_ALARM_FAILURES while the window is already one day (narrowing cannot help:
 * the source is down or answers in a way the adapter cannot read), on every STALL_WARN_FAILURES-th failure, which at
 * the hourly pace is about once a day: the run goes red after its commit. ISC's stall was green for 1,861 runs; a stall
 * now cannot stay silent, and it does not turn every hourly run red either.
 */
export function stallLevel(cur: ProviderCursor): 'ok' | 'warn' | 'alarm' {
  if (cur.failures < STALL_WARN_FAILURES) return 'ok';
  if (cur.failures >= STALL_ALARM_FAILURES && cur.windowDays <= 1 && cur.failures % STALL_WARN_FAILURES === 0) return 'alarm';
  return 'warn';
}
