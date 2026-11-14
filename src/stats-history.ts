import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { ArchiveEntry, Archives } from './archive.js';
import { extractTarball } from './archive-io.js';
import { eventDayKey, featureToNode, nodeToFeature } from './bitemporal.js';
import { DATA_DIR, REMERGE_EPOCH, REMERGE_INGEST_TIME, REMERGE_RULES, REPO, dataPaths } from './config.js';
import { haversineKm } from './geo.js';
import { ghRetry } from './gh.js';
import { historyQueryUrl } from './history-fetch.js';
import { type EditionEntry, type HistoryIndex, currentEdition as currentHistoryEdition, editionIsMerged } from './history-index.js';
import { frozenBefore } from './partitions.js';
import { loadRegistry, priorityMap } from './providers.js';
import { type EditionRef, type RemediationIndex, LATE_USGS_MAX_AGE_DAYS, currentEdition as currentRemediationEdition, emptyRemediationIndex } from './remediation.js';
import { RemergeError, normalizeUnit, remergeNodes } from './remerge.js';
import { archiveIsMerged } from './remerge-archives.js';
import { STATS_STATE_PATH, type StatsConfig, loadStatsConfig } from './stats.js';
import {
  AREA_COLUMNS,
  CELL_DEG,
  MAG_EDGES_E2,
  RECONCILE_CANDIDATE_E2,
  RECONCILE_RULE,
  STATS_ATTRIBUTION,
  STATS_DIR,
  STATS_FORMAT,
  type StatsEvent,
  YEAR_COLUMNS,
  buildEventTable,
  cellOf,
  dayStartMs,
  magBin,
  type Reconciliation,
  reconcileRows,
  statsEventOf,
} from './stats-table.js';
import type { EventNode, ProviderConfig } from './types.js';
import { canonicalJson, fetchText } from './util.js';

/**
 * The stats builder (stats.yml; APIs.md, Statistics): the year files `v1/stats/year/<Y>.json` (the current year and the
 * two before it) and the area files `v1/stats/area/<Y>.json` (1973 .. the year of `through`), committed on `data` with
 * their ledger `knowledge/stats/state.json`, which derive reads to publish them.
 *
 * Every UTC day up to `through` (the last frozen day) has one input, the first that matches of: the day's current
 * remediation edition, its frozen partition on `data` (keyed by the blob), the archive month that lists it, the
 * current deep-history edition that lists it (chooseDayInput). A year is rebuilt only when the digest of its inputs
 * changes (or a file is missing, or a run names it), newest first, a few years per run.
 *
 * Inputs whose merge epoch is below STATS_REMERGE_EPOCH (archives and editions not yet re-merged, remediation editions
 * built before the re-merge, the frozen day partitions) still hold the split duplicates the backfill made (owner
 * decision A6): the builder runs the feed's own `remergeNodes` (src/remerge.ts) over each such month in memory, with the
 * 7 days before it as frozen and the 7 days after it as pinned context, read from those days' own inputs, and counts the
 * result. It records `remerged_in_memory` per year; when the merged assets land, their checksums change the digest and
 * the year is rebuilt from them.
 *
 * Each rebuilt year is checked against USGS ComCat's counts of M6+ and M4.5+ earthquakes (comcatGate) before its files
 * are written; a year that fails keeps its previous files (a first build stays absent), and the run writes the marker
 * stats-blocked.txt (walk-blocked-stats, read by the health workflow).
 *
 *   npx tsx src/stats-history.ts
 *
 * Environment:
 *   DATA_DIR          the data checkout (knowledge/index, knowledge/stats, v1/stats; the day partitions are read by
 *                     blob with `git cat-file`, so a blobless checkout is enough); read only
 *   STATS_OUT         output directory (default stats-out): v1/stats/** and knowledge/stats/** as they must be on
 *                     `data`, base.json, report.md
 *   STATS_YEARS       years to rebuild whatever their digest (comma-separated)
 *   STATS_MAX_YEARS   years per run (default providers/stats.json max_years_per_run)
 *   STATS_DRY_RUN=1   build and check as usual; the workflow commits nothing (runs although history_enabled is false)
 *   STATS_VERIFY      '' | sample | full: the per-month table against ComCat (job summary, report.md)
 *   STATS_NOW         ISO time to run at (tests and replays; default the clock)
 */

const DAY = 86_400_000;
const CONTEXT_DAYS = 7;
/** The epoch the stats count at: the in-memory re-merge runs over every input below it. At least 1 whatever config
 *  REMERGE_EPOCH says, so the statistics never count the backfill's split duplicates (epoch 0 = never re-merged). */
export const STATS_REMERGE_EPOCH = Math.max(REMERGE_EPOCH, 1);
/** The first year the area files cover (era B, ComCat M4.5+, public domain); nothing older is published. */
export const STATS_FIRST_YEAR = 1973;
/** dup_suspects: two M4.5+ rows of different chosen providers this close (diagnostics only). */
export const DUP_DT_MS = 60_000;
export const DUP_KM = 100;
/** ComCat: at most one request every 2 s (0.5 req/s). */
export const COMCAT_GAP_MS = 2_000;

export const dayShift = (day: string, n: number): string => eventDayKey(Date.parse(`${day}T00:00:00Z`) + n * DAY);
const sha256Hex = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

// --- inputs ---

export type InputKind = 'remediation' | 'partition' | 'archive' | 'edition';

/** The input a day is read from. `key` + `fp` name it in the digest; `merged` says whether it is re-merged to
 *  STATS_REMERGE_EPOCH (else the in-memory re-merge runs over its month). */
export interface DayInput {
  kind: InputKind;
  /** `tag/asset` of a Release asset; the day of a partition. */
  key: string;
  /** sha256 of the asset; the blob oid of a partition. */
  fp: string;
  tag?: string;
  asset?: string;
  /** era of a deep-history edition ('A', 'B', 'pilot'); null otherwise. */
  era: string | null;
  /** The input's magnitude floor (era B editions: 4.5); null for none. */
  minMag: number | null;
  merged: boolean;
}

/** The indexes the inputs come from, with lookups per day. */
export interface InputIndex {
  remediation: RemediationIndex;
  /** Frozen day partitions on `data`: day -> blob oid. */
  partitions: ReadonlyMap<string, string>;
  archives: readonly ArchiveEntry[];
  history: HistoryIndex | null;
}

/** Day lookups built once per run (chooseDayInput). */
export interface InputLookup {
  idx: InputIndex;
  epoch: number;
  remediationByDay: Map<string, EditionRef>;
  archiveByDay: Map<string, ArchiveEntry>;
  editionByDay: Map<string, EditionEntry>;
}

export function inputLookup(idx: InputIndex, epoch = STATS_REMERGE_EPOCH): InputLookup {
  const remediationByDay = new Map<string, EditionRef>();
  for (const day of new Set(idx.remediation.editions.map((e) => e.day))) {
    const e = currentRemediationEdition(idx.remediation, day);
    if (e) remediationByDay.set(day, e);
  }
  const archiveByDay = new Map<string, ArchiveEntry>();
  for (const a of idx.archives) for (const d of a.days ?? []) archiveByDay.set(d, a);
  const editionByDay = new Map<string, EditionEntry>();
  if (idx.history) {
    // An edition covers every day of its month before the history boundary: `days` lists only the days that have a
    // member, and a quiet day has none (era B: no M4.5+ quake on 1981-10-30). The 2023-07 editions end at the boundary.
    const boundary = idx.history.boundary;
    for (const period of new Set(idx.history.editions.map((e) => e.period))) {
      const e = currentHistoryEdition(idx.history, period);
      if (!e) continue;
      const [y, m] = period.split('-').map(Number);
      for (let t = Date.UTC(y!, m! - 1, 1); t < Date.UTC(y!, m!, 1); t += DAY) {
        const d = eventDayKey(t);
        if (d < boundary || e.days.includes(d)) editionByDay.set(d, e);
      }
    }
  }
  return { idx, epoch, remediationByDay, archiveByDay, editionByDay };
}

/**
 * The input of one day, first match wins (owner decision D1): the current remediation edition (it replaces an archived
 * day and supersedes its partition), the frozen partition on `data`, the archive month that lists the day, the current
 * deep-history edition that lists it. null: no input (a missing day).
 */
