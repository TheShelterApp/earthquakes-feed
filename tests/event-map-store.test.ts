import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { loadEventMap, pruneEventMapShards, saveEventMap } from '../src/bitemporal.js';
import { dataPaths } from '../src/config.js';
import {
  EVENT_MAP_STORE_AUTHORITATIVE,
  IGNORE_LINES,
  PersistRefused,
  SENTINEL_FILE,
  assertEventMapNotStaged,
  emptyGeneration,
  ensureIgnoreLines,
  eventMapInGit,
  eventMapStagingProblems,
  hydrate,
  main,
  parseGeneration,
  persist,
  pruneGeneration,
  readGeneration,
  serializeGeneration,
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
    const day = readFileSync(join(dataPaths(r).eventMapDir, '2026-11-15.ndjson'));
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
    rmSync(join(dataPaths(r).eventMapDir, '2026-11-14.ndjson'));
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
    assert.match(readFileSync(join(dataPaths(r).eventMapDir, '2026-11-14.ndjson'), 'utf8'), /checkout only/);
    // A generation ahead of its commit's head is refused.
    setSeq(r, 3);
    await assert.rejects(hydrate(r, be, { mode: 'shadow' }), /ahead of its commit/);
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
    const text = readFileSync(join(dataPaths(r).eventMapDir, '2026-11-15.ndjson'));
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
    const want = Object.fromEntries(readdirSync(dataPaths(r).eventMapDir).map((f) => [f, readFileSync(join(dataPaths(r).eventMapDir, f), 'utf8')]));
    // A checkout that lost a day and holds a stray one (a rebase, an old code's run): replaced wholesale.
    const emDir = dataPaths(r).eventMapDir;
    rmSync(join(emDir, '2026-11-14.ndjson'));
    writeFileSync(join(emDir, '2026-11-13-05.ndjson'), JSON.stringify(node('efd_z', '2026-11-13T05:00:00Z')) + '\n');
    writeFileSync(join(emDir, SENTINEL_FILE), 'phase 3b sentinel: not JSON\n');
    const rep = await hydrate(r, be, { mode: 'authoritative' });
    assert.deepEqual(rep.written, ['2026-11-14', '2026-11-15']);
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
    rmSync(join(dataPaths(r).eventMapDir, '2026-11-15.ndjson'));
    assert.equal(await main(['persist'], env({ FEED_STATE_BACKEND: `fs:${dir}` })), 1);
    assert.equal(marker('persist').error_kind, 'refused');
    assert.equal(await main(['nonsense'], env({})), 3);
  } finally {
    console.log = log;
    rmSync(r, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(markers, { recursive: true, force: true });
  }
});
