import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DATA_DIR, EVENT_MAP_HORIZON_DAYS, dataPaths } from './config.js';
import { isSparseCheckout, treeNames } from './sparse-checkout.js';
import { StateStoreError, backendFromEnv, getBlobs, isSha256Hex, sha256Hex, type GetBlobsStats, type RetryPolicy, type StateBackend } from './state-store.js';

/**
 * The event map in the state store (storage phase 3; APIs.md "Repository size"). The event map is the feed's dedup
 * state: one NDJSON line per event (types.ts EventNode), one file per UTC event-day under knowledge/index/event_map/,
 * 45 days of it (EVENT_MAP_HORIZON_DAYS), about 78 MB. Every aggregate run rewrote 1–4 hour shards of it in git, about
 * 58 % of what the 5-minute commits still added to the repository after phase 2. Phase 3 moves it out of git without
 * rewriting history:
 *
 * - The generation document, knowledge/index/generation.json, names each day's content: the sha256, size and node
 *   count of the day's NDJSON and the content address of its gzip in the store (src/state-store.ts). It is committed in
 *   the same commit as head.json, sweeps.json, watermarks.json, the correction/heal markers and onboard.json, so the
 *   one `git push` stays the atomic commit and the compare-and-swap of the whole state (an aggregate commit's invariants
 *   1–5, understand.md); the blobs are uploaded before that commit, so a failed push leaves only orphans GC removes.
 *   Its `parent` line (the sha256 of the previous document) changes on every write, so two writers that both rewrote it
 *   conflict in git instead of merging line by line.
 * - persist (aggregate, after the Aggregate step): every day on disk is canonicalized; a day whose sha256 differs from
 *   the generation's entry is gzipped and PUT; the new generation is written. It never infers a removal from a missing
 *   file: a day the previous generation lists that the checkout lacks throws, unless it is below the horizon.
 * - pruneGeneration (derive, beside the prune of the day files): a pure local edit, no network.
 * - hydrate: blobs of the generation fetched (in batches of at most 2.5 MB, three at a time, each retried on its own:
 *   src/state-store.ts getBlobs), each checked against the generation (gzip sha256 by the client, NDJSON sha256, bytes
 *   and node count here). Phase 3a (`shadow`): every checked-out day is compared with its generation entry, mismatches
 *   reported, and the store is exercised with the days that differ plus a rotating sample (SHADOW_SAMPLE_DAYS a run,
 *   every day about hourly); the checkout is never touched, the run never failed by it (git is still the truth). Phase
 *   3b (`authoritative`, behind EVENT_MAP_STORE_AUTHORITATIVE): every day not already identical on disk is fetched, the
 *   directory is replaced by exactly the generation's days and any failure throws.
 *
 * The layout on disk follows git (eventMapShardHours): while git tracks the event map (phase 3a) saveEventMap keeps
 * writing round 17's hour shards, so each 5-minute commit still adds ~70 KB shards to the repository's history instead
 * of ~1.7 MB day files (APIs.md "Repository size": day files would add about 7–22 MB a day for as long as the soak
 * lasts, for ever); once git no longer holds the files (phase 3b) it writes one file per day. The knob
 * EVENT_MAP_SHARD_HOURS is gone. A day's store bytes are canonicalDay of its files, whatever their layout: byte for
 * byte the day file, so a hydrated day (always a day file) hashes to its entry. moveToDayLayout (aggregate, phase 3b
 * only) moves any day still in shards to its day file.
 *
 * Absence never reads as empty or as today any more: loadEventMap throws when the generation lists a day the checkout
 * lacks, or when there is neither a map nor a generation (EVENT_MAP_BOOTSTRAP=1 starts an empty one); liveFloor (the
 * live pipeline's first day, which backfill fills strictly before and archive never reaches) throws when it has no
 * source. A file named `0000-00-00*` is the phase-3b sentinel and skipped by every reader here.
 *
 *   DATA_DIR=.data FEED_STATE_BACKEND=worker npx --no-install tsx src/event-map-store.ts hydrate|persist|layout|stage|untrack|assert-staged|floor
 */

export const GENERATION_FORMAT = 1;
export const EVENT_MAP_LAYOUT = 'day';
/** The EventNode line schema the day files hold; a reader refuses another. */
export const NODE_SCHEMA = 1;
/** The phase-3b sentinel's day: never an event-day, skipped by every reader of this module. */
export const SENTINEL_DAY = '0000-00-00';
export const SENTINEL_FILE = `${SENTINEL_DAY}.ndjson`;
/**
 * Phase 3b's switch. false in phase 3a: git still tracks the day files and stays the truth; the store is written and
 * shadow-verified. true (the phase-3b PR, after its gate in APIs.md): hydrate replaces the checkout's event map and
 * fails closed, persist failures fail the run, and EVENT_MAP_IN_GIT defaults to 0, which turns on the assert that no
 * event-map path but the sentinel is staged.
 */
export const EVENT_MAP_STORE_AUTHORITATIVE = false;
/** gzip level of a day blob: the store keys a blob by the sha256 of its gzip bytes, so the level only sets the size. */
export const BLOB_GZIP_LEVEL = 9;
/** PUTs in flight at once (the first phase-3a run uploads all 46 days). */
export const PUT_CONCURRENCY = 4;
/**
 * Phase 3a's retry policy for the two shadow steps (hydrate, persist): the store only shadows git, so a slow or hanging
 * store must not stretch the 5-minute aggregate job (the client's defaults allow ~87 s per request: 4 × 20 s plus
 * backoff). Two attempts of at most 15 s for a PUT, up to BATCH_ATTEMPTS (4) for each hydrate batch with a timeout
 * scaled to its bytes (src/state-store.ts batchTimeoutMs: 5.6 s for one day, 10 s for a full 2.5 MB batch), 8 s of
 * backoff per request, and a deadline over the step's store requests, the OIDC token requests included: hydrate 30 s,
 * persist (the first run's 46 PUTs) 60 s, so a hung store costs a run at most ~90 s. hydrate's 30 s start after its
 * local comparison (canonicalizing the checkout's ~78 MB of days, a second or more on a busy runner: main builds the
 * backend when the fetch starts, and the marker summary names the local ms), so the store requests have all of it. A shadow hydrate fetches about 1.2 MB (the
 * sample of 4 days and the rare day that differs: one request), so 30 s holds three or four attempts of it; even a
 * full 46-day fetch (12.2 MB, 6 batches in two waves) holds a stalled batch's retry. A step cut by its deadline reports
 * a transport error (feed:state-shadow).
 */
