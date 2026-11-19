import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/**
 * The state store client (storage phase 3; APIs.md "Repository size"): content-addressed blobs that hold the feed's
 * working state outside git. In phase 3 the event map's day files live there; the generation document that names them
 * (knowledge/index/generation.json, src/event-map-store.ts) stays in git, committed with the commit whose state it
 * describes, so `git push` remains the one compare-and-swap of the whole state.
 *
 * Two backends behind one interface:
 * - WorkerBackend: the `earthquakes-feed-state` Worker (state/, its own README), over HTTPS. No static secret exists
 *   anywhere: every request carries a GitHub Actions OIDC token minted for the audience `earthquakes-feed-state`, and
 *   the Worker admits only tokens of this repository's main branch, from the workflows each route allows. One R2
 *   bucket behind it, keys `cas/sha256/<first 2 hex>/<hex>`, the hex being the sha256 of the stored bytes (a day's
 *   NDJSON, gzipped). The bucket is S3-portable: the exit path is an `rclone` of the bucket and a backend for any S3.
 * - FsBackend: a local directory with the same key layout (tests, scripts/phase3/dryrun.sh, a disaster replay).
 *
 * FEED_STATE_BACKEND selects it: `worker`, `fs:<dir>`, or unset (no store: the steps that use it report "off").
 * FEED_STATE_URL (default https://feed-state.theshelter.app) and FEED_STATE_AUDIENCE (default earthquakes-feed-state)
 * point the Worker backend at production or staging (state-rehearsal.yml).
 *
 * The HTTP contract (protocol 1; the Worker refuses an older protocol on writes and gc with 426):
 *   every request   Authorization: Bearer <GitHub OIDC JWT>, User-Agent: earthquakes-feed-state-client/1,
 *                   x-feed-state-protocol: 1
 *   PUT  /v1/cas/sha256/<hex>       body = the blob (Content-Type application/gzip, Content-Length required: 411
 *                                   without, 413 over 25 MiB); R2 checks the bytes against <hex> (400 on a mismatch).
 *                                   200 {key, size, uploaded}. Always written, never skipped: the same key holds the
 *                                   same bytes, and the write refreshes `uploaded`, which GC's age rule reads.
 *   POST /v1/cas:batchGet           body {"shas": [hex, …]} (1–40 unique); 200 application/octet-stream, a framed
 *                                   stream: per blob `BLOB <hex> <length>\n` + bytes + `\n`, a missing one
 *                                   `MISSING <hex>\n`, then `END <count>\n`. The client fails closed on a MISSING and
 *                                   on any length or sha256 mismatch; a stream cut short (no trailer) keeps the blobs
 *                                   it delivered whole and verified and asks again for the rest (getBlobs below: at
 *                                   most BATCH_MAX_BYTES a request, BATCH_CONCURRENCY in flight).
 *   POST /v1/gc                     body {keep (1–10,000), current (1–40 on the first page, none later), cursor,
 *                                   minAgeDays ≥ 14, maxDeletes ≤ 1,000, dryRun}: one listing page; 200 {listed,
 *                                   deleted, bytesDeleted, wouldDelete, bytesWouldDelete, kept, young, capped,
 *                                   foreign, cursor|null, dryRun} (deleted/bytesDeleted: removed by this call, 0 in a
 *                                   dry run; wouldDelete/bytesWouldDelete: what the rules select); 409 when `current`
 *                                   is not in `keep` or a `current` blob is missing.
 *   GET  /v1/budget                 200 {day, used: {class_a, class_b, bytes_written, requests, refused},
 *                                   stored_bytes, stored_seeded_at, gc_pass_open, ceilings: {class_a, class_b,
 *                                   bytes_written, stored_bytes}} (health reads it; scripts/feed-health.mjs).
 *   400 {"error":"checksum mismatch…"} a PUT whose bytes do not hash to its key (kind integrity); any other 400 is a
 *   request the client should not have sent (kind client) · 401 bad or missing token · 403 a workflow the route does
 *   not allow · 426 protocol too old · 429 {"error":"budget"} a free-tier ceiling is reached (never retried: the store
 *   refuses until 00:00 UTC) · 500 {"error":"misconfigured: …"} a deploy error (never retried, kind config) · other
 *   429 and 5xx: retried, after the answer's Retry-After when it names at most 60 s (a longer one ends the retries) ·
 *   503 {"error":"unavailable"}: the Worker's isolate has no GitHub signing key yet (GitHub's JWKS unreachable and no
 *   copy in its isolate, colo cache or bucket); retried after at most KEYS_UNAVAILABLE_WAIT_MS whatever Retry-After says
 *   (that isolate fetches again within seconds, and the next attempt may reach another isolate), inside the deadline.
 *   A Cloudflare error 1027 (the account's daily Workers requests are used up) is kind `quota`, never retried (it
 *   lasts until 00:00 UTC); a platform 429 that outlives the retries is kind `quota` too (feed:state-quota).
 *
 * Protocol 2 (storage phase 4.0; additive, nothing in the production pipeline calls it yet): CAS refs, one per writer
 * lane (main, main-shadow, first-solutions, history), and their reflog. Every ref call sends x-feed-state-protocol 2;
 * the blob routes above keep sending 1 until 4.3's flip (MIN_PROTOCOL then fences pre-flip runs).
 *   GET  /v1/refs/<lane>            200 the ref's canonical JSON with a strong ETag, or 404 {"error":"no ref"}.
 *   PUT  /v1/refs/<lane>            body = the new ref (canonical JSON ≤ 4 KiB), If-Match: "<etag>" of the ref it
 *                                   replaces, or If-None-Match: * for the lane's first ref (428 without either).
 *                                   200 {lane, seq, generation, etag, reflog: {previous, entry}}; 412 {current, etag}
 *                                   when the ref is no longer the version named (fail closed, never rebased); 409
 *                                   when the body is not the successor (seq + 1, parent = current generation, head_seq
 *                                   not backwards) or its generation blob is missing. A body with `restore_of` is a
 *                                   restore (state-restore.yml in the Environment state-restore only).
 *   GET  /v1/gen/<lane>?after&limit 200 {lane, entries: [{seq, generation, parent, head_seq, data_commit, written,
 *                                   writer, restore_of, uploaded, size}], next}: the reflog, ascending, ≤ 1,000 a page.
 *   An answer whose outcome is unknown (a timeout, a cut connection, a 5xx after the swap) is reconciled by swapRef:
 *   re-GET the ref; our writer nonce there means it landed, the ETag still the one named means retry, anything else is
 *   a 412 (state/README.md "Protocol 2").
 */

export const STATE_PROTOCOL = 1;
export const STATE_USER_AGENT = 'earthquakes-feed-state-client/1';
export const DEFAULT_STATE_URL = 'https://feed-state.theshelter.app';
export const DEFAULT_STATE_AUDIENCE = 'earthquakes-feed-state';
/** At most this many blobs per batchGet (the Worker's limit; a Free-plan invocation's subrequests stay well inside). */
export const BATCH_MAX = 40;
/**
 * At most this many blob bytes (the generation's blob_bytes) per batchGet: about 9 day blobs, so the 46 days (12.2 MB)
 * are 6 requests, not 2. One 40-blob answer is about 10 MB streamed through the Worker in one response, and a stall
 * anywhere in it cost the whole answer: phase 3a's shadow hydrate failed about once in 200 runs that way (runs
 * 44043134871 and 44177064278 on 2026-11-17, "the stream broke: This operation was aborted" after 15 s of a 40-blob
 * body; 44403949467 on 2026-11-18, a 6-blob request that never answered, twice). Smaller answers fail less often, are
 * retried on their own, cost less to repeat, and keep a Worker invocation's subrequests near 10 instead of 41.
 */
export const BATCH_MAX_BYTES = 2_500_000;
/** batchGets in flight at once (getBlobs): 46 days in two waves; the Worker sees at most three of this run's at a time. */
export const BATCH_CONCURRENCY = 3;
/**
 * Attempts per batch, independent of the policy's `attempts` (which bounds every other request): each batch is retried
 * on its own and asks only for the blobs it has not yet received and verified, so a retry is cheap and short. The step
 * deadline and the retry budget still bound it.
 */
export const BATCH_ATTEMPTS = 4;
/**
 * A batch attempt's timeout: BATCH_TIMEOUT_BASE_MS (the token check and the first byte: about 0.1–0.6 s, once 3.4 s on
 * a cold isolate) plus BATCH_MS_PER_MB for every MB it asks for (a floor of 0.5 MB/s; a healthy answer streams 10 MB in
 * about 1.5 s), capped by the policy's timeoutMs: 10 s for a full 2.5 MB batch, 5.6 s for one 0.3 MB day. A stalled
 * attempt is cut after seconds, not after the 15–20 s the largest answer needed, and the retry still fits the deadline.
 */
export const BATCH_TIMEOUT_BASE_MS = 5_000;
export const BATCH_MS_PER_MB = 2_000;
/** A blob of unknown size counts as this many bytes when batches are planned and timed (a day blob is 0.08–0.33 MB). */
export const BLOB_BYTES_ESTIMATE = 300_000;
/** The Worker refuses a PUT body over this size (413). A day's gzipped NDJSON is about 0.3 MB. */
export const PUT_MAX_BYTES = 25 * 1024 * 1024;
/** Per request (a batchGet attempt: batchTimeoutMs of its bytes, at most this). */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Attempts per request (network errors, 5xx, a 429 that is not the budget). */
export const MAX_ATTEMPTS = 4;
/** A Retry-After longer than this is not waited for: the request fails (retryable) and the step decides. */
export const RETRY_AFTER_MAX_MS = 60_000;
/**
 * The wait before retrying a 503 {"error":"unavailable"} (the Worker had no GitHub signing key: state/src/auth.js).
 * Older Workers answered it with Retry-After: 30, which phase 3a's retry budget (5 s) never waited for, so a cold
 * isolate failed the whole shadow step (runs 43907386794, 43964170954 on 2026-11-16); a keyless isolate fetches again
 * after 2 s, so a short wait is enough, and the step's deadline still bounds it.
 */
export const KEYS_UNAVAILABLE_WAIT_MS = 3_000;
/** At most this much sleeping between the attempts of one request (backoff and Retry-After together): a request's
 *  retries stay inside its step's time budget (the writer jobs' steps run a few minutes). */
