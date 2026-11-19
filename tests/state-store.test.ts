import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  BATCH_ATTEMPTS,
  BATCH_CONCURRENCY,
  BATCH_MAX,
  BATCH_MAX_BYTES,
  BATCH_TIMEOUT_BASE_MS,
  FsBackend,
  KEYS_UNAVAILABLE_WAIT_MS,
  STATE_USER_AGENT,
  StateStoreError,
  WorkerBackend,
  backendFromEnv,
  batchTimeoutMs,
  casKey,
  frameBatch,
  getBlobs,
  githubOidcTokenSource,
  jwtExpiryMs,
  parseBatchFrames,
  parseBudget,
  parseGcPage,
  planBatches,
  retryAfterMs,
  sha256Hex,
  sleepUnlessAborted,
  type GcRequest,
} from '../src/state-store.js';
import { SHADOW_RETRY_POLICY, SHADOW_STEP_DEADLINE_MS } from '../src/event-map-store.js';

// The state store client (src/state-store.ts) against a local fake of the state Worker that implements its HTTP
// contract (routes, headers, statuses, the batchGet framing), and the directory backend. No network beyond 127.0.0.1.

const blob = (s: string): { hex: string; bytes: Buffer } => {
  const bytes = gzipSync(s, { level: 9 });
  return { hex: sha256Hex(bytes), bytes };
};
const jwt = (expSec: number): string =>
  `${Buffer.from('{"alg":"RS256","kid":"k"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.sig`;

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/** GET /v1/budget as state/src/budget.js snapshot() answers it. */
const BUDGET = {
  day: '2026-11-16',
  used: { class_a: 10, class_b: 300, bytes_written: 4_000_000, requests: 320, refused: 0 },
  stored_bytes: 2_000_000_000,
  stored_seeded_at: '2026-11-16T03:00:00.000Z',
  gc_pass_open: false,
  ceilings: { class_a: 20_000, class_b: 200_000, bytes_written: 1_073_741_824, stored_bytes: 6_442_450_944 },
};
const DAY_MS = 86_400_000;

/** A fake state Worker: R2 as a Map, every route of the contract (GC with the Worker's checks and answer,
 *  state/src/worker.js and cas.js), and hooks to break it on purpose. */
function fakeWorker(hooks: { before?: (req: Seen, res: ServerResponse) => boolean; frame?: (shas: string[], store: Map<string, Buffer>) => Buffer } = {}) {
  const store = new Map<string, Buffer>();
  const uploaded = new Map<string, number>();
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(s);
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `r${seen.length}` });
        res.end(JSON.stringify(body));
      };
      if (hooks.before?.(s, res)) return;
      if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(String(req.headers.authorization ?? ''))) return json(401, { error: 'unauthenticated' });
      if (req.headers['x-feed-state-protocol'] !== '1') return json(426, { error: 'protocol' });
      const put = /^\/v1\/cas\/sha256\/([0-9a-f]{64})$/.exec(req.url!);
      if (req.method === 'PUT' && put) {
        if (req.headers['content-length'] == null) return json(411, { error: 'length required' });
        if (Number(req.headers['content-length']) > 25 * 1024 * 1024) return json(413, { error: 'too large' });
        if (sha256Hex(s.body) !== put[1]) return json(400, { error: 'checksum mismatch: the body is not the blob its sha256 names', retryable: false });
        store.set(put[1]!, s.body);
        uploaded.set(put[1]!, Date.now());
        return json(200, { key: casKey(put[1]!), size: s.body.length, uploaded: new Date().toISOString() });
      }
      if (req.method === 'POST' && req.url === '/v1/cas:batchGet') {
        const { shas } = JSON.parse(s.body.toString('utf8')) as { shas: string[] };
        if (!Array.isArray(shas) || shas.length < 1 || shas.length > 40 || new Set(shas).size !== shas.length) return json(400, { error: 'shas' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(hooks.frame ? hooks.frame(shas, store) : frameBatch(shas.map((h) => [h, store.get(h) ?? null])));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/gc') {
        const r = JSON.parse(s.body.toString('utf8')) as GcRequest;
        if (!Array.isArray(r.keep) || r.keep.length < 1 || r.keep.length > 10_000) return json(400, { error: 'keep must hold 1..10000 shas' });
        if (r.cursor === null && (!Array.isArray(r.current) || r.current.length < 1 || r.current.length > 40)) return json(400, { error: 'current must hold 1..40 shas' });
        if (r.current.some((c) => !r.keep.includes(c) || !store.has(c))) return json(409, { error: 'current not kept or missing' });
        const cutoff = Date.now() - r.minAgeDays * DAY_MS;
        let kept = 0;
        let young = 0;
        let capped = 0;
        const doomed: string[] = [];
        let bytes = 0;
        for (const k of [...store.keys()].sort()) {
          if (r.keep.includes(k)) kept++;
          else if (!(uploaded.get(k)! < cutoff)) young++;
          else if (doomed.length >= r.maxDeletes) capped++;
          else (doomed.push(k), (bytes += store.get(k)!.length));
        }
        const listed = store.size;
        if (!r.dryRun) for (const k of doomed) store.delete(k);
        return json(200, {
          listed,
          deleted: r.dryRun ? 0 : doomed.length,
          wouldDelete: doomed.length,
          bytesDeleted: r.dryRun ? 0 : bytes,
          bytesWouldDelete: bytes,
          kept,
          young,
          capped,
          foreign: 0,
          cursor: null,
          dryRun: r.dryRun,
        });
      }
      if (req.method === 'GET' && req.url === '/v1/budget') return json(200, BUDGET);
      json(404, { error: 'no route' });
    });
  });
  return {
    store,
    uploaded,
    seen,
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))),
    // closeAllConnections: a connection a test left hanging (a hung answer the client gave up on) ends now, not after
    // the server's keep-alive timeout.
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const quick = { sleep: async () => {}, random: () => 0, token: async () => jwt(Math.floor(Date.now() / 1000) + 300) };

