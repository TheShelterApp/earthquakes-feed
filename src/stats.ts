import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { DOMAIN, SCHEMA_DIR, SCHEMA_VERSION } from './config.js';
import { eventDayKey, writeIfChanged } from './bitemporal.js';
import { dayPartitionFile } from './partitions.js';
import {
  CELL_COUNT,
  FEED_ID_RE,
  STATS_ATTRIBUTION,
  STATS_DAYS,
  STATS_DIR,
  STATS_FORMAT,
  OPTIONAL_COLUMNS,
  dayStartMs,
  dayTableJson,
  dayTablePath,
  parseNdjson,
  type DayTableResult,
} from './stats-table.js';
import { isoFromMs } from './util.js';

/**
 * Statistics products, derive's part (APIs.md, Statistics): every run writes the 61 day tables (today - 60 .. today),
 * copies the year and area files the stats builder committed on `data` (verified against its ledger), writes
 * `v1/stats/index.json` and checks all of it. Nothing here may block the live feed: derive runs it through `safeStats`,
 * which drops the stats of the run (no files, no pointer) on any throw, a failed check or a run past the budget.
 */

export type DerivePublish = 'off' | 'shadow' | 'on';
export const DERIVE_PUBLISH_MODES: readonly DerivePublish[] = ['off', 'shadow', 'on'];

export interface StatsEpoch {
  from: string;
  to: string | null;
  key: string;
  min_mag?: number;
}

/** `providers/stats.json`. */
export interface StatsConfig {
  derive_publish: DerivePublish;
  history_enabled: boolean;
  builder: number;
  derive_budget_ms: number;
  max_years_per_run: number;
  budget_minutes: number;
  epochs: StatsEpoch[];
  gate: {
    eraB: { m6: [number, number]; m45: [number, number] };
    default: { m6: [number, number]; m45: [number, number] };
    current_year: 'warn' | 'gate';
  };
}

export const STATS_CONFIG_PATH = process.env.STATS_CONFIG ?? 'providers/stats.json';
export const STATS_INDEX_PATH = `${STATS_DIR}/index.json`;
export const STATS_STATE_PATH = 'knowledge/stats/state.json';
/** derive's guard when the config does not name one. */
export const DEFAULT_DERIVE_BUDGET_MS = 10_000;

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const pair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) && v[0] <= v[1];

/** Parses `providers/stats.json`; throws with the first problem found. */
export function parseStatsConfig(json: unknown): StatsConfig {
  if (!isObj(json)) throw new Error('not an object');
  const mode = json['derive_publish'];
  if (!DERIVE_PUBLISH_MODES.includes(mode as DerivePublish)) throw new Error(`derive_publish must be one of ${DERIVE_PUBLISH_MODES.join(', ')}, got ${JSON.stringify(mode)}`);
  if (typeof json['history_enabled'] !== 'boolean') throw new Error('history_enabled must be a boolean');
  for (const k of ['builder', 'max_years_per_run', 'budget_minutes'] as const) {
    if (!Number.isInteger(json[k]) || (json[k] as number) < 1) throw new Error(`${k} must be a positive integer`);
  }
  const budget = json['derive_budget_ms'] ?? DEFAULT_DERIVE_BUDGET_MS;
  if (!Number.isInteger(budget) || (budget as number) < 1) throw new Error('derive_budget_ms must be a positive integer');
  const epochs = json['epochs'];
  if (!Array.isArray(epochs) || epochs.length === 0) throw new Error('epochs must be a non-empty list');
  epochs.forEach((e, i) => {
    if (!isObj(e) || typeof e['key'] !== 'string' || !DATE_RE.test(String(e['from'])) || !(e['to'] === null || DATE_RE.test(String(e['to'])))) {
      throw new Error(`epochs[${i}] needs key, from and to (a date or null)`);
    }
    if (e['min_mag'] !== undefined && typeof e['min_mag'] !== 'number') throw new Error(`epochs[${i}].min_mag must be a number`);
    if (i > 0 && (epochs[i - 1] as StatsEpoch).to !== e['from']) throw new Error(`epochs[${i}] does not start where epochs[${i - 1}] ends`);
    if (e['to'] === null && i !== epochs.length - 1) throw new Error(`epochs[${i}]: only the last epoch is open`);
  });
  const gate = json['gate'];
  if (!isObj(gate) || !isObj(gate['eraB']) || !isObj(gate['default'])) throw new Error('gate needs eraB and default');
  for (const g of ['eraB', 'default'] as const) {
    const t = gate[g] as Record<string, unknown>;
    if (!pair(t['m6']) || !pair(t['m45'])) throw new Error(`gate.${g} needs m6 and m45 as [low, high]`);
  }
  if (gate['current_year'] !== 'warn' && gate['current_year'] !== 'gate') throw new Error('gate.current_year must be "warn" or "gate"');
  return { ...(json as unknown as StatsConfig), derive_budget_ms: budget as number };
}

