import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR, DOMAIN, EVENT_MAP_HORIZON_DAYS } from './config.js';
import { eventDayKey, loadEventMap, writeIfChanged } from './bitemporal.js';
import { LIVE_WINDOW_DAYS, addPartitionLines } from './live-sync.js';
import { dayPartitionText, partitionPath } from './partitions.js';
import { FUTURE_LEEWAY_MS } from './summaries.js';
import type { EventNode } from './types.js';

/**
 * The silent-change baseline without the committed day partitions (round 25, storage option 4).
 *
 * derive's silent-change check (PRB-2, live-sync.ts) compares each window event's full-fat line with the line the
 * previous derive run wrote. Until round 25 it read those lines from the day partitions that run committed to `data`;
 * from phase 2 of option 4 the unfrozen days are not committed (stage-data.ts), so the lines come from elsewhere:
 *
 * - The snapshot. A day partition is a pure function of the event map (partitions.ts dayPartitionText), and the event
 *   map a run checks out is the one the previous derive read: aggregate, the only writer of window days, commits it,
 *   derive rebuilds the views from that commit and never changes a window shard, and the side-index jobs (history,
 *   first-solutions, remediate) and backfill/archive write other files or days weeks old. So a step before the
 *   aggregate rebuilds the window days' partitions from the checkout (this file's CLI, aggregate.yml and derive.yml)
 *   into LIVE_BASELINE_DIR, outside the data checkout.
 * - The record, `knowledge/index/live_baseline.json` (about 1 KB, committed by derive): the sha256 of every partition
 *   of the days around the window that derive wrote, with the run's `generated` and `head_seq`. A snapshot day is used
 *   only when its sha256 is the recorded one, and the record only when it belongs to the run whose head is the
 *   check's `prevHead` (the committed manifest.json). When the previous derive failed after its aggregate commit, the
 *   checkout holds an event map that derive never published: the sha256 differs.
 * - The Pages copy (phase 2), for such a day: the snapshot step fetches the day's partition from Pages, where the
 *   previous derive deployed it (partitions.ts writePagesPartition), and keeps it in the snapshot in place of the
 *   rebuilt one when its sha256 is the recorded one. The usual case is a derive that failed before its commit (no
 *   commit, no deploy): the record and Pages are both the run before. A derive that committed but did not deploy leaves
 *   Pages one run older than the record: the sha256 differs and the day has no baseline for that run (logged).
 *
 * Phase 1 also fell back to the committed partition and ran the old check beside the new one: replayed over the 412
 * derive runs of 2026-10-13 00:02 .. 10-14 07:49 UTC (scripts/live-baseline-replay.ts), the snapshot gave every window
 * day and the same 163 silent changes in 109 runs as the committed partitions and as production; replayed as if each
 * derive before had failed, 788 of 3,282 window days fell back to the partitions and the 410 runs again agreed. Phase 2
 * drops both: a day without a verified baseline has none for that run (a warning), so a feature of it that changed
 * without a new seq is missing from that run's deltas (its day file and the file's sha256 in the live index still
 * carry the change).
 */

export const LIVE_BASELINE_FILE = 'knowledge/index/live_baseline.json';
export const LIVE_BASELINE_SNAPSHOT_META = 'snapshot.json';

const DAY_MS = 86_400_000;

export interface LiveBaselineRecord {
  /** The derive run that wrote it: the `generated` (ms) and `head_seq` of its manifest. */
  generated: number;
  head_seq: number;
  /** sha256 of each day partition that run wrote, by UTC day; null = no partition of that day. */
  days: Record<string, string | null>;
}

export interface BaselineSnapshot {
  /** The days the snapshot covers: a covered day without a file has no partition. */
  covered: ReadonlySet<string>;
  /** The days whose text is the Pages copy of the previous derive's partition, not the event-map rebuild. */
  fromPages: ReadonlySet<string>;
  text(day: string): string | null;
}

