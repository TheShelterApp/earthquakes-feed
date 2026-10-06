import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION } from './config.js';
import { eventDayKey, nodeToFeature, writeIfChanged } from './bitemporal.js';
import { dayPartitionFile } from './partitions.js';
import { FUTURE_LEEWAY_MS, NOTICE, type Feat } from './summaries.js';
import type { EventNode } from './types.js';
import { isoFromMs } from './util.js';

/**
 * The live index (PRB-2): the week summary's content in a form a client can refresh incrementally.
 *
 * `all_week.geojson` is one ~7.4 MB file (~870 KB brotli) that changes on every 5-minute run, if only because its
 * `metadata.generated` does, so every poll that finds it changed and every cold start downloads all of it again. This
 * module publishes, beside it (the summaries stay as they are for the builds that read them):
 *
 * - `v1/live/days/<YYYY-MM-DD>.geojson`, one compact FeatureCollection per UTC day of the week window (today and the 7
 *   days before it; tomorrow too while a live event inside the 10-minute future leeway sits there). Each holds exactly
 *   the features `all_week` publishes for that day (`summaryFeats`: live events, plus the retired markers of the last
 *   48 h flagged non-live), whole days with no magnitude floor, and nothing that changes from run to run: its bytes
 *   change only when its events do, so its `sha256` is a fingerprint a client compares with the copy it holds.
 * - `v1/live/delta-<15m|1h|6h|24h>.geojson`, the same compact features of every window event whose knowledge clock
 *   (`feed.ingest_seq`) is above the delta's `from_seq`: everything that changed (a new event, a revision, a fold, a
 *   withdrawal) since about that long ago. A client that holds the window as of `head_seq` = c applies the smallest
 *   delta with `from_seq <= c` (upsert by `id`, remove the non-live ones) and then holds it as of the delta's
 *   `head_seq`.
 * - `v1/live/index.json`, the small catalog of both (`head_seq`, the days with `sha256`, the deltas with `from_seq`),
 *   rewritten every run; `manifest.json` points at it (`live`).
 *
 * Why a delta is exact: `from_seq` for a window W is the largest `lastSeq` of an event-map node last changed at least W
 * ago. Sequence numbers grow with ingest time, so every node changed later has a larger `lastSeq`, and the delta is by
 * definition every window node above `from_seq`. A client at cursor c >= from_seq therefore receives every node changed
 * after c. Nothing else changes a day's content: an event leaving the window is the client's own time filter, and a
 * retired marker that stops being published after 48 h only stops repeating a removal the client already applied.
 * Every change inside the window that the event map records takes a new seq: the aggregate's log (LogBuffer) gives
 * each its own, and the writers that stamp the current head instead (backfill, remediation) only write days before the
 * event-map horizon or frozen days, weeks outside the window. One kind does not: a revision of a provenance row that
 * represents nothing in its event replaces the stored row and leaves the event's `lastSeq` as it was (PF-5h (2)), yet
 * it can change the compact feature through the fill-only fields (`updated`, `author`, `magAuthor`, `tsunami`, ...).
 * Replaying a client over the real derive commits of 2026-10-05 14:00..10-06 02:45 found 20 such features. So derive
 * also compares each window event's partition line with the one the previous run committed (detectSilentChanges):
 * one that differs while its `lastSeq` is not above the previous run's head is a silent change, kept for a day in
 * `knowledge/index/live_silent.json` with that previous head (`head_before`), and every delta whose `from_seq` is at
 * most `head_before` carries it. A client at a cursor c >= from_seq that has not seen the change synced at or before
 * that previous run, so c <= head_before: the change reaches it.
 *
 * Measured over origin/data's derive commits of 2026-10-04..06 (brotli level 4, the compression Pages serves is
 * about 6 % larger): the week summary 846 KB per changed poll; the per-day files 205 KB per 5-minute run (1.8 of the
 * 8 days change per run on average), 530 KB after an hour away, 786 KB after 8 h; the deltas 4.0 KB (15 min), 11.1 KB
 * (1 h), 54.7 KB (6 h) and 173.8 KB (24 h).
 */

const DOMAIN = 'https://earthquakes-feed.theshelter.app';
const DAY_MS = 86_400_000;
/** Whole UTC days in the window: today and the 7 before it (the week summary's 7 x 24 h end inside the oldest). */
export const LIVE_WINDOW_DAYS = 8;
/** The delta look-backs, smallest first; a client takes the smallest one whose `from_seq` covers its cursor. */
export const LIVE_DELTAS: ReadonlyArray<{ name: string; seconds: number }> = [
  { name: '15m', seconds: 15 * 60 },
  { name: '1h', seconds: 3600 },
  { name: '6h', seconds: 6 * 3600 },
  { name: '24h', seconds: 24 * 3600 },
];
export const LIVE_DIR = 'live';
export const LIVE_INDEX_PATH = `v1/${LIVE_DIR}/index.json`;

