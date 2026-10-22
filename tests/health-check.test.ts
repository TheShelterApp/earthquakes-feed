import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('health check: a pinned source failing on its certificate keeps the certificate issue open, with no leaf due (TMD, 2026-10-13)', () => {
  // TMD failed every handshake from 2026-10-09 (its leaf renewed under another intermediate). Its last leaf, expired, was
  // the only thing that held the issue open, and it leaves status.json a week after it was last read (10-16): the issue
  // would have closed with TMD still cut off. status.json tls_errors (the aggregate, 6 h past the last failure) holds it.
  const phivolcs = { not_after: '2026-11-19T05:01:03.000Z', days_left: 36.5, issuer: 'GlobalSign RSA OV SSL CA 2018', subject: '*.phivolcs.dost.gov.ph', seen_at: '2026-10-13T17:56:58.926Z' };
  const tlsErrors = {
    tmd: { error: 'unable to verify the first certificate (the pinned intermediate no longer completes this host\'s chain: pin the one its leaf names, providers/tls/README.md)', since: '2026-10-09T02:01:00.000Z', last_at: '2026-10-16T02:00:00.000Z' },
  };
  const failing = { degraded: ['tmd'], tls_leaves: { phivolcs }, tls_errors: tlsErrors, providers: providers(['tmd', 'phivolcs'], { tmd: { ok: false } }) };
  const { out, stdout } = run(failing);
  assert.equal(out['tls_set'], 'cert:tmd');
  assert.equal(out['tls'], `tmd: the pinned fetch fails on a certificate since 2026-10-09T02:01:00.000Z (last 2026-10-16T02:00:00.000Z): ${tlsErrors.tmd.error}`);
  assert.match(stdout, /::warning::pinned certificate tmd: the pinned fetch fails on a certificate/);
  assert.equal(out['problem'], '', 'a warning, never a red run');
  // With a leaf under 7 days as well, both are named; the issue's set line tells them apart.
  const tmdLeaf = { not_after: '2026-10-09T01:59:47.000Z', days_left: -4.7, issuer: 'GlobalSign GCC R6 AlphaSSL CA 2025', subject: '*.tmd.go.th', seen_at: '2026-10-09T01:56:48.498Z' };
  const both = run({ ...failing, tls_leaves: { phivolcs, tmd: tmdLeaf } });
  assert.equal(both.out['tls_set'], 'tmd,cert:tmd');
  assert.equal(both.out['tls']!.split('; ').length, 2);
  // An entry never carries a semicolon, a backtick or a line break into the one-line step output (the round-24 oneLine).
  const odd = run({ ...failing, tls_errors: { tmd: { ...tlsErrors.tmd, error: 'a; b\nc`d' } } });
  assert.match(odd.out['tls']!, /: a b c d$/);
  // Fixed (no tls_errors, the current leaf far from its end): nothing keeps the issue open.
  assert.equal(run({ degraded: [], tls_leaves: { phivolcs }, tls_errors: {}, providers: providers(['tmd', 'phivolcs']) }).out['tls_set'], '');
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

function runSizes(tree: unknown, limit = '45000000', dayLimit = '5000000'): { out: Record<string, string>; stdout: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'health-sizes-'));
  writeFileSync(join(dir, 'data-tree.json'), typeof tree === 'string' ? tree : JSON.stringify(tree));
  const outFile = join(dir, 'out.txt');
  writeFileSync(outFile, '');
  const r = spawnSync(process.execPath, ['-e', sizesScript], { cwd: dir, env: { ...process.env, DATA_FILE_WARN_BYTES: limit, HISTORY_DAY_FILE_WARN_BYTES: dayLimit, GITHUB_OUTPUT: outFile }, encoding: 'utf8' });
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
  assert.match(r.stdout, /status history: 1 file\(s\) \(0 day file\(s\)\), 6\.5 MB, largest status\/history\/2026-10\.ndjson 6\.5 MB \(warning above 5\.0 MB a day file, 45\.0 MB any other file\)/);
  assert.match(r.stdout, /data tree: 4 files, 10\.0 MB \(status 6\.5 MB, events 2\.4 MB, knowledge 0\.9 MB, \(root\) 0\.1 MB\)/);
  assert.doesNotMatch(r.stdout, /::warning/);
  assert.deepEqual([r.out['tree_read'], r.out['size_set'], r.out['size']], ['1', '', '']);
});

