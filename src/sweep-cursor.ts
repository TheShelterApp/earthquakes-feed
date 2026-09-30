import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DELETE_SWEEP_PROVIDERS,
  FETCH_LIMIT,
  HOT_WINDOW_DAYS,
  SWEEP_EPOCH,
  SWEEP_MAX_PAGES,
  SWEEP_OVERLAP_MS,
  SWEEP_PAGE_OVERLAP,
  SWEEP_TIMEOUT_MS,
  UPDATED_SWEEP_PROVIDERS,
  dataPaths,
} from './config.js';
import { type FetchOutcome, type Fetcher, fetchProvider, fetchSweepPage } from './providers.js';
import type { ProviderConfig, ProviderStatus, RawObs } from './types.js';
import { fetchText, isoFromMs } from './util.js';

// PF-5c. Until 2026-09-30 the sweeps asked from the provider's watermark, which the LIVE rows
// advance, and were issued after the ~40 live fetches with the live 8 s timeout. On the runner
// those fetches queue for name resolution (getaddrinfo on libuv's 4-thread pool), so the sweeps
// aborted in almost every run, and the next run asked from a watermark already past the failed
// window, which was then never asked for again. Now each sweep has a cursor of its own that only
// a complete sweep advances, its requests go out before the live ones, and it has its own budget.

const DAY_MS = 86_400_000;

export type SweepKind = 'updated' | 'deleted';

/** One sweep's cursor in knowledge/index/sweeps.json. aggregate writes the file in the same commit
 *  as the lines the sweep caused, so a run whose push fails leaves the old cursor behind and the
 *  next run asks for the same window again. */
export interface SweepCursor {
  /** The upper bound of the last complete sweep: the moment it requested its first page (ISO).
   *  Every update stamped before it was in that sweep's answer. */
  through: string;
  /** SWEEP_EPOCH when that sweep ran (a lower one, or none, means the catch-up is still due). */
  epoch: number;
}

/** Keyed `usgs:updated`, `emsc:updated`, `usgs:deleted` (sweepKey). */
export type SweepCursors = Record<string, SweepCursor>;

export const sweepKey = (provider: string, kind: SweepKind): string => `${provider}:${kind}`;

export function loadSweepCursors(root: string): SweepCursors {
  const f = dataPaths(root).sweepCursors;
  if (!existsSync(f)) return {};
  const raw = JSON.parse(readFileSync(f, 'utf8')) as Record<string, Partial<SweepCursor>>;
  const out: SweepCursors = {};
  for (const [k, c] of Object.entries(raw)) {
    if (typeof c?.through === 'string' && Number.isFinite(Date.parse(c.through)) && typeof c.epoch === 'number') {
      out[k] = { through: c.through, epoch: c.epoch };
    }
  }
  return out;
}

export function saveSweepCursors(root: string, cursors: SweepCursors): void {
  const f = dataPaths(root).sweepCursors;
  mkdirSync(dirname(f), { recursive: true });
  const sorted = Object.fromEntries(Object.keys(cursors).sort().map((k) => [k, cursors[k]]));
  writeFileSync(f, JSON.stringify(sorted, null, 2) + '\n');
}

export interface SweepSpec {
  provider: ProviderConfig;
  kind: SweepKind;
}

/** The sweeps of a run, in the order they are issued: the `updatedafter` revision sweeps
 *  (config UPDATED_SWEEP_PROVIDERS), then the delete sweeps (DELETE_SWEEP_PROVIDERS), each for an
 *  active FDSN source with time-range queries. */
export function sweepSpecs(active: readonly ProviderConfig[]): SweepSpec[] {
  const out: SweepSpec[] = [];
  const add = (ids: readonly string[], kind: SweepKind): void => {
    for (const id of ids) {
      const p = active.find((x) => x.id === id);
      if (p && p.adapter === 'fdsn' && p.supportsTimeRange) out.push({ provider: p, kind });
    }
  };
  add(UPDATED_SWEEP_PROVIDERS, 'updated');
  add(DELETE_SWEEP_PROVIDERS, 'deleted');
  return out;
}

export interface SweepWindow {
  /** `updatedafter` of every page of this sweep. */
  sinceMs: number;
  /** The one-time catch-up: no cursor, or one from an older SWEEP_EPOCH. */
  catchUp: boolean;
}

