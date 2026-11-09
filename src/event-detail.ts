import { join } from 'node:path';
import { SCHEMA_VERSION } from './config.js';
import { nodeToFeature, writeIfChanged } from './bitemporal.js';
import { FUTURE_LEEWAY_MS, NOTICE } from './summaries.js';
import type { EventNode } from './types.js';
import { feedIdTimeMs } from './ulid.js';
import { isoFromMs } from './util.js';

/**
 * Per-hour detail files (EVT-5): `v1/detail/<YYYY-MM-DDTHH>.geojson`, one FeatureCollection per UTC hour of the days
 * the run publishes as Pages day files, holding that hour's LIVE events full-fat (every provider's solution in
 * `feed.provenance[]`, as in the day files). An app opening one event used to read the whole UTC day file (about
 * 2.3 MB, 270 KB brotli) and, near midnight or when the day did not name the event, a neighbouring day as well; the
 * event's own hour is about 1/24 of that, and the agencies' sibling solutions of a large quake (within 60 s) sit in the
 * same hour or, within 60 s of the hour, in the next or previous one.
 *
 * Every hour from the first published day's 00 h to the hour of now + the 10-minute future leeway has a file, empty or
 * not, so a missing file never means "no event". The bytes hold no run clock (`metadata.generated` is the newest ingest
 * time among the features, or the hour's start): an hour's file changes only when its events do, so a deploy uploads
 * only the hours that changed. Retired events are not here (the day files keep their 48-hour markers).
 *
 * `moved` (share links, 2026-11): a feed id names its hour only as a hint (its ULID time is the minting report's origin,
 * rounded to 30 s), and a shared id can be retired minutes later when agencies' solutions fold together. So each hour
 * file also carries, under the foreign member `moved`, the ids whose ULID time falls in that hour but which are not
 * among its features: every retired (`superseded`) id whose final live survivor is in a detail file
 * (`{to: <survivor>, hour: <survivor's hour>}`) and every live id whose origin hour is another hour (`to` = itself).
 * Built from the run's event map (45 days, every state) on every run, nothing persisted: any id resolves in at most two
 * hour reads, its ULID hour and the hour `moved` names. Tombstoned ids are not listed.
 *
 * Why hours and not one file per event (measured on origin/data dae9220725, 2026-10-06): the 46 published days hold
 * about 54k live events, so one file per event would be 54k files, beyond Cloudflare Pages' 20,000 files per site on the
 * free plan; hours are 46 x 24 = 1,104 files. A feed id -> byte-range index into the day files would keep the file
 * count, but Pages serves the day files compressed and a range of the compressed body is not a range of the JSON.
 */

const DOMAIN = 'https://earthquakes-feed.theshelter.app';
const HOUR_MS = 3_600_000;
export const DETAIL_DIR = 'detail';

/** The `event_detail` pointer in manifest.json: build a URL by putting an hour key into `url_template`. */
export interface EventDetailPointer {
  path_template: string;
  url_template: string;
  /** `YYYY-MM-DDTHH`, UTC: the first and last hour with a file (inclusive; every hour between has one). */
  first_hour: string;
  last_hour: string;
}

export const hourKey = (ms: number): string => isoFromMs(ms).slice(0, 13);

/** Where a moved or retired id is now (APIs.md, Event detail: `moved`). */
export interface MovedEntry {
  /** The live feed id: the final survivor of a retired id, or the id itself. */
  to: string;
  /** `YYYY-MM-DDTHH`: the hour file that holds `to`. */
  hour: string;
}

/** The detail files' time span for the run's Pages days: from the first day's 00:00 UTC to now + the future leeway,
 *  both inclusive (an event at `endMs` is published). Null without days. */
export function detailWindow(days: Iterable<string>, nowMs: number): { startMs: number; endMs: number } | null {
  const first = [...new Set(days)].sort()[0];
  if (first == null) return null;
  return { startMs: Date.parse(`${first}T00:00:00Z`), endMs: nowMs + FUTURE_LEEWAY_MS };
}

/** Superseded chains longer than this are treated as broken (a merge chain is one or two hops in practice). */
const MAX_SURVIVOR_HOPS = 16;

/**
 * The live event a node stands for now: the node itself when live, else the end of its `supersededBy` chain when that
 * end is live. Null for a tombstoned node, a chain that ends tombstoned, leaves the map (`byId`) or loops.
 */
export function liveSurvivor(node: EventNode, byId: ReadonlyMap<string, EventNode>): EventNode | null {
  let at: EventNode | undefined = node;
  const seen = new Set<string>();
  for (let hops = 0; at && hops <= MAX_SURVIVOR_HOPS; hops++) {
    if (at.state === 'live') return at;
    if (at.state !== 'superseded' || !at.supersededBy || seen.has(at.feedId)) return null;
    seen.add(at.feedId);
    at = byId.get(at.supersededBy);
  }
  return null;
}

