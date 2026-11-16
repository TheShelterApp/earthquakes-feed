// The feed's state Worker: the HTTP surface of the event map's blob store (README.md in this directory has the
// contract, the auth policy, the budgets and the runbook).
//
//   PUT  /v1/cas/sha256/<hex>   write   store one blob (gzip bytes whose sha256 is <hex>)
//   POST /v1/cas:batchGet       read    1..40 blobs in one framed stream
//   POST /v1/gc                 gc      one page of garbage collection
//   GET  /v1/budget             budget  today's counters and the ceilings (feed-health)
//
// Every route: a GitHub OIDC token (auth.js) → the route's workflow allow-list → (writes and gc) the protocol gate →
// request validation → the budget reservation (budget.js, Durable Object BUDGET) → the bucket (binding STATE).
// Order matters for cost: an unauthenticated request never reaches the Durable Object or the bucket, so a flood costs
// Worker requests only (account-wide 100,000/day on Workers Free; the zone's rate limits sit in front).
//
// One structured JSON line per request (route, workflow, run_id, run_attempt, n, bytes, status, ms, error), never the
// token; every response carries x-request-id (the cf-ray when there is one), which the client logs on failure.

import { AuthError, authorize, bearerToken, createKeyStore, verifyToken } from './auth.js';
import {
  MAX_BATCH,
  MAX_BLOB_BYTES,
  MAX_CURRENT,
  MAX_DELETES,
  MAX_KEEP,
  MIN_AGE_DAYS,
  blobKey,
  gcPage,
  isSha,
  keepHash,
  putBlob,
  r2ErrorCode,
  streamBlobs,
} from './cas.js';

/** The name of the one budget ledger object (Durable Object class BudgetLedger in index.js, budget.js). */
export const BUDGET_NAME = 'global';
export const PROTOCOL_HEADER = 'x-feed-state-protocol';
const MAX_BATCH_BODY = 8 * 1024;
const MAX_GC_BODY = 1024 * 1024;
const CEILING_VARS = ['CLASS_A_PER_DAY', 'CLASS_B_PER_DAY', 'BYTES_WRITTEN_PER_DAY', 'STORED_BYTES_MAX'];

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** The Worker's configuration from its vars; a missing or malformed var is a deploy error, answered 500. */
export function configFrom(env) {
  const problems = [];
  const repositoryId = String(env.REPOSITORY_ID ?? '');
  if (!/^[1-9][0-9]*$/.test(repositoryId)) problems.push('REPOSITORY_ID');
  const audience = String(env.AUDIENCE ?? '');
  if (!audience) problems.push('AUDIENCE');
  const allowAnyRef = String(env.ALLOW_ANY_REF ?? '');
  if (allowAnyRef !== '0' && allowAnyRef !== '1') problems.push('ALLOW_ANY_REF');
  const environment = String(env.ENVIRONMENT ?? '');
  if (environment !== 'production' && environment !== 'staging') problems.push('ENVIRONMENT');
  // Production never admits another ref, whatever the vars say.
  if (environment === 'production' && allowAnyRef === '1') problems.push('ALLOW_ANY_REF (production)');
  const minProtocol = Number(env.MIN_PROTOCOL);
  if (!Number.isInteger(minProtocol) || minProtocol < 1) problems.push('MIN_PROTOCOL');
  const ceilings = {};
  for (const name of CEILING_VARS) {
    const v = Number(env[name]);
    if (!Number.isSafeInteger(v) || v <= 0) problems.push(name);
    ceilings[name] = v;
  }
  if (!env.STATE) problems.push('STATE');
  if (!env.BUDGET) problems.push('BUDGET');
  if (problems.length) throw new HttpError(500, `misconfigured: ${problems.join(', ')}`);
  return {
    repositoryId,
    audience,
    allowAnyRef: allowAnyRef === '1',
    staging: environment === 'staging',
    minProtocol,
    ceilings,
  };
}

