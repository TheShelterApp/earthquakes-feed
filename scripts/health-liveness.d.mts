// Types for scripts/health-liveness.mjs (dependency-free JavaScript, so health-liveness.yml runs it without `npm ci`).
// Only the tests import it from TypeScript.
import type { FetchImpl } from './reconcile.mjs';

export const JUDGED: ReadonlyArray<string>;
export const RUNS_PER_PAGE: number;
export const BOT_LOGIN: string;

export function outageMarker(outage: number | string): string;

export interface CompletedRun {
  id: number | null;
  /** updated_at: the run's completion. */
  ms: number;
  conclusion: string;
  url: string | null;
}
export function summarizeRuns(runs: unknown): { lastCompleted: CompletedRun | null; newestCreatedMs: number | null };

export interface Decision {
  state: 'ok' | 'stale' | 'dead';
  ageMs: number;
  dispatch: boolean;
  heal: string | null;
  reason: string;
}
export function decide(opts: { nowMs: number; lastCompletedMs: number | null; newestCreatedMs: number | null; staleMs?: number; deadMs?: number }): Decision;

export function outageSaid(comments: unknown, outage: number | string): boolean;

export function outageBody(opts: { mention: string | null; nowMs: number; lastCompleted: CompletedRun | null; decision: Decision; dispatched: boolean; runUrl: string | null }): string;

export function run(opts: {
  env: Record<string, string | undefined>;
  nowMs?: number;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  readFile?: (path: string) => string;
}): Promise<number>;