export function chooseDayInput(day: string, lk: InputLookup): DayInput | null {
  const r = lk.remediationByDay.get(day);
  if (r) {
    // Merged when it is merged to the epoch and built on the month's current asset, itself merged to the current rules
    // (a refreshed edition of the archive re-merge).
    const month = lk.archiveByDay.get(day);
    const merged = (r.stats.remerge?.epoch ?? 0) >= lk.epoch && (!month || (month.sha256 === r.built_on.sha256 && archiveIsMerged(month, lk.epoch)));
    return { kind: 'remediation', key: `${r.tag}/${r.asset}`, fp: r.sha256, tag: r.tag, asset: r.asset, era: null, minMag: null, merged };
  }
  const oid = lk.idx.partitions.get(day);
  // A partition has no merge epoch: the days frozen before the live heal (2026-07 .. 09) hold split duplicates, and
  // the re-merge of a healed day changes (almost) nothing.
  if (oid) return { kind: 'partition', key: day, fp: oid, era: null, minMag: null, merged: false };
  const a = lk.archiveByDay.get(day);
  if (a) return { kind: 'archive', key: `${a.tag}/${a.asset}`, fp: a.sha256, tag: a.tag, asset: a.asset, era: null, minMag: null, merged: archiveIsMerged(a, lk.epoch) };
  const e = lk.editionByDay.get(day);
  // An edition of one source (era B, ComCat alone) has nothing to fold: never re-merged (eraIsRemerged), so read as is.
  if (e) return { kind: 'edition', key: `${e.tag}/${e.asset}`, fp: e.sha256, tag: e.tag, asset: e.asset, era: e.era ?? null, minMag: e.min_magnitude ?? null, merged: editionIsMerged(e, lk.epoch) || (e.sources ?? []).length === 1 };
  return null;
}

/** The last frozen day at `nowMs`: the year and area files run through it. */
export const statsThrough = (nowMs: number): string => dayShift(frozenBefore(nowMs), -1);

export const yearDays = (year: number, through: string): string[] => {
  const out: string[] = [];
  const last = `${year}-12-31` < through ? `${year}-12-31` : through;
  for (let d = `${year}-01-01`; d <= last; d = dayShift(d, 1)) out.push(d);
  return out;
};

export interface YearPlan {
  year: number;
  days: string[];
  inputs: (DayInput | null)[];
  missing: string[];
  /** Months (YYYY-MM) with an input below the epoch: re-merged in memory. */
  unmergedMonths: string[];
  /** The inputs of the 7 days around the year, which the in-memory re-merge reads as context (empty when none is
   *  re-merged). */
  context: { day: string; input: DayInput | null }[];
  digest: string;
  /** Era B: every input carries the M4.5 floor. */
  minMag: number | null;
  /** Every input is a deep-history edition of era B. */
  eraB: boolean;
  complete: boolean;
  through: string;
}

const inputRef = (i: DayInput): { kind: InputKind; key: string; fp: string } => ({ kind: i.kind, key: i.key, fp: i.fp });

/** sha256 of the canonical JSON of what a year's bytes depend on: the builder, the format, the epoch it counts at,
 *  the unique inputs (sorted) and, when it re-merges in memory, the inputs of its context days. */
export function yearDigest(o: { builder: number; epoch: number; through: string; inputs: (DayInput | null)[]; context: { day: string; input: DayInput | null }[] }): string {
  const uniq = new Map<string, { kind: InputKind; key: string; fp: string }>();
  for (const i of o.inputs) if (i) uniq.set(`${i.kind}\u0000${i.key}\u0000${i.fp}`, inputRef(i));
  const inputs = [...uniq.values()].sort((a, b) => (a.kind + a.key < b.kind + b.key ? -1 : a.kind + a.key > b.kind + b.key ? 1 : a.fp < b.fp ? -1 : 1));
  const context = o.context.map((c) => ({ day: c.day, input: c.input ? inputRef(c.input) : null }));
  return sha256Hex(canonicalJson({ builder: o.builder, rules: `${STATS_FORMAT}/reconcile-${RECONCILE_RULE}`, remerge_epoch: o.epoch, remerge_rules: REMERGE_RULES, through: o.through, inputs, ...(context.length ? { context } : {}) }));
}

export function planYear(year: number, through: string, lk: InputLookup, builder: number): YearPlan {
  const days = yearDays(year, through);
  const inputs = days.map((d) => chooseDayInput(d, lk));
  const missing = days.filter((_, i) => inputs[i] == null);
  const months = new Set<string>();
  days.forEach((d, i) => {
    const inp = inputs[i];
    if (inp && !inp.merged) months.add(d.slice(0, 7));
  });
  const unmergedMonths = [...months].sort();
  const context: YearPlan['context'] = [];
  if (unmergedMonths.length && days.length) {
    for (let k = CONTEXT_DAYS; k >= 1; k--) {
      const d = dayShift(days[0]!, -k);
      context.push({ day: d, input: chooseDayInput(d, lk) });
    }
    for (let k = 1; k <= CONTEXT_DAYS; k++) {
      const d = dayShift(days[days.length - 1]!, k);
      if (d > through) break;
      context.push({ day: d, input: chooseDayInput(d, lk) });
    }
  }
  const present = inputs.filter((x): x is DayInput => x != null);
  const eraB = present.length > 0 && present.every((x) => x.kind === 'edition' && x.era === 'B');
  const minMag = present.length > 0 && present.every((x) => x.minMag === 4.5) ? 4.5 : null;
  const yThrough = days.length ? days[days.length - 1]! : through;
  return {
    year,
    days,
    inputs,
    missing,
    unmergedMonths,
    context,
    digest: yearDigest({ builder, epoch: lk.epoch, through: yThrough, inputs, context }),
    minMag,
    eraB,
    complete: yThrough === `${year}-12-31`,
    through: yThrough,
  };
}

// --- the ledger ---

export interface GateCheck {
  gate: 'ok' | 'warn' | 'fail' | 'error';
  era: 'B' | 'default';
  current_year: boolean;
  window: { start: string; end: string };
  feed: { m6: number; m45: number };
  comcat: { m6: number; m45: number } | null;
  ratio: { m6: number | null; m45: number | null } | null;
  bands: { m6: [number, number]; m45: [number, number] };
  message?: string;
}

export interface MonthCounts {
  n45: number;
  m6: number;
  dup: number;
}

export interface YearState {
  inputs_digest: string;
  through: string;
  complete: boolean;
  area?: { bytes: number; sha256: string; records: number; m6: number };
  year?: { bytes: number; sha256: string };
  check?: GateCheck;
  remerged_in_memory: boolean;
  /** Rows the statistical reconciliation left out (APIs.md, Statistics: Reconciliation). */
  collapsed?: number;
  out_of_region?: number;
  inputs: Record<InputKind, number> & { unmerged_months: number };
  dup_suspects?: { count: number; n45: number; ratio: number; sample: { a: string; b: string; dt_s: number; km: number }[] };
  months?: Record<string, MonthCounts>;
  /** The digest of the build that failed its gate: not retried until the inputs change or a run names the year. */
  failed_digest?: string;
  /** A failed input or build: the previous files stay; retried next run. */
  error?: string;
  /** Days without an input: the year waits (era B walking). */
  waiting?: string;
}

export interface StatsHistoryState {
  version: 1;
  builder: number;
  through: string | null;
  generated: string;
  run_id: string | null;
  years: Record<string, YearState>;
}

export const emptyState = (builder: number): StatsHistoryState => ({ version: 1, builder, through: null, generated: '', run_id: null, years: {} });

/** The stats JSON of the ledger: years in order, one per line (a run's diff names the years it touched). */
export function stateText(s: StatsHistoryState): string {
  const years = Object.keys(s.years).sort();
  const body = years.map((y) => `    ${JSON.stringify(y)}: ${JSON.stringify(s.years[y])}`).join(',\n');
  return `{\n  "version": 1,\n  "builder": ${s.builder},\n  "through": ${JSON.stringify(s.through)},\n  "generated": ${JSON.stringify(s.generated)},\n  "run_id": ${JSON.stringify(s.run_id)},\n  "years": {${years.length ? `\n${body}\n  ` : ''}}\n}\n`;
}

/** Why a year needs a build, or null. */
export function staleReason(plan: YearPlan, st: YearState | undefined, o: { forced: boolean; fileExists: (kind: 'area' | 'year') => boolean; wantsYearFile: boolean }): string | null {
  if (plan.missing.length) return null; // waiting: never built with holes
  if (o.forced) return 'named by the run';
  if (!st) return 'never built';
  if (st.error) return `last build failed (${st.error.slice(0, 80)})`;
  if (st.inputs_digest === plan.digest && st.area && o.fileExists('area') && (!o.wantsYearFile || (st.year && o.fileExists('year')))) return null;
  if (st.failed_digest === plan.digest) return null; // the gate failed on these very inputs
  if (st.inputs_digest !== plan.digest) return 'inputs changed';
  if (!st.area || !o.fileExists('area')) return 'area file missing';
  return 'year file missing';
}

