import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dataPaths } from './config.js';
import { dayStartMs } from './backfill-cursor.js';
import { type BackfillCursorFile, applyWindowResult, planJobs, stallReport, windowText } from './backfill-plan.js';
import { readArchivedDays } from './archive-io.js';
import { eventDayKey } from './bitemporal.js';
import { Resolver } from './dedup.js';
import {
  loadInventory,
  readDayPartitionNodes,
  saveInventory,
  writeDayPartition,
  type Inventory,
} from './partitions.js';
import { activeProviders, fetchProviderWindow, loadRegistry, priorityMap, configMap } from './providers.js';
import { byIngestOrder, emptyTally, screen } from './quality.js';
import type { EventNode, Head, RawObs } from './types.js';
import { isoFromMs } from './util.js';

const DAY = 86_400_000;
const BACKFILL_TARGET_YEARS = Number(process.env.BACKFILL_TARGET_YEARS ?? 3);

type Cursor = BackfillCursorFile;

/** Oldest UTC day owned by the live pipeline (has an event_map shard). Backfill fills
 *  strictly before this, so it never collides with aggregate/derive rewrites. */
function earliestLiveDay(root: string, nowMs: number): string {
  const dir = dataPaths(root).eventMapDir;
  const today = eventDayKey(nowMs);
  if (!existsSync(dir)) return today;
  const days = readdirSync(dir).filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, 10)).sort();
  return days[0] ?? today;
}

function loadCursor(root: string, nowMs: number, liveDay: string): Cursor {
  const f = dataPaths(root).backfillCursor;
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as Cursor;
  return { targetStart: eventDayKey(nowMs - BACKFILL_TARGET_YEARS * 365 * DAY), providers: {} };
}