export const RETRY_BUDGET_MS = 90_000;

/**
 * How hard a run tries (the defaults above, or a tighter policy): per-request timeout, attempts, the sleep budget of one
 * request, and `deadlineMs`, an epoch-ms instant after which no attempt starts and no wait reaches past (a running
 * attempt's timeout is cut to it). The deadline spans every request of the backend and the OIDC token requests, so it
 * bounds a whole step however many requests it makes (phase 3a's shadow steps, src/event-map-store.ts).
 */
export interface RetryPolicy {
  timeoutMs?: number;
  attempts?: number;
  /** Attempts of one batchGet batch (default BATCH_ATTEMPTS); its timeout is batchTimeoutMs of its bytes. */
  batchAttempts?: number;
  retryBudgetMs?: number;
  deadlineMs?: number | null;
}
/** The Worker's limits on a GC call (state/src/cas.js). */
export const GC_MAX_KEEP = 10_000;
export const GC_MIN_AGE_DAYS_FLOOR = 14;
export const GC_MAX_DELETES_CAP = 1_000;
/** A cached OIDC token is reused only while it has more than this left (GitHub's tokens live about 5 minutes). */
export const TOKEN_MIN_LEFT_MS = 60_000;

const HEX64 = /^[0-9a-f]{64}$/;
export const isSha256Hex = (s: unknown): s is string => typeof s === 'string' && HEX64.test(s);
export const sha256Hex = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
/** The bucket key of a blob. */
export const casKey = (hex: string): string => `cas/sha256/${hex.slice(0, 2)}/${hex}`;

export interface PutResult {
  key: string;
  size: number;
  uploaded: string;
}

export interface GcRequest {
  /** Every blob that must survive (hex). */
  keep: string[];
  /** The current generation's blobs (at most 40 a call): the Worker refuses unless they are in `keep` and exist. */
  current: string[];
  cursor: string | null;
  minAgeDays: number;
  maxDeletes: number;
  dryRun: boolean;
}

export interface GcPage {
  listed: number;
  /** Deleted by this call (0 in a dry run). */
  deleted: number;
  bytesDeleted: number;
  /** What the rules select: deleted or, in a dry run, what would have been. */
  wouldDelete: number;
  bytesWouldDelete: number;
  /** In `keep`. */
  kept: number;
  /** Not in `keep` but uploaded less than minAgeDays ago. */
  young: number;
  /** Old enough and not in `keep`, but over maxDeletes (left for the next pass). */
  capped: number;
  /** Not a CAS blob key (never deleted). */
  foreign: number;
  cursor: string | null;
  dryRun: boolean;
}

/** GET /v1/budget (state/src/budget.js snapshot). The protocol-2 fields (4.0) are absent from an older Worker. */
export interface StateBudget {
  day: string;
  used: { class_a: number; class_b: number; bytes_written: number; requests: number; refused: number; refused_critical?: number; ref_conflicts?: number; reflog_collisions?: number };
  stored_bytes: number;
  /** Ref and reflog bytes inside stored_bytes. */
  meta_bytes?: number;
  /** The priority lanes' shares of every ceiling ({critical: 0.95, background: 0.6}). */
  lanes?: { critical: number; background: number };
  stored_seeded_at: string | null;
  gc_pass_open: boolean;
  ceilings: { class_a: number; class_b: number; bytes_written: number; stored_bytes: number };
}

/** What a batchGet may know beyond its shas (getBlobs passes both; a backend that has no use for them ignores them). */
export interface BatchGetOptions {
  /** Each blob's stored size (the generation's blob_bytes): scales the attempt's timeout (batchTimeoutMs). */
  sizes?: ReadonlyMap<string, number>;
  /** Aborted when a sibling batch failed for good: no further attempt starts, a running one is cut. */
  signal?: AbortSignal;
}

export interface StateBackend {
  readonly label: string;
  /** Store `bytes` under the sha256 `hex` of those bytes. */
  put(hex: string, bytes: Uint8Array): Promise<PutResult>;
  /** The blobs `shas` (1–40), each verified against its sha256. Throws when any is missing. */
  batchGet(shas: readonly string[], opts?: BatchGetOptions): Promise<Map<string, Buffer>>;
  /** One GC page. */
  gc(req: GcRequest): Promise<GcPage>;
  /** Today's counters and ceilings, as the store reports them (null: the backend keeps none). */
  budget(): Promise<StateBudget | null>;
}

export type StateErrorKind = 'config' | 'auth' | 'forbidden' | 'protocol' | 'budget' | 'quota' | 'refused' | 'conflict' | 'integrity' | 'missing' | 'transport' | 'client';

