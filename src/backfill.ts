import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { dataPaths } from './config.js';
import { dayStartMs } from './backfill-cursor.js';
import { backfillCfg } from './backfill-cfg.js';
import {
  type BackfillCursorFile,
  applyWindowResult,
  closeBeyondRetention,
  homeDayOf,
  openDispatchLines,
  planDays,
  planWindows,
  recordDispatchOutcome,
  rememberHomeDay,
  saturatedReport,
  skipLine,
  sparseMonthPatterns,
  stallReport,
  windowDays,
  windowText,
} from './backfill-plan.js';
import { readArchivedDays } from './archive-io.js';
import { eventDayKey } from './bitemporal.js';
import { Resolver } from './dedup.js';
import {
  loadInventory,
  loadPartitionFormat,
  partitionPath,
  readDayPartitionNodes,
  saveInventory,
  writeDayPartition,
  type Inventory,
} from './partitions.js';
import { activeProviders, fetchProviderWindow, loadRegistry, priorityMap, configMap } from './providers.js';
import type { RemediationIndex } from './remediation.js';
import { RETENTION } from './retention.js';
import { assertCheckedOut, isSparseCheckout, treeNames } from './sparse-checkout.js';
import { byIngestOrder, emptyTally, screen } from './quality.js';
import type { EventNode, Head, RawObs } from './types.js';
import { isoFromMs } from './util.js';

const DAY = 86_400_000;
const BACKFILL_TARGET_YEARS = Number(process.env.BACKFILL_TARGET_YEARS ?? 3);

type Cursor = BackfillCursorFile;

/** Oldest UTC day owned by the live pipeline (has an event_map shard). Backfill fills
 *  strictly before this, so it never collides with aggregate/derive rewrites. On the sparse checkout of backfill.yml
 *  the shards are not checked out: their names come from git (a missing directory would read as "today" and let the
 *  run write live-owned days). */
function earliestLiveDay(root: string, nowMs: number): string {
  const dir = dataPaths(root).eventMapDir;
  const today = eventDayKey(nowMs);
  let names: string[];
  if (existsSync(dir)) names = readdirSync(dir);
  else if (isSparseCheckout(root)) names = treeNames(root, relative(root, dir).split(sep).join('/'));
  else return today;
  const days = names.filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, 10)).sort();
  return days[0] ?? today;
}

/** The index files backfill reads (cursor, archives, inventory, head, partition format): every `*.json` of
 *  knowledge/index, the sparse pattern of backfill.yml. */
const INDEX_JSON = /^knowledge\/index\/[^/]+\.json$/;

function loadCursor(root: string, nowMs: number, liveDay: string): Cursor {
  const f = dataPaths(root).backfillCursor;
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as Cursor;
  return { targetStart: eventDayKey(nowMs - BACKFILL_TARGET_YEARS * 365 * DAY), providers: {} };
}

/**
 * The blocked marker (backfill-blocked.txt in the workspace root, never .data: a marker there would be committed to the
 * data branch), read by the health workflow as the artifact walk-blocked-backfill. It states every standing block: the
 * open dispatched windows, the stalled walks, this run's unreadable archives. A run with none writes nothing here and
 * the workflow uploads an empty marker, which clears the board.
 */
function writeMarker(blockers: readonly string[]): void {
  if (!blockers.length) return;
  for (const msg of blockers) console.error(`::error::${msg}`);
  // Marker + exit 0, NOT process.exitCode = 1: a non-zero tool step makes Actions skip every later step lacking `if:`,
  // so the commit never lands and each run redoes and re-discards the same work.
  writeFileSync('backfill-blocked.txt', blockers.join('\n') + '\n');
}

/** The remediation index (knowledge/index/remediation.json, in the sparse checkout's index files): which saturated
 *  days a remediation edition completed. */
function loadRemediation(root: string): Pick<RemediationIndex, 'raw' | 'editions'> {
  const f = dataPaths(root).remediationIndex;
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RemediationIndex) : { raw: [], editions: [] };
}

/** The standing blocks every run reports, walk jobs or not: the stalled walks, the open dispatched windows and the
 *  saturated days no remediation edition has completed yet (SHLTR-151). */
