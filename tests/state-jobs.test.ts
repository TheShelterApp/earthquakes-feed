import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { emptyGeneration, serializeGeneration, type Generation } from '../src/event-map-store.js';
import {
  BACKUP_CATCHUP_DAYS,
  backupMembers,
  compressBackup,
  dayAssets,
  decompressBackup,
  main as backupMain,
  readTar,
  runBackup,
  verifyBackup,
  writeTar,
  type BackupIo,
  type ReleaseAsset,
} from '../src/state-backup.js';
import { GC_DAILY_DAYS, GC_MAX_WINDOW_DAYS, STATE_GC_SCHEDULED, collect, dryRunOf, main as gcMain, planKeep, type GcSources } from '../src/state-gc.js';
import { rehearse } from '../src/state-rehearsal.js';
import { FsBackend, casKey, sha256Hex, type GcRequest, type StateBackend } from '../src/state-store.js';

// The state store's daily jobs (storage phase 3): GC's keep set and paging (src/state-gc.ts), the deterministic backup
// into draft monthly Releases (src/state-backup.ts), and the staging rehearsal (src/state-rehearsal.ts) on the
// directory backend. GitHub is a stub; nothing leaves the machine.

const NOW = Date.parse('2026-12-20T00:47:00Z');
const DAY_MS = 86_400_000;
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const blob = (s: string): { hex: string; bytes: Buffer } => {
  const bytes = gzipSync(s);
  return { hex: sha256Hex(bytes), bytes };
};
const genWith = (blobs: Record<string, { hex: string; bytes: Buffer }>, headSeq = 1): Generation => ({
  ...emptyGeneration(),
  head_seq: headSeq,
  days: Object.fromEntries(Object.entries(blobs).map(([d, b]) => [d, { sha256: 'e'.repeat(64), bytes: 1, nodes: 1, blob: b.hex, blob_bytes: b.bytes.length }])),
});

/** A data branch as GC and the backup see it: one commit per UTC day (its generation at 00:00), and HEAD. */
function history(gens: Map<string, Generation>, head: Generation, marker: { newest: string | null; first_missing: string | null } | null) {
  const asked: string[] = [];
  const src: GcSources = {
    async commitBefore(iso) {
      asked.push(iso);
      const day = iso.slice(0, 10);
      return gens.has(day) ? createHash('sha1').update(day).digest('hex') : null;
    },
    async generationAt(ref) {
      if (ref === 'data') return serializeGeneration(head);
      for (const [day, g] of gens) if (createHash('sha1').update(day).digest('hex') === ref) return serializeGeneration(g);
      return null;
    },
    async backupMarker() {
      return marker;
    },
  };
  return { src, asked };
}

