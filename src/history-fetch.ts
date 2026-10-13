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
 * the rows of every window must equal the count the source gave for it. Two sources have one: ComCat
 * (`fdsnws/event/1/count`, USGS's extension of FDSN) and EMSC (`fdsnws/event/1/count`, the `counts` resource of its
 * WADL; it answers `{"count":N}` for `format=json`, HTTP 500 for `format=geojson`). Measured 2026-10-06: none of the
 * other 15 FDSN services the feed reads answers a count (14 answer 404 or 400; INGV was unreachable from the test host).
 *
 * EMSC answers some events it counts as empty elements of its json `features` array, and in no other format either
 * (src/fdsn.ts, repairEmptyArrayElements; 2017-12 held ten, round 23). A window with such elements is split down to
 * `minWindowMs` and then kept only when its rows plus its empty elements equal the count the source gave for it: the
 * window log says how many (`unserialized`), the raw header and the index list each such window, and nothing else is
 * ever accepted short of the count.
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

/** Sources with a count service at the query URL with `/query` replaced by `/count`, asked in the source's own query
 *  format (ComCat `geojson`, EMSC `json`): both answer `{"count":N}`. */
export const COUNT_SERVICE_PROVIDERS: ReadonlySet<string> = new Set(['usgs', 'emsc']);

/** FDSN-safe timestamp: no fractional seconds, no trailing Z (the live path's form, providers.ts). */
const fdsnTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

export function historyQueryUrl(p: ProviderConfig, startMs: number, endMs: number, opts: { limit: number; minMagnitude: number | null; count?: boolean }): string {
  // The count is asked in the query's own format: ComCat's count answers `geojson`, EMSC's `json` (500 for geojson).
  const q = new URLSearchParams({ format: p.queryFormat });
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
  /** Events the source counted in the window but answered as empty elements (EMSC); absent when none. */
  unserialized?: number;
}

/** A window whose answer lacked events the source counted (WindowLog.unserialized): an explicit gap of the raw asset. */
export interface UnserializedWindow {
  start: string;
  end: string;
  count: number;
}

