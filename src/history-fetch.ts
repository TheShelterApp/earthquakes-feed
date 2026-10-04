import { type ParseStats, isNoData, parseFdsnText, parseGeoJSON } from './fdsn.js';
import type { ProviderConfig, RawObs } from './types.js';

/**
 * Deep history (PF-5j): one source's rows for one closed time range, fetched as a polite client. Requests go out one
 * at a time with at least `spacingMs` between the end of one and the start of the next; HTTP 429 / 5xx answers wait
 * (Retry-After when the source sends one, else 5 s doubling, capped at 2 min) and are retried a few times (a
 * Retry-After over 2 min ends the attempt at once and is handed back, so the walk asks no sooner); a window
 * whose answer fills the page or times out is split in two. A range that cannot be fetched whole fails as a whole:
 * the caller uploads nothing for it and the next run asks again. A source with a count service (ComCat's
 * `fdsnws/event/1/count`) is asked for the count first: a window over the page is split before it is fetched, and
 * the rows of every window must equal the count the source gave for it.
 */

export interface HttpAnswer {
  status: number;
  body: string;
  latencyMs: number;
  /** Retry-After in ms, when the answer carried one. */
  retryAfterMs: number | null;
}
export type HistoryFetcher = (url: string, timeoutMs: number) => Promise<HttpAnswer>;

/** The contact URL is the repository (issues, SECURITY.md): the feed host's root answers 404. */
export const HISTORY_USER_AGENT = 'earthquakes-feed-history/1.0 (+https://github.com/TheShelterApp/earthquakes-feed; deep-history backfill, one request at a time)';

export async function fetchHttp(url: string, timeoutMs: number): Promise<HttpAnswer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': HISTORY_USER_AGENT, accept: 'application/json, text/plain, */*' } });
    const body = await res.text();
    return { status: res.status, body, latencyMs: Math.round(performance.now() - started), retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), Date.now()) };
  } finally {
    clearTimeout(timer);
  }
}

/** Retry-After as delta-seconds or an HTTP date, in ms from `nowMs`; null when absent or unreadable. */
export function parseRetryAfter(v: string | null, nowMs: number): number | null {
  if (!v) return null;
  const s = Number(v.trim());
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - nowMs) : null;
}

/** Sources with a count service at the query URL with `/query` replaced by `/count` (USGS's extension of FDSN). */
export const COUNT_SERVICE_PROVIDERS: ReadonlySet<string> = new Set(['usgs']);

/** FDSN-safe timestamp: no fractional seconds, no trailing Z (the live path's form, providers.ts). */
const fdsnTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

export function historyQueryUrl(p: ProviderConfig, startMs: number, endMs: number, opts: { limit: number; minMagnitude: number | null; count?: boolean }): string {
  const q = new URLSearchParams({ format: opts.count ? 'geojson' : p.queryFormat });
  if (!opts.count && !p.noLimit) q.set('limit', String(opts.limit));
  q.set('starttime', fdsnTime(startMs));
  // FDSN endtime is inclusive and second-precision: ask to the end second, keep only rows before endMs below.
  q.set('endtime', fdsnTime(endMs));
  if (opts.minMagnitude != null) q.set('minmagnitude', String(opts.minMagnitude));
  for (const [k, v] of Object.entries(p.params ?? {})) if (!(opts.count && k === 'orderby')) q.set(k, v);
  const base = opts.count ? p.base.replace(/\/query$/, '/count') : p.base;
  return `${base}?${q.toString()}`;
}

export interface WindowLog {
  start: string;
  end: string;
  /** Records in the answer, before the parser dropped any. */
  rows: number;
  /** The source's own count for the window (count service), else null. */
  count: number | null;
  http: number | null;
  ms: number | null;
}

export interface FetchedRange {
  rows: RawObs[];
  windows: WindowLog[];
  /** Records the source sent across all windows. */
  responseRows: number;
  /** Rows the parser kept (time, place and id present) inside [startMs, endMs). */
  parsedRows: number;
  /** The same native id in two windows (a row at a window's edge): kept once. */
  duplicateIds: number;
  /** Sum of the windows' counts when the source has a count service, else null. */
  providerCount: number | null;
  requests: number;
}