export const SHADOW_RETRY_POLICY = { attempts: 2, batchAttempts: 4, timeoutMs: 15_000, retryBudgetMs: 8_000 } as const;
export const SHADOW_STEP_DEADLINE_MS = { hydrate: 30_000, persist: 60_000 } as const;
/**
 * Phase 3b's hydrate (authoritative: a fresh checkout has no day file, so every run fetches all 46 days, 12.2 MB, 6
 * batches): 4 attempts a batch, each at most 20 s (batchTimeoutMs: 10 s for a full batch), 15 s of backoff a request,
 * and a 60 s deadline over the step, after which it fails closed (the run stops; the next one, 5 minutes later, tries
 * again). At the 3a failure rate (one batch stall in about 200 runs, now one of 6 smaller batches, retried for its
 * missing blobs only) a run needs 2–4 s, a stalled one about 15 s. The step's timeout-minutes (2) stays the backstop.
 * persist keeps the client's defaults in 3b (a failure stops the run; APIs.md "Phase 3b").
 */
export const AUTHORITATIVE_HYDRATE_POLICY = { batchAttempts: 4, timeoutMs: 20_000, retryBudgetMs: 15_000 } as const;
export const AUTHORITATIVE_HYDRATE_DEADLINE_MS = 60_000;
/**
 * Days a shadow hydrate fetches beyond the ones that differ (shadowSample): 4 of the 46 a run, a different 4 each run
 * by the run number, so 12 consecutive aggregate runs (an hour) verify every day the store holds. Before 2026-11-19 the
 * shadow fetched all 46 every run (12.2 MB, 13,000 Class B a day), which only exercised the same blobs 12 times an hour.
 */
export const SHADOW_SAMPLE_DAYS = 4;

/** The retry policy of a step: phase 3a's shadow steps and phase 3b's hydrate are bounded; 3b's persist keeps the
 *  client's defaults. */
export function stepPolicy(cmd: 'hydrate' | 'persist', mode: HydrateMode | null, t0: number): RetryPolicy | undefined {
  if (cmd === 'hydrate' && mode === 'authoritative') return { ...AUTHORITATIVE_HYDRATE_POLICY, deadlineMs: t0 + AUTHORITATIVE_HYDRATE_DEADLINE_MS };
  if (cmd === 'persist' && EVENT_MAP_STORE_AUTHORITATIVE) return undefined;
  return { ...SHADOW_RETRY_POLICY, deadlineMs: t0 + SHADOW_STEP_DEADLINE_MS[cmd] };
}

/**
 * The rotation number of this run's shadow sample: GITHUB_RUN_NUMBER (counts up by one each run of a workflow, so
 * consecutive runs take consecutive slices and the coverage is exact), else GITHUB_RUN_ID, else the 5-minute slot of
 * `nowMs` (a local run). A re-run attempt has the same number and the same sample.
 */
export function shadowRotation(env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): number {
  for (const k of ['GITHUB_RUN_NUMBER', 'GITHUB_RUN_ID'] as const) {
    const v = (env[k] ?? '').trim();
    if (/^\d{1,15}$/.test(v)) return Number(v);
  }
  return Math.floor(nowMs / 300_000);
}

/**
 * The days of a shadow hydrate's rotating sample: `k` consecutive days (wrapping) of the sorted `days`, starting at
 * rotation × k. Deterministic (a run can be replayed), distinct, and ceil(n / k) consecutive rotations cover every day:
 * 12 aggregate runs, one hour, for 46 days and k = 4. `k` at or above n: every day.
 */
export function shadowSample(days: readonly string[], rotation: number, k: number = SHADOW_SAMPLE_DAYS): string[] {
  const sorted = [...days].sort();
  const n = sorted.length;
  if (k >= n) return sorted;
  const start = ((rotation % n) * (k % n)) % n;
  return Array.from({ length: k }, (_, i) => sorted[(start + i) % n]!).sort();
}

const DAY_MS = 86_400_000;
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Whether git tracks the event map (EVENT_MAP_IN_GIT, default 1 while EVENT_MAP_STORE_AUTHORITATIVE is false). */
export function eventMapInGit(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.EVENT_MAP_IN_GIT ?? '').trim();
  if (raw === '') return !EVENT_MAP_STORE_AUTHORITATIVE;
  if (raw !== '0' && raw !== '1') throw new Error(`EVENT_MAP_IN_GIT=${raw.slice(0, 20)}: 0 or 1`);
  return raw === '1';
}

/**
 * The hours of event time one event-map file holds (src/bitemporal.ts saveEventMap): 1 (round 17's hour shards) while
 * git tracks the event map, since git keeps every rewritten file for ever; 24 (one file per day, the store's blob
 * layout) once it does not (phase 3b).
 */
export function eventMapShardHours(env: NodeJS.ProcessEnv = process.env): number {
  return eventMapInGit(env) ? 1 : 24;
}

// ---------------------------------------------------------------------------------------------------------------------
// The generation document

export interface DayEntry {
  /** sha256 of the day's canonical NDJSON. */
  sha256: string;
  bytes: number;
  nodes: number;
  /** sha256 of the stored gzip (the blob's content address). */
  blob: string;
  blob_bytes: number;
}

