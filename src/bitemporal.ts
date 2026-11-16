import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXTRA_CANON_KEYS, NULLABLE_STD_KEYS, mergeCanonical } from './canonical.js';
import { reviewStatusOfNode, reviewStatusOfRow } from './review-status.js';
import { GRID_CELL_DEG, SCHEMA_VERSION, dataPaths } from './config.js';
import { dayFileName, eventMapFiles, eventMapShardHours, readGeneration } from './event-map-store.js';
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

// --- event_map: sharded by UTC event-day (fixes C1: no unbounded single file); its blobs in the state store from phase 3 ---

/** The day file of `day` (`YYYY-MM-DD.ndjson`). */
export const eventMapDayFile = dayFileName;

/**
 * The event-map file of a node of `day` at `eventTimeMs`: with `hours` 24 the day file, otherwise the shard of
 * `hours` hours from HH (`YYYY-MM-DD-HH.ndjson`, round 17). saveEventMap writes hour shards (1) while git tracks the
 * event map (phase 3a): an aggregate commit then rewrites ~70 KB shards instead of ~1.7 MB day files, which git keeps
 * for ever. Once the store is authoritative and git no longer holds the files (phase 3b), it writes day files
 * (src/event-map-store.ts eventMapShardHours). Either layout reads alike everywhere, and a day's store bytes are
 * canonicalDay of its files, whatever their layout.
 */
export function eventMapShardName(day: string, eventTimeMs: number, hours: number): string {
  if (hours >= 24) return eventMapDayFile(day);
  const h = new Date(eventTimeMs).getUTCHours();
  return `${day}-${String(h - (h % hours)).padStart(2, '0')}.ndjson`;
}

/** Load the event_map, optionally limited to the last `sinceDays` of event-days.
 *  Reads the day files (and any round-17 hour shards); falls back to the legacy monolithic file (migration). A feed id
 *  found in two files (only after a layout change, or a node moved to a day no run rewrote since) keeps the node with
 *  the higher `lastSeq`; on a tie the file read later (name order) wins, as before round 17. The phase-3b sentinel
 *  (`0000-00-00*`) and any other name are skipped.
 *
 *  The map's order: event-day by event-day, each day's nodes in feed-id order (the order of a day file, which
 *  saveEventMap writes sorted by feed id). The Resolver indexes the map in this order and some of its tie-breaks follow
 *  it (the first candidate at an equal distance wins), so hour shards read in name order (hour, then feed id) would
 *  change which node an equidistant report joins (round 17 review).
 *
 *  Fail closed (storage phase 3): absence never reads as an empty map. With a generation document
 *  (knowledge/index/generation.json), every day it lists from the load's first day on must have a file in the checkout,
 *  else this throws (a day lost from disk, by a rebase or a partial hydrate, would otherwise vanish from every view and,
 *  saved back, from the state). With neither a map, a legacy file nor a generation it throws, unless `bootstrap`
 *  (EVENT_MAP_BOOTSTRAP=1: a fresh data branch). */
export function loadEventMap(
  root: string,
  opts: { sinceDays?: number; nowMs?: number; bootstrap?: boolean } = {},
): Map<string, EventNode> {
  const p = dataPaths(root);
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffDay = opts.sinceDays != null ? eventDayKey(nowMs - opts.sinceDays * 86_400_000) : null;
  const gen = readGeneration(root);
  const map = new Map<string, EventNode>();
  const add = (node: EventNode): void => {
    const held = map.get(node.feedId);
    if (held && (held.lastSeq ?? -1) > (node.lastSeq ?? -1)) return;
    map.set(node.feedId, node);
  };
  const parse = (text: string, into: EventNode[]): void => {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t) into.push(JSON.parse(t) as EventNode);
    }
  };
  const wanted = (day: string): boolean => !cutoffDay || day >= cutoffDay;
  const genDays = gen ? Object.keys(gen.generation.days).filter(wanted) : [];
  if (existsSync(p.eventMapDir)) {
    const files = eventMapFiles(root);
    const lacking = genDays.filter((d) => !files.has(d));
    if (lacking.length) {
      throw new Error(
        `event map: the generation lists ${lacking.length} day(s) the checkout lacks (${lacking.slice(0, 5).join(', ')}${lacking.length > 5 ? ', …' : ''}): ` +
          'refusing to read them as empty',
      );
    }
    for (const [day, names] of files) {
      if (!wanted(day)) continue;
      const nodes: EventNode[] = [];
      for (const f of names) parse(readFileSync(join(p.eventMapDir, f), 'utf8'), nodes);
      // A stable sort: lines of one feed id keep their file order, so the later file still wins a lastSeq tie.
      nodes.sort((a, b) => (a.feedId < b.feedId ? -1 : a.feedId > b.feedId ? 1 : 0));
      for (const n of nodes) add(n);
    }
  } else if (existsSync(p.eventMapLegacy)) {
    // One-time migration: read the whole legacy file regardless of `sinceDays`, so the
    // narrow (aggregate) load can't drop older events before they're written as day files.
    const nodes: EventNode[] = [];
    parse(readFileSync(p.eventMapLegacy, 'utf8'), nodes);
    for (const n of nodes) add(n);
  } else if (gen) {
    if (genDays.length) {
      throw new Error(`event map: the generation lists ${genDays.length} day(s) and the checkout has no knowledge/index/event_map: refusing to read them as empty`);
    }
  } else if (!(opts.bootstrap ?? process.env.EVENT_MAP_BOOTSTRAP === '1')) {
    throw new Error(
      'event map: the data checkout has none (no knowledge/index/event_map, no legacy event_map.ndjson, no generation.json): ' +
        'refusing to read it as empty (EVENT_MAP_BOOTSTRAP=1 starts an empty one on a fresh data branch)',
    );
  }
  return map;
}

