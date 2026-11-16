import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, createHmac, type KeyObject, sign as nodeSign } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JWKS_STALE_MS, JWKS_TTL_MS, REFETCH_MIN_MS, ROUTE_WORKFLOWS, createKeyStore, type JwksCache } from '../state/src/auth.js';
import { KEEP_DAYS, SCHEMA, gcBegin, gcEnd, refundStored, reserve, snapshot, type Sql } from '../state/src/budget.js';
import { BLOB_METADATA, blobKey, shaOfKey } from '../state/src/cas.js';
import { createHandler, type Env } from '../state/src/worker.js';

// The feed's state Worker (state/): GitHub OIDC verification and the per-route workflow policy, the CAS PUT, the
// batchGet frames, the GC pages, the budget ledger's ceilings and the protocol gate — offline, against an in-memory R2
// bucket, the budget ledger on node:sqlite, a local RSA key behind an injected JWKS and a fake Cache API.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const REPO_ID = '1289538519';
const AUD = 'earthquakes-feed-state';
const T0 = Date.parse('2026-11-16T10:00:00Z');
const DAY = 86_400_000;
const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

// --- Tokens --------------------------------------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (key: KeyObject, kid: string) => ({ ...(key.export({ format: 'jwk' }) as object), kid, alg: 'RS256', use: 'sig' });
const JWKS = { keys: [jwkOf(publicKey, 'k1')] };

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** The clock tokens are minted at: each harness resets it to T0 and moves it with its own clock. */
let tokenClock = T0;

function claimsFor(overrides: Record<string, unknown> = {}, nowMs = tokenClock): Record<string, unknown> {
  const now = Math.floor(nowMs / 1000);
  const workflow = (overrides.workflow as string | undefined) ?? 'aggregate.yml';
  const ref = (overrides.ref as string | undefined) ?? 'refs/heads/main';
  const c: Record<string, unknown> = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: AUD,
    sub: 'repo:TheShelterApp/earthquakes-feed:ref:refs/heads/main',
    repository: 'TheShelterApp/earthquakes-feed',
    repository_id: REPO_ID,
    repository_owner_id: '1',
    ref,
    ref_type: 'branch',
    event_name: 'schedule',
    runner_environment: 'github-hosted',
    workflow_ref: `TheShelterApp/earthquakes-feed/.github/workflows/${workflow}@${ref}`,
    run_id: '43810721906',
    run_attempt: '1',
    nbf: now - 600,
    iat: now,
    exp: now + 300,
    ...overrides,
  };
  delete c.workflow;
  return c;
}

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key: KeyObject = privateKey): string {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header }));
  const p = b64url(JSON.stringify(claimsFor(claims)));
  const sig = nodeSign('sha256', Buffer.from(`${h}.${p}`), key);
  return `${h}.${p}.${b64url(sig)}`;
}

// --- Fakes ---------------------------------------------------------------------------------------------------------

interface Stored {
  bytes: Uint8Array;
  uploaded: Date;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}

/** The R2 binding's subset the Worker uses: put (with the sha256 check R2 does), get, head, list, delete. */
class FakeR2 {
  objects = new Map<string, Stored>();
  ops = { put: 0, get: 0, head: 0, list: 0, delete: 0 };
  now = (): number => T0;
  failGetAfter = Infinity;
  async put(key: string, value: ReadableStream | Uint8Array, opts: { sha256?: string; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } } = {}) {
    this.ops.put++;
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    if (opts.sha256 && sha256(bytes) !== opts.sha256) {
      throw new Error('put: The SHA-256 checksum you specified did not match what we received. (10037)');
    }
    const o: Stored = { bytes, uploaded: new Date(this.now()), customMetadata: opts.customMetadata, httpMetadata: opts.httpMetadata };
    this.objects.set(key, o);
    return { key, size: bytes.byteLength, uploaded: o.uploaded, etag: sha256(bytes).slice(0, 32) };
  }
  async get(key: string) {
    this.ops.get++;
    if (this.ops.get > this.failGetAfter) throw new Error('get: We encountered an internal error. Please try again. (10001)');
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.byteLength, uploaded: o.uploaded, body: new Response(o.bytes.slice()).body! } : null;
  }
  async head(key: string) {
    this.ops.head++;
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.byteLength, uploaded: o.uploaded } : null;
  }
  async list({ prefix = '', cursor, limit = 1000 }: { prefix?: string; cursor?: string; limit?: number }) {
    this.ops.list++;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? keys.findIndex((k) => k > cursor) : 0;
    const from = start < 0 ? keys.length : start;
    const page = keys.slice(from, from + Math.min(limit, 1000));
    const truncated = from + page.length < keys.length;
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.bytes.byteLength, uploaded: this.objects.get(key)!.uploaded })),
      truncated,
      cursor: truncated ? page.at(-1)! : undefined,
      delimitedPrefixes: [],
    };
  }
  async delete(keys: string | string[]) {
    this.ops.delete++;
    const list = Array.isArray(keys) ? keys : [keys];
    assert.ok(list.length <= 1000, 'R2 deletes at most 1000 keys per call');
    for (const k of list) this.objects.delete(k);
  }
  /** Seed a blob as if PUT at uploadedMs. */
  seed(bytes: Uint8Array | string, uploadedMs: number): string {
    const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    const sha = sha256(b);
    this.objects.set(blobKey(sha), { bytes: b, uploaded: new Date(uploadedMs) });
    return sha;
  }
}

/** A node:sqlite database behind the Durable Object's `ctx.storage.sql.exec` shape, with the ledger's schema. */
function sqliteSql(): Sql {
  const db = new DatabaseSync(':memory:');
  const exec = (query: string, ...bindings: unknown[]) => {
    const rows = db.prepare(query).all(...(bindings as SQLInputValue[]));
    return { toArray: () => rows };
  };
  for (const s of SCHEMA) exec(s);
  return { exec };
}

/** The BudgetLedger Durable Object's RPC surface over node:sqlite (async, values cloned, as RPC does). */
function fakeBudget(down = false) {
  const sql = sqliteSql();
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const names: string[] = [];
  const stub = {
    reserve: async (a: Parameters<typeof reserve>[1]) => clone(reserve(sql, clone(a))),
    refundStored: async (b: number) => refundStored(sql, b),
    gcBegin: async (a: Parameters<typeof gcBegin>[1]) => clone(gcBegin(sql, clone(a))),
    gcEnd: async (a: Parameters<typeof gcEnd>[1]) => gcEnd(sql, clone(a)),
    snapshot: async (a: Parameters<typeof snapshot>[1]) => clone(snapshot(sql, clone(a))),
  };
  return {
    sql,
    names,
    ns: {
      idFromName: (n: string) => (names.push(n), n),
      get: () => {
        if (down) throw new Error('Durable Object reset because its code was updated.');
        return stub;
      },
    },
  };
}

