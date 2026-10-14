import { join } from 'node:path';
import { SCHEMA_VERSION, SUMMARY_WINDOWS } from './config.js';
import { eventDayKey, writeIfChanged } from './bitemporal.js';
import { LIVE_DIR, LIVE_FEATURES_FORMAT, liveDayJson, sha256Hex, type LiveDayEntry } from './live-sync.js';
import type { Feat } from './summaries.js';
import { isoFromMs } from './util.js';

/**
 * The month index (PRB-2's last piece, round 27): the month under the live week, the M >= 2.5 events `all_month`
 * carries, as one compact file per UTC day with a sha256, so a client that keeps the month on disk downloads only the
 * days that changed instead of the whole `all_month` (~9.5 MB, ~1.1 MB brotli, new bytes every 5-minute run because
 * its `metadata.generated` moves, so an ETag never matches after a run).
 *
 * - `v1/live/month/<YYYY-MM-DD>.geojson`, one per UTC day from the first day the month window reaches (the day of
 *   now - 30 d, as `all_month`'s window) through today - MONTH_NEWEST_OFFSET_DAYS: exactly the features `all_month`
 *   publishes for that day (`summaryFeats` at M >= 2.5: the live events and, flagged non-live, the ones retired in the
 *   last 48 h), whole days, no run clock inside (`liveDayJson`), so the bytes and the sha256 change only when that
 *   day's events do. The floor stays at M >= 2.5 even in the (so far unseen) month whose `all_month` climbs the size
 *   ladder: a day file is ~0.3 MB.
 * - `v1/live/month.json`, the catalog of those days (`days[]` with `sha256`, as the live index's), rewritten every run;
 *   `manifest.json` points at it (`live_month`). No deltas: the days older than the newest six change rarely (heals,
 *   late reports and deletions inside the 10 days the run can still revise, the 48-hour markers), so comparing the
 *   fingerprints costs less than a delta would.
 *
 * Why stop at today - 6: the live index already holds the week at every magnitude, and a client cuts the month at its
 * live set's oldest event (about now - 7 d). Through today - 6 the month reaches at least a whole day past that edge,
 * so an event the live set drops between two refreshes of the month, also across a UTC midnight, is already held.
 * The newer days would only repeat the live week at a price: today's and yesterday's change on nearly every run.
 *
 * Measured by replaying origin/data's 943 derive commits of 2026-10-11 18:00 .. 10-14 18:48 UTC (each M >= 2.5 day
 * rebuilt from the committed partitions; brotli quality 4 x 1.078, the ratio Pages served `all_month` at on
 * 2026-10-14): the first sync is 976 KB (once per install, then kept on disk); after it a refresh moves the index
 * (7.3 KB, ~1.7 KB compressed) and 0.22 changed days on average: 10 KB per 30-minute refresh, 25 KB after 2 h, 57 KB
 * after 8 h and 93 KB after 24 h, against 1,100 KB of `all_month` each time (99, 98, 95 and 92 % less). Through today
 * (every day of the window) the same refreshes would move 96-349 KB, most of it today's and yesterday's files.
 */

export const MONTH_MIN_MAG = 2.5;
/** The month window, `all_month`'s (30 x 24 h). */
export const MONTH_WINDOW_MS = SUMMARY_WINDOWS['month']!;
/** The newest day of the month index: today - 6 (see the module comment). */
export const MONTH_NEWEST_OFFSET_DAYS = 6;
export const LIVE_MONTH_DIR = `${LIVE_DIR}/month`;
export const LIVE_MONTH_PATH = `v1/${LIVE_DIR}/month.json`;

const DOMAIN = 'https://earthquakes-feed.theshelter.app';
const DAY_MS = 86_400_000;

