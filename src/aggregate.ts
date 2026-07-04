import { DATA_DIR } from './config.js';
import { appendObservations, loadState, saveState } from './bitemporal.js';
import { Resolver, type IngestResult } from './dedup.js';
import { activeProviders, configMap, fetchProvider, loadRegistry, priorityMap } from './providers.js';
import type { Observation, RawObs } from './types.js';
import { isoFromMs } from './util.js';

function makeObservation(raw: RawObs, r: IngestResult, seq: number, ingestTime: string): Observation {
  return {
    seq,
    op: 'observe',
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
    extra: raw.extra,
  };
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const ingestTime = process.env.RUN_INGEST_TIME ?? isoFromMs(nowMs);
  const all = loadRegistry();
  const active = activeProviders(all);
  const state = loadState(DATA_DIR);
  const resolver = new Resolver(state.eventMap, priorityMap(all), configMap(all), nowMs);

  const outcomes = await Promise.all(active.map((p) => fetchProvider(p, nowMs)));
  const raws = outcomes.flatMap((o) => o.obs);
  // Deterministic ingest order (idempotency, design §8.10).
  raws.sort(
    (a, b) =>
      a.eventTimeMs - b.eventTimeMs ||
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
      (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0),
  );

  let seq = state.head.seq;
  const newObs: Observation[] = [];
  for (const raw of raws) {
    const r = resolver.ingest(raw, ingestTime);
    if (raw.providerUpdatedMs != null) {
      state.watermarks[raw.provider] = Math.max(state.watermarks[raw.provider] ?? 0, raw.providerUpdatedMs);
    }
    if (r.changed) {
      seq += 1;
      r.node.lastSeq = seq;
      if (r.node.firstSeenSeq < 0) r.node.firstSeenSeq = seq;
      newObs.push(makeObservation(raw, r, seq, ingestTime));
    }
  }

  if (newObs.length) appendObservations(DATA_DIR, newObs);
  state.head = { seq, ingest_time: ingestTime };

  const providers: Record<string, unknown> = {};
  const degraded: string[] = [];
  for (const o of outcomes) {
    providers[o.provider] = o.status;
    if (!o.status.ok) degraded.push(o.provider);
  }
  const status = {
    generated: ingestTime,
    head_seq: seq,
    events_total: state.eventMap.size,
    observations_returned: raws.length,
    new_observations: newObs.length,
    degraded,
    providers,
  };
  saveState(DATA_DIR, state, status);

  console.log(
    `aggregate: seq=${seq} events=${state.eventMap.size} fetched=${raws.length} new=${newObs.length} ` +
      `providers=${outcomes.filter((o) => o.status.ok).length}/${outcomes.length}` +
      (degraded.length ? ` degraded=[${degraded.join(',')}]` : ''),
  );
}

main().catch((err) => {
  console.error('aggregate failed:', err);
  process.exit(1);
});