/** The Cache API subset: a Map of Responses. */
function fakeCache(): JwksCache & { size(): number } {
  const m = new Map<string, Response>();
  return {
    match: async (k: string) => m.get(k)?.clone(),
    put: async (k: string, r: Response) => void m.set(k, r.clone()),
    size: () => m.size,
  };
}

type Body = NonNullable<RequestInit['body']>;

const CEILINGS = { CLASS_A_PER_DAY: '20000', CLASS_B_PER_DAY: '200000', BYTES_WRITTEN_PER_DAY: '1073741824', STORED_BYTES_MAX: '6442450944' };

function harness(opts: { staging?: boolean; env?: Partial<Env>; jwks?: () => Promise<unknown>; budgetDown?: boolean } = {}) {
  let t = T0;
  tokenClock = T0;
  const r2 = new FakeR2();
  r2.now = () => t;
  const budget = fakeBudget(opts.budgetDown);
  const cache = fakeCache();
  let jwksFetches = 0;
  const fetchJwks =
    opts.jwks ??
    (async () => {
      jwksFetches++;
      return JWKS;
    });
  const keyStore = createKeyStore({
    fetchJwks: async () => {
      if (opts.jwks) jwksFetches++;
      return fetchJwks();
    },
    cache,
    now: () => t,
  });
  const logs: string[] = [];
  const handle = createHandler({ keyStore, now: () => t, log: (l) => void logs.push(l) });
  const env: Env = {
    ENVIRONMENT: opts.staging ? 'staging' : 'production',
    REPOSITORY_ID: REPO_ID,
    AUDIENCE: opts.staging ? 'earthquakes-feed-state-staging' : AUD,
    ALLOW_ANY_REF: opts.staging ? '1' : '0',
    MIN_PROTOCOL: '1',
    ...CEILINGS,
    STATE: r2,
    BUDGET: budget.ns,
    ...opts.env,
  };
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const call = async (
    method: string,
    path: string,
    { auth, body, headers = {}, protocol = '1' }: { auth?: string | null; body?: Body | object; headers?: Record<string, string>; protocol?: string | null } = {},
  ): Promise<Response> => {
    const h: Record<string, string> = { ...headers };
    if (auth !== null) h.authorization = `Bearer ${auth ?? token(opts.staging ? { aud: env.AUDIENCE } : {})}`;
    if (protocol !== null) h['x-feed-state-protocol'] = protocol;
    let b: Body | undefined;
    const streamed = body instanceof ReadableStream;
    if (streamed || body instanceof Uint8Array || typeof body === 'string') b = body as Body;
    else if (body !== undefined) b = JSON.stringify(body);
    if (b !== undefined && !streamed && h['content-length'] === undefined) {
      h['content-length'] = String(typeof b === 'string' ? Buffer.byteLength(b) : (b as Uint8Array).byteLength);
    }
    const init = { method, headers: h, body: b, ...(streamed ? { duplex: 'half' } : {}) } as RequestInit;
    const req = new Request(`https://feed-state.theshelter.app${path}`, init);
    return handle(req, env, ctx);
  };
  const settle = async () => {
    await Promise.all(waits.splice(0));
  };
  return {
    r2,
    budget,
    cache,
    env,
    logs,
    call,
    settle,
    get jwksFetches() {
      return jwksFetches;
    },
    advance: (ms: number) => {
      t += ms;
      tokenClock = t;
    },
    get now() {
      return t;
    },
  };
}

const gz = (text: string): Uint8Array => new Uint8Array(Buffer.from(`gzip:${text}`));

/** Parse a batchGet stream; throws on any framing error (the client's fail-closed rules). */
function parseFrames(buf: Uint8Array): { blobs: Map<string, Uint8Array>; missing: string[]; end: number | null } {
  const blobs = new Map<string, Uint8Array>();
  const missing: string[] = [];
  let at = 0;
  let end: number | null = null;
  const line = (): string => {
    const nl = buf.indexOf(10, at);
    if (nl < 0) throw new Error('truncated header');
    const s = Buffer.from(buf.subarray(at, nl)).toString('utf8');
    at = nl + 1;
    return s;
  };
  while (at < buf.length) {
    if (end !== null) throw new Error('bytes after the trailer');
    const l = line();
    let m: RegExpExecArray | null;
    if ((m = /^BLOB ([0-9a-f]{64}) (\d+)$/.exec(l))) {
      const n = Number(m[2]);
      if (at + n + 1 > buf.length || buf[at + n] !== 10) throw new Error('length mismatch');
      const bytes = buf.slice(at, at + n);
      if (sha256(bytes) !== m[1]) throw new Error('sha mismatch');
      blobs.set(m[1]!, bytes);
      at += n + 1;
    } else if ((m = /^MISSING ([0-9a-f]{64})$/.exec(l))) missing.push(m[1]!);
    else if ((m = /^END (\d+)$/.exec(l))) end = Number(m[1]);
    else throw new Error(`bad frame ${l}`);
  }
  return { blobs, missing, end };
}

// --- Authentication ------------------------------------------------------------------------------------------------

test('state auth: a valid main-branch token of an allowed workflow passes; the JWKS is fetched once and cached', async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) assert.equal((await h.call('GET', '/v1/budget')).status, 200);
  assert.equal(h.jwksFetches, 1);
  assert.equal(h.cache.size(), 1, 'the JWKS document is kept in the Cache API');
  // A dispatched run is admitted like a scheduled one.
  assert.equal((await h.call('GET', '/v1/budget', { auth: token({ event_name: 'workflow_dispatch' }) })).status, 200);
});