export interface LiveDayEntry {
  date: string;
  path: string;
  url: string;
  /** Live events in the file (retired markers not counted). */
  count: number;
  bytes: number;
  sha256: string;
}

export interface LiveDeltaEntry {
  name: string;
  window_seconds: number;
  path: string;
  url: string;
  /** Exclusive lower bound: the file holds every window event whose `feed.ingest_seq` is above it. */
  from_seq: number;
  head_seq: number;
  /** Features in the file, retired markers included (a delta's markers are removals to apply). */
  count: number;
  bytes: number;
  sha256: string;
}

export interface LiveIndex {
  schema_version: number;
  api: '1';
  generated: number;
  generated_iso: string;
  head_seq: number;
  /** Live events over the window's days. */
  count: number;
  window_days: number;
  days: LiveDayEntry[];
  deltas: LiveDeltaEntry[];
}

/** The `live` pointer in manifest.json. */
export interface LivePointer {
  path: string;
  url: string;
  head_seq: number;
  window_days: number;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A window event whose published feature changed without its `lastSeq` moving (see the module comment). */
export interface SilentChange {
  id: string;
  /** The previous run's head: a client at a cursor at or below it has not seen the change. */
  head_before: number;
  /** When derive saw it (ms). */
  at: number;
}

export const LIVE_SILENT_FILE = 'knowledge/index/live_silent.json';
const ID_IN_LINE = /^\{"type":"Feature","id":"([^"]+)"/;

/**
 * The window events whose partition line differs from the line the previous run committed while their `lastSeq` is
 * not above that run's head `prevHead`. Reads the day partitions as they are on disk, so it must run before derive
 * rewrites them. The line is compared whole (full-fat): a superset of the compact feature's changes.
 */
export function detectSilentChanges(root: string, nodes: Iterable<EventNode>, days: Iterable<string>, prevHead: number): string[] {
  const window = new Set(days);
  const previous = new Map<string, string>();
  for (const day of window) {
    const file = dayPartitionFile(root, day);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const id = ID_IN_LINE.exec(line)?.[1];
      if (id) previous.set(id, line);
    }
  }
  const out: string[] = [];
  for (const n of nodes) {
    if (n.lastSeq > prevHead || !window.has(eventDayKey(n.eventTimeMs))) continue;
    const before = previous.get(n.feedId);
    if (before !== undefined && before !== JSON.stringify(nodeToFeature(n))) out.push(n.feedId);
  }
  return out.sort();
}

/** The silent-change log after this run: the kept entries, this run's detections (the newest head_before per id wins),
 *  minus the entries no delta can still need (head_before below the oldest delta's from_seq). */
export function nextSilentLog(prior: SilentChange[], detected: string[], prevHead: number, nowMs: number, oldestFromSeq: number): SilentChange[] {
  const byId = new Map<string, SilentChange>();
  for (const e of prior) if (e.head_before >= oldestFromSeq) byId.set(e.id, e);
  for (const id of detected) byId.set(id, { id, head_before: prevHead, at: nowMs });
  return [...byId.values()].sort((a, b) => a.head_before - b.head_before || (a.id < b.id ? -1 : 1));
}

export function readSilentLog(root: string): SilentChange[] {
  const f = join(root, LIVE_SILENT_FILE);
  if (!existsSync(f)) return [];
  try {
    return (JSON.parse(readFileSync(f, 'utf8')) as { entries?: SilentChange[] }).entries ?? [];
  } catch {
    return [];
  }
}

export function writeSilentLog(root: string, entries: SilentChange[]): void {
  writeIfChanged(join(root, LIVE_SILENT_FILE), JSON.stringify({ entries }) + '\n');
}

/** The UTC days of the window at `nowMs`, oldest first: today and the LIVE_WINDOW_DAYS - 1 before it, plus tomorrow
 *  when the future leeway reaches past midnight. */
export function liveWindowDays(nowMs: number): string[] {
  const days = new Set<string>();
  for (let i = LIVE_WINDOW_DAYS - 1; i >= 0; i--) days.add(eventDayKey(nowMs - i * DAY_MS));
  days.add(eventDayKey(nowMs + FUTURE_LEEWAY_MS));
  return [...days];
}

const byTimeThenId = (a: Feat, b: Feat): number => a.timeMs - b.timeMs || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);
const idOf = (f: Feat): string => (f.feature as { id: string }).id;

/** One day file: deterministic bytes for the same features (no run clock inside). `generated` is the newest ingest
 *  time among them, or the day's midnight when it is empty: it moves only when the content does. */
export function liveDayJson(date: string, feats: Feat[]): string {
  const sorted = [...feats].sort(byTimeThenId);
  const generated = sorted.reduce((m, f) => Math.max(m, Number.isFinite(f.ingestMs) ? f.ingestMs : 0), Date.parse(`${date}T00:00:00Z`));
  return JSON.stringify({
    type: 'FeatureCollection',
    metadata: {
      generated,
      generated_iso: isoFromMs(generated),
      title: `earthquakes-feed live day ${date}`,
      api: '1',
      date,
      count: sorted.filter((f) => f.live).length,
      schema_version: SCHEMA_VERSION,
      attribution: NOTICE,
    },
    features: sorted.map((f) => f.feature),
  });
}

