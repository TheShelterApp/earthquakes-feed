import { join } from 'node:path';

export const REPO = 'TheShelterApp/earthquakes-feed';
export const DOMAIN = 'earthquakes-feed.theshelter.app';
export const JSDELIVR_BASE = `https://cdn.jsdelivr.net/gh/${REPO}`;

export const SCHEMA_VERSION = 1;
export const FEED_ID_PREFIX = 'efd_';

/** Directory of the checked-out `data` branch (worktree in CI, plain dir locally). */
export const DATA_DIR = process.env.DATA_DIR ?? '.data';
/** Directory uploaded to Cloudflare Pages by derive.yml (not committed). */
export const PUBLIC_DIR = process.env.PUBLIC_DIR ?? 'public';
export const REGISTRY_PATH = process.env.REGISTRY_PATH ?? 'providers/registry.json';
export const SCHEMA_DIR = process.env.SCHEMA_DIR ?? 'schema';

// --- dedup / identity (base windows held identical to the iOS/web clients) ---
export const SPATIAL_KM = 10;
export const TEMPORAL_MS = 60_000;
/** Fixed-degree grid cell size for the spatial index (~22 km at the equator). */
export const GRID_CELL_DEG = 0.2;
/** Swarm guard: a grid cell holding this many live events disables proximity-merge. */
export const SWARM_CELL_ABSOLUTE = 50;
export const MAG_MERGE_MAX_DELTA = 0.8;
/** Large-event proximity. Preliminary epicentres of one M6–7 quake scatter by tens of km
 *  across agencies (Loyalty Islands M7.0, 2026-09-25: 22–62 km, six feed ids), so when BOTH
 *  solutions are ≥ LARGE_EVENT_MAG the spatial window is
 *  clamp(LARGE_EVENT_BASE_KM + LARGE_EVENT_KM_PER_MAG · (min(mag) − LARGE_EVENT_MAG), LARGE_EVENT_BASE_KM, LARGE_EVENT_MAX_KM)
 *  (M5.5 → 20 km, M6.0 → 30, M6.5 → 40, M7.0 → 50; the cap is the alerts gateway's own fold
 *  window) before the usual ΔM shrink. On that widened path a hard |ΔM| ≤ LARGE_EVENT_MAX_DELTA
 *  keeps a large aftershock out of the mainshock's window.
 *  The base was 10 km (= SPATIAL_KM) until 2026-09-28; agencies scatter by 15–35 km at M5.5–5.8
 *  (the Loyalty aftershock M5.5, USGS vs EMSC 16.5 km; Tonga M5.7, 18.7 km). 20 km was measured
 *  by replaying the whole observation log (2026-07-05 … 09-28, 184,629 lines): 57 more groups
 *  folded, 55 fewer live duplicates, no false merge (tests/fixtures/replay-report-pf2.md). */
export const LARGE_EVENT_MAG = 5.5;
export const LARGE_EVENT_BASE_KM = 20;
export const LARGE_EVENT_KM_PER_MAG = 20;
export const LARGE_EVENT_MAX_KM = 50;
export const LARGE_EVENT_MAX_DELTA = 1.0;
/** A provider re-publishing ONE solution under a second native id (INGV 46714321 / 47246702,
 *  2026-09-25) is a re-id, not a distinct event: rows this close fold instead of minting. */
export const REID_DT_MS = 2_000;
export const REID_KM = 2;
export const REID_MAG_DELTA = 0.1;
/** Bound on the post-revision merge chain one ingest may trigger (each round retires a node). */
export const MERGE_MAX_ROUNDS = 8;
/** A retired event (superseded by an op:merge, or tombstoned: an upstream delete, a provider's
 *  zeroed withdrawal or the feed's own retraction) stays published, compact and flagged
 *  non-live, for this long after its last ingest, so a poller that treats absence as "still
 *  there" sees the removal. Tombstones joined on 2026-09-28, once every consumer that reads the
 *  Pages files without the state filter was fixed (the alerts gateway's pages_url path). */
export const RETIRED_VISIBLE_MS = 48 * 3600_000;
/** The one-time heal (src/heal.ts). aggregate runs it once when the data branch's
 *  knowledge/index/heal.json holds a lower epoch (or none): the op:merge pass over every live
 *  node in the hot window (Resolver.heal) and the coordinate-less retraction over the whole
 *  event-map horizon, logged like any other change, then the marker records this epoch in the
 *  same commit. Bump it only to run a new heal on purpose. */
export const HEAL_EPOCH = 1;
/** Only events within this many days are kept in the in-memory dedup index. */
export const HOT_WINDOW_DAYS = 7;
/** aggregate loads only this many days of event_map shards (fast hot path). */
export const LIVE_INDEX_DAYS = Number(process.env.LIVE_INDEX_DAYS ?? 10);
/** derive loads this many days (covers the 30-day month summary + revision tail);
 *  event_map shards older than this are pruned (their identity lives in frozen partitions). */
export const EVENT_MAP_HORIZON_DAYS = Number(process.env.EVENT_MAP_HORIZON_DAYS ?? 45);

// --- fetching ---
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 8000);
/** Backfill/onboarding tolerate slower nodes (hourly, not the 5-min hot path). */
export const BACKFILL_FETCH_TIMEOUT_MS = Number(process.env.BACKFILL_FETCH_TIMEOUT_MS ?? 20000);
/** Each run asks providers for events in [now - lookback, now]; dedup absorbs overlap. */
export const QUERY_LOOKBACK_MS = Number(process.env.QUERY_LOOKBACK_MS ?? 2 * 24 * 3600 * 1000);
export const FETCH_LIMIT = Number(process.env.FETCH_LIMIT ?? 5000);

// --- derived views ---
export const MAX_PUBLISHED_BYTES = 18 * 1024 * 1024;
export const SUMMARY_WINDOWS: Record<string, number> = {
  hour: 3600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};
/** null threshold = "all". */
export const SUMMARY_THRESHOLDS: Record<string, number | null> = {
  all: null,
  '1.0': 1.0,
  '2.5': 2.5,
  '4.5': 4.5,
  significant: 4.5,
};

export function dataPaths(root = DATA_DIR) {
  return {
    root,
    observationsDir: join(root, 'knowledge', 'observations'),
    snapshotsDir: join(root, 'knowledge', 'snapshots'),
    indexDir: join(root, 'knowledge', 'index'),
    head: join(root, 'knowledge', 'index', 'head.json'),
    eventMapDir: join(root, 'knowledge', 'index', 'event_map'),
    eventMapLegacy: join(root, 'knowledge', 'index', 'event_map.ndjson'),
    watermarks: join(root, 'knowledge', 'index', 'watermarks.json'),
    backfillCursor: join(root, 'knowledge', 'index', 'backfill.json'),
    onboardCursor: join(root, 'knowledge', 'index', 'onboard.json'),
    healMarker: join(root, 'knowledge', 'index', 'heal.json'),
    archivesIndex: join(root, 'knowledge', 'index', 'archives.json'),
    partitionsIndex: join(root, 'knowledge', 'index', 'partitions.json'),
    providerHealth: join(root, 'knowledge', 'index', 'provider_health.json'),
    changesCursor: join(root, 'knowledge', 'index', 'changes.json'),
    changesDir: join(root, 'changes'),
    eventsDir: join(root, 'events'),
    feedDir: join(root, 'v1'),
    manifest: join(root, 'manifest.json'),
    status: join(root, 'status.json'),
    statusHistoryDir: join(root, 'status', 'history'),
  };
}
