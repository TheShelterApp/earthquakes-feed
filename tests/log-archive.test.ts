import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  LOG_ARCHIVE_GRACE_MS,
  archiveLogFiles,
  assetName,
  isFinishedMonth,
  loadLogArchives,
  logFilesToArchive,
  saveLogArchives,
  type ReleaseIo,
} from '../src/log-archive.js';

// LIVE-2: finished months of status/history and changes/ become immutable gzip Release assets, verified before the
// tree copy is removed; an existing asset is never replaced. A stub ReleaseIo stands in for gh.

const NOW = Date.parse('2026-10-04T10:00:00Z');

/** An in-memory Releases store that records every call; `onUpload` can corrupt or fail an upload. */
function stubReleases(onUpload?: (tag: string, name: string, bytes: Buffer) => Buffer | Error) {
  const store = new Map<string, Map<string, Buffer>>();
  const calls: string[] = [];
  const io: ReleaseIo = {
    ensureRelease(tag) {
      calls.push(`ensure ${tag}`);
      if (!store.has(tag)) store.set(tag, new Map());
    },
    assets(tag) {
      calls.push(`assets ${tag}`);
      return [...(store.get(tag) ?? new Map<string, Buffer>()).entries()].map(([name, b]) => ({ name, size: b.length }));
    },
    upload(tag, file) {
      const name = basename(file);
      calls.push(`upload ${tag}/${name}`);
      const rel = store.get(tag)!;
      if (rel.has(name)) throw new Error(`HTTP 422: asset ${name} already exists`);
      const r = onUpload ? onUpload(tag, name, readFileSync(file)) : readFileSync(file);
      if (r instanceof Error) throw r;
      rel.set(name, r);
    },
    download(tag, asset, out) {
      calls.push(`download ${tag}/${asset}`);
      const b = store.get(tag)?.get(asset);
      if (!b) throw new Error('HTTP 404: no assets to download');
      writeFileSync(out, b);
    },
  };
  return { io, store, calls };
}

/** A data root with three status months, two September change days and two October ones. */
function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'log-archive-'));
  mkdirSync(join(root, 'status', 'history'), { recursive: true });
  mkdirSync(join(root, 'changes'), { recursive: true });
  mkdirSync(join(root, 'knowledge', 'index'), { recursive: true });
  for (const m of ['2026-08', '2026-09', '2026-10']) writeFileSync(join(root, 'status', 'history', `${m}.ndjson`), `{"generated":"${m}-01T00:00:00Z","n":1}\n{"generated":"${m}-02T00:00:00Z","n":2}\n`);
  for (const d of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-04']) writeFileSync(join(root, 'changes', `${d}.ndjson`), `{"seq":1,"day":"${d}"}\n`);
  return root;
}

test('isFinishedMonth: a month is finished one day after it ends (no writer can still append to it)', () => {
  const oct1 = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(isFinishedMonth('2026-09', oct1), false);
  assert.equal(isFinishedMonth('2026-09', oct1 + LOG_ARCHIVE_GRACE_MS - 1), false);
  assert.equal(isFinishedMonth('2026-09', oct1 + LOG_ARCHIVE_GRACE_MS), true);
  assert.equal(isFinishedMonth('2026-12', Date.parse('2027-01-02T00:00:00Z')), true, 'December rolls into the next year');
  assert.equal(isFinishedMonth('2026-10', NOW), false);
  assert.equal(isFinishedMonth('nonsense', NOW), false);
});

test('logFilesToArchive: finished months of both logs, oldest first; the current month stays', () => {
  const root = dataRoot();
  assert.deepEqual(logFilesToArchive(root, NOW).map((f) => [f.kind, f.file, f.period]), [
    ['status_history', 'status/history/2026-08.ndjson', '2026-08'],
    ['changes', 'changes/2026-09-29.ndjson', '2026-09'],
    ['changes', 'changes/2026-09-30.ndjson', '2026-09'],
    ['status_history', 'status/history/2026-09.ndjson', '2026-09'],
  ]);
  assert.equal(assetName({ kind: 'status_history', file: 'status/history/2026-08.ndjson' }), 'status-history-2026-08.ndjson.gz');
  assert.equal(assetName({ kind: 'changes', file: 'changes/2026-09-29.ndjson' }), 'changes-2026-09-29.ndjson.gz');
});

