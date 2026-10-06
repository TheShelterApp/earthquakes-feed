import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// FEED-OPS-5: every workflow uses the same version of each action. Until 2026-10-04 history.yml ran upload-artifact@v4
// and download-artifact@v4 (Node 20) beside first-solutions.yml's @v6 / @v7 (Node 24).
// X-10 (round 14): every action is pinned by commit SHA with its tag in a comment (a tag can be moved; a SHA cannot),
// and Node by the exact version in .nvmrc. Bump an action everywhere at once, after reading its release notes; the
// artifact pair is exercised on every pull request by validate.yml's `artifacts` jobs.

const dir = fileURLToPath(new URL('../.github/', import.meta.url));
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
