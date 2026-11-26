import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
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
  BLOB_GZIP_OS,
  assertEventMapNotStaged,
  emptyGeneration,
  ensureIgnoreLines,
  eventMapFiles,
  eventMapStagingProblems,
  gzipDay,
  moveToDayLayout,
  SENTINEL_FILES,
  SENTINEL_PATHS,
  trackedEventMapPaths,
  SHADOW_RETRY_POLICY,
  SHADOW_STEP_DEADLINE_MS,
  hydrate,
  main,
  markStarted,
  markerFile,
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

// Storage phase 3 (src/event-map-store.ts): the generation document, persist to the store, derive's prune of the
// generation, phase 3a's shadow hydrate (kept for the rehearsal and the dry runs), phase 3b's authoritative hydrate,
// the transition and the staging assert, on temporary data roots with the directory backend (and a failing one).
// tests/phase3b.test.ts runs the phase-3b cycle on git repositories (the transition commit, a rebase, the midnight
// prune, the rollback's re-track, and what code from before phase 3 does with the sentinels).

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

// The checkouts below start in phase 3a's layout (hour shards: saveEventMap's default while git tracks the event map),
// so every store path is exercised across layouts: a day's store bytes are canonicalDay of its files. A later save in a
// test (no repository: phase 3b's default) writes day files.
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
  saveEventMap(r, mapOf(node('efd_a', '2026-11-14T01:00:00Z'), node('efd_b', '2026-11-15T02:00:00Z'), node('efd_c', '2026-11-15T03:00:00Z')), { hours: 1 });
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

