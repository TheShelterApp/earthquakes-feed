/**
 * Replay of derive's silent-change check (PRB-2) over real `data` commits: the baseline of storage option 4 phase 2 (the
 * snapshot of the event map the run checked out, with the previous derive's Pages copy for a day it did not publish
 * from that map, each verified against the record of the previous derive; src/live-baseline.ts) against the check of
 * round 24 (the partitions the previous derive committed; live-sync.ts detectSilentChanges, the reference while the
 * commits hold them, i.e. before phase 2), and both against what production found (the entries the derive commit added
 * to knowledge/index/live_silent.json).
 *
 * For each derive commit D after the first in the range, with A = the aggregate commit it was built on (its parent) and
 * B = the commit that aggregate started from (A's parent): the snapshot is rebuilt from B's event map, the record from
 * the partitions of the derive commit before D (what that derive wrote, by the round-25 rule), and the check runs on
 * A's event map at D's `generated`. Writes nothing but the checkout of the replay directory.
 *
 * --failed-derive replays every run as if the derive before it had failed after its aggregate commit: the run checks out
 * that aggregate's event map with the partitions, manifest and record of the derive before (D two back), so the days the
 * failed run's aggregate changed come from that derive's Pages copy (here: its committed partitions, the same bytes);
 * --no-pages replays them without it (no baseline for those days). Production is not compared then.
 *
 * Usage (a detached worktree of `data` the script may check out at will; never pushed):
 *   git worktree add --detach /tmp/data-replay origin/data
 *   npx tsx scripts/live-baseline-replay.ts --dir /tmp/data-replay --from <commit> --to <commit> [--failed-derive]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEventMap } from '../src/bitemporal.js';
import { EVENT_MAP_HORIZON_DAYS } from '../src/config.js';
import { baselineDays, baselineRecord, partitionTexts, previousWindowLines, recoverFromPages, type BaselineSnapshot } from '../src/live-baseline.js';
import { detectSilentChanges, liveWindowDays, silentChangesAgainst } from '../src/live-sync.js';
import { dayPartitionFile, partitionPath } from '../src/partitions.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = opt('--dir');
const from = opt('--from');
const to = opt('--to') ?? 'HEAD';
if (!dir || !from) {
  console.error('usage: npx tsx scripts/live-baseline-replay.ts --dir <data worktree> --from <commit> [--to <commit>]');
  process.exit(2);
}

const failedDerive = args.includes('--failed-derive');
const noPages = args.includes('--no-pages');
const git = (...a: string[]): string => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const checkout = (c: string): void => {
  git('checkout', '-q', '-f', '--detach', c);
};
const readJson = <T>(rel: string): T | null => {
  const f = join(dir, rel);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : null;
};

const log = git('log', '--first-parent', '--reverse', '--format=%H %P|%s', `${from}^..${to}`)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [ids, subject] = [l.slice(0, l.indexOf('|')), l.slice(l.indexOf('|') + 1)];
    const [sha, parent] = ids.split(' ');
    return { sha: sha!, parent: parent ?? '', subject };
  });
const subjectOf = new Map(log.map((c) => [c.sha, c.subject]));
const derives = log.filter((c) => c.subject.startsWith('derive: views'));

const totals = { runs: 0, skipped: 0, equal: 0, differ: 0, matchesProduction: 0, productionDiffers: 0, silent: 0, daysSnapshot: 0, daysFromPages: 0, daysMissing: 0 };
const notes: string[] = [];
const started = Date.now();

for (let i = failedDerive ? 2 : 1; i < derives.length; i++) {
  const prevD = derives[i - (failedDerive ? 2 : 1)]!;
  const d = derives[i]!;
  const a = d.parent;
  // The commit the aggregate started from; with --failed-derive the aggregate commit of the failed run instead.
  const b = failedDerive ? derives[i - 1]!.parent : git('rev-parse', `${a}^`);
  if (!subjectOf.get(a)?.startsWith('aggregate:') || (failedDerive && !subjectOf.get(b)?.startsWith('aggregate:'))) {
    totals.skipped++;
    notes.push(`${d.sha.slice(0, 10)}: ${a.slice(0, 10)} / ${b.slice(0, 10)} is not an aggregate commit (${subjectOf.get(a) ?? 'outside the range'}), skipped`);
    continue;
  }

  // What the previous derive committed: its manifest and its partitions -> the record it would have written.
  checkout(prevD.sha);
  const prevManifest = readJson<{ generated: number; head_seq: number }>('manifest.json')!;
  const written = new Map<string, string>();
  for (const day of baselineDays(prevManifest.generated)) {
    const f = dayPartitionFile(dir, day);
    if (existsSync(f)) written.set(day, readFileSync(f, 'utf8'));
  }
  const record = baselineRecord(prevManifest.generated, prevManifest.head_seq, written);

  // The snapshot step: the event map of the commit the aggregate started from, a minute before the aggregate commit;
  // a day that differs from the record, from the previous derive's Pages copy (its committed partition: the same bytes).
  checkout(b);
  const t0 = Number(git('log', '-1', '--format=%ct', a)) * 1000 - 60_000;
  const covered = baselineDays(t0);
  const texts = partitionTexts(loadEventMap(dir, { sinceDays: EVENT_MAP_HORIZON_DAYS, nowMs: t0 }).values(), covered);
  const pages = (async (url: string | URL | Request) => {
    const rel = String(url).replace('https://pages.replay/', '');
    const blob = git('ls-tree', prevD.sha, rel) ? execFileSync('git', ['-C', dir, 'show', `${prevD.sha}:${rel}`], { encoding: 'utf8', maxBuffer: 1 << 26 }) : null;
    return blob == null ? new Response('', { status: 404 }) : new Response(blob, { status: 200 });
  }) as typeof fetch;
  const recovered = noPages ? [] : (await recoverFromPages({ days: covered, texts, record, base: 'https://pages.replay/', fetchImpl: pages })).recovered;
  const snapshot: BaselineSnapshot = { covered: new Set(covered), fromPages: new Set(recovered), text: (day) => texts.get(day) ?? null };

  // derive on the aggregate commit, at the derive run's clock.
  checkout(d.sha);
  const nowMs = readJson<{ generated: number }>('manifest.json')!.generated;
  const production = (readJson<{ entries?: { id: string; at: number }[] }>('knowledge/index/live_silent.json')?.entries ?? [])
    .filter((e) => e.at === nowMs)
    .map((e) => e.id)
    .sort();
  checkout(a);
  const window = liveWindowDays(nowMs);
  if (failedDerive) {
    // The failed derive committed nothing: the manifest and the window's partitions are those of the derive before.
    git('checkout', prevD.sha, '--', 'manifest.json');
    for (const day of window) {
      const rel = partitionPath(day);
      if (git('ls-tree', '--name-only', prevD.sha, rel)) git('checkout', prevD.sha, '--', rel);
      else if (existsSync(join(dir, rel))) git('rm', '-q', '-f', '--', rel);
    }
  }
  const prev = readJson<{ generated: number; head_seq: number }>('manifest.json')!;
  const nodes = [...loadEventMap(dir, { sinceDays: EVENT_MAP_HORIZON_DAYS, nowMs }).values()];
  const previous = previousWindowLines({ days: window, record, prev, snapshot });
  const fromBaseline = silentChangesAgainst(previous.lines, nodes, window, prev.head_seq);
  const fromPartitions = detectSilentChanges(dir, nodes, window, prev.head_seq);

  totals.runs++;
  totals.silent += fromBaseline.length;
  totals.daysSnapshot += previous.fromSnapshot.length;
  totals.daysFromPages += previous.fromSnapshot.filter((day) => snapshot.fromPages.has(day)).length;
  totals.daysMissing += previous.missing.length;
  const same = JSON.stringify(fromBaseline) === JSON.stringify(fromPartitions);
  if (same) totals.equal++;
  else {
    totals.differ++;
    notes.push(`${d.sha.slice(0, 10)} ${new Date(nowMs).toISOString()}: baseline [${fromBaseline.join(',')}] partitions [${fromPartitions.join(',')}]`);
  }
  if (failedDerive) {
    // Not comparable with production, which ran after a derive that succeeded.
  } else if (JSON.stringify(fromPartitions) === JSON.stringify(production)) totals.matchesProduction++;
  else {
    totals.productionDiffers++;
    notes.push(`${d.sha.slice(0, 10)} ${new Date(nowMs).toISOString()}: production [${production.join(',')}] replayed partitions [${fromPartitions.join(',')}]`);
  }
  if (previous.missing.length || recovered.length || previous.recordUnused) {
    notes.push(
      `${d.sha.slice(0, 10)} ${new Date(nowMs).toISOString()}: ${recovered.length} day(s) from Pages [${recovered.join(',')}], ${previous.missing.length} without a baseline [${previous.missing.join(',')}]` +
        `${previous.recordUnused ? ` (${previous.recordUnused})` : ''}`,
    );
  }
  if (fromBaseline.length) console.log(`${new Date(nowMs).toISOString()} ${d.sha.slice(0, 10)}: silent ${fromBaseline.length} [${fromBaseline.slice(0, 4).join(', ')}${fromBaseline.length > 4 ? ', ...' : ''}]`);
}

console.log(`\nreplay ${derives[0]?.sha.slice(0, 10)}..${derives.at(-1)?.sha.slice(0, 10)} (${derives.length} derive commits) in ${Math.round((Date.now() - started) / 1000)} s`);
console.log(JSON.stringify(totals));
for (const n of notes.slice(0, 60)) console.log(`  ${n}`);
if (notes.length > 60) console.log(`  ... ${notes.length - 60} more`);
process.exit(totals.differ ? 1 : 0);