test('state client: PUT then batchGet round trip; every request carries the token, the protocol and the user agent', async () => {
  const w = fakeWorker();
  const base = await w.start();
  try {
    const be = new WorkerBackend({ baseUrl: base, ...quick });
    const a = blob('{"feedId":"efd_a"}\n');
    const b = blob('{"feedId":"efd_b"}\n');
    const put = await be.put(a.hex, a.bytes);
    assert.deepEqual([put.key, put.size], [casKey(a.hex), a.bytes.length]);
    await be.put(b.hex, b.bytes);
    const got = await be.batchGet([a.hex, b.hex]);
    assert.ok(got.get(a.hex)!.equals(a.bytes) && got.get(b.hex)!.equals(b.bytes));
    for (const s of w.seen) {
      assert.match(String(s.headers.authorization), /^Bearer /);
      assert.equal(s.headers['user-agent'], STATE_USER_AGENT);
      assert.equal(s.headers['x-feed-state-protocol'], '1');
    }
    const p = w.seen.find((s) => s.method === 'PUT')!;
    assert.equal(p.url, `/v1/cas/sha256/${a.hex}`);
    assert.equal(p.headers['content-type'], 'application/gzip');
    assert.equal(p.headers['content-length'], String(a.bytes.length), 'a buffered body: fetch sends Content-Length');
    assert.equal(p.headers['transfer-encoding'], undefined);
    const g = w.seen.find((s) => s.url === '/v1/cas:batchGet')!;
    assert.deepEqual(JSON.parse(g.body.toString('utf8')), { shas: [a.hex, b.hex] });
    assert.deepEqual(await be.budget(), BUDGET);
  } finally {
    await w.stop();
  }
});

test('state client: a MISSING blob fails closed; getBlobs batches at most 40 blobs and at most 2.5 MB at a time', async () => {
  const w = fakeWorker();
  const base = await w.start();
  try {
    const be = new WorkerBackend({ baseUrl: base, ...quick });
    const blobs = Array.from({ length: BATCH_MAX + 5 }, (_, i) => blob(`{"feedId":"efd_${i}"}\n`));
    for (const x of blobs) await be.put(x.hex, x.bytes);
    const gets = (): number[] =>
      w.seen
        .filter((s) => s.url === '/v1/cas:batchGet')
        .map((s) => (JSON.parse(s.body.toString('utf8')) as { shas: string[] }).shas.length)
        .sort((a, b) => b - a);
    // Sizes known (tiny blobs): the count limit rules.
    const all = await getBlobs(be, blobs.map((x) => x.hex), { sizes: new Map(blobs.map((x) => [x.hex, x.bytes.length])) });
    assert.equal(all.size, blobs.length);
    assert.deepEqual(gets(), [BATCH_MAX, 5]);
    // Sizes unknown: each blob counts as a day blob (BLOB_BYTES_ESTIMATE), 8 to a 2.5 MB batch.
    w.seen.length = 0;
    assert.equal((await getBlobs(be, blobs.map((x) => x.hex))).size, blobs.length);
    assert.deepEqual(gets(), [8, 8, 8, 8, 8, 5]);
    const absent = blob('never stored');
    await assert.rejects(be.batchGet([blobs[0]!.hex, absent.hex]), (e: unknown) => e instanceof StateStoreError && e.kind === 'missing' && e.message.includes(absent.hex));
    await assert.rejects(be.batchGet([]), /1 to 40/);
    await assert.rejects(be.batchGet(Array.from({ length: 41 }, (_, i) => blobs[i % blobs.length]!.hex)), /1 to 40|duplicate/);
  } finally {
    await w.stop();
  }
});

test('state client: the framing is checked to the byte (trailer, lengths, sha256, nothing unrequested)', () => {
  const a = blob('a');
  const b = blob('b');
  const ok = frameBatch([[a.hex, a.bytes], [b.hex, b.bytes]]);
  assert.equal(parseBatchFrames(ok, [a.hex, b.hex]).size, 2);
  const kind = (body: Buffer, shas = [a.hex, b.hex]): string => {
    try {
      parseBatchFrames(body, shas);
      return 'ok';
    } catch (e) {
      return (e as StateStoreError).kind;
    }
  };
  assert.equal(kind(ok.subarray(0, ok.length - 6)), 'transport', 'no trailer: cut short');
  assert.equal(kind(ok.subarray(0, 30)), 'transport', 'cut inside a blob');
  assert.equal(kind(Buffer.concat([ok, Buffer.from('x')])), 'integrity', 'bytes after the trailer');
  assert.equal(kind(Buffer.from(ok.toString('latin1').replace('END 2', 'END 3'), 'latin1')), 'integrity', 'a wrong count');
  const flipped = Buffer.from(ok);
  flipped[ok.indexOf(0x0a) + 3] ^= 0xff;
  assert.equal(kind(flipped), 'integrity', 'bytes that do not hash to their sha');
  assert.equal(kind(frameBatch([[a.hex, a.bytes]])), 'integrity', 'a requested blob not in the answer');
  assert.equal(kind(frameBatch([[a.hex, a.bytes], [b.hex, b.bytes]]), [a.hex]), 'integrity', 'an unrequested blob');
  assert.equal(kind(frameBatch([[a.hex, a.bytes], [b.hex, null]])), 'missing');
  assert.equal(kind(Buffer.from(`BLOB ${a.hex} 1x\n`)), 'integrity');
  assert.equal(kind(Buffer.from('HELLO\n')), 'integrity');
});