/**
 * derive's mode and the config: from `providers/stats.json`; a missing or invalid file means "off" with a warning (the
 * live feed never depends on it). `STATS_PUBLISH` overrides the mode for a local run only (the workflows never set it).
 */
export function loadStatsConfig(path = STATS_CONFIG_PATH, env: NodeJS.ProcessEnv = process.env): { mode: DerivePublish; config: StatsConfig | null; warning: string | null } {
  let config: StatsConfig | null = null;
  let warning: string | null = null;
  try {
    config = parseStatsConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    warning = `${path} ${existsSync(path) ? `is invalid (${err instanceof Error ? err.message : String(err)})` : 'is missing'}: stats off`;
  }
  let mode: DerivePublish = config?.derive_publish ?? 'off';
  const override = env['STATS_PUBLISH'];
  if (override && config) {
    if (DERIVE_PUBLISH_MODES.includes(override as DerivePublish)) mode = override as DerivePublish;
    else warning = `STATS_PUBLISH=${override} is not one of ${DERIVE_PUBLISH_MODES.join(', ')}: ignored`;
  }
  return { mode, config, warning };
}

/** The UTC days of the day tables at `nowMs`, oldest first: today - 60 .. today. */
export function statsDays(nowMs: number): string[] {
  const last = dayStartMs(eventDayKey(nowMs));
  const out: string[] = [];
  for (let i = STATS_DAYS - 1; i >= 0; i--) out.push(eventDayKey(last - i * DAY_MS));
  return out;
}

export interface StatsIndexDay {
  date: string;
  path: string;
  count: number;
  filtered: number;
  bytes: number;
  sha256: string;
}
export interface StatsIndexYear {
  year: number;
  path: string;
  bytes: number;
  sha256: string;
  first: string;
  through: string;
  complete: boolean;
  mirrorable: true;
}
export interface StatsIndexArea {
  year: number;
  path: string;
  bytes: number;
  sha256: string;
  min_mag: number | null;
  records: number;
  m6: number;
  complete: boolean;
  mirrorable: true;
}
export interface StatsIndex {
  schema_version: number;
  format: number;
  generated: number;
  generated_iso: string;
  head_seq: number;
  days: StatsIndexDay[];
  missing_days: string[];
  through: string | null;
  years: StatsIndexYear[];
  area: StatsIndexArea[];
  completeness: StatsEpoch[];
  attribution: string;
}
/** The v1 manifest's `stats` pointer. */
export interface StatsPointer {
  path: string;
  url: string;
  head_seq: number;
  format: number;
}

/** The stats builder's ledger on `data` (stats.yml writes it; derive reads `through` and the sha256 of each file). */
export interface StatsStateFile {
  bytes: number;
  sha256: string;
}
export interface StatsState {
  version: number;
  builder?: number;
  through?: string | null;
  years?: Record<string, { inputs_digest?: string; area?: StatsStateFile; year?: StatsStateFile; error?: string } & Record<string, unknown>>;
}

