import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// FEED-OPS-5: every workflow uses the same version of each action. Until 2026-10-04 history.yml ran upload-artifact@v4
// and download-artifact@v4 (Node 20) beside first-solutions.yml's @v6 / @v7 (Node 24).
// X-10 (round 14): every action is pinned by commit SHA with its tag in a comment (a tag can be moved; a SHA cannot),
// and Node by the exact version in .nvmrc. Bump an action everywhere at once, after reading its release notes; the
// artifact pair is exercised on every pull request by validate.yml's `artifacts` jobs.

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, '.github');
const sources = (): [string, string][] => {
  const files = readdirSync(join(dir, 'workflows')).filter((x) => x.endsWith('.yml')).map((f) => join('workflows', f));
  for (const a of readdirSync(join(dir, 'actions'))) files.push(join('actions', a, 'action.yml'));
  return files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]);
};

test('workflows: every action pinned by a full commit SHA with its tag in a comment, one pin per action everywhere', () => {
  const pins = new Map<string, Map<string, string[]>>();
  let uses = 0;
  for (const [f, yml] of sources()) {
    for (const m of yml.matchAll(/uses:\s*(\S+)(.*)$/gm)) {
      const [, ref, rest] = m;
      if (ref!.startsWith('./')) continue; // the repository's own composite actions
      uses++;
      const pin = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})$/.exec(ref!);
      assert.ok(pin, `${f}: ${ref} is not pinned by a commit SHA`);
      const tag = /^\s+#\s+(v\d+\.\d+\.\d+)\s*$/.exec(rest!)?.[1];
      assert.ok(tag, `${f}: ${ref} has no "# vX.Y.Z" comment`);
      const byPin = pins.get(pin[1]!) ?? pins.set(pin[1]!, new Map()).get(pin[1]!)!;
      (byPin.get(`${pin[2]} ${tag}`) ?? byPin.set(`${pin[2]} ${tag}`, []).get(`${pin[2]} ${tag}`)!).push(f);
    }
  }
  assert.ok(uses > 0);
  for (const [action, byPin] of pins) {
    assert.equal(byPin.size, 1, `${action}: ${[...byPin].map(([v, fs]) => `${v} in ${[...new Set(fs)].join(', ')}`).join('; ')}`);
  }
  assert.deepEqual([...pins.keys()].sort(), ['actions/checkout', 'actions/download-artifact', 'actions/setup-node', 'actions/upload-artifact']);
});

test('workflows: Node comes from .nvmrc, an exact 22.x version', () => {
  const nvmrc = readFileSync(fileURLToPath(new URL('../.nvmrc', import.meta.url)), 'utf8').trim();
  assert.match(nvmrc, /^22\.\d+\.\d+$/);
  for (const [f, yml] of sources()) {
    assert.doesNotMatch(yml, /node-version:/, `${f}: node-version instead of node-version-file`);
    const setups = (yml.match(/actions\/setup-node@/g) ?? []).length;
    assert.equal((yml.match(/node-version-file: \.nvmrc/g) ?? []).length, setups, f);
  }
});

// Owner decision 2026-11-17: Dependabot version updates (.github/dependabot.yml; README.md, Dependency updates). The
// file is parsed by GitHub only when it runs, so its shape is pinned here: both ecosystems weekly from "/", the 7-day
// cooldown, one grouped PR for minors and patches (majors separate), a small PR limit; and "/" must stay enough.
const dependabot = (): string => readFileSync(join(dir, 'dependabot.yml'), 'utf8');
const updateBlocks = (yml: string): Map<string, string> => {
  const blocks = new Map<string, string>();
  for (const block of yml.split(/^ {2}- (?=package-ecosystem:)/m).slice(1)) {
    const eco = /^package-ecosystem: (\S+)$/m.exec(block)?.[1];
    assert.ok(eco && !blocks.has(eco), `one entry per ecosystem (${eco})`);
    blocks.set(eco, block.replace(/^\s*#.*$/gm, ''));
  }
  return blocks;
};

test('dependabot: npm and github-actions, weekly from "/", 7-day cooldown, minors and patches grouped, majors apart', () => {
  const yml = dependabot();
  assert.match(yml, /^version: 2$/m);
  assert.doesNotMatch(yml, /\t/, 'YAML takes no tabs');
  const blocks = updateBlocks(yml);
  assert.deepEqual([...blocks.keys()].sort(), ['github-actions', 'npm']);
  for (const [eco, b] of blocks) {
    assert.match(b, /^ {4}directory: "\/"$/m, eco);
    assert.doesNotMatch(b, /directories:/, eco);
    assert.match(b, /^ {4}schedule:\n {6}interval: weekly$/m, eco);
    assert.match(b, /^ {4}cooldown:\n {6}default-days: 7$/m, eco);
    const limit = Number(/^ {4}open-pull-requests-limit: (\d+)$/m.exec(b)?.[1]);
    assert.ok(limit >= 1 && limit <= 5, `${eco}: open-pull-requests-limit ${limit}`);
    // One group, for version updates, minor and patch only: a major is left to a pull request of its own.
    assert.match(b, /^ {4}groups:\n {6}[\w-]+:\n {8}applies-to: version-updates\n {8}update-types: \[minor, patch\]$/m, eco);
    assert.equal((b.match(/applies-to:/g) ?? []).length, 1, `${eco}: one group`);
  }
  // Our own GitLab-hosted package is re-pinned by hand (.npmrc, tests/npm-install.test.ts), never by Dependabot.
  assert.match(blocks.get('npm')!, /- dependency-name: "@theshelter\/signing"\n/);
});

test('dependabot: "/" covers every manifest, the workflows and the composite actions', () => {
  // npm: the root package.json is the only one (heartbeat/ and state/ have none); a new one needs its directory.
  const manifests = execFileSync('git', ['ls-files', '--', '*package.json', 'package.json'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(manifests, ['package.json']);
  for (const w of ['heartbeat', 'state']) assert.ok(!existsSync(join(root, w, 'package.json')), `${w}/package.json needs a dependabot entry`);
  // github-actions: "/" reads .github/workflows only; a composite action calling another action needs its directory.
  for (const [f, yml] of sources()) {
    if (!f.startsWith('actions')) continue;
    for (const m of yml.matchAll(/uses:\s*(\S+)/g)) assert.ok(m[1]!.startsWith('./'), `${f}: ${m[1]} is outside dependabot's "/"`);
  }
});