/** Persist the in-memory event_map as shards of `opts.hours` hours of each event-day (default eventMapShardHours():
 *  1 while git tracks the event map, 24, one file per day, from phase 3b; byte-compare writes, lines in feed-id order).
 *  Only days present in `map` are (re)written, and each of those loses the files it no longer fills (an hour every node
 *  left, or the other layout's files); other days' files are left untouched. With `opts.floorDay` (the first event-day
 *  the run loaded), a day below it is not rewritten from `map`: its nodes there are merged into its files on disk,
 *  upserted by feed id. Retires the legacy monolithic file once shards exist.
 *
 *  Whatever the layout, canonicalDay of a day's files is the day file's bytes, so the day's sha256 is the generation's
 *  entry (src/event-map-store.ts). */
export function saveEventMap(root: string, map: Map<string, EventNode>, opts: { floorDay?: string; hours?: number } = {}): void {
  const hours = opts.hours ?? eventMapShardHours();
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 || 24 % hours !== 0) throw new Error(`event map shard hours ${hours}: a divisor of 24`);
  const p = dataPaths(root);
  const byDay = new Map<string, EventNode[]>();
  for (const node of map.values()) {
    const key = eventDayKey(node.eventTimeMs);
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(node);
  }
  const existing = eventMapFiles(root);
  // A day below the load floor (`floorDay`, the first event-day loadEventMap read) was NOT loaded: `map` holds only the
  // nodes a revision moved onto it (an updatedafter sweep reaches further back than the loaded window). Rewriting it
  // from `map` alone would drop every other event of that day, so merge: the day's nodes on disk, upserted by feed id
  // with the moved nodes (2026-11-15 audit). A day the generation lists that has no file is never read as empty
  // (storage phase 3): the merge would write the moved nodes alone.
  if (opts.floorDay) {
    const gen = readGeneration(root);
    for (const [day, nodes] of byDay) {
      if (day >= opts.floorDay) continue;
      const names = existing.get(day) ?? [];
      if (!names.length && gen?.generation.days[day]) {
        throw new Error(`event map: a revision moved a node onto ${day}, which the generation lists and the checkout lacks: refusing to write the day from that node alone`);
      }
      const merged = new Map<string, EventNode>();
      for (const f of names) {
        for (const line of readFileSync(join(p.eventMapDir, f), 'utf8').split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const n = JSON.parse(t) as EventNode;
          const held = merged.get(n.feedId);
          if (!held || (held.lastSeq ?? -1) <= (n.lastSeq ?? -1)) merged.set(n.feedId, n);
        }
      }
      for (const n of nodes) merged.set(n.feedId, n);
      byDay.set(day, [...merged.values()].filter((n) => eventDayKey(n.eventTimeMs) === day));
    }
  }
  for (const [day, nodes] of byDay) {
    nodes.sort((a, b) => (a.feedId < b.feedId ? -1 : 1));
    const files = new Map<string, string[]>();
    for (const n of nodes) {
      const f = eventMapShardName(day, n.eventTimeMs, hours);
      (files.get(f) ?? files.set(f, []).get(f)!).push(JSON.stringify(n));
    }
    for (const [f, lines] of files) writeIfChanged(join(p.eventMapDir, f), lines.join('\n') + '\n');
    for (const f of existing.get(day) ?? []) if (!files.has(f)) rmSync(join(p.eventMapDir, f));
  }
  if (existsSync(p.eventMapLegacy)) rmSync(p.eventMapLegacy);
}

