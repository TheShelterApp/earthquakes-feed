// Types for scripts/platform-watchdog.mjs (dependency-free JavaScript run by the health workflow without `npm ci`).
// Only the tests import it from TypeScript.
import type { FetchImpl, FetchResult } from './alerts-watchdog.mjs';
import type { Finding } from './lib/findings.mjs';

export const API_HEALTH_URL: string;
export const CONFIG_HEALTH_URL: string;
/** The API's tries (RULES['platform:api'].limits): 3, spread evenly over 60 s. */
export const API_RETRY: Readonly<{ attempts: number; backoffMs: ReadonlyArray<number> }>;
/** Every key this evaluator judges (unjudged, all of them, when a bad argument stops it). */
export const PLATFORM_KEYS: ReadonlyArray<string>;

/** platform:api (P2) and platform:api:envelope (P3); `unjudged` names the envelope key while the API cannot be read. */
export function evaluateApiHealth(r: FetchResult): { findings: Finding[]; unjudged: string[]; summary: string };
/** platform:config-worker (P3); `version` is the bundle version the host serves, null when down or unsaid. */
export function evaluateConfigHealth(r: FetchResult): { findings: Finding[]; summary: string; version: number | null };
/** config:bundle by age (config:bundle:age, P3/P2/P1) or by the copy's version gap behind the host (config:bundle:gap, P3). */
export function evaluateConfigBundle(input: { status: FetchResult; hostVersion: number | null; nowMs: number }): {
  findings: Finding[];
  unjudged: string[];
  notes: string[];
  summary: string;
};
/** 1 when platform:api or platform:config-worker is present, else 3 for a watcher:* finding, else 0. */
export function plainExitCode(findings: ReadonlyArray<Pick<Finding, 'key'>>): 0 | 1 | 3;

export interface Options {
  apiUrl: string;
  configUrl: string;
  statusUrl: string;
  /** --findings <path>: write a findings document there and exit 0; null for plain mode. */
  findingsPath: string | null;
}
export function parseArgs(argv: string[]): Options;
export function main(opts?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchImpl;
  now?: () => number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  writeFile?: (path: string, data: string) => void;
}): Promise<number>;
