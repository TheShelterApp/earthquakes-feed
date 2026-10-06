import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveLookbackMs } from './providers.js';
import type { ProviderConfig, ProviderStatus, TlsLeafStatus } from './types.js';
import { isoFromMs } from './util.js';

/**
 * Silent-provider detection (FEED-3). A source whose fetch succeeds with no rows looks healthy to the per-run status,
 * so a node that went empty stayed green for days: NOA's registered node answered 204 to every query from 2026-09-24
 * (352 Greek events lost, PF-5j-NOA), and on 2026-10-04 the status history showed three custom sources that had not
 * returned a row for 47 to 67 days (ENSN Egypt since 2026-07-29 12:06, Geoscience Australia since 07-30 00:09, TMD
 * since 08-18 03:56 UTC), every run of them `ok`.
 *
 * Each run records, per source, the last time its answer had rows (`lastNonEmptyAt`, knowledge/index/
 * provider_activity.json). A source is SILENT when that is longer ago than its activity budget: 12 h by default (an
 * active agency's 2-day query window is never empty that long), `activityBudgetHours` in the registry for a quiet one
 * (72 h), `null` for a source that may stay quiet for weeks, and no budget at all for a source the live path does not
 * ask (`liveActive: false`). A silent source is listed in status.json `silent` and counted in `degraded`.
 *
 * Calibrated on the status history 2026-07-05 → 2026-10-04 (26,890 runs): with these budgets, every silence the
 * history holds past a budget is either a fetch outage (already failing) or one of the dead sources above.
 */
export const DEFAULT_ACTIVITY_BUDGET_HOURS = 12;

const HOUR_MS = 3_600_000;

export interface ActivityRecord {
  /** ms epoch of the last run whose answer had rows; null = none seen since `sinceMs`. */
  lastNonEmptyAt: number | null;
  /** ms epoch from which the record counts (its first run, or the oldest status-history line it was seeded from). */
  sinceMs: number;
  /** Pinned sources (tlsIntermediates): the leaf certificate last read from the host, kept so a run whose handshake
   *  fails (an expired leaf) still shows when it expired. */
  tlsLeaf?: { notAfterMs: number; issuer: string | null; subject: string | null; seenAt: number };
}
export type ActivityIndex = Record<string, ActivityRecord>;

export interface SilentEntry {
  /** ISO time of the last answer with rows, or null when none was seen since `counted_from`. */
  last_non_empty_at: string | null;
  counted_from: string;
  silent_hours: number;
  budget_hours: number;
}

/** A source's activity budget in hours, or null when it has none (never reported silent). */
export function activityBudgetHours(p: Pick<ProviderConfig, 'liveActive' | 'activityBudgetHours'>): number | null {
  if (p.liveActive === false) return null;
  if (p.activityBudgetHours === null) return null;
  if (typeof p.activityBudgetHours === 'number' && p.activityBudgetHours > 0) return p.activityBudgetHours;
  return DEFAULT_ACTIVITY_BUDGET_HOURS;
}

const hasRows = (s: Pick<ProviderStatus, 'ok' | 'events_returned'>): boolean => s.ok && (s.events_returned ?? 0) > 0;

/** This run's answers into the index: a source with rows is active now; a new source starts its clock now. A leaf
 *  certificate read in this run (pinned sources) replaces the one kept. */
export function updateActivity(
  prev: ActivityIndex,
  statuses: Record<string, Pick<ProviderStatus, 'ok' | 'events_returned'>>,
  nowMs: number,
  leaves: Record<string, { notAfterMs: number; issuer: string | null; subject: string | null }> = {},
): ActivityIndex {
  const next: ActivityIndex = { ...prev };
  for (const [id, s] of Object.entries(statuses)) {
    const rec = next[id] ?? { lastNonEmptyAt: null, sinceMs: nowMs };
    next[id] = hasRows(s) ? { ...rec, lastNonEmptyAt: nowMs } : rec;
  }
  for (const [id, leaf] of Object.entries(leaves)) {
    const rec = next[id] ?? { lastNonEmptyAt: null, sinceMs: nowMs };
    next[id] = { ...rec, tlsLeaf: { ...leaf, seenAt: nowMs } };
  }
  return next;
}

/** The sources past their budget, by id (only those the registry still asks). */
export function silentProviders(index: ActivityIndex, providers: ProviderConfig[], nowMs: number): Record<string, SilentEntry> {
  const out: Record<string, SilentEntry> = {};
  for (const p of providers) {
    const budget = activityBudgetHours(p);
    const rec = index[p.id];
    if (budget == null || !rec) continue;
    const from = rec.lastNonEmptyAt ?? rec.sinceMs;
    const silentMs = nowMs - from;
    if (silentMs <= budget * HOUR_MS) continue;
    out[p.id] = {
      last_non_empty_at: rec.lastNonEmptyAt != null ? isoFromMs(rec.lastNonEmptyAt) : null,
      counted_from: isoFromMs(rec.sinceMs),
      silent_hours: Math.round(silentMs / HOUR_MS * 10) / 10,
      budget_hours: budget,
    };
  }
  return out;
}

