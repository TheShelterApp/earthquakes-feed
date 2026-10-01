import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { extractTarball } from './archive-io.js';
import { eventDayKey } from './bitemporal.js';
import { REPO, dataPaths } from './config.js';
import {
  type FirstSolutionsCursor,
  type SourceCursor,
  type WalkPlan,
  LOG_START_DAY,
  addDays,
  daysLeft,
  markDone,
  newCursor,
  newSourceCursor,
  nextDay,
  recordAnswer,
  recordFailure,
  stallLevel,
  unmarkRange,
} from './first-solutions-cursor.js';
import {
  type FirstSolutionRecord,
  type HistorySource,
  HISTORY_SOURCES,
  missingRecord,
  parseComcatSuperseded,
  parseGeonetHistory,
  parseQuakemlAllOrigins,
} from './first-solutions.js';
import { gh, ghRetry, ghRetryNet, sleepMs } from './gh.js';
import { FROZEN_AFTER_DAYS, dayPartitionFile } from './partitions.js';
import { isoFromMs } from './util.js';

/**
 * The earliest-solutions collector (PF-5i P-3, `.github/workflows/first-solutions.yml`). Each run walks every
 * HISTORY_SOURCES provider through the feed's day partitions (the in-tree days, the archived months pulled back from
 * their Release, and before the 3-year layer the deep history's current monthly editions, PF-5j), asks the provider for the version history of each report the feed holds (or, for the `day`
 * sources, for the whole day at once), and writes what it gets as gzip NDJSON chunks, one per source and event month.
 * The chunks go to the GitHub Release `first-solutions-YYYY-MM` (never into the `data` branch's git history); the walk's
 * cursor and the list of chunks are small files in `knowledge/first_solutions/`, which the workflow's commit job
 * writes under the writer lock. Nothing in the `data` branch is rewritten: no partition, archive or log line changes.
 *
 * Politeness: one lane per source, every source on its own host, requests in a lane strictly one after another and
 * at least FIRST_SOLUTIONS_MIN_INTERVAL_MS (1 s) apart, the feed's User-Agent, Retry-After honoured, transient errors
 * retried three times with growing pauses (2 s, 8 s, 30 s), then the lane stops for the run and resumes where it stood.
 * A run stops taking work after FIRST_SOLUTIONS_BUDGET_MS (30 min), so the job ends far inside its 45-minute timeout.
 *
 * Environment: DATA_DIR (a checkout of `data`, read only), FIRST_SOLUTIONS_OUT (output directory, default
 * `first-solutions-out`), FIRST_SOLUTIONS_UPLOAD=1 (upload the chunks; without it nothing leaves the machine),
 * FIRST_SOLUTIONS_BUDGET_MIN (or _MS), FIRST_SOLUTIONS_MIN_INTERVAL_MS (at least 1000), FIRST_SOLUTIONS_SOURCES (comma list),
 * FIRST_SOLUTIONS_DAYS (a one-off slice: comma list of days or `from..to`; the walk's order is ignored, finished days
 * are marked done), FIRST_SOLUTIONS_ONLY_IDS (with FIRST_SOLUTIONS_DAYS: only these `provider:id` reports; the cursor
 * is left as it was), GH_TOKEN (archived months and uploads).
 */

const DAY = 86_400_000;
const USER_AGENT = 'earthquakes-feed/0.1 first-solutions (+https://earthquakes-feed.theshelter.app)';
/** Pauses before the 2nd, 3rd and 4th attempt of a request that failed transiently. */
const RETRY_PAUSES_MS = [2_000, 8_000, 30_000];
/** A Retry-After longer than this stops the lane for the run instead of waiting. */
const MAX_RETRY_AFTER_MS = 120_000;
/** This many answers in a row without the event (404, 204, 409, other 4xx) stop a one-event lane: the provider is more
 *  likely broken or moved than missing that many events. The streak's records are dropped and asked again next run. */
export const GONE_STREAK_LIMIT = 50;
/** A `day` source's day the node answers with no content (204, or 404 for nodes that say "no data" that way) while the
 *  feed holds reports of it: asked again in later runs (a node that is down answers 204 to everything, as NOA did on
 *  2026-10-01), recorded as missing on the third such answer. */
