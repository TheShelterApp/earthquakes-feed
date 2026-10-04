import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { type ArchiveIo, type ArchiveOptions, runArchive } from '../src/archive.js';

// FEED-TEST-1: the archive run's decisions, end to end on a temporary data root with a stub for the Releases: which
// months are cold, the live-shard guard, upload → download → verify BEFORE the index entry and the tree removal, the
// re-roll merge and its shrink guard, a failed upload restoring the prior asset, dry run, the per-run cap.

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
    replaceAsset(tag, file) {
      const name = basename(file);
      calls.push(`replace ${tag}/${name}`);
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
  // Each replace is followed by the download of the same asset (the verify) before anything else.
  const i = calls.indexOf(`replace archive-2026-05/${e.asset}`);
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
});

test('archive run: a re-roll upload that fails puts the prior asset back and stops the run', () => {
  const root = dataRoot();
  const first = stubReleases();
  silently(() => runArchive(root, NOW, first.io, opts(root)));
  const prior = index(root).list.find((x) => x.period === '2026-05')!;
  const priorBytes = first.store.get('archive-2026-05')!.get(prior.asset)!;
  // The same store, now with a replace that fails for the new tarball (its first replace in this run) the way
  // `--clobber` does: the old asset is deleted before the upload fails.
  let seen = 0;
  const failing: ArchiveIo = {
    ...first.io,
    replaceAsset(tag, file) {
      seen++;
      if (seen === 1) {
        first.store.get(tag)!.delete(basename(file));
        throw new Error('HTTP 502 upload failed');
      }
      first.io.replaceAsset(tag, file);
    },
  };
  mkdirSync(join(root, 'events', '2026', '05'), { recursive: true });
  writeFileSync(join(root, 'events', '2026', '05', '02.ndjson'), [line('a'), line('b'), line('c')].join('\n') + '\n');
  const idx = index(root);
  idx.list.find((x) => x.period === '2026-05')!.needs_reroll = true;
  writeFileSync(join(root, 'knowledge', 'index', 'archives.json'), JSON.stringify(idx));
  assert.throws(() => silently(() => runArchive(root, NOW, failing, opts(root))), /HTTP 502/);
  assert.deepEqual(first.store.get('archive-2026-05')!.get(prior.asset), priorBytes, 'the prior asset is back, byte for byte');
  assert.ok(existsSync(join(root, 'events', '2026', '05', '02.ndjson')), 'the re-materialized day stays in the tree');
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
  // Cap 0: nothing rolls.
  const root2 = dataRoot();
  assert.deepEqual(silently(() => runArchive(root2, NOW, stubReleases().io, opts(root2, { maxMonths: 0 }))).archived, []);
  assert.ok(existsSync(join(root2, 'events', '2026', '05', '01.ndjson')));
});
