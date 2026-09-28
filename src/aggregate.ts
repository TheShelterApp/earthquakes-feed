import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, EVENT_MAP_HORIZON_DAYS, HEAL_EPOCH, HOT_WINDOW_DAYS, LIVE_INDEX_DAYS, dataPaths } from './config.js';
import { appendObservations, earliestEventMapDay, loadState, saveEventMap, saveMeta } from './bitemporal.js';
import { onboardStep } from './onboard.js';
import { Resolver } from './dedup.js';
import { healedEpoch, runFeedSideSteps } from './heal.js';
import { LogBuffer } from './oplog.js';
import { activeProviders, configMap, fetchProvider, fetchProviderDeleted, fetchProviderUpdated, loadRegistry, priorityMap } from './providers.js';
import { emptyTally, screen } from './quality.js';

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

async function main(): Promise<void> {
  const nowMs = Date.now();
  const ingestTime = process.env.RUN_INGEST_TIME ?? isoFromMs(nowMs);
  const all = loadRegistry();
  const active = activeProviders(all);
  // The one-time heal (config HEAL_EPOCH) loads the whole event-map horizon, so its
  // coordinate-less retraction reaches every day file derive publishes; other runs keep the
  // fast LIVE_INDEX_DAYS load.
  const healDue = healedEpoch(DATA_DIR) < HEAL_EPOCH;
  const loadDays = healDue ? Math.max(LIVE_INDEX_DAYS, EVENT_MAP_HORIZON_DAYS) : LIVE_INDEX_DAYS;
  const state = loadState(DATA_DIR, { sinceDays: loadDays, nowMs });
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
  // Coordinate-less placeholders (quality.ts isCoordinateless: NCEDC's 0,0 / M0) are dropped
  // at the door too, counted as coordinateless_dropped; the delete sweep keeps them.
  const tally = emptyTally();
  const raws = screen(inWindow, tally);
  // Deterministic ingest order (idempotency, design §8.10).
  raws.sort(
    (a, b) =>
      a.eventTimeMs - b.eventTimeMs ||
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
      (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0),
  );

  // Every line this run appends, and the seq clock (LogBuffer.record: the op:merge lines an
  // ingest caused before the report's own line, so seq order reads cause → effect).
  const log = new LogBuffer(state.head.seq, ingestTime);
  for (const raw of raws) {
    const r = resolver.ingest(raw, ingestTime);
    if (raw.providerUpdatedMs != null) {
      state.watermarks[raw.provider] = Math.max(state.watermarks[raw.provider] ?? 0, raw.providerUpdatedMs);
    }
    if (r.changed) log.record(raw, r);
  }

  // Revision sweep (H2): updatedafter results revise KNOWN events only (reviseExisting
  // never mints), so revisions to events outside the hot index are skipped, not duped.
  const updates = screen(updateOutcomes.flatMap((o) => o.obs).filter((r) => r.eventTimeMs <= futureCeil), tally);
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
      log.record(raw, r);
      revisions++;
    }
  }

  // Delete sweep: tombstone events retracted upstream (op:tombstone; never mints).
  const deletes = screen(deleteOutcomes.flatMap((o) => o.obs), tally, new Set(['coordinateless']));
  let tombstoned = 0;
  for (const raw of deletes) {
    const r = resolver.tombstoneProvider(raw, ingestTime);
    if (r?.changed) {
      log.record(raw, r, 'tombstone');
      tombstoned++;
    }
  }

  // Feed-side steps (heal.ts): the coordinate-less retraction of rows published before the ingest
  // rule (the upstream-delete path, op:tombstone with a reason; a no-op once nothing is left)
  // and, once, the heal — the op:merge pass over every live node in the hot window — with its
  // marker, in the same commit as its lines, so it runs exactly once.
  const feedSide = runFeedSideSteps(DATA_DIR, resolver, log, { healDue, loadDays, ingestTime });
  const heal = feedSide.heal;
  if (heal) console.log(`aggregate: heal epoch ${heal.epoch}: ${JSON.stringify(heal)}`);
  for (const l of log.lines) if (l.op === 'merge' && heal && l.seq >= (heal.first_seq ?? Infinity)) console.log(`  heal op:merge ${l.feed_id} -> ${l.superseded_by} (${l.reason})`);

  if (tally.bad_coords) {
    console.warn(
      `::warning::aggregate: dropped ${tally.bad_coords} obs with out-of-range coordinates: ${JSON.stringify(tally.byProvider.bad_coords)}`,
    );
  }
  if (feedSide.retracted) console.log(`aggregate: retracted ${feedSide.retracted} coordinate-less rows: ${JSON.stringify(feedSide.retractedByProvider)}`);

  const seq = log.seq;
  const newObs = log.lines;
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
    bad_coords_dropped: tally.bad_coords,
    coordinateless_dropped: tally.coordinateless,
    coordinateless_retracted: feedSide.retracted,
    new_observations: newObs.length,
    revisions,
    tombstoned,
    merged: log.merged,
    ...(heal ? { heal } : {}),
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
    `aggregate: seq=${seq} indexed=${state.eventMap.size} fetched=${fetched.length} stale_dropped=${staleDropped} new=${newObs.length} revisions=${revisions} tombstoned=${tombstoned} merged=${log.merged} ` +
      `providers=${outcomes.filter((o) => o.status.ok).length}/${outcomes.length}` +
      (tally.bad_coords ? ` bad_coords_dropped=${tally.bad_coords}` : '') +
      (tally.coordinateless ? ` coordinateless_dropped=${tally.coordinateless}` : '') +
      (feedSide.retracted ? ` coordinateless_retracted=${feedSide.retracted}` : '') +
      (heal ? ` heal_epoch=${heal.epoch} heal_merged=${heal.merged}` : '') +
      (degraded.length ? ` degraded=[${degraded.join(',')}]` : ''),
  );
}

main().catch((err) => {
  console.error('aggregate failed:', err);
  process.exit(1);
});
