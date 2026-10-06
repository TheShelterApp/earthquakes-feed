import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// FEED-TEST-1: the data-branch push loop (scripts/push-data.sh, called by aggregate.yml) against real git repositories
// in a temporary directory: a concurrent writer's commit is rebased onto and pushed, a conflict aborts the rebase and
// fails loudly with both sides intact, an unreachable origin fails after its attempts.

const SCRIPT = fileURLToPath(new URL('../scripts/push-data.sh', import.meta.url));

/** git with a private HOME (no user config, no signing) and a fixed identity. */
function env(home: string): NodeJS.ProcessEnv {
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

function setup(): { dir: string; git: (cwd: string, ...args: string[]) => string; a: string; b: string; e: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'push-data-'));
  const e = env(dir);
  writeFileSync(join(dir, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = data\n');
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(dir, 'init', '-q', '--bare', 'origin.git');
  git(dir, 'clone', '-q', join(dir, 'origin.git'), 'seed');
  const seed = join(dir, 'seed');
  writeFileSync(join(seed, 'status.json'), '{"seq":1}\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:data');
  for (const c of ['a', 'b']) git(dir, 'clone', '-q', '--branch', 'data', join(dir, 'origin.git'), c);
  return { dir, git, a: join(dir, 'a'), b: join(dir, 'b'), e };
}

const commit = (s: ReturnType<typeof setup>, repo: string, file: string, text: string, msg: string): void => {
  writeFileSync(join(repo, file), text);
  s.git(repo, 'add', '-A');
  s.git(repo, 'commit', '-q', '-m', msg);
};
const push = (s: ReturnType<typeof setup>, repo: string, extra: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT], { cwd: repo, env: { ...s.e, PUSH_BACKOFF_S: '0', ...extra }, encoding: 'utf8' });

test('push-data: a plain push lands', () => {
  const s = setup();
  commit(s, s.a, 'a.ndjson', '{"a":1}\n', 'aggregate: seq=2');
  const r = push(s, s.a);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.git(s.a, 'rev-parse', 'HEAD'), s.git(s.a, 'ls-remote', 'origin', 'refs/heads/data').split('\t')[0] + '\n');
});

test('push-data: a concurrent writer\'s commit is fetched and rebased onto, then both are on origin', () => {
  const s = setup();
  commit(s, s.b, 'changes.ndjson', '{"derive":1}\n', 'derive: views');
  s.git(s.b, 'push', '-q', 'origin', 'HEAD:data');
  commit(s, s.a, 'status.json', '{"seq":2}\n', 'aggregate: seq=2');
  const r = push(s, s.a);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = s.git(s.a, 'log', '--format=%s', 'origin/data').trim().split('\n');
  assert.deepEqual(log, ['aggregate: seq=2', 'derive: views', 'seed']);
  assert.equal(readFileSync(join(s.a, 'changes.ndjson'), 'utf8'), '{"derive":1}\n');
});

test('push-data: a conflict aborts the rebase, keeps both sides and fails with an annotation', () => {
  const s = setup();
  commit(s, s.b, 'status.json', '{"seq":"b"}\n', 'writer b');
  s.git(s.b, 'push', '-q', 'origin', 'HEAD:data');
  commit(s, s.a, 'status.json', '{"seq":"a"}\n', 'writer a');
  const mine = s.git(s.a, 'rev-parse', 'HEAD');
  const r = push(s, s.a);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::rebase conflict pushing to data/);
  assert.ok(!existsSync(join(s.a, '.git', 'rebase-merge')) && !existsSync(join(s.a, '.git', 'rebase-apply')), 'no rebase left in progress');
  assert.equal(s.git(s.a, 'rev-parse', 'HEAD'), mine, 'the local commit is intact');
  assert.equal(s.git(s.a, 'log', '-1', '--format=%s', 'origin/data').trim(), 'writer b', 'origin keeps the other writer');
});

test('push-data: an unreachable origin fails with an annotation instead of looping', () => {
  const s = setup();
  commit(s, s.a, 'status.json', '{"seq":2}\n', 'aggregate: seq=2');
  s.git(s.a, 'remote', 'set-url', 'origin', join(s.dir, 'missing.git'));
  const r = push(s, s.a, { PUSH_ATTEMPTS: '2' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::fetching origin\/data failed after a rejected push \(attempt 1\)/);
});

test('push-data: a conflict names the conflicting files', () => {
  const s = setup();
  commit(s, s.b, 'status.json', '{"seq":"b"}\n', 'writer b');
  s.git(s.b, 'push', '-q', 'origin', 'HEAD:data');
  commit(s, s.a, 'status.json', '{"seq":"a"}\n', 'writer a');
  const r = push(s, s.a);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::rebase conflict pushing to data: status\.json/);
});

