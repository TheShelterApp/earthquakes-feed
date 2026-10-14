/**
 * Cloudflare Pages `_headers` for the published tree (written by derive).
 *
 * Pages applies EVERY rule whose path pattern matches a request and joins a header set by
 * several of them with ", ". The old file had `/v1/*`, `/v1/events/*` and a rule for today's
 * day file, so on 2026-09-28 today's file was served with
 * `Cache-Control: public, max-age=30, stale-while-revalidate=120, public, max-age=3600, public,
 * max-age=300, stale-while-revalidate=600` (a client picks any of three lifetimes) and
 * `Access-Control-Allow-Origin: *, *, *` (which a browser rejects: only one value is allowed),
 * and the change-log got the same doubling. Here every published path matches exactly one rule:
 * a `:name` placeholder matches one path segment (never a "/"), so `/v1/:file` covers the
 * top-level files only, and the day files are listed by name.
 */

/** Pages refuses a `_headers` file with more rules than this. */
export const PAGES_HEADER_RULE_LIMIT = 100;

export const CACHE_CONTROL = {
  /** manifest.json, status.json and the rolling summaries: rewritten every run. */
  top: 'public, max-age=30, stale-while-revalidate=120',
  /** Today's and yesterday's day files: still filling (late reports land minutes after midnight). */
  hotDay: 'public, max-age=300, stale-while-revalidate=600',
  /** Older day files: they change only on a revision, a merge or a retraction. */
  coldDay: 'public, max-age=3600',
  /** The change-log: tailed with Range from the last byte offset; short edge cache. */
  changes: 'public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400',
  /** The v2 manifest (signed envelope, ~KBs): clients revalidate with ETag, the edge absorbs it. */
  v2: 'public, max-age=0, s-maxage=60, stale-while-revalidate=120, stale-if-error=86400',
  /** The live index's day files (live-sync.ts): stable bytes that a client fetches when the index's sha256 for the day
   *  differs from its copy, so a cached copy must never be served without asking (an ETag revalidation is a 304). Also
   *  the unfrozen day partitions (`/events/YYYY/MM/DD.ndjson`, round 25): the v2 manifest's sha256 names their current
   *  bytes, and a reader that gets other bytes moves to the next origin. */
  liveDay: 'public, max-age=0, must-revalidate',
} as const;

const DAY_MS = 86_400_000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The NDJSON files' type (R25-FOLLOWUPS (4)). Wrangler names no type for `.ndjson`, so until 2026-10-14 Pages served
 *  the change-log and the day partitions as `application/octet-stream`, uncompressed (about 1–2.5 MB a day partition)
 *  while the GeoJSON files went out as brotli. A `_headers` value replaces the type Pages sends. The bytes do not change:
 *  a client decodes any Content-Encoding first, so the v2 manifest's sha256 still names them. Pages already answered a
 *  Range request on these files with the whole body (200, measured 2026-10-14), so no reader loses a byte range. */
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

function rule(path: string, cacheControl: string, contentType?: string): string[] {
  return [path, `  Cache-Control: ${cacheControl}`, '  Access-Control-Allow-Origin: *', ...(contentType ? [`  Content-Type: ${contentType}`] : [])];
}

/** The `_headers` body for a deploy at `nowMs` that publishes the day files `dayKeys`
 *  (`/v1/events/<day>.geojson`). A day on or after yesterday (UTC) is hot, older ones cold.
 *  Should the day list ever outgrow the rule limit, every day file shares one placeholder rule
 *  with the hot lifetime instead — still one value per file. */
export function pagesHeaders(nowMs: number, dayKeys: Iterable<string>): string {
  const hotFrom = dayOf(nowMs - DAY_MS);
  const days = [...new Set(dayKeys)].sort();
  const fixed = [
    rule('/v1/:file', CACHE_CONTROL.top),
    // Only the day's change-log (`<day>.ndjson`) is published here.
    rule('/v1/changes/:file', CACHE_CONTROL.changes, NDJSON_CONTENT_TYPE),
    rule('/v2/*', CACHE_CONTROL.v2),
    // The live index (index.json + the deltas, rewritten every run) and its day files (live-sync.ts).
    rule('/v1/live/:file', CACHE_CONTROL.top),
    rule('/v1/live/days/:file', CACHE_CONTROL.liveDay),
    // The per-hour detail files (event-detail.ts): recent hours still fill, like the hot day files.
    rule('/v1/detail/:file', CACHE_CONTROL.hotDay),
    // The unfrozen day partitions (NDJSON, partitions.ts writePagesPartition): the manifest's `url` and the v2 `pages`
    // origin. Outside /v1/, so no other rule matches them.
    rule('/events/*', CACHE_CONTROL.liveDay, NDJSON_CONTENT_TYPE),
  ];
  const perDay = fixed.length + days.length <= PAGES_HEADER_RULE_LIMIT;
  const dayRules = perDay
    ? days.map((d) => rule(`/v1/events/${d}.geojson`, d >= hotFrom ? CACHE_CONTROL.hotDay : CACHE_CONTROL.coldDay))
    : [rule('/v1/events/:file', CACHE_CONTROL.hotDay)];
  return [...fixed[0]!, ...dayRules.flat(), ...fixed.slice(1).flat(), ''].join('\n');
}
