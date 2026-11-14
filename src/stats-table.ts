import { outsideAuthority } from './authority.js';
import { gatherCellKeys, gridKey, haversineKm } from './geo.js';
import { reviewStatusOfRow } from './review-status.js';
import type { Extra } from './types.js';

/**
 * Statistics tables (format 1, APIs.md "Statistics"): the columnar event tables the app's Statistics screen reads
 * instead of whole day files or ComCat. Pure: no I/O, no clock. The same features give the same bytes, so a day table's
 * sha256 changes only when its events do. Shared by derive (the 61 day tables, src/stats.ts) and by the year and area
 * builder (stats.yml), which injects its own I/O.
 *
 * Integer scales are fixed by `format: 1` (lat/lon x 1e4, mag x 100, depth km x 100, intensity x 10, rms x 1000); every
 * scaled value is `Math.round(value * scale)` (half toward +infinity), and every comparison on a threshold (M 4.5, M 5,
 * M 6) is made on the scaled integer, on the feed and in the app alike. A new optional column keeps format 1; an
 * incompatible change is a new directory and the manifest key `stats2`.
 */

export const STATS_FORMAT = 1;
/** Day tables published by derive: today - 60 .. today (UTC). */
export const STATS_DAYS = 61;
/** The year and area builder's version (providers/stats.json `builder`, the one the builder reads; tests keep the two
 *  equal): bumping it rebuilds every year (stats.yml). 2: the statistical reconciliation. 3: `collapsed_into` in the
 *  year M5+ and area M6+ tables (share links). */
export const STATS_BUILDER_VERSION = 3;
/** Every stats product lives under this path, on Pages and (year and area files) on the `data` branch. */
export const STATS_DIR = 'v1/stats';
/** The app's "revised later" line (StatisticsLogic.revisionDelay): `updated - time` strictly above one hour. */
export const REVISION_DELAY_MS = 3_600_000;
/** The app's plausible magnitude range (StatisticsLogic.magnitudeRange). */
export const MAG_MIN = -2;
export const MAG_MAX = 10.5;
/** Lower edges (mag x 100) of the year bins: <2, [2,2.5), [2.5,3), [3,3.5), [3.5,4), [4,4.5), [4.5,5), [5,6), [6,7), >=7.
 *  The app's `StatisticsLogic.yearThresholds` [2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7]: `atLeast[t]` is the sum of the bins
 *  whose lower edge is >= t. */