export interface StatsWrite {
  index: StatsIndex;
  pointer: StatsPointer;
  /** Problems found by checkStats after the write: any one drops the run's stats. */
  errors: string[];
  /** Days read back from the data checkout's partitions (the event map holds 45 days). */
  fromData: string[];
  /** Year and area files listed by the ledger but not published (missing, or not the bytes it names). */
  dropped: string[];
  /** Bytes of every file under v1/stats, the index included. */
  bytes: number;
  ms: number;
}

const sha256Hex = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const relPath = (root: string, file: string): string => relative(root, file).split(sep).join('/');

/** The ledger, or null when the builder has not run (or wrote something unreadable: then a warning). */
export function readStatsState(dataDir: string, warn: (m: string) => void = () => {}): StatsState | null {
  const f = join(dataDir, STATS_STATE_PATH);
  if (!existsSync(f)) return null;
  try {
    const s = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    if (!isObj(s) || typeof s['version'] !== 'number') throw new Error('no version');
    return s as unknown as StatsState;
  } catch (err) {
    warn(`${STATS_STATE_PATH} unreadable (${err instanceof Error ? err.message : String(err)}): no year or area files this run`);
    return null;
  }
}

/**
 * Writes the run's stats under `publicDir/v1/stats/` and checks them. `tables` holds the day tables derive built from
 * the event map inside its partition loop; every other window day is read from the data checkout's partition, and a
 * day with neither is listed in `missing_days`. Year and area files are copied byte for byte from the data checkout
 * when their sha256 is the one the ledger names. Files under `v1/stats/` that this run did not write are removed.
 */
