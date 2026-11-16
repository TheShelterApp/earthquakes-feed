// The feed's state Worker: the HTTP surface of the event map's blob store (README.md in this directory has the
// contract, the auth policy, the budgets and the runbook).
//
//   PUT  /v1/cas/sha256/<hex>   write      store one blob (gzip bytes whose sha256 is <hex>)
//   POST /v1/cas:batchGet       read       1..40 blobs in one framed stream
//   POST /v1/gc                 gc         one page of garbage collection
//   GET  /v1/budget             budget     today's counters and the ceilings (feed-health)
// Protocol 2 (storage phase 4.0, refs.js; additive: MIN_PROTOCOL stays 1, and nothing in production calls these yet):
//   GET  /v1/refs/<lane>        ref-read   the lane's ref and its strong ETag, or 404
//   PUT  /v1/refs/<lane>        ref-write  compare-and-swap (If-Match, or If-None-Match: * once); `restore` when the
//                                          body carries restore_of
//   GET  /v1/gen/<lane>         reflog     one page of the lane's reflog (?after=<seq>&limit=<n ≤ 1000>)
//   POST /v1/rehearsal/<lane>   (staging)  the rehearsal's probes on a rehearsal lane (create-only, drop-reflog)
//
// Every route: a GitHub OIDC token (auth.js) → the route's (repository_id, workflow) pairs → (writes and gc) the protocol gate →
// request validation → the budget reservation (budget.js, Durable Object BUDGET) → the bucket (binding STATE).
// Order matters for cost: an unauthenticated request never reaches the Durable Object or the bucket, so a flood costs
// Worker requests only (account-wide 100,000/day on Workers Free; the zone's rate limits sit in front).
//
// One structured JSON line per request (route, workflow, run_id, run_attempt, lane, n, bytes, status, ms, error, ops,
// ledger), never the token; every response carries x-request-id (the cf-ray when there is one), which the client logs on
// failure. A ref route's answer also carries x-feed-state-store-ops (bucket and ref-store operations it made) and
// x-feed-state-ledger-calls (budget ledger calls), so the rehearsal can prove the subrequest bound.
//
// Priority lanes (budget.js): aggregate, derive and the restore reserve on the `critical` lane (refused above 95 % of a
// ceiling); every other workflow on `background` (above 60 %).

import { AuthError, DEFAULT_POLICY, LANES, REHEARSAL_LANE, authorize, bearerToken, createKeyStore, knownRepositories, verifyToken } from './auth.js';
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
import {
  MAX_REFLOG_PAGE,
  MAX_REF_BYTES,
  REF_PROTOCOL,
  RefError,
  doRefStore,
  httpEtag,
  parseRefBody,
  preconditionOf,
  probe,
  putRef,
  r2RefStore,
  reflogPage,
} from './refs.js';