function json(status, body, requestId, extraHeaders = {}) {
  return new Response(JSON.stringify(body) + '\n', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...extraHeaders,
    },
  });
}

/** The route of a request: {name, right} or an HttpError (404 unknown path, 405 wrong method). */
function routeOf(method, pathname) {
  const put = /^\/v1\/cas\/sha256\/([0-9a-f]{64})$/.exec(pathname);
  const routes = [
    [put != null, 'PUT', { name: 'put', right: 'write', sha: put?.[1] }],
    [pathname === '/v1/cas:batchGet', 'POST', { name: 'batchGet', right: 'read' }],
    [pathname === '/v1/gc', 'POST', { name: 'gc', right: 'gc' }],
    [pathname === '/v1/budget', 'GET', { name: 'budget', right: 'budget' }],
  ];
  for (const [match, want, route] of routes) {
    if (!match) continue;
    if (method !== want) throw new HttpError(405, 'method not allowed', { allow: want });
    return route;
  }
  throw new HttpError(404, 'not found');
}

/** The declared Content-Length, or null when absent; a malformed value is a 400. */
function contentLength(request) {
  const raw = request.headers.get('content-length');
  if (raw == null) return null;
  if (!/^[0-9]{1,15}$/.test(raw)) throw new HttpError(400, 'malformed content-length');
  return Number(raw);
}

/** Read a JSON request body of at most max bytes (413 above it, 400 if not a JSON object). */
async function readJson(request, max) {
  const declared = contentLength(request);
  if (declared != null && declared > max) throw new HttpError(413, `body above ${max} bytes`);
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, `body above ${max} bytes`);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'body is not a JSON object');
}

/** A list of unique shas with min ≤ length ≤ max, or a 400 naming the field. */
function shaList(v, field, min, max) {
  if (!Array.isArray(v)) throw new HttpError(400, `${field} must be an array`);
  if (v.length < min || v.length > max) throw new HttpError(400, `${field} must hold ${min}..${max} shas`);
  for (const s of v) if (!isSha(s)) throw new HttpError(400, `${field} holds a value that is not a lowercase sha256`);
  if (new Set(v).size !== v.length) throw new HttpError(400, `${field} holds duplicates`);
  return v;
}

function protocolOk(request, min) {
  const raw = request.headers.get(PROTOCOL_HEADER);
  return raw != null && /^[0-9]{1,6}$/.test(raw) && Number(raw) >= min;
}

function budgetStub(env) {
  return env.BUDGET.get(env.BUDGET.idFromName(BUDGET_NAME));
}

/** Call the budget ledger; an unreachable ledger is a 503 (retryable), never an unmetered request. */
async function ledger(env, call) {
  try {
    return await call(budgetStub(env));
  } catch (err) {
    throw new HttpError(503, 'budget ledger unavailable', { cause: String(err) });
  }
}

function refusedByBudget(verdict) {
  if (verdict.pass) throw new HttpError(409, 'gc cursor does not continue the open pass: start again with cursor null');
  if (!verdict.ok) throw new HttpError(429, 'budget', { ceiling: verdict.ceiling });
}

async function handlePut(request, env, cfg, route, log, nowMs) {
  if (request.headers.get('content-encoding')) {
    throw new HttpError(400, 'send the gzip bytes as the body with content-type application/gzip, no content-encoding');
  }
  const length = contentLength(request);
  if (length == null) throw new HttpError(411, 'content-length required');
  if (length > MAX_BLOB_BYTES) throw new HttpError(413, `blob above ${MAX_BLOB_BYTES} bytes`);
  if (length === 0 || !request.body) throw new HttpError(400, 'empty body');
  log.bytes = length;
  const verdict = await ledger(env, (b) =>
    b.reserve({ nowMs, cost: { classA: 1, classB: 0, bytes: length }, ceilings: cfg.ceilings }),
  );
  refusedByBudget(verdict);
  let object;
  try {
    object = await putBlob(env.STATE, route.sha, request.body);
  } catch (err) {
    await ledger(env, (b) => b.refundStored(length)).catch(() => {});
    const code = r2ErrorCode(err);
    if (code === 10037) throw new HttpError(400, 'checksum mismatch: the body is not the blob its sha256 names', { retryable: false });
    throw new HttpError(503, 'store write failed', { cause: String(err) });
  }
  return json(200, { key: object.key, size: object.size, uploaded: new Date(object.uploaded).toISOString() }, log.rid);
}