/**
 * Where a sweep starts. With a cursor of the current epoch: SWEEP_OVERLAP_MS before it, so a failed
 * window is asked for again until a sweep over it completes. Without one (the first run, or a
 * cursor from an older SWEEP_EPOCH): the catch-up, from now − HOT_WINDOW_DAYS, the window in which
 * an unknown ComCat row may still be minted (PF-5a). Never below the origin floor (no update of an
 * event older than it can be placed: updated ≥ origin), never later than now − SWEEP_OVERLAP_MS.
 */
export function sweepWindow(cursor: SweepCursor | undefined, nowMs: number, originFloorMs: number): SweepWindow {
  const throughMs = cursor ? Date.parse(cursor.through) : NaN;
  const catchUp = !cursor || !(cursor.epoch >= SWEEP_EPOCH) || !Number.isFinite(throughMs);
  const from = catchUp ? nowMs - HOT_WINDOW_DAYS * DAY_MS : throughMs - SWEEP_OVERLAP_MS;
  return { sinceMs: Math.max(originFloorMs, Math.min(from, nowMs - SWEEP_OVERLAP_MS)), catchUp };
}

/** `status.json` `sweeps.<kind>.<provider>`: the fetch outcome (ok, http_status, latency_ms over
 *  every page, events_returned = distinct rows, error) plus where the sweep stands. */
export interface SweepStatus extends ProviderStatus {
  /** `updatedafter` this run asked from. */
  since: string;
  /** The cursor after this run: this run's upper bound when the sweep completed, else the cursor
   *  it started from (null before the first complete sweep). */
  through: string | null;
  /** The epoch recorded with that cursor (null before the first complete sweep). */
  epoch: number | null;
  pages: number;
  /** Present on the one-time catch-up run (whether or not it completed). */
  catch_up?: true;
}

export interface SweepRun {
  spec: SweepSpec;
  key: string;
  /** Every row of every page that arrived, one per id (the most recently updated copy). Rows of an
   *  unfinished sweep are still applied: an unchanged re-report is a no-op, so the next run asking
   *  for the same window again changes nothing twice. */
  obs: RawObs[];
  status: SweepStatus;
  /** The cursor to persist: advanced on a complete sweep, else the one it started from. */
  cursor: SweepCursor | undefined;
  complete: boolean;
  catchUp: boolean;
}

/** undici's `fetch failed` hides why a request failed; a sweep's status names the cause
 *  (e.g. `fetch failed (UND_ERR_SOCKET other side closed)`). An abort keeps its own message. */
function withCause(fetcher: Fetcher): Fetcher {
  return async (url, timeoutMs) => {
    try {
      return await fetcher(url, timeoutMs);
    } catch (err) {
      const e = err as { message?: unknown; cause?: { code?: unknown; message?: unknown } };
      const cause = e.cause ? [e.cause.code, e.cause.message].filter((x) => typeof x === 'string' && x).join(' ') : '';
      const message = typeof e.message === 'string' ? e.message : String(err);
      throw new Error(cause ? `${message} (${cause})` : message);
    }
  };
}

export interface SweepOptions {
  nowMs: number;
  /** Origin floor of the query (`starttime`), the same on every page so the paged set does not
   *  shift: the oldest origin the run's loaded event map can hold. */
  originFloorMs: number;
  fetcher?: Fetcher;
  /** Wall clock for the upper bound and the budget (tests pass their own). */
  clock?: () => number;
}

/**
 * One sweep: pages of FETCH_LIMIT records (offset paging over a fixed origin floor, consecutive
 * pages overlapping by SWEEP_PAGE_OVERLAP) until a page comes back short, within SWEEP_TIMEOUT_MS
 * for all pages together and at most SWEEP_MAX_PAGES. Complete only when every page arrived and
 * the last one was short; only then does the cursor move, to the moment the first page was
 * requested (the query's upper bound: every update stamped before it is in the answer), never to
 * the end of the run. Fail-open, like the live fetch: an error is recorded, never thrown.
 */