function standing(providers: ReturnType<typeof activeProviders>, cursor: Cursor, root: string, nowMs: number): { blockers: string[]; warnings: string[] } {
  const eligible = providers.filter((p) => backfillCfg(p) !== null);
  const walks = eligible.map((p) => ({ p, cur: cursor.providers[p.id] ?? null }));
  const stalls = stallReport(walks);
  const open = openDispatchLines(cursor.dispatched ?? [], new Set(eligible.map((p) => p.id)));
  const saturated = saturatedReport(walks, loadRemediation(root), nowMs);
  return { blockers: [...open, ...stalls.blockers, ...saturated.blockers], warnings: [...stalls.warnings, ...saturated.warnings] };
}

async function main(): Promise<void> {
  const root = dataPaths().root;
  // Before anything is read: on a sparse checkout an index file that is not checked out would read as absent (a lost
  // cursor restarts every walk at the live edge).
  assertCheckedOut(root, ['knowledge/index'], (p) => INDEX_JSON.test(p));
  const nowMs = Date.now();
  const ingestTime = process.env.RUN_INGEST_TIME ?? isoFromMs(nowMs);
  const all = loadRegistry();
  const providers = activeProviders(all);
  const liveDay = earliestLiveDay(root, nowMs);
  const liveDayMs = dayStartMs(liveDay);
  // The partitions it rewrites carry `review_status` as derive's would (partitions.ts PartitionFormat).
  const fmt = loadPartitionFormat(root);
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

  // 1) Decide each provider's window for this run (backfill-plan.ts planWindows). Dispatch is a one-off fill of an
  // explicit range — it must NOT move the auto-cursor, or it leaves a gap (the auto-walk would skip the range between
  // it and the live edge).
  // A source with a retention (registry retentionDays, SHLTR-146) is never asked for a day before it: those windows
  // are `skipped` with the reason `retention` and reported as such, never as filled.
  const isDispatch = dispatchStart != null && dispatchEnd != null;
  const { jobs, skipped } = planWindows(providers, cursor, {
    liveDay,
    liveDayMs,
    targetMs,
    nowMs,
    dispatch: isDispatch ? { startMs: dispatchStart, endMs: dispatchEnd } : null,
    only: onlyProviders,
  });

  // backfill.yml's dry run (input dry_run): the plan, day by day, and nothing else (no write, no request).
  if (process.env.BACKFILL_PHASE === 'plan') {
    for (const j of jobs) console.log(`backfill plan: ${j.p.id} ${windowText(j)} fetch${j.cur ? ` (walk at ${j.cur.filledBackTo}, ${j.cur.windowDays}-day window)` : ' (dispatched)'}`);
    for (const k of skipped) console.log(`backfill plan: ${skipLine(k).replace(/^backfill: /, '')}`);
    for (const d of planDays(jobs, skipped)) console.log(`backfill plan: ${d.provider} ${d.day} ${d.action}`);
    const out = process.env.BACKFILL_PLAN_OUT;
    if (out) {
      const plan = {
        live_day: liveDay,
        dispatch: isDispatch ? { start: new Date(dispatchStart).toISOString(), end: new Date(dispatchEnd).toISOString() } : null,
        jobs: jobs.map((j) => ({ provider: j.p.id, start: new Date(j.startMs).toISOString(), end: new Date(j.endMs).toISOString(), walk: j.cur != null })),
        skipped: skipped.map((k) => ({ provider: k.provider, start: new Date(k.startMs).toISOString(), end: new Date(k.endMs).toISOString(), reason: k.reason, retained_from: k.retainedFrom, walk: k.walk, note: k.note })),
        days: planDays(jobs, skipped),
      };
      writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
    }
    console.log(`backfill plan: ${jobs.length} window(s) to fetch, ${skipped.length} skipped; nothing written, nothing asked`);
    return;
  }

  // backfill.yml's plan step (SHLTR-149): the months this plan reads and writes, as sparse-checkout patterns, and
  // nothing else (no write to the data checkout, no request).
  const days = windowDays(jobs, liveDay);
  if (process.env.BACKFILL_PHASE === 'paths') {
    const out = process.env.BACKFILL_PATHS_OUT;
    if (!out) throw new Error('BACKFILL_PHASE=paths needs BACKFILL_PATHS_OUT');
    const patterns = sparseMonthPatterns(days);
    writeFileSync(out, patterns.map((p) => `${p}\n`).join(''));
    console.log(`backfill: ${jobs.length} window(s) over ${days[0] ?? '-'}..${days.at(-1) ?? '-'}: ${patterns.length} month(s) to check out`);
    return;
  }
  const dayFiles = new Set(days.map(partitionPath));
  assertCheckedOut(root, ['events'], (p) => dayFiles.has(p));
  for (const k of skipped) console.log(`::notice::${skipLine(k)}`);
  // An open dispatched window before a source's retention can never be filled: it leaves the open list.
  if (cursor.dispatched?.length) {
    const r = closeBeyondRetention(cursor.dispatched, providers, nowMs);
    for (const line of r.closed) console.log(`::notice::${line}`);
    if (r.open.length) cursor.dispatched = r.open;
    else delete cursor.dispatched;
  }

  if (!jobs.length) {
    writeFileSync(dataPaths(root).backfillCursor, JSON.stringify(cursor, null, 2) + '\n');
    console.log(`backfill: nothing to do (all providers done or none eligible${skipped.length ? `; ${skipped.length} window(s) skipped: ${RETENTION}` : ''})`);
    const st = standing(providers, cursor, root, nowMs);
    for (const w of st.warnings) console.log(`::warning::${w}`);
    writeMarker(st.blockers);
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
  // An event kept off its time-day by the day file it is published in (a re-merged archive keeps an event whose time
  // left the month in the member it was read from, src/remerge.ts `off_unit`): written back to that day, never moved, so
  // a re-materialized day cannot lose it on the re-roll (C6).
  const homeDay = new Map<string, string>();
  const remember = (day: string, n: EventNode): void => rememberHomeDay(homeDay, day, n);
  for (let ms = dayStartMs(eventDayKey(minStart)); ms <= maxEnd; ms += DAY) {
    const day = eventDayKey(ms);
    if (day >= liveDay) continue; // never touch live-owned days
    const nodes = readDayPartitionNodes(root, day);
    if (nodes.length) inTreeDays.add(day);
    for (const node of nodes) {
      transient.set(node.feedId, node);
      remember(day, node);
    }
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
    for (const [day, nodes] of arch.days) {
      for (const n of nodes) {
        transient.set(n.feedId, n);
        remember(day, n);
      }
    }
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
    const untouchable = windowHasUntouchable(j.startMs, j.endMs);
    const { verdict } = applyWindowResult(j, res, { ingestTime, targetMs, untouchable });
    // A dispatched window's overflow, failure or held-back day stays open in the cursor file (reported by every run
    // below until dispatched ranges that answered in full cover it); a full answer closes what it covers.
    if (!j.cur) {
      const open = recordDispatchOutcome(cursor.dispatched ?? [], j, verdict, { ingestTime, untouchable });
      if (open.length) cursor.dispatched = open;
      else delete cursor.dispatched;
    }
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
  const dayOf = (n: EventNode): string => homeDayOf(homeDay, n);
  for (const raw of raws) {
    const r = resolver.ingest(raw, ingestTime);
    if (r.changed) {
      r.node.lastSeq = seqMarker;
      if (r.node.firstSeenSeq < 0) r.node.firstSeenSeq = seqMarker;
      changedDays.add(dayOf(r.node));
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
      changedDays.add(dayOf(r.node));
      changedCount++;
      withdrawnCount++;
    }
  }

  // 5) Write back partitions for every touched day + update inventory.
  const byDay = new Map<string, EventNode[]>();
  for (const node of transient.values()) {
    const day = dayOf(node);
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
    const { written, stat } = writeDayPartition(root, day, nodes, { nowMs, headIngestTime: ingestTime, fmt });
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
  // A walk that keeps failing, and a dispatched window not filled yet, are reported on every run, never silent
  // (backfill-plan.ts stallReport, openDispatchLines).
  const st = standing(providers, cursor, root, nowMs);
  for (const w of st.warnings) console.log(`::warning::${w}`);
  blockers.push(...st.blockers);
  writeMarker(blockers);
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
