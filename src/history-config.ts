import { readFileSync } from 'node:fs';
import { REPO } from './config.js';
import type { ProviderConfig } from './types.js';

/**
 * Deep history (PF-5j): the feed's history before the 3-year layer that `backfill` walked (the day partitions and
 * the monthly `archive-YYYY-MM` Releases, from `knowledge/index/backfill.json` `targetStart` on). It never commits a
 * day partition to the `data` branch and never touches an existing archive or a frozen day: every byte of it is an
 * immutable GitHub Release asset, and the `data` branch only gains the small index `knowledge/index/history.json`.
 *
 * Two layers, both immutable once uploaded (an asset is never overwritten or deleted; a broken upload is replaced by
 * the next free name):
 * - raw: `raw-<source>-<YYYY-MM>.ndjson.zst` in the Release `history-<YYYY>`: one source's answer for one month,
 *   normalised by the source's parser (RawObs), after a header line that records the queries, the row counts and,
 *   where the source has a count service (ComCat), the source's own count;
 * - events: `events-<YYYY-MM>.e<N>.tar.zst` in the same Release, the month's day files (`DD.ndjson`, the feature
 *   format of the day partitions and of `archive-YYYY-MM`) plus `_edition.json`, built offline from every raw asset of
 *   the month by the backfill's own Resolver (src/history-build.ts). Edition N+1 is built when a source joins an era;
 *   older editions stay.
 *
 * The walk runs only while `enabled` is true in providers/history.json (the flag), at most `maxUnitsPerRun` source
 * months and `maxSecondsPerRun` per run, one request at a time with `requestSpacingMs` between them.
 */

export const HISTORY_CONFIG_PATH = process.env.HISTORY_CONFIG ?? 'providers/history.json';
export const HISTORY_TAG_PREFIX = 'history-';
const DAY = 86_400_000;

export interface HistoryEra {
  id: string;
  /** First UTC day of the era (inclusive), YYYY-MM-DD. */
  from: string;
  /** First UTC day after the era (exclusive), YYYY-MM-DD. */
  to: string;
  /** An event is kept when the largest magnitude any of its sources gives reaches this; null keeps every event. Rows
   *  are fetched from this minus FETCH_MARGIN_MAG, so every agency's row of a qualifying event is there. */
  minMagnitude: number | null;
  /** Provider ids (providers/registry.json) walked in this era, in order. */
  sources: string[];
}

export interface HistoryConfig {
  enabled: boolean;
  /** The first day the 3-year layer holds; must equal knowledge/index/backfill.json `targetStart`. History fills
   *  strictly before it. */
  boundary: string;
  eras: HistoryEra[];
  maxUnitsPerRun: number;
  maxSecondsPerRun: number;
  /** Minimum pause between the end of one request and the start of the next (every request goes to one host at a
   *  time, so this is the per-host rate). */
  requestSpacingMs: number;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Rows per request by provider id (the source's own maximum); FETCH_LIMIT_DEFAULT otherwise. */
  pageLimits: Record<string, number>;
}

/** Rows per request for a source with no `pageLimits` entry (the live path's FETCH_LIMIT). */
export const FETCH_LIMIT_DEFAULT = 5000;
/** The fetch floor sits this far under an era's magnitude floor (see HistoryEra.minMagnitude). */
export const FETCH_MARGIN_MAG = 0.5;

export interface Period {
  /** YYYY-MM */
  key: string;
  eraId: string;
  startMs: number;
  /** Exclusive. */
  endMs: number;
}

export const dayKeyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dayKeyOf(dayMs(s)) === s;

export function loadHistoryConfig(path = HISTORY_CONFIG_PATH): HistoryConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as HistoryConfig;
}

