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
/** Only events within this many days are kept in the in-memory dedup index. */
export const HOT_WINDOW_DAYS = 7;
/** aggregate loads only this many days of event_map shards (fast hot path). */
export const LIVE_INDEX_DAYS = Number(process.env.LIVE_INDEX_DAYS ?? 10);
/** derive loads this many days (covers the 30-day month summary + revision tail);
 *  event_map shards older than this are pruned (their identity lives in frozen partitions). */
export const EVENT_MAP_HORIZON_DAYS = Number(process.env.EVENT_MAP_HORIZON_DAYS ?? 45);

// --- fetching ---
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 8000);
export const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS ?? 180_000);
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
    archivesIndex: join(root, 'knowledge', 'index', 'archives.json'),
    partitionsIndex: join(root, 'knowledge', 'index', 'partitions.json'),
    eventsDir: join(root, 'events'),
    feedDir: join(root, 'v1'),
    manifest: join(root, 'manifest.json'),
    status: join(root, 'status.json'),
    statusHistoryDir: join(root, 'status', 'history'),
  };
}