/**
 * Frozen sources (FEED-3's blind spot, round 14). A source whose file stops being regenerated but is still served answers
 * `ok` with rows for ever, so it is never silent: the rows are just old. A last-N list (ENSN's RSS, BGS, CWA, IG-EPN) or a
 * rolling file (CENC's year) would keep its rows that way; none has done it yet. A source is FROZEN when its answer has
 * rows but the newest origin it lists is older than its query window (2 days, or `lookbackDays`) plus its frozen budget:
 * `frozenBudgetHours`, else three times its activity budget (36 h for an active agency). A source that honours the time
 * window and stops publishing goes silent after the window plus its activity budget; one whose file stands still goes
 * frozen after the window plus the frozen budget. A time-windowed FDSN answer can never be frozen (its newest origin is
 * inside the window); a failed fetch is failing, not frozen.
 * Calibrated on the observation log 2026-07-05 → 10-06 (newest origin per source, hourly): the longest quiet spells of
 * the sources that list without a time window, outside fetch outages, were CENC 59.6 h, GeoSphere 54.1 h, BMKG 51.8 h,
 * IGP 46.2 h, JMA 41.2 h (all others under 31 h): the window of 48 h plus 12 h would have flagged CENC's, so the
 * default is 48 + 36 = 84 h. The last-N lists of BGS (180 h), IG-EPN (168 h) and CWA (157 h) get 216 h (264 h in all).
 */
export interface FrozenEntry {
  newest_origin: string;
  newest_origin_age_hours: number;
  window_hours: number;
  budget_hours: number;
  rows: number;
}

/** The frozen budget is this many activity budgets unless the registry sets `frozenBudgetHours`. */
export const FROZEN_BUDGET_FACTOR = 3;

/** A source's frozen budget in hours, or null when it has none (never reported frozen). */
export function frozenBudgetHours(p: Pick<ProviderConfig, 'liveActive' | 'activityBudgetHours' | 'frozenBudgetHours'>): number | null {
  if (p.liveActive === false) return null;
  if (p.frozenBudgetHours === null) return null;
  if (typeof p.frozenBudgetHours === 'number' && p.frozenBudgetHours > 0) return p.frozenBudgetHours;
  const activity = activityBudgetHours(p);
  return activity == null ? null : activity * FROZEN_BUDGET_FACTOR;
}

export interface Answer {
  ok: boolean;
  events_returned?: number;
  /** ms epoch of the newest origin among the answer's rows (future rows excluded), null with none. */
  newestOriginMs: number | null;
}

/** The sources whose rows stand still past their window plus budget, by id (only those the registry still asks). */
export function frozenProviders(answers: Record<string, Answer>, providers: ProviderConfig[], nowMs: number): Record<string, FrozenEntry> {
  const out: Record<string, FrozenEntry> = {};
  for (const p of providers) {
    const a = answers[p.id];
    const budget = frozenBudgetHours(p);
    if (budget == null || !a || !hasRows(a) || a.newestOriginMs == null) continue;
    const windowHours = liveLookbackMs(p) / HOUR_MS;
    const ageHours = (nowMs - a.newestOriginMs) / HOUR_MS;
    if (ageHours <= windowHours + budget) continue;
    out[p.id] = {
      newest_origin: isoFromMs(a.newestOriginMs),
      newest_origin_age_hours: Math.round(ageHours * 10) / 10,
      window_hours: Math.round(windowHours * 10) / 10,
      budget_hours: budget,
      rows: a.events_returned ?? 0,
    };
  }
  return out;
}

/** status.json's view of a kept leaf certificate: when it expires, how many days are left now, when it was read. */
export function tlsLeafStatus(leaf: NonNullable<ActivityRecord['tlsLeaf']>, nowMs: number): TlsLeafStatus {
  return {
    not_after: isoFromMs(leaf.notAfterMs),
    days_left: Math.round(((leaf.notAfterMs - nowMs) / 86_400_000) * 10) / 10,
    issuer: leaf.issuer,
    subject: leaf.subject,
    seen_at: isoFromMs(leaf.seenAt),
  };
}

/**
 * The first index, from the status history (status/history/YYYY-MM.ndjson, one line per aggregate run): without it a
 * source that went silent before this module existed would look fresh for another budget. Lines are read in file
 * order; a line that does not parse is skipped.
 */
export function seedActivity(statusHistoryDir: string): ActivityIndex {
  const index: ActivityIndex = {};
  if (!existsSync(statusHistoryDir)) return index;
  const files = readdirSync(statusHistoryDir).filter((f) => /^\d{4}-\d{2}\.ndjson$/.test(f)).sort();
  for (const f of files) {
    for (const line of readFileSync(join(statusHistoryDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row: { generated?: unknown; providers?: Record<string, ProviderStatus> };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        continue;
      }
      const t = typeof row.generated === 'string' ? Date.parse(row.generated) : NaN;
      if (!Number.isFinite(t) || !row.providers) continue;
      for (const [id, s] of Object.entries(row.providers)) {
        const rec = index[id] ?? (index[id] = { lastNonEmptyAt: null, sinceMs: t });
        if (hasRows(s) && (rec.lastNonEmptyAt == null || t > rec.lastNonEmptyAt)) rec.lastNonEmptyAt = t;
      }
    }
  }
  return index;
}

/** The persisted index, or the one seeded from the status history when there is none yet. */
export function loadActivity(path: string, statusHistoryDir: string): { index: ActivityIndex; seeded: boolean } {
  if (existsSync(path)) {
    try {
      return { index: JSON.parse(readFileSync(path, 'utf8')) as ActivityIndex, seeded: false };
    } catch {
      /* unreadable: seed again rather than stop the run */
    }
  }
  return { index: seedActivity(statusHistoryDir), seeded: true };
}

export function saveActivity(path: string, index: ActivityIndex): void {
  const sorted = Object.fromEntries(Object.keys(index).sort().map((k) => [k, index[k]]));
  writeFileSync(path, JSON.stringify(sorted, null, 1) + '\n');
}
