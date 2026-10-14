import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { GitHubStore } from '../src/history-store.js';

// PN-2: GitHubStore.list() resolves a Release by its tag, then lists its assets. Run 38506296121 (2026-10-14 03:26 UTC)
// went red on a 404 from the assets endpoint of a Release the tag lookup had just resolved: GitHub's eventual
// consistency, which every other Releases call retries. The history walk, first-solutions-collect and remediate all
// list through this store. A `gh` stub first on PATH plays GitHub's answers in order.

const GH_STUB = `#!/usr/bin/env bash
n=$(( $(cat "$GH_STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$GH_STUB_DIR/count"
printf '%s\\n' "$*" >> "$GH_STUB_DIR/calls"
case "$*" in
  *releases/tags/*)
    if [ -e "$GH_STUB_DIR/no-release" ]; then echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi
    echo 4242 ;;
  *releases/4242/assets*)
    k=$(( $(cat "$GH_STUB_DIR/assets" 2>/dev/null || echo 0) + 1 ))
    echo "$k" > "$GH_STUB_DIR/assets"
    if [ "$k" -le "$(cat "$GH_STUB_DIR/assets-404s")" ]; then echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi
    printf 'raw-usgs-2001-01.ndjson.zst\\t1234\\tuploaded\\nevents-2001-01.e1.tar.zst\\t99\\tuploaded\\n' ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`;

function withGhStub<T>(setup: { assets404s: number; noRelease?: boolean }, run: () => T): { result: T; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'history-store-'));
  writeFileSync(join(dir, 'gh'), GH_STUB, { mode: 0o755 });
  writeFileSync(join(dir, 'assets-404s'), String(setup.assets404s));
  if (setup.noRelease) writeFileSync(join(dir, 'no-release'), '');
  const saved = { PATH: process.env.PATH, GH_STUB_DIR: process.env.GH_STUB_DIR };
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  process.env.GH_STUB_DIR = dir;
  try {
    const result = run();
    const calls = readdirSync(dir).includes('calls') ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : [];
    return { result, calls };
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.GH_STUB_DIR === undefined) delete process.env.GH_STUB_DIR;
    else process.env.GH_STUB_DIR = saved.GH_STUB_DIR;
  }
}

test('GitHubStore.list: a 404 from the assets list of a resolved Release is retried, and the second answer is used', () => {
  const { result, calls } = withGhStub({ assets404s: 1 }, () => new GitHubStore().list('history-2001'));
  assert.deepEqual(result, [
    { name: 'raw-usgs-2001-01.ndjson.zst', size: 1234, state: 'uploaded' },
    { name: 'events-2001-01.e1.tar.zst', size: 99, state: 'uploaded' },
  ]);
  assert.equal(calls.length, 3, calls.join('\n'));
  assert.match(calls[0]!, /^api repos\/TheShelterApp\/earthquakes-feed\/releases\/tags\/history-2001 /);
  assert.match(calls[1]!, /^api --paginate repos\/TheShelterApp\/earthquakes-feed\/releases\/4242\/assets\?per_page=100 /);
  assert.equal(calls[2], calls[1], 'the same request again');
});

test('GitHubStore.list: a tag GitHub does not know is still "no Release" at once (no retry, nothing listed)', () => {
  const { result, calls } = withGhStub({ assets404s: 0, noRelease: true }, () => new GitHubStore().list('history-1999'));
  assert.deepEqual(result, []);
  assert.equal(calls.length, 1, calls.join('\n'));
});