test('gzipDay: the blob\'s gzip header names Unix whatever the platform, so a Mac persists the runners\' blob keys', async () => {
  // zlib writes its build platform into byte 9 (3 on Linux, 19 on macOS); the 2026-11-26 rehearsal's seed on a Mac
  // re-keyed every day of production's generation until the byte was pinned (46 of 46 keys equal since).
  const text = '{"feedId":"efd_a"}\n{"feedId":"efd_b"}\n';
  const gz = gzipDay(text);
  assert.equal(BLOB_GZIP_OS, 3);
  assert.deepEqual([...gz.subarray(0, 4)], [0x1f, 0x8b, 8, 0], 'gzip, deflate, no flags');
  assert.equal(gz[9], BLOB_GZIP_OS);
  assert.equal(gunzipSync(gz).toString('utf8'), text);
  const native = gzipSync(text, { level: 9 });
  assert.deepEqual(gz.subarray(10), native.subarray(10), 'only the OS byte differs from zlib\'s own output');
  // persist names exactly that blob.
  const r = dataRoot();
  const dir = tmp();
  try {
    await persist(r, new FsBackend(dir), { cutoffDay: CUTOFF });
    const e = readGeneration(r)!.generation.days['2026-11-15']!;
    assert.equal(e.blob, sha256Hex(gzipDay(dayText(r, '2026-11-15'))));
    assert.equal((await new FsBackend(dir).batchGet([e.blob])).get(e.blob)![9], BLOB_GZIP_OS);
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persist uploadAll (git still tracks event-map files: the transition run): every day PUT again, so a blob the store lost is healed before the commit untracks git\'s copy', async () => {
  const r = dataRoot();
  const dir = tmp();
  try {
    const { be, calls } = counting(new FsBackend(dir));
    await persist(r, be, { cutoffDay: CUTOFF });
    const g1 = readGeneration(r)!;
    const blobFile = (sha: string): string => join(dir, 'cas', 'sha256', sha.slice(0, 2), sha);
    // The store lost an unchanged day's blob (the risk the 3a shadow's sampling leaves open). A plain persist keeps the
    // entry without an upload, so the loss would outlive the transition; uploadAll writes it back.
    rmSync(blobFile(g1.generation.days['2026-11-15']!.blob));
    const plain = await persist(r, be, { cutoffDay: CUTOFF });
    assert.deepEqual([plain.uploaded, calls.put], [[], 2]);
    const all = await persist(r, be, { cutoffDay: CUTOFF, uploadAll: true });
    assert.deepEqual([all.uploaded, all.written, calls.put], [['2026-11-14', '2026-11-15'], false, 4], 'the same bytes: the generation is unchanged');
    assert.ok(existsSync(blobFile(g1.generation.days['2026-11-15']!.blob)));
    // Every blob the generation names reads back and verifies.
    const back = await hydrate(r, new FsBackend(dir), { mode: 'shadow', sample: 2 });
    assert.deepEqual([back.mismatches, back.fetched.sort()], [[], ['2026-11-14', '2026-11-15']]);
    // A PUT that fails writes nothing (the run stops before its commit, git keeps the shards).
    const failing = counting(new FsBackend(dir), () => true);
    await assert.rejects(persist(r, failing.be, { cutoffDay: CUTOFF, uploadAll: true }));
    assert.equal(readGeneration(r)!.sha256, g1.sha256);
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

test('the phase-3b staging assert: on (the store is authoritative); only deletions and the sentinels with their own bytes pass', () => {
  assert.equal(EVENT_MAP_STORE_AUTHORITATIVE, true, 'phase 3b');
  assert.deepEqual(SENTINEL_FILES, ['0000-00-00.ndjson', '9999-12-31.ndjson']);
  const lines = [
    'M\tknowledge/index/event_map/2026-11-15.ndjson',
    'A\tknowledge/index/event_map/0000-00-00.ndjson',
    'A\tknowledge/index/event_map/9999-12-31.ndjson',
    'D\tknowledge/index/event_map/2026-10-01-00.ndjson',
    'A\tknowledge/index/event_map.ndjson',
    'A\tknowledge/index/event_map/2026-11-15-03.ndjson',
  ];
  assert.deepEqual(eventMapStagingProblems(lines), ['M knowledge/index/event_map/2026-11-15.ndjson', 'A knowledge/index/event_map.ndjson', 'A knowledge/index/event_map/2026-11-15-03.ndjson']);
  const fakeGit = (diff: string, shown: string = SENTINEL_TEXT) => (args: string[]): string => (args[0] === 'show' ? shown : diff);
  assert.throws(() => assertEventMapNotStaged(fakeGit(lines.join('\n'))), /event map staged for a commit \(phase 3b/);
  assert.deepEqual(assertEventMapNotStaged(fakeGit('D\tknowledge/index/event_map/2026-11-15.ndjson\n')), { checked: true, problems: [] });
  assert.deepEqual(assertEventMapNotStaged(fakeGit(`A\t${SENTINEL_PATHS[0]}\nA\t${SENTINEL_PATHS[1]}\n`)), { checked: true, problems: [] });
  // A sentinel staged with other bytes (a hand edit, a JSON line that old code would read as a node): refused.
  assert.throws(() => assertEventMapNotStaged(fakeGit(`M\t${SENTINEL_PATHS[1]}\n`, '{"feedId":"x"}\n')), /9999-12-31\.ndjson staged with other bytes than the sentinel's line/);
  const r = mkdtempSync(join(tmpdir(), 'efd-ignore-'));
  try {
    writeFileSync(join(r, '.gitignore'), 'node_modules/\n.data/');
    assert.equal(ensureIgnoreLines(r), true);
    assert.equal(readFileSync(join(r, '.gitignore'), 'utf8'), `node_modules/\n.data/\n${IGNORE_LINES.join('\n')}\n`);
    assert.deepEqual([...IGNORE_LINES], ['knowledge/index/event_map/*', '!knowledge/index/event_map/0000-00-00.ndjson', '!knowledge/index/event_map/9999-12-31.ndjson']);
    assert.equal(ensureIgnoreLines(r), false);
    // Not a repository: nothing tracked, so the layout move may run.
    assert.deepEqual(trackedEventMapPaths(r), []);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('the steps (phase 3b): markers for the health workflow; no store, a store error, a bad blob or a lost day stops the run; the shadow mode never does', async () => {
  const r = dataRoot();
  const dir = tmp();
  const markers = tmp();
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ DATA_DIR: r, FEED_STATE_MARKER_DIR: markers, GITHUB_RUN_ID: '42', ...extra });
  const marker = (step: string): Record<string, unknown> => JSON.parse(readFileSync(join(markers, `${step}.json`), 'utf8')) as Record<string, unknown>;
  const logs: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (l: string) => void logs.push(String(l));
  console.error = () => {};
  try {
    // No store configured: phase 3a's kill switch is gone, the step fails closed (exit 1) with a config marker.
    for (const backend of [undefined, 'off', '']) {
      assert.equal(await main(['persist'], env(backend == null ? {} : { FEED_STATE_BACKEND: backend })), 1, `FEED_STATE_BACKEND=${backend}`);
      assert.deepEqual([marker('persist').ok, marker('persist').off, marker('persist').error_kind], [false, undefined, 'config']);
      assert.equal(await main(['hydrate'], env(backend == null ? {} : { FEED_STATE_BACKEND: backend })), 1);
      assert.equal(marker('hydrate').ok, false);
    }
    assert.ok(logs.some((l) => l.startsWith('::error title=State persist::no state store configured')), 'an error annotation, not a warning');
    assert.equal(await main(['persist'], env({ FEED_STATE_BACKEND: 'bogus' })), 1);
    assert.equal(marker('persist').error_kind, 'config');
    assert.equal(await main(['persist'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 0);
    assert.equal(marker('persist').ok, true);
    assert.equal(marker('persist').run_id, '42');
    // The authoritative hydrate (the default): every day already identical on disk, rewritten as day files.
    assert.equal(await main(['hydrate'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 0);
    assert.deepEqual([marker('hydrate').ok, marker('hydrate').mode, marker('hydrate').mismatches], [true, 'authoritative', []]);
    assert.match(String(marker('hydrate').summary), /^2 day\(s\) written, 0 fetched \(0\.0 MB in 0 batch\(es\)\) from .* \(the rest already identical on disk\)/);
    assert.deepEqual(readdirSync(dataPaths(r).eventMapDir).sort(), ['2026-11-14.ndjson', '2026-11-15.ndjson']);
    // A day lost from disk is fetched back.
    rmDay(r, '2026-11-15');
    assert.equal(await main(['hydrate'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 0);
    assert.match(String(marker('hydrate').summary), /^2 day\(s\) written, 1 fetched/);
    // The store lost the blob: the run stops (exit 1) and the checkout is left as it was (nothing removed or written).
    rmDay(r, '2026-11-15');
    rmSync(join(dir, 'cas'), { recursive: true });
    const before = readdirSync(dataPaths(r).eventMapDir).sort();
    assert.equal(await main(['hydrate'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 1);
    assert.deepEqual([marker('hydrate').ok, marker('hydrate').error_kind], [false, 'missing']);
    assert.deepEqual(readdirSync(dataPaths(r).eventMapDir).sort(), before);
    // phase 3a's shadow mode (state-rehearsal, the dry runs) still never fails its caller.
    assert.equal(await main(['hydrate', '--mode', 'shadow'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 0);
    assert.deepEqual([marker('hydrate').ok, marker('hydrate').mode], [false, 'shadow']);
    // A lost day is a refusal; a store error fails the run too (phase 3b: the commit must not go out without its state).
    assert.equal(await main(['persist'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 1);
    assert.equal(marker('persist').error_kind, 'refused');
    assert.equal(await main(['nonsense'], env({})), 3);
    // A step killed by its timeout-minutes before it reports leaves the marker it wrote when it started: a failed step
    // health sees (feed:state-shadow), never a missing marker. Every step that ends overwrites it.
    markStarted('hydrate', { at: '2026-11-16T12:00:00.000Z', run_id: '43' }, env({}));
    assert.deepEqual([marker('hydrate').ok, marker('hydrate').error_kind, marker('hydrate').run_id], [false, 'killed', '43']);
    // derive-publish's re-hydrate runs in the same job and directory: FEED_STATE_MARKER_NAME keeps its marker beside the
    // first hydrate's instead of over it (health reads every file of the artifact). A bad name falls back to the step's.
    assert.equal(await main(['hydrate'], env({ FEED_STATE_BACKEND: 'bogus', FEED_STATE_MARKER_NAME: 'hydrate-publish' })), 1);
    assert.deepEqual([marker('hydrate-publish').step, marker('hydrate-publish').error_kind, marker('hydrate').error_kind], ['hydrate', 'config', 'killed']);
    assert.equal(markerFile('hydrate', env({ FEED_STATE_MARKER_NAME: '../x' })), join(markers, 'hydrate.json'));
    assert.equal(markerFile('persist', env({})), join(markers, 'persist.json'));
    // The bounds: phase 3b's hydrate fails closed within a minute of store requests, inside its 3-minute timeout-minutes;
    // persist keeps the client's defaults (its timeout-minutes is 4); phase 3a's shadow policy stays for the shadow mode.
    assert.equal(SHADOW_RETRY_POLICY.attempts, 2);
    assert.ok(SHADOW_STEP_DEADLINE_MS.hydrate + SHADOW_STEP_DEADLINE_MS.persist <= 90_000);
    assert.deepEqual(stepPolicy('hydrate', 'shadow', 1_000), { ...SHADOW_RETRY_POLICY, deadlineMs: 1_000 + SHADOW_STEP_DEADLINE_MS.hydrate });
    assert.equal(stepPolicy('persist', null, 1_000), undefined, 'phase 3b: the client\'s default policy');
    assert.deepEqual(stepPolicy('hydrate', 'authoritative', 1_000), { ...AUTHORITATIVE_HYDRATE_POLICY, deadlineMs: 1_000 + AUTHORITATIVE_HYDRATE_DEADLINE_MS });
    assert.ok(AUTHORITATIVE_HYDRATE_DEADLINE_MS <= 60_000, 'inside the step\'s 3-minute timeout-minutes');
  } finally {
    console.log = log;
    console.error = err;
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(markers, { recursive: true, force: true });
  }
});

test('the data-branch bootstrap and reset scripts write phase 3b\'s layout: the canonical empty generation, both sentinels, the ignore lines, and no legacy event_map.ndjson', () => {
  for (const f of ['scripts/bootstrap-data-branch.sh', 'scripts/reset-data-branch.sh']) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const line = text.split('\n').find((l) => l.endsWith('> knowledge/index/generation.json'))!;
    const printed = /^printf '(.*)' > knowledge\/index\/generation\.json$/.exec(line)![1]!.replace(/\\n/g, '\n');
    assert.equal(printed, serializeGeneration(emptyGeneration()), f);
    assert.doesNotMatch(text, /event_map\.ndjson/, f);
    const ignore = /cat > \.gitignore <<'EOF'\n([\s\S]*?)\nEOF\n/.exec(text)![1]!.split('\n');
    assert.deepEqual(ignore.slice(-IGNORE_LINES.length), [...IGNORE_LINES], `${f}: the ignore lines`);
    assert.match(text, /\nfor s in 0000-00-00 9999-12-31; do\n/, `${f}: both sentinels`);
    const sentinel = /printf '%s\\n' '([^']*)' > "knowledge\/index\/event_map\/\$s\.ndjson"/.exec(text)![1]!;
    assert.equal(`${sentinel}\n`, SENTINEL_TEXT, `${f}: the sentinel's line`);
    assert.match(text, /\ngit add \.gitignore README\.md knowledge events status\n/, `${f}: the sentinels are staged with knowledge (un-ignored)`);
  }
});

test('the phase-3b transition (untrack): every tracked event-map path leaves the index and stays on disk; the sentinels and the ignore lines are staged; idempotent', async () => {
  const { execFileSync } = await import('node:child_process');
  const r = dataRoot();
  try {
    const git = (args: string[]): string => execFileSync('git', ['-C', r, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    git(['init', '-q']);
    writeFileSync(join(r, '.gitignore'), 'node_modules/\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'phase 3a']);
    const tracked = ['knowledge/index/event_map/2026-11-14-01.ndjson', 'knowledge/index/event_map/2026-11-15-02.ndjson', 'knowledge/index/event_map/2026-11-15-03.ndjson'];
    assert.deepEqual(trackedEventMapPaths(r), tracked);
    // The layout move refuses while git tracks the files: it would rewrite tracked paths before the untrack.
    assert.throws(() => moveToDayLayout(r), /git still tracks 3 event-map file\(s\)/);
    assert.deepEqual(untrackEventMap(r, git), tracked);
    assert.deepEqual(trackedEventMapPaths(r), []);
    for (const f of SENTINEL_FILES) assert.equal(readFileSync(join(dataPaths(r).eventMapDir, f), 'utf8'), SENTINEL_TEXT);
    assert.throws(() => JSON.parse(SENTINEL_TEXT), 'code before phase 3 throws on it');
    assert.deepEqual(moveToDayLayout(r), ['2026-11-14', '2026-11-15'], 'after the untrack');
    git(['add', 'knowledge']);
    assert.deepEqual(assertEventMapNotStaged(git), { checked: true, problems: [] });
    assert.deepEqual(git(['diff', '--cached', '--name-status']).trim().split('\n').sort(), [
      'A\tknowledge/index/event_map/0000-00-00.ndjson',
      'A\tknowledge/index/event_map/9999-12-31.ndjson',
      ...tracked.map((p) => `D\t${p}`),
      'M\t.gitignore',
    ]);
    assert.ok(existsSync(join(dataPaths(r).eventMapDir, '2026-11-15.ndjson')), 'the day files on disk, ignored');
    git(['commit', '-q', '-m', 'phase 3b']);
    assert.deepEqual(untrackEventMap(r, git), [], 'idempotent');
    assert.equal(git(['status', '--porcelain']), '', 'nothing staged or untracked-and-visible');
    assert.deepEqual([...loadEventMap(r).keys()], ['efd_a', 'efd_b', 'efd_c'], 'the sentinels are no day');
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test('authoritative hydrate while git still tracks event-map files (the transition run, or after a re-track): the checkout is the truth, compared and kept, nothing fetched', async () => {
  const r = dataRoot();
  const dir = tmp();
  try {
    await persist(r, new FsBackend(dir), { cutoffDay: CUTOFF });
    const files = readdirSync(dataPaths(r).eventMapDir).sort();
    // The checkout moved ahead of the generation (a phase-3a persist that failed): git's truth, not a store fault.
    const m = loadEventMap(r);
    m.get('efd_a')!.place = 'ahead';
    m.get('efd_a')!.lastSeq = 3;
    saveEventMap(r, m, { hours: 1 });
    let built = 0;
    const rep = await hydrate(r, () => (built++, new FsBackend(dir)), { mode: 'authoritative', tracked: ['knowledge/index/event_map/2026-11-14-01.ndjson'] });
    assert.deepEqual([rep.tracked, rep.written, rep.fetched, built], [1, [], [], 0]);
    assert.deepEqual(rep.mismatches, ["2026-11-14: the checkout's day differs from the generation's (persist uploads it)"]);
    assert.deepEqual(readdirSync(dataPaths(r).eventMapDir).sort(), files, 'not replaced, no layout move');
    assert.match(dayText(r, '2026-11-14'), /"place":"ahead"/);
    // The run's persist then uploads it, and the next (untracked) hydrate finds every day identical.
    await persist(r, new FsBackend(dir), { cutoffDay: CUTOFF });
    const next = await hydrate(r, new FsBackend(dir), { mode: 'authoritative' });
    assert.deepEqual([next.tracked, next.fetched, next.written], [0, [], ['2026-11-14', '2026-11-15']]);
  } finally {
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
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