export interface Generation {
  format: number;
  head_seq: number;
  parent: string | null;
  days: Record<string, DayEntry>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * The canonical bytes of a generation: one day a line, ascending, so a day's change is a one-line diff and the
 * `parent` line changes on every write (two writers conflict). Readers refuse any other formatting.
 */
export function serializeGeneration(g: Generation): string {
  const days = Object.keys(g.days)
    .sort()
    .map((d) => {
      const e = g.days[d]!;
      return `${JSON.stringify(d)}: {"sha256": ${JSON.stringify(e.sha256)}, "bytes": ${e.bytes}, "nodes": ${e.nodes}, "blob": ${JSON.stringify(e.blob)}, "blob_bytes": ${e.blob_bytes}}`;
    });
  return (
    `{\n"format": ${g.format},\n"head_seq": ${g.head_seq},\n"parent": ${JSON.stringify(g.parent)},\n` +
    `"components": {"event_map": {"layout": "${EVENT_MAP_LAYOUT}", "node_schema": ${NODE_SCHEMA}, "days": {\n` +
    days.map((l, i) => `${l}${i < days.length - 1 ? ',' : ''}\n`).join('') +
    '}}}\n}\n'
  );
}

/** Parse and check a generation document; throws (fail closed) on an unknown format, layout or node schema, a bad
 *  entry, or bytes that are not the canonical form. */
export function parseGeneration(text: string): Generation {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`generation.json: not JSON (${(e as Error).message})`);
  }
  if (j.format !== GENERATION_FORMAT) {
    throw new Error(`generation.json: format ${JSON.stringify(j.format)}, this code reads format ${GENERATION_FORMAT} only (written by newer code?): refusing to read it`);
  }
  const em = (j.components as { event_map?: Record<string, unknown> } | undefined)?.event_map;
  if (!em || typeof em !== 'object') throw new Error('generation.json: no components.event_map');
  if (em.layout !== EVENT_MAP_LAYOUT) throw new Error(`generation.json: event_map layout ${JSON.stringify(em.layout)}, this code reads "${EVENT_MAP_LAYOUT}" only`);
  if (em.node_schema !== NODE_SCHEMA) throw new Error(`generation.json: node_schema ${JSON.stringify(em.node_schema)}, this code reads ${NODE_SCHEMA} only`);
  if (!isCount(j.head_seq)) throw new Error(`generation.json: head_seq ${JSON.stringify(j.head_seq)}`);
  if (!(j.parent === null || isSha256Hex(j.parent))) throw new Error(`generation.json: parent ${JSON.stringify(j.parent)}`);
  const rawDays = em.days;
  if (!rawDays || typeof rawDays !== 'object' || Array.isArray(rawDays)) throw new Error('generation.json: no event_map.days');
  const days: Record<string, DayEntry> = {};
  for (const [d, v] of Object.entries(rawDays as Record<string, unknown>)) {
    const e = v as Partial<DayEntry>;
    if (!DAY_RE.test(d) || d === SENTINEL_DAY) throw new Error(`generation.json: day ${JSON.stringify(d)}`);
    if (!e || !isSha256Hex(e.sha256) || !isSha256Hex(e.blob) || !isCount(e.bytes) || !isCount(e.nodes) || !isCount(e.blob_bytes)) {
      throw new Error(`generation.json: entry of ${d} unreadable: ${JSON.stringify(v).slice(0, 200)}`);
    }
    days[d] = { sha256: e.sha256, bytes: e.bytes, nodes: e.nodes, blob: e.blob, blob_bytes: e.blob_bytes };
  }
  const g: Generation = { format: j.format, head_seq: j.head_seq, parent: j.parent as string | null, days };
  if (serializeGeneration(g) !== text) throw new Error('generation.json: not in its canonical form (edited by hand?): refusing to read it');
  return g;
}

export interface GenerationFile {
  generation: Generation;
  /** sha256 of the file's bytes: the next generation's `parent`. */
  sha256: string;
}

/** The checkout's generation document, or null when there is none. Throws when it cannot be read (fail closed). */
export function readGeneration(root: string): GenerationFile | null {
  const f = dataPaths(root).generation;
  if (!existsSync(f)) return null;
  const bytes = readFileSync(f);
  return { generation: parseGeneration(bytes.toString('utf8')), sha256: sha256Hex(bytes) };
}

export function writeGeneration(root: string, g: Generation): void {
  const f = dataPaths(root).generation;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, serializeGeneration(g));
}

/** An empty generation (a fresh data branch: scripts/bootstrap-data-branch.sh writes these bytes). */
export const emptyGeneration = (): Generation => ({ format: GENERATION_FORMAT, head_seq: 0, parent: null, days: {} });

const sameEntry = (a: DayEntry | undefined, b: DayEntry | undefined): boolean =>
  !!a && !!b && a.sha256 === b.sha256 && a.bytes === b.bytes && a.nodes === b.nodes && a.blob === b.blob && a.blob_bytes === b.blob_bytes;

const sameDays = (a: Record<string, DayEntry>, b: Record<string, DayEntry>): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameEntry(a[k], b[k]));
};

/** head.json's seq of the checkout (0 when there is none: a fresh branch). */
function headSeqOf(root: string): number {
  const f = dataPaths(root).head;
  if (!existsSync(f)) return 0;
  const seq = (JSON.parse(readFileSync(f, 'utf8')) as { seq?: unknown }).seq;
  if (!isCount(seq)) throw new Error(`head.json: seq ${JSON.stringify(seq)}`);
  return seq;
}

// ---------------------------------------------------------------------------------------------------------------------
// The day files

/** An event-map file name: `YYYY-MM-DD.ndjson` (a day file) or `YYYY-MM-DD-HH.ndjson` (a round-17 hour shard). */
export const EVENT_MAP_FILE = /^(\d{4}-\d{2}-\d{2})(?:-(\d{2}))?\.ndjson$/;
export const isSentinelName = (name: string): boolean => name.startsWith(SENTINEL_DAY);
export const dayFileName = (day: string): string => `${day}.ndjson`;

/** Event-day → its file names (name order: hour shards before the day file), for the given names. The sentinel and
 *  anything that is not an event-map file name are left out. */
