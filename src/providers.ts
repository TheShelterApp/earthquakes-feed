import { readFileSync } from 'node:fs';
import { FETCH_LIMIT, FETCH_TIMEOUT_MS, QUERY_LOOKBACK_MS, REGISTRY_PATH } from './config.js';
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

function buildUrl(p: ProviderConfig, nowMs: number): string {
  const params = new URLSearchParams({ format: p.queryFormat });
  if (!p.noLimit) params.set('limit', String(FETCH_LIMIT));
  if (p.supportsTimeRange) params.set('starttime', fdsnTime(nowMs - QUERY_LOOKBACK_MS));
  for (const [k, v] of Object.entries(p.params ?? {})) params.set(k, v);
  return `${p.base}?${params.toString()}`;
}

export interface FetchOutcome {
  provider: string;
  obs: RawObs[];
  status: ProviderStatus;
}

/** Fail-open: any error yields zero observations and a `degraded` status, never a throw. */
export async function fetchProvider(p: ProviderConfig, nowMs: number): Promise<FetchOutcome> {
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
  const url = buildUrl(p, nowMs);
  try {
    const res = await fetchText(url, FETCH_TIMEOUT_MS);
    // FDSN "no data" is 204/404 — a successful empty result, not a failure.
    if (res.status === 204 || res.status === 404) {
      return { provider: p.id, obs: [], status: { ok: true, http_status: res.status, latency_ms: res.latencyMs, events_returned: 0 } };
    }
    if (res.status >= 400) {
      return { provider: p.id, obs: [], status: { ok: false, http_status: res.status, latency_ms: res.latencyMs, error: `HTTP ${res.status}` } };
    }
    const obs = p.parse === 'geojson' ? parseGeoJSON(res.body, p.id) : parseFdsnText(res.body, p.id);
    return { provider: p.id, obs, status: { ok: true, http_status: res.status, latency_ms: res.latencyMs, events_returned: obs.length } };
  } catch (err) {
    return { provider: p.id, obs: [], status: { ok: false, error: err instanceof Error ? err.message : String(err) } };
  }
}
