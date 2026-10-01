import type { Observation } from './types.js';

/** One provider report as the feed first held it: its earliest `op:observe` line. */
export interface FirstSeen {
  provider: string;
  provider_event_id: string;
  seq: number;
  /** When the feed first held this report (the line's ingest time). */
  ingest_time: string;
  /** The provider's own update time of that version, where the source gives one (usgs, emsc, imo, ipma, jma, igp). */
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
