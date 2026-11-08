import { eventDayKey, nodeToFeature } from './bitemporal.js';
import { afadCorrections } from './correction.js';
import { Resolver } from './dedup.js';
import { dayPartitionText, type PartitionFormat } from './partitions.js';
import { configMap, priorityMap } from './providers.js';
import { byIngestOrder, emptyTally, screen } from './quality.js';
import type { EventNode, ProviderConfig, RawObs } from './types.js';

/**
 * FEED-DQ-1 / DQ-3: the saturated backfill days. When even a one-day backfill window filled a source's page cap, the
 * walk kept the capped rows (partial) and recorded the day in its cursor (`saturatedDays`, knowledge/index/
 * backfill.json) "for later sub-day remediation", which never came: on 2026-10-04 KAGSR 2025-07-30 (the day after the
 * M8.8 Kamchatka mainshock), 23 AFAD days of the Sındırgı sequences (2025-08-11…25, 2025-10-28…11-12) and 3 IMO days.
 *
 * Every one of them lies in a month already rolled to an `archive-YYYY-MM` Release, i.e. frozen: the normal path
 * (backfill's Resolver writing the day partition, the month re-rolled) would rewrite a frozen day and replace a
 * published Release asset, which the feed never does. So the remediation is ADDITIVE, like the deep-history editions:
 * the source's whole day is asked again in sub-day windows (split until no window fills the cap), the rows go through
 * the same screen and Resolver as backfill (merge off) on top of the archived day and its neighbours, and the result
 * is published as an immutable day edition — the complete day after remediation, in the day-partition format — beside
 * a raw asset with exactly what the source answered, in the Release `remediation-YYYY`, indexed in
 * knowledge/index/remediation.json. The archived day, its Release asset and the manifest stay as they were; a consumer
 * that wants the repaired day reads the edition the index names (APIs.md, Remediation editions).
 *
 * The same mechanism repairs the 2026-06-28..07-03 seam (`reason: 'seam'`): days the live layer's start left empty for
 * the 15 sources the onboarding bootstrap seeded as complete. Explicit refills go through a persistent queue in the
 * index (`refill_queue`), taken day by day once each day is archived; one edition is built per day from all of its
 * sources' raw assets, and a neighbour is read as consumers read it (its current edition, else its archived day).
 */

/** Kamchatka first, then the Sındırgı sequence (AFAD), then the rest. */
export const REMEDIATION_ORDER: readonly string[] = ['kagsr', 'afad', 'imo'];
/** The first windows of a day; a window whose answer fills the cap is halved. */
export const FIRST_WINDOW_MS = 6 * 3_600_000;
/** The smallest window; one that still fills the cap leaves the day partial (recorded). */
export const MIN_WINDOW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/** Why a day is remediated: a source's backfill window filled its page cap (`saturated`, the default when absent), or
 *  the live layer's start left the day empty for some sources (`seam`, 2026-06-28..07-03; APIs.md, Remediation
 *  editions). */
export type RemediationReason = 'saturated' | 'seam';

export interface DayTask {
  provider: string;
  day: string;
  reason?: RemediationReason;
}

/** The days of `YYYY-MM-DD..YYYY-MM-DD` (both ends included; one day may be given alone), at most MAX_REFILL_DAYS. */
export const MAX_REFILL_DAYS = 31;
export function rangeDays(range: string): string[] {
  const m = /^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?$/.exec(range.trim());
  const valid = (d: string): boolean => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(Date.parse(`${d}T00:00:00Z`)).toISOString().slice(0, 10) === d;
  if (!m || !valid(m[1]!) || (m[2] != null && !valid(m[2]))) throw new Error(`bad refill range "${range}": expected YYYY-MM-DD..YYYY-MM-DD`);
  const from = m[1]!;
  const to = m[2] ?? from;
  if (to < from) throw new Error(`bad refill range "${range}": it ends before it starts`);
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  if (days.length > MAX_REFILL_DAYS) throw new Error(`bad refill range "${range}": ${days.length} days, at most ${MAX_REFILL_DAYS}`);
  return days;
}

