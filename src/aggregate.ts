import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CORRECTION_EPOCH, DATA_DIR, EVENT_MAP_HORIZON_DAYS, HEAL_EPOCH, HOT_WINDOW_DAYS, LIVE_INDEX_DAYS, SWEEP_EPOCH, dataPaths } from './config.js';
import { appendObservations, earliestEventMapDay, loadState, saveEventMap, saveMeta } from './bitemporal.js';
import { onboardStep } from './onboard.js';
import { correctedEpoch, correctionFloor, runCorrection } from './correction.js';
import { Resolver } from './dedup.js';
import { PRELIMINARY_SUPERSEDED_REASON, finalsIndex, isPreliminary, supersedingFinal } from './preliminary.js';
import { healedEpoch, runFeedSideSteps, withdrawZeroedReports } from './heal.js';
import { LogBuffer } from './oplog.js';
import { activeProviders, configMap, loadRegistry, priorityMap } from './providers.js';
import { byIngestOrder, emptyTally, screen } from './quality.js';
import { COMCAT_DELETE_REASON, revisionSweep } from './sweep.js';
import { vanishedIds } from './absence.js';
import { loadActivity, saveActivity, silentProviders, updateActivity } from './activity.js';
import { fetchRunInputs, loadSweepCursors, nextCursors, saveSweepCursors, sweepOriginFloorMs, sweepSpecs } from './sweep-cursor.js';
import type { RawObs } from './types.js';
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
  // Every line this run appends, and the seq clock (LogBuffer.record: the op:merge lines an
  // ingest caused before the report's own line, so seq order reads cause → effect).
  const log = new LogBuffer(state.head.seq, ingestTime);
  // The one-time correction (config CORRECTION_EPOCH, src/correction.ts) goes first, over the days
  // the manifest does not call frozen, with a Resolver of its own, making the steps of the epochs
  // after the data branch's marker; this run's Resolver is built on the corrected event map.
  const correction = correctedEpoch(DATA_DIR) < CORRECTION_EPOCH
    ? runCorrection(DATA_DIR, state.eventMap, priorityMap(all), configMap(all), log, { nowMs, ingestTime })
    : null;
  if (correction) console.log(`aggregate: correction epoch ${correction.epoch}: ${JSON.stringify(correction)}`);
  const resolver = new Resolver(state.eventMap, priorityMap(all), configMap(all), nowMs);

  // The sweeps (updatedafter revisions, includedeleted deletes) ask from cursors of their own
  // (knowledge/index/sweeps.json) that only a complete sweep advances, and go out before the live
  // fetches with a budget of their own (src/sweep-cursor.ts, PF-5c). The watermarks the live rows
  // advance are no longer where a sweep starts.
  const cursors = loadSweepCursors(DATA_DIR);
  const specs = sweepSpecs(active);
  const { live: outcomes, sweeps: sweepRuns } = await fetchRunInputs(active, specs, cursors, {
    nowMs,
    originFloorMs: sweepOriginFloorMs(nowMs, loadDays),
  });
  const updateRuns = sweepRuns.filter((r) => r.spec.kind === 'updated');
  const deleteRuns = sweepRuns.filter((r) => r.spec.kind === 'deleted');
  for (const r of sweepRuns) {
    const st = r.status;
    console.log(
      `  sweep ${r.key}${r.catchUp ? ' (catch-up)' : ''}: since ${st.since} pages=${st.pages} rows=${st.events_returned} ${Math.round((st.latency_ms ?? 0) / 100) / 10} s ` +
        (r.complete ? `complete, cursor -> ${st.through}` : `UNFINISHED (${st.error}), cursor stays ${st.through ?? 'unset'}`),
    );
  }
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
  const screened = screen(inWindow, tally, undefined, zeroed);
  // FEED-5: a preliminary report (Mexico's SSN) whose reviewed solution is known, in this answer or in the map, is not
  // ingested; one already in the map is withdrawn below (withdrawSupersededPreliminaries).
  const knownFinals = finalsIndex([...screened, ...[...state.eventMap.values()].filter((n) => n.state === 'live').flatMap((n) => n.provenance)]);
  const preliminarySkipped = screened.filter((r) => isPreliminary(r) && supersedingFinal(r, knownFinals) != null);
  const raws = preliminarySkipped.length ? screened.filter((r) => !preliminarySkipped.includes(r)) : screened;
  // Deterministic ingest order (idempotency, design §8.10).
  raws.sort(byIngestOrder);

  // AEC reports not minted beside another agency's event (Resolver.ingest, PF-5b): status `twin_withheld`.
  const twinWithheld: string[] = [];
  for (const raw of raws) {
    const r = resolver.ingest(raw, ingestTime);
    if (raw.providerUpdatedMs != null) {
      state.watermarks[raw.provider] = Math.max(state.watermarks[raw.provider] ?? 0, raw.providerUpdatedMs);
    }
    if (r.changed) log.record(raw, r);
    if (r.withheld) {
      twinWithheld.push(
        `${raw.provider}:${raw.providerEventId} M${raw.mag ?? '?'} ${raw.status ?? ''} beside ${r.node.feedId} [${[...new Set(r.node.provenance.map((p) => p.provider))].sort().join(',')}] ${r.withheld.km.toFixed(1)} km ${(r.withheld.dtMs / 1000).toFixed(1)} s`,
      );
    }
  }
  for (const w of twinWithheld) console.log(`  twin withheld ${w}`);

  // Revision sweep (H2, src/sweep.ts): updatedafter results revise KNOWN events; an unknown row
  // is skipped, not duped, except that a LATE_MINT_PROVIDERS row (ComCat publishes events days
  // after origin, past the live lookback) is minted while its origin is inside the hot window,
  // where the spatial match still runs, unless another provider's event sits beside it (PF-5a);
  // status counts late_minted and late_withheld.
  const updates = screen(updateRuns.flatMap((o) => o.obs).filter((r) => r.eventTimeMs <= futureCeil), tally, undefined, zeroed);
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

  // Delete sweep: tombstone events retracted upstream (op:tombstone; never mints). A ComCat delete also withdraws
  // the AEC row of the same id (COMCAT_ID_PROVIDERS, PF-5b), one op:tombstone line with a reason each.
  const deletes = screen(deleteRuns.flatMap((o) => o.obs), tally, new Set(['coordinateless']));
  let tombstoned = 0;
  let comcatTwinsWithdrawn = 0;
  for (const raw of deletes) {
    const r = resolver.tombstoneProvider(raw, ingestTime);
    if (r?.changed) {
      log.record(raw, r, 'tombstone');
      tombstoned++;
    }
    for (const w of resolver.withdrawComcatTwins(raw, ingestTime)) {
      log.record(w.raw, w.result, 'tombstone', COMCAT_DELETE_REASON);
      comcatTwinsWithdrawn++;
    }
  }
  // FEED-5: preliminary rows whose reviewed solution is now in the map leave their events (op:tombstone with a reason),
  // on days the manifest does not call frozen.
  const preliminarySuperseded = resolver.withdrawSupersededPreliminaries(correctionFloor(nowMs).floorMs, ingestTime);
  for (const w of preliminarySuperseded) {
    log.record(w.raw, w.result, 'tombstone', PRELIMINARY_SUPERSEDED_REASON);
    console.log(`  preliminary superseded ${w.raw.provider}:${w.raw.providerEventId} by ${w.by} (${w.result.node.state === 'tombstoned' ? 'event tombstoned' : `event ${w.result.node.feedId} keeps ${w.result.node.provenance.length} row(s)`})`);
  }
  for (const r of preliminarySkipped) console.log(`  preliminary skipped ${r.provider}:${r.providerEventId} (its reviewed solution is known)`);

  // Rolling-file ids that vanished (PF-5b, log only; src/absence.ts).
  const absent = vanishedIds(state.eventMap, outcomes, nowMs);
  for (const [p, a] of Object.entries(absent)) {
    if (a.count) console.log(`  absent ${p}: ${a.count} live id(s) younger than the watch window no longer listed: ${a.ids.join(', ')}${a.count > a.ids.length ? ', …' : ''}`);
  }

  // Feed-side steps (heal.ts): the coordinate-less retraction of rows published before the ingest
  // rule (the upstream-delete path, op:tombstone with a reason; a no-op once nothing is left)
  // and, once, the heal — the op:merge pass over every live node in the hot window — with its
  // marker, in the same commit as its lines, so it runs exactly once.
  const feedSide = runFeedSideSteps(DATA_DIR, resolver, log, { healDue, loadDays, ingestTime });
  const heal = feedSide.heal;
  if (heal) console.log(`aggregate: heal epoch ${heal.epoch}: ${JSON.stringify(heal)}`);
  for (const l of log.lines) if (l.op === 'merge' && heal && l.seq >= (heal.first_seq ?? Infinity)) console.log(`  heal op:merge ${l.feed_id} -> ${l.superseded_by} (${l.reason})`);
  // EMSC copies that left their event for the one holding the agency row they copy (the reports' path and the
  // feed-side pass; Resolver.rehomeCopy, FEED-2): status `copies_rehomed`.
  for (const c of resolver.rehomedCopies) console.log(`  copy re-homed ${c}`);

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
  // FEED-3: a source that keeps answering with no rows past its activity budget is silent, listed in `silent` and
  // counted in `degraded` (src/activity.ts). The first run seeds the index from the status history.
  const paths = dataPaths(DATA_DIR);
  const loadedActivity = loadActivity(paths.providerActivity, paths.statusHistoryDir);
  if (loadedActivity.seeded) console.log(`aggregate: provider activity seeded from the status history (${Object.keys(loadedActivity.index).length} sources)`);
  const activity = updateActivity(loadedActivity.index, Object.fromEntries(outcomes.map((o) => [o.provider, o.status])), nowMs);
  const silent = silentProviders(activity, active, nowMs);
  for (const id of Object.keys(silent)) if (!degraded.includes(id)) degraded.push(id);
  // The sweeps' outcomes and cursors: fail-open like the live fetch, and a sweep that did not
  // complete keeps its cursor, so the next run asks for the same window again. `epoch` is the
  // catch-up epoch (config SWEEP_EPOCH); each sweep's `epoch` is the one its cursor carries.
  const sweeps = {
    epoch: SWEEP_EPOCH,
    updated: Object.fromEntries(updateRuns.map((r) => [r.spec.provider.id, r.status])),
    deleted: Object.fromEntries(deleteRuns.map((r) => [r.spec.provider.id, r.status])),
  };
  const sweepsFailed = sweepRuns.filter((r) => !r.complete).map((r) => r.key);
  const sweepsCatchUp = sweepRuns.filter((r) => r.catchUp).map((r) => r.key);
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
    comcat_twins_withdrawn: comcatTwinsWithdrawn,
    twin_withheld: twinWithheld.length,
    preliminary_superseded: preliminarySuperseded.length,
    preliminary_skipped: preliminarySkipped.length,
    absent,
    merged: log.merged,
    copies_rehomed: resolver.rehomedCopies.length,
    ...(heal ? { heal } : {}),
    ...(correction ? { correction } : {}),
    duration_ms: Math.round(Date.now() - nowMs),
    degraded,
    silent,
    providers,
    sweeps,
  };
  saveEventMap(DATA_DIR, state.eventMap);
  saveMeta(DATA_DIR, state.head, state.watermarks, status);
  saveActivity(paths.providerActivity, activity);
  saveSweepCursors(DATA_DIR, nextCursors(cursors, sweepRuns));

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
      (comcatTwinsWithdrawn ? `comcat_twins_withdrawn=${comcatTwinsWithdrawn} ` : '') +
      (twinWithheld.length ? `twin_withheld=${twinWithheld.length} ` : '') +
      `providers=${outcomes.filter((o) => o.status.ok).length}/${outcomes.length}` +
      (tally.bad_coords ? ` bad_coords_dropped=${tally.bad_coords}` : '') +
      (tally.coordinateless ? ` coordinateless_dropped=${tally.coordinateless}` : '') +
      (zeroedOut.withdrawn ? ` coordinateless_withdrawn=${zeroedOut.withdrawn}` : '') +
      (feedSide.retracted ? ` coordinateless_retracted=${feedSide.retracted}` : '') +
      (heal ? ` heal_epoch=${heal.epoch} heal_merged=${heal.merged}` : '') +
      (correction ? ` correction_epoch=${correction.epoch} from_epoch=${correction.from_epoch}` : '') +
      (correction?.afad ? ` afad_retimed=${correction.afad.retimed} afad_moved_out=${correction.afad.moved_out} afad_merged=${correction.afad.merged}` : '') +
      (correction?.comcat_id ? ` comcat_id_merged=${correction.comcat_id.merged}` : '') +
      (correction?.nrcan ? ` nrcan_filled=${correction.nrcan.filled} nrcan_chosen=${correction.nrcan.chosen} nrcan_merged=${correction.nrcan.merged}` : '') +
      (degraded.length ? ` degraded=[${degraded.join(',')}]` : '') +
      (Object.keys(silent).length ? ` silent=[${Object.entries(silent).map(([id, e]) => `${id}:${Math.round(e.silent_hours)}h`).join(',')}]` : '') +
      (sweep.stale ? ` sweep_stale_skipped=${sweep.stale}` : '') +
      ` sweeps_failed=[${sweepsFailed.join(',')}]` +
      (sweepsCatchUp.length ? ` sweeps_catch_up=[${sweepsCatchUp.join(',')}]` : ''),
  );
}

main().catch((err) => {
  console.error('aggregate failed:', err);
  process.exit(1);
});