export interface PreviousLines {
  /** The previous run's line of every window event, by feed id. */
  lines: Map<string, string>;
  /** Window days with a verified baseline: read from the snapshot (the recorded sha256 matched), or recorded without a
   *  partition (no lines). */
  fromSnapshot: string[];
  /** Window days without a verified baseline (no record, no snapshot, or a sha256 mismatch): none for this run. */
  missing: string[];
  /** Why the record was not used, when it was not. */
  recordUnused: string | null;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const fingerprint = (text: string | null): string | null => (text == null ? null : sha256Hex(text));

/** The UTC days a baseline covers at `nowMs`: the live window (live-sync.ts liveWindowDays) of a derive run at any time
 *  from `nowMs` to a day later, i.e. the 8 days before today's to tomorrow's. */
export function baselineDays(nowMs: number): string[] {
  const out: string[] = [];
  const last = eventDayKey(nowMs + DAY_MS + FUTURE_LEEWAY_MS);
  for (let ms = Date.parse(`${eventDayKey(nowMs - LIVE_WINDOW_DAYS * DAY_MS)}T00:00:00Z`); eventDayKey(ms) <= last; ms += DAY_MS) {
    out.push(eventDayKey(ms));
  }
  return out;
}

/** The day partitions of `days` rebuilt from event-map nodes, by day; a day without nodes is absent (derive writes no
 *  partition for it). */
export function partitionTexts(nodes: Iterable<EventNode>, days: Iterable<string>): Map<string, string> {
  const want = new Set(days);
  const byDay = new Map<string, EventNode[]>();
  for (const n of nodes) {
    const d = eventDayKey(n.eventTimeMs);
    if (want.has(d)) (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(n);
  }
  return new Map([...byDay].map(([d, ns]) => [d, dayPartitionText(ns)]));
}

/** The record derive commits for its run at `nowMs`: the sha256 of the partitions it wrote (`texts`) over
 *  baselineDays(nowMs). */
export function baselineRecord(nowMs: number, headSeq: number, texts: ReadonlyMap<string, string>): LiveBaselineRecord {
  const days: Record<string, string | null> = {};
  for (const d of baselineDays(nowMs)) days[d] = fingerprint(texts.get(d) ?? null);
  return { generated: nowMs, head_seq: headSeq, days };
}

export function readBaselineRecord(root: string): LiveBaselineRecord | null {
  const f = join(root, LIVE_BASELINE_FILE);
  if (!existsSync(f)) return null;
  try {
    const r = JSON.parse(readFileSync(f, 'utf8')) as Partial<LiveBaselineRecord>;
    if (typeof r.generated !== 'number' || typeof r.head_seq !== 'number' || !r.days || typeof r.days !== 'object') return null;
    return r as LiveBaselineRecord;
  } catch {
    return null;
  }
}

export function writeBaselineRecord(root: string, record: LiveBaselineRecord): boolean {
  return writeIfChanged(join(root, LIVE_BASELINE_FILE), JSON.stringify(record) + '\n');
}

/** Writes a snapshot into `dir` (emptied first): `events/YYYY/MM/DD.ndjson` per day with nodes, then the metadata
 *  file, last, so a snapshot cut short has none and reads as absent. `from_pages` names the days whose text is the
 *  Pages copy (recoverFromPages). */
export function writeBaselineSnapshot(
  dir: string,
  covered: Iterable<string>,
  texts: ReadonlyMap<string, string>,
  meta: { taken_at: number; head_seq: number; from_pages?: string[] },
): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [day, text] of texts) {
    const f = join(dir, partitionPath(day));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
  writeFileSync(join(dir, LIVE_BASELINE_SNAPSHOT_META), JSON.stringify({ ...meta, from_pages: [...(meta.from_pages ?? [])].sort(), days: [...new Set(covered)].sort() }) + '\n');
}

/** The snapshot in `dir`, or null when there is none (no directory, no metadata file, unreadable metadata). */
export function readBaselineSnapshot(dir: string | undefined): BaselineSnapshot | null {
  if (!dir) return null;
  const meta = join(dir, LIVE_BASELINE_SNAPSHOT_META);
  if (!existsSync(meta)) return null;
  try {
    const m = JSON.parse(readFileSync(meta, 'utf8')) as { days?: unknown; from_pages?: unknown };
    if (!Array.isArray(m.days)) return null;
    const covered = new Set(m.days.filter((d): d is string => typeof d === 'string'));
    const fromPages = new Set(Array.isArray(m.from_pages) ? m.from_pages.filter((d): d is string => typeof d === 'string') : []);
    return {
      covered,
      fromPages,
      text: (day) => {
        const f = join(dir, partitionPath(day));
        return existsSync(f) ? readFileSync(f, 'utf8') : null;
      },
    };
  } catch {
    return null;
  }
}

/**
 * The previous run's lines of the window days `days` (in that order): from the snapshot for each day whose sha256 is
 * the one the record names; a day without one has no lines (`missing`). `prev` is the committed manifest's `generated`
 * and `head_seq` (the run the check compares with); the record is used only when it is that run's. A day the record
 * names null had no partition: no lines, and nothing is missing.
 */
export function previousWindowLines(opts: {
  days: Iterable<string>;
  record: LiveBaselineRecord | null;
  prev: { generated: number; head_seq: number };
  snapshot: BaselineSnapshot | null;
}): PreviousLines {
  const { record, prev, snapshot } = opts;
  const recordUnused = whyRecordUnused(record, prev, snapshot);
  const usable = recordUnused == null ? record : null;
  const out: PreviousLines = { lines: new Map(), fromSnapshot: [], missing: [], recordUnused };
  for (const day of new Set(opts.days)) {
    const recorded = usable ? usable.days[day] : undefined;
    if (recorded === null) {
      // The previous derive wrote no partition of this day: no lines, known from the record alone. After a failed derive
      // the snapshot can hold the day's first events (the new UTC day's, a few minutes after midnight), which that
      // derive never saw; they are not a missing baseline (round 27 review: replayed 10-12 00:12 UTC).
      out.fromSnapshot.push(day);
      continue;
    }
    const snap = recorded !== undefined && snapshot!.covered.has(day) ? snapshot!.text(day) : undefined;
    if (snap !== undefined && fingerprint(snap) === recorded) {
      out.fromSnapshot.push(day);
      if (snap != null) addPartitionLines(out.lines, snap);
    } else {
      out.missing.push(day);
    }
  }
  return out;
}

/** Why the record cannot verify the snapshot against the run `prev`, or null when it can. */
export function whyRecordUnused(record: LiveBaselineRecord | null, prev: { generated: number; head_seq: number }, snapshot: BaselineSnapshot | null | 'n/a'): string | null {
  if (!record) return `no ${LIVE_BASELINE_FILE}`;
  if (record.generated !== prev.generated || record.head_seq !== prev.head_seq) {
    return `${LIVE_BASELINE_FILE} is from the run of ${new Date(record.generated).toISOString()} (head ${record.head_seq}), the manifest from ${new Date(prev.generated).toISOString()} (head ${prev.head_seq})`;
  }
  if (!snapshot) return 'no snapshot';
  return null;
}

/** How long the snapshot step may spend on Pages copies in all, and on one. */
export const PAGES_RECOVERY_BUDGET_MS = 45_000;
const PAGES_FETCH_TIMEOUT_MS = 10_000;

export interface PagesRecovery {
  /** The days whose rebuilt text was replaced by the Pages copy (its sha256 is the recorded one). */
  recovered: string[];
  /** The days that differ from the record and could not be recovered, with the reason. */
  failed: string[];
}

/**
 * The Pages fallback of the snapshot step (phase 2): for every covered day whose rebuilt text differs from the sha256
 * the record names (a partition, not null), fetch the previous derive's Pages copy at `base` + `events/YYYY/MM/DD.ndjson`
 * and, when its sha256 is the recorded one, put it in `texts` in place of the rebuild. One request at a time, each
 * bounded, all within PAGES_RECOVERY_BUDGET_MS; never throws.
 */
export async function recoverFromPages(opts: {
  days: Iterable<string>;
  texts: Map<string, string>;
  record: LiveBaselineRecord;
  base: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}): Promise<PagesRecovery> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const clock = opts.nowMs ?? Date.now;
  const deadline = clock() + PAGES_RECOVERY_BUDGET_MS;
  const out: PagesRecovery = { recovered: [], failed: [] };
  for (const day of new Set(opts.days)) {
    const recorded = opts.record.days[day];
    if (typeof recorded !== 'string' || fingerprint(opts.texts.get(day) ?? null) === recorded) continue;
    const left = deadline - clock();
    if (left <= 0) {
      out.failed.push(`${day} (no time left)`);
      continue;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.min(PAGES_FETCH_TIMEOUT_MS, left));
    try {
      const res = await fetchImpl(`${opts.base}${partitionPath(day)}`, { signal: abort.signal, headers: { 'cache-control': 'no-cache' } });
      if (!res.ok) {
        out.failed.push(`${day} (HTTP ${res.status})`);
        continue;
      }
      const text = await res.text();
      if (fingerprint(text) !== recorded) {
        out.failed.push(`${day} (the Pages copy is not the recorded partition)`);
        continue;
      }
      opts.texts.set(day, text);
      out.recovered.push(day);
    } catch (err) {
      out.failed.push(`${day} (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/** The snapshot step (aggregate.yml and derive.yml, before anything writes the data checkout): DATA_DIR's event map,
 *  the partitions of baselineDays(now) into LIVE_BASELINE_DIR, with the Pages copies of the days the previous derive
 *  did not publish from it (recoverFromPages; LIVE_BASELINE_PAGES_BASE overrides the Pages origin, for dry runs). Never
 *  fails the job: derive then has no baseline for the days it lacks. */
async function main(): Promise<void> {
  const dir = process.env.LIVE_BASELINE_DIR;
  if (!dir) {
    console.warn('::warning::live-baseline: LIVE_BASELINE_DIR is not set, no snapshot (derive then has no silent-change baseline)');
    return;
  }
  try {
    const t0 = Date.now();
    const nowMs = Date.now();
    const map = loadEventMap(DATA_DIR, { sinceDays: EVENT_MAP_HORIZON_DAYS, nowMs });
    const head = (() => {
      try {
        return (JSON.parse(readFileSync(join(DATA_DIR, 'knowledge', 'index', 'head.json'), 'utf8')) as { seq?: number }).seq ?? 0;
      } catch {
        return 0;
      }
    })();
    const days = baselineDays(nowMs);
    const texts = partitionTexts(map.values(), days);
    // Phase 2: the days the previous derive did not publish from this event map, from its Pages copies.
    let recovery: PagesRecovery = { recovered: [], failed: [] };
    const record = readBaselineRecord(DATA_DIR);
    const prev = (() => {
      try {
        return JSON.parse(readFileSync(join(DATA_DIR, 'manifest.json'), 'utf8')) as { generated?: number; head_seq?: number };
      } catch {
        return null;
      }
    })();
    if (record && prev && whyRecordUnused(record, { generated: prev.generated ?? -1, head_seq: prev.head_seq ?? -1 }, 'n/a') == null) {
      recovery = await recoverFromPages({ days, texts, record, base: process.env.LIVE_BASELINE_PAGES_BASE || `https://${DOMAIN}/` });
    }
    writeBaselineSnapshot(dir, days, texts, { taken_at: nowMs, head_seq: head, from_pages: recovery.recovered });
    const bytes = [...texts.values()].reduce((s, t) => s + Buffer.byteLength(t), 0);
    console.log(
      `live-baseline: snapshot of ${days[0]}..${days.at(-1)} at head ${head}: ${texts.size} day partition(s), ${bytes} B, ${Date.now() - t0} ms` +
        (recovery.recovered.length ? `; from the previous derive's Pages copies: ${recovery.recovered.join(', ')}` : ''),
    );
    if (recovery.failed.length) {
      console.warn(`::warning::live-baseline: the previous derive's partition of ${recovery.failed.join(', ')} is neither in the event map nor on Pages; derive has no silent-change baseline for those days`);
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    console.warn(`::warning::live-baseline: no snapshot (${err instanceof Error ? err.message : String(err)}); derive has no silent-change baseline this run`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
