import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// health.yml's feed check (the inline `node -e` script of step "Check live feed freshness + providers") run against a
// manifest and status.json of our own: silent and frozen sources (FEED-3, round 14) leave the systemic count and reach
// the silent issue's step outputs; a pinned leaf under 7 days reaches the certificate issue's outputs (FEED-SEC-1).

const yml = readFileSync(fileURLToPath(new URL('../.github/workflows/health.yml', import.meta.url)), 'utf8');
const script = (() => {
  const start = yml.indexOf("QUEUED_S=\"$QUEUED\" node -e '");
  assert.ok(start > 0, 'the check script');
  const body = yml.slice(start + "QUEUED_S=\"$QUEUED\" node -e '".length);
  return body.slice(0, body.indexOf("\n          '\n"));
})();

function run(status: unknown): { out: Record<string, string>; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'health-check-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ generated: Date.now() - 60_000, head_seq: 7, event_count: 10, freshness: { stale_after_seconds: 1800 } }));
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
  const outFile = join(dir, 'out.txt');
  writeFileSync(outFile, '');
  const r = spawnSync(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, QUEUED_S: '0', GITHUB_OUTPUT: outFile }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out: Record<string, string> = {};
  for (const line of readFileSync(outFile, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return { out, stdout: r.stdout };
}

const providers = (ids: string[], over: Record<string, unknown> = {}): Record<string, unknown> =>
  Object.fromEntries(ids.map((id) => [id, { ok: true, events_returned: 5, ...((over[id] as object) ?? {}) }]));

test('health check: silent and frozen sources are reported, kept out of the systemic count, and named in the issue set', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
  const status = {
    degraded: ['egypt', 'bgs'],
    silent: { egypt: { last_non_empty_at: '2026-07-29T12:06:21.443Z', counted_from: '2026-07-05T00:00:00Z', silent_hours: 1608, budget_hours: 12 } },
    frozen: { bgs: { newest_origin: '2026-09-25T00:00:00.000Z', newest_origin_age_hours: 264.5, window_hours: 48, budget_hours: 216, rows: 40 } },
    providers: providers([...ids, 'egypt', 'bgs']),
  };
  const { out, stdout } = run(status);
  assert.equal(out['problem'], '', 'no systemic problem');
  assert.match(stdout, /failing=0\/32/);
  assert.match(stdout, /silent=\[egypt\] frozen=\[bgs\]/);
  assert.match(stdout, /::warning::frozen provider bgs: frozen, 40 rows whose newest origin \(2026-09-25T00:00:00.000Z\) is 265 h old \(window 48 h \+ budget 216 h\)/);
  assert.equal(out['silent_set'], 'egypt,frozen:bgs');
  assert.equal(out['silent']!.split('; ').length, 2);
  assert.ok(!out['silent']!.split('; ').some((e) => e.includes(';')));
  // A frozen source whose fetch fails in this run counts as failing, like a silent one.
  const failingFrozen = run({ ...status, providers: providers([...ids, 'egypt', 'bgs'], { bgs: { ok: false } }) });
  assert.match(failingFrozen.stdout, /failing=1\/32 limit=\d+ \[bgs\]/);
});

test('health check: a pinned leaf under 7 days is warned about and named for the certificate issue; none otherwise', () => {
  const leaves = {
    tmd: { not_after: '2026-10-09T01:59:47.000Z', days_left: 3.1, issuer: 'GlobalSign GCC R6 AlphaSSL CA 2025', subject: '*.tmd.go.th', seen_at: '2026-10-06T00:00:00.000Z' },
    phivolcs: { not_after: '2027-04-16T23:59:59.000Z', days_left: 192.9, issuer: 'Amazon RSA 2048 M04', subject: 'phivolcs.dost.gov.ph', seen_at: '2026-10-06T00:00:00.000Z' },
  };
  const { out, stdout } = run({ degraded: [], tls_leaves: leaves, providers: providers(['tmd', 'phivolcs']) });
  assert.equal(out['tls_set'], 'tmd');
  assert.match(out['tls']!, /^tmd: leaf \*\.tmd\.go\.th \(issuer GlobalSign GCC R6 AlphaSSL CA 2025\) expires 2026-10-09T01:59:47\.000Z, in 3\.1 days/);
  assert.match(stdout, /::warning::pinned certificate tmd:/);
  assert.match(stdout, /tls_leaf_days=\[phivolcs:192\.9,tmd:3\.1\]/);
  assert.equal(out['problem'], '', 'a warning, never a red run');
  const calm = run({ degraded: [], tls_leaves: { phivolcs: leaves.phivolcs }, providers: providers(['tmd', 'phivolcs']) });
  assert.equal(calm.out['tls_set'], '');
  // A status.json without the field (before round 14) changes nothing.
  assert.equal(run({ degraded: [], providers: providers(['tmd']) }).out['tls_set'], '');
});

test('health.yml: the certificate issue step never fails the run and closes when no leaf is due', () => {
  const step = yml.slice(yml.indexOf('- name: Pinned certificate issue'), yml.indexOf('- name: Open/refresh health issue and fail'));
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /TITLE="\[health\] pinned certificate expiring"/);
  assert.match(step, /gh issue close/);
  assert.match(step, /tls-set: \$\{TLS_SET\}/);
});

