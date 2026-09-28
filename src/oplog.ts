import type { IngestResult, MergeRecord } from './dedup.js';
import type { Observation, Op, RawObs } from './types.js';
import { isoFromMs, knownAliasIdsOf } from './util.js';

/** The observation-log line for one provider report that landed in `r.node`. */
export function observeLine(raw: RawObs, r: IngestResult, seq: number, ingestTime: string, op: Op = 'observe'): Observation {
  return {
    seq,
    op,
    feed_id: r.node.feedId,
    revision: r.revision,
    ingest_time: ingestTime,
    event_time: isoFromMs(raw.eventTimeMs),
    provider: raw.provider,
    provider_event_id: raw.providerEventId,
    provider_updated: raw.providerUpdatedMs != null ? isoFromMs(raw.providerUpdatedMs) : null,
    status: raw.status,
    lat: raw.lat,
    lon: raw.lon,
    depth: raw.depth,
    mag: raw.mag,
    magType: raw.magType,
    place: raw.place,
    fields: raw.fields,
  };
}

/** The op:merge line. `feed_id` is the LOSER at its retiring revision, `superseded_by` the
 *  survivor, and the solution columns are the loser's last representative (its chosen row),
 *  so a log reader can follow the fold without the event_map. `fields` is empty: the rows
 *  themselves were logged when observed and now live on the survivor. */
export function mergeLine(m: MergeRecord, seq: number, ingestTime: string): Observation {
  const { loser } = m;
  const chosen = loser.provenance.find((r) => r.chosen) ?? loser.provenance[0];
  return {
    seq,
    op: 'merge',
    feed_id: loser.feedId,
    revision: loser.revision,
    ingest_time: ingestTime,
    event_time: isoFromMs(loser.eventTimeMs),
    provider: chosen?.provider ?? loser.chosenProvider,
    provider_event_id: chosen?.nativeId ?? '',
    provider_updated: chosen?.providerUpdatedMs != null ? isoFromMs(chosen.providerUpdatedMs) : null,
    status: loser.status,
    lat: loser.lat,
    lon: loser.lon,
    depth: loser.depth,
    mag: loser.mag,
    magType: loser.magType,
    place: loser.place,
    fields: {},
    reason: m.reason,
    superseded_by: m.survivor.feedId,
  };
}

/** The inverse of observeLine: a logged report back into what the Resolver ingests (replay,
 *  fixtures). Same-provider alias ids come back from the row's own `ids` vocabulary. */
export function observationToRaw(o: Observation): RawObs {
  const fields = o.fields ?? {};
  return {
    provider: o.provider,
    providerEventId: o.provider_event_id,
    eventTimeMs: Date.parse(o.event_time),
    providerUpdatedMs: o.provider_updated ? Date.parse(o.provider_updated) : null,
    status: o.status ?? null,
    lat: o.lat,
    lon: o.lon,
    depth: o.depth ?? null,
    mag: o.mag ?? null,
    magType: o.magType ?? null,
    place: o.place ?? null,
    knownAliasIds: knownAliasIdsOf(o.provider, o.provider_event_id, fields),
    fields,
  };
}