test('GC keep set: the current generation, every daily generation of the last 31 days, and every day the backup has not copied', async () => {
  const b = (n: number) => blob(`blob ${n}`);
  const gens = new Map<string, Generation>();
  for (let i = 0; i <= 60; i++) gens.set(dayKey(NOW - i * DAY_MS), genWith({ '2026-11-01': b(i) }));
  const head = genWith({ '2026-11-01': b(999), '2026-11-02': b(998) });
  const plan = await planKeep(history(gens, head, { newest: dayKey(NOW), first_missing: null }).src, NOW);
  assert.equal(plan.holdReason, null);
  assert.equal(plan.windowFrom, dayKey(NOW - GC_DAILY_DAYS * DAY_MS));
  assert.deepEqual(plan.current, [b(999).hex, b(998).hex].sort());
  assert.equal(plan.boundaries.length, GC_DAILY_DAYS + 1);
  const keep = new Set(plan.keep);
  for (let i = 0; i <= GC_DAILY_DAYS; i++) assert.ok(keep.has(b(i).hex), `day -${i}`);
  assert.ok(!keep.has(b(GC_DAILY_DAYS + 1).hex), 'older daily generations are not kept');
  // A backup that stopped 40 days ago: its days stay restorable.
  const behind = await planKeep(history(gens, head, { newest: dayKey(NOW - 41 * DAY_MS), first_missing: null }).src, NOW);
  assert.equal(behind.windowFrom, dayKey(NOW - 40 * DAY_MS));
  assert.ok(new Set(behind.keep).has(b(40).hex));
  // No marker, or a backup further behind than GC_MAX_WINDOW_DAYS: nothing is deleted.
  assert.match((await planKeep(history(gens, head, null).src, NOW)).holdReason!, /no state-backup marker/);
  const far = await planKeep(history(gens, head, { newest: null, first_missing: dayKey(NOW - 200 * DAY_MS) }).src, NOW);
  assert.match(far.holdReason!, new RegExp(`more than ${GC_MAX_WINDOW_DAYS} days`));
  // A current generation that names no blob: a hold (the Worker refuses an empty `current`), GC is skipped.
  const empty = await planKeep(history(gens, genWith({}), { newest: dayKey(NOW), first_missing: null }).src, NOW);
  assert.deepEqual(empty.current, []);
  assert.match(empty.holdReason!, /^the current generation names no blob: .*GC is skipped$/);
  // No current generation yet (before the first persist): skipped, nothing else read, the run writes its marker.
  const noneAsked = history(gens, head, null);
  const none = await planKeep({ ...noneAsked.src, generationAt: async () => null }, NOW);
  assert.deepEqual([none.keep, none.current, none.boundaries], [[], [], []]);
  assert.match(none.holdReason!, /has no knowledge\/index\/generation\.json yet .*GC is skipped/);
  assert.deepEqual(noneAsked.asked, []);
  // An unreadable current generation: no keep set at all.
  const bad: GcSources = { ...history(gens, head, null).src, generationAt: async () => serializeGeneration(head).replace('"format": 1', '"format": 2') };
  await assert.rejects(planKeep(bad, NOW), /format 2/);
  assert.equal(STATE_GC_SCHEDULED, 'dry-run', 'phase 3a: the scheduled GC lists and deletes nothing');
  assert.deepEqual([dryRunOf('scheduled'), dryRunOf('1'), dryRunOf(''), dryRunOf('false')], [true, true, false, false]);
});