// --- the data file size step (R16-FOLLOWUPS (3), round 17): the run log under status/history and every other file on
// the data branch, judged from the API's recursive tree listing, whatever the history's file layout ---

const sizesStep = yml.slice(yml.indexOf('- name: Data file sizes'), yml.indexOf('- name: Data file size issue'));
const sizesScript = (() => {
  const open = "node -e '";
  const start = sizesStep.indexOf(open);
  assert.ok(start > 0, 'the size script');
  const body = sizesStep.slice(start + open.length);
  return body.slice(0, body.indexOf("\n          '\n"));
})();

function runSizes(tree: unknown, limit = '45000000'): { out: Record<string, string>; stdout: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'health-sizes-'));
  writeFileSync(join(dir, 'data-tree.json'), typeof tree === 'string' ? tree : JSON.stringify(tree));
  const outFile = join(dir, 'out.txt');
  writeFileSync(outFile, '');
  const r = spawnSync(process.execPath, ['-e', sizesScript], { cwd: dir, env: { ...process.env, DATA_FILE_WARN_BYTES: limit, GITHUB_OUTPUT: outFile }, encoding: 'utf8' });
  const out: Record<string, string> = {};
  for (const line of readFileSync(outFile, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return { out, stdout: r.stdout, status: r.status };
}

const blob = (path: string, size: number) => ({ path, mode: '100644', type: 'blob', sha: '0'.repeat(40), size });
const dirEntry = (path: string) => ({ path, mode: '040000', type: 'tree', sha: '1'.repeat(40) });
/** The data tree of 2026-10-06 11:4x UTC in miniature: the October run log at 6.5 MB, a day partition, an index. */
const todaysTree = (historySize = 6_495_366, extra: object[] = []) => ({
  sha: 'f'.repeat(40),
  truncated: false,
  tree: [
    blob('manifest.json', 150_000),
    dirEntry('events'),
    blob('events/2026/10/05.ndjson', 2_364_837),
    dirEntry('knowledge/index/event_map'),
    blob('knowledge/index/event_map/2026-10-05.ndjson', 950_000),
    dirEntry('status/history'),
    blob('status/history/2026-10.ndjson', historySize),
    ...extra,
  ],
});

test('data file sizes: today\'s tree is logged, nothing is warned and the issue set is empty', () => {
  const r = runSizes(todaysTree());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /status history: 1 file\(s\), 6\.5 MB, largest status\/history\/2026-10\.ndjson 6\.5 MB \(warning above 45\.0 MB a file\)/);
  assert.match(r.stdout, /data tree: 4 files, 10\.0 MB \(status 6\.5 MB, events 2\.4 MB, knowledge 0\.9 MB, \(root\) 0\.1 MB\)/);
  assert.doesNotMatch(r.stdout, /::warning/);
  assert.deepEqual([r.out['tree_read'], r.out['size_set'], r.out['size']], ['1', '', '']);
});

