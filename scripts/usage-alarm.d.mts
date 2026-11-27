// Types for scripts/usage-alarm.mjs (dependency-free JavaScript run by usage-alarm.yml). Only the tests import it.
export const GRAPHQL_URL: string;
export const R2_CLASS_A_LIMIT: number;
export const R2_CLASS_B_LIMIT: number;
export const WORKERS_DAILY_LIMIT: number;
export const D1_ROWS_WRITTEN_DAILY_LIMIT: number;
export const CLASS_B_SHARE_LINE: number;
export const CLASS_B_PROJECTION_LINE: number;
export const CLASS_A_SHARE_LINE: number;
export const WORKERS_REQUESTS_LINE: number;
export const D1_ROWS_WRITTEN_LINE: number;
export const MIN_PROJECTION_DAYS: number;
export const CLASS_A_ACTIONS: ReadonlyArray<string>;
export const CLASS_B_ACTIONS: ReadonlyArray<string>;
export const DATASETS: Readonly<{ r2: string; workers: string; d1: string }>;
export const ACTION_ORDER: ReadonlyArray<string>;

export function periods(nowMs: number): { monthStart: number; nextMonth: number; todayStart: number; yesterdayStart: number };
export function buildRequests(accountTag: string, nowMs: number): Record<'r2' | 'workers' | 'd1', { query: string; variables: Record<string, string> }>;
export function datasetRows(body: unknown, dataset: string): { rows?: unknown[]; unavailable?: string };
export function r2Classes(rows: unknown[]): { a: number; b: number } | null;
export function evaluate(
  answers: { r2?: unknown; workers?: unknown; d1?: unknown },
  nowMs: number,
): { lines: string[]; failures: string[]; unavailable: string[]; exitCode: 0 | 1 | 3 };
export function parseArgs(argv: string[]): { file: string | null; now: string | null };
export function main(opts?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: (url: string, init: unknown) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now?: () => number;
  log?: (line: string) => void;
  summaryPath?: string;
}): Promise<number>;
