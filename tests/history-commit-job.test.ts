import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Review of round 24 (#99): history.yml's commit job is what keeps the 2.5 MB index out of a run that only counts one
// more failure. The walk's side is tested in tests/history-run.test.ts (the index text comes back byte for byte); this
// runs the job's own script, as the workflow file has it, against a git checkout of the two files: the state alone is
// committed as `history: state`, both as `history: index`, and nothing when neither changed.

/** The `run: |` script of history.yml's commit job (its one run step), unindented. */
function commitScript(): string {
  const yml = readFileSync('.github/workflows/history.yml', 'utf8');
  const lines = yml.slice(yml.indexOf('\n  commit:')).split('\n');
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(at > 0, 'the commit job has a run step');
  const keyIndent = lines[at]!.search(/\S/);
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && l.search(/\S/) <= keyIndent) break;
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  const script = body.map((l) => l.slice(indent)).join('\n');
  assert.match(script, /git commit/);
  return script;
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** A data checkout (`.data`) holding the index, and the state when given, beside the job's workspace and artifact. */
function setup(index: string, state: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'history-commit-'));
  const ws = join(dir, 'ws');
  mkdirSync(join(ws, 'scripts'), { recursive: true });
  // push-data.sh stands in for the push: it records that it ran.
  writeFileSync(join(ws, 'scripts', 'push-data.sh'), `echo pushed >> "${join(dir, 'pushes')}"\n`);
  const data = join(dir, '.data');
  mkdirSync(join(data, 'knowledge', 'index'), { recursive: true });
  git(data, 'init', '-q');
  writeFileSync(join(data, 'knowledge', 'index', 'history.json'), index);
  if (state != null) writeFileSync(join(data, 'knowledge', 'index', 'history-state.json'), state);
  writeFileSync(join(data, 'status.json'), '{}\n');
  git(data, 'add', '-A');
  git(data, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  mkdirSync(join(dir, 'history-out'));
  /** The walk's two output files (the artifact), then the job's script in the data checkout. */
  const run = (outIndex: string, outState: string) => {
    writeFileSync(join(dir, 'history-out', 'history.json'), outIndex);
    writeFileSync(join(dir, 'history-out', 'history-state.json'), outState);
    const r = spawnSync('bash', ['-c', commitScript()], { cwd: data, env: { ...process.env, GITHUB_WORKSPACE: ws }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return {
      stdout: r.stdout,
      subject: git(data, 'log', '-1', '--format=%s').trim(),
      files: git(data, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n'),
      pushes: existsSync(join(dir, 'pushes')) ? readFileSync(join(dir, 'pushes'), 'utf8').trim().split('\n').length : 0,
    };
  };
  return { run };
}

const INDEX = '{\n  "version": 1,\n  "raw": [],\n  "attempts": {}\n}\n';
const STATE = (failures: number) =>
  `{\n  "version": 1,\n  "attempts": {\n    "emsc:2005-11": {"failures":${failures},"since":"2026-10-13T19:55:06.100Z","last_error":"fetch failed"}\n  },\n  "stall": null\n}\n`;

test('history commit job: a run that only counts a failure commits the state file alone, as `history: state`', () => {
  const s = setup(INDEX, STATE(1));
  const r = s.run(INDEX, STATE(2));
  assert.match(r.subject, /^history: state @ \d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(r.files, ['knowledge/index/history-state.json'], 'the index is not rewritten');
  assert.equal(r.pushes, 1);
});

test('history commit job: the first state file comes with the index commit that needs it; a later index change commits both as `history: index`', () => {
  // Before round 24 the data branch had no state file: the first run that writes the index adds it.
  const s = setup(INDEX, null);
  const first = s.run(INDEX.replace('"raw": []', '"raw": [1]'), '{\n  "version": 1,\n  "attempts": {},\n  "stall": null\n}\n');
  assert.match(first.subject, /^history: index @ /);
  assert.deepEqual(first.files.sort(), ['knowledge/index/history-state.json', 'knowledge/index/history.json']);
  const both = s.run(INDEX.replace('"raw": []', '"raw": [1, 2]'), STATE(1));
  assert.match(both.subject, /^history: index @ /);
  assert.deepEqual(both.files.sort(), ['knowledge/index/history-state.json', 'knowledge/index/history.json']);
  assert.equal(both.pushes, 2);
});

test('history commit job: a run that changes neither file commits and pushes nothing', () => {
  const s = setup(INDEX, STATE(3));
  const r = s.run(INDEX, STATE(3));
  assert.match(r.stdout, /^no changes$/m);
  assert.equal(r.subject, 'seed');
  assert.equal(r.pushes, 0);
});