/** A store failure. `retryable` only for transport-class failures (the client has already retried those). */
export class StateStoreError extends Error {
  constructor(
    message: string,
    readonly kind: StateErrorKind,
    readonly status: number | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'StateStoreError';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The batchGet framing

/** What a batchGet answer held up to where it ended. */
export interface BatchScan {
  /** The blobs delivered whole, each verified against its sha256. */
  blobs: Map<string, Buffer>;
  /** The shas answered MISSING. */
  missing: string[];
  /** The END trailer was read (and checked): the answer is complete. */
  ended: boolean;
  /** Without the trailer: where the answer was cut (for the error message). */
  cut: string | null;
}

/**
 * Read a batchGet answer as far as it goes. Every frame up to the cut is checked: a requested sha at most once, as `BLOB
 * <hex> <length>` with that many bytes whose sha256 is <hex> and a `\n` after them, or as `MISSING <hex>`; nothing
 * unrequested; the `END <count>` trailer last and nothing after it, <count> the number of records. Anything malformed
 * throws kind `integrity` (never retried: the store answered something else than it holds). A stream that ends before
 * its trailer is not an error here: `ended` is false and `blobs` holds what it delivered whole, so a retry can ask for
 * the rest only.
 */
export function scanBatchFrames(body: Buffer, requested: readonly string[]): BatchScan {
  const want = new Set(requested);
  const blobs = new Map<string, Buffer>();
  const missing: string[] = [];
  let records = 0;
  let pos = 0;
  const bad = (why: string): never => {
    throw new StateStoreError(`batchGet: ${why}`, 'integrity');
  };
  for (;;) {
    const nl = body.indexOf(0x0a, pos);
    if (nl < 0) return { blobs, missing, ended: false, cut: `the stream ended after ${records} record(s) without its END trailer` };
    const line = body.toString('latin1', pos, nl);
    const parts = line.split(' ');
    if (parts[0] === 'END' && parts.length === 2) {
      if (!/^\d+$/.test(parts[1]!) || Number(parts[1]) !== records) bad(`trailer ${JSON.stringify(line)} after ${records} record(s)`);
      if (nl + 1 !== body.length) bad(`${body.length - nl - 1} byte(s) after the trailer`);
      return { blobs, missing, ended: true, cut: null };
    }
    if (parts[0] === 'MISSING' && parts.length === 2) {
      const hex = parts[1]!;
      if (!want.has(hex) || blobs.has(hex) || missing.includes(hex)) bad(`unexpected MISSING ${hex.slice(0, 80)}`);
      missing.push(hex);
      records++;
      pos = nl + 1;
      continue;
    }
    if (parts[0] === 'BLOB' && parts.length === 3) {
      const hex = parts[1]!;
      if (!want.has(hex) || blobs.has(hex) || missing.includes(hex)) bad(`unexpected BLOB ${hex.slice(0, 80)}`);
      if (!/^\d+$/.test(parts[2]!)) bad(`BLOB ${hex}: length ${JSON.stringify(parts[2]!.slice(0, 20))}`);
      const len = Number(parts[2]);
      const at = nl + 1;
      if (at + len + 1 > body.length) return { blobs, missing, ended: false, cut: `BLOB ${hex} declares ${len} bytes, the stream ends ${body.length - at} byte(s) later` };
      const bytes = body.subarray(at, at + len);
      if (body[at + len] !== 0x0a) bad(`BLOB ${hex}: no newline after its ${len} bytes`);
      const got = sha256Hex(bytes);
      if (got !== hex) bad(`BLOB ${hex}: its bytes hash to ${got}`);
      blobs.set(hex, Buffer.from(bytes));
      pos = at + len + 1;
      records++;
      continue;
    }
    // A header line cut before its newline is caught above (no newline); a whole line that is no frame is malformed.
    bad(`unreadable frame ${JSON.stringify(line.slice(0, 80))}`);
  }
}

const missingError = (missing: readonly string[]): StateStoreError =>
  new StateStoreError(`batchGet: ${missing.length} blob(s) missing from the store: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`, 'missing');

/**
 * The blobs of a whole batchGet answer, each checked (scanBatchFrames): a `MISSING` record throws (kind `missing`); a
 * stream cut short (no trailer) throws kind `transport` (the request is worth repeating); a requested blob the trailer
 * left out, or anything malformed, throws kind `integrity`.
 */
export function parseBatchFrames(body: Buffer, requested: readonly string[]): Map<string, Buffer> {
  const scan = scanBatchFrames(body, requested);
  if (!scan.ended) throw new StateStoreError(`batchGet: ${scan.cut}`, 'transport', null, true);
  if (scan.missing.length) throw missingError(scan.missing);
  const absent = requested.filter((h) => !scan.blobs.has(h));
  if (absent.length) throw new StateStoreError(`batchGet: ${absent.length} requested blob(s) not in the answer: ${absent.slice(0, 5).join(', ')}`, 'integrity');
  return scan.blobs;
}

/** The framed answer for `blobs` (in order; null = MISSING), as the Worker writes it. For tests and the FsBackend's own checks. */
export function frameBatch(blobs: readonly [string, Uint8Array | null][]): Buffer {
  const parts: Buffer[] = [];
  for (const [hex, b] of blobs) {
    if (b == null) parts.push(Buffer.from(`MISSING ${hex}\n`, 'latin1'));
    else parts.push(Buffer.from(`BLOB ${hex} ${b.length}\n`, 'latin1'), Buffer.from(b), Buffer.from('\n', 'latin1'));
  }
  parts.push(Buffer.from(`END ${blobs.length}\n`, 'latin1'));
  return Buffer.concat(parts);
}

function checkShas(shas: readonly string[]): void {
  if (shas.length < 1 || shas.length > BATCH_MAX) throw new StateStoreError(`batchGet: ${shas.length} shas, 1 to ${BATCH_MAX} a call`, 'client');
  if (new Set(shas).size !== shas.length) throw new StateStoreError('batchGet: duplicate shas', 'client');
  for (const s of shas) if (!isSha256Hex(s)) throw new StateStoreError(`batchGet: not a sha256: ${String(s).slice(0, 80)}`, 'client');
}

/** The stored size of `hex` as far as `sizes` knows it (BLOB_BYTES_ESTIMATE otherwise). */
const sizeOf = (hex: string, sizes?: ReadonlyMap<string, number>): number => sizes?.get(hex) ?? BLOB_BYTES_ESTIMATE;

/** A batch attempt's timeout for `bytes` of blobs: BATCH_TIMEOUT_BASE_MS + BATCH_MS_PER_MB a MB, at most `capMs`. */
export function batchTimeoutMs(bytes: number, capMs: number): number {
  return Math.max(1, Math.min(capMs, BATCH_TIMEOUT_BASE_MS + Math.ceil((bytes / 1e6) * BATCH_MS_PER_MB)));
}

/**
 * The batches of `shas` (sorted, unique): consecutive runs of at most BATCH_MAX blobs and at most `maxBytes` of them
 * (a blob larger than that alone). Deterministic, so a run's requests can be read back from its log.
 */
export function planBatches(shas: Iterable<string>, sizes?: ReadonlyMap<string, number>, maxBytes: number = BATCH_MAX_BYTES): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const h of [...new Set(shas)].sort()) {
    const n = sizeOf(h, sizes);
    if (cur.length && (cur.length >= BATCH_MAX || bytes + n > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(h);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** What getBlobs did (filled in when the caller passes it). */
export interface GetBlobsStats {
  batches: number;
  blobs: number;
  bytes: number;
}

/**
 * Every blob of `shas` (any number, duplicates allowed): planned into batches by bytes (planBatches, from `sizes`: the
 * generation's blob_bytes), at most `concurrency` (BATCH_CONCURRENCY) in flight. Each batch is one backend.batchGet
 * with its own attempts (the Worker backend retries a batch on its own and asks again only for the blobs not yet
 * received and verified). The first batch that fails for good (its attempts or the step deadline used up, or a failure
 * that is never retried: a MISSING, an integrity failure, the budget, a 1027) fails the whole fetch, fail closed: the
 * batches in flight are cancelled, none starts after it, and its error is the one thrown.
 */
export async function getBlobs(
  backend: StateBackend,
  shas: Iterable<string>,
  opts: { sizes?: ReadonlyMap<string, number>; maxBatchBytes?: number; concurrency?: number; stats?: GetBlobsStats } = {},
): Promise<Map<string, Buffer>> {
  const batches = planBatches(shas, opts.sizes, opts.maxBatchBytes ?? BATCH_MAX_BYTES);
  const out = new Map<string, Buffer>();
  const cancel = new AbortController();
  let failed: { error: unknown } | null = null;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!failed && next < batches.length) {
      const batch = batches[next++]!;
      try {
        const got = await backend.batchGet(batch, { sizes: opts.sizes, signal: cancel.signal });
        for (const [k, v] of got) out.set(k, v);
      } catch (e) {
        // The first failure wins; the cancelled siblings' errors that follow it say nothing new.
        if (!failed) {
          failed = { error: e };
          cancel.abort();
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? BATCH_CONCURRENCY, batches.length) }, worker));
  if (failed) throw (failed as { error: unknown }).error;
  if (opts.stats) {
    opts.stats.batches += batches.length;
    opts.stats.blobs += out.size;
    for (const v of out.values()) opts.stats.bytes += v.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The GC and budget answers

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A GC page as the Worker answers it, checked: every count present, `listed` the sum of the five classes, a dry run
 *  deleting nothing, a real run deleting what it selected, and the mode the request asked for. Throws kind integrity. */
export function parseGcPage(j: unknown, dryRun: boolean): GcPage {
  const bad = (why: string): never => {
    throw new StateStoreError(`gc: ${why}: ${JSON.stringify(j).slice(0, 300)}`, 'integrity');
  };
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('not a JSON object');
  const o = j as Record<string, unknown>;
  const keys = ['listed', 'deleted', 'bytesDeleted', 'wouldDelete', 'bytesWouldDelete', 'kept', 'young', 'capped', 'foreign'] as const;
  for (const k of keys) if (!isCount(o[k])) bad(`no count ${k}`);
  if (!(o.cursor === null || (typeof o.cursor === 'string' && o.cursor.length > 0))) bad('cursor neither null nor a string');
  if (o.dryRun !== dryRun) bad(`dryRun ${String(o.dryRun)}, asked ${dryRun}`);
  const p = Object.fromEntries(keys.map((k) => [k, o[k] as number])) as Record<(typeof keys)[number], number>;
  if (p.listed !== p.kept + p.young + p.capped + p.foreign + p.wouldDelete) bad('listed is not kept + young + capped + foreign + wouldDelete');
  if (dryRun ? p.deleted !== 0 || p.bytesDeleted !== 0 : p.deleted !== p.wouldDelete || p.bytesDeleted !== p.bytesWouldDelete) bad(dryRun ? 'a dry run deleted' : 'deleted is not what it selected');
  return { ...p, cursor: o.cursor as string | null, dryRun };
}

/** GET /v1/budget's answer, checked (kind integrity when it is not the Worker's snapshot). */
export function parseBudget(j: unknown): StateBudget {
  const bad = (why: string): never => {
    throw new StateStoreError(`budget: ${why}: ${JSON.stringify(j).slice(0, 300)}`, 'integrity');
  };
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!obj(j)) return bad('not a JSON object');
  if (typeof j.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(j.day)) bad('no day');
  if (!obj(j.used) || !obj(j.ceilings)) return bad('no used or ceilings');
  const used = j.used;
  const ceilings = j.ceilings;
  for (const k of ['class_a', 'class_b', 'bytes_written', 'requests', 'refused']) if (!isCount(used[k])) bad(`no used.${k}`);
  for (const k of ['class_a', 'class_b', 'bytes_written', 'stored_bytes']) if (!isCount(ceilings[k]) || ceilings[k] === 0) bad(`no ceilings.${k}`);
  if (!isCount(j.stored_bytes)) bad('no stored_bytes');
  if (!(j.stored_seeded_at === null || typeof j.stored_seeded_at === 'string')) bad('stored_seeded_at');
  if (typeof j.gc_pass_open !== 'boolean') bad('gc_pass_open');
  for (const k of ['refused_critical', 'ref_conflicts', 'reflog_collisions']) if (used[k] !== undefined && !isCount(used[k])) bad(`used.${k}`);
  if (j.meta_bytes !== undefined && !isCount(j.meta_bytes)) bad('meta_bytes');
  const lanes = obj(j.lanes) && typeof j.lanes.critical === 'number' && typeof j.lanes.background === 'number' ? { critical: j.lanes.critical, background: j.lanes.background } : undefined;
  const n = (o: Record<string, unknown>, k: string): number => o[k] as number;
  const opt = (o: Record<string, unknown>, k: string): Record<string, number> => (o[k] === undefined ? {} : { [k]: o[k] as number });
  return {
    day: j.day as string,
    used: { class_a: n(used, 'class_a'), class_b: n(used, 'class_b'), bytes_written: n(used, 'bytes_written'), requests: n(used, 'requests'), refused: n(used, 'refused'), ...opt(used, 'refused_critical'), ...opt(used, 'ref_conflicts'), ...opt(used, 'reflog_collisions') },
    stored_bytes: j.stored_bytes as number,
    ...opt(j, 'meta_bytes'),
    ...(lanes ? { lanes } : {}),
    stored_seeded_at: j.stored_seeded_at as string | null,
    gc_pass_open: j.gc_pass_open as boolean,
    ceilings: { class_a: n(ceilings, 'class_a'), class_b: n(ceilings, 'class_b'), bytes_written: n(ceilings, 'bytes_written'), stored_bytes: n(ceilings, 'stored_bytes') },
  };
}

/** One line of a budget: each ceiling's use (stored_bytes against the stored estimate). */
export function budgetLine(b: StateBudget): string {
  const used: Record<keyof StateBudget['ceilings'], number> = { class_a: b.used.class_a, class_b: b.used.class_b, bytes_written: b.used.bytes_written, stored_bytes: b.stored_bytes };
  const parts = (Object.keys(b.ceilings) as (keyof StateBudget['ceilings'])[]).map((k) => `${k} ${used[k]} of ${b.ceilings[k]} (${Math.round((100 * used[k]) / b.ceilings[k])} %)`);
  return `${b.day}: ${parts.join(', ')}; ${b.used.requests} request(s), ${b.used.refused} refused${b.gc_pass_open ? '; a GC pass is open' : ''}`;
}

/** The checks the Worker makes on a GC request before it touches the bucket (400 with kind client, 409 refused are
 *  left to the caller). Throws kind client with status 400. */
function checkGcRequest(req: GcRequest): void {
  const bad = (why: string): never => {
    throw new StateStoreError(`gc: ${why}`, 'client', 400);
  };
  const list = (v: readonly string[], field: string, min: number, max: number): void => {
    if (!Array.isArray(v) || v.length < min || v.length > max) bad(`${field} must hold ${min}..${max} shas, not ${Array.isArray(v) ? v.length : typeof v}`);
    for (const x of v) if (!isSha256Hex(x)) bad(`${field} holds a value that is not a lowercase sha256`);
    if (new Set(v).size !== v.length) bad(`${field} holds duplicates`);
  };
  if (req.cursor !== null && (typeof req.cursor !== 'string' || req.cursor.length === 0 || req.cursor.length > 4096)) bad('cursor must be null or a cursor the store returned');
  list(req.keep, 'keep', 1, GC_MAX_KEEP);
  if (req.cursor === null) list(req.current, 'current', 1, BATCH_MAX);
  else list(req.current ?? [], 'current', 0, 0);
  if (!Number.isInteger(req.minAgeDays) || req.minAgeDays < GC_MIN_AGE_DAYS_FLOOR || req.minAgeDays > 36_500) bad(`minAgeDays must be an integer ≥ ${GC_MIN_AGE_DAYS_FLOOR}`);
  if (!Number.isInteger(req.maxDeletes) || req.maxDeletes < 0 || req.maxDeletes > GC_MAX_DELETES_CAP) bad(`maxDeletes must be an integer 0..${GC_MAX_DELETES_CAP}`);
  if (typeof req.dryRun !== 'boolean') bad('dryRun must be true or false');
}

/**
 * The wait a Retry-After header asks for, in ms (delta-seconds or an HTTP date), or null when there is none or it
 * cannot be read.
 */
export function retryAfterMs(raw: string | null, nowMs: number = Date.now()): number | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) && /[a-z]/i.test(v) ? Math.max(0, at - nowMs) : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Protocol 2: lane refs and the reflog (state/src/refs.js is the Worker's side of the same rules)

export const REF_PROTOCOL = 2;
export const REF_FORMAT = 1;
export const REF_MAX_BYTES = 4096;
/** The production lanes (staging adds `rehearsal-<run>` lanes for state-rehearsal.yml). */
export const STATE_LANES = ['main', 'main-shadow', 'first-solutions', 'history'] as const;
const REHEARSAL_LANE = /^rehearsal-[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_SEQ = 999_999_999_999;
const WRITER = /^([A-Za-z0-9._-]+\.ya?ml)\/([0-9]{1,20})-([0-9]{1,6})\/([A-Za-z0-9._-]{1,64})\/([0-9a-f]{16,64})$/;

/** A lane's ref (format 1): the generation it names and its place in the lane's chain. */
export interface StateRef {
  format: 1;
  lane: string;
  /** The sha256 of the generation blob (a CAS key). */
  generation: string;
  seq: number;
  /** The generation this one replaced (null: the lane's first ref, seq 1). */
  parent: string | null;
  head_seq: number;
  data_commit: string;
  written: string;
  /** `<workflow>/<run_id>-<attempt>/<step>/<nonce>`: the Worker checks the run against the token; the nonce makes an
   *  ambiguous answer decidable (swapRef). */
  writer: string;
  /** A restore only: the reflog entry it restores. */
  restore_of?: { seq: number; generation: string };
}

/** A ref as read: the parsed ref, its exact bytes and its HTTP ETag (quoted, as If-Match wants it back). */
export interface RefRead {
  ref: StateRef;
  text: string;
  etag: string;
}

/** What a ref PUT replaces: the version read ({etag}), or no ref at all ({create: true}, the lane's bootstrap). */
export type RefPrecondition = { etag: string } | { create: true };

export interface RefSwap {
  lane: string;
  seq: number;
  generation: string;
  etag: string;
  /** previous: whether the replaced ref's reflog entry was there ('present'), had to be written ('repaired'), or there
   *  was none ('none'); entry: the new seq's entry 'created', or 'exists' (its slot was taken: putRef then throws
   *  ReflogCollision, so a RefSwap a caller holds never says 'exists'). With CREATE_ONLY_FORM "off" the Worker's puts
   *  are plain: 'rewritten' (the current entry put again, its same bytes) and 'written' (not known to have been free). */
  reflog: { previous: 'none' | 'present' | 'repaired' | 'rewritten'; entry: 'created' | 'exists' | 'written' };
  /** The bucket and ref-store operations the Worker made (x-feed-state-store-ops; null when the backend has none). */
  storeOps: number | null;
  ledgerCalls: number | null;
}

export interface ReflogEntry {
  seq: number;
  generation: string | null;
  parent: string | null;
  head_seq: number | null;
  data_commit: string | null;
  written: string | null;
  writer: string | null;
  restore_of: { seq: number; generation: string } | null;
  uploaded: string;
  size: number;
}
export interface ReflogPage {
  lane: string;
  entries: ReflogEntry[];
  /** Ask again with after = next; null at the end. */
  next: number | null;
}

/** The ref routes (protocol 2). Both backends implement them; neither is used by the production pipeline in 4.0. */
export interface StateRefs {
  getRef(lane: string): Promise<RefRead | null>;
  /** One attempt, never retried blindly (a CAS): 412 throws RefConflict, an unknown outcome a retryable error, a swap
   *  onto a taken reflog slot ReflogCollision (kind integrity). */
  putRef(lane: string, ref: StateRef, pre: RefPrecondition): Promise<RefSwap>;
  reflog(lane: string, opts?: { after?: number; limit?: number }): Promise<ReflogPage>;
}

/** A 412: the ref is no longer the version named. `current` is the ref the store holds now (null: none). */
export class RefConflict extends StateStoreError {
  constructor(
    message: string,
    readonly current: RefRead | null,
    /** Which check refused: 'read' (the Worker's GET saw another version) or 'swap' (the conditional put itself). */
    readonly at: 'read' | 'swap' | null = null,
  ) {
    super(message, 'conflict', 412);
    this.name = 'RefConflict';
  }
}

/**
 * A swap that happened onto a reflog slot already taken (the Worker's 200 with `reflog.entry: "exists"`): the ref moved,
 * but the reflog's entry for its seq names another write (a second winner of the seq, so the CAS was not atomic, or an
 * entry left by a lost ref). The GC root set and the restore index would miss the live generation, so the run fails
 * loudly (kind integrity, never retried) instead of writing on; the Worker counted it (reflog_collisions, health P1).
 * `swap` is the answer, for the rehearsal's race check.
 */
export class ReflogCollision extends StateStoreError {
  constructor(
    message: string,
    readonly swap: RefSwap,
  ) {
    super(message, 'integrity', 200);
    this.name = 'ReflogCollision';
  }
}

/** Fail closed on a taken reflog slot (both backends' putRef). */
function checkReflogSlot(swap: RefSwap): RefSwap {
  if (swap.reflog.entry === 'exists') {
    throw new ReflogCollision(`ref ${swap.lane}: swapped to seq ${swap.seq}, but its reflog slot was already taken (another write of that seq): integrity failure, see state/README.md`, swap);
  }
  return swap;
}

/** JSON with every object's keys sorted, no whitespace: the one serialization of a ref (the Worker refuses others). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function isLane(lane: string, opts: { rehearsal?: boolean } = {}): boolean {
  return (STATE_LANES as readonly string[]).includes(lane) || (!!opts.rehearsal && REHEARSAL_LANE.test(lane));
}

/**
 * A ref's text checked: exactly the ref fields, for `lane`, canonical. Throws kind integrity (a store that answers
 * something else is not trusted with the chain).
 */
export function parseRef(text: string, lane: string): StateRef {
  const bad = (why: string): never => {
    throw new StateStoreError(`ref ${lane}: ${why}`, 'integrity');
  };
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return bad('not JSON');
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('not a JSON object');
  const r = j as Record<string, unknown>;
  const fields = new Set(['data_commit', 'format', 'generation', 'head_seq', 'lane', 'parent', 'restore_of', 'seq', 'written', 'writer']);
  for (const k of Object.keys(r)) if (!fields.has(k)) bad(`unknown field ${k.slice(0, 40)}`);
  const seq = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_SEQ;
  if (r.format !== REF_FORMAT) bad(`format ${String(r.format)}`);
  if (r.lane !== lane) bad(`lane ${String(r.lane)}`);
  if (!isSha256Hex(r.generation)) bad('generation');
  if (!seq(r.seq)) bad('seq');
  if (!(r.parent === null || isSha256Hex(r.parent))) bad('parent');
  if (!Number.isSafeInteger(r.head_seq) || (r.head_seq as number) < 0) bad('head_seq');
  if (typeof r.data_commit !== 'string' || !/^[0-9a-f]{40}$/.test(r.data_commit)) bad('data_commit');
  if (typeof r.written !== 'string' || !Number.isFinite(Date.parse(r.written))) bad('written');
  if (typeof r.writer !== 'string' || !WRITER.test(r.writer)) bad('writer');
  if (r.restore_of !== undefined) {
    const o = r.restore_of as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || !seq(o.seq) || !isSha256Hex(o.generation) || Object.keys(o).length !== 2) bad('restore_of');
  }
  if (canonicalJson(r) !== text) bad('not canonical');
  return r as unknown as StateRef;
}

/** A writer id: `<workflow>/<run_id>-<attempt>/<step>/<nonce>` (the nonce: 32 random hex unless given). */
export function writerId(p: { workflow: string; runId: string; runAttempt: string; step: string; nonce?: string }): string {
  const id = `${p.workflow}/${p.runId}-${p.runAttempt}/${p.step}/${p.nonce ?? randomBytes(16).toString('hex')}`;
  if (!WRITER.test(id)) throw new StateStoreError(`writer id ${id.slice(0, 120)}: not <workflow>/<run_id>-<attempt>/<step>/<hex nonce>`, 'client');
  return id;
}

/** The writer id of this Actions run's `step` (GITHUB_WORKFLOW_REF, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT): what the Worker
 *  checks against the token's workflow_ref, run_id and run_attempt. */
export function writerFromEnv(step: string, env: NodeJS.ProcessEnv = process.env, nonce?: string): string {
  const m = /\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@/.exec(env.GITHUB_WORKFLOW_REF ?? '');
  if (!m || !env.GITHUB_RUN_ID || !env.GITHUB_RUN_ATTEMPT) {
    throw new StateStoreError('no writer id: GITHUB_WORKFLOW_REF, GITHUB_RUN_ID or GITHUB_RUN_ATTEMPT is unset (an Actions run only)', 'config');
  }
  return writerId({ workflow: m[1]!, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, step, nonce });
}

/**
 * The successor of `cur`: seq + 1, parent = cur's generation, head_seq never below cur's. `cur` null is a create: seq
 * `firstSeq` (1) with `parent` (null) on a lane without a reflog; a create on a lane whose ref is gone but whose reflog
 * is not (a REF_BACKEND switch, state/README.md) passes the last entry's seq + 1 and generation instead. A restore names
 * restore_of and must jump head_seq forward (the Worker checks both).
 */
export function nextRef(
  cur: StateRef | null,
  f: { lane: string; generation: string; head_seq: number; data_commit: string; writer: string; written?: string; restore_of?: StateRef['restore_of']; firstSeq?: number; parent?: string | null },
): StateRef {
  const ref: StateRef = {
    format: REF_FORMAT,
    lane: f.lane,
    generation: f.generation,
    seq: cur ? cur.seq + 1 : (f.firstSeq ?? 1),
    parent: cur ? cur.generation : (f.parent ?? null),
    head_seq: f.head_seq,
    data_commit: f.data_commit,
    written: f.written ?? new Date().toISOString(),
    writer: f.writer,
  };
  if (f.restore_of) ref.restore_of = f.restore_of;
  return ref;
}

/** The successor rules (state/src/refs.js checkSuccessor), for the directory backend: `cur` null is a lane with
 *  neither a ref nor a reflog (seq 1, parent null). Throws kind refused (409). */
function checkSuccessor(cur: Pick<StateRef, 'seq' | 'generation' | 'head_seq'> | null, next: StateRef): void {
  const no = (why: string): never => {
    throw new StateStoreError(`ref ${next.lane}: ${why}`, 'refused', 409);
  };
  if (!cur) {
    if (next.seq !== 1 || next.parent !== null) no('the lane has no ref and no reflog: its first ref is seq 1 with parent null');
    return;
  }
  if (next.seq !== cur.seq + 1) no(`seq must be ${cur.seq + 1}`);
  if (next.parent !== cur.generation) no('parent must be the current generation');
  if (next.restore_of ? next.head_seq <= cur.head_seq : next.head_seq < cur.head_seq) no(next.restore_of ? 'a restore must jump head_seq forward' : 'head_seq must not go backwards');
}

export type SwapOutcome =
  /** The PUT answered 200. */
  | 'swapped'
  /** A 412 whose current ref is ours: an earlier attempt of this same write landed (its answer was lost). */
  | 'landed-before'
  /** The PUT's outcome was unknown; the re-GET found our writer nonce. */
  | 'reconciled'
  /** The PUT's outcome was unknown; the ref was still the version named, so the same write was sent again. */
  | 'retried';

/**
 * One compare-and-swap of a lane's ref with the ambiguous-answer rule (APIs.md phase 4 crash matrix): a PUT whose
 * outcome is unknown (timeout, cut connection, a 5xx) is never repeated blindly. The ref is read again: our writer nonce
 * there means the write landed; the ETag still the one named (or still no ref, for a create) means it did not, and the
 * same body goes again (at most `attempts` PUTs); anything else is someone else's write, a RefConflict (fail closed).
 * A 412 whose current ref carries our nonce is a landed earlier attempt, not a conflict.
 */
export async function swapRef(
  refs: StateRefs,
  lane: string,
  ref: StateRef,
  pre: RefPrecondition,
  opts: { attempts?: number; log?: (line: string) => void } = {},
): Promise<{ outcome: SwapOutcome; etag: string; swap: RefSwap | null; attempts: number }> {
  const attempts = opts.attempts ?? 3;
  const log = opts.log ?? (() => {});
  let lastError: StateStoreError | null = null;
  let retried = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const swap = await refs.putRef(lane, ref, pre);
      return { outcome: retried ? 'retried' : 'swapped', etag: swap.etag, swap, attempts: attempt };
    } catch (e) {
      if (e instanceof RefConflict) {
        if (e.current?.ref.writer === ref.writer) return { outcome: 'landed-before', etag: e.current.etag, swap: null, attempts: attempt };
        throw e;
      }
      if (!(e instanceof StateStoreError) || !e.retryable) throw e;
      lastError = e;
      log(`state ref ${lane}: the PUT of seq ${ref.seq} has no certain outcome (${e.message}); reading the ref back`);
    }
    const cur = await refs.getRef(lane);
    if (cur?.ref.writer === ref.writer) return { outcome: 'reconciled', etag: cur.etag, swap: null, attempts: attempt };
    const unchanged = 'create' in pre ? cur == null : cur?.etag === pre.etag;
    if (!unchanged) throw new RefConflict(`ref ${lane}: after an unknown outcome the ref is ${cur ? `seq ${cur.ref.seq} by ${cur.ref.writer}` : 'gone'}, not ours: fail closed`, cur);
    retried = true;
  }
  throw new StateStoreError(`ref ${lane}: seq ${ref.seq} not swapped after ${attempts} attempt(s): ${lastError?.message ?? 'no answer'}`, lastError?.kind ?? 'transport', lastError?.status ?? null, true);
}

/** Every reflog entry of a lane after `after` (paged). */
export async function reflogAll(refs: StateRefs, lane: string, after = 0): Promise<ReflogEntry[]> {
  const out: ReflogEntry[] = [];
  let next: number | null = after;
  while (next != null) {
    const page: ReflogPage = await refs.reflog(lane, { after: next });
    out.push(...page.entries);
    if (page.next != null && page.next <= next) throw new StateStoreError(`reflog ${lane}: next ${page.next} does not advance past ${next}`, 'integrity');
    next = page.next;
  }
  return out;
}

function parseReflogPage(j: unknown, lane: string): ReflogPage {
  const bad = (why: string): never => {
    throw new StateStoreError(`reflog ${lane}: ${why}: ${JSON.stringify(j).slice(0, 300)}`, 'integrity');
  };
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('not a JSON object');
  const o = j as Record<string, unknown>;
  if (o.lane !== lane || !Array.isArray(o.entries)) return bad('no lane or entries');
  if (!(o.next === null || (Number.isSafeInteger(o.next) && (o.next as number) > 0))) bad('next');
  let prev = 0;
  for (const e of o.entries as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object' || !Number.isSafeInteger(e.seq) || (e.seq as number) <= prev) bad('entries not ascending by seq');
    prev = e.seq as number;
  }
  return o as unknown as ReflogPage;
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub Actions OIDC tokens

export type TokenSource = () => Promise<string>;
type FetchImpl = typeof globalThis.fetch;

/** The `exp` claim of a JWT in ms, or null when it cannot be read (the token is then never reused). */
export function jwtExpiryMs(jwt: string): number | null {
  const payload = jwt.split('.')[1];
  if (!payload) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * GitHub's OIDC token for `audience` (the job needs `permissions: id-token: write`, which sets
 * ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN). A fresh token per call unless the cached one has
 * more than TOKEN_MIN_LEFT_MS left: a token lives about 5 minutes, and a job's steps span longer than that. The token
 * is never logged.
 */
export function githubOidcTokenSource(
  audience: string,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchImpl; now?: () => number; sleep?: (ms: number) => Promise<void>; policy?: RetryPolicy } = {},
): TokenSource {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.policy?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const attempts = opts.policy?.attempts ?? MAX_ATTEMPTS;
  const deadlineMs = opts.policy?.deadlineMs ?? null;
  // The deadline is wall-clock time (Date.now), whatever `now` a test passes for the token's expiry.
  const left = (): number => (deadlineMs == null ? Infinity : deadlineMs - Date.now());
  let cached: { token: string; expMs: number } | null = null;
  // Concurrent callers (getBlobs' batches, persist's PUTs) share one token request instead of each minting their own.
  let pending: Promise<string> | null = null;
  const source: TokenSource = async () => {
    if (cached && cached.expMs - now() > TOKEN_MIN_LEFT_MS) return cached.token;
    pending ??= mint().finally(() => {
      pending = null;
    });
    return pending;
  };
  const mint = async (): Promise<string> => {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) {
      throw new StateStoreError('no GitHub OIDC token: ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN are unset (the job needs `permissions: id-token: write`)', 'config');
    }
    const target = `${url}${url.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`;
    let last = '';
    let tried = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        const wait = backoffMs(attempt, Math.random);
        if (wait >= left()) {
          last += ` (the step's deadline leaves no room for attempt ${attempt})`;
          break;
        }
        await sleep(wait);
      }
      if (left() <= 0) {
        last += ' (the step\'s deadline passed)';
        break;
      }
      tried = attempt;
      const ctrl = new AbortController();
      const limit = Math.max(1, Math.min(timeoutMs, left()));
      const timer = setTimeout(() => ctrl.abort(), limit);
      try {
        const res = await fetchImpl(target, { headers: { authorization: `bearer ${bearer}`, accept: 'application/json', 'user-agent': STATE_USER_AGENT }, signal: ctrl.signal });
        if (!res.ok) {
          last = `HTTP ${res.status}`;
          if (res.status >= 500 || res.status === 429) continue;
          throw new StateStoreError(`the OIDC token request answered ${last}`, 'auth', res.status);
        }
        const value = ((await res.json()) as { value?: unknown }).value;
        if (typeof value !== 'string' || value.split('.').length !== 3) throw new StateStoreError('the OIDC token request answered no token', 'auth');
        const expMs = jwtExpiryMs(value);
        cached = expMs != null ? { token: value, expMs } : null;
        return value;
      } catch (e) {
        if (e instanceof StateStoreError) throw e;
        last = ctrl.signal.aborted ? `timed out after ${limit} ms` : `network error: ${(e as Error).message}`;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new StateStoreError(`the OIDC token request failed: ${last || 'no attempt'} after ${tried} attempt${tried === 1 ? '' : 's'}`, 'transport', null, true);
  };
  return source;
}