/** Every reason the config cannot run; empty when it can. `registry` is the full provider list. */
export function configProblems(cfg: HistoryConfig, registry: ProviderConfig[]): string[] {
  const out: string[] = [];
  if (!isDay(cfg.boundary)) out.push(`boundary ${String(cfg.boundary)} is not a YYYY-MM-DD day`);
  for (const k of ['maxUnitsPerRun', 'maxSecondsPerRun', 'requestSpacingMs', 'timeoutMs'] as const) {
    if (!(typeof cfg[k] === 'number' && cfg[k] > 0)) out.push(`${k} must be a positive number`);
  }
  if (typeof cfg.requestSpacingMs === 'number' && cfg.requestSpacingMs < 1000) out.push('requestSpacingMs must be at least 1000 (one request per second per host)');
  const byId = new Map(registry.map((p) => [p.id, p]));
  const ids = new Set<string>();
  const spans: [number, number, string][] = [];
  for (const era of cfg.eras ?? []) {
    if (!era.id || ids.has(era.id)) out.push(`era id ${String(era.id)} is missing or repeated`);
    ids.add(era.id);
    if (!isDay(era.from) || !isDay(era.to)) {
      out.push(`era ${era.id}: from/to must be YYYY-MM-DD days`);
      continue;
    }
    if (dayMs(era.from) >= dayMs(era.to)) out.push(`era ${era.id}: from ${era.from} is not before to ${era.to}`);
    if (isDay(cfg.boundary) && dayMs(era.to) > dayMs(cfg.boundary)) out.push(`era ${era.id}: to ${era.to} is after the boundary ${cfg.boundary}`);
    if (era.minMagnitude != null && typeof era.minMagnitude !== 'number') out.push(`era ${era.id}: minMagnitude must be a number or null`);
    if (!Array.isArray(era.sources) || !era.sources.length) out.push(`era ${era.id}: no sources`);
    for (const s of era.sources ?? []) {
      const p = byId.get(s);
      if (!p) out.push(`era ${era.id}: unknown source ${s}`);
      // Step 1 walks FDSN event services only: the custom adapters' history queries are not built yet.
      else if (p.adapter !== 'fdsn' || !p.supportsTimeRange) out.push(`era ${era.id}: source ${s} is not an FDSN time-range service`);
    }
    if (new Set(era.sources ?? []).size !== (era.sources ?? []).length) out.push(`era ${era.id}: a source is listed twice`);
    spans.push([dayMs(era.from), dayMs(era.to), era.id]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]![0] < spans[i - 1]![1]) out.push(`eras ${spans[i - 1]![2]} and ${spans[i]![2]} overlap`);
  }
  return out;
}

/** The era's months, newest first, each clipped to the era (the newest month of the first era ends at the boundary,
 *  e.g. 2023-07 holds 07-01..07-05 when the boundary is 2023-07-06). */
export function eraPeriods(era: HistoryEra): Period[] {
  const from = dayMs(era.from);
  const to = dayMs(era.to);
  const out: Period[] = [];
  let y = new Date(to - 1).getUTCFullYear();
  let m = new Date(to - 1).getUTCMonth();
  for (;;) {
    const monthStart = Date.UTC(y, m, 1);
    const monthEnd = Date.UTC(y, m + 1, 1);
    if (monthEnd <= from) break;
    out.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, eraId: era.id, startMs: Math.max(from, monthStart), endMs: Math.min(to, monthEnd) });
    if (--m < 0) {
      m = 11;
      y--;
    }
  }
  return out;
}

/** Every period of every era, newest first. */
export function allPeriods(cfg: HistoryConfig): Period[] {
  return cfg.eras.flatMap(eraPeriods).sort((a, b) => b.startMs - a.startMs);
}

/** The UTC days a period covers. */
export function periodDays(p: Period): string[] {
  const out: string[] = [];
  for (let ms = p.startMs; ms < p.endMs; ms += DAY) out.push(dayKeyOf(ms));
  return out;
}

export const historyTag = (period: string): string => `${HISTORY_TAG_PREFIX}${period.slice(0, 4)}`;
export const rawAssetName = (source: string, period: string, generation = 1): string =>
  `raw-${source}-${period}${generation > 1 ? `.g${generation}` : ''}.ndjson.zst`;
export const editionAssetName = (period: string, edition: number): string => `events-${period}.e${edition}.tar.zst`;
export const releaseAssetUrl = (tag: string, asset: string): string => `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

/** The first free generation / edition number given the asset names a Release already holds (a name is never
 *  reused: an asset is never overwritten, and a broken one stays where it is). */
export function nextRawGeneration(existing: ReadonlySet<string>, source: string, period: string): number {
  let g = 1;
  while (existing.has(rawAssetName(source, period, g))) g++;
  return g;
}
export function nextEdition(existing: ReadonlySet<string>, period: string, atLeast = 1): number {
  let e = Math.max(1, atLeast);
  while (existing.has(editionAssetName(period, e))) e++;
  return e;
}
