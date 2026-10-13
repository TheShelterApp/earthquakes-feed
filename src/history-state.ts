import { type AttemptEntry, type HistoryIndex, rawOf } from './history-index.js';

/**
 * Deep history (PF-5j): `knowledge/index/history-state.json` on the `data` branch, the walk's own bookkeeping beside
 * its index (round 24). The index (`history.json`, about 2.5 MB at the end of era A) lists the published assets and
 * changes only when the walk publishes or adopts something; this small file holds what changes from run to run while a
 * source month keeps failing or the walk makes no progress: the failure streak of each source month (`attempts`, in the
 * index's `attempts` until round 24) and the no-progress streak (`stall`). Before, every run in which a month failed
 * rewrote the whole index to count one more failure (about 150 commits of 2.3 MB in the week of EMSC's 2017-12).
 *
 * Only the history workflow writes it, in the same commit as the index, so the two never disagree; it is written with a
 * stable layout and has no per-run timestamp, so a run that changes no counter commits nothing.
 */

export const HISTORY_STATE_VERSION = 1;

/** A run of the walk in which work was left (source months to fetch or complete months to seal) and nothing was
 *  fetched, sealed or adopted: the streak of such runs. */
export interface StallEntry {
  /** The first run of the streak. */
  since: string;
  /** Runs in the streak. */
  runs: number;
  /** Those of them that no Retry-After and no time budget explain. */
  unexplained: number;
  /** When the streak last turned a run red; null before the first time. */
  alarmed_at: string | null;
}

export interface HistoryState {
  version: typeof HISTORY_STATE_VERSION;
  /** Keyed `<source>:<YYYY-MM>`: a source month whose fetch failed, until it succeeds (then the entry goes). */
  attempts: Record<string, AttemptEntry>;
  stall: StallEntry | null;
}

/** Unexplained no-progress runs in a row that turn the run red: a day of hourly runs. */
export const STALL_ALARM_RUNS = 24;
/** No-progress runs in a row, explained or not, that turn the run red: a walk that only ever waits for a Retry-After or
 *  runs out of its time budget inside the same month (a month never fetched whole within maxSecondsPerRun is asked
 *  from its start again each run) has stopped too, three days on. */
export const STALL_ALARM_RUNS_ANY = 72;
/** While the stall lasts it turns one run a day red. 23 h, not 24: the hourly runs start some minutes apart, and the
 *  repeat must not slip to the next hour's run every day. */
export const STALL_REPEAT_MS = 23 * 3_600_000;

export const emptyState = (): HistoryState => ({ version: HISTORY_STATE_VERSION, attempts: {}, stall: null });

export function parseState(text: string): HistoryState {
  const s = JSON.parse(text) as HistoryState;
  if (s.version !== HISTORY_STATE_VERSION) throw new Error(`history state version ${String(s.version)} is not ${HISTORY_STATE_VERSION}`);
  s.attempts ??= {};
  s.stall ??= null;
  return s;
}

/** One line per attempt, keys sorted: a run that changes one month's streak changes one line. */
export function stateText(s: HistoryState): string {
  const attempts = Object.entries(s.attempts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const att = attempts.length ? `{\n${attempts.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n  }` : '{}';
  return `{\n  "version": ${s.version},\n  "attempts": ${att},\n  "stall": ${JSON.stringify(s.stall)}\n}\n`;
}

/**
 * The walk's state for a run, from the index and the state file as the data branch holds them. The index's own
 * `attempts` is empty since round 24; when it is not, it was written by a walk that kept its streaks there (the first
 * run of round 24, or a walk reverted to that layout), which ran after the state file was last written: those streaks
 * are the current ones. The returned state's `attempts` is the very object the run works on: `idx.attempts`.
 */
export function loadState(idx: HistoryIndex, text: string | null): HistoryState {
  const s = text ? parseState(text) : emptyState();
  if (Object.keys(idx.attempts).length) s.attempts = idx.attempts;
  idx.attempts = s.attempts;
  return s;
}

/** The two files a run leaves: the index without the streaks, and the state with them. A streak of a source month the
 *  index now holds (fetched by a run whose commit never landed, then adopted) is dropped. */
export function walkTexts(idx: HistoryIndex, s: HistoryState, indexText: (i: HistoryIndex) => string): { index: string; state: string } {
  for (const key of Object.keys(idx.attempts)) {
    const at = key.lastIndexOf(':');
    if (rawOf(idx, key.slice(0, at), key.slice(at + 1))) delete idx.attempts[key];
  }
  return { index: indexText({ ...idx, attempts: {} }), state: stateText({ ...s, attempts: idx.attempts }) };
}

/** What a run did, for the no-progress streak. */
export interface RunOutcome {
  /** Fetched, sealed or adopted anything. */
  progress: boolean;
  /** Source months left to fetch or complete months left to seal after the run. */
  workLeft: boolean;
  /** The run ended its fetching on the time budget or left a source to its Retry-After, and nothing else failed. */
  explained: boolean;
}

/**
 * Count the run into the no-progress streak (`s.stall`). True when this run turns red for it: the streak has reached
 * STALL_ALARM_RUNS unexplained runs or STALL_ALARM_RUNS_ANY runs, and it has not turned a run red in the last
 * STALL_REPEAT_MS. Progress, or no work left, ends the streak.
 */
export function recordRun(s: HistoryState, o: RunOutcome, nowIso: string): boolean {
  if (o.progress || !o.workLeft) {
    s.stall = null;
    return false;
  }
  const st = (s.stall ??= { since: nowIso, runs: 0, unexplained: 0, alarmed_at: null });
  st.runs++;
  if (!o.explained) st.unexplained++;
  if (st.unexplained < STALL_ALARM_RUNS && st.runs < STALL_ALARM_RUNS_ANY) return false;
  if (st.alarmed_at != null && Date.parse(nowIso) - Date.parse(st.alarmed_at) < STALL_REPEAT_MS) return false;
  st.alarmed_at = nowIso;
  return true;
}