/** Build order: the current year and the two before it first, then the others newest first (era B last), at most
 *  `max`. A run that names years (`forced`) builds only those, newest first. */
export function buildOrder(stale: readonly number[], currentYear: number, max: number, forced: ReadonlySet<number> = new Set()): number[] {
  if (forced.size) return stale.filter((y) => forced.has(y)).sort((a, b) => b - a).slice(0, Math.max(0, max));
  const first = [currentYear, currentYear - 1, currentYear - 2].filter((y) => stale.includes(y));
  const rest = stale.filter((y) => !first.includes(y)).sort((a, b) => b - a);
  return [...first, ...rest].slice(0, Math.max(0, max));
}

// --- the accumulation ---

interface DupRow {
  t: number;
  lat: number;
  lon: number;
  prov: string;
  id: string;
}

/** What one year's rows add up to (area records, M6+ rows, and for a year file the per-day columns and M5+ rows). */
export class YearAccumulator {
  readonly area = new Map<number, [number, number, number]>();
  readonly m6: StatsEvent[] = [];
  readonly m5: StatsEvent[] = [];
  readonly dayIndex: Map<string, number>;
  readonly total: number[];
  readonly filtered: number[];
  readonly bins: number[][];
  readonly providers: Set<string>[];
  readonly months = new Map<string, { n45: number; m6: number }>();
  readonly dup: DupRow[] = [];
  rows = 0;
  skipped = 0;
  outside = 0;
  belowFloor = 0;
  private readonly t0: number;
  private readonly tEnd: number;

  constructor(
    readonly year: number,
    days: readonly string[],
    readonly detailed: boolean,
  ) {
    this.dayIndex = new Map(days.map((d, i) => [d, i]));
    this.total = days.map(() => 0);
    this.filtered = days.map(() => 0);
    this.bins = days.map(() => new Array<number>(10).fill(0));
    this.providers = days.map(() => new Set<string>());
    this.collapsed = days.map(() => 0);
    this.outOfRegion = days.map(() => 0);
    this.t0 = days.length ? dayStartMs(days[0]!) : 0;
    this.tEnd = days.length ? dayStartMs(days[days.length - 1]!) + DAY : 0;
  }

  /** One feature of an input with magnitude floor `minMag` (era B: rows under it are left out). */
  add(feature: unknown, minMag: number | null): void {
    const r = statsEventOf(feature);
    if (r == null) return;
    if (r.kind === 'skip') {
      this.skipped++;
      return;
    }
    const t = r.kind === 'filtered' ? r.timeMs : r.ev.timeMs;
    if (t < this.t0 || t >= this.tEnd) {
      this.outside++;
      return;
    }
    const day = eventDayKey(t);
    const di = this.dayIndex.get(day)!;
    if (r.kind === 'filtered') {
      if (minMag == null) this.filtered[di]!++;
      return;
    }
    const ev = r.ev;
    if (minMag != null && ev.magE2 < Math.round(minMag * 100)) {
      this.belowFloor++;
      return;
    }
    // A row the reconciliation may leave out waits for it (finish).
    if (ev.magE2 >= RECONCILE_CANDIDATE_E2) this.pending.push(ev);
    else this.count(ev, di);
  }

  /** The rows that wait for the reconciliation (M3.5+: the only ones that can link). */
  readonly pending: StatsEvent[] = [];
  /** Per day: rows the reconciliation left out. */
  readonly collapsed: number[];
  collapsedTotal = 0;
  /** Per day: rows outside every reporting catalogue's authoritative region (rule v3). */
  readonly outOfRegion: number[];
  outOfRegionTotal = 0;
  private finished = false;

  /**
   * The `collapsed_into` pairs of the year: [feed id, representative id, the representative's mag x 100] for every row
   * the reconciliation collapsed into one of the year's own rows. The collapsed row is the year's own or a context row
   * (the day before or after the year); a row of the year collapsed into a context row is listed by the neighbouring
   * year, whose own row the representative is: a pair always sits in the file that holds its representative's row.
   */
  readonly collapsedInto: [string, string, number][] = [];

  /**
   * Counts the waiting rows the reconciliation kept and the ones it left out (collapsed, out of region), and collects
   * `collapsedInto`. `rec` covers the waiting rows and the context rows the build reconciled with them.
   */
  finish(rec: Reconciliation): void {
    if (this.finished) throw new Error('YearAccumulator.finish called twice');
    this.finished = true;
    const ownMag = new Map(this.pending.map((ev) => [ev.id, ev.magE2]));
    for (const ev of this.pending) {
      const di = this.dayIndex.get(eventDayKey(ev.timeMs))!;
      if (rec.outOfRegion.has(ev.id)) {
        this.outOfRegion[di]!++;
        this.outOfRegionTotal++;
      } else if (rec.dropped.has(ev.id)) {
        this.collapsed[di]!++;
        this.collapsedTotal++;
      } else this.count(ev, di);
    }
    for (const [id, rep] of rec.dropped) {
      const repMag = ownMag.get(rep);
      if (repMag == null || rec.dropped.has(rep) || rec.outOfRegion.has(rep)) continue;
      this.collapsedInto.push([id, rep, repMag]);
    }
    this.pending.length = 0;
  }

  /** The `collapsed_into` pairs of a table whose rows are M(minE2 / 100)+: the representative is at or above it (so
   *  it is a row of that table). */
  collapsedIntoAtLeast(minE2: number): [string, string][] {
    return this.collapsedInto.filter(([, , m]) => m >= minE2).map(([id, rep]) => [id, rep]);
  }

  private count(ev: StatsEvent, di: number): void {
    this.rows++;
    const cell = cellOf(ev.latE4, ev.lonE4);
    const rec = this.area.get(cell);
    const m45 = ev.magE2 >= 450 ? 1 : 0;
    if (rec) {
      rec[0]++;
      rec[1] += m45;
      if (ev.magE2 > rec[2]) rec[2] = ev.magE2;
    } else this.area.set(cell, [1, m45, ev.magE2]);
    if (ev.magE2 >= 600) this.m6.push(ev);
    const month = eventDayKey(ev.timeMs).slice(0, 7);
    let mc = this.months.get(month);
    if (!mc) this.months.set(month, (mc = { n45: 0, m6: 0 }));
    if (m45) {
      mc.n45++;
      this.dup.push({ t: ev.timeMs, lat: ev.latE4 / 1e4, lon: ev.lonE4 / 1e4, prov: ev.provider, id: ev.id });
    }
    if (ev.magE2 >= 600) mc.m6++;
    if (this.detailed) {
      this.total[di]!++;
      this.bins[di]![magBin(ev.magE2)]!++;
      this.providers[di]!.add(ev.provider);
      if (ev.magE2 >= 500) this.m5.push(ev);
    }
  }
}

/** Pairs of M4.5+ rows of different chosen providers within DUP_DT_MS and DUP_KM: split duplicates the merge left. */
export function dupSuspects(rows: readonly DupRow[]): { count: number; pairs: { a: string; b: string; dt_s: number; km: number; month: string }[] } {
  const s = [...rows].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  const pairs: { a: string; b: string; dt_s: number; km: number; month: string }[] = [];
  let lo = 0;
  for (let i = 0; i < s.length; i++) {
    const x = s[i]!;
    while (s[lo]!.t < x.t - DUP_DT_MS) lo++;
    for (let j = lo; j < i; j++) {
      const y = s[j]!;
      if (y.prov === x.prov) continue;
      const km = haversineKm(x.lat, x.lon, y.lat, y.lon);
      if (km <= DUP_KM) pairs.push({ a: y.id, b: x.id, dt_s: Math.round((x.t - y.t) / 1000), km: Math.round(km * 10) / 10, month: eventDayKey(x.t).slice(0, 7) });
    }
  }
  return { count: pairs.length, pairs };
}

/** The area file's bytes (key order of the schema). */
export function areaFileJson(acc: YearAccumulator, plan: YearPlan, builder: number): string {
  const cells = [...acc.area.keys()].sort((a, b) => a - b);
  let prev = 0;
  const cell = cells.map((c, i) => {
    const d = i === 0 ? c : c - prev;
    prev = c;
    return d;
  });
  const t0 = Date.UTC(plan.year, 0, 1);
  const doc = {
    format: STATS_FORMAT,
    kind: 'area',
    year: plan.year,
    builder,
    min_mag: plan.minMag,
    through: plan.through,
    complete: plan.complete,
    cell_deg: CELL_DEG,
    records: cells.length,
    cell,
    total: cells.map((c) => acc.area.get(c)![0]),
    m45: cells.map((c) => acc.area.get(c)![1]),
    mmax: cells.map((c) => acc.area.get(c)![2]),
    m6: buildEventTable('area', t0, acc.m6, AREA_COLUMNS, acc.collapsedIntoAtLeast(600)),
    reconciled: { rule: RECONCILE_RULE, collapsed: acc.collapsedTotal, out_of_region: acc.outOfRegionTotal },
    inputs_digest: plan.digest,
    attribution: STATS_ATTRIBUTION,
  };
  return JSON.stringify(doc);
}

