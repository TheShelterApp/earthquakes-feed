// Types for scripts/health-liveness.mjs (dependency-free JavaScript, so health-liveness.yml runs it without `npm ci`).
// Only the tests import it from TypeScript.
import type { FetchImpl } from './reconcile.mjs';

export { BOT_LOGIN, outageMarker, outageSaid } from './reconcile.mjs';

export const RUNS_PER_PAGE: number;
export const LIVENESS_KEY: string;
export const MENTION_HOLD_MS: number;
export const LIVENESS_RED_EVERY_MS: number;
export const SELF_WORKFLOW: string;

export interface CompletedRun {
  id: number | null;
  /** updated_at: the run's completion. */
  ms: number;
  conclusion: string;
  url: string | null;
}
export function summarizeRuns(runs: unknown): { lastRun: CompletedRun | null; newestCreatedMs: number | null; newestPendingCreatedMs: number | null };

export interface Decision {
  state: 'ok' | 'stale' | 'dead';
  ageMs: number;
  dispatch: boolean;
  /** Dead, but the mention waits for a health run that may still reconcile. */
  hold: boolean;
  heal: string | null;
  reason: string;
}
export function decide(opts: {
  nowMs: number;
  lastReconciledMs: number | null;
  newestCreatedMs?: number | null;
  newestPendingCreatedMs?: number | null;
  staleMs?: number;
  deadMs?: number;
  holdMs?: number;
}): Decision;

export function outageBody(opts: {
  mention: string | null;
  nowMs: number;
  lastReconciledMs: number | null;
  lastRun: CompletedRun | null;
  decision: Decision;
  dispatched: boolean;
  runUrl: string | null;
}): string;

export function run(opts: {
  env: Record<string, string | undefined>;
  nowMs?: number;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  readFile?: (path: string) => string;
}): Promise<number>;
