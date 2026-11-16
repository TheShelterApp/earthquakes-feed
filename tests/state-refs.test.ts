import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { DEFAULT_POLICY, HOME, LANE_POLICY, RESTORE_PAIR, authorize, createKeyStore, knownRepositories, type Policy } from '../state/src/auth.js';
import { SCHEMA, gcBegin, gcEnd, migrate, reflogCollision, refundRef, refundStored, reserve, snapshot, type Sql } from '../state/src/budget.js';
import { blobKey } from '../state/src/cas.js';
import { REFS_SCHEMA, canonicalJson as workerCanonical, parseRefBody, refGetSql, refSwapSql, reflogKey } from '../state/src/refs.js';
import { createHandler, type Env } from '../state/src/worker.js';
import { RACE_ROUNDS, observationsMarkdown, rehearseRefs } from '../src/state-rehearsal.js';
import {
  FsBackend,
  RefConflict,
  ReflogCollision,
  StateStoreError,
  WorkerBackend,
  canonicalJson,
  isQuota1027,
  nextRef,
  parseBudget,
  reflogAll,
  swapRef,
  writerFromEnv,
  writerId,
  type RefSwap,
  type StateRef,
} from '../src/state-store.js';

// Protocol 2 of the state Worker (storage phase 4.0): lane refs, the reflog, (repository_id, workflow) pairs, the
// restore gate, priority lanes and the Durable Object fallback — the real Worker handler (state/src) driven by the real
// client (src/state-store.ts) in one process, over an in-memory R2 that honours `onlyIf` (atomically, or not, to show
// what the staging rehearsal would see) and the budget ledger on node:sqlite.

const REPO_ID = '1289538519';
const PEER_ID = '1300000001';
const T0 = Date.parse('2026-11-16T10:00:00Z');
const DAY = 86_400_000;
const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');

// --- Tokens --------------------------------------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { keys: [{ ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' }] };
const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

interface Who {
  workflow?: string;
  repositoryId?: string;
  ref?: string;
  event?: string;
  environment?: string;
  runId?: string;
  attempt?: string;
}

function token(aud: string, who: Who = {}): string {
  const now = Math.floor(T0 / 1000);
  const ref = who.ref ?? 'refs/heads/main';
  const claims: Record<string, unknown> = {
    iss: 'https://token.actions.githubusercontent.com',
    aud,
    repository_id: who.repositoryId ?? REPO_ID,
    ref,
    ref_type: 'branch',
    event_name: who.event ?? 'schedule',
    runner_environment: 'github-hosted',
    workflow_ref: `TheShelterApp/x/.github/workflows/${who.workflow ?? 'aggregate.yml'}@${ref}`,
    run_id: who.runId ?? '4242',
    run_attempt: who.attempt ?? '1',
    nbf: now - 600,
    iat: now,
    exp: now + 300,
  };
  if (who.environment) claims.environment = who.environment;
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64url(JSON.stringify(claims));
  return `${h}.${p}.${b64url(nodeSign('sha256', Buffer.from(`${h}.${p}`), privateKey))}`;
}

// --- Fakes ---------------------------------------------------------------------------------------------------------

interface Stored {
  bytes: Uint8Array;
  uploaded: Date;
  etag: string;
  customMetadata?: Record<string, string>;
}

/**
 * The R2 binding as the Worker uses it, with conditional puts: `onlyIf` as Headers (If-None-Match: *, If-Match) or an
 * R2Conditional (etagMatches, etagDoesNotMatch "*"); a failed precondition answers null. `atomic` false lets another
 * request run between the check and the write (what the race rehearsal must catch on the real binding).
 */
class FakeR2 {
  objects = new Map<string, Stored>();
  /** Every call takes a turn of the event loop, as a network round trip would: two concurrent requests interleave. */
  private tick = (): Promise<void> => new Promise((r) => setImmediate(r));
  ops = { put: 0, get: 0, head: 0, list: 0, delete: 0 };
  atomic = true;
  now = (): number => T0;
  private holds(key: string, onlyIf: unknown): boolean {
    const o = this.objects.get(key);
    if (onlyIf == null) return true;
    if (onlyIf instanceof Headers) {
      const none = onlyIf.get('if-none-match');
      const match = onlyIf.get('if-match');
      if (none === '*') return !o;
      if (match) return !!o && `"${o.etag}"` === match;
      return true;
    }
    const c = onlyIf as { etagMatches?: string; etagDoesNotMatch?: string };
    if (c.etagMatches !== undefined && (!o || o.etag !== c.etagMatches)) return false;
    if (c.etagDoesNotMatch === '*' && o) return false;
    return true;
  }
  async put(key: string, value: ReadableStream | Uint8Array | string, opts: { sha256?: string; onlyIf?: unknown; customMetadata?: Record<string, string> } = {}) {
    this.ops.put++;
    await this.tick();
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    if (opts.sha256 && sha256(bytes) !== opts.sha256) throw new Error('put: checksum (10037)');
    if (!this.holds(key, opts.onlyIf)) return null;
    // Not atomic: the etag check of a swap and its write with a gap between them (create-only stays atomic here).
    const swap = opts.onlyIf != null && !(opts.onlyIf instanceof Headers && opts.onlyIf.get('if-none-match') === '*') && (opts.onlyIf as { etagDoesNotMatch?: string }).etagDoesNotMatch !== '*';
    if (!this.atomic && swap) await new Promise((r) => setTimeout(r, 2));
    const o: Stored = { bytes, uploaded: new Date(this.now()), etag: md5(bytes), customMetadata: opts.customMetadata };
    this.objects.set(key, o);
    return { key, size: bytes.byteLength, uploaded: o.uploaded, etag: o.etag, httpEtag: `"${o.etag}"` };
  }
  async get(key: string) {
    this.ops.get++;
    await this.tick();
    const o = this.objects.get(key);
    if (!o) return null;
    return { key, size: o.bytes.byteLength, uploaded: o.uploaded, etag: o.etag, body: new Response(o.bytes.slice()).body!, text: async () => Buffer.from(o.bytes).toString('utf8') };
  }
  async head(key: string) {
    this.ops.head++;
    await this.tick();
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.byteLength, uploaded: o.uploaded, etag: o.etag } : null;
  }
  async list({ prefix = '', startAfter, cursor, limit = 1000, include = [] }: { prefix?: string; startAfter?: string; cursor?: string; limit?: number; include?: string[] }) {
    this.ops.list++;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && (!startAfter || k > startAfter) && (!cursor || k > cursor)).sort();
    const page = keys.slice(0, limit);
    const truncated = page.length < keys.length;
    return {
      objects: page.map((key) => {
        const o = this.objects.get(key)!;
        return { key, size: o.bytes.byteLength, uploaded: o.uploaded, ...(include.includes('customMetadata') ? { customMetadata: o.customMetadata } : {}) };
      }),
      truncated,
      cursor: truncated ? page.at(-1) : undefined,
    };
  }
  async delete(keys: string | string[]) {
    this.ops.delete++;
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
}

