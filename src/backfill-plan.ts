import { type BackfillCfg, backfillCfg } from './backfill-cfg.js';
import { type ProviderCursor, STALL_ALARM_FAILURES, advance, narrowAfterOverflow, newCursor, nextWindow, recordAnswer, recordFailure, stallLevel } from './backfill-cursor.js';
import { eventDayKey } from './bitemporal.js';
import type { WindowOutcome } from './providers.js';
import { RETENTION, retainedFrom, retainedFromMs, retentionNote } from './retention.js';
import type { EventNode, ProviderConfig } from './types.js';

/**
 * The backfill run's decisions (src/backfill.ts), pure over their inputs so they are tested without the network or a
 * data branch (FEED-TEST-1, tests/backfill-plan.test.ts): which window each provider is asked for, and how a window's
 * answer moves that provider's cursor. The orchestrator keeps the I/O (fetch, archives, partitions).
 */

const DAY = 86_400_000;

export interface BackfillCursorFile {
  targetStart: string;
  providers: Record<string, ProviderCursor>;
  /**
   * The dispatched windows still open: a dispatched range that overflowed, failed or held back a day is asked once,
   * so the run records it here and every later run (cron or dispatch) reports what is left of it in its blocked marker,
   * until dispatched ranges that answered in full cover it (recordDispatchOutcome). Absent = none.
   */
  dispatched?: OpenDispatch[];
}

/** A part of a dispatched window that has not been filled yet. */
export interface OpenDispatch {
  provider: string;
  /** ISO times, half-open [start, end). */
  start: string;
  end: string;
  /** Why it is open: 'overflow' (filled the page cap), 'failed' (the fetch failed) or 'held' (a day of it could only
   *  be rebuilt from an archive that could not be read, so the run left it unwritten). */
  reason: 'overflow' | 'failed' | 'held';
  error?: string;
  /** The ingest time of the run that opened it. */
  since: string;
}

export interface Job {
  p: ProviderConfig;
  cfg: BackfillCfg;
  /** null for a dispatched one-off range: it never moves the walk's cursor. */
  cur: ProviderCursor | null;
  startMs: number;
  endMs: number;
}

/** A window, or the part of one, the run does not ask for: older than the source's retention (SHLTR-146). */
export interface PlanSkip {
  provider: string;
  /** Half-open [startMs, endMs). */
  startMs: number;
  endMs: number;
  reason: typeof RETENTION;
  /** The first whole day the source still answers for. */
  retainedFrom: string;
  note: string;
  /** A walk's window (its cursor is then done: nothing older can be fetched), not a dispatched one. */
  walk: boolean;
}

/**
 * Each eligible provider's window for this run. A dispatched range (BACKFILL_STARTTIME/ENDTIME) is a one-off fill and
 * leaves every cursor alone; otherwise a provider without a cursor gets a new one (added to `cursor`), a finished or
 * windowless walk asks nothing.
 *
 * A source with a retention (registry `retentionDays`, src/retention.ts) is never asked for a day before it: such a
 * window is a `skipped` entry with the reason `retention`, never a job, so no request is made and nothing reads as
 * filled; a window across the edge is asked from the edge on. A walk whose next window lies wholly before the edge
 * is done (`stoppedBy: 'retention'`): the source no longer holds anything older.
 */
export function planWindows(
  providers: readonly ProviderConfig[],
  cursor: BackfillCursorFile,
  opts: { liveDay: string; liveDayMs: number; targetMs: number; nowMs: number; dispatch: { startMs: number; endMs: number } | null; only: ReadonlySet<string> | null },
): { jobs: Job[]; skipped: PlanSkip[] } {
  const jobs: Job[] = [];
  const skipped: PlanSkip[] = [];
  for (const p of providers) {
    if (opts.only && !opts.only.has(p.id)) continue;
    const cfg = backfillCfg(p);
    if (!cfg) continue;
    let cur: ProviderCursor | null = null;
    let win: { startMs: number; endMs: number } | null;
    if (opts.dispatch) win = { ...opts.dispatch };
    else {
      cur = cursor.providers[p.id] ??= newCursor(opts.liveDay, cfg);
      if (cur.done) continue;
      win = nextWindow(cur, cfg, opts.targetMs, opts.liveDayMs);
      if (!win) continue;
    }
    const edgeMs = retainedFromMs(p, opts.nowMs);
    if (edgeMs != null && win.startMs < edgeMs) {
      const skip: PlanSkip = {
        provider: p.id, startMs: win.startMs, endMs: Math.min(win.endMs, edgeMs), reason: RETENTION, retainedFrom: retainedFrom(p, opts.nowMs)!,
        note: retentionNote(p, opts.nowMs), walk: cur != null,
      };
      skipped.push(skip);
      if (win.endMs <= edgeMs) {
        if (cur) {
          cur.done = true;
          cur.stoppedBy = RETENTION;
        }
        continue;
      }
      win = { startMs: edgeMs, endMs: win.endMs };
    }
    jobs.push({ p, cfg, cur, ...win });
  }
  return { jobs, skipped };
}