export async function runSweep(spec: SweepSpec, cursor: SweepCursor | undefined, opts: SweepOptions): Promise<SweepRun> {
  const clock = opts.clock ?? Date.now;
  const fetcher = withCause(opts.fetcher ?? fetchText);
  const key = sweepKey(spec.provider.id, spec.kind);
  const win = sweepWindow(cursor, opts.nowMs, opts.originFloorMs);
  const startedMs = clock();
  const deadlineMs = startedMs + SWEEP_TIMEOUT_MS;
  const byId = new Map<string, RawObs>();
  let pages = 0;
  let offset = 1;
  let httpStatus: number | undefined;
  let error: string | undefined;
  let complete = false;
  for (;;) {
    if (pages >= SWEEP_MAX_PAGES) {
      error = `unfinished: more than ${SWEEP_MAX_PAGES} pages of ${FETCH_LIMIT}`;
      break;
    }
    const leftMs = deadlineMs - clock();
    if (leftMs <= 0) {
      error = `unfinished: the ${SWEEP_TIMEOUT_MS} ms sweep budget ran out after ${pages} page(s)`;
      break;
    }
    const page = await fetchSweepPage(spec.provider, { kind: spec.kind, updatedAfterMs: win.sinceMs, startMs: opts.originFloorMs, offset }, leftMs, fetcher);
    pages++;
    if (page.status.http_status != null) httpStatus = page.status.http_status;
    if (!page.status.ok) {
      error = pages > 1 ? `page ${pages}: ${page.status.error ?? 'failed'}` : (page.status.error ?? 'failed');
      break;
    }
    for (const o of page.obs) {
      const id = `${o.provider}:${o.providerEventId}`;
      const had = byId.get(id);
      if (!had || (o.providerUpdatedMs ?? -Infinity) >= (had.providerUpdatedMs ?? -Infinity)) byId.set(id, o);
    }
    if (!page.full) {
      complete = true;
      break;
    }
    offset += FETCH_LIMIT - SWEEP_PAGE_OVERLAP;
  }
  const next: SweepCursor | undefined = complete ? { through: isoFromMs(startedMs), epoch: SWEEP_EPOCH } : cursor;
  const status: SweepStatus = {
    ok: complete,
    ...(httpStatus != null ? { http_status: httpStatus } : {}),
    latency_ms: Math.round(clock() - startedMs),
    events_returned: byId.size,
    ...(error ? { error } : {}),
    since: isoFromMs(win.sinceMs),
    through: next?.through ?? null,
    epoch: next?.epoch ?? null,
    pages,
    ...(win.catchUp ? { catch_up: true as const } : {}),
  };
  return { spec, key, obs: [...byId.values()], status, cursor: next, complete, catchUp: win.catchUp };
}

export interface RunFetches {
  live: FetchOutcome[];
  sweeps: SweepRun[];
}

/**
 * aggregate's fetches, all concurrent: the sweeps are started first, so their first requests (and
 * the name lookups behind them) are issued ahead of the live ones, then every live source.
 * UV_THREADPOOL_SIZE (aggregate.yml) keeps the lookups from queueing at all; the order is the
 * second line of defence.
 */
export async function fetchRunInputs(
  active: readonly ProviderConfig[],
  specs: readonly SweepSpec[],
  cursors: SweepCursors,
  opts: SweepOptions,
): Promise<RunFetches> {
  const sweeps = Promise.all(specs.map((s) => runSweep(s, cursors[sweepKey(s.provider.id, s.kind)], opts)));
  const live = Promise.all(active.map((p) => fetchProvider(p, opts.nowMs, opts.fetcher ?? fetchText)));
  const [s, l] = await Promise.all([sweeps, live]);
  return { live: l, sweeps: s };
}

/** The cursors to persist after a run: each sweep's own (unchanged unless it completed). */
export function nextCursors(prev: SweepCursors, runs: readonly SweepRun[]): SweepCursors {
  const out: SweepCursors = { ...prev };
  for (const r of runs) if (r.cursor) out[r.key] = r.cursor;
  return out;
}

/** The origin floor of a run's sweep queries: one day below the oldest event-map day it loaded. */
export const sweepOriginFloorMs = (nowMs: number, loadDays: number): number => nowMs - (loadDays + 1) * DAY_MS;