export const MAG_EDGES_E2 = [200, 250, 300, 350, 400, 450, 500, 600, 700] as const;
/** Area grid: 0.1-degree cells, row-major from the south pole and the antimeridian. */
export const CELL_DEG = 0.1;
export const CELL_ROWS = 1800;
export const CELL_COLS = 3600;
export const CELL_COUNT = CELL_ROWS * CELL_COLS;
/** A feed id (feature id == feed.feed_id): `efd_` + a ULID. */
export const FEED_ID_RE = /^efd_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The licence line every stats file carries (the tables are adapted from the feed's events). */
export const STATS_ATTRIBUTION =
  'Statistics adapted from earthquakes-feed (https://earthquakes-feed.theshelter.app), CDLA-Permissive-2.0 compilation. ' +
  "Each row is a feed event: its sources, their licences and attributions are in that event's properties.feed.provenance[] " +
  '(day files, NDJSON partitions, archives, history editions). Sources include USGS/ANSS (public domain), EMSC/CSEM and FDSN ' +
  'networks (CC-BY-4.0); events before 2000 are USGS ComCat (public domain). See ATTRIBUTIONS.md.';

const DAY_MS = 86_400_000;

/** The bin (0..9) of a scaled magnitude: the number of MAG_EDGES_E2 at or below it. */
export function magBin(magE2: number): number {
  let i = 0;
  while (i < MAG_EDGES_E2.length && magE2 >= MAG_EDGES_E2[i]!) i++;
  return i;
}

/**
 * The 0.1-degree cell of a scaled position (integers only, so the feed and any reader agree): row from the south pole
 * (lat 90 joins the top row), column from the antimeridian (lon 180 wraps to column 0).
 */
export function cellOf(latE4: number, lonE4: number): number {
  const row = Math.min(CELL_ROWS - 1, Math.max(0, Math.floor((latE4 + 900_000) / 1000)));
  const col = Math.floor((((lonE4 + 1_800_000) % 3_600_000) + 3_600_000) % 3_600_000 / 1000);
  return row * CELL_COLS + col;
}

/** The centre of a cell, in degrees. */
export function cellCentre(cell: number): { lat: number; lon: number } {
  const row = Math.floor(cell / CELL_COLS);
  const col = cell % CELL_COLS;
  return { lat: -90 + (row + 0.5) * CELL_DEG, lon: -180 + (col + 0.5) * CELL_DEG };
}

/**
 * Event types the Statistics screen leaves out of the earthquake counts: a word-for-word port of the app's
 * `StatisticsLogic.isNonEarthquake` (EMSC / QuakeML codes for known or suspected explosions, rock bursts, quarry blasts,
 * landslides and sonic booms, and the words for the other kinds). Only spaces and tabs are trimmed, as Swift's
 * `.whitespaces` does.
 */
const NON_EARTHQUAKE_CODES: ReadonlySet<string> = new Set(['km', 'sm', 'kx', 'sx', 'kn', 'sn', 'kr', 'sr', 'qb', 'ls', 'sb']);
const NON_EARTHQUAKE_WORDS = [
  'blast', 'explosion', 'quarry', 'mining', 'mine collapse', 'rock burst', 'rockburst', 'ice quake', 'icequake',
  'landslide', 'rockslide', 'rock slide', 'sonic boom', 'collapse', 'avalanche', 'meteor', 'acoustic noise',
  'not existing', 'other event', 'volcanic eruption',
] as const;

export function isNonEarthquake(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  const t = type.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, '').toLowerCase();
  if (!t) return false;
  if (NON_EARTHQUAKE_CODES.has(t)) return true;
  return NON_EARTHQUAKE_WORDS.some((w) => t.includes(w));
}

/** One event as the tables store it: every value already on its integer scale. */
export interface StatsEvent {
  id: string;
  timeMs: number;
  latE4: number;
  lonE4: number;
  magE2: number;
  depthE2: number | null;
  place: string | null;
  provider: string;
  felt: number | null;
  intensityE1: number | null;
  alert: string | null;
  tsunami: 0 | 1;
  status: 0 | 1 | null;
  upd: 0 | 1 | null;
  nst: number | null;
  rmsE3: number | null;
  delay: number | null;
  /** The providers of the event's provenance rows, sorted and unique (the reconciliation's input; never a column). */
  sources: string[];
}

