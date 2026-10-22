// Types for scripts/reconcile.mjs (dependency-free JavaScript, so the health workflow runs it without `npm ci`). Only
// the tests import it from TypeScript.
import type { Board, CheckSlug, Evaluator, FindingClass, RuleId, Severity } from './lib/findings.mjs';

export const SELFTEST_CRON: string;
export const MAX_BODY_CHARS: number;
export const SAMPLE_WINDOW: number;
export const SAMPLE_SLOT_MS: number;
export const SELFTEST_OVERDUE_MS: number;
export const PIN_CHECK_MS: number;
export const MAX_FAULTS: number;
export const LOG_KEEP_MS: number;
export const LOG_MAX_EVENTS: number;
export const DAYS_KEPT: number;
export const STATE_TEXT_CHARS: number;
export const STATE_TEXT_SHORT_CHARS: number;
export const STATE_TEXT_MIN_CHARS: number;
export const LOG_ROWS_SHOWN: number;
export const MAX_SILENCES: number;
export const PING_REASON_CHARS: number;
export const PING_TIMEOUT_MS: number;
export const SEVERITY_LABELS: Readonly<{ P1: string; P2: string; P3: string; ok: string }>;
export const LABEL_DEFS: ReadonlyArray<Readonly<{ name: string; color: string; description: string }>>;

/** One board row: the latest finding of its key plus reconcile's memory of the episode. */
export interface Entry {
  key: string;
  /** The rule of the latest finding (several rules can judge one key). */
  rule: RuleId;
  board: Board;
  class: FindingClass;
  /** The verdict check this entry pings at its current severity (null below P2, or for a rule without one). */
  check: CheckSlug | null;
  shadow: boolean;
  /** The evaluator that produced the latest finding; null for findings reconcile makes itself (watcher:evaluator:*). */
  evaluator: Evaluator | null;
  /** At most 300 characters (160, then 60 when a body had to shrink). */
  text: string;
  members: string[];
  sinceMs: number | null;
  /** The severity the evaluator judged on the last run the key was present (null when absent). */
  found: Severity | null;
  open: boolean;
  /** While open: the entry's severity (a P4 sample keeps it, though not red; a P1-P3 finding sets it). */
  severity: Severity;
  openedMs: number | null;
  /** The episode's start, the escalation counts from it: by line, the finding's sinceMs (the first run that saw it when
   *  that is null); by ratio, the earlier of that and the oldest failing sample in the window. */
  episodeSinceMs: number | null;
  enteredBy: 'line' | 'ratio' | null;
  /** "confirming 1/2" or "holding 3.5 h of 24.0 h" while a present P1-P3 finding waits for its rule. */
  pending: string | null;
  seenRuns: number;
  /** Absent runs in a row, each in a sample slot of its own (a run within 10 min of the previous sample adds none). */
  absentRuns: number;
  firstSeenMs: number | null;
  lastSeenMs: number | null;
  /** '1' present, '0' absent, newest last, at most 8; a run less than 10 min after the newest slot shares it. Cleared
   *  when the entry resolves. */
  samples: string;
  /** The time of each sample slot (same length as `samples`). */
  sampleMs: number[];
  /** The time of the oldest '1' in the window. */
  firstSampleMs: number | null;
  /** The severity last announced (by a comment, or by the red run for P1/P2); null: not yet. */
  notified: Severity | null;
  escalated: boolean;
  escalationNotified: boolean;
  /** Its last comment could not be posted: the next run posts it again, present or not. */
  retryComment: boolean;
  /** When the entry first was P1/P2 in this episode: a P2 is red for P2_RED_MS from here. */
  redSinceMs: number | null;
  /** The silence that matched first in this episode and the severity it silenced (a rise above it lifts it). */
  silence: { spec: string; severity: Severity } | null;
  /** This run's mute (shadow entries are muted by `shadow` and carry null here). */
  muted: { by: 'inhibited' | 'silenced'; note: string } | null;
  /** Set when the key was not judged this run (its evaluator missing or stale, its input unreadable, the alerts freeze). */
  frozen: string | null;
}

export type LogEventKind = 'open' | 'escalate' | 'resolve' | 'would-resolve' | 'would-notify' | 'notify';

export interface LogEvent {
  ms: number;
  key: string;
  event: LogEventKind;
  severity: Severity | null;
}

export interface DayCounts {
  red: number;
  comments: number;
  /** Checks that went from success to /fail: the pushes that would have gone out. */
  transitions: number;
  /** Shadow entries that would have notified. */
  would: number;
}

/** The state of one board, stored in the marker `<!-- health-state v1 {json} -->` at the end of its body. */
export interface Fault {
  ms: number;
  text: string;
}

