import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXTRA_CANON_KEYS, NULLABLE_STD_KEYS, mergeCanonical } from './canonical.js';
import { GRID_CELL_DEG, SCHEMA_VERSION, dataPaths } from './config.js';
import { gridKey } from './geo.js';
import type { EventNode, Extra, Head, Observation, ProvenanceRow, State, Watermarks } from './types.js';
import { isoFromMs, round6 } from './util.js';

const readJson = <T>(path: string, fallback: T): T =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;

const ensureDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

/** Write only when content differs — keeps git blobs and shard files byte-stable. */
export function writeIfChanged(file: string, data: string): boolean {
  if (existsSync(file) && readFileSync(file, 'utf8') === data) return false;
  ensureDir(file);
  writeFileSync(file, data);
  return true;
}

export const eventDayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// --- event_map: sharded by UTC event-day (fixes C1: no unbounded single file) ---

/** Load the event_map, optionally limited to the last `sinceDays` of event-days.
 *  Reads day shards if present; falls back to the legacy monolithic file (migration). */
export function loadEventMap(root: string, opts: { sinceDays?: number; nowMs?: number } = {}): Map<string, EventNode> {
  const p = dataPaths(root);
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffDay = opts.sinceDays != null ? eventDayKey(nowMs - opts.sinceDays * 86_400_000) : null;
  const map = new Map<string, EventNode>();
  const add = (line: string): void => {
    const t = line.trim();
    if (!t) return;
    const node = JSON.parse(t) as EventNode;
    map.set(node.feedId, node);
  };
  if (existsSync(p.eventMapDir)) {
    for (const f of readdirSync(p.eventMapDir).sort()) {
      if (!f.endsWith('.ndjson')) continue;
      if (cutoffDay && f.slice(0, 10) < cutoffDay) continue;
      for (const line of readFileSync(join(p.eventMapDir, f), 'utf8').split('\n')) add(line);
    }
  } else if (existsSync(p.eventMapLegacy)) {
    // One-time migration: read the whole legacy file regardless of `sinceDays`, so the
    // narrow (aggregate) load can't drop older events before they're written as shards.
    for (const line of readFileSync(p.eventMapLegacy, 'utf8').split('\n')) add(line);
  }
  return map;
}

/** Persist the in-memory event_map as per-event-day shards (byte-compare writes).
 *  Only days present in `map` are (re)written; other shards are left untouched.
 *  Retires the legacy monolithic file once shards exist. */
export function saveEventMap(root: string, map: Map<string, EventNode>): void {
  const p = dataPaths(root);
  const byDay = new Map<string, EventNode[]>();
  for (const node of map.values()) {
    const key = eventDayKey(node.eventTimeMs);
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(node);
  }
  for (const [day, nodes] of byDay) {
    nodes.sort((a, b) => (a.feedId < b.feedId ? -1 : 1));
    writeIfChanged(join(p.eventMapDir, `${day}.ndjson`), nodes.map((n) => JSON.stringify(n)).join('\n') + '\n');
  }
  if (existsSync(p.eventMapLegacy)) rmSync(p.eventMapLegacy);
}

/** Delete event_map shards for event-days strictly before `beforeMs`
 *  (their identity is preserved in the frozen day partitions). Returns pruned days. */
export function pruneEventMapShards(root: string, beforeMs: number): string[] {
  const p = dataPaths(root);
  if (!existsSync(p.eventMapDir)) return [];
  const cutoffDay = eventDayKey(beforeMs);
  const pruned: string[] = [];
  for (const f of readdirSync(p.eventMapDir)) {
    if (f.endsWith('.ndjson') && f.slice(0, 10) < cutoffDay) {
      rmSync(join(p.eventMapDir, f));
      pruned.push(f.slice(0, 10));
    }
  }
  return pruned;
}

/** Oldest UTC event-day that still has an event_map shard — the live-window floor.
 *  Backfill fills strictly before it; onboarding fills the recent window at/after it. */
export function earliestEventMapDay(root: string, nowMs: number): string {
  const dir = dataPaths(root).eventMapDir;
  const today = eventDayKey(nowMs);
  if (!existsSync(dir)) return today;
  const days = readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => f.slice(0, 10))
    .sort();
  return days[0] ?? today;
}

