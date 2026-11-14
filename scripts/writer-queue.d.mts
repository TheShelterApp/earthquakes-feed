// Types for scripts/writer-queue.mjs (dependency-free JavaScript, so the gate jobs and the health workflow run it
// without `npm ci`). The tests and scripts/feed-health.mjs import it.

export const WRITER_GROUP: 'earthquakes-feed-writer';
export const MAX_QUEUED: number;
export const GATE_JOB: 'gate';
export interface WriterDef {
  /** The job that takes the writer group (job-level concurrency). */
  lockJob: string;
  /** Whether a `gate` job guards it (every writer but aggregate). */
  gated: boolean;
}
export const WRITERS: Readonly<Record<'aggregate.yml' | 'backfill.yml' | 'archive.yml' | 'derive.yml', Readonly<WriterDef>>>;
export const STALE_RUN_MS: number;
export const OPEN_RUN_STATUSES: readonly string[];

/** A run as GET /repos/{repo}/actions/runs lists it (the fields used). */
export interface RunJson {
  id: number;
  path?: string;
  status?: string | null;
  event?: string;
  created_at?: string;
}
/** A job as GET /repos/{repo}/actions/runs/{id}/jobs lists it (the fields used). */
export interface JobJson {
  name: string;
  status?: string | null;
  conclusion?: string | null;
}
export type RunState = 'holding' | 'waiting' | 'approaching' | 'refused' | 'done' | 'stale';
export interface QueueEntry {
  id: number;
  workflow: string;
  event: string | null;
  created: string | null;
  state: Exclude<RunState, 'done'>;
}

export function workflowOf(run: Partial<RunJson> | null | undefined): string | null;
export function classifyRun(run: RunJson, jobs: readonly JobJson[] | null | undefined, nowMs: number): RunState | null;
export function isQueued(state: string): boolean;
export function queueOf(entries: ReadonlyArray<{ run: RunJson; jobs: readonly JobJson[] }>, nowMs: number): QueueEntry[];
export function describe(queue: readonly QueueEntry[]): string;
export interface GateDecision {
  admit: boolean;
  level: 'notice' | 'warning' | 'error';
  ahead: QueueEntry[];
  message: string;
}
export function decideGate(opts: { queue: readonly QueueEntry[]; selfId: number; force?: boolean; retried?: boolean; workflow: string; maxQueued?: number }): GateDecision;

export type FetchImpl = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<Response>;
export function readQueue(opts: { repo: string; token: string; nowMs?: number; fetchImpl?: FetchImpl; sleep?: (ms: number) => Promise<void> }): Promise<QueueEntry[]>;
export function run(opts?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  nowMs?: number;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  appendOutput?: (file: string, text: string) => void;
}): Promise<number>;
