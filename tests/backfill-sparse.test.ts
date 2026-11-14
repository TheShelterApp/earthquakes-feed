import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sparseMonthPatterns, windowDays } from '../src/backfill-plan.js';
import { dayStartMs } from '../src/backfill-cursor.js';
import { isSparseCheckout, missingFromWorktree, treeNames } from '../src/sparse-checkout.js';

// SHLTR-149: backfill.yml holds the writer lock on a sparse, blobless checkout of `data` (the full checkout took 94–101 s
// of the 2 min 15 s each backfill held the lock on 2026-11-08). The plan step prints the months a run reads and writes,
// and the run refuses to read a partition (or an index file) that is in the tree but not checked out: an absent day
// would read as an empty one and truncate it on write-back. Real git repositories in a temporary directory.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DAY = 86_400_000;

test('windowDays: the windows\' days with a day of margin on each side, stopping before the live day', () => {
  const jobs = [
    { startMs: dayStartMs('2026-08-30'), endMs: dayStartMs('2026-09-02') },
    { startMs: dayStartMs('2026-09-01'), endMs: dayStartMs('2026-09-03') + DAY - 1 },
  ];
  assert.deepEqual(windowDays(jobs, '2026-10-01'), ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  assert.deepEqual(windowDays(jobs, '2026-09-02'), ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01']);
  assert.deepEqual(windowDays([], '2026-10-01'), []);
  assert.deepEqual(sparseMonthPatterns(windowDays(jobs, '2026-10-01')), ['/events/2026/08/', '/events/2026/09/']);
  assert.deepEqual(sparseMonthPatterns(['2025-12-31', '2026-01-01']), ['/events/2025/12/', '/events/2026/01/']);
});

test('missingFromWorktree: the wanted tree paths that are not checked out', () => {
  const tree = ['events/2026/09/01.ndjson', 'events/2026/09/02.ndjson', 'knowledge/index/head.json'];
  const wanted = (p: string): boolean => p.startsWith('events/');
  assert.deepEqual(missingFromWorktree(tree, wanted, (p) => p.endsWith('01.ndjson')), ['events/2026/09/02.ndjson']);
  assert.deepEqual(missingFromWorktree(tree, wanted, () => true), []);
});

/** git with a private HOME (no user config, no signing) and a fixed identity. */
function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_AUTHOR_NAME: 'earthquakes-feed-bot',
    GIT_AUTHOR_EMAIL: 'bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'earthquakes-feed-bot',
    GIT_COMMITTER_EMAIL: 'bot@users.noreply.github.com',
  };
}

