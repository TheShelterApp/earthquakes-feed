import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, HOT_WINDOW_DAYS, LIVE_INDEX_DAYS, dataPaths } from './config.js';
import { appendObservations, earliestEventMapDay, loadState, saveEventMap, saveMeta } from './bitemporal.js';
import { onboardStep } from './onboard.js';
import { Resolver, type IngestResult } from './dedup.js';
import { mergeLine, observeLine } from './oplog.js';
import { activeProviders, configMap, fetchProvider, fetchProviderDeleted, fetchProviderUpdated, loadRegistry, priorityMap } from './providers.js';
import type { Observation, Op, RawObs } from './types.js';

/** FDSN nodes that support the `includedeleted` delete query (extensible). */
const DELETE_PROVIDERS = new Set(['usgs']);
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

/** A lat/lon that physics and the schema (±90 / ±180) forbid. A single provider
 *  emitting such coordinates would otherwise red-line derive's validate gate for the
 *  entire feed (JMA's DDMM.m `cod`, 2026-08-22), so the log drops them at the door. */
const hasBadCoords = (r: RawObs): boolean =>
  !Number.isFinite(r.lat) || !Number.isFinite(r.lon) || Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180;

async function main(): Promise<void> {
  const nowMs = Date.now();
  const ingestTime = process.env.RUN_INGEST_TIME ?? isoFromMs(nowMs);
  const all = loadRegistry();
  const active = activeProviders(all);
  const state = loadState(DATA_DIR, { sinceDays: LIVE_INDEX_DAYS, nowMs });
  assertHeadMatchesLog(DATA_DIR, state.head.seq);
  const resolver = new Resolver(state.eventMap, priorityMap(all), configMap(all), nowMs);

  // Query updatedafter from LAST run's watermark (revisions since we last looked).
  const prevWatermarks = { ...state.watermarks };
  const [outcomes, updateOutcomes, deleteOutcomes] = await Promise.all([
    Promise.all(active.map((p) => fetchProvider(p, nowMs))),
    Promise.all(
      active
        .filter((p) => p.adapter === 'fdsn' && prevWatermarks[p.id])
        .map((p) => fetchProviderUpdated(p, prevWatermarks[p.id]! - 300_000)),
    ),
    Promise.all(
      active
        .filter((p) => DELETE_PROVIDERS.has(p.id) && prevWatermarks[p.id])
        .map((p) => fetchProviderDeleted(p, prevWatermarks[p.id]! - 300_000)),
    ),
  ]);
  const fetched = outcomes.flatMap((o) => o.obs);
  // Live path handles the hot window only; older rows (e.g. CENC's rolling year file)
  // would bypass dedup outside it (C2) — drop them; backfill owns history.
  const hotFloor = nowMs - HOT_WINDOW_DAYS * 86_400_000;
  const futureCeil = nowMs + FUTURE_LEEWAY_MS;
  const inWindow = fetched.filter((r) => r.eventTimeMs >= hotFloor && r.eventTimeMs <= futureCeil);
  const staleDropped = fetched.length - inWindow.length;
  // Coordinate backstop across all three ingest paths — never silent: a nonzero
  // bad_coords_dropped in status names the scale so a provider regression is visible.
  let badCoordsDropped = 0;
  const badCoordsByProvider: Record<string, number> = {};
  const dropBadCoords = <T extends RawObs>(arr: T[]): T[] =>
    arr.filter((r) => {
      if (!hasBadCoords(r)) return true;
      badCoordsDropped++;
      badCoordsByProvider[r.provider] = (badCoordsByProvider[r.provider] ?? 0) + 1;
      return false;
    });
  const raws = dropBadCoords(inWindow);
  // Deterministic ingest order (idempotency, design §8.10).
  raws.sort(
    (a, b) =>
      a.eventTimeMs - b.eventTimeMs ||
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
      (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0),
  );

  let seq = state.head.seq;
  const newObs: Observation[] = [];
  let merged = 0;
  // Log one ingest: the op:merge lines it caused (each the loser's retiring revision) before
  // the report's own line, so seq order reads cause → effect and the survivor's ingest_seq
  // is the last one written.
  const record = (raw: RawObs, r: IngestResult, op: Op = 'observe'): void => {
    for (const m of r.merges) {
      seq += 1;
      m.loser.lastSeq = seq;
      newObs.push(mergeLine(m, seq, ingestTime));
      merged++;
    }
    seq += 1;
    r.node.lastSeq = seq;
    if (r.node.firstSeenSeq < 0) r.node.firstSeenSeq = seq;
    newObs.push(observeLine(raw, r, seq, ingestTime, op));
  };
  for (const raw of raws) {
    const r = resolver.ingest(raw, ingestTime);
    if (raw.providerUpdatedMs != null) {
      state.watermarks[raw.provider] = Math.max(state.watermarks[raw.provider] ?? 0, raw.providerUpdatedMs);
    }
    if (r.changed) record(raw, r);
  }

  // Revision sweep (H2): updatedafter results revise KNOWN events only (reviseExisting
  // never mints), so revisions to events outside the hot index are skipped, not duped.
  const updates = dropBadCoords(updateOutcomes.flatMap((o) => o.obs).filter((r) => r.eventTimeMs <= futureCeil));
  updates.sort(
    (a, b) =>
      a.eventTimeMs - b.eventTimeMs ||
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
      (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0),
  );
  let revisions = 0;
  for (const raw of updates) {
    if (raw.providerUpdatedMs != null) {
      state.watermarks[raw.provider] = Math.max(state.watermarks[raw.provider] ?? 0, raw.providerUpdatedMs);
    }
    const r = resolver.reviseExisting(raw, ingestTime);
    if (r?.changed) {
      record(raw, r);
      revisions++;
    }
  }

  // Delete sweep: tombstone events retracted upstream (op:tombstone; never mints).
  const deletes = dropBadCoords(deleteOutcomes.flatMap((o) => o.obs));
  let tombstoned = 0;
  for (const raw of deletes) {
    const r = resolver.tombstoneProvider(raw, ingestTime);
    if (r?.changed) {
      record(raw, r, 'tombstone');
      tombstoned++;
    }
  }

  if (badCoordsDropped) {
    console.warn(
      `::warning::aggregate: dropped ${badCoordsDropped} obs with out-of-range coordinates: ${JSON.stringify(badCoordsByProvider)}`,
    );
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
    bad_coords_dropped: badCoordsDropped,
    new_observations: newObs.length,
    revisions,
    tombstoned,
    merged,
    duration_ms: Math.round(Date.now() - nowMs),
    degraded,
    providers,
  };
  saveEventMap(DATA_DIR, state.eventMap);
  saveMeta(DATA_DIR, state.head, state.watermarks, status);

  // Onboard a newly-added source's recent live window [liveDay, now-lookback] into the
  // event_map (one paced chunk/run) so it has NO gap between the live path and deep backfill.
  // Runs after the main save (loads the just-saved shards fresh); fail-safe — never breaks
  // the critical aggregate run. derive rebuilds the touched partitions on its next run.
  try {
    const ob = await onboardStep(DATA_DIR, all, active, earliestEventMapDay(DATA_DIR, nowMs), nowMs, ingestTime);
    if (ob.provider) console.log(`onboard: ${JSON.stringify(ob)}`);
  } catch (err) {
    console.error(`onboard: step failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `aggregate: seq=${seq} indexed=${state.eventMap.size} fetched=${fetched.length} stale_dropped=${staleDropped} new=${newObs.length} revisions=${revisions} tombstoned=${tombstoned} merged=${merged} ` +
      `providers=${outcomes.filter((o) => o.status.ok).length}/${outcomes.length}` +
      (badCoordsDropped ? ` bad_coords_dropped=${badCoordsDropped}` : '') +
      (degraded.length ? ` degraded=[${degraded.join(',')}]` : ''),
  );
}

main().catch((err) => {
  console.error('aggregate failed:', err);
  process.exit(1);
});
