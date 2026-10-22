// Types for scripts/alerts-watchdog.mjs (kept dependency-free JavaScript so the health workflow can run it
// without `npm ci`). Only the tests import it from TypeScript.

import type { Finding } from './lib/findings.mjs';

export const STATUS_URL: string;
export const GRAPHQL_URL: string;
/** The canary's source: RULES['alerts:canary'].limits.url (USGS's 4.5_hour summary). */
export const CANARY_URL: string;
export const USAGE_QUERY: string;

/** What the evaluator judged: findings, key patterns it could not judge this run, log notes and a one-line summary. */
export interface Verdict {
  findings: Finding[];
  /** Key patterns (exact, or a prefix ending in `*`) reconcile freezes instead of resolving by absence. */
  unjudged: string[];
  notes: string[];
  summary: string;
}

/**
 * Judge a parsed status.json as findings: the document gate (unreadable, stale, fresh), then every rule of the plan's
 * section 3a as of the document's generatedAtMs. `canary` is the parsed USGS 4.5_hour summary (null: not read, and
 * alerts:canary is unjudged); `selftest` adds alerts:selftest (P1).
 */
export function evaluateStatus(doc: unknown, opts: { nowMs: number; canary?: unknown; selftest?: boolean }): Verdict;
/** alerts:status:unreadable at P2 with this text (sinceMs null). */
export function unreadableFinding(message: string): Finding;
/** alerts:budget from the gateway's daily counters projected to the end of the UTC day (from 02:00 UTC); null when
 *  below 0.65, on another UTC day, or too early. */
export function budgetFinding(doc: unknown, refMs: number): Finding | null;
/** alerts:canary (shadow, P4) when USGS lists a 10-60 min old event newer than the gateway's newest detection. */
export function canaryFinding(doc: unknown, geojson: unknown, nowMs: number): Finding | null;
/** platform:cf-usage from a usage result (or watcher:cf-usage when it failed). */
export function usageFindings(r: UsageResult, nowMs: number): Verdict;
/** The usage half when CF_ANALYTICS_TOKEN is set but CF_ACCOUNT_ID is empty: watcher:cf-usage. */
export function usageMisconfigured(): Verdict;
/** Plain-mode exit code: 1 a non-shadow P1/P2 (other than unreadable) · 2 status.json unreadable · 3 a watcher:*
 *  finding · 0. */
export function plainExitCode(findings: ReadonlyArray<Finding>): 0 | 1 | 2 | 3;

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
/** The feed backstop's provider id ('feed'); never one of the direct providers of the coverage rules. */
export const BACKSTOP_PROVIDER: string;
/** How often the gateway polls a healthy provider (ms, whole ticks; 60 s for an unknown id). */
export function pollIntervalMs(id: string): number;
/** Whether the gateway polls the provider on every detector tick (EMSC, GFZ). */
export function isFastProvider(id: string): boolean;
/** About how long a streak of `failures` polls in a row has lasted (s), first failed poll to the latest. */
export function streakSpanSec(id: string, failures: number): number;
/** How long a failing provider entry has failed (s) as of `refMs`: from its failingSinceMs (round-25 gateways) when
 *  usable (`measured`), else estimated from consecutiveFailures; null when it carries neither. */
export function streakDuration(
  provider: unknown,
  refMs: number,
): { sec: number; measured: boolean; since?: number; failures: number | null } | null;
/** The failing deletions query of a provider entry (round-16 gateways); null when it carries no positive streak.
 *  `lasted` is " over N min" from deletionsFailingSinceMs (round 25) as of `refMs`, else ''. */
export function deletionsFailure(provider: unknown, refMs?: number): { failures: number; why: string; lasted: string } | null;
/** The failing primary live query of a provider entry (2026-10-13 gateways); null when it carries no positive streak.
 *  `fallback` is true while the provider is ok on its summary-feed fallback; `lasted` as for deletionsFailure. */
export function primaryFailure(provider: unknown, refMs?: number): { failures: number; why: string; fallback: boolean; lasted: string } | null;

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
/** `secrets` (the token, the account id) are redacted from the API's error messages before they are cut to length. */
export function parseUsageResponse(json: unknown, opts?: { secrets?: ReadonlyArray<string | undefined> }): UsageResult;
/** Every message of the result has the token and the account id redacted. */
export function fetchUsage(opts: {
  token: string;
  accountTag: string;
  nowMs: number;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}): Promise<UsageResult>;

/** `text` with each non-empty secret (any letter case) replaced by ***. */
export function redact(text: string, secrets: ReadonlyArray<string | undefined> | null | undefined): string;

export function annotation(level: 'error' | 'warning' | 'notice', title: string, message: string): string;

export interface Options {
  url: string;
  statusFile: string | null;
  selftest: boolean;
  /** --findings <path>: write the findings document there and exit 0. */
  findingsPath: string | null;
  /** The canary's URL (CANARY_URL by default); null with --no-canary. */
  canaryUrl: string | null;
  /** A saved USGS 4.5_hour summary to judge instead of fetching; null with --no-canary. */
  canaryFile: string | null;
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
  writeFile?: (path: string, text: string) => void;
}): Promise<number>;