/** planWindows' jobs alone. */
export const planJobs = (...args: Parameters<typeof planWindows>): Job[] => planWindows(...args).jobs;

/** One line per provider and UTC day of a plan: `fetch` (a job's day) or `retention` (a skipped day). */
export function planDays(jobs: ReadonlyArray<Pick<Job, 'p' | 'startMs' | 'endMs'>>, skipped: readonly PlanSkip[]): { provider: string; day: string; action: 'fetch' | typeof RETENTION }[] {
  const out: { provider: string; day: string; action: 'fetch' | typeof RETENTION }[] = [];
  const days = (s: number, e: number): string[] => {
    const r: string[] = [];
    for (let ms = Date.parse(`${eventDayKey(s)}T00:00:00Z`); ms < e; ms += DAY) r.push(eventDayKey(ms));
    return r;
  };
  for (const k of skipped) for (const day of days(k.startMs, k.endMs)) out.push({ provider: k.provider, day, action: RETENTION });
  for (const j of jobs) for (const day of days(j.startMs, j.endMs)) out.push({ provider: j.p.id, day, action: 'fetch' });
  return out.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** The log line of a skipped window. */
export const skipLine = (k: PlanSkip): string =>
  `backfill: ${k.provider} ${windowText(k)} skipped (${k.reason}): ${k.note}${k.walk ? '; its walk is done' : ''}`;

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

/**
 * The stalled walks: an alarm is a blocker (the run's marker, a P3 on the "[health] feed" board), a warning an
 * annotation. Backfill's marker states every standing block on every run, so an empty marker clears the board (the
 * health workflow reads only the newest one): a walk at one day with STALL_ALARM_FAILURES or more failures is a
 * blocker on EVERY run, not only on stallLevel's every 24th failure, until the source answers again. Pass every eligible
 * provider's cursor (a dispatched run has no walk jobs, yet must still report the walks' stalls).
 */
export function stallReport(walks: ReadonlyArray<Pick<Job, 'p' | 'cur'>>): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const j of walks) {
    const cur = j.cur;
    if (!cur || cur.done) continue;
    const level = cur.failures >= STALL_ALARM_FAILURES && cur.windowDays <= 1 ? 'alarm' : stallLevel(cur);
    if (level === 'ok') continue;
    const msg =
      `backfill: ${j.p.id} has failed ${cur.failures} consecutive runs since ${cur.failingSince} (last error: ${cur.lastError}); ` +
      `its walk stands at ${cur.filledBackTo} with a ${cur.windowDays}-day window. Fix the source or set its registry backfill.enabled to false`;
    if (level === 'alarm') blockers.push(msg);
    else warnings.push(msg);
  }
  return { blockers, warnings };
}

const MIN_OPEN_MS = 60_000;

/** [a, b) minus [c, d): zero, one or two pieces, dropping a piece shorter than a minute (an ISO end like 23:59:59Z). */
function subtract(a: number, b: number, c: number, d: number): Array<[number, number]> {
  if (d <= a || c >= b) return [[a, b]];
  const out: Array<[number, number]> = [];
  if (c - a >= MIN_OPEN_MS) out.push([a, c]);
  if (b - d >= MIN_OPEN_MS) out.push([d, b]);
  return out;
}

/** The provider's open dispatched windows minus [startMs, endMs). */
function closeRange(open: OpenDispatch[], provider: string, startMs: number, endMs: number): OpenDispatch[] {
  const out: OpenDispatch[] = [];
  for (const o of open) {
    if (o.provider !== provider) {
      out.push(o);
      continue;
    }
    for (const [s, e] of subtract(Date.parse(o.start), Date.parse(o.end), startMs, endMs)) out.push({ ...o, start: new Date(s).toISOString(), end: new Date(e).toISOString() });
  }
  return out;
}

/**
 * How one dispatched window's outcome moves the open list (BackfillCursorFile.dispatched): an answer whose days were
 * all written closes that range for its provider (the narrower ranges an operator dispatches after an overflow close
 * the overflowed window piece by piece); an overflow, a failure, or an answer that left a day unwritten opens it
 * (replacing whatever was open over the same range). A walk job (cursor set) changes nothing: the walk asks again.
 */