export function daysOfNames(names: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of [...names].sort()) {
    const m = EVENT_MAP_FILE.exec(f);
    if (!m || isSentinelName(f)) continue;
    (out.get(m[1]!) ?? out.set(m[1]!, []).get(m[1]!)!).push(f);
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The checkout's event-map files by day (empty when the directory is absent). */
export function eventMapFiles(root: string): Map<string, string[]> {
  const dir = dataPaths(root).eventMapDir;
  return existsSync(dir) ? daysOfNames(readdirSync(dir)) : new Map();
}

export interface CanonicalDay {
  text: string;
  nodes: number;
}

/**
 * The canonical NDJSON of one event-day from the texts of its files in name order: every node once, a feed id found
 * twice keeps the higher `lastSeq` (the later file on a tie, as loadEventMap), the original JSON lines, in feed-id
 * order, each ending in a newline. Byte for byte what saveEventMap writes for the day, whatever layout the files had.
 */
export function canonicalDay(texts: readonly string[]): CanonicalDay {
  const held = new Map<string, { line: string; lastSeq: number }>();
  for (const text of texts) {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const n = JSON.parse(line) as { feedId?: unknown; lastSeq?: unknown };
      if (typeof n.feedId !== 'string') throw new Error(`event map: a line without a feedId: ${line.slice(0, 120)}`);
      const seq = typeof n.lastSeq === 'number' ? n.lastSeq : -1;
      const h = held.get(n.feedId);
      if (!h || h.lastSeq <= seq) held.set(n.feedId, { line, lastSeq: seq });
    }
  }
  const ids = [...held.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { text: ids.map((id) => held.get(id)!.line).join('\n') + (ids.length ? '\n' : ''), nodes: ids.length };
}

/** canonicalDay of the checkout's files of `day`. */
export function readCanonicalDay(root: string, names: readonly string[]): CanonicalDay {
  const dir = dataPaths(root).eventMapDir;
  return canonicalDay(names.map((f) => readFileSync(join(dir, f), 'utf8')));
}

/**
 * The layout move: every day held in any other file than its day file (hour shards, or a mix after an old code's run)
 * is written as its canonical day file, and its other files removed. Aggregate runs it only once git no longer tracks
 * the event map (phase 3b: the files never reach git; the authoritative hydrate already writes day files, so it
 * usually finds nothing). Returns the days moved.
 */
export function moveToDayLayout(root: string): string[] {
  const dir = dataPaths(root).eventMapDir;
  const moved: string[] = [];
  for (const [day, names] of eventMapFiles(root)) {
    if (names.length === 1 && names[0] === dayFileName(day)) continue;
    const { text } = readCanonicalDay(root, names);
    writeFileSync(join(dir, dayFileName(day)), text);
    for (const f of names) if (f !== dayFileName(day)) rmSync(join(dir, f));
    moved.push(day);
  }
  return moved;
}

// ---------------------------------------------------------------------------------------------------------------------
// The live floor

export type FloorSource = 'generation' | 'checkout' | 'tree' | 'empty-generation' | 'bootstrap';

/**
 * The live pipeline's first event-day: backfill fills strictly before it, onboarding at and after it, archive never
 * archives a month that reaches it. In order: the generation's oldest day; the checkout's oldest event-map file; on a
 * sparse checkout (backfill.yml) the oldest event-map name in git's tree; otherwise it throws: a floor read as "today"
 * would let backfill write the days the live pipeline owns. Two explicit starts answer today: a generation that exists
 * and names no day while no event-map file exists anywhere (the empty generation scripts/bootstrap-data-branch.sh and
 * reset-data-branch.sh write: a fresh branch until its first aggregate run), and EVENT_MAP_BOOTSTRAP=1.
 */
export function liveFloorOf(root: string, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): { day: string; source: FloorSource } {
  const gen = readGeneration(root);
  const genDays = gen ? Object.keys(gen.generation.days).sort() : [];
  if (genDays.length) return { day: genDays[0]!, source: 'generation' };
  const disk = [...eventMapFiles(root).keys()];
  if (disk.length) return { day: disk[0]!, source: 'checkout' };
  if (isSparseCheckout(root)) {
    const tree = [...daysOfNames(treeNames(root, 'knowledge/index/event_map')).keys()];
    if (tree.length) return { day: tree[0]!, source: 'tree' };
  }
  if (gen && genDays.length === 0) return { day: dayKey(nowMs), source: 'empty-generation' };
  if (env.EVENT_MAP_BOOTSTRAP === '1') return { day: dayKey(nowMs), source: 'bootstrap' };
  throw new Error(
    'event map: no live floor (no generation day, no event-map file in the checkout or in git): refusing to read it as today, ' +
      'which would let backfill write the days the live pipeline owns (EVENT_MAP_BOOTSTRAP=1 on a fresh data branch)',
  );
}

export const liveFloor = (root: string, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): string => liveFloorOf(root, nowMs, env).day;

// ---------------------------------------------------------------------------------------------------------------------
// persist, prune

export class PersistRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistRefused';
  }
}

export interface PersistReport {
  /** The generation file was rewritten. */
  written: boolean;
  days: number;
  /** Days whose blob was uploaded. */
  uploaded: string[];
  uploadedBytes: number;
  /** Days of the previous generation below the cutoff that left the checkout (derive's prune). */
  dropped: string[];
  headSeq: number;
}