export function writeStats(
  tables: ReadonlyMap<string, DayTableResult>,
  opts: { publicDir: string; dataDir: string; nowMs: number; headSeq: number; config: StatsConfig; warn?: (m: string) => void },
): StatsWrite {
  const started = performance.now();
  const { publicDir, dataDir, nowMs, headSeq, config } = opts;
  const warn = opts.warn ?? ((m: string) => console.warn(`::warning::${m}`));
  const written = new Set<string>();
  const put = (path: string, body: string | Buffer): void => {
    const file = join(publicDir, path);
    if (typeof body === 'string') writeIfChanged(file, body);
    else if (!existsSync(file) || !readFileSync(file).equals(body)) writeIfChanged(file, body.toString('utf8'));
    written.add(path);
  };

  // 1-2. Day tables.
  const days: StatsIndexDay[] = [];
  const missing: string[] = [];
  const fromData: string[] = [];
  for (const date of statsDays(nowMs)) {
    let t = tables.get(date);
    if (!t) {
      const f = dayPartitionFile(dataDir, date);
      if (!existsSync(f)) {
        missing.push(date);
        continue;
      }
      t = dayTableJson(date, parseNdjson(readFileSync(f, 'utf8')));
      fromData.push(date);
    }
    const path = dayTablePath(date);
    put(path, t.body);
    days.push({ date, path, count: t.count, filtered: t.filtered, bytes: Buffer.byteLength(t.body), sha256: sha256Hex(t.body) });
  }

  // 3. Year and area files from the data checkout, verified against the ledger.
  const state = readStatsState(dataDir, warn);
  const years: StatsIndexYear[] = [];
  const area: StatsIndexArea[] = [];
  const dropped: string[] = [];
  const listed = new Set<string>();
  if (state) {
    for (const y of Object.keys(state.years ?? {}).sort()) {
      const entry = state.years![y]!;
      for (const kind of ['year', 'area'] as const) {
        const want = entry[kind];
        if (!isObj(want)) continue;
        const path = `${STATS_DIR}/${kind}/${y}.json`;
        listed.add(path);
        const src = join(dataDir, path);
        const why = (() => {
          if (!/^\d{4}$/.test(y)) return 'not a year';
          if (!existsSync(src)) return 'missing from the data checkout';
          const bytes = readFileSync(src);
          if (bytes.byteLength !== want.bytes || sha256Hex(bytes) !== want.sha256) return `not the bytes ${STATS_STATE_PATH} names (${bytes.byteLength} B, sha256 ${sha256Hex(bytes).slice(0, 12)})`;
          let doc: Record<string, unknown>;
          try {
            doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
          } catch {
            return 'not JSON';
          }
          if (doc['kind'] !== kind || doc['year'] !== Number(y)) return `kind/year ${String(doc['kind'])}/${String(doc['year'])} in the file`;
          put(path, bytes);
          if (kind === 'year') {
            years.push({ year: Number(y), path, bytes: bytes.byteLength, sha256: want.sha256, first: String(doc['first']), through: String(doc['through']), complete: doc['complete'] === true, mirrorable: true });
          } else {
            const m6 = isObj(doc['m6']) && typeof doc['m6']['count'] === 'number' ? doc['m6']['count'] : 0;
            area.push({
              year: Number(y),
              path,
              bytes: bytes.byteLength,
              sha256: want.sha256,
              min_mag: typeof doc['min_mag'] === 'number' ? doc['min_mag'] : null,
              records: typeof doc['records'] === 'number' ? doc['records'] : 0,
              m6,
              complete: doc['complete'] === true,
              mirrorable: true,
            });
          }
          return null;
        })();
        if (why) {
          dropped.push(path);
          warn(`stats: ${path} not published: ${why}`);
        }
      }
    }
    for (const kind of ['year', 'area']) {
      for (const f of listFiles(join(dataDir, STATS_DIR, kind))) {
        const path = relPath(dataDir, f);
        if (!listed.has(path)) warn(`stats: ${path} is on data but not in ${STATS_STATE_PATH}: not published`);
      }
    }
  }

  // 4. Index.
  const through = state && typeof state.through === 'string' && DATE_RE.test(state.through) ? state.through : null;
  const index: StatsIndex = {
    schema_version: SCHEMA_VERSION,
    format: STATS_FORMAT,
    generated: nowMs,
    generated_iso: isoFromMs(nowMs),
    head_seq: headSeq,
    days,
    missing_days: missing,
    through,
    years,
    area,
    completeness: config.epochs,
    attribution: STATS_ATTRIBUTION,
  };
  const indexBody = JSON.stringify(index);
  put(STATS_INDEX_PATH, indexBody);

  // Anything else under v1/stats is a leftover of an earlier local run (CI starts from an empty public/).
  let bytes = 0;
  for (const f of listFiles(join(publicDir, STATS_DIR))) {
    if (!written.has(relPath(publicDir, f))) rmSync(f);
    else bytes += statSync(f).size;
  }

  const errors = checkStats(publicDir, nowMs);
  return {
    index,
    pointer: { path: STATS_INDEX_PATH, url: `https://${DOMAIN}/${STATS_INDEX_PATH}`, head_seq: headSeq, format: STATS_FORMAT },
    errors,
    fromData,
    dropped,
    bytes,
    ms: performance.now() - started,
  };
}

// --- checks (derive drops on any error; validate.ts fails on any) ---

let validators: { index: ValidateFunction; table: ValidateFunction; year: ValidateFunction; area: ValidateFunction } | null = null;
function schemaValidators(schemaDir: string): NonNullable<typeof validators> {
  if (validators) return validators;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const load = (name: string): object => JSON.parse(readFileSync(join(schemaDir, name), 'utf8')) as object;
  ajv.addSchema(load('stats-table.schema.json'));
  validators = {
    index: ajv.compile(load('stats-index.schema.json')),
    table: ajv.getSchema('https://earthquakes-feed.theshelter.app/schema/stats-table.schema.json')!,
    year: ajv.compile(load('stats-year.schema.json')),
    area: ajv.compile(load('stats-area.schema.json')),
  };
  return validators;
}

