import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACTION_ORDER,
  CLASS_A_ACTIONS,
  CLASS_B_ACTIONS,
  buildRequests,
  evaluate,
  main,
  periods,
} from '../scripts/usage-alarm.mjs';

// Guard G11 of the server-content plan (2026-11-27): scripts/usage-alarm.mjs, usage-alarm.yml. Nothing here touches the network.

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/usage-alarm/${name}`, import.meta.url));
const HEALTHY = JSON.parse(readFileSync(fixture('healthy.json'), 'utf8')) as Record<string, any>;
/** Day 16 of a 30-day month at noon: 15.5 days elapsed. */
const NOW = Date.parse('2026-11-16T12:00:00Z');
const answers = (patch: (a: Record<string, any>) => void): Record<string, any> => {
  const a = structuredClone(HEALTHY);
  patch(a);
  return a;
};
const setOp = (a: Record<string, any>, name: string, n: number): void => {
  const rows = a.r2.data.viewer.accounts[0].r2OperationsAdaptiveGroups as any[];
  rows.find((r) => r.dimensions.actionType === name).sum.requests = n;
};
const wAt = (a: Record<string, any>, n: number): void => {
  a.workers.data.viewer.accounts[0].workersInvocationsAdaptive[0].sum.requests = n;
};

test('usage alarm: the healthy fixture passes and prints shares only', () => {
  const r = evaluate(HEALTHY, NOW);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.unavailable, []);
  assert.equal(r.lines.length, 5);
  for (const l of r.lines) assert.match(l, /\d+(\.\d+)? %/);
  assert.doesNotMatch(r.lines.join('\n'), /\d{4,}/, 'no absolute count');
});

test('usage alarm: Class B over 60 % of the month fails', () => {
  const r = evaluate(answers((a) => { setOp(a, 'GetObject', 6_000_000); }), NOW);
  assert.equal(r.exitCode, 1);
  assert.ok(r.failures.some((f) => f.startsWith('R2 Class B is at')));
});

test('usage alarm: Class B projection over 80 % fails below the 60 % line', () => {
  // 4.2 M of 10 M = 42 %, 15.5 of 30 days: the projection is 81.3 %.
  const r = evaluate(answers((a) => { setOp(a, 'GetObject', 3_000_000); setOp(a, 'HeadObject', 1_200_000); }), NOW);
  assert.equal(r.exitCode, 1);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0]!, /projects to/);
  // 4.0 M projects to 77.4 %: green.
  assert.equal(evaluate(answers((a) => { setOp(a, 'GetObject', 3_000_000); setOp(a, 'HeadObject', 1_000_000); }), NOW).exitCode, 0);
});

test('usage alarm: the projection is not judged on day 1', () => {
  const r = evaluate(answers((a) => { setOp(a, 'GetObject', 3_000_000); }), Date.parse('2026-11-01T06:00:00Z'));
  assert.equal(r.exitCode, 0);
  assert.ok(r.lines.some((l) => /not judged/.test(l)));
});

test('usage alarm: Class A over 60 % fails; the free operations count toward neither class', () => {
  assert.equal(evaluate(answers((a) => { setOp(a, 'PutObject', 600_001); }), NOW).exitCode, 1);
  assert.equal(evaluate(answers((a) => { setOp(a, 'DeleteObject', 9_000_000); }), NOW).exitCode, 0);
  assert.ok(CLASS_B_ACTIONS.includes('HeadObject') && CLASS_B_ACTIONS.includes('GetObject'));
  assert.ok(!CLASS_A_ACTIONS.some((x) => CLASS_B_ACTIONS.includes(x)));
});

test('usage alarm: Workers requests yesterday over 70,000 fail, 70,000 itself passes', () => {
  assert.equal(evaluate(answers((a) => { wAt(a, 60_001); }), NOW).exitCode, 1); // 60,001 + 15,000 = 75,001
  assert.equal(evaluate(answers((a) => { wAt(a, 55_000); }), NOW).exitCode, 0); // exactly 70,000
});

test('usage alarm: D1 rows written yesterday over 60,000 fail', () => {
  const r = evaluate(answers((a) => { a.d1.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups[0].sum.rowsWritten = 60_001; }), NOW);
  assert.equal(r.exitCode, 1);
  assert.match(r.failures[0]!, /^D1 rows written/);
});

test('usage alarm: an unavailable dataset fails by name, never as zero', () => {
  const r = evaluate(JSON.parse(readFileSync(fixture('r2-unavailable.json'), 'utf8')), NOW);
  assert.equal(r.exitCode, 3);
  assert.match(r.unavailable[0]!, /^r2OperationsAdaptiveGroups:/);
  for (const [k, name] of [['workers', 'workersInvocationsAdaptive'], ['d1', 'd1AnalyticsAdaptiveGroups']] as const) {
    const gone = evaluate(answers((a) => { delete a[k]; }), NOW);
    assert.equal(gone.exitCode, 3);
    assert.match(gone.unavailable.join(), new RegExp(name));
    const empty = evaluate(answers((a) => { a[k].data.viewer.accounts[0][name] = []; }), NOW);
    assert.equal(empty.exitCode, 3, `${name}: empty rows are not zero`);
    const partial = evaluate(answers((a) => { a[k].data.viewer.accounts[0][name][0].sum = {}; }), NOW);
    assert.equal(partial.exitCode, 3, `${name}: a row without its count`);
  }
});

test('usage alarm: a failure outranks an unavailable dataset in the exit code', () => {
  const r = evaluate(answers((a) => { delete a.d1; wAt(a, 90_000); }), NOW);
  assert.equal(r.exitCode, 1);
  assert.equal(r.unavailable.length, 1);
});

test('usage alarm: the requests cover the month to now, yesterday, and carry the account in a variable only', () => {
  const p = periods(NOW);
  assert.equal(new Date(p.monthStart).toISOString(), '2026-11-01T00:00:00.000Z');
  const q = buildRequests('ACCOUNT123', NOW);
  assert.equal(q.r2.variables.start, '2026-11-01T00:00:00.000Z');
  assert.equal(q.workers.variables.start, '2026-11-15T00:00:00.000Z');
  assert.equal(q.workers.variables.end, '2026-11-16T00:00:00.000Z');
  assert.equal(q.d1.variables.day, '2026-11-15');
  for (const r of Object.values(q)) assert.doesNotMatch(r.query, /ACCOUNT123/);
});

test('usage alarm: main --file prints shares and the action order on a failure, never counts or ids', async () => {
  const lines: string[] = [];
  const code = await main({ argv: ['--file', fixture('healthy.json'), '--now', '2026-11-16T12:00:00Z'], env: {}, log: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.doesNotMatch(lines.join('\n'), /Action order/);
  const bad: string[] = [];
  const code2 = await main({ argv: ['--file', fixture('r2-unavailable.json'), '--now', '2026-11-16T12:00:00Z'], env: {}, log: (l) => bad.push(l) });
  assert.equal(code2, 3);
  assert.match(bad.join('\n'), /UNAVAILABLE: r2OperationsAdaptiveGroups/);
  assert.equal(ACTION_ORDER.length, 3);
  assert.match(ACTION_ORDER[0]!, /learn/);
  assert.match(ACTION_ORDER[1]!, /quiz_compare/);
});

test('usage alarm: main over the network path sends the token only as a header, and echoes no API text', async () => {
  const seen: { auth: string; body: string }[] = [];
  const lines: string[] = [];
  const fetchImpl = async (_u: string, init: any) => {
    seen.push({ auth: init.headers.authorization, body: init.body });
    return { ok: false, status: 403, json: async () => ({ errors: [{ message: 'token SECRETTOKEN account ACCOUNT123' }] }) };
  };
  const code = await main({ argv: [], env: { CF_ANALYTICS_TOKEN: 'SECRETTOKEN', CF_ACCOUNT_ID: 'ACCOUNT123' }, fetchImpl, now: () => NOW, log: (l) => lines.push(l) });
  assert.equal(code, 3);
  assert.equal(seen.length, 3);
  assert.equal(seen[0]!.auth, 'Bearer SECRETTOKEN');
  assert.doesNotMatch(lines.join('\n'), /SECRETTOKEN|ACCOUNT123/);
  const missing: string[] = [];
  assert.equal(await main({ argv: [], env: {}, log: (l) => missing.push(l) }), 3);
  assert.match(missing[0]!, /CF_ANALYTICS_TOKEN is not set/);
});

test('usage alarm workflow: only CF_ANALYTICS_TOKEN, read-only, two daily crons, pinned actions', () => {
  const yml = readFileSync(fileURLToPath(new URL('../.github/workflows/usage-alarm.yml', import.meta.url)), 'utf8');
  assert.deepEqual([...new Set([...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))], ['CF_ANALYTICS_TOKEN']);
  assert.deepEqual([...yml.matchAll(/^\s+- cron: '(.+)'/gm)].map((m) => m[1]).length, 2);
  assert.doesNotMatch(yml, /(: write|environment:)/);
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /^permissions:\n {2}contents: read\n/m);
});