async function main(): Promise<void> {
  const root = dataPaths().root;
  const nowMs = Date.now();
  const ingestTime = process.env.RUN_INGEST_TIME ?? isoFromMs(nowMs);
  const all = loadRegistry();
  const providers = activeProviders(all);
  const liveDay = earliestLiveDay(root, nowMs);
  const liveDayMs = dayStartMs(liveDay);
  // Days already rolled to Releases are no longer in-tree. To let a (new) source dedup
  // against + merge into that cold history, we pull the touched archived days back from
  // their Release tarballs (below), re-materialize the changed ones, and flag the month for
  // re-roll — instead of blindly skipping (which would re-mint duplicates).
  const archFile = dataPaths(root).archivesIndex;
  const archives = existsSync(archFile)
    ? (JSON.parse(readFileSync(archFile, 'utf8')) as { list: { period: string; tag: string; asset: string; days?: string[]; needs_reroll?: boolean }[] })
    : { list: [] };
  const archivedDays = new Set<string>();
  for (const a of archives.list) for (const d of a.days ?? []) archivedDays.add(d);
  const cursor = loadCursor(root, nowMs, liveDay);
  const targetMs = dayStartMs(cursor.targetStart);

  // Explicit dispatch window overrides the cursor for a one-off range.
  const dispatchStart = process.env.BACKFILL_STARTTIME ? Date.parse(process.env.BACKFILL_STARTTIME) : null;
  const dispatchEnd = process.env.BACKFILL_ENDTIME ? Date.parse(process.env.BACKFILL_ENDTIME) : null;
  const onlyProviders = process.env.BACKFILL_PROVIDERS ? new Set(process.env.BACKFILL_PROVIDERS.split(',')) : null;

  // 1) Decide each provider's window for this run (backfill-plan.ts planJobs). Dispatch is a one-off fill of an
  // explicit range — it must NOT move the auto-cursor, or it leaves a gap (the auto-walk would skip the range between
  // it and the live edge).
  const isDispatch = dispatchStart != null && dispatchEnd != null;
  const jobs = planJobs(providers, cursor, {
    liveDay,
    liveDayMs,
    targetMs,
    dispatch: isDispatch ? { startMs: dispatchStart, endMs: dispatchEnd } : null,
    only: onlyProviders,
  });

  if (!jobs.length) {
    writeFileSync(dataPaths(root).backfillCursor, JSON.stringify(cursor, null, 2) + '\n');
    console.log('backfill: nothing to do (all providers done or none eligible)');
    return;
  }

  // 2) Fetch all windows in parallel.
  const results = await Promise.all(jobs.map((j) => fetchProviderWindow(j.p, j.startMs, j.endMs, j.cfg.minmag)));

  // 3) Build a transient index from existing partitions across the union day range.
  const minStart = Math.min(...jobs.map((j) => j.startMs));
  const maxEnd = Math.max(...jobs.map((j) => j.endMs));
  const transient = new Map<string, EventNode>();
  // Which days still have an in-tree partition (readDayPartitionNodes returns [] when the file
  // is absent). Such a day is fully in `transient`, so it stays writable even if its month's
  // archive is unreadable — see the write-back skip below.
  const inTreeDays = new Set<string>();
  for (let ms = dayStartMs(eventDayKey(minStart)); ms <= maxEnd; ms += DAY) {
    const day = eventDayKey(ms);
    if (day >= liveDay) continue; // never touch live-owned days
    const nodes = readDayPartitionNodes(root, day);
    if (nodes.length) inTreeDays.add(day);
    for (const node of nodes) transient.set(node.feedId, node);
  }
  // Pull the archived days this run's fetch actually lands on (from their Release tarballs)
  // into the transient BEFORE the Resolver is built, so their existing events are in its
  // identity index and the new source merges instead of re-minting. Bounded: only touched days.
  const archivedTouched = new Set<string>();
  for (const res of results) {
    if (!res.status.ok) continue;
    for (const o of res.obs) {
      const day = eventDayKey(o.eventTimeMs);
      if (day < liveDay && archivedDays.has(day)) archivedTouched.add(day);
    }
  }
  // Months we could not read back: their archived, no-longer-in-tree days stay untouchable below —
  // `transient` holds only this run's fresh rows for those, so writing one truncates the day
  // (2026-07: −34.5k events).
  const failedMonths = new Set<string>();
  if (archivedTouched.size) {
    const arch = readArchivedDays(archives.list, archivedTouched);
    for (const nodes of arch.days.values()) for (const n of nodes) transient.set(n.feedId, n);
    for (const m of arch.failedMonths) failedMonths.add(m);
    console.log(`backfill: pulled ${arch.days.size}/${archivedTouched.size} archived day(s) for merge`);
  }
  // Days whose only copy sits inside an archive we could not read: month failed, day is archived,
  // nothing in-tree to rebuild from. Only these are left unwritten below — every other day of a
  // failed month is complete in `transient` and safe to write.
  const untouchableDays = new Set(
    [...archivedTouched].filter((d) => failedMonths.has(d.slice(0, 7)) && !inTreeDays.has(d)),
  );
  // Does a fetch window actually CONTAIN one? Freezing a cursor on mere month-overlap stalls a
  // provider whose every day was written safely — zero progress, red every hour, nothing lost.
  const windowHasUntouchable = (startMs: number, endMs: number): boolean => {
    if (!untouchableDays.size) return false;
    for (let ms = dayStartMs(eventDayKey(startMs)); ms <= endMs; ms += DAY) {
      if (untouchableDays.has(eventDayKey(ms))) return true;
    }
    return false;
  };
  // merge=false: backfill never logs, so it never folds (op:merge) — see Resolver.
  const resolver = new Resolver(transient, priorityMap(all), configMap(all), nowMs, { hotFloorMs: 0, merge: false });

  // 4) Ingest (deterministic order). Overflowed windows are dropped + retried narrower.
  const raws: RawObs[] = [];
  // Coordinate-less reports held back by the screen: a known id among them is its provider's
  // withdrawal (Resolver.withdrawZeroed), applied after the ingest below.
  const zeroed: RawObs[] = [];
  const screened = emptyTally();
  let overflowCount = 0;
  let saturatedCount = 0;
  let failedCount = 0;
  // What must turn this run red after its commit (the marker below), besides an unreadable archive.
  const blockers: string[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i]!;
    const res = results[i]!;
    // The cursor transitions (backfill-plan.ts applyWindowResult): overflow with room to narrow → retry a smaller
    // window next run, ingest nothing (no partial-window gaps; at windowDays<=1 it can't narrow, so it falls through
    // as saturated); a failure counts and halves; an answer advances and adapts the window — unless the window holds a
    // day we must leave unwritten below, when advancing would walk the cursor past it for good (the 2026-07 truncation
    // failure mode): the provider then retries the identical window once the Releases are reachable.
    const { verdict, blocker } = applyWindowResult(j, res, { ingestTime, targetMs, untouchable: windowHasUntouchable(j.startMs, j.endMs) });
    if (blocker) blockers.push(blocker);
    if (verdict.kind === 'narrowed') {
      overflowCount++;
      continue;
    }
    if (verdict.kind === 'failed') {
      failedCount++;
      const cur = j.cur;
      if (cur) {
        console.log(
          `backfill: ${j.p.id} window ${windowText(j)} failed${res.status.latency_ms != null ? ` after ${res.status.latency_ms} ms` : ''}: ${verdict.error} — ` +
            `${cur.failures} consecutive failure(s) since ${cur.failingSince}; next window ${cur.windowDays} d`,
        );
      }
      continue;
    }
    // Saturated single day (overflow even at a 1-day window): this one day is denser than the provider's page cap.
    // Never spin — the capped rows are captured (partial), the day is recorded for sub-day remediation, and the
    // cursor advanced past it.
    if (verdict.saturated && j.cur) saturatedCount++;
    // The same door as the live path: no out-of-range or coordinate-less report enters history.
    const heldBack: RawObs[] = [];
    for (const o of screen(res.obs, screened, undefined, heldBack)) {
      const day = eventDayKey(o.eventTimeMs);
      // Archived days are now pulled into the transient above, so they can be ingested too.
      if (day < liveDay) raws.push(o);
    }
    for (const o of heldBack) if (eventDayKey(o.eventTimeMs) < liveDay) zeroed.push(o);
  }
  // A walk that keeps failing is reported, never silent (backfill-cursor.ts stallLevel).
  const stalls = stallReport(jobs);
  for (const w of stalls.warnings) console.log(`::warning::${w}`);
  blockers.push(...stalls.blockers);

  raws.sort(byIngestOrder);
  zeroed.sort(byIngestOrder);

  // Backfill does NOT append to the observation log or advance head.seq. Historical
  // data lives in the (lossless) day partitions; the log stays the LIVE knowledge
  // stream, so a fast multi-year backfill can't bloat it. Backfilled nodes carry the
  // current head.seq as a "learned-around" marker.
  const head = JSON.parse(readFileSync(dataPaths(root).head, 'utf8')) as Head;
  const seqMarker = head.seq;
  let changedCount = 0;
  const changedDays = new Set<string>();
  for (const raw of raws) {
    const r = resolver.ingest(raw, ingestTime);
    if (r.changed) {
      r.node.lastSeq = seqMarker;
      if (r.node.firstSeenSeq < 0) r.node.firstSeenSeq = seqMarker;
      changedDays.add(eventDayKey(r.node.eventTimeMs));
      changedCount++;
    }
  }
  // A provider that zeroed an id this history already holds withdrew it (the live path's rule):
  // drop its row, tombstoning the event when no row is left. Unknown placeholders change nothing.
  let withdrawnCount = 0;
  for (const raw of zeroed) {
    const r = resolver.withdrawZeroed(raw, ingestTime);
    if (r?.changed) {
      r.node.lastSeq = seqMarker;
      changedDays.add(eventDayKey(r.node.eventTimeMs));
      changedCount++;
      withdrawnCount++;
    }
  }

  // 5) Write back partitions for every touched day + update inventory.
  const byDay = new Map<string, EventNode[]>();
  for (const node of transient.values()) {
    const day = eventDayKey(node.eventTimeMs);
    if (day >= liveDay) continue;
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(node);
  }
  const inv: Inventory = loadInventory(root);
  let rewritten = 0;
  let rematerialized = 0;
  const writtenDays = new Set<string>();
  let skippedDays = 0;
  for (const [day, nodes] of byDay) {
    // Untouchable ONLY when the day's history lives SOLELY in the unreadable tarball: month
    // failed AND the day is archived AND nothing in-tree to rebuild from. Then skip it entirely —
    // no partition, no inventory, and (via writtenDays) no needs_reroll — so archive.ts can't
    // promote a fragment to authoritative. A day the archive never covered (2024-05 went cold
    // holding only days 20-31) or one already re-materialized in-tree is complete in `transient`,
    // so writing it is loss-free; skipping it would discard rows that can't be truncated.
    if (untouchableDays.has(day)) {
      skippedDays++;
      continue;
    }
    // An archived day is in `transient` only because we pulled it to merge a new source —
    // re-materialize it to the tree ONLY if it actually changed (else a needless re-roll).
    const isArchived = archivedDays.has(day);
    if (isArchived && !changedDays.has(day)) continue;
    const { written, stat } = writeDayPartition(root, day, nodes, { nowMs, headIngestTime: ingestTime });
    if (written) {
      rewritten++;
      writtenDays.add(day);
      if (isArchived) rematerialized++;
    }
    inv[day] = stat;
  }
  saveInventory(root, inv);
  // If we byte-changed a day in a month that's archived, flag it so archive.ts re-rolls the
  // whole month (merging the re-materialized in-tree days back into the Release asset).
  const touchedMonths = new Set([...writtenDays].map((d) => d.slice(0, 7)));
  let reroll = false;
  for (const a of archives.list) {
    if (touchedMonths.has(a.period) && !a.needs_reroll) {
      a.needs_reroll = true;
      reroll = true;
    }
  }
  if (reroll) writeFileSync(archFile, JSON.stringify(archives, null, 2) + '\n');
  writeFileSync(dataPaths(root).backfillCursor, JSON.stringify(cursor, null, 2) + '\n');

  const remaining = Object.values(cursor.providers).filter((c) => !c.done).length;
  console.log(
    `backfill: jobs=${jobs.length} fetched=${raws.length} changed=${changedCount} days_written=${rewritten} ` +
      `rematerialized=${rematerialized} overflow=${overflowCount} saturated=${saturatedCount} failed=${failedCount} providers_remaining=${remaining}` +
      (screened.bad_coords ? ` bad_coords_dropped=${screened.bad_coords}` : '') +
      (screened.coordinateless ? ` coordinateless_dropped=${screened.coordinateless}` : '') +
      (withdrawnCount ? ` coordinateless_withdrawn=${withdrawnCount}` : ''),
  );
  // The rest of the run is honest work and stays written (cursor included), but the run must go
  // RED: a silently-green skip is exactly how the 2026-07 truncation went unnoticed for months.
  if (failedMonths.size) {
    blockers.unshift(
      `backfill: archive unreadable for ${[...failedMonths].sort().join(', ')} — left ${skippedDays} archived day(s) whose history exists only in those tarballs untouched ` +
        `rather than rewrite them from fresh rows alone, and held back the cursor of every provider whose window overlapped them; re-run once Releases are reachable`,
    );
  }
  if (blockers.length) {
    for (const msg of blockers) console.error(`::error::${msg}`);
    // Marker + exit 0, NOT process.exitCode = 1: a non-zero tool step makes Actions skip every
    // later step lacking `if:`, so the commit never lands and each run redoes and re-discards the
    // same work. The workflow's final always()-step reads this and goes red AFTER the push.
    // Workspace root, never .data — a marker under .data would be committed to the data branch.
    writeFileSync('backfill-blocked.txt', blockers.join('\n') + '\n');
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
