import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from './config.js';
import { parseGeneration, type Generation } from './event-map-store.js';
import { BATCH_MAX, GC_MAX_KEEP, backendFromEnv, type GcPage, type StateBackend } from './state-store.js';

/**
 * The state store's garbage collection (state-gc.yml; storage phase 3, APIs.md "Repository size"). Every aggregate run
 * that changes an event-map day uploads a new blob (about 1.4 days a run, 0.3 MB each); nothing in the store is ever
 * overwritten, so GC deletes the blobs no generation that must stay restorable names any more. What stays (`keep`):
 *
 * - the current generation of `data` (read under the writer lock, which this job holds: no persist runs meanwhile, so
 *   no blob can be re-referenced between the read and the delete);
 * - the generation at the last data commit before each of the last GC_DAILY_DAYS UTC midnights (one restorable state
 *   a day for a month; state-backup.yml copies the same daily generations to Releases, for ever);
 * - every daily generation since the first day state-backup has not yet copied (its marker, the artifact state-backup):
 *   a stalled backup never loses its sources. Without a readable marker, or with one that names no backed-up day (no
 *   generation yet, or the store off at its run), nothing is deleted (a dry run). Only a marker of a scheduled or
 *   dispatched state-backup.yml run on this repository's main counts (readBackupMarkerWithGh): the repository is public,
 *   and a pull request's run can upload an artifact of any name.
 *
 * The Worker deletes only blobs older than minAgeDays (GC_MIN_AGE_DAYS: 30 days of intra-day versions stay
 * restorable), at most maxDeletes a listing page, and refuses (409) unless the current generation's blobs are in `keep`
 * and exist. The generations come from GitHub's API (commits?sha=data&until=, contents?ref=), not from a checkout: 31
 * days are about 9,000 commits. A generation that cannot be parsed stops the run: `keep` is never computed from less
 * than every generation it needs.
 *
 * Dry run: a dispatch's `dry_run` input (default true); the scheduled run follows STATE_GC_SCHEDULED.
 *
 * Skipped (no call to the store, a hold): no generation on `data` yet or one that names no blob (before the first
 * persist, or an empty map), or a keep set outside the Worker's 1..10,000: the Worker would refuse the call (400), and
 * there is nothing to check the keep set against. The run still completes and writes its marker (`skipped`).
 *
 * The store off (FEED_STATE_BACKEND off or unset: the repository variable set to `off`, phase 3a's kill switch): nothing
 * is read or called; the run completes and writes its marker with `off: true`.
 *
 *   GH_TOKEN=… FEED_STATE_BACKEND=worker STATE_GC_DRY_RUN=1 npx --no-install tsx src/state-gc.ts
 */

/** The scheduled run's mode: 'dry-run' for the first weeks of phase 3a (every page listed, nothing deleted), then
 *  'delete' by a reviewed commit, once the dry runs' counts look right (APIs.md "Repository size", runbook). */
export const STATE_GC_SCHEDULED: 'dry-run' | 'delete' = 'dry-run';
export const GC_MIN_AGE_DAYS = 30;
export const GC_MAX_DELETES = 600;
export const GC_DAILY_DAYS = 31;
/** A backup stalled further back than this stops deletion (and the GitHub reads it would take) until it catches up. */
export const GC_MAX_WINDOW_DAYS = 120;
/** At most this many listing pages a run (1,000 keys each): far above the bucket's expected ~15,000 objects. */
export const GC_MAX_PAGES = 100;
export const GENERATION_PATH = 'knowledge/index/generation.json';

