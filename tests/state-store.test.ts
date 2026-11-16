import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  BATCH_MAX,
  FsBackend,
  STATE_USER_AGENT,
  StateStoreError,
  WorkerBackend,
  backendFromEnv,
  casKey,
  frameBatch,
  getBlobs,
  githubOidcTokenSource,
  jwtExpiryMs,
  parseBatchFrames,
  sha256Hex,
  type GcRequest,
} from '../src/state-store.js';

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

/** A fake state Worker: R2 as a Map, every route of the contract, and hooks to break it on purpose. */
function fakeWorker(hooks: { before?: (req: Seen, res: ServerResponse) => boolean; frame?: (shas: string[], store: Map<string, Buffer>) => Buffer } = {}) {
  const store = new Map<string, Buffer>();
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
        if (sha256Hex(s.body) !== put[1]) return json(400, { error: 'checksum' });
        store.set(put[1]!, s.body);
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
        if (r.current.some((c) => !r.keep.includes(c) || !store.has(c))) return json(409, { error: 'current not kept or missing' });
        let deleted = 0;
        for (const k of [...store.keys()]) if (!r.keep.includes(k) && deleted < r.maxDeletes) (deleted++, r.dryRun || store.delete(k));
        return json(200, { listed: store.size, deleted, bytesDeleted: 0, kept: store.size - deleted, cursor: null });
      }
      if (req.method === 'GET' && req.url === '/v1/budget') return json(200, { day: '2026-11-16', counters: { classA: 10 }, ceilings: { classA: 20000 } });
      json(404, { error: 'no route' });
    });
  });
  return {
    store,
    seen,
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
    assert.deepEqual(await be.budget(), { day: '2026-11-16', counters: { classA: 10 }, ceilings: { classA: 20000 } });
  } finally {
    await w.stop();
  }
});

test('state client: a MISSING blob fails closed; getBlobs batches 40 at a time', async () => {
  const w = fakeWorker();
  const base = await w.start();
  try {
    const be = new WorkerBackend({ baseUrl: base, ...quick });
    const blobs = Array.from({ length: BATCH_MAX + 5 }, (_, i) => blob(`{"feedId":"efd_${i}"}\n`));
    for (const x of blobs) await be.put(x.hex, x.bytes);
    const all = await getBlobs(be, blobs.map((x) => x.hex));
    assert.equal(all.size, blobs.length);
    const gets = w.seen.filter((s) => s.url === '/v1/cas:batchGet').map((s) => (JSON.parse(s.body.toString('utf8')) as { shas: string[] }).shas.length);
    assert.deepEqual(gets, [BATCH_MAX, 5]);
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

test('state client: 5xx, a non-budget 429 and a cut stream are retried (at most 4 attempts); 4xx and the budget never', async () => {
  let failures = 0;
  const w = fakeWorker({
    before: (s, res) => {
      if (s.url.startsWith('/v1/cas/sha256/') && failures < 2) {
        failures++;
        res.writeHead(failures === 1 ? 503 : 429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: failures === 1 ? 'unavailable' : 'slow down' }));
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
    [400, 'checksum', 'integrity'],
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
  // A batchGet answer cut short is asked again; the second answer is whole.
  let cut = 0;
  const flaky = fakeWorker({
    frame: (shas, store) => {
      const full = frameBatch(shas.map((h) => [h, store.get(h) ?? null]));
      return cut++ === 0 ? full.subarray(0, full.length - 4) : full;
    },
  });
  const fb = await flaky.start();
  try {
    const be = new WorkerBackend({ baseUrl: fb, ...quick });
    const a = blob('cut');
    await be.put(a.hex, a.bytes);
    assert.equal((await be.batchGet([a.hex])).size, 1);
    assert.equal(flaky.seen.filter((s) => s.url === '/v1/cas:batchGet').length, 2);
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

test('directory backend: the Worker\'s checks and GC rules (keep, current, age, cap, pages)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-fs-'));
  try {
    let now = Date.parse('2026-11-16T00:00:00Z');
    const be = new FsBackend(dir, () => now);
    const blobs = Array.from({ length: 5 }, (_, i) => blob(`day ${i}`));
    for (const x of blobs) await be.put(x.hex, x.bytes);
    await assert.rejects(be.put(blobs[0]!.hex, blobs[1]!.bytes), (e: unknown) => e instanceof StateStoreError && e.status === 400);
    // Age: three blobs uploaded 40 days ago, two now.
    const old = (Date.parse('2026-10-07T00:00:00Z')) / 1000;
    for (const x of blobs.slice(0, 3)) utimesSync(join(dir, ...casKey(x.hex).split('/')), old, old);
    const keep = [blobs[0]!.hex, blobs[4]!.hex];
    await assert.rejects(be.gc({ keep, current: [blobs[1]!.hex], cursor: null, minAgeDays: 30, maxDeletes: 10, dryRun: true }), /not in keep/);
    const missing = blob('gone');
    await assert.rejects(be.gc({ keep: [...keep, missing.hex], current: [missing.hex], cursor: null, minAgeDays: 30, maxDeletes: 10, dryRun: true }), /missing/);
    const dry = await be.gc({ keep, current: [blobs[0]!.hex], cursor: null, minAgeDays: 30, maxDeletes: 10, dryRun: true });
    assert.deepEqual([dry.listed, dry.deleted, dry.kept, dry.cursor], [5, 2, 3, null]);
    assert.equal((await getBlobs(be, blobs.map((x) => x.hex))).size, 5, 'a dry run deletes nothing');
    const capped = await be.gc({ keep, current: [], cursor: null, minAgeDays: 30, maxDeletes: 1, dryRun: false });
    assert.equal(capped.deleted, 1);
    const rest = await be.gc({ keep, current: [], cursor: null, minAgeDays: 30, maxDeletes: 10, dryRun: false });
    assert.equal(rest.deleted, 1);
    assert.equal((await getBlobs(be, keep)).size, 2);
    await assert.rejects(be.batchGet([blobs[1]!.hex]), /missing/);
    // A re-PUT refreshes the age: a blob that comes back into use is not collected.
    now += 40 * 86_400_000;
    await be.put(blobs[4]!.hex, blobs[4]!.bytes);
    const after = await be.gc({ keep: [], current: [], cursor: null, minAgeDays: 30, maxDeletes: 10, dryRun: true });
    assert.equal(after.deleted, 2, 'blobs 0 and 3 (80 and 40 days old); blob 4 was written again just now');
    await assert.rejects(be.gc({ keep: [], current: [], cursor: null, minAgeDays: 7, maxDeletes: 10, dryRun: true }), /minAgeDays/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
