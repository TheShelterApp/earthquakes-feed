import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { type ArchiveIo, type ArchiveOptions, extractTarball, makeTarball, runArchive } from '../src/archive.js';
import { isGnuTar } from '../src/tar.js';

// FEED-TEST-1: the archive run's decisions, end to end on a temporary data root with a stub for the Releases: which
// months are cold, the live-shard guard, upload → download → verify BEFORE the index entry and the tree removal, the
// re-roll merge and its shrink guard, no asset ever replaced (C5: the next free name, `previous[]`), dry run, the per-run
// cap.

const NOW = Date.parse('2026-10-04T10:00:00Z'); // 120 days back: 2026-06-06
const line = (id: string): string => JSON.stringify({ type: 'Feature', id, properties: { feed: { feed_id: id } } });

function stubReleases(opts: { corruptDownloadOf?: (asset: string) => boolean } = {}) {
  const store = new Map<string, Map<string, Buffer>>();
  const calls: string[] = [];
  const io: ArchiveIo = {
    ensureRelease(tag) {
      calls.push(`ensure ${tag}`);
      if (!store.has(tag)) store.set(tag, new Map());
    },
    assets(tag) {
      return [...(store.get(tag) ?? new Map<string, Buffer>()).entries()].map(([name, b]) => ({ name, size: b.length }));
    },
    upload(tag, file) {
      const name = basename(file);
      calls.push(`upload ${tag}/${name}`);
      if (store.get(tag)!.has(name)) throw new Error('already exists');
      store.get(tag)!.set(name, readFileSync(file));
    },
    download(tag, asset, out) {
      calls.push(`download ${tag}/${asset}`);
      const b = store.get(tag)?.get(asset);
      if (!b) throw new Error('HTTP 404 Not Found');
      writeFileSync(out, opts.corruptDownloadOf?.(asset) ? Buffer.concat([b, Buffer.from('x')]) : b);
    },
  };
  return { io, store, calls };
}

/** May 2026 is cold (2 days), June is not (06-10 is inside 120 days), April holds a live event_map shard. */
function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'archive-run-'));
  const day = (d: string, n: number): void => {
    const [y, m, dd] = d.split('-');
    mkdirSync(join(root, 'events', y!, m!), { recursive: true });
    writeFileSync(join(root, 'events', y!, m!, `${dd}.ndjson`), Array.from({ length: n }, (_, i) => line(`${d}-${i}`)).join('\n') + '\n');
  };
  day('2026-05-01', 3);
  day('2026-05-02', 2);
  day('2026-06-05', 1);
  day('2026-06-10', 1);
  day('2026-04-03', 1);
  mkdirSync(join(root, 'knowledge', 'index', 'event_map'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'index', 'event_map', '2026-04-03.ndjson'), '');
  const inv: Record<string, unknown> = {};
  for (const d of ['2026-04-03', '2026-05-01', '2026-05-02', '2026-06-05', '2026-06-10']) inv[d] = { count: 1 };
  writeFileSync(join(root, 'knowledge', 'index', 'partitions.json'), JSON.stringify(inv) + '\n');
  for (const [m, d] of [['05', '01'], ['06', '10']]) {
    mkdirSync(join(root, 'knowledge', 'observations', 'ingest=2026', m!, d!), { recursive: true });
    writeFileSync(join(root, 'knowledge', 'observations', 'ingest=2026', m!, d!, '00.ndjson'), '{"seq":1}\n');
  }
  return root;
}

const opts = (root: string, over: Partial<ArchiveOptions> = {}): ArchiveOptions => ({
  hotDays: 120,
  maxMonths: 12,
  dryRun: false,
  allowShrink: false,
  markerDir: mkdtempSync(join(tmpdir(), `${basename(root)}-marker-`)),
  ...over,
});
const index = (root: string): { list: { period: string; count: number; days: string[]; needs_reroll?: boolean; asset: string; sha256: string }[]; log_list?: { period: string }[] } =>
  JSON.parse(readFileSync(join(root, 'knowledge', 'index', 'archives.json'), 'utf8'));
const silently = <T>(fn: () => T): T => {
  const [log, err, warn] = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = () => {};
  try {
    return fn();
  } finally {
    [console.log, console.error, console.warn] = [log, err, warn];
  }
};

