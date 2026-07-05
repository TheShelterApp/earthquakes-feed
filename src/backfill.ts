import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dataPaths } from './config.js';
import { type BackfillCfg, backfillCfg } from './backfill-cfg.js';
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
import type { EventNode, Head, ProviderConfig, RawObs } from './types.js';
import { isoFromMs } from './util.js';

const DAY = 86_400_000;
const BACKFILL_TARGET_YEARS = Number(process.env.BACKFILL_TARGET_YEARS ?? 3);

interface ProviderCursor {
  filledBackTo: string;
  windowDays: number;
  done: boolean;
  failures: number;
  lastCount: number;
  lastRun: string;
  /** Days denser than the provider's page cap even at a 1-day window — captured partially,
   *  recorded here (bounded) for optional later sub-day remediation. */
  saturatedDays?: string[];
}
interface Cursor {
  targetStart: string;
  providers: Record<string, ProviderCursor>;
}

const dayStartMs = (dayKey: string): number => Date.parse(`${dayKey}T00:00:00Z`);

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

  // 1) Decide each provider's window for this run.
  interface Job {
    p: ProviderConfig;
    cfg: BackfillCfg;
    cur: ProviderCursor | null;
    startMs: number;
    endMs: number;
  }
  // Dispatch is a one-off fill of an explicit range — it must NOT move the auto-cursor,
  // or it leaves a gap (the auto-walk would skip the range between it and the live edge).
  const isDispatch = dispatchStart != null && dispatchEnd != null;
  const jobs: Job[] = [];
  for (const p of providers) {
    if (onlyProviders && !onlyProviders.has(p.id)) continue;
    const cfg = backfillCfg(p);
    if (!cfg) continue;
    if (isDispatch) {
      jobs.push({ p, cfg, cur: null, startMs: dispatchStart, endMs: dispatchEnd });
      continue;
    }
    const cur = (cursor.providers[p.id] ??= { filledBackTo: liveDay, windowDays: cfg.initialWindowDays, done: false, failures: 0, lastCount: 0, lastRun: '' });
    if (cur.done) continue;
    const endMs = Math.min(dayStartMs(cur.filledBackTo), liveDayMs);
    const startMs = Math.max(targetMs, cfg.earliestMs, endMs - cur.windowDays * DAY);
    if (startMs >= endMs) {
      cur.done = true;
      continue;
    }
    jobs.push({ p, cfg, cur, startMs, endMs });
  }

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
  for (let ms = dayStartMs(eventDayKey(minStart)); ms <= maxEnd; ms += DAY) {
    const day = eventDayKey(ms);
    if (day >= liveDay) continue; // never touch live-owned days
    for (const node of readDayPartitionNodes(root, day)) transient.set(node.feedId, node);
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
  if (archivedTouched.size) {
    const arch = readArchivedDays(archives.list, archivedTouched);
    for (const nodes of arch.values()) for (const n of nodes) transient.set(n.feedId, n);
    console.log(`backfill: pulled ${arch.size}/${archivedTouched.size} archived day(s) for merge`);
  }
  const resolver = new Resolver(transient, priorityMap(all), configMap(all), nowMs, { hotFloorMs: 0 });

  // 4) Ingest (deterministic order). Overflowed windows are dropped + retried narrower.
  const raws: RawObs[] = [];
  let overflowCount = 0;
  let saturatedCount = 0;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i]!;
    const res = results[i]!;
    const cur = j.cur;
    if (cur) cur.lastRun = ingestTime;
    // Overflow WITH room to narrow: retry a smaller window next run, ingest nothing
    // (avoid partial-window gaps). At windowDays<=1 we can't narrow further — fall through.
    if (res.overflow && (!cur || cur.windowDays > 1)) {
      if (cur) cur.windowDays = Math.max(1, Math.floor(cur.windowDays / 2));
      overflowCount++;
      continue;
    }
    if (!res.status.ok) {
      if (cur) cur.failures++;
      continue;
    }
    // Saturated single day (overflow even at a 1-day window): this one day is denser than the
    // provider's page cap. Never spin — capture the capped rows we got (partial), record the
    // day for later sub-day remediation, and advance past it below.
    const saturated = res.overflow;
    if (saturated && cur) {
      (cur.saturatedDays ??= []).push(eventDayKey(j.startMs));
      if (cur.saturatedDays.length > 100) cur.saturatedDays.shift();
      saturatedCount++;
    }
    for (const o of res.obs) {
      const day = eventDayKey(o.eventTimeMs);
      // Archived days are now pulled into the transient above, so they can be ingested too.
      if (day < liveDay) raws.push(o);
    }
    if (cur) {
      cur.failures = 0;
      cur.lastCount = res.obs.length;
      // Advance + adapt the window: reset after a saturated day, else grow when sparse.
      cur.filledBackTo = eventDayKey(j.startMs);
      if (saturated) cur.windowDays = j.cfg.initialWindowDays;
      else if (res.obs.length < 0.3 * 5000) cur.windowDays = Math.min(j.cfg.maxWindowDays, Math.ceil(cur.windowDays * 1.5));
      if (dayStartMs(cur.filledBackTo) <= Math.max(targetMs, j.cfg.earliestMs)) cur.done = true;
    }
  }

  raws.sort(
    (a, b) =>
      a.eventTimeMs - b.eventTimeMs ||
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
      (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0),
  );

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
  for (const [day, nodes] of byDay) {
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
      `rematerialized=${rematerialized} overflow=${overflowCount} saturated=${saturatedCount} providers_remaining=${remaining}`,
  );
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
