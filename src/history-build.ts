import { nodeToFeature } from './bitemporal.js';
import { Resolver } from './dedup.js';
import { haversineKm } from './geo.js';
import { FETCH_MARGIN_MAG, type HistoryEra, type Period, dayKeyOf, periodDays } from './history-config.js';
import type { WindowLog } from './history-fetch.js';
import { configMap, priorityMap } from './providers.js';
import { byIngestOrder, emptyTally, screen } from './quality.js';
import type { EventNode, ProviderConfig, RawObs } from './types.js';

/**
 * Deep history (PF-5j): the raw layer's file format and the offline build of one month's events edition.
 *
 * The build is the backfill's own identity resolution over a closed window: one Resolver (hot floor 0, merge pass off,
 * as src/backfill.ts runs it) over every raw row of the month, in the deterministic ingest order, so the same raw
 * assets always give the same events and the same feed ids (the ids are seeded by time and place, src/ulid.ts). It
 * reads nothing from and writes nothing to the live data: no observation log, no event map, no day partition.
 *
 * The month's newer neighbour is already frozen when the month is built (the walk goes backwards): the 3-year layer's
 * first day (in an `archive-YYYY-MM` Release) for the month before the boundary, else the first day of the newer
 * month's current edition. Its events are loaded read-only, so a quake whose rows straddle midnight is one event: a
 * row of this month that joins one of them is not written (that event's file is immutable) and is listed in the
 * edition's `joined_newer` instead.
 */

export const RAW_KIND = 'earthquakes-feed/history-raw';
export const EDITION_KIND = 'earthquakes-feed/history-edition';

export interface RawHeader {
  kind: typeof RAW_KIND;
  version: 1;
  source: string;
  period: string;
  /** The range fetched, [start, end). */
  start: string;
  end: string;
  /** The minmagnitude asked for (the era's floor minus the margin), null for none. */
  fetch_min_magnitude: number | null;
  fetched_at: string;
  /** Rows in this file (one per native id). */
  rows: number;
  response_rows: number;
  parsed_rows: number;
  duplicate_ids: number;
  /** The source's own count of the range (count service), or null where the source has none. */
  provider_count: number | null;
  requests: number;
  windows: WindowLog[];
  user_agent: string;
}

/** Header line, then one RawObs per line in the deterministic ingest order. */
export function rawFileText(header: RawHeader, rows: RawObs[]): string {
  const sorted = [...rows].sort(byIngestOrder);
  return [JSON.stringify(header), ...sorted.map((r) => JSON.stringify(r))].join('\n') + '\n';
}

export function parseRawText(text: string): { header: RawHeader; rows: RawObs[] } {
  const lines = text.split('\n').filter((l) => l.trim());
  const header = JSON.parse(lines[0] ?? 'null') as RawHeader | null;
  if (!header || header.kind !== RAW_KIND || header.version !== 1) throw new Error('not a history raw file (header line)');
  const rows = lines.slice(1).map((l) => JSON.parse(l) as RawObs);
  if (rows.length !== header.rows) throw new Error(`raw file holds ${rows.length} rows where its header says ${header.rows}`);
  return { header, rows };
}

export interface RawInput {
  asset: string;
  sha256: string;
  header: RawHeader;
  rows: RawObs[];
}

/** The frozen newer neighbour's first day (read-only). */
export interface ContextInput {
  /** Where it was read from, e.g. `archive-2023-07/events-2023-07.tar.zst#06.ndjson`. */
  label: string;
  day: string;
  nodes: EventNode[];
  /** The checksum of the asset the day was read from, as its index lists it (archives.json / history.json), so a
   *  later re-roll of that archive stays visible against this edition. */
  sha256?: string | null;
}

export interface BuildInput {
  period: Period;
  era: HistoryEra;
  edition: number;
  raws: RawInput[];
  context: ContextInput | null;
  registry: ProviderConfig[];
  boundary: string;
  /** Every day an `archive-YYYY-MM` entry lists (knowledge/index/archives.json). */
  archivedDays: ReadonlySet<string>;
}

export interface JoinedRow {
  provider: string;
  native_id: string;
  feed_id: string;
}