async function inPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async (): Promise<void> => {
    while (failed === null && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (e) {
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== null) throw failed;
}

/**
 * Persist the checkout's event map to the store and write the generation that names it (aggregate, after the
 * Aggregate step and before its commit). The checkout's days are the truth: each is canonicalized, a day whose sha256
 * differs from its entry is gzipped and PUT (blob = the sha256 of the gzip), new days are added. A day the previous
 * generation lists that the checkout lacks throws (PersistRefused), never read as removed, unless it is below
 * `cutoffDay` (derive pruned it). Every PUT completes before the generation is written: on any store error nothing is
 * written, so a generation only ever names blobs that exist; the next run uploads again (its sha differs). An unchanged
 * set of entries leaves the file untouched.
 */
export async function persist(root: string, backend: StateBackend, opts: { cutoffDay: string; concurrency?: number }): Promise<PersistReport> {
  const prev = readGeneration(root);
  const prevDays = prev?.generation.days ?? {};
  const files = eventMapFiles(root);
  const dropped: string[] = [];
  const lost: string[] = [];
  for (const day of Object.keys(prevDays).sort()) {
    if (files.has(day)) continue;
    if (day < opts.cutoffDay) dropped.push(day);
    else lost.push(day);
  }
  if (lost.length) {
    throw new PersistRefused(
      `event map: the generation lists ${lost.length} day(s) the checkout lacks (${lost.slice(0, 5).join(', ')}${lost.length > 5 ? ', …' : ''}), ` +
        `not below the horizon ${opts.cutoffDay}: refusing to read them as removed`,
    );
  }
  const days: Record<string, DayEntry> = {};
  const todo: { day: string; gz: Buffer; entry: DayEntry }[] = [];
  for (const [day, names] of files) {
    const { text, nodes } = readCanonicalDay(root, names);
    const sha = sha256Hex(text);
    const bytes = Buffer.byteLength(text);
    const held = prevDays[day];
    if (held && held.sha256 === sha && held.bytes === bytes && held.nodes === nodes) {
      days[day] = held;
      continue;
    }
    const gz = gzipSync(text, { level: BLOB_GZIP_LEVEL });
    const entry: DayEntry = { sha256: sha, bytes, nodes, blob: sha256Hex(gz), blob_bytes: gz.length };
    days[day] = entry;
    todo.push({ day, gz, entry });
  }
  await inPool(todo, opts.concurrency ?? PUT_CONCURRENCY, async (t) => {
    const r = await backend.put(t.entry.blob, t.gz);
    if (r.size !== t.gz.length) throw new StateStoreError(`put ${t.day}: the store holds ${r.size} bytes, sent ${t.gz.length}`, 'integrity');
  });
  const headSeq = headSeqOf(root);
  const written = !prev || !sameDays(prevDays, days);
  if (written) writeGeneration(root, { format: GENERATION_FORMAT, head_seq: headSeq, parent: prev?.sha256 ?? null, days });
  return { written, days: Object.keys(days).length, uploaded: todo.map((t) => t.day), uploadedBytes: todo.reduce((n, t) => n + t.gz.length, 0), dropped, headSeq };
}

/**
 * derive's prune of the generation: the days below `cutoffDay` leave it (derive deletes their day files in the same
 * run, pruneEventMapShards). Pure: no network, the blobs stay until GC. No generation, or nothing below the cutoff:
 * nothing written. Returns the days removed.
 */
export function pruneGeneration(root: string, cutoffDay: string): string[] {
  const prev = readGeneration(root);
  if (!prev) return [];
  const removed = Object.keys(prev.generation.days).filter((d) => d < cutoffDay).sort();
  if (!removed.length) return [];
  const days = { ...prev.generation.days };
  for (const d of removed) delete days[d];
  writeGeneration(root, { format: GENERATION_FORMAT, head_seq: headSeqOf(root), parent: prev.sha256, days });
  return removed;
}

// ---------------------------------------------------------------------------------------------------------------------
// hydrate

export type HydrateMode = 'shadow' | 'authoritative';

export interface HydrateReport {
  mode: HydrateMode;
  /** No generation document in the checkout (before the first persist): nothing to compare. */
  noGeneration: boolean;
  days: number;
  blobBytes: number;
  /** shadow: each difference between the store and the checkout, one line each. */
  mismatches: string[];
  /** authoritative: the days written. */
  written: string[];
  /** The days whose blobs were fetched (authoritative: those not already identical on disk; shadow: changed ∪ sampled). */
  fetched: string[];
  /** shadow: the days whose checkout differs from their generation entry (or that the checkout lacks): always fetched. */
  changed: string[];
  /** shadow: the rotating sample fetched beside them (shadowSample, without the changed days). */
  sampled: string[];
  /** The batchGet batches the fetch was planned into (each one request unless retried). */
  batches: number;
  /** ms of local work (reading and canonicalizing the checkout's days) before the first store request. */
  localMs: number;
  headSeq: number | null;
}

/** blob → its stored size, from the generation: plans the batches by bytes and times each attempt. */
export const blobSizes = (g: Generation): Map<string, number> => new Map(Object.values(g.days).map((e) => [e.blob, e.blob_bytes]));

/** The NDJSON of each generation day from the store, every check applied (throws on the first failure). */
export async function fetchGenerationDays(backend: StateBackend, g: Generation, stats?: GetBlobsStats): Promise<Map<string, string>> {
  const blobs = await getBlobs(
    backend,
    Object.values(g.days).map((e) => e.blob),
    { sizes: blobSizes(g), stats },
  );
  const out = new Map<string, string>();
  for (const [day, e] of Object.entries(g.days).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const gz = blobs.get(e.blob);
    if (!gz) throw new StateStoreError(`hydrate ${day}: blob ${e.blob} not returned`, 'missing');
    if (gz.length !== e.blob_bytes) throw new StateStoreError(`hydrate ${day}: blob ${e.blob} is ${gz.length} bytes, the generation says ${e.blob_bytes}`, 'integrity');
    let text: Buffer;
    try {
      text = gunzipSync(gz);
    } catch (err) {
      throw new StateStoreError(`hydrate ${day}: blob ${e.blob} is not gzip (${(err as Error).message})`, 'integrity');
    }
    if (text.length !== e.bytes || sha256Hex(text) !== e.sha256) {
      throw new StateStoreError(`hydrate ${day}: the NDJSON of blob ${e.blob} (${text.length} bytes, sha256 ${sha256Hex(text)}) is not the generation's (${e.bytes} bytes, ${e.sha256})`, 'integrity');
    }
    const s = text.toString('utf8');
    const nodes = canonicalDay([s]);
    if (nodes.text !== s || nodes.nodes !== e.nodes) throw new StateStoreError(`hydrate ${day}: blob ${e.blob} is not a canonical day of ${e.nodes} nodes`, 'integrity');
    out.set(day, s);
  }
  return out;
}

/**
 * Hydrate the checkout's event map from the store. `shadow` (phase 3a) compares every checked-out day with its
 * generation entry (each difference a mismatch line) and fetches and verifies the days that differ plus a rotating
 * sample of `sample` days (SHADOW_SAMPLE_DAYS; `rotation` from shadowRotation), so the store is exercised every run and
 * every blob about hourly; the checkout is never written. A store or integrity failure throws; the caller reports it.
 * `authoritative` (phase 3b) replaces the directory with exactly the generation's days (the sentinel kept), fetching
 * every day not already identical on disk, and throws on anything, including a missing generation unless
 * EVENT_MAP_BOOTSTRAP=1. Both refuse a generation ahead of head.json (its head_seq above the checkout's seq).
 */
export async function hydrate(
  root: string,
  backend: StateBackend | (() => StateBackend),
  opts: { mode: HydrateMode; env?: NodeJS.ProcessEnv; sample?: number; rotation?: number },
): Promise<HydrateReport> {
  const env = opts.env ?? process.env;
  const t0 = Date.now();
  // `backend` may be a factory, called once the local work is done: main builds the backend there, so the step's
  // deadline starts with the store requests and the canonicalization of ~78 MB of checkout does not eat into it.
  const connect = (): StateBackend => {
    report.localMs = Date.now() - t0;
    return typeof backend === 'function' ? backend() : backend;
  };
  const gen = readGeneration(root);
  const report: HydrateReport = {
    mode: opts.mode,
    noGeneration: !gen,
    days: 0,
    blobBytes: 0,
    mismatches: [],
    written: [],
    fetched: [],
    changed: [],
    sampled: [],
    batches: 0,
    localMs: 0,
    headSeq: gen?.generation.head_seq ?? null,
  };
  const dir = dataPaths(root).eventMapDir;
  if (!gen) {
    if (opts.mode === 'authoritative' && env.EVENT_MAP_BOOTSTRAP !== '1') {
      throw new Error('hydrate: no knowledge/index/generation.json in the checkout: refusing to start from an empty event map (EVENT_MAP_BOOTSTRAP=1 on a fresh data branch)');
    }
    if (opts.mode === 'authoritative') mkdirSync(dir, { recursive: true });
    return report;
  }
  const g = gen.generation;
  const head = headSeqOf(root);
  if (g.head_seq > head) throw new Error(`hydrate: the generation was written at seq ${g.head_seq}, head.json is at ${head}: a generation ahead of its commit`);
  const stats: GetBlobsStats = { batches: 0, blobs: 0, bytes: 0 };
  const files = eventMapFiles(root);
  const days = Object.keys(g.days).sort();
  report.days = days.length;
  const only = (keep: ReadonlySet<string>): Generation => ({ ...g, days: Object.fromEntries(Object.entries(g.days).filter(([d]) => keep.has(d))) });
  if (opts.mode === 'authoritative') {
    // A day whose files on disk already canonicalize to the entry's sha256 is that content: it is rewritten from disk,
    // not fetched (derive-publish's hydrate after the aggregate commit then fetches only what a rebase removed).
    const have = new Map<string, string>();
    for (const [day, e] of Object.entries(g.days)) {
      const names = files.get(day);
      if (!names) continue;
      const c = readCanonicalDay(root, names);
      if (c.nodes === e.nodes && Buffer.byteLength(c.text) === e.bytes && sha256Hex(c.text) === e.sha256) have.set(day, c.text);
    }
    const missing = only(new Set(days.filter((d) => !have.has(d))));
    const fetched = Object.keys(missing.days).length ? await fetchGenerationDays(connect(), missing, stats) : new Map<string, string>();
    report.blobBytes = Object.values(missing.days).reduce((n, e) => n + e.blob_bytes, 0);
    report.fetched = [...fetched.keys()];
    report.batches = stats.batches;
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) if (!isSentinelName(f)) rmSync(join(dir, f), { recursive: true, force: true });
    for (const day of days) {
      writeFileSync(join(dir, dayFileName(day)), have.get(day) ?? fetched.get(day)!);
      report.written.push(day);
    }
    return report;
  }
  // shadow: the checkout against the generation first (no network: a mismatch is a difference between the two whatever
  // the store holds), then the store exercised with the days that differ and the rotating sample, each blob verified
  // against its entry (the store is what is under test; a blob the sample has not reached yet is verified within the
  // hour, and phase 3b's authoritative hydrate fetches every one anyway).
  for (const day of days) {
    const e = g.days[day]!;
    const names = files.get(day);
    if (!names) {
      report.mismatches.push(`${day}: in the generation, not in the checkout`);
      report.changed.push(day);
      continue;
    }
    const sha = sha256Hex(readCanonicalDay(root, names).text);
    if (sha !== e.sha256) {
      report.mismatches.push(`${day}: the store's day (sha256 ${e.sha256.slice(0, 12)}) differs from the checkout's (${sha.slice(0, 12)})`);
      report.changed.push(day);
    }
  }
  for (const day of files.keys()) if (!g.days[day]) report.mismatches.push(`${day}: in the checkout, not in the generation`);
  const changed = new Set(report.changed);
  report.sampled = shadowSample(days, opts.rotation ?? shadowRotation(env), opts.sample ?? SHADOW_SAMPLE_DAYS).filter((d) => !changed.has(d));
  const want = only(new Set([...report.changed, ...report.sampled]));
  const texts = Object.keys(want.days).length ? await fetchGenerationDays(connect(), want, stats) : new Map<string, string>();
  report.fetched = [...texts.keys()];
  report.blobBytes = Object.values(want.days).reduce((n, e) => n + e.blob_bytes, 0);
  report.batches = stats.batches;
  return report;
}

