import { join } from 'node:path';
import { SCHEMA_VERSION } from './config.js';
import { nodeToFeature, writeIfChanged } from './bitemporal.js';
import { FUTURE_LEEWAY_MS, NOTICE } from './summaries.js';
import type { EventNode } from './types.js';
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

export function detailHourJson(hour: string, nodes: EventNode[]): string {
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
    features: sorted.map((n) => nodeToFeature(n)),
  });
}

/**
 * Writes the hour files for `days` (the run's Pages day files) and returns the manifest pointer, or null without days.
 */
export function writeDetailHours(
  nodes: Iterable<EventNode>,
  days: Iterable<string>,
  opts: { publicV1: string; nowMs: number },
): { pointer: EventDetailPointer; files: number; bytes: number; maxBytes: number } | null {
  const daySet = new Set(days);
  if (!daySet.size) return null;
  const first = [...daySet].sort()[0]!;
  const startMs = Date.parse(`${first}T00:00:00Z`);
  const endMs = opts.nowMs + FUTURE_LEEWAY_MS;
  const byHour = new Map<string, EventNode[]>();
  for (const n of nodes) {
    if (n.state !== 'live' || n.eventTimeMs < startMs || n.eventTimeMs > endMs) continue;
    const k = hourKey(n.eventTimeMs);
    (byHour.get(k) ?? byHour.set(k, []).get(k)!).push(n);
  }
  let files = 0;
  let bytes = 0;
  let maxBytes = 0;
  let last = hourKey(startMs);
  for (let t = startMs; t <= endMs; t += HOUR_MS) {
    const hour = hourKey(t);
    const body = detailHourJson(hour, byHour.get(hour) ?? []);
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
  };
}