test('state client: 5xx, a non-budget 429 and a cut stream are retried (at most 4 attempts); 4xx, the budget and a 500 misconfigured never; only a checksum 400 is integrity', async () => {
  let failures = 0;
  const w = fakeWorker({
    before: (s, res) => {
      if (s.url.startsWith('/v1/cas/sha256/') && failures < 2) {
        failures++;
        res.writeHead(failures === 1 ? 503 : 429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: failures === 1 ? 'store write failed' : 'slow down' }));
        return true;
      }
      return false;
    },
  });
  const base = await w.start();
  try {
    const sleeps: number[] = [];
    const be = new WorkerBackend({ baseUrl: base, ...quick, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
    const a = blob('retried');
    await be.put(a.hex, a.bytes);
    assert.equal(w.seen.filter((s) => s.method === 'PUT').length, 3);
    assert.deepEqual(sleeps, [750, 1500], 'jittered backoff');
  } finally {
    await w.stop();
  }
  const status = (code: number, error: string) =>
    fakeWorker({
      before: (_s, res) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error }));
        return true;
      },
    });
  for (const [code, error, kind] of [
    [401, 'unauthenticated', 'auth'],
    [403, 'forbidden', 'forbidden'],
    [411, 'length required', 'client'],
    [413, 'too large', 'client'],
    [426, 'protocol', 'protocol'],
    [429, 'budget', 'budget'],
    [409, 'refused', 'refused'],
    [400, 'checksum mismatch: the body is not the blob its sha256 names', 'integrity'],
    [400, 'empty body', 'client'],
    [400, 'body is not a JSON object', 'client'],
    [500, 'misconfigured: REPOSITORY_ID', 'config'],
  ] as const) {
    const f = status(code, error);
    const b = await f.start();
    try {
      const be = new WorkerBackend({ baseUrl: b, ...quick });
      const a = blob(`x${code}`);
      await assert.rejects(be.put(a.hex, a.bytes), (e: unknown) => e instanceof StateStoreError && e.kind === kind && e.status === code, `${code}`);
      assert.equal(f.seen.length, 1, `${code}: never retried`);
    } finally {
      await f.stop();
    }
  }
  const down = status(502, 'bad gateway');
  const b = await down.start();
  try {
    const be = new WorkerBackend({ baseUrl: b, ...quick });
    const a = blob('down');
    await assert.rejects(be.put(a.hex, a.bytes), (e: unknown) => e instanceof StateStoreError && e.kind === 'transport' && /after 4 attempts/.test(e.message));
    assert.equal(down.seen.length, 4);
  } finally {
    await down.stop();
  }
  // A batchGet answer cut short inside a blob is asked again; the second answer is whole. One that delivered every blob
  // whole and lost only its trailer is complete: each blob is proven by its sha256 and none was left out.
  let cut = 0;
  let cutAt = 60;
  const flaky = fakeWorker({
    frame: (shas, store) => {
      const full = frameBatch(shas.map((h) => [h, store.get(h) ?? null]));
      return cut++ === 0 ? full.subarray(0, cutAt < 0 ? full.length + cutAt : cutAt) : full;
    },
  });
  const fb = await flaky.start();
  try {
    const be = new WorkerBackend({ baseUrl: fb, ...quick });
    const a = blob('cut');
    await be.put(a.hex, a.bytes);
    assert.equal((await be.batchGet([a.hex])).size, 1);
    assert.equal(flaky.seen.filter((s) => s.url === '/v1/cas:batchGet').length, 2);
    cut = 0;
    cutAt = -4;
    assert.equal((await be.batchGet([a.hex])).size, 1);
    assert.equal(flaky.seen.filter((s) => s.url === '/v1/cas:batchGet').length, 3, 'only the trailer cut: no second request');
  } finally {
    await flaky.stop();
  }
});

test('state client: a request that hangs times out and is retried', async () => {
  let hung = 0;
  const w = fakeWorker({ before: (s) => s.method === 'GET' && hung++ === 0 });
  const base = await w.start();
  try {
    const be = new WorkerBackend({ baseUrl: base, ...quick, timeoutMs: 100 });
    assert.ok(await be.budget());
    assert.equal(hung, 2);
  } finally {
    await w.stop();
  }
});

test('state client: a step deadline bounds every request and the token requests, however many attempts are left (phase 3a)', async () => {
  // A store that never answers: each attempt hangs until its abort.
  const hang = (async (_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
  const t0 = Date.now();
  const be = new WorkerBackend({ baseUrl: 'https://feed-state.example', fetchImpl: hang, token: quick.token, random: () => 0, attempts: 4, timeoutMs: 20_000, deadlineMs: t0 + 150 });
  await assert.rejects(be.budget(), (e: unknown) => e instanceof StateStoreError && e.kind === 'transport' && e.retryable && /deadline/.test(e.message));
  const took = Date.now() - t0;
  assert.ok(took < 2_000, `stopped at the deadline, not after 4 × 20 s (${took} ms)`);
  // A deadline already passed: no attempt at all.
  await assert.rejects(new WorkerBackend({ baseUrl: 'https://feed-state.example', fetchImpl: hang, token: quick.token, deadlineMs: Date.now() - 1 }).budget(), /after 0 attempts: the step's deadline passed/);
  // The OIDC token request under the same deadline.
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/req', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' };
  const t1 = Date.now();
  await assert.rejects(githubOidcTokenSource('a', { env, fetchImpl: hang, sleep: async () => {}, policy: { attempts: 4, timeoutMs: 20_000, deadlineMs: t1 + 150 } })(), /timed out after .*deadline/);
  assert.ok(Date.now() - t1 < 2_000);
  // backendFromEnv passes the policy to both.
  const fromEnv = backendFromEnv({ FEED_STATE_BACKEND: 'worker', ...env }, { fetchImpl: hang, log: () => {}, policy: { attempts: 2, timeoutMs: 20_000, deadlineMs: Date.now() + 150 } })!;
  const t2 = Date.now();
  await assert.rejects(fromEnv.budget(), /deadline/);
  assert.ok(Date.now() - t2 < 2_000);
});

test('state client: the OIDC token is minted for the audience, reused while it has more than 60 s left, never sent elsewhere', async () => {
  let minted = 0;
  let now = 1_800_000_000_000;
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seen.push(String(url));
    assert.equal((init?.headers as Record<string, string>).authorization, 'bearer request-token');
    minted++;
    return new Response(JSON.stringify({ value: jwt(Math.floor(now / 1000) + 300) }), { status: 200 });
  }) as typeof fetch;
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/req?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' };
  const source = githubOidcTokenSource('earthquakes-feed-state', { env, fetchImpl, now: () => now, sleep: async () => {} });
  const t1 = await source();
  assert.equal(jwtExpiryMs(t1), Math.floor(now / 1000) * 1000 + 300_000);
  now += 200_000;
  assert.equal(await source(), t1, '100 s left: reused');
  now += 50_000;
  assert.notEqual(await source(), undefined);
  assert.equal(minted, 2, '50 s left: a fresh token');
  assert.equal(seen[0], 'https://token.example/req?api-version=2.0&audience=earthquakes-feed-state');
  await assert.rejects(githubOidcTokenSource('a', { env: {} })(), /id-token: write/);
});