test('push-data: PUSH_ATTEMPTS bounds the pushes, and the last rejection is not followed by a useless fetch', () => {
  const s = setup();
  // A hook that rejects every push: each attempt is a rejection, then a fetch and a rebase with nothing to do.
  writeFileSync(join(s.dir, 'origin.git', 'hooks', 'pre-receive'), '#!/bin/sh\necho rejected-by-hook\nexit 1\n', { mode: 0o755 });
  commit(s, s.a, 'status.json', '{"seq":2}\n', 'aggregate: seq=2');
  const r = push(s, s.a, { PUSH_ATTEMPTS: '3' });
  assert.equal(r.status, 1);
  assert.equal((r.stderr.match(/rejected-by-hook/g) ?? []).length, 3, r.stderr);
  assert.match(r.stdout, /::error::push to data failed after 3 attempts/);
});

/**
 * The checkouts the workflows push from (actions/checkout): `fetch-depth: 1` (aggregate, backfill, archive, derive) and,
 * for the side-index commit jobs, also sparse and blobless (first-solutions: cone `knowledge/first_solutions`; history /
 * remediate: one file). Since FEED-OPS-4 those jobs push without the writer lock, so their rebase onto a writer's
 * commit must work in exactly that kind of checkout.
 */
function shallowClone(s: ReturnType<typeof setup>, name: string, sparse: string[] | null): string {
  const url = `file://${join(s.dir, 'origin.git')}`;
  const args = ['clone', '-q', '--depth', '1', '--branch', 'data'];
  if (sparse) args.push('--filter=blob:none', '--sparse');
  s.git(s.dir, ...args, url, name);
  const repo = join(s.dir, name);
  if (sparse) s.git(repo, 'sparse-checkout', 'set', '--no-cone', ...sparse);
  return repo;
}

function seedTree(s: ReturnType<typeof setup>): void {
  // A few commits so the depth-1 clones really are shallow, and the files every writer touches.
  s.git(s.dir, 'config', '--file', join(s.dir, 'origin.git', 'config'), 'uploadpack.allowFilter', 'true');
  s.git(s.dir, 'config', '--file', join(s.dir, 'origin.git', 'config'), 'uploadpack.allowAnySHA1InWant', 'true');
  for (let n = 0; n < 3; n++) {
    mkdirSync(join(s.b, 'knowledge', 'index'), { recursive: true });
    mkdirSync(join(s.b, 'knowledge', 'first_solutions'), { recursive: true });
    writeFileSync(join(s.b, 'knowledge', 'index', 'head.json'), `{"seq":${n}}\n`);
    writeFileSync(join(s.b, 'knowledge', 'index', 'history.json'), `{"n":${n}}\n`);
    writeFileSync(join(s.b, 'knowledge', 'first_solutions', 'cursor.json'), `{"n":${n}}\n`);
    commit(s, s.b, 'status.json', `{"seq":${n}}\n`, `aggregate: seq=${n}`);
  }
  s.git(s.b, 'push', '-q', 'origin', 'HEAD:data');
}

for (const [shape, sparse, file] of [
  ['first-solutions commit (shallow, blobless, sparse cone)', ['/knowledge/first_solutions/', '/*.json'], 'knowledge/first_solutions/cursor.json'],
  ['history commit (shallow, blobless, one file)', ['knowledge/index/history.json'], 'knowledge/index/history.json'],
  ['aggregate (shallow)', null, 'status.json'],
] as const) {
  test(`push-data: rebases in a ${shape} checkout onto a writer that pushed first`, () => {
    const s = setup();
    seedTree(s);
    const side = shallowClone(s, 'side', sparse ? [...sparse] : null);
    assert.equal(s.git(side, 'rev-parse', '--is-shallow-repository').trim(), 'true');
    if (sparse) assert.equal(s.git(side, 'config', 'remote.origin.promisor').trim(), 'true', 'a blobless (partial) clone');
    // Meanwhile aggregate (and its derive steps) push: other files, including a root file inside the sparse cone.
    s.git(s.b, 'pull', '-q', 'origin', 'data');
    writeFileSync(join(s.b, 'knowledge', 'index', 'head.json'), '{"seq":9}\n');
    writeFileSync(join(s.b, 'events.ndjson'), '{"day":1}\n');
    commit(s, s.b, file === 'status.json' ? 'manifest.json' : 'status.json', '{"seq":9}\n', 'aggregate: seq=9');
    s.git(s.b, 'push', '-q', 'origin', 'HEAD:data');
    writeFileSync(join(side, file), '{"side":true}\n');
    s.git(side, 'add', '--sparse', file);
    s.git(side, 'commit', '-q', '-m', 'side index');
    const r = push(s, side, { PUSH_ATTEMPTS: '6', PUSH_BACKOFF_S: '0' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /rejected/, 'the first push lost the race');
    const check = join(s.dir, 'check');
    s.git(s.dir, 'clone', '-q', '--branch', 'data', join(s.dir, 'origin.git'), check);
    assert.deepEqual(s.git(check, 'log', '-2', '--format=%s').trim().split('\n'), ['side index', 'aggregate: seq=9']);
    assert.equal(readFileSync(join(check, file), 'utf8'), '{"side":true}\n');
    assert.equal(readFileSync(join(check, 'knowledge', 'index', 'head.json'), 'utf8'), '{"seq":9}\n');
  });
}