// ---------------------------------------------------------------------------------------------------------------------
// The phase-3b staging assert

export const EVENT_MAP_PATH = 'knowledge/index/event_map';
export const EVENT_MAP_LEGACY_PATH = 'knowledge/index/event_map.ndjson';

/**
 * The staged event-map paths a phase-3b commit must not carry: anything added or modified under
 * knowledge/index/event_map/ but the sentinel, or the legacy file. Deletions pass (the phase-3b transition commit
 * untracks every day file). `nameStatus`: `git diff --cached --name-status --no-renames` lines.
 */
export function eventMapStagingProblems(nameStatus: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of nameStatus) {
    const [status, path] = l.split('\t');
    if (!status || !path || status.startsWith('D')) continue;
    if (path === EVENT_MAP_LEGACY_PATH) out.push(`${status} ${path}`);
    else if (path.startsWith(`${EVENT_MAP_PATH}/`) && path !== `${EVENT_MAP_PATH}/${SENTINEL_FILE}`) out.push(`${status} ${path}`);
  }
  return out;
}

/**
 * The commit hook of every committer that stages `knowledge` (aggregate.yml after its `git add`; src/stage-data.ts for
 * derive-publish, backfill and archive): with EVENT_MAP_IN_GIT=0 (phase 3b), throws when an event-map path but the
 * sentinel is staged (a lost `.gitignore` line would otherwise re-track 78 MB silently). Phase 3a: off.
 */