/** WorkerBackend's default wait between attempts: `ms`, or until `signal` aborts, whichever comes first. */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Jittered exponential backoff before attempt `attempt` (2, 3, …): 0.5–1 s, 1–2 s, 2–4 s. */
export function backoffMs(attempt: number, random: () => number): number {
  const base = 500 * 2 ** (attempt - 2);
  return Math.round(base + random() * base);
}

// ---------------------------------------------------------------------------------------------------------------------
// The Worker backend

export interface WorkerBackendOptions {
  baseUrl?: string;
  token: TokenSource;
  fetchImpl?: FetchImpl;
  /** The wait between attempts; the default ends early when `signal` aborts (an injected one may ignore it: the
   *  backend stops waiting on the abort either way). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
  attempts?: number;
  /** Attempts of one batchGet batch (default BATCH_ATTEMPTS). */
  batchAttempts?: number;
  /** At most this much sleeping between one request's attempts (default RETRY_BUDGET_MS). */
  retryBudgetMs?: number;
  /** No attempt starts after this epoch-ms instant and none runs past it (RetryPolicy); null: none. */
  deadlineMs?: number | null;
  /** One line per request (route, status, attempts, ms; never the token). */
  log?: (line: string) => void;
}

const errorOf = (text: string): string | null => {
  try {
    const e = (JSON.parse(text) as { error?: unknown }).error;
    return typeof e === 'string' ? e : null;
  } catch {
    return null;
  }
};

