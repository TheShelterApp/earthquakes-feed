import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FROZEN_AFTER_DAYS, isFrozenDay, partitionPath } from '../src/partitions.js';
import { partitionDayOf, stageData, unfrozenPartitionPaths, type Git } from '../src/stage-data.js';

// Storage option 4 phase 2: the writers of the `data` branch stage everything but the day partitions of unfrozen days
// (src/stage-data.ts). The files stay on disk for sign-manifest, validate and publish-r2; a tracked one leaves the
// branch once (the first phase-2 run); a day is committed by the first run after it freezes, also when it froze between
// derive and the staging. Real git repositories in a temporary directory.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-04T12:00:00Z');
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function repo(): { dir: string; git: Git; run: (...a: string[]) => string; write: (path: string, text: string) => void; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'stage-data-'));
  const dir = join(home, 'data');
  mkdirSync(dir);
  writeFileSync(join(home, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = data\n');
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_AUTHOR_NAME: 'earthquakes-feed-bot',
    GIT_AUTHOR_EMAIL: 'bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'earthquakes-feed-bot',
    GIT_COMMITTER_EMAIL: 'bot@users.noreply.github.com',
  };
  const git: Git = (args) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  return { dir, git, run: (...a) => git(a), write, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const tree = (r: ReturnType<typeof repo>): string[] => r.run('ls-tree', '-r', '--name-only', 'HEAD', '--', 'events').split('\n').filter(Boolean);

test('the unfrozen day partitions: every events/YYYY/MM/DD.ndjson whose day is not frozen, nothing else', () => {
  assert.equal(partitionDayOf('events/2026/10/14.ndjson'), '2026-10-14');
  for (const p of ['events/2026/10/14.geojson', 'events/2026/10/README', 'v1/events/2026-10-14.geojson', 'knowledge/index/event_map/2026-10-14-03.ndjson']) {
    assert.equal(partitionDayOf(p), null, p);
  }
  const last = dayOf(NOW - (FROZEN_AFTER_DAYS + 1) * DAY);
  const paths = [0, 1, FROZEN_AFTER_DAYS, FROZEN_AFTER_DAYS + 1, 40].map((d) => partitionPath(dayOf(NOW - d * DAY)));
  paths.push(partitionPath(dayOf(NOW + DAY)), 'knowledge/index/partitions.json');
  assert.equal(isFrozenDay(last, NOW), true);
  assert.deepEqual(unfrozenPartitionPaths(paths, NOW), [0, 1, FROZEN_AFTER_DAYS].map((d) => partitionPath(dayOf(NOW - d * DAY))).concat(partitionPath(dayOf(NOW + DAY))).sort());
});

test('the first phase-2 run: the unfrozen days leave the branch, stay on disk, and a frozen day is committed once', () => {
  const r = repo();
  try {
    const unfrozen = [0, 1, 5, FROZEN_AFTER_DAYS].map((d) => partitionPath(dayOf(NOW - d * DAY)));
    const justFrozen = partitionPath(dayOf(NOW - (FROZEN_AFTER_DAYS + 1) * DAY));
    const old = partitionPath(dayOf(NOW - 30 * DAY));
    // Phase 1 committed every day, the unfrozen ones (and the one that froze at midnight) included.
    for (const p of [...unfrozen, justFrozen, old]) r.write(p, `${p} v1\n`);
    r.write('knowledge/index/partitions.json', '{}\n');
    r.write('manifest.json', '{"v":1}\n');
    r.run('add', '-A');
    r.run('commit', '-q', '-m', 'derive: phase 1');

    // derive rewrites the unfrozen days, the frozen day's final bytes, a new day, the inventory and the manifest.
    for (const p of unfrozen) r.write(p, `${p} v2\n`);
    const tomorrow = partitionPath(dayOf(NOW + DAY));
    r.write(tomorrow, 'future leeway\n');
    r.write(justFrozen, `${justFrozen} final\n`);
    r.write('knowledge/index/partitions.json', '{"n":2}\n');
    r.write('manifest.json', '{"v":2}\n');
    const res = stageData(r.dir, ['.'], NOW, r.git);
    assert.deepEqual(res.keptOut, [...unfrozen, tomorrow].sort());
    assert.deepEqual(res.leftBranch, [...unfrozen].sort(), 'tracked before: deleted from the branch by this commit');
    assert.deepEqual(res.frozenStaged, [`M ${justFrozen}`]);
    const staged = r.run('diff', '--cached', '--name-status').trim().split('\n').sort();
    assert.deepEqual(staged, [...unfrozen.map((p) => `D\t${p}`), `M\t${justFrozen}`, 'M\tknowledge/index/partitions.json', 'M\tmanifest.json'].sort());
    r.run('commit', '-q', '-m', 'derive: phase 2');
    assert.deepEqual(tree(r), [justFrozen, old].sort(), 'the branch holds the frozen days only');
    for (const p of [...unfrozen, tomorrow]) assert.equal(readFileSync(join(r.dir, p), 'utf8').includes('leeway') || readFileSync(join(r.dir, p), 'utf8').endsWith('v2\n'), true, `${p} stays on disk`);
    assert.equal(r.run('status', '--porcelain', '--untracked-files=all').trim().split('\n').filter((l) => !l.startsWith('??')).length, 0, 'nothing tracked is left unstaged');

    // The next run (same day): the unfrozen days are untracked files again; nothing reaches the commit.
    for (const p of unfrozen) r.write(p, `${p} v3\n`);
    const next = stageData(r.dir, ['.'], NOW + 5 * 60_000, r.git);
    assert.deepEqual(next.leftBranch, []);
    assert.deepEqual(next.frozenStaged, []);
    assert.equal(r.run('diff', '--cached', '--name-only'), '', 'nothing to commit');
  } finally {
    r.cleanup();
  }
});

test('a day that froze between derive and the staging is committed by that run; the next run leaves it alone', () => {
  const r = repo();
  try {
    const beforeMidnight = Date.parse('2026-11-04T23:59:59Z');
    const afterMidnight = Date.parse('2026-11-05T00:00:01Z');
    const day = dayOf(beforeMidnight - FROZEN_AFTER_DAYS * DAY); // 10-25: unfrozen at 23:59:59, frozen at 00:00:01
    assert.equal(isFrozenDay(day, beforeMidnight), false);
    assert.equal(isFrozenDay(day, afterMidnight), true);
    r.write('manifest.json', '{}\n');
    r.run('add', '-A');
    r.run('commit', '-q', '-m', 'seed');
    // derive at 23:59:59 wrote the day (it was unfrozen then); the staging runs at 00:00:01.
    r.write(partitionPath(day), 'final\n');
    r.write(partitionPath(dayOf(afterMidnight)), 'new day\n');
    const res = stageData(r.dir, ['.'], afterMidnight, r.git);
    assert.deepEqual(res.frozenStaged, [`A ${partitionPath(day)}`]);
    assert.deepEqual(res.keptOut, [partitionPath(dayOf(afterMidnight))]);
    r.run('commit', '-q', '-m', 'derive');
    assert.deepEqual(tree(r), [partitionPath(day)]);
    // 00:05: derive writes the same bytes; nothing to commit.
    r.write(partitionPath(day), 'final\n');
    assert.deepEqual(stageData(r.dir, ['.'], afterMidnight + 5 * 60_000, r.git).frozenStaged, []);
    // Had the staging run before midnight too, the day would have stayed out, and the first run after midnight (derive
    // writes every day of the event map's horizon into a checkout that lacks it) commits it.
  } finally {
    r.cleanup();
  }
});

test("backfill's and archive's pathspecs: only those paths, and never an unfrozen day partition", () => {
  const r = repo();
  try {
    r.write('status/history/2026-11-04.ndjson', 'a\n');
    r.write('changes/2026-11-04.ndjson', 'a\n');
    r.write(partitionPath('2026-06-01'), 'archived month\n');
    r.run('add', '-A');
    r.run('commit', '-q', '-m', 'seed');
    r.write('knowledge/index/backfill.json', '{"cursor":1}\n');
    r.write(partitionPath('2026-08-01'), 'backfilled\n');
    r.write(partitionPath(dayOf(NOW)), 'stray\n');
    r.write('status/history/2026-11-04.ndjson', 'b\n');
    rmSync(join(r.dir, partitionPath('2026-06-01')));
    const res = stageData(r.dir, ['events', 'knowledge'], NOW, r.git);
    assert.deepEqual(res.keptOut, [partitionPath(dayOf(NOW))]);
    const staged = r.run('diff', '--cached', '--name-status').trim().split('\n').sort();
    assert.deepEqual(staged, [`A\t${partitionPath('2026-08-01')}`, `D\t${partitionPath('2026-06-01')}`, 'A\tknowledge/index/backfill.json'].sort());
    assert.deepEqual(res.frozenStaged, [`A ${partitionPath('2026-08-01')}`], 'a removal is not a committed day');
  } finally {
    r.cleanup();
  }
});

test('push-data.sh rebases onto a concurrent commit with the unfrozen days untracked in the checkout', () => {
  const r = repo();
  try {
    const origin = join(dirname(r.dir), 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    r.write('knowledge/index/history.json', '{}\n');
    r.run('add', '-A');
    r.run('commit', '-q', '-m', 'seed');
    r.run('remote', 'add', 'origin', origin);
    r.run('push', '-q', 'origin', 'HEAD:data');
    // A side-index job pushes first (history), from its own clone.
    const other = join(dirname(r.dir), 'other');
    execFileSync('git', ['clone', '-q', '--branch', 'data', origin, other]);
    writeFileSync(join(other, 'knowledge', 'index', 'history.json'), '{"h":1}\n');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dirname(r.dir), GIT_CONFIG_GLOBAL: join(dirname(r.dir), 'gitconfig'), GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' };
    execFileSync('git', ['-C', other, 'commit', '-qam', 'history'], { env });
    execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:data'], { env });
    // derive: the unfrozen days on disk, staged out; a frozen day and the manifest committed.
    r.write(partitionPath(dayOf(Date.now())), 'today\n');
    r.write(partitionPath(dayOf(Date.now() - 2 * DAY)), 'two days ago\n');
    r.write(partitionPath('2026-01-02'), 'frozen\n');
    r.write('manifest.json', '{}\n');
    stageData(r.dir, ['.'], Date.now(), r.git);
    r.run('commit', '-q', '-m', 'derive: views');
    const push = spawnSync('bash', [here('../scripts/push-data.sh')], { cwd: r.dir, env: { ...env, PUSH_BACKOFF_S: '0' }, encoding: 'utf8' });
    assert.equal(push.status, 0, push.stdout + push.stderr);
    const remote = execFileSync('git', ['-C', origin, 'ls-tree', '-r', '--name-only', 'data'], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(remote, ['events/2026/01/02.ndjson', 'knowledge/index/history.json', 'manifest.json']);
    assert.ok(existsSync(join(r.dir, partitionPath(dayOf(Date.now())))), 'the unfrozen day is still on disk after the rebase');
  } finally {
    r.cleanup();
  }
});

test('the CLI stages DATA_DIR with the clock it reads after derive, and says what it kept out', () => {
  const r = repo();
  try {
    r.write('manifest.json', '{}\n');
    r.run('add', '-A');
    r.run('commit', '-q', '-m', 'seed');
    r.write(partitionPath(dayOf(Date.now())), 'today\n');
    r.write(partitionPath('2026-01-02'), 'frozen\n');
    const env = { ...process.env, DATA_DIR: r.dir, HOME: dirname(r.dir), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirname(r.dir), 'gitconfig') };
    const out = spawnSync(process.execPath, ['--import', 'tsx', here('../src/stage-data.ts'), '.'], { env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, new RegExp(`1 unfrozen day partition\\(s\\) kept out of the commit \\(on disk for the steps after it\\): ${dayOf(Date.now())}`));
    assert.match(out.stdout, /frozen day partition\(s\) committed: A events\/2026\/01\/02\.ndjson/);
    assert.equal(r.run('diff', '--cached', '--name-only').trim().split('\n').sort().join(' '), 'events/2026/01/02.ndjson');
    assert.equal(spawnSync(process.execPath, ['--import', 'tsx', here('../src/stage-data.ts')], { env, encoding: 'utf8' }).status, 1, 'no pathspec');
  } finally {
    r.cleanup();
  }
});

test('wiring: derive-publish, backfill and archive stage through src/stage-data.ts; no workflow stages events/ itself', () => {
  const read = (rel: string): string => readFileSync(here(`../${rel}`), 'utf8');
  for (const [file, specs] of [
    ['.github/actions/derive-publish/action.yml', '.'],
    ['.github/workflows/backfill.yml', 'events knowledge'],
    ['.github/workflows/archive.yml', 'events knowledge status changes'],
  ] as const) {
    const text = read(file);
    const call = `( cd "$GITHUB_WORKSPACE" && DATA_DIR=.data npx --no-install tsx src/stage-data.ts ${specs} )`;
    assert.ok(text.includes(call), `${file}: ${call}`);
    assert.ok(text.indexOf(call) < text.indexOf('git commit'), `${file}: staged before the commit`);
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /\bgit add\b/, `${file}: no git add of its own`);
  }
  for (const f of ['aggregate.yml', 'history.yml', 'first-solutions.yml', 'remediate.yml', 'derive.yml']) {
    const text = read(`.github/workflows/${f}`).replace(/^\s*#.*$/gm, '');
    for (const m of text.matchAll(/\bgit add\b([^\n]*)/g)) assert.doesNotMatch(m[1]!, /(^|\s)(-A|\.|events\S*)(\s|$)/, `${f}: ${m[0]}`);
  }
});