export function assertEventMapNotStaged(git: (args: string[]) => string, env: NodeJS.ProcessEnv = process.env): { checked: boolean; problems: string[] } {
  if (eventMapInGit(env)) return { checked: false, problems: [] };
  const lines = git(['diff', '--cached', '--name-status', '--no-renames', '--', EVENT_MAP_PATH, EVENT_MAP_LEGACY_PATH]).split('\n').filter(Boolean);
  const problems = eventMapStagingProblems(lines);
  if (problems.length) {
    throw new Error(
      `event map staged for a commit while EVENT_MAP_IN_GIT=0 (phase 3b: the store holds it, git only the sentinel): ${problems.slice(0, 5).join(', ')}` +
        `${problems.length > 5 ? ', …' : ''}; is the .gitignore line ${EVENT_MAP_PATH}/* missing?`,
    );
  }
  return { checked: true, problems };
}

/** The `.gitignore` lines of phase 3b: the day files are not tracked, the sentinel is. */
export const IGNORE_LINES = [`${EVENT_MAP_PATH}/*`, `!${EVENT_MAP_PATH}/${SENTINEL_FILE}`] as const;

/** The sentinel's one line: not JSON on purpose, so code from before phase 3a that reads it throws instead of taking
 *  an untracked event map as empty, and its live floor (the oldest name) becomes 0000-00-00 (backfill writes nothing). */
export const SENTINEL_TEXT = 'phase 3b sentinel: the event map lives in the state store (knowledge/index/generation.json); this line is not JSON on purpose\n';

/**
 * The phase-3b transition, in the aggregate commit step before its `git add` (EVENT_MAP_IN_GIT=0 only; a no-op while
 * git tracks the event map): the ignore lines, the tracked sentinel, and every other tracked event-map path out of the
 * index (`git rm --cached`: the files stay on disk). Idempotent: after the transition commit nothing is tracked but the
 * sentinel and it changes nothing. Returns the paths it untracked.
 */
export function untrackEventMap(root: string, git: (args: string[]) => string, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (eventMapInGit(env)) return null;
  ensureIgnoreLines(root);
  const sentinel = join(dataPaths(root).eventMapDir, SENTINEL_FILE);
  if (!existsSync(sentinel) || readFileSync(sentinel, 'utf8') !== SENTINEL_TEXT) {
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, SENTINEL_TEXT);
  }
  const tracked = git(['ls-files', '-z', '--', EVENT_MAP_PATH, EVENT_MAP_LEGACY_PATH]).split('\0').filter((p) => p && p !== `${EVENT_MAP_PATH}/${SENTINEL_FILE}`);
  if (tracked.length) git(['rm', '-q', '--cached', '--', ...tracked]);
  git(['add', '-f', '--', `${EVENT_MAP_PATH}/${SENTINEL_FILE}`, '.gitignore']);
  return tracked;
}