test('state client: FEED_STATE_BACKEND selects the backend; the Worker URL must be https', () => {
  assert.equal(backendFromEnv({}), null);
  assert.equal(backendFromEnv({ FEED_STATE_BACKEND: ' ' }), null);
  assert.match(backendFromEnv({ FEED_STATE_BACKEND: 'worker' })!.label, /feed-state\.theshelter\.app/);
  assert.match(backendFromEnv({ FEED_STATE_BACKEND: 'worker', FEED_STATE_URL: 'https://feed-state-staging.theshelter.app' })!.label, /staging/);
  assert.match(backendFromEnv({ FEED_STATE_BACKEND: 'fs:/tmp/x' })!.label, /directory \/tmp\/x/);
  assert.throws(() => backendFromEnv({ FEED_STATE_BACKEND: 's3' }), /worker, fs:<dir> or unset/);
  assert.throws(() => backendFromEnv({ FEED_STATE_BACKEND: 'worker', FEED_STATE_URL: 'http://feed-state.theshelter.app' }), /https only/);
});

test('directory backend: the Worker\'s checks and GC rules (keep, current, age, cap) and its answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-fs-'));
  try {
    let now = Date.parse('2026-11-16T00:00:00Z');
    const be = new FsBackend(dir, () => now);
    const blobs = Array.from({ length: 5 }, (_, i) => blob(`day ${i}`));
    for (const x of blobs) await be.put(x.hex, x.bytes);
    await assert.rejects(be.put(blobs[0]!.hex, blobs[1]!.bytes), (e: unknown) => e instanceof StateStoreError && e.status === 400 && e.kind === 'integrity');
    // Age: three blobs uploaded 40 days ago, two now.
    const old = (Date.parse('2026-10-07T00:00:00Z')) / 1000;
    for (const x of blobs.slice(0, 3)) utimesSync(join(dir, ...casKey(x.hex).split('/')), old, old);
    const keep = [blobs[0]!.hex, blobs[4]!.hex];
    const req = { keep, current: [blobs[0]!.hex], cursor: null, minAgeDays: 30, maxDeletes: 10, dryRun: true };
    await assert.rejects(be.gc({ ...req, current: [blobs[1]!.hex] }), (e: unknown) => e instanceof StateStoreError && e.kind === 'refused' && /not in keep/.test(e.message));
    const missing = blob('gone');
    await assert.rejects(be.gc({ ...req, keep: [...keep, missing.hex], current: [missing.hex] }), /missing/);
    // The Worker's limits (400): keep 1..10,000, current 1..40 on the first page and none later, minAgeDays ≥ 14.
    const client400 = (e: unknown): boolean => e instanceof StateStoreError && e.kind === 'client' && e.status === 400;
    await assert.rejects(be.gc({ ...req, keep: [], current: [] }), client400);
    await assert.rejects(be.gc({ ...req, current: [] }), client400);
    await assert.rejects(be.gc({ ...req, cursor: 'x', current: [blobs[0]!.hex] }), client400);
    await assert.rejects(be.gc({ ...req, minAgeDays: 7 }), (e: unknown) => client400(e) && /minAgeDays/.test(String(e)));
    await assert.rejects(be.gc({ ...req, maxDeletes: 1001 }), client400);
    // A foreign key under cas/ is listed and never touched.
    writeFileSync(join(dir, 'cas', 'notes.txt'), 'x');
    utimesSync(join(dir, 'cas', 'notes.txt'), old, old);
    const dry = await be.gc(req);
    assert.deepEqual(dry, { listed: 6, deleted: 0, bytesDeleted: 0, wouldDelete: 2, bytesWouldDelete: blobs[1]!.bytes.length + blobs[2]!.bytes.length, kept: 2, young: 1, capped: 0, foreign: 1, cursor: null, dryRun: true });
    assert.equal((await getBlobs(be, blobs.map((x) => x.hex))).size, 5, 'a dry run deletes nothing');
    const capped = await be.gc({ ...req, maxDeletes: 1, dryRun: false });
    assert.deepEqual([capped.deleted, capped.wouldDelete, capped.capped, capped.bytesDeleted === capped.bytesWouldDelete], [1, 1, 1, true]);
    const rest = await be.gc({ ...req, dryRun: false });
    assert.deepEqual([rest.deleted, rest.capped], [1, 0]);
    assert.equal((await getBlobs(be, keep)).size, 2);
    await assert.rejects(be.batchGet([blobs[1]!.hex]), /missing/);
    assert.ok(existsSync(join(dir, 'cas', 'notes.txt')), 'a foreign key stays');
    // A re-PUT refreshes the age: a blob that comes back into use is not collected.
    const anchor = blob('anchor');
    await be.put(anchor.hex, anchor.bytes);
    now += 40 * 86_400_000;
    await be.put(blobs[4]!.hex, blobs[4]!.bytes);
    const after = await be.gc({ ...req, keep: [anchor.hex], current: [anchor.hex] });
    assert.deepEqual([after.wouldDelete, after.young, after.kept], [2, 1, 1], 'blobs 0 and 3 (80 and 40 days old); blob 4 was written again just now');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('state client: GC over the Worker: the request checked before it is sent, a dry run reads wouldDelete and its bytes', async () => {
  const w = fakeWorker();
  const base = await w.start();
  try {
    const be = new WorkerBackend({ baseUrl: base, ...quick });
    const blobs = Array.from({ length: 4 }, (_, i) => blob(`gc ${i}`));
    for (const x of blobs) await be.put(x.hex, x.bytes);
    for (const x of blobs.slice(0, 3)) w.uploaded.set(x.hex, Date.now() - 40 * DAY_MS);
    const req = { keep: [blobs[0]!.hex], current: [blobs[0]!.hex], cursor: null, minAgeDays: 30, maxDeletes: 600, dryRun: true };
    const sent = w.seen.length;
    await assert.rejects(be.gc({ ...req, keep: [], current: [] }), (e: unknown) => e instanceof StateStoreError && e.kind === 'client' && /keep must hold 1\.\.10000/.test(e.message));
    await assert.rejects(be.gc({ ...req, current: [] }), /current must hold 1\.\.40/);
    assert.equal(w.seen.length, sent, 'a request the Worker would refuse is never sent');
    const dry = await be.gc(req);
    const two = blobs[1]!.bytes.length + blobs[2]!.bytes.length;
    assert.deepEqual(dry, { listed: 4, deleted: 0, bytesDeleted: 0, wouldDelete: 2, bytesWouldDelete: two, kept: 1, young: 1, capped: 0, foreign: 0, cursor: null, dryRun: true });
    assert.equal(w.store.size, 4);
    const real = await be.gc({ ...req, dryRun: false });
    assert.deepEqual([real.deleted, real.bytesDeleted, real.wouldDelete], [2, two, 2]);
    assert.equal(w.store.size, 2);
  } finally {
    await w.stop();
  }
});

test('state client: a GC or budget answer that is not the Worker\'s shape is an integrity failure', () => {
  const page = { listed: 5, deleted: 0, bytesDeleted: 0, wouldDelete: 2, bytesWouldDelete: 9, kept: 1, young: 1, capped: 1, foreign: 0, cursor: null, dryRun: true };
  assert.deepEqual(parseGcPage(page, true), page);
  const kind = (f: () => unknown): string => {
    try {
      f();
      return 'ok';
    } catch (e) {
      return (e as StateStoreError).kind;
    }
  };
  assert.equal(kind(() => parseGcPage({ listed: 5, deleted: 2, bytesDeleted: 0, kept: 3, cursor: null }, true)), 'integrity', 'the old answer without wouldDelete');
  assert.equal(kind(() => parseGcPage({ ...page, deleted: 2 }, true)), 'integrity', 'a dry run that deleted');
  assert.equal(kind(() => parseGcPage({ ...page, listed: 6 }, true)), 'integrity', 'listed is not the sum of its classes');
  assert.equal(kind(() => parseGcPage(page, false)), 'integrity', 'a dry-run answer to a deleting call');
  assert.equal(kind(() => parseGcPage({ ...page, dryRun: false }, false)), 'integrity', 'a real page that deleted less than it selected');
  assert.equal(kind(() => parseGcPage({ ...page, dryRun: false, deleted: 2, bytesDeleted: 9 }, false)), 'ok');
  assert.deepEqual(parseBudget(BUDGET), BUDGET);
  assert.equal(kind(() => parseBudget({ day: '2026-11-16', counters: { classA: 10 }, ceilings: { classA: 20000 } })), 'integrity', 'the old camelCase shape');
  assert.equal(kind(() => parseBudget({ ...BUDGET, stored_bytes: undefined })), 'integrity');
  assert.equal(kind(() => parseBudget({ ...BUDGET, ceilings: { ...BUDGET.ceilings, class_a: 0 } })), 'integrity');
});

test('state client: phase 3a\'s shadow policy retries a keyless 503 after 3 s inside the step deadline (runs 43907386794, 43964170954)', async () => {
  // 2 attempts, 5 s of retry budget: a Retry-After of 30 s used to end the step at the first 503.
  let n = 0;
  const w = fakeWorker({
    before: (s, res) => {
      if (s.method !== 'GET' || n++ >= 1) return false;
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(JSON.stringify({ error: 'unavailable', reason: 'signing keys unavailable' }));
      return true;
    },
  });
  const base = await w.start();
  try {
    const sleeps: number[] = [];
    const policy = { ...SHADOW_RETRY_POLICY, deadlineMs: Date.now() + SHADOW_STEP_DEADLINE_MS.hydrate };
    const be = new WorkerBackend({ baseUrl: base, ...quick, ...policy, sleep: async (ms) => void sleeps.push(ms) });
    assert.deepEqual(await be.budget(), BUDGET);
    assert.deepEqual(sleeps, [3_000]);
    assert.ok(KEYS_UNAVAILABLE_WAIT_MS <= SHADOW_RETRY_POLICY.retryBudgetMs);
    // The deadline still rules: with less than 3 s left, no second attempt.
    n = 0;
    const late = new WorkerBackend({ baseUrl: base, ...quick, ...SHADOW_RETRY_POLICY, deadlineMs: Date.now() + 2_000, sleep: async (ms) => void sleeps.push(ms) });
    await assert.rejects(late.budget(), (e: unknown) => e instanceof StateStoreError && e.retryable && /HTTP 503 unavailable after 1 attempt: the step's deadline leaves no room for another attempt/.test(e.message));
  } finally {
    await w.stop();
  }
});

test('state client: Retry-After up to 60 s is honoured within the retry budget; a longer one ends the retries', async () => {
  assert.equal(retryAfterMs('30'), 30_000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('soon'), null);
  assert.equal(retryAfterMs(new Date(Date.parse('2026-11-16T00:00:45Z')).toUTCString(), Date.parse('2026-11-16T00:00:00Z')), 45_000);
  const answering = (status: number, retryAfter: string | null, failures: number, error = 'store write failed') => {
    let n = 0;
    return fakeWorker({
      before: (s, res) => {
        if (s.method !== 'GET' || n++ >= failures) return false;
        res.writeHead(status, { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) });
        res.end(JSON.stringify({ error }));
        return true;
      },
    });
  };
  // A 503 asking for 30 s: waited exactly.
  const a = answering(503, '30', 2);
  const ba = await a.start();
  try {
    const sleeps: number[] = [];
    const be = new WorkerBackend({ baseUrl: ba, ...quick, sleep: async (ms) => void sleeps.push(ms) });
    assert.deepEqual(await be.budget(), BUDGET);
    assert.deepEqual(sleeps, [30_000, 30_000]);
  } finally {
    await a.stop();
  }
  // The Worker's 503 when no GitHub signing key can be had (older Workers: Retry-After 30): retried after 3 s.
  const k = answering(503, '30', 2, 'unavailable');
  const bk = await k.start();
  try {
    const sleeps: number[] = [];
    const be = new WorkerBackend({ baseUrl: bk, ...quick, sleep: async (ms) => void sleeps.push(ms) });
    assert.deepEqual(await be.budget(), BUDGET);
    assert.deepEqual(sleeps, [KEYS_UNAVAILABLE_WAIT_MS, KEYS_UNAVAILABLE_WAIT_MS]);
  } finally {
    await k.stop();
  }
  // With a retry budget of 60 s, a third wait of 30 s (90 s in all) is not made.
  const b = answering(503, '30', 3);
  const bb = await b.start();
  try {
    const sleeps: number[] = [];
    const be = new WorkerBackend({ baseUrl: bb, ...quick, retryBudgetMs: 60_000, sleep: async (ms) => void sleeps.push(ms) });
    await assert.rejects(be.budget(), (e: unknown) => e instanceof StateStoreError && e.kind === 'transport' && e.retryable && /after 3 attempts: the next wait of 30 s would pass the retry budget of 60 s/.test(e.message));
    assert.deepEqual(sleeps, [30_000, 30_000]);
    assert.equal(b.seen.length, 3);
  } finally {
    await b.stop();
  }
  // A zone rate limit asking for 120 s: not waited for.
  const c = answering(429, '120', 1);
  const bc = await c.start();
  try {
    const sleeps: number[] = [];
    const be = new WorkerBackend({ baseUrl: bc, ...quick, sleep: async (ms) => void sleeps.push(ms) });
    await assert.rejects(be.budget(), /after 1 attempt: the store asks to retry after 120 s, over 60 s/);
    assert.deepEqual([sleeps, c.seen.length], [[], 1]);
  } finally {
    await c.stop();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The batched, resumable hydrate fetch (getBlobs; phase 3a's shadow failures of 2026-11-17 and 11-18: runs 44043134871,
// 44177064278, 44403949467): a fake Worker whose batchGet answers break mid-blob, hang, 503 or come late.

/** 46 blobs the size of the event map's day blobs (0.25–0.32 MB, 12–13 MB in all), stored in `w`. */
function dayBlobs(w: ReturnType<typeof fakeWorker>, n = 46): { hexes: string[]; sizes: Map<string, number>; bytes: Map<string, Buffer> } {
  const bytes = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const b = randomBytes(250_000 + ((i * 1_571) % 70_000));
    bytes.set(sha256Hex(b), b);
  }
  for (const [h, b] of bytes) w.store.set(h, b);
  const hexes = [...bytes.keys()].sort();
  return { hexes, sizes: new Map([...bytes].map(([h, b]) => [h, b.length])), bytes };
}

type Fault = 'break' | 'break-first' | 'hang' | '503' | { delayMs: number } | null;

/**
 * A fake Worker whose batchGet consults `decide` (the shas asked, in order) for each request: `break` writes the frames of
 * the first two blobs and half of the third, then cuts the connection; `break-first` cuts inside the first blob; `hang`
 * never answers; `503` answers {"error":"store read failed"}; a delay answers whole, late. Every request's shas are kept
 * in `asked`, and the most batchGets in flight at once in `maxInFlight`.
 */
function faultyWorker(decide: (shas: string[]) => Fault) {
  const asked: string[][] = [];
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const w = fakeWorker({
    before: (s, res) => {
      if (s.url !== '/v1/cas:batchGet') return false;
      const shas = (JSON.parse(s.body.toString('utf8')) as { shas: string[] }).shas;
      asked.push(shas);
      inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      res.on('close', () => inFlight--);
      const fault = decide(shas);
      const whole = (): void => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(frameBatch(shas.map((h) => [h, w.store.get(h) ?? null])));
      };
      if (fault === 'hang') return true;
      if (fault === '503') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'store read failed' }));
        return true;
      }
      if (fault === 'break' || fault === 'break-first') {
        const head = fault === 'break' ? shas.slice(0, 2) : [];
        const next = shas[head.length]!;
        const b = w.store.get(next)!;
        const part = Buffer.concat([
          ...head.flatMap((h) => [Buffer.from(`BLOB ${h} ${w.store.get(h)!.length}\n`), w.store.get(h)!, Buffer.from('\n')]),
          Buffer.from(`BLOB ${next} ${b.length}\n`),
          b.subarray(0, b.length >> 1),
        ]);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write(part, () => res.destroy());
        return true;
      }
      if (fault && typeof fault === 'object') {
        setTimeout(whole, fault.delayMs);
        return true;
      }
      whole();
      return true;
    },
  });
  return { w, asked, stats };
}

