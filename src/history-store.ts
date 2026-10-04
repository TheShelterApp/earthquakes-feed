import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { REPO } from './config.js';
import { gh, ghRetry, ghRetryNet, sleepMs } from './gh.js';

/**
 * Deep history (PF-5j): where the immutable assets go. In production the `history-YYYY` GitHub Releases; in a dry run
 * a local directory with the same layout (`<dir>/<tag>/<asset>`), so a dry run exercises every step except the
 * upload and can be resumed like the real walk. Neither ever overwrites or deletes an asset.
 */

export interface AssetInfo {
  name: string;
  size: number;
  /** GitHub's asset state: `uploaded` when complete (a failed upload can leave `starter`). */
  state: string;
}

export interface HistoryStore {
  readonly label: string;
  list(tag: string): AssetInfo[];
  ensureRelease(tag: string): void;
  /** Upload `file` under its basename. Refuses when the name exists: assets are never overwritten. */
  upload(tag: string, file: string): void;
  download(tag: string, asset: string, dest: string): void;
}

export class GitHubStore implements HistoryStore {
  readonly label = `GitHub Releases of ${REPO}`;

  /** `notesFor` names a new release's notes; the default describes a deep-history year (history-YYYY). */
  constructor(private readonly notesFor?: (tag: string) => string) {}

  list(tag: string): AssetInfo[] {
    let id: string;
    try {
      id = ghRetryNet(['api', `repos/${REPO}/releases/tags/${tag}`, '--jq', '.id']).trim();
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message ?? '');
      if (/HTTP 404|Not Found/i.test(msg)) return [];
      throw e;
    }
    // The assets endpoint, paginated: a year of the full walk holds a few hundred assets.
    const out = ghRetryNet(['api', '--paginate', `repos/${REPO}/releases/${id}/assets?per_page=100`, '--jq', '.[] | [.name, .size, .state] | @tsv']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, size, state] = l.split('\t');
        return { name: name!, size: Number(size), state: state ?? '' };
      });
  }

  ensureRelease(tag: string): void {
    try {
      gh(['release', 'view', tag, '-R', REPO, '--json', 'tagName']);
      return;
    } catch {
      /* not created yet */
    }
    const notes =
      this.notesFor?.(tag) ??
      `Deep history of earthquakes-feed for ${tag.slice(-4)} (before the 3-year layer): immutable raw source answers ` +
        '(raw-<source>-<YYYY-MM>.ndjson.zst) and monthly events editions (events-<YYYY-MM>.e<N>.tar.zst). Index: ' +
        'knowledge/index/history.json on the data branch; format: APIs.md, Deep history.';
    try {
      // --latest=false: these Releases must never become the repository's "Latest release".
      ghRetryNet(['release', 'create', tag, '-R', REPO, '--target', 'main', '--title', tag, '--notes', notes, '--latest=false']);
    } catch {
      sleepMs(3_000);
      ghRetryNet(['release', 'view', tag, '-R', REPO, '--json', 'tagName']);
    }
  }

  upload(tag: string, file: string): void {
    if (this.list(tag).some((a) => a.name === basename(file))) throw new Error(`asset ${tag}/${basename(file)} already exists; history never overwrites an asset`);
    // No --clobber, ever: a name that appeared meanwhile makes the upload fail instead of replacing it.
    ghRetry(['release', 'upload', tag, file, '-R', REPO]);
  }

  download(tag: string, asset: string, dest: string): void {
    ghRetry(['release', 'download', tag, '-R', REPO, '-p', asset, '-O', dest, '--clobber']);
  }
}

export class LocalStore implements HistoryStore {
  constructor(private readonly dir: string) {}

  get label(): string {
    return `local directory ${this.dir} (dry run: nothing is uploaded)`;
  }

  list(tag: string): AssetInfo[] {
    const d = join(this.dir, tag);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .sort()
      .map((name) => ({ name, size: statSync(join(d, name)).size, state: 'uploaded' }));
  }

  ensureRelease(tag: string): void {
    mkdirSync(join(this.dir, tag), { recursive: true });
  }

  upload(tag: string, file: string): void {
    const dest = join(this.dir, tag, basename(file));
    if (existsSync(dest)) throw new Error(`asset ${tag}/${basename(file)} already exists; history never overwrites an asset`);
    mkdirSync(join(this.dir, tag), { recursive: true });
    copyFileSync(file, dest);
  }

  download(tag: string, asset: string, dest: string): void {
    const src = join(this.dir, tag, asset);
    if (!existsSync(src)) throw new Error(`no asset ${tag}/${asset} in ${this.dir}`);
    copyFileSync(src, dest);
  }
}