/** The name of the one budget ledger object (Durable Object class BudgetLedger in index.js, budget.js). */
export const BUDGET_NAME = 'global';
export const PROTOCOL_HEADER = 'x-feed-state-protocol';
const MAX_BATCH_BODY = 8 * 1024;
const MAX_GC_BODY = 1024 * 1024;
const MAX_PROBE_BODY = 1024;
const CEILING_VARS = ['CLASS_A_PER_DAY', 'CLASS_B_PER_DAY', 'BYTES_WRITTEN_PER_DAY', 'STORED_BYTES_MAX'];
/** The workflows of this repository that reserve on the critical lane; every other caller is background. */
export const CRITICAL_WORKFLOWS = ['aggregate.yml', 'derive.yml', 'state-restore.yml'];

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
  const refBackend = String(env.REF_BACKEND ?? '');
  if (refBackend !== 'r2' && refBackend !== 'do') problems.push('REF_BACKEND');
  if (!env.STATE) problems.push('STATE');
  if (!env.BUDGET) problems.push('BUDGET');
  if (problems.length) throw new HttpError(500, `misconfigured: ${problems.join(', ')}`);
  return {
    repositoryId,
    audience,
    allowAnyRef: allowAnyRef === '1',
    staging: environment === 'staging',
    minProtocol,
    refBackend,
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

/** Whether `lane` names a lane here: a production lane, or (staging only) a rehearsal lane. */
function laneOk(lane, staging) {
  return LANES.includes(lane) || (staging && REHEARSAL_LANE.test(lane));
}

/** The route of a request: {name, right, lane?} or an HttpError (404 unknown path or lane, 405 wrong method). */
function routeOf(method, pathname, staging) {
  const lanePath = /^\/v1\/(refs|gen|rehearsal)\/([a-z0-9-]{1,64})$/.exec(pathname);
  if (lanePath) {
    const [, kind, lane] = lanePath;
    if (kind === 'rehearsal' ? !(staging && REHEARSAL_LANE.test(lane)) : !laneOk(lane, staging)) throw new HttpError(404, 'not found');
    if (kind === 'refs') {
      if (method === 'GET') return { name: 'refGet', right: 'ref-read', lane };
      if (method === 'PUT') return { name: 'refPut', right: 'ref-write', lane };
      throw new HttpError(405, 'method not allowed', { allow: 'GET, PUT' });
    }
    const want = kind === 'gen' ? 'GET' : 'POST';
    if (method !== want) throw new HttpError(405, 'method not allowed', { allow: want });
    return kind === 'gen' ? { name: 'reflog', right: 'reflog', lane } : { name: 'probe', right: 'probe', lane };
  }
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

/** Read a request body of at most max bytes as text (413 above it). */
async function readText(request, max) {
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, 'body is not UTF-8');
  }
}

