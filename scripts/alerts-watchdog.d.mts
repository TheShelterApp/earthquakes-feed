// Types for scripts/alerts-watchdog.mjs (kept dependency-free JavaScript so the health workflow can run it
// without `npm ci`). Only the tests import it from TypeScript.

export interface Thresholds {
  maxAgeSec: number;
  /** a 60 s provider's (USGS, the feed) failure streak that fails the run; a 15 s provider's (EMSC, GFZ) warning, and its
   *  red line while another direct provider is down too. */
  providerFailures: number;
  /** a 15 s provider's (EMSC, GFZ) failure streak that fails the run on its own. */
  fastProviderFailures: number;
  minHeadroomPct: number;
  usageFailPct: number;
  maxFeedManifestAgeSec: number;
  maxConfigBundleAgeSec: number;
  /** a provider's deletions query failing this many times in a row warns (never fails). */
  deletionsFailures: number;
  /** a provider's primary live query (USGS FDSN) failing this many times in a row warns while its fallback keeps it ok. */
  primaryFailures: number;
}

export const STATUS_URL: string;
export const GRAPHQL_URL: string;
export const DEFAULT_THRESHOLDS: Readonly<Thresholds>;
export const FREE_TIER_DAILY: Readonly<{ workersRequests: number; d1RowsWritten: number }>;
export const SELFTEST_MIN_HEADROOM_PCT: number;
export const USAGE_QUERY: string;

export interface StatusVerdict {
  problems: string[];
  warnings: string[];
  notes: string[];
  summary: string;
}
export function evaluateStatus(doc: unknown, opts: { nowMs: number; thresholds?: Partial<Thresholds> }): StatusVerdict;
/** The gateway's provider `lastError` codes and what they mean (round 14). */
export const PROVIDER_ERRORS: Readonly<Record<'timeout' | 'http' | 'network' | 'invalid', string>>;
/** ", last error …, N timeouts in a row" for a failing provider entry; '' when it carries neither field. */
export function failureReason(provider: unknown): string;
/** How far back the gateway's USGS deletions query reaches (7 days). */
export const DELETIONS_MAX_WINDOW_MS: number;
/** The gateway's detector tick (15 s), each provider's minIntervalMs and the failure backoff steps (platform repo,
 *  services/alerts-gateway). */
export const GATEWAY_TICK_MS: number;
export const PROVIDER_MIN_INTERVAL_MS: Readonly<Record<string, number>>;
export const PROVIDER_BACKOFF_STEPS: ReadonlyArray<Readonly<{ atFailures: number; intervalMs: number }>>;
/** The gateway's own upstream sources (usgs, emsc, gfz); the feed is the backstop. */
export const DIRECT_PROVIDERS: ReadonlyArray<string>;
/** How often the gateway polls a healthy provider (ms, whole ticks; 60 s for an unknown id). */
export function pollIntervalMs(id: string): number;
/** Whether the gateway polls the provider on every detector tick (EMSC, GFZ). */
export function isFastProvider(id: string): boolean;
/** About how long a streak of `failures` polls in a row has lasted (s), first failed poll to the latest. */
export function streakSpanSec(id: string, failures: number): number;
/** The warning and red streaks for a failing provider; `together` = another direct provider is down too. */
export function providerLimit(id: string, thresholds: Thresholds, together?: boolean): { warn: number; red: number };
/** The failing deletions query of a provider entry (round-16 gateways); null when it carries no positive streak. */
export function deletionsFailure(provider: unknown): { failures: number; why: string } | null;
/** The failing primary live query of a provider entry (2026-10-13 gateways); null when it carries no positive streak.
 *  `fallback` is true while the provider is ok on its summary-feed fallback. */
export function primaryFailure(provider: unknown): { failures: number; why: string; fallback: boolean } | null;

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
export type FetchResult =
  | { ok: true; status: number; json: unknown; attempts: number }
  | { ok: false; kind: 'network' | 'http' | 'parse'; status?: number; retryable: boolean; message: string; body?: string; attempts: number };
export function fetchJson(
  url: string,
  opts?: { init?: RequestInit; fetchImpl?: FetchImpl; attempts?: number; backoffMs?: number[]; timeoutMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<FetchResult>;

export interface UsageWindow {
  date: string;
  datetimeStart: string;
  datetimeEnd: string;
  dayFraction: number;
}
export function usageWindow(nowMs: number): UsageWindow;
export function buildUsageRequest(
  accountTag: string,
  nowMs: number,
): { query: string; variables: { accountTag: string; datetimeStart: string; datetimeEnd: string; date: string } };

export type UsageResult =
  | { ok: true; workersRequests: number; d1RowsWritten: number }
  | { ok: false; kind: 'auth' | 'graphql' | 'shape'; message: string };
export function parseUsageResponse(json: unknown): UsageResult;
export function evaluateUsage(
  usage: { workersRequests: number; d1RowsWritten: number },
  opts: { dayFraction: number; failPct?: number; caps?: { workersRequests: number; d1RowsWritten: number } },
): { problems: string[]; summary: string };
export function fetchUsage(opts: {
  token: string;
  accountTag: string;
  nowMs: number;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}): Promise<UsageResult>;

export function annotation(level: 'error' | 'warning' | 'notice', title: string, message: string): string;

export interface Options {
  url: string;
  statusFile: string | null;
  selftest: boolean;
  thresholds: Thresholds;
}
export function parseArgs(argv: string[], env?: Record<string, string | undefined>): Options;

export function main(opts?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchImpl;
  now?: () => number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => string;
}): Promise<number>;