/** `from_seq` of a delta reaching back `windowMs` from `nowMs`: the largest `lastSeq` among the nodes last changed at
 *  or before `nowMs - windowMs` (0 when none is that old). */
export function deltaFromSeq(nodes: Iterable<EventNode>, nowMs: number, windowMs: number): number {
  const cut = nowMs - windowMs;
  let from = 0;
  for (const n of nodes) {
    const t = Date.parse(n.lastIngestTime);
    if (Number.isFinite(t) && t <= cut && n.lastSeq > from) from = n.lastSeq;
  }
  return from;
}

export function liveDeltaJson(name: string, windowSeconds: number, fromSeq: number, headSeq: number, feats: Feat[], nowMs: number): string {
  const sorted = [...feats].sort(byTimeThenId);
  return JSON.stringify({
    type: 'FeatureCollection',
    metadata: {
      generated: nowMs,
      generated_iso: isoFromMs(nowMs),
      title: `earthquakes-feed live delta ${name}`,
      api: '1',
      from_seq: fromSeq,
      head_seq: headSeq,
      window_seconds: windowSeconds,
      count: sorted.length,
      schema_version: SCHEMA_VERSION,
      attribution: NOTICE,
    },
    features: sorted.map((f) => f.feature),
  });
}

/**
 * Builds the live index from the run's summary candidates (`summaryFeats` over every loaded node) and writes it under
 * `publicV1/live/`. Pure apart from the writes: the same nodes, head and clock give the same bytes.
 */
export function writeLiveIndex(
  feats: Feat[],
  nodes: Iterable<EventNode>,
  opts: { publicV1: string; nowMs: number; headSeq: number; silent?: ReadonlyArray<SilentChange> },
): { index: LiveIndex; pointer: LivePointer; files: Record<string, string> } {
  const { publicV1, nowMs, headSeq } = opts;
  const silent = opts.silent ?? [];
  const days = liveWindowDays(nowMs);
  const inWindow = new Set(days);
  const byDay = new Map<string, Feat[]>(days.map((d) => [d, []]));
  for (const f of feats) {
    const d = eventDayKey(f.timeMs);
    if (inWindow.has(d)) byDay.get(d)!.push(f);
  }
  const files: Record<string, string> = {};

  const dayEntries: LiveDayEntry[] = days.map((date) => {
    const body = liveDayJson(date, byDay.get(date)!);
    const path = `v1/${LIVE_DIR}/days/${date}.geojson`;
    files[path] = body;
    return {
      date,
      path,
      url: `${DOMAIN}/${path}`,
      count: byDay.get(date)!.filter((f) => f.live).length,
      bytes: Buffer.byteLength(body),
      sha256: sha256Hex(body),
    };
  });

  const windowFeats = [...byDay.values()].flat();
  const nodeList = [...nodes];
  const deltaEntries: LiveDeltaEntry[] = LIVE_DELTAS.map(({ name, seconds }) => {
    const fromSeq = Math.min(deltaFromSeq(nodeList, nowMs, seconds * 1000), headSeq);
    const silentIds = new Set(silent.filter((e) => e.head_before >= fromSeq).map((e) => e.id));
    const picked = windowFeats.filter((f) => f.seq > fromSeq || silentIds.has(idOf(f)));
    const body = liveDeltaJson(name, seconds, fromSeq, headSeq, picked, nowMs);
    const path = `v1/${LIVE_DIR}/delta-${name}.geojson`;
    files[path] = body;
    return {
      name,
      window_seconds: seconds,
      path,
      url: `${DOMAIN}/${path}`,
      from_seq: fromSeq,
      head_seq: headSeq,
      count: picked.length,
      bytes: Buffer.byteLength(body),
      sha256: sha256Hex(body),
    };
  });

  const index: LiveIndex = {
    schema_version: SCHEMA_VERSION,
    api: '1',
    generated: nowMs,
    generated_iso: isoFromMs(nowMs),
    head_seq: headSeq,
    count: dayEntries.reduce((s, d) => s + d.count, 0),
    window_days: LIVE_WINDOW_DAYS,
    days: dayEntries,
    deltas: deltaEntries,
  };
  files[LIVE_INDEX_PATH] = JSON.stringify(index, null, 1);

  // publicV1 is `<PUBLIC_DIR>/v1`; every path above starts with `v1/`.
  for (const [path, body] of Object.entries(files)) writeIfChanged(join(publicV1, path.slice('v1/'.length)), body);
  return {
    index,
    pointer: { path: LIVE_INDEX_PATH, url: `${DOMAIN}/${LIVE_INDEX_PATH}`, head_seq: headSeq, window_days: LIVE_WINDOW_DAYS },
    files,
  };
}