/** The year file's bytes (key order of the schema). */
export function yearFileJson(acc: YearAccumulator, plan: YearPlan, builder: number): string {
  const names = [...new Set(acc.providers.flatMap((s) => [...s]))].sort();
  const pIndex = new Map(names.map((p, i) => [p, i]));
  const missing = new Set(plan.missing);
  const doc = {
    format: STATS_FORMAT,
    kind: 'year',
    year: plan.year,
    builder,
    first: plan.days[0]!,
    through: plan.through,
    complete: plan.complete,
    mag_edges_e2: [...MAG_EDGES_E2],
    provider_names: names,
    days: {
      total: acc.total,
      filtered: acc.filtered,
      collapsed: acc.collapsed,
      out_of_region: acc.outOfRegion,
      bins: acc.bins,
      providers: acc.providers.map((s) => [...s].map((p) => pIndex.get(p)!).sort((a, b) => a - b)),
      missing: plan.days.flatMap((d, i) => (missing.has(d) ? [i] : [])),
    },
    events: buildEventTable('year', Date.UTC(plan.year, 0, 1), acc.m5, YEAR_COLUMNS, acc.collapsedIntoAtLeast(500)),
    reconciled: { rule: RECONCILE_RULE, collapsed: acc.collapsedTotal, out_of_region: acc.outOfRegionTotal },
    inputs_digest: plan.digest,
    attribution: STATS_ATTRIBUTION,
  };
  return JSON.stringify(doc);
}

// --- reading the inputs ---

/** The I/O the builder needs, injectable for tests. */
export interface StatsIo {
  /** The members (DD.ndjson, _*.json) of a Release tar asset, its sha256 checked against `sha256`. */
  assetMembers(tag: string, asset: string, sha256: string): Map<string, string>;
  /** The NDJSON text of a gzip Release asset (a remediation edition), its sha256 checked. */
  gzipText(tag: string, asset: string, sha256: string): string;
  /** The NDJSON text of a frozen partition by its blob. */
  partitionText(day: string, oid: string): string;
  /** Fetch these partition blobs in one go before they are read (optional: a blobless checkout would otherwise fetch
   *  them one request each). */
  prefetchPartitions?(oids: string[]): void;
}

/** The input reader of one run: keeps the last few month assets (a month and its neighbours) and remediation days in
 *  memory, in separate caches, so the remediated days of a month never push its archive out. */
export class InputReader {
  private readonly months = new Map<string, Map<string, string>>();
  private readonly days = new Map<string, Map<string, string>>();
  downloads = 0;
  constructor(
    private readonly io: StatsIo,
    private readonly keep = 4,
    private readonly keepDays = 40,
  ) {}

  private members(i: DayInput): Map<string, string> {
    const cache = i.kind === 'remediation' ? this.days : this.months;
    const hit = cache.get(i.key);
    if (hit) {
      cache.delete(i.key);
      cache.set(i.key, hit);
      return hit;
    }
    this.downloads++;
    const m = i.kind === 'remediation' ? new Map([['day', this.io.gzipText(i.tag!, i.asset!, i.fp)]]) : this.io.assetMembers(i.tag!, i.asset!, i.fp);
    cache.set(i.key, m);
    const keep = i.kind === 'remediation' ? this.keepDays : this.keep;
    while (cache.size > keep) cache.delete(cache.keys().next().value!);
    return m;
  }

  /** Fetches the partition blobs among `inputs` in one go (when the I/O can). */
  prefetch(inputs: Iterable<DayInput | null>): void {
    const oids = [...new Set([...inputs].filter((i): i is DayInput => i?.kind === 'partition').map((i) => i.fp))];
    if (oids.length && this.io.prefetchPartitions) this.io.prefetchPartitions(oids);
  }

  /** The NDJSON text of `day` from its input ('' when the input holds no line of the day). */
  dayText(day: string, i: DayInput): string {
    if (i.kind === 'partition') return this.io.partitionText(day, i.fp);
    const m = this.members(i);
    return i.kind === 'remediation' ? m.get('day')! : (m.get(`${day.slice(8, 10)}.ndjson`) ?? '');
  }

  /** The `into_newer` survivors the input's merge metadata names (an older merged unit points into the next one). */
  intoNewer(i: DayInput): string[] {
    if (i.kind !== 'archive' && i.kind !== 'edition') return [];
    const m = this.members(i);
    const meta = m.get('_archive.json') ?? m.get('_edition.json');
    if (!meta) return [];
    try {
      const j = JSON.parse(meta) as { merge?: { into_newer?: { survivor: string }[] } };
      return (j.merge?.into_newer ?? []).map((x) => x.survivor);
    } catch {
      return [];
    }
  }
}

const lines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');

export interface YearBuild {
  acc: YearAccumulator;
  areaBody: string;
  yearBody: string | null;
  remergedMonths: string[];
  folds: number;
  ms: number;
}

/**
 * Builds one year from its plan. Merged inputs are streamed one day member at a time; a month with any unmerged input
 * is read whole, re-merged in memory (remergeNodes with 7 days of frozen older and pinned newer context, each day read
 * from its own input) and its own events counted after the merge. Throws on a failed input or a broken re-merge
 * invariant (the caller keeps the year's previous files).
 */
export function buildYear(plan: YearPlan, reader: InputReader, o: { builder: number; detailed: boolean; registry: ProviderConfig[]; lookup: InputLookup; through: string; log?: (m: string) => void }): YearBuild {
  const priority = priorityMap(o.registry);
  const started = performance.now();
  const acc = new YearAccumulator(plan.year, plan.days, o.detailed);
  const byMonth = new Map<string, number[]>();
  plan.days.forEach((d, i) => {
    const m = d.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(i);
  });
  const unmerged = new Set(plan.unmergedMonths);
  reader.prefetch([...plan.inputs, ...plan.context.map((c) => c.input)]);
  let folds = 0;
  for (const [month, idxs] of byMonth) {
    if (!unmerged.has(month)) {
      for (const i of idxs) {
        const inp = plan.inputs[i];
        if (!inp) continue;
        for (const l of lines(reader.dayText(plan.days[i]!, inp))) acc.add(JSON.parse(l), inp.minMag);
      }
      continue;
    }
    // The in-memory re-merge of the month (owner decision A6).
    const t0 = performance.now();
    const own: EventNode[] = [];
    const memberDay = new Map<string, string>();
    const minMagOf = new Map<string, number | null>();
    const seen = new Set<string>();
    const ownDays: string[] = [];
    for (const i of idxs) {
      const inp = plan.inputs[i];
      if (!inp) continue;
      const day = plan.days[i]!;
      ownDays.push(day);
      for (const l of lines(reader.dayText(day, inp))) {
        const n = featureToNode(JSON.parse(l));
        if (seen.has(n.feedId)) throw new Error(`${month}: ${n.feedId} is in two day inputs`);
        seen.add(n.feedId);
        own.push(n);
        memberDay.set(n.feedId, day);
        minMagOf.set(n.feedId, inp.minMag);
      }
    }
    if (!ownDays.length) continue;
    const first = ownDays[0]!;
    const last = ownDays[ownDays.length - 1]!;
    const ctx = (days: string[]): { nodes: EventNode[]; intoNewer: string[] } => {
      const nodes: EventNode[] = [];
      const intoNewer: string[] = [];
      for (const d of days) {
        if (d > o.through) continue;
        const inp = chooseDayInput(d, o.lookup);
        if (!inp) continue;
        intoNewer.push(...reader.intoNewer(inp));
        for (const l of lines(reader.dayText(d, inp))) {
          const n = featureToNode(JSON.parse(l));
          if (seen.has(n.feedId)) continue;
          seen.add(n.feedId);
          nodes.push(n);
        }
      }
      return { nodes, intoNewer };
    };
    const older = ctx(Array.from({ length: CONTEXT_DAYS }, (_, k) => dayShift(first, k - CONTEXT_DAYS)));
    const newer = ctx(Array.from({ length: CONTEXT_DAYS }, (_, k) => dayShift(last, k + 1)));
    const anchored = new Set(older.intoNewer.filter((id) => memberDay.has(id)));
    // The re-merge's input normalization (REMERGE_RULES; row-normalize.ts): the unit and both context windows, as the
    // archive re-merge does (AFAD rows stored 3 h early re-timed, ISC magnitudes of untrusted authors dropped).
    const norm = normalizeUnit(own, o.registry);
    normalizeUnit(older.nodes, o.registry);
    normalizeUnit(newer.nodes, o.registry);
    let res: ReturnType<typeof remergeNodes>;
    try {
      res = remergeNodes({
        own,
        memberDay,
        startMs: dayStartMs(first),
        endMs: dayStartMs(last) + DAY,
        older: older.nodes,
        newer: newer.nodes,
        anchored,
        registry: o.registry,
        ingestTime: REMERGE_INGEST_TIME,
        epoch: STATS_REMERGE_EPOCH,
      });
    } catch (e) {
      if (e instanceof RemergeError) throw new Error(`${month}: in-memory re-merge: ${e.message}`);
      throw e;
    }
    folds += res.merges.length;
    for (const n of own) acc.add(nodeToFeature(n), minMagOf.get(n.feedId) ?? null);
    o.log?.(`stats: ${month} re-merged in memory: ${res.live_before} -> ${res.live_after} live, ${res.merges.length} fold(s), ${norm.events_changed} event(s) normalized (AFAD ${norm.afad_retimed}, ISC ${norm.isc_magnitude_dropped}), ${Math.round(performance.now() - t0)} ms`);
  }
  // The statistical reconciliation over the whole year, the day before and the day after it (when frozen) as context:
  // a quake's reports across midnight on New Year's Eve count once too.
  const context: StatsEvent[] = [];
  if (plan.days.length) {
    for (const d of [dayShift(plan.days[0]!, -1), dayShift(plan.days[plan.days.length - 1]!, 1)]) {
      if (d > o.through) continue;
      const inp = chooseDayInput(d, o.lookup);
      if (!inp) continue;
      const floor = inp.minMag == null ? -Infinity : Math.round(inp.minMag * 100);
      for (const l of lines(reader.dayText(d, inp))) {
        const r = statsEventOf(JSON.parse(l));
        if (r?.kind === 'event' && r.ev.magE2 >= RECONCILE_CANDIDATE_E2 && r.ev.magE2 >= floor) context.push(r.ev);
      }
    }
  }
  const own = new Set(acc.pending.map((e) => e.id));
  const r0 = performance.now();
  const rec = reconcileRows([...acc.pending, ...context.filter((e) => !own.has(e.id))], priority);
  acc.finish(rec);
  o.log?.(`stats: ${plan.year} reconciled: ${acc.collapsedTotal} row(s) collapsed, ${acc.outOfRegionTotal} out of region, ${Math.round(performance.now() - r0)} ms`);
  return {
    acc,
    areaBody: areaFileJson(acc, plan, o.builder),
    yearBody: o.detailed ? yearFileJson(acc, plan, o.builder) : null,
    remergedMonths: plan.unmergedMonths,
    folds,
    ms: Math.round(performance.now() - started),
  };
}

