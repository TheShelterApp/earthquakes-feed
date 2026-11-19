import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { loadEventMap, pruneEventMapShards, saveEventMap } from '../src/bitemporal.js';
import { dataPaths } from '../src/config.js';
import {
  AUTHORITATIVE_HYDRATE_DEADLINE_MS,
  AUTHORITATIVE_HYDRATE_POLICY,
  EVENT_MAP_STORE_AUTHORITATIVE,
  SHADOW_SAMPLE_DAYS,
  IGNORE_LINES,
  PersistRefused,
  SENTINEL_FILE,
  SENTINEL_TEXT,
  assertEventMapNotStaged,
  emptyGeneration,
  ensureIgnoreLines,
  eventMapFiles,
  eventMapInGit,
  eventMapStagingProblems,
  SHADOW_RETRY_POLICY,
  SHADOW_STEP_DEADLINE_MS,
  hydrate,
  main,
  markStarted,
  parseGeneration,
  persist,
  pruneGeneration,
  readCanonicalDay,
  readGeneration,
  serializeGeneration,
  shadowRotation,
  shadowSample,
  stepPolicy,
  untrackEventMap,
  writeGeneration,
  type Generation,
} from '../src/event-map-store.js';
import { FsBackend, StateStoreError, sha256Hex, type StateBackend } from '../src/state-store.js';
import type { EventNode } from '../src/types.js';

// Storage phase 3a (src/event-map-store.ts): the generation document, persist to the store, derive's prune of the
// generation, the shadow hydrate that compares the store with the checkout, the phase-3b authoritative hydrate and the
// staging assert, on temporary data roots with the directory backend (and a failing one).

const NOW = Date.parse('2026-11-16T12:00:00Z');
const CUTOFF = '2026-10-02';

function node(feedId: string, iso: string, lastSeq = 1): EventNode {
  return {
    feedId,
    aliases: [`usgs:${feedId}`],
    eventTimeMs: Date.parse(iso),
    firstIngestTime: iso,
    lastIngestTime: iso,
    lat: 1,
    lon: 2,
    depth: 10,
    mag: 4.5,
    magType: 'mb',
    status: null,
    place: 'x',
    chosenProvider: 'usgs',
    provenance: [],
    revision: 1,
    firstSeenSeq: 1,
    lastSeq,
    state: 'live',
    geohash: 'g',
  };
}

const mapOf = (...ns: EventNode[]): Map<string, EventNode> => new Map(ns.map((n) => [n.feedId, n]));

// The checkouts below are in phase 3a's layout (saveEventMap's default while git tracks the event map: hour shards),
// so every store path is exercised across layouts: a day's store bytes are canonicalDay of its files.
/** The canonical NDJSON of `day` from the checkout's files of it, whatever their layout. */
const dayText = (r: string, day: string): string => readCanonicalDay(r, eventMapFiles(r).get(day) ?? []).text;
/** Remove every file of `day` from the checkout. */
const rmDay = (r: string, day: string): void => {
  for (const f of eventMapFiles(r).get(day) ?? []) rmSync(join(dataPaths(r).eventMapDir, f));
};

function dataRoot(seq = 10): string {
  const r = mkdtempSync(join(tmpdir(), 'efd-em-store-'));
  mkdirSync(dataPaths(r).indexDir, { recursive: true });
  writeFileSync(dataPaths(r).head, JSON.stringify({ seq, ingest_time: '2026-11-16T11:55:00.000Z' }) + '\n');
  saveEventMap(r, mapOf(node('efd_a', '2026-11-14T01:00:00Z'), node('efd_b', '2026-11-15T02:00:00Z'), node('efd_c', '2026-11-15T03:00:00Z')));
  return r;
}
const setSeq = (r: string, seq: number): void => writeFileSync(dataPaths(r).head, JSON.stringify({ seq, ingest_time: '2026-11-16T12:00:00.000Z' }) + '\n');

/** A backend that counts calls and fails PUTs on demand. */
function counting(inner: StateBackend, failPut: () => boolean = () => false) {
  const calls = { put: 0, get: 0 };
  const be: StateBackend = {
    label: 'counting',
    put: async (h, b) => {
      calls.put++;
      if (failPut()) throw new StateStoreError('PUT: HTTP 503 after 4 attempts', 'transport', 503, true);
      return inner.put(h, b);
    },
    batchGet: async (s) => {
      calls.get++;
      return inner.batchGet(s);
    },
    gc: (r) => inner.gc(r),
    budget: () => inner.budget(),
  };
  return { be, calls };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'efd-store-dir-'));

