import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, HOT_WINDOW_DAYS, LIVE_INDEX_DAYS, dataPaths } from './config.js';
import { appendObservations, loadState, saveEventMap, saveMeta } from './bitemporal.js';
import { Resolver, type IngestResult } from './dedup.js';
import { activeProviders, configMap, fetchProvider, loadRegistry, priorityMap } from './providers.js';
import type { Observation, RawObs } from './types.js';
import { isoFromMs } from './util.js';

const FUTURE_LEEWAY_MS = 10 * 60_000;

/** M4 guard: head.seq must equal the max seq in the most recent log files —
 *  a mismatch means a torn or out-of-band write; refuse to append on top of it. */
function assertHeadMatchesLog(root: string, headSeq: number): void {
  const dir = dataPaths(root).observationsDir;
  const files: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? (walk(join(d, e.name)), '') : join(d, e.name)));
    } catch {
      return;
    }
    for (const f of entries) if (f && f.endsWith('.ndjson')) files.push(f);
  };
  walk(dir);
  if (!files.length) {
    if (headSeq !== 0) throw new Error(`head.seq=${headSeq} but observation log is empty`);
    return;
  }
  files.sort();
  let maxSeq = 0;
  for (const f of files.slice(-2)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const seq = (JSON.parse(line) as { seq: number }).seq;
      if (seq > maxSeq) maxSeq = seq;
    }
  }
  if (maxSeq !== headSeq) {
    throw new Error(`seq reconciliation failed: head.seq=${headSeq} but log max seq=${maxSeq} — refusing to append (torn or out-of-band write)`);
  }
}

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
  const state = loadState(DATA_DIR, { sinceDays: LIVE_INDEX_DAYS, nowMs });
  assertHeadMatchesLog(DATA_DIR, state.head.seq);
  const resolver = new Resolver(state.eventMap, priorityMap(all), configMap(all), nowMs);

  const outcomes = await Promise.all(active.map((p) => fetchProvider(p, nowMs)));
  const fetched = outcomes.flatMap((o) => o.obs);
  // Live path handles the hot window only; older rows (e.g. CENC's rolling year file)
  // would bypass dedup outside it (C2) — drop them; backfill owns history.
  const hotFloor = nowMs - HOT_WINDOW_DAYS * 86_400_000;
  const futureCeil = nowMs + FUTURE_LEEWAY_MS;
  const raws = fetched.filter((r) => r.eventTimeMs >= hotFloor && r.eventTimeMs <= futureCeil);
  const staleDropped = fetched.length - raws.length;
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
    events_indexed: state.eventMap.size,
    observations_returned: fetched.length,
    stale_dropped: staleDropped,
    new_observations: newObs.length,
    duration_ms: Math.round(Date.now() - nowMs),
    degraded,
    providers,
  };
  saveEventMap(DATA_DIR, state.eventMap);
  saveMeta(DATA_DIR, state.head, state.watermarks, status);

  console.log(
    `aggregate: seq=${seq} indexed=${state.eventMap.size} fetched=${fetched.length} stale_dropped=${staleDropped} new=${newObs.length} ` +
      `providers=${outcomes.filter((o) => o.status.ok).length}/${outcomes.length}` +
      (degraded.length ? ` degraded=[${degraded.join(',')}]` : ''),
  );
}

main().catch((err) => {
  console.error('aggregate failed:', err);
  process.exit(1);
});