/** The invariants of one event table (format 1); `where` prefixes each problem. */
export function checkEventTable(table: Record<string, unknown>, where: string, bounds?: { from: number; to: number }): string[] {
  const errs: string[] = [];
  const count = table['count'];
  if (typeof count !== 'number') return [`${where}: no count`];
  for (const c of ['id', 't', 'lat', 'lon', 'mag', ...OPTIONAL_COLUMNS]) {
    const col = table[c];
    if (col === undefined && !['id', 't', 'lat', 'lon', 'mag'].includes(c)) continue;
    if (!Array.isArray(col) || col.length !== count) errs.push(`${where}: column ${c} has ${Array.isArray(col) ? col.length : 'no'} values, count is ${count}`);
  }
  if (errs.length) return errs;
  const ids = table['id'] as unknown[];
  const bad = ids.find((id) => typeof id !== 'string' || !FEED_ID_RE.test(id));
  if (bad !== undefined) errs.push(`${where}: id ${JSON.stringify(bad)} is not a feed id`);
  const t = table['t'] as number[];
  if (t.some((d) => !(d >= 0))) errs.push(`${where}: a negative time delta`);
  if (bounds && count > 0) {
    const first = (table['t0'] as number) + t[0]!;
    const last = t.reduce((a, d) => a + d, table['t0'] as number);
    if (first < bounds.from || last >= bounds.to) errs.push(`${where}: times ${isoFromMs(first)}..${isoFromMs(last)} outside ${isoFromMs(bounds.from)}..${isoFromMs(bounds.to)}`);
  }
  const providers = table['providers'] as unknown[];
  const prov = table['prov'] as number[] | undefined;
  if (prov && prov.some((i) => !(Number.isInteger(i) && i >= 0 && i < providers.length))) errs.push(`${where}: a prov index outside providers`);
  return errs;
}

/** The invariants of an area file beyond its schema. */
export function checkAreaFile(doc: Record<string, unknown>, where: string): string[] {
  const errs: string[] = [];
  const records = doc['records'] as number;
  const cell = doc['cell'] as number[];
  const total = doc['total'] as number[];
  const m45 = doc['m45'] as number[];
  const mmax = doc['mmax'] as number[];
  for (const [name, col] of [['cell', cell], ['total', total], ['m45', m45], ['mmax', mmax]] as const) {
    if (col.length !== records) errs.push(`${where}: ${name} has ${col.length} values, records is ${records}`);
  }
  if (errs.length) return errs;
  let at = -1;
  for (const [i, d] of cell.entries()) {
    const c = i === 0 ? d : at + d;
    if (!(c > at) || c >= CELL_COUNT) {
      errs.push(`${where}: cell ${c} at record ${i} is not strictly increasing below ${CELL_COUNT}`);
      break;
    }
    at = c;
  }
  if (m45.some((v, i) => v > total[i]!)) errs.push(`${where}: m45 above total`);
  if (doc['min_mag'] === 4.5 && m45.some((v, i) => v !== total[i])) errs.push(`${where}: min_mag 4.5 but m45 != total`);
  if (isObj(doc['m6'])) errs.push(...checkEventTable(doc['m6'], `${where} m6`));
  return errs;
}

/**
 * Every invariant of the published stats at `publicDir` for a run at `nowMs` (the v1 manifest's `generated`): the
 * schemas; the 61 window days listed (consecutive, ending on the run's day) or named in `missing_days`; every listed
 * file present with its bytes and sha256; column lengths equal to `count`; time deltas >= 0 inside the day; feed ids;
 * area cells strictly increasing below 6,480,000, m45 <= total, min_mag 4.5 => m45 == total; index.generated == nowMs.
 * Returns the problems (empty: all good). Used by derive (drops the stats) and validate.ts (fails the run).
 */