export type FetchRangeResult =
  | ({ ok: true } & FetchedRange)
  /** `budget`: the run's time budget ran out (not the source's fault: the range is asked again next run). */
  | { ok: false; error: string; windows: WindowLog[]; requests: number; budget?: boolean; retryAfterMs?: number };

export interface FetchRangeOptions {
  limit: number;
  minMagnitude: number | null;
  spacingMs: number;
  timeoutMs: number;
  /** Retries of one request after a 429 / 5xx / network error (a timeout splits instead). */
  maxRetries?: number;
  /** Smallest window ever asked for; a fuller one fails the range. */
  minWindowMs?: number;
  /** Give up (fail the range) once the clock passes this. */
  deadlineMs?: number;
  /** Shared between the calls that go to one host, so the pause holds across months too. */
  pace?: { lastEndMs: number };
  fetcher?: HistoryFetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const BACKOFF_START_MS = 5_000;
const BACKOFF_CAP_MS = 120_000;

/** Fetch every row of `p` with an origin in [startMs, endMs). */
export async function fetchRange(p: ProviderConfig, startMs: number, endMs: number, o: FetchRangeOptions): Promise<FetchRangeResult> {
  const fetcher = o.fetcher ?? fetchHttp;
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const maxRetries = o.maxRetries ?? 3;
  const minWindowMs = o.minWindowMs ?? 3600_000;
  const counted = COUNT_SERVICE_PROVIDERS.has(p.id);
  const windows: WindowLog[] = [];
  let requests = 0;
  const pace = o.pace ?? { lastEndMs: -Infinity };

  let budget = false;
  /** A Retry-After over BACKOFF_CAP_MS: returned to the caller, which waits it out across runs. */
  let longRetryAfterMs: number | null = null;
  /** One GET at the polite pace, with the 429 / 5xx / network retries. */
  const get = async (url: string): Promise<HttpAnswer | { status: null; error: string; timeout: boolean }> => {
    for (let attempt = 0; ; attempt++) {
      const wait = pace.lastEndMs + o.spacingMs - now();
      if (wait > 0) await sleep(wait);
      if (o.deadlineMs != null && now() > o.deadlineMs) {
        budget = true;
        return { status: null, error: 'run time budget reached', timeout: false };
      }
      requests++;
      let ans: HttpAnswer | null = null;
      let err: string | null = null;
      let timeout = false;
      try {
        ans = await fetcher(url, o.timeoutMs);
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
        timeout = /abort/i.test(err) || (e instanceof Error && e.name === 'AbortError');
      }
      pace.lastEndMs = now();
      if (ans && ans.status !== 429 && ans.status < 500) return ans;
      if (timeout) return { status: null, error: `timeout after ${o.timeoutMs} ms`, timeout: true };
      if (attempt >= maxRetries) return { status: null, error: ans ? `HTTP ${ans.status}` : String(err), timeout: false };
      // A source that asks for a longer pause than the cap gets it: the range fails now, and the walk leaves the
      // source alone until the time it named (src/history.ts, attempts[].not_before).
      if (ans?.retryAfterMs != null && ans.retryAfterMs > BACKOFF_CAP_MS) {
        longRetryAfterMs = ans.retryAfterMs;
        return { status: null, error: `HTTP ${ans.status}, Retry-After ${Math.round(ans.retryAfterMs / 1000)} s (over the ${BACKOFF_CAP_MS / 1000} s cap; asked again next run)`, timeout: false };
      }
      const backoff = Math.min(BACKOFF_CAP_MS, Math.max(ans?.retryAfterMs ?? 0, BACKOFF_START_MS * 2 ** attempt));
      await sleep(backoff);
    }
  };

  const fail = (error: string): FetchRangeResult => ({
    ok: false,
    error,
    windows,
    requests,
    ...(budget ? { budget: true } : {}),
    ...(longRetryAfterMs != null ? { retryAfterMs: longRetryAfterMs } : {}),
  });
  const byId = new Map<string, RawObs>();
  let responseRows = 0;
  let parsedRows = 0;
  let duplicateIds = 0;
  let providerCount: number | null = counted ? 0 : null;
  // Newest window first, so the answer order is stable whatever the splits.
  const todo: [number, number][] = [[startMs, endMs]];
  while (todo.length) {
    const [ws, we] = todo.shift()!;
    const split = (why: string): FetchRangeResult | null => {
      if (we - ws <= minWindowMs) return fail(`${why} at a ${Math.round((we - ws) / 60_000)}-minute window ${fdsnTime(ws)}..${fdsnTime(we)}`);
      const mid = ws + Math.floor((we - ws) / 2 / 1000) * 1000;
      todo.unshift([mid, we], [ws, mid]);
      return null;
    };
    let count: number | null = null;
    if (counted) {
      const c = await get(historyQueryUrl(p, ws, we, { limit: o.limit, minMagnitude: o.minMagnitude, count: true }));
      if (c.status == null) return fail(`count ${fdsnTime(ws)}..${fdsnTime(we)}: ${c.error}`);
      const n = c.status === 200 ? (JSON.parse(c.body) as { count?: unknown }).count : isNoData(p, c.status) ? 0 : null;
      if (typeof n !== 'number') return fail(`count ${fdsnTime(ws)}..${fdsnTime(we)}: HTTP ${c.status}`);
      count = n;
      if (count >= o.limit) {
        const r = split(`count ${count} over the page of ${o.limit}`);
        if (r) return r;
        continue;
      }
      if (count === 0) {
        windows.push({ start: new Date(ws).toISOString(), end: new Date(we).toISOString(), rows: 0, count: 0, http: c.status, ms: c.latencyMs });
        continue;
      }
    }
    const a = await get(historyQueryUrl(p, ws, we, { limit: o.limit, minMagnitude: o.minMagnitude }));
    if (a.status == null) {
      if (a.timeout) {
        const r = split('timeout');
        if (r) return r;
        continue;
      }
      return fail(`${fdsnTime(ws)}..${fdsnTime(we)}: ${a.error}`);
    }
    let obs: RawObs[] = [];
    const stats: ParseStats = { rows: 0 };
    if (a.status === 200) {
      try {
        obs = p.parse === 'geojson' ? parseGeoJSON(a.body, p.id, stats) : parseFdsnText(a.body, p.id, stats);
      } catch (e) {
        return fail(`${fdsnTime(ws)}..${fdsnTime(we)}: unreadable answer (${e instanceof Error ? e.message : String(e)})`);
      }
    } else if (!isNoData(p, a.status)) {
      // 4xx other than "no data": a query the source refuses (413 / 400 for too many rows on some nodes) splits.
      if (a.status === 413 || a.status === 400) {
        const r = split(`HTTP ${a.status}`);
        if (r) return r;
        continue;
      }
      return fail(`${fdsnTime(ws)}..${fdsnTime(we)}: HTTP ${a.status}`);
    }
    if (!p.noLimit && stats.rows >= o.limit) {
      const r = split(`answer filled the page of ${o.limit}`);
      if (r) return r;
      continue;
    }
    if (count != null && stats.rows !== count) {
      // The catalogue changed between the count and the query (an event added or deleted in those seconds), or the
      // two disagree: never keep a window the source's own count does not confirm.
      return fail(`${fdsnTime(ws)}..${fdsnTime(we)}: ${stats.rows} rows where the count service said ${count}`);
    }
    responseRows += stats.rows;
    if (providerCount != null && count != null) providerCount += count;
    windows.push({ start: new Date(ws).toISOString(), end: new Date(we).toISOString(), rows: stats.rows, count, http: a.status, ms: a.latencyMs });
    for (const r of obs) {
      if (r.eventTimeMs < startMs || r.eventTimeMs >= endMs) continue;
      parsedRows++;
      const prev = byId.get(r.providerEventId);
      if (prev) {
        duplicateIds++;
        if ((r.providerUpdatedMs ?? -Infinity) <= (prev.providerUpdatedMs ?? -Infinity)) continue;
      }
      byId.set(r.providerEventId, r);
    }
  }
  windows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { ok: true, rows: [...byId.values()], windows, responseRows, parsedRows, duplicateIds, providerCount, requests };
}
