// Types for scripts/lib/findings.mjs (dependency-free JavaScript, so the health workflow runs it without `npm ci`).
// The evaluators and scripts/reconcile.mjs import the JavaScript; the tests import these types from TypeScript.

export type Severity = 'P1' | 'P2' | 'P3' | 'P4';
export type Board = 'alerts' | 'feed' | 'platform';
export type FindingClass = 'symptom' | 'redundancy' | 'external' | 'capacity' | 'expiry' | 'config' | 'maintenance' | 'watcher' | 'unknown';
export type Evaluator = 'alerts' | 'feed' | 'platform';
export type VerdictCheck = 'gh-detect' | 'gh-deliver' | 'gh-redundancy' | 'gh-feed' | 'gh-platform' | 'gh-capacity';
export type CheckSlug = 'health-watchdog' | VerdictCheck | 'gh-aging' | 'selftest';

export type RuleId =
  | 'alerts:status:stale'
  | 'alerts:status:unreadable'
  | 'alerts:coverage:all'
  | 'alerts:coverage:two'
  | 'alerts:provider:fast'
  | 'alerts:provider:fast:invalid'
  | 'alerts:provider:usgs'
  | 'alerts:usgs:primary'
  | 'alerts:usgs:deletions'
  | 'alerts:provider:feed'
  | 'alerts:provider:unlisted'
  | 'alerts:provider-silent'
  | 'alerts:latency'
  | 'alerts:budget'
  | 'alerts:degraded'
  | 'alerts:policy'
  | 'alerts:apns'
  | 'alerts:canary'
  | 'alerts:dispatch'
  | 'alerts:fanout'
  | 'alerts:selftest'
  | 'feed:freshness'
  | 'feed:freshness:unreachable'
  | 'feed:systemic'
  | 'feed:status'
  | 'feed:source'
  | 'feed:source:core'
  | 'feed:source:definite'
  | 'feed:source:quiet'
  | 'feed:cert'
  | 'feed:size'
  | 'feed:repo-size'
  | 'walks'
  | 'platform:api'
  | 'platform:api:envelope'
  | 'platform:config-worker'
  | 'config:bundle:age'
  | 'config:bundle:gap'
  | 'platform:cf-usage'
  | 'watcher';

/**
 * One judged condition. An evaluator emits it as of one moment, with no memory of earlier runs; reconcile applies the
 * holds of its rule. A condition below its line is emitted as a P4 sample: it never opens a board entry by itself, but
 * it keeps an open entry open and counts toward a ratio rule.
 */
export interface Finding {
  /** Stable id of the board row: the rule's `key`, or `<keyPrefix><member>` (alerts:provider:gfz, feed:source:tmd). */
  key: string;
  /** The RULES entry that judged it (several rules can judge one key, e.g. config:bundle by age or by the version gap). */
  rule: RuleId;
  /** The board issue the row belongs to (always the rule's). */
  board: Board;
  /** The severity judged now, before reconcile's holds (P4: a sample below the line). */
  severity: Severity;
  /** What kind of thing it is about (always the rule's); external, maintenance and watcher are never red. */
  class: FindingClass;
  /** When the condition started, by the evaluator's best evidence (failingSinceMs, lastSuccessAt, a generated time);
   *  null when unknown: reconcile then counts the episode from the first run that saw it, and holds a finding at its
   *  rule's severity for the rule's `limits.lineMs` from there. */
  sinceMs: number | null;
  /** One line, safe for a public issue: what is wrong, how long, and what it means. */
  text: string;
  /** The verdict check a P1/P2 pings; null for none (a P3's escalation goes to gh-aging). */
  check: CheckSlug | null;
  /** Shadow rule (always the rule's): logged as "would notify", never a comment, a ping or a red run. */
  shadow: boolean;
  /** Sub-items: the failing providers of a coverage finding (muted while it is open), the reasons of a feed source
   *  (fetch, silent, frozen), the files over a size line, ... */
  members?: string[];
}

export interface Ratio {
  min: number;
  of: number;
  severity: Severity;
}