test('state auth: 401 for a missing, malformed, expired, early, foreign or tampered token', async () => {
  const h = harness();
  const cases: [string, string | null][] = [
    ['missing', null],
    ['not a jwt', 'abc'],
    ['expired', token({ exp: Math.floor(T0 / 1000) - 31 })],
    ['not yet valid', token({ nbf: Math.floor(T0 / 1000) + 31 })],
    ['issued in the future', token({ iat: Math.floor(T0 / 1000) + 120 })],
    ['wrong audience (the staging token on production)', token({ aud: 'earthquakes-feed-state-staging' })],
    ['wrong issuer', token({ iss: 'https://evil.example' })],
    ['wrong repository id', token({ repository_id: '1289538520' })],
    ['signed by another key under the known kid', token({}, {}, other.privateKey)],
    ['unknown kid', token({}, { kid: 'k-unknown' })],
    ['missing kid', token({}, { kid: undefined })],
  ];
  for (const [what, auth] of cases) {
    const res = auth === null ? await h.call('GET', '/v1/budget', { auth: null }) : await h.call('GET', '/v1/budget', { auth });
    assert.equal(res.status, 401, what);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'unauthenticated', what);
    assert.ok(res.headers.get('x-request-id'), what);
  }
  // A tampered payload under a genuine signature.
  const [hd, , sig] = token().split('.');
  const forged = `${hd}.${b64url(JSON.stringify(claimsFor({ workflow: 'state-gc.yml' })))}.${sig}`;
  assert.equal((await h.call('GET', '/v1/budget', { auth: forged })).status, 401);
  // Within the 30 s skew both ways is still accepted.
  assert.equal((await h.call('GET', '/v1/budget', { auth: token({ exp: Math.floor(T0 / 1000) - 29, nbf: Math.floor(T0 / 1000) + 29 }) })).status, 200);
  // An audience given as a one-element array is the same audience.
  assert.equal((await h.call('GET', '/v1/budget', { auth: token({ aud: [AUD] }) })).status, 200);
});