test('state client: batches are planned by bytes and count, deterministic; a batch attempt\'s timeout scales with its bytes', () => {
  const sizes = new Map<string, number>();
  const hexes = Array.from({ length: 46 }, (_, i) => sha256Hex(`day ${i}`));
  hexes.forEach((h, i) => sizes.set(h, 250_000 + ((i * 1_571) % 70_000)));
  const plan = planBatches([...hexes, hexes[0]!], sizes);
  assert.deepEqual(plan.flat(), [...hexes].sort(), 'every blob once, sorted');
  for (const b of plan) {
    assert.ok(b.length <= BATCH_MAX);
    assert.ok(b.reduce((n, h) => n + sizes.get(h)!, 0) <= BATCH_MAX_BYTES, 'at most 2.5 MB a batch');
  }
  assert.equal(plan.length, 6, '46 day blobs (~13 MB): 6 requests');
  assert.deepEqual(planBatches(hexes, sizes), plan, 'deterministic');
  // A blob larger than the limit goes alone; no sizes: BLOB_BYTES_ESTIMATE each.
  const three = hexes.slice(0, 3).sort();
  assert.deepEqual(planBatches(three, new Map([[three[1]!, 9_000_000]])).map((b) => b.length), [1, 1, 1]);
  assert.deepEqual(planBatches(three, new Map([[three[0]!, 9_000_000]])).map((b) => b.length), [1, 2]);
  assert.deepEqual(planBatches(hexes).map((b) => b.length), [8, 8, 8, 8, 8, 6]);
  assert.equal(batchTimeoutMs(0, 20_000), BATCH_TIMEOUT_BASE_MS);
  assert.equal(batchTimeoutMs(300_000, 20_000), 5_600, 'one day blob');
  assert.equal(batchTimeoutMs(2_500_000, 20_000), 10_000, 'a full batch');
  assert.equal(batchTimeoutMs(12_200_000, 20_000), 20_000, 'capped by the policy');
  assert.equal(batchTimeoutMs(2_500_000, 300), 300);
});