/** Phase 3b: add the ignore lines to the data checkout's .gitignore when missing (aggregate stages .gitignore). */
export function ensureIgnoreLines(root: string): boolean {
  const f = join(root, '.gitignore');
  const text = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const add = IGNORE_LINES.filter((l) => !have.has(l));
  if (!add.length) return false;
  writeFileSync(f, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reports and the command line

export interface StateMarker {
  step: 'hydrate' | 'persist';
  ok: boolean;
  /** No store configured (FEED_STATE_BACKEND off). */
  off?: boolean;
  mode?: HydrateMode;
  at: string;
  run_id?: string;
  data_commit?: string;
  summary: string;
  mismatches?: string[];
  error?: string;
  error_kind?: string;
}

/**
 * The marker a step writes when it starts, before any request: not ok, error_kind `killed`. The step overwrites it with
 * its real report when it ends, so it survives only when the runner killed the step (its timeout-minutes) before it
 * could report: health then sees a hung store as a failed step (feed:state-shadow), not as a missing marker.
 */
export function markStarted(step: StateMarker['step'], common: Pick<StateMarker, 'at' | 'run_id' | 'data_commit'>, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.FEED_STATE_MARKER_DIR) return;
  const m: StateMarker = {
    step,
    ok: false,
    ...common,
    summary: 'started and never reported: the step was killed before it ended (its timeout-minutes; a hanging store or OIDC endpoint?)',
    error_kind: 'killed',
  };
  mkdirSync(env.FEED_STATE_MARKER_DIR, { recursive: true });
  writeFileSync(join(env.FEED_STATE_MARKER_DIR, `${step}.json`), `${JSON.stringify(m, null, 2)}\n`);
}

/** The step's marker for the health workflow (FEED_STATE_MARKER_DIR/<step>.json, uploaded as the artifact
 *  state-shadow), its step-summary line and its log line. */
export function report(m: StateMarker, env: NodeJS.ProcessEnv = process.env, log: (l: string) => void = console.log): void {
  log(`state ${m.step}: ${m.summary}`);
  for (const x of (m.mismatches ?? []).slice(0, 20)) log(`  mismatch ${x}`);
  if (!m.ok && !m.off) log(`::warning title=State ${m.step}::${m.summary.replace(/\n/g, ' ').slice(0, 400)}`);
  if (env.FEED_STATE_MARKER_DIR) {
    mkdirSync(env.FEED_STATE_MARKER_DIR, { recursive: true });
    writeFileSync(join(env.FEED_STATE_MARKER_DIR, `${m.step}.json`), `${JSON.stringify(m, null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      const lines = [`### State ${m.step}${m.mode ? ` (${m.mode})` : ''}`, '', m.summary, ...(m.mismatches ?? []).slice(0, 50).map((x) => `- ${x}`), ''];
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
    } catch {
      /* the summary is a convenience */
    }
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const root = env.DATA_DIR ?? DATA_DIR;
  const cmd = argv[0];
  const at = new Date().toISOString();
  const common = { at, run_id: env.GITHUB_RUN_ID, data_commit: gitHead(root) };
  const modeArg = argv.indexOf('--mode') >= 0 ? argv[argv.indexOf('--mode') + 1] : undefined;
  const authoritative = EVENT_MAP_STORE_AUTHORITATIVE;
  if (cmd === 'layout') {
    const moved = moveToDayLayout(root);
    console.log(`event map layout: ${moved.length ? `${moved.length} day(s) moved to day files (${moved[0]} … ${moved.at(-1)})` : 'every day is a day file'}`);
    return 0;
  }
  if (cmd === 'floor') {
    const f = liveFloorOf(root, Date.now(), env);
    console.log(`event map live floor: ${f.day} (from the ${f.source})`);
    return 0;
  }
  if (cmd === 'untrack') {
    const r = untrackEventMap(root, (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }), env);
    console.log(r == null ? 'event map: still tracked by git (EVENT_MAP_IN_GIT=1, phase 3a)' : `event map: ${r.length} path(s) untracked; the sentinel and the ignore lines staged`);
    return 0;
  }
  if (cmd === 'stage') {
    // aggregate.yml's commit step, after its `git add`: the phase-3b transition (untrack) and the staging check; both do
    // nothing while git tracks the event map (phase 3a).
    const git = (args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const untracked = untrackEventMap(root, git, env);
    const r = assertEventMapNotStaged(git, env);
    console.log(
      untracked == null
        ? 'event map staging: not checked (EVENT_MAP_IN_GIT=1: git tracks the event map in phase 3a)'
        : `event map staging: ${untracked.length ? `${untracked.length} path(s) untracked (the phase-3b transition), ` : ''}no event-map path but the sentinel staged (checked: ${r.checked})`,
    );
    return 0;
  }
  if (cmd === 'assert-staged') {
    const r = assertEventMapNotStaged((args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }), env);
    console.log(r.checked ? 'event map staging: no event-map path but the sentinel staged (EVENT_MAP_IN_GIT=0)' : 'event map staging: not checked (EVENT_MAP_IN_GIT=1: git tracks the event map in phase 3a)');
    return 0;
  }
  if (cmd !== 'hydrate' && cmd !== 'persist') {
    console.error('usage: event-map-store.ts hydrate [--mode shadow|authoritative] [--3b-only] | persist | layout | floor | stage | untrack | assert-staged');
    return 3;
  }
  // The steps that exist for phase 3b only (derive-publish's re-hydrate after the push, first-solutions' hydrate): in
  // phase 3a the checkout holds the event map and they do nothing.
  if (argv.includes('--3b-only') && !authoritative) {
    console.log(`state ${cmd}: phase 3a (git holds the event map): nothing to do`);
    return 0;
  }
  markStarted(cmd, common, env);
  const t0 = Date.now();
  const mode: HydrateMode = modeArg === 'authoritative' || modeArg === 'shadow' ? modeArg : authoritative ? 'authoritative' : 'shadow';
  let backend: StateBackend | null;
  try {
    const policy = stepPolicy(cmd, cmd === 'hydrate' ? mode : null, t0);
    backend = backendFromEnv(env, policy ? { policy } : {});
  } catch (e) {
    report({ step: cmd, ok: false, ...common, summary: `store misconfigured: ${errText(e)}`, error: errText(e), error_kind: 'config' }, env);
    return authoritative ? 1 : 0;
  }
  if (!backend) {
    report({ step: cmd, ok: true, off: true, ...common, summary: 'state store off (FEED_STATE_BACKEND off): nothing read or written' }, env);
    if (authoritative) {
      console.error('::error::the state store is required once it is authoritative (phase 3b)');
      return 1;
    }
    return 0;
  }
  if (cmd === 'hydrate') {
    try {
      // The step's deadline (stepPolicy) starts when the store requests do, after hydrate's local comparison: the
      // backend is built again there with a policy from that instant (the first one above checked the configuration).
      const first = backend;
      const r = await hydrate(root, () => backendFromEnv(env, { policy: stepPolicy('hydrate', mode, Date.now())! }) ?? first, { mode, env });
      const ms = Date.now() - t0;
      const mb = `${(r.blobBytes / 1e6).toFixed(1)} MB in ${r.batches} batch(es)`;
      const summary = r.noGeneration
        ? `no generation.json in the checkout yet (before the first persist): nothing to ${mode === 'shadow' ? 'compare' : 'hydrate'}`
        : mode === 'shadow'
          ? `${r.days} day(s) compared with the checkout; ${r.fetched.length} fetched and verified (${r.changed.length} changed, ${r.sampled.length} sampled: ${r.sampled.join(' ') || 'none'}), ` +
            `${mb} from ${backend.label} in ${ms} ms (${r.localMs} ms of it local); ${r.mismatches.length ? `${r.mismatches.length} MISMATCH(ES) with the checkout` : 'identical to the checkout'} (generation at seq ${r.headSeq})`
          : `${r.written.length} day(s) written, ${r.fetched.length} fetched (${mb}) from ${backend.label} (the rest already identical on disk) in ${ms} ms (${r.localMs} ms of it local; generation at seq ${r.headSeq})`;
      report({ step: 'hydrate', ok: r.mismatches.length === 0, mode, ...common, summary, mismatches: r.mismatches }, env);
      return 0;
    } catch (e) {
      report({ step: 'hydrate', ok: false, mode, ...common, summary: `failed: ${errText(e)}`, error: errText(e), error_kind: e instanceof StateStoreError ? e.kind : 'error' }, env);
      return mode === 'authoritative' ? 1 : 0;
    }
  }
  const cutoffDay = dayKey(Date.now() - EVENT_MAP_HORIZON_DAYS * DAY_MS);
  try {
    if (authoritative && ensureIgnoreLines(root)) console.log('state persist: the event-map ignore lines added to .gitignore');
    const r = await persist(root, backend, { cutoffDay });
    const summary =
      `${r.days} day(s); ${r.uploaded.length ? `${r.uploaded.length} uploaded (${r.uploaded.join(', ')}, ${(r.uploadedBytes / 1e6).toFixed(2)} MB)` : 'nothing uploaded'}` +
      `${r.dropped.length ? `; ${r.dropped.length} pruned day(s) left the generation` : ''}; generation ${r.written ? `written at seq ${r.headSeq}` : 'unchanged'} (${Date.now() - t0} ms, ${backend.label})`;
    report({ step: 'persist', ok: true, ...common, summary }, env);
    return 0;
  } catch (e) {
    // Phase 3a: git still holds the event map; the generation is left as it was (it names only blobs that exist) and
    // the next run uploads again. Phase 3b: the commit must not go out without its state.
    report({ step: 'persist', ok: false, ...common, summary: `failed, generation.json left unchanged: ${errText(e)}`, error: errText(e), error_kind: e instanceof StateStoreError ? e.kind : e instanceof PersistRefused ? 'refused' : 'error' }, env);
    return authoritative || e instanceof PersistRefused ? 1 : 0;
  }
}

function gitHead(root: string): string | undefined {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`event-map-store: ${errText(e)}`);
      process.exitCode = 1;
    },
  );
}