test('archive run: only the fully cold month rolls; the live-shard month is refused; verified before index and prune', () => {
  const root = dataRoot();
  const { io, store, calls } = stubReleases();
  const res = silently(() => runArchive(root, NOW, io, opts(root)));
  assert.deepEqual(res.archived, ['2026-05']);
  assert.equal(res.logArchived, 1, 'the cold observation-log month too');
  // May left the tree and the inventory; June and the shard-guarded April stay.
  assert.ok(!existsSync(join(root, 'events', '2026', '05')) || readdirSync(join(root, 'events', '2026', '05')).length === 0);
  assert.ok(existsSync(join(root, 'events', '2026', '06', '10.ndjson')));
  assert.ok(existsSync(join(root, 'events', '2026', '04', '03.ndjson')), 'a month with a live event_map shard is never archived');
  const inv = JSON.parse(readFileSync(join(root, 'knowledge', 'index', 'partitions.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(inv).sort(), ['2026-04-03', '2026-06-05', '2026-06-10']);
  const e = index(root).list.find((x) => x.period === '2026-05')!;
  assert.equal(e.count, 5);
  assert.deepEqual(e.days, ['2026-05-01', '2026-05-02']);
  assert.ok(store.get('archive-2026-05')!.has(e.asset));
  assert.deepEqual(index(root).log_list?.map((x) => x.period), ['2026-05']);
  assert.ok(!existsSync(join(root, 'knowledge', 'observations', 'ingest=2026', '05')));
  assert.ok(existsSync(join(root, 'knowledge', 'observations', 'ingest=2026', '06', '10', '00.ndjson')));
  // Each upload is followed by the download of the same asset (the verify) before anything else.
  assert.match(e.asset, /^events-2026-05\.tar\.(zst|gz)$/, 'the first roll is edition 1, the unsuffixed name');
  const i = calls.indexOf(`upload archive-2026-05/${e.asset}`);
  assert.equal(calls[i + 1], `download archive-2026-05/${e.asset}`);
});

test('archive run: an upload that reads back with another checksum stops the run before the index or the tree changes', () => {
  const root = dataRoot();
  // zstd where installed, gzip otherwise: either way the event tarball of May reads back wrong.
  const { io } = stubReleases({ corruptDownloadOf: (a) => a.startsWith('events-2026-05.tar.') });
  assert.throws(() => silently(() => runArchive(root, NOW, io, opts(root))), /archive verify failed for 2026-05/);
  assert.ok(existsSync(join(root, 'events', '2026', '05', '01.ndjson')));
  assert.ok(existsSync(join(root, 'events', '2026', '05', '02.ndjson')));
  assert.ok(!existsSync(join(root, 'knowledge', 'index', 'archives.json')), 'no index entry for an unverified asset');
});

test('archive run: a re-roll merges the archived days with the re-materialized one; a shrink is refused and turns the run red', () => {
  const root = dataRoot();
  const { io, store } = stubReleases();
  silently(() => runArchive(root, NOW, io, opts(root)));
  const first = index(root).list.find((x) => x.period === '2026-05')!;
  // Backfill re-materialized 05-02 with one more event and flagged the month.
  mkdirSync(join(root, 'events', '2026', '05'), { recursive: true });
  writeFileSync(join(root, 'events', '2026', '05', '02.ndjson'), [line('a'), line('b'), line('c')].join('\n') + '\n');
  const idx = index(root);
  idx.list.find((x) => x.period === '2026-05')!.needs_reroll = true;
  writeFileSync(join(root, 'knowledge', 'index', 'archives.json'), JSON.stringify(idx));
  const res = silently(() => runArchive(root, NOW, io, opts(root)));
  assert.deepEqual(res.archived, ['2026-05']);
  const second = index(root).list.find((x) => x.period === '2026-05')!;
  assert.equal(second.count, 6, '3 kept from the archive + 3 re-materialized (the in-tree day wins)');
  assert.equal(second.needs_reroll, false);
  assert.notEqual(second.sha256, first.sha256);
  assert.ok(store.get('archive-2026-05')!.has(second.asset));
  // Never replaced: the re-roll is edition 2 under its own name, the first asset stays and is listed.
  assert.match(second.asset, /^events-2026-05\.e2\.tar\.(zst|gz)$/);
  assert.ok(store.get('archive-2026-05')!.has(first.asset), 'the first asset is still there');
  const sec = second as unknown as { edition?: number; previous?: { asset: string; sha256: string; edition: number }[]; merge_epoch?: number };
  assert.equal(sec.edition, 2);
  assert.deepEqual(sec.previous?.map((x) => [x.asset, x.sha256, x.edition]), [[first.asset, first.sha256, 1]]);
  assert.equal(sec.merge_epoch, undefined);
  // Now a re-roll that would publish fewer events than the entry: refused, file kept, marker written.
  writeFileSync(join(root, 'events', '2026', '05', '02.ndjson'), line('only') + '\n');
  const idx2 = index(root);
  Object.assign(idx2.list.find((x) => x.period === '2026-05')!, { needs_reroll: true, count: 1000 });
  writeFileSync(join(root, 'knowledge', 'index', 'archives.json'), JSON.stringify(idx2));
  const o = opts(root);
  const res2 = silently(() => runArchive(root, NOW, io, o));
  assert.deepEqual(res2.archived, []);
  assert.match(res2.blocked.join('\n'), /2026-05: refused shrink 1000 -> \d+ events/);
  assert.match(readFileSync(join(o.markerDir, 'archive-blocked.txt'), 'utf8'), /refused shrink/);
  assert.ok(existsSync(join(root, 'events', '2026', '05', '02.ndjson')));
  assert.equal(index(root).list.find((x) => x.period === '2026-05')!.needs_reroll, true, 'the month waits for a decision');
  assert.equal(res2.complete, true);
  // SHLTR-151: the month stays flagged, so every later run tries it again and states the block again (no 26 h hold
  // needed); once it re-rolls, the run's marker names nothing and archive.yml uploads a '#' marker.
  const o3 = opts(root);
  const res3 = silently(() => runArchive(root, NOW, io, o3));
  assert.match(res3.blocked.join('\n'), /2026-05: refused shrink 1000 -> \d+ events/);
  assert.match(readFileSync(join(o3.markerDir, 'archive-blocked.txt'), 'utf8'), /refused shrink/);
  const idx3 = index(root);
  Object.assign(idx3.list.find((x) => x.period === '2026-05')!, { count: 1 });
  writeFileSync(join(root, 'knowledge', 'index', 'archives.json'), JSON.stringify(idx3));
  const o4 = opts(root);
  const res4 = silently(() => runArchive(root, NOW, io, o4));
  assert.deepEqual([res4.archived, res4.blocked, res4.complete], [['2026-05'], [], true]);
  assert.equal(existsSync(join(o4.markerDir, 'archive-blocked.txt')), false);
});

test('archive run: a re-roll never replaces an asset: a failed upload leaves the prior asset; an orphan name is skipped; a merged month is merged again', () => {
  const root = dataRoot();
  const first = stubReleases();
  silently(() => runArchive(root, NOW, first.io, opts(root)));
  const prior = index(root).list.find((x) => x.period === '2026-05')!;
  const priorBytes = first.store.get('archive-2026-05')!.get(prior.asset)!;
  // The month was re-merged since (remerge.yml): its asset carries _archive.json and its entry merge_epoch.
  const idx0 = index(root);
  Object.assign(idx0.list.find((x) => x.period === '2026-05')!, { merge_epoch: 1, needs_reroll: true });
  writeFileSync(join(root, 'knowledge', 'index', 'archives.json'), JSON.stringify(idx0));
  // An earlier run's upload of edition 2 whose index commit never landed: its name is never used again.
  const ext = prior.asset.endsWith('.zst') ? 'zst' : 'gz';
  first.store.get('archive-2026-05')!.set(`events-2026-05.e2.tar.${ext}`, Buffer.from('orphan'));
  let uploads = 0;
  const failing: ArchiveIo = {
    ...first.io,
    upload(tag, file) {
      uploads++;
      if (uploads === 1) throw new Error('HTTP 502 upload failed');
      first.io.upload(tag, file);
    },
  };
  mkdirSync(join(root, 'events', '2026', '05'), { recursive: true });
  writeFileSync(join(root, 'events', '2026', '05', '02.ndjson'), [line('a'), line('b'), line('c')].join('\n') + '\n');
  assert.throws(() => silently(() => runArchive(root, NOW, failing, opts(root))), /HTTP 502/);
  assert.deepEqual(first.store.get('archive-2026-05')!.get(prior.asset), priorBytes, 'the prior asset was never touched');
  assert.equal(first.store.get('archive-2026-05')!.get(`events-2026-05.e2.tar.${ext}`)!.toString(), 'orphan');
  assert.ok(existsSync(join(root, 'events', '2026', '05', '02.ndjson')), 'the re-materialized day stays in the tree');
  // The next run lands edition 3; the entry lists the merged edition 1 in previous[] and is not merged any more.
  const res = silently(() => runArchive(root, NOW, first.io, opts(root)));
  assert.deepEqual(res.archived, ['2026-05']);
  const e = index(root).list.find((x) => x.period === '2026-05')! as unknown as { asset: string; edition: number; merge_epoch?: number; previous: { asset: string; merge_epoch?: number }[] };
  assert.equal(e.asset, `events-2026-05.e3.tar.${ext}`);
  assert.equal(e.edition, 3);
  assert.equal(e.merge_epoch, undefined);
  assert.deepEqual(e.previous.map((x) => [x.asset, x.merge_epoch]), [[prior.asset, 1]]);
});

test('archive run: a re-roll of a merged asset drops its _archive.json member', () => {
  const root = dataRoot();
  const { io, store } = stubReleases();
  silently(() => runArchive(root, NOW, io, opts(root)));
  const prior = index(root).list.find((x) => x.period === '2026-05')!;
  // Replace the stored asset's bytes by a tarball that also holds _archive.json (as a merged asset does).
  const dir = mkdtempSync(join(tmpdir(), 'merged-'));
  const members = join(dir, 'm');
  mkdirSync(members);
  writeFileSync(join(members, '01.ndjson'), [line('x'), line('y')].join('\n') + '\n');
  writeFileSync(join(members, '_archive.json'), '{"kind":"earthquakes-feed/archive-edition"}\n');
  const { path } = makeTarball(members, ['01.ndjson', '_archive.json'], 'events-2026-05');
  store.get('archive-2026-05')!.set(prior.asset, readFileSync(path));
  const idx = index(root);
  idx.list.find((x) => x.period === '2026-05')!.needs_reroll = true;
  writeFileSync(join(root, 'knowledge', 'index', 'archives.json'), JSON.stringify(idx));
  mkdirSync(join(root, 'events', '2026', '05'), { recursive: true });
  writeFileSync(join(root, 'events', '2026', '05', '02.ndjson'), line('z') + '\n');
  silently(() => runArchive(root, NOW, io, { ...opts(root), allowShrink: true }));
  const next = index(root).list.find((x) => x.period === '2026-05')!;
  const out = mkdtempSync(join(tmpdir(), 'rolled-'));
  writeFileSync(join(out, next.asset), store.get('archive-2026-05')!.get(next.asset)!);
  extractTarball(join(out, next.asset), out);
  assert.ok(!existsSync(join(out, '_archive.json')), 'stale metadata dropped');
  assert.equal(next.count, 3);
});

test('archive run: tarballs are deterministic with GNU tar (sorted names, mtime 0, owner 0)', { skip: !isGnuTar() }, () => {
  const sums = [0, 1].map(() => {
    const dir = mkdtempSync(join(tmpdir(), 'det-'));
    const m = join(dir, 'm');
    mkdirSync(m);
    writeFileSync(join(m, '02.ndjson'), 'b\n');
    writeFileSync(join(m, '01.ndjson'), 'a\n');
    const { path } = makeTarball(m, ['02.ndjson', '01.ndjson'], 'events-2026-05');
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  });
  assert.equal(sums[0], sums[1]);
});

test('archive run: dry run uploads, indexes and removes nothing; the per-run cap holds', () => {
  const root = dataRoot();
  const { io, calls } = stubReleases();
  const res = silently(() => runArchive(root, NOW, io, opts(root, { dryRun: true })));
  assert.deepEqual(res.archived, ['2026-05'], 'planned');
  assert.deepEqual(calls.filter((c) => !c.startsWith('download')), [], 'no release created, nothing uploaded');
  assert.ok(existsSync(join(root, 'events', '2026', '05', '01.ndjson')));
  assert.ok(existsSync(join(root, 'knowledge', 'observations', 'ingest=2026', '05', '01', '00.ndjson')));
  assert.equal(index(root).list.length, 0);
  assert.equal(res.complete, true);
  // Cap 0: nothing rolls, and the run has not looked at every cold month (no '#' marker: a month it skipped may be
  // one blocked before).
  const root2 = dataRoot();
  const capped = silently(() => runArchive(root2, NOW, stubReleases().io, opts(root2, { maxMonths: 0 })));
  assert.deepEqual([capped.archived, capped.complete], [[], false]);
  assert.ok(existsSync(join(root2, 'events', '2026', '05', '01.ndjson')));
});