export function checkStats(publicDir: string, nowMs: number, schemaDir = SCHEMA_DIR): string[] {
  const errs: string[] = [];
  const v = schemaValidators(schemaDir);
  const indexFile = join(publicDir, STATS_INDEX_PATH);
  if (!existsSync(indexFile)) return [`${STATS_INDEX_PATH} is missing`];
  let index: StatsIndex;
  try {
    index = JSON.parse(readFileSync(indexFile, 'utf8')) as StatsIndex;
  } catch (err) {
    return [`${STATS_INDEX_PATH} is not JSON (${err instanceof Error ? err.message : String(err)})`];
  }
  if (!v.index(index)) return [`${STATS_INDEX_PATH}: ${v.index.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`];
  if (index.generated !== nowMs) errs.push(`${STATS_INDEX_PATH}: generated ${index.generated} is not the run's ${nowMs}`);

  const want = statsDays(nowMs);
  const listed = index.days.map((d) => d.date);
  const named = [...listed, ...index.missing_days].sort();
  if (named.join() !== want.join()) errs.push(`${STATS_INDEX_PATH}: days + missing_days are not ${want[0]}..${want.at(-1)} (${named.length} named)`);
  if (listed.join() !== [...listed].sort().join()) errs.push(`${STATS_INDEX_PATH}: days not in date order`);

  const readListed = (what: string, e: { path: string; bytes: number; sha256: string }): Record<string, unknown> | null => {
    const f = join(publicDir, e.path);
    if (!existsSync(f)) {
      errs.push(`${what} ${e.path} is missing`);
      return null;
    }
    const body = readFileSync(f);
    if (body.byteLength !== e.bytes) errs.push(`${what} ${e.path} has ${body.byteLength} bytes, the index says ${e.bytes}`);
    if (sha256Hex(body) !== e.sha256) errs.push(`${what} ${e.path} sha256 differs from the index`);
    try {
      return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      errs.push(`${what} ${e.path} is not JSON`);
      return null;
    }
  };

  for (const d of index.days) {
    if (d.path !== dayTablePath(d.date)) errs.push(`day ${d.date}: path ${d.path}`);
    const doc = readListed('day', d);
    if (!doc) continue;
    if (!v.table(doc)) {
      errs.push(`day ${d.path}: ${v.table.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
      continue;
    }
    const t0 = dayStartMs(d.date);
    if (doc['kind'] !== 'day' || doc['date'] !== d.date || doc['t0'] !== t0) errs.push(`day ${d.path}: kind/date/t0 ${String(doc['kind'])}/${String(doc['date'])}/${String(doc['t0'])}`);
    if (doc['count'] !== d.count) errs.push(`day ${d.path}: count ${String(doc['count'])}, the index says ${d.count}`);
    const filtered = doc['filtered'] as number[];
    if (filtered.length !== d.filtered) errs.push(`day ${d.path}: ${filtered.length} filtered, the index says ${d.filtered}`);
    if (filtered.some((x, i) => x < 0 || x >= DAY_MS || (i > 0 && x < filtered[i - 1]!))) errs.push(`day ${d.path}: filtered times not ascending inside the day`);
    errs.push(...checkEventTable(doc, `day ${d.path}`, { from: t0, to: t0 + DAY_MS }));
  }
  for (const y of index.years) {
    const doc = readListed('year', y);
    if (!doc) continue;
    if (!v.year(doc)) {
      errs.push(`year ${y.path}: ${v.year.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
      continue;
    }
    if (doc['year'] !== y.year) errs.push(`year ${y.path}: year ${String(doc['year'])}`);
    if (isObj(doc['events'])) errs.push(...checkEventTable(doc['events'], `year ${y.path} events`, { from: Date.parse(`${y.year}-01-01T00:00:00Z`), to: Date.parse(`${y.year + 1}-01-01T00:00:00Z`) }));
  }
  for (const a of index.area) {
    const doc = readListed('area', a);
    if (!doc) continue;
    if (!v.area(doc)) {
      errs.push(`area ${a.path}: ${v.area.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ')}`);
      continue;
    }
    if (doc['year'] !== a.year || doc['records'] !== a.records) errs.push(`area ${a.path}: year/records ${String(doc['year'])}/${String(doc['records'])}`);
    errs.push(...checkAreaFile(doc, `area ${a.path}`));
  }
  if (index.through !== null && !(index.through < eventDayKey(nowMs))) errs.push(`${STATS_INDEX_PATH}: through ${index.through} is not before the run's day`);
  for (const e of [...index.years, ...index.area]) if (!SHA_RE.test(e.sha256)) errs.push(`${e.path}: bad sha256`);
  return errs;
}

/**
 * Runs derive's stats step so that it can never block the live feed: a throw, a failed check (`errors`) or a run past
 * `budgetMs` (`ms` plus the time the caller already spent, `spentMs`) removes `<root>/v1/stats`, prints
 * `::warning::stats dropped: <reason>` and returns null.
 */
export function safeStats<T extends { errors: string[]; ms: number }>(
  run: () => T,
  opts: { root: string; budgetMs: number; spentMs?: number; warn?: (m: string) => void },
): { result: T | null; reason: string | null } {
  const warn = opts.warn ?? ((m: string) => console.warn(`::warning::${m}`));
  let reason: string | null = null;
  let result: T | null = null;
  try {
    result = run();
    const ms = result.ms + (opts.spentMs ?? 0);
    if (result.errors.length) reason = `check failed: ${result.errors.slice(0, 3).join('; ')}${result.errors.length > 3 ? ` (+${result.errors.length - 3} more)` : ''}`;
    else if (ms > opts.budgetMs) reason = `took ${Math.round(ms)} ms, over the ${opts.budgetMs} ms budget`;
  } catch (err) {
    reason = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (reason === null) return { result, reason: null };
  try {
    rmSync(join(opts.root, STATS_DIR), { recursive: true, force: true });
  } catch (err) {
    reason += ` (and removing ${STATS_DIR} failed: ${err instanceof Error ? err.message : String(err)})`;
  }
  warn(`stats dropped: ${reason}`);
  return { result: null, reason };
}

/**
 * derive's stats step for one run: "off" does nothing; "shadow" writes and checks everything under `shadowDir` (never
 * deployed) and yields no pointer; "on" writes under `publicDir` and yields the manifest pointer. `loopError` (a day
 * table derive failed to build in its partition loop) and `loopMs` (the time those tables took) count as part of the
 * step: the error drops the run's stats, the time counts toward the budget. `write` is injectable for tests.
 */
export function deriveStats(input: {
  mode: DerivePublish;
  config: StatsConfig | null;
  tables: ReadonlyMap<string, DayTableResult>;
  loopError?: unknown;
  loopMs?: number;
  publicDir: string;
  shadowDir: string;
  dataDir: string;
  nowMs: number;
  headSeq: number;
  warn?: (m: string) => void;
  write?: typeof writeStats;
}): { stats: StatsWrite | null; pointer: StatsPointer | null; reason: string | null } {
  if (input.mode === 'off' || !input.config) return { stats: null, pointer: null, reason: null };
  const config = input.config;
  const root = input.mode === 'on' ? input.publicDir : input.shadowDir;
  const write = input.write ?? writeStats;
  const { result, reason } = safeStats(
    () => {
      if (input.loopError != null) throw input.loopError;
      return write(input.tables, { publicDir: root, dataDir: input.dataDir, nowMs: input.nowMs, headSeq: input.headSeq, config, ...(input.warn ? { warn: input.warn } : {}) });
    },
    { root, budgetMs: config.derive_budget_ms, spentMs: input.loopMs ?? 0, ...(input.warn ? { warn: input.warn } : {}) },
  );
  return { stats: result, pointer: result && input.mode === 'on' ? result.pointer : null, reason };
}