export interface EditionMeta {
  kind: typeof EDITION_KIND;
  version: 1;
  period: string;
  edition: number;
  era: string;
  min_magnitude: number | null;
  boundary: string;
  start: string;
  end: string;
  sources: string[];
  raw: { source: string; asset: string; sha256: string; rows: number; provider_count: number | null }[];
  context: { label: string; day: string; events: number; sha256: string | null } | null;
  events: number;
  days: string[];
  rows: {
    /** Rows in the raw assets. */
    fetched: number;
    /** Dropped at the door, as on every ingest path (quality.ts). */
    bad_coords: number;
    coordinateless: number;
    /** Rows inside the events written. */
    written: number;
    /** Rows that joined an event of the frozen newer neighbour. */
    joined_newer: number;
    /** Rows of events under the era's magnitude floor. */
    below_floor: number;
  };
  /** Events dropped by the magnitude floor. */
  below_floor_events: number;
  /** Two events within 60 s and 10 km that each hold a row of the same source under distinct ids (the source lists
   *  two quakes there; for one source alone this is the usual aftershock / swarm pattern, kept as the source has it). */
  same_source_near_pairs: number;
  joined_newer: JoinedRow[];
}

export class HistoryBuildError extends Error {}

const maxMag = (n: EventNode): number | null => {
  let m: number | null = null;
  for (const r of n.provenance) if (r.mag != null && (m == null || r.mag > m)) m = r.mag;
  return m;
};

/** Same-source pairs within 60 s / 10 km among `nodes` (sorted by time). */
export function sameSourceNearPairs(nodes: EventNode[]): number {
  const sorted = [...nodes].sort((a, b) => a.eventTimeMs - b.eventTimeMs);
  let pairs = 0;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    const aProv = new Set(a.provenance.map((r) => r.provider));
    for (let j = i + 1; j < sorted.length && sorted[j]!.eventTimeMs - a.eventTimeMs <= 60_000; j++) {
      const b = sorted[j]!;
      if (!b.provenance.some((r) => aProv.has(r.provider))) continue;
      if (haversineKm(a.lat, a.lon, b.lat, b.lon) <= 10) pairs++;
    }
  }
  return pairs;
}

/** Build one month's events edition. Throws HistoryBuildError when an input or an invariant is wrong; nothing is
 *  returned half-checked. */