export type StatsRow = { kind: 'filtered'; timeMs: number } | { kind: 'skip' } | { kind: 'event'; ev: StatsEvent };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const scaled = (v: unknown, k: number): number | null => (finite(v) ? Math.round(v * k) : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The row rule (APIs.md, Statistics): what one full-fat feature contributes to a table.
 * - null: not a live event (superseded, tombstoned);
 * - filtered: a named non-earthquake (isNonEarthquake), counted by time only;
 * - skip: no usable magnitude (null or outside [-2, 10.5]), no valid position, or the 0,0 M0 placeholder;
 * - event: the row, with `status` from the chosen provenance row (reviewStatusOfRow: 1 reviewed, 0 automatic, null not
 *   said), `upd` = updated - time > 1 h, `delay` = first ingest - time in seconds.
 */
export function statsEventOf(feature: unknown): StatsRow | null {
  if (!isObj(feature)) return null;
  const p = isObj(feature['properties']) ? feature['properties'] : {};
  const feed = isObj(p['feed']) ? p['feed'] : {};
  if (feed['state'] !== 'live' || feed['tombstone'] === true) return null;
  const timeMs = p['time'];
  const id = typeof feature['id'] === 'string' ? feature['id'] : typeof feed['feed_id'] === 'string' ? feed['feed_id'] : null;
  if (!finite(timeMs) || id == null) return { kind: 'skip' };
  if (isNonEarthquake(p['type'])) return { kind: 'filtered', timeMs: Math.round(timeMs) };
  const mag = p['mag'];
  if (!finite(mag) || mag < MAG_MIN || mag > MAG_MAX) return { kind: 'skip' };
  const geom = isObj(feature['geometry']) ? feature['geometry'] : {};
  const coords = Array.isArray(geom['coordinates']) ? (geom['coordinates'] as unknown[]) : [];
  const lon = coords[0];
  const lat = coords[1];
  if (!finite(lat) || !finite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return { kind: 'skip' };
  if (lat === 0 && lon === 0 && mag === 0) return { kind: 'skip' };

  const provider = text(feed['chosen_provider']) ?? text(feature['source']) ?? 'unknown';
  const prov = Array.isArray(feed['provenance']) ? (feed['provenance'] as unknown[]).filter(isObj) : [];
  const chosen = prov.find((r) => r['chosen'] === true) ?? prov[0];
  const rs = chosen
    ? reviewStatusOfRow({
        provider: String(chosen['provider'] ?? provider),
        status: typeof chosen['status'] === 'string' ? chosen['status'] : null,
        fields: (isObj(chosen['fields']) ? chosen['fields'] : {}) as Extra,
      })
    : reviewStatusOfRow({ provider, status: typeof p['status'] === 'string' ? p['status'] : null, fields: {} });
  const updated = p['updated'];
  const firstIngest = typeof feed['first_ingest_time'] === 'string' ? Date.parse(feed['first_ingest_time']) : NaN;
  const intensity = finite(p['mmi']) ? p['mmi'] : finite(p['cdi']) ? p['cdi'] : null;
  return {
    kind: 'event',
    ev: {
      id,
      timeMs: Math.round(timeMs),
      latE4: Math.round(lat * 1e4),
      lonE4: Math.round(lon * 1e4),
      magE2: Math.round(mag * 100),
      depthE2: scaled(coords[2], 100),
      place: text(p['place']),
      provider,
      felt: scaled(p['felt'], 1),
      intensityE1: scaled(intensity, 10),
      alert: text(p['alert']),
      tsunami: finite(Number(p['tsunami'])) && Number(p['tsunami']) > 0 ? 1 : 0,
      status: rs === 'reviewed' ? 1 : rs === 'automatic' ? 0 : null,
      upd: finite(updated) ? (updated - timeMs > REVISION_DELAY_MS ? 1 : 0) : null,
      nst: scaled(p['nst'], 1),
      rmsE3: scaled(p['rms'], 1000),
      delay: Number.isFinite(firstIngest) ? Math.round((firstIngest - timeMs) / 1000) : null,
      sources: [...new Set(prov.map((r) => String(r['provider'] ?? '')).filter(Boolean))].sort(),
    },
  };
}

/** The optional columns, in their fixed order. An absent column means all null. */
export const OPTIONAL_COLUMNS = ['depth', 'place', 'prov', 'felt', 'intensity', 'alert', 'tsunami', 'status', 'upd', 'nst', 'rms', 'delay'] as const;
export type StatsColumn = (typeof OPTIONAL_COLUMNS)[number];
export type TableKind = 'day' | 'year' | 'area';
/** Which optional columns each kind carries (APIs.md, Statistics). */
export const DAY_COLUMNS: readonly StatsColumn[] = OPTIONAL_COLUMNS;
export const YEAR_COLUMNS: readonly StatsColumn[] = OPTIONAL_COLUMNS.filter((c) => c !== 'delay');
export const AREA_COLUMNS: readonly StatsColumn[] = ['depth', 'place', 'prov'];

/** The event table (format 1): rows sorted by (time, id), times as ms deltas from t0, providers indexed by `prov`. */
export interface EventTable {
  format: number;
  kind: TableKind;
  t0: number;
  count: number;
  providers: string[];
  id: string[];
  t: number[];
  lat: number[];
  lon: number[];
  mag: number[];
  depth?: (number | null)[];
  place?: (string | null)[];
  prov?: number[];
  felt?: (number | null)[];
  intensity?: (number | null)[];
  alert?: (string | null)[];
  tsunami?: (0 | 1)[];
  status?: (0 | 1 | null)[];
  upd?: (0 | 1 | null)[];
  nst?: (number | null)[];
  rms?: (number | null)[];
  delay?: (number | null)[];
  /** Feed ids the reconciliation collapsed -> their representative's id (share links: a shared id that was folded
   *  still resolves). Day tables: every collapsed row of the day. Year and area tables: every collapsed row of the
   *  year whose representative is at or above the table's magnitude floor. Keys in feed-id order. */
  collapsed_into?: Record<string, string>;
}

/** The `collapsed_into` member of a table: the pairs as an object, keys in feed-id order (stable bytes). */
export function collapsedIntoObject(pairs: Iterable<readonly [string, string]>): Record<string, string> {
  return Object.fromEntries([...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export const compareEvents = (a: StatsEvent, b: StatsEvent): number => a.timeMs - b.timeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The event table of `rows` with the optional `columns` (in OPTIONAL_COLUMNS order whatever order they are given in)
 * and, when given, `collapsed_into` after them. `t0` must be at or before the earliest row. The object's key order is
 * the file's.
 */
export function buildEventTable(
  kind: TableKind,
  t0: number,
  rows: readonly StatsEvent[],
  columns: readonly StatsColumn[],
  collapsedInto?: Iterable<readonly [string, string]>,
): EventTable {
  const sorted = [...rows].sort(compareEvents);
  if (sorted.length && sorted[0]!.timeMs < t0) throw new Error(`stats table: a row at ${sorted[0]!.timeMs} is before t0 ${t0}`);
  const providers = [...new Set(sorted.map((r) => r.provider))].sort();
  const pIndex = new Map(providers.map((p, i) => [p, i]));
  let prev = t0;
  const table: EventTable = {
    format: STATS_FORMAT,
    kind,
    t0,
    count: sorted.length,
    providers,
    id: sorted.map((r) => r.id),
    t: sorted.map((r) => {
      const d = r.timeMs - prev;
      prev = r.timeMs;
      return d;
    }),
    lat: sorted.map((r) => r.latE4),
    lon: sorted.map((r) => r.lonE4),
    mag: sorted.map((r) => r.magE2),
  };
  const want = new Set(columns);
  for (const c of OPTIONAL_COLUMNS) {
    if (!want.has(c)) continue;
    switch (c) {
      case 'depth': table.depth = sorted.map((r) => r.depthE2); break;
      case 'place': table.place = sorted.map((r) => r.place); break;
      case 'prov': table.prov = sorted.map((r) => pIndex.get(r.provider)!); break;
      case 'felt': table.felt = sorted.map((r) => r.felt); break;
      case 'intensity': table.intensity = sorted.map((r) => r.intensityE1); break;
      case 'alert': table.alert = sorted.map((r) => r.alert); break;
      case 'tsunami': table.tsunami = sorted.map((r) => r.tsunami); break;
      case 'status': table.status = sorted.map((r) => r.status); break;
      case 'upd': table.upd = sorted.map((r) => r.upd); break;
      case 'nst': table.nst = sorted.map((r) => r.nst); break;
      case 'rms': table.rms = sorted.map((r) => r.rmsE3); break;
      case 'delay': table.delay = sorted.map((r) => r.delay); break;
    }
  }
  if (collapsedInto) table.collapsed_into = collapsedIntoObject(collapsedInto);
  return table;
}

/** The absolute times of a table's rows (the reader's side of the `t` deltas). */
export function tableTimes(table: Pick<EventTable, 't0' | 't'>): number[] {
  let at = table.t0;
  return table.t.map((d) => (at += d));
}

/** A day table `v1/stats/days/<date>.json`: the event table of kind "day" plus the day's filtered and skipped counts. */
export interface DayTable extends EventTable {
  date: string;
  /** Times of the filtered (non-earthquake) live events, ms from t0 (not cumulative), ascending. */
  filtered: number[];
  skipped: number;
  attribution: string;
}

export interface DayTableResult {
  body: string;
  count: number;
  filtered: number;
  skipped: number;
  /** Rows left out by the statistical reconciliation (reconcileRows): collapsed into another row, or out of region. */
  collapsed: number;
  out_of_region: number;
}

export const dayStartMs = (date: string): number => Date.parse(`${date}T00:00:00Z`);
export const dayTablePath = (date: string): string => `${STATS_DIR}/days/${date}.json`;

/** One UTC day's rows before the reconciliation: what the day table is serialized from. */
export interface DayRows {
  date: string;
  rows: StatsEvent[];
  /** Times of the filtered events, ms from the day's start. */
  filtered: number[];
  skipped: number;
}

/**
 * The rows of one UTC day from that day's full-fat features (any states, any order). A feature of another day is an
 * error (the caller passes one day's partition).
 */
export function dayRows(date: string, features: Iterable<unknown>): DayRows {
  const t0 = dayStartMs(date);
  if (!Number.isFinite(t0)) throw new Error(`stats day table: bad date ${date}`);
  const rows: StatsEvent[] = [];
  const filtered: number[] = [];
  let skipped = 0;
  for (const f of features) {
    const r = statsEventOf(f);
    if (r == null) continue;
    if (r.kind === 'skip') {
      skipped++;
      continue;
    }
    const at = r.kind === 'filtered' ? r.timeMs : r.ev.timeMs;
    if (at < t0 || at >= t0 + DAY_MS) throw new Error(`stats day table ${date}: an event at ${new Date(at).toISOString()} is of another day`);
    if (r.kind === 'filtered') filtered.push(at - t0);
    else rows.push(r.ev);
  }
  return { date, rows, filtered: filtered.sort((a, b) => a - b), skipped };
}

/**
 * The day table `v1/stats/days/<date>.json` of a day's rows, without the rows the reconciliation dropped (`dropped`,
 * feed ids): the bytes and the counts the index lists. Invariant: count + filtered + skipped + collapsed + out_of_region
 * = the day's live, non-tombstoned features. `collapsed_into` names every collapsed row's representative (its row is in
 * this day's table or, across midnight, the neighbouring day's).
 */
export function dayTableFromRows(d: DayRows, rec: Reconciliation = EMPTY_RECONCILIATION): DayTableResult {
  const t0 = dayStartMs(d.date);
  let outOfRegion = 0;
  const into: [string, string][] = [];
  const kept = d.rows.filter((r) => {
    const rep = rec.dropped.get(r.id);
    if (rec.outOfRegion.has(r.id)) outOfRegion++;
    else if (rep != null) into.push([r.id, rep]);
    else return true;
    return false;
  });
  const collapsed = into.length;
  const table = buildEventTable('day', t0, kept, DAY_COLUMNS, into);
  // Key order of the file: format, kind, date, then the table, then the day's extras.
  const { format, kind, ...rest } = table;
  const day = { format, kind, date: d.date, ...rest, filtered: d.filtered, skipped: d.skipped, collapsed, out_of_region: outOfRegion, attribution: STATS_ATTRIBUTION };
  return { body: JSON.stringify(day), count: table.count, filtered: d.filtered.length, skipped: d.skipped, collapsed, out_of_region: outOfRegion };
}

/** The day table of one day's features, reconciled within the day only (derive reconciles across its whole window
 *  first: writeStats). */
export function dayTableJson(date: string, features: Iterable<unknown>, priority: ReadonlyMap<string, number> = new Map()): DayTableResult {
  const d = dayRows(date, features);
  return dayTableFromRows(d, reconcileRows(d.rows, priority));
}

// --- the statistical reconciliation (APIs.md, Statistics: "Reconciliation") ---

/** The rule's version, named in the files (`reconciled.rule`) and in the stats builder's digest. */
export const RECONCILE_RULE = 'v3';
export const RECONCILE_DT_MS = 60_000;
export const RECONCILE_KM = 100;
/** |delta mag| x 100 at most. */
export const RECONCILE_DMAG_E2 = 100;
/** The great-quake tier (rule v2): a pair whose larger magnitude is M7.0+ (x 100) links up to |delta mag| 1.5 and
 *  200 km (agencies' locations and magnitudes of a great quake scatter more). */
export const RECONCILE_GREAT_E2 = 700;
export const RECONCILE_GREAT_KM = 200;
export const RECONCILE_GREAT_DMAG_E2 = 150;
/** A pair links only when one of the two is M4.5+ (x 100). */
export const RECONCILE_MIN_E2 = 450;
/** Rows below this (x 100) can never link: RECONCILE_MIN_E2 - RECONCILE_DMAG_E2 (a great-quake partner is at least
 *  M5.5). */
export const RECONCILE_CANDIDATE_E2 = RECONCILE_MIN_E2 - RECONCILE_DMAG_E2;
const RECONCILE_CELL_DEG = 1;

/** What the reconciliation leaves out: rows collapsed into their group's representative (id -> representative id) and
 *  rows outside every reporting catalogue's authoritative region (rule v3). */
export interface Reconciliation {
  dropped: ReadonlyMap<string, string>;
  outOfRegion: ReadonlySet<string>;
}
export const EMPTY_RECONCILIATION: Reconciliation = { dropped: new Map(), outOfRegion: new Set() };

/**
 * The authoritative-region filter (rule v3, ComCat's own practice: a regional network is authoritative for its own
 * region, a global network everywhere): an M4.5+ row is out of region when none of its provenance providers is a global
 * network (STATS_GLOBAL_PROVIDERS) and its epicentre lies outside the region (AUTHORITY_REGIONS, by catalogue, plus
 * STATS_REGION_MARGIN_DEG on every side) of every provider that reported it. A provider with no region is treated as
 * global. A row holding a `usgs` row is therefore never out of region; nothing below M4.5 ever is. The test is
 * authority.ts outsideAuthority, the one the Resolver's authoritative-region window (epoch 2) uses too.
 */
export function isOutOfRegion(ev: Pick<StatsEvent, 'magE2' | 'latE4' | 'lonE4' | 'sources'>): boolean {
  if (ev.magE2 < RECONCILE_MIN_E2) return false;
  return outsideAuthority(ev.sources, ev.latE4 / 1e4, ev.lonE4 / 1e4);
}

/**
 * The statistical reconciliation (statistics products only; the feed's own dedup stays the event identity and the live
 * map is untouched): a catalogue-level collapse of the reports of one quake that the feed still keeps as several events.
 * Two rows link when they share no provenance provider (a provider's own catalogue is self-consistent), their origin
 * times are within 60 s, their epicentres within 100 km, their magnitudes within 1.0, and one of them is M4.5+ (all on
 * the scaled integers); rule v2: when the larger of the two is M7.0+, within 200 km and 1.5 magnitude units. Links are taken closest first (time gap, then distance, then ids) and join two groups only while
 * the groups still share no provider (single link under that constraint). Each group keeps one representative: the
 * member holding a `usgs` provenance row (ComCat's magnitude is the reference), else the member whose chosen provider
 * ranks first in the feed's provider priority (`priority`, lower first, as the Resolver ranks), then the earliest origin,
 * then the smallest id. Before linking, rows out of region (isOutOfRegion, rule v3) are left out. Returns the rows
 * left out: collapsed (id -> its representative's id) and out of region. O(n log n): a time-sorted sweep with
 * 1-degree cells (gatherCellKeys). Rows of context (outside the caller's unit) take part like any other; the caller
 * counts only its own.
 */
export function reconcileRows(rows: readonly StatsEvent[], priority: ReadonlyMap<string, number>): Reconciliation {
  const outOfRegion = new Set<string>();
  for (const r of rows) if (isOutOfRegion(r)) outOfRegion.add(r.id);
  const cand = rows.filter((r) => r.magE2 >= RECONCILE_CANDIDATE_E2 && !outOfRegion.has(r.id)).sort(compareEvents);
  const n = cand.length;
  const out = new Map<string, string>();
  if (n < 2) return { dropped: out, outOfRegion };
  const lat = cand.map((r) => r.latE4 / 1e4);
  const lon = cand.map((r) => r.lonE4 / 1e4);
  const key = cand.map((_, i) => gridKey(lat[i]!, lon[i]!, RECONCILE_CELL_DEG));
  const cells = new Map<string, number[]>();
  const edges: { dt: number; km: number; a: number; b: number }[] = [];
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const x = cand[i]!;
    while (cand[lo]!.timeMs < x.timeMs - RECONCILE_DT_MS) {
      const list = cells.get(key[lo]!)!;
      list.splice(list.indexOf(lo), 1);
      lo++;
    }
    // A row that may pair with a great quake (M5.5+) looks as far as the great-quake tier.
    const reach = x.magE2 >= RECONCILE_GREAT_E2 - RECONCILE_GREAT_DMAG_E2 ? RECONCILE_GREAT_KM : RECONCILE_KM;
    for (const k of gatherCellKeys(lat[i]!, lon[i]!, reach, RECONCILE_CELL_DEG)) {
      for (const j of cells.get(k) ?? []) {
        const y = cand[j]!;
        const top = Math.max(x.magE2, y.magE2);
        const great = top >= RECONCILE_GREAT_E2;
        if (Math.abs(x.magE2 - y.magE2) > (great ? RECONCILE_GREAT_DMAG_E2 : RECONCILE_DMAG_E2) || top < RECONCILE_MIN_E2) continue;
        if (x.sources.some((p) => y.sources.includes(p))) continue;
        const km = haversineKm(lat[i]!, lon[i]!, lat[j]!, lon[j]!);
        if (km > (great ? RECONCILE_GREAT_KM : RECONCILE_KM)) continue;
        edges.push({ dt: x.timeMs - y.timeMs, km, a: j, b: i });
      }
    }
    if (!cells.has(key[i]!)) cells.set(key[i]!, []);
    cells.get(key[i]!)!.push(i);
  }
  if (!edges.length) return { dropped: out, outOfRegion };
  const id = (i: number): string => cand[i]!.id;
  edges.sort((p, q) => p.dt - q.dt || p.km - q.km || (id(p.a) < id(q.a) ? -1 : id(p.a) > id(q.a) ? 1 : id(p.b) < id(q.b) ? -1 : id(p.b) > id(q.b) ? 1 : 0));
  const parent = cand.map((_, i) => i);
  const srcs = cand.map((r) => new Set(r.sources));
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  for (const e of edges) {
    let ra = find(e.a);
    let rb = find(e.b);
    if (ra === rb) continue;
    const sa = srcs[ra]!;
    const sb = srcs[rb]!;
    let shared = false;
    for (const p of sb) if (sa.has(p)) shared = true;
    if (shared) continue;
    if (sa.size < sb.size) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    for (const p of srcs[rb]!) srcs[ra]!.add(p);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }
  const rank = (p: string): number => priority.get(p) ?? 9999;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ms = members.map((i) => cand[i]!);
    ms.sort((a, b) => {
      const ua = a.sources.includes('usgs') ? 0 : 1;
      const ub = b.sources.includes('usgs') ? 0 : 1;
      return ua - ub || rank(a.provider) - rank(b.provider) || compareEvents(a, b);
    });
    const rep = ms[0]!.id;
    for (const m of ms.slice(1)) out.set(m.id, rep);
  }
  return { dropped: out, outOfRegion };
}

/** Parses an NDJSON partition's text into features (blank lines ignored). */
export function parseNdjson(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) if (line) out.push(JSON.parse(line));
  return out;
}
