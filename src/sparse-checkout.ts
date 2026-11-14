import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The data checkout's git view, for a writer that runs on a sparse checkout of `data` (backfill.yml since SHLTR-149:
 * the full checkout took 94–101 s of the writer lock while the backfill itself took 0–2 s). A file that is in the tree
 * but not checked out looks absent to `existsSync`, and an absent day partition reads as an empty day: written back,
 * it would truncate the day (the 2026-07 failure mode). So a sparse writer lists names from git, never from the
 * worktree, and checks that everything it reads is checked out before it reads anything.
 */

const git = (root: string, args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

/** Whether `root` is a git checkout with sparse checkout on. False outside git (a local data directory). */
export function isSparseCheckout(root: string): boolean {
  try {
    return git(root, ['config', '--bool', 'core.sparseCheckout']).trim() === 'true';
  } catch {
    return false;
  }
}

/** The names (not paths) of the entries of directory `rel` (relative to the checkout) in HEAD's tree. Throws on a git failure. */
export function treeNames(root: string, rel: string): string[] {
  const dir = rel.endsWith('/') ? rel : `${rel}/`;
  return git(root, ['ls-tree', '--name-only', 'HEAD', '--', dir])
    .split('\n')
    .filter(Boolean)
    .map((p) => p.slice(p.lastIndexOf('/') + 1));
}

/** Every file path under the directories `rels` in HEAD's tree (recursive). Throws on a git failure. */
export function treeFiles(root: string, rels: readonly string[]): string[] {
  return git(root, ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...rels]).split('\n').filter(Boolean);
}

/** The paths of `wanted` that are in HEAD's tree but not in the worktree. Pure over its inputs. */
export function missingFromWorktree(inTree: Iterable<string>, wanted: (path: string) => boolean, exists: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const p of inTree) if (wanted(p) && !exists(p)) out.push(p);
  return out.sort();
}

/**
 * On a sparse checkout, throw unless every file of the tree that `wanted` selects under `dirs` is checked out. A
 * full checkout (or no git) passes untouched.
 */
export function assertCheckedOut(root: string, dirs: readonly string[], wanted: (path: string) => boolean): void {
  if (!isSparseCheckout(root)) return;
  const missing = missingFromWorktree(treeFiles(root, dirs), wanted, (p) => existsSync(join(root, p)));
  if (missing.length) {
    throw new Error(
      `the sparse data checkout lacks ${missing.length} file(s) this run reads (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}): ` +
        'refusing to read them as absent (an absent day partition is an empty day, and writing it back would truncate it)',
    );
  }
}