// --- the ComCat gate and verify ---

/** ComCat's count of earthquakes in [startMs, endMs) at or above minMag. */
export type ComcatCount = (startMs: number, endMs: number, minMag: number) => Promise<number>;

const ratio = (feed: number, comcat: number): number | null => (comcat === 0 ? (feed === 0 ? 1 : null) : Math.round((feed / comcat) * 10_000) / 10_000);
const within = (r: number | null, [lo, hi]: [number, number]): boolean => r != null && r >= lo && r <= hi;

/** The gate of one year: feed M6+ (the area file's m6 rows) and M4.5+ (sum of m45) against ComCat over
 *  [Y-01-01, min(Y+1-01-01, through + 1 day)). Era B within its band (+-2 %), 2000+ within the default bands; the open
 *  current year only warns (config gate.current_year "warn"). */
export async function comcatGate(o: { year: number; through: string; eraB: boolean; currentYear: boolean; feed: { m6: number; m45: number }; gate: StatsConfig['gate']; count: ComcatCount }): Promise<GateCheck> {
  const start = `${o.year}-01-01`;
  const end = `${o.year + 1}-01-01` < dayShift(o.through, 1) ? `${o.year + 1}-01-01` : dayShift(o.through, 1);
  const bands = o.eraB ? o.gate.eraB : o.gate.default;
  const base = { era: o.eraB ? ('B' as const) : ('default' as const), current_year: o.currentYear, window: { start, end }, feed: o.feed, bands: { m6: bands.m6, m45: bands.m45 } };
  let comcat: { m6: number; m45: number };
  try {
    const s = dayStartMs(start);
    const e = dayStartMs(end);
    comcat = { m6: await o.count(s, e, 6), m45: await o.count(s, e, 4.5) };
  } catch (err) {
    return { gate: 'error', ...base, comcat: null, ratio: null, message: `ComCat count failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const r = { m6: ratio(o.feed.m6, comcat.m6), m45: ratio(o.feed.m45, comcat.m45) };
  const pass = within(r.m6, bands.m6) && within(r.m45, bands.m45);
  const warnOnly = o.currentYear && o.gate.current_year === 'warn';
  const numbers = `M6+ ${o.feed.m6} vs ComCat ${comcat.m6} (ratio ${r.m6}), M4.5+ ${o.feed.m45} vs ${comcat.m45} (ratio ${r.m45}) outside M6+ [${bands.m6.join(', ')}] / M4.5+ [${bands.m45.join(', ')}]`;
  // The open year warns with its cause first: below ComCat it is ComCat's late publications on the frozen live-era days
  // (settled within LATE_USGS_MAX_AGE_DAYS by remediate.yml's late_usgs editions), above it the split copies.
  const message = pass ? undefined : warnOnly ? `${gateCauses(r, bands).join(' + ')}: ${numbers}` : numbers;
  return { gate: pass ? 'ok' : warnOnly ? 'warn' : 'fail', ...base, comcat, ratio: r, ...(message ? { message } : {}) };
}

/** Why the open year is off ComCat: `late ComCat` when a ratio is below its band (ComCat publishes and upgrades M4.5+
 *  solutions days or weeks after the origin, after the live days froze: APIs.md, Remediation editions), `split copies`
 *  when one is above it (one quake counted twice: SHLTR-148). */
export function gateCauses(r: { m6: number | null; m45: number | null }, bands: { m6: [number, number]; m45: [number, number] }): string[] {
  const below = (x: number | null, b: [number, number]): boolean => x != null && x < b[0];
  const above = (x: number | null, b: [number, number]): boolean => x != null && x > b[1];
  const causes: string[] = [];
  if (below(r.m45, bands.m45) || below(r.m6, bands.m6)) causes.push(LATE_COMCAT);
  if (above(r.m45, bands.m45) || above(r.m6, bands.m6)) causes.push('split copies');
  return causes.length ? causes : ['no ComCat ratio'];
}
/** The name the warnings give ComCat's late publications (SHLTR-150). */
export const LATE_COMCAT = 'late ComCat';

/** The live ComCat count (fetchText; one request at a time, at least COMCAT_GAP_MS apart, 3 tries). */
export function comcatCounter(usgs: ProviderConfig, o: { gapMs?: number; sleep?: (ms: number) => Promise<void> } = {}): ComcatCount {
  const gap = o.gapMs ?? COMCAT_GAP_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = 0;
  return async (startMs, endMs, minMag) => {
    const url = `${historyQueryUrl(usgs, startMs, endMs, { limit: 0, minMagnitude: minMag, count: true })}&eventtype=earthquake`;
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = last + gap * (attempt + 1) - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      try {
        const r = await fetchText(url, 30_000);
        if (r.status === 200) {
          const j = JSON.parse(r.body) as { count?: unknown };
          if (typeof j.count === 'number') return j.count;
          lastErr = 'no count in the answer';
        } else lastErr = `HTTP ${r.status}`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(`${url}: ${lastErr}`);
  };
}

export interface VerifyRow {
  month: string;
  feed: MonthCounts;
  comcat: { m45: number; m6: number } | null;
  ratio45: number | null;
  ok: boolean;
  note?: string;
}

/** The months a verify run checks: `full` every month the ledger has counts for; `sample` the last 13 plus 6 picked
 *  at random from the closed months before them (seeded by the run, so a re-run checks the same ones). */
export function verifyMonths(all: readonly string[], mode: 'sample' | 'full', seed: number): string[] {
  const sorted = [...all].sort();
  if (mode === 'full') return sorted;
  const last = sorted.slice(-13);
  const older = sorted.slice(0, -13);
  const picked: string[] = [];
  let x = (seed >>> 0) || 1;
  while (picked.length < 6 && picked.length < older.length) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const m = older[x % older.length]!;
    if (!picked.includes(m)) picked.push(m);
  }
  return [...picked.sort(), ...last];
}

/** One month against ComCat: M4.5+ within the era's band, M6+ within max(2, 20 %); the open month only reports. A
 *  month that is not settled yet (`settling`: it ends within LATE_USGS_MAX_AGE_DAYS of `through`) and is below ComCat
 *  names the cause, `late ComCat`, before its numbers. */
export function verifyRow(month: string, feed: MonthCounts, comcat: { m45: number; m6: number }, bands: StatsConfig['gate']['default'], open: boolean, settling = false): VerifyRow {
  const r45 = ratio(feed.n45, comcat.m45);
  const m6ok = Math.abs(feed.m6 - comcat.m6) <= Math.max(2, Math.ceil(comcat.m6 * 0.2));
  const ok = open || (within(r45, bands.m45) && m6ok);
  const low = (r45 != null && r45 < bands.m45[0]) || feed.m6 < comcat.m6 - Math.max(2, Math.ceil(comcat.m6 * 0.2));
  const numbers = `M4.5+ ratio ${r45}, M6+ ${feed.m6} vs ${comcat.m6}`;
  return { month, feed, comcat, ratio45: r45, ok, ...(open ? { note: 'open month' } : !ok ? { note: settling && low ? `${LATE_COMCAT}, settles within ${LATE_USGS_MAX_AGE_DAYS} days: ${numbers}` : numbers } : {}) };
}

// --- the run ---

export interface RunOptions {
  nowMs: number;
  config: StatsConfig;
  lookup: InputLookup;
  state: StatsHistoryState;
  /** Paths under the data checkout that exist (v1/stats/area/<Y>.json, …). */
  fileExists: (path: string) => boolean;
  forced: ReadonlySet<number>;
  maxYears: number;
  budgetMs: number;
  reader: InputReader;
  registry: ProviderConfig[];
  comcat: ComcatCount;
  runId: string | null;
  log?: (m: string) => void;
  clock?: () => number;
}

export interface YearReport {
  year: number;
  /** The build's per-month counts (also when its gate failed: the ledger then keeps the previous build's). */
  months?: Record<string, MonthCounts>;
  reason: string;
  result: 'built' | 'gate-failed' | 'error' | 'budget';
  inputs?: YearState['inputs'];
  remerged_months?: number;
  folds?: number;
  collapsed?: number;
  out_of_region?: number;
  area_bytes?: number;
  year_bytes?: number;
  records?: number;
  ms?: number;
  check?: GateCheck;
  error?: string;
}

export interface RunResult {
  state: StatsHistoryState;
  /** path (v1/stats/...) -> new bytes. */
  writes: Map<string, string>;
  /** Year files to remove. */
  removes: string[];
  reports: YearReport[];
  waiting: { year: number; missing: number }[];
  /** Lines of the blocked marker (gate failures, failed builds). */
  blocked: string[];
  through: string;
  stale: number[];
  changed: boolean;
}

export const areaPath = (y: number): string => `${STATS_DIR}/area/${y}.json`;
export const yearPath = (y: number): string => `${STATS_DIR}/year/${y}.json`;

const countInputs = (plan: YearPlan): YearState['inputs'] => {
  const c = { remediation: 0, partition: 0, archive: 0, edition: 0, unmerged_months: plan.unmergedMonths.length };
  for (const i of plan.inputs) if (i) c[i.kind]++;
  return c;
};

/** One builder run over every year (pure apart from `reader`, `comcat` and `fileExists`). */
export async function runStatsHistory(o: RunOptions): Promise<RunResult> {
  const clock = o.clock ?? (() => Date.now());
  const started = clock();
  const log = o.log ?? (() => {});
  const builder = o.config.builder;
  const through = statsThrough(o.nowMs);
  const nowYear = new Date(o.nowMs).getUTCFullYear();
  const lastYear = Number(through.slice(0, 4));
  const yearFileYears = new Set([nowYear, nowYear - 1, nowYear - 2].filter((y) => y <= lastYear));
  const state: StatsHistoryState = structuredClone(o.state);
  // A builder bump rebuilds everything: the old ledger's digests no longer match anyway (the builder is in them).
  state.builder = builder;
  const plans = new Map<number, YearPlan>();
  const waiting: RunResult['waiting'] = [];
  for (let y = STATS_FIRST_YEAR; y <= lastYear; y++) {
    const plan = planYear(y, through, o.lookup, builder);
    if (plan.inputs.every((i) => i == null)) continue;
    plans.set(y, plan);
    if (plan.missing.length) waiting.push({ year: y, missing: plan.missing.length });
  }
  const stale: number[] = [];
  const reasons = new Map<number, string>();
  for (const [y, plan] of plans) {
    const st = state.years[String(y)];
    const why = staleReason(plan, st, { forced: o.forced.has(y), fileExists: (k) => o.fileExists(k === 'area' ? areaPath(y) : yearPath(y)), wantsYearFile: yearFileYears.has(y) });
    if (why) {
      stale.push(y);
      reasons.set(y, why);
    }
  }
  for (const w of waiting) {
    const st = state.years[String(w.year)];
    if (st) st.waiting = `${w.missing} day(s) without an input`;
  }
  const order = buildOrder(stale, nowYear, o.maxYears, o.forced);
  const writes = new Map<string, string>();
  const removes: string[] = [];
  const reports: YearReport[] = [];
  const blocked: string[] = [];
  let changed = false;

  for (const y of order) {
    const plan = plans.get(y)!;
    const reason = reasons.get(y)!;
    if (clock() - started > o.budgetMs) {
      reports.push({ year: y, reason, result: 'budget' });
      continue;
    }
    changed = true;
    const key = String(y);
    const prev = state.years[key];
    const detailed = yearFileYears.has(y);
    const inputs = countInputs(plan);
    log(`stats: ${y}: building (${reason}); ${plan.days.length} day(s), inputs ${JSON.stringify(inputs)}`);
    let built: YearBuild;
    try {
      built = buildYear(plan, o.reader, { builder, detailed, registry: o.registry, lookup: o.lookup, through, log });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`::warning::stats: ${y}: build failed, the previous files stay: ${msg}`);
      state.years[key] = { ...(prev ?? { inputs_digest: '', through: plan.through, complete: plan.complete, remerged_in_memory: false, inputs }), error: msg.slice(0, 500) };
      reports.push({ year: y, reason, result: 'error', error: msg });
      blocked.push(`stats ${y}: build failed: ${msg.slice(0, 200)}`);
      continue;
    }
    const acc = built.acc;
    const feed = { m6: acc.m6.length, m45: [...acc.area.values()].reduce((s, r) => s + r[1], 0) };
    const check = await comcatGate({ year: y, through, eraB: plan.eraB, currentYear: !plan.complete && y === lastYear, feed, gate: o.config.gate, count: o.comcat });
    const dup = dupSuspects(acc.dup);
    const months: Record<string, MonthCounts> = {};
    for (const [m, c] of [...acc.months].sort(([a], [b]) => (a < b ? -1 : 1))) months[m] = { n45: c.n45, m6: c.m6, dup: dup.pairs.filter((p) => p.month === m).length };
    const base: YearState = {
      inputs_digest: plan.digest,
      through: plan.through,
      complete: plan.complete,
      check,
      remerged_in_memory: built.remergedMonths.length > 0,
      collapsed: acc.collapsedTotal,
      out_of_region: acc.outOfRegionTotal,
      inputs,
      dup_suspects: { count: dup.count, n45: feed.m45, ratio: feed.m45 ? Math.round((dup.count / feed.m45) * 10_000) / 10_000 : 0, sample: dup.pairs.slice(0, 10).map(({ a, b, dt_s, km }) => ({ a, b, dt_s, km })) },
      months,
    };
    const rep: YearReport = { year: y, reason, result: 'built', months, inputs, remerged_months: built.remergedMonths.length, folds: built.folds, collapsed: acc.collapsedTotal, out_of_region: acc.outOfRegionTotal, area_bytes: Buffer.byteLength(built.areaBody), ...(built.yearBody ? { year_bytes: Buffer.byteLength(built.yearBody) } : {}), records: acc.area.size, ms: built.ms, check };
    if (check.gate === 'fail' || check.gate === 'error') {
      // Keep the previous files and their ledger entry; a gate failure is not retried on the same inputs.
      log(`::warning::stats: ${y}: ComCat gate ${check.gate}: ${check.message ?? ''}; the previous files stay`);
      state.years[key] = {
        ...(prev ?? { inputs_digest: '', through: plan.through, complete: plan.complete, remerged_in_memory: false, inputs }),
        check,
        ...(check.gate === 'fail' ? { failed_digest: plan.digest } : {}),
      };
      delete state.years[key]!.error;
      reports.push({ ...rep, result: check.gate === 'fail' ? 'gate-failed' : 'error' });
      blocked.push(`stats ${y}: ComCat gate ${check.gate}: ${check.message ?? ''}`);
      continue;
    }
    writes.set(areaPath(y), built.areaBody);
    base.area = { bytes: Buffer.byteLength(built.areaBody), sha256: sha256Hex(built.areaBody), records: acc.area.size, m6: acc.m6.length };
    if (built.yearBody) {
      writes.set(yearPath(y), built.yearBody);
      base.year = { bytes: Buffer.byteLength(built.yearBody), sha256: sha256Hex(built.yearBody) };
    }
    state.years[key] = base;
    reports.push(rep);
    log(`stats: ${y}: ${check.gate}${check.gate === 'warn' && check.message ? ` (${check.message})` : ''}; ${acc.area.size} cells, M6+ ${feed.m6}, M4.5+ ${feed.m45}${check.comcat ? ` (ComCat ${check.comcat.m6} / ${check.comcat.m45})` : ''}, ${built.ms} ms`);
  }

  // Year files outside the current year and the two before it go.
  for (const [key, st] of Object.entries(state.years)) {
    const y = Number(key);
    if (st.year && !yearFileYears.has(y)) {
      delete st.year;
      removes.push(yearPath(y));
      changed = true;
    }
  }
  // A gate that failed in an earlier run keeps alarming while it lasts.
  for (const [key, st] of Object.entries(state.years)) {
    if (st.check?.gate === 'fail' && !blocked.some((b) => b.startsWith(`stats ${key}:`))) blocked.push(`stats ${key}: ComCat gate failed on these inputs (${st.check.message ?? ''})`);
  }
  // `through` of the published files: that of the newest year's area file.
  const newest = Object.keys(state.years).filter((k) => state.years[k]!.area).sort().at(-1);
  state.through = newest ? state.years[newest]!.through : null;
  state.generated = new Date(o.nowMs).toISOString();
  state.run_id = o.runId;
  return { state, writes, removes, reports, waiting, blocked, through, stale, changed };
}

// --- I/O ---

/** Release downloads through gh (ghRetry), then the API asset endpoint (direct downloads have answered 504s in a row). */
export function downloadAsset(tag: string, asset: string, out: string): void {
  try {
    ghRetry(['release', 'download', tag, '-R', REPO, '-p', asset, '-O', out, '--clobber']);
    return;
  } catch (e) {
    console.error(`stats: gh release download ${tag}/${asset} failed (${String(e).replace(/\s+/g, ' ').slice(0, 160)}); trying the API asset endpoint`);
  }
  const id = ghRetry(['api', `repos/${REPO}/releases/tags/${tag}`, '--jq', `.assets[] | select(.name == "${asset}") | .id`]).trim();
  if (!/^\d+$/.test(id)) throw new Error(`${tag}/${asset}: no such asset`);
  const bytes = execFileSync('gh', ['api', `repos/${REPO}/releases/assets/${id}`, '-H', 'Accept: application/octet-stream'], { maxBuffer: 1 << 30 });
  writeFileSync(out, bytes);
}

export function ghStatsIo(dataDir: string, work: string): StatsIo {
  const fetchChecked = (tag: string, asset: string, sha: string): string => {
    const dir = mkdtempSync(join(work, 'asset-'));
    const file = join(dir, asset);
    downloadAsset(tag, asset, file);
    const got = sha256Hex(readFileSync(file));
    if (got !== sha) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`${tag}/${asset} has sha256 ${got}, the index says ${sha}`);
    }
    return file;
  };
  return {
    assetMembers(tag, asset, sha) {
      const file = fetchChecked(tag, asset, sha);
      const dir = dirname(file);
      const into = join(dir, 'x');
      mkdirSync(into);
      extractTarball(file, into);
      const out = new Map<string, string>();
      for (const m of readdirSync(into).sort()) out.set(m, readFileSync(join(into, m), 'utf8'));
      rmSync(dir, { recursive: true, force: true });
      return out;
    },
    gzipText(tag, asset, sha) {
      const file = fetchChecked(tag, asset, sha);
      const text = gunzipSync(readFileSync(file)).toString('utf8');
      rmSync(dirname(file), { recursive: true, force: true });
      return text;
    },
    prefetchPartitions(oids) {
      // One fetch of the missing blobs (the promisor remote of a blobless checkout); a failure leaves them to the lazy
      // fetch of `git cat-file`.
      let missing: string[] = oids;
      try {
        const out = execFileSync('git', ['-C', dataDir, '-c', 'fetch.negotiationAlgorithm=noop', 'cat-file', '--batch-check=%(objectname)', '--buffer'], { input: oids.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, maxBuffer: 1 << 24 });
        missing = out.split('\n').filter((l) => / missing$/.test(l)).map((l) => l.split(' ')[0]!);
      } catch {
        /* fall through: try them all */
      }
      for (let k = 0; k < missing.length; k += 200) {
        const chunk = missing.slice(k, k + 200);
        try {
          execFileSync('git', ['-C', dataDir, '-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', 'origin', ...chunk], { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (e) {
          console.error(`stats: prefetching ${chunk.length} partition blob(s) failed (${String(e).replace(/\s+/g, ' ').slice(0, 160)}); reading them one by one`);
        }
      }
    },
    partitionText(_day, oid) {
      // A blobless checkout fetches the one blob.
      return execFileSync('git', ['-C', dataDir, 'cat-file', 'blob', oid], { encoding: 'utf8', maxBuffer: 1 << 30 });
    },
  };
}

/** The frozen day partitions of the data checkout at or before `through`: day -> blob oid (`git ls-tree`). */
export function partitionBlobs(dataDir: string, through: string): Map<string, string> {
  const out = new Map<string, string>();
  let text = '';
  try {
    text = execFileSync('git', ['-C', dataDir, 'ls-tree', '-r', 'HEAD', '--', 'events'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (e) {
    throw new Error(`git ls-tree of the data checkout failed: ${String(e).slice(0, 200)}`);
  }
  for (const line of text.split('\n')) {
    const m = /^\d+ blob ([0-9a-f]{40,64})\tevents\/(\d{4})\/(\d{2})\/(\d{2})\.ndjson$/.exec(line);
    if (!m) continue;
    const day = `${m[2]}-${m[3]}-${m[4]}`;
    if (day <= through) out.set(day, m[1]!);
  }
  return out;
}

const readJson = <T>(f: string, fallback: T): T => (existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : fallback);

function setOutput(key: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const fmtRatio = (r: number | null | undefined): string => (r == null ? '–' : r.toFixed(3));

export function reportMarkdown(r: RunResult, o: { dryRun: boolean; verify: VerifyRow[] | null; ms: number; downloads: number }): string {
  const out: string[] = [];
  out.push(`# Stats builder run${o.dryRun ? ' (dry run)' : ''}`, '');
  out.push(`through ${r.through}; ${r.stale.length} stale year(s); built ${r.reports.filter((x) => x.result === 'built').length}; ${o.downloads} asset download(s); ${Math.round(o.ms / 1000)} s`, '');
  if (r.reports.length) {
    out.push('| Year | Reason | Result | Inputs (rem/part/arch/ed) | Re-merged months | Folds | Collapsed | Out of region | Cells | Area bytes | Year bytes | Feed M6+ / ComCat | Feed M4.5+ / ComCat | Ratios M6 / M4.5 | Gate | s |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const x of r.reports) {
      const i = x.inputs;
      const c = x.check;
      out.push(
        `| ${x.year} | ${x.reason} | ${x.result}${x.error ? `: ${x.error.slice(0, 120)}` : ''} | ${i ? `${i.remediation}/${i.partition}/${i.archive}/${i.edition}` : ''} | ${x.remerged_months ?? ''} | ${x.folds ?? ''} | ${x.collapsed ?? ''} | ${x.out_of_region ?? ''} | ${x.records ?? ''} | ${x.area_bytes ?? ''} | ${x.year_bytes ?? ''} | ${c ? `${c.feed.m6} / ${c.comcat?.m6 ?? '–'}` : ''} | ${c ? `${c.feed.m45} / ${c.comcat?.m45 ?? '–'}` : ''} | ${c ? `${fmtRatio(c.ratio?.m6)} / ${fmtRatio(c.ratio?.m45)}` : ''} | ${c?.gate ?? ''} | ${x.ms != null ? Math.round(x.ms / 1000) : ''} |`,
      );
    }
    out.push('');
  }
  const built = r.reports.filter((x) => x.months);
  if (built.length) {
    out.push('## Rebuilt years by month (feed)', '', '| Month | M4.5+ | M6+ | dup_suspects |', '|---|---|---|---|');
    for (const x of built) for (const [m, c] of Object.entries(x.months!)) out.push(`| ${m} | ${c.n45} | ${c.m6} | ${c.dup} |`);
    out.push('');
  }
  if (r.waiting.length) out.push(`Waiting (days without an input): ${r.waiting.map((w) => `${w.year} (${w.missing})`).join(', ')}`, '');
  if (r.blocked.length) out.push('Blocked:', '', ...r.blocked.map((b) => `- ${b}`), '');
  out.push('## Ledger', '', '| Year | Through | Gate | M6+ feed / ComCat | M4.5+ feed / ComCat | Re-merged in memory | dup_suspects / n45 | Area bytes |', '|---|---|---|---|---|---|---|---|');
  for (const y of Object.keys(r.state.years).sort()) {
    const s = r.state.years[y]!;
    const c = s.check;
    out.push(`| ${y} | ${s.through} | ${c?.gate ?? '–'} | ${c ? `${c.feed.m6} / ${c.comcat?.m6 ?? '–'}` : '–'} | ${c ? `${c.feed.m45} / ${c.comcat?.m45 ?? '–'}` : '–'} | ${s.remerged_in_memory} | ${s.dup_suspects ? `${s.dup_suspects.count} / ${s.dup_suspects.n45} (${s.dup_suspects.ratio})` : '–'} | ${s.area?.bytes ?? '–'} |`);
  }
  out.push('');
  if (o.verify) {
    out.push('## Verify (per month against ComCat)', '', '| Month | Feed M4.5+ | ComCat M4.5+ | Ratio | Feed M6+ | ComCat M6+ | dup | OK |', '|---|---|---|---|---|---|---|---|');
    for (const v of o.verify) out.push(`| ${v.month} | ${v.feed.n45} | ${v.comcat?.m45 ?? '–'} | ${fmtRatio(v.ratio45)} | ${v.feed.m6} | ${v.comcat?.m6 ?? '–'} | ${v.feed.dup} | ${v.ok ? 'yes' : `no${v.note ? ` (${v.note})` : ''}`} |`);
    out.push('');
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const out = process.env.STATS_OUT ?? 'stats-out';
  const dryRun = process.env.STATS_DRY_RUN === '1';
  const verifyMode = (process.env.STATS_VERIFY ?? '').trim();
  if (verifyMode && verifyMode !== 'sample' && verifyMode !== 'full') throw new Error(`STATS_VERIFY must be '', sample or full, got ${verifyMode}`);
  const { config, warning } = loadStatsConfig();
  if (!config) throw new Error(`providers/stats.json: ${warning}`);
  if (!config.history_enabled && !dryRun) {
    console.log('stats: history_enabled is false in providers/stats.json: the stats builder does nothing (a dry run builds anyway)');
    setOutput('changed', 'false');
    return;
  }
  const nowMs = process.env.STATS_NOW ? Date.parse(process.env.STATS_NOW) : Date.now();
  const paths = dataPaths(DATA_DIR);
  const through = statsThrough(nowMs);
  const idx: InputIndex = {
    remediation: readJson<RemediationIndex>(paths.remediationIndex, emptyRemediationIndex()),
    partitions: partitionBlobs(DATA_DIR, through),
    archives: readJson<Archives>(paths.archivesIndex, { list: [] }).list,
    history: readJson<HistoryIndex | null>(join(paths.indexDir, 'history.json'), null),
  };
  const lookup = inputLookup(idx);
  const stateFile = join(DATA_DIR, STATS_STATE_PATH);
  const stateBytes = existsSync(stateFile) ? readFileSync(stateFile) : null;
  const state = stateBytes ? (JSON.parse(stateBytes.toString('utf8')) as StatsHistoryState) : emptyState(config.builder);
  const forced = new Set(
    (process.env.STATS_YEARS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );
  for (const y of forced) if (!Number.isInteger(y) || y < STATS_FIRST_YEAR) throw new Error(`STATS_YEARS: ${y} is not a year from ${STATS_FIRST_YEAR}`);
  const maxYears = Number(process.env.STATS_MAX_YEARS || config.max_years_per_run);
  const registry = loadRegistry();
  const usgs = registry.find((p) => p.id === 'usgs');
  if (!usgs) throw new Error('no usgs provider in the registry');
  const comcat = comcatCounter(usgs);
  const work = mkdtempSync(join(tmpdir(), 'efd-stats-'));
  const reader = new InputReader(ghStatsIo(DATA_DIR, work));
  console.log(`stats: through ${through}; epoch ${STATS_REMERGE_EPOCH} (config REMERGE_EPOCH ${REMERGE_EPOCH}); ${idx.partitions.size} frozen partition(s), ${idx.archives.length} archive month(s), ${idx.remediation.editions.length} remediation edition(s), ${idx.history?.editions.length ?? 0} history edition(s); max ${maxYears} year(s)${dryRun ? '; dry run' : ''}`);
  let res: RunResult;
  try {
    res = await runStatsHistory({
      nowMs,
      config,
      lookup,
      state,
      fileExists: (p) => existsSync(join(DATA_DIR, p)),
      forced,
      maxYears,
      budgetMs: config.budget_minutes * 60_000,
      reader,
      registry,
      comcat,
      runId: process.env.GITHUB_RUN_ID ?? null,
      log: (m) => console.log(m),
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Verify: the per-month table against ComCat.
  let verify: VerifyRow[] | null = null;
  if (verifyMode) {
    verify = [];
    const all = Object.values(res.state.years).flatMap((s) => Object.keys(s.months ?? {}));
    const counts = new Map<string, MonthCounts>();
    for (const s of Object.values(res.state.years)) for (const [m, c] of Object.entries(s.months ?? {})) counts.set(m, c);
    const openMonth = res.through.slice(0, 7);
    for (const m of verifyMonths(all, verifyMode as 'sample' | 'full', Number(process.env.GITHUB_RUN_ID ?? 1))) {
      const [y, mo] = m.split('-').map(Number);
      const s = Date.UTC(y!, mo! - 1, 1);
      const e = Math.min(Date.UTC(y!, mo!, 1), dayStartMs(dayShift(res.through, 1)));
      const bands = y! < 2000 ? config.gate.eraB : config.gate.default;
      try {
        const c = { m45: await comcat(s, e, 4.5), m6: await comcat(s, e, 6) };
        // A month not settled yet: its last day is within LATE_USGS_MAX_AGE_DAYS of `through`.
        const settling = dayShift(eventDayKey(e - DAY), LATE_USGS_MAX_AGE_DAYS) > res.through;
        verify.push(verifyRow(m, counts.get(m)!, c, bands, m === openMonth, settling));
      } catch (err) {
        verify.push({ month: m, feed: counts.get(m)!, comcat: null, ratio45: null, ok: false, note: `ComCat: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}` });
      }
    }
    const bad = verify.filter((v) => !v.ok);
    if (bad.length) res.blocked.push(`stats-verify-failed: ${bad.length} of ${verify.length} month(s) off ComCat: ${bad.slice(0, 6).map((v) => `${v.month} (${v.note})`).join('; ')}`);
  }

  // Outputs: the full v1/stats/{area,year} and knowledge/stats trees as they must be on `data`.
  mkdirSync(out, { recursive: true });
  for (const kind of ['area', 'year']) {
    const src = join(DATA_DIR, STATS_DIR, kind);
    const dst = join(out, STATS_DIR, kind);
    mkdirSync(dst, { recursive: true });
    if (existsSync(src)) for (const f of readdirSync(src)) if (f.endsWith('.json')) writeFileSync(join(dst, f), readFileSync(join(src, f)));
  }
  for (const [p, body] of res.writes) {
    mkdirSync(dirname(join(out, p)), { recursive: true });
    writeFileSync(join(out, p), body);
  }
  for (const p of res.removes) rmSync(join(out, p), { force: true });
  mkdirSync(join(out, 'knowledge', 'stats'), { recursive: true });
  writeFileSync(join(out, STATS_STATE_PATH), stateText(res.state));
  writeFileSync(join(out, 'base.json'), JSON.stringify({ state_sha256: stateBytes ? sha256Hex(stateBytes) : null }) + '\n');
  const md = reportMarkdown(res, { dryRun, verify, ms: Date.now() - t0, downloads: reader.downloads });
  writeFileSync(join(out, 'report.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  if (res.blocked.length) writeFileSync('stats-blocked.txt', res.blocked.join('\n') + '\n');
  setOutput('changed', String(res.changed));
  console.log(`stats: ${res.changed ? 'changed' : 'nothing to do'}; ${res.writes.size} file(s) written, ${res.removes.length} removed, ${res.blocked.length} blocked line(s), ${Math.round((Date.now() - t0) / 1000)} s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('stats builder failed:', err);
    process.exit(1);
  });
}
