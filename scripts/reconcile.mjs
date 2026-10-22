#!/usr/bin/env node
// Health reconcile: the single writer of the three health boards and the only pinger (alerting plan of 2026-10-22,
// section 4 and Phase 1a item 5, with the owner's decisions of that day). Run by .github/workflows/health.yml:
//
//   node scripts/reconcile.mjs --gate                               # job `gate`: run= and selftest= to GITHUB_OUTPUT
//   node scripts/reconcile.mjs --findings-dir findings              # job `reconcile`: apply the evaluators' documents
//   node scripts/reconcile.mjs --findings-dir findings --dry-run    # read the boards, print, write nothing
//
// The evaluator jobs (scripts/alerts-watchdog.mjs, scripts/feed-health.mjs and scripts/platform-watchdog.mjs, each with
// --findings) are stateless: each writes one findings document (scripts/lib/findings.mjs). This script keeps the memory
// across runs in the three permanent board issues ("[health] alert pipeline", "[health] feed", "[health] platform";
// label health-board; pinned and locked), as a hidden `<!-- health-state v1 {json} -->` marker at the end of each body.
// It applies the reconcile parameters of the rule each finding names: the 2-run confirmation, the 24 h hold, 4 of the
// last 8 samples, resolving after N healthy runs, the time escalation, the promotion (status.json unreadable for 60 min
// becomes P1), the inhibitions, the HEALTH_SILENCES silences, the frozen keys of an input that could not be read, and
// the P2 red hour. Samples, confirmations and resolves go by time, not by the number of runs: a run less than 10 min
// after the previous sample shares its slot (and counts as no healthy run of its own), and a confirming run must come at
// least 10 min after the first sighting, so an extra dispatch adds nothing. A resolved entry starts its samples afresh.
//
// Notifications (owner decisions 2026-10-22): a board gets a comment only when a P3 enters or passes its rule's age line
// (the escalation), at most one item per key per run. A P1/P2 row is silent, and so is a rise into P1/P2 (config:bundle
// by age, the promotion): the boards are public and P1 goes to the owner only, through the red run. Red only on
// evidence: a P1 on every run its finding is present at P1/P2 or frozen, a P2 so during its first hour (then green with
// ::error::); an entry held open only by its resolve count, or by a P4 sample below its line, is not red. Members leaving
// and resolutions are silent body edits. A comment an inhibition held back goes out only on a run where the key's own
// finding is present (a child that cleared while its parent was open never comments); one a silence held back goes out
// when the silence ends. A single external source, a maintenance walk and the watcher itself never turn a run red.
// Shadow rules only log "would notify". The Healthchecks.io pings are computed on every run but skipped while the
// HC_PING_KEY secret is unset (no push channel for now). The last selftest is recorded on every board: 35 days without
// one opens watcher:selftest-overdue.
//
// Boards: the first run that finds none creates all three at once, the labels first (a one-time rollout notification to
// the repository's watchers), never because of a finding (a P4 sample, a pending one or a shadow rule cannot open an
// issue). Their numbers then go into scripts/health-boards.json and each board is read by its number: on 2026-10-22 the
// label listing missed fresh boards and two runs made second and third sets (readBoards). A numbered board that is gone
// makes the run red (exit 3) instead of a new board; one without a number is made only when both label listings
// answered without it. A duplicate is retired, and the board keeps the newest state of the two. A key's comment is posted before the body that records it: a comment GitHub refuses is rolled back and retried by the next
// run, and a body that is not saved after its comment went out makes a rare duplicate rather than a lost comment. A
// board locked against the bot's comment or body edit is unlocked around it and locked again. A body is shrunk to fit
// (log rows, texts, closed rows, then rendered rows; the state keeps every open row); one that still does not fit is
// neither written nor commented on. Once a day the pins and locks are checked again through GraphQL.
//
// Environment: GH_TOKEN (issues: write, actions: read), GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SERVER_URL,
// GITHUB_EVENT_NAME, HEALTH_SILENCES (repository variable), HC_PING_KEY (secret, optional), GITHUB_STEP_SUMMARY; with
// --gate also GITHUB_OUTPUT, EVENT, SCHEDULE and SELFTEST_INPUT.
// Exit codes: 0 green · 1 red (a P1, a P2 in its first hour, the selftest) · 3 alerting itself is broken: a bad
// argument, GH_TOKEN or GITHUB_REPOSITORY unset, the boards unreadable, a board body not created or saved (the memory
// of every rule is lost, or it does not fit), a board created this run that cannot be labelled, board comments that
// fail on two runs in a row, or a crash. A comment that fails once is an ::error::, retried by the next run, which
// reports it as watcher:reconcile; a failed ping, label edit of an existing board, lock or pin check is a ::warning::.
//
// Dependency-free (Node >= 22, global fetch): the health workflow runs it from a sparse checkout without `npm ci`, so it
// imports nothing but scripts/lib. Types: reconcile.d.mts. The pure core is exported for tests/reconcile.test.ts, which
// never touches the network.

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AGING_CHECK,
  BOARD_LABEL,
  BOARDS,
  CHECKS,
  EVALUATORS,
  HC_PING_BASE,
  HEALTH_FALLBACK_CRON,
  INHIBITIONS,
  LIVENESS_CHECK,
  P2_RED_MS,
  RULES,
  SCHEDULE_SKIP_MS,
  SELFTEST_CHECK,
  SEVERITIES,
  STATE_MARKER,
  VERDICT_CHECKS,
  ageText,
  checkFor,
  makeFinding,
  matchesKey,
  mayTurnRed,
  moreSevere,
  oneLine,
  parseFindingsDocument,
  ruleJudgesKey,
  severityRank,
  utcText,
} from './lib/findings.mjs';

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The monthly selftest cron of health.yml (09:17 UTC on the 1st): a forced P1 that must turn the run red. */
export const SELFTEST_CRON = '17 9 1 * *';
/** A board body stays under this (GitHub rejects a body over 65,536 characters). */
export const MAX_BODY_CHARS = 60_000;
/** Presence samples kept per key ('1' present, '0' absent; newest last): enough for 4 of the last 8. */
export const SAMPLE_WINDOW = 8;
/**
 * A run less than this after the previous sample shares its slot (present if either run saw the key, and no healthy run
 * of its own toward a resolve), and a confirming run must come at least this long after the first sighting: a rerun, a
 * queued or extra dispatch, or the Worker's double dispatch adds no evidence.
 */
export const SAMPLE_SLOT_MS = 10 * MIN;
/** Without a selftest run for this long (and boards older than that) watcher:selftest-overdue opens. */
export const SELFTEST_OVERDUE_MS = 35 * DAY;
/** The boards' pin and lock are checked through GraphQL at most this often. */
export const PIN_CHECK_MS = DAY;
/** A board state keeps at most this many comment failures for watcher:reconcile. */
export const MAX_FAULTS = 10;
/** The state's event log keeps 7 days, at most 300 events (the oldest go first). */
export const LOG_KEEP_MS = 7 * DAY;
export const LOG_MAX_EVENTS = 300;
/** The "Last 7 days" counters keep today and the 6 UTC days before it. */
export const DAYS_KEPT = 7;
/** A finding's text as the state keeps it; shortened to 160, then 60 characters when a body would not fit otherwise. */
export const STATE_TEXT_CHARS = 300;
export const STATE_TEXT_SHORT_CHARS = 160;
export const STATE_TEXT_MIN_CHARS = 60;
/** Event rows rendered in a body (newest first); the state keeps more. */
export const LOG_ROWS_SHOWN = 50;
/** HEALTH_SILENCES holds at most this many entries. */
export const MAX_SILENCES = 20;
/** A ping carries its reason as the body (Healthchecks shows it), at most this long, with a 10 s timeout per try. */
export const PING_REASON_CHARS = 1_000;
export const PING_TIMEOUT_MS = 10_000;
/** The severity label of a board: its worst open non-shadow severity, or ok. */
export const SEVERITY_LABELS = Object.freeze({ P1: 'health:p1', P2: 'health:p2', P3: 'health:p3', ok: 'health:ok' });
/** The five labels reconcile uses, created before the first board (and again when GitHub refuses one as missing). */
export const LABEL_DEFS = Object.freeze([
  Object.freeze({ name: BOARD_LABEL, color: '5319e7', description: 'Permanent health board, written by the health workflow' }),
  Object.freeze({ name: SEVERITY_LABELS.P1, color: 'b60205', description: 'Health board with an open P1 (page)' }),
  Object.freeze({ name: SEVERITY_LABELS.P2, color: 'd93f0b', description: 'Health board with an open P2 (urgent)' }),
  Object.freeze({ name: SEVERITY_LABELS.P3, color: 'fbca04', description: 'Health board with an open P3 (ticket)' }),
  Object.freeze({ name: SEVERITY_LABELS.ok, color: '0e8a16', description: 'Health board with nothing open' }),
]);