test('state client: 46 day blobs in 6 batches, 3 in flight; a stream broken mid-blob, a hung answer and a 503 are each recovered within the deadline, a retry asking only for what is missing', async () => {
  let plan: string[][] = [];
  const fired = new Set<string>();
  const once = (key: string, f: Fault): Fault => (fired.has(key) ? null : (fired.add(key), f));
  const { w, asked, stats } = faultyWorker((shas) => {
    if (shas.includes(plan[0]![2]!)) return once('break', 'break');
    if (shas.includes(plan[1]![0]!)) return once('hang', 'hang');
    if (shas.includes(plan[2]![0]!)) return once('503', '503');
    return { delayMs: 40 };
  });
  const base = await w.start();
  try {
    const { hexes, sizes, bytes } = dayBlobs(w);
    plan = planBatches(hexes, sizes);
    const lines: string[] = [];
    const t0 = Date.now();
    const deadlineMs = t0 + 8_000;
    // The attempt timeout capped at 1 s (the scaled one would be 10 s): the hung answer costs a second, not ten.
    const be = new WorkerBackend({ baseUrl: base, ...quick, timeoutMs: 1_000, deadlineMs, log: (l) => lines.push(l) });
    const stats2 = { batches: 0, blobs: 0, bytes: 0 };
    const got = await getBlobs(be, hexes, { sizes, stats: stats2 });
    const took = Date.now() - t0;
    assert.equal(got.size, 46);
    for (const [h, b] of bytes) assert.ok(got.get(h)!.equals(b), h);
    assert.ok(plan.length >= 6 && plan.length <= 7, `${plan.length} batches of at most 2.5 MB`);
    assert.deepEqual(stats2, { batches: plan.length, blobs: 46, bytes: [...bytes.values()].reduce((n, b) => n + b.length, 0) });
    assert.ok(took < deadlineMs - t0, `recovered inside the deadline (${took} ms)`);
    assert.equal(stats.maxInFlight, BATCH_CONCURRENCY, 'three batches in flight at once, never more');
    // One request a batch, and one retry each for the broken, the hung and the 503 one.
    assert.equal(asked.length, plan.length + 3);
    // The broken batch delivered two blobs whole: its retry asked for the other six only.
    const brokenRetry = asked.filter((a) => a.includes(plan[0]![2]!));
    assert.deepEqual(brokenRetry, [plan[0], plan[0]!.slice(2)]);
    // The hung and the 503 batches had nothing delivered: asked again whole.
    assert.deepEqual(asked.filter((a) => a.includes(plan[1]![0]!)), [plan[1], plan[1]]);
    assert.deepEqual(asked.filter((a) => a.includes(plan[2]![0]!)), [plan[2], plan[2]]);
    assert.ok(lines.some((l) => l.includes(`the stream broke after 2 of ${plan[0]!.length} blob(s)`)), lines.join('\n'));
    assert.ok(lines.some((l) => l.includes(`[${plan[0]!.length - 2} blob(s), `) && /: 200 in/.test(l)), 'the retry logs what it still asks for');
    assert.ok(lines.some((l) => /timed out after 1000 ms/.test(l)));
  } finally {
    await w.stop();
  }
});