test('data file sizes: a run-log file past 45 MB and any other large file on data warn and name the issue set, largest first', () => {
  const r = runSizes(todaysTree(46_200_000, [blob('knowledge/index/huge.json', 52_000_000)]));
  assert.equal(r.status, 0, 'a warning, never a failed step');
  assert.match(r.stdout, /::warning title=Data file size::knowledge\/index\/huge\.json: 52\.0 MB, over 45\.0 MB \(a file on the data branch\): every rewrite of a large file grows the repository, and GitHub rejects a pushed file above 100 MiB/);
  assert.match(r.stdout, /::warning title=Data file size::status\/history\/2026-10\.ndjson: 46\.2 MB, over 45\.0 MB \(the run log, rewritten by every aggregate commit\)/);
  assert.equal(r.out['size_set'], 'knowledge/index/huge.json,status/history/2026-10.ndjson');
  assert.equal(r.out['size']!.split('; ').length, 2);
  assert.ok(!r.out['size']!.split('; ').some((e) => e.includes(';')), 'one entry per file for the issue body');
  // The boundary is strict, like the aggregate's: exactly 45,000,000 bytes does not warn.
  assert.equal(runSizes(todaysTree(45_000_000)).out['size_set'], '');
  assert.equal(runSizes(todaysTree(45_000_001)).out['size_set'], 'status/history/2026-10.ndjson');
});