/**
 * Explicit refill tasks (the 2026-07 seam): every provider × every day of `range`, `reason: 'seam'`, those already in
 * the index (`done`: `provider:day` of its raw assets) skipped, by day then provider.
 */
export function refillTasks(range: string, providers: readonly string[], done: ReadonlySet<string>, reason: RemediationReason = 'seam'): DayTask[] {
  const days = rangeDays(range);
  const out: DayTask[] = [];
  for (const day of days) for (const provider of [...new Set(providers)].sort()) if (!done.has(`${provider}:${day}`)) out.push({ provider, day, reason });
  return out;
}

/** Tasks grouped per day, days ascending (a run builds one edition per day from all of the day's sources). */
export function tasksByDay(tasks: readonly DayTask[]): Map<string, DayTask[]> {
  const by = new Map<string, DayTask[]>();
  for (const t of tasks) (by.get(t.day) ?? by.set(t.day, []).get(t.day)!).push(t);
  return new Map([...by].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The saturated days to remediate: every provider's `saturatedDays`, frozen days only (before `frozenBefore`), those
 * already in the index skipped, Kamchatka and Sındırgı first, then by day.
 */
export function remediationTasks(
  cursor: { providers: Record<string, { saturatedDays?: string[] }> },
  frozenBefore: string,
  done: ReadonlySet<string>,
  order: readonly string[] = REMEDIATION_ORDER,
): DayTask[] {
  const out = new Map<string, DayTask>();
  for (const [provider, c] of Object.entries(cursor.providers)) {
    for (const day of c.saturatedDays ?? []) {
      const key = `${provider}:${day}`;
      if (day < frozenBefore && !done.has(key)) out.set(key, { provider, day });
    }
  }
  const rank = (p: string): number => (order.includes(p) ? order.indexOf(p) : order.length);
  return [...out.values()].sort((a, b) => rank(a.provider) - rank(b.provider) || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export interface WindowLog {
  start: string;
  end: string;
  rows: number;
  /** The answer filled the cap and the window was halved (its rows were not kept). */
  split?: boolean;
  /** At the smallest window and still full: its rows are kept, the day is partial. */
  saturated?: boolean;
}

export interface DayFetch {
  ok: boolean;
  rows: RawObs[];
  windows: WindowLog[];
  requests: number;
  /** A window at MIN_WINDOW_MS still filled the cap: the day is better, not complete. */
  partial: boolean;
  error?: string;
}

/** One window's answer (providers.ts fetchProviderWindow's shape). */
export type WindowFetcher = (startMs: number, endMs: number) => Promise<{ obs: RawObs[]; status: { ok: boolean; error?: string; http_status?: number }; overflow: boolean }>;

/**
 * Ask the source for one UTC day in windows of FIRST_WINDOW_MS, halving every window whose answer fills the cap
 * (`overflow`) down to MIN_WINDOW_MS, one request at a time and at least `spacingMs` apart (the feed's 1 request/s per
 * host). Rows are kept from windows that did not overflow (and from saturated smallest windows), deduplicated by id,
 * and only those with an origin on the day. Any failed window fails the day: nothing half-kept.
 */
export async function fetchDayInWindows(
  day: string,
  fetchWindow: WindowFetcher,
  opts: { spacingMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number; firstWindowMs?: number; minWindowMs?: number },
): Promise<DayFetch> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const first = opts.firstWindowMs ?? FIRST_WINDOW_MS;
  const min = opts.minWindowMs ?? MIN_WINDOW_MS;
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const todo: [number, number][] = [];
  for (let s = dayStart; s < dayStart + DAY_MS; s += first) todo.push([s, Math.min(s + first, dayStart + DAY_MS)]);
  const byId = new Map<string, RawObs>();
  const windows: WindowLog[] = [];
  let requests = 0;
  let partial = false;
  let lastAt = -Infinity;
  while (todo.length) {
    const [s, e] = todo.shift()!;
    const wait = lastAt + opts.spacingMs - now();
    if (wait > 0) await sleep(wait);
    const res = await fetchWindow(s, e);
    lastAt = now();
    requests++;
    const log: WindowLog = { start: new Date(s).toISOString(), end: new Date(e).toISOString(), rows: res.obs.length };
    if (!res.status.ok) {
      windows.push(log);
      return { ok: false, rows: [], windows, requests, partial, error: `${log.start}..${log.end}: ${res.status.error ?? `HTTP ${res.status.http_status ?? '?'}`}` };
    }
    if (res.overflow && e - s > min) {
      const mid = s + Math.max(min, Math.floor((e - s) / 2 / 60_000) * 60_000);
      todo.unshift([s, mid], [mid, e]);
      windows.push({ ...log, split: true });
      continue;
    }
    if (res.overflow) {
      partial = true;
      log.saturated = true;
    }
    windows.push(log);
    for (const o of res.obs) if (eventDayKey(o.eventTimeMs) === day) byId.set(`${o.provider}:${o.providerEventId}`, o);
  }
  const rows = [...byId.values()].sort(byIngestOrder);
  return { ok: true, rows, windows, requests, partial };
}

export interface EditionStats {
  /** Events the archived day held (all states, like a day partition). */
  archived_events: number;
  /** Events of the day after remediation (all states). */
  events: number;
  /** Live events before and after. */
  live_before: number;
  live_after: number;
  /** Rows fetched for the day (all remediated providers of the day). */
  rows: number;
  /** Fetched rows that changed something (a new event, a new row of an event, a revised row). */
  changed: number;
  /** Fetched rows the corrected day already held unchanged. */
  unchanged: number;
  /** Rows the ingest screen kept out (out of range or coordinate-less). */
  screened: number;
  /** Events on the day after that were on no context day before (new events). */
  new_events: number;
  /** Events of the archived day that are no longer live (folded into another, or emptied). */
  retired: number;
  /** Events of the archived day whose time is now on another day (AFAD rows 3 h early, re-read across midnight): kept
   *  in this edition, the day their archive gave them, so no event leaves the published days or appears in two. */
  off_day: number;
  /** Fetched rows that joined an event of a neighbouring archived day: that day is not re-published, so this edition
   *  does not carry them (the event itself stays published by its own archive). */
  neighbour_joins: number;
  /** AFAD rows of the context re-read at their real time first (PF-5e, as the correction did for unfrozen days). */
  afad_retimed: number;
  afad_moved_out: number;
  /** Folds of the corrected events into the events they belong to. */
  merged: number;
  /** Per provider: its rows on the day before and after. */
  provider_rows: Record<string, { before: number; after: number }>;
}

/**
 * The complete day after remediation, built on the archived day and its neighbours (context, so an event near
 * midnight is matched):
 *  1. the rows the archived DAY holds 3 h early (AFAD before 2026-10-01, PF-5e) are re-read at their real time and their
 *     events folded, exactly as the one-time correction did for the unfrozen days (Resolver.correctReport +
 *     foldAround), among the day's own events only — otherwise a re-asked AFAD day would hold both time bases;
 *  2. the fetched rows go through the ingest screen and backfill's Resolver (merge off: history never folds on ingest),
 *     against the day and its neighbours;
 *  3. the edition is the archived day's events (by feed id, whatever their time is now) plus the events this build
 *     minted, serialized exactly as a day partition (writeDayPartition: event time, feed id; nodeToFeature).
 *
 * The edition replaces ONE archived day while its neighbours stay as archived, so membership follows the archive, not
 * the corrected time: an event re-read across midnight stays in this edition (counted `off_day`), an event of a
 * neighbouring day never enters it, and no fold crosses into a neighbour. Otherwise an AFAD row stored at 22:00 for
 * 01:00 the next day would leave this edition and be in no published day, and the next day's rows stored before
 * midnight would be published twice (review of FEED-DQ-1, 2026-10-04: 12 events of 2025-07-30 left the day).
 */
export function buildDayEdition(input: {
  day: string;
  context: Map<string, EventNode[]>;
  rows: RawObs[];
  registry: ProviderConfig[];
  nowMs: number;
  ingestTime: string;
  seqMarker: number;
  /** The line format (dayPartitionText): EDITION_FORMAT for every edition built since 2026-11-08 (decision A4 of the
   *  2026-11-08 plan); the editions of 2026-10-04 were built without `review_status` (NO_PARTITION_FORMAT) and keep
   *  their bytes. */
  fmt: PartitionFormat;
}): { text: string; nodes: EventNode[]; stats: EditionStats } {
  const map = new Map<string, EventNode>();
  for (const nodes of input.context.values()) for (const n of nodes) map.set(n.feedId, n);
  const onDay = (n: EventNode): boolean => eventDayKey(n.eventTimeMs) === input.day;
  const providerRows = (nodes: EventNode[]): Record<string, number> => {
    const c: Record<string, number> = {};
    for (const n of nodes) if (n.state === 'live') for (const r of n.provenance) c[r.provider] = (c[r.provider] ?? 0) + 1;
    return c;
  };
  const archived = input.context.get(input.day) ?? [];
  const archivedIds = new Set(archived.map((n) => n.feedId));
  const archivedReports = new Set(archived.flatMap((n) => n.provenance.map(reportKey)));
  const liveBefore = new Set(archived.filter((n) => n.state === 'live').map((n) => n.feedId));
  const contextIds = new Set(map.keys());
  const before = providerRows(archived);
  const priority = priorityMap(input.registry);
  const cfg = configMap(input.registry);

  // 1) The AFAD rows stored 3 h early, re-read and folded (the correction's step), on the archived day's events only:
  //    a neighbour's rows are published by its own archive, and a fold with a neighbour's event would leave one of the
  //    two copies there.
  const dayMap = new Map(archived.map((n) => [n.feedId, n]));
  const fixer = new Resolver(dayMap, priority, cfg, input.nowMs, { hotFloorMs: 0 });
  let afadRetimed = 0;
  let afadMovedOut = 0;
  const touched: string[] = [];
  for (const raw of afadCorrections(dayMap, 0)) {
    const entries = fixer.correctReport(raw, input.ingestTime);
    for (const e of entries) {
      touched.push(e.result.node.feedId);
      e.result.node.lastSeq = input.seqMarker;
    }
    if (!entries.length) continue;
    if (entries.some((e) => e.op === 'tombstone')) afadMovedOut++;
    else afadRetimed++;
  }
  const folds = fixer.foldAround(touched, input.ingestTime);
  for (const n of folds.survivors) n.lastSeq = input.seqMarker;
  for (const m of folds.merges) m.loser.lastSeq = input.seqMarker;
  // An AFAD row that left an event of other providers is in an event the correction minted: it joins the context.
  for (const [id, n] of dayMap) map.set(id, n);
  // In the edition: the archived day's events, and the events this build minted (from the day's fetched rows, or from
  // the day's own AFAD rows re-read above).
  const inEdition = (n: EventNode): boolean => archivedIds.has(n.feedId) || !contextIds.has(n.feedId);

  // 2) The fetched rows, through the ingest screen and backfill's Resolver.
  const resolver = new Resolver(map, priority, cfg, input.nowMs, { hotFloorMs: 0, merge: false });
  const tally = emptyTally();
  const zeroed: RawObs[] = [];
  const kept = screen(input.rows, tally, undefined, zeroed).sort(byIngestOrder);
  let changed = 0;
  let unchanged = 0;
  let neighbourJoins = 0;
  for (const raw of kept) {
    const r = resolver.ingest(raw, input.ingestTime);
    if (!r.changed) {
      unchanged++;
      continue;
    }
    changed++;
    if (!inEdition(r.node)) neighbourJoins++;
    r.node.lastSeq = input.seqMarker;
    if (r.node.firstSeenSeq < 0) r.node.firstSeenSeq = input.seqMarker;
  }
  for (const raw of zeroed) {
    const r = resolver.withdrawZeroed(raw, input.ingestTime);
    if (r?.changed) r.node.lastSeq = input.seqMarker;
  }

  // 3) The day.
  const nodes = [...map.values()].filter(inEdition).sort((a, b) => a.eventTimeMs - b.eventTimeMs || (a.feedId < b.feedId ? -1 : 1));
  const after = providerRows(nodes);
  const provider_rows: Record<string, { before: number; after: number }> = {};
  for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (input.rows.some((r) => r.provider === p) || (before[p] ?? 0) !== (after[p] ?? 0)) provider_rows[p] = { before: before[p] ?? 0, after: after[p] ?? 0 };
  }
  const stats: EditionStats = {
    archived_events: archived.length,
    events: nodes.length,
    live_before: liveBefore.size,
    live_after: nodes.filter((n) => n.state === 'live').length,
    rows: input.rows.length,
    changed,
    unchanged,
    screened: tally.bad_coords + tally.coordinateless,
    new_events: nodes.filter((n) => !contextIds.has(n.feedId)).length,
    retired: [...liveBefore].filter((id) => map.get(id)?.state !== 'live').length,
    off_day: archived.filter((n) => !onDay(n)).length,
    neighbour_joins: neighbourJoins,
    afad_retimed: afadRetimed,
    afad_moved_out: afadMovedOut,
    merged: folds.merges.length,
    provider_rows,
  };
  return { text: dayPartitionText(nodes, input.day, input.fmt), nodes, stats };
}

const reportKey = (r: { provider: string; nativeId: string }): string => `${r.provider}:${r.nativeId}`;

/** The line format of the remediation editions built since 2026-11-08: `review_status` on every day (decision A4 of
 *  the 2026-11-08 plan: they are new assets, so no frozen bytes change), wherever the event's rows give one. */
export const EDITION_FORMAT: PartitionFormat = { version: 1, review_status_from: '0000-01-01' };

/**
 * What must hold for an edition before it is published: every event is on the day — or, given the ARCHIVED days it was
 * built on (`archive`, unchanged), was archived on the day or holds only reports the archived day held (an AFAD row
 * re-read across midnight); no report is in two live events; and no report the archived day did not hold live is live
 * in a neighbouring archived day (replacing the day by the edition must never publish one report twice).
 */
export function editionProblems(day: string, nodes: EventNode[], archive?: ReadonlyMap<string, readonly EventNode[]>): string[] {
  const problems: string[] = [];
  const archivedDay = archive?.get(day) ?? [];
  const archivedIds = new Set(archivedDay.map((n) => n.feedId));
  const archivedReports = new Set(archivedDay.flatMap((n) => n.provenance.map(reportKey)));
  const archivedLive = new Set(archivedDay.filter((n) => n.state === 'live').flatMap((n) => n.provenance.map(reportKey)));
  const neighbourLive = new Map<string, string>();
  for (const [d, ns] of archive ?? []) {
    if (d === day) continue;
    for (const n of ns) if (n.state === 'live') for (const r of n.provenance) neighbourLive.set(reportKey(r), `${n.feedId} (${d})`);
  }
  const seen = new Map<string, string>();
  for (const n of nodes) {
    const nDay = eventDayKey(n.eventTimeMs);
    const belongs = nDay === day || (archive != null && (archivedIds.has(n.feedId) || n.provenance.every((r) => archivedReports.has(reportKey(r)))));
    if (!belongs) problems.push(`${n.feedId} is on ${nDay}, not ${day}`);
    if (n.state !== 'live') continue;
    for (const r of n.provenance) {
      const key = reportKey(r);
      const other = seen.get(key);
      if (other && other !== n.feedId) problems.push(`${key} is in two live events (${other}, ${n.feedId})`);
      seen.set(key, n.feedId);
      const there = archivedLive.has(key) ? undefined : neighbourLive.get(key);
      if (there) problems.push(`${key} would be live twice: in ${n.feedId} here and in ${there}`);
    }
  }
  return problems;
}

/** The raw asset: a header line, then exactly the rows the source answered for the day (RawObs), one per line. */
export const RAW_REMEDIATION_KIND = 'earthquakes-feed/remediation-raw';
export interface RemediationRawHeader {
  kind: typeof RAW_REMEDIATION_KIND;
  version: 1;
  provider: string;
  day: string;
  fetched_at: string;
  rows: number;
  requests: number;
  partial: boolean;
  windows: WindowLog[];
}
export function rawText(h: RemediationRawHeader, rows: RawObs[]): string {
  return [JSON.stringify(h), ...rows.map((r) => JSON.stringify(r))].join('\n') + '\n';
}
export function parseRawText(text: string): { header: RemediationRawHeader; rows: RawObs[] } {
  const lines = text.split('\n').filter((l) => l.trim());
  const header = JSON.parse(lines[0] ?? '{}') as RemediationRawHeader;
  if (header.kind !== RAW_REMEDIATION_KIND) throw new Error('not a remediation raw asset');
  const rows = lines.slice(1).map((l) => JSON.parse(l) as RawObs);
  if (rows.length !== header.rows) throw new Error(`raw asset holds ${rows.length} rows, its header says ${header.rows}`);
  return { header, rows };
}

export const remediationTag = (day: string): string => `remediation-${day.slice(0, 4)}`;
export const rawAssetName = (provider: string, day: string, generation = 1): string => `raw-${provider}-${day}${generation > 1 ? `.g${generation}` : ''}.ndjson.gz`;
export const editionAssetName = (day: string, edition: number): string => `events-${day}.e${edition}.ndjson.gz`;

/** The first name of the form `make(n)` not in `names`, n from 1. Assets are never overwritten. */
export function nextFree(names: ReadonlySet<string>, make: (n: number) => string, from = 1): number {
  let n = from;
  while (names.has(make(n))) n++;
  return n;
}

export interface RawRef {
  provider: string;
  day: string;
  tag: string;
  asset: string;
  url: string;
  sha256: string;
  bytes: number;
  rows: number;
  requests: number;
  partial: boolean;
  fetched_at: string;
  /** Absent: `saturated` (the index of 2026-10-04). */
  reason?: RemediationReason;
}
/** A published asset a build read: an archive month or a remediation edition, and its sha256. */
export interface AssetRef {
  tag: string;
  asset: string;
  sha256: string | null;
}
export interface EditionRef {
  day: string;
  edition: number;
  tag: string;
  asset: string;
  url: string;
  sha256: string;
  bytes: number;
  /** The archived day it is built on: its archive asset and that asset's sha256. */
  built_on: AssetRef;
  /** The raw assets it is built from. */
  built_from: string[];
  /** Absent: `saturated` (the index of 2026-10-04). */
  reason?: RemediationReason;
  /** What the day and its neighbours were read from, by day: the archive asset, or a neighbour's current edition
   *  (absent on the editions of 2026-10-04, which read archives only). */
  context?: Record<string, AssetRef>;
  stats: EditionStats;
  built_at: string;
}
/**
 * A queued refill: its days are remediated as soon as each is archived (a remediation edition supplements an archived
 * day only), by the scheduled run or any dispatch, and dropped from the range once done (every provider has a raw
 * asset of the day and the day's current edition is built from all of the day's raws).
 */
export interface RefillEntry {
  range: string;
  providers: string[];
  reason: RemediationReason;
  queued_at: string;
}
export interface RemediationIndex {
  version: 1;
  raw: RawRef[];
  editions: EditionRef[];
  refill_queue?: RefillEntry[];
}
export const emptyRemediationIndex = (): RemediationIndex => ({ version: 1, raw: [], editions: [], refill_queue: [] });
/** The current edition of a day: the highest. */
export const currentEdition = (idx: RemediationIndex, day: string): EditionRef | undefined =>
  idx.editions.filter((e) => e.day === day).sort((a, b) => b.edition - a.edition)[0];
export function indexText(idx: RemediationIndex): string {
  const raw = [...idx.raw].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.provider < b.provider ? -1 : 1));
  const editions = [...idx.editions].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.edition - b.edition));
  return JSON.stringify({ version: 1, raw, editions, refill_queue: idx.refill_queue ?? [] }, null, 2) + '\n';
}