export const EMPTY_DAY_RETRIES = 3;

export interface HttpAnswer {
  status: number;
  body: string;
  retryAfterMs: number | null;
}
export type HttpGet = (url: string, opts: { timeoutMs: number; accept: string }) => Promise<HttpAnswer>;

function retryAfterMs(v: string | null): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

export const httpGet: HttpGet = async (url, { timeoutMs, accept }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': USER_AGENT, accept } });
    const body = await res.text();
    return { status: res.status, body, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
  } finally {
    clearTimeout(timer);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** At most one request start per `minIntervalMs` per host. */
export class Pacer {
  private readonly last = new Map<string, number>();
  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}
  async before(url: string): Promise<void> {
    const host = new URL(url).host;
    const prev = this.last.get(host);
    if (prev != null) {
      const due = prev + this.minIntervalMs - this.now();
      if (due > 0) await this.wait(due);
    }
    this.last.set(host, this.now());
  }
}

export type Fetched =
  | { kind: 'ok'; status: number; body: string; attempts: number }
  | { kind: 'gone'; status: number; attempts: number }
  | { kind: 'fail'; error: string; attempts: number };

/** One request with pacing and retries: 2xx with content is `ok`; 204, 404, 409, 410 and other 4xx (but 429) are
 *  `gone`; 429, 5xx, timeouts and network errors are retried, then `fail`. */
export async function fetchPolitely(url: string, src: Pick<HistorySource, 'timeoutMs' | 'accept'>, pacer: Pacer, get: HttpGet, wait: (ms: number) => Promise<void> = sleep): Promise<Fetched> {
  let lastError = '';
  for (let attempt = 0; attempt <= RETRY_PAUSES_MS.length; attempt++) {
    await pacer.before(url);
    let ans: HttpAnswer | null = null;
    try {
      ans = await get(url, { timeoutMs: src.timeoutMs, accept: src.accept });
    } catch (err) {
      lastError = err instanceof Error ? (err.name === 'AbortError' ? `timeout after ${src.timeoutMs} ms` : err.message) : String(err);
    }
    if (ans) {
      if (ans.status >= 200 && ans.status < 300 && ans.status !== 204 && ans.body.trim()) return { kind: 'ok', status: ans.status, body: ans.body, attempts: attempt + 1 };
      if (ans.status === 204 || (ans.status >= 200 && ans.status < 300)) return { kind: 'gone', status: 204, attempts: attempt + 1 };
      if (ans.status >= 400 && ans.status < 500 && ans.status !== 429) return { kind: 'gone', status: ans.status, attempts: attempt + 1 };
      lastError = `HTTP ${ans.status}`;
      if (ans.retryAfterMs != null && ans.retryAfterMs > MAX_RETRY_AFTER_MS) return { kind: 'fail', error: `${lastError}, Retry-After ${Math.round(ans.retryAfterMs / 1000)} s`, attempts: attempt + 1 };
    }
    if (attempt === RETRY_PAUSES_MS.length) break;
    await wait(Math.max(RETRY_PAUSES_MS[attempt]!, ans?.retryAfterMs ?? 0));
  }
  return { kind: 'fail', error: lastError || 'no answer', attempts: RETRY_PAUSES_MS.length + 1 };
}

/** The native ids of one provider's reports in one event-day partition, deduplicated, in code-point order. */
export function idsInPartition(text: string, provider: string): string[] {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes(`"${provider}"`)) continue;
    const f = JSON.parse(line) as { properties?: { feed?: { provenance?: Array<{ provider: string; native_id: string }> } } };
    for (const r of f.properties?.feed?.provenance ?? []) if (r.provider === provider && r.native_id) ids.add(r.native_id);
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

interface ArchiveEntry {
  period: string;
  tag: string;
  asset: string;
  days?: string[];
}

/** A month of the deep history (PF-5j, knowledge/index/history.json `editions`): a `history-YYYY` Release asset of day
 *  files in the partitions' feature format, built from the listed raw assets (one or more per source). */
export interface DeepEdition {
  period: string;
  edition: number;
  tag: string;
  asset: string;
  days: string[];
  built_from: string[];
}

export interface DeepHistory {
  /** The 3-year layer's first day; the deep history lies before it. */
  boundary: string | null;
  /** Each month's current edition (its highest). */
  current: Map<string, DeepEdition>;
  /** The first day of the deep months built back from the boundary without a gap, or null when none is. */
  start: string | null;
}

/** The deep history the side index can walk: each month's current edition, and how far back they reach without a gap
 *  (the history walk builds months newest first, so a gap is a month not built yet). */
export function deepHistory(index: { boundary?: string; editions?: DeepEdition[] } | null): DeepHistory {
  const current = new Map<string, DeepEdition>();
  for (const e of index?.editions ?? []) {
    const had = current.get(e.period);
    if (!had || e.edition > had.edition) current.set(e.period, e);
  }
  const boundary = index?.boundary ?? null;
  let start: string | null = null;
  if (boundary) {
    for (let m = addDays(boundary, -1).slice(0, 7); current.has(m); m = addDays(`${m}-01`, -1).slice(0, 7)) start = `${m}-01`;
  }
  return { boundary, current, start };
}

/** Which raw assets of a source an edition was built from: the source's rows in that month change only when these do. */
export const deepKey = (provider: string, e: DeepEdition): string =>
  e.built_from
    .filter((a) => a.startsWith(`raw-${provider}-`))
    .sort()
    .join(',');

/** Re-open the deep months whose current edition was built from other raw assets of the source than the ones it was
 *  collected from (the source joined the era, or was fetched again). Returns the months re-opened. */
export function reopenChangedDeepMonths(provider: string, cur: SourceCursor, deep: DeepHistory): string[] {
  const reopened: string[] = [];
  if (!cur.deep || !deep.boundary) return reopened;
  for (const [period, key] of Object.entries(cur.deep)) {
    const e = deep.current.get(period);
    if (!e || deepKey(provider, e) === key) continue;
    const last = addDays(`${addDays(`${period}-28`, 7).slice(0, 7)}-01`, -1);
    unmarkRange(cur, `${period}-01`, last < deep.boundary ? last : addDays(deep.boundary, -1));
    delete cur.deep[period];
    reopened.push(period);
  }
  return reopened;
}

/** Day partitions: in the tree when there, else from the month's Release archive, else (before the 3-year layer) from
 *  the month's current deep-history edition; each asset downloaded once per run. */
export class PartitionReader {
  private readonly archivedDay = new Map<string, ArchiveEntry>();
  private readonly assets = new Map<string, Promise<string>>();
  private staging: string | null = null;

  constructor(
    private readonly root: string,
    archives: ArchiveEntry[],
    private readonly download: (e: { tag: string; asset: string }, intoDir: string) => void = downloadArchive,
    private readonly deep: DeepHistory = { boundary: null, current: new Map(), start: null },
  ) {
    for (const a of archives) for (const d of a.days ?? []) this.archivedDay.set(d, a);
  }

  private fetchAsset(e: { tag: string; asset: string }): Promise<string> {
    let dir = this.assets.get(e.asset);
    if (!dir) {
      this.staging ??= mkdtempSync(join(tmpdir(), 'efd-fs-arch-'));
      const into = join(this.staging, e.asset.replace(/[^A-Za-z0-9.-]/g, '_'));
      dir = Promise.resolve().then(() => {
        mkdirSync(into, { recursive: true });
        this.download(e, into);
        return into;
      });
      this.assets.set(e.asset, dir);
      dir.catch(() => this.assets.delete(e.asset));
    }
    return dir;
  }

  /** The partition's text, '' when the feed has no partition of that day; throws when an archive or edition cannot be
   *  read. */
  async dayText(day: string): Promise<string> {
    const inTree = dayPartitionFile(this.root, day);
    if (existsSync(inTree)) return readFileSync(inTree, 'utf8');
    let entry: { tag: string; asset: string } | undefined = this.archivedDay.get(day);
    if (!entry && this.deep.boundary && day < this.deep.boundary) {
      const e = this.deep.current.get(day.slice(0, 7));
      if (e && e.days.includes(day)) entry = e;
    }
    if (!entry) return '';
    const file = join(await this.fetchAsset(entry), `${day.slice(8, 10)}.ndjson`);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }

  close(): void {
    if (this.staging) rmSync(this.staging, { recursive: true, force: true });
  }
}

function downloadArchive(e: { tag: string; asset: string }, intoDir: string): void {
  const asset = join(intoDir, e.asset);
  ghRetry(['release', 'download', e.tag, '-R', REPO, '-p', e.asset, '-O', asset, '--clobber']);
  extractTarball(asset, intoDir);
  rmSync(asset, { force: true });
}

export interface LaneContext {
  deadlineMs: number;
  now: () => number;
  collectedAt: () => string;
  pacer: Pacer;
  get: HttpGet;
  wait?: (ms: number) => Promise<void>;
  partitions: { dayText(day: string): Promise<string> };
  plan: (src: HistorySource) => WalkPlan;
  /** One-off slice (FIRST_SOLUTIONS_DAYS): these days in this order instead of the walk. */
  days?: string[];
  /** With `days`: only these native ids of each provider; the cursor is not moved. */
  onlyIds?: Map<string, Set<string>>;
  /** For a deep-history day, the source's raw assets its month's edition was built from (deepKey); null otherwise. */
  deepKeyOf?: (provider: string, day: string) => string | null;
}

export interface LaneResult {
  provider: string;
  records: FirstSolutionRecord[];
  requests: number;
  daysDone: string[];
  error: string | null;
}

function parseAnswer(src: HistorySource, body: string, id: string, day: string, collected: string): FirstSolutionRecord {
  const base = { provider: src.provider, providerEventId: id, day, collected };
  if (src.method === 'comcat-superseded') return parseComcatSuperseded(body, base);
  if (src.method === 'geonet-history') return parseGeonetHistory(body, base);
  const recs = parseQuakemlAllOrigins(body, src.provider, day, collected, (p) => p, id);
  return recs.find((r) => r.provider_event_id === id) ?? missingRecord(src, base, 'no such event in the answer');
}

/** Walk one source until the deadline, the end of its plan or a failed request. Mutates `cur`. */
export async function runLane(src: HistorySource, cur: SourceCursor, ctx: LaneContext): Promise<LaneResult> {
  const out: LaneResult = { provider: src.provider, records: [], requests: 0, daysDone: [], error: null };
  const oneOff = ctx.days != null;
  const moveCursor = !ctx.onlyIds;
  const only = ctx.onlyIds ? (ctx.onlyIds.get(src.provider) ?? new Set<string>()) : undefined;
  const queue = oneOff ? [...ctx.days!] : null;
  const take = (): string | null => (queue ? (queue.shift() ?? null) : nextDay(cur, ctx.plan(src)));
  const finishDay = (day: string): void => {
    out.daysDone.push(day);
    if (moveCursor) {
      markDone(cur, day);
      if (cur.pending?.day === day) delete cur.pending;
      const key = ctx.deepKeyOf?.(src.provider, day) ?? null;
      if (key != null) (cur.deep ??= {})[day.slice(0, 7)] = key;
    }
  };
  for (let day = take(); day != null && ctx.now() < ctx.deadlineMs; day = take()) {
    let ids: string[];
    try {
      ids = idsInPartition(await ctx.partitions.dayText(day), src.provider);
    } catch (err) {
      out.error = `partition ${day}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    if (only) ids = ids.filter((id) => only.has(id));
    const collected = ctx.collectedAt();

    if (src.unit === 'day') {
      if (!ids.length) {
        finishDay(day);
        continue;
      }
      const res = await fetchPolitely(src.url(day), src, ctx.pacer, ctx.get, ctx.wait);
      out.requests += res.attempts;
      if (res.kind === 'fail') {
        out.error = `${day}: ${res.error}`;
        break;
      }
      let recs: FirstSolutionRecord[];
      if (res.kind === 'gone') {
        // Any other client error to a day query means the request itself is refused (a parameter the node stopped
        // supporting): never record a whole day as missing for that.
        if (res.status !== 204 && res.status !== 404) {
          out.error = `${day}: HTTP ${res.status} to the day query`;
          break;
        }
        const tries = (cur.pending?.day === day ? (cur.pending.empty ?? 0) : 0) + 1;
        if (tries < EMPTY_DAY_RETRIES) {
          if (moveCursor) cur.pending = { day, offset: 0, empty: tries };
          out.error = `${day}: no content (HTTP ${res.status}) for a day the feed holds ${ids.length} report(s) of; asked again next run (${tries}/${EMPTY_DAY_RETRIES})`;
          break;
        }
        recs = ids.map((id) => missingRecord(src, { provider: src.provider, providerEventId: id, day, collected }, `http ${res.status}`));
      } else {
        try {
          recs = parseQuakemlAllOrigins(res.body, src.provider, day, collected, src.idOf ?? ((p) => p));
        } catch (err) {
          out.error = `${day}: unreadable answer: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
        const have = new Set(recs.map((r) => r.provider_event_id));
        for (const id of ids) if (!have.has(id)) recs.push(missingRecord(src, { provider: src.provider, providerEventId: id, day, collected }, 'not in the day answer'));
      }
      out.records.push(...recs);
      finishDay(day);
      continue;
    }

    // One request per report, resumable inside the day.
    let i = cur.pending?.day === day && moveCursor ? cur.pending.offset : 0;
    let streakStart = -1;
    let streakRecords = 0;
    for (; i < ids.length; i++) {
      if (ctx.now() >= ctx.deadlineMs) break;
      const id = ids[i]!;
      const res = await fetchPolitely(src.url(id), src, ctx.pacer, ctx.get, ctx.wait);
      out.requests += res.attempts;
      if (res.kind === 'fail') {
        out.error = `${src.provider}:${id}: ${res.error}`;
        break;
      }
      const at = ctx.collectedAt();
      if (res.kind === 'gone') {
        if (streakStart < 0) streakStart = i;
        streakRecords++;
        out.records.push(missingRecord(src, { provider: src.provider, providerEventId: id, day, collected: at }, `http ${res.status}`));
        if (streakRecords >= GONE_STREAK_LIMIT) {
          out.records.splice(out.records.length - streakRecords, streakRecords);
          i = streakStart;
          out.error = `${src.provider}: ${GONE_STREAK_LIMIT} answers in a row without the event (last HTTP ${res.status}); stopped at ${ids[streakStart]} of ${day}`;
          break;
        }
        continue;
      }
      streakStart = -1;
      streakRecords = 0;
      try {
        out.records.push(parseAnswer(src, res.body, id, day, at));
      } catch (err) {
        out.error = `${src.provider}:${id}: unreadable answer: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }
    if (i >= ids.length && !out.error) {
      finishDay(day);
      continue;
    }
    if (moveCursor) cur.pending = { day, offset: i };
    break;
  }
  return out;
}

// --- chunks, Releases, cursor files ------------------------------------------------------------------------------------

export interface ChunkLine {
  source: string;
  month: string;
  /** The Release holding the asset; null for a local run that uploaded nothing. */
  tag: string | null;
  asset: string;
  records: number;
  bytes: number;
  sha256: string;
  days: [string, string];
  run: string;
  collected: string;
}

export const releaseTag = (month: string): string => `first-solutions-${month}`;

/** Group a lane's records into chunks, one per event month: gzip NDJSON, records in (day, id) order. */
export function buildChunks(provider: string, records: FirstSolutionRecord[], run: string): Array<{ line: ChunkLine; body: Buffer }> {
  const byMonth = new Map<string, FirstSolutionRecord[]>();
  for (const r of records) {
    const m = r.day.slice(0, 7);
    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(r);
  }
  const out: Array<{ line: ChunkLine; body: Buffer }> = [];
  for (const [month, recs] of [...byMonth].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    recs.sort((a, b) => (a.day + a.provider_event_id < b.day + b.provider_event_id ? -1 : a.day + a.provider_event_id > b.day + b.provider_event_id ? 1 : 0));
    const body = gzipSync(Buffer.from(recs.map((r) => JSON.stringify(r)).join('\n') + '\n'), { level: 9 });
    const days = recs.map((r) => r.day).sort();
    out.push({
      line: {
        source: provider,
        month,
        tag: null,
        asset: `fs-${provider}-${month}-${run}.ndjson.gz`,
        records: recs.length,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        days: [days[0]!, days[days.length - 1]!],
        run,
        collected: recs.map((r) => r.collected).sort().pop()!,
      },
      body,
    });
  }
  return out;
}

function ensureRelease(tag: string): void {
  try {
    gh(['release', 'view', tag, '-R', REPO, '--json', 'tagName']);
    return;
  } catch {
    /* not there yet */
  }
  const notes =
    'Earliest-solutions side index (PF-5i P-3): gzip NDJSON chunks, one line per provider report with every solution ' +
    "the provider still keeps in its version history. Listed in the data branch's knowledge/first_solutions/chunks.ndjson; " +
    'read with scripts/first-observations.ts (APIs.md, Earliest solutions).';
  try {
    ghRetryNet(['release', 'create', tag, '-R', REPO, '--target', 'main', '--title', tag, '--notes', notes, '--latest=false']);
  } catch {
    sleepMs(3_000);
    ghRetryNet(['release', 'view', tag, '-R', REPO, '--json', 'tagName']);
  }
}

/** Upload one chunk to its month's Release and check it is listed with its size. Asset names carry the run, so an
 *  upload never replaces anything. */
function uploadChunk(line: ChunkLine, file: string): void {
  const tag = releaseTag(line.month);
  ensureRelease(tag);
  ghRetry(['release', 'upload', tag, file, '-R', REPO]);
  const listed = JSON.parse(ghRetry(['release', 'view', tag, '-R', REPO, '--json', 'assets'])) as { assets: Array<{ name: string; size: number }> };
  const a = listed.assets.find((x) => x.name === line.asset);
  if (!a || a.size !== line.bytes) throw new Error(`asset ${line.asset} not listed with ${line.bytes} bytes after upload`);
}

const sha256Of = (s: string | null): string | null => (s == null ? null : createHash('sha256').update(s).digest('hex'));
const readOr = (f: string): string | null => (existsSync(f) ? readFileSync(f, 'utf8') : null);

export function firstSolutionsPaths(root: string) {
  const dir = join(root, 'knowledge', 'first_solutions');
  return { dir, cursor: join(dir, 'cursor.json'), chunks: join(dir, 'chunks.ndjson') };
}

function expandDays(spec: string): string[] {
  const out: string[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b] = part.split('..');
    if (!b) out.push(a!);
    else for (let d = a!; d <= b; d = addDays(d, 1)) out.push(d);
  }
  return out;
}

async function main(): Promise<void> {
  const root = dataPaths().root;
  const outDir = process.env.FIRST_SOLUTIONS_OUT ?? 'first-solutions-out';
  const upload = process.env.FIRST_SOLUTIONS_UPLOAD === '1';
  const startedMs = Date.now();
  const budgetMin = Number(process.env.FIRST_SOLUTIONS_BUDGET_MIN || NaN);
  const budgetMs = Number.isFinite(budgetMin) && budgetMin > 0 ? budgetMin * 60_000 : Number(process.env.FIRST_SOLUTIONS_BUDGET_MS || 30 * 60_000);
  const minIntervalMs = Math.max(1000, Number(process.env.FIRST_SOLUTIONS_MIN_INTERVAL_MS ?? 1000));
  const run = process.env.GITHUB_RUN_ID ? `r${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}` : `local-${isoFromMs(startedMs).replace(/[-:]/g, '').slice(0, 15)}`;
  const onlySources = process.env.FIRST_SOLUTIONS_SOURCES ? new Set(process.env.FIRST_SOLUTIONS_SOURCES.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const days = process.env.FIRST_SOLUTIONS_DAYS ? expandDays(process.env.FIRST_SOLUTIONS_DAYS) : undefined;
  let onlyIds: Map<string, Set<string>> | undefined;
  if (process.env.FIRST_SOLUTIONS_ONLY_IDS) {
    if (!days) throw new Error('FIRST_SOLUTIONS_ONLY_IDS needs FIRST_SOLUTIONS_DAYS');
    onlyIds = new Map();
    for (const key of process.env.FIRST_SOLUTIONS_ONLY_IDS.split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = key.indexOf(':');
      const p = key.slice(0, i);
      (onlyIds.get(p) ?? onlyIds.set(p, new Set()).get(p)!).add(key.slice(i + 1));
    }
  }

  const fsp = firstSolutionsPaths(root);
  const cursorText = readOr(fsp.cursor);
  const chunksText = readOr(fsp.chunks);
  const cursor: FirstSolutionsCursor = cursorText ? (JSON.parse(cursorText) as FirstSolutionsCursor) : newCursor();
  const backfillText = readOr(dataPaths(root).backfillCursor);
  const targetStart = (backfillText ? (JSON.parse(backfillText) as { targetStart?: string }).targetStart : undefined) ?? '2023-07-06';
  const archivesText = readOr(dataPaths(root).archivesIndex);
  const archives = archivesText ? ((JSON.parse(archivesText) as { list: ArchiveEntry[] }).list ?? []) : [];
  const historyText = readOr(join(dataPaths(root).indexDir, 'history.json'));
  const deep = deepHistory(historyText ? (JSON.parse(historyText) as { boundary?: string; editions?: DeepEdition[] }) : null);
  const walkStart = deep.start && deep.start < targetStart ? deep.start : targetStart;
  const settledEnd = addDays(eventDayKey(startedMs - FROZEN_AFTER_DAYS * DAY), -1);
  const plan = (src: HistorySource): WalkPlan => ({
    targetStart: walkStart,
    logStart: LOG_START_DAY,
    settledEnd,
    retentionStart: src.retentionDays ? addDays(eventDayKey(Date.now() - src.retentionDays * DAY), 1) : null,
  });

  const sources = HISTORY_SOURCES.filter((s) => !onlySources || onlySources.has(s.provider));
  const before = new Map<string, string>();
  for (const s of sources) {
    cursor.sources[s.provider] ??= newSourceCursor();
    before.set(s.provider, JSON.stringify(cursor.sources[s.provider]));
    if (!onlyIds) {
      const reopened = reopenChangedDeepMonths(s.provider, cursor.sources[s.provider]!, deep);
      if (reopened.length) console.log(`first-solutions ${s.provider}: deep month(s) ${reopened.join(', ')} have a new edition with other ${s.provider} rows; collected again`);
    }
  }
  const partitions = new PartitionReader(root, archives, undefined, deep);
  const deepKeyOf = (provider: string, day: string): string | null => {
    if (!deep.boundary || day >= deep.boundary) return null;
    const e = deep.current.get(day.slice(0, 7));
    return e ? deepKey(provider, e) : null;
  };
  const pacer = new Pacer(minIntervalMs);
  const ctx: LaneContext = {
    deadlineMs: startedMs + budgetMs,
    now: Date.now,
    collectedAt: () => isoFromMs(Date.now()),
    pacer,
    get: httpGet,
    partitions,
    plan,
    days,
    onlyIds,
    deepKeyOf,
  };
  console.log(`first-solutions: run ${run}, budget ${Math.round(budgetMs / 1000)} s, target ${walkStart}${walkStart !== targetStart ? ` (deep history from ${walkStart}, 3-year layer from ${targetStart})` : ''}, settled to ${settledEnd}, sources ${sources.map((s) => s.provider).join(',')}${days ? `, one-off days ${days.join(',')}` : ''}`);
  let results: LaneResult[];
  try {
    results = await Promise.all(sources.map((s) => runLane(s, cursor.sources[s.provider]!, ctx)));
  } finally {
    partitions.close();
  }

  mkdirSync(join(outDir, 'chunks'), { recursive: true });
  const newLines: ChunkLine[] = [];
  const blockers: string[] = [];
  const summary: Record<string, unknown> = {};
  const nowIso = isoFromMs(Date.now());
  for (const res of results) {
    const cur = cursor.sources[res.provider]!;
    const chunks = buildChunks(res.provider, res.records, run);
    let uploadError: string | null = null;
    for (const c of chunks) {
      const file = join(outDir, 'chunks', c.line.asset);
      writeFileSync(file, c.body);
      if (upload && !uploadError) {
        try {
          uploadChunk(c.line, file);
          c.line.tag = releaseTag(c.line.month);
        } catch (err) {
          uploadError = err instanceof Error ? err.message : String(err);
        }
      }
    }
    if (uploadError) {
      // Nothing of this source counts: its cursor goes back to where the run found it, its chunks stay unlisted.
      const reverted = JSON.parse(before.get(res.provider)!) as SourceCursor;
      if (!onlyIds) recordFailure(reverted, `upload: ${uploadError}`, nowIso);
      cursor.sources[res.provider] = reverted;
      console.log(`::warning::first-solutions ${res.provider}: upload failed, the run's work is asked again next run: ${uploadError}`);
      summary[res.provider] = { upload_error: uploadError, requests: res.requests, failures: reverted.failures };
      if (stallLevel(reverted) === 'alarm') blockers.push(`first-solutions ${res.provider}: ${reverted.failures} failed runs in a row since ${reverted.failingSince}: ${reverted.lastError}`);
      continue;
    }
    newLines.push(...chunks.map((c) => c.line));
    // A run with nothing to do leaves the cursor byte-identical, so the commit job has nothing to commit.
    if (!onlyIds && (res.requests > 0 || res.daysDone.length > 0 || res.error)) {
      cur.requests += res.requests;
      cur.records += res.records.length;
      cur.lastRun = nowIso;
      if (res.error) recordFailure(cur, res.error, nowIso);
      else if (res.requests > 0) recordAnswer(cur);
    }
    const level = stallLevel(cur);
    const left = daysLeft(cur, plan(HISTORY_SOURCES.find((s) => s.provider === res.provider)!));
    summary[res.provider] = { requests: res.requests, records: res.records.length, days: res.daysDone.length, pending: cur.pending ?? null, days_left: left, failures: cur.failures, error: res.error };
    console.log(
      `first-solutions ${res.provider}: ${res.requests} request(s), ${res.records.length} record(s), ${res.daysDone.length} day(s) done${res.daysDone.length ? ` (${res.daysDone[0]}..${res.daysDone[res.daysDone.length - 1]})` : ''}, pending ${cur.pending ? `${cur.pending.day}+${cur.pending.offset}` : 'none'}, ${left} day(s) left${res.error ? `, stopped: ${res.error}` : ''}`,
    );
    if (level === 'warn') console.log(`::warning::first-solutions ${res.provider}: ${cur.failures} failed runs in a row since ${cur.failingSince}: ${cur.lastError}`);
    if (level === 'alarm') blockers.push(`first-solutions ${res.provider}: ${cur.failures} failed runs in a row since ${cur.failingSince}: ${cur.lastError}`);
  }

  writeFileSync(join(outDir, 'cursor.json'), JSON.stringify(cursor, null, 2) + '\n');
  writeFileSync(join(outDir, 'chunks.ndjson'), (chunksText ?? '') + newLines.map((l) => JSON.stringify(l) + '\n').join(''));
  writeFileSync(join(outDir, 'base.json'), JSON.stringify({ cursor_sha256: sha256Of(cursorText), chunks_sha256: sha256Of(chunksText) }, null, 2) + '\n');
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ run, started: isoFromMs(startedMs), finished: nowIso, uploaded: upload, sources: summary }, null, 2) + '\n');
  if (blockers.length) writeFileSync(join(outDir, 'blocked.txt'), blockers.join('\n') + '\n');
  const total = newLines.reduce((s, l) => s + l.bytes, 0);
  console.log(`first-solutions: ${newLines.length} chunk(s), ${newLines.reduce((s, l) => s + l.records, 0)} record(s), ${total} bytes${upload ? ' uploaded' : ' (local only)'}; ${Math.round((Date.now() - startedMs) / 1000)} s`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
