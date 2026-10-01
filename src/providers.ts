import { readFileSync } from 'node:fs';
import { BACKFILL_FETCH_TIMEOUT_MS, FETCH_LIMIT, FETCH_TIMEOUT_MS, HOT_WINDOW_DAYS, QUERY_LOOKBACK_MS, REGISTRY_PATH } from './config.js';
import { CUSTOM_ADAPTERS } from './custom.js';
import { type ParseStats, parseFdsnText, parseGeoJSON } from './fdsn.js';
import type { ProviderConfig, ProviderStatus, RawObs } from './types.js';
import { type FetchResult, fetchText, isoFromMs } from './util.js';

/** The GET every FDSN query goes through (util.ts fetchText); tests pass their own. */
export type Fetcher = (url: string, timeoutMs: number) => Promise<FetchResult>;

export function loadRegistry(path = REGISTRY_PATH): ProviderConfig[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { providers: ProviderConfig[] };
  return raw.providers;
}

export const activeProviders = (all: ProviderConfig[]): ProviderConfig[] => all.filter((p) => p.active);

export function priorityMap(all: ProviderConfig[]): Map<string, number> {
  return new Map(all.map((p) => [p.id, p.priority]));
}

export function configMap(all: ProviderConfig[]): Map<string, ProviderConfig> {
  return new Map(all.map((p) => [p.id, p]));
}

/** FDSN-safe timestamp: no fractional seconds, no trailing Z (some nodes reject both). */
const fdsnTime = (ms: number): string => isoFromMs(ms).slice(0, 19);

interface FetchParams {
  starttime?: number;
  endtime?: number;
  updatedafter?: number;
  minmag?: number;
  includedeleted?: 'only' | 'true';
  /** FDSN `offset`, 1-based: the first record of a page. */
  offset?: number;
}

function buildUrl(p: ProviderConfig, params: FetchParams): string {
  const q = new URLSearchParams({ format: p.queryFormat });
  if (!p.noLimit) q.set('limit', String(FETCH_LIMIT));
  if (params.offset != null && params.offset > 1) q.set('offset', String(params.offset));
  if (params.starttime != null) q.set('starttime', fdsnTime(params.starttime));
  if (params.endtime != null) q.set('endtime', fdsnTime(params.endtime));
  if (params.updatedafter != null) q.set('updatedafter', fdsnTime(params.updatedafter));
  if (params.minmag != null) q.set('minmagnitude', String(params.minmag));
  if (params.includedeleted != null) q.set('includedeleted', params.includedeleted);
  for (const [k, v] of Object.entries(p.params ?? {})) q.set(k, v);
  return `${p.base}?${q.toString()}`;
}

interface FdsnResult {
  obs: RawObs[];
  status: ProviderStatus;
  overflow: boolean;
  /** Records in the response before the parser dropped any; `overflow` is rows ≥ the limit. */
  rows: number;
}

/** Fail-open FDSN fetch. `overflow` = the result likely hit the row cap (window too wide). */
async function fetchFdsn(p: ProviderConfig, params: FetchParams, timeoutMs = FETCH_TIMEOUT_MS, fetcher: Fetcher = fetchText): Promise<FdsnResult> {
  try {
    const res = await fetcher(buildUrl(p, params), timeoutMs);
    if (res.status === 204 || res.status === 404) {
      return { obs: [], status: { ok: true, http_status: res.status, latency_ms: res.latencyMs, events_returned: 0 }, overflow: false, rows: 0 };
    }
    if (res.status >= 400) {
      return { obs: [], status: { ok: false, http_status: res.status, latency_ms: res.latencyMs, error: `HTTP ${res.status}` }, overflow: res.status === 400 || res.status === 413, rows: 0 };
    }
    const stats: ParseStats = { rows: 0 };
    const obs = p.parse === 'geojson' ? parseGeoJSON(res.body, p.id, stats) : parseFdsnText(res.body, p.id, stats);
    return {
      obs,
      status: { ok: true, http_status: res.status, latency_ms: res.latencyMs, events_returned: obs.length },
      overflow: !p.noLimit && Math.max(obs.length, stats.rows) >= FETCH_LIMIT,
      rows: stats.rows,
    };
  } catch (err) {
    return { obs: [], status: { ok: false, error: err instanceof Error ? err.message : String(err) }, overflow: false, rows: 0 };
  }
}

export interface FetchOutcome {
  provider: string;
  obs: RawObs[];
  status: ProviderStatus;
}
export interface WindowOutcome extends FetchOutcome {
  overflow: boolean;
}

/** How far back the live path asks a time-range FDSN source for origins: QUERY_LOOKBACK_MS (2 days), or the source's
 *  own `lookbackDays`, at most HOT_WINDOW_DAYS (aggregate drops an older row before the dedup sees it). Earthquakes
 *  Canada publishes many events more than 2 days after origin: on 2026-10-01, 12 of the 57 events of its 8-day answer
 *  had reached the feed through no source at all, and each of the 12 was in its answer at most 5.3 days after origin;
 *  over the 44 days to then, 132 of its 435 events (41 of them M ≥ 2.5) had not reached the feed. */
