import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, EVENT_MAP_HORIZON_DAYS, HEAL_EPOCH, HOT_WINDOW_DAYS, LIVE_INDEX_DAYS, dataPaths } from './config.js';
import { appendObservations, earliestEventMapDay, loadState, saveEventMap, saveMeta } from './bitemporal.js';
import { onboardStep } from './onboard.js';
import { Resolver } from './dedup.js';
import { healedEpoch, runFeedSideSteps, withdrawZeroedReports } from './heal.js';
import { LogBuffer } from './oplog.js';
import { activeProviders, configMap, fetchProvider, fetchProviderDeleted, fetchProviderUpdated, loadRegistry, priorityMap } from './providers.js';
import { byIngestOrder, emptyTally, screen } from './quality.js';
import { revisionSweep } from './sweep.js';
import type { RawObs } from './types.js';

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
  // Coordinate-less reports (quality.ts isCoordinateless: 0,0 with M0 or none) never enter as
  // reports, counted as coordinateless_dropped; the delete sweep keeps them. They are held in
  // `zeroed`: for an id the feed already holds, zeroing is how SCEDC / NCEDC withdraw it
  // (withdrawZeroedReports below); an unknown one (NCEDC's unlocated placeholder) is dropped.
  const tally = emptyTally();
  const zeroed: RawObs[] = [];
  const raws = screen(inWindow, tally, undefined, zeroed);
  // Deterministic ingest order (idempotency, design §8.10).
  raws.sort(byIngestOrder);

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

  // Revision sweep (H2, src/sweep.ts): updatedafter results revise KNOWN events; an unknown row
  // is skipped, not duped, except that a LATE_MINT_PROVIDERS row (ComCat publishes events days
  // after origin, past the live lookback) is minted while its origin is inside the hot window,
  // where the spatial match still runs, unless another provider's event sits beside it (PF-5a);
  // status counts late_minted and late_withheld.
  const updates = screen(updateOutcomes.flatMap((o) => o.obs).filter((r) => r.eventTimeMs <= futureCeil), tally, undefined, zeroed);
  updates.sort(byIngestOrder);
  const sweep = revisionSweep(resolver, log, updates, state.watermarks, ingestTime);
  const revisions = sweep.revisions;
  const lateMinted = sweep.lateMinted.length;
  const lateWithheld = sweep.lateWithheld.length;
  for (const m of sweep.lateMinted) {
    console.log(`  late mint ${m.feedId} ${m.provider}:${m.providerEventId} M${m.mag ?? '?'} ${m.eventTime} (${m.lagDays.toFixed(1)} d) ${m.place ?? ''}`);
  }
  for (const w of sweep.lateWithheld) {
    console.log(`  late withheld ${w.provider}:${w.providerEventId} M${w.mag ?? '?'} ${w.eventTime}: beside ${w.nearFeedId} [${w.nearProviders.join(',')}] ${w.km.toFixed(1)} km ${w.dtS.toFixed(1)} s`);
  }

  // Provider withdrawals by zeroing (live and revision paths): a coordinate-less report of a
  // KNOWN id withdraws that provider's row, like an upstream delete (op:tombstone with a reason);
  // only unknown ids are dropped at the door. Watermarks count them as seen, like any report.
  for (const raw of zeroed) {
    if (raw.providerUpdatedMs != null) {
      state.watermarks[raw.provider] = Math.max(state.watermarks[raw.provider] ?? 0, raw.providerUpdatedMs);
    }
  }
  const zeroedOut = withdrawZeroedReports(resolver, log, zeroed, ingestTime);

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
  if (zeroedOut.withdrawn) console.log(`aggregate: withdrew ${zeroedOut.withdrawn} rows whose provider zeroed a known id: ${JSON.stringify(zeroedOut.byProvider)}`);
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
  // The sweeps' own fetches (updatedafter, includedeleted): fail-open like the live fetch, so a
  // failed one used to leave no trace, and the next run starts from a watermark the live rows
  // already moved past its window. Recorded here so a sweep that delivers nothing is visible.
  const sweeps = {
    updated: Object.fromEntries(updateOutcomes.map((o) => [o.provider, o.status])),
    deleted: Object.fromEntries(deleteOutcomes.map((o) => [o.provider, o.status])),
  };
  const sweepsFailed = [
    ...updateOutcomes.filter((o) => !o.status.ok).map((o) => `${o.provider}:updated`),
    ...deleteOutcomes.filter((o) => !o.status.ok).map((o) => `${o.provider}:deleted`),
  ];
  const status = {
    generated: ingestTime,
    head_seq: seq,
    events_indexed: state.eventMap.size,
    observations_returned: fetched.length,
    stale_dropped: staleDropped,
    bad_coords_dropped: tally.bad_coords,
    coordinateless_dropped: tally.coordinateless,
    coordinateless_withdrawn: zeroedOut.withdrawn,
    coordinateless_retracted: feedSide.retracted,
    new_observations: newObs.length,
    revisions,
    late_minted: lateMinted,
    late_withheld: lateWithheld,
    tombstoned,
    merged: log.merged,
    ...(heal ? { heal } : {}),
    duration_ms: Math.round(Date.now() - nowMs),
    degraded,
    providers,
    sweeps,
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
    if (ob.screened?.bad_coords) console.warn(`::warning::onboard: dropped ${ob.screened.bad_coords} obs with out-of-range coordinates from ${ob.provider}`);
  } catch (err) {
    console.error(`onboard: step failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `aggregate: seq=${seq} indexed=${state.eventMap.size} fetched=${fetched.length} stale_dropped=${staleDropped} new=${newObs.length} revisions=${revisions} late_minted=${lateMinted} late_withheld=${lateWithheld} tombstoned=${tombstoned} merged=${log.merged} ` +
      `providers=${outcomes.filter((o) => o.status.ok).length}/${outcomes.length}` +
      (tally.bad_coords ? ` bad_coords_dropped=${tally.bad_coords}` : '') +
      (tally.coordinateless ? ` coordinateless_dropped=${tally.coordinateless}` : '') +
      (zeroedOut.withdrawn ? ` coordinateless_withdrawn=${zeroedOut.withdrawn}` : '') +
      (feedSide.retracted ? ` coordinateless_retracted=${feedSide.retracted}` : '') +
      (heal ? ` heal_epoch=${heal.epoch} heal_merged=${heal.merged}` : '') +
      (degraded.length ? ` degraded=[${degraded.join(',')}]` : '') +
      (sweepsFailed.length ? ` sweeps_failed=[${sweepsFailed.join(',')}]` : ''),
  );
}

main().catch((err) => {
  console.error('aggregate failed:', err);
  process.exit(1);
});