/** Delete event_map files for event-days strictly before `beforeMs` (their identity is preserved in the frozen day
 *  partitions; derive also drops them from the generation, src/event-map-store.ts pruneGeneration). Never the phase-3b
 *  sentinel. Returns the pruned days, each once. */
export function pruneEventMapShards(root: string, beforeMs: number): string[] {
  const p = dataPaths(root);
  const cutoffDay = eventDayKey(beforeMs);
  const pruned: string[] = [];
  for (const [day, names] of eventMapFiles(root)) {
    if (day >= cutoffDay) continue;
    for (const f of names) rmSync(join(p.eventMapDir, f));
    pruned.push(day);
  }
  return pruned;
}

export function loadState(root: string, opts: { sinceDays?: number; nowMs?: number; bootstrap?: boolean } = {}): State {
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

/** The observation-log lines of the ingest days from `fromDay` (YYYY-MM-DD) on that the data branch holds (older ingest
 *  months move to the `archive-YYYY-MM` Releases), in seq order. */
export function readObservations(root: string, fromDay: string): Observation[] {
  const dir = dataPaths(root).observationsDir;
  const out: Observation[] = [];
  const list = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort() : []);
  for (const y of list(dir)) {
    if (!y.startsWith('ingest=')) continue;
    const yyyy = y.slice('ingest='.length);
    for (const mm of list(join(dir, y))) {
      for (const dd of list(join(dir, y, mm))) {
        if (`${yyyy}-${mm}-${dd}` < fromDay) continue;
        for (const f of list(join(dir, y, mm, dd))) {
          if (!f.endsWith('.ndjson')) continue;
          for (const line of readFileSync(join(dir, y, mm, dd, f), 'utf8').split('\n')) if (line.trim()) out.push(JSON.parse(line) as Observation);
        }
      }
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** The per-provider fields status.json carries for the current run only, left out of its status/history line. */
export const HISTORY_OMITTED_PROVIDER_FIELDS = ['newest_origin', 'tls_leaf'] as const;

/** A status/history day file past this size draws a warning. A day is about 1.3 MB (288 runs at about 4.5 KB a line);
 *  5 MB means the line has grown about fourfold, which grows every aggregate commit's rewrite of the day file and the
 *  month asset it rolls into (APIs.md Run logs). Until round 17 this guarded the month file (45 MB, against GitHub's
 *  50 MiB warning and 100 MiB rejection of a pushed file). */
export const HISTORY_FILE_WARN_BYTES = 5_000_000;

/** A status/history file name: `YYYY-MM-DD.ndjson` (one UTC day, since round 17) or `YYYY-MM.ndjson` (one month, the
 *  layout until round 17: the October 2026 file holds the lines before the switch). */
const STATUS_HISTORY_NAME = /^(\d{4}-\d{2})(?:-(\d{2}))?\.ndjson$/;

export interface StatusHistoryFile {
  /** Absolute path. */
  path: string;
  /** YYYY-MM the file belongs to. */
  month: string;
  /** YYYY-MM-DD for a day file, null for a month file. */
  day: string | null;
}

/**
 * The status/history files in the order their lines were written: month by month, a month file (written until round
 * 17) before the day files of that month, the day files by day. Concatenated in this order they are the month file the
 * layout before round 17 would have written, byte for byte (a line goes to the file of its run's ingest time, which only
 * moves forward).
 */
export function statusHistoryFiles(dir: string): StatusHistoryFile[] {
  if (!existsSync(dir)) return [];
  const out: (StatusHistoryFile & { key: string })[] = [];
  for (const f of readdirSync(dir)) {
    const m = STATUS_HISTORY_NAME.exec(f);
    if (!m) continue;
    const day = m[2] ? `${m[1]}-${m[2]}` : null;
    out.push({ path: join(dir, f), month: m[1]!, day, key: day ?? `${m[1]}-00` });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(({ key: _k, ...f }) => f);
}

/**
 * The status/history line of a run (FEED-R15-1, round 16): status.json without `providers.<id>.newest_origin` and
 * `providers.<id>.tls_leaf`. Both serve the current run only: the frozen check reads the newest origins of the run's
 * own answers (a frozen source keeps its `newest_origin` in the top-level `frozen`), and `tls_leaf` repeats the
 * top-level `tls_leaves`, which the line keeps. With them a line grew from ~4.4 KB to ~6.5 KB (a month file of
 * ~54 MB at 12 runs an hour). Everything else passes through untouched; a status without `providers` is returned as is.
 */
export function historyStatus(status: unknown): unknown {
  if (status == null || typeof status !== 'object' || Array.isArray(status)) return status;
  const providers = (status as { providers?: unknown }).providers;
  if (providers == null || typeof providers !== 'object' || Array.isArray(providers)) return status;
  const slim: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(providers as Record<string, unknown>)) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      slim[id] = entry;
      continue;
    }
    const rest: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
    for (const k of HISTORY_OMITTED_PROVIDER_FIELDS) delete rest[k];
    slim[id] = rest;
  }
  return { ...(status as Record<string, unknown>), providers: slim };
}

/** head + watermarks + status + status/history (event_map is written separately). status.json is the full status; the
 *  history line is `historyStatus(status)`, appended to the day file of the head's ingest time,
 *  `status/history/YYYY-MM-DD.ndjson` (round 17, LANE G: every aggregate commit used to rewrite the whole month file,
 *  up to ~40 MB at a month's end; a day file stays near 1.3 MB). Returns the history file and its size after the
 *  append. */
export function saveMeta(root: string, head: Head, watermarks: Watermarks, status: unknown): { historyFile: string; historyBytes: number } {
  const p = dataPaths(root);
  ensureDir(p.head);
  writeFileSync(p.head, JSON.stringify(head, null, 2) + '\n');
  writeFileSync(p.watermarks, JSON.stringify(watermarks, null, 2) + '\n');
  writeFileSync(p.status, JSON.stringify(status, null, 2) + '\n');
  const now = new Date(head.ingest_time || Date.now());
  const histFile = join(p.statusHistoryDir, `${now.toISOString().slice(0, 10)}.ndjson`);
  ensureDir(histFile);
  appendFileSync(histFile, JSON.stringify(historyStatus(status)) + '\n');
  return { historyFile: histFile, historyBytes: statSync(histFile).size };
}

// --- Feature <-> node (lossless round-trip, P1: enables identity-from-partitions) ---

const maxUpdated = (node: EventNode): number | null => {
  let m = -Infinity;
  for (const r of node.provenance) if (r.providerUpdatedMs != null) m = Math.max(m, r.providerUpdatedMs);
  return m === -Infinity ? null : m;
};

/**
 * The event's merged auxiliary fields and place, as its feature shows them: the chosen provider's coherent solution
 * leads, then gaps fill from the other providers (first non-null per canonical field wins). Core geometry and
 * magnitude stay from the chosen solution only — never mixed across providers.
 */
export function canonicalOf(node: EventNode): { canon: Extra; place: string | null } {
  const chosen = node.provenance.find((r) => r.chosen) ?? node.provenance[0];
  const ordered = chosen ? [chosen, ...node.provenance.filter((r) => r !== chosen)] : node.provenance;
  return {
    canon: mergeCanonical(ordered.map((r) => r.fields)),
    place: node.place ?? ordered.map((r) => r.place).find((p) => p != null) ?? null,
  };
}

/** Materialize an EventNode into a USGS-GeoJSON-superset Feature, losslessly.
 *
 *  `compact` omits `feed.provenance[]` (each provider's full solution + original
 *  vocabulary) — used for the ROLLING SUMMARIES only, whose saturated 30-day window at
 *  38 sources cannot fit a single servable file full-fat (Pages hard limit 25 MiB).
 *  Nothing is lost: day partitions and /v1/events day files stay full-fat, and the
 *  summary keeps `aliases` + `chosen_provider` for realtime dedup. */
/** `reviewStatus`: add the normalized `review_status` (review-status.ts) to the event's properties and to each
 *  provenance row, when the source says it. Opt-in: the surfaces derive rebuilds every run (summaries, the live and month
 *  indexes, the detail hours, the Pages day files) always pass it; the day partitions pass it from the day their
 *  PartitionFormat names (partitions.ts), so a frozen day never changes. */
export function nodeToFeature(node: EventNode, opts?: { compact?: boolean; reviewStatus?: boolean }): unknown {
  const updated = maxUpdated(node);
  // 2-element [lon, lat] when depth is unknown — never emit a null Z, so strictly
  // typed consumers (iOS `coordinates: [Double]`) can decode every Feature.
  const coordinates =
    node.depth == null
      ? [round6(node.lon), round6(node.lat)]
      : [round6(node.lon), round6(node.lat), node.depth];

  const { canon, place } = canonicalOf(node);

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
  if (opts?.reviewStatus) {
    const rs = reviewStatusOfNode(node);
    if (rs) properties['review_status'] = rs;
  }

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
    // (Omitted in compact summary features — full detail lives in the day files/partitions.)
    ...(opts?.compact ? {} : { provenance: node.provenance.map((r) => ({
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
      ...(opts?.reviewStatus && reviewStatusOfRow(r) ? { review_status: reviewStatusOfRow(r) } : {}),
      ...(Object.keys(r.fields).length ? { fields: r.fields } : {}),
    })) }),
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