async function handleBatchGet(request, env, cfg, ctx, log, nowMs, started, emit) {
  const body = await readJson(request, MAX_BATCH_BODY);
  const shas = shaList(body.shas, 'shas', 1, MAX_BATCH);
  log.n = shas.length;
  const verdict = await ledger(env, (b) =>
    b.reserve({ nowMs, cost: { classA: 0, classB: shas.length, bytes: 0 }, ceilings: cfg.ceilings }),
  );
  refusedByBudget(verdict);
  const { readable, writable } = new TransformStream();
  const pump = streamBlobs(env.STATE, shas, writable).then(
    (r) => {
      log.bytes = r.bytes;
      log.missing = r.missing;
      emit(200, started);
    },
    (err) => {
      log.error = `stream aborted: ${String(err)}`;
      emit(200, started);
    },
  );
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pump);
  log.deferred = true;
  return new Response(readable, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      // no-transform: the zone must neither compress nor rewrite the frames; no-store: never cached.
      'cache-control': 'no-store, no-transform',
      'x-request-id': log.rid,
    },
  });
}

async function handleGc(request, env, cfg, log, nowMs) {
  const body = await readJson(request, MAX_GC_BODY);
  const cursor = body.cursor ?? null;
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4096)) {
    throw new HttpError(400, 'cursor must be null or a cursor this endpoint returned');
  }
  const keep = shaList(body.keep, 'keep', 1, MAX_KEEP);
  // `current` (blobs of the live generation) is proven present and inside keep on the pass's first page; later pages
  // carry no `current` and are tied to that page by the ledger (same cursor chain, same keep hash). At most MAX_CURRENT
  // HEADs per invocation (the Free plan's subrequest limit is 50 under its stricter reading), so the client sends the
  // generation's OLDEST days: a day's blob is never uploaded before that day, so with minAgeDays ≥ 14 only the days
  // older than 14 days (at most 32 of the 45-day horizon's ~46) are old enough to be deleted at all.
  const current = cursor === null ? shaList(body.current, 'current', 1, MAX_CURRENT) : shaList(body.current ?? [], 'current', 0, 0);
  const minAgeDays = body.minAgeDays;
  if (!Number.isInteger(minAgeDays) || minAgeDays < MIN_AGE_DAYS || minAgeDays > 36_500) {
    throw new HttpError(400, `minAgeDays must be an integer ≥ ${MIN_AGE_DAYS}`);
  }
  const maxDeletes = body.maxDeletes;
  if (!Number.isInteger(maxDeletes) || maxDeletes < 0 || maxDeletes > MAX_DELETES) {
    throw new HttpError(400, `maxDeletes must be an integer 0..${MAX_DELETES}`);
  }
  if (typeof body.dryRun !== 'boolean') throw new HttpError(400, 'dryRun must be true or false');
  const dryRun = body.dryRun;
  log.n = keep.length;
  log.dry_run = dryRun;
  const keepSet = new Set(keep);
  const outside = current.filter((s) => !keepSet.has(s));
  if (outside.length) throw new HttpError(409, 'current is not inside keep', { outside });
  const hash = await keepHash(keep);
  const verdict = await ledger(env, (b) =>
    b.gcBegin({ nowMs, cursor, keepHash: hash, cost: { classA: 1, classB: current.length, bytes: 0 }, ceilings: cfg.ceilings }),
  );
  refusedByBudget(verdict);
  const missing = [];
  for (const sha of current) {
    if (!(await env.STATE.head(blobKey(sha)))) missing.push(sha);
  }
  if (missing.length) throw new HttpError(409, 'a current blob is missing from the store', { missing });
  const page = await gcPage(env.STATE, { keep, cursor, minAgeDays, maxDeletes, dryRun, nowMs });
  await ledger(env, (b) =>
    b.gcEnd({
      nowMs,
      cursor,
      nextCursor: page.cursor,
      keepHash: hash,
      keptBytes: page.keptBytes,
      deletedBytes: page.bytesDeleted,
    }),
  );
  log.bytes = page.bytesDeleted;
  log.deleted = page.deleted;
  const { keptBytes: _keptBytes, ...result } = page;
  return json(200, { ...result, dryRun }, log.rid);
}

