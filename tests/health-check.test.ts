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
