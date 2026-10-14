import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR, EVENT_MAP_HORIZON_DAYS } from './config.js';
import { eventDayKey, loadEventMap, writeIfChanged } from './bitemporal.js';
import { LIVE_WINDOW_DAYS, addPartitionLines } from './live-sync.js';
import { dayPartitionFile, dayPartitionText, partitionPath } from './partitions.js';
import { FUTURE_LEEWAY_MS } from './summaries.js';
import type { EventNode } from './types.js';

/**
 * The silent-change baseline without the committed day partitions (round 25, storage option 4 phase 1).
 *
 * derive's silent-change check (PRB-2, live-sync.ts) compares each window event's full-fat line with the line the
 * previous derive run wrote. Until round 25 it read those lines from the day partitions that run committed to `data`.
 * Phase 2 of option 4 (about 2026-11-04) stops committing the unfrozen days, so the lines come from elsewhere:
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
 *   checkout holds an event map that derive never published: the sha256 differs and the day falls back.
 *
 * Phase 1 falls back to the committed partition, and also runs the old check beside the new one (derive.ts): the
 * union of both is kept (an extra entry only repeats a feature in a delta, a missing one would lose a change for a
 * client) and any difference is a warning. Replayed over the 412 derive runs of 2026-10-13 00:02 .. 10-14 07:49 UTC
 * (scripts/live-baseline-replay.ts), the snapshot gave every window day and the same 163 silent changes in 109 runs as
 * the committed partitions and as production; replayed as if each derive before had failed, 788 of 3,282 window days
 * fell back to the partitions and the 410 runs again agreed. Phase 2 drops the committed partitions and the check
 * beside it; a day without a usable snapshot then has no baseline for that run (logged), as when the file is missing
 * today.
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
  text(day: string): string | null;
}

export interface PreviousLines {
  /** The previous run's line of every window event, by feed id. */
  lines: Map<string, string>;
  /** Window days read from the snapshot (the recorded sha256 matched). */
  fromSnapshot: string[];
  /** Window days read from the committed partitions (no record, no snapshot, or a sha256 mismatch). */
  fromPartitions: string[];
  /** Snapshot days whose committed partition differs from the snapshot (phase 1 check; none expected). */
  partitionDiffers: string[];
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
 *  file, last, so a snapshot cut short has none and reads as absent. */
export function writeBaselineSnapshot(dir: string, covered: Iterable<string>, texts: ReadonlyMap<string, string>, meta: { taken_at: number; head_seq: number }): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [day, text] of texts) {
    const f = join(dir, partitionPath(day));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
  writeFileSync(join(dir, LIVE_BASELINE_SNAPSHOT_META), JSON.stringify({ ...meta, days: [...new Set(covered)].sort() }) + '\n');
}

/** The snapshot in `dir`, or null when there is none (no directory, no metadata file, unreadable metadata). */
export function readBaselineSnapshot(dir: string | undefined): BaselineSnapshot | null {
  if (!dir) return null;
  const meta = join(dir, LIVE_BASELINE_SNAPSHOT_META);
  if (!existsSync(meta)) return null;
  try {
    const m = JSON.parse(readFileSync(meta, 'utf8')) as { days?: unknown };
    if (!Array.isArray(m.days)) return null;
    const covered = new Set(m.days.filter((d): d is string => typeof d === 'string'));
    return {
      covered,
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
 * The previous run's lines of the window days `days` (in that order, like detectSilentChanges): from the snapshot for
 * each day whose sha256 is the one the record names, else from the committed partition. `prev` is the committed
 * manifest's `generated` and `head_seq` (the run the check compares with); the record is used only when it is that
 * run's. `compare` (phase 1) also reads the committed partition of every snapshot day and names those that differ.
 */
export function previousWindowLines(opts: {
  root: string;
  days: Iterable<string>;
  record: LiveBaselineRecord | null;
  prev: { generated: number; head_seq: number };
  snapshot: BaselineSnapshot | null;
  compare?: boolean;
}): PreviousLines {
  const { root, record, prev, snapshot } = opts;
  let recordUnused: string | null = null;
  if (!record) recordUnused = `no ${LIVE_BASELINE_FILE}`;
  else if (record.generated !== prev.generated || record.head_seq !== prev.head_seq) {
    recordUnused = `${LIVE_BASELINE_FILE} is from the run of ${new Date(record.generated).toISOString()} (head ${record.head_seq}), the manifest from ${new Date(prev.generated).toISOString()} (head ${prev.head_seq})`;
  } else if (!snapshot) recordUnused = 'no snapshot';
  const usable = recordUnused == null ? record : null;
  const committed = (day: string): string | null => {
    const f = dayPartitionFile(root, day);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  };
  const out: PreviousLines = { lines: new Map(), fromSnapshot: [], fromPartitions: [], partitionDiffers: [], recordUnused };
  for (const day of new Set(opts.days)) {
    const recorded = usable ? usable.days[day] : undefined;
    let text: string | null;
    const snap = recorded !== undefined && snapshot!.covered.has(day) ? snapshot!.text(day) : undefined;
    if (snap !== undefined && fingerprint(snap) === recorded) {
      text = snap;
      out.fromSnapshot.push(day);
      if (opts.compare && committed(day) !== snap) out.partitionDiffers.push(day);
    } else {
      text = committed(day);
      out.fromPartitions.push(day);
    }
    if (text != null) addPartitionLines(out.lines, text);
  }
  return out;
}

/** The snapshot step (aggregate.yml and derive.yml, before anything writes the data checkout): DATA_DIR's event map,
 *  the partitions of baselineDays(now) into LIVE_BASELINE_DIR. Never fails the job: derive falls back without it. */
function main(): void {
  const dir = process.env.LIVE_BASELINE_DIR;
  if (!dir) {
    console.warn('::warning::live-baseline: LIVE_BASELINE_DIR is not set, no snapshot (derive reads the committed partitions)');
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
    writeBaselineSnapshot(dir, days, texts, { taken_at: nowMs, head_seq: head });
    const bytes = [...texts.values()].reduce((s, t) => s + Buffer.byteLength(t), 0);
    console.log(`live-baseline: snapshot of ${days[0]}..${days.at(-1)} at head ${head}: ${texts.size} day partition(s), ${bytes} B, ${Date.now() - t0} ms`);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    console.warn(`::warning::live-baseline: no snapshot (${err instanceof Error ? err.message : String(err)}); derive reads the committed partitions`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
