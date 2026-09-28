import type { IngestResult, MergeRecord } from './dedup.js';
import type { EventNode, Observation, Op, RawObs } from './types.js';
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

/** The op:correction line: a feed-side revision with no provider report behind it — the survivor
 *  of the one-time heal, whose revision the folds moved. `feed_id` / `revision` are the node's,
 *  the solution columns its representative (chosen row) after the folds, `fields` is empty (the
 *  rows were logged when observed) and `reason` names what it absorbed. It gives the survivor a
 *  seq of its own, so `ingest_seq` and the change-log stay one line per change. */
export function correctionLine(node: EventNode, seq: number, ingestTime: string, reason: string): Observation {
  const chosen = node.provenance.find((r) => r.chosen) ?? node.provenance[0];
  return {
    seq,
    op: 'correction',
    feed_id: node.feedId,
    revision: node.revision,
    ingest_time: ingestTime,
    event_time: isoFromMs(node.eventTimeMs),
    provider: chosen?.provider ?? node.chosenProvider,
    provider_event_id: chosen?.nativeId ?? '',
    provider_updated: chosen?.providerUpdatedMs != null ? isoFromMs(chosen.providerUpdatedMs) : null,
    status: node.status,
    lat: node.lat,
    lon: node.lon,
    depth: node.depth,
    mag: node.mag,
    magType: node.magType,
    place: node.place,
    fields: {},
    reason,
  };
}

/** The lines one aggregate run appends, with the seq clock they advance. Every change gets its
 *  own seq and the node it changed records it (`lastSeq`, and `firstSeenSeq` on a mint). */
export class LogBuffer {
  readonly lines: Observation[] = [];
  /** op:merge lines written (normal folds, re-points and the heal). */
  merged = 0;

  constructor(
    public seq: number,
    private readonly ingestTime: string,
  ) {}

  private merge(m: MergeRecord): void {
    this.seq += 1;
    m.loser.lastSeq = this.seq;
    this.lines.push(mergeLine(m, this.seq, this.ingestTime));
    this.merged++;
  }

  /** One ingest: the op:merge lines it caused (each the loser's retiring revision) before the
   *  report's own line, so seq order reads cause → effect and the survivor's ingest_seq is the
   *  last one written. `reason` annotates a feed-side op:tombstone (a retraction). */
  record(raw: RawObs, r: IngestResult, op: Op = 'observe', reason?: string): void {
    for (const m of r.merges) this.merge(m);
    this.seq += 1;
    r.node.lastSeq = this.seq;
    if (r.node.firstSeenSeq < 0) r.node.firstSeenSeq = this.seq;
    const line = observeLine(raw, r, this.seq, this.ingestTime, op);
    if (reason) line.reason = reason;
    this.lines.push(line);
  }

  /** The heal (Resolver.heal): one op:merge line per fold, in fold order, then one
   *  op:correction line per live survivor — the line that carries its new revision. */
  recordHeal(merges: MergeRecord[], survivors: EventNode[], epoch: number): void {
    for (const m of merges) this.merge(m);
    for (const node of survivors) {
      const absorbed = merges.filter((m) => m.survivor === node).map((m) => m.loser.feedId);
      this.seq += 1;
      node.lastSeq = this.seq;
      this.lines.push(correctionLine(node, this.seq, this.ingestTime, `heal epoch ${epoch}: absorbed ${absorbed.join(', ')}`));
    }
  }
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