/**
 * The request handler. deps (tests): keyStore, cache (Cache API or null), now() → epoch ms, log(line).
 */
export function createHandler({ keyStore, cache = null, now = Date.now, log: writeLog = (l) => console.log(l) } = {}) {
  const keys = keyStore ?? createKeyStore({ cache, now });
  return async function handle(request, env, ctx) {
    const started = now();
    const url = new URL(request.url);
    const rid = request.headers.get('cf-ray') || crypto.randomUUID();
    const log = { t: 'feed-state', rid, method: request.method, route: null, path: url.pathname };
    let emitted = false;
    const emit = (status, since) => {
      if (emitted) return;
      emitted = true;
      log.status = status;
      log.ms = now() - since;
      delete log.deferred;
      writeLog(JSON.stringify(log));
    };
    let response;
    try {
      const cfg = configFrom(env);
      const route = routeOf(request.method, url.pathname);
      log.route = route.name;
      if (route.sha) log.sha = route.sha;
      const token = bearerToken(request);
      const claims = await verifyToken(token, {
        audience: cfg.audience,
        repositoryId: cfg.repositoryId,
        keyStore: keys,
        cacheKey: `${url.origin}/.jwks-cache/github-actions`,
        nowMs: now(),
      });
      log.run_id = claims.run_id ?? null;
      log.run_attempt = claims.run_attempt ?? null;
      log.workflow = authorize(claims, route.right, { allowAnyRef: cfg.allowAnyRef, staging: cfg.staging });
      if ((route.right === 'write' || route.right === 'gc') && !protocolOk(request, cfg.minProtocol)) {
        throw new HttpError(426, `${PROTOCOL_HEADER} must be ≥ ${cfg.minProtocol}`, { min_protocol: cfg.minProtocol });
      }
      const nowMs = now();
      if (route.name === 'put') response = await handlePut(request, env, cfg, route, log, nowMs);
      else if (route.name === 'batchGet') response = await handleBatchGet(request, env, cfg, ctx, log, nowMs, started, emit);
      else if (route.name === 'gc') response = await handleGc(request, env, cfg, log, nowMs);
      else response = json(200, await ledger(env, (b) => b.snapshot({ nowMs, ceilings: cfg.ceilings })), rid);
    } catch (err) {
      if (err instanceof AuthError) {
        log.error = err.reason;
        const error = { 401: 'unauthenticated', 403: 'forbidden', 503: 'unavailable' }[err.status];
        response = json(err.status, { error, reason: err.reason }, rid, err.status === 503 ? { 'retry-after': '30' } : {});
      } else if (err instanceof HttpError) {
        log.error = err.message;
        if (err.extra.cause) log.cause = err.extra.cause;
        const { cause: _cause, allow, ...extra } = err.extra;
        const body = err.status === 429 ? { error: 'budget', ...extra } : { error: err.message, ...extra };
        response = json(err.status, body, rid, allow ? { allow } : {});
      } else {
        log.error = `internal: ${String(err)}`;
        response = json(500, { error: 'internal error' }, rid);
      }
    }
    if (!log.deferred) emit(response.status, started);
    return response;
  };
}

let defaultHandler = null;

export default {
  async fetch(request, env, ctx) {
    defaultHandler ??= createHandler({ cache: typeof caches !== 'undefined' ? caches.default : null });
    return defaultHandler(request, env, ctx);
  },
};
