import { COMCAT_NETWORK_OF, type FirstSolutionIndex, type FirstSolutionRecord, type HistoryMethod, type ProviderVersion } from './first-solutions.js';
import type { Observation } from './types.js';
import { comcatIdOf } from './util.js';

/** One provider report as the feed first held it: its earliest `op:observe` line. */
export interface FirstSeen {
  provider: string;
  provider_event_id: string;
  seq: number;
  /** When the feed first held this report (the line's ingest time). */
  ingest_time: string;
  /** The provider's own update time of that version, where the source gives one (usgs, emsc, imo, ipma, jma, igp; afad
   *  only for an event it has revised). */
  provider_updated: string | null;
  event_time: string;
  lat: number;
  lon: number;
  depth: number | null;
  mag: number | null;
  magType: string | null;
  place: string | null;
  status: string | null;
  /** ingest_time − event_time, in seconds. */
  lag_seconds: number;
}

export interface EventFirstSeen {
  /** The event the reports live in now (op:merge lines followed to the last survivor). */
  feed_id: string;
  /** Each provider id of the event, earliest observation each, in the order the feed first held them. */
  reports: FirstSeen[];
}

/**
 * The earliest observation of every provider report in the observation log, by event. The log is append-only and gets
 * a line for every report that changed the feed, so a report's first line is the version the feed saw first: for an
 * event observed live (the log starts 2026-07-05), the earliest observation of each source, up to the polling
 * interval. History filled by backfill or new-source onboarding has no log lines: its rows in the day partitions are
 * each provider's solution at the time of the backfill, not a first observation, and `lookup` returns null for them.
 * For those, and for versions a source published before the feed first polled it, the provider's own version history
 * answers (src/first-solutions.ts; `earliestReport` below merges the two).
 */
export class FirstObservationIndex {
  private readonly survivorOf = new Map<string, string>();
  private readonly first = new Map<string, FirstSeen>();
  /** The event a report's latest line placed it in (a correction can move a row to another event). */
  private readonly lastFeed = new Map<string, { seq: number; feedId: string }>();

  add(o: Observation): void {
    if (o.op === 'merge' && o.superseded_by) this.survivorOf.set(o.feed_id, o.superseded_by);
    if (o.op !== 'observe') return;
    const key = `${o.provider}:${o.provider_event_id}`;
    const last = this.lastFeed.get(key);
    if (!last || o.seq > last.seq) this.lastFeed.set(key, { seq: o.seq, feedId: o.feed_id });
    const had = this.first.get(key);
    if (had && had.seq <= o.seq) return;
    this.first.set(key, {
      provider: o.provider,
      provider_event_id: o.provider_event_id,
      seq: o.seq,
      ingest_time: o.ingest_time,
      provider_updated: o.provider_updated,
      event_time: o.event_time,
      lat: o.lat,
      lon: o.lon,
      depth: o.depth,
      mag: o.mag,
      magType: o.magType,
      place: o.place,
      status: o.status,
      lag_seconds: Math.round((Date.parse(o.ingest_time) - Date.parse(o.event_time)) / 1000),
    });
  }

  /** The event a feed id lives in now: op:merge lines followed to the last survivor. */
  resolve(feedId: string): string {
    let id = feedId;
    const seen = new Set<string>();
    while (this.survivorOf.has(id) && !seen.has(id)) {
      seen.add(id);
      id = this.survivorOf.get(id)!;
    }
    return id;
  }

  /** The event named by a feed id (`efd_…`, a superseded one included) or by a report (`provider:native_id`), with the
   *  earliest observation of each of its reports; null when the log holds no report of it. */
  lookup(idOrAlias: string): EventFirstSeen | null {
    let feedId: string;
    if (idOrAlias.startsWith('efd_')) {
      feedId = this.resolve(idOrAlias);
    } else {
      const last = this.lastFeed.get(idOrAlias);
      if (!last) return null;
      feedId = this.resolve(last.feedId);
    }
    const reports: FirstSeen[] = [];
    for (const [key, f] of this.first) {
      if (this.resolve(this.lastFeed.get(key)!.feedId) === feedId) reports.push(f);
    }
    if (!reports.length) return null;
    reports.sort((a, b) => a.seq - b.seq);
    return { feed_id: feedId, reports };
  }
}

// --- one answer per report: the provider's own version history merged with the log ----------------------------------

/** Where an earliest time or solution comes from: the provider's version history (src/first-solutions.ts), the
 *  provider's creation time of the event (QuakeML, where the first values are no longer kept), or the observation log
 *  (when the feed first held the report: the provider published it at or before then). */
export type Provenance = 'provider version history' | 'provider event creation time' | 'first seen by the feed';