export function liveLookbackMs(p: ProviderConfig): number {
  if (p.lookbackDays == null || !(p.lookbackDays > 0)) return QUERY_LOOKBACK_MS;
  return Math.min(p.lookbackDays, HOT_WINDOW_DAYS) * 86_400_000;
}

/** Live path: recent events only (starttime = now − lookback). Fail-open. */
export async function fetchProvider(p: ProviderConfig, nowMs: number, fetcher: Fetcher = fetchText): Promise<FetchOutcome> {
  // Delayed catalogs (e.g. ISC) contribute nothing to the 2-day live window — skip them here
  // (no wasted fetch, no false "degraded"); backfill still uses them for historical depth.
  if (p.liveActive === false) return { provider: p.id, obs: [], status: { ok: true, events_returned: 0 } };
  if (p.adapter.startsWith('custom')) {
    const adapter = CUSTOM_ADAPTERS[p.id];
    if (!adapter) return { provider: p.id, obs: [], status: { ok: false, error: `no custom adapter for '${p.id}'` } };
    const started = performance.now();
    try {
      const obs = await adapter(p, nowMs);
      return { provider: p.id, obs, status: { ok: true, latency_ms: Math.round(performance.now() - started), events_returned: obs.length } };
    } catch (err) {
      return { provider: p.id, obs: [], status: { ok: false, latency_ms: Math.round(performance.now() - started), error: err instanceof Error ? err.message : String(err) } };
    }
  }
  const r = await fetchFdsn(p, p.supportsTimeRange ? { starttime: nowMs - liveLookbackMs(p) } : {}, p.timeoutMs ?? FETCH_TIMEOUT_MS, fetcher);
  return { provider: p.id, obs: r.obs, status: r.status };
}

/** One page of a sweep query (src/sweep-cursor.ts runs the paging and owns the cursor). */
export interface SweepPageQuery {
  /** `updated`: the revision sweep (H2), events UPDATED after `updatedAfterMs` whatever their
   *  origin, which catches reviewed solutions and late publications outside the live lookback.
   *  `deleted`: the delete sweep, events DELETED upstream after it (`includedeleted=only`). */
  kind: 'updated' | 'deleted';
  updatedAfterMs: number;
  /** Origin floor, the same on every page of one sweep, so the paged set does not shift. */
  startMs: number;
  /** 1-based first record. */
  offset: number;
}

export interface SweepPage extends FetchOutcome {
  /** Records in the response before parsing dropped any (a full page has FETCH_LIMIT). */
  rows: number;
  /** The page held FETCH_LIMIT records, so the query has more. */
  full: boolean;
}

export async function fetchSweepPage(p: ProviderConfig, q: SweepPageQuery, timeoutMs: number, fetcher: Fetcher = fetchText): Promise<SweepPage> {
  const r = await fetchFdsn(
    p,
    { updatedafter: q.updatedAfterMs, starttime: q.startMs, offset: q.offset, ...(q.kind === 'deleted' ? { includedeleted: 'only' as const } : {}) },
    timeoutMs,
    fetcher,
  );
  return { provider: p.id, obs: r.obs, status: r.status, rows: r.rows, full: r.status.ok && !p.noLimit && r.rows >= FETCH_LIMIT };
}

/** Backfill path: a bounded [startMs, endMs] window; rows outside are dropped (providers
 *  ignore params). `overflow` drives the caller's window-halving. */
export async function fetchProviderWindow(p: ProviderConfig, startMs: number, endMs: number, minmag?: number): Promise<WindowOutcome> {
  const inWindow = (o: RawObs): boolean => o.eventTimeMs >= startMs - 60_000 && o.eventTimeMs <= endMs + 60_000;
  if (p.adapter.startsWith('custom')) {
    const adapter = CUSTOM_ADAPTERS[p.id];
    if (!adapter) return { provider: p.id, obs: [], status: { ok: false, error: `no custom adapter for '${p.id}'` }, overflow: false };
    const started = performance.now();
    try {
      const raw = await adapter(p, endMs, { startMs, endMs });
      return { provider: p.id, obs: raw.filter(inWindow), status: { ok: true, latency_ms: Math.round(performance.now() - started), events_returned: raw.length }, overflow: raw.length >= 490 };
    } catch (err) {
      return { provider: p.id, obs: [], status: { ok: false, latency_ms: Math.round(performance.now() - started), error: err instanceof Error ? err.message : String(err) }, overflow: false };
    }
  }
  const r = await fetchFdsn(p, { starttime: startMs, endtime: endMs, minmag }, p.timeoutMs ?? BACKFILL_FETCH_TIMEOUT_MS);
  return { provider: p.id, obs: r.obs.filter(inWindow), status: r.status, overflow: r.overflow };
}