test('state client: a batch that cannot be fetched fails the whole fetch closed: its 4 attempts, the siblings cancelled, no batch started after it', async () => {
  let plan: string[][] = [];
  const { w, asked } = faultyWorker((shas) => (shas.includes(plan[0]![0]!) ? 'break-first' : { delayMs: 3_000 }));
  const base = await w.start();
  try {
    const { hexes, sizes } = dayBlobs(w);
    plan = planBatches(hexes, sizes);
    const be = new WorkerBackend({ baseUrl: base, ...quick, timeoutMs: 15_000 });
    const t0 = Date.now();
    await assert.rejects(
      getBlobs(be, hexes, { sizes }),
      (e: unknown) =>
        e instanceof StateStoreError && e.kind === 'transport' && e.retryable && e.message.includes(`the stream broke after 0 of ${plan[0]!.length} blob(s)`) && /0 of \d held after 4 attempts$/.test(e.message),
    );
    assert.ok(Date.now() - t0 < 2_500, 'the slow siblings were cancelled, not waited for');
    assert.equal(asked.filter((a) => a.includes(plan[0]![0]!)).length, BATCH_ATTEMPTS);
    const started = new Set(asked.map((a) => a[0]));
    assert.equal(started.size, BATCH_CONCURRENCY, 'the three batches of the first wave only');
  } finally {
    await w.stop();
  }
});

