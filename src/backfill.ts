import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { GRID_CELL_DEG, dataPaths } from './config.js';
import { appendObservations, eventDayKey } from './bitemporal.js';
import { Resolver, type IngestResult } from './dedup.js';
import {
  loadInventory,
  readDayPartitionNodes,
  saveInventory,
  writeDayPartition,
  type Inventory,
} from './partitions.js';
import { activeProviders, fetchProviderWindow, loadRegistry, priorityMap, configMap } from './providers.js';
import type { EventNode, Head, Observation, ProviderConfig, RawObs } from './types.js';
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
}
interface Cursor {
  targetStart: string;
  providers: Record<string, ProviderCursor>;
}

interface BackfillCfg {
  earliestMs: number;
  minmag?: number;
  maxWindowDays: number;
  initialWindowDays: number;
}

/** A provider is backfill-eligible if it is FDSN or one of the time-range custom APIs,
 *  unless the registry explicitly disables it. */
function backfillCfg(p: ProviderConfig): BackfillCfg | null {
  const eligible = p.adapter === 'fdsn' || p.id === 'afad' || p.id === 'kagsr';
  const enabled = p.backfill?.enabled ?? eligible;
  if (!enabled) return null;
  const isAfad = p.id === 'afad';
  return {
    earliestMs: Date.parse(`${p.backfill?.earliest ?? (isAfad ? '2015-01-01' : '1990-01-01')}T00:00:00Z`),
    minmag: p.backfill?.minmag,
    maxWindowDays: p.backfill?.maxWindowDays ?? (isAfad ? 7 : 30),
    initialWindowDays: p.backfill?.initialWindowDays ?? (isAfad ? 3 : 14),
  };
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
    backfilled: true,
    extra: raw.extra,
  };
}

async function main(): Promise<void> {
  const root = dataPaths().root;
  const nowMs = Date.now();
  const ingestTime = process.env.RUN_INGEST_TIME ?? isoFromMs(nowMs);
  const all = loadRegistry();
  const providers = activeProviders(all);
  const liveDay = earliestLiveDay(root, nowMs);
  const liveDayMs = dayStartMs(liveDay);
  // Days already rolled to Releases are no longer in-tree; touching them would re-mint
  // duplicates (their nodes aren't in the transient index). Skip them.
  const archivedDays = new Set<string>();
  const archFile = dataPaths(root).archivesIndex;
  if (existsSync(archFile)) {
    for (const a of (JSON.parse(readFileSync(archFile, 'utf8')) as { list?: { days?: string[] }[] }).list ?? []) {
      for (const d of a.days ?? []) archivedDays.add(d);
    }
  }
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
    cur: ProviderCursor;
    startMs: number;
    endMs: number;
  }
  const jobs: Job[] = [];
  for (const p of providers) {
    if (onlyProviders && !onlyProviders.has(p.id)) continue;
    const cfg = backfillCfg(p);
    if (!cfg) continue;
    const cur = (cursor.providers[p.id] ??= { filledBackTo: liveDay, windowDays: cfg.initialWindowDays, done: false, failures: 0, lastCount: 0, lastRun: '' });
    if (cur.done && !dispatchStart) continue;
    const endMs = dispatchEnd ?? Math.min(dayStartMs(cur.filledBackTo), liveDayMs);
    const lowerBound = dispatchStart ?? Math.max(targetMs, cfg.earliestMs);
    const startMs = Math.max(lowerBound, endMs - cur.windowDays * DAY);
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
  const touchedDays = new Set<string>();
  const transient = new Map<string, EventNode>();
  for (let ms = dayStartMs(eventDayKey(minStart)); ms <= maxEnd; ms += DAY) {
    const day = eventDayKey(ms);
    if (day >= liveDay) continue; // never touch live-owned days
    for (const node of readDayPartitionNodes(root, day)) transient.set(node.feedId, node);
  }
  const resolver = new Resolver(transient, priorityMap(all), configMap(all), nowMs, { hotFloorMs: 0 });

  // 4) Ingest (deterministic order). Overflowed windows are dropped + retried narrower.
  const raws: RawObs[] = [];
  let overflowCount = 0;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i]!;
    const res = results[i]!;
    j.cur.lastRun = ingestTime;
    if (res.overflow) {
      j.cur.windowDays = Math.max(1, Math.floor(j.cur.windowDays / 2));
      overflowCount++;
      continue; // do not advance filledBackTo; retry a narrower window next run
    }
    if (!res.status.ok) {
      j.cur.failures++;
      continue;
    }
    j.cur.failures = 0;
    j.cur.lastCount = res.obs.length;
    for (const o of res.obs) {
      const day = eventDayKey(o.eventTimeMs);
      if (day < liveDay && !archivedDays.has(day)) raws.push(o);
    }
    // Advance + adapt the window (grow when sparse).
    j.cur.filledBackTo = eventDayKey(j.startMs);
    if (res.obs.length < 0.3 * 5000) j.cur.windowDays = Math.min(j.cfg.maxWindowDays, Math.ceil(j.cur.windowDays * 1.5));
    if (dayStartMs(j.cur.filledBackTo) <= Math.max(targetMs, j.cfg.earliestMs)) j.cur.done = true;
  }

  raws.sort(
    (a, b) =>
      a.eventTimeMs - b.eventTimeMs ||
      (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
      (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0),
  );

  const head = JSON.parse(readFileSync(dataPaths(root).head, 'utf8')) as Head;
  let seq = head.seq;
  const newObs: Observation[] = [];
  for (const raw of raws) {
    const r = resolver.ingest(raw, ingestTime);
    if (r.changed) {
      seq += 1;
      r.node.lastSeq = seq;
      if (r.node.firstSeenSeq < 0) r.node.firstSeenSeq = seq;
      newObs.push(makeObservation(raw, r, seq, ingestTime));
    }
  }

  // 5) Write back partitions for every touched day + update inventory.
  const byDay = new Map<string, EventNode[]>();
  for (const node of transient.values()) {
    const day = eventDayKey(node.eventTimeMs);
    if (day >= liveDay) continue;
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(node);
    touchedDays.add(day);
  }
  const inv: Inventory = loadInventory(root);
  let rewritten = 0;
  for (const [day, nodes] of byDay) {
    const { written, stat } = writeDayPartition(root, day, nodes, { nowMs, headIngestTime: ingestTime });
    if (written) rewritten++;
    inv[day] = stat;
  }
  saveInventory(root, inv);
  if (newObs.length) appendObservations(root, newObs);
  head.seq = seq;
  head.ingest_time = ingestTime;
  writeFileSync(dataPaths(root).head, JSON.stringify(head, null, 2) + '\n');
  writeFileSync(dataPaths(root).backfillCursor, JSON.stringify(cursor, null, 2) + '\n');

  const remaining = Object.values(cursor.providers).filter((c) => !c.done).length;
  console.log(
    `backfill: jobs=${jobs.length} fetched=${raws.length} new=${newObs.length} days_written=${rewritten} ` +
      `overflow=${overflowCount} providers_remaining=${remaining} head_seq=${seq}`,
  );
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