/** Whether a node is one of the detail files' features over `window`. */
export const inDetailWindow = (n: EventNode, window: { startMs: number; endMs: number }): boolean =>
  n.state === 'live' && n.eventTimeMs >= window.startMs && n.eventTimeMs <= window.endMs;

/**
 * The `moved` member of every hour file over `window`, keyed by hour: for each id whose ULID hour has a file, a
 * retired id whose live survivor is a feature of the files, or a feature whose origin hour is not its ULID hour.
 */
export function movedByHour(nodes: Iterable<EventNode>, window: { startMs: number; endMs: number }): Map<string, Map<string, MovedEntry>> {
  const all = [...nodes];
  const byId = new Map(all.map((n) => [n.feedId, n]));
  const firstHour = hourKey(window.startMs);
  const lastHour = hourKey(window.endMs);
  const out = new Map<string, Map<string, MovedEntry>>();
  const put = (hour: string, id: string, e: MovedEntry): void => {
    (out.get(hour) ?? out.set(hour, new Map()).get(hour)!).set(id, e);
  };
  for (const n of all) {
    const minted = feedIdTimeMs(n.feedId);
    if (minted == null) continue;
    const idHour = hourKey(minted);
    if (idHour < firstHour || idHour > lastHour) continue;
    if (n.state === 'superseded') {
      const s = liveSurvivor(n, byId);
      if (s && inDetailWindow(s, window)) put(idHour, n.feedId, { to: s.feedId, hour: hourKey(s.eventTimeMs) });
    } else if (inDetailWindow(n, window)) {
      const hour = hourKey(n.eventTimeMs);
      if (hour !== idHour) put(idHour, n.feedId, { to: n.feedId, hour });
    }
  }
  return out;
}

export function detailHourJson(hour: string, nodes: EventNode[], moved?: ReadonlyMap<string, MovedEntry>): string {
  const sorted = [...nodes].sort((a, b) => a.eventTimeMs - b.eventTimeMs || (a.feedId < b.feedId ? -1 : a.feedId > b.feedId ? 1 : 0));
  const generated = sorted.reduce((m, n) => {
    const t = Date.parse(n.lastIngestTime);
    return Number.isFinite(t) ? Math.max(m, t) : m;
  }, Date.parse(`${hour}:00:00Z`));
  return JSON.stringify({
    type: 'FeatureCollection',
    metadata: {
      generated,
      generated_iso: isoFromMs(generated),
      title: `earthquakes-feed detail ${hour}`,
      api: '1',
      hour,
      count: sorted.length,
      schema_version: SCHEMA_VERSION,
      attribution: NOTICE,
    },
    features: sorted.map((n) => nodeToFeature(n, { reviewStatus: true })),
    // Present only when the hour has an entry; keys in feed-id order, so the bytes follow the events alone.
    ...(moved && moved.size
      ? { moved: Object.fromEntries([...moved].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, e]) => [id, { to: e.to, hour: e.hour }])) }
      : {}),
  });
}

/**
 * Writes the hour files for `days` (the run's Pages day files) and returns the manifest pointer, or null without days.
 */
export function writeDetailHours(
  nodes: Iterable<EventNode>,
  days: Iterable<string>,
  opts: { publicV1: string; nowMs: number },
): { pointer: EventDetailPointer; files: number; bytes: number; maxBytes: number; moved: number } | null {
  const window = detailWindow(days, opts.nowMs);
  if (!window) return null;
  const { startMs, endMs } = window;
  const all = [...nodes];
  const byHour = new Map<string, EventNode[]>();
  for (const n of all) {
    if (!inDetailWindow(n, window)) continue;
    const k = hourKey(n.eventTimeMs);
    (byHour.get(k) ?? byHour.set(k, []).get(k)!).push(n);
  }
  const moved = movedByHour(all, window);
  let files = 0;
  let bytes = 0;
  let maxBytes = 0;
  let movedCount = 0;
  let last = hourKey(startMs);
  for (let t = startMs; t <= endMs; t += HOUR_MS) {
    const hour = hourKey(t);
    const hourMoved = moved.get(hour);
    movedCount += hourMoved?.size ?? 0;
    const body = detailHourJson(hour, byHour.get(hour) ?? [], hourMoved);
    writeIfChanged(join(opts.publicV1, DETAIL_DIR, `${hour}.geojson`), body);
    const b = Buffer.byteLength(body);
    files++;
    bytes += b;
    maxBytes = Math.max(maxBytes, b);
    last = hour;
  }
  return {
    pointer: {
      path_template: `v1/${DETAIL_DIR}/{hour}.geojson`,
      url_template: `${DOMAIN}/v1/${DETAIL_DIR}/{hour}.geojson`,
      first_hour: hourKey(startMs),
      last_hour: last,
    },
    files,
    bytes,
    maxBytes,
    moved: movedCount,
  };
}