export interface LiveMonthIndex {
  schema_version: number;
  api: '1';
  generated: number;
  generated_iso: string;
  head_seq: number;
  /** Live events over the days. */
  count: number;
  /** The magnitude floor of every day file. */
  min_mag: number;
  /** The month window the days cover, in days (`all_month`'s 30). */
  window_days: number;
  /** The newest day is today minus this many days. */
  newest_offset_days: number;
  /** LIVE_FEATURES_FORMAT: a client holding the days in another one re-reads every day. */
  features_format: number;
  days: LiveDayEntry[];
}

/** The `live_month` pointer in manifest.json. */
export interface LiveMonthPointer {
  path: string;
  url: string;
  head_seq: number;
  min_mag: number;
  window_days: number;
}

/** The UTC days of the month index at `nowMs`, oldest first: the day of now - 30 d through today - 6. */
export function liveMonthDays(nowMs: number): string[] {
  const days: string[] = [];
  const last = Date.parse(`${eventDayKey(nowMs - MONTH_NEWEST_OFFSET_DAYS * DAY_MS)}T00:00:00Z`);
  for (let d = Date.parse(`${eventDayKey(nowMs - MONTH_WINDOW_MS)}T00:00:00Z`); d <= last; d += DAY_MS) days.push(eventDayKey(d));
  return days;
}

/** Whether a summary candidate belongs to the month index: `all_month`'s floor, applied the same way. */
export const inMonth = (f: Feat): boolean => f.mag != null && f.mag >= MONTH_MIN_MAG;

/**
 * Builds the month index from the run's summary candidates (`summaryFeats` over every loaded node; derive loads the
 * 45-day event map, past the month) and writes it under `publicV1/live/`. Pure apart from the writes: the same
 * candidates, head and clock give the same bytes.
 */
export function writeLiveMonth(
  feats: Feat[],
  opts: { publicV1: string; nowMs: number; headSeq: number },
): { index: LiveMonthIndex; pointer: LiveMonthPointer; files: Record<string, string> } {
  const { publicV1, nowMs, headSeq } = opts;
  const days = liveMonthDays(nowMs);
  const byDay = new Map<string, Feat[]>(days.map((d) => [d, []]));
  for (const f of feats) {
    if (inMonth(f)) byDay.get(eventDayKey(f.timeMs))?.push(f);
  }
  const files: Record<string, string> = {};
  const dayEntries: LiveDayEntry[] = days.map((date) => {
    const feats = byDay.get(date)!;
    const body = liveDayJson(date, feats, { title: `earthquakes-feed month day ${date}`, minMag: MONTH_MIN_MAG });
    const path = `v1/${LIVE_MONTH_DIR}/${date}.geojson`;
    files[path] = body;
    return {
      date,
      path,
      url: `${DOMAIN}/${path}`,
      count: feats.filter((f) => f.live).length,
      bytes: Buffer.byteLength(body),
      sha256: sha256Hex(body),
    };
  });
  const windowDays = Math.round(MONTH_WINDOW_MS / DAY_MS);
  const index: LiveMonthIndex = {
    schema_version: SCHEMA_VERSION,
    api: '1',
    generated: nowMs,
    generated_iso: isoFromMs(nowMs),
    head_seq: headSeq,
    count: dayEntries.reduce((s, d) => s + d.count, 0),
    min_mag: MONTH_MIN_MAG,
    window_days: windowDays,
    newest_offset_days: MONTH_NEWEST_OFFSET_DAYS,
    features_format: LIVE_FEATURES_FORMAT,
    days: dayEntries,
  };
  files[LIVE_MONTH_PATH] = JSON.stringify(index, null, 1);

  // publicV1 is `<PUBLIC_DIR>/v1`; every path above starts with `v1/`.
  for (const [path, body] of Object.entries(files)) writeIfChanged(join(publicV1, path.slice('v1/'.length)), body);
  return {
    index,
    pointer: { path: LIVE_MONTH_PATH, url: `${DOMAIN}/${LIVE_MONTH_PATH}`, head_seq: headSeq, min_mag: MONTH_MIN_MAG, window_days: windowDays },
    files,
  };
}