/** Add a refill to the queue. Nothing is added when every day of the range is already done for these providers or
 *  queued for them with the same reason (a dispatch repeated after the queue shrank the range adds no second entry). */
export function enqueueRefill(idx: RemediationIndex, range: string, providers: readonly string[], reason: RemediationReason, nowIso: string): boolean {
  const days = rangeDays(range);
  const q = (idx.refill_queue ??= []);
  const ps = [...new Set(providers)].sort();
  const covers = (e: RefillEntry, day: string): boolean => e.reason === reason && ps.every((p) => e.providers.includes(p)) && rangeDays(e.range).includes(day);
  if (days.every((d) => queuedDayDone(idx, d, ps) || q.some((e) => covers(e, d)))) return false;
  q.push({ range, providers: ps, reason, queued_at: nowIso });
  return true;
}

/** The raw assets of a day the index lists, the newest per provider. */
export function dayRaws(idx: RemediationIndex, day: string): RawRef[] {
  const by = new Map<string, RawRef>();
  for (const r of idx.raw) if (r.day === day) {
    const had = by.get(r.provider);
    if (!had || r.fetched_at > had.fetched_at || (r.fetched_at === had.fetched_at && r.asset > had.asset)) by.set(r.provider, r);
  }
  return [...by.values()].sort((a, b) => (a.provider < b.provider ? -1 : 1));
}