test('GC paging: the current generation goes out 40 blobs a call, a dry run deletes nothing, then only the old unkept blobs go', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-gc-'));
  try {
    const fs = new FsBackend(dir, () => NOW);
    const calls: GcRequest[] = [];
    const be: StateBackend = { ...fs, label: fs.label, put: (h, b) => fs.put(h, b), batchGet: (s) => fs.batchGet(s), budget: () => fs.budget(), gc: (r) => (calls.push(r), fs.gc(r)) };
    const current = Array.from({ length: 46 }, (_, i) => blob(`current ${i}`));
    const orphans = Array.from({ length: 5 }, (_, i) => blob(`orphan ${i}`));
    for (const x of [...current, ...orphans]) await fs.put(x.hex, x.bytes);
    const old = (NOW - 40 * DAY_MS) / 1000;
    for (const x of [...current, ...orphans.slice(0, 3)]) utimesSync(join(dir, ...casKey(x.hex).split('/')), old, old);
    const plan = { keep: current.map((x) => x.hex).sort(), current: current.map((x) => x.hex).sort(), windowFrom: '', boundaries: [], holdReason: null };
    const dry = await collect(be, plan, { dryRun: true });
    assert.deepEqual([dry.deleted, dry.wouldDelete, dry.listed, dry.kept, dry.young, dry.capped, dry.foreign, dry.pages, dry.skipped], [0, 3, 51, 46, 2, 0, 0, 1, null]);
    assert.equal(dry.bytesWouldDelete, orphans.slice(0, 3).reduce((n, x) => n + x.bytes.length, 0));
    assert.deepEqual(calls.map((c) => [c.current.length, c.dryRun, c.cursor]), [[40, true, null], [6, true, null]]);
    calls.length = 0;
    const real = await collect(be, plan, { dryRun: false });
    assert.deepEqual([real.deleted, real.wouldDelete, real.bytesDeleted], [3, 3, dry.bytesWouldDelete]);
    assert.deepEqual(calls.map((c) => [c.current.length, c.dryRun]), [[40, true], [6, false]], 'the verification chunk never deletes');
    for (const x of current) assert.ok(existsSync(join(dir, ...casKey(x.hex).split('/'))));
    assert.ok(existsSync(join(dir, ...casKey(orphans[4]!.hex).split('/'))), 'a young orphan stays (min age 30 days)');
    // An empty current generation (before the first persist): no call at all, a hold the marker records.
    calls.length = 0;
    const empty = await collect(be, { ...plan, current: [] }, { dryRun: false });
    assert.deepEqual([empty.skipped, empty.pages, calls.length], ['the current generation names no blob: nothing to check the keep set against', 0, 0]);
    const huge = await collect(be, { ...plan, keep: Array.from({ length: 10_001 }, (_, i) => sha256Hex(String(i))) }, { dryRun: true });
    assert.match(huge.skipped!, /10001 blobs, over the store's 10000/);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backup archive: a deterministic ustar of sorted members that reads back; verify checks every blob of the generation', () => {
  const a = blob('day a');
  const g = genWith({ '2026-12-18': a }, 7);
  const commit = 'c'.repeat(40);
  const members = backupMembers(commit, serializeGeneration(g), new Map([['knowledge/index/head.json', Buffer.from('{"seq":7}\n')]]), new Map([[a.hex, a.bytes]]));
  const tar1 = writeTar(members);
  const tar2 = writeTar(new Map([...members.entries()].reverse()));
  assert.ok(tar1.equals(tar2), 'member order does not matter');
  assert.equal(tar1.length % 512, 0);
  const back = readTar(tar1);
  assert.deepEqual([...back.keys()], ['cas/sha256/' + a.hex.slice(0, 2) + '/' + a.hex, 'data_commit.txt', 'generation.json', 'head.json']);
  assert.equal(back.get('data_commit.txt')!.toString(), `${commit}\nknowledge/index/head.json\n`);
  assert.deepEqual(verifyBackup(back).commit, commit);
  const zst = compressBackup(tar1);
  assert.ok(compressBackup(tar1).equals(zst));
  assert.ok(decompressBackup(zst).equals(tar1));
  // GNU tar reads it (the runners' tar; a restore by hand).
  const dir = mkdtempSync(join(tmpdir(), 'state-tar-'));
  try {
    writeFileSync(join(dir, 'x.tar'), tar1);
    assert.match(execFileSync('tar', ['-tf', join(dir, 'x.tar')], { encoding: 'utf8' }), /generation\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const broken = new Map(back);
  broken.delete(casKey(a.hex));
  assert.throws(() => verifyBackup(broken), /is not in the archive/);
  const bad = Buffer.from(tar1);
  bad[10] ^= 1;
  assert.throws(() => readTar(bad), /bad header checksum/);
});

test('backup asset names: the first complete one counts; an incomplete upload is never replaced, the next is .g2', () => {
  const ok: ReleaseAsset = { name: 'state-2026-12-18.tar.zst', size: 10, state: 'uploaded', digest: `sha256:${'a'.repeat(64)}` };
  assert.deepEqual(dayAssets([], '2026-12-18'), { complete: null, nextName: 'state-2026-12-18.tar.zst' });
  assert.equal(dayAssets([ok], '2026-12-18').complete, ok);
  const starter = { ...ok, state: 'starter', size: 0, digest: null };
  assert.deepEqual(dayAssets([starter], '2026-12-18'), { complete: null, nextName: 'state-2026-12-18.g2.tar.zst' });
  assert.deepEqual(dayAssets([starter, { ...starter, name: 'state-2026-12-18.g2.tar.zst' }], '2026-12-18').nextName, 'state-2026-12-18.g3.tar.zst');
  assert.equal(dayAssets([ok], '2026-12-19').complete, null);
});

/** Releases in memory, as GitHub keeps them (an upload gets its digest; drafts until published). */
function releases(src: GcSources, opts: { corrupt?: boolean } = {}) {
  const rel = new Map<string, { draft: boolean; assets: Map<string, Buffer> }>();
  const io: BackupIo = {
    commitBefore: (iso) => src.commitBefore(iso),
    async fileAt(ref, path) {
      if (path === 'knowledge/index/generation.json') {
        const t = await src.generationAt(ref);
        return t == null ? null : Buffer.from(t);
      }
      return path.endsWith('head.json') ? Buffer.from('{"seq":1}\n') : null;
    },
    assets(tag) {
      const r = rel.get(tag);
      return r
        ? [...r.assets].map(([name, b]) => ({ name, size: b.length, state: 'uploaded', digest: `sha256:${createHash('sha256').update(opts.corrupt ? Buffer.concat([b, Buffer.from('x')]) : b).digest('hex')}` }))
        : null;
    },
    createDraft(tag) {
      assert.ok(!rel.has(tag));
      rel.set(tag, { draft: true, assets: new Map() });
    },
    upload(tag, file) {
      const r = rel.get(tag)!;
      assert.ok(!r.assets.has(basename(file)), 'never --clobber');
      r.assets.set(basename(file), readFileSync(file));
    },
    isDraft: (tag) => rel.get(tag)?.draft ?? null,
    publish(tag) {
      rel.get(tag)!.draft = false;
    },
  };
  return { io, rel };
}

test('backup run: every day of the catch-up window with a generation, into its month\'s draft Release, verified; a closed complete month is published', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-backup-'));
  const work = mkdtempSync(join(tmpdir(), 'state-backup-work-'));
  try {
    const be = new FsBackend(dir, () => NOW);
    const gens = new Map<string, Generation>();
    // Phase 3a started on 2026-11-28: its first midnight with a generation is 11-29.
    for (let d = '2026-11-29'; d <= '2026-12-20'; d = dayKey(Date.parse(`${d}T00:00:00Z`) + DAY_MS)) {
      const x = blob(`state of ${d}`);
      await be.put(x.hex, x.bytes);
      gens.set(d, genWith({ [d]: x }));
    }
    const { src } = history(gens, gens.get('2026-12-20')!, null);
    const { io, rel } = releases(src);
    const r = await runBackup(io, be, { nowMs: NOW, workDir: work });
    assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
    assert.equal(r.uploaded.length, 22);
    assert.equal(r.noGeneration.length, BACKUP_CATCHUP_DAYS + 1 - 22);
    assert.equal(r.newest, '2026-12-20');
    assert.deepEqual(r.published, ['state-2026-11'], 'November is over and complete');
    assert.equal(rel.get('state-2026-12')!.draft, true, 'December is still running');
    const asset = rel.get('state-2026-12')!.assets.get('state-2026-12-05.tar.zst')!;
    const back = verifyBackup(readTar(decompressBackup(asset)));
    assert.deepEqual(Object.keys(back.generation.days), ['2026-12-05']);
    // The next run uploads nothing again.
    const again = await runBackup(io, be, { nowMs: NOW, workDir: work });
    assert.deepEqual([again.uploaded, again.newest], [[], '2026-12-20']);
    // A blob gone from the store: that day fails, the others are unaffected.
    const fresh = releases(src);
    rmSync(join(dir, ...casKey(gens.get('2026-12-10')!.days['2026-12-10']!.blob).split('/')));
    const partial = await runBackup(fresh.io, be, { nowMs: NOW, workDir: mkdtempSync(join(tmpdir(), 'state-backup-w2-')) });
    assert.deepEqual(partial.failed.map((f) => f.day), ['2026-12-10']);
    assert.equal(partial.firstMissing, '2026-12-10');
    assert.equal(partial.uploaded.length, 21);
    // An upload whose digest does not read back as the local sha256 does not count.
    const corrupt = releases(src, { corrupt: true });
    const c = await runBackup(corrupt.io, be, { nowMs: NOW, workDir: mkdtempSync(join(tmpdir(), 'state-backup-w3-')) });
    assert.equal(c.uploaded.length, 0);
    assert.match(c.failed[0]!.error, /reads back as/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('rehearsal: the whole client path (persist, shadow and authoritative hydrate, GC dry run, budget) on the directory backend', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-rehearsal-'));
  try {
    const steps = await rehearse(new FsBackend(dir), { nodesPerDay: 20 });
    assert.equal(steps.length, 7);
    assert.match(steps[0]!, /^persist: 3 day blob\(s\) uploaded/);
    assert.match(steps[3]!, /byte for byte/);
    assert.match(steps[4]!, /^restore: a backup archive of the generation verified and its 3 blob\(s\) PUT again/);
    assert.match(steps[5]!, /would delete 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore: scripts/state-restore.ts verifies a backup asset, unpacks it and PUTs its blobs into a store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'state-restore-'));
  try {
    const a = blob('restored day');
    const g = genWith({ '2026-12-18': a }, 3);
    const zst = compressBackup(writeTar(backupMembers('d'.repeat(40), serializeGeneration(g), new Map(), new Map([[a.hex, a.bytes]]))));
    const asset = join(dir, 'state-2026-12-19.tar.zst');
    writeFileSync(asset, zst);
    const data = join(dir, 'data');
    mkdirSync(join(data, 'knowledge', 'index'), { recursive: true });
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/state-restore.ts', asset, '--out', join(dir, 'out'), '--put', '--data-dir', data], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, FEED_STATE_BACKEND: `fs:${join(dir, 'store')}` },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /verified: data commit d{40}, generation at seq 3, 1 day\(s\)/);
    assert.ok(readFileSync(join(dir, 'store', ...casKey(a.hex).split('/'))).equals(a.bytes));
    assert.ok(existsSync(join(dir, 'out', 'generation.json')));
    assert.equal(readFileSync(join(data, 'knowledge', 'index', 'generation.json'), 'utf8'), serializeGeneration(g));
    copyFileSync(asset, join(dir, 'broken.tar.zst'));
    writeFileSync(join(dir, 'broken.tar.zst'), compressBackup(writeTar(new Map([['generation.json', Buffer.from(serializeGeneration(g))], ['data_commit.txt', Buffer.from('d'.repeat(40) + '\n')]]))));
    const bad = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/state-restore.ts', join(dir, 'broken.tar.zst')], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /is not in the archive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the store off (the repository variable FEED_STATE_BACKEND unset): GC and the backup complete, read nothing and write an off marker', async () => {
  const out = mkdtempSync(join(tmpdir(), 'state-off-'));
  const log = console.log;
  console.log = () => {};
  try {
    // No GitHub call can happen: no fetch is reachable with this token, and gh is never run.
    assert.equal(await gcMain({ GH_TOKEN: 'unused', STATE_GC_MARKER_DIR: out, GITHUB_RUN_ID: '7' }), 0);
    const gc = JSON.parse(readFileSync(join(out, 'state-gc.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual([gc.ok, gc.off, gc.run_id], [true, true, '7']);
    assert.equal(await backupMain({ FEED_STATE_BACKEND: '', STATE_BACKUP_MARKER_DIR: out }), 0);
    const b = JSON.parse(readFileSync(join(out, 'state-backup.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual([b.ok, b.off, b.newest, b.first_missing], [true, true, null, null]);
  } finally {
    console.log = log;
    rmSync(out, { recursive: true, force: true });
  }
});

test('workflows: the store is switched on by the repository variable FEED_STATE_BACKEND (unset: off), never hard-coded on the production jobs', () => {
  const wf = (f: string): string => readFileSync(fileURLToPath(new URL(`../.github/workflows/${f}`, import.meta.url)), 'utf8');
  for (const f of ['aggregate.yml', 'derive.yml', 'state-gc.yml', 'state-backup.yml', 'health.yml']) {
    const text = wf(f);
    assert.match(text, /FEED_STATE_BACKEND: \$\{\{ vars\.FEED_STATE_BACKEND \}\}/, f);
    assert.doesNotMatch(text, /FEED_STATE_BACKEND: worker/, f);
  }
  assert.equal(wf('aggregate.yml').match(/FEED_STATE_BACKEND: \$\{\{ vars\.FEED_STATE_BACKEND \}\}/g)!.length, 2, 'hydrate and persist');
});
