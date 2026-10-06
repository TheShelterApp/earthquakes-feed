/**
 * SD-E3 status contract. The aggregate writes a rich status.json already; this brings it to the
 * Spec-2 shape ADDITIVELY — every existing field stays (current consumers, incl. the health
 * watchdog, keep working), and the v2 fields are added alongside: a ms-epoch `generatedAt`, the
 * freshness thresholds, a `degradedProviders` list, and per-provider `ok`/`lastSuccessAt`/
 * `lagSeconds`/`observations`/structured `error`. Pure over its inputs.
 */

/** The aggregate's status.json (the fields we read; extra fields pass through untouched). */
export interface AggregateStatus {
  generated: string;
  head_seq: number;
  degraded?: string[];
  /** FEED-3: the sources past their activity budget (src/activity.ts), by id; absent before 2026-10-04. */
  silent?: Record<string, unknown>;
  /** FEED-3, round 14: the sources whose newest listed origin stands still past window + budget, by id; absent before. */
  frozen?: Record<string, unknown>;
  providers: Record<string, RawProvider>;
  [key: string]: unknown;
}
export interface RawProvider {
  ok: boolean;
  http_status?: number;
  latency_ms?: number;
  events_returned?: number;
  error?: string;
  [key: string]: unknown;
}

export type ProviderHealth = Record<string, number>; // provider -> lastSuccess ms

/** After a run, every OK provider's last-success time is "now"; a failing one keeps its old time. */
export function updateProviderHealth(prev: ProviderHealth, providers: Record<string, RawProvider>, generatedMs: number): ProviderHealth {
  const next: ProviderHealth = { ...prev };
  for (const [id, p] of Object.entries(providers)) if (p.ok) next[id] = generatedMs;
  return next;
}

export interface StatusV2Options {
  generatedMs: number;
  expectedIntervalSeconds: number;
  staleAfterSeconds: number;
  health: ProviderHealth;
  /** knowledge/index/provider_activity.json: per source, the last run whose answer had rows (ms epoch). */
  lastNonEmpty?: Record<string, number | null>;
  runId?: string;
  scheduler?: 'github-actions' | 'cf-cron' | 'container';
}

export function enrichStatusV2(raw: AggregateStatus, opts: StatusV2Options): Record<string, unknown> {
  const degradedProviders = raw.degraded ?? Object.entries(raw.providers).filter(([, p]) => !p.ok).map(([id]) => id);
  const silent = raw.silent ?? {};
  const frozen = raw.frozen ?? {};
  const providers: Record<string, unknown> = {};
  for (const [id, p] of Object.entries(raw.providers)) {
    const lastSuccess = opts.health[id];
    providers[id] = {
      ...p, // keep http_status / latency_ms / events_returned / error string
      ok: p.ok,
      observations: p.events_returned ?? 0,
      lastSuccessAt: lastSuccess ?? null,
      // FEED-3: `ok` says the fetch worked; `silent` says it has brought no rows for longer than the source's budget.
      ...(opts.lastNonEmpty ? { lastNonEmptyAt: opts.lastNonEmpty[id] ?? null } : {}),
      silent: id in silent,
      // Round 14: rows, but the newest origin they list stands still past the source's window plus budget.
      frozen: id in frozen,
      lagSeconds: lastSuccess != null ? Math.max(0, Math.round((opts.generatedMs - lastSuccess) / 1000)) : null,
      error: p.ok ? null : { kind: classifyError(p), message: p.error ?? 'provider failed', since: lastSuccess ?? opts.generatedMs },
    };
  }
  return {
    ...raw, // generated (ISO), head_seq, events_indexed, degraded (array), … all preserved
    generatedAt: opts.generatedMs,
    ...(opts.runId ? { runId: opts.runId } : {}),
    scheduler: opts.scheduler ?? 'github-actions',
    expectedIntervalSeconds: opts.expectedIntervalSeconds,
    staleAfterSeconds: opts.staleAfterSeconds,
    degradedProviders,
    silentProviders: Object.keys(silent),
    frozenProviders: Object.keys(frozen),
    providers,
  };
}

function classifyError(p: RawProvider): 'http' | 'schema' | 'timeout' | 'error' {
  const s = String(p.error ?? '').toLowerCase();
  if (p.http_status && p.http_status >= 400) return 'http';
  if (s.includes('timeout') || s.includes('timed out')) return 'timeout';
  if (s.includes('schema') || s.includes('parse') || s.includes('missing')) return 'schema';
  return 'error';
}