const DAY_MS = 86_400_000;
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number): string => dayKey(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

/** state-backup.yml's marker as GC reads it. */
export interface BackupMarker {
  /** The newest day whose state (the generation at its 00:00 UTC) is in a Release, or null. */
  newest: string | null;
  /** The oldest day of the backup's window whose state is not in a Release yet, or null when none is missing. */
  first_missing: string | null;
}

export interface GcSources {
  /** The last `data` commit before `iso` (exclusive), or null when there is none. */
  commitBefore(iso: string): Promise<string | null>;
  /** generation.json at a ref, or null when the ref has none. */
  generationAt(ref: string): Promise<string | null>;
  /** state-backup's newest marker, or null when none can be read. */
  backupMarker(): Promise<BackupMarker | null>;
}

export interface KeepPlan {
  keep: string[];
  current: string[];
  /** The first UTC midnight whose generation is kept. */
  windowFrom: string;
  /** Per midnight: the commit and how many blobs its generation names (0: no generation then). */
  boundaries: { day: string; commit: string | null; blobs: number }[];
  /** Why nothing may be deleted this run (the run is then a dry run), or null. */
  holdReason: string | null;
}

const blobsOf = (g: Generation): string[] => Object.values(g.days).map((e) => e.blob);

/** The keep set (module comment). Throws when the current generation is missing or any generation is unreadable. */
export async function planKeep(src: GcSources, nowMs: number): Promise<KeepPlan> {
  const today = dayKey(nowMs);
  const currentText = await src.generationAt('data');
  if (currentText == null) {
    // Before the first persist: nothing to collect against, nothing read further (a skip, its marker written).
    return { keep: [], current: [], windowFrom: today, boundaries: [], holdReason: `the data branch has no ${GENERATION_PATH} yet (before the first persist): GC is skipped` };
  }
  const current = [...new Set(blobsOf(parseGeneration(currentText)))].sort();
  const backup = await src.backupMarker();
  let holdReason: string | null = null;
  let windowFrom = addDays(today, -GC_DAILY_DAYS);
  if (!backup) holdReason = 'no state-backup marker could be read: nothing is deleted until the backup is known';
  else if (!backup.newest && !backup.first_missing) {
    holdReason = 'the newest state-backup marker names no backed-up day (no generation yet, or the store off at its run): nothing is deleted until a backup has copied one';
  } else {
    const firstUnbacked = backup.first_missing ?? (backup.newest ? addDays(backup.newest, 1) : null);
    if (firstUnbacked && firstUnbacked < windowFrom) windowFrom = firstUnbacked;
  }
  const oldest = addDays(today, -GC_MAX_WINDOW_DAYS);
  if (windowFrom < oldest) {
    holdReason = `the state backup is behind since ${windowFrom}, more than ${GC_MAX_WINDOW_DAYS} days: nothing is deleted until it catches up`;
    windowFrom = oldest;
  }
  const keep = new Set(current);
  const boundaries: KeepPlan['boundaries'] = [];
  for (let day = windowFrom; day <= today; day = addDays(day, 1)) {
    const commit = await src.commitBefore(`${day}T00:00:00Z`);
    const text = commit ? await src.generationAt(commit) : null;
    const blobs = text == null ? [] : blobsOf(parseGeneration(text));
    for (const b of blobs) keep.add(b);
    boundaries.push({ day, commit, blobs: blobs.length });
  }
  const sorted = [...keep].sort();
  const skip = gcSkipReason({ keep: sorted, current });
  if (skip) holdReason ??= `${skip}: GC is skipped`;
  return { keep: sorted, current, windowFrom, boundaries, holdReason };
}

export interface GcResult {
  dryRun: boolean;
  /** Why no call was made (gcSkipReason), or null. */
  skipped: string | null;
  pages: number;
  listed: number;
  /** Deleted (0 in a dry run). */
  deleted: number;
  bytesDeleted: number;
  /** Selected by the rules: deleted, or in a dry run what would have been. */
  wouldDelete: number;
  bytesWouldDelete: number;
  /** In the keep set. */
  kept: number;
  /** Not kept but younger than GC_MIN_AGE_DAYS. */
  young: number;
  /** Deletable but over GC_MAX_DELETES on their page (the next run takes them). */
  capped: number;
  /** Keys outside the CAS layout (never deleted). */
  foreign: number;
}

/** Why `plan` cannot go to the store at all (module comment), or null. */
export function gcSkipReason(plan: Pick<KeepPlan, 'keep' | 'current'>): string | null {
  if (plan.current.length === 0) return 'the current generation names no blob: nothing to check the keep set against';
  if (plan.keep.length > GC_MAX_KEEP) return `the keep set holds ${plan.keep.length} blobs, over the store's ${GC_MAX_KEEP} a call`;
  return null;
}

/** One line of counts (a page's or a run's). */
export function gcCounts(r: Omit<GcPage, 'cursor'>): string {
  const mb = (b: number): string => (b / 1e6).toFixed(1);
  const action = r.dryRun ? `would delete ${r.wouldDelete} (${mb(r.bytesWouldDelete)} MB)` : `deleted ${r.deleted} (${mb(r.bytesDeleted)} MB)`;
  return `listed ${r.listed}, ${action}, kept ${r.kept} (in keep), ${r.young} young, ${r.capped} capped, ${r.foreign} foreign`;
}

/**
 * Page through the bucket. The Worker checks at most BATCH_MAX `current` blobs a call, so the current generation goes
 * out in chunks: every chunk but the last in a dry-run call (it lists a page and deletes nothing), the last with the
 * first real page; later pages send none (cursor set).
 */
export async function collect(backend: StateBackend, plan: KeepPlan, opts: { dryRun: boolean; log?: (l: string) => void }): Promise<GcResult> {
  const log = opts.log ?? (() => {});
  const out: GcResult = { dryRun: opts.dryRun, skipped: gcSkipReason(plan), pages: 0, listed: 0, deleted: 0, bytesDeleted: 0, wouldDelete: 0, bytesWouldDelete: 0, kept: 0, young: 0, capped: 0, foreign: 0 };
  if (out.skipped) {
    log(`state GC skipped: ${out.skipped}`);
    return out;
  }
  const chunks: string[][] = [];
  for (let i = 0; i < plan.current.length; i += BATCH_MAX) chunks.push(plan.current.slice(i, i + BATCH_MAX));
  const base = { keep: plan.keep, minAgeDays: GC_MIN_AGE_DAYS, maxDeletes: GC_MAX_DELETES };
  for (const chunk of chunks.slice(0, -1)) await backend.gc({ ...base, current: chunk, cursor: null, dryRun: true });
  let cursor: string | null = null;
  do {
    if (out.pages >= GC_MAX_PAGES) throw new Error(`state GC: more than ${GC_MAX_PAGES} listing pages: stopping (is the bucket growing unbounded?)`);
    const page: GcPage = await backend.gc({ ...base, current: out.pages === 0 ? (chunks.at(-1) ?? []) : [], cursor, dryRun: opts.dryRun });
    out.pages++;
    for (const k of ['listed', 'deleted', 'bytesDeleted', 'wouldDelete', 'bytesWouldDelete', 'kept', 'young', 'capped', 'foreign'] as const) out[k] += page[k];
    log(`state GC page ${out.pages}: ${gcCounts(page)}`);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub

type FetchImpl = typeof globalThis.fetch;

/** GET from GitHub's API with GH_TOKEN (3 attempts on 5xx, 429 and network errors); null on a 404. */
async function ghGet(path: string, token: string, accept: string, fetchImpl: FetchImpl): Promise<Response | null> {
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, attempt * 2_000));
    try {
      const res = await fetchImpl(`https://api.github.com${path}`, {
        headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'earthquakes-feed-state-gc' },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return null;
      if (res.ok) return res;
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(`GitHub ${path}: ${last}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The run ids behind the non-expired `name` artifacts of an artifacts listing, newest first, of runs on this
 * repository's `main` only (workflow_run.head_branch main, head_repository_id = repository_id): a fork's pull request
 * can upload an artifact named state-backup into this public repository's listing.
 */
export function mainArtifactRuns(listing: unknown, name: string): number[] {
  const list = isObj(listing) && Array.isArray(listing.artifacts) ? listing.artifacts : [];
  return list
    .filter((a): a is Record<string, unknown> => isObj(a) && a.name === name && a.expired !== true && typeof a.created_at === 'string')
    .filter((a) => {
      const wr = a.workflow_run;
      return isObj(wr) && typeof wr.id === 'number' && wr.head_branch === 'main' && typeof wr.repository_id === 'number' && wr.head_repository_id === wr.repository_id;
    })
    .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))
    .map((a) => (a.workflow_run as { id: number }).id);
}

/** Whether a workflow run (GET actions/runs/{id}) is `file` on this repository's main, by schedule or dispatch (a
 *  pull_request run executes the PR's own workflow files, so its path proves nothing). */
export function trustedRun(run: unknown, file: string): boolean {
  if (!isObj(run) || run.head_branch !== 'main' || (run.event !== 'schedule' && run.event !== 'workflow_dispatch')) return false;
  if (!isObj(run.repository) || !isObj(run.head_repository) || typeof run.repository.id !== 'number' || run.head_repository.id !== run.repository.id) return false;
  return run.path === `.github/workflows/${file}`;
}

export interface MarkerGh {
  /** gh api <path>, parsed. */
  json(path: string): unknown;
  /** The marker file of the run's state-backup artifact (gh run download). */
  download(runId: number): string;
}

const ghMarker = (repo: string): MarkerGh => ({
  json: (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 1 << 24 })) as unknown,
  download: (runId) =>
    execFileSync('bash', ['-c', `d=$(mktemp -d) && gh run download "$1" -R "$2" -n state-backup -D "$d" >/dev/null && cat "$d/state-backup.json"; s=$?; rm -rf "$d"; exit $s`, '_', String(runId), repo], { encoding: 'utf8' }),
});

/** The newest state-backup marker of a trusted run (mainArtifactRuns, then trustedRun on the newest few), or null
 *  when none can be read. */
export function readBackupMarkerWithGh(repo: string = REPO, io: MarkerGh = ghMarker(repo)): BackupMarker | null {
  try {
    const runs = mainArtifactRuns(io.json(`repos/${repo}/actions/artifacts?name=state-backup&per_page=30`), 'state-backup');
    for (const id of runs.slice(0, 5)) {
      if (!trustedRun(io.json(`repos/${repo}/actions/runs/${id}`), 'state-backup.yml')) continue;
      const m = JSON.parse(io.download(id)) as Partial<BackupMarker>;
      const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      return { newest: day(m.newest), first_missing: day(m.first_missing) };
    }
    return null;
  } catch {
    return null;
  }
}

export function githubSources(token: string, repo: string = REPO, fetchImpl: FetchImpl = globalThis.fetch): GcSources {
  return {
    async commitBefore(iso) {
      const until = new Date(Date.parse(iso) - 1000).toISOString().replace(/\.000Z$/, 'Z');
      const res = await ghGet(`/repos/${repo}/commits?sha=data&until=${encodeURIComponent(until)}&per_page=1`, token, 'application/vnd.github+json', fetchImpl);
      const list = res ? ((await res.json()) as { sha?: string }[]) : [];
      return list[0]?.sha ?? null;
    },
    async generationAt(ref) {
      const res = await ghGet(`/repos/${repo}/contents/${GENERATION_PATH}?ref=${encodeURIComponent(ref)}`, token, 'application/vnd.github.raw+json', fetchImpl);
      return res ? await res.text() : null;
    },
    async backupMarker() {
      return readBackupMarkerWithGh(repo);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The command line

/** STATE_GC_DRY_RUN: '1' a dry run, '' a deleting dispatch, 'scheduled' the scheduled run (STATE_GC_SCHEDULED). */
export function dryRunOf(raw: string | undefined): boolean {
  const v = (raw ?? '').trim();
  if (v === 'scheduled') return STATE_GC_SCHEDULED !== 'delete';
  return v !== '' && v !== '0' && v !== 'false';
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const token = env.GH_TOKEN;
  if (!token) {
    console.error('::error::state GC: GH_TOKEN is not set');
    return 3;
  }
  const backend = backendFromEnv(env);
  const nowMs = Date.now();
  if (!backend) {
    // The store is off (FEED_STATE_BACKEND off or unset): a completed run that did nothing.
    const summary = 'the state store is off (FEED_STATE_BACKEND off): nothing collected';
    console.log(`state GC: ${summary}`);
    if (env.STATE_GC_MARKER_DIR) {
      mkdirSync(env.STATE_GC_MARKER_DIR, { recursive: true });
      writeFileSync(join(env.STATE_GC_MARKER_DIR, 'state-gc.json'), `${JSON.stringify({ ok: true, off: true, at: new Date(nowMs).toISOString(), run_id: env.GITHUB_RUN_ID, skipped: summary }, null, 2)}\n`);
    }
    return 0;
  }
  const plan = await planKeep(githubSources(token), nowMs);
  const dryRun = dryRunOf(env.STATE_GC_DRY_RUN) || plan.holdReason != null;
  if (plan.holdReason) console.log(`::warning title=State GC::${plan.holdReason}`);
  const withGen = plan.boundaries.filter((b) => b.blobs > 0);
  console.log(
    `state GC: keep ${plan.keep.length} blob(s): the current generation (${plan.current.length}) and the generations at ${withGen.length} of ${plan.boundaries.length} UTC midnight(s) from ${plan.windowFrom}; ` +
      `min age ${GC_MIN_AGE_DAYS} days, at most ${GC_MAX_DELETES} deletions a page${dryRun ? ', DRY RUN' : ''} (${backend.label})`,
  );
  const r = await collect(backend, plan, { dryRun, log: (l) => console.log(l) });
  const summary = r.skipped ? `skipped: ${r.skipped}` : `${r.pages} page(s): ${gcCounts(r)}`;
  if (r.skipped && !plan.holdReason?.startsWith(r.skipped)) console.log(`::warning title=State GC::${r.skipped}`);
  console.log(`state GC: ${summary}`);
  const out = env.STATE_GC_MARKER_DIR;
  if (out) {
    mkdirSync(out, { recursive: true });
    const marker = { ok: true, at: new Date(nowMs).toISOString(), run_id: env.GITHUB_RUN_ID, dry_run: r.dryRun, hold: plan.holdReason, window_from: plan.windowFrom, keep: plan.keep.length, ...r };
    writeFileSync(join(out, 'state-gc.json'), `${JSON.stringify(marker, null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(env.GITHUB_STEP_SUMMARY, `### State GC${r.dryRun ? ' (dry run)' : ''}\n\n${summary}; window from ${plan.windowFrom}${plan.holdReason ? `; ${plan.holdReason}` : ''}\n`, { flag: 'a' });
    } catch {
      /* the summary is a convenience */
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`::error::state GC: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