/** The gaps a raw asset's windows record (empty when none). */
export const unserializedWindows = (windows: readonly WindowLog[]): UnserializedWindow[] =>
  windows.filter((w) => (w.unserialized ?? 0) > 0).map((w) => ({ start: w.start, end: w.end, count: w.unserialized! }));

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
  /** Events the source counted but answered as empty elements (windows[].unserialized): providerCount = responseRows + this. */
  unserialized: number;
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
  let unserialized = 0;
  let providerCount: number | null = counted ? 0 : null;

  /** One window's answer: kept as is, split (too full / too slow), or the range's failure. */
  type Asked =
    | { kind: 'fail'; error: string }
    | { kind: 'split'; why: string }
    | { kind: 'answer'; log: WindowLog; obs: RawObs[]; empty: number };
  const ask = async (ws: number, we: number): Promise<Asked> => {
    const span = `${fdsnTime(ws)}..${fdsnTime(we)}`;
    let count: number | null = null;
    if (counted) {
      const c = await get(historyQueryUrl(p, ws, we, { limit: o.limit, minMagnitude: o.minMagnitude, count: true }));
      if (c.status == null) return { kind: 'fail', error: `count ${span}: ${c.error}` };
      let n: unknown = null;
      try {
        n = c.status === 200 ? (JSON.parse(c.body) as { count?: unknown }).count : isNoData(p, c.status) ? 0 : null;
      } catch {
        return { kind: 'fail', error: `count ${span}: unreadable answer` };
      }
      if (typeof n !== 'number') return { kind: 'fail', error: `count ${span}: HTTP ${c.status}` };
      count = n;
      if (count >= o.limit) return { kind: 'split', why: `count ${count} over the page of ${o.limit}` };
      if (count === 0) return { kind: 'answer', log: { start: new Date(ws).toISOString(), end: new Date(we).toISOString(), rows: 0, count: 0, http: c.status, ms: c.latencyMs }, obs: [], empty: 0 };
    }
    const a = await get(historyQueryUrl(p, ws, we, { limit: o.limit, minMagnitude: o.minMagnitude }));
    if (a.status == null) return a.timeout ? { kind: 'split', why: 'timeout' } : { kind: 'fail', error: `${span}: ${a.error}` };
    let obs: RawObs[] = [];
    const stats: ParseStats = { rows: 0 };
    if (a.status === 200) {
      try {
        obs = p.parse === 'geojson' ? parseGeoJSON(a.body, p.id, stats) : parseFdsnText(a.body, p.id, stats);
      } catch (e) {
        return { kind: 'fail', error: `${span}: unreadable answer (${e instanceof Error ? e.message : String(e)})` };
      }
    } else if (!isNoData(p, a.status)) {
      // 4xx other than "no data": a query the source refuses (413 / 400 for too many rows on some nodes) splits.
      if (a.status === 413 || a.status === 400) return { kind: 'split', why: `HTTP ${a.status}` };
      return { kind: 'fail', error: `${span}: HTTP ${a.status}` };
    }
    const empty = stats.emptySlots ?? 0;
    if (!p.noLimit && stats.rows + empty >= o.limit) return { kind: 'split', why: `answer filled the page of ${o.limit}` };
    if (empty > 0) {
      // Events the source counted but did not send: only its count can say nothing else is missing.
      if (count == null) return { kind: 'fail', error: `${span}: ${empty} empty element(s) in the answer and no count to check them against` };
      if (stats.rows + empty !== count) return { kind: 'fail', error: `${span}: ${stats.rows} rows and ${empty} empty element(s) where the count service said ${count}` };
    } else if (count != null && stats.rows !== count) {
      // The catalogue changed between the count and the query (an event added or deleted in those seconds), or the
      // two disagree: never keep a window the source's own count does not confirm.
      return { kind: 'fail', error: `${span}: ${stats.rows} rows where the count service said ${count}` };
    }
    const log: WindowLog = { start: new Date(ws).toISOString(), end: new Date(we).toISOString(), rows: stats.rows, count, http: a.status, ms: a.latencyMs };
    if (empty > 0) log.unserialized = empty;
    return { kind: 'answer', log, obs, empty };
  };

  /**
   * A window kept with empty elements, narrowed: its halves are asked in turn, down to `minWindowMs`, so the gap the
   * asset records is as small as the source allows. Any half that is not a clean, count-confirmed answer (a window of
   * nothing but such events can answer `[]`, `[,]` or 204, which no count matches) ends the narrowing there and the
   * window is kept as it was answered.
   */
  const narrow = async (ws: number, we: number, whole: Extract<Asked, { kind: 'answer' }>): Promise<Extract<Asked, { kind: 'answer' }>[]> => {
    if (we - ws <= minWindowMs) return [whole];
    const mid = ws + Math.floor((we - ws) / 2 / 1000) * 1000;
    const out: Extract<Asked, { kind: 'answer' }>[] = [];
    for (const [hs, he] of [[ws, mid], [mid, we]] as const) {
      const h = await ask(hs, he);
      if (h.kind !== 'answer') return [whole];
      out.push(...(h.empty > 0 ? await narrow(hs, he, h) : [h]));
    }
    // The halves must account for the whole window's count (an event added or deleted meanwhile keeps the whole).
    const sum = (xs: Extract<Asked, { kind: 'answer' }>[]): number => xs.reduce((s, x) => s + x.log.rows + x.empty, 0);
    return sum(out) === sum([whole]) ? out : [whole];
  };

  const keep = (w: Extract<Asked, { kind: 'answer' }>): void => {
    windows.push(w.log);
    responseRows += w.log.rows;
    unserialized += w.empty;
    if (providerCount != null && w.log.count != null) providerCount += w.log.count;
    for (const r of w.obs) {
      if (r.eventTimeMs < startMs || r.eventTimeMs >= endMs) continue;
      parsedRows++;
      const prev = byId.get(r.providerEventId);
      if (prev) {
        duplicateIds++;
        if ((r.providerUpdatedMs ?? -Infinity) <= (prev.providerUpdatedMs ?? -Infinity)) continue;
      }
      byId.set(r.providerEventId, r);
    }
  };

  // Newest window first, so the answer order is stable whatever the splits.
  const todo: [number, number][] = [[startMs, endMs]];
  while (todo.length) {
    const [ws, we] = todo.shift()!;
    const r = await ask(ws, we);
    if (r.kind === 'fail') return fail(r.error);
    if (r.kind === 'split') {
      if (we - ws <= minWindowMs) return fail(`${r.why} at a ${Math.round((we - ws) / 60_000)}-minute window ${fdsnTime(ws)}..${fdsnTime(we)}`);
      const mid = ws + Math.floor((we - ws) / 2 / 1000) * 1000;
      todo.unshift([mid, we], [ws, mid]);
      continue;
    }
    for (const w of r.empty > 0 ? await narrow(ws, we, r) : [r]) keep(w);
  }
  windows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { ok: true, rows: [...byId.values()], windows, responseRows, parsedRows, duplicateIds, providerCount, unserialized, requests };
}
