import { eventDayKey, nodeToFeature } from './bitemporal.js';
import { afadCorrections } from './correction.js';
import { Resolver } from './dedup.js';
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
 * that wants the repaired day reads the edition the index names (APIs.md, Saturated days).
 */

/** Kamchatka first, then the Sındırgı sequence (AFAD), then the rest. */
export const REMEDIATION_ORDER: readonly string[] = ['kagsr', 'afad', 'imo'];
/** The first windows of a day; a window whose answer fills the cap is halved. */
export const FIRST_WINDOW_MS = 6 * 3_600_000;
/** The smallest window; one that still fills the cap leaves the day partial (recorded). */
export const MIN_WINDOW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export interface DayTask {
  provider: string;
  day: string;
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
  /** Events of the archived day whose time moved to another day (AFAD rows 3 h early, re-read). */
  left_day: number;
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
 *  1. the rows the archive holds 3 h early (AFAD before 2026-10-01, PF-5e) are re-read at their real time and their
 *     events folded, exactly as the one-time correction did for the unfrozen days (Resolver.correctReport +
 *     foldAround) — otherwise a re-asked AFAD day would hold both time bases;
 *  2. the fetched rows go through the ingest screen and backfill's Resolver (merge off: history never folds on ingest);
 *  3. the day's nodes are serialized exactly as a day partition (writeDayPartition: event time, feed id; nodeToFeature).
 */
export function buildDayEdition(input: {
  day: string;
  context: Map<string, EventNode[]>;
  rows: RawObs[];
  registry: ProviderConfig[];
  nowMs: number;
  ingestTime: string;
  seqMarker: number;
}): { text: string; nodes: EventNode[]; stats: EditionStats } {
  const map = new Map<string, EventNode>();
  for (const nodes of input.context.values()) for (const n of nodes) map.set(n.feedId, n);
  const onDay = (n: EventNode): boolean => eventDayKey(n.eventTimeMs) === input.day;
  const providerRows = (nodes: EventNode[]): Record<string, number> => {
    const c: Record<string, number> = {};
    for (const n of nodes) if (n.state === 'live') for (const r of n.provenance) c[r.provider] = (c[r.provider] ?? 0) + 1;
    return c;
  };
  const archived = [...map.values()].filter(onDay);
  const archivedIds = new Set(archived.map((n) => n.feedId));
  const liveBefore = new Set(archived.filter((n) => n.state === 'live').map((n) => n.feedId));
  const contextIds = new Set(map.keys());
  const before = providerRows(archived);
  const priority = priorityMap(input.registry);
  const cfg = configMap(input.registry);

  // 1) The AFAD rows stored 3 h early, re-read and folded (the correction's step, on this context only).
  const fixer = new Resolver(map, priority, cfg, input.nowMs, { hotFloorMs: 0 });
  let afadRetimed = 0;
  let afadMovedOut = 0;
  const touched: string[] = [];
  for (const raw of afadCorrections(map, 0)) {
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

  // 2) The fetched rows, through the ingest screen and backfill's Resolver.
  const resolver = new Resolver(map, priority, cfg, input.nowMs, { hotFloorMs: 0, merge: false });
  const tally = emptyTally();
  const zeroed: RawObs[] = [];
  const kept = screen(input.rows, tally, undefined, zeroed).sort(byIngestOrder);
  let changed = 0;
  let unchanged = 0;
  for (const raw of kept) {
    const r = resolver.ingest(raw, input.ingestTime);
    if (!r.changed) {
      unchanged++;
      continue;
    }
    changed++;
    r.node.lastSeq = input.seqMarker;
    if (r.node.firstSeenSeq < 0) r.node.firstSeenSeq = input.seqMarker;
  }
  for (const raw of zeroed) {
    const r = resolver.withdrawZeroed(raw, input.ingestTime);
    if (r?.changed) r.node.lastSeq = input.seqMarker;
  }

  // 3) The day.
  const nodes = [...map.values()].filter(onDay).sort((a, b) => a.eventTimeMs - b.eventTimeMs || (a.feedId < b.feedId ? -1 : 1));
  const after = providerRows(nodes);
  const nodeIds = new Set(nodes.map((n) => n.feedId));
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
    left_day: [...archivedIds].filter((id) => !nodeIds.has(id)).length,
    afad_retimed: afadRetimed,
    afad_moved_out: afadMovedOut,
    merged: folds.merges.length,
    provider_rows,
  };
  const feats = nodes.map((n) => JSON.stringify(nodeToFeature(n)));
  return { text: feats.join('\n') + (feats.length ? '\n' : ''), nodes, stats };
}

/** What must hold for an edition before it is published: every event on the day, no report in two live events. */
export function editionProblems(day: string, nodes: EventNode[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const n of nodes) {
    if (eventDayKey(n.eventTimeMs) !== day) problems.push(`${n.feedId} is on ${eventDayKey(n.eventTimeMs)}, not ${day}`);
    if (n.state !== 'live') continue;
    for (const r of n.provenance) {
      const key = `${r.provider}:${r.nativeId}`;
      const other = seen.get(key);
      if (other && other !== n.feedId) problems.push(`${key} is in two live events (${other}, ${n.feedId})`);
      seen.set(key, n.feedId);
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
  built_on: { tag: string; asset: string; sha256: string | null };
  /** The raw assets it is built from. */
  built_from: string[];
  stats: EditionStats;
  built_at: string;
}
export interface RemediationIndex {
  version: 1;
  raw: RawRef[];
  editions: EditionRef[];
}
export const emptyRemediationIndex = (): RemediationIndex => ({ version: 1, raw: [], editions: [] });
/** The current edition of a day: the highest. */
export const currentEdition = (idx: RemediationIndex, day: string): EditionRef | undefined =>
  idx.editions.filter((e) => e.day === day).sort((a, b) => b.edition - a.edition)[0];
export function indexText(idx: RemediationIndex): string {
  const raw = [...idx.raw].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.provider < b.provider ? -1 : 1));
  const editions = [...idx.editions].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.edition - b.edition));
  return JSON.stringify({ version: 1, raw, editions }, null, 2) + '\n';
}