test('data file sizes: round 17\'s day files (YYYY-MM-DD.ndjson) warn past 5 MB, the month file of before only past 45 MB', () => {
  // Lane G's layout: October's month file keeps the lines before the switch (6.5 MB, frozen), then one file a UTC day
  // (about 1.3 MB). The aggregate warns past 5 MB for a day file (HISTORY_FILE_WARN_BYTES of that branch).
  const days = Array.from({ length: 3 }, (_, i) => blob(`status/history/2026-10-${String(i + 7).padStart(2, '0')}.ndjson`, 1_300_000 + i * 1000));
  const calm = runSizes(todaysTree(6_495_366, days));
  assert.match(calm.stdout, /status history: 4 file\(s\) \(3 day file\(s\)\), 10\.4 MB, largest status\/history\/2026-10\.ndjson 6\.5 MB/);
  assert.equal(calm.out['size_set'], '', 'a 6.5 MB month file is under its 45 MB limit');
  const grown = runSizes(todaysTree(6_495_366, [...days, blob('status/history/2026-10-10.ndjson', 5_200_000)]));
  assert.equal(grown.out['size_set'], 'status/history/2026-10-10.ndjson');
  assert.match(grown.stdout, /::warning title=Data file size::status\/history\/2026-10-10\.ndjson: 5\.2 MB, over 5\.0 MB \(the run log/);
  // Exactly the limit does not warn; the limit is the step's HISTORY_DAY_FILE_WARN_BYTES.
  assert.equal(runSizes(todaysTree(1, [blob('status/history/2026-10-10.ndjson', 5_000_000)])).out['size_set'], '');
  // Only a day file's name gets the day limit: a 6 MB file of another name under status/history is judged at 45 MB.
  assert.equal(runSizes(todaysTree(1, [blob('status/history/2026-10-10.ndjson.gz', 6_000_000), blob('status/history/notes.txt', 6_000_000)])).out['size_set'], '');
});

test('data file sizes: any layout under status/history is summed and its largest file named (gzip, sub-folders)', () => {
  const days = Array.from({ length: 6 }, (_, i) => blob(`status/history/2026-10/${String(i + 1).padStart(2, '0')}.ndjson`, 1_300_000 + i * 1000));
  const tree = { truncated: false, tree: [dirEntry('status/history'), dirEntry('status/history/2026-10'), ...days, blob('status/history/2026-09.ndjson.gz', 4_000_000), blob('status.json', 9_000)] };
  const r = runSizes(tree);
  assert.match(r.stdout, /status history: 7 file\(s\) \(0 day file\(s\)\), 11\.8 MB, largest status\/history\/2026-09\.ndjson\.gz 4\.0 MB/);
  assert.equal(r.out['size_set'], '');
  // No status/history at all (the log moved elsewhere): said, and the other files are still judged.
  const moved = runSizes({ truncated: false, tree: [blob('logs/status/2026-10.ndjson', 47_000_000)] });
  assert.match(moved.stdout, /status history: 0 file\(s\) \(0 day file\(s\)\), 0\.0 MB, largest none/);
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
  assert.match(odd.stdout, /status history: 1 file\(s\) \(0 day file\(s\)\)/);
  assert.equal(odd.out['size_set'], '');
});

test('health.yml: the size steps run after a red feed check, never fail the run, and the issue opens and closes', () => {
  assert.match(sizesStep, /id: sizes\n\s+if: always\(\)\n\s+continue-on-error: true/);
  assert.match(sizesStep, /gh api "repos\/\$\{\{ github\.repository \}\}\/git\/trees\/data\?recursive=1" > data-tree\.json/);
  assert.match(sizesStep, /DATA_FILE_WARN_BYTES: '45000000'/);
  assert.match(sizesStep, /HISTORY_DAY_FILE_WARN_BYTES: '5000000'/);
  assert.doesNotMatch(sizesStep, /exit 1/);
  const issue = yml.slice(yml.indexOf('- name: Data file size issue'), yml.indexOf('\n  alerts:'));
  assert.match(issue, /if: always\(\) && steps\.sizes\.outputs\.tree_read == '1'/);
  assert.match(issue, /continue-on-error: true/);
  assert.match(issue, /TITLE="\[health\] data file size"/);
  assert.match(issue, /size-set: \$\{SIZE_SET\}/);
  assert.match(issue, /gh issue close/);
  assert.doesNotMatch(issue, /exit 1/);
});

// --- round 24: a silent source whose fetch fails is named with its error, and the issue is commented again after 48 h of
// failure (TMD: certificate chain failing from 2026-10-09, one comment saying "no rows") ---

const HOUR_MS = 3_600_000;
/** The live status.json of 2026-10-13 18:07 UTC in miniature: TMD silent because its fetch fails (v2 error object). */
const tmdStatus = (generatedAt: number, lastOkAgoH = 112.2, message: unknown = "unable to verify the first certificate (the pinned intermediate no longer completes this host's chain: pin the one its leaf names, providers/tls/README.md)"): Record<string, any> => ({
  generated: new Date(generatedAt).toISOString(),
  generatedAt,
  degraded: ['tmd'],
  silent: { tmd: { last_non_empty_at: '2026-10-09T01:56:48.498Z', counted_from: '2026-07-05T05:42:10.043Z', silent_hours: lastOkAgoH, budget_hours: 12 } },
  frozen: {},
  providers: {
    ...providers(['emsc', 'kagsr']),
    tmd: { ok: false, latency_ms: 6281, error: { kind: 'error', message, since: generatedAt - lastOkAgoH * HOUR_MS }, observations: 0, lastSuccessAt: generatedAt - lastOkAgoH * HOUR_MS, lastNonEmptyAt: generatedAt - lastOkAgoH * HOUR_MS, silent: true },
  },
});

test('health check: a silent source whose fetch fails is named with its error and failing time, not only "no rows"', () => {
  const gen = Date.parse('2026-10-13T18:07:01.145Z');
  const { out, stdout } = run(tmdStatus(gen));
  const entry = "tmd: fetch failing for 112 h (last successful fetch 2026-10-09T01:55:01.145Z), no rows for 112 h (budget 12 h, last rows 2026-10-09T01:56:48.498Z), error: unable to verify the first certificate (the pinned intermediate no longer completes this host's chain: pin the one its leaf names, providers/tls/README.md)";
  assert.equal(out['silent'], entry);
  assert.ok(stdout.includes(`::warning::silent provider ${entry}\n`));
  assert.equal(out['silent_set'], 'tmd');
  assert.equal(out['problem'], '', 'still a warning and an issue, never a red run');
  // It has failed for 48 h or more: the time it reached 48 h (epoch s) is handed to the issue step.
  assert.equal(out['failing_48h_at'], String(Math.floor((gen - 112.2 * HOUR_MS) / 1000) + 48 * 3600));
});

test('health check: an answer without rows still says "no rows"; a shorter failure or an unknown start is not a 48 h one', () => {
  const gen = Date.parse('2026-10-13T18:07:01.145Z');
  const quiet = tmdStatus(gen);
  quiet.providers.tmd = { ...quiet.providers.tmd, ok: true, error: null };
  const q = run(quiet);
  assert.equal(q.out['silent'], 'tmd: no rows for 112 h (budget 12 h, last rows 2026-10-09T01:56:48.498Z)');
  assert.equal(q.out['failing_48h_at'], '');
  // 47 h of failure: named, but not yet 48 h.
  const young = run(tmdStatus(gen, 47));
  assert.match(young.out['silent']!, /^tmd: fetch failing for 47 h /);
  assert.equal(young.out['failing_48h_at'], '');
  // No last success on record (a source that never succeeded): named, its failing time unknown, never a 48 h reminder.
  const never = tmdStatus(gen);
  never.providers.tmd = { ...never.providers.tmd, lastSuccessAt: null };
  const n = run(never);
  assert.match(n.out['silent']!, /^tmd: fetch failing \(no successful fetch on record\), no rows for 112 h/);
  assert.equal(n.out['failing_48h_at'], '');
});

test('health check: the error text is cut to one line without ";" or backticks; a v1 string error and no message work too', () => {
  const gen = Date.now();
  const nasty = run(tmdStatus(gen, 60, 'HTTP 502;\n::error::injected `code`\r\nproblem=x' + 'y'.repeat(400)));
  const entry = nasty.out['silent']!;
  assert.ok(!/[;`\r\n]/.test(entry), entry);
  assert.match(entry, /error: HTTP 502 ::error::injected code problem=xy+$/);
  assert.equal(nasty.out['problem'], '', 'the text cannot write another step output');
  assert.equal(entry.slice(entry.indexOf('error: ') + 7).length, 240);
  const v1 = tmdStatus(gen, 60);
  v1.providers.tmd = { ...v1.providers.tmd, error: 'deadline: 45000 ms spent after 3 attempt(s); last: This operation was aborted' };
  assert.match(run(v1).out['silent']!, /error: deadline: 45000 ms spent after 3 attempt\(s\) last: This operation was aborted$/);
  const none = tmdStatus(gen, 60);
  none.providers.tmd = { ...none.providers.tmd, error: null };
  assert.match(run(none).out['silent']!, /error: no error message$/);
});

// The issue step's shell script, run with a `gh` stub that applies each --jq expression to canned answers with jq.
const silentIssueStep = yml.slice(yml.indexOf('- name: Silent providers issue'), yml.indexOf('- name: Pinned certificate issue'));
const silentIssueScript = (() => {
  const lines = silentIssueStep.split('\n');
  const at = lines.findIndex((l) => /^\s+run: \|$/.test(l));
  assert.ok(at > 0, 'the issue script');
  const body = lines.slice(at + 1);
  const indent = /^(\s*)/.exec(body[0]!)![1]!.length;
  const end = body.findIndex((l) => l.trim() !== '' && /^(\s*)/.exec(l)![1]!.length < indent);
  return (end < 0 ? body : body.slice(0, end))
    .map((l) => l.slice(indent))
    .join('\n')
    .replace(/\$\{\{ github\.repository \}\}/g, 'TheShelterApp/earthquakes-feed')
    .replace(/\$\{\{ github\.server_url \}\}/g, 'https://github.com')
    .replace(/\$\{\{ github\.run_id \}\}/g, '1');
})();
const GH_STUB = `#!/bin/bash
n=$(ls "$GH_STUB_DIR" | grep -c '^call-' || true)
printf '%s\\0' "$@" > "$GH_STUB_DIR/call-$n"
prev=""; expr=""
for a in "$@"; do if [ "$prev" = "--jq" ]; then expr="$a"; fi; prev="$a"; done
case "$1 $2" in
  "issue list") jq -r "$expr" "$GH_STUB_DIR/list.json" ;;
  "issue view") jq -r "$expr" "$GH_STUB_DIR/view.json" ;;
esac
`;
const hasJq = spawnSync('jq', ['--version']).status === 0;

/** Run the step: `issue` is the open issue (null: none), its posts as [createdAt ISO, body]. Returns the gh calls. */
function runSilentIssue(env: { SILENT: string; SILENT_SET: string; FAILING_48H_AT: string }, issue: { posts: Array<[string, string]> } | null) {
  const dir = mkdtempSync(join(tmpdir(), 'health-silent-issue-'));
  writeFileSync(join(dir, 'gh'), GH_STUB, { mode: 0o755 });
  writeFileSync(join(dir, 'list.json'), JSON.stringify(issue ? [{ number: 94 }] : []));
  if (issue) {
    const [first, ...rest] = issue.posts;
    writeFileSync(join(dir, 'view.json'), JSON.stringify({ createdAt: first![0], body: first![1], comments: rest.map(([createdAt, body]) => ({ createdAt, body })) }));
  }
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', silentIssueScript], {
    env: { ...process.env, ...env, PATH: `${dir}:${process.env.PATH}`, GH_STUB_DIR: dir, GH_TOKEN: 'x' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const calls = readdirSync(dir).filter((f) => f.startsWith('call-')).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map((f) => readFileSync(join(dir, f), 'utf8').split('\0').slice(0, -1));
  return { calls, writes: calls.filter((c) => c[0] === 'issue' && c[1] !== 'list' && c[1] !== 'view'), stdout: r.stdout };
}
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const bodyOf = (call: string[]): string => call[call.indexOf('--body') + 1]!;

test('silent issue: unchanged set, no 48 h failure: no comment (as before)', { skip: hasJq ? false : 'no jq' }, () => {
  const now = Date.now();
  const r = runSilentIssue({ SILENT: 'kagsr: no rows for 13 h', SILENT_SET: 'kagsr', FAILING_48H_AT: '' }, { posts: [[iso(now - 100 * HOUR_MS), 'x\n\nsilent-set: kagsr\nRun: y']] });
  assert.deepEqual(r.writes, []);
  assert.match(r.stdout, /issue #94 already lists kagsr/);
});

test('silent issue: a fetch failing for 48 h is commented again once it reaches 48 h, then every 48 h, with the set unchanged', { skip: hasJq ? false : 'no jq' }, () => {
  const now = Date.now();
  const set = 'tmd';
  const silent = 'tmd: fetch failing for 60 h (last successful fetch x), no rows for 60 h (budget 12 h, last rows x), error: unable to verify the first certificate';
  const post = (agoH: number): [string, string] => [iso(now - agoH * HOUR_MS), `Automated watchdog\n\n- tmd: no rows\n\nsilent-set: ${set}\nRun: y`];
  const reached = String(Math.floor((now - 12 * HOUR_MS) / 1000)); // TMD reached 48 h of failure 12 h ago
  // The last post naming the set is older than that: comment once, saying why.
  const due = runSilentIssue({ SILENT: silent, SILENT_SET: set, FAILING_48H_AT: reached }, { posts: [post(30)] });
  assert.equal(due.writes.length, 1);
  assert.deepEqual(due.writes[0]!.slice(0, 3), ['issue', 'comment', '94']);
  assert.match(bodyOf(due.writes[0]!), /^Still failing: the fetch of a source listed here has failed for 48 h or more/);
  assert.match(bodyOf(due.writes[0]!), /\n- tmd: fetch failing for 60 h .*error: unable to verify the first certificate\n\nsilent-set: tmd\n/);
  // Posted after it reached 48 h, less than 48 h ago: nothing (the next run after a reminder stays quiet).
  assert.deepEqual(runSilentIssue({ SILENT: silent, SILENT_SET: set, FAILING_48H_AT: reached }, { posts: [post(30), post(1)] }).writes, []);
  assert.deepEqual(runSilentIssue({ SILENT: silent, SILENT_SET: set, FAILING_48H_AT: reached }, { posts: [post(11.9)] }).writes, []);
  // 48 h after the last post, still failing: again.
  const again = runSilentIssue({ SILENT: silent, SILENT_SET: set, FAILING_48H_AT: String(Math.floor((now - 100 * HOUR_MS) / 1000)) }, { posts: [post(200), post(48.1)] });
  assert.equal(again.writes.length, 1);
  assert.match(bodyOf(again.writes[0]!), /^Still failing:/);
  // A comment that does not name the set (a person's) does not count as the last post.
  const human = runSilentIssue({ SILENT: silent, SILENT_SET: set, FAILING_48H_AT: reached }, { posts: [post(30), [iso(now - HOUR_MS), 'Looking into it.']] });
  assert.equal(human.writes.length, 1);
});

test('silent issue: a changed set is commented as before, a new one is opened, an empty one is closed', { skip: hasJq ? false : 'no jq' }, () => {
  const now = Date.now();
  const changed = runSilentIssue({ SILENT: 'ign: no rows for 13 h; tmd: fetch failing for 60 h', SILENT_SET: 'ign,tmd', FAILING_48H_AT: String(Math.floor(now / 1000) - 3600) },
    { posts: [[iso(now - HOUR_MS), 'a\n\nsilent-set: tmd\nRun: y']] });
  assert.equal(changed.writes.length, 1);
  assert.match(bodyOf(changed.writes[0]!), /^Automated watchdog: /);
  assert.match(bodyOf(changed.writes[0]!), /\n- ign: no rows for 13 h\n- tmd: fetch failing for 60 h\n\nsilent-set: ign,tmd\n/);
  const opened = runSilentIssue({ SILENT: 'tmd: no rows for 13 h', SILENT_SET: 'tmd', FAILING_48H_AT: '' }, null);
  assert.deepEqual(opened.writes.map((c) => c.slice(0, 2)), [['issue', 'create']]);
  const closed = runSilentIssue({ SILENT: '', SILENT_SET: '', FAILING_48H_AT: '' }, { posts: [[iso(now - HOUR_MS), 'silent-set: tmd']] });
  assert.deepEqual(closed.writes.map((c) => c.slice(0, 2)), [['issue', 'comment'], ['issue', 'close']]);
  // An unreadable post time never turns into a comment every run.
  const odd = runSilentIssue({ SILENT: 'tmd: x', SILENT_SET: 'tmd', FAILING_48H_AT: 'abc' }, { posts: [['', 'silent-set: tmd']] });
  assert.deepEqual(odd.writes, []);
  // Each guard on its own (the case above trips both, so either alone passes it): an unreadable post time while a source
  // has failed for 100 h, and a malformed 48 h time under a post 100 h old.
  const longAgo = String(Math.floor((now - 100 * HOUR_MS) / 1000));
  assert.deepEqual(runSilentIssue({ SILENT: 'tmd: x', SILENT_SET: 'tmd', FAILING_48H_AT: longAgo }, { posts: [['', 'silent-set: tmd']] }).writes, []);
  assert.deepEqual(runSilentIssue({ SILENT: 'tmd: x', SILENT_SET: 'tmd', FAILING_48H_AT: '12x' }, { posts: [[iso(now - 100 * HOUR_MS), 'silent-set: tmd']] }).writes, []);
});

test('health.yml: the silent issue step gets the 48 h output and never fails the run', () => {
  assert.match(silentIssueStep, /continue-on-error: true/);
  assert.match(silentIssueStep, /FAILING_48H_AT: \$\{\{ steps\.check\.outputs\.failing_48h_at \}\}/);
  assert.doesNotMatch(silentIssueStep, /exit 1/);
});