test('data file sizes: a run-log file past 45 MB and any other large file on data warn and name the issue set, largest first', () => {
  const r = runSizes(todaysTree(46_200_000, [blob('knowledge/index/huge.json', 52_000_000)]));
  assert.equal(r.status, 0, 'a warning, never a failed step');
  assert.match(r.stdout, /::warning title=Data file size::knowledge\/index\/huge\.json: 52\.0 MB \(a file on the data branch\), over 45\.0 MB: GitHub rejects a pushed file above 100 MiB/);
  assert.match(r.stdout, /::warning title=Data file size::status\/history\/2026-10\.ndjson: 46\.2 MB \(the run log, rewritten by every aggregate commit\), over 45\.0 MB/);
  assert.equal(r.out['size_set'], 'knowledge/index/huge.json,status/history/2026-10.ndjson');
  assert.equal(r.out['size']!.split('; ').length, 2);
  assert.ok(!r.out['size']!.split('; ').some((e) => e.includes(';')), 'one entry per file for the issue body');
  // The boundary is strict, like the aggregate's: exactly 45,000,000 bytes does not warn.
  assert.equal(runSizes(todaysTree(45_000_000)).out['size_set'], '');
  assert.equal(runSizes(todaysTree(45_000_001)).out['size_set'], 'status/history/2026-10.ndjson');
});

test('data file sizes: any layout under status/history is summed and its largest file named (one file a day, gzip, sub-folders)', () => {
  const days = Array.from({ length: 6 }, (_, i) => blob(`status/history/2026-10/${String(i + 1).padStart(2, '0')}.ndjson`, 1_300_000 + i * 1000));
  const tree = { truncated: false, tree: [dirEntry('status/history'), dirEntry('status/history/2026-10'), ...days, blob('status/history/2026-09.ndjson.gz', 4_000_000), blob('status.json', 9_000)] };
  const r = runSizes(tree);
  assert.match(r.stdout, /status history: 7 file\(s\), 11\.8 MB, largest status\/history\/2026-09\.ndjson\.gz 4\.0 MB/);
  assert.equal(r.out['size_set'], '');
  // No status/history at all (the log moved elsewhere): said, and the other files are still judged.
  const moved = runSizes({ truncated: false, tree: [blob('logs/status/2026-10.ndjson', 47_000_000)] });
  assert.match(moved.stdout, /status history: 0 file\(s\), 0\.0 MB, largest none/);
  assert.equal(moved.out['size_set'], 'logs/status/2026-10.ndjson');
});

test('data file sizes: a truncated listing warns; an unreadable answer changes nothing (state unknown)', () => {
  const t = runSizes({ ...todaysTree(), truncated: true });
  assert.match(t.stdout, /listing TRUNCATED/);
  assert.match(t.stdout, /::warning title=Data file size::the data tree listing was truncated/);
  for (const bad of ['', 'not json', JSON.stringify({ message: 'Not Found' }), JSON.stringify({ tree: 'x' })]) {
    const r = runSizes(bad);
    assert.equal(r.status, 0, bad);
    assert.match(r.stdout, /data tree: unknown/, bad);
    assert.equal(r.out['tree_read'], undefined, `${bad}: no outputs, so the issue step is skipped`);
  }
  // Entries without a numeric size (submodules, odd shapes) are skipped, not counted.
  const odd = runSizes({ truncated: false, tree: [null, { path: 'status/history/x', type: 'blob' }, { type: 'blob', size: 99_000_000 }, blob('status/history/2026-10.ndjson', 10)] });
  assert.equal(odd.status, 0);
  assert.match(odd.stdout, /status history: 1 file\(s\)/);
  assert.equal(odd.out['size_set'], '');
});

test('health.yml: the size steps run after a red feed check, never fail the run, and the issue opens and closes', () => {
  assert.match(sizesStep, /id: sizes\n\s+if: always\(\)\n\s+continue-on-error: true/);
  assert.match(sizesStep, /gh api "repos\/\$\{\{ github\.repository \}\}\/git\/trees\/data\?recursive=1" > data-tree\.json/);
  assert.match(sizesStep, /DATA_FILE_WARN_BYTES: '45000000'/);
  assert.doesNotMatch(sizesStep, /exit 1/);
  const issue = yml.slice(yml.indexOf('- name: Data file size issue'), yml.indexOf('\n  alerts:'));
  assert.match(issue, /if: always\(\) && steps\.sizes\.outputs\.tree_read == '1'/);
  assert.match(issue, /continue-on-error: true/);
  assert.match(issue, /TITLE="\[health\] data file size"/);
  assert.match(issue, /size-set: \$\{SIZE_SET\}/);
  assert.match(issue, /gh issue close/);
  assert.doesNotMatch(issue, /exit 1/);
});