/** Six small blobs planned as 1 MB each: three batches of two, one per getBlobs worker. */
function threeBatches(): { hexes: string[]; sizes: Map<string, number>; blobs: Map<string, Buffer>; plan: string[][] } {
  const blobs = new Map<string, Buffer>();
  for (let i = 0; i < 6; i++) {
    const b = Buffer.from(`blob ${i} `.repeat(200));
    blobs.set(sha256Hex(b), b);
  }
  const hexes = [...blobs.keys()].sort();
  const sizes = new Map(hexes.map((h) => [h, 1_000_000]));
  const plan = planBatches(hexes, sizes);
  assert.equal(plan.length, 3);
  return { hexes, sizes, blobs, plan };
}

const shasOf = (init?: RequestInit): string[] => (JSON.parse(String(init?.body)) as { shas: string[] }).shas;

test('state client: a cancel that lands while a sibling batch waits for its token stops it before its request', async () => {
  const { hexes, sizes, plan } = threeBatches();
  // The first batch's token comes at once, its answer is MISSING; the siblings' tokens come after that failure.
  let tokens = 0;
  const token = async (): Promise<string> => {
    if (tokens++ > 0) await new Promise((r) => setTimeout(r, 100));
    return jwt(Math.floor(Date.now() / 1000) + 300);
  };
  const fetched: string[][] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const shas = shasOf(init);
    fetched.push(shas);
    if (shas.includes(plan[0]![0]!)) return new Response(frameBatch(shas.map((h) => [h, null])), { status: 200 });
    // A sibling request that went out would hang until its own timeout (9 s for 2 MB).
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  }) as typeof fetch;
  const be = new WorkerBackend({ baseUrl: 'https://feed-state.example', fetchImpl, token, sleep: quick.sleep, random: () => 0, timeoutMs: 15_000 });
  await assert.rejects(getBlobs(be, hexes, { sizes }), (e: unknown) => e instanceof StateStoreError && e.kind === 'missing');
  assert.deepEqual(fetched, [plan[0]], 'the siblings never sent their request');
});

test('state client: a sibling cut mid-stream or waiting out a backoff by the cancel stops at once, labelled cancelled', { timeout: 10_000 }, async () => {
  const { hexes, sizes, blobs, plan } = threeBatches();
  const fetched: string[][] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const shas = shasOf(init);
    fetched.push(shas);
    if (shas.includes(plan[0]![0]!)) {
      // Fails for good once the siblings are under way: one mid-stream, one in its backoff after a 503.
      await new Promise((r) => setTimeout(r, 50));
      return new Response(frameBatch(shas.map((h) => [h, null])), { status: 200 });
    }
    if (shas.includes(plan[2]![0]!)) return new Response(JSON.stringify({ error: 'store read failed' }), { status: 503 });
    const b = blobs.get(shas[0]!)!;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.concat([Buffer.from(`BLOB ${shas[0]} ${b.length}\n`), b.subarray(0, b.length >> 1)]));
        init?.signal?.addEventListener('abort', () => c.error(new Error('This operation was aborted')));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  // A backoff that never ends by itself: only the cancel can end it (the test's timeout catches a backend that waits).
  const sleeps: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    return new Promise(() => {});
  };
  const lines: string[] = [];
  const be = new WorkerBackend({ baseUrl: 'https://feed-state.example', fetchImpl, token: quick.token, sleep, random: () => 0, timeoutMs: 15_000, log: (l) => lines.push(l) });
  await assert.rejects(getBlobs(be, hexes, { sizes }), (e: unknown) => e instanceof StateStoreError && e.kind === 'missing');
  assert.equal(fetched.length, 3, 'one request a batch, no retry after the cancel');
  assert.deepEqual(sleeps, [500], "the 503 sibling's backoff only; the cut one went straight to the cancel");
  assert.ok(lines.some((l) => l.includes(`the stream broke after 0 of ${plan[1]!.length} blob(s) (cancelled)`)), lines.join('\n'));
  assert.ok(!lines.some((l) => /timed out/.test(l)), lines.join('\n'));
});

test('state client: the default wait between attempts ends early on an abort', { timeout: 10_000 }, async () => {
  // A minute-long wait each: only the abort can end them inside the test's timeout.
  const ac = new AbortController();
  const p = sleepUnlessAborted(60_000, ac.signal);
  ac.abort();
  await p;
  await sleepUnlessAborted(60_000, ac.signal);
  await sleepUnlessAborted(1);
});

test('state client: a store that hangs fails the fetch at the step deadline; a MISSING blob fails it at once, never retried', async () => {
  const hung = faultyWorker(() => 'hang');
  const base = await hung.w.start();
  try {
    const { hexes, sizes } = dayBlobs(hung.w, 10);
    const t0 = Date.now();
    const be = new WorkerBackend({ baseUrl: base, ...quick, timeoutMs: 15_000, deadlineMs: t0 + 1_200 });
    await assert.rejects(getBlobs(be, hexes, { sizes }), (e: unknown) => e instanceof StateStoreError && e.kind === 'transport' && /timed out|deadline/.test(e.message));
    const took = Date.now() - t0;
    assert.ok(took >= 1_000 && took < 2_500, `bounded by the deadline (${took} ms)`);
  } finally {
    await hung.w.stop();
  }
  const missing = faultyWorker(() => null);
  const mb = await missing.w.start();
  try {
    const { hexes, sizes } = dayBlobs(missing.w, 10);
    missing.w.store.delete(hexes[3]!);
    const be = new WorkerBackend({ baseUrl: mb, ...quick });
    await assert.rejects(getBlobs(be, hexes, { sizes }), (e: unknown) => e instanceof StateStoreError && e.kind === 'missing' && e.message.includes(hexes[3]!));
    assert.equal(missing.asked.filter((a) => a.includes(hexes[3]!)).length, 1);
  } finally {
    await missing.w.stop();
  }
});

test('state client: concurrent requests share one OIDC token request', async () => {
  let minted = 0;
  const fetchImpl = (async () => {
    minted++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ value: jwt(Math.floor(Date.now() / 1000) + 300) }), { status: 200 });
  }) as typeof fetch;
  const source = githubOidcTokenSource('earthquakes-feed-state', { env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/req', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' }, fetchImpl });
  const tokens = await Promise.all([source(), source(), source()]);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(minted, 1);
});