export function buildEdition(input: BuildInput): { dayFiles: Map<string, string>; meta: EditionMeta; nodes: EventNode[] } {
  const { period, era, raws, context, registry, boundary, archivedDays } = input;
  const fail = (msg: string): never => {
    throw new HistoryBuildError(`history ${period.key} e${input.edition}: ${msg}`);
  };
  const days = periodDays(period);
  const daySet = new Set(days);
  // Never a day of the 3-year layer or of an existing archive: history only ever adds days before them.
  for (const d of days) {
    if (d >= boundary) fail(`day ${d} is not before the boundary ${boundary}`);
    if (archivedDays.has(d)) fail(`day ${d} is already in an archive-YYYY-MM Release`);
  }
  const fetchFloor = era.minMagnitude == null ? null : era.minMagnitude - FETCH_MARGIN_MAG;
  const bySource = new Map<string, RawInput>();
  for (const r of raws) {
    const h = r.header;
    if (h.period !== period.key) fail(`raw ${r.asset} is for ${h.period}`);
    if (!era.sources.includes(h.source)) fail(`raw ${r.asset} is from ${h.source}, not a source of era ${era.id}`);
    if (bySource.has(h.source)) fail(`two raw assets of ${h.source}`);
    if (Date.parse(h.start) !== period.startMs || Date.parse(h.end) !== period.endMs) fail(`raw ${r.asset} covers ${h.start}..${h.end}`);
    if (h.fetch_min_magnitude !== fetchFloor) fail(`raw ${r.asset} was fetched from M${h.fetch_min_magnitude}, the era asks M${fetchFloor}`);
    for (const row of r.rows) {
      if (row.provider !== h.source) fail(`raw ${r.asset} holds a row of ${row.provider}`);
      if (row.eventTimeMs < period.startMs || row.eventTimeMs >= period.endMs) fail(`raw ${r.asset} holds a row outside the month (${row.providerEventId})`);
    }
    bySource.set(h.source, r);
  }
  for (const s of era.sources) if (!bySource.has(s)) fail(`no raw asset of ${s}`);
  if (context && context.day !== dayKeyOf(period.endMs)) fail(`context day ${context.day} is not the day after the month (${dayKeyOf(period.endMs)})`);

  // Read-only neighbour: its provider keys as they were before any of this month's rows touched it.
  const transient = new Map<string, EventNode>();
  const contextIds = new Set<string>();
  const contextKeys = new Set<string>();
  for (const n of context?.nodes ?? []) {
    transient.set(n.feedId, n);
    contextIds.add(n.feedId);
    for (const r of n.provenance) contextKeys.add(`${r.provider}:${r.nativeId}`);
  }
  const resolver = new Resolver(transient, priorityMap(registry), configMap(registry), period.endMs, { hotFloorMs: 0, merge: false });

  const tally = emptyTally();
  const queue: { raw: RawObs; ingestTime: string }[] = [];
  let fetched = 0;
  for (const s of era.sources) {
    const r = bySource.get(s)!;
    fetched += r.rows.length;
    for (const row of screen(r.rows, tally)) queue.push({ raw: row, ingestTime: r.header.fetched_at });
  }
  queue.sort((a, b) => byIngestOrder(a.raw, b.raw));
  const joined: JoinedRow[] = [];
  for (const { raw, ingestTime } of queue) {
    const res = resolver.ingest(raw, ingestTime);
    if (res.withheld) fail(`row ${raw.provider}:${raw.providerEventId} was withheld (a lifecycle source is not walked by history)`);
    if (contextIds.has(res.node.feedId)) joined.push({ provider: raw.provider, native_id: raw.providerEventId, feed_id: res.node.feedId });
  }

  const written: EventNode[] = [];
  let belowFloorEvents = 0;
  let belowFloorRows = 0;
  for (const n of transient.values()) {
    if (contextIds.has(n.feedId)) continue;
    if (n.state !== 'live') fail(`event ${n.feedId} is ${n.state} (the merge pass is off)`);
    const m = maxMag(n);
    if (era.minMagnitude != null && (m == null || m < era.minMagnitude)) {
      belowFloorEvents++;
      belowFloorRows += n.provenance.length;
      continue;
    }
    // Never seen by the live log: first_seen_seq / ingest_seq 0 (backfill writes the log position of its run).
    n.firstSeenSeq = 0;
    n.lastSeq = 0;
    written.push(n);
  }

  // Invariants: every event inside the month, every source id once, nothing shared with the frozen neighbour, and
  // every fetched row accounted for.
  const keys = new Set<string>();
  let writtenRows = 0;
  for (const n of written) {
    const d = dayKeyOf(n.eventTimeMs);
    if (!daySet.has(d)) fail(`event ${n.feedId} falls on ${d}, outside the month`);
    for (const r of n.provenance) {
      const k = `${r.provider}:${r.nativeId}`;
      if (keys.has(k)) fail(`${k} is in two events`);
      if (contextKeys.has(k)) fail(`${k} is written although the frozen neighbour already holds it`);
      keys.add(k);
      writtenRows++;
    }
  }
  const kept = queue.length;
  if (writtenRows + joined.length + belowFloorRows !== kept) {
    fail(`row accounting: ${kept} rows ingested, ${writtenRows} written + ${joined.length} joined the neighbour + ${belowFloorRows} below the floor`);
  }

  const byDay = new Map<string, EventNode[]>();
  for (const n of written) {
    const d = dayKeyOf(n.eventTimeMs);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(n);
  }
  const dayFiles = new Map<string, string>();
  for (const d of [...byDay.keys()].sort()) {
    // The day partitions' order and bytes (partitions.ts writeDayPartition).
    const sorted = byDay.get(d)!.sort((a, b) => a.eventTimeMs - b.eventTimeMs || (a.feedId < b.feedId ? -1 : 1));
    dayFiles.set(d, sorted.map((n) => JSON.stringify(nodeToFeature(n))).join('\n') + '\n');
  }

  const meta: EditionMeta = {
    kind: EDITION_KIND,
    version: 1,
    period: period.key,
    edition: input.edition,
    era: era.id,
    min_magnitude: era.minMagnitude,
    boundary,
    start: new Date(period.startMs).toISOString(),
    end: new Date(period.endMs).toISOString(),
    sources: [...era.sources],
    raw: era.sources.map((s) => {
      const r = bySource.get(s)!;
      return { source: s, asset: r.asset, sha256: r.sha256, rows: r.rows.length, provider_count: r.header.provider_count };
    }),
    context: context ? { label: context.label, day: context.day, events: context.nodes.length, sha256: context.sha256 ?? null } : null,
    events: written.length,
    days: [...dayFiles.keys()],
    rows: {
      fetched,
      bad_coords: tally.bad_coords,
      coordinateless: tally.coordinateless,
      written: writtenRows,
      joined_newer: joined.length,
      below_floor: belowFloorRows,
    },
    below_floor_events: belowFloorEvents,
    same_source_near_pairs: sameSourceNearPairs(written),
    joined_newer: joined,
  };
  return { dayFiles, meta, nodes: written };
}
