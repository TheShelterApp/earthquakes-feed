import { createHash } from 'node:crypto';
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
 *                                   `MISSING <hex>\n`, then `END <count>\n`. The client fails closed on a MISSING, a
 *                                   stream without its trailer, any length or sha256 mismatch.
 *   POST /v1/gc                     body {keep, current, cursor, minAgeDays, maxDeletes, dryRun}: one listing page;
 *                                   200 {listed, deleted, bytesDeleted, kept, cursor|null}; 409 when `current` is not
 *                                   in `keep` or a `current` blob is missing (at most 40 `current` a call).
 *   GET  /v1/budget                 200 today's counters and the ceilings (health reads it).
 *   401 bad or missing token · 403 a workflow the route does not allow · 426 protocol too old · 429 {"error":"budget"}
 *   a free-tier ceiling is reached (never retried: the store refuses until 00:00 UTC) · other 429 and 5xx: retried.
 */

export const STATE_PROTOCOL = 1;
export const STATE_USER_AGENT = 'earthquakes-feed-state-client/1';
export const DEFAULT_STATE_URL = 'https://feed-state.theshelter.app';
export const DEFAULT_STATE_AUDIENCE = 'earthquakes-feed-state';
/** At most this many blobs per batchGet (the Worker's limit; a Free-plan invocation's subrequests stay well inside). */
export const BATCH_MAX = 40;
/** The Worker refuses a PUT body over this size (413). A day's gzipped NDJSON is about 0.3 MB. */
export const PUT_MAX_BYTES = 25 * 1024 * 1024;
/** Per request; a batchGet of 40 day blobs is about 12 MB. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Attempts per request (network errors, 5xx, a 429 that is not the budget). */
export const MAX_ATTEMPTS = 4;
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
  /** Deleted (or, in a dry run, that would be). */
  deleted: number;
  bytesDeleted: number;
  kept: number;
  cursor: string | null;
}

export interface StateBackend {
  readonly label: string;
  /** Store `bytes` under the sha256 `hex` of those bytes. */
  put(hex: string, bytes: Uint8Array): Promise<PutResult>;
  /** The blobs `shas` (1–40), each verified against its sha256. Throws when any is missing. */
  batchGet(shas: readonly string[]): Promise<Map<string, Buffer>>;
  /** One GC page. */
  gc(req: GcRequest): Promise<GcPage>;
  /** Today's counters and ceilings, as the store reports them (null: the backend keeps none). */
  budget(): Promise<unknown>;
}

export type StateErrorKind = 'config' | 'auth' | 'forbidden' | 'protocol' | 'budget' | 'refused' | 'integrity' | 'missing' | 'transport' | 'client';

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

/**
 * The blobs of a batchGet answer, each checked: every requested sha exactly once, as `BLOB <hex> <length>` with that
 * many bytes whose sha256 is <hex> and a `\n` after them, nothing unrequested, the `END <count>` trailer last and
 * nothing after it, <count> the number of records. A `MISSING` record throws (kind `missing`); a stream cut short (no
 * trailer) throws kind `transport` (the request is worth repeating); anything else malformed throws kind `integrity`.
 */
