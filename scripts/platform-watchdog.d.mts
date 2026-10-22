// Types for scripts/platform-watchdog.mjs (dependency-free JavaScript run by the health workflow without `npm ci`).
// Only the tests import it from TypeScript.
import type { FetchImpl, FetchResult } from './alerts-watchdog.mjs';

export const API_HEALTH_URL: string;
export const CONFIG_HEALTH_URL: string;

export interface Verdict {
  problems: string[];
  warnings: string[];
  summary: string;
}
export function evaluateApiHealth(r: FetchResult): Verdict;
export function evaluateConfigHealth(r: FetchResult): Verdict;
export function parseArgs(argv: string[]): { apiUrl: string; configUrl: string };
export function main(opts?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchImpl;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<number>;