export interface BoardState {
  v: 1;
  board: Board;
  /** When reconcile first wrote this board's state. */
  createdMs: number | null;
  updatedMs: number | null;
  runId: string | null;
  runUrl: string | null;
  /** Whether the run that wrote it sent its pings (HC_PING_KEY set). */
  pings: 'sent' | 'skipped';
  /** Copied to all three boards: the generatedAtMs of the last document applied per evaluator. */
  evaluators: Partial<Record<Evaluator, number>>;
  /** Copied to all three boards: the last signal per check. */
  checks: Partial<Record<CheckSlug, 'success' | 'fail'>>;
  /** Copied to all three boards: the last run that reconciled the selftest's forced P1. */
  lastSelftestMs: number | null;
  /** Copied to all three boards: the last daily pin and lock check. */
  pinsCheckedMs: number | null;
  /** On the watcher's board: the comments this run could not post (the next run reports them as watcher:reconcile). */
  faults: Fault[];
  entries: Record<string, Entry>;
  log: LogEvent[];
  /** 'YYYY-MM-DD' (UTC), the last 7 days. */
  days: Record<string, DayCounts>;
}

export interface Silence {
  /** Exact key, or a prefix ending in `*`. */
  pattern: string;
  untilMs: number;
  reason: string;
  /** The entry as written in HEALTH_SILENCES. */
  spec: string;
}

export interface ReconcileContext {
  runId?: string | number | null;
  runUrl?: string | null;
  eventName?: string | null;
  /** Why an evaluator has no document (an unparseable file, no artifact). */
  missing?: Partial<Record<Evaluator, string>>;
  /** The boards that exist as issues (default: those with a previous state). */
  existing?: Board[];
  /** HC_PING_KEY is set (only shown on the boards and in the summary). */
  pingsEnabled?: boolean;
  /** parseSilences errors, warned about in the summary and as annotations. */
  silenceErrors?: string[];
}

export interface Ping {
  check: CheckSlug;
  signal: 'success' | 'fail';
  reason: string;
}

export interface EvaluatorStatus {
  state: 'fresh' | 'stale' | 'missing';
  generatedAtMs: number | null;
  reason: string | null;
}

export interface ReconcileResult {
  state: Record<Board, BoardState | null>;
  /** The full issue body per board; null when the board neither exists nor needs to. */
  bodies: Record<Board, string | null>;
  /** Boards that do not exist and now need to. */
  create: Board[];
  /** At most one per board per run, one item per key; `keys` with what they had before this run, for a rollback. */
  comments: BoardComment[];
  labels: Record<Board, string[]>;
  /** Computed on every run; the wrapper skips them without HC_PING_KEY. */
  pings: Ping[];
  exitCode: 0 | 1;
  summary: string;
  annotations: string[];
  evaluators: Record<Evaluator, EvaluatorStatus>;
  /** Every document was already applied: nothing changed. */
  replay: boolean;
  /** The daily pin and lock check is due (the wrapper runs it on the boards that already existed). */
  pinCheck: boolean;
  /** The comments the last run could not post: when this run's fail too, the wrapper exits 3. */
  commentFaultsBefore: number;
}

export interface BoardComment {
  board: Board;
  body: string;
  keys: Array<{ key: string; notified: Severity | null; escalationNotified: boolean }>;
}

export function reconcile(
  prevState: Partial<Record<Board, BoardState | null>> | null,
  findings: unknown[],
  nowMs: number,
  silences?: Silence[],
  context?: ReconcileContext,
): ReconcileResult;

export function renderBody(board: Board, state: BoardState, view?: { logRows?: number; tableRows?: number }): string;
export function parseBoardState(body: unknown, board?: Board): BoardState | null;
export function parseSilences(text: string | null | undefined, nowMs: number): { silences: Silence[]; errors: string[] };
export function withFailedComments(
  result: ReconcileResult,
  failed: Array<{ comment: BoardComment; message: string }>,
): { state: Record<Board, BoardState | null>; bodies: Record<Board, string | null> };
export function scheduleGate(opts: {
  eventName: string | null | undefined;
  schedule: string | null | undefined;
  selftestInput: string | boolean | null | undefined;
  /** The dispatched health runs as the Actions API lists them; null when the list could not be read. */
  dispatchedRuns: Array<{ created_at?: unknown; status?: unknown; conclusion?: unknown }> | null;
  nowMs: number;
}): { run: boolean; selftest: boolean; reason: string };
export function pingUrl(key: string, check: CheckSlug, signal: 'success' | 'fail'): string;
export function markdownText(x: unknown): string;
export function annotation(level: 'error' | 'warning' | 'notice', title: string | null, message: string): string;
export function parseArgs(argv: string[]): { gate: boolean; findingsDir: string | null; dryRun: boolean };

export type FetchImpl = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export function main(opts?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchImpl;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  readFile?: (path: string) => string;
  readDir?: (path: string) => string[];
  appendFile?: (path: string, text: string) => void;
}): Promise<number>;