/** A `data` branch with the index files, two event-map shards (the live window starts 2026-10-01) and three partitions;
 *  `clone(patterns)` makes a blobless, depth-1, sparse clone of it as actions/checkout does. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-sparse-'));
  const e = gitEnv(dir);
  writeFileSync(join(dir, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = data\n[uploadpack]\n\tallowFilter = true\n\tallowAnySHA1InWant = true\n');
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = join(dir, 'origin');
  const files: Record<string, string> = {
    'knowledge/index/backfill.json': '{"targetStart":"2023-07-06","providers":{}}\n',
    'knowledge/index/archives.json': '{"list":[]}\n',
    'knowledge/index/head.json': '{"seq":5,"ingest_time":"2026-11-14T15:00:00.000Z"}\n',
    'knowledge/index/partitions.json': '{}\n',
    'knowledge/index/event_map/2026-10-01-00.ndjson': '\n',
    'knowledge/index/event_map/2026-10-02-00.ndjson': '\n',
    'events/2026/08/31.ndjson': '{"x":1}\n',
    'events/2026/09/15.ndjson': '{"x":2}\n',
    'events/2026/10/02.ndjson': '{"x":3}\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(origin, rel)), { recursive: true });
    writeFileSync(join(origin, rel), text);
  }
  git(dir, 'init', '-q', origin);
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'seed');
  let n = 0;
  const clone = (patterns: string[]): string => {
    const work = join(dir, `work${n++}`);
    git(dir, 'clone', '-q', '--filter=blob:none', '--depth', '1', '--no-checkout', `file://${origin}`, work);
    git(work, 'sparse-checkout', 'set', '--no-cone', ...patterns);
    git(work, 'checkout', '-q', 'data');
    return work;
  };
  return { dir, e, git, clone };
}

const backfill = (s: ReturnType<typeof setup>, data: string, extra: Record<string, string>) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/backfill.ts'], {
    cwd: ROOT,
    env: {
      ...s.e,
      DATA_DIR: data,
      BACKFILL_STARTTIME: '2026-08-30T00:00:00Z',
      BACKFILL_ENDTIME: '2026-10-05T00:00:00Z',
      BACKFILL_PROVIDERS: 'usgs',
      ...extra,
    },
    encoding: 'utf8',
  });

test('backfill on a sparse checkout: the plan step names the months before the live window (from git, not the missing shards); once added, they are checked out', () => {
  const s = setup();
  const work = s.clone(['/knowledge/index/*.json']);
  assert.equal(isSparseCheckout(work), true);
  assert.equal(existsSync(join(work, 'knowledge/index/event_map')), false, 'the shards are not checked out');
  assert.deepEqual(treeNames(work, 'knowledge/index/event_map'), ['2026-10-01-00.ndjson', '2026-10-02-00.ndjson']);
  const out = join(s.dir, 'paths.txt');
  const r = backfill(s, work, { BACKFILL_PHASE: 'paths', BACKFILL_PATHS_OUT: out });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // 2026-08-29 .. 2026-09-30: the live window (2026-10-01 on, from the shard names in git) is never touched. Had the
  // missing directory read as "no shards", the live day would be today and October would be in the list.
  assert.equal(readFileSync(out, 'utf8'), '/events/2026/08/\n/events/2026/09/\n');
  assert.match(r.stdout, /backfill: 1 window\(s\) over 2026-08-29\.\.2026-09-30: 2 month\(s\) to check out/);
  execFileSync('git', ['-C', work, 'sparse-checkout', 'add', '--stdin'], { input: readFileSync(out), env: s.e });
  assert.equal(readFileSync(join(work, 'events/2026/09/15.ndjson'), 'utf8'), '{"x":2}\n');
  assert.equal(existsSync(join(work, 'events/2026/10/02.ndjson')), false, 'the live month stays out');
});

test('backfill on a sparse checkout refuses to run when a partition of its window, or an index file, is not checked out', () => {
  const s = setup();
  // The months were never added: the run stops before any request, naming the missing days.
  const work = s.clone(['/knowledge/index/*.json']);
  const r = backfill(s, work, {});
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /the sparse data checkout lacks 2 file\(s\) this run reads \(events\/2026\/08\/31\.ndjson, events\/2026\/09\/15\.ndjson\): refusing/);
  // No index files: the cursor would read as absent and every walk restart at the live edge.
  const bare = s.clone(['/events/2026/09/']);
  const r2 = backfill(s, bare, { BACKFILL_PHASE: 'paths', BACKFILL_PATHS_OUT: join(s.dir, 'p2.txt') });
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stderr, /lacks 4 file\(s\) this run reads \(knowledge\/index\/archives\.json, knowledge\/index\/backfill\.json, knowledge\/index\/head\.json, knowledge\/index\/partitions\.json\)/);
  assert.equal(existsSync(join(s.dir, 'p2.txt')), false);
});

test('backfill.yml commit step on a sparse checkout: stages the changes inside it, refuses a new file outside it, never stages a day it did not check out', () => {
  // 2026-11-14 15:43Z: `git add events knowledge` exited 1 on the first gated walk, which checked out no month (nothing
  // to fill): a pathspec that matches only paths outside the sparse checkout is an error. The step now runs the line
  // below from backfill.yml itself, so the test and the workflow cannot drift.
  const yml = readFileSync(join(ROOT, '.github/workflows/backfill.yml'), 'utf8');
  const addLine = yml.split('\n').map((l) => l.trim()).find((l) => l.startsWith('git add'));
  assert.equal(addLine, 'git add -A');
  const s = setup();
  const add = (cwd: string) => spawnSync('git', ['add', '-A'], { cwd, env: s.e, encoding: 'utf8' });
  const staged = (cwd: string) => s.git(cwd, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);

  // A walk with nothing to fill: only the index files, the cursor rewritten.
  const walk = s.clone(['/knowledge/index/*.json']);
  writeFileSync(join(walk, 'knowledge/index/backfill.json'), '{"targetStart":"2023-07-06","providers":{"usgs":{}}}\n');
  assert.equal(spawnSync('git', ['add', 'events', 'knowledge'], { cwd: walk, env: s.e }).status, 1, 'the old pathspecs fail with no month checked out');
  const r = add(walk);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(staged(walk), ['knowledge/index/backfill.json']);

  // A window run: one month checked out, a day rewritten and a new day added inside it.
  const win = s.clone(['/knowledge/index/*.json', '/events/2026/09/']);
  writeFileSync(join(win, 'events/2026/09/15.ndjson'), '{"x":2}\n{"x":4}\n');
  writeFileSync(join(win, 'events/2026/09/16.ndjson'), '{"x":5}\n');
  assert.equal(add(win).status, 0);
  assert.deepEqual(staged(win), ['events/2026/09/15.ndjson', 'events/2026/09/16.ndjson']);

  // A new file in a month that is not checked out: refused, nothing more is staged.
  const stray = s.clone(['/knowledge/index/*.json']);
  mkdirSync(join(stray, 'events/2026/08'), { recursive: true });
  writeFileSync(join(stray, 'events/2026/08/30.ndjson'), '{"x":6}\n');
  const r2 = add(stray);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /outside of your sparse-checkout definition/);
  assert.deepEqual(staged(stray), []);

  // A rewrite of a tracked day that is not checked out (the truncation shape): never staged.
  const trunc = s.clone(['/knowledge/index/*.json']);
  mkdirSync(join(trunc, 'events/2026/08'), { recursive: true });
  writeFileSync(join(trunc, 'events/2026/08/31.ndjson'), '');
  add(trunc);
  assert.deepEqual(staged(trunc), []);
});
