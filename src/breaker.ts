import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BREAKER_MASS_FAILURE_SHARE,
  BREAKER_MASS_MIN_ASKED,
  BREAKER_RUN_INTERVAL_MS,
  BREAKER_SKIP_RUNS,
  BREAKER_TRIP_RUNS,
  DELETE_SWEEP_PROVIDERS,
  UPDATED_SWEEP_PROVIDERS,
} from './config.js';
import { isPinnedCertError } from './custom.js';
import type { FetchOutcome } from './providers.js';
import type { BreakerStatus, ProviderConfig, ProviderStatus } from './types.js';
import { isoFromMs } from './util.js';

/**
 * Live-fetch circuit breaker (SHLTR-147). The live fetches run in parallel, so a run's fetch phase lasts as long as its
 * slowest source, and a source that does not answer costs its whole timeout on every run (NOA on 2026-11-08: 15 s on
 * its host plus 15 s on its fallback host, every run). After BREAKER_TRIP_RUNS consecutive runs without an answer the
 * breaker opens: the source is not asked for BREAKER_SKIP_RUNS runs (2, 4, 8, then 12 as it keeps failing), then one
 * run probes it (half-open). Any answer, an HTTP error included, closes it; no answer opens it again with the next,
 * longer back-off. A skipped source's status is `ok: false` with `skipped: "breaker"`, so everything that reads `ok`
 * (degraded, the activity index, silent and frozen, lastSuccessAt, the health board) sees it exactly as a failing one.
 *
 * The state is knowledge/index/provider_breakers.json on the data branch, written in the aggregate's commit; a missing
 * or unreadable file, or an unreadable entry, means closed.
 *
 * Not tracked: the sources with a sweep (usgs, emsc): their sweeps ask the same host every run with a budget of their
 * own, so skipping the live fetch would save no time, and they are the feed's backbone; and the sources the live path
 * does not ask (`liveActive: false`).
 */

/** One source's breaker in knowledge/index/provider_breakers.json. A closed breaker with no failure has no entry. */
export interface BreakerRecord {
  /** Consecutive runs without an answer (probes included). */
  failures: number;
  /** The last such run's error message. */
  lastError: string;
  /** ms epoch of the run that opened it (kept while it re-opens); absent while closed. */
  openSinceMs?: number;
  /** How many times it has opened in a row (1 on the first opening): picks the back-off. */
  opens?: number;
  /** Runs it skips before the next probe. */
  skipRuns?: number;
  /** ms epoch from which a run probes it. */
  nextProbeMs?: number;
}
export type BreakerIndex = Record<string, BreakerRecord>;

const SWEPT: ReadonlySet<string> = new Set([...UPDATED_SWEEP_PROVIDERS, ...DELETE_SWEEP_PROVIDERS]);

/** Whether a source has a breaker at all. */
export const breakerTracked = (p: Pick<ProviderConfig, 'id' | 'liveActive'>): boolean => p.liveActive !== false && !SWEPT.has(p.id);

const isOpen = (r: BreakerRecord | undefined): r is BreakerRecord & Required<Pick<BreakerRecord, 'openSinceMs' | 'opens' | 'skipRuns' | 'nextProbeMs'>> =>
  r != null && r.openSinceMs != null && r.opens != null && r.skipRuns != null && r.nextProbeMs != null;

/** Messages of a request that got no answer: an abort (FETCH_TIMEOUT_MS), a custom adapter's own timeout or deadline,
 *  undici's `fetch failed` (refused, reset, DNS), a socket error. */
const NO_ANSWER_RE = /abort|time[d ]?out|deadline|fetch failed|socket hang up|other side closed|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|UND_ERR|network/i;

/**
 * Whether a live fetch got no answer: failed without an HTTP status and with a timeout or connection error (or none at
 * all: an AggregateError of a connect attempt to several addresses has an empty message, PHIVOLCS). An HTTP error
 * (`http_status`, or a custom adapter's `HTTP 503`), an empty answer, a parse error and a pinned source's certificate
 * failure are answers: the host replied (quickly), and the certificate failure keeps its own `tls_errors` record, which
 * a skip would let lapse.
 */
export function isNoAnswer(s: Pick<ProviderStatus, 'ok' | 'http_status' | 'error'>): boolean {
  if (s.ok || s.http_status != null) return false;
  const e = s.error ?? '';
  if (/\bHTTP \d{3}\b/.test(e) || isPinnedCertError(e)) return false;
  return e.trim() === '' || NO_ANSWER_RE.test(e);
}

/** FNV-1a of a string, as a fraction in [0, 1): the jitter, the same for the same source and run. */
function unitHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 2 ** 32;
}

/** The runs to skip after the `opens`-th opening in a row: BREAKER_SKIP_RUNS (the last entry for every later one),
 *  less a jitter of 0 to a quarter of it picked by the source and the run's seq. */
export function breakerSkipRuns(opens: number, id: string, seq: number): number {
  const base = BREAKER_SKIP_RUNS[Math.min(Math.max(opens, 1), BREAKER_SKIP_RUNS.length) - 1]!;
  return base - Math.floor(unitHash(`${id}:${seq}`) * (Math.floor(base / 4) + 1));
}

/** The first run at or after this time probes: `skipRuns` runs are skipped, the next one asks. */
const nextProbeAt = (nowMs: number, skipRuns: number): number => nowMs + (skipRuns + 1) * BREAKER_RUN_INTERVAL_MS - BREAKER_RUN_INTERVAL_MS / 2;