/** The raws of the day its current edition is not built from (a run uploaded them but built no edition: another source
 *  of the day failed, or the run died between the uploads). */
export function unbuiltRaws(idx: RemediationIndex, day: string): RawRef[] {
  const cur = currentEdition(idx, day);
  const built = new Set(cur?.built_from ?? []);
  return dayRaws(idx, day).filter((r) => !built.has(r.asset));
}

/** A queued day is done when every provider of the entry has a raw asset of it and its current edition is built from
 *  all of the day's raws. */
const queuedDayDone = (idx: RemediationIndex, day: string, providers: readonly string[]): boolean => {
  const have = new Set(dayRaws(idx, day).map((r) => r.provider));
  return providers.every((p) => have.has(p)) && currentEdition(idx, day) != null && unbuiltRaws(idx, day).length === 0;
};

/**
 * What the queue asks of this run: fetch tasks for its ARCHIVED days (providers without a raw of the day), the archived
 * days whose raws are all there but not yet in an edition, and the days still waiting for their month's archive.
 */
export function queuePlan(idx: RemediationIndex, archivedDays: ReadonlySet<string>): { tasks: DayTask[]; editionOnly: string[]; waiting: string[] } {
  const done = new Set(idx.raw.map((r) => `${r.provider}:${r.day}`));
  const tasks = new Map<string, DayTask>();
  const editionOnly = new Set<string>();
  const waiting = new Set<string>();
  for (const e of idx.refill_queue ?? []) {
    for (const t of refillTasks(e.range, e.providers, new Set(), e.reason)) {
      if (!archivedDays.has(t.day)) waiting.add(t.day);
      else if (!done.has(`${t.provider}:${t.day}`)) tasks.set(`${t.provider}:${t.day}`, t);
    }
    for (const day of rangeDays(e.range)) {
      if (archivedDays.has(day) && !queuedDayDone(idx, day, e.providers) && e.providers.every((p) => done.has(`${p}:${day}`))) editionOnly.add(day);
    }
  }
  const sort = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    tasks: [...tasks.values()].sort((a, b) => sort(a.day, b.day) || sort(a.provider, b.provider)),
    editionOnly: [...editionOnly].sort(sort),
    waiting: [...waiting].sort(sort),
  };
}

/** Drop the done days from the queue: each entry's range shrinks from both ends past its done days, and an entry with
 *  every day done leaves the queue. Returns the entries that left. */
export function pruneQueue(idx: RemediationIndex): RefillEntry[] {
  const left: RefillEntry[] = [];
  const keep: RefillEntry[] = [];
  for (const e of idx.refill_queue ?? []) {
    const days = rangeDays(e.range);
    let a = 0;
    let b = days.length - 1;
    while (a <= b && queuedDayDone(idx, days[a]!, e.providers)) a++;
    while (b >= a && queuedDayDone(idx, days[b]!, e.providers)) b--;
    if (a > b) {
      left.push(e);
      continue;
    }
    const range = `${days[a]}..${days[b]}`;
    // The same refill twice (a queue written before enqueueRefill looked at the shrunk ranges): one entry, the first.
    if (keep.some((k) => k.range === range && k.reason === e.reason && k.providers.join(',') === e.providers.join(','))) continue;
    keep.push({ ...e, range });
  }
  idx.refill_queue = keep;
  return left;
}