/** Read a JSON request body of at most max bytes (413 above it, 400 if not a JSON object). */
async function readJson(request, max) {
  const text = await readText(request, max);
  try {
    const v = JSON.parse(text);
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

/** The lowest protocol a right needs: blob writes and GC MIN_PROTOCOL, ref writes (and restore, probes) at least 2. */
function protocolFor(right, cfg) {
  if (right === 'write' || right === 'gc') return cfg.minProtocol;
  if (right === 'ref-write' || right === 'restore' || right === 'probe') return Math.max(cfg.minProtocol, REF_PROTOCOL);
  return null;
}

function protocolOk(request, min) {
  const raw = request.headers.get(PROTOCOL_HEADER);
  return raw != null && /^[0-9]{1,6}$/.test(raw) && Number(raw) >= min;
}

function budgetStub(env) {
  return env.BUDGET.get(env.BUDGET.idFromName(BUDGET_NAME));
}

/** Call the budget ledger; an unreachable ledger is a 503 (retryable), never an unmetered request. `log.ledger` counts
 *  the calls of the request. */
async function ledger(env, log, call) {
  log.ledger = (log.ledger ?? 0) + 1;
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
  const verdict = await ledger(env, log, (b) =>
    b.reserve({ nowMs, cost: { classA: 1, classB: 0, bytes: length }, ceilings: cfg.ceilings, priority: log.priority }),
  );
  refusedByBudget(verdict);
  let object;
  try {
    object = await putBlob(env.STATE, route.sha, request.body);
  } catch (err) {
    await ledger(env, log, (b) => b.refundStored(length, nowMs)).catch(() => {});
    const code = r2ErrorCode(err);
    if (code === 10037) throw new HttpError(400, 'checksum mismatch: the body is not the blob its sha256 names', { retryable: false });
    throw new HttpError(503, 'store write failed', { cause: String(err) });
  }
  return json(200, { key: object.key, size: object.size, uploaded: new Date(object.uploaded).toISOString() }, log.rid);
}

/**
 * The batchGet response's pipe. On Workers an IdentityTransformStream: native and byte-oriented, so the R2 bodies piped
 * into it (and the Response reading it) move without passing every chunk through JS, which a standard TransformStream
 * would charge to the Worker's CPU (transformstream_enable_standard_constructor is on since 2022-11-30). Its writable
 * takes the frame headers as Uint8Array. Node (the tests) has no IdentityTransformStream: a standard one there.
 */
export function byteStream() {
  const Identity = globalThis.IdentityTransformStream;
  return typeof Identity === 'function' ? new Identity() : new TransformStream();
}

async function handleBatchGet(request, env, cfg, ctx, log, nowMs, started, emit) {
  const body = await readJson(request, MAX_BATCH_BODY);
  const shas = shaList(body.shas, 'shas', 1, MAX_BATCH);
  log.n = shas.length;
  const verdict = await ledger(env, log, (b) =>
    b.reserve({ nowMs, cost: { classA: 0, classB: shas.length, bytes: 0 }, ceilings: cfg.ceilings, priority: log.priority }),
  );
  refusedByBudget(verdict);
  const { readable, writable } = byteStream();
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
  // HEADs per invocation (the Free plan's subrequest limit is 50 under its stricter reading), so the client sends a
  // larger generation in chunks of 40: each but the last in a dry-run first page of its own, the last with the real
  // pass's first page (src/state-gc.ts collect; state/README.md).
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
  const verdict = await ledger(env, log, (b) =>
    b.gcBegin({ nowMs, cursor, keepHash: hash, cost: { classA: 1, classB: current.length, bytes: 0 }, ceilings: cfg.ceilings, priority: log.priority }),
  );
  refusedByBudget(verdict);
  const missing = [];
  for (const sha of current) {
    if (!(await env.STATE.head(blobKey(sha)))) missing.push(sha);
  }
  if (missing.length) throw new HttpError(409, 'a current blob is missing from the store', { missing });
  const page = await gcPage(env.STATE, { keep, cursor, minAgeDays, maxDeletes, dryRun, nowMs });
  await ledger(env, log, (b) =>
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

// ---------------------------------------------------------------------------------------------------------------------
// Protocol 2: refs and the reflog (refs.js)

/** The bucket as one request sees it: every call counted in log.ops (the subrequest bound of a ref route). */
function countedBucket(bucket, log) {
  const count =
    (name) =>
    (...args) => {
      log.ops = (log.ops ?? 0) + 1;
      return bucket[name](...args);
    };
  return { get: count('get'), head: count('head'), put: count('put'), list: count('list'), delete: count('delete') };
}

/** The ref store REF_BACKEND names, over the counted bucket (r2) or the ledger object with its calls counted (do). */
function refStoreFor(env, cfg, bucket, log) {
  if (cfg.refBackend === 'r2') return r2RefStore(bucket);
  const store = doRefStore(budgetStub(env));
  const count =
    (fn) =>
    async (...args) => {
      log.ops = (log.ops ?? 0) + 1;
      try {
        return await fn(...args);
      } catch (err) {
        throw new HttpError(503, 'ref store unavailable', { cause: String(err) });
      }
    };
  return { kind: 'do', get: count(store.get), swap: count(store.swap) };
}

/** Whether a ref PUT's body asks for a restore (decides the right before the body is fully checked). */
function restoreRequested(text) {
  try {
    const v = JSON.parse(text);
    return !!v && typeof v === 'object' && !Array.isArray(v) && 'restore_of' in v;
  } catch {
    return false;
  }
}

async function handleRefGet(env, cfg, route, log, nowMs) {
  const verdict = await ledger(env, log, (b) =>
    b.reserve({ nowMs, cost: { classA: 0, classB: 1, bytes: 0 }, ceilings: cfg.ceilings, priority: log.priority }),
  );
  refusedByBudget(verdict);
  const store = refStoreFor(env, cfg, countedBucket(env.STATE, log), log);
  let cur;
  try {
    cur = await store.get(route.lane);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, 'store read failed', { cause: String(err) });
  }
  if (!cur) return json(404, { error: 'no ref', lane: route.lane }, log.rid);
  return new Response(cur.text, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      etag: httpEtag(cur.etag),
      'x-request-id': log.rid,
    },
  });
}

async function handleRefPut(request, env, cfg, route, claims, text, log, nowMs) {
  const pre = preconditionOf(request.headers);
  const ref = parseRefBody(text, route.lane, { workflow: log.workflow, runId: claims.run_id, runAttempt: claims.run_attempt });
  const len = new TextEncoder().encode(text).byteLength;
  log.seq = ref.seq;
  log.bytes = len;
  if (ref.restore_of) log.restore_of = ref.restore_of.seq;
  // Stored: the new reflog entry, and on a create the ref object too; written: three bodies at most (repair, swap, entry).
  // The worst case of each class: Class A the repair (a create: the reflog listing), the swap and the entry; Class B
  // the GET, the HEAD and, when the swap itself refuses, the re-GET for the 412 body (it replaces the entry's PUT).
  const metaBytes = len * (pre.create ? 2 : 1);
  const verdict = await ledger(env, log, (b) =>
    b.reserve({ nowMs, cost: { classA: 3, classB: 3, bytes: 0, metaBytes, extraWritten: 3 * len - metaBytes }, ceilings: cfg.ceilings, priority: log.priority }),
  );
  refusedByBudget(verdict);
  const bucket = countedBucket(env.STATE, log);
  let result;
  try {
    result = await putRef({ store: refStoreFor(env, cfg, bucket, log), bucket, lane: route.lane, pre, text, ref });
  } catch (err) {
    if (err instanceof RefError) {
      await ledger(env, log, (b) => b.refundRef({ nowMs, metaBytes, conflict: err.status === 412 })).catch(() => {});
      throw err;
    }
    if (err instanceof HttpError) throw err;
    // A bucket error after the reservation: whether anything was stored is unknown, so the reservation stays (high).
    throw new HttpError(503, 'store write failed', { cause: String(err) });
  }
  log.reflog = `${result.reflog.previous}/${result.reflog.entry}`;
  if (result.reflog.entry === 'exists') log.error = `the reflog slot of seq ${ref.seq} was already taken`;
  const etag = httpEtag(result.etag);
  return json(200, { lane: route.lane, seq: ref.seq, generation: ref.generation, etag, reflog: result.reflog }, log.rid, { etag });
}

async function handleReflog(url, env, cfg, route, log, nowMs) {
  const int = (name, dflt, min, max) => {
    const raw = url.searchParams.get(name);
    if (raw == null) return dflt;
    if (!/^[0-9]{1,13}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new HttpError(400, `${name} must be an integer ${min}..${max}`);
    return Number(raw);
  };
  const after = int('after', 0, 0, 999_999_999_999);
  const limit = int('limit', MAX_REFLOG_PAGE, 1, MAX_REFLOG_PAGE);
  const verdict = await ledger(env, log, (b) =>
    b.reserve({ nowMs, cost: { classA: 1, classB: 0, bytes: 0 }, ceilings: cfg.ceilings, priority: log.priority }),
  );
  refusedByBudget(verdict);
  let page;
  try {
    page = await reflogPage(countedBucket(env.STATE, log), route.lane, after, limit);
  } catch (err) {
    throw new HttpError(503, 'store list failed', { cause: String(err) });
  }
  log.n = page.entries.length;
  return json(200, page, log.rid);
}

async function handleProbe(request, env, cfg, route, log, nowMs) {
  const body = await readJson(request, MAX_PROBE_BODY);
  log.probe = String(body.op ?? '');
  const verdict = await ledger(env, log, (b) =>
    b.reserve({ nowMs, cost: { classA: 2, classB: 1, bytes: 0, metaBytes: 64 }, ceilings: cfg.ceilings, priority: log.priority }),
  );
  refusedByBudget(verdict);
  return json(200, await probe(countedBucket(env.STATE, log), route.lane, body), log.rid);
}

/** The priority lane of a caller (budget.js): the home repository's feed workflows are critical. */
function priorityOf(claims, workflow, homeId) {
  return String(claims.repository_id ?? '') === String(homeId) && CRITICAL_WORKFLOWS.includes(workflow) ? 'critical' : 'background';
}

/**
 * The request handler. deps (tests): keyStore, cache (Cache API or null), now() → epoch ms, log(line), policy (the
 * (repository_id, workflow) pairs, auth.js DEFAULT_POLICY).
 */
export function createHandler({ keyStore, cache = null, now = Date.now, log: writeLog = (l) => console.log(l), policy = DEFAULT_POLICY } = {}) {
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
    let route = null;
    try {
      const cfg = configFrom(env);
      route = routeOf(request.method, url.pathname, cfg.staging);
      log.route = route.name;
      if (route.sha) log.sha = route.sha;
      if (route.lane) log.lane = route.lane;
      const token = bearerToken(request);
      const claims = await verifyToken(token, {
        audience: cfg.audience,
        repositoryIds: knownRepositories(cfg.repositoryId, policy),
        keyStore: keys,
        cacheKey: `${url.origin}/.jwks-cache/github-actions`,
        nowMs: now(),
      });
      log.run_id = claims.run_id ?? null;
      log.run_attempt = claims.run_attempt ?? null;
      if (String(claims.repository_id) !== cfg.repositoryId) log.repository_id = String(claims.repository_id);
      // A ref PUT is a restore when its body says so: the right (and so the pairs) depends on the body, read first
      // (at most 4 KiB, after the token is verified).
      let refText = null;
      if (route.name === 'refPut') {
        refText = await readText(request, MAX_REF_BYTES);
        if (restoreRequested(refText)) route = { ...route, right: 'restore' };
      }
      log.workflow = authorize(claims, route.right, {
        repositoryId: cfg.repositoryId,
        allowAnyRef: cfg.allowAnyRef,
        staging: cfg.staging,
        lane: route.lane ?? null,
        policy,
      });
      log.priority = priorityOf(claims, log.workflow, cfg.repositoryId);
      const min = protocolFor(route.right, cfg);
      if (min != null && !protocolOk(request, min)) {
        throw new HttpError(426, `${PROTOCOL_HEADER} must be ≥ ${min}`, { min_protocol: min });
      }
      const nowMs = now();
      if (route.name === 'put') response = await handlePut(request, env, cfg, route, log, nowMs);
      else if (route.name === 'batchGet') response = await handleBatchGet(request, env, cfg, ctx, log, nowMs, started, emit);
      else if (route.name === 'gc') response = await handleGc(request, env, cfg, log, nowMs);
      else if (route.name === 'refGet') response = await handleRefGet(env, cfg, route, log, nowMs);
      else if (route.name === 'refPut') response = await handleRefPut(request, env, cfg, route, claims, refText, log, nowMs);
      else if (route.name === 'reflog') response = await handleReflog(url, env, cfg, route, log, nowMs);
      else if (route.name === 'probe') response = await handleProbe(request, env, cfg, route, log, nowMs);
      else response = json(200, await ledger(env, log, (b) => b.snapshot({ nowMs, ceilings: cfg.ceilings })), rid);
    } catch (err) {
      if (err instanceof AuthError) {
        log.error = err.reason;
        const error = { 401: 'unauthenticated', 403: 'forbidden', 503: 'unavailable' }[err.status];
        response = json(err.status, { error, reason: err.reason }, rid, err.status === 503 ? { 'retry-after': '30' } : {});
      } else if (err instanceof RefError) {
        log.error = err.message;
        const etag = err.status === 412 && err.extra.etag ? { etag: err.extra.etag } : {};
        response = json(err.status, { error: err.message, ...err.extra }, rid, etag);
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
    if (route?.lane) {
      response.headers.set('x-feed-state-store-ops', String(log.ops ?? 0));
      response.headers.set('x-feed-state-ledger-calls', String(log.ledger ?? 0));
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
