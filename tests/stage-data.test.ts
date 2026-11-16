import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** The workflow files of the repository: every .github/workflows/*.yml and .github/actions/<name>/action.yml. */
function workflowFiles(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(here('../.github/workflows'))) if (/\.ya?ml$/.test(f)) out.push(`.github/workflows/${f}`);
  for (const d of readdirSync(here('../.github/actions'))) {
    for (const f of ['action.yml', 'action.yaml']) if (existsSync(here(`../.github/actions/${d}/${f}`))) out.push(`.github/actions/${d}/${f}`);
  }
  return out.sort();
}

/** What is wrong with the `git add` / `git commit` lines of a workflow `text` that does not stage through stage-data.ts:
 *  each `git add` must name explicit pathspecs (a `"$var"` resolved from a `var=value` line of the file), none of them
 *  the whole checkout (`.`, `:/`, a bare `-A`) or a day partition (`events...`); `-A` is allowed only before such
 *  pathspecs (stats.yml stages its removals); `git commit -a` is never allowed. */
function stagingProblems(text: string): string[] {
  const body = text.replace(/^\s*#.*$/gm, '');
  const vars = new Map([...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=([^\s;]+)\s*$/gm)].map((m) => [m[1]!, m[2]!.replace(/^["']|["']$/g, '')]));
  const out: string[] = [];
  for (const m of body.matchAll(/\bgit add\b([^\n;&|)]*)/g)) {
    const args = m[1]!.trim().split(/\s+/).filter(Boolean);
    const specs: string[] = [];
    for (const a of args) {
      if (a === '-A' || a === '--') continue;
      if (a.startsWith('-')) out.push(`${m[0].trim()}: option ${a}`);
      else {
        const v = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/.exec(a);
        const spec = v ? vars.get(v[1]!) : a.replace(/^["']|["']$/g, '');
        if (spec == null) out.push(`${m[0].trim()}: ${a} is not set in the file`);
        else specs.push(spec);
      }
    }
    if (!specs.length) out.push(`${m[0].trim()}: no pathspec (the whole checkout)`);
    for (const p of specs) if (/^(\.|\.\/|:\/|\*|:\(.*)$/.test(p) || /^(\.\/)?events(\/|$)/.test(p) || p.includes('*')) out.push(`${m[0].trim()}: pathspec ${p}`);
  }
  for (const m of body.matchAll(/\bgit commit\b([^\n]*)/g)) if (/(^|\s)(-a\w*|--all)(\s|$)/.test(m[1]!)) out.push(`${m[0].trim()}: commit -a`);
  return out;
}

test('stagingProblems: explicit non-events pathspecs pass; the whole checkout, a day partition, an unknown variable or commit -a fail', () => {
  assert.deepEqual(stagingProblems('git add knowledge status status.json .gitignore\ngit commit -m x'), []);
  assert.deepEqual(stagingProblems('git add -A v1/stats knowledge/stats'), []);
  assert.deepEqual(stagingProblems('dir=knowledge/first_solutions\ngit add "$dir"'), []);
  assert.deepEqual(stagingProblems('# git add -A\ngit add knowledge/index/remediation.json'), [], 'comments do not count');
  assert.equal(stagingProblems('git add -A').length, 1);
  assert.equal(stagingProblems('git add .').length, 1);
  assert.equal(stagingProblems('git add :/').length, 1);
  assert.equal(stagingProblems('git add events knowledge').length, 1);
  assert.equal(stagingProblems('git add -A events/2026/11').length, 1);
  assert.equal(stagingProblems('dir=events\ngit add "$dir"').length, 1);
  assert.equal(stagingProblems('git add "$where"').length, 2, 'unset variable: unknown and so no pathspec');
  assert.equal(stagingProblems('git add -u knowledge').length, 1);
  assert.equal(stagingProblems('git add knowledge\ngit commit -am x').length, 1);
});

test('wiring: derive-publish, backfill and archive stage through src/stage-data.ts; no other workflow or action stages events/ or the whole checkout', () => {
  const read = (rel: string): string => readFileSync(here(`../${rel}`), 'utf8');
  const writers = new Map([
    ['.github/actions/derive-publish/action.yml', '.'],
    ['.github/workflows/backfill.yml', '.'],
    ['.github/workflows/archive.yml', 'events knowledge status changes'],
  ]);
  const files = workflowFiles();
  for (const f of [...writers.keys(), '.github/workflows/stats.yml', '.github/workflows/remerge.yml', '.github/workflows/aggregate.yml']) {
    assert.ok(files.includes(f), `the glob finds ${f}`);
  }
  const committers: string[] = [];
  for (const file of files) {
    const text = read(file);
    const body = text.replace(/^\s*#.*$/gm, '');
    if (/\bgit commit\b/.test(body)) committers.push(file);
    const specs = writers.get(file);
    if (specs != null) {
      const call = `( cd "$GITHUB_WORKSPACE" && DATA_DIR=.data npx --no-install tsx src/stage-data.ts ${specs} )`;
      assert.ok(body.includes(call), `${file}: ${call}`);
      assert.ok(body.indexOf(call) < body.indexOf('git commit'), `${file}: staged before the commit`);
      assert.doesNotMatch(body, /\bgit add\b/, `${file}: no git add of its own`);
      assert.doesNotMatch(body, /\bgit commit\b[^\n]*(\s-a\w*|--all)\b/, `${file}: no commit -a`);
    } else {
      assert.doesNotMatch(body, /src\/stage-data\.ts/, `${file}: stage-data is wired only in the writers of day partitions`);
      assert.deepEqual(stagingProblems(text), [], file);
    }
  }
  // Every workflow that commits to data is checked above (a new one is covered by the glob).
  assert.ok(committers.length >= 9, `committers: ${committers.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Storage phase 3 (src/event-map-store.ts): the jobs that may mint a GitHub OIDC token for the state store, and the
// phase-3b event-map check on every commit that stages `knowledge`.

/** The jobs of a workflow by id: each job's text up to the next job. */
const jobsOf = (yml: string): Record<string, string> => {
  const body = yml.slice(yml.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const out: Record<string, string> = {};
  const starts = [...body.matchAll(/^ {2}([\w-]+):\n/gm)];
  starts.forEach((m, i) => (out[m[1]!] = body.slice(m.index!, starts[i + 1]?.index ?? body.length)));
  return out;
};

test('wiring: exactly the state store\'s jobs hold id-token: write, at job level, each restating the permissions it needs', () => {
  const read = (rel: string): string => readFileSync(here(`../${rel}`), 'utf8');
  const holders: string[] = [];
  for (const file of workflowFiles().filter((f) => f.startsWith('.github/workflows/'))) {
    const text = read(file);
    const top = text.slice(0, text.indexOf('\njobs:'));
    assert.doesNotMatch(top, /id-token/, `${file}: never at workflow level (it would reach every job added later)`);
    for (const [job, block] of Object.entries(jobsOf(text))) {
      if (!/\n {6}id-token: write\n/.test(block)) continue;
      holders.push(`${file.slice('.github/workflows/'.length)}:${job}`);
      assert.match(block, /\n {4}permissions:\n(?: {6}#.*\n| {6}[\w-]+: (?:read|write)\n)+/, `${file}:${job}: a job-level permissions block`);
    }
  }
  assert.deepEqual(holders.sort(), [
    // Readers and writers of the store (the state Worker's allow-lists, state/README.md).
    'aggregate.yml:aggregate',
    'derive.yml:derive',
    'first-solutions.yml:collect',
    'health.yml:feed',
    'state-backup.yml:backup',
    'state-gc.yml:gc',
    'state-rehearsal.yml:rehearse',
  ]);
  // The jobs that push to data keep contents: write next to it; first-solutions' collect uploads Release chunks.
  for (const [file, job, perms] of [
    ['aggregate.yml', 'aggregate', ['contents: write', 'id-token: write']],
    ['derive.yml', 'derive', ['contents: write', 'id-token: write']],
    ['first-solutions.yml', 'collect', ['contents: write', 'actions: read', 'id-token: write']],
    ['health.yml', 'feed', ['contents: read', 'actions: read', 'id-token: write']],
    ['state-gc.yml', 'gc', ['contents: read', 'actions: read', 'id-token: write']],
    ['state-backup.yml', 'backup', ['contents: write', 'id-token: write']],
    ['state-rehearsal.yml', 'rehearse', ['contents: read', 'id-token: write']],
  ] as const) {
    const block = jobsOf(read(`.github/workflows/${file}`))[job]!;
    const got = [...block.slice(block.indexOf('\n    permissions:\n')).matchAll(/^ {6}([\w-]+: (?:read|write))$/gm)].map((m) => m[1]);
    assert.deepEqual(got.slice(0, perms.length), [...perms], `${file}:${job}`);
  }
});

test('wiring: every commit that stages knowledge carries the phase-3b event-map check (off while EVENT_MAP_IN_GIT=1)', () => {
  const read = (rel: string): string => readFileSync(here(`../${rel}`), 'utf8');
  const hook = '( cd "$GITHUB_WORKSPACE" && DATA_DIR=.data npx --no-install tsx src/event-map-store.ts stage )';
  let explicit = 0;
  for (const file of workflowFiles()) {
    const body = read(file).replace(/^\s*#.*$/gm, '');
    for (const m of body.matchAll(/\bgit add\b([^\n;&|)]*)/g)) {
      const specs = m[1]!.trim().split(/\s+/).filter((a) => !a.startsWith('-'));
      if (!specs.some((p) => p === 'knowledge' || p === 'knowledge/index' || p === '.')) continue;
      explicit++;
      const after = body.indexOf(hook, m.index!);
      assert.ok(after > m.index!, `${file}: ${m[0].trim()} without the event-map check after it`);
      assert.ok(after < body.indexOf('git commit', m.index!), `${file}: the check before the commit`);
    }
  }
  assert.equal(explicit, 1, 'aggregate.yml stages knowledge itself; derive-publish, backfill and archive go through stage-data.ts');
});

test('stageData: with EVENT_MAP_IN_GIT=0 (phase 3b) a staged event-map day file stops the commit; deletions and the sentinel pass', () => {
  const r = repo();
  try {
    r.write('knowledge/index/event_map/2026-11-01.ndjson', '{"feedId":"a"}\n');
    r.write('manifest.json', '{}\n');
    r.run('add', '-A');
    r.run('commit', '-q', '-m', 'seed');
    r.write('knowledge/index/event_map/2026-11-02.ndjson', '{"feedId":"b"}\n');
    assert.throws(() => stageData(r.dir, ['.'], NOW, r.git, { EVENT_MAP_IN_GIT: '0' }), /event map staged for a commit while EVENT_MAP_IN_GIT=0 .*: A knowledge\/index\/event_map\/2026-11-02\.ndjson/);
    r.run('reset', '-q');
    // Phase 3a (the default): git tracks the event map; nothing is checked.
    assert.doesNotThrow(() => stageData(r.dir, ['.'], NOW, r.git, {}));
    r.run('reset', '-q');
    rmSync(join(r.dir, 'knowledge/index/event_map/2026-11-02.ndjson'));
    // The phase-3b transition: every day file untracked, the sentinel added.
    r.run('rm', '-q', '-r', '--cached', 'knowledge/index/event_map');
    r.write('.gitignore', 'knowledge/index/event_map/*\n!knowledge/index/event_map/0000-00-00.ndjson\n');
    r.write('knowledge/index/event_map/0000-00-00.ndjson', 'phase 3b sentinel: not JSON\n');
    assert.doesNotThrow(() => stageData(r.dir, ['.'], NOW, r.git, { EVENT_MAP_IN_GIT: '0' }));
    assert.deepEqual(r.run('diff', '--cached', '--name-status').trim().split('\n').sort(), [
      'A\t.gitignore',
      'A\tknowledge/index/event_map/0000-00-00.ndjson',
      'D\tknowledge/index/event_map/2026-11-01.ndjson',
    ]);
  } finally {
    r.cleanup();
  }
});
