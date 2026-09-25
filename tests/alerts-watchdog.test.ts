import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  annotation,
  buildUsageRequest,
  DEFAULT_THRESHOLDS,
  evaluateStatus,
  evaluateUsage,
  fetchJson,
  GRAPHQL_URL,
  main,
  parseArgs,
  parseUsageResponse,
  SELFTEST_MIN_HEADROOM_PCT,
  STATUS_URL,
  usageWindow,
  type FetchImpl,
} from '../scripts/alerts-watchdog.mjs';

// The alert-pipeline watchdog (scripts/alerts-watchdog.mjs, run by .github/workflows/health.yml).
// Fixtures: tests/fixtures/alerts-status/healthy.json is a real capture of the public prod document; every
// other status fixture is that capture with exactly one failing condition. Nothing here touches the network.

const FIXTURES = join(import.meta.dirname, 'fixtures');
const statusFixture = (name: string): Record<string, any> => JSON.parse(readFileSync(join(FIXTURES, 'alerts-status', `${name}.json`), 'utf8'));
const cfFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, 'cf-analytics', `${name}.json`), 'utf8'));

const HEALTHY = statusFixture('healthy');
/** 15 s after the healthy capture was generated. */
const NOW = (HEALTHY.generatedAtMs as number) + 15_000;
const noSleep = async (): Promise<void> => {};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake fetch that answers from a queue per URL and records every call. */
function fakeFetch(routes: Record<string, Array<Response | Error>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    const queue = routes[url];
    if (!queue || queue.length === 0) throw new Error(`unexpected fetch ${url}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  };
  return { impl, calls };
}

// --- evaluateStatus: one fixture per condition ---

test('healthy fixture (live prod capture) passes every check', () => {
  const v = evaluateStatus(HEALTHY, { nowMs: NOW });
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.warnings, []);
  assert.match(v.summary, /age=15s/);
  assert.match(v.summary, /providers=usgs:ok,feed:ok,emsc:ok,gfz:ok/);
  assert.match(v.summary, /policy=signed\/v19/);
  assert.match(v.summary, /degraded=none/);
  assert.match(v.summary, /headroom=92%/);
  assert.match(v.summary, /apns=configured/);
});

test('stale fixture: generatedAtMs older than 300 s fails', () => {
  const v = evaluateStatus(statusFixture('stale'), { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /615 s old \(limit 300 s\)/);
});

test('freshness boundary: 300 s passes, 301 s fails', () => {
  assert.deepEqual(evaluateStatus(HEALTHY, { nowMs: HEALTHY.generatedAtMs + 300_000 }).problems, []);
  assert.equal(evaluateStatus(HEALTHY, { nowMs: HEALTHY.generatedAtMs + 301_000 }).problems.length, 1);
});

test('provider-down fixture: ok:false with >= 3 consecutive failures fails; a single failure is only a note', () => {
  const v = evaluateStatus(statusFixture('provider-down'), { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /provider usgs is down: ok:false with 4 consecutive failures \(limit 3\), last HTTP 503/);
  assert.equal(v.notes.length, 1);
  assert.match(v.notes[0]!, /provider emsc is ok:false with 1 consecutive failures/);
  assert.match(v.summary, /usgs:FAIL\(4\).*emsc:FAIL\(1\)/);
});

test('provider streak boundary: 2 failures pass, 3 fail', () => {
  const doc = structuredClone(HEALTHY);
  Object.assign(doc.detector.providers[1], { ok: false, consecutiveFailures: 2 });
  assert.deepEqual(evaluateStatus(doc, { nowMs: NOW }).problems, []);
  doc.detector.providers[1].consecutiveFailures = 3;
  assert.match(evaluateStatus(doc, { nowMs: NOW }).problems[0]!, /provider feed is down/);
});

test('policy-fallback fixture: policy.fallback == true fails with the reason', () => {
  const v = evaluateStatus(statusFixture('policy-fallback'), { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /compiled FALLBACK alerts policy \(v1, reason: expired\)/);
});

test('degraded fixture: degraded.active fails with the level', () => {
  const v = evaluateStatus(statusFixture('degraded'), { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /DEGRADED \(level tier2-off, reason: budget_exhausted\)/);
});

test('low-headroom fixture: budget.headroomPct < 20 fails; 20 passes; absent is not judged', () => {
  const v = evaluateStatus(statusFixture('low-headroom'), { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /headroom is 12 % \(limit 20 %\)/);
  const at20 = structuredClone(HEALTHY);
  at20.budget.headroomPct = 20;
  assert.deepEqual(evaluateStatus(at20, { nowMs: NOW }).problems, []);
  const absent = structuredClone(HEALTHY);
  delete absent.budget.headroomPct;
  const va = evaluateStatus(absent, { nowMs: NOW });
  assert.deepEqual(va.problems, []);
  assert.match(va.summary, /headroom=n\/a/);
});

test('apns-dry fixture: apns.configured == false fails', () => {
  const v = evaluateStatus(statusFixture('apns-dry'), { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /APNs is NOT configured/);
});

test('missing optional blocks warn instead of failing; missing required fields fail', () => {
  const partial = structuredClone(HEALTHY);
  delete partial.apns;
  partial.policy = null;
  delete partial.degraded;
  const v = evaluateStatus(partial, { nowMs: NOW });
  assert.deepEqual(v.problems, []);
  assert.equal(v.warnings.length, 3);

  const broken = structuredClone(HEALTHY);
  delete broken.generatedAtMs;
  delete broken.detector;
  const b = evaluateStatus(broken, { nowMs: NOW });
  assert.equal(b.problems.length, 2);
  assert.match(b.problems.join(' | '), /generatedAtMs is missing.*detector\.providers is missing/);

  assert.deepEqual(evaluateStatus([1, 2], { nowMs: NOW }).problems, ['status.json is not a JSON object']);
});

test('every failing condition at once is reported, one problem each', () => {
  const doc = structuredClone(statusFixture('stale'));
  Object.assign(doc.detector.providers[0], { ok: false, consecutiveFailures: 9 });
  doc.policy = statusFixture('policy-fallback').policy;
  doc.degraded = statusFixture('degraded').degraded;
  doc.budget.headroomPct = 5;
  doc.apns = { configured: false };
  assert.equal(evaluateStatus(doc, { nowMs: NOW }).problems.length, 6);
});

test('thresholds can be overridden (the selftest path)', () => {
  const v = evaluateStatus(HEALTHY, { nowMs: NOW, thresholds: { minHeadroomPct: SELFTEST_MIN_HEADROOM_PCT } });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /headroom is 92 % \(limit 101 %\)/);
});

// --- fetchJson: bounded retries, network vs HTTP vs parse ---

test('fetchJson retries a network error twice with backoff, then reports kind=network', async () => {
  const slept: number[] = [];
  const f = fakeFetch({ [STATUS_URL]: [new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })] });
  const r = await fetchJson(STATUS_URL, { fetchImpl: f.impl, sleep: async (ms) => void slept.push(ms) });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(slept, [2000, 5000]);
  if (!r.ok) {
    assert.equal(r.kind, 'network');
    assert.match(r.message, /network error: fetch failed \(ECONNRESET\)/);
  }
});

test('fetchJson recovers when a retry succeeds', async () => {
  const f = fakeFetch({ [STATUS_URL]: [new TypeError('fetch failed'), jsonResponse('oops', 502), jsonResponse(HEALTHY)] });
  const r = await fetchJson(STATUS_URL, { fetchImpl: f.impl, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

test('fetchJson does not retry a 404, retries an unparseable body, and times out', async () => {
  const notFound = fakeFetch({ [STATUS_URL]: [jsonResponse('missing', 404)] });
  const r404 = await fetchJson(STATUS_URL, { fetchImpl: notFound.impl, sleep: noSleep });
  assert.equal(r404.attempts, 1);
  assert.equal(!r404.ok && r404.kind, 'http');

  const garbage = fakeFetch({ [STATUS_URL]: [jsonResponse('{"trunc', 200)] });
  const rParse = await fetchJson(STATUS_URL, { fetchImpl: garbage.impl, sleep: noSleep });
  assert.equal(rParse.attempts, 3);
  assert.equal(!rParse.ok && rParse.kind, 'parse');

  const hang: FetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const rTimeout = await fetchJson(STATUS_URL, { fetchImpl: hang, sleep: noSleep, attempts: 1, timeoutMs: 20 });
  assert.equal(!rTimeout.ok && rTimeout.message, 'timed out after 20 ms');
});

// --- usage half: parsing + judging (fixtures only, the API is never called) ---

test('usageWindow covers the current UTC day', () => {
  const w = usageWindow(Date.UTC(2026, 8, 26, 6, 0, 0));
  assert.deepEqual(w, { date: '2026-09-26', datetimeStart: '2026-09-26T00:00:00.000Z', datetimeEnd: '2026-09-26T06:00:00.000Z', dayFraction: 0.25 });
  assert.equal(usageWindow(Date.UTC(2026, 8, 26, 0, 0, 5)).dayFraction, 1 / 1440);
});

test('buildUsageRequest asks for Workers requests and D1 rows written of one account', () => {
  const req = buildUsageRequest('acct123', Date.UTC(2026, 8, 26, 12, 0, 0));
  assert.match(req.query, /workersInvocationsAdaptive\(/);
  assert.match(req.query, /d1AnalyticsAdaptiveGroups\(/);
  assert.match(req.query, /sum \{ requests \}/);
  assert.match(req.query, /sum \{ rowsWritten \}/);
  assert.deepEqual(req.variables, { accountTag: 'acct123', datetimeStart: '2026-09-26T00:00:00.000Z', datetimeEnd: '2026-09-26T12:00:00.000Z', date: '2026-09-26' });
});

test('parseUsageResponse sums every group into account totals (no per-script names leave the parser)', () => {
  assert.deepEqual(parseUsageResponse(cfFixture('usage-ok')), { ok: true, workersRequests: 16150, d1RowsWritten: 5944 });
});

test('parseUsageResponse classifies authz errors and an invisible account as auth, others as graphql/shape', () => {
  assert.deepEqual(parseUsageResponse(cfFixture('authz-error')), { ok: false, kind: 'auth', message: 'not authorized for that account' });
  const empty = parseUsageResponse(cfFixture('empty-accounts'));
  assert.equal(!empty.ok && empty.kind, 'auth');
  const transient = parseUsageResponse(cfFixture('transient-error'));
  assert.equal(!transient.ok && transient.kind, 'graphql');
  const noAccounts = parseUsageResponse({ data: { viewer: {} } });
  assert.equal(!noAccounts.ok && noAccounts.kind, 'shape');
  const badSum = parseUsageResponse({ data: { viewer: { accounts: [{ workers: [{ sum: {} }], d1: [] }] } } });
  assert.equal(!badSum.ok && badSum.kind, 'shape');
  const notObject = parseUsageResponse('nope');
  assert.equal(!notObject.ok && notObject.kind, 'shape');
});

test('evaluateUsage fails at 80 % of either Free cap and not below', () => {
  const ok = parseUsageResponse(cfFixture('usage-ok'));
  const over = parseUsageResponse(cfFixture('usage-over'));
  assert.ok(ok.ok && over.ok);
  if (!ok.ok || !over.ok) return;
  assert.deepEqual(evaluateUsage(ok, { dayFraction: 0.5 }).problems, []);
  const v = evaluateUsage(over, { dayFraction: 0.9 });
  assert.equal(v.problems.length, 2);
  assert.match(v.problems[0]!, /Workers requests today: 80440 = 80\.4 % of the Workers Free cap \(100000\/day; limit 80 %\)/);
  assert.match(v.problems[1]!, /D1 rows written today: 85000 = 85\.0 %/);
  const edge = evaluateUsage({ workersRequests: 79_999, d1RowsWritten: 80_000 }, { dayFraction: 1 });
  assert.equal(edge.problems.length, 1);
  assert.match(edge.problems[0]!, /D1 rows written/);
  assert.match(evaluateUsage(ok, { dayFraction: 0.5 }).summary, /projected 32300\/day/);
});

// --- CLI ---

test('annotation escapes the workflow-command metacharacters', () => {
  assert.equal(annotation('error', 'a: b, c', '50% done\nnext'), '::error title=a%3A b%2C c::50%25 done%0Anext');
});

test('parseArgs: defaults, overrides, selftest via flag or env, and bad input', () => {
  assert.deepEqual(parseArgs([]).thresholds, { ...DEFAULT_THRESHOLDS });
  const o = parseArgs(['--url', 'https://x/s.json', '--max-age-sec', '600', '--usage-fail-pct', '50']);
  assert.equal(o.url, 'https://x/s.json');
  assert.equal(o.thresholds.maxAgeSec, 600);
  assert.equal(o.thresholds.usageFailPct, 50);
  assert.equal(parseArgs(['--selftest']).thresholds.minHeadroomPct, SELFTEST_MIN_HEADROOM_PCT);
  assert.equal(parseArgs([], { WATCHDOG_SELFTEST: '1' }).selftest, true);
  assert.equal(parseArgs([], { WATCHDOG_SELFTEST: '' }).selftest, false);
  assert.throws(() => parseArgs(['--max-age-sec', 'abc']), /non-negative number/);
  assert.throws(() => parseArgs(['--url']), /needs a value/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['toString', '1']), /unknown argument/);
});

async function run(opts: { routes: Record<string, Array<Response | Error>>; env?: Record<string, string>; argv?: string[] }) {
  const lines: string[] = [];
  const f = fakeFetch(opts.routes);
  const code = await main({ argv: opts.argv ?? [], env: opts.env ?? {}, fetchImpl: f.impl, now: () => NOW, log: (l) => void lines.push(l), sleep: noSleep });
  return { code, lines, out: lines.join('\n'), calls: f.calls };
}

test('main: healthy document, no token -> exit 0 and the usage API is never called', async () => {
  const r = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)] } });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /::error/);
  assert.match(r.out, /alert pipeline healthy/);
  assert.deepEqual(r.calls.map((c) => c.url), [STATUS_URL]);
});

test('main: every failing fixture exits 1 with an "Alert pipeline unhealthy" error', async () => {
  for (const name of ['stale', 'provider-down', 'policy-fallback', 'degraded', 'low-headroom', 'apns-dry']) {
    const r = await run({ routes: { [STATUS_URL]: [jsonResponse(statusFixture(name))] } });
    assert.equal(r.code, 1, name);
    assert.match(r.out, /::error title=Alert pipeline unhealthy::/, name);
  }
});

test('main: an unreachable status.json exits 2 and says the state is UNKNOWN, not unhealthy', async () => {
  const r = await run({ routes: { [STATUS_URL]: [new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })] } });
  assert.equal(r.code, 2);
  assert.equal(r.calls.length, 3);
  assert.match(r.out, /::error title=Alert watchdog could not read status.json \(network error\)::/);
  assert.match(r.out, /UNKNOWN/);
  assert.doesNotMatch(r.out, /Alert pipeline unhealthy/);
  const http = await run({ routes: { [STATUS_URL]: [jsonResponse('gone', 404)] } });
  assert.equal(http.code, 2);
  assert.match(http.out, /could not read status.json \(HTTP 404\)::HTTP 404 after 1 attempt\(s\).*missing or blocked/);
  assert.match(r.out, /not a confirmed pipeline failure/);
});

test('main: selftest turns the healthy document red', async () => {
  const r = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)] }, env: { WATCHDOG_SELFTEST: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /::notice title=Alert watchdog selftest::/);
  // `%` is escaped as `%25` inside a workflow command (GitHub renders it back as `%`).
  assert.match(r.out, /::error title=\[selftest\] Alert pipeline unhealthy::free-tier headroom is 92 %25 \(limit 101 %25\)/);
});

test('main: usage half runs only with a token, sends it only to the GraphQL API, and fails at 80 %', async () => {
  const env = { CF_ANALYTICS_TOKEN: 'test-token', CF_ACCOUNT_ID: 'acct123' };
  const ok = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)], [GRAPHQL_URL]: [jsonResponse(cfFixture('usage-ok'))] }, env });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /account usage today \(UTC\): Workers requests 16150\/100000/);
  assert.doesNotMatch(ok.out, /shelter-api-prod|00000000-0000/, 'no Worker or database names in the public run log');
  const statusCall = ok.calls.find((c) => c.url === STATUS_URL)!;
  const gqlCall = ok.calls.find((c) => c.url === GRAPHQL_URL)!;
  assert.equal(new Headers(statusCall.init?.headers).get('authorization'), null);
  assert.equal(new Headers(gqlCall.init?.headers).get('authorization'), 'Bearer test-token');
  assert.equal(gqlCall.init?.method, 'POST');
  assert.equal(JSON.parse(String(gqlCall.init?.body)).variables.accountTag, 'acct123');

  const over = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)], [GRAPHQL_URL]: [jsonResponse(cfFixture('usage-over'))] }, env });
  assert.equal(over.code, 1);
  assert.match(over.out, /::error title=Cloudflare free-tier usage high::/);
});

test('main: a rejected token or a missing account id is a misconfiguration (exit 3); transient errors only warn', async () => {
  const env = { CF_ANALYTICS_TOKEN: 'test-token', CF_ACCOUNT_ID: 'acct123' };
  const authz = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)], [GRAPHQL_URL]: [jsonResponse(cfFixture('authz-error'))] }, env });
  assert.equal(authz.code, 3);
  assert.match(authz.out, /::error title=Alert watchdog misconfigured::the usage check was refused/);
  const http403 = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)], [GRAPHQL_URL]: [jsonResponse({ success: false }, 403)] }, env });
  assert.equal(http403.code, 3);
  const noAccount = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)] }, env: { CF_ANALYTICS_TOKEN: 'test-token' } });
  assert.equal(noAccount.code, 3);
  assert.deepEqual(noAccount.calls.map((c) => c.url), [STATUS_URL]);
  const transient = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)], [GRAPHQL_URL]: [jsonResponse(cfFixture('transient-error'))] }, env });
  assert.equal(transient.code, 0);
  assert.match(transient.out, /::warning title=Cloudflare usage unavailable::query timed out/);
  const down = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)], [GRAPHQL_URL]: [jsonResponse('bad gateway', 502)] }, env });
  assert.equal(down.code, 0);
  assert.match(down.out, /HTTP 502 after 3 attempt\(s\)/);
});

test('main: an unhealthy pipeline outranks an unreadable usage check and a bad argument exits 3', async () => {
  const env = { CF_ANALYTICS_TOKEN: 'test-token', CF_ACCOUNT_ID: 'acct123' };
  const r = await run({ routes: { [STATUS_URL]: [jsonResponse(statusFixture('degraded'))], [GRAPHQL_URL]: [jsonResponse(cfFixture('authz-error'))] }, env });
  assert.equal(r.code, 1);
  const bad = await run({ routes: {}, argv: ['--max-age-sec', '-5'] });
  assert.equal(bad.code, 3);
  assert.match(bad.out, /::error title=Alert watchdog misconfigured::/);
});

test('main: --status-file judges a saved document and writes the step summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alerts-watchdog-'));
  try {
    const summary = join(dir, 'summary.md');
    const lines: string[] = [];
    const code = await main({
      argv: ['--status-file', join(FIXTURES, 'alerts-status', 'apns-dry.json')],
      env: { GITHUB_STEP_SUMMARY: summary },
      fetchImpl: async () => {
        throw new Error('no network in this test');
      },
      now: () => NOW,
      log: (l) => void lines.push(l),
      sleep: noSleep,
    });
    assert.equal(code, 1);
    const md = readFileSync(summary, 'utf8');
    assert.match(md, /### Alert-pipeline watchdog/);
    assert.match(md, /status\.json: \*\*UNHEALTHY\*\* \(1 problem\(s\)\)/);
    assert.match(md, /account usage: skipped \(no CF_ANALYTICS_TOKEN\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