/** The provider's version history of one report, summarised. */
export interface HistorySummary {
  method: HistoryMethod;
  /** Read through another record: `usgs:nc75438707` for NCEDC 75438707 (the network's own origins in ComCat). */
  via?: string;
  collected: string;
  created: string | null;
  versions: number;
  first: ProviderVersion | null;
  /** The first version not flagged automatic (GeoNet's and ETHZ's first automatic versions can be far off). */
  first_non_automatic: ProviderVersion | null;
  last: ProviderVersion | null;
  deleted?: string;
  missing?: string;
}

export interface EarliestSolution {
  provenance: Exclude<Provenance, 'provider event creation time'>;
  /** The provider's publication time of this solution (version history), or when the feed first held it (log). */
  at: string;
  time: string;
  lat: number;
  lon: number;
  depth: number | null;
  mag: number | null;
  magType: string | null;
  status: string | null;
  source: string | null;
}

export interface EarliestReport {
  provider: string;
  provider_event_id: string;
  /** The earliest moment the provider is known to have published a solution of this event. */
  first_published: { at: string; provenance: Provenance } | null;
  /** The earliest solution whose values are known. */
  first_solution: EarliestSolution | null;
  provider_history: HistorySummary | null;
  feed_first_seen: FirstSeen | null;
}

const isAutomatic = (v: ProviderVersion): boolean => v.status === 'automatic' || v.status === 'deleted';

function summarise(rec: FirstSolutionRecord, versions: ProviderVersion[], via?: { key: string; network: string }): HistorySummary {
  const s: HistorySummary = {
    method: rec.method,
    collected: rec.collected,
    created: rec.created,
    versions: versions.length,
    first: versions[0] ?? null,
    first_non_automatic: versions.find((v) => !isAutomatic(v)) ?? null,
    last: versions[versions.length - 1] ?? null,
  };
  if (via) s.via = via.key;
  if (rec.deleted) s.deleted = rec.deleted;
  if (!versions.length) s.missing = via ? `no ${via.network} origin in the ComCat event` : (rec.missing ?? 'no versions');
  return s;
}

/** The provider's history of a report: its own record, or for NCEDC / SCEDC / AEC the ComCat event of the same id
 *  read through that network's origin products (COMCAT_NETWORK_OF). */
export function historyOf(side: FirstSolutionIndex, provider: string, id: string): HistorySummary | null {
  const own = side.get(provider, id);
  if (own) return summarise(own, own.versions);
  const network = COMCAT_NETWORK_OF.get(provider);
  const comcatId = network ? comcatIdOf(provider, id) : null;
  if (!network || !comcatId) return null;
  const rec = side.get('usgs', comcatId);
  if (!rec) return null;
  const versions = rec.versions.filter((v) => v.source === network);
  return summarise(rec, versions, { key: `usgs:${comcatId}`, network });
}

/**
 * One report's earliest published solution, from the provider's version history and the log's first line, with where
 * each comes from. The earlier of the history's first version (its publication time) and the log's first line (when
 * the feed first held it) wins; equal times go to the history (the provider's own clock). A creation time earlier than
 * both (GEOFON, KNMI, IPGP, LMU keep only later origins) is the first publication time, its values unknown.
 */
export function earliestReport(provider: string, id: string, firstSeen: FirstSeen | null, side: FirstSolutionIndex | null): EarliestReport {
  const history = side ? historyOf(side, provider, id) : null;
  const candidates: EarliestSolution[] = [];
  const hv = history?.first;
  if (hv) {
    candidates.push({ provenance: 'provider version history', at: hv.published, time: hv.time, lat: hv.lat, lon: hv.lon, depth: hv.depth, mag: hv.mag, magType: hv.magType, status: hv.status, source: hv.source });
  }
  if (firstSeen) {
    candidates.push({
      provenance: 'first seen by the feed',
      at: firstSeen.ingest_time,
      time: firstSeen.event_time,
      lat: firstSeen.lat,
      lon: firstSeen.lon,
      depth: firstSeen.depth,
      mag: firstSeen.mag,
      magType: firstSeen.magType,
      status: firstSeen.status,
      source: null,
    });
  }
  let first: EarliestSolution | null = null;
  for (const c of candidates) if (!first || Date.parse(c.at) < Date.parse(first.at)) first = c;
  let published: EarliestReport['first_published'] = first ? { at: first.at, provenance: first.provenance } : null;
  if (history?.created && (!published || Date.parse(history.created) < Date.parse(published.at))) {
    published = { at: history.created, provenance: 'provider event creation time' };
  }
  return { provider, provider_event_id: id, first_published: published, first_solution: first, provider_history: history, feed_first_seen: firstSeen };
}