function validRecord(r: unknown): r is BreakerRecord {
  if (r == null || typeof r !== 'object' || Array.isArray(r)) return false;
  const x = r as Record<string, unknown>;
  const int = (v: unknown, min: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= min;
  const time = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!int(x.failures, 1) || typeof x.lastError !== 'string') return false;
  const open = ['openSinceMs', 'opens', 'skipRuns', 'nextProbeMs'].filter((k) => x[k] !== undefined);
  if (open.length === 0) return true;
  return open.length === 4 && time(x.openSinceMs) && time(x.nextProbeMs) && int(x.opens, 1) && int(x.skipRuns, 0);
}

/** The persisted index: an entry that does not read as a breaker is dropped (closed), a file that does not parse is no
 *  breaker at all; neither stops the run. */
export function loadBreakers(path: string): { index: BreakerIndex; dropped: string[] } {
  if (!existsSync(path)) return { index: {}, dropped: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { index: {}, dropped: ['(the file does not parse)'] };
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { index: {}, dropped: ['(the file is not an object)'] };
  const index: BreakerIndex = {};
  const dropped: string[] = [];
  for (const [id, r] of Object.entries(raw as Record<string, unknown>)) {
    if (validRecord(r)) index[id] = r;
    else dropped.push(id);
  }
  return { index, dropped };
}

export function saveBreakers(path: string, index: BreakerIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(Object.keys(index).sort().map((k) => [k, index[k]]));
  writeFileSync(path, JSON.stringify(sorted, null, 1) + '\n');
}

/** status.json `providers.<id>.breaker` of an open breaker. */
export function breakerStatus(r: BreakerRecord): BreakerStatus | undefined {
  if (!isOpen(r)) return undefined;
  return { open_since: isoFromMs(r.openSinceMs), next_probe: isoFromMs(r.nextProbeMs), failures: r.failures, skip_runs: r.skipRuns };
}

export interface BreakerPlan {
  /** The sources not asked this run, with the status each gets instead of an answer. */
  skipped: Record<string, ProviderStatus>;
  /** The sources whose open breaker is probed this run. */
  probing: string[];
}

/** This run's skips and probes. */
export function breakerPlan(index: BreakerIndex, active: readonly ProviderConfig[], nowMs: number): BreakerPlan {
  const skipped: Record<string, ProviderStatus> = {};
  const probing: string[] = [];
  for (const p of active) {
    const r = index[p.id];
    if (!breakerTracked(p) || !isOpen(r)) continue;
    if (nowMs >= r.nextProbeMs) {
      probing.push(p.id);
      continue;
    }
    skipped[p.id] = {
      ok: false,
      skipped: 'breaker',
      error: `not asked: circuit breaker open after ${r.failures} runs without an answer (last: ${r.lastError || 'no message'})`,
      breaker: breakerStatus(r)!,
    };
  }
  return { skipped, probing };
}

export interface BreakerUpdate {
  index: BreakerIndex;
  /** Opened this run (the BREAKER_TRIP_RUNS-th run without an answer). */
  opened: string[];
  /** Probed this run without an answer: open again, with a longer back-off. */
  reopened: string[];
  /** Open before this run and answered now. */
  closed: string[];
  /** More than BREAKER_MASS_FAILURE_SHARE of the sources asked got no answer: no failure was counted. */
  massFailure: boolean;
}

/**
 * The index after a run. A source asked this run: an answer closes its breaker (and clears its count); no answer counts
 * one more failure, opens the breaker at BREAKER_TRIP_RUNS, and re-opens a probed one with the next back-off. A skipped
 * source keeps its entry as it was. In a mass failure, the failures of this run are not counted (entries stay as they
 * were, so a probe that met it probes again next run). Entries of sources no longer tracked are dropped. `seq` (the
 * run's head seq) picks the jitter.
 */
export function updateBreakers(
  prev: BreakerIndex,
  outcomes: readonly FetchOutcome[],
  plan: BreakerPlan,
  active: readonly ProviderConfig[],
  nowMs: number,
  seq: number,
): BreakerUpdate {
  const tracked = new Set(active.filter(breakerTracked).map((p) => p.id));
  const liveAsked = new Set(active.filter((p) => p.liveActive !== false).map((p) => p.id));
  const asked = outcomes.filter((o) => liveAsked.has(o.provider) && !Object.hasOwn(plan.skipped, o.provider));
  const noAnswer = asked.filter((o) => isNoAnswer(o.status)).length;
  const massFailure = asked.length >= BREAKER_MASS_MIN_ASKED && noAnswer > asked.length * BREAKER_MASS_FAILURE_SHARE;
  const index: BreakerIndex = {};
  const opened: string[] = [];
  const reopened: string[] = [];
  const closed: string[] = [];
  for (const id of Object.keys(plan.skipped)) if (tracked.has(id) && prev[id]) index[id] = prev[id]!;
  for (const o of asked) {
    if (!tracked.has(o.provider)) continue;
    const r = prev[o.provider];
    if (!isNoAnswer(o.status)) {
      if (isOpen(r)) closed.push(o.provider);
      continue;
    }
    if (massFailure) {
      if (r) index[o.provider] = r;
      continue;
    }
    const failures = (r?.failures ?? 0) + 1;
    const lastError = o.status.error ?? '';
    if (isOpen(r) || failures >= BREAKER_TRIP_RUNS) {
      const opens = isOpen(r) ? r.opens + 1 : 1;
      const skipRuns = breakerSkipRuns(opens, o.provider, seq);
      index[o.provider] = { failures, lastError, openSinceMs: isOpen(r) ? r.openSinceMs : nowMs, opens, skipRuns, nextProbeMs: nextProbeAt(nowMs, skipRuns) };
      (isOpen(r) ? reopened : opened).push(o.provider);
    } else {
      index[o.provider] = { failures, lastError };
    }
  }
  return { index, opened, reopened, closed, massFailure };
}