function sqliteSql(): Sql {
  const db = new DatabaseSync(':memory:');
  const exec = (query: string, ...bindings: unknown[]) => {
    const rows = db.prepare(query).all(...(bindings as SQLInputValue[]));
    return { toArray: () => rows };
  };
  const sql = { exec };
  migrate(sql, [REFS_SCHEMA]);
  return sql;
}

function fakeLedger() {
  const sql = sqliteSql();
  const clone = <T>(v: T): T => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
  const stub = {
    reserve: async (a: Parameters<typeof reserve>[1]) => clone(reserve(sql, clone(a))),
    refundStored: async (b: number, at?: number) => refundStored(sql, b, at),
    refundRef: async (a: Parameters<typeof refundRef>[1]) => refundRef(sql, clone(a)),
    reflogCollision: async (a: Parameters<typeof reflogCollision>[1]) => reflogCollision(sql, clone(a)),
    gcBegin: async (a: Parameters<typeof gcBegin>[1]) => clone(gcBegin(sql, clone(a))),
    gcEnd: async (a: Parameters<typeof gcEnd>[1]) => gcEnd(sql, clone(a)),
    snapshot: async (a: Parameters<typeof snapshot>[1]) => clone(snapshot(sql, clone(a))),
    refGet: async (lane: string) => clone(refGetSql(sql, lane)),
    refSwap: async (a: Parameters<typeof refSwapSql>[1]) => clone(refSwapSql(sql, clone(a))),
  };
  return { sql, ns: { idFromName: (n: string) => n, get: () => stub } };
}

const CEILINGS = { CLASS_A_PER_DAY: '20000', CLASS_B_PER_DAY: '200000', BYTES_WRITTEN_PER_DAY: '1073741824', STORED_BYTES_MAX: '6442450944' };

function harness(opts: { staging?: boolean; refBackend?: 'r2' | 'do'; atomic?: boolean; env?: Partial<Env>; policy?: Policy } = {}) {
  const r2 = new FakeR2();
  r2.atomic = opts.atomic ?? true;
  const ledger = fakeLedger();
  const keyStore = createKeyStore({ fetchJwks: async () => JWKS, now: () => T0 });
  const logs: string[] = [];
  const handle = createHandler({ keyStore, now: () => T0, log: (l) => void logs.push(l), ...(opts.policy ? { policy: opts.policy } : {}) });
  const aud = opts.staging ? 'earthquakes-feed-state-staging' : 'earthquakes-feed-state';
  const env: Env = {
    ENVIRONMENT: opts.staging ? 'staging' : 'production',
    REPOSITORY_ID: REPO_ID,
    AUDIENCE: aud,
    ALLOW_ANY_REF: opts.staging ? '1' : '0',
    MIN_PROTOCOL: '1',
    REF_BACKEND: opts.refBackend ?? 'r2',
    ...CEILINGS,
    STATE: r2,
    BUDGET: ledger.ns,
    ...opts.env,
  };
  const host = `https://feed-state${opts.staging ? '-staging' : ''}.theshelter.app`;
  // fetch sets Content-Length on the wire for a buffered body; an in-process Request does not, so the harness does.
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    const headers = new Headers(init?.headers);
    if ((typeof body === 'string' || body instanceof Uint8Array) && !headers.has('content-length')) headers.set('content-length', String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength));
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return handle(new Request(input, { ...init, headers }), env, { waitUntil: () => {} });
  }) as typeof fetch;
  /** A client as `who` (its writer ids name the same run). */
  const client = (who: Who = {}, wrap?: (f: typeof fetch) => typeof fetch) =>
    new WorkerBackend({ baseUrl: host, token: async () => token(aud, who), fetchImpl: wrap ? wrap(fetchImpl) : fetchImpl, sleep: async () => {}, random: () => 0 });
  const writer = (who: Who, step: string) => writerId({ workflow: who.workflow ?? 'aggregate.yml', runId: who.runId ?? '4242', runAttempt: who.attempt ?? '1', step });
  /** A generation blob in the bucket. */
  const blob = (text: string): string => {
    const bytes = gzipSync(Buffer.from(text));
    const hex = sha256(bytes);
    r2.objects.set(blobKey(hex), { bytes, uploaded: new Date(T0), etag: md5(bytes) });
    return hex;
  };
  return { r2, ledger, env, logs, client, writer, blob, fetchImpl, aud };
}

const COMMIT = 'a'.repeat(40);
const refFor = (lane: string, cur: StateRef | null, generation: string, writer: string, extra: Partial<StateRef> = {}): StateRef => ({
  ...nextRef(cur, { lane, generation, head_seq: (cur?.head_seq ?? 0) + 5, data_commit: COMMIT, writer, written: '2026-11-16T10:00:00.000Z' }),
  ...extra,
});

// --- The ref routes ------------------------------------------------------------------------------------------------