export function recordDispatchOutcome(
  open: readonly OpenDispatch[],
  j: Pick<Job, 'p' | 'cur' | 'startMs' | 'endMs'>,
  verdict: WindowVerdict,
  opts: { ingestTime: string; untouchable: boolean },
): OpenDispatch[] {
  if (j.cur) return [...open];
  const rest = closeRange([...open], j.p.id, j.startMs, j.endMs);
  const range = { provider: j.p.id, start: new Date(j.startMs).toISOString(), end: new Date(j.endMs).toISOString(), since: opts.ingestTime };
  if (verdict.kind === 'narrowed') rest.push({ ...range, reason: 'overflow' });
  else if (verdict.kind === 'failed') rest.push({ ...range, reason: 'failed', error: verdict.error.slice(0, 200) });
  else if (opts.untouchable) rest.push({ ...range, reason: 'held' });
  return rest;
}

/**
 * The open dispatched windows without their parts before a source's retention (SHLTR-146): those can never be filled,
 * so they leave the list (with a log line each) instead of standing on the board for good.
 */
export function closeBeyondRetention(open: readonly OpenDispatch[], providers: readonly ProviderConfig[], nowMs: number): { open: OpenDispatch[]; closed: string[] } {
  const out: OpenDispatch[] = [];
  const closed: string[] = [];
  for (const o of open) {
    const p = providers.find((x) => x.id === o.provider);
    const edgeMs = p ? retainedFromMs(p, nowMs) : null;
    const s = Date.parse(o.start);
    const e = Date.parse(o.end);
    if (!p || edgeMs == null || s >= edgeMs) {
      out.push(o);
      continue;
    }
    closed.push(`backfill: dispatched window ${windowText({ startMs: s, endMs: Math.min(e, edgeMs) })} of ${o.provider} (open since ${o.since}) closed (${RETENTION}): ${retentionNote(p, nowMs)}`);
    if (e - edgeMs >= MIN_OPEN_MS) out.push({ ...o, start: new Date(edgeMs).toISOString() });
  }
  return { open: out, closed };
}

/** The marker lines of the open dispatched windows of the given providers (each names its provider id). */
export function openDispatchLines(open: readonly OpenDispatch[], providers: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const o of open) {
    if (!providers.has(o.provider)) continue;
    const w = windowText({ startMs: Date.parse(o.start), endMs: Date.parse(o.end) });
    const why =
      o.reason === 'overflow'
        ? 'filled the page cap and was not ingested; dispatch narrower ranges inside it'
        : o.reason === 'failed'
          ? `failed (${o.error ?? 'error'}); dispatch it again`
          : 'held back a day whose archive could not be read; dispatch it again once the Releases are readable';
    out.push(`backfill: dispatched window ${w} of ${o.provider} (open since ${o.since}) ${why}`);
  }
  return out;
}

/** C6: remember the day file an event was read from when that is not its time-day (a re-merged archive keeps an event
 *  whose time left the month in the member it was read from, src/remerge.ts `off_unit`). */
export function rememberHomeDay(homeDay: Map<string, string>, day: string, n: Pick<EventNode, 'feedId' | 'eventTimeMs'>): void {
  if (eventDayKey(n.eventTimeMs) !== day) homeDay.set(n.feedId, day);
  else homeDay.delete(n.feedId);
}

/** The day backfill writes an event back to: the day file it was read from when that kept it off its time-day (so a
 *  re-materialized day never loses it on the re-roll), else its time-day (a repositioned event moves as before). */
export const homeDayOf = (homeDay: ReadonlyMap<string, string>, n: Pick<EventNode, 'feedId' | 'eventTimeMs'>): string =>
  homeDay.get(n.feedId) ?? eventDayKey(n.eventTimeMs);

/**
 * The days a run's windows read and write (SHLTR-149, the sparse checkout of backfill.yml): every day from the first
 * window's start to the last window's end, which the run reads, and one day of margin on each side (a row may sit up to
 * a minute outside its window, so a write can land on the day before or after). Days from `liveDay` on are the live
 * pipeline's and never touched. Empty without jobs.
 */
export function windowDays(jobs: ReadonlyArray<Pick<Job, 'startMs' | 'endMs'>>, liveDay: string): string[] {
  if (!jobs.length) return [];
  const first = Math.min(...jobs.map((j) => j.startMs)) - DAY;
  const last = Math.max(...jobs.map((j) => j.endMs)) + DAY;
  const out: string[] = [];
  for (let ms = Date.parse(`${eventDayKey(first)}T00:00:00Z`); ms <= last; ms += DAY) {
    const d = eventDayKey(ms);
    if (d >= liveDay) break;
    out.push(d);
  }
  return out;
}

/** The sparse-checkout patterns (non-cone) of those days: one `/events/YYYY/MM/` per month, oldest first. */
export function sparseMonthPatterns(days: readonly string[]): string[] {
  return [...new Set(days.map((d) => `/events/${d.slice(0, 4)}/${d.slice(5, 7)}/`))];
}