test('archive: upload, download back, verify both hashes, index, then remove; the current month stays', () => {
  const root = dataRoot();
  const before = readFileSync(join(root, 'status', 'history', '2026-09.ndjson'));
  const { io, store, calls } = stubReleases();
  const idx = loadLogArchives(root);
  const res = archiveLogFiles(root, idx, NOW, io, join(root, '..', `${basename(root)}-staging`), { log: () => {} });
  assert.equal(res.archived.length, 4);
  assert.deepEqual(res.blocked, []);
  // Tree: only October left.
  assert.ok(!existsSync(join(root, 'status', 'history', '2026-08.ndjson')));
  assert.ok(!existsSync(join(root, 'changes', '2026-09-30.ndjson')));
  assert.ok(existsSync(join(root, 'status', 'history', '2026-10.ndjson')));
  assert.ok(existsSync(join(root, 'changes', '2026-10-01.ndjson')), 'October 1 is in the current month');
  // Releases: one per month, gzip of the exact bytes.
  assert.deepEqual([...store.keys()].sort(), ['logs-2026-08', 'logs-2026-09']);
  assert.deepEqual(gunzipSync(store.get('logs-2026-09')!.get('status-history-2026-09.ndjson.gz')!), before);
  // Every upload is followed by its own download (verify) before the next file.
  const seq = calls.filter((c) => c.startsWith('upload') || c.startsWith('download'));
  for (let i = 0; i < seq.length; i += 2) assert.equal(seq[i]!.replace('upload', 'download'), seq[i + 1]);
  const e = idx.entries.find((x) => x.file === 'status/history/2026-09.ndjson')!;
  assert.equal(e.tag, 'logs-2026-09');
  assert.equal(e.lines, 2);
  assert.equal(e.content_bytes, before.length);
  assert.equal(e.url, 'https://github.com/TheShelterApp/earthquakes-feed/releases/download/logs-2026-09/status-history-2026-09.ndjson.gz');
  // Saved and read back; a second run finds nothing to do.
  saveLogArchives(root, idx);
  const again = archiveLogFiles(root, loadLogArchives(root), NOW, io, join(root, '..', `${basename(root)}-staging2`), { log: () => {} });
  assert.deepEqual([again.archived.length, again.blocked.length, again.adopted.length, again.leftoversRemoved.length], [0, 0, 0, 0]);
});

test('a release asset left by a run that never committed is adopted only when its content is identical', () => {
  const root = dataRoot();
  const { io, store } = stubReleases();
  io.ensureRelease('logs-2026-08', '');
  // Same content, other gzip bytes (another compression level): adopted with its own hash.
  store.get('logs-2026-08')!.set('status-history-2026-08.ndjson.gz', gzipSync(readFileSync(join(root, 'status', 'history', '2026-08.ndjson')), { level: 1 }));
  io.ensureRelease('logs-2026-09', '');
  // Other content under the same name: never replaced, the file stays.
  store.get('logs-2026-09')!.set('changes-2026-09-29.ndjson.gz', gzipSync(Buffer.from('{"seq":999}\n')));
  const idx = loadLogArchives(root);
  const res = archiveLogFiles(root, idx, NOW, io, join(root, '..', `${basename(root)}-st`), { log: () => {} });
  assert.deepEqual(res.adopted, ['status-history-2026-08.ndjson.gz']);
  assert.equal(res.blocked.length, 1);
  assert.match(res.blocked[0]!, /changes\/2026-09-29\.ndjson: logs-2026-09\/changes-2026-09-29\.ndjson\.gz exists with other content; never replaced/);
  assert.ok(existsSync(join(root, 'changes', '2026-09-29.ndjson')));
  assert.ok(!existsSync(join(root, 'status', 'history', '2026-08.ndjson')));
  assert.deepEqual(gunzipSync(store.get('logs-2026-09')!.get('changes-2026-09-29.ndjson.gz')!).toString(), '{"seq":999}\n', 'the existing asset is untouched');
});