for (const refBackend of ['r2', 'do'] as const) {
  test(`state refs (${refBackend}): bootstrap once, swap only the successor of the version named, the reflog follows`, async () => {
    const h = harness({ refBackend });
    const agg: Who = { workflow: 'aggregate.yml' };
    const be = h.client(agg);
    assert.equal(await be.getRef('main'), null);
    const g1 = h.blob('g1');
    const r1 = refFor('main', null, g1, h.writer(agg, 'bootstrap'));
    const s1 = await be.putRef('main', r1, { create: true });
    assert.deepEqual([s1.seq, s1.reflog], [1, { previous: 'none', entry: 'created' }]);
    assert.ok(s1.storeOps! <= 5 && s1.ledgerCalls === 1);
    // The second create is refused with the first ref as the current one.
    await assert.rejects(be.putRef('main', refFor('main', null, g1, h.writer(agg, 'again')), { create: true }), (e: unknown) => e instanceof RefConflict && e.current?.ref.writer === r1.writer);
    const read = (await be.getRef('main'))!;
    assert.equal(read.text, canonicalJson(r1));
    assert.equal(read.etag, s1.etag);
    // The successor swaps; a stale ETag is a 412 with the current ref; the store ops stay within 5.
    const r2 = refFor('main', r1, h.blob('g2'), h.writer(agg, 'next'));
    const s2 = await be.putRef('main', r2, { etag: read.etag });
    assert.deepEqual([s2.seq, s2.reflog], [2, { previous: 'present', entry: 'created' }]);
    assert.ok(s2.storeOps! <= 5, `ops ${s2.storeOps}`);
    const stale = await be.putRef('main', refFor('main', r1, h.blob('g3'), h.writer(agg, 'stale')), { etag: read.etag }).catch((e) => e);
    assert.ok(stale instanceof RefConflict && stale.current?.ref.seq === 2 && stale.current.etag === s2.etag);
    // The reflog: both refs, ascending, with their fields (read by GC's workflow: a writer holds no reflog right).
    const log = await reflogAll(h.client({ workflow: 'state-gc.yml' }), 'main');
    assert.deepEqual(log.map((e) => [e.seq, e.generation, e.writer, e.parent]), [[1, g1, r1.writer, null], [2, r2.generation, r2.writer, g1]]);
    if (refBackend === 'r2') assert.ok(h.r2.objects.has('refs/main'));
    else assert.ok(!h.r2.objects.has('refs/main'), 'the do backend keeps the ref out of the bucket');
    assert.ok(h.r2.objects.has(reflogKey('main', 1)) && h.r2.objects.has(reflogKey('main', 2)));
  });

  test(`state refs (${refBackend}): two racing writers on one ref, exactly one 412 every time`, async () => {
    const h = harness({ refBackend });
    const agg: Who = { workflow: 'aggregate.yml' };
    const be = h.client(agg);
    await be.putRef('main', refFor('main', null, h.blob('g0'), h.writer(agg, 'b')), { create: true });
    for (let round = 0; round < 5; round++) {
      const cur = (await be.getRef('main'))!;
      const pair = [0, 1].map((i) => refFor('main', cur.ref, h.blob(`r${round}-${i}`), h.writer(agg, `race-${i}`)));
      const res = await Promise.allSettled(pair.map((r) => be.putRef('main', r, { etag: cur.etag })));
      const won = res.filter((r) => r.status === 'fulfilled');
      const lost = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert.equal(won.length, 1, `round ${round}`);
      assert.ok(lost[0]!.reason instanceof RefConflict);
      const winner = pair[res.findIndex((r) => r.status === 'fulfilled')]!;
      assert.equal((lost[0]!.reason as RefConflict).current?.ref.writer, winner.writer);
    }
    const log = await reflogAll(h.client({ workflow: 'state-backup.yml' }), 'main');
    assert.deepEqual(log.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
    // The ledger reserved at least what the bucket did, the re-GET of every swap-time 412 included.
    const b = await h.client({ workflow: 'health.yml' }).budget();
    assert.ok(b.used.class_b >= h.r2.ops.get + h.r2.ops.head, `class B ${b.used.class_b} < ${h.r2.ops.get + h.r2.ops.head}`);
    assert.ok(b.used.class_a >= h.r2.ops.put + h.r2.ops.list, `class A ${b.used.class_a} < ${h.r2.ops.put + h.r2.ops.list}`);
  });

  test(`state refs (${refBackend}): a create continues the reflog of a lane whose ref is gone (a backend switch, a lost ref)`, async () => {
    const h = harness({ refBackend });
    const agg: Who = { workflow: 'aggregate.yml' };
    const be = h.client(agg);
    const status = (p: Promise<unknown>) => p.then(() => 200, (e: StateStoreError) => e.status);
    // An empty reflog: seq 1 with parent null only.
    assert.equal(await status(be.putRef('main', refFor('main', null, h.blob('g0'), h.writer(agg, 'b'), { seq: 2 }), { create: true })), 409);
    assert.equal(await status(be.putRef('main', refFor('main', null, h.blob('g0'), h.writer(agg, 'b'), { parent: sha256('x') }), { create: true })), 409);
    let prev: StateRef | null = null;
    let etag: string | null = null;
    for (let i = 1; i <= 3; i++) {
      const r = refFor('main', prev, h.blob(`g${i}`), h.writer(agg, `s${i}`));
      etag = (await be.putRef('main', r, etag ? { etag } : { create: true })).etag;
      prev = r;
    }
    // The ref goes (REF_BACKEND switched, or the object deleted by hand); the reflog stays in R2.
    if (refBackend === 'r2') h.r2.objects.delete('refs/main');
    else h.ledger.sql.exec('DELETE FROM refs WHERE lane = ?', 'main');
    assert.equal(await be.getRef('main'), null);
    const g = h.blob('g4');
    const create = (extra: Partial<StateRef>) => status(be.putRef('main', refFor('main', null, g, h.writer(agg, 'c'), extra), { create: true }));
    assert.equal(await create({}), 409, 'seq 1 again: its slot holds the first generation');
    assert.equal(await create({ seq: 3, parent: prev!.parent }), 409, 'a seq whose slot is taken');
    assert.equal(await create({ seq: 5, parent: prev!.generation }), 409, 'a gap');
    assert.equal(await create({ seq: 4, parent: sha256('other') }), 409, 'not the last entry\'s generation');
    assert.equal(await create({ seq: 4, parent: prev!.generation, head_seq: prev!.head_seq - 1 }), 409, 'head_seq backwards');
    assert.equal(await create({ seq: 4, parent: prev!.generation, head_seq: prev!.head_seq + 9, restore_of: { seq: 1, generation: prev!.generation } }), 403, 'a feed writer never restores');
    const r4 = refFor('main', null, g, h.writer(agg, 'c'), { seq: 4, parent: prev!.generation, head_seq: prev!.head_seq });
    const s4 = await be.putRef('main', r4, { create: true });
    assert.deepEqual(s4.reflog, { previous: 'none', entry: 'created' });
    assert.ok(s4.storeOps! <= 5, `ops ${s4.storeOps}`);
    assert.deepEqual((await reflogAll(h.client({ workflow: 'state-gc.yml' }), 'main')).map((e) => [e.seq, e.writer]).at(-1), [4, r4.writer]);
  });
}

test('state refs: a create never restores, not even by the restore pair', async () => {
  const h = harness({ staging: true });
  const restorer: Who = { workflow: 'state-restore.yml', event: 'workflow_dispatch', environment: 'state-restore' };
  const g = h.blob('g');
  const r = refFor('main', null, g, h.writer(restorer, 'r'), { restore_of: { seq: 1, generation: g } });
  await assert.rejects(h.client(restorer).putRef('main', r, { create: true }), (e: unknown) => e instanceof StateStoreError && e.status === 409 && /a create cannot restore/.test(e.message));
});

test('state refs: a non-atomic conditional put lets both racers win; the reflog slot then shows it', async () => {
  const h = harness({ atomic: false });
  const agg: Who = { workflow: 'aggregate.yml' };
  const be = h.client(agg);
  await be.putRef('main', refFor('main', null, h.blob('g0'), h.writer(agg, 'b')), { create: true });
  const cur = (await be.getRef('main'))!;
  const pair = [0, 1].map((i) => refFor('main', cur.ref, h.blob(`x${i}`), h.writer(agg, `race-${i}`)));
  const res = await Promise.allSettled(pair.map((r) => be.putRef('main', r, { etag: cur.etag })));
  // Both swapped; the second winner finds its seq slot taken and fails closed (kind integrity), never a plain success.
  const ok = res.filter((r) => r.status === 'fulfilled');
  const collided = res.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  assert.equal(ok.length, 1);
  assert.equal((ok[0] as PromiseFulfilledResult<RefSwap>).value.reflog.entry, 'created');
  assert.ok(collided[0] instanceof ReflogCollision && collided[0].kind === 'integrity' && collided[0].swap.reflog.entry === 'exists');
  assert.ok(h.logs.some((l) => /the reflog slot of seq 2 was already taken/.test(l)));
  // swapRef never turns it into a success; the ledger counted it, so health raises it.
  const cur2 = (await be.getRef('main'))!;
  h.r2.objects.set(reflogKey('main', 3), { bytes: new Uint8Array([1]), uploaded: new Date(T0), etag: 'x' });
  await assert.rejects(swapRef(be, 'main', refFor('main', cur2.ref, h.blob('x2'), h.writer(agg, 'next')), { etag: cur2.etag }), ReflogCollision);
  const b = await h.client({ workflow: 'health.yml' }).budget();
  assert.equal(b.used.reflog_collisions, 2);
});

test('state refs: the successor rules, the precondition, the generation blob, canonical bodies, the writer and the protocol', async () => {
  const h = harness();
  const agg: Who = { workflow: 'aggregate.yml' };
  const be = h.client(agg);
  const g1 = h.blob('g1');
  const r1 = refFor('main', null, g1, h.writer(agg, 'b'));
  await be.putRef('main', r1, { create: true });
  const cur = (await be.getRef('main'))!;
  const ok = refFor('main', r1, h.blob('g2'), h.writer(agg, 'n'));
  const put = async (body: string, headers: Record<string, string>, who: Who = agg) => {
    const res = await h.fetchImpl('https://feed-state.theshelter.app/v1/refs/main', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token(h.aud, who)}`, 'x-feed-state-protocol': '2', ...headers },
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const m = { 'if-match': cur.etag };
  assert.equal((await put(canonicalJson(ok), {})).status, 428);
  assert.equal((await put(canonicalJson(ok), { ...m, 'if-none-match': '*' })).status, 400);
  assert.equal((await put(canonicalJson(ok), { 'if-match': `W/${cur.etag}` })).status, 400, 'a weak tag');
  assert.equal((await put(canonicalJson({ ...ok, seq: 3 }), m)).status, 409);
  assert.equal((await put(canonicalJson({ ...ok, parent: sha256('other') }), m)).status, 409);
  assert.equal((await put(canonicalJson({ ...ok, head_seq: r1.head_seq - 1 }), m)).status, 409);
  const missing = await put(canonicalJson({ ...ok, generation: sha256('absent') }), m);
  assert.deepEqual([missing.status, missing.json.error], [409, 'the generation blob is missing from the store']);
  assert.equal((await put(JSON.stringify(ok), m)).status, 400, 'not canonical (key order)');
  assert.equal((await put(canonicalJson({ ...ok, extra: 1 }), m)).status, 400);
  assert.equal((await put(canonicalJson({ ...ok, lane: 'history' }), m)).status, 400);
  assert.equal((await put(canonicalJson({ ...ok, writer: writerId({ workflow: 'aggregate.yml', runId: '1', runAttempt: '1', step: 's' }) }), m)).status, 400, 'another run');
  assert.equal((await put(canonicalJson(ok), { ...m, 'x-feed-state-protocol': '1' })).status, 426);
  assert.equal((await put('x'.repeat(5000), m)).status, 413);
  // A conflict and a refused body gave their meta bytes back; the 412s are counted.
  const before = parseBudget(await (await h.fetchImpl('https://feed-state.theshelter.app/v1/budget', { headers: { authorization: `Bearer ${token(h.aud)}` } })).json());
  assert.equal(before.meta_bytes, 2 * Buffer.byteLength(canonicalJson(r1)), 'the bootstrap: the ref object and its entry');
  assert.equal((await put(canonicalJson(ok), { 'if-match': '"0000"' })).status, 412);
  const after = parseBudget(await (await h.fetchImpl('https://feed-state.theshelter.app/v1/budget', { headers: { authorization: `Bearer ${token(h.aud)}` } })).json());
  assert.equal(after.meta_bytes, before.meta_bytes);
  assert.equal(after.used.ref_conflicts, 1);
  assert.equal((await put(canonicalJson(ok), m)).status, 200);
  // Unknown lanes are 404; a rehearsal lane exists on staging only.
  const status = async (path: string, method = 'GET') => (await h.fetchImpl(`https://feed-state.theshelter.app${path}`, { method, headers: { authorization: `Bearer ${token(h.aud)}` } })).status;
  assert.equal(await status('/v1/refs/nope'), 404);
  assert.equal(await status('/v1/refs/rehearsal-abc'), 404);
  assert.equal(await status('/v1/rehearsal/rehearsal-abc', 'POST'), 404);
  assert.equal(await status('/v1/refs/main', 'POST'), 405);
});

test('state refs: lane allow-lists are (repository_id, workflow) pairs; a peer repository is admitted by its own pairs only', async () => {
  const peerPolicy: Policy = {
    ...DEFAULT_POLICY,
    lanes: { ...DEFAULT_POLICY.lanes, history: { ...LANE_POLICY.history, read: [...LANE_POLICY.history.read, { repository: PEER_ID, workflow: 'publish.yml' }] } },
  };
  const h = harness({ policy: peerPolicy });
  const hist: Who = { workflow: 'history.yml' };
  await h.client(hist).putRef('history', refFor('history', null, h.blob('h1'), h.writer(hist, 'b')), { create: true });
  // The peer's publish.yml reads history; this repository's publish.yml (no such pair) does not; an unknown repository
  // is not even authenticated.
  assert.ok(await h.client({ workflow: 'publish.yml', repositoryId: PEER_ID }).getRef('history'));
  await assert.rejects(h.client({ workflow: 'publish.yml' }).getRef('history'), (e: unknown) => e instanceof StateStoreError && e.kind === 'forbidden');
  await assert.rejects(h.client({ workflow: 'publish.yml', repositoryId: '1300000002' }).getRef('history'), (e: unknown) => e instanceof StateStoreError && e.kind === 'auth');
  // The peer's history.yml matches no pair, although this repository's history.yml writes the lane.
  await assert.rejects(h.client({ workflow: 'history.yml', repositoryId: PEER_ID }).getRef('history'), (e: unknown) => e instanceof StateStoreError && e.kind === 'forbidden');
  assert.deepEqual(knownRepositories(REPO_ID, peerPolicy).sort(), [REPO_ID, PEER_ID].sort());
  assert.deepEqual(knownRepositories(REPO_ID), [REPO_ID], 'no peer in 4.0');
  // The default lists, per lane.
  const allowed = (right: 'ref-read' | 'ref-write' | 'reflog', lane: string, workflow: string): boolean => {
    try {
      authorize({ ref_type: 'branch', runner_environment: 'github-hosted', event_name: 'schedule', ref: 'refs/heads/main', workflow_ref: `o/r/.github/workflows/${workflow}@refs/heads/main`, repository_id: REPO_ID }, right, { repositoryId: REPO_ID, allowAnyRef: false, staging: false, lane });
      return true;
    } catch {
      return false;
    }
  };
  for (const w of ['aggregate.yml', 'derive.yml', 'backfill.yml', 'archive.yml', 'state-gc.yml']) assert.ok(allowed('ref-write', 'main', w), w);
  for (const w of ['first-solutions.yml', 'history.yml', 'health.yml', 'stats.yml', 'remediate.yml', 'state-rehearsal.yml']) assert.ok(!allowed('ref-write', 'main', w), w);
  for (const w of ['remediate.yml', 'health.yml', 'stats.yml', 'history.yml']) assert.ok(allowed('ref-read', 'main', w), w);
  assert.ok(allowed('ref-write', 'history', 'remerge.yml') && !allowed('ref-write', 'history', 'aggregate.yml'));
  assert.ok(allowed('ref-write', 'first-solutions', 'first-solutions.yml') && !allowed('ref-write', 'first-solutions', 'history.yml'));
  assert.ok(allowed('reflog', 'main', 'state-gc.yml') && allowed('reflog', 'main', 'state-backup.yml') && !allowed('reflog', 'main', 'aggregate.yml'));
  assert.ok(!allowed('ref-read', 'main', 'state-rehearsal.yml'), 'the rehearsal is never a production reader');
  for (const lanes of Object.values(LANE_POLICY)) for (const list of Object.values(lanes)) for (const p of list) assert.equal(p.repository, HOME);
});

test('state refs: a restore only from state-restore.yml in the Environment state-restore, dispatched, jumping head_seq', async () => {
  const h = harness({ staging: true });
  const agg: Who = { workflow: 'aggregate.yml' };
  const g1 = h.blob('g1');
  const r1 = refFor('main', null, g1, h.writer(agg, 'b'));
  await h.client(agg).putRef('main', r1, { create: true });
  const cur = (await h.client(agg).getRef('main'))!;
  const restorer: Who = { workflow: 'state-restore.yml', event: 'workflow_dispatch', environment: 'state-restore' };
  const body = (who: Who, extra: Partial<StateRef> = {}) => refFor('main', r1, g1, h.writer(who, 'restore'), { head_seq: r1.head_seq + 1000, restore_of: { seq: 1, generation: g1 }, ...extra });
  const tryAs = async (who: Who, extra: Partial<StateRef> = {}) => h.client(who).putRef('main', body(who, extra), { etag: cur.etag }).then(() => 200, (e: StateStoreError) => e.status);
  assert.equal(await tryAs(agg), 403, 'a feed writer cannot restore');
  assert.equal(await tryAs({ workflow: 'state-rehearsal.yml', ref: 'refs/heads/x' }), 403, 'the rehearsal never restores, not even on staging');
  assert.equal(await tryAs({ ...restorer, environment: undefined }), 403, 'no Environment');
  assert.equal(await tryAs({ ...restorer, environment: 'production' }), 403, 'another Environment');
  assert.equal(await tryAs({ ...restorer, event: 'schedule' }), 403, 'scheduled');
  assert.equal(await tryAs(restorer, { head_seq: r1.head_seq }), 409, 'head_seq must jump');
  assert.equal(await tryAs(restorer), 200);
  // Without restore_of the restore workflow is no writer, and the reflog records what was restored.
  const now = (await h.client(restorer).getRef('main'))!;
  await assert.rejects(h.client(restorer).putRef('main', refFor('main', now.ref, g1, h.writer(restorer, 'w')), { etag: now.etag }), (e: unknown) => e instanceof StateStoreError && e.status === 403);
  const log = await reflogAll(h.client(restorer), 'main');
  assert.deepEqual(log.at(-1)!.restore_of, { seq: 1, generation: g1 });
  assert.equal(RESTORE_PAIR.environment, 'state-restore');
  // The restore reserves on the critical lane.
  assert.ok(h.logs.some((l) => JSON.parse(l).workflow === 'state-restore.yml' && JSON.parse(l).priority === 'critical'));
});

test('state refs: the reflog is repaired from the current ref (create-only), and paged', async () => {
  const h = harness();
  const agg: Who = { workflow: 'aggregate.yml' };
  const be = h.client(agg);
  let prev: StateRef | null = null;
  let etag: string | null = null;
  for (let i = 1; i <= 5; i++) {
    const r = refFor('main', prev, h.blob(`g${i}`), h.writer(agg, `s${i}`));
    etag = (await be.putRef('main', r, etag ? { etag } : { create: true })).etag;
    prev = r;
  }
  // A Worker that died between its swap and its reflog write: entry 5 is missing; the next PUT puts it back.
  h.r2.objects.delete(reflogKey('main', 5));
  const r6 = refFor('main', prev, h.blob('g6'), h.writer(agg, 's6'));
  const s6 = await be.putRef('main', r6, { etag: etag! });
  assert.equal(s6.reflog.previous, 'repaired');
  assert.equal(Buffer.from(h.r2.objects.get(reflogKey('main', 5))!.bytes).toString(), canonicalJson(prev));
  const s7 = await be.putRef('main', refFor('main', r6, h.blob('g7'), h.writer(agg, 's7')), { etag: s6.etag });
  assert.equal(s7.reflog.previous, 'present');
  // Paged: 2 a page.
  const reader = h.client({ workflow: 'state-gc.yml' });
  const p1 = await reader.reflog('main', { limit: 2 });
  assert.deepEqual([p1.entries.map((e) => e.seq), p1.next], [[1, 2], 2]);
  const p2 = await reader.reflog('main', { after: 6, limit: 2 });
  assert.deepEqual([p2.entries.map((e) => e.seq), p2.next], [[7], null]);
  assert.deepEqual((await reflogAll(reader, 'main')).map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
  await assert.rejects(h.client(agg).reflog('main'), (e: unknown) => e instanceof StateStoreError && e.kind === 'forbidden', 'aggregate does not walk the reflog');
});

// --- The ambiguous outcome -------------------------------------------------------------------------------------------

test('state refs client: an unknown outcome is reconciled by the writer nonce, retried while unchanged, else fails closed', async () => {
  const h = harness();
  const agg: Who = { workflow: 'aggregate.yml' };
  const be = h.client(agg);
  const r1 = refFor('main', null, h.blob('g1'), h.writer(agg, 'b'));
  await be.putRef('main', r1, { create: true });
  let cur = (await be.getRef('main'))!;
  const isPut = (init?: RequestInit) => init?.method === 'PUT';
  // The answer lost after the swap: the ref is ours.
  const dropped = h.client(agg, (f) => async (i, init) => {
    const res = await f(i, init);
    if (isPut(init)) throw new TypeError('fetch failed');
    return res;
  });
  const r2 = refFor('main', cur.ref, h.blob('g2'), h.writer(agg, 'drop'));
  assert.equal((await swapRef(dropped, 'main', r2, { etag: cur.etag })).outcome, 'reconciled');
  cur = (await be.getRef('main'))!;
  // A request that never left: the ref is unchanged, so the same body goes again.
  let first = true;
  const lost = h.client(agg, (f) => async (i, init) => {
    if (isPut(init) && first) {
      first = false;
      throw new TypeError('fetch failed');
    }
    return f(i, init);
  });
  const r3 = refFor('main', cur.ref, h.blob('g3'), h.writer(agg, 'lost'));
  const s3 = await swapRef(lost, 'main', r3, { etag: cur.etag });
  assert.deepEqual([s3.outcome, s3.attempts], ['retried', 2]);
  cur = (await be.getRef('main'))!;
  // A 503 after the swap and a repeat that meets its own write: the 412 names us, so it landed.
  let once = true;
  const flaky = h.client(agg, (f) => async (i, init) => {
    const res = await f(i, init);
    if (isPut(init) && once) {
      once = false;
      return new Response('{"error":"unavailable"}', { status: 503 });
    }
    return res;
  });
  const r4 = refFor('main', cur.ref, h.blob('g4'), h.writer(agg, 'flaky'));
  // Force the repeat path: the re-GET is made to look unchanged by answering the old ref once.
  const old = cur;
  let lie = true;
  const liar = {
    getRef: async (lane: string) => (lie ? ((lie = false), old) : be.getRef(lane)),
    putRef: flaky.putRef.bind(flaky),
    reflog: flaky.reflog.bind(flaky),
  };
  assert.equal((await swapRef(liar, 'main', r4, { etag: cur.etag })).outcome, 'landed-before');
  cur = (await be.getRef('main'))!;
  // Another writer's swap in between: fail closed.
  const r5 = refFor('main', cur.ref, h.blob('g5'), h.writer(agg, 'other'));
  await be.putRef('main', r5, { etag: cur.etag });
  const r5b = refFor('main', cur.ref, h.blob('g5b'), h.writer(agg, 'late'));
  await assert.rejects(swapRef(dropped, 'main', r5b, { etag: cur.etag }), (e: unknown) => e instanceof RefConflict && e.current?.ref.writer === r5.writer);
  // The reflog has exactly one entry per seq, each the ref that won it.
  assert.deepEqual((await reflogAll(h.client({ workflow: 'state-gc.yml' }), 'main')).map((e) => e.writer), [r1.writer, r2.writer, r3.writer, r4.writer, r5.writer]);
});

test('state refs client: writer ids, canonical JSON (the Worker\'s too), the 1027 quota page', () => {
  const env = { GITHUB_WORKFLOW_REF: 'TheShelterApp/earthquakes-feed/.github/workflows/aggregate.yml@refs/heads/main', GITHUB_RUN_ID: '19000000001', GITHUB_RUN_ATTEMPT: '2' };
  assert.equal(writerFromEnv('persist', env, 'ab'.repeat(16)), `aggregate.yml/19000000001-2/persist/${'ab'.repeat(16)}`);
  assert.match(writerFromEnv('persist', env), /^aggregate\.yml\/19000000001-2\/persist\/[0-9a-f]{32}$/);
  assert.throws(() => writerFromEnv('persist', {}), /GITHUB_WORKFLOW_REF/);
  const v = { b: 1, a: { d: [3, { y: null, x: 'é' }], c: true } };
  assert.equal(canonicalJson(v), '{"a":{"c":true,"d":[3,{"x":"é","y":null}]},"b":1}');
  assert.equal(canonicalJson(v), workerCanonical(v));
  const ref = refFor('main', null, sha256('g'), writerFromEnv('s', env));
  assert.deepEqual(parseRefBody(canonicalJson(ref), 'main', { workflow: 'aggregate.yml', runId: '19000000001', runAttempt: '2' }), ref);
  assert.ok(isQuota1027('error code: 1027'));
  assert.ok(isQuota1027('<title>Error 1027</title>'));
  assert.ok(!isQuota1027('{"error":"budget"}'));
  assert.ok(!isQuota1027('request 8f1027ab-AMS'));
});

test('state client: a 1027 page is kind quota and never retried; a platform 429 that outlives the retries is quota too', async () => {
  let calls = 0;
  const answer = (status: number, body: string) =>
    new WorkerBackend({
      baseUrl: 'https://feed-state.theshelter.app',
      token: async () => 'a.b.c',
      fetchImpl: (async () => (calls++, new Response(body, { status, headers: { 'content-type': 'text/plain' } }))) as typeof fetch,
      sleep: async () => {},
      random: () => 0,
    });
  await assert.rejects(answer(429, 'error code: 1027').budget(), (e: unknown) => e instanceof StateStoreError && e.kind === 'quota' && !e.retryable);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(answer(429, 'Too many requests').budget(), (e: unknown) => e instanceof StateStoreError && e.kind === 'quota' && e.retryable);
  assert.equal(calls, 4);
});

// --- Budget lanes ------------------------------------------------------------------------------------------------------

test('state budget lanes: background refused above 60 % of a ceiling, critical only above 95 %; refusals on the critical lane counted', () => {
  const sql = sqliteSql();
  const ceilings = { CLASS_A_PER_DAY: 100, CLASS_B_PER_DAY: 1000, BYTES_WRITTEN_PER_DAY: 1e9, STORED_BYTES_MAX: 1e9 };
  const at = (priority: 'critical' | 'background', classA = 1) => reserve(sql, { nowMs: T0, cost: { classA }, ceilings, priority });
  assert.deepEqual(at('background', 60), { ok: true });
  assert.deepEqual(at('background'), { ok: false, ceiling: 'class_a' }, 'background: 61 > 60');
  assert.deepEqual(at('critical', 35), { ok: true });
  assert.deepEqual(at('critical'), { ok: false, ceiling: 'class_a' }, 'critical: 96 > 95');
  const snap = snapshot(sql, { nowMs: T0, ceilings });
  assert.deepEqual([snap.used.refused, snap.used.refused_critical, snap.lanes], [2, 1, { critical: 0.95, background: 0.6 }]);
  // Meta bytes survive a GC re-seed (GC lists cas/ only).
  reserve(sql, { nowMs: T0 + DAY, cost: { metaBytes: 300, extraWritten: 600 }, ceilings });
  assert.equal(snapshot(sql, { nowMs: T0 + DAY, ceilings }).used.bytes_written, 900);
  gcBegin(sql, { nowMs: T0 + DAY, cursor: null, keepHash: 'h', cost: { classA: 1 }, ceilings });
  gcEnd(sql, { nowMs: T0 + DAY, cursor: null, nextCursor: null, keepHash: 'h', keptBytes: 1000, deletedBytes: 0 });
  const s = snapshot(sql, { nowMs: T0 + DAY, ceilings });
  assert.deepEqual([s.stored_bytes, s.meta_bytes], [1300, 300]);
  refundRef(sql, { nowMs: T0 + DAY, metaBytes: 100, conflict: true });
  const t = snapshot(sql, { nowMs: T0 + DAY, ceilings });
  assert.deepEqual([t.stored_bytes, t.meta_bytes, t.used.ref_conflicts], [1200, 200, 1]);
  // migrate is idempotent (every Durable Object start runs it).
  migrate(sql, [REFS_SCHEMA]);
  migrate(sql, [REFS_SCHEMA]);
});

test('state budget ledger: a protocol-1 object migrates in place (rows kept, the new columns 0, the refs table added)', () => {
  const db = new DatabaseSync(':memory:');
  const sql: Sql = {
    exec: (q: string, ...b: unknown[]) => {
      const rows = db.prepare(q).all(...(b as SQLInputValue[]));
      return { toArray: () => rows };
    },
  };
  for (const st of SCHEMA) sql.exec(st);
  const ceilings = { CLASS_A_PER_DAY: 100, CLASS_B_PER_DAY: 100, BYTES_WRITTEN_PER_DAY: 1e9, STORED_BYTES_MAX: 1e9 };
  db.prepare("INSERT INTO days (day, class_a, requests) VALUES ('2026-11-16', 7, 7)").run();
  db.prepare('UPDATE store SET stored_bytes = 500 WHERE id = 1').run();
  migrate(sql, [REFS_SCHEMA]);
  const snap = snapshot(sql, { nowMs: T0, ceilings });
  assert.deepEqual([snap.used.class_a, snap.used.refused_critical, snap.used.ref_conflicts, snap.stored_bytes, snap.meta_bytes], [7, 0, 0, 500, 0]);
  assert.deepEqual(refGetSql(sql, 'main'), null);
  assert.deepEqual(refSwapSql(sql, { lane: 'main', expect: null, text: '{}', etag: 'e1', nowMs: T0 }), { ok: true });
  assert.deepEqual(refSwapSql(sql, { lane: 'main', expect: null, text: '{}', etag: 'e2', nowMs: T0 }), { ok: false }, 'create once');
  assert.deepEqual(refSwapSql(sql, { lane: 'main', expect: 'e0', text: '{}', etag: 'e2', nowMs: T0 }), { ok: false });
  assert.deepEqual(refSwapSql(sql, { lane: 'main', expect: 'e1', text: '{"a":1}', etag: 'e2', nowMs: T0 }), { ok: true });
  assert.deepEqual(refGetSql(sql, 'main'), { text: '{"a":1}', etag: 'e2' });
});

test('state budget lanes: through the Worker, health (background) is refused before aggregate (critical)', async () => {
  const h = harness({ env: { CLASS_B_PER_DAY: '10' } });
  const agg = h.client({ workflow: 'aggregate.yml' });
  await agg.putRef('main', refFor('main', null, h.blob('g'), h.writer({ workflow: 'aggregate.yml' }, 'b')), { create: true });
  // The PUT reserved 3 Class B (its worst case: GET, HEAD, the re-GET of a swap-time 412); 3 reads by health reach 6
  // (60 %), the next is refused; aggregate goes on to 9 (95 %).
  const health = h.client({ workflow: 'health.yml' });
  for (let i = 0; i < 3; i++) assert.ok(await health.getRef('main'));
  await assert.rejects(health.getRef('main'), (e: unknown) => e instanceof StateStoreError && e.kind === 'budget');
  for (let i = 0; i < 3; i++) assert.ok(await agg.getRef('main'));
  await assert.rejects(agg.getRef('main'), (e: unknown) => e instanceof StateStoreError && e.kind === 'budget');
  const b = await h.client({ workflow: 'health.yml' }).budget();
  assert.deepEqual([b.used.class_b, b.used.refused, b.used.refused_critical], [9, 2, 1]);
});

// --- The directory backend -------------------------------------------------------------------------------------------

test('state refs (directory backend): the same rules, create-only reflog, repair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-refs-'));
  try {
    const be = new FsBackend(dir);
    const g = async (t: string) => {
      const b = gzipSync(Buffer.from(t));
      await be.put(sha256(b), b);
      return sha256(b);
    };
    const w = (s: string) => writerId({ workflow: 'aggregate.yml', runId: '1', runAttempt: '1', step: s });
    const r1 = refFor('main', null, await g('1'), w('a'));
    const s1 = await be.putRef('main', r1, { create: true });
    await assert.rejects(be.putRef('main', r1, { create: true }), RefConflict);
    const r2 = refFor('main', r1, await g('2'), w('b'));
    await assert.rejects(be.putRef('main', { ...r2, seq: 5 }, { etag: s1.etag }), (e: unknown) => e instanceof StateStoreError && e.kind === 'refused');
    await assert.rejects(be.putRef('main', { ...r2, generation: sha256('none') }, { etag: s1.etag }), (e: unknown) => e instanceof StateStoreError && e.status === 409);
    rmSync(join(dir, 'gen', 'main', '000000000001'));
    const s2 = await be.putRef('main', r2, { etag: s1.etag });
    assert.deepEqual(s2.reflog, { previous: 'repaired', entry: 'created' });
    assert.equal((await be.getRef('main'))!.etag, s2.etag);
    assert.deepEqual((await reflogAll(be, 'main')).map((e) => e.writer), [r1.writer, r2.writer]);
    // A lost ref: a create continues the reflog (seq 3, parent r2's generation), never restarts it.
    rmSync(join(dir, 'refs', 'main'));
    await assert.rejects(be.putRef('main', refFor('main', null, await g('3'), w('c')), { create: true }), (e: unknown) => e instanceof StateStoreError && e.status === 409);
    const r3 = refFor('main', null, await g('3'), w('c'), { seq: 3, parent: r2.generation, head_seq: r2.head_seq });
    assert.deepEqual((await be.putRef('main', r3, { create: true })).reflog, { previous: 'none', entry: 'created' });
    // GC never sees refs or the reflog (it lists cas/ only).
    const page = await be.gc({ keep: [r2.generation], current: [r2.generation], cursor: null, minAgeDays: 14, maxDeletes: 10, dryRun: true });
    assert.equal(page.foreign, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- The staging rehearsal, offline -----------------------------------------------------------------------------------

const rehearsalWho: Who = { workflow: 'state-rehearsal.yml', ref: 'refs/heads/feed/state-protocol2', event: 'workflow_dispatch', runId: '777', attempt: '1' };

for (const refBackend of ['r2', 'do'] as const) {
  test(`state rehearsal refs (${refBackend}, atomic R2): every 4.0 property holds`, async () => {
    const h = harness({ staging: true, refBackend });
    const obs = await rehearseRefs({ make: (wrap) => h.client(rehearsalWho, wrap), writer: (step) => h.writer(rehearsalWho, step), run: 'abc12345' });
    assert.deepEqual(obs.filter((o) => o.verdict !== 'ok'), []);
    assert.ok(obs.length >= 15);
    assert.ok(obs.some((o) => o.check.startsWith(`two racing writers on one ref (${RACE_ROUNDS} rounds)`)));
    assert.match(observationsMarkdown(obs), /Every property of the 4\.0 gate held/);
    // Rehearsal keys stay in their own namespace.
    for (const k of h.r2.objects.keys()) assert.match(k, /^(cas\/sha256\/|refs\/rehearsal-abc12345-|gen\/rehearsal-abc12345-|rehearsal\/rehearsal-abc12345-)/);
  });
}

test('state rehearsal refs: a non-atomic R2 conditional put fails the race check and names the Durable Object fallback', async () => {
  const h = harness({ staging: true, atomic: false });
  const obs = await rehearseRefs({ make: (wrap) => h.client(rehearsalWho, wrap), writer: (step) => h.writer(rehearsalWho, step), run: 'def67890' });
  const failed = obs.filter((o) => o.verdict === 'fail').map((o) => o.check);
  assert.ok(failed.some((c) => c.startsWith('two racing writers')), failed.join('; '));
  assert.match(observationsMarkdown(obs), /REF_BACKEND = "do"/);
  // The same non-atomic bucket with the refs in the Durable Object: the races hold.
  const d = harness({ staging: true, atomic: false, refBackend: 'do' });
  const obs2 = await rehearseRefs({ make: (wrap) => d.client(rehearsalWho, wrap), writer: (step) => d.writer(rehearsalWho, step), run: 'def67891' });
  assert.ok(!obs2.some((o) => o.check.startsWith('two racing writers') && o.verdict !== 'ok'));
});

test('state rehearsal refs: a binding that ignores create-only is a warning that names the runbook bootstrap', async () => {
  const h = harness({ staging: true });
  const put = h.r2.put.bind(h.r2);
  h.r2.put = (async (key: string, value: never, opts: { onlyIf?: unknown } = {}) => {
    const create = opts.onlyIf instanceof Headers || (opts.onlyIf as { etagDoesNotMatch?: string } | undefined)?.etagDoesNotMatch === '*';
    return put(key, value, create ? { ...opts, onlyIf: undefined } : opts);
  }) as typeof h.r2.put;
  const obs = await rehearseRefs({ make: (wrap) => h.client(rehearsalWho, wrap), writer: (step) => h.writer(rehearsalWho, step), run: 'aaa00000' });
  const warned = obs.filter((o) => o.verdict === 'warn').map((o) => o.check);
  assert.ok(warned.some((c) => c.includes('If-None-Match')), warned.join('; '));
  assert.match(observationsMarkdown(obs), /runbook bootstrap/);
});
