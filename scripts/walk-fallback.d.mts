// Types for scripts/walk-fallback.mjs (dependency-free JavaScript, so walk-fallback.yml runs it without `npm ci`). Only
// the tests import it from TypeScript.

export interface Walk {
  /** The cron of walk-fallback.yml that stands in for the walk (github.event.schedule). */
  cron: string;
  /** The UTC minute the heartbeat Worker dispatches the walk at (heartbeat/src/worker.js workflowFor). */
  heartbeatMinute: number;
  /** The inputs the Worker dispatches it with (heartbeat/src/worker.js inputsFor). */
  inputs: Readonly<Record<string, string>> | null;
}

export const WALKS: Readonly<Record<'history.yml' | 'first-solutions.yml', Readonly<Walk>>>;
export const MAX_DISPATCH_AGE_MS: number;

export function walkForSchedule(schedule: string | null | undefined): 'history.yml' | 'first-solutions.yml' | null;

export interface Verdict {
  dispatch: boolean;
  ageMin: number | null;
  reason: string;
}
export function decide(opts: { nowMs: number; newestDispatchMs: number | null; maxAgeMs?: number }): Verdict;

export function dispatchBody(workflow: string): { ref: 'main'; inputs?: Record<string, string> };

export type FetchImpl = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export function newestDispatchMs(opts: {
  repo: string;
  workflow: string;
  token: string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
}): Promise<number | null>;

export function run(opts: {
  env: Record<string, string | undefined>;
  nowMs?: number;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  annotate?: (line: string) => void;
}): Promise<number>;