/** The extra knobs of one request: a different protocol header, extra headers, statuses besides 200 that `read`
 *  handles (404 for a ref GET, 412 for a ref PUT), the attempts (1 for a CAS; a batchGet's own BATCH_ATTEMPTS),
 *  each attempt's timeout when it is not the backend's (a batchGet's, scaled to the bytes it still asks for), a
 *  signal that cancels the request (a sibling batch failed), and what the log line names beside the route. */
interface RequestOpts {
  protocol?: number;
  headers?: Record<string, string>;
  accept?: readonly number[];
  attempts?: number;
  timeoutMs?: () => number;
  signal?: AbortSignal;
  what?: () => string;
}

/** What `read` knows about the attempt it reads: whether the attempt's timeout (or a cancel) aborted it, whether a cancel
 *  did (a sibling batch failed: the cut is reported `cancelled`, not as a timeout), and its limit. */
interface AttemptInfo {
  aborted: () => boolean;
  cancelled: () => boolean;
  limitMs: number;
}

/** A Cloudflare error 1027 page: the account's daily Workers requests are used up until 00:00 UTC. */
export const isQuota1027 = (text: string): boolean => /\berror(?: code)?:?\s*1027\b/i.test(text) && errorOf(text) == null;

export class WorkerBackend implements StateBackend, StateRefs {
  readonly label: string;
  private readonly base: string;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly batchAttempts: number;
  private readonly retryBudgetMs: number;
  private readonly deadlineMs: number | null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: WorkerBackendOptions) {
    const base = (opts.baseUrl ?? DEFAULT_STATE_URL).replace(/\/+$/, '');
    const u = new URL(base);
    // The token goes nowhere but the store: https only (plain http only to a loopback address, for tests).
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname))) {
      throw new StateStoreError(`FEED_STATE_URL ${base}: https only`, 'config');
    }
    this.base = base;
    this.label = `state Worker ${u.host}`;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.sleep = opts.sleep ?? sleepUnlessAborted;
    this.random = opts.random ?? Math.random;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.attempts = opts.attempts ?? MAX_ATTEMPTS;
    this.batchAttempts = opts.batchAttempts ?? BATCH_ATTEMPTS;
    this.retryBudgetMs = opts.retryBudgetMs ?? RETRY_BUDGET_MS;
    this.deadlineMs = opts.deadlineMs ?? null;
    this.log = opts.log ?? (() => {});
  }

  /** ms left before the deadline (Infinity without one). */
  private left(): number {
    return this.deadlineMs == null ? Infinity : this.deadlineMs - Date.now();
  }

  /** The wait between attempts, over as soon as `signal` aborts (whether or not the injected sleep heeds it). */
  private async pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return this.sleep(ms);
    if (signal.aborted) return;
    let wake = (): void => {};
    const aborted = new Promise<void>((r) => {
      wake = r;
      signal.addEventListener('abort', wake, { once: true });
    });
    try {
      await Promise.race([this.sleep(ms, signal), aborted]);
    } finally {
      signal.removeEventListener('abort', wake);
    }
  }

  /**
   * One request with the retry policy: a network error, a timeout, a 5xx or a 429 that is not the budget's are tried
   * again (at most `attempts` in all), after the answer's Retry-After when it names at most RETRY_AFTER_MAX_MS
   * (longer: no more attempts; a 503 `unavailable`, no signing key yet, after at most KEYS_UNAVAILABLE_WAIT_MS),
   * otherwise after a jittered backoff, and never sleeping more than `retryBudgetMs` in
   * all. A 500 `misconfigured` (a deploy error) and any other status are final. `read` turns a 200 into the result and
   * may throw a retryable StateStoreError (a stream cut short). With a deadline, no attempt starts or waits past it and
   * a running attempt's timeout is cut to it. `body` may be a function: it is called for every attempt (a batchGet's
   * retry asks only for what is still missing).
   */
  private async request<T>(
    method: string,
    path: string,
    body: Uint8Array | string | null | (() => Uint8Array | string),
    contentType: string | null,
    read: (res: Response, at: AttemptInfo) => Promise<T>,
    ro: RequestOpts = {},
  ): Promise<T> {
    const route = `${method} ${path.replace(/[0-9a-f]{64}/, '<hex>').replace(/\?.*$/, '')}`;
    const maxAttempts = ro.attempts ?? this.attempts;
    let last: StateStoreError | null = null;
    let slept = 0;
    let asked: number | null = null;
    let attempt = 0;
    let stop = '';
    const cancelled = (): boolean => {
      if (!ro.signal?.aborted) return false;
      stop = ': cancelled (another request of the step failed)';
      return true;
    };
    while (attempt < maxAttempts) {
      // A cancel (getBlobs: a sibling batch failed for good) is checked before the backoff, not only after it, so an
      // attempt it cut short does not sleep up to 4 s first; the backoff itself ends on it (pause).
      if (cancelled()) break;
      if (attempt > 0) {
        const wait = asked ?? backoffMs(attempt + 1, this.random);
        if (slept + wait > this.retryBudgetMs) {
          stop = `: the next wait of ${Math.round(wait / 1000)} s would pass the retry budget of ${Math.round(this.retryBudgetMs / 1000)} s`;
          break;
        }
        if (wait >= this.left()) {
          stop = ": the step's deadline leaves no room for another attempt";
          break;
        }
        await this.pause(wait, ro.signal);
        slept += wait;
        if (cancelled()) break;
      }
      if (this.left() <= 0) {
        stop = ": the step's deadline passed";
        break;
      }
      attempt++;
      asked = null;
      const t0 = Date.now();
      const token = await this.opts.token();
      // The cancel may land while the token is minted: the abort listener below is added after this await, and a
      // listener added to an aborted signal never fires, so without this check the attempt would run to its timeout.
      if (cancelled()) {
        attempt--; // no request went out: the count in the error names requests sent
        break;
      }
      const tag = ro.what ? ` [${ro.what()}]` : '';
      const sent = typeof body === 'function' ? body() : body;
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        'user-agent': STATE_USER_AGENT,
        'x-feed-state-protocol': String(ro.protocol ?? STATE_PROTOCOL),
        ...ro.headers,
      };
      if (contentType) headers['content-type'] = contentType;
      // Content-Length is not set here: fetch derives it from a buffered body (a string or bytes, never a stream), and
      // the Worker refuses a body without one (411; R2's put needs a known length). tests/state-store.test.ts checks it.
      const ctrl = new AbortController();
      const limit = Math.max(1, Math.min(ro.timeoutMs ? ro.timeoutMs() : this.timeoutMs, this.left()));
      const timer = setTimeout(() => ctrl.abort(), limit);
      const cancel = (): void => ctrl.abort();
      ro.signal?.addEventListener('abort', cancel, { once: true });
      let status: number | null = null;
      try {
        const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: sent ?? undefined, signal: ctrl.signal });
        status = res.status;
        const rid = res.headers.get('x-request-id') ?? '-';
        if (res.status === 200 || ro.accept?.includes(res.status)) {
          this.log(`state ${route}${tag}: ${res.status} in ${Date.now() - t0} ms (attempt ${attempt}, request ${rid})`);
          return await read(res, { aborted: () => ctrl.signal.aborted, cancelled: () => ro.signal?.aborted === true, limitMs: limit });
        }
        const text = await res.text().catch(() => '');
        const err = errorOf(text);
        if (isQuota1027(text)) {
          this.log(`state ${route}: HTTP ${res.status} error 1027 in ${Date.now() - t0} ms (attempt ${attempt}, request ${rid})`);
          throw new StateStoreError(`${route}: HTTP ${res.status}: Cloudflare error 1027, the account's daily Workers requests are used up until 00:00 UTC (feed:state-quota)`, 'quota', res.status);
        }
        this.log(`state ${route}: HTTP ${res.status}${err ? ` (${err})` : ''} in ${Date.now() - t0} ms (attempt ${attempt}, request ${rid})`);
        const what = `${route}: HTTP ${res.status}${err ? ` ${err}` : ''}`;
        if (res.status === 429 && err === 'budget') throw new StateStoreError(`${what}: a free-tier ceiling of the store is reached until 00:00 UTC`, 'budget', 429);
        if (res.status === 500 && err?.startsWith('misconfigured')) throw new StateStoreError(`${what}: the store's deployment is broken (state/README.md)`, 'config', 500);
        if (res.status >= 500 || res.status === 429) {
          // A 429 that is not the Worker's budget is the platform's (a zone rate limit): retried, and kind quota if it
          // outlives the retries (feed:state-quota), so health tells it from a Worker that is down.
          last = new StateStoreError(what, res.status === 429 ? 'quota' : 'transport', res.status, true);
          const ra = retryAfterMs(res.headers.get('retry-after'));
          if (res.status === 503 && err === 'unavailable') {
            // No signing key in the Worker's isolate yet: worth another attempt within seconds, not after Retry-After.
            asked = Math.min(ra ?? KEYS_UNAVAILABLE_WAIT_MS, KEYS_UNAVAILABLE_WAIT_MS);
            continue;
          }
          if (ra != null && ra > RETRY_AFTER_MAX_MS) {
            stop = `: the store asks to retry after ${Math.round(ra / 1000)} s, over ${RETRY_AFTER_MAX_MS / 1000} s`;
            break;
          }
          asked = ra;
          continue;
        }
        const kind: StateErrorKind =
          res.status === 401
            ? 'auth'
            : res.status === 403
              ? 'forbidden'
              : res.status === 426
                ? 'protocol'
                : res.status === 409
                  ? 'refused'
                  : res.status === 412
                    ? 'conflict'
                    : res.status === 400 && err?.startsWith('checksum mismatch')
                    ? 'integrity'
                    : 'client';
        throw new StateStoreError(what, kind, res.status);
      } catch (e) {
        if (e instanceof StateStoreError) {
          if (!e.retryable) throw e;
          last = e;
          if (status === 200) this.log(`state ${route}${tag}: ${e.message} (attempt ${attempt})`);
          continue;
        }
        const why = ro.signal?.aborted ? 'cancelled' : ctrl.signal.aborted ? `timed out after ${limit} ms` : `network error: ${(e as Error).message}`;
        last = new StateStoreError(`${route}: ${why}`, 'transport', status, true);
        this.log(`state ${route}${tag}: ${last.message} (attempt ${attempt})`);
      } finally {
        clearTimeout(timer);
        ro.signal?.removeEventListener('abort', cancel);
      }
    }
    throw new StateStoreError(`${last?.message ?? route} after ${attempt} attempt${attempt === 1 ? '' : 's'}${stop}`, last?.kind ?? 'transport', last?.status ?? null, true);
  }

  async put(hex: string, bytes: Uint8Array): Promise<PutResult> {
    if (!isSha256Hex(hex)) throw new StateStoreError(`put: not a sha256: ${String(hex).slice(0, 80)}`, 'client');
    if (bytes.byteLength > PUT_MAX_BYTES) throw new StateStoreError(`put ${hex}: ${bytes.byteLength} bytes, over ${PUT_MAX_BYTES}`, 'client');
    if (sha256Hex(bytes) !== hex) throw new StateStoreError(`put ${hex}: the bytes do not hash to it`, 'client');
    return this.request('PUT', `/v1/cas/sha256/${hex}`, bytes, 'application/gzip', async (res) => {
      const j = (await res.json()) as Partial<PutResult>;
      if (j.key !== casKey(hex) || j.size !== bytes.byteLength || typeof j.uploaded !== 'string') {
        throw new StateStoreError(`put ${hex}: the store answered ${JSON.stringify(j).slice(0, 200)}, expected key ${casKey(hex)} and size ${bytes.byteLength}`, 'integrity');
      }
      return { key: j.key, size: j.size, uploaded: j.uploaded };
    });
  }

  /**
   * One batch, resumable: the answer is read as a stream and scanned (scanBatchFrames), every blob delivered whole is
   * verified and kept, and when the stream breaks (a cut connection, the attempt's timeout) the next attempt asks only
   * for the blobs not yet held. A stream that delivered every requested blob is complete even if its trailer was cut
   * (each blob is proven by its sha256; the trailer guards against a blob left out, and none is). Up to batchAttempts
   * attempts, each timed by batchTimeoutMs of the bytes it asks for (opts.sizes; BLOB_BYTES_ESTIMATE a blob otherwise).
   * A MISSING blob or a malformed frame fails at once (never retried).
   */
  async batchGet(shas: readonly string[], opts: BatchGetOptions = {}): Promise<Map<string, Buffer>> {
    checkShas(shas);
    const got = new Map<string, Buffer>();
    const left = (): string[] => shas.filter((h) => !got.has(h));
    const bytes = (hs: readonly string[]): number => hs.reduce((n, h) => n + sizeOf(h, opts.sizes), 0);
    return this.request(
      'POST',
      '/v1/cas:batchGet',
      () => JSON.stringify({ shas: left() }),
      'application/json',
      async (res, at) => {
        const asked = left();
        const chunks: Buffer[] = [];
        let broke: string | null = null;
        try {
          if (res.body) {
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(Buffer.from(value));
            }
          } else chunks.push(Buffer.from(await res.arrayBuffer()));
        } catch (e) {
          broke = at.cancelled() ? 'cancelled' : at.aborted() ? `timed out after ${at.limitMs} ms` : (e as Error).message;
        }
        const scan = scanBatchFrames(Buffer.concat(chunks), asked);
        for (const [k, v] of scan.blobs) got.set(k, v);
        if (scan.missing.length) throw missingError(scan.missing);
        const rest = left();
        if (rest.length === 0) return got;
        if (scan.ended) throw new StateStoreError(`batchGet: ${rest.length} requested blob(s) not in the answer: ${rest.slice(0, 5).join(', ')}`, 'integrity');
        throw new StateStoreError(
          `batchGet: the stream broke after ${scan.blobs.size} of ${asked.length} blob(s) (${broke ?? scan.cut}); ${shas.length - rest.length} of ${shas.length} held`,
          'transport',
          200,
          true,
        );
      },
      {
        attempts: this.batchAttempts,
        timeoutMs: () => batchTimeoutMs(bytes(left()), this.timeoutMs),
        signal: opts.signal,
        what: () => {
          const l = left();
          return `${l.length} blob(s), ${(bytes(l) / 1e6).toFixed(1)} MB`;
        },
      },
    );
  }

  async gc(req: GcRequest): Promise<GcPage> {
    checkGcRequest(req);
    return this.request('POST', '/v1/gc', JSON.stringify(req), 'application/json', async (res) => parseGcPage(await res.json(), req.dryRun));
  }

  async budget(): Promise<StateBudget> {
    return this.request('GET', '/v1/budget', null, null, async (res) => parseBudget(await res.json()));
  }

  async getRef(lane: string): Promise<RefRead | null> {
    if (!isLane(lane, { rehearsal: true })) throw new StateStoreError(`ref: not a lane: ${lane.slice(0, 80)}`, 'client');
    return this.request(
      'GET',
      `/v1/refs/${lane}`,
      null,
      null,
      async (res) => {
        if (res.status === 404) return null;
        // x-feed-state-etag first: the edge may weaken the standard ETag of a compressed answer (W/"…"; state/src/worker.js
        // json), and only a strong tag can go back as If-Match.
        const etag = res.headers.get('x-feed-state-etag') ?? res.headers.get('etag');
        if (!etag || !/^"[^"\s]+"$/.test(etag)) throw new StateStoreError(`ref ${lane}: no strong ETag in the answer`, 'integrity');
        const text = await res.text();
        return { ref: parseRef(text, lane), text, etag };
      },
      { protocol: REF_PROTOCOL, accept: [404] },
    );
  }

  /**
   * One PUT, never retried here (a CAS: swapRef decides after an unknown outcome). 412 → RefConflict with the current
   * ref; a 200 whose new seq's reflog slot was already taken → ReflogCollision (kind integrity); a 404 answer (the lane
   * is unknown to the Worker) is kind client.
   */
  async putRef(lane: string, ref: StateRef, pre: RefPrecondition): Promise<RefSwap> {
    if (!isLane(lane, { rehearsal: true }) || ref.lane !== lane) throw new StateStoreError(`ref: not a lane, or the ref is another lane's: ${lane.slice(0, 80)}`, 'client');
    const text = canonicalJson(ref);
    parseRef(text, lane);
    if (Buffer.byteLength(text) > REF_MAX_BYTES) throw new StateStoreError(`ref ${lane}: ${Buffer.byteLength(text)} bytes, over ${REF_MAX_BYTES}`, 'client');
    const headers: Record<string, string> = 'create' in pre ? { 'if-none-match': '*' } : { 'if-match': pre.etag };
    return this.request(
      'PUT',
      `/v1/refs/${lane}`,
      text,
      'application/json',
      async (res) => {
        const num = (h: string): number | null => (res.headers.get(h) != null && /^\d+$/.test(res.headers.get(h)!) ? Number(res.headers.get(h)) : null);
        if (res.status === 412) {
          const j = (await res.json().catch(() => null)) as { current?: unknown; etag?: unknown; at?: unknown } | null;
          let current: RefRead | null = null;
          if (j && j.current != null && typeof j.etag === 'string') {
            const t = canonicalJson(j.current);
            current = { ref: parseRef(t, lane), text: t, etag: j.etag };
          }
          const at = j?.at === 'read' || j?.at === 'swap' ? j.at : null;
          throw new RefConflict(`ref ${lane}: 412, the ref is ${current ? `seq ${current.ref.seq} by ${current.ref.writer}` : 'absent'}, not the version named`, current, at);
        }
        const j = (await res.json()) as Partial<RefSwap> & { reflog?: RefSwap['reflog'] };
        if (j.lane !== lane || j.seq !== ref.seq || j.generation !== ref.generation || typeof j.etag !== 'string' || !j.reflog) {
          throw new StateStoreError(`ref ${lane}: the store answered ${JSON.stringify(j).slice(0, 200)}`, 'integrity');
        }
        return checkReflogSlot({ lane, seq: ref.seq, generation: ref.generation, etag: j.etag, reflog: j.reflog, storeOps: num('x-feed-state-store-ops'), ledgerCalls: num('x-feed-state-ledger-calls') });
      },
      { protocol: REF_PROTOCOL, headers, accept: [412], attempts: 1 },
    );
  }

  async reflog(lane: string, opts: { after?: number; limit?: number } = {}): Promise<ReflogPage> {
    if (!isLane(lane, { rehearsal: true })) throw new StateStoreError(`reflog: not a lane: ${lane.slice(0, 80)}`, 'client');
    const q = new URLSearchParams();
    if (opts.after) q.set('after', String(opts.after));
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return this.request('GET', `/v1/gen/${lane}${qs ? `?${qs}` : ''}`, null, null, async (res) => parseReflogPage(await res.json(), lane), { protocol: REF_PROTOCOL });
  }

  /** Staging's rehearsal probes (POST /v1/rehearsal/<lane>; the Worker has the route on staging only). */
  async rehearsalProbe(lane: string, body: { op: 'create-only'; form: 'headers' | 'conditional' } | { op: 'drop-reflog'; seq: number }): Promise<Record<string, unknown>> {
    if (!REHEARSAL_LANE.test(lane)) throw new StateStoreError(`probe: not a rehearsal lane: ${lane.slice(0, 80)}`, 'client');
    return this.request('POST', `/v1/rehearsal/${lane}`, JSON.stringify(body), 'application/json', async (res) => (await res.json()) as Record<string, unknown>, { protocol: REF_PROTOCOL, attempts: 1 });
  }

  /** A raw request for the rehearsal's negative checks (status and parsed JSON, never thrown). */
  async rawRef(method: 'GET' | 'PUT', lane: string, body: string | null, headers: Record<string, string>): Promise<{ status: number; json: unknown; headers: Headers }> {
    const token = await this.opts.token();
    const res = await this.fetchImpl(`${this.base}/v1/refs/${lane}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'user-agent': STATE_USER_AGENT, ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ?? undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The directory backend

const DAY_MS = 86_400_000;

/**
 * A local directory with the bucket's key layout (`<dir>/cas/sha256/<2>/<hex>`): the same checks as the Worker (the
 * bytes must hash to the key; at most 40 per batchGet; GC's rules), so a dry run or a test exercises the client's
 * paths. A file's mtime stands for R2's `uploaded`; a put rewrites the file, refreshing it.
 */
export class FsBackend implements StateBackend, StateRefs {
  readonly label: string;
  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.label = `directory ${dir}`;
  }

  private file(hex: string): string {
    return join(this.dir, ...casKey(hex).split('/'));
  }

  async put(hex: string, bytes: Uint8Array): Promise<PutResult> {
    if (!isSha256Hex(hex)) throw new StateStoreError(`put: not a sha256: ${String(hex).slice(0, 80)}`, 'client');
    if (bytes.byteLength > PUT_MAX_BYTES) throw new StateStoreError(`put ${hex}: ${bytes.byteLength} bytes, over ${PUT_MAX_BYTES}`, 'client');
    if (sha256Hex(bytes) !== hex) throw new StateStoreError(`put ${hex}: checksum mismatch`, 'integrity', 400);
    const f = this.file(hex);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, f);
    const t = this.now() / 1000;
    utimesSync(f, t, t);
    return { key: casKey(hex), size: bytes.byteLength, uploaded: new Date(this.now()).toISOString() };
  }

  async batchGet(shas: readonly string[], _opts?: BatchGetOptions): Promise<Map<string, Buffer>> {
    checkShas(shas);
    const framed = frameBatch(shas.map((h) => [h, existsSync(this.file(h)) ? readFileSync(this.file(h)) : null]));
    return parseBatchFrames(framed, shas);
  }

  /** Every key under cas/, sorted (the listing order of R2). */
  private keys(): string[] {
    const root = join(this.dir, 'cas');
    const out: string[] = [];
    const walk = (d: string): void => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (!e.name.includes('.tmp-')) out.push(relative(this.dir, p).split(sep).join('/'));
      }
    };
    walk(root);
    return out.sort();
  }

  /** The Worker's GC (state/src/cas.js gcPage) on the directory, with the same request checks and the same answer. */
  async gc(req: GcRequest): Promise<GcPage> {
    checkGcRequest(req);
    const keep = new Set(req.keep);
    for (const c of req.current) {
      if (!keep.has(c)) throw new StateStoreError(`gc: current blob ${c} is not in keep`, 'refused', 409);
      if (!existsSync(this.file(c))) throw new StateStoreError(`gc: current blob ${c} is missing`, 'refused', 409);
    }
    const all = this.keys();
    const start = req.cursor ? all.findIndex((k) => k > req.cursor!) : 0;
    const page = start < 0 ? [] : all.slice(start, start + 1000);
    const cutoffMs = this.now() - req.minAgeDays * DAY_MS;
    const doomed: string[] = [];
    let bytesWouldDelete = 0;
    let kept = 0;
    let young = 0;
    let capped = 0;
    let foreign = 0;
    for (const k of page) {
      const m = /^cas\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(k);
      const hex = m && m[2]!.startsWith(m[1]!) ? m[2]! : null;
      const st = statSync(join(this.dir, ...k.split('/')));
      if (hex == null) foreign++;
      else if (keep.has(hex)) kept++;
      else if (!(st.mtimeMs < cutoffMs)) young++;
      else if (doomed.length >= req.maxDeletes) capped++;
      else {
        doomed.push(k);
        bytesWouldDelete += st.size;
      }
    }
    if (!req.dryRun) for (const k of doomed) rmSync(join(this.dir, ...k.split('/')));
    const more = start >= 0 && start + 1000 < all.length;
    return {
      listed: page.length,
      deleted: req.dryRun ? 0 : doomed.length,
      bytesDeleted: req.dryRun ? 0 : bytesWouldDelete,
      wouldDelete: doomed.length,
      bytesWouldDelete,
      kept,
      young,
      capped,
      foreign,
      cursor: more ? page.at(-1)! : null,
      dryRun: req.dryRun,
    };
  }

  async budget(): Promise<StateBudget | null> {
    return null;
  }

  // The refs: `<dir>/refs/<lane>` and `<dir>/gen/<lane>/<seq12>`, the Worker's rules (successor, the generation blob
  // present, create-only reflog with repair), an ETag of the body's sha256 (32 hex, as the Worker's Durable Object
  // fallback computes it). One process at a time (a dry run, a test): the swap is a read-compare-rename, not atomic
  // between processes.
  private refFile(lane: string): string {
    return join(this.dir, 'refs', lane);
  }

  private reflogFile(lane: string, seq: number): string {
    return join(this.dir, 'gen', lane, String(seq).padStart(12, '0'));
  }

  async getRef(lane: string): Promise<RefRead | null> {
    if (!isLane(lane, { rehearsal: true })) throw new StateStoreError(`ref: not a lane: ${lane.slice(0, 80)}`, 'client');
    const f = this.refFile(lane);
    if (!existsSync(f)) return null;
    const text = readFileSync(f, 'utf8');
    return { ref: parseRef(text, lane), text, etag: `"${sha256Hex(text).slice(0, 32)}"` };
  }

  async putRef(lane: string, ref: StateRef, pre: RefPrecondition): Promise<RefSwap> {
    if (!isLane(lane, { rehearsal: true }) || ref.lane !== lane) throw new StateStoreError(`ref: not a lane, or the ref is another lane's: ${lane.slice(0, 80)}`, 'client');
    const text = canonicalJson(ref);
    parseRef(text, lane);
    const cur = await this.getRef(lane);
    if ('create' in pre ? cur != null : cur?.etag !== pre.etag) throw new RefConflict(`ref ${lane}: 412`, cur);
    if (cur) checkSuccessor(cur.ref, ref);
    else {
      // A create continues the reflog the lane may still have (the Worker's checkCreate).
      if (ref.restore_of) throw new StateStoreError(`ref ${lane}: a create cannot restore`, 'refused', 409);
      const d = join(this.dir, 'gen', lane);
      const last = existsSync(d) ? readdirSync(d).filter((n) => /^\d{12}$/.test(n)).sort().at(-1) : undefined;
      checkSuccessor(last ? parseRef(readFileSync(join(d, last), 'utf8'), lane) : null, ref);
    }
    if (!existsSync(this.file(ref.generation))) throw new StateStoreError(`ref ${lane}: the generation blob is missing from the store`, 'refused', 409);
    const createOnly = (f: string, body: string): boolean => {
      mkdirSync(dirname(f), { recursive: true });
      try {
        writeFileSync(f, body, { flag: 'wx' });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
      }
    };
    const previous = cur ? (createOnly(this.reflogFile(lane, cur.ref.seq), cur.text) ? 'repaired' : 'present') : 'none';
    const f = this.refFile(lane);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(`${f}.tmp-${process.pid}`, text);
    renameSync(`${f}.tmp-${process.pid}`, f);
    const entry = createOnly(this.reflogFile(lane, ref.seq), text) ? 'created' : 'exists';
    return checkReflogSlot({ lane, seq: ref.seq, generation: ref.generation, etag: `"${sha256Hex(text).slice(0, 32)}"`, reflog: { previous, entry }, storeOps: null, ledgerCalls: null });
  }

  async reflog(lane: string, opts: { after?: number; limit?: number } = {}): Promise<ReflogPage> {
    const d = join(this.dir, 'gen', lane);
    const after = opts.after ?? 0;
    const limit = Math.min(opts.limit ?? 1000, 1000);
    const names = existsSync(d) ? readdirSync(d).filter((n) => /^\d{12}$/.test(n) && Number(n) > after).sort() : [];
    const page = names.slice(0, limit);
    const entries: ReflogEntry[] = page.map((n) => {
      const p = join(d, n);
      const r = parseRef(readFileSync(p, 'utf8'), lane);
      const st = statSync(p);
      return { seq: Number(n), generation: r.generation, parent: r.parent, head_seq: r.head_seq, data_commit: r.data_commit, written: r.written, writer: r.writer, restore_of: r.restore_of ?? null, uploaded: new Date(st.mtimeMs).toISOString(), size: st.size };
    });
    return { lane, entries, next: names.length > limit && entries.length ? entries.at(-1)!.seq : null };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Configuration

/**
 * FEED_STATE_BACKEND as the jobs read it: the workflows pass `${{ vars.FEED_STATE_BACKEND || 'worker' }}`, so the store
 * is on by default and the repository variable set to `off` is the kill switch (phase 3a only: from phase 3b the store
 * holds the only copy of the event map). `off`, empty or unset → '' (no store).
 */
export function stateBackendSetting(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.FEED_STATE_BACKEND ?? '').trim();
  return raw === 'off' ? '' : raw;
}

/**
 * The backend FEED_STATE_BACKEND names: `worker` (FEED_STATE_URL, FEED_STATE_AUDIENCE), `fs:<dir>`, or null when unset,
 * empty or `off` (no store). Anything else throws. `policy` (the Worker only) tightens the retry defaults and sets a step
 * deadline over every request, the token requests included.
 */
export function backendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { log?: (line: string) => void; fetchImpl?: FetchImpl; policy?: RetryPolicy } = {},
): StateBackend | null {
  const raw = stateBackendSetting(env);
  if (!raw) return null;
  if (raw === 'worker') {
    const audience = (env.FEED_STATE_AUDIENCE ?? '').trim() || DEFAULT_STATE_AUDIENCE;
    return new WorkerBackend({
      baseUrl: (env.FEED_STATE_URL ?? '').trim() || DEFAULT_STATE_URL,
      token: githubOidcTokenSource(audience, { env, fetchImpl: opts.fetchImpl, policy: opts.policy }),
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.policy?.timeoutMs,
      attempts: opts.policy?.attempts,
      batchAttempts: opts.policy?.batchAttempts,
      retryBudgetMs: opts.policy?.retryBudgetMs,
      deadlineMs: opts.policy?.deadlineMs ?? null,
      log: opts.log ?? ((l) => console.log(l)),
    });
  }
  if (raw.startsWith('fs:') && raw.length > 3) return new FsBackend(raw.slice(3));
  throw new StateStoreError(`FEED_STATE_BACKEND=${raw.slice(0, 80)}: worker, fs:<dir> or unset`, 'config');
}
