import { readFileSync } from 'node:fs';
import { BACKFILL_FETCH_TIMEOUT_MS, FETCH_LIMIT, FETCH_TIMEOUT_MS, QUERY_LOOKBACK_MS, REGISTRY_PATH } from './config.js';
import { CUSTOM_ADAPTERS } from './custom.js';
import { parseFdsnText, parseGeoJSON } from './fdsn.js';
import type { ProviderConfig, ProviderStatus, RawObs } from './types.js';
import { fetchText, isoFromMs } from './util.js';

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
}

function buildUrl(p: ProviderConfig, params: FetchParams): string {
  const q = new URLSearchParams({ format: p.queryFormat });
  if (!p.noLimit) q.set('limit', String(FETCH_LIMIT));
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
}

/** Fail-open FDSN fetch. `overflow` = the result likely hit the row cap (window too wide). */
async function fetchFdsn(p: ProviderConfig, params: FetchParams, timeoutMs = FETCH_TIMEOUT_MS): Promise<FdsnResult> {
  try {
    const res = await fetchText(buildUrl(p, params), timeoutMs);
    if (res.status === 204 || res.status === 404) {
      return { obs: [], status: { ok: true, http_status: res.status, latency_ms: res.latencyMs, events_returned: 0 }, overflow: false };
    }
    if (res.status >= 400) {
      return { obs: [], status: { ok: false, http_status: res.status, latency_ms: res.latencyMs, error: `HTTP ${res.status}` }, overflow: res.status === 400 || res.status === 413 };
    }
    const obs = p.parse === 'geojson' ? parseGeoJSON(res.body, p.id) : parseFdsnText(res.body, p.id);
    return {
      obs,
      status: { ok: true, http_status: res.status, latency_ms: res.latencyMs, events_returned: obs.length },
      overflow: !p.noLimit && obs.length >= FETCH_LIMIT,
    };
  } catch (err) {
    return { obs: [], status: { ok: false, error: err instanceof Error ? err.message : String(err) }, overflow: false };
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

/** Live path: recent events only (starttime = now − lookback). Fail-open. */
export async function fetchProvider(p: ProviderConfig, nowMs: number): Promise<FetchOutcome> {
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
  const r = await fetchFdsn(p, p.supportsTimeRange ? { starttime: nowMs - QUERY_LOOKBACK_MS } : {}, p.timeoutMs ?? FETCH_TIMEOUT_MS);
  return { provider: p.id, obs: r.obs, status: r.status };
}

/** Revision sweep (H2): FDSN events UPDATED since `sinceMs`, regardless of origin time —
 *  catches reviewed-solution upgrades that fall outside the 48h origin window. */
export async function fetchProviderUpdated(p: ProviderConfig, sinceMs: number): Promise<FetchOutcome> {
  if (p.adapter !== 'fdsn' || !p.supportsTimeRange) return { provider: p.id, obs: [], status: { ok: true, events_returned: 0 } };
  const r = await fetchFdsn(p, { updatedafter: sinceMs });
  return { provider: p.id, obs: r.obs, status: r.status };
}

/** Delete sweep: events DELETED upstream since `sinceMs` (USGS `includedeleted=only`). */
export async function fetchProviderDeleted(p: ProviderConfig, sinceMs: number): Promise<FetchOutcome> {
  const r = await fetchFdsn(p, { updatedafter: sinceMs, includedeleted: 'only' });
  return { provider: p.id, obs: r.obs, status: r.status };
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
