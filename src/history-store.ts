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
  /** Releases this store has seen or created, and the asset names of each as it last listed them plus its own uploads
   *  since: a walk that uploads dozens of assets per run asks the API once per Release instead of before every upload
   *  (the GITHUB_TOKEN allows 1,000 REST requests per hour per repository, shared by every workflow). `list` itself is
   *  never cached: callers that check an upload read the Release as it is. */
  private readonly knownReleases = new Set<string>();
  private readonly knownNames = new Map<string, Set<string>>();

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
    this.knownReleases.add(tag);
    // The assets endpoint, paginated: a year of the full walk holds a few hundred assets.
    const out = ghRetryNet(['api', '--paginate', `repos/${REPO}/releases/${id}/assets?per_page=100`, '--jq', '.[] | [.name, .size, .state] | @tsv']);
    const assets = out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, size, state] = l.split('\t');
        return { name: name!, size: Number(size), state: state ?? '' };
      });
    this.knownNames.set(tag, new Set(assets.map((a) => a.name)));
    return assets;
  }

  ensureRelease(tag: string): void {
    if (this.knownReleases.has(tag)) return;
    try {
      gh(['release', 'view', tag, '-R', REPO, '--json', 'tagName']);
      this.knownReleases.add(tag);
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
    this.knownReleases.add(tag);
  }

  upload(tag: string, file: string): void {
    const names = this.knownNames.get(tag) ?? new Set(this.list(tag).map((a) => a.name));
    if (names.has(basename(file))) throw new Error(`asset ${tag}/${basename(file)} already exists; history never overwrites an asset`);
    // No --clobber, ever: a name that appeared meanwhile (another writer, after this store listed the Release) makes the
    // upload fail instead of replacing it.
    ghRetry(['release', 'upload', tag, file, '-R', REPO]);
    (this.knownNames.get(tag) ?? this.knownNames.set(tag, names).get(tag)!).add(basename(file));
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

/**
 * A dry run of a walk that already has assets in production (edition 2 of a month needs the published raw assets of
 * the sources fetched before): reads the published Releases (read only) and writes only to the local directory.
 * `list` is both, the local copy winning a name both hold; `download` takes the local copy when there is one, else the
 * published asset; `ensureRelease` and `upload` touch the local directory only, and an upload under a name the
 * Release already holds is refused (a dry run never shadows a published asset; the walk takes the next free name).
 */
export class DryRunStore implements HistoryStore {
  constructor(
    private readonly local: HistoryStore,
    private readonly published: HistoryStore,
  ) {}

  get label(): string {
    return `${this.local.label}, reading the published assets of ${this.published.label} (read only)`;
  }

  list(tag: string): AssetInfo[] {
    const mine = this.local.list(tag);
    const names = new Set(mine.map((a) => a.name));
    return [...this.published.list(tag).filter((a) => !names.has(a.name)), ...mine].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  ensureRelease(tag: string): void {
    this.local.ensureRelease(tag);
  }

  upload(tag: string, file: string): void {
    if (this.published.list(tag).some((a) => a.name === basename(file))) throw new Error(`asset ${tag}/${basename(file)} is published; history never overwrites an asset`);
    this.local.upload(tag, file);
  }

  download(tag: string, asset: string, dest: string): void {
    if (this.local.list(tag).some((a) => a.name === asset)) this.local.download(tag, asset, dest);
    else this.published.download(tag, asset, dest);
  }
}
