import { REMERGE_RULES } from '../src/config.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { type ArchiveEntry, type Archives, makeTarball } from '../src/archive.js';
import { nodeToFeature } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import type { ReleaseIo } from '../src/log-archive.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { type RemergeArchivesCtx, runRemergeArchives, selectMonths } from '../src/remerge-archives.js';
import { type EditionRef, type RemediationIndex, currentEdition, emptyRemediationIndex } from '../src/remediation.js';
import type { EventNode, RawObs } from '../src/types.js';
import { applyPending, rollback } from '../scripts/remerge-commit.mjs';

// The archive re-merge (C5, src/remerge-archives.ts + scripts/remerge-commit.mjs) on a stub of the Releases: selection,
// waits, no clobber, remediation refresh, adoption by checksum, compare-and-set, rollback.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const IT = '2026-11-08T00:00:00.000Z';
const KM = 111.195;
const hasZstd = ((): boolean => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function obs(provider: string, id: string, t: number, over: Partial<RawObs> = {}): RawObs {
  return { provider, providerEventId: id, eventTimeMs: t, providerUpdatedMs: null, status: 'reviewed', lat: 10, lon: 120, depth: 10, mag: 6.1, magType: 'mww', place: 'test', knownAliasIds: [], fields: {}, ...over };
}
function split(rows: RawObs[]): EventNode[] {
  const out: EventNode[] = [];
  for (const row of rows) {
    const one = new Map<string, EventNode>();
    new Resolver(one, prio, cfg, Date.parse(IT), { hotFloorMs: 0, merge: false }).ingest(row, IT);
    for (const n of one.values()) {
      while (out.some((o) => o.feedId === n.feedId)) n.feedId = `${n.feedId}X`;
      out.push(n);
    }
  }
  return out;
}
const quake = (t: number, tag: string): RawObs[] => [
  obs('usgs', `us${tag}`, t, { fields: { ids: `,us${tag},` } }),
  obs('geofon', `gfz${tag}`, t + 2_000, { lat: 10 + 22 / KM, mag: 6.0, magType: 'mw' }),
  obs('emsc', `em${tag}`, t + 3_000, { lat: 10 - 18 / KM, mag: 5.9, magType: 'mw' }),
];

function stub() {
  const store = new Map<string, Map<string, Buffer>>();
  const uploads: string[] = [];
  const io: ReleaseIo = {
    ensureRelease(tag) {
      if (!store.has(tag)) store.set(tag, new Map());
    },
    assets(tag) {
      return [...(store.get(tag) ?? new Map<string, Buffer>()).entries()].map(([name, b]) => ({ name, size: b.length }));
    },
    upload(tag, file) {
      const name = basename(file);
      if (store.get(tag)!.has(name)) throw new Error('already exists');
      uploads.push(`${tag}/${name}`);
      store.get(tag)!.set(name, readFileSync(file));
    },
    download(tag, asset, out) {
      const b = store.get(tag)?.get(asset);
      if (!b) throw new Error('HTTP 404');
      writeFileSync(out, b);
    },
  };
  return { io, store, uploads };
}

/** Archive months 2024-05 and 2024-06 (a split M6 in each), and a remediation edition of 2024-06-12 built on June's asset. */
function world(opts: { remediationOn?: 'june' | 'other' | 'partition' | 'other-partition' } = {}) {
  const s = stub();
  const archives: Archives = { list: [] };
  const memberText = new Map<string, string>();
  const months: [string, EventNode[]][] = [
    ['2024-05', split(quake(Date.parse('2024-05-20T03:00:00Z'), 'may'))],
    ['2024-06', split([...quake(Date.parse('2024-06-12T03:00:00Z'), 'jun'), obs('usgs', 'usx', Date.parse('2024-06-12T09:00:00Z'), { mag: 4.0, lat: 30 })])],
  ];
  for (const [period, nodes] of months) {
    const dir = mkdtempSync(join(tmpdir(), `arch-${period}-`));
    const m = join(dir, 'm');
    mkdirSync(m);
    const byDay = new Map<string, EventNode[]>();
    for (const n of nodes) {
      const d = new Date(n.eventTimeMs).toISOString().slice(0, 10);
      (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(n);
    }
    for (const [d, ns] of byDay) {
      memberText.set(d, ns.map((n) => JSON.stringify(nodeToFeature(n))).join('\n') + '\n');
      writeFileSync(join(m, `${d.slice(8, 10)}.ndjson`), memberText.get(d)!);
    }
    const { path, asset } = makeTarball(m, readdirSync(m), `events-${period}`);
    const tag = `archive-${period}`;
    s.io.ensureRelease(tag, '');
    s.store.get(tag)!.set(asset, readFileSync(path));
    archives.list.push({ period, tag, asset, url: '', bytes: readFileSync(path).length, sha256: sha(readFileSync(path)), count: nodes.length, days: [...byDay.keys()].sort(), needs_reroll: false });
  }
  const remediation: RemediationIndex = emptyRemediationIndex();
  if (opts.remediationOn) {
    const june = archives.list.find((e) => e.period === '2024-06')!;
    const nodes = months[1]![1].filter((n) => new Date(n.eventTimeMs).toISOString().slice(0, 10) === '2024-06-12');
    const bytes = gzipSync(Buffer.from(nodes.map((n) => JSON.stringify(nodeToFeature(n))).join('\n') + '\n'), { level: 9 });
    s.io.ensureRelease('remediation-2024', '');
    s.store.get('remediation-2024')!.set('events-2024-06-12.e1.ndjson.gz', bytes);
    remediation.editions.push({
      day: '2024-06-12', edition: 1, tag: 'remediation-2024', asset: 'events-2024-06-12.e1.ndjson.gz', url: '', sha256: sha(bytes), bytes: bytes.length,
      built_on: opts.remediationOn === 'partition' || opts.remediationOn === 'other-partition'
        // A late_usgs edition (SHLTR-150): built on the day's frozen partition before the month rolled.
        ? { tag: 'data', asset: 'events/2024/06/12.ndjson', sha256: opts.remediationOn === 'partition' ? sha(Buffer.from(memberText.get('2024-06-12')!)) : 'another', blob: '0'.repeat(40) }
        : { tag: june.tag, asset: june.asset, sha256: opts.remediationOn === 'june' ? june.sha256 : 'another' },
      built_from: ['raw-x'], stats: {} as EditionRef['stats'], built_at: IT,
    });
  }
  const out = mkdtempSync(join(tmpdir(), 'remerge-out-'));
  const ctx = (over: Partial<RemergeArchivesCtx> = {}): RemergeArchivesCtx => ({
    root: out, out, work: mkdtempSync(join(tmpdir(), 'remerge-work-')), io: s.io, dryRun: false, epoch: 1, ingestTime: IT, deadline: Date.now() + 600_000, registry,
    archives, remediation, history: null, now: () => IT, readTreeDay: () => '', ...over,
  });
  return { ...s, archives, remediation, ctx, out };
}
const silently = <T>(fn: () => T): T => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

test('selection: below the epoch, not waiting for a re-roll, newest first, at most N; nothing with the epoch at 0', () => {
  const e = (period: string, over: Partial<ArchiveEntry> = {}): ArchiveEntry => ({ period, tag: '', asset: '', url: '', bytes: 0, sha256: '', count: 0, days: [], ...over });
  const list = [e('2024-01'), e('2024-02', { merge_epoch: 1, merge_rules: REMERGE_RULES }), e('2024-03', { needs_reroll: true }), e('2024-04'), e('2024-05'), e('2023-12', { merge_epoch: 1 })];
  assert.deepEqual(selectMonths(list, 1, 2).map((x) => x.period), ['2024-05', '2024-04']);
  // 2023-12 was merged under the older input rules (no merge_rules = 1): merged again, a new asset.
  assert.deepEqual(selectMonths(list, 1, 9).map((x) => x.period), ['2024-05', '2024-04', '2024-01', '2023-12']);
  assert.deepEqual(selectMonths(list, 2, 9).map((x) => x.period), ['2024-05', '2024-04', '2024-02', '2024-01', '2023-12']);
  assert.deepEqual(selectMonths(list, 0, 9), []);
});

test('archive re-merge: newest first, a new asset beside the old one, the remediated day refreshed; compare-and-set applies it', { skip: !hasZstd && 'zstd not installed' }, () => {
  const w = world({ remediationOn: 'june' });
  const { pending, report } = silently(() => runRemergeArchives(w.ctx(), { max: 4 }));
  assert.deepEqual(report.blocked, []);
  assert.deepEqual(pending.months.map((m) => m.period), ['2024-06', '2024-05'], 'newest first; May waited for June within the run');
  const june = pending.months[0]!;
  assert.equal(june.entry.asset, 'events-2024-06.e2.tar.zst');
  assert.equal(june.entry.merge_epoch, 1);
  assert.equal(june.entry.live, 2);
  assert.equal(june.entry.superseded, 2);
  assert.ok(w.store.get('archive-2024-06')!.has('events-2024-06.tar.zst'), 'the old asset stays');
  assert.equal(june.remediation_editions.length, 1);
  const ref = june.remediation_editions[0]!;
  assert.equal(ref.asset, 'events-2024-06-12.e2.ndjson.gz');
  assert.deepEqual(ref.built_on, { tag: 'archive-2024-06', asset: june.entry.asset, sha256: june.entry.sha256 });
  assert.deepEqual(ref.stats.remerge, { epoch: 1, from_edition: 1 });
  assert.equal(ref.stats.live_after, 2, 'the quake and the unrelated M4');
  assert.equal(ref.stats.live_before, 4);
  assert.ok(w.uploads.includes('remediation-2024/events-2024-06-12.e2.ndjson.gz'));
  assert.ok(existsSync(join(w.out, 'months', '2024-06.json')));
  // The commit: compare-and-set. June applies; May's entry moved on meanwhile (a re-roll) and is dropped.
  const archives = JSON.parse(JSON.stringify(w.archives)) as Archives;
  archives.list.find((e) => e.period === '2024-05')!.sha256 = 'rerolled';
  const remediation = JSON.parse(JSON.stringify(w.remediation)) as RemediationIndex;
  const res = applyPending(archives as never, remediation as never, pending as never);
  assert.deepEqual(res.applied, ['2024-06']);
  assert.match(res.dropped.join('\n'), /2024-05: the entry moved on/);
  const applied = archives.list.find((e) => e.period === '2024-06')!;
  assert.equal(applied.asset, 'events-2024-06.e2.tar.zst');
  assert.deepEqual(applied.previous!.map((p) => [p.asset, p.edition]), [['events-2024-06.tar.zst', 1]]);
  assert.equal(currentEdition(remediation, '2024-06-12')!.edition, 2, 'the refreshed edition is the day’s current one');
  // A rollback restores the entry from previous[0] and withdraws the refreshed edition; nothing is deleted.
  const rb = rollback({ archives: archives as never, history: null, remediation: remediation as never }, 1, { at: IT, reason: 'test' });
  assert.deepEqual(rb.problems, []);
  const back = archives.list.find((e) => e.period === '2024-06')!;
  assert.equal(back.asset, 'events-2024-06.tar.zst');
  assert.equal(back.merge_epoch, undefined);
  assert.equal(back.previous![0]!.asset, 'events-2024-06.e2.tar.zst');
  assert.equal(back.previous![0]!.withdrawn_at, IT);
  assert.equal(currentEdition(remediation, '2024-06-12')!.edition, 1);
});

test('archive re-merge: a lost commit is adopted by checksum on the next run (no second upload); a stale merged asset becomes unused', { skip: !hasZstd && 'zstd not installed' }, () => {
  const w = world();
  const first = silently(() => runRemergeArchives(w.ctx(), { max: 1 }));
  assert.deepEqual(first.pending.months.map((m) => m.entry.asset), ['events-2024-06.e2.tar.zst']);
  const n = w.uploads.length;
  // The commit never landed: the index is unchanged. An unrelated merged asset also sits in May's Release.
  w.store.get('archive-2024-05')!.set('events-2024-05.e2.tar.zst', Buffer.from('junk'));
  const second = silently(() => runRemergeArchives(w.ctx(), { max: 4 }));
  const june = second.report.merged.find((m) => m.period === '2024-06')!;
  assert.equal(june.adopted, true);
  assert.equal(june.asset, 'events-2024-06.e2.tar.zst');
  assert.equal(second.pending.months[0]!.entry.sha256, first.pending.months[0]!.entry.sha256);
  assert.ok(!w.uploads.slice(n).some((u) => u.startsWith('archive-2024-06/')), 'June was not uploaded again');
  assert.deepEqual(second.pending.unused.map((u) => u.asset), ['events-2024-05.e2.tar.zst']);
  assert.equal(second.pending.months[1]!.entry.asset, 'events-2024-05.e3.tar.zst', 'May takes the next free name');
});

test('archive re-merge: a remediated day built on another asset blocks the month (nothing uploaded); the deadline stops the run; a dry run uploads nothing', { skip: !hasZstd && 'zstd not installed' }, () => {
  const w = world({ remediationOn: 'other' });
  const r = silently(() => runRemergeArchives(w.ctx(), { max: 4 }));
  assert.match(r.report.blocked.join('\n'), /2024-06: remediation events-2024-06-12\.e1\.ndjson\.gz of 2024-06-12 was built on/);
  assert.deepEqual(w.uploads, []);
  assert.match(r.report.waiting.join('\n'), /2024-05: waits for 2024-06/);
  const late = silently(() => runRemergeArchives(world().ctx({ deadline: Date.now() - 1 }), { max: 4 }));
  assert.deepEqual(late.report.budget, ['re-merging 2024-06 on']);
  const w2 = world();
  const dry = silently(() => runRemergeArchives(w2.ctx({ dryRun: true }), { max: 4 }));
  assert.equal(dry.pending.months.length, 2);
  assert.deepEqual(w2.uploads, []);
  assert.ok(existsSync(join(w2.out, 'releases', 'archive-2024-06', 'events-2024-06.e2.tar.zst')));
});

test('archive re-merge: a remediation edition built on an earlier asset is used when the re-roll left its day unchanged, and blocks the month when it changed it', { skip: !hasZstd && 'zstd not installed' }, () => {
  for (const changeDay of ['13', '12']) {
    const w = world({ remediationOn: 'june' });
    const june = w.archives.list.find((e) => e.period === '2024-06')!;
    // A re-roll since (a backfill fill): the old asset's members, plus a change on one day.
    const dir = mkdtempSync(join(tmpdir(), 'reroll-'));
    const m = join(dir, 'm');
    mkdirSync(m);
    const old = join(dir, june.asset);
    writeFileSync(old, w.store.get('archive-2024-06')!.get(june.asset)!);
    execFileSync('sh', ['-c', `zstd -d -q -c "$1" | tar -xf - -C "$2"`, 'sh', old, m]);
    const extra = split([obs('usgs', `usrefill${changeDay}`, Date.parse(`2024-06-${changeDay}T20:00:00Z`), { lat: -30, mag: 3 })])[0]!;
    const f = join(m, `${changeDay}.ndjson`);
    writeFileSync(f, (existsSync(f) ? readFileSync(f, 'utf8') : '') + JSON.stringify(nodeToFeature(extra)) + '\n');
    const { path, asset } = makeTarball(m, readdirSync(m), 'events-2024-06.e2');
    w.store.get('archive-2024-06')!.set(asset, readFileSync(path));
    const prev = { asset: june.asset, sha256: june.sha256, bytes: june.bytes, count: june.count, edition: 1, days: june.days };
    Object.assign(june, { asset, sha256: sha(readFileSync(path)), edition: 2, count: june.count + 1, days: [...new Set([...june.days, `2024-06-${changeDay}`])].sort(), previous: [prev] });
    const r = silently(() => runRemergeArchives(w.ctx(), { max: 1 }));
    if (changeDay === '13') {
      assert.deepEqual(r.report.blocked, []);
      assert.deepEqual(r.pending.months[0]!.entry.remediation, [{ day: '2024-06-12', edition: 1, sha256: w.remediation.editions[0]!.sha256 }]);
    } else {
      assert.match(r.report.blocked.join('\n'), /built on events-2024-06\.tar\.zst .*the re-roll changed that day/);
    }
  }
});

test('archive re-merge: a late_usgs edition built on the frozen partition is the day\'s input when the archive holds that file byte for byte, and blocks the month otherwise', { skip: !hasZstd && 'zstd not installed' }, () => {
  const w = world({ remediationOn: 'partition' });
  const r = silently(() => runRemergeArchives(w.ctx(), { max: 1 }));
  assert.deepEqual(r.report.blocked, []);
  assert.deepEqual(r.pending.months[0]!.entry.remediation, [{ day: '2024-06-12', edition: 1, sha256: w.remediation.editions[0]!.sha256 }]);
  const other = world({ remediationOn: 'other-partition' });
  const b = silently(() => runRemergeArchives(other.ctx(), { max: 1 }));
  assert.match(b.report.blocked.join('\n'), /2024-06: remediation events-2024-06-12\.e1\.ndjson\.gz of 2024-06-12 was built on events\/2024\/06\/12\.ndjson/);
  assert.deepEqual(other.uploads, []);
});