export function parseBatchFrames(body: Buffer, requested: readonly string[]): Map<string, Buffer> {
  const want = new Set(requested);
  const out = new Map<string, Buffer>();
  const missing: string[] = [];
  let records = 0;
  let pos = 0;
  const bad = (why: string): never => {
    throw new StateStoreError(`batchGet: ${why}`, 'integrity');
  };
  for (;;) {
    const nl = body.indexOf(0x0a, pos);
    if (nl < 0) {
      throw new StateStoreError(`batchGet: the stream ended after ${records} record(s) without its END trailer`, 'transport', null, true);
    }
    const line = body.toString('latin1', pos, nl);
    pos = nl + 1;
    const parts = line.split(' ');
    if (parts[0] === 'END' && parts.length === 2) {
      if (!/^\d+$/.test(parts[1]!) || Number(parts[1]) !== records) bad(`trailer ${JSON.stringify(line)} after ${records} record(s)`);
      if (pos !== body.length) bad(`${body.length - pos} byte(s) after the trailer`);
      break;
    }
    if (parts[0] === 'MISSING' && parts.length === 2) {
      const hex = parts[1]!;
      if (!want.has(hex) || out.has(hex) || missing.includes(hex)) bad(`unexpected MISSING ${hex.slice(0, 80)}`);
      missing.push(hex);
      records++;
      continue;
    }
    if (parts[0] === 'BLOB' && parts.length === 3) {
      const hex = parts[1]!;
      if (!want.has(hex) || out.has(hex) || missing.includes(hex)) bad(`unexpected BLOB ${hex.slice(0, 80)}`);
      if (!/^\d+$/.test(parts[2]!)) bad(`BLOB ${hex}: length ${JSON.stringify(parts[2]!.slice(0, 20))}`);
      const len = Number(parts[2]);
      if (pos + len + 1 > body.length) {
        throw new StateStoreError(`batchGet: BLOB ${hex} declares ${len} bytes, the stream ends ${body.length - pos} byte(s) later`, 'transport', null, true);
      }
      const bytes = body.subarray(pos, pos + len);
      if (body[pos + len] !== 0x0a) bad(`BLOB ${hex}: no newline after its ${len} bytes`);
      const got = sha256Hex(bytes);
      if (got !== hex) bad(`BLOB ${hex}: its bytes hash to ${got}`);
      out.set(hex, Buffer.from(bytes));
      pos += len + 1;
      records++;
      continue;
    }
    bad(`unreadable frame ${JSON.stringify(line.slice(0, 80))}`);
  }
  if (missing.length) throw new StateStoreError(`batchGet: ${missing.length} blob(s) missing from the store: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`, 'missing');
  const absent = requested.filter((h) => !out.has(h));
  if (absent.length) bad(`${absent.length} requested blob(s) not in the answer: ${absent.slice(0, 5).join(', ')}`);
  return out;
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

/** Every blob of `shas` (any number, duplicates allowed), fetched in batches of at most BATCH_MAX. */
export async function getBlobs(backend: StateBackend, shas: Iterable<string>): Promise<Map<string, Buffer>> {
  const all = [...new Set(shas)].sort();
  const out = new Map<string, Buffer>();
  for (let i = 0; i < all.length; i += BATCH_MAX) {
    const got = await backend.batchGet(all.slice(i, i + BATCH_MAX));
    for (const [k, v] of got) out.set(k, v);
  }
  return out;
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
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchImpl; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): TokenSource {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let cached: { token: string; expMs: number } | null = null;
  return async () => {
    if (cached && cached.expMs - now() > TOKEN_MIN_LEFT_MS) return cached.token;
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) {
      throw new StateStoreError('no GitHub OIDC token: ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN are unset (the job needs `permissions: id-token: write`)', 'config');
    }
    const target = `${url}${url.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`;
    let last = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(backoffMs(attempt, Math.random));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
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
        last = ctrl.signal.aborted ? `timed out after ${REQUEST_TIMEOUT_MS} ms` : `network error: ${(e as Error).message}`;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new StateStoreError(`the OIDC token request failed: ${last} after ${MAX_ATTEMPTS} attempts`, 'transport', null, true);
  };
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
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
  attempts?: number;
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

export class WorkerBackend implements StateBackend {
  readonly label: string;
  private readonly base: string;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly attempts: number;
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
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.attempts = opts.attempts ?? MAX_ATTEMPTS;
    this.log = opts.log ?? (() => {});
  }

  /**
   * One request with the retry policy: a network error, a timeout, a 5xx or a 429 that is not the budget's are tried
   * again (at most `attempts` in all, jittered backoff); any other status is final. `read` turns a 200 into the result
   * and may throw a retryable StateStoreError (a stream cut short).
   */
  private async request<T>(method: string, path: string, body: Uint8Array | string | null, contentType: string | null, read: (res: Response) => Promise<T>): Promise<T> {
    const route = `${method} ${path.replace(/[0-9a-f]{64}/, '<hex>')}`;
    let last: StateStoreError | null = null;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      if (attempt > 1) await this.sleep(backoffMs(attempt, this.random));
      const t0 = Date.now();
      const token = await this.opts.token();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        'user-agent': STATE_USER_AGENT,
        'x-feed-state-protocol': String(STATE_PROTOCOL),
      };
      if (contentType) headers['content-type'] = contentType;
      // Content-Length is not set here: fetch derives it from a buffered body (a string or bytes, never a stream), and
      // the Worker refuses a body without one (411; R2's put needs a known length). tests/state-store.test.ts checks it.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let status: number | null = null;
      try {
        const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: body ?? undefined, signal: ctrl.signal });
        status = res.status;
        const rid = res.headers.get('x-request-id') ?? '-';
        if (res.status === 200) {
          const out = await read(res);
          this.log(`state ${route}: 200 in ${Date.now() - t0} ms (attempt ${attempt}, request ${rid})`);
          return out;
        }
        const text = await res.text().catch(() => '');
        const err = errorOf(text);
        this.log(`state ${route}: HTTP ${res.status}${err ? ` (${err})` : ''} in ${Date.now() - t0} ms (attempt ${attempt}, request ${rid})`);
        const what = `${route}: HTTP ${res.status}${err ? ` ${err}` : ''}`;
        if (res.status === 429 && err === 'budget') throw new StateStoreError(`${what}: a free-tier ceiling of the store is reached until 00:00 UTC`, 'budget', 429);
        if (res.status >= 500 || res.status === 429) {
          last = new StateStoreError(what, 'transport', res.status, true);
          continue;
        }
        const kind: StateErrorKind =
          res.status === 401 ? 'auth' : res.status === 403 ? 'forbidden' : res.status === 426 ? 'protocol' : res.status === 409 ? 'refused' : res.status === 400 ? 'integrity' : 'client';
        throw new StateStoreError(what, kind, res.status);
      } catch (e) {
        if (e instanceof StateStoreError) {
          if (!e.retryable) throw e;
          last = e;
          continue;
        }
        last = new StateStoreError(`${route}: ${ctrl.signal.aborted ? `timed out after ${this.timeoutMs} ms` : `network error: ${(e as Error).message}`}`, 'transport', status, true);
        this.log(`state ${route}: ${last.message} (attempt ${attempt})`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new StateStoreError(`${last?.message ?? route} after ${this.attempts} attempts`, last?.kind ?? 'transport', last?.status ?? null, true);
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

  async batchGet(shas: readonly string[]): Promise<Map<string, Buffer>> {
    checkShas(shas);
    return this.request('POST', '/v1/cas:batchGet', JSON.stringify({ shas }), 'application/json', async (res) => {
      let body: Buffer;
      try {
        body = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        throw new StateStoreError(`batchGet: the stream broke: ${(e as Error).message}`, 'transport', 200, true);
      }
      return parseBatchFrames(body, shas);
    });
  }

  async gc(req: GcRequest): Promise<GcPage> {
    if (req.current.length > BATCH_MAX) throw new StateStoreError(`gc: ${req.current.length} current blobs, at most ${BATCH_MAX} a call`, 'client');
    return this.request('POST', '/v1/gc', JSON.stringify(req), 'application/json', async (res) => {
      const j = (await res.json()) as Partial<GcPage>;
      const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
      if (!num(j.listed) || !num(j.deleted) || !num(j.bytesDeleted) || !num(j.kept) || !(j.cursor === null || typeof j.cursor === 'string')) {
        throw new StateStoreError(`gc: unreadable answer ${JSON.stringify(j).slice(0, 200)}`, 'integrity');
      }
      return { listed: j.listed, deleted: j.deleted, bytesDeleted: j.bytesDeleted, kept: j.kept, cursor: j.cursor };
    });
  }

  async budget(): Promise<unknown> {
    return this.request('GET', '/v1/budget', null, null, async (res) => (await res.json()) as unknown);
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
export class FsBackend implements StateBackend {
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

  async batchGet(shas: readonly string[]): Promise<Map<string, Buffer>> {
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

  async gc(req: GcRequest): Promise<GcPage> {
    if (req.current.length > BATCH_MAX) throw new StateStoreError(`gc: ${req.current.length} current blobs, at most ${BATCH_MAX} a call`, 'client', 400);
    if (!(req.minAgeDays >= 14) || !(req.maxDeletes >= 0 && req.maxDeletes <= 1000)) throw new StateStoreError('gc: minAgeDays ≥ 14 and maxDeletes ≤ 1000', 'client', 400);
    const keep = new Set(req.keep);
    for (const c of req.current) {
      if (!keep.has(c)) throw new StateStoreError(`gc: current blob ${c} is not in keep`, 'refused', 409);
      if (!existsSync(this.file(c))) throw new StateStoreError(`gc: current blob ${c} is missing`, 'refused', 409);
    }
    const all = this.keys();
    const start = req.cursor ? all.findIndex((k) => k > req.cursor!) : 0;
    const page = start < 0 ? [] : all.slice(start, start + 1000);
    const cutoffMs = this.now() - req.minAgeDays * DAY_MS;
    let deleted = 0;
    let bytesDeleted = 0;
    let kept = 0;
    for (const k of page) {
      const hex = k.slice(k.lastIndexOf('/') + 1);
      const st = statSync(join(this.dir, ...k.split('/')));
      if (keep.has(hex) || st.mtimeMs >= cutoffMs || deleted >= req.maxDeletes) {
        kept++;
        continue;
      }
      deleted++;
      bytesDeleted += st.size;
      if (!req.dryRun) rmSync(join(this.dir, ...k.split('/')));
    }
    const more = start >= 0 && start + 1000 < all.length;
    return { listed: page.length, deleted, bytesDeleted, kept, cursor: more ? page.at(-1)! : null };
  }

  async budget(): Promise<unknown> {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Configuration

/**
 * The backend FEED_STATE_BACKEND names: `worker` (FEED_STATE_URL, FEED_STATE_AUDIENCE), `fs:<dir>`, or null when unset
 * or empty (no store). Anything else throws.
 */
export function backendFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { log?: (line: string) => void; fetchImpl?: FetchImpl } = {}): StateBackend | null {
  const raw = (env.FEED_STATE_BACKEND ?? '').trim();
  if (!raw) return null;
  if (raw === 'worker') {
    const audience = (env.FEED_STATE_AUDIENCE ?? '').trim() || DEFAULT_STATE_AUDIENCE;
    return new WorkerBackend({
      baseUrl: (env.FEED_STATE_URL ?? '').trim() || DEFAULT_STATE_URL,
      token: githubOidcTokenSource(audience, { env, fetchImpl: opts.fetchImpl }),
      fetchImpl: opts.fetchImpl,
      log: opts.log ?? ((l) => console.log(l)),
    });
  }
  if (raw.startsWith('fs:') && raw.length > 3) return new FsBackend(raw.slice(3));
  throw new StateStoreError(`FEED_STATE_BACKEND=${raw.slice(0, 80)}: worker, fs:<dir> or unset`, 'config');
}
