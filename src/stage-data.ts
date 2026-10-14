import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DATA_DIR } from './config.js';
import { isFrozenDay } from './partitions.js';

/**
 * What a writer of the `data` branch stages for its commit (storage option 4 phase 2; APIs.md "Repository size").
 *
 * Until phase 2 every 5-minute run committed the unfrozen day partitions (`events/YYYY/MM/DD.ndjson` of today and the 10
 * days before it), 2.5–2.8 MB each, rewritten whole on every change: about four fifths of the repository's growth. From
 * phase 2 the `data` branch holds a day partition only once the day is frozen (partitions.ts isFrozenDay). derive still
 * writes the unfrozen days into the data checkout, because the steps after the commit read them there (sign-manifest.ts
 * hashes them for the v2 `sha256` and throws on a missing file; validate.ts and publish-r2.ts read them), and copies them
 * to Pages, their only published copy until they freeze.
 *
 * So every writer that stages day partitions (derive-publish, backfill, archive) stages through this file:
 * 1. `git add -A -- <pathspecs>`, as before;
 * 2. every `events/YYYY/MM/DD.ndjson` in the index whose day is not frozen NOW leaves the index (`git rm --cached`): the
 *    file stays on disk, and one the previous commit held is deleted from the branch by this commit (the first run with
 *    phase 2 deletes the 11 unfrozen days; history is never rewritten);
 * 3. a check that nothing staged names an unfrozen day.
 *
 * A day is committed once, by the first run after it freezes: derive writes every day of the event map's 45-day
 * horizon, a day absent from the checkout is a new file, and the clock here is read after derive, so a day that froze
 * during the run (derive just before midnight, the staging just after) is committed by that run with derive's bytes —
 * no later aggregate can change it. A frozen day changes again only by a deliberate pass (a HEAL_EPOCH, an onboarding,
 * a backfill re-roll) and is then committed again. remediate.yml commits only knowledge/index/remediation.json and
 * refuses anything else; aggregate.yml and the side-index jobs stage no `events/` path.
 *
 * The unstaged files stay untracked in the checkout, which no later step of the job reads through git. push-data.sh
 * stashes them around its rebase: the first phase-2 run's commit deletes the unfrozen days from the branch, and when a
 * side-index job pushed onto the branch that still holds them, git refuses to rebase over untracked files at those
 * paths (tests/push-data.test.ts). A run is never left with a tracked unfrozen day modified but unstaged, the state
 * that broke the push retry's rebase in run 30301900011.
 *
 *   DATA_DIR=.data npx --no-install tsx src/stage-data.ts <pathspec> ...
 */

/** A day partition's path in the data checkout: `events/YYYY/MM/DD.ndjson`. */
export const PARTITION_PATH = /^events\/(\d{4})\/(\d{2})\/(\d{2})\.ndjson$/;

/** The UTC day of a day partition's path, or null for any other path. */
export function partitionDayOf(path: string): string | null {
  const m = PARTITION_PATH.exec(path);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** The day partitions among `paths` whose day is not frozen at `nowMs` (sorted). */
export function unfrozenPartitionPaths(paths: Iterable<string>, nowMs: number): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const day = partitionDayOf(p);
    if (day && !isFrozenDay(day, nowMs)) out.push(p);
  }
  return out.sort();
}

export type Git = (args: string[]) => string;

export const gitIn =
  (root: string): Git =>
  (args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });

const lines = (out: string, sep = '\n'): string[] => out.split(sep).filter(Boolean);

export interface StageResult {
  /** The unfrozen day partitions kept out of the commit (in the index after `git add`, removed from it). */
  keptOut: string[];
  /** Those of them the previous commit held: the commit deletes them from the branch (the first phase-2 run only). */
  leftBranch: string[];
  /** The day partitions the commit adds or changes (frozen days), with git's status letter: `A events/...`. */
  frozenStaged: string[];
}

/** Stages `pathspecs` of the data checkout at `root` for a commit, without the day partitions of unfrozen days. */
export function stageData(root: string, pathspecs: string[], nowMs: number, git: Git = gitIn(root)): StageResult {
  if (!pathspecs.length) throw new Error('stage-data: no pathspec');
  git(['add', '-A', '--', ...pathspecs]);
  const keptOut = unfrozenPartitionPaths(lines(git(['ls-files', '-z', '--', 'events']), '\0'), nowMs);
  let leftBranch: string[] = [];
  if (keptOut.length) {
    const hasHead = (() => {
      try {
        git(['rev-parse', '--verify', '-q', 'HEAD']);
        return true;
      } catch {
        return false;
      }
    })();
    if (hasHead) leftBranch = lines(git(['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...keptOut]), '\0').sort();
    git(['rm', '--cached', '-q', '--', ...keptOut]);
  }
  const staged = lines(git(['diff', '--cached', '--name-status', '--no-renames', '--', 'events'])).map((l) => {
    const [status, path] = l.split('\t');
    return { status: status!, path: path! };
  });
  const wrong = unfrozenPartitionPaths(
    staged.filter((s) => s.status !== 'D').map((s) => s.path),
    nowMs,
  );
  if (wrong.length) throw new Error(`stage-data: unfrozen day partition(s) still staged: ${wrong.join(', ')}`);
  return {
    keptOut,
    leftBranch,
    frozenStaged: staged.filter((s) => s.status !== 'D' && partitionDayOf(s.path)).map((s) => `${s.status} ${s.path}`),
  };
}

function main(): void {
  const pathspecs = process.argv.slice(2);
  const nowMs = Date.now();
  const r = stageData(DATA_DIR, pathspecs, nowMs);
  const days = (paths: string[]): string => paths.map((p) => partitionDayOf(p.replace(/^[A-Z] /, ''))).join(', ');
  console.log(
    `stage-data: ${pathspecs.join(' ')} staged at ${new Date(nowMs).toISOString()}; ${r.keptOut.length} unfrozen day partition(s) kept out of the commit (on disk for the steps after it)` +
      (r.keptOut.length ? `: ${days(r.keptOut)}` : ''),
  );
  if (r.leftBranch.length) console.log(`stage-data: ${r.leftBranch.length} of them leave the data branch with this commit (storage option 4 phase 2): ${days(r.leftBranch)}`);
  if (r.frozenStaged.length) console.log(`stage-data: frozen day partition(s) committed: ${r.frozenStaged.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
