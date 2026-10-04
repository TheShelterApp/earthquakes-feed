import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// FEED-OPS-5: every workflow uses the same major of each action. Until 2026-10-04 history.yml ran upload-artifact@v4
// and download-artifact@v4 (Node 20) beside first-solutions.yml's @v6 / @v7 (Node 24); bump all uses of an action
// together, and only after a green run of one workflow on the new major.

const dir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

test('workflows: one major per action across every workflow', () => {
  const majors = new Map<string, Map<string, string[]>>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@([^\s#]+)/g)) {
      const [, action, ref] = m;
      const major = /^v\d+/.exec(ref!)?.[0] ?? ref!;
      const byMajor = majors.get(action!) ?? majors.set(action!, new Map()).get(action!)!;
      (byMajor.get(major) ?? byMajor.set(major, []).get(major)!).push(f);
    }
  }
  assert.ok(majors.size > 0);
  for (const [action, byMajor] of majors) {
    assert.equal(byMajor.size, 1, `${action}: ${[...byMajor].map(([v, fs]) => `${v} in ${[...new Set(fs)].join(', ')}`).join('; ')}`);
  }
});