export function loadState(root: string, opts: { sinceDays?: number; nowMs?: number } = {}): State {
  const p = dataPaths(root);
  return {
    head: readJson<Head>(p.head, { seq: 0, ingest_time: '' }),
    watermarks: readJson<Watermarks>(p.watermarks, {}),
    eventMap: loadEventMap(root, opts),
  };
}

/** Append-only: group observations by ingest-hour and append their NDJSON lines. */
export function appendObservations(root: string, obs: Observation[]): void {
  const p = dataPaths(root);
  const byFile = new Map<string, string[]>();
  for (const o of obs) {
    const d = new Date(o.ingest_time);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const file = join(p.observationsDir, `ingest=${yyyy}`, mm, dd, `${hh}.ndjson`);
    (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(JSON.stringify(o));
  }
  for (const [file, lines] of byFile) {
    ensureDir(file);
    appendFileSync(file, lines.join('\n') + '\n');
  }
}

/** head + watermarks + status + status/history (event_map is written separately). */
export function saveMeta(root: string, head: Head, watermarks: Watermarks, status: unknown): void {
  const p = dataPaths(root);
  ensureDir(p.head);
  writeFileSync(p.head, JSON.stringify(head, null, 2) + '\n');
  writeFileSync(p.watermarks, JSON.stringify(watermarks, null, 2) + '\n');
  writeFileSync(p.status, JSON.stringify(status, null, 2) + '\n');
  const now = new Date(head.ingest_time || Date.now());
  const histFile = join(p.statusHistoryDir, `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}.ndjson`);
  ensureDir(histFile);
  appendFileSync(histFile, JSON.stringify(status) + '\n');
}

// --- Feature <-> node (lossless round-trip, P1: enables identity-from-partitions) ---

const maxUpdated = (node: EventNode): number | null => {
  let m = -Infinity;
  for (const r of node.provenance) if (r.providerUpdatedMs != null) m = Math.max(m, r.providerUpdatedMs);
  return m === -Infinity ? null : m;
};

/** Materialize an EventNode into a USGS-GeoJSON-superset Feature, losslessly. */
export function nodeToFeature(node: EventNode): unknown {
  const updated = maxUpdated(node);
  // 2-element [lon, lat] when depth is unknown — never emit a null Z, so strictly
  // typed consumers (iOS `coordinates: [Double]`) can decode every Feature.
  const coordinates =
    node.depth == null
      ? [round6(node.lon), round6(node.lat)]
      : [round6(node.lon), round6(node.lat), node.depth];

  // Fill-only field merge: the chosen provider's coherent solution leads, then gaps fill
  // from the other providers (first non-null per canonical field wins). Core geometry and
  // magnitude stay from the chosen solution only — never mixed across providers.
  const chosen = node.provenance.find((r) => r.chosen) ?? node.provenance[0];
  const ordered = chosen ? [chosen, ...node.provenance.filter((r) => r !== chosen)] : node.provenance;
  const canon = mergeCanonical(ordered.map((r) => r.fields));
  const place = node.place ?? ordered.map((r) => r.place).find((p) => p != null) ?? null;

  const properties: Record<string, unknown> = {
    mag: node.mag,
    magType: node.magType,
    place,
    time: node.eventTimeMs,
    updated: updated ?? node.eventTimeMs,
    status: node.status,
    net: node.chosenProvider,
    tsunami: canon['tsunami'] ?? 0,
    type: (canon['type'] as string) ?? 'earthquake',
  };
  // USGS-standard nullable metrics/refs — always present (null when absent) for USGS-parser parity.
  for (const k of NULLABLE_STD_KEYS) properties[k] = canon[k] ?? null;
  // Cross-source attribution + geo-admin — surfaced only when a source actually provided them.
  for (const k of EXTRA_CANON_KEYS) if (canon[k] != null) properties[k] = canon[k];

  properties['feed'] = {
    schema_version: SCHEMA_VERSION,
    feed_id: node.feedId,
    event_time: isoFromMs(node.eventTimeMs),
    ingest_time: node.lastIngestTime,
    first_ingest_time: node.firstIngestTime,
    first_seen_seq: node.firstSeenSeq,
    ingest_seq: node.lastSeq,
    revision: node.revision,
    state: node.state,
    tombstone: node.state === 'tombstoned',
    ...(node.supersededBy ? { superseded_by: node.supersededBy } : {}),
    chosen_provider: node.chosenProvider,
    aliases: node.aliases,
    // Every provider's COMPLETE original field vocabulary is retained here under `fields` —
    // nothing a source reported is ever dropped, even fields not surfaced at top level.
    provenance: node.provenance.map((r) => ({
      provider: r.provider,
      native_id: r.nativeId,
      event_time: isoFromMs(r.eventTimeMs),
      mag: r.mag,
      magType: r.magType,
      status: r.status,
      provider_updated: r.providerUpdatedMs != null ? isoFromMs(r.providerUpdatedMs) : null,
      lat: round6(r.lat),
      lon: round6(r.lon),
      depth: r.depth,
      place: r.place,
      chosen: r.chosen,
      license: r.license,
      attribution: r.attribution,
      doi: r.doi,
      ...(Object.keys(r.fields).length ? { fields: r.fields } : {}),
    })),
  };

  return {
    type: 'Feature',
    id: node.feedId,
    // Top-level `source` mirrors `properties.net` (the chosen network). Lets a strict
    // client key its source enum off one required field without reading `properties`.
    source: node.chosenProvider,
    geometry: { type: 'Point', coordinates },
    properties,
  };
}

interface FeatureShape {
  id: string;
  geometry: { coordinates: [number, number, (number | null)?] };
  properties: {
    mag: number | null;
    magType: string | null;
    place: string | null;
    time: number;
    status: string | null;
    feed: Record<string, unknown>;
  };
}

/** Exact inverse of nodeToFeature — reconstruct an EventNode from a partition line. */
export function featureToNode(feature: unknown): EventNode {
  const f = feature as FeatureShape;
  const props = f.properties;
  const feed = props.feed;
  const [lon, lat] = f.geometry.coordinates;
  // Accept both new 2-element [lon, lat] (undefined) and legacy [lon, lat, null].
  const depth = f.geometry.coordinates[2] ?? null;
  const provenance: ProvenanceRow[] = (feed['provenance'] as Record<string, unknown>[]).map((r) => ({
    provider: r['provider'] as string,
    nativeId: r['native_id'] as string,
    eventTimeMs: Date.parse(r['event_time'] as string),
    mag: (r['mag'] as number | null) ?? null,
    magType: (r['magType'] as string | null) ?? null,
    status: (r['status'] as string | null) ?? null,
    providerUpdatedMs: r['provider_updated'] ? Date.parse(r['provider_updated'] as string) : null,
    lat: r['lat'] as number,
    lon: r['lon'] as number,
    depth: (r['depth'] as number | null) ?? null,
    place: (r['place'] as string | null) ?? null,
    chosen: Boolean(r['chosen']),
    license: r['license'] as string,
    attribution: r['attribution'] as string,
    doi: (r['doi'] as string | null) ?? null,
    fields: (r['fields'] as Extra) ?? {},
  }));
  return {
    feedId: f.id,
    aliases: feed['aliases'] as string[],
    eventTimeMs: props.time,
    firstIngestTime: feed['first_ingest_time'] as string,
    lastIngestTime: feed['ingest_time'] as string,
    lat,
    lon,
    depth,
    mag: props.mag,
    magType: props.magType,
    status: props.status,
    place: props.place,
    chosenProvider: feed['chosen_provider'] as string,
    provenance,
    revision: feed['revision'] as number,
    firstSeenSeq: feed['first_seen_seq'] as number,
    lastSeq: feed['ingest_seq'] as number,
    state: (feed['state'] as EventNode['state']) ?? (feed['tombstone'] ? 'tombstoned' : 'live'),
    ...(feed['superseded_by'] ? { supersededBy: feed['superseded_by'] as string } : {}),
    geohash: gridKey(lat, lon, GRID_CELL_DEG),
  };
}