test('an upload that does not verify, or fails, leaves the tree file and blocks', () => {
  const root = dataRoot();
  const { io } = stubReleases((_tag, name, b) => (name.startsWith('changes-2026-09-29') ? Buffer.from('garbage') : name.startsWith('changes-2026-09-30') ? new Error('HTTP 502') : b));
  const res = archiveLogFiles(root, loadLogArchives(root), NOW, io, join(root, '..', `${basename(root)}-st`), { log: () => {} });
  assert.equal(res.archived.length, 2);
  assert.equal(res.blocked.length, 2);
  assert.match(res.blocked.join('\n'), /changes-2026-09-29\.ndjson\.gz did not verify after upload/);
  assert.match(res.blocked.join('\n'), /upload of logs-2026-09\/changes-2026-09-30\.ndjson\.gz failed \(HTTP 502\)/);
  assert.ok(existsSync(join(root, 'changes', '2026-09-29.ndjson')));
  assert.ok(existsSync(join(root, 'changes', '2026-09-30.ndjson')));
});

test('a file the index already holds is removed when identical (a removal that did not land), blocked when not', () => {
  const root = dataRoot();
  const { io } = stubReleases();
  const idx = loadLogArchives(root);
  archiveLogFiles(root, idx, NOW, io, join(root, '..', `${basename(root)}-a`), { log: () => {} });
  // The commit with the removal was lost: the files are back in the tree.
  writeFileSync(join(root, 'status', 'history', '2026-08.ndjson'), '{"generated":"2026-08-01T00:00:00Z","n":1}\n{"generated":"2026-08-02T00:00:00Z","n":2}\n');
  writeFileSync(join(root, 'changes', '2026-09-29.ndjson'), '{"seq":1,"day":"2026-09-29"}\n{"seq":2}\n');
  const res = archiveLogFiles(root, idx, NOW, io, join(root, '..', `${basename(root)}-b`), { log: () => {} });
  assert.deepEqual(res.leftoversRemoved, ['status/history/2026-08.ndjson']);
  assert.equal(res.blocked.length, 1);
  assert.match(res.blocked[0]!, /changes\/2026-09-29\.ndjson: differs from its archived copy/);
  assert.ok(existsSync(join(root, 'changes', '2026-09-29.ndjson')));
});

test('dry run: plans only — no release, no upload, nothing removed, the index unchanged', () => {
  const root = dataRoot();
  const { io, calls } = stubReleases();
  const idx = loadLogArchives(root);
  const lines: string[] = [];
  const res = archiveLogFiles(root, idx, NOW, io, join(root, '..', `${basename(root)}-d`), { dryRun: true, log: (l) => lines.push(l) });
  assert.deepEqual(calls, []);
  assert.equal(res.archived.length, 0);
  assert.equal(idx.entries.length, 0);
  assert.equal(lines.filter((l) => l.endsWith('[dry-run]')).length, 4);
  assert.ok(existsSync(join(root, 'status', 'history', '2026-08.ndjson')));
});

test('the per-run cap stops after maxFiles uploads; the rest rolls next run', () => {
  const root = dataRoot();
  const { io } = stubReleases();
  const idx = loadLogArchives(root);
  assert.equal(archiveLogFiles(root, idx, NOW, io, join(root, '..', `${basename(root)}-c1`), { maxFiles: 3, log: () => {} }).archived.length, 3);
  assert.equal(archiveLogFiles(root, idx, NOW, io, join(root, '..', `${basename(root)}-c2`), { maxFiles: 3, log: () => {} }).archived.length, 1);
});