test('state auth: the alg is pinned to RS256 (none and HS256 with the public key as secret are refused)', async () => {
  const h = harness();
  const p = b64url(JSON.stringify(claimsFor()));
  const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${p}.`;
  assert.equal((await h.call('GET', '/v1/budget', { auth: none })).status, 401);
  const hsHeader = b64url(JSON.stringify({ alg: 'HS256', kid: 'k1' }));
  const secret = publicKey.export({ format: 'pem', type: 'spki' });
  const hs = `${hsHeader}.${p}.${createHmac('sha256', secret).update(`${hsHeader}.${p}`).digest('base64url')}`;
  const res = await h.call('GET', '/v1/budget', { auth: hs });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthenticated', reason: 'alg not RS256' });
  const rs512 = token({}, { alg: 'RS512' });
  assert.equal((await h.call('GET', '/v1/budget', { auth: rs512 })).status, 401);
});

test('state auth: 403 for another event, ref, ref type, runner or a workflow outside the route allow-list', async () => {
  const h = harness();
  const cases: [string, Record<string, unknown>][] = [
    ['pull_request', { event_name: 'pull_request', ref: 'refs/pull/7/merge' }],
    ['push', { event_name: 'push' }],
    ['pull_request_target', { event_name: 'pull_request_target' }],
    ['another branch on production', { ref: 'refs/heads/feature' }],
    ['a tag', { ref: 'refs/tags/v1', ref_type: 'tag' }],
    ['self-hosted runner', { runner_environment: 'self-hosted' }],
    ['workflow_ref of another ref', { workflow_ref: 'TheShelterApp/earthquakes-feed/.github/workflows/aggregate.yml@refs/heads/x' }],
    ['the rehearsal on production', { workflow: 'state-rehearsal.yml' }],
    ['validate.yml', { workflow: 'validate.yml' }],
  ];
  for (const [what, c] of cases) {
    const res = await h.call('GET', '/v1/budget', { auth: token(c) });
    assert.equal(res.status, 403, what);
    assert.equal(((await res.json()) as { error: string }).error, 'forbidden', what);
  }
});

test('state auth: per-route allow-lists (read, write, gc, budget)', async () => {
  const h = harness();
  const sha = '0'.repeat(64);
  const probe = async (route: string, workflow: string): Promise<number> => {
    const auth = token({ workflow });
    if (route === 'read') {
      const res = await h.call('POST', '/v1/cas:batchGet', { auth, body: { shas: [sha] } });
      await res.arrayBuffer();
      return res.status;
    }
    if (route === 'write') return (await h.call('PUT', `/v1/cas/sha256/${sha}`, { auth, body: new Uint8Array([1]) })).status;
    if (route === 'gc') return (await h.call('POST', '/v1/gc', { auth, body: {} })).status;
    return (await h.call('GET', '/v1/budget', { auth })).status;
  };
  const workflows = ['aggregate.yml', 'derive.yml', 'first-solutions.yml', 'state-backup.yml', 'state-gc.yml', 'health.yml', 'archive.yml', 'backfill.yml', 'state-rehearsal.yml'];
  for (const route of ['read', 'write', 'gc', 'budget'] as const) {
    for (const w of workflows) {
      const status = await probe(route, w);
      if (ROUTE_WORKFLOWS[route].includes(w)) assert.notEqual(status, 403, `${route} ${w}`);
      else assert.equal(status, 403, `${route} ${w}`);
    }
  }
  assert.deepEqual(ROUTE_WORKFLOWS.write, ['aggregate.yml']);
  assert.deepEqual(ROUTE_WORKFLOWS.gc, ['state-gc.yml']);
  assert.ok(!ROUTE_WORKFLOWS.read.includes('health.yml') && ROUTE_WORKFLOWS.budget.includes('health.yml'));
});

test('state auth: staging admits any branch and the rehearsal workflow, with its own audience', async () => {
  const h = harness({ staging: true });
  const aud = 'earthquakes-feed-state-staging';
  const branch = { aud, ref: 'refs/heads/feed/state-worker', workflow: 'state-rehearsal.yml' };
  assert.equal((await h.call('GET', '/v1/budget', { auth: token(branch) })).status, 200);
  assert.equal((await h.call('POST', '/v1/gc', { auth: token(branch), body: { keep: ['1'] } })).status, 400, 'gc admitted (then refused as a bad body)');
  // The production audience is refused here.
  assert.equal((await h.call('GET', '/v1/budget', { auth: token({ ...branch, aud: AUD }) })).status, 401);
  // Still never a pull request, a tag or a self-hosted runner.
  assert.equal((await h.call('GET', '/v1/budget', { auth: token({ ...branch, event_name: 'pull_request' }) })).status, 403);
  assert.equal((await h.call('GET', '/v1/budget', { auth: token({ ...branch, ref_type: 'tag', ref: 'refs/tags/x', workflow_ref: 'o/r/.github/workflows/state-rehearsal.yml@refs/tags/x' }) })).status, 403);
  // Production refuses to start with ALLOW_ANY_REF=1.
  const bad = harness({ env: { ALLOW_ANY_REF: '1' } });
  const res = await bad.call('GET', '/v1/budget');
  assert.equal(res.status, 500);
  assert.match(((await res.json()) as { error: string }).error, /ALLOW_ANY_REF \(production\)/);
});

test('state auth: JWKS refresh after the TTL, stale-if-error, unknown kid refetched at most once a minute, 503 with no keys', async () => {
  let up = true;
  let doc: unknown = JWKS;
  const h = harness({
    jwks: async () => {
      if (!up) throw new Error('fetch failed');
      return doc;
    },
  });
  assert.equal((await h.call('GET', '/v1/budget')).status, 200);
  assert.equal(h.jwksFetches, 1);
  // An unknown kid right after a fetch: no refetch inside the minute.
  assert.equal((await h.call('GET', '/v1/budget', { auth: token({}, { kid: 'x' }) })).status, 401);
  assert.equal(h.jwksFetches, 1);
  // A minute later: one refetch, then none for a minute however many unknown kids arrive.
  h.advance(REFETCH_MIN_MS);
  for (let i = 0; i < 10; i++) assert.equal((await h.call('GET', '/v1/budget', { auth: token({}, { kid: `x${i}` }) })).status, 401);
  assert.equal(h.jwksFetches, 2);
  h.advance(REFETCH_MIN_MS);
  // GitHub rotated: the new kid appears in the JWKS and is picked up by the refetch.
  doc = { keys: [...JWKS.keys, jwkOf(other.publicKey, 'k2')] };
  assert.equal((await h.call('GET', '/v1/budget', { auth: token({}, { kid: 'k2' }, other.privateKey) })).status, 200);
  assert.equal(h.jwksFetches, 3);
  // Past the TTL with GitHub down: the stale copy still verifies (stale-if-error), and the failed fetch is not retried
  // on every request.
  up = false;
  h.advance(JWKS_TTL_MS + 1);
  const fresh = () => token({ exp: Math.floor(h.now / 1000) + 300, iat: Math.floor(h.now / 1000), nbf: Math.floor(h.now / 1000) - 600 });
  for (let i = 0; i < 3; i++) assert.equal((await h.call('GET', '/v1/budget', { auth: fresh() })).status, 200);
  assert.equal(h.jwksFetches, 4);
  // Older than the stale window and still no GitHub: no key at all is a 503 (retry), not a 401.
  h.advance(JWKS_STALE_MS);
  const res = await h.call('GET', '/v1/budget', { auth: fresh() });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '30');
  // A fresh isolate with GitHub down and nothing cached: 503.
  const cold = harness({
    jwks: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.equal((await cold.call('GET', '/v1/budget')).status, 503);
});

test('state auth: a new isolate takes the JWKS from the Cache API instead of fetching it', async () => {
  const cache = fakeCache();
  let fetches = 0;
  const mk = () =>
    createKeyStore({
      fetchJwks: async () => (fetches++, JWKS),
      cache,
      now: () => T0,
    });
  await mk().keyFor('k1', 'https://feed-state.theshelter.app/.jwks-cache/github-actions');
  await mk().keyFor('k1', 'https://feed-state.theshelter.app/.jwks-cache/github-actions');
  assert.equal(fetches, 1);
});

// --- PUT -----------------------------------------------------------------------------------------------------------

test('state PUT: stores the blob under its sha with the gzip metadata, refreshes uploaded on a re-PUT', async () => {
  const h = harness();
  const bytes = gz('2026-11-16 day');
  const sha = sha256(bytes);
  const res = await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: bytes, headers: { 'content-type': 'application/gzip' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { key: `cas/sha256/${sha.slice(0, 2)}/${sha}`, size: bytes.byteLength, uploaded: new Date(T0).toISOString() });
  const stored = h.r2.objects.get(blobKey(sha))!;
  assert.deepEqual(stored.customMetadata, { encoding: 'gzip', kind: 'event_map-day', format: '1' });
  assert.deepEqual(stored.customMetadata, BLOB_METADATA);
  assert.equal(stored.httpMetadata?.contentType, 'application/gzip');
  h.advance(DAY);
  const again = await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: bytes });
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { uploaded: string }).uploaded, new Date(T0 + DAY).toISOString());
  assert.equal(h.r2.ops.put, 2, 'always a PUT: the second refreshes uploaded so GC keeps a blob a new generation names');
});

test('state PUT: 411 without Content-Length, 413 above 25 MiB, 400 on a checksum mismatch (not retryable)', async () => {
  const h = harness();
  const bytes = gz('x');
  const sha = sha256(bytes);
  // A chunked body (no Content-Length): R2 cannot take a stream of unknown length.
  const chunked = await h.call('PUT', `/v1/cas/sha256/${sha}`, {
    body: new ReadableStream({ start: (c) => (c.enqueue(bytes), c.close()) }) as unknown as Body,
  });
  assert.equal(chunked.status, 411);
  const big = await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: bytes, headers: { 'content-length': String(25 * 1024 * 1024 + 1) } });
  assert.equal(big.status, 413);
  const wrong = await h.call('PUT', `/v1/cas/sha256/${'a'.repeat(64)}`, { body: bytes });
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: 'checksum mismatch: the body is not the blob its sha256 names', retryable: false });
  assert.equal(h.r2.objects.size, 0);
  // The refused write gave its stored bytes back (the Class A op stays counted).
  const snap = (await (await h.call('GET', '/v1/budget')).json()) as { stored_bytes: number; used: { class_a: number } };
  assert.equal(snap.stored_bytes, 0);
  assert.equal(snap.used.class_a, 1);
  // Content-Encoding would let the zone or a proxy rewrite the bytes the sha names.
  assert.equal((await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: bytes, headers: { 'content-encoding': 'gzip' } })).status, 400);
  assert.equal((await h.call('PUT', `/v1/cas/sha256/${sha.toUpperCase()}`, { body: bytes })).status, 404);
  assert.equal((await h.call('GET', `/v1/cas/sha256/${sha}`)).status, 405);
  assert.equal((await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: new Uint8Array(0) })).status, 400);
});

test('state PUT and GC: the protocol gate answers 426 below MIN_PROTOCOL; reads need no protocol header', async () => {
  const h = harness({ env: { MIN_PROTOCOL: '2' } });
  const bytes = gz('p');
  const sha = sha256(bytes);
  for (const protocol of [null, '1', 'x']) {
    const res = await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: bytes, protocol });
    assert.equal(res.status, 426, String(protocol));
    assert.equal(((await res.json()) as { min_protocol: number }).min_protocol, 2);
    assert.equal((await h.call('POST', '/v1/gc', { auth: token({ workflow: 'state-gc.yml' }), body: {}, protocol })).status, 426);
  }
  assert.equal((await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: bytes, protocol: '2' })).status, 200);
  const read = await h.call('POST', '/v1/cas:batchGet', { body: { shas: [sha] }, protocol: null });
  assert.equal(read.status, 200);
  assert.equal(parseFrames(new Uint8Array(await read.arrayBuffer())).blobs.size, 1);
  assert.equal(h.r2.ops.put, 1, 'nothing reached the bucket below the protocol');
});

// --- batchGet ------------------------------------------------------------------------------------------------------

test('state batchGet: 40 blobs in one framed stream, a missing blob is a MISSING frame, the trailer counts the frames', async () => {
  const h = harness();
  const shas = Array.from({ length: 39 }, (_, i) => h.r2.seed(gz(`day ${i} ${'x'.repeat(i * 37)}`), T0));
  const absent = sha256('never stored');
  const asked = [...shas.slice(0, 20), absent, ...shas.slice(20)];
  const res = await h.call('POST', '/v1/cas:batchGet', { body: { shas: asked } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('cache-control'), 'no-store, no-transform');
  const frames = parseFrames(new Uint8Array(await res.arrayBuffer()));
  assert.equal(frames.end, 40);
  assert.deepEqual(frames.missing, [absent]);
  assert.equal(frames.blobs.size, 39);
  for (const s of shas) assert.deepEqual(frames.blobs.get(s), h.r2.objects.get(blobKey(s))!.bytes);
  await h.settle();
  const line = JSON.parse(h.logs.at(-1)!);
  assert.equal(line.route, 'batchGet');
  assert.equal(line.n, 40);
  assert.equal(line.missing, 1);
  assert.equal(line.status, 200);
  // 40 Class B reserved.
  const snap = (await (await h.call('GET', '/v1/budget')).json()) as { used: { class_b: number } };
  assert.equal(snap.used.class_b, 40);
});

test('state batchGet: a bucket error mid-stream leaves no trailer, so the client fails closed', async () => {
  const h = harness();
  const shas = [h.r2.seed(gz('a'), T0), h.r2.seed(gz('b'), T0), h.r2.seed(gz('c'), T0)];
  h.r2.failGetAfter = 1;
  const res = await h.call('POST', '/v1/cas:batchGet', { body: { shas } });
  assert.equal(res.status, 200);
  await assert.rejects(async () => {
    const buf = new Uint8Array(await res.arrayBuffer());
    const f = parseFrames(buf);
    if (f.end === null) throw new Error('no trailer');
  });
  await h.settle();
  assert.match(JSON.parse(h.logs.at(-1)!).error, /^stream aborted/);
});

test('state batchGet: 1..40 unique lowercase shas, else 400 before any bucket or budget work', async () => {
  const h = harness();
  const s = sha256('x');
  const bad: unknown[] = [{}, { shas: [] }, { shas: Array.from({ length: 41 }, (_, i) => sha256(String(i))) }, { shas: [s, s] }, { shas: [s.toUpperCase()] }, { shas: ['abc'] }, { shas: 'x' }];
  for (const body of bad) assert.equal((await h.call('POST', '/v1/cas:batchGet', { body: body as object })).status, 400, JSON.stringify(body).slice(0, 40));
  assert.equal((await h.call('POST', '/v1/cas:batchGet', { body: 'not json' })).status, 400);
  assert.equal((await h.call('POST', '/v1/cas:batchGet', { body: 'x'.repeat(9000) })).status, 413);
  assert.equal(h.r2.ops.get, 0);
  const snap = (await (await h.call('GET', '/v1/budget')).json()) as { used: { requests: number } };
  assert.equal(snap.used.requests, 0, 'nothing reserved');
});

// --- GC ------------------------------------------------------------------------------------------------------------

const gcAuth = () => token({ workflow: 'state-gc.yml' });

test('state GC: refuses (409) unless current ⊆ keep and every current blob exists', async () => {
  const h = harness();
  const a = h.r2.seed(gz('a'), T0 - 60 * DAY);
  const b = sha256('b never stored');
  const base = { minAgeDays: 30, maxDeletes: 600, dryRun: false, cursor: null };
  const outside = await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, keep: [b], current: [a] } });
  assert.equal(outside.status, 409);
  assert.deepEqual(((await outside.json()) as { outside: string[] }).outside, [a]);
  const missing = await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, keep: [a, b], current: [a, b] } });
  assert.equal(missing.status, 409);
  assert.deepEqual(((await missing.json()) as { missing: string[] }).missing, [b]);
  assert.equal(h.r2.ops.delete, 0);
  assert.ok(h.r2.objects.has(blobKey(a)));
  // The first page must carry current (1..40); later pages must not.
  assert.equal((await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, keep: [a], current: [] } })).status, 400);
  const tooMany = Array.from({ length: 41 }, (_, i) => sha256(`c${i}`));
  assert.equal((await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, keep: tooMany, current: tooMany } })).status, 400);
  assert.equal((await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, keep: [a], current: [a], cursor: 'k' } })).status, 400);
  // minAgeDays ≥ 14, maxDeletes ≤ 1000, dryRun a boolean.
  for (const over of [{ minAgeDays: 13 }, { minAgeDays: 30.5 }, { maxDeletes: 1001 }, { maxDeletes: -1 }, { dryRun: 'no' }]) {
    assert.equal((await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, keep: [a], current: [a], ...over } })).status, 400, JSON.stringify(over));
  }
});

test('state GC: deletes only unreferenced blobs older than minAgeDays, capped at maxDeletes; never a foreign key', async () => {
  const h = harness();
  const live = h.r2.seed(gz('live'), T0 - 90 * DAY);
  const kept = h.r2.seed(gz('kept old'), T0 - 90 * DAY);
  const young = h.r2.seed(gz('young'), T0 - 29 * DAY);
  const old = [h.r2.seed(gz('old 1'), T0 - 31 * DAY), h.r2.seed(gz('old 2'), T0 - 40 * DAY), h.r2.seed(gz('old 3'), T0 - 50 * DAY)];
  h.r2.objects.set('cas/notes.txt', { bytes: new Uint8Array([1]), uploaded: new Date(T0 - 900 * DAY) });
  h.r2.objects.set(`cas/sha256/zz/${old[0]}`, { bytes: new Uint8Array([1]), uploaded: new Date(T0 - 900 * DAY) });
  const body = { keep: [live, kept], current: [live], cursor: null, minAgeDays: 30, maxDeletes: 2, dryRun: true };

  const dry = await h.call('POST', '/v1/gc', { auth: gcAuth(), body });
  assert.equal(dry.status, 200);
  const d = (await dry.json()) as Record<string, unknown>;
  assert.equal(d.deleted, 0);
  assert.equal(d.wouldDelete, 2);
  assert.equal(h.r2.objects.size, 8, 'a dry run deletes nothing');

  const res = await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...body, dryRun: false } });
  const r = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(
    { listed: r.listed, deleted: r.deleted, kept: r.kept, young: r.young, capped: r.capped, foreign: r.foreign, cursor: r.cursor, dryRun: r.dryRun },
    { listed: 8, deleted: 2, kept: 2, young: 1, capped: 1, foreign: 2, cursor: null, dryRun: false },
  );
  const left = [...h.r2.objects.keys()];
  for (const s of [live, kept, young]) assert.ok(left.includes(blobKey(s)), s);
  assert.equal(old.filter((s) => h.r2.objects.has(blobKey(s))).length, 1, 'one old blob waits for the next pass (cap)');
  assert.ok(left.includes('cas/notes.txt') && left.includes(`cas/sha256/zz/${old[0]}`), 'keys outside the CAS layout are never deleted');
  const gone = old.filter((s) => !h.r2.objects.has(blobKey(s)));
  assert.equal(r.bytesDeleted, gone.length * gz('old 1').byteLength);
  // A blob re-PUT today (uploaded refreshed) is young again, whatever the keep set says.
  const lastOld = old.find((s) => h.r2.objects.has(blobKey(s)))!;
  assert.equal((await h.call('PUT', `/v1/cas/sha256/${lastOld}`, { body: h.r2.objects.get(blobKey(lastOld))!.bytes })).status, 200);
  const again = (await (await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...body, dryRun: false } })).json()) as Record<string, unknown>;
  assert.equal(again.deleted, 0);
  assert.ok(h.r2.objects.has(blobKey(lastOld)));
  assert.equal(shaOfKey(`cas/sha256/zz/${old[0]}`), null);
});

test('state GC: pages by cursor; a later page must continue the open pass with the same keep set', async () => {
  const h = harness();
  const live = h.r2.seed(gz('live'), T0 - 90 * DAY);
  for (let i = 0; i < 2500; i++) h.r2.seed(gz(`garbage ${i}`), T0 - 60 * DAY);
  const base = { keep: [live], minAgeDays: 30, maxDeletes: 1000, dryRun: false };
  const first = (await (await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, current: [live], cursor: null } })).json()) as { cursor: string; listed: number; deleted: number };
  assert.equal(first.listed, 1000);
  assert.ok(first.cursor);
  // A cursor nobody returned, or the right cursor with another keep set: 409, nothing listed.
  const lists = h.r2.ops.list;
  assert.equal((await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, cursor: 'cas/zzz' } })).status, 409);
  assert.equal((await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, keep: [live, sha256('other')], cursor: first.cursor } })).status, 409);
  assert.equal(h.r2.ops.list, lists);
  let cursor: string | null = first.cursor;
  let pages = 1;
  let deleted = first.deleted;
  while (cursor) {
    const page = (await (await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, cursor } })).json()) as { cursor: string | null; deleted: number; listed: number };
    assert.ok(page.listed <= 1000);
    deleted += page.deleted;
    cursor = page.cursor;
    pages++;
  }
  assert.equal(pages, 3);
  assert.equal(deleted, 2500);
  assert.deepEqual([...h.r2.objects.keys()], [blobKey(live)]);
  // The completed pass re-seeded the stored estimate with what is left.
  const snap = (await (await h.call('GET', '/v1/budget')).json()) as { stored_bytes: number; stored_seeded_at: string; gc_pass_open: boolean };
  assert.equal(snap.stored_bytes, gz('live').byteLength);
  assert.equal(snap.stored_seeded_at, new Date(T0).toISOString());
  assert.equal(snap.gc_pass_open, false);
  // The finished pass's cursor cannot be replayed.
  assert.equal((await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { ...base, cursor: first.cursor } })).status, 409);
});

// --- Budget --------------------------------------------------------------------------------------------------------

test('state budget: each ceiling refuses with 429 {"error":"budget"} before the bucket is touched', async () => {
  const tight = { CLASS_A_PER_DAY: '2', CLASS_B_PER_DAY: '45', BYTES_WRITTEN_PER_DAY: '1000000', STORED_BYTES_MAX: '1000000' };
  const h = harness({ env: tight });
  const blob = (s: string) => {
    const b = gz(s);
    return { b, sha: sha256(b) };
  };
  // Class B: 40 + 5 fit, one more does not.
  const s40 = Array.from({ length: 40 }, (_, i) => sha256(`b${i}`));
  for (const shas of [s40, s40.slice(0, 5)]) {
    const res = await h.call('POST', '/v1/cas:batchGet', { body: { shas } });
    assert.equal(res.status, 200);
    assert.equal(parseFrames(new Uint8Array(await res.arrayBuffer())).missing.length, shas.length);
  }
  const gets = h.r2.ops.get;
  const refused = await h.call('POST', '/v1/cas:batchGet', { body: { shas: s40.slice(0, 1) } });
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: 'budget', ceiling: 'class_b' });
  await h.settle();
  assert.equal(h.r2.ops.get, gets);
  // Class A: two PUTs, the third is refused.
  for (const s of ['p1', 'p2']) {
    const { b, sha } = blob(s);
    assert.equal((await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: b })).status, 200);
  }
  const { b: b3, sha: s3 } = blob('p3');
  const third = await h.call('PUT', `/v1/cas/sha256/${s3}`, { body: b3 });
  assert.equal(third.status, 429);
  assert.deepEqual(await third.json(), { error: 'budget', ceiling: 'class_a' });
  assert.equal(h.r2.ops.put, 2);
  // A new UTC day starts from zero.
  h.advance(DAY);
  assert.equal((await h.call('PUT', `/v1/cas/sha256/${s3}`, { body: b3 })).status, 200);
  const snap = (await (await h.call('GET', '/v1/budget')).json()) as Record<string, unknown>;
  assert.deepEqual(snap, {
    day: '2026-11-17',
    used: { class_a: 1, class_b: 0, bytes_written: b3.byteLength, requests: 1, refused: 0 },
    stored_bytes: 3 * b3.byteLength,
    stored_seeded_at: null,
    gc_pass_open: false,
    ceilings: { class_a: 2, class_b: 45, bytes_written: 1000000, stored_bytes: 1000000 },
  });
});

test('state budget: bytes written per day and the stored estimate refuse a PUT', async () => {
  const h = harness({ env: { BYTES_WRITTEN_PER_DAY: '100', STORED_BYTES_MAX: '150' } });
  const b = new Uint8Array(60).fill(7);
  const sha = sha256(b);
  assert.equal((await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: b })).status, 200);
  const over = await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: b });
  assert.deepEqual(await over.json(), { error: 'budget', ceiling: 'bytes_written' });
  h.advance(DAY);
  assert.equal((await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: b })).status, 200);
  h.advance(DAY);
  // 120 stored (the estimate counts the overwrite again: it errs high), 60 more would pass 150.
  const full = await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: b });
  assert.deepEqual(await full.json(), { error: 'budget', ceiling: 'stored_bytes' });
  // A GC pass re-seeds it from the listing: one 60-byte blob.
  const gc = await h.call('POST', '/v1/gc', { auth: gcAuth(), body: { keep: [sha], current: [sha], cursor: null, minAgeDays: 30, maxDeletes: 10, dryRun: true } });
  assert.equal(gc.status, 200);
  assert.equal((await h.call('PUT', `/v1/cas/sha256/${sha}`, { body: b })).status, 200);
});

test('state budget: an unreachable ledger is a 503, never an unmetered bucket call', async () => {
  const h = harness({ budgetDown: true });
  const res = await h.call('POST', '/v1/cas:batchGet', { body: { shas: [sha256('x')] } });
  assert.equal(res.status, 503);
  assert.equal(h.r2.ops.get, 0);
  assert.equal(h.budget.names.length, 1);
});

test('state budget ledger: day rows older than KEEP_DAYS are pruned; GC passes re-seed the estimate', () => {
  const sql = sqliteSql();
  const ceilings = { CLASS_A_PER_DAY: 10, CLASS_B_PER_DAY: 10, BYTES_WRITTEN_PER_DAY: 1e9, STORED_BYTES_MAX: 1e9 };
  for (let d = 0; d < 60; d++) assert.deepEqual(reserve(sql, { nowMs: T0 + d * DAY, cost: { classA: 1 }, ceilings }), { ok: true });
  const days = sql.exec('SELECT day FROM days ORDER BY day').toArray() as { day: string }[];
  assert.equal(days.length, KEEP_DAYS + 1);
  assert.equal(days[0]!.day, new Date(T0 + (59 - KEEP_DAYS) * DAY).toISOString().slice(0, 10));
  // PUTs during a pass are added on top of what the pass listed.
  assert.deepEqual(gcBegin(sql, { nowMs: T0, cursor: null, keepHash: 'h', cost: { classA: 1 }, ceilings }), { ok: true });
  gcEnd(sql, { nowMs: T0, cursor: null, nextCursor: 'c1', keepHash: 'h', keptBytes: 500, deletedBytes: 100 });
  reserve(sql, { nowMs: T0, cost: { classA: 1, bytes: 7 }, ceilings });
  assert.deepEqual(gcBegin(sql, { nowMs: T0, cursor: 'c1', keepHash: 'other', cost: { classA: 1 }, ceilings }), { ok: false, pass: true });
  assert.deepEqual(gcBegin(sql, { nowMs: T0, cursor: 'c1', keepHash: 'h', cost: { classA: 1 }, ceilings }), { ok: true });
  gcEnd(sql, { nowMs: T0, cursor: 'c1', nextCursor: null, keepHash: 'h', keptBytes: 300, deletedBytes: 0 });
  assert.equal(snapshot(sql, { nowMs: T0, ceilings }).stored_bytes, 807);
  refundStored(sql, 10_000);
  assert.equal(snapshot(sql, { nowMs: T0, ceilings }).stored_bytes, 0, 'never below zero');
});

// --- Logging, routing, configuration --------------------------------------------------------------------------------

test('state log: one JSON line per request with route, workflow, run, status and ms; never the token', async () => {
  const h = harness();
  const auth = token({ workflow: 'derive.yml', run_id: '99', run_attempt: '2' });
  const res = await h.call('GET', '/v1/budget', { auth, headers: { 'cf-ray': '8f00aa-AMS' } });
  assert.equal(res.headers.get('x-request-id'), '8f00aa-AMS');
  await h.call('GET', '/v1/budget', { auth: 'x.y.z' });
  await h.call('GET', '/nope', { auth });
  assert.equal(h.logs.length, 3);
  const [ok, denied, unknown] = h.logs.map((l) => JSON.parse(l));
  assert.deepEqual(
    { t: ok.t, rid: ok.rid, route: ok.route, workflow: ok.workflow, run_id: ok.run_id, run_attempt: ok.run_attempt, status: ok.status },
    { t: 'feed-state', rid: '8f00aa-AMS', route: 'budget', workflow: 'derive.yml', run_id: '99', run_attempt: '2', status: 200 },
  );
  assert.equal(typeof ok.ms, 'number');
  assert.equal(denied.status, 401);
  assert.equal(unknown.status, 404);
  for (const l of h.logs) assert.ok(!l.includes(auth.split('.')[2]!) && !l.includes(auth.split('.')[1]!), 'no token in the log');
});

test('state config: a missing or malformed var answers 500 for every request', async () => {
  for (const env of [{ REPOSITORY_ID: '' }, { CLASS_B_PER_DAY: 'lots' }, { MIN_PROTOCOL: '0' }, { ENVIRONMENT: 'prod' }]) {
    const h = harness({ env });
    assert.equal((await h.call('GET', '/v1/budget')).status, 500, JSON.stringify(env));
  }
});

// --- wrangler.toml and deploy.sh -----------------------------------------------------------------------------------

test('state wrangler.toml: production and staging, custom domains only, R2 + SQLite budget ledger, the vars', () => {
  const toml = readFileSync(here('../state/wrangler.toml'), 'utf8');
  const [top, staging] = toml.split('\n[env.staging]\n');
  assert.ok(top && staging);
  assert.match(top, /^name = "earthquakes-feed-state"$/m);
  assert.match(top, /^main = "src\/index\.js"$/m);
  const date = /^compatibility_date = "(\d{4}-\d{2}-\d{2})"$/m.exec(top)?.[1];
  assert.ok(date && date >= '2026-10-17', String(date));
  for (const part of [top, staging]) {
    assert.match(part, /^workers_dev = false$/m);
    assert.match(part, /^preview_urls = false$/m);
  }
  assert.match(top, /^routes = \[\{ pattern = "feed-state\.theshelter\.app", custom_domain = true \}\]$/m);
  assert.match(staging, /^name = "earthquakes-feed-state-staging"$/m);
  assert.match(staging, /^routes = \[\{ pattern = "feed-state-staging\.theshelter\.app", custom_domain = true \}\]$/m);
  assert.match(top, /\[\[r2_buckets\]\]\nbinding = "STATE"\nbucket_name = "earthquakes-feed-state"\n/);
  assert.match(staging, /\[\[env\.staging\.r2_buckets\]\]\nbinding = "STATE"\nbucket_name = "earthquakes-feed-state-staging"\n/);
  assert.match(top, /\[\[durable_objects\.bindings\]\]\nname = "BUDGET"\nclass_name = "BudgetLedger"/);
  assert.match(top, /\[\[migrations\]\]\ntag = "v1"\nnew_sqlite_classes = \["BudgetLedger"\]/);
  assert.match(staging, /\[\[env\.staging\.durable_objects\.bindings\]\]\nname = "BUDGET"\nclass_name = "BudgetLedger"/);
  const vars = (part: string): Record<string, string> =>
    Object.fromEntries([...part.matchAll(/^([A-Z_]+) = "([^"]*)"$/gm)].map((m) => [m[1]!, m[2]!]));
  const p = vars(top);
  const s = vars(staging);
  assert.deepEqual(
    { ENVIRONMENT: p.ENVIRONMENT, REPOSITORY_ID: p.REPOSITORY_ID, AUDIENCE: p.AUDIENCE, ALLOW_ANY_REF: p.ALLOW_ANY_REF, MIN_PROTOCOL: p.MIN_PROTOCOL },
    { ENVIRONMENT: 'production', REPOSITORY_ID: '1289538519', AUDIENCE: 'earthquakes-feed-state', ALLOW_ANY_REF: '0', MIN_PROTOCOL: '1' },
  );
  assert.deepEqual(
    { ENVIRONMENT: s.ENVIRONMENT, REPOSITORY_ID: s.REPOSITORY_ID, AUDIENCE: s.AUDIENCE, ALLOW_ANY_REF: s.ALLOW_ANY_REF },
    { ENVIRONMENT: 'staging', REPOSITORY_ID: '1289538519', AUDIENCE: 'earthquakes-feed-state-staging', ALLOW_ANY_REF: '1' },
  );
  // Never pay: the R2 free tier is per account, so production's and staging's ceilings together stay inside it.
  const n = (v: string | undefined) => Number(v);
  assert.deepEqual([p.CLASS_A_PER_DAY, p.CLASS_B_PER_DAY, p.BYTES_WRITTEN_PER_DAY, p.STORED_BYTES_MAX], ['20000', '200000', '1073741824', '6442450944']);
  assert.ok((n(p.CLASS_A_PER_DAY) + n(s.CLASS_A_PER_DAY)) * 31 < 1_000_000);
  assert.ok((n(p.CLASS_B_PER_DAY) + n(s.CLASS_B_PER_DAY)) * 31 < 10_000_000);
  assert.ok(n(p.STORED_BYTES_MAX) + n(s.STORED_BYTES_MAX) + 0.5e9 < 10e9);
});

/** A repository with state/deploy.sh, a bare origin and a fake wrangler that records its arguments. */
function deployRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'state-deploy-'));
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    FAKE_WRANGLER_LOG: join(dir, 'wrangler.log'),
  };
  delete e.FEED_STATE_CF_EMAIL;
  writeFileSync(join(dir, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', work);
  mkdirSync(join(work, 'state'));
  copyFileSync(here('../state/deploy.sh'), join(work, 'state/deploy.sh'));
  copyFileSync(here('../state/wrangler.toml'), join(work, 'state/wrangler.toml'));
  writeFileSync(join(work, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(work, 'node_modules/.bin'), { recursive: true });
  const fake = join(work, 'node_modules/.bin/wrangler');
  writeFileSync(
    fake,
    '#!/usr/bin/env bash\nprintf \'%s|\' "$@" >> "$FAKE_WRANGLER_LOG"; echo >> "$FAKE_WRANGLER_LOG"\n' +
      'if [ "$1" = whoami ]; then echo "You are logged in with an OAuth Token, associated with the email owner@example.com."; fi\n',
  );
  chmodSync(fake, 0o755);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'seed');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync('bash', ['state/deploy.sh', ...args], { cwd: work, env: { ...e, ...extra }, encoding: 'utf8' });
    return { status: r.status, err: r.stderr, out: r.stdout };
  };
  const calls = (): string[] => {
    try {
      return readFileSync(e.FAKE_WRANGLER_LOG!, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return { work, git, run, calls };
}

test('state deploy.sh: deploys only from a clean main at origin/main, as the expected account, tagged with the commit', () => {
  const r = deployRepo();
  const email = { FEED_STATE_CF_EMAIL: 'owner@example.com' };
  const sha = r.git(r.work, 'rev-parse', '--short=10', 'HEAD').trim();

  // No account given, or another account logged in: refused before any deploy.
  let res = r.run([]);
  assert.notEqual(res.status, 0);
  assert.match(res.err, /set FEED_STATE_CF_EMAIL/);
  res = r.run([], { FEED_STATE_CF_EMAIL: 'someone@else.example' });
  assert.notEqual(res.status, 0);
  assert.match(res.err, /not logged in as someone@else\.example/);
  assert.ok(!r.calls().some((c) => c.startsWith('deploy|')));

  // Production (the top level, selected with --env "") and staging.
  res = r.run([], email);
  assert.equal(res.status, 0, res.err);
  assert.equal(r.calls().at(-1), `deploy|-c|wrangler.toml|--env||--message|main ${sha}|`);
  res = r.run(['--env', 'staging'], email);
  assert.equal(res.status, 0, res.err);
  assert.equal(r.calls().at(-1), `deploy|-c|wrangler.toml|--env|staging|--message|main ${sha}|`);
  res = r.run(['--env=staging', '--dry-run']);
  assert.equal(res.status, 0, res.err);
  assert.equal(r.calls().at(-1), 'deploy|-c|wrangler.toml|--env|staging|--dry-run|');
  assert.notEqual(r.run(['--env', 'prod'], email).status, 0);

  // A dirty tree (a change, or an untracked file anywhere), a commit ahead of origin/main, another branch: refused.
  const before = r.calls().length;
  writeFileSync(join(r.work, 'stray.txt'), 'x');
  res = r.run([], email);
  assert.match(res.err, /working tree is not clean/);
  r.git(r.work, 'add', 'stray.txt');
  r.git(r.work, 'commit', '-q', '-m', 'local');
  res = r.run([], email);
  assert.match(res.err, /is not origin\/main/);
  r.git(r.work, 'checkout', '-q', '-b', 'feature');
  res = r.run(['--dry-run'], email);
  assert.match(res.err, /on feature, not main/);
  r.git(r.work, 'checkout', '-q', '--detach');
  res = r.run([], email);
  assert.match(res.err, /on a detached HEAD, not main/);
  assert.equal(r.calls().length, before, 'wrangler never ran');
});