export interface Rule {
  id: RuleId;
  /** A short name for the board row. */
  title: string;
  board: Board;
  class: FindingClass;
  /** The severity the rule notifies at. */
  severity: Severity;
  /** The single key it judges, or null when it judges `<keyPrefix><member>` keys. */
  key: string | null;
  keyPrefix: string | null;
  /** The verdict check a P1/P2 finding pings: one slug, or one per severity. */
  check: CheckSlug | Partial<Record<Severity, CheckSlug>> | null;
  /** 1: evaluated from Phase 1a; 2: needs a gateway field not published yet. */
  phase: 1 | 2;
  shadow: boolean;
  /** Consecutive runs with the finding before it takes its severity (P4 until then); the confirming run at least 10 min
   *  after the first sighting. */
  confirmRuns: number;
  /** Continuous presence (reconcile's run times) before it takes its severity (P4 until then). */
  holdMs: number;
  /** Also enters, at ratio.severity, when present (any severity) in at least `min` of the last `of` samples (a run
   *  less than 10 min after the previous sample shares its slot). */
  ratio: Readonly<Ratio> | null;
  /** Consecutive runs without the finding that resolve an open entry. */
  resolveRuns: number;
  /** The same, for an entry that entered by ratio. */
  resolveRunsAfterRatio: number;
  /** And absent for at least this long. */
  resolveAfterMs: number;
  /** An entry open this long (from its episode's start) escalates once, on a run its finding is present: one comment
   *  and gh-aging. */
  escalateAfterMs: number | null;
  /** An entry open continuously for `afterMs` takes severity `to` while its finding holds. */
  promote: Readonly<{ afterMs: number; to: Severity }> | null;
  /** The evaluator's own thresholds. */
  limits: Readonly<Record<string, unknown>>;
}

export interface FindingsDocument {
  schema: 'health-findings/1';
  evaluator: Evaluator;
  /** When the evaluator judged (ms); reconcile ignores a document not newer than the last one it applied. */
  generatedAtMs: number;
  findings: Finding[];
  /** Key patterns (exact, or a prefix ending in `*`) not judged this run: frozen, never resolved by absence. */
  unjudged: string[];
  /** Log lines for the step summary (P4 detail that is not a finding). */
  notes: string[];
}

export interface Inhibition {
  /** The inhibiting key or key pattern. */
  when: string;
  /** Muted key patterns. */
  mute?: ReadonlyArray<string>;
  /** Mutes `<muteMembers><member>` for each member of the inhibiting finding. */
  muteMembers?: string;
}

export const SEVERITIES: ReadonlyArray<Severity>;
export const BOARDS: Readonly<Record<Board, string>>;
export const BOARD_LABEL: string;
export const CLASSES: ReadonlyArray<FindingClass>;
export const NEVER_RED_CLASSES: ReadonlyArray<FindingClass>;
export const EVALUATORS: ReadonlyArray<Evaluator>;
export const VERDICT_CHECKS: ReadonlyArray<VerdictCheck>;
export const AGING_CHECK: 'gh-aging';
export const LIVENESS_CHECK: 'health-watchdog';
export const SELFTEST_CHECK: 'selftest';
export const CHECKS: ReadonlyArray<CheckSlug>;
export const HC_PING_BASE: string;
export const PUSH_PRIORITY: Readonly<{ P1: number; P2: number }>;
export const P2_RED_MS: number;
export const HEALTH_FALLBACK_CRON: string;
export const SCHEDULE_SKIP_MS: number;
export const AGENCY_PAIRS: Readonly<Record<string, string>>;
export const INHIBITIONS: ReadonlyArray<Readonly<Inhibition>>;
export const FINDINGS_SCHEMA: 'health-findings/1';
export const STATE_MARKER: string;
export const MAX_KEY_CHARS: number;
export const MAX_TEXT_CHARS: number;
export const RULES: Readonly<Record<RuleId, Readonly<Rule>>>;

export function severityRank(s: unknown): number;
export function moreSevere(a: unknown, b: unknown): boolean;
export function worstSeverity(...list: Array<Severity | null | undefined>): Severity;
export function mayTurnRed(cls: FindingClass): boolean;
export function matchesKey(pattern: string, key: string): boolean;
export function checkFor(rule: Readonly<Rule> | null | undefined, severity: Severity): CheckSlug | null;
export function ruleOf(finding: { rule?: unknown } | null | undefined): Readonly<Rule> | null;
export function ruleJudgesKey(rule: Readonly<Rule> | null | undefined, key: string): boolean;
export function ageText(ms: number | null | undefined): string;
export function utcText(ms: number | null | undefined): string;
export function oneLine(x: unknown, max?: number): string;
export function makeFinding(
  ruleId: RuleId,
  fields: {
    id?: string;
    key?: string;
    severity?: Severity;
    sinceMs?: number | null;
    text: string;
    members?: Iterable<string>;
    check?: CheckSlug | null;
  },
): Finding;
export function validateFinding(f: unknown): string[];
export function findingsDocument(opts: {
  evaluator: Evaluator;
  generatedAtMs: number;
  findings: Iterable<Finding>;
  unjudged?: Iterable<string>;
  notes?: string[];
}): FindingsDocument;
export function parseFindingsDocument(value: unknown): { ok: true; doc: FindingsDocument } | { ok: false; error: string };