test('generation.json: canonical bytes, one day a line; unknown formats, layouts, schemas and hand edits are refused', () => {
  const g: Generation = {
    format: 1,
    head_seq: 7,
    parent: null,
    days: {
      '2026-11-15': { sha256: 'b'.repeat(64), bytes: 20, nodes: 2, blob: 'c'.repeat(64), blob_bytes: 30 },
      '2026-11-14': { sha256: 'a'.repeat(64), bytes: 10, nodes: 1, blob: 'd'.repeat(64), blob_bytes: 15 },
    },
  };
  const text = serializeGeneration(g);
  assert.equal(
    text,
    [
      '{',
      '"format": 1,',
      '"head_seq": 7,',
      '"parent": null,',
      '"components": {"event_map": {"layout": "day", "node_schema": 1, "days": {',
      `"2026-11-14": {"sha256": "${'a'.repeat(64)}", "bytes": 10, "nodes": 1, "blob": "${'d'.repeat(64)}", "blob_bytes": 15},`,
      `"2026-11-15": {"sha256": "${'b'.repeat(64)}", "bytes": 20, "nodes": 2, "blob": "${'c'.repeat(64)}", "blob_bytes": 30}`,
      '}}}',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(parseGeneration(text), { ...g, days: { '2026-11-14': g.days['2026-11-14'], '2026-11-15': g.days['2026-11-15'] } });
  assert.equal(serializeGeneration(emptyGeneration()), '{\n"format": 1,\n"head_seq": 0,\n"parent": null,\n"components": {"event_map": {"layout": "day", "node_schema": 1, "days": {\n}}}\n}\n');
  assert.throws(() => parseGeneration(text.replace('"format": 1', '"format": 2')), /format 2, this code reads format 1 only/);
  assert.throws(() => parseGeneration(text.replace('"layout": "day"', '"layout": "hour"')), /layout "hour"/);
  assert.throws(() => parseGeneration(text.replace('"node_schema": 1', '"node_schema": 2')), /node_schema 2/);
  assert.throws(() => parseGeneration(text.replace('"head_seq": 7,', '"head_seq":7,')), /canonical form/);
  assert.throws(() => parseGeneration(text.replace('"bytes": 10', '"bytes": -1')), /entry of 2026-11-14/);
  assert.throws(() => parseGeneration(text.replace('2026-11-14', '0000-00-00')), /day "0000-00-00"/);
});

test('persist: every day uploaded once as gzip, the generation names the blobs; unchanged days are never uploaded again', async () => {
  const r = dataRoot();
  const dir = tmp();
  try {
    const { be, calls } = counting(new FsBackend(dir));
    const first = await persist(r, be, { cutoffDay: CUTOFF });
    assert.deepEqual([first.written, first.days, first.uploaded, first.headSeq], [true, 2, ['2026-11-14', '2026-11-15'], 10]);
    const g1 = readGeneration(r)!;
    assert.equal(g1.generation.parent, null);
    assert.deepEqual(eventMapFiles(r).get('2026-11-15'), ['2026-11-15-02.ndjson', '2026-11-15-03.ndjson'], 'phase 3a: hour shards on disk');
    const day = Buffer.from(dayText(r, '2026-11-15'));
    const e = g1.generation.days['2026-11-15']!;
    assert.deepEqual([e.sha256, e.bytes, e.nodes], [sha256Hex(day), day.length, 2]);
    // Nothing changed: no PUT, no rewrite (the aggregate commit then carries no generation change).
    const before = readFileSync(dataPaths(r).generation, 'utf8');
    setSeq(r, 11);
    const same = await persist(r, be, { cutoffDay: CUTOFF });
    assert.deepEqual([same.written, same.uploaded, calls.put], [false, [], 2]);
    assert.equal(readFileSync(dataPaths(r).generation, 'utf8'), before);
    // One day changes, one is new: two PUTs; parent = the sha256 of the previous document, head_seq of the run.
    const m = loadEventMap(r);
    m.get('efd_b')!.lastSeq = 11;
    m.get('efd_b')!.place = 'revised';
    m.set('efd_d', node('efd_d', '2026-11-16T01:00:00Z', 11));
    saveEventMap(r, m);
    const next = await persist(r, be, { cutoffDay: CUTOFF });
    assert.deepEqual([next.written, next.uploaded, calls.put], [true, ['2026-11-15', '2026-11-16'], 4]);
    const g2 = readGeneration(r)!;
    assert.equal(g2.generation.parent, g1.sha256);
    assert.equal(g2.generation.head_seq, 11);
    assert.deepEqual(g2.generation.days['2026-11-14'], g1.generation.days['2026-11-14']);
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persist never infers a removal from a missing file: a lost day throws; a day pruned below the horizon leaves', async () => {
  const r = dataRoot();
  const dir = tmp();
  try {
    const be = new FsBackend(dir);
    await persist(r, be, { cutoffDay: CUTOFF });
    const before = readFileSync(dataPaths(r).generation, 'utf8');
    rmDay(r, '2026-11-14');
    await assert.rejects(persist(r, be, { cutoffDay: CUTOFF }), (e: unknown) => e instanceof PersistRefused && /lacks \(2026-11-14\)/.test(e.message));
    assert.equal(readFileSync(dataPaths(r).generation, 'utf8'), before, 'nothing written');
    // Below the horizon (derive pruned it): it leaves the generation.
    const pruned = await persist(r, be, { cutoffDay: '2026-11-15' });
    assert.deepEqual([pruned.dropped, Object.keys(readGeneration(r)!.generation.days)], [['2026-11-14'], ['2026-11-15']]);
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persist: a store error writes nothing, so the generation only names blobs that exist; the next run uploads again', async () => {
  const r = dataRoot();
  const dir = tmp();
  try {
    let fail = true;
    const { be, calls } = counting(new FsBackend(dir), () => fail);
    await assert.rejects(persist(r, be, { cutoffDay: CUTOFF }), /HTTP 503/);
    assert.equal(existsSync(dataPaths(r).generation), false);
    fail = false;
    const ok = await persist(r, be, { cutoffDay: CUTOFF });
    assert.deepEqual(ok.uploaded, ['2026-11-14', '2026-11-15']);
    assert.ok(calls.put >= 3);
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneGeneration: derive\'s prune is a pure edit of the generation, beside the deletion of the day files', async () => {
  const r = dataRoot();
  const dir = tmp();
  try {
    await persist(r, new FsBackend(dir), { cutoffDay: CUTOFF });
    const g1 = readGeneration(r)!;
    assert.deepEqual(pruneGeneration(r, '2026-11-14'), [], 'nothing below the cutoff: nothing written');
    assert.equal(readGeneration(r)!.sha256, g1.sha256);
    setSeq(r, 12);
    assert.deepEqual(pruneEventMapShards(r, Date.parse('2026-11-15T00:00:00Z')), ['2026-11-14']);
    assert.deepEqual(pruneGeneration(r, '2026-11-15'), ['2026-11-14']);
    const g2 = readGeneration(r)!.generation;
    assert.deepEqual([Object.keys(g2.days), g2.parent, g2.head_seq], [['2026-11-15'], g1.sha256, 12]);
    assert.deepEqual([...loadEventMap(r).keys()], ['efd_b', 'efd_c']);
    rmSync(dataPaths(r).generation);
    assert.deepEqual(pruneGeneration(r, '2026-12-01'), [], 'no generation: nothing to prune');
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shadow hydrate: verified blobs compared with the checkout; mismatches reported, the checkout never written', async () => {
  const r = dataRoot();
  const dir = tmp();
  try {
    const be = new FsBackend(dir);
    const none = await hydrate(r, be, { mode: 'shadow' });
    assert.equal(none.noGeneration, true, 'before the first persist: nothing to compare');
    await persist(r, be, { cutoffDay: CUTOFF });
    const same = await hydrate(r, be, { mode: 'shadow' });
    assert.deepEqual([same.days, same.mismatches], [2, []]);
    // The checkout moves on without a persist (a failed store PUT, or an old code's run): reported, not repaired.
    const m = loadEventMap(r);
    m.get('efd_a')!.place = 'checkout only';
    m.get('efd_a')!.lastSeq = 3;
    m.set('efd_e', node('efd_e', '2026-11-16T05:00:00Z'));
    saveEventMap(r, m);
    const files = readdirSync(dataPaths(r).eventMapDir).sort();
    const diff = await hydrate(r, be, { mode: 'shadow' });
    assert.equal(diff.mismatches.length, 2);
    assert.match(diff.mismatches[0]!, /^2026-11-14: the store's day .* differs from the checkout's/);
    assert.equal(diff.mismatches[1], '2026-11-16: in the checkout, not in the generation');
    assert.deepEqual(readdirSync(dataPaths(r).eventMapDir).sort(), files);
    assert.match(dayText(r, '2026-11-14'), /checkout only/);
    // A generation ahead of its commit's head is refused.
    setSeq(r, 3);
    await assert.rejects(hydrate(r, be, { mode: 'shadow' }), /ahead of its commit/);
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hydrate builds a backend given as a factory only when its local work is done and a fetch is due (the step deadline starts there)', async () => {
  const r = dataRoot();
  const dir = tmp();
  try {
    const be = new FsBackend(dir);
    await persist(r, be, { cutoffDay: CUTOFF });
    let built = 0;
    const factory = (): FsBackend => {
      built++;
      return be;
    };
    // Nothing differs and no sample: no store request, so no backend (and no deadline) at all.
    const quiet = await hydrate(r, factory, { mode: 'shadow', sample: 0 });
    assert.deepEqual([quiet.fetched, built], [[], 0]);
    // The sample: one backend, built once for the whole fetch.
    const sampled = await hydrate(r, factory, { mode: 'shadow', sample: 2 });
    assert.deepEqual([sampled.fetched.length, sampled.mismatches, built], [2, [], 1]);
    assert.ok(sampled.localMs >= 0);
    // Authoritative with every day already on disk: nothing to fetch, no backend.
    const auth = await hydrate(r, factory, { mode: 'authoritative' });
    assert.deepEqual([auth.written.length, auth.fetched, built], [2, [], 1]);
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hydrate fails closed on a missing or corrupt blob; another gzip of the same NDJSON hydrates (the blob is keyed by its gzip)', async () => {
  const r = dataRoot();
  const dir = tmp();
  try {
    const be = new FsBackend(dir);
    await persist(r, be, { cutoffDay: CUTOFF });
    const g = readGeneration(r)!.generation;
    // Another zlib (a Node upgrade) gzips the same day differently: a different blob, the same NDJSON entry.
    const text = Buffer.from(dayText(r, '2026-11-15'));
    const other = gzipSync(text, { level: 1 });
    assert.notEqual(sha256Hex(other), g.days['2026-11-15']!.blob);
    await be.put(sha256Hex(other), other);
    writeGeneration(r, { ...g, days: { ...g.days, '2026-11-15': { ...g.days['2026-11-15']!, blob: sha256Hex(other), blob_bytes: other.length } } });
    assert.deepEqual((await hydrate(r, be, { mode: 'shadow' })).mismatches, []);
    // A blob that is gone: MISSING, fail closed.
    rmSync(join(dir, 'cas', 'sha256', g.days['2026-11-14']!.blob.slice(0, 2), g.days['2026-11-14']!.blob));
    await assert.rejects(hydrate(r, be, { mode: 'shadow' }), (e: unknown) => e instanceof StateStoreError && e.kind === 'missing');
    // A blob that decompresses to other NDJSON than its entry names.
    const wrong = gzipSync('{"feedId":"efd_x"}\n');
    await be.put(sha256Hex(wrong), wrong);
    writeGeneration(r, { ...g, days: { '2026-11-15': { ...g.days['2026-11-15']!, blob: sha256Hex(wrong), blob_bytes: wrong.length } } });
    await assert.rejects(hydrate(r, be, { mode: 'shadow' }), /is not the generation's/);
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('authoritative hydrate (phase 3b): exactly the generation\'s days, the sentinel kept; no generation throws unless bootstrapping', async () => {
  const r = dataRoot();
  const dir = tmp();
  try {
    const be = new FsBackend(dir);
    await persist(r, be, { cutoffDay: CUTOFF });
    // The store's layout: one day file per day, each the canonical bytes of the day's hour shards.
    const want = Object.fromEntries([...eventMapFiles(r).keys()].map((d) => [`${d}.ndjson`, dayText(r, d)]));
    // A checkout that lost a day and holds a stray one (a rebase, an old code's run): replaced wholesale.
    const emDir = dataPaths(r).eventMapDir;
    rmDay(r, '2026-11-14');
    writeFileSync(join(emDir, '2026-11-13-05.ndjson'), JSON.stringify(node('efd_z', '2026-11-13T05:00:00Z')) + '\n');
    writeFileSync(join(emDir, SENTINEL_FILE), 'phase 3b sentinel: not JSON\n');
    const rep = await hydrate(r, be, { mode: 'authoritative' });
    assert.deepEqual(rep.written, ['2026-11-14', '2026-11-15']);
    assert.deepEqual(rep.fetched, ['2026-11-14'], 'a day already identical on disk (here in hour shards) is not fetched');
    assert.deepEqual(readdirSync(emDir).sort(), [SENTINEL_FILE, ...Object.keys(want)].sort());
    for (const [f, text] of Object.entries(want)) assert.equal(readFileSync(join(emDir, f), 'utf8'), text, f);
    assert.deepEqual([...loadEventMap(r).keys()], ['efd_a', 'efd_b', 'efd_c']);
    rmSync(dataPaths(r).generation);
    await assert.rejects(hydrate(r, be, { mode: 'authoritative', env: {} }), /refusing to start from an empty event map/);
    assert.equal((await hydrate(r, be, { mode: 'authoritative', env: { EVENT_MAP_BOOTSTRAP: '1' } })).noGeneration, true);
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the phase-3b staging assert: off while git tracks the event map (3a); then only deletions and the sentinel pass', () => {
  assert.equal(EVENT_MAP_STORE_AUTHORITATIVE, false, 'phase 3a');
  assert.equal(eventMapInGit({}), true);
  assert.equal(eventMapInGit({ EVENT_MAP_IN_GIT: '0' }), false);
  assert.throws(() => eventMapInGit({ EVENT_MAP_IN_GIT: 'yes' }), /0 or 1/);
  const lines = [
    'M\tknowledge/index/event_map/2026-11-15.ndjson',
    'A\tknowledge/index/event_map/0000-00-00.ndjson',
    'D\tknowledge/index/event_map/2026-10-01-00.ndjson',
    'A\tknowledge/index/event_map.ndjson',
  ];
  assert.deepEqual(eventMapStagingProblems(lines), ['M knowledge/index/event_map/2026-11-15.ndjson', 'A knowledge/index/event_map.ndjson']);
  let asked = 0;
  const git = (): string => {
    asked++;
    return lines.join('\n');
  };
  assert.deepEqual(assertEventMapNotStaged(git, {}), { checked: false, problems: [] });
  assert.equal(asked, 0, '3a: git is not even asked');
  assert.throws(() => assertEventMapNotStaged(git, { EVENT_MAP_IN_GIT: '0' }), /event map staged for a commit while EVENT_MAP_IN_GIT=0/);
  assert.deepEqual(assertEventMapNotStaged(() => 'D\tknowledge/index/event_map/2026-11-15.ndjson\n', { EVENT_MAP_IN_GIT: '0' }), { checked: true, problems: [] });
  const r = mkdtempSync(join(tmpdir(), 'efd-ignore-'));
  try {
    writeFileSync(join(r, '.gitignore'), 'node_modules/\n.data/');
    assert.equal(ensureIgnoreLines(r), true);
    assert.equal(readFileSync(join(r, '.gitignore'), 'utf8'), `node_modules/\n.data/\n${IGNORE_LINES.join('\n')}\n`);
    assert.equal(ensureIgnoreLines(r), false);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('the steps: markers for the health workflow; the store off, a mismatch or a store error never fails a phase-3a run', async () => {
  const r = dataRoot();
  const dir = tmp();
  const markers = tmp();
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ DATA_DIR: r, FEED_STATE_MARKER_DIR: markers, GITHUB_RUN_ID: '42', ...extra });
  const marker = (step: string): Record<string, unknown> => JSON.parse(readFileSync(join(markers, `${step}.json`), 'utf8')) as Record<string, unknown>;
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await main(['persist'], env({})), 0);
    assert.deepEqual([marker('persist').ok, marker('persist').off], [true, true]);
    assert.equal(await main(['persist'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 0);
    assert.equal(marker('persist').ok, true);
    assert.equal(marker('persist').run_id, '42');
    assert.equal(await main(['hydrate'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 0);
    assert.deepEqual([marker('hydrate').ok, marker('hydrate').mode, marker('hydrate').mismatches], [true, 'shadow', []]);
    assert.match(String(marker('hydrate').summary), /^2 day\(s\) compared with the checkout; 2 fetched and verified \(0 changed, 2 sampled: 2026-11-14 2026-11-15\), 0\.0 MB in 1 batch\(es\) from .* in \d+ ms \(\d+ ms of it local\)/);
    const m = loadEventMap(r);
    m.get('efd_a')!.lastSeq = 4;
    saveEventMap(r, m);
    assert.equal(await main(['hydrate'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 0);
    assert.equal(marker('hydrate').ok, false);
    assert.equal((marker('hydrate').mismatches as string[]).length, 1);
    rmSync(join(dir, 'cas'), { recursive: true });
    assert.equal(await main(['hydrate'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 0);
    assert.deepEqual([marker('hydrate').ok, marker('hydrate').error_kind], [false, 'missing']);
    assert.equal(await main(['persist'], env({ FEED_STATE_BACKEND: 'bogus' })), 0);
    assert.equal(marker('persist').error_kind, 'config');
    // A lost day is a refusal the run shows (exit 1; the step is continue-on-error in phase 3a).
    rmDay(r, '2026-11-15');
    assert.equal(await main(['persist'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 1);
    assert.equal(marker('persist').error_kind, 'refused');
    assert.equal(await main(['nonsense'], env({})), 3);
    // A step killed by its timeout-minutes before it reports leaves the marker it wrote when it started: a failed step
    // health sees (feed:state-shadow), never a missing marker. Every step that ends overwrites it.
    markStarted('hydrate', { at: '2026-11-16T12:00:00.000Z', run_id: '43' }, env({}));
    assert.deepEqual([marker('hydrate').ok, marker('hydrate').error_kind, marker('hydrate').run_id], [false, 'killed', '43']);
    assert.equal(await main(['hydrate'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 0);
    assert.notEqual(marker('hydrate').error_kind, 'killed');
    // Phase 3a's bound on a hanging store: 2 attempts (4 a hydrate batch, each short), and step deadlines well inside the
    // 5-minute job; phase 3b's hydrate fails closed within a minute.
    assert.equal(SHADOW_RETRY_POLICY.attempts, 2);
    assert.ok(SHADOW_STEP_DEADLINE_MS.hydrate + SHADOW_STEP_DEADLINE_MS.persist <= 90_000);
    assert.deepEqual(stepPolicy('hydrate', 'shadow', 1_000), { ...SHADOW_RETRY_POLICY, deadlineMs: 1_000 + SHADOW_STEP_DEADLINE_MS.hydrate });
    assert.deepEqual(stepPolicy('persist', null, 1_000), { ...SHADOW_RETRY_POLICY, deadlineMs: 1_000 + SHADOW_STEP_DEADLINE_MS.persist });
    assert.deepEqual(stepPolicy('hydrate', 'authoritative', 1_000), { ...AUTHORITATIVE_HYDRATE_POLICY, deadlineMs: 1_000 + AUTHORITATIVE_HYDRATE_DEADLINE_MS });
    assert.ok(AUTHORITATIVE_HYDRATE_DEADLINE_MS <= 60_000, 'inside the step\'s 2-minute timeout-minutes');
    // The phase-3b-only steps (derive-publish, first-solutions) and the commit step's transition do nothing in 3a.
    rmSync(markers, { recursive: true, force: true });
    assert.equal(await main(['hydrate', '--3b-only'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 0);
    assert.equal(existsSync(join(markers, 'hydrate.json')), false);
  } finally {
    console.log = log;
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(markers, { recursive: true, force: true });
  }
});

test('the data-branch bootstrap and reset scripts write the canonical empty generation, and no legacy event_map.ndjson', () => {
  for (const f of ['scripts/bootstrap-data-branch.sh', 'scripts/reset-data-branch.sh']) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const line = text.split('\n').find((l) => l.endsWith('> knowledge/index/generation.json'))!;
    const printed = /^printf '(.*)' > knowledge\/index\/generation\.json$/.exec(line)![1]!.replace(/\\n/g, '\n');
    assert.equal(printed, serializeGeneration(emptyGeneration()), f);
    assert.doesNotMatch(text, /event_map\.ndjson/, f);
  }
});

test('the phase-3b transition (untrack, off while EVENT_MAP_IN_GIT=1): the day files leave the index and stay on disk, the sentinel and the ignore lines are staged', async () => {
  const { execFileSync } = await import('node:child_process');
  const r = dataRoot();
  try {
    const git = (args: string[]): string => execFileSync('git', ['-C', r, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    git(['init', '-q']);
    writeFileSync(join(r, '.gitignore'), 'node_modules/\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);
    assert.equal(untrackEventMap(r, git, {}), null, 'phase 3a: nothing happens');
    // Phase 3a tracked hour shards; the transition untracks whatever is tracked.
    const tracked = ['knowledge/index/event_map/2026-11-14-01.ndjson', 'knowledge/index/event_map/2026-11-15-02.ndjson', 'knowledge/index/event_map/2026-11-15-03.ndjson'];
    assert.deepEqual(untrackEventMap(r, git, { EVENT_MAP_IN_GIT: '0' }), tracked);
    assert.equal(readFileSync(join(dataPaths(r).eventMapDir, SENTINEL_FILE), 'utf8'), SENTINEL_TEXT);
    assert.throws(() => JSON.parse(SENTINEL_TEXT), 'code before phase 3a throws on it');
    git(['add', 'knowledge']);
    assert.deepEqual(assertEventMapNotStaged(git, { EVENT_MAP_IN_GIT: '0' }), { checked: true, problems: [] });
    assert.deepEqual(git(['diff', '--cached', '--name-status']).trim().split('\n').sort(), [
      'A\tknowledge/index/event_map/0000-00-00.ndjson',
      ...tracked.map((p) => `D\t${p}`),
      'M\t.gitignore',
    ]);
    assert.ok(existsSync(join(dataPaths(r).eventMapDir, '2026-11-15-02.ndjson')), 'the files stay on disk');
    git(['commit', '-q', '-m', 'phase 3b']);
    assert.deepEqual(untrackEventMap(r, git, { EVENT_MAP_IN_GIT: '0' }), [], 'idempotent');
    assert.equal(git(['status', '--porcelain']), '');
    assert.deepEqual([...loadEventMap(r).keys()], ['efd_a', 'efd_b', 'efd_c'], 'the sentinel is no day');
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The shadow hydrate's sample (phase 3a after 2026-11-19): the days that differ plus a rotating sample, not all 46.

const DAYS46 = Array.from({ length: 46 }, (_, i) => new Date(Date.parse('2026-10-04T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10));

test('shadow sample: deterministic by the run number, distinct days, every day covered by 12 consecutive runs', () => {
  assert.equal(SHADOW_SAMPLE_DAYS, 4);
  for (const r of [0, 1, 7, 1234, 44_403_949_467]) {
    const a = shadowSample(DAYS46, r);
    assert.deepEqual(shadowSample([...DAYS46].reverse(), r), a, 'the order of the input does not matter');
    assert.equal(new Set(a).size, 4);
    assert.ok(a.every((d) => DAYS46.includes(d)));
  }
  // Any 12 consecutive run numbers (an hour of 5-minute aggregate runs) verify all 46 days.
  for (const from of [0, 5, 98_765]) {
    const seen = new Set<string>();
    for (let r = from; r < from + Math.ceil(46 / 4); r++) for (const d of shadowSample(DAYS46, r)) seen.add(d);
    assert.equal(seen.size, 46, `runs ${from}..${from + 11}`);
  }
  // Consecutive runs take consecutive slices.
  assert.deepEqual(shadowSample(DAYS46, 0), DAYS46.slice(0, 4));
  assert.deepEqual(shadowSample(DAYS46, 1), DAYS46.slice(4, 8));
  assert.deepEqual(shadowSample(DAYS46, 11), [...DAYS46.slice(44), ...DAYS46.slice(0, 2)].sort());
  assert.deepEqual(shadowSample(DAYS46.slice(0, 3), 9), DAYS46.slice(0, 3), 'fewer days than the sample: all');
  assert.deepEqual(shadowSample([], 3), []);
  // The rotation: the run number, else the run id, else the 5-minute slot.
  assert.equal(shadowRotation({ GITHUB_RUN_NUMBER: '318941', GITHUB_RUN_ID: '44403949467' }), 318_941);
  assert.equal(shadowRotation({ GITHUB_RUN_ID: '44403949467' }), 44_403_949_467);
  assert.equal(shadowRotation({}, Date.parse('2026-11-19T10:07:00Z')), Math.floor(Date.parse('2026-11-19T10:05:00Z') / 300_000));
});

/** A data root with one event on each of `n` days ending 2026-11-15. */
function manyDays(n: number): string {
  const r = mkdtempSync(join(tmpdir(), 'efd-em-many-'));
  mkdirSync(dataPaths(r).indexDir, { recursive: true });
  writeFileSync(dataPaths(r).head, JSON.stringify({ seq: 10, ingest_time: '2026-11-16T11:55:00.000Z' }) + '\n');
  const nodes = Array.from({ length: n }, (_, i) => node(`efd_${String(i).padStart(3, '0')}`, new Date(Date.parse('2026-11-15T06:00:00Z') - i * 86_400_000).toISOString()));
  saveEventMap(r, mapOf(...nodes));
  return r;
}

test('shadow hydrate: fetches the days that differ and the rotating sample only, verified; sampled vs changed reported', async () => {
  const r = manyDays(10);
  const dir = tmp();
  try {
    const inner = new FsBackend(dir);
    await persist(r, inner, { cutoffDay: CUTOFF });
    const g = readGeneration(r)!.generation;
    const days = Object.keys(g.days).sort();
    assert.equal(days.length, 10);
    const dayOfBlob = new Map(Object.entries(g.days).map(([d, e]) => [e.blob, d]));
    const asked: string[] = [];
    const be: StateBackend = { ...counting(inner).be, batchGet: async (s, o) => (asked.push(...s.map((h) => dayOfBlob.get(h)!)), inner.batchGet(s, o)) };
    // Nothing differs: the sample alone, one batch.
    const quiet = await hydrate(r, be, { mode: 'shadow', rotation: 1 });
    assert.deepEqual(quiet.changed, []);
    assert.deepEqual(quiet.sampled, days.slice(4, 8));
    assert.deepEqual([quiet.fetched, quiet.mismatches, quiet.days, quiet.batches], [days.slice(4, 8), [], 10, 1]);
    assert.deepEqual(asked.sort(), days.slice(4, 8));
    assert.equal(quiet.blobBytes, days.slice(4, 8).reduce((n, d) => n + g.days[d]!.blob_bytes, 0));
    // A day that differs and a day the checkout lost: both mismatches, both fetched and verified, beside the sample.
    asked.length = 0;
    const m = loadEventMap(r);
    m.get('efd_000')!.place = 'checkout only';
    m.get('efd_000')!.lastSeq = 3;
    saveEventMap(r, m);
    rmDay(r, days[0]!);
    const busy = await hydrate(r, be, { mode: 'shadow', rotation: 0 });
    assert.deepEqual(busy.changed, [days[0], days[9]]);
    assert.deepEqual(busy.sampled, days.slice(1, 4), 'the sample without the days already fetched as changed');
    assert.deepEqual(busy.fetched, [days[0], ...days.slice(1, 4), days[9]]);
    assert.deepEqual(asked.sort(), busy.fetched);
    assert.equal(busy.mismatches.length, 2);
    // A blob lost from the store: unseen while the sample has not reached its day (git is the truth in phase 3a, the
    // next hour's runs reach it), a fail-closed `missing` once it does.
    rmSync(join(dir, 'cas', 'sha256', g.days[days[6]!]!.blob.slice(0, 2), g.days[days[6]!]!.blob));
    const unreached = await hydrate(r, be, { mode: 'shadow', rotation: 2 });
    assert.deepEqual(unreached.sampled, [days[1], days[8]], 'days 8, 9, 0, 1 without the two changed ones');
    assert.ok(!unreached.fetched.includes(days[6]!));
    await assert.rejects(hydrate(r, be, { mode: 'shadow', rotation: 1 }), (e: unknown) => e instanceof StateStoreError && e.kind === 'missing');
    // `sample` at or above the day count verifies every day (the staging rehearsal).
    await assert.rejects(hydrate(r, be, { mode: 'shadow', rotation: 0, sample: 10 }), (e: unknown) => e instanceof StateStoreError && e.kind === 'missing');
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
