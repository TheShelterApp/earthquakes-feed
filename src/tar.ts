import { execFileSync } from 'node:child_process';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Deterministic tarballs (C5): the same members give the same bytes, so a re-run's upload has the checksum of the asset
 * an interrupted run left (adoption by checksum) and a rebuild can be compared byte for byte. GNU tar (the runners')
 * gets sorted names, mtime 0 and owner/group 0; bsdtar (macOS, local runs) has no such flags: the members' mtimes are
 * set to 0 before the plain call, which makes its output repeatable on one machine (owner and group stay the user's).
 */
let gnu: boolean | null = null;
export function isGnuTar(): boolean {
  if (gnu == null) {
    try {
      gnu = /GNU tar/.test(execFileSync('tar', ['--version'], { encoding: 'utf8' }));
    } catch {
      gnu = false;
    }
  }
  return gnu;
}

/** tar `members` (names relative to `dir`, written in the order given after sorting) into `tarPath`. */
export function createTar(tarPath: string, dir: string, members: readonly string[]): void {
  const sorted = [...members].sort();
  for (const m of sorted) utimesSync(join(dir, m), 0, 0);
  const det = isGnuTar() ? ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner'] : [];
  execFileSync('tar', [...det, '-cf', tarPath, '-C', dir, ...sorted]);
}