const API = 'https://api.github.com';
const READ_ATTEMPTS = 3;
/** A comment is tried this often (BACKOFF_MS apart) on a network error, a 5xx or a 429. */
const COMMENT_ATTEMPTS = 3;
const BACKOFF_MS = Object.freeze([2_000, 5_000]);
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_MEMBERS = 50;
const KEY_RE = /^[a-z0-9][a-z0-9._:-]*$/;
const EVENTS = Object.freeze(['open', 'escalate', 'resolve', 'would-resolve', 'would-notify', 'notify']);
const BOARD_IDS = Object.freeze(Object.keys(BOARDS));
const SELFTEST_KEY = RULES['alerts:selftest'].key;
const RECONCILE_WATCHER_ID = 'reconcile';
const SELFTEST_WATCHER_ID = 'selftest-overdue';
const STATUS_KEYS = Object.freeze([RULES['alerts:status:stale'].key, RULES['alerts:status:unreadable'].key]);
const RENDER_ROWS = Object.freeze([LOG_ROWS_SHOWN, 25, 10, 0]);
/** The last resort of fitBody: at most this many rows per table (worst first); the state keeps every row. */
const TABLE_ROWS = Object.freeze([40, 20, 10]);
const BOARD_SCOPE = Object.freeze({
  alerts: "The Shelter's alert pipeline: the alerts gateway's public status.json (providers, detection, delivery, budget)",
  feed: 'the earthquakes feed: the live manifests, the per-source status, the data files and the maintenance walks',
  platform: "The Shelter's API and config Worker, the config bundle, the account usage and the health monitoring itself",
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => (finite(v) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const redSeverity = (s) => s === 'P1' || s === 'P2';
const notifiable = (s) => severityRank(s) <= 3;
const onesIn = (samples, of) => [...samples.slice(-of)].filter((c) => c === '1').length;
const errMsg = (e) => (e instanceof Error ? e.message : String(e));
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const severityOrNull = (v) => (SEVERITIES.includes(v) ? v : null);
const stateMembers = (list) => (Array.isArray(list) ? list.filter((m) => typeof m === 'string').slice(0, MAX_MEMBERS).map((m) => oneLine(m, 120)) : []);
const runUrlOrNull = (v) => (typeof v === 'string' && /^https:\/\/[^\s<>"'`|]+$/.test(v) && v.length <= 300 ? v : null);
/** `obj`'s fields in the order of `order` (a state's JSON, and so its body, must not depend on insertion order). */
const ordered = (obj, order) => {
  const out = {};
  for (const k of order) if (Object.hasOwn(obj, k)) out[k] = obj[k];
  return out;
};
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
/** Worst severity first, then the oldest episode, then the key. */
const byWorst = (a, b) => severityRank(a.severity) - severityRank(b.severity) || (a.episodeSinceMs ?? Infinity) - (b.episodeSinceMs ?? Infinity) || byKey(a, b);
/**
 * An open P1/P2 entry whose finding is present this run below a red severity: a P4 sample keeps it open until it
 * resolves (coverage:all while two providers still fail), but its condition no longer holds, so it is not red and fails
 * no check.
 */
const heldBelowRed = (e) => e.open && redSeverity(e.severity) && e.frozen === null && e.found !== null && !redSeverity(e.found);
const BELOW_LINE_NOTE = 'below its line this run: not red, open until it resolves';

/**
 * Untrusted text as one line of markdown that is safe inside a table cell and notifies nobody: no pipes, no @mentions,
 * no #123 references, no HTML.
 */
export function markdownText(x) {
  return oneLine(x, 10_000)
    .replace(/\|/g, '\\|')
    .replace(/@/g, '@\u200b')
    .replace(/#(?=\d)/g, '#\u200b')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
const md = markdownText;

/** A GitHub Actions workflow command (annotation), with the documented escaping; no title when `title` is null. */
export function annotation(level, title, message) {
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return title === null || title === undefined ? `::${level}::${esc(message)}` : `::${level} title=${escProp(title)}::${esc(message)}`;
}

/** The Healthchecks.io ping URL of one check. A capability: never log it or put it in an error message. */
export function pingUrl(key, check, signal) {
  return `${HC_PING_BASE}/${key}/${check}/${signal === 'fail' ? 'fail' : '0'}`;
}

// ---------------------------------------------------------------------------------------------------------
// State: the hidden marker of a board body

function blankEntry(key, board) {
  return {
    key,
    rule: null,
    board,
    class: null,
    check: null,
    shadow: false,
    evaluator: null,
    text: '',
    members: [],
    sinceMs: null,
    found: null,
    open: false,
    severity: 'P4',
    openedMs: null,
    episodeSinceMs: null,
    enteredBy: null,
    pending: null,
    seenRuns: 0,
    absentRuns: 0,
    firstSeenMs: null,
    lastSeenMs: null,
    samples: '',
    sampleMs: [],
    firstSampleMs: null,
    notified: null,
    escalated: false,
    escalationNotified: false,
    retryComment: false,
    redSinceMs: null,
    silence: null,
    muted: null,
    frozen: null,
  };
}

/** One entry of a parsed state, with every field checked; null when it is not one this board can hold. */
function normalizeEntry(key, raw, board) {
  if (!isObject(raw) || raw.key !== key || typeof key !== 'string' || !KEY_RE.test(key) || key.length > 120) return null;
  if (key === SELFTEST_KEY || typeof raw.rule !== 'string' || !Object.hasOwn(RULES, raw.rule)) return null;
  const r = RULES[raw.rule];
  if (r.board !== board || !ruleJudgesKey(r, key)) return null;
  const e = blankEntry(key, board);
  e.rule = r.id;
  e.class = r.class;
  e.shadow = r.shadow;
  e.check = CHECKS.includes(raw.check) ? raw.check : null;
  e.evaluator = EVALUATORS.includes(raw.evaluator) ? raw.evaluator : null;
  e.text = typeof raw.text === 'string' ? oneLine(raw.text, STATE_TEXT_CHARS) : '';
  e.members = stateMembers(raw.members);
  e.sinceMs = numOrNull(raw.sinceMs);
  e.found = severityOrNull(raw.found);
  e.open = raw.open === true;
  e.severity = SEVERITIES.includes(raw.severity) ? raw.severity : 'P4';
  e.openedMs = numOrNull(raw.openedMs);
  e.episodeSinceMs = numOrNull(raw.episodeSinceMs);
  e.enteredBy = raw.enteredBy === 'line' || raw.enteredBy === 'ratio' ? raw.enteredBy : null;
  e.pending = typeof raw.pending === 'string' ? oneLine(raw.pending, 120) : null;
  e.seenRuns = count(raw.seenRuns);
  e.absentRuns = count(raw.absentRuns);
  e.firstSeenMs = numOrNull(raw.firstSeenMs);
  e.lastSeenMs = numOrNull(raw.lastSeenMs);
  // The samples and their times go together: a pair that does not match starts the window afresh.
  if (typeof raw.samples === 'string' && /^[01]*$/.test(raw.samples) && Array.isArray(raw.sampleMs) && raw.sampleMs.length === raw.samples.length && raw.sampleMs.every(finite)) {
    e.samples = raw.samples.slice(-SAMPLE_WINDOW);
    e.sampleMs = raw.sampleMs.slice(-SAMPLE_WINDOW);
  }
  e.firstSampleMs = oldestFailingSample(e);
  e.notified = severityOrNull(raw.notified);
  e.escalated = raw.escalated === true;
  e.escalationNotified = raw.escalationNotified === true;
  e.retryComment = raw.retryComment === true;
  e.redSinceMs = numOrNull(raw.redSinceMs);
  e.silence = isObject(raw.silence) && typeof raw.silence.spec === 'string' && SEVERITIES.includes(raw.silence.severity) ? { spec: oneLine(raw.silence.spec, 300), severity: raw.silence.severity } : null;
  e.muted = isObject(raw.muted) && (raw.muted.by === 'inhibited' || raw.muted.by === 'silenced') && typeof raw.muted.note === 'string' ? { by: raw.muted.by, note: oneLine(raw.muted.note, 300) } : null;
  e.frozen = typeof raw.frozen === 'string' ? oneLine(raw.frozen, 200) : null;
  return e;
}

const validEvent = (x) => isObject(x) && finite(x.ms) && typeof x.key === 'string' && KEY_RE.test(x.key) && x.key.length <= 120 && EVENTS.includes(x.event);
const validFault = (x) => isObject(x) && finite(x.ms) && typeof x.text === 'string';

/** The time of the oldest '1' still in an entry's sample window, or null. */
function oldestFailingSample(e) {
  const i = e.samples.indexOf('1');
  return i < 0 ? null : e.sampleMs[i];
}

/**
 * Add this run's sample ('1' present, '0' absent). A run less than SAMPLE_SLOT_MS after the newest slot shares it: the
 * slot becomes present when either run saw the key (and then takes this run's time, so its time is a run that saw it).
 * Returns whether the run opened a slot of its own (only such an absent run counts toward a resolve).
 */
function addSample(e, bit, nowMs) {
  const last = e.samples.length - 1;
  let opened = false;
  if (last >= 0 && nowMs - e.sampleMs[last] < SAMPLE_SLOT_MS) {
    if (bit === '1' && e.samples[last] === '0') {
      e.samples = `${e.samples.slice(0, last)}1`;
      e.sampleMs = [...e.sampleMs.slice(0, last), nowMs];
    }
  } else {
    e.samples = `${e.samples}${bit}`.slice(-SAMPLE_WINDOW);
    e.sampleMs = [...e.sampleMs, nowMs].slice(-SAMPLE_WINDOW);
    opened = true;
  }
  e.firstSampleMs = oldestFailingSample(e);
  return opened;
}

/** A state object checked field by field; null for a wrong version or board (the board then starts empty). */
function normalizeState(raw, board) {
  if (!isObject(raw) || raw.v !== 1 || typeof raw.board !== 'string' || !Object.hasOwn(BOARDS, raw.board)) return null;
  if (board !== undefined && board !== null && raw.board !== board) return null;
  const b = raw.board;
  const evaluators = {};
  if (isObject(raw.evaluators)) for (const e of EVALUATORS) if (finite(raw.evaluators[e])) evaluators[e] = raw.evaluators[e];
  const checks = {};
  if (isObject(raw.checks)) for (const c of CHECKS) if (raw.checks[c] === 'success' || raw.checks[c] === 'fail') checks[c] = raw.checks[c];
  const entries = {};
  if (isObject(raw.entries)) {
    for (const k of Object.keys(raw.entries).sort()) {
      const e = normalizeEntry(k, raw.entries[k], b);
      if (e) entries[k] = e;
    }
  }
  const log = Array.isArray(raw.log) ? raw.log.filter(validEvent).map((x) => ({ ms: x.ms, key: x.key, event: x.event, severity: severityOrNull(x.severity) })) : [];
  const faults = Array.isArray(raw.faults) ? raw.faults.filter(validFault).slice(-MAX_FAULTS).map((x) => ({ ms: x.ms, text: oneLine(x.text, 300) })) : [];
  const days = {};
  if (isObject(raw.days)) {
    for (const d of Object.keys(raw.days).sort()) {
      const x = raw.days[d];
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && isObject(x)) days[d] = { red: count(x.red), comments: count(x.comments), transitions: count(x.transitions), would: count(x.would) };
    }
  }
  return {
    v: 1,
    board: b,
    createdMs: numOrNull(raw.createdMs),
    updatedMs: numOrNull(raw.updatedMs),
    runId: typeof raw.runId === 'string' ? oneLine(raw.runId, 40) : null,
    runUrl: runUrlOrNull(raw.runUrl),
    pings: raw.pings === 'sent' ? 'sent' : 'skipped',
    evaluators,
    checks,
    lastSelftestMs: numOrNull(raw.lastSelftestMs),
    pinsCheckedMs: numOrNull(raw.pinsCheckedMs),
    faults,
    entries,
    log,
    days,
  };
}

/**
 * The state hidden in a board body (`<!-- health-state v1 {json} -->`), or null when the marker is missing or broken,
 * or names another version or board: the board then starts empty, which costs at most one duplicate entry comment.
 * @param {unknown} body
 * @param {string} [board] the board the body belongs to
 */
export function parseBoardState(body, board) {
  if (typeof body !== 'string') return null;
  const head = `<!-- ${STATE_MARKER} `;
  const start = body.lastIndexOf(head);
  if (start < 0) return null;
  const end = body.indexOf(' -->', start + head.length);
  if (end < 0) return null;
  let raw;
  try {
    raw = JSON.parse(body.slice(start + head.length, end));
  } catch {
    return null;
  }
  return normalizeState(raw, board);
}

/** Entry fields the marker leaves out: the rule gives board, class and shadow, and the samples give firstSampleMs. */
const DERIVED_FIELDS = new Set(['board', 'class', 'shadow', 'firstSampleMs']);
const BLANK_ENTRY = blankEntry('', '');
const isBlank = (v, blank) => v === blank || (Array.isArray(v) && v.length === 0 && Array.isArray(blank) && blank.length === 0);

/** An entry as the marker stores it: no derived field and no field at its blank value (normalizeEntry restores both). */
function compactEntry(e) {
  const out = {};
  for (const [k, v] of Object.entries(e)) if (k === 'key' || k === 'rule' || (!DERIVED_FIELDS.has(k) && !isBlank(v, BLANK_ENTRY[k]))) out[k] = v;
  return out;
}

/** The marker: compact JSON with every < and > escaped, so ` -->` can never appear inside it. */
function stateMarker(state) {
  const entries = {};
  for (const [k, e] of Object.entries(state.entries)) entries[k] = compactEntry(e);
  const json = JSON.stringify({ ...state, entries }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<!-- ${STATE_MARKER} ${json} -->`;
}

// ---------------------------------------------------------------------------------------------------------
// Silences and the schedule gate

/**
 * HEALTH_SILENCES: `key=until,reason;...`. `key` is exact or a prefix ending in `*`; `until` is YYYY-MM-DD (the end of
 * that UTC day) or a full ISO time with a zone. At most 20 entries. A bad entry, an entry over the limit and an expired
 * one go to `errors` (the summary warns about them); `silences` holds the ones in force at `nowMs`.
 */
export function parseSilences(text, nowMs) {
  const silences = [];
  const errors = [];
  const items = String(text ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const [i, item] of items.entries()) {
    const spec = oneLine(item, 300);
    if (i >= MAX_SILENCES) {
      errors.push(`"${spec}": more than ${MAX_SILENCES} silences, ignored`);
      continue;
    }
    const eq = item.indexOf('=');
    if (eq < 0) {
      errors.push(`"${spec}": not key=until,reason`);
      continue;
    }
    const pattern = item.slice(0, eq).trim();
    const rest = item.slice(eq + 1);
    const comma = rest.indexOf(',');
    const until = (comma < 0 ? rest : rest.slice(0, comma)).trim();
    const reason = comma < 0 ? '' : oneLine(rest.slice(comma + 1), 200);
    if (pattern === '*' || !(KEY_RE.test(pattern.endsWith('*') ? pattern.slice(0, -1) : pattern)) || pattern.length > 120) {
      errors.push(`"${spec}": the key must be a health key or a key prefix ending in * (not * alone)`);
      continue;
    }
    let untilMs = NaN;
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
    if (day) {
      const start = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
      if (isoDate(start) === until) untilMs = start + DAY;
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(until)) {
      untilMs = Date.parse(until);
    }
    if (!Number.isFinite(untilMs)) {
      errors.push(`"${spec}": until must be YYYY-MM-DD or an ISO time with a zone`);
      continue;
    }
    if (finite(nowMs) && untilMs <= nowMs) {
      errors.push(`"${spec}": expired at ${utcText(untilMs)}; remove it from HEALTH_SILENCES`);
      continue;
    }
    silences.push({ pattern, untilMs, reason, spec });
  }
  return { silences, errors };
}

/** Workflow-run conclusions of a dispatched health run that judged nothing, so it cannot stand in for the fallback. */
const NOT_A_RUN = Object.freeze(['cancelled', 'skipped']);

/**
 * Whether this health run judges at all, and whether it is a selftest. health.yml's own fallback cron
 * (HEALTH_FALLBACK_CRON) skips its checks when a workflow_dispatch health run was created within SCHEDULE_SKIP_MS,
 * whatever that run's status otherwise (on 2026-10-21 the dispatched run created at 15:22:30 was still running when the
 * scheduled one started at 15:22:39). A run that was cancelled or skipped does not count: a pending dispatched run is
 * cancelled when a newer one joins the `health` concurrency group, so a fallback run that arrives behind it would
 * otherwise skip on behalf of a run that never judged. A list that could not be read (null) means run.
 * `dispatchedRuns` are the workflow runs as the Actions API lists them (created_at, status, conclusion).
 */
export function scheduleGate({ eventName, schedule, selftestInput, dispatchedRuns, nowMs }) {
  const cron = String(schedule ?? '').trim();
  const selftest = String(selftestInput ?? '').trim() === 'true' || cron === SELFTEST_CRON;
  if (eventName !== 'schedule' || cron !== HEALTH_FALLBACK_CRON) {
    return { run: true, selftest, reason: eventName === 'schedule' ? `schedule '${cron}'` : `event ${eventName || '(unknown)'}` };
  }
  if (!Array.isArray(dispatchedRuns)) {
    return { run: true, selftest, reason: 'the dispatched health runs could not be listed, so the fallback cron runs the checks' };
  }
  const recent = dispatchedRuns
    .filter((x) => isObject(x) && !NOT_A_RUN.includes(x.conclusion))
    .map((x) => Date.parse(String(x.created_at)))
    .filter((ms) => Number.isFinite(ms) && Math.abs(nowMs - ms) < SCHEDULE_SKIP_MS)
    .sort((a, b) => b - a);
  if (recent.length > 0) {
    return { run: false, selftest, reason: `a workflow_dispatch health run was created ${ageText(nowMs - recent[0])} ago (within ${ageText(SCHEDULE_SKIP_MS)}): the fallback cron skips its checks` };
  }
  return { run: true, selftest, reason: `no workflow_dispatch health run (not cancelled or skipped) created in the last ${ageText(SCHEDULE_SKIP_MS)}: the fallback cron runs the checks` };
}

// ---------------------------------------------------------------------------------------------------------
// The pure core

const titleOf = (e) => RULES[e.rule]?.title ?? e.rule;
const sinceText = (e, nowMs) => (finite(e.episodeSinceMs) ? `since ${utcText(e.episodeSinceMs)}, ${ageText(nowMs - e.episodeSinceMs)}` : 'since ?');
const head = (e) => `**${e.severity} · \`${e.key}\`** ${md(titleOf(e))}`;

function entryItem(e, nowMs) {
  const r = RULES[e.rule];
  const ratio = e.enteredBy === 'ratio' && r.ratio ? `; entered on ${onesIn(e.samples, r.ratio.of)} of the last ${r.ratio.of} runs` : '';
  return `${head(e)} — ${md(e.text)} (${sinceText(e, nowMs)}${ratio})`;
}
const agingItem = (e, nowMs) => `${head(e)} — open for ${ageText(nowMs - e.episodeSinceMs)}: ${md(e.text)} (${sinceText(e, nowMs)})`;
/** An entry that is past its escalation line in the same run: one item says both. */
const agingNote = (e) => `; past its ${ageText(RULES[e.rule].escalateAfterMs)} escalation line`;

/** Merge a duplicate finding of one key: the worst severity wins, members are merged. */
function addPresent(present, f, evaluator) {
  const cur = present.get(f.key);
  if (!cur) {
    present.set(f.key, { f, evaluator });
    return;
  }
  const members = [...new Set([...(cur.f.members ?? []), ...(f.members ?? [])])];
  const winner = moreSevere(f.severity, cur.f.severity) ? { f, evaluator } : cur;
  present.set(f.key, { f: members.length > 0 ? { ...winner.f, members } : winner.f, evaluator: winner.evaluator });
}

/**
 * Whether the run is red, and why. Red only on evidence: an open P1/P2 entry whose finding is present this run at P1 or
 * P2, or that is frozen (its evaluator missing or stale, or the key not judged: it cannot be told from one that still
 * holds). An entry held open only by its resolve count, or by a P4 sample below its line, is not red; neither are
 * shadow, inhibited and never-red classes.
 */
function redVerdict(entries, nowMs, selftest) {
  const reasons = [];
  const boards = new Set();
  for (const e of [...entries].sort(byWorst)) {
    if (!e.open || e.shadow || e.muted?.by === 'inhibited' || !mayTurnRed(e.class)) continue;
    if ((e.frozen === null && e.found === null) || heldBelowRed(e)) continue;
    if (e.severity === 'P1') reasons.push(`P1 \`${e.key}\``);
    else if (e.severity === 'P2' && finite(e.redSinceMs) && nowMs - e.redSinceMs < P2_RED_MS) reasons.push(`P2 \`${e.key}\` (red for its first hour: ${ageText(nowMs - e.redSinceMs)} so far)`);
    else continue;
    boards.add(e.board);
  }
  if (selftest) {
    reasons.push('the selftest (`alerts:selftest`)');
    boards.add('alerts');
  }
  return { exitCode: reasons.length > 0 ? 1 : 0, reasons, boards };
}

/** The pings of this run, in order, and the boards whose entries drive each one (for the transition counts). */
function computePings(entries, ctx, evaluatorStatus, selftest) {
  const live = [...entries].filter((e) => e.open && !e.shadow && !e.muted).sort(byWorst);
  const pings = [];
  const drivers = [];
  const describe = (list) => oneLine(list.map((e) => `${e.severity} ${e.key}: ${e.text}`).join('; '), PING_REASON_CHARS);
  // An entry waiting on its resolve count keeps its check failing (no flapping push); one present below its line not.
  for (const check of VERDICT_CHECKS) {
    const culprits = live.filter((e) => e.check === check && redSeverity(e.severity) && !heldBelowRed(e));
    pings.push({ check, signal: culprits.length > 0 ? 'fail' : 'success', reason: culprits.length > 0 ? describe(culprits) : 'no open P1/P2 finding' });
    drivers.push([...new Set(culprits.map((e) => e.board))]);
  }
  // gh-aging fails while an announced escalation is open, muted or not: a mute that comes later must not flip it back to
  // /0, or the unmute would push a second time in the same episode. An escalation still held back pushes once announced.
  const aging = [...entries].filter((e) => e.open && !e.shadow && e.escalated && e.escalationNotified).sort(byWorst);
  pings.push({ check: AGING_CHECK, signal: aging.length > 0 ? 'fail' : 'success', reason: aging.length > 0 ? describe(aging) : 'no escalated entry' });
  drivers.push([...new Set(aging.map((e) => e.board))]);
  if (ctx.eventName === 'workflow_dispatch') {
    const missing = EVALUATORS.filter((e) => evaluatorStatus[e].state === 'missing');
    pings.push({
      check: LIVENESS_CHECK,
      signal: missing.length > 0 ? 'fail' : 'success',
      reason: missing.length > 0 ? oneLine(`no findings from ${missing.map((e) => `${e} (${evaluatorStatus[e].reason})`).join(', ')}`, PING_REASON_CHARS) : 'every evaluator produced findings',
    });
    drivers.push(missing.length > 0 ? [RULES.watcher.board] : []);
  }
  if (selftest) {
    pings.push({ check: SELFTEST_CHECK, signal: 'fail', reason: 'selftest: forced P1' }, { check: SELFTEST_CHECK, signal: 'success', reason: 'selftest done' });
    drivers.push(['alerts'], []);
  }
  return { pings, drivers };
}

function labelFor(state) {
  let worst = null;
  for (const e of Object.values(state?.entries ?? {})) if (e.open && !e.shadow && notifiable(e.severity) && (worst === null || moreSevere(e.severity, worst))) worst = e.severity;
  return worst ? SEVERITY_LABELS[worst] : SEVERITY_LABELS.ok;
}

/**
 * Render, then shrink until the body fits: rendered log rows, then the oldest log events, then texts (160 characters),
 * then the closed rows, then the rendered rows of each table, then texts of 60. `fits` is false when even that is over
 * MAX_BODY_CHARS (about a hundred open rows): the wrapper then neither saves the board nor posts its comment, and the
 * run exits 3.
 */
function fitBody(board, state) {
  const tryRows = (s, tableRows) => {
    for (const rows of RENDER_ROWS) {
      const body = renderBody(board, s, { logRows: rows, tableRows });
      if (body.length <= MAX_BODY_CHARS) return body;
    }
    return null;
  };
  let s = state;
  let body = tryRows(s);
  while (body === null && s.log.length > 0) {
    s = { ...s, log: s.log.slice(Math.max(1, Math.ceil(s.log.length / 5))) };
    body = tryRows(s);
  }
  if (body === null) {
    const entries = {};
    for (const [k, e] of Object.entries(s.entries)) entries[k] = { ...e, text: oneLine(e.text, STATE_TEXT_SHORT_CHARS) };
    s = { ...s, entries };
    body = tryRows(s);
  }
  if (body === null) {
    // Keep only the open rows (the samples of closed keys are the cheapest history to lose).
    const entries = {};
    for (const [k, e] of Object.entries(s.entries)) if (e.open) entries[k] = e;
    s = { ...s, entries };
    body = tryRows(s);
  }
  // Last resort: fewer rendered rows, then texts of 60 characters, with every row's memory kept.
  for (const tableRows of TABLE_ROWS) if (body === null) body = tryRows(s, tableRows);
  const fewest = TABLE_ROWS[TABLE_ROWS.length - 1];
  if (body === null) {
    const entries = {};
    for (const [k, e] of Object.entries(s.entries)) entries[k] = { ...e, text: oneLine(e.text, STATE_TEXT_MIN_CHARS) };
    s = { ...s, entries };
    body = tryRows(s, fewest);
  }
  if (body === null) return { body: renderBody(board, s, { logRows: 0, tableRows: fewest }), state: s, fits: false };
  return { body, state: s, fits: true };
}

/**
 * Apply one run's findings to the boards' state. Pure.
 * @param {Partial<Record<string, unknown>> | null} prevState per board, the state parsed from its body (or null)
 * @param {unknown[]} findings the evaluators' documents (re-validated: an invalid one counts as missing)
 * @param {number} nowMs
 * @param {Array<{pattern: string, untilMs: number, reason: string, spec: string}>} [silences]
 * @param {object} [context] { runId, runUrl, eventName, missing: {evaluator: reason}, existing: Board[], pingsEnabled, silenceErrors }
 */
export function reconcile(prevState, findings, nowMs, silences = [], context = {}) {
  if (!finite(nowMs)) throw new TypeError('reconcile: nowMs is not a finite number');
  const ctx = {
    runId: context?.runId !== undefined && context?.runId !== null ? oneLine(String(context.runId), 40) : null,
    runUrl: runUrlOrNull(context?.runUrl),
    eventName: typeof context?.eventName === 'string' ? context.eventName : null,
    missing: isObject(context?.missing) ? context.missing : {},
    pingsEnabled: context?.pingsEnabled === true,
    silenceErrors: Array.isArray(context?.silenceErrors) ? context.silenceErrors.map((x) => oneLine(x, 300)) : [],
  };
  const prev = {};
  for (const b of BOARD_IDS) prev[b] = prevState && prevState[b] ? normalizeState(prevState[b], b) : null;
  const existing = new Set(Array.isArray(context?.existing) ? context.existing.filter((b) => BOARD_IDS.includes(b)) : BOARD_IDS.filter((b) => prev[b] !== null));
  const active = (Array.isArray(silences) ? silences : []).filter((s) => isObject(s) && typeof s.pattern === 'string' && finite(s.untilMs) && nowMs < s.untilMs);

  // The copies every board holds: the last applied document per evaluator, the last selftest and the last pin check
  // (the max of each), the check states (the newest board's). The oldest board's creation, and the comments the last
  // run could not post.
  const lastApplied = {};
  let checks = {};
  let checksMs = -Infinity;
  let lastSelftestMs = null;
  let pinsCheckedMs = null;
  let boardsSinceMs = null;
  const priorFaults = [];
  const before = new Map();
  for (const b of BOARD_IDS) {
    const s = prev[b];
    if (!s) continue;
    for (const [e, ms] of Object.entries(s.evaluators)) if (!(lastApplied[e] >= ms)) lastApplied[e] = ms;
    if (Object.keys(s.checks).length > 0 && (s.updatedMs ?? -Infinity) >= checksMs) {
      checks = { ...s.checks };
      checksMs = s.updatedMs ?? -Infinity;
    }
    if (finite(s.lastSelftestMs) && (lastSelftestMs === null || s.lastSelftestMs > lastSelftestMs)) lastSelftestMs = s.lastSelftestMs;
    if (finite(s.pinsCheckedMs) && (pinsCheckedMs === null || s.pinsCheckedMs > pinsCheckedMs)) pinsCheckedMs = s.pinsCheckedMs;
    if (finite(s.createdMs) && (boardsSinceMs === null || s.createdMs < boardsSinceMs)) boardsSinceMs = s.createdMs;
    priorFaults.push(...s.faults);
    for (const [k, e] of Object.entries(s.entries)) before.set(k, e);
  }

  // 1. Documents: fresh, stale (not newer than the one applied last: an overlapping run or a rerun) or missing.
  const docs = new Map();
  const rejected = {};
  const notes = [];
  for (const value of Array.isArray(findings) ? findings : []) {
    const r = parseFindingsDocument(value);
    if (!r.ok) {
      const e = isObject(value) && EVALUATORS.includes(value.evaluator) ? value.evaluator : null;
      if (e) rejected[e] = `invalid findings document: ${r.error}`;
      notes.push(`rejected a findings document${e ? ` of ${e}` : ''}: ${r.error}`);
      continue;
    }
    const cur = docs.get(r.doc.evaluator);
    if (!cur || r.doc.generatedAtMs > cur.generatedAtMs) docs.set(r.doc.evaluator, r.doc);
  }
  const evaluatorStatus = {};
  for (const e of EVALUATORS) {
    const d = docs.get(e);
    if (!d) {
      const why = ctx.missing[e] ?? rejected[e] ?? 'no findings document (its job failed or its artifact is missing)';
      evaluatorStatus[e] = { state: 'missing', generatedAtMs: null, reason: oneLine(why, 200) };
    } else if (finite(lastApplied[e]) && d.generatedAtMs <= lastApplied[e]) {
      evaluatorStatus[e] = { state: 'stale', generatedAtMs: d.generatedAtMs, reason: `generated ${utcText(d.generatedAtMs)}, not newer than the one applied (${utcText(lastApplied[e])})` };
    } else {
      evaluatorStatus[e] = { state: 'fresh', generatedAtMs: d.generatedAtMs, reason: null };
    }
  }
  const fresh = EVALUATORS.filter((e) => evaluatorStatus[e].state === 'fresh');
  const staleOnes = EVALUATORS.filter((e) => evaluatorStatus[e].state === 'stale');
  const missing = EVALUATORS.filter((e) => evaluatorStatus[e].state === 'missing');

  // A replay (every document already applied: a rerun, or an overlapping run that lost the race) changes nothing.
  if (fresh.length === 0 && staleOnes.length > 0) {
    const states = {};
    const bodies = {};
    const labels = {};
    for (const b of BOARD_IDS) {
      if (prev[b]) {
        const fit = fitBody(b, prev[b]);
        states[b] = fit.state;
        bodies[b] = fit.body;
      } else {
        states[b] = null;
        bodies[b] = null;
      }
      labels[b] = [BOARD_LABEL, labelFor(states[b])];
    }
    const all = [...before.values()];
    const verdict = redVerdict(all, nowMs, false);
    const { pings } = computePings(all, ctx, evaluatorStatus, false);
    return {
      state: states,
      bodies,
      create: [],
      comments: [],
      labels,
      pings,
      exitCode: verdict.exitCode,
      summary: buildSummary({ ctx, nowMs, evaluatorStatus, all, present: new Map(), comments: [], pings, create: [], verdict, notes, replay: true, silences: active }),
      annotations: buildAnnotations(all, null, ctx),
      evaluators: evaluatorStatus,
      replay: true,
      pinCheck: false,
      commentFaultsBefore: priorFaults.length,
    };
  }

  const present = new Map();
  const unjudged = [];
  for (const e of fresh) {
    const d = docs.get(e);
    for (const f of d.findings) addPresent(present, f, e);
    unjudged.push(...d.unjudged);
  }
  for (const e of missing) {
    const text = `the ${e} evaluator produced no findings this run (${evaluatorStatus[e].reason}): its entries are frozen until it does`;
    addPresent(present, makeFinding('watcher', { id: `evaluator:${e}`, text }), null);
  }
  // The comments the last run could not post (it rolled them back, so this run posts them again): a watcher fault.
  if (priorFaults.length > 0) {
    const n = priorFaults.length;
    const text = `the last health run could not post ${n === 1 ? 'a board comment' : `${n} board comments`} (rolled back, so this run posts ${n === 1 ? 'it' : 'them'} again): ${priorFaults[n - 1].text}`;
    addPresent(present, makeFinding('watcher', { id: RECONCILE_WATCHER_ID, sinceMs: priorFaults[0].ms, text }), null);
  }
  const selftestFinding = present.get(SELFTEST_KEY)?.f ?? null;
  present.delete(SELFTEST_KEY);
  // The selftest proves the red path, and GitHub can drop its monthly cron without a trace: a long gap is a watcher
  // fault. Counted from the last selftest, or from the oldest board's creation until the first (none at rollout).
  const selftestMs = selftestFinding ? nowMs : lastSelftestMs;
  const selftestBase = selftestMs ?? boardsSinceMs;
  if (finite(selftestBase) && nowMs - selftestBase > SELFTEST_OVERDUE_MS) {
    const since = selftestMs === null ? `no selftest since the boards were created at ${utcText(selftestBase)}` : `the last selftest ran at ${utcText(selftestBase)}`;
    const text = `${since} (${ageText(nowMs - selftestBase)}; line ${ageText(SELFTEST_OVERDUE_MS)}): GitHub may have dropped the monthly selftest cron, so run the health workflow with watchdog_selftest=true`;
    addPresent(present, makeFinding('watcher', { id: SELFTEST_WATCHER_ID, sinceMs: selftestBase + SELFTEST_OVERDUE_MS, text }), null);
  }

  // 2. Frozen keys keep their entry unchanged: no counters, no samples, no enter, no resolve. Every other alerts:* key
  // is frozen while status.json is stale or unreadable THIS run (or its status keys are not judged): on the first run
  // the document is fresh again they are judged, so a P1 it shows is red on that run.
  const notJudged = (key) => !present.has(key) && unjudged.some((p) => matchesKey(p, key));
  const alertsFrozen = evaluatorStatus.alerts.state !== 'fresh' || STATUS_KEYS.some((k) => present.has(k) || notJudged(k));
  const frozenReason = (key) => {
    const entry = before.get(key);
    if (entry?.evaluator && evaluatorStatus[entry.evaluator].state !== 'fresh') return `not judged this run (the ${entry.evaluator} findings are ${evaluatorStatus[entry.evaluator].state})`;
    if (notJudged(key)) return 'not judged this run (its input could not be read)';
    if (alertsFrozen && key.startsWith('alerts:') && !key.startsWith('alerts:status:') && key !== SELFTEST_KEY) {
      return evaluatorStatus.alerts.state !== 'fresh' ? `not judged this run (the alerts findings are ${evaluatorStatus.alerts.state})` : 'not judged this run (status.json is stale or unreadable)';
    }
    return null;
  };

  const logs = {};
  const days = {};
  for (const b of BOARD_IDS) {
    logs[b] = [...(prev[b]?.log ?? [])];
    days[b] = {};
    for (const [d, x] of Object.entries(prev[b]?.days ?? {})) days[b][d] = { ...x };
  }
  const today = isoDate(nowMs);
  const bump = (b, field) => {
    const d = (days[b][today] ??= { red: 0, comments: 0, transitions: 0, would: 0 });
    d[field] += 1;
  };
  const logEvent = (e, event) => logs[e.board].push({ ms: nowMs, key: e.key, event, severity: severityOrNull(e.severity) });

  // 3. Per key.
  const next = new Map();
  for (const key of [...new Set([...before.keys(), ...present.keys()])].sort()) {
    const old = before.get(key) ?? null;
    const why = frozenReason(key);
    if (why) {
      if (old) next.set(key, { ...old, frozen: oneLine(why, 200) });
      continue;
    }
    const p = present.get(key) ?? null;
    let e;
    if (p) {
      const { f } = p;
      const r = RULES[f.rule];
      e = old ? { ...old } : blankEntry(key, r.board);
      e.frozen = null;
      e.seenRuns += 1;
      e.absentRuns = 0;
      e.firstSeenMs ??= nowMs;
      e.lastSeenMs = nowMs;
      addSample(e, '1', nowMs);
      e.rule = r.id;
      e.board = r.board;
      e.class = r.class;
      e.shadow = r.shadow;
      e.evaluator = p.evaluator;
      e.text = oneLine(f.text, STATE_TEXT_CHARS);
      e.members = stateMembers(f.members);
      e.sinceMs = f.sinceMs;
      e.found = f.severity;
      let eff = f.severity;
      let pending = null;
      let byRatio = false;
      if (notifiable(f.severity)) {
        // A confirming run counts only SAMPLE_SLOT_MS after the first sighting. A finding whose start is unknown
        // (sinceMs null: a feed source that never fetched successfully) is held for its rule's line from that sighting.
        const confirmed = e.seenRuns >= r.confirmRuns && nowMs - e.firstSeenMs >= (r.confirmRuns - 1) * SAMPLE_SLOT_MS;
        const holdMs = Math.max(r.holdMs, f.sinceMs === null && finite(r.limits.lineMs) ? r.limits.lineMs : 0);
        if (!confirmed) {
          eff = 'P4';
          pending = `confirming ${Math.min(e.seenRuns, r.confirmRuns - 1)}/${r.confirmRuns}`;
        } else if (holdMs > 0 && nowMs - e.firstSeenMs < holdMs) {
          eff = 'P4';
          pending = `holding ${ageText(nowMs - e.firstSeenMs)} of ${ageText(holdMs)}${holdMs > r.holdMs ? ' (its start is unknown)' : ''}`;
        }
      }
      // The rule's promotion (alerts:status:unreadable: P1 once open for 60 min), while its finding holds.
      if (e.open && r.promote && pending === null && notifiable(eff) && finite(e.openedMs) && nowMs - e.openedMs >= r.promote.afterMs && moreSevere(r.promote.to, eff)) {
        eff = r.promote.to;
      }
      if (pending === null && eff === 'P4' && r.ratio && onesIn(e.samples, r.ratio.of) >= r.ratio.min) {
        eff = r.ratio.severity;
        byRatio = true;
      }
      e.pending = pending;
      // A shadow rule whose own severity is P4 (the canary, the latency rule) enters at P4: its line is the presence
      // itself (the canary) or its ratio (latency). Every other entry needs P1-P3.
      const enters = notifiable(eff) || (r.shadow && r.severity === 'P4' && pending === null && (r.ratio ? byRatio : true));
      if (enters && !e.open) {
        e.open = true;
        e.openedMs = nowMs;
        e.enteredBy = byRatio ? 'ratio' : 'line';
        // The episode's start: by its line, the finding's own streak start (reconcile's first sighting when that is
        // unknown); by ratio, the earlier of that and the oldest failing sample in the window (which only holds samples
        // since the last resolve), so an older episode never dates a new one.
        e.episodeSinceMs = byRatio ? Math.min(f.sinceMs ?? Infinity, e.firstSampleMs ?? nowMs) : (f.sinceMs ?? e.firstSeenMs);
        e.severity = eff;
        e.notified = null;
        e.escalated = false;
        e.escalationNotified = false;
        e.redSinceMs = null;
        e.silence = null;
        logEvent(e, 'open');
      } else if (enters) {
        const rose = moreSevere(eff, e.severity);
        e.severity = eff;
        if (rose) logEvent(e, 'escalate');
      } else if (!e.open) {
        e.severity = 'P4';
      }
      e.check = e.open ? (f.severity === e.severity ? f.check : checkFor(r, e.severity)) : null;
    } else {
      e = { ...old, frozen: null, pending: null, found: null };
      const r = RULES[e.rule];
      e.seenRuns = 0;
      e.firstSeenMs = null;
      // Resolving goes by time too: an absent run in the slot of the previous sample (a rerun, an extra dispatch) adds
      // no healthy run, so "2 healthy runs" spans at least 10 min.
      if (addSample(e, '0', nowMs)) e.absentRuns += 1;
      if (e.open) {
        const need = e.enteredBy === 'ratio' ? r.resolveRunsAfterRatio : r.resolveRuns;
        if (e.absentRuns >= need && nowMs - (e.lastSeenMs ?? -Infinity) >= r.resolveAfterMs) {
          e.open = false;
          // The next episode starts from nothing: the samples before the resolve neither re-open it nor date it.
          e.samples = '';
          e.sampleMs = [];
          e.firstSampleMs = null;
          logEvent(e, e.shadow ? 'would-resolve' : 'resolve');
        }
      }
    }
    const r = RULES[e.rule];
    // The time escalation, only on a run where the key's finding is present (a recovering entry does not escalate).
    if (p !== null && e.open && !e.escalated && r.escalateAfterMs !== null && finite(e.episodeSinceMs) && nowMs - e.episodeSinceMs >= r.escalateAfterMs) {
      e.escalated = true;
      logEvent(e, 'escalate');
    }
    if (e.open && redSeverity(e.severity) && e.redSinceMs === null) e.redSinceMs = nowMs;
    if (!e.open) {
      e.muted = null;
      e.retryComment = false;
    }
    const keep = e.open || (p !== null && e.pending !== null) || (r.ratio !== null && e.samples.includes('1'));
    if (keep) next.set(key, e);
  }

  // 4. Mute: shadow, then inhibited, then silenced. Only an entry open after this run's holds inhibits (a frozen one
  // while it is open): a finding still confirming or holding shows as P4 and mutes nothing.
  const inhibitors = [...next.values()].filter((e) => e.open && !e.shadow).map((e) => e.key).sort();
  const membersOf = (k) => next.get(k)?.members ?? [];
  const inhibitorOf = (key) => {
    for (const inh of INHIBITIONS) {
      for (const k of inhibitors) {
        if (k === key || !matchesKey(inh.when, k)) continue;
        if (inh.mute && inh.mute.some((pat) => matchesKey(pat, key))) return k;
        if (inh.muteMembers && membersOf(k).some((m) => `${inh.muteMembers}${m}` === key)) return k;
      }
    }
    return null;
  };
  for (const e of next.values()) {
    if (!e.open || e.shadow) {
      e.muted = null;
      continue;
    }
    const by = inhibitorOf(e.key);
    if (by) {
      e.muted = { by: 'inhibited', note: oneLine(`inhibited by ${by}`, 300) };
      continue;
    }
    const s = active.find((x) => matchesKey(x.pattern, e.key));
    if (!s) {
      if (!e.frozen) e.silence = null;
      e.muted = null;
      continue;
    }
    let record = e.silence;
    if (!record || record.spec !== oneLine(s.spec, 300)) {
      record = { spec: oneLine(s.spec, 300), severity: e.severity };
      if (!e.frozen) e.silence = record;
    }
    // A silence lifts early once the severity rises above the one it silenced.
    e.muted = moreSevere(e.severity, record.severity) ? null : { by: 'silenced', note: oneLine(`silenced until ${utcText(s.untilMs)}${s.reason ? `: ${s.reason}` : ''}`, 300) };
  }

  // 5. Notifications: one comment per board per run, one item per key. A due item that is muted stays due. One an
  // inhibition held back goes out only on a run where the key's own finding is present (a child whose condition
  // cleared while its parent was open never comments); one a silence held back goes out once the silence ends, and one
  // whose post failed (rolled back by the wrapper) on the next run, present or not.
  const items = { alerts: [], feed: [], platform: [] };
  const announced = { alerts: [], feed: [], platform: [] };
  for (const e of [...next.values()].sort(byWorst)) {
    if (!e.open || e.frozen) continue;
    if (e.shadow) {
      if (e.notified === null) {
        e.notified = e.severity;
        logEvent(e, 'would-notify');
        bump(e.board, 'would');
      }
      continue;
    }
    if (e.muted || !notifiable(e.severity)) continue;
    if (e.found === null && before.get(e.key)?.muted?.by !== 'silenced' && !e.retryComment) continue;
    const was = { key: e.key, notified: e.notified, escalationNotified: e.escalationNotified };
    let item = null;
    // A P3 entry gets its comment. A P1/P2 entry, and a rise (it always lands at P1 or P2: config:bundle by age, the
    // promotion of an unreadable status.json), is announced by the red run alone: the boards are public, and P1 goes to
    // the owner only (owner decisions 2026-10-22).
    if (e.notified === null) {
      if (e.severity === 'P3') item = entryItem(e, nowMs);
      e.notified = e.severity;
    } else if (moreSevere(e.severity, e.notified)) {
      e.notified = e.severity;
    }
    // An entry already past its escalation line when it enters (its finding's sinceMs hours old on the first run after
    // the rollout) gets one item that says both.
    if (e.escalated && !e.escalationNotified) {
      item = item === null ? agingItem(e, nowMs) : `${item}${agingNote(e)}`;
      e.escalationNotified = true;
    }
    e.retryComment = false;
    if (item !== null) {
      items[e.board].push(item);
      announced[e.board].push(was);
      logEvent(e, 'notify');
    }
  }
  const comments = [];
  for (const b of BOARD_IDS) {
    if (items[b].length === 0) continue;
    // `keys`: the keys it announces, with what they had before (the wrapper restores it when the post fails).
    comments.push({ board: b, body: [...items[b], `Run: ${ctx.runUrl ?? '(a local run)'}`].join('\n\n'), keys: announced[b] });
    bump(b, 'comments');
  }

  // 6. Exit code, 7. pings.
  const all = [...next.values()];
  const verdict = redVerdict(all, nowMs, selftestFinding !== null);
  for (const b of verdict.boards) bump(b, 'red');
  const { pings, drivers } = computePings(all, ctx, evaluatorStatus, selftestFinding !== null);
  const running = { ...checks };
  pings.forEach((p, i) => {
    if (p.signal === 'fail' && running[p.check] !== 'fail') for (const b of drivers[i]) bump(b, 'transitions');
    running[p.check] = p.signal;
  });

  // 8. States and bodies. Every board exists from the first run on (see the header): nothing here decides whether one
  // is needed, so no finding can be the reason an issue is created.
  const pinCheck = pinsCheckedMs === null || nowMs - pinsCheckedMs >= PIN_CHECK_MS;
  const applied = { ...lastApplied };
  for (const e of fresh) applied[e] = Math.max(applied[e] ?? -Infinity, evaluatorStatus[e].generatedAtMs);
  const evaluators = ordered(applied, EVALUATORS);
  const checksOut = ordered(running, CHECKS);
  const oldestDay = isoDate(nowMs - (DAYS_KEPT - 1) * DAY);
  const states = {};
  const bodies = {};
  const labels = {};
  const create = [];
  for (const b of BOARD_IDS) {
    const entries = {};
    for (const e of all.filter((x) => x.board === b).sort(byKey)) entries[e.key] = e;
    const log = logs[b].filter((x) => x.ms >= nowMs - LOG_KEEP_MS).slice(-LOG_MAX_EVENTS);
    const daysKept = {};
    for (const d of Object.keys(days[b]).sort()) if (d >= oldestDay) daysKept[d] = days[b][d];
    const state = {
      v: 1,
      board: b,
      createdMs: prev[b]?.createdMs ?? nowMs,
      updatedMs: nowMs,
      runId: ctx.runId,
      runUrl: ctx.runUrl,
      pings: ctx.pingsEnabled ? 'sent' : 'skipped',
      evaluators: { ...evaluators },
      checks: { ...checksOut },
      lastSelftestMs: selftestMs,
      pinsCheckedMs: pinCheck ? nowMs : pinsCheckedMs,
      faults: [],
      entries,
      log,
      days: daysKept,
    };
    const fit = fitBody(b, state);
    states[b] = fit.state;
    bodies[b] = fit.body;
    if (!existing.has(b)) create.push(b);
    labels[b] = [BOARD_LABEL, labelFor(states[b])];
  }
  const finalEntries = BOARD_IDS.flatMap((b) => Object.values(states[b]?.entries ?? {}));
  return {
    state: states,
    bodies,
    create,
    comments,
    labels,
    pings,
    exitCode: verdict.exitCode,
    summary: buildSummary({ ctx, nowMs, evaluatorStatus, all: finalEntries, present, comments, pings, create, verdict, notes, replay: false, silences: active }),
    annotations: buildAnnotations(finalEntries, selftestFinding, ctx),
    evaluators: evaluatorStatus,
    replay: false,
    pinCheck,
    commentFaultsBefore: priorFaults.length,
  };
}

/**
 * The states and bodies once some of a run's comments could not be posted. Each comment's keys get back the notified
 * and escalationNotified they had before the run and are marked for a retry (the next run posts them, present or not);
 * the run's notify events and comment count for them are taken back; and the failures are kept on the watcher's board,
 * where the next run turns them into watcher:reconcile. Pure.
 * @param {ReturnType<typeof reconcile>} result
 * @param {Array<{ comment: { board: string, keys: Array<{ key: string, notified: string | null, escalationNotified: boolean }> }, message: string }>} failed
 */
export function withFailedComments(result, failed) {
  const states = { ...result.state };
  const bodies = { ...result.bodies };
  const touched = new Set();
  for (const { comment } of failed) {
    const s = states[comment.board];
    if (!s) continue;
    const keys = new Set(comment.keys.map((k) => k.key));
    const entries = { ...s.entries };
    for (const k of comment.keys) {
      if (entries[k.key]) entries[k.key] = { ...entries[k.key], notified: k.notified, escalationNotified: k.escalationNotified, retryComment: true };
    }
    const day = isoDate(s.updatedMs);
    const days = { ...s.days };
    if (days[day]) days[day] = { ...days[day], comments: Math.max(0, days[day].comments - 1) };
    const log = s.log.filter((x) => !(x.ms === s.updatedMs && x.event === 'notify' && keys.has(x.key)));
    states[comment.board] = { ...s, entries, log, days };
    touched.add(comment.board);
  }
  const wb = RULES.watcher.board;
  if (states[wb] && failed.length > 0) {
    const faults = failed.map(({ comment, message }) => ({ ms: states[wb].updatedMs, text: oneLine(`"${BOARDS[comment.board]}": ${message}`, 300) }));
    states[wb] = { ...states[wb], faults: [...states[wb].faults, ...faults].slice(-MAX_FAULTS) };
    touched.add(wb);
  }
  for (const b of touched) {
    const fit = fitBody(b, states[b]);
    states[b] = fit.state;
    bodies[b] = fit.body;
  }
  return { state: states, bodies };
}

function buildAnnotations(entries, selftestFinding, ctx) {
  const out = [];
  for (const e of [...entries].filter((x) => x.open).sort(byWorst)) {
    const level = e.shadow ? 'notice' : redSeverity(e.severity) ? 'error' : 'warning';
    const flags = [e.shadow ? 'shadow rule: log only' : null, e.muted ? `muted: ${e.muted.note}` : null, e.frozen, heldBelowRed(e) ? BELOW_LINE_NOTE : null].filter(Boolean);
    out.push(annotation(level, `${e.severity} ${e.key}`, `${e.text}${flags.length > 0 ? ` (${flags.join('; ')})` : ''}`));
  }
  if (selftestFinding) out.push(annotation('error', `P1 ${SELFTEST_KEY}`, selftestFinding.text));
  for (const err of ctx.silenceErrors) out.push(annotation('warning', 'HEALTH_SILENCES', err));
  return out;
}

function buildSummary({ ctx, nowMs, evaluatorStatus, all, present, comments, pings, create, verdict, notes, replay, silences }) {
  const lines = ['### Health reconcile', ''];
  lines.push(verdict.exitCode === 1 ? `**Run verdict: red**: ${verdict.reasons.join('; ')}.` : '**Run verdict: green.**');
  if (replay) lines.push('', 'Every findings document was already applied (an overlapping run or a rerun): the boards are unchanged and nothing was commented.');
  lines.push('', '| Evaluator | Findings |', '|---|---|');
  for (const e of EVALUATORS) {
    const s = evaluatorStatus[e];
    lines.push(`| ${e} | ${s.state === 'fresh' ? `fresh, generated ${utcText(s.generatedAtMs)}` : `${s.state}: ${md(s.reason)}`} |`);
  }
  const open = all.filter((e) => e.open && !e.shadow).sort(byWorst);
  lines.push('', `**Open (${open.length})**`);
  if (open.length === 0) lines.push('', 'Nothing open.');
  else {
    lines.push('');
    for (const e of open) {
      const flags = [e.muted ? `muted: ${md(e.muted.note)}` : null, e.frozen ? md(e.frozen) : null, heldBelowRed(e) ? BELOW_LINE_NOTE : null, e.escalated ? 'escalated' : null].filter(Boolean);
      lines.push(`- ${e.severity} \`${e.key}\` (${e.board}, ${sinceText(e, nowMs)}): ${md(e.text)}${flags.length > 0 ? ` · ${flags.join(' · ')}` : ''}`);
    }
  }
  const pendingList = all.filter((e) => !e.open && e.pending).sort(byKey);
  if (pendingList.length > 0) {
    lines.push('', '**Pending**', '');
    for (const e of pendingList) lines.push(`- \`${e.key}\` judged ${e.found ?? '?'}, ${md(e.pending)}: ${md(e.text)}`);
  }
  const samples = [...present.values()].filter(({ f }) => f.severity === 'P4' && !all.some((e) => e.key === f.key && e.open)).map(({ f }) => `\`${f.key}\``);
  if (samples.length > 0) lines.push('', `**Samples below their line (P4):** ${samples.join(', ')}`);
  const shadow = all.filter((e) => e.open && e.shadow).sort(byWorst);
  if (shadow.length > 0) {
    lines.push('', '**Shadow rules (log only)**', '');
    for (const e of shadow) lines.push(`- ${e.severity} \`${e.key}\`: ${md(e.text)}`);
  }
  lines.push('', `**Comments:** ${comments.length > 0 ? comments.map((c) => `${c.board} (${c.body.split('\n\n').length - 1} item(s))`).join(', ') : 'none'}`);
  if (create.length > 0) lines.push(`**Boards to create:** ${create.map((b) => `"${BOARDS[b]}"`).join(', ')}`);
  lines.push(`**Pings${ctx.pingsEnabled ? '' : ' (skipped: HC_PING_KEY unset)'}:** ${pings.map((p) => `${p.check} ${p.signal === 'fail' ? '/fail' : '/0'}`).join(', ')}`);
  if (silences.length > 0) lines.push(`**Silences in force:** ${silences.map((s) => `\`${s.pattern}\` until ${utcText(s.untilMs)}`).join(', ')}`);
  for (const err of ctx.silenceErrors) lines.push(`- HEALTH_SILENCES: ${md(err)}`);
  for (const n of notes) lines.push(`- ${md(n)}`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------
// The board body

function sinceCell(e, nowMs) {
  return finite(e.episodeSinceMs) ? `${utcText(e.episodeSinceMs)} (${ageText(nowMs - e.episodeSinceMs)})` : '?';
}

function conditionCell(e) {
  const parts = [`**${md(titleOf(e))}**: ${md(e.text)}`];
  if (e.members.length > 0) parts.push(`members: ${e.members.slice(0, 10).map(md).join(', ')}${e.members.length > 10 ? ` +${e.members.length - 10} more` : ''}`);
  if (e.enteredBy === 'ratio') parts.push('entered by ratio');
  if (e.escalated) parts.push('escalated');
  if (e.muted) parts.push(`muted: ${md(e.muted.note)}`);
  if (e.frozen) parts.push(md(e.frozen));
  if (heldBelowRed(e)) parts.push(BELOW_LINE_NOTE);
  return parts.join(' · ');
}

/**
 * A board's full issue body, a pure function of its state (so a replay renders the body it found). `view.logRows`
 * limits the rendered event rows (default 50), `view.tableRows` the rows of each table (default all).
 */
export function renderBody(board, state, view = {}) {
  const logRows = Number.isInteger(view.logRows) && view.logRows >= 0 ? view.logRows : LOG_ROWS_SHOWN;
  const tableRows = Number.isInteger(view.tableRows) && view.tableRows >= 0 ? view.tableRows : Infinity;
  const nowMs = state.updatedMs ?? 0;
  const entries = Object.values(state.entries ?? {});
  const open = entries.filter((e) => e.open && !e.shadow).sort(byWorst);
  const pending = entries.filter((e) => !e.open && e.pending).sort(byKey);
  const shadow = entries.filter((e) => e.open && e.shadow).sort(byWorst);
  const lines = [];
  const more = (list) => {
    if (list.length > tableRows) lines.push('', `${list.length - tableRows} more row(s) are kept in the state only (the run's job summary lists them).`);
  };
  lines.push(
    `Automated health board of ${BOARD_SCOPE[board] ?? board}. The health workflow rewrites this body on every run and comments only when a P3 enters or passes its age line; P1/P2 rows (a rise into P1/P2 too), members leaving and resolutions are silent edits (the red run is the P1/P2 alarm). Severity: P1 page, P2 urgent, P3 ticket. Runbook: README "Health watchdogs".`,
  );
  lines.push('', '### Open', '');
  if (open.length === 0) lines.push('Nothing open.');
  else {
    lines.push('| Sev | Key | Since | Condition |', '|---|---|---|---|');
    for (const e of open.slice(0, tableRows)) lines.push(`| ${e.severity} | \`${e.key}\` | ${sinceCell(e, nowMs)} | ${conditionCell(e)} |`);
    more(open);
  }
  lines.push('', '### Pending', '');
  if (pending.length === 0) lines.push('Nothing confirming or holding.');
  else {
    lines.push('| Key | Judged | Waiting | Condition |', '|---|---|---|---|');
    for (const e of pending.slice(0, tableRows)) lines.push(`| \`${e.key}\` | ${e.found ?? '?'} | ${md(e.pending)} | ${conditionCell(e)} |`);
    more(pending);
  }
  lines.push('', '### Shadow rules (log only)', '');
  if (shadow.length === 0) lines.push('No shadow rule would notify now.');
  else {
    lines.push('| Sev | Key | Since | Condition |', '|---|---|---|---|');
    for (const e of shadow.slice(0, tableRows)) lines.push(`| ${e.severity} | \`${e.key}\` | ${sinceCell(e, nowMs)} | ${conditionCell(e)} |`);
    more(shadow);
  }
  lines.push('', '### Last 7 days', '');
  const dayKeys = Object.keys(state.days ?? {}).sort().reverse();
  const total = { red: 0, comments: 0, transitions: 0, would: 0 };
  if (dayKeys.length > 0) {
    lines.push('| Day (UTC) | Red runs | Comments | Push transitions | Shadow would-notify |', '|---|---|---|---|---|');
    for (const d of dayKeys) {
      const x = state.days[d];
      for (const k of Object.keys(total)) total[k] += x[k];
      lines.push(`| ${d} | ${x.red} | ${x.comments} | ${x.transitions} | ${x.would} |`);
    }
    lines.push(`| **7 days** | ${total.red} | ${total.comments} | ${total.transitions} | ${total.would} |`, '');
  }
  lines.push(`Push transitions count the checks that went to /fail${state.pings === 'sent' ? '' : ' (pings skipped: HC_PING_KEY unset, so these are the pushes that would have gone out)'}.`);
  if (board === 'alerts') lines.push('', `Last selftest (the forced P1 that proves the red run): ${finite(state.lastSelftestMs) ? utcText(state.lastSelftestMs) : 'none yet'}.`);
  const log = state.log ?? [];
  const opened = new Map();
  for (const x of log) if (x.event === 'open') opened.set(x.key, (opened.get(x.key) ?? 0) + 1);
  if (opened.size > 0) {
    const perKey = [...opened.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `\`${k}\` ${n}`);
    lines.push('', `Entries per key: ${perKey.join(', ')}.`);
  }
  if (log.length > 0 && logRows > 0) {
    const rows = log.slice(-logRows).reverse();
    lines.push('', '| Time (UTC) | Key | Event | Sev |', '|---|---|---|---|');
    for (const x of rows) lines.push(`| ${utcText(x.ms)} | \`${x.key}\` | ${x.event} | ${x.severity ?? ''} |`);
    if (log.length > rows.length) lines.push('', `${log.length - rows.length} older event(s) are kept in the state only.`);
  } else if (log.length > 0) {
    lines.push('', `${log.length} event(s) are kept in the state only.`);
  } else {
    lines.push('', 'No events in the last 7 days.');
  }
  lines.push('', `Updated ${utcText(state.updatedMs)} by run ${state.runUrl ?? state.runId ?? '(a local run)'}.`, '', stateMarker(state));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------
// I/O wrapper

/** Parse argv into options; throws an Error with a readable message on a bad argument. */
export function parseArgs(argv) {
  const opts = { gate: false, findingsDir: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gate') opts.gate = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--findings-dir') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--findings-dir needs a value');
      opts.findingsDir = value;
      i += 1;
    } else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (opts.gate && opts.findingsDir !== null) throw new Error('--gate and --findings-dir exclude each other');
  if (!opts.gate && opts.findingsDir === null) throw new Error('one of --gate or --findings-dir <dir> is required');
  return opts;
}

/** One HTTP request with a timeout; never throws. */
async function request(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, message: res.ok ? 'ok' : `HTTP ${res.status}${text ? `: ${oneLine(text, 160)}` : ''}` };
  } catch (e) {
    return { ok: false, status: 0, json: null, message: ctrl.signal.aborted ? `timed out after ${timeoutMs} ms` : `network error: ${errMsg(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** The GitHub REST/GraphQL client: every method but POST is retried on 5xx and network errors (2 s, 5 s). */
function githubClient({ token, fetchImpl, sleep }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'earthquakes-feed-health',
  };
  const call = async (method, path, payload) => {
    const url = path.startsWith('https://') ? path : `${API}${path}`;
    const init = { method, headers: payload !== undefined ? { ...headers, 'content-type': 'application/json' } : headers, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) };
    const attempts = method === 'POST' ? 1 : READ_ATTEMPTS;
    let r = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)]);
      r = await request(fetchImpl, url, init);
      if (r.ok || (r.status >= 400 && r.status < 500)) break;
    }
    return r;
  };
  const graphql = async (query, variables) => {
    const r = await call('POST', `${API}/graphql`, { query, variables });
    if (r.ok && Array.isArray(r.json?.errors) && r.json.errors.length > 0) return { ...r, ok: false, message: `GraphQL: ${oneLine(r.json.errors.map((x) => x?.message).join('; '), 200)}` };
    return r;
  };
  return { call, graphql };
}

/** The board numbers, kept in the repository: a board is read by its number, never looked up by a listing alone. */
export const BOARD_NUMBERS_FILE = 'scripts/health-boards.json';
const BOARDS_QUERY =
  'query($owner: String!, $name: String!, $label: String!) { repository(owner: $owner, name: $name) { issues(first: 50, labels: [$label], states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: ASC}) { nodes { id number title body state locked isPinned labels(first: 20) { nodes { name } } } } } }';

/**
 * BOARD_NUMBERS_FILE's numbers ({ alerts, feed, platform }; a board without one is found by the listings). A file that
 * is missing gives none (the first run); one that does not parse is an error, since a board created again would be a
 * second one.
 */
export function parseBoardNumbers(text) {
  if (text === null || text === undefined) return { numbers: {}, error: null };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { numbers: {}, error: `${BOARD_NUMBERS_FILE} does not parse: ${errMsg(e)}` };
  }
  const numbers = {};
  for (const b of BOARD_IDS) {
    const n = isObject(raw) ? raw[b] : undefined;
    if (n === undefined || n === null) continue;
    if (!Number.isInteger(n) || n <= 0) return { numbers: {}, error: `${BOARD_NUMBERS_FILE}: "${b}" is not an issue number` };
    numbers[b] = n;
  }
  return { numbers, error: null };
}

/** A board issue from the REST API or the GraphQL listing, in one shape (null for anything else). */
function boardIssue(i, source) {
  if (!isObject(i) || i.pull_request || !Number.isInteger(i.number) || typeof i.title !== 'string') return null;
  const labels = (source === 'graphql' ? (i.labels?.nodes ?? []) : Array.isArray(i.labels) ? i.labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string');
  const id = source === 'graphql' ? i.id : i.node_id;
  return {
    number: i.number,
    title: i.title,
    nodeId: typeof id === 'string' ? id : null,
    body: typeof i.body === 'string' ? i.body.replace(/\r\n/g, '\n') : '',
    state: String(i.state).toLowerCase() === 'closed' ? 'closed' : 'open',
    locked: i.locked === true,
    pinned: typeof i.isPinned === 'boolean' ? i.isPinned : null,
    labels,
  };
}

/**
 * The three boards. A board with a number in BOARD_NUMBERS_FILE is read by that number (GET /issues/N); one that is gone
 * or is not that board makes the boards unreadable (exit 3), never a new board. On 2026-10-22 the label listing of the
 * runs at 16:00 and 16:07 UTC answered without the boards made at 15:53 (a probe at 16:13 listed them all, and the
 * unfiltered listing answered an empty list), and each of those runs made three more. The listings (REST by label,
 * GraphQL by label) only find duplicates and the boards that have no number yet; such a board is created only when both
 * answered without it. Duplicates (the same title): the numbered board, else the lowest number, is the board; its
 * state is the newest of their markers, with the earliest createdMs and the latest selftest, and writeBoards retires
 * the others (renamed "... (duplicate of #N)", unlabelled, unpinned and closed).
 */
async function readBoards(gh, repo, numbers) {
  const byNumber = {};
  for (const b of BOARD_IDS) {
    const n = numbers[b];
    if (!n) continue;
    const r = await gh.call('GET', `/repos/${repo}/issues/${n}`);
    if (r.status === 404 || r.status === 410) return { ok: false, message: `board #${n} "${BOARDS[b]}" (${BOARD_NUMBERS_FILE}) is gone: restore it, or put the number of its replacement there` };
    if (!r.ok || !isObject(r.json)) return { ok: false, message: `board #${n} "${BOARDS[b]}": ${r.ok ? 'not an issue' : r.message}` };
    const i = boardIssue(r.json, 'rest');
    if (!i || i.title !== BOARDS[b]) return { ok: false, message: `issue #${n} (${BOARD_NUMBERS_FILE}) is not the board "${BOARDS[b]}"` };
    byNumber[b] = i;
  }
  const found = new Map();
  const add = (i) => {
    if (!i || !BOARD_IDS.some((b) => BOARDS[b] === i.title)) return;
    const had = found.get(i.number);
    found.set(i.number, had ? { ...had, nodeId: had.nodeId ?? i.nodeId, pinned: had.pinned ?? i.pinned } : i);
  };
  const failed = [];
  const r = await gh.call('GET', `/repos/${repo}/issues?labels=${BOARD_LABEL}&state=all&per_page=100`);
  if (r.ok && Array.isArray(r.json)) for (const raw of r.json) add(boardIssue(raw, 'rest'));
  else failed.push(`the label listing: ${r.ok ? 'not a list' : r.message}`);
  const [owner, name] = repo.split('/');
  const q = await gh.graphql(BOARDS_QUERY, { owner, name, label: BOARD_LABEL });
  const nodes = q.json?.data?.repository?.issues?.nodes;
  if (q.ok && Array.isArray(nodes)) for (const raw of nodes) add(boardIssue(raw, 'graphql'));
  else failed.push(`GraphQL's label listing: ${q.ok ? 'no issue list' : q.message}`);

  const boards = {};
  const warnings = [];
  for (const b of BOARD_IDS) {
    const matches = [...found.values()].filter((i) => i.title === BOARDS[b]).sort((x, y) => x.number - y.number);
    const board = byNumber[b] ? { ...byNumber[b], pinned: found.get(byNumber[b].number)?.pinned ?? null } : matches[0];
    if (!board) {
      if (failed.length > 0) return { ok: false, message: `"${BOARDS[b]}" has no number in ${BOARD_NUMBERS_FILE} and a listing failed (${failed.join('; ')}): creating it could make a second one` };
      continue;
    }
    if (!byNumber[b]) warnings.push(`board "${BOARDS[b]}" is #${board.number}: put that number in ${BOARD_NUMBERS_FILE}`);
    const duplicates = matches.filter((i) => i.number !== board.number);
    if (duplicates.length > 0) warnings.push(`${duplicates.length + 1} issues are titled "${BOARDS[b]}" (#${[board, ...duplicates].map((m) => m.number).join(', #')}): #${board.number} is the board, the others are retired`);
    boards[b] = { ...board, duplicates, stateBodies: [board.body, ...duplicates.map((d) => d.body)] };
  }
  if (failed.length > 0) warnings.push(`the boards' listings failed (${failed.join('; ')}): duplicates are not looked for this run`);
  return { ok: true, boards, warnings };
}

/** The state a board continues from: the newest marker of the board and its duplicates, with the earliest createdMs and the latest selftest. */
export function mergedBoardState(states) {
  const all = states.filter(Boolean);
  if (all.length === 0) return null;
  const newest = all.reduce((x, y) => ((y.updatedMs ?? -1) > (x.updatedMs ?? -1) ? y : x));
  const created = all.map((s) => s.createdMs).filter(finite);
  const selftests = all.map((s) => s.lastSelftestMs).filter(finite);
  return { ...newest, createdMs: created.length > 0 ? Math.min(...created) : newest.createdMs, lastSelftestMs: selftests.length > 0 ? Math.max(...selftests) : newest.lastSelftestMs };
}

async function ensureLabels(gh, repo, warn) {
  for (const l of LABEL_DEFS) {
    const r = await gh.call('POST', `/repos/${repo}/labels`, { ...l });
    if (!r.ok && r.status !== 422) warn(`cannot create the label ${l.name}: ${r.message}`);
  }
}

const OUR_LABELS = new Set(LABEL_DEFS.map((l) => l.name));
const PIN_MUTATION = 'mutation($issueId: ID!) { pinIssue(input: {issueId: $issueId}) { issue { number } } }';
const PINS_QUERY = 'query($ids: [ID!]!) { nodes(ids: $ids) { ... on Issue { id number isPinned locked } } }';
const lockPath = (repo, n) => `/repos/${repo}/issues/${n}/lock`;

/**
 * One write to a board (`what`: "comment", "save its body"). Whether GITHUB_TOKEN may comment on, or edit, a locked
 * issue is not documented: when GitHub refuses the write as locked (a 403, or a 422 that says so), the board is
 * unlocked, written and locked again (a relock that fails is a warning; the next run locks it again).
 */
async function writeUnlocked({ gh, repo, issue, what, write, log, warn }) {
  const r = await write();
  if (r.ok || !(r.status === 403 || (r.status === 422 && /lock/i.test(r.message)))) return r;
  const unlock = await gh.call('DELETE', lockPath(repo, issue.number));
  if (!unlock.ok) return { ...r, message: `${r.message}; cannot unlock it to ${what}: ${unlock.message}` };
  log(`board #${issue.number} refused the write (${what}) while locked (${r.message}): unlocked for it`);
  issue.locked = false;
  const again = await write();
  const relock = await gh.call('PUT', lockPath(repo, issue.number));
  if (relock.ok) issue.locked = true;
  else warn(`cannot lock board #${issue.number} again (unlocked to ${what}): ${relock.message}`);
  return again;
}

/**
 * POST one comment: up to COMMENT_ATTEMPTS tries on a network error, a 5xx or a 429 (a timeout that did post makes a
 * rare duplicate, which beats a lost comment), around an unlock when the board is locked against it.
 */
async function postComment({ gh, repo, issue, body, sleep, log, warn }) {
  const post = async () => {
    let r = null;
    for (let attempt = 1; attempt <= COMMENT_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)]);
      r = await gh.call('POST', `/repos/${repo}/issues/${issue.number}/comments`, { body });
      if (r.ok || !(r.status === 0 || r.status === 429 || r.status >= 500)) break;
    }
    return r;
  };
  return writeUnlocked({ gh, repo, issue, what: 'comment', write: post, log, warn });
}

/**
 * The daily check (result.pinCheck) of boards that already existed: one GraphQL query for their pin and lock, then
 * pinIssue or the lock for one that lost it. Every failure is a warning only: GITHUB_TOKEN may lack the right to pin, and
 * GitHub pins at most three issues per repository (the three boards).
 */
async function checkPins({ gh, repo, issues, log, warn }) {
  const list = issues.filter((i) => typeof i.nodeId === 'string');
  if (list.length === 0) return;
  const r = await gh.graphql(PINS_QUERY, { ids: list.map((i) => i.nodeId) });
  const nodes = r.ok && Array.isArray(r.json?.data?.nodes) ? r.json.data.nodes : null;
  if (!nodes) {
    warn(`cannot check the boards' pins: ${r.ok ? 'the answer has no nodes' : r.message}`);
    return;
  }
  for (const issue of list) {
    const node = nodes.find((x) => isObject(x) && x.id === issue.nodeId);
    if (!node) {
      warn(`cannot check the pin of board #${issue.number}: it is not in the answer`);
      continue;
    }
    if (node.isPinned !== true) {
      const pin = await gh.graphql(PIN_MUTATION, { issueId: issue.nodeId });
      if (pin.ok) log(`pinned board #${issue.number} again`);
      else warn(`cannot pin board #${issue.number} again: ${pin.message}`);
    }
    if (node.locked !== true) {
      const lock = await gh.call('PUT', lockPath(repo, issue.number));
      if (lock.ok) log(`locked board #${issue.number} again`);
      else warn(`cannot lock board #${issue.number} again: ${lock.message}`);
    }
  }
}

/**
 * Write a run's result: create the boards that do not exist (the labels first; all three on the first run), post the
 * comments, then save the bodies (with a failed comment's keys rolled back), the locks and the labels, and run the
 * daily pin check. A comment that fails is an error that the next run retries and reports as watcher:reconcile. A board
 * whose body does not fit even shrunk is neither written nor commented on (its comment would repeat on every run).
 * @returns {Promise<{ saved: boolean, failedComments: number }>} saved is false when a board body could not be created
 *   or saved, or a board created this run could not be labelled (the next run would not find it): the run then exits 3
 */
async function writeBoards({ result, read, gh, repo, sleep, log, warn, error }) {
  let saved = true;
  const issues = {};
  for (const b of BOARD_IDS) if (read.boards[b]) issues[b] = { ...read.boards[b] };
  const pinned = result.pinCheck ? BOARD_IDS.filter((b) => issues[b]).map((b) => issues[b]) : [];
  const oversize = new Set(BOARD_IDS.filter((b) => (result.bodies[b]?.length ?? 0) > MAX_BODY_CHARS));
  for (const b of oversize) {
    error(`the body of "${BOARDS[b]}" is ${result.bodies[b].length} characters even shrunk (over ${MAX_BODY_CHARS}: too many open rows): the board is not written and its comment is held back`);
    saved = false;
  }
  const created = new Set();

  // 1. The missing boards, each pinned and locked once created. Its labels are the ones GitHub reports (it drops them
  // silently for a token without push access), so step 3 sets them again when they are missing.
  const missing = BOARD_IDS.filter((b) => !issues[b] && result.create.includes(b) && !oversize.has(b));
  if (missing.length > 0) await ensureLabels(gh, repo, warn);
  for (const b of missing) {
    const r = await gh.call('POST', `/repos/${repo}/issues`, { title: BOARDS[b], body: result.bodies[b], labels: result.labels[b] });
    if (!r.ok || !Number.isInteger(r.json?.number)) {
      error(`cannot create the board "${BOARDS[b]}": ${r.message}`);
      saved = false;
      continue;
    }
    const labels = (Array.isArray(r.json.labels) ? r.json.labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string');
    const issue = { number: r.json.number, nodeId: typeof r.json.node_id === 'string' ? r.json.node_id : null, body: result.bodies[b], state: 'open', locked: false, labels };
    issues[b] = issue;
    created.add(b);
    if (issue.nodeId) {
      const pin = await gh.graphql(PIN_MUTATION, { issueId: issue.nodeId });
      if (!pin.ok) warn(`cannot pin board #${issue.number}: ${pin.message}`);
    } else warn(`cannot pin board #${issue.number}: the created issue has no node id`);
    const lock = await gh.call('PUT', lockPath(repo, issue.number));
    if (lock.ok) issue.locked = true;
    else warn(`cannot lock board #${issue.number}: ${lock.message}`);
    log(`created board #${issue.number} "${BOARDS[b]}"`);
  }

  // 2. The comments, before the bodies that record them as posted.
  const failed = [];
  for (const c of result.comments) {
    if (oversize.has(c.board)) continue;
    const issue = issues[c.board];
    const r = issue ? await postComment({ gh, repo, issue, body: c.body, sleep, log, warn }) : { ok: false, message: 'the board does not exist' };
    if (r.ok) {
      log(`commented on board #${issue.number}`);
      continue;
    }
    error(`cannot comment on board "${BOARDS[c.board]}": ${r.message}; ${c.keys.map((k) => k.key).join(', ')} rolled back, so the next run posts it again (and reports watcher:reconcile)`);
    failed.push({ comment: c, message: r.message });
  }
  const out = failed.length > 0 ? withFailedComments(result, failed) : result;

  // 3. Bodies, locks and labels.
  for (const b of BOARD_IDS) {
    const issue = issues[b];
    const body = out.bodies[b];
    if (!issue || body === null || body === undefined || oversize.has(b)) continue;
    const n = issue.number;
    if (!issue.locked) {
      const lock = await gh.call('PUT', lockPath(repo, n));
      if (lock.ok) log(`re-locked board #${n}`);
      else warn(`cannot re-lock board #${n}: ${lock.message}`);
    }
    const reopen = issue.state === 'closed' && Object.values(out.state[b]?.entries ?? {}).some((e) => e.open);
    if (body !== issue.body || reopen) {
      const patch = () => gh.call('PATCH', `/repos/${repo}/issues/${n}`, reopen ? { body, state: 'open' } : { body });
      const r = await writeUnlocked({ gh, repo, issue, what: 'save its body', write: patch, log, warn });
      if (r.ok) log(`updated board #${n}${reopen ? ' (reopened)' : ''}`);
      else {
        error(`cannot update board #${n}: ${r.message} (its state is not saved: every rule's memory of this run is lost)`);
        saved = false;
      }
    }
    const labels = result.labels[b];
    const desired = [...labels, ...issue.labels.filter((l) => !OUR_LABELS.has(l))];
    const same = desired.length === issue.labels.length && desired.every((l) => issue.labels.includes(l));
    if (!same) {
      let r = await gh.call('PUT', `/repos/${repo}/issues/${n}/labels`, { labels: desired });
      if (r.status === 422) {
        await ensureLabels(gh, repo, warn);
        r = await gh.call('PUT', `/repos/${repo}/issues/${n}/labels`, { labels: desired });
      }
      if (r.ok) continue;
      if (created.has(b) && !issue.labels.includes(BOARD_LABEL)) {
        // The boards are found by this label: without it the next run creates the board again, and again.
        error(`cannot label the new board #${n} ${BOARD_LABEL}: ${r.message} (the next run would not find it and would create it again)`);
        saved = false;
      } else warn(`cannot set the labels of board #${n}: ${r.message}`);
    }
  }

  // 4. Duplicates (readBoards), once every board is saved with the newest state: renamed, unlabelled, unpinned and
  // closed, so no listing finds them again. A step that fails is a warning; the next run tries again.
  if (saved) for (const b of BOARD_IDS) for (const d of issues[b]?.duplicates ?? []) await retireDuplicate({ gh, repo, board: b, number: issues[b].number, duplicate: { ...d }, log, warn });

  // 5. The daily pin check.
  if (pinned.length > 0) await checkPins({ gh, repo, issues: pinned, log, warn });
  return { saved, failedComments: failed.length };
}

const UNPIN_MUTATION = 'mutation($issueId: ID!) { unpinIssue(input: {issueId: $issueId}) { issue { number } } }';

/** Retire a duplicate board: renamed "... (duplicate of #N)" and closed, then unlabelled and unpinned. */
async function retireDuplicate({ gh, repo, board, number, duplicate, log, warn }) {
  const n = duplicate.number;
  const close = () => gh.call('PATCH', `/repos/${repo}/issues/${n}`, { title: `${BOARDS[board]} (duplicate of #${number})`, state: 'closed', state_reason: 'not_planned' });
  const r = await writeUnlocked({ gh, repo, issue: duplicate, what: 'retire it', write: close, log, warn });
  if (!r.ok) {
    warn(`cannot retire the duplicate board #${n}: ${r.message} (the next run tries again)`);
    return;
  }
  const labels = await gh.call('PUT', `/repos/${repo}/issues/${n}/labels`, { labels: duplicate.labels.filter((l) => !OUR_LABELS.has(l)) });
  if (!labels.ok) warn(`cannot unlabel the retired duplicate #${n}: ${labels.message}`);
  if (duplicate.pinned === true && duplicate.nodeId) {
    const unpin = await gh.graphql(UNPIN_MUTATION, { issueId: duplicate.nodeId });
    if (!unpin.ok) warn(`cannot unpin the retired duplicate #${n}: ${unpin.message}`);
  }
  log(`retired the duplicate board #${n} (the board is #${number})`);
}

/** POST each ping (the reason as the body), 3 tries with a 10 s timeout each. The URL never reaches a log line. */
async function sendPings({ pings, key, fetchImpl, sleep, log }) {
  for (const p of pings) {
    const url = pingUrl(key, p.check, p.signal);
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await sleep(BACKOFF_MS[Math.min(attempt - 2, BACKOFF_MS.length - 1)]);
      last = await request(fetchImpl, url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8', 'user-agent': 'earthquakes-feed-health' },
        body: oneLine(p.reason, PING_REASON_CHARS),
        timeoutMs: PING_TIMEOUT_MS,
      });
      if (last.ok || (last.status >= 400 && last.status < 500)) break;
    }
    const signal = p.signal === 'fail' ? '/fail' : '/0';
    if (last?.ok) log(`pinged ${p.check} ${signal}`);
    else {
      const why = String(last?.status ? `HTTP ${last.status}` : (last?.message ?? 'not sent')).split(url).join('<ping URL>').split(key).join('***');
      log(annotation('warning', 'Health ping', `${p.check} ${signal} failed after 3 tries: ${why}`));
    }
  }
}

/** Every findings document of the directory; an unreadable or invalid file marks its evaluator missing. */
function readFindingsDir(dir, { readDir, readFile }) {
  const docs = [];
  const missing = {};
  const notes = [];
  let names;
  try {
    names = readDir(dir);
  } catch (e) {
    for (const ev of EVALUATORS) missing[ev] = 'no findings directory (no evaluator artifact was downloaded)';
    notes.push(`cannot read ${dir}: ${errMsg(e)}`);
    return { docs, missing, notes };
  }
  for (const name of [...names].filter((n) => typeof n === 'string' && n.endsWith('.json')).sort()) {
    const stem = name.slice(0, -'.json'.length);
    let value;
    try {
      value = JSON.parse(readFile(join(dir, name)));
    } catch (e) {
      if (EVALUATORS.includes(stem)) missing[stem] = oneLine(`${name} is unreadable: ${errMsg(e)}`, 200);
      notes.push(`${name} is unreadable: ${errMsg(e)}`);
      continue;
    }
    const r = parseFindingsDocument(value);
    if (!r.ok) {
      const ev = isObject(value) && EVALUATORS.includes(value.evaluator) ? value.evaluator : EVALUATORS.includes(stem) ? stem : null;
      if (ev) missing[ev] = oneLine(`${name} is not a valid findings document: ${r.error}`, 200);
      notes.push(`${name} is not a valid findings document: ${r.error}`);
      continue;
    }
    docs.push(r.doc);
  }
  return { docs, missing, notes };
}

async function runGate({ env, fetchImpl, nowMs, sleep, log, appendFile }) {
  const eventName = env.EVENT || env.GITHUB_EVENT_NAME || '';
  const schedule = env.SCHEDULE ?? '';
  let dispatchedRuns = [];
  if (eventName === 'schedule' && schedule.trim() === HEALTH_FALLBACK_CRON) {
    dispatchedRuns = null;
    if (env.GH_TOKEN && env.GITHUB_REPOSITORY) {
      const gh = githubClient({ token: env.GH_TOKEN, fetchImpl, sleep });
      const r = await gh.call('GET', `/repos/${env.GITHUB_REPOSITORY}/actions/workflows/health.yml/runs?event=workflow_dispatch&per_page=10`);
      if (r.ok && Array.isArray(r.json?.workflow_runs)) dispatchedRuns = r.json.workflow_runs.filter(isObject);
      else log(`gate: cannot list the dispatched health runs (${r.message})`);
    } else log('gate: GH_TOKEN or GITHUB_REPOSITORY unset');
  }
  const g = scheduleGate({ eventName, schedule, selftestInput: env.SELFTEST_INPUT, dispatchedRuns, nowMs });
  log(`gate: run=${g.run} selftest=${g.selftest}: ${g.reason}`);
  const out = `run=${g.run ? 'true' : 'false'}\nselftest=${g.selftest ? '1' : '0'}\n`;
  if (env.GITHUB_STEP_SUMMARY && !g.run) {
    try {
      appendFile(env.GITHUB_STEP_SUMMARY, `### Health gate\n\nSkipped: ${g.reason}.\n`);
    } catch {
      /* the summary is a convenience */
    }
  }
  if (!env.GITHUB_OUTPUT) {
    log(out.trim());
    return 0;
  }
  try {
    appendFile(env.GITHUB_OUTPUT, out);
  } catch (e) {
    log(annotation('error', 'Health gate', `cannot write GITHUB_OUTPUT: ${errMsg(e)}`));
    return 1;
  }
  return 0;
}

/**
 * Run the gate or a reconcile. Everything with a side effect is injectable so tests stay offline.
 * @returns {Promise<number>} the exit code
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = sleepMs,
  log = console.log,
  readFile = (p) => readFileSync(p, 'utf8'),
  readDir = (p) => readdirSync(p),
  appendFile = (p, s) => appendFileSync(p, s),
} = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    log(annotation('error', 'Health reconcile misconfigured', errMsg(e)));
    return 3;
  }
  const nowMs = now();
  if (opts.gate) return runGate({ env, fetchImpl, nowMs, sleep, log, appendFile });

  const repo = env.GITHUB_REPOSITORY ?? '';
  const token = env.GH_TOKEN ?? '';
  const runId = env.GITHUB_RUN_ID ?? null;
  const runUrl = repo && runId ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${runId}` : null;
  const pingKey = env.HC_PING_KEY ?? '';
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const errors = [];
  const error = (m) => errors.push(m);
  const { silences, errors: silenceErrors } = parseSilences(env.HEALTH_SILENCES ?? '', nowMs);
  const { docs, missing, notes } = readFindingsDir(opts.findingsDir, { readDir, readFile });
  for (const n of notes) log(`reconcile: ${n}`);
  log(`reconcile: findings from ${docs.map((d) => `${d.evaluator} (${d.findings.length})`).join(', ') || 'no evaluator'}`);

  const gh = token && repo ? githubClient({ token, fetchImpl, sleep }) : null;
  let numbersText = null;
  try {
    numbersText = readFile(BOARD_NUMBERS_FILE);
  } catch {
    numbersText = null;
  }
  const { numbers, error: numbersError } = parseBoardNumbers(numbersText);
  let read;
  if (numbersError) read = { ok: false, message: numbersError };
  else if (gh) read = await readBoards(gh, repo, numbers);
  else if (opts.dryRun) read = { ok: true, boards: {}, warnings: ['GH_TOKEN or GITHUB_REPOSITORY unset: the dry run starts from empty boards'] };
  else read = { ok: false, message: 'GH_TOKEN or GITHUB_REPOSITORY unset (misconfigured)' };

  const writeSummary = (text) => {
    if (!env.GITHUB_STEP_SUMMARY) return;
    try {
      appendFile(env.GITHUB_STEP_SUMMARY, text);
    } catch {
      /* the summary is a convenience */
    }
  };

  if (!read.ok) {
    // Nothing written, no pings, and red (exit 3): the prior state is unknown, so no hold, ratio or resolve can be
    // applied, and alerting itself is broken. The P1/P2 findings of this run are listed, so the red run names them.
    const findings = docs.flatMap((d) => d.findings);
    const urgent = findings.filter((f) => (redSeverity(f.severity) && !f.shadow && mayTurnRed(f.class)) || f.key === SELFTEST_KEY);
    log(annotation('error', null, `boards unreadable (${read.message}): nothing was written and no ping was sent`));
    for (const f of findings.filter((x) => notifiable(x.severity)).sort((a, b) => severityRank(a.severity) - severityRank(b.severity))) {
      log(annotation(f.shadow ? 'notice' : redSeverity(f.severity) ? 'error' : 'warning', `${f.severity} ${f.key}`, f.text));
    }
    const named = urgent.length > 0 ? `; P1/P2 findings present this run: ${urgent.map((f) => `${f.severity} \`${f.key}\``).join(', ')}` : '';
    writeSummary(`### Health reconcile\n\n**Boards unreadable** (${md(read.message)}): nothing was written and no ping was sent; the run is red (exit 3: alerting itself is broken)${named}.\n`);
    log(`reconcile: the run is red (the boards are unreadable${urgent.length > 0 ? `, and ${urgent.length} P1/P2 finding(s) are present` : ''})`);
    return 3;
  }
  for (const w of read.warnings) warn(w);

  const prevState = {};
  for (const b of BOARD_IDS) prevState[b] = read.boards[b] ? mergedBoardState(read.boards[b].stateBodies.map((body) => parseBoardState(body, b))) : null;
  for (const b of BOARD_IDS) if (read.boards[b] && prevState[b] === null) warn(`board #${read.boards[b].number} "${BOARDS[b]}" has no readable state marker: it starts empty`);
  const result = reconcile(prevState, docs, nowMs, silences, {
    runId,
    runUrl,
    eventName: env.GITHUB_EVENT_NAME ?? null,
    missing,
    existing: Object.keys(read.boards),
    pingsEnabled: Boolean(pingKey) && !opts.dryRun,
    silenceErrors,
  });

  if (opts.dryRun) {
    for (const b of BOARD_IDS) {
      if (result.bodies[b] === null) continue;
      log(`----- ${read.boards[b] ? `board #${read.boards[b].number}` : 'new board'} "${BOARDS[b]}" (labels ${result.labels[b].join(', ')}) -----`);
      log(result.bodies[b]);
    }
    for (const c of result.comments) log(`----- comment on "${BOARDS[c.board]}" -----\n${c.body}`);
    for (const p of result.pings) log(`ping (dry run, not sent): ${p.check} ${p.signal === 'fail' ? '/fail' : '/0'}`);
    for (const a of result.annotations) log(a);
    for (const w of warnings) log(annotation('warning', 'Health reconcile', w));
    log(`reconcile (dry run): the run would be ${result.exitCode === 1 ? 'red' : 'green'}`);
    return result.exitCode;
  }

  let written = { saved: true, failedComments: 0 };
  if (!result.replay) written = await writeBoards({ result, read, gh, repo, sleep, log, warn, error });
  else log('reconcile: every findings document was already applied (an overlapping run or a rerun): nothing to write');
  // A comment that fails once is retried by the next run; failing on two runs in a row, it turns the run red, because
  // watcher:reconcile's own comment cannot reach anyone either.
  const commentsBroken = written.failedComments > 0 && result.commentFaultsBefore > 0;
  if (commentsBroken) error(`board comments failed on two runs in a row (${result.commentFaultsBefore} on the last run, ${written.failedComments} on this one): the P3 notices are not reaching anyone`);

  if (!pingKey) log('pings skipped (HC_PING_KEY unset)');
  else await sendPings({ pings: result.pings, key: pingKey, fetchImpl, sleep, log });

  for (const a of result.annotations) log(a);
  for (const e of errors) log(annotation('error', 'Health reconcile', e));
  for (const w of warnings) log(annotation('warning', 'Health reconcile', w));
  const problems = [...errors.map((e) => `- error: ${md(e)}`), ...warnings.map((w) => `- warning: ${md(w)}`)];
  writeSummary(`${result.summary}${problems.length > 0 ? `\n${problems.join('\n')}\n` : ''}`);
  // A board body that was not created or saved (every rule's memory of this run is lost), or comments that keep
  // failing: alerting itself is broken.
  const broken = !written.saved || commentsBroken;
  const code = broken ? 3 : result.exitCode;
  const why = !written.saved ? ' (a board could not be written)' : commentsBroken ? ' (board comments failed on two runs in a row)' : '';
  log(`reconcile: the run is ${code === 0 ? 'green' : `red${why}`}`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(annotation('error', 'Health reconcile crashed', errMsg(e)));
      process.exitCode = 3;
    },
  );
}
