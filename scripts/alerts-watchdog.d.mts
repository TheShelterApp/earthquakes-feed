// Types for scripts/alerts-watchdog.mjs (kept dependency-free JavaScript so the health workflow can run it
// without `npm ci`). Only the tests import it from TypeScript.

export interface Thresholds {
  maxAgeSec: number;
  providerFailures: number;
  minHeadroomPct: number;
  usageFailPct: number;
  maxFeedManifestAgeSec: number;
  maxConfigBundleAgeSec: number;
  /** a provider's deletions query failing this many times in a row warns (never fails). */
  deletionsFailures: number;
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
/** The failing deletions query of a provider entry (round-16 gateways); null when it carries no positive streak. */
export function deletionsFailure(provider: unknown): { failures: number; why: string } | null;

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
