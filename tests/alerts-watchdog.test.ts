import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  annotation,
  buildUsageRequest,
  DEFAULT_THRESHOLDS,
  DELETIONS_MAX_WINDOW_MS,
  deletionsFailure,
  DIRECT_PROVIDERS,
  evaluateStatus,
  evaluateUsage,
  failureReason,
  fetchJson,
  GATEWAY_TICK_MS,
  GRAPHQL_URL,
  isFastProvider,
  main,
  parseArgs,
  parseUsageResponse,
  pollIntervalMs,
  primaryFailure,
  PROVIDER_BACKOFF_STEPS,
  PROVIDER_MIN_INTERVAL_MS,
  providerDownSec,
  SELFTEST_MIN_HEADROOM_PCT,
  STATUS_URL,
  streakDuration,
  streakSpanSec,
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

test('provider-down fixture: USGS failing for 6.5 min (failingSinceMs) fails; EMSC failing for 5 s is only a note', () => {
  const v = evaluateStatus(statusFixture('provider-down'), { nowMs: NOW });
  assert.deepEqual(v.problems, ['provider usgs is down: ok:false for 6.5 min (since 19:40:35 UTC), limit 5 min for a provider polled every 60 s, 7 consecutive failures, last HTTP 503']);
  assert.deepEqual(v.warnings, []);
  assert.deepEqual(v.notes, ['provider emsc is ok:false for 5 s (since 19:47:00 UTC), below the warning at 60 s, down at 3 min, 1 consecutive failure, last HTTP 502']);
  assert.match(v.summary, /usgs:FAIL\(7\).*emsc:FAIL\(1\)/);
});

test('provider boundary by time: the feed at 299 s warns, at 300 s fails; measured to the document, not to now', () => {
  const doc = structuredClone(HEALTHY);
  Object.assign(doc.detector.providers[1], { ok: false, consecutiveFailures: 5, failingSinceMs: HEALTHY.generatedAtMs - 299_000 });
  let v = evaluateStatus(doc, { nowMs: NOW });
  assert.deepEqual(v.problems, []);
  assert.match(v.warnings[0]!, /^provider feed is failing: ok:false for 4\.5 min \(since .*\), a warning from 60 s, down at 5 min, 5 consecutive failures/);
  // The watchdog reading the same document a minute later sees the same streak: the duration is as of generatedAtMs.
  assert.deepEqual(evaluateStatus(doc, { nowMs: NOW + 60_000 }).problems, []);
  doc.detector.providers[1].failingSinceMs = HEALTHY.generatedAtMs - 300_000;
  v = evaluateStatus(doc, { nowMs: NOW });
  assert.match(v.problems[0]!, /^provider feed is down: ok:false for 5 min \(since .*\), limit 5 min for a provider polled every 60 s/);
});

test('an older gateway (no failingSinceMs): the duration comes from the count at the gateway\'s polling, never earlier', () => {
  // 5 USGS failures span 4 min (60 s apart): a warning; 6 span 5 min: down. The old count rule was red at 3.
  const doc = structuredClone(HEALTHY);
  Object.assign(doc.detector.providers[0], { ok: false, httpStatus: 503, consecutiveFailures: 5 });
  assert.deepEqual(evaluateStatus(doc, { nowMs: NOW }).problems, []);
  assert.deepEqual(evaluateStatus(doc, { nowMs: NOW }).warnings, [
    'provider usgs is failing: ok:false for about 4 min (5 consecutive failures at 60 s polls; the gateway publishes no failingSinceMs for it), a warning from 60 s, down at 5 min, last HTTP 503: the other providers still deliver, so alerts still go out (a quake only usgs reports may come later)',
  ]);
  doc.detector.providers[0].consecutiveFailures = 6;
  assert.deepEqual(evaluateStatus(doc, { nowMs: NOW }).problems, [
    'provider usgs is down: ok:false for about 5 min (6 consecutive failures at 60 s polls; the gateway publishes no failingSinceMs for it), limit 5 min for a provider polled every 60 s, last HTTP 503',
  ]);
  // Two USGS failures (60 s) are a warning, one is a note; a damaged or future start falls back to the count too.
  doc.detector.providers[0].consecutiveFailures = 1;
  assert.match(evaluateStatus(doc, { nowMs: NOW }).notes[0]!, /^provider usgs is ok:false for about 0 s \(1 consecutive failure at 60 s polls/);
  for (const bad of ['1790365235218', -1, 0, null, Number.NaN, HEALTHY.generatedAtMs + 3_600_000]) {
    Object.assign(doc.detector.providers[0], { consecutiveFailures: 6, failingSinceMs: bad });
    assert.match(evaluateStatus(doc, { nowMs: NOW }).problems[0]!, /^provider usgs is down: ok:false for about 5 min \(6 consecutive failures/, String(bad));
  }
  // Neither a start nor a count: a note, never a failure.
  Object.assign(doc.detector.providers[0], { consecutiveFailures: undefined, failingSinceMs: undefined });
  const none = evaluateStatus(doc, { nowMs: NOW });
  assert.deepEqual([none.problems, none.warnings], [[], []]);
  assert.match(none.notes[0]!, /^provider usgs is ok:false with no failure streak published/);
});

test('round-14 gateway: the failure message names lastError and consecutiveTimeouts (the 2026-10-04 USGS timeouts)', () => {
  const doc = structuredClone(HEALTHY);
  // What the gateway publishes while USGS answers slower than its 4 s fetch timeout: HTTP 0, latency ≈ the timeout.
  Object.assign(doc.detector.providers[0], { ok: false, httpStatus: 0, latencyMs: 4000, consecutiveFailures: 387, lastError: 'timeout', consecutiveTimeouts: 387 });
  const v = evaluateStatus(doc, { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.equal(
    v.problems[0],
    "provider usgs is down: ok:false for about 31.6 h (387 consecutive failures at 60 s polls; the gateway publishes no failingSinceMs for it), limit 5 min for a provider polled every 60 s, last HTTP 0, last error timeout (slower than the gateway's fetch timeout), 387 timeouts in a row",
  );
  assert.match(v.summary, /usgs:FAIL\(387\)/); // the summary tag is unchanged
});

test('round-14 gateway: an HTTP, network or invalid failure is named; zero timeouts add nothing; a note carries it too', () => {
  const doc = structuredClone(HEALTHY);
  Object.assign(doc.detector.providers[2], { ok: false, httpStatus: 503, consecutiveFailures: 5, lastError: 'http', consecutiveTimeouts: 0 });
  Object.assign(doc.detector.providers[3], { ok: false, httpStatus: 200, consecutiveFailures: 1, lastError: 'invalid', consecutiveTimeouts: 0 });
  const v = evaluateStatus(doc, { nowMs: NOW });
  // EMSC's 5 failures span 2.5 min at 15 s polls: a warning (down at 3 min); the reason is named there too.
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.warnings, ['provider emsc is failing: ok:false for about 2.5 min (5 consecutive failures at 15 s polls; the gateway publishes no failingSinceMs for it), a warning from 60 s, down at 3 min, last HTTP 503, last error http (an HTTP error status): the other providers still deliver, so alerts still go out (a quake only emsc reports may come later)']);
  assert.deepEqual(v.notes, ['provider gfz is ok:false for about 0 s (1 consecutive failure at 15 s polls; the gateway publishes no failingSinceMs for it), below the warning at 60 s, down at 3 min, last HTTP 200, last error invalid (a body that does not parse or verify)']);
  // A streak that ended in a network error after two timeouts.
  assert.equal(failureReason({ lastError: 'network', consecutiveTimeouts: 0 }), ', last error network (a network failure before the timeout)');
  assert.equal(failureReason({ lastError: 'timeout', consecutiveTimeouts: 1 }), ", last error timeout (slower than the gateway's fetch timeout), 1 timeout in a row");
});

test('lastError / consecutiveTimeouts: missing, malformed or unknown values never break the check', () => {
  assert.equal(failureReason({}), '');
  assert.equal(failureReason(null), '');
  assert.equal(failureReason({ lastError: '', consecutiveTimeouts: -1 }), '');
  assert.equal(failureReason({ lastError: 42, consecutiveTimeouts: '3' }), '');
  assert.equal(failureReason({ consecutiveTimeouts: Number.NaN }), '');
  // An unknown code (a newer gateway) is shown as is, cut to 32 characters; only the timeout count is added.
  assert.equal(failureReason({ lastError: 'tls', consecutiveTimeouts: 2 }), ', last error tls, 2 timeouts in a row');
  assert.equal(failureReason({ lastError: 'x'.repeat(100) }), `, last error ${'x'.repeat(32)}`);
  const doc = structuredClone(HEALTHY);
  Object.assign(doc.detector.providers[0], { ok: false, consecutiveFailures: 6, lastError: { nested: true }, consecutiveTimeouts: null });
  assert.deepEqual(evaluateStatus(doc, { nowMs: NOW }).problems, ['provider usgs is down: ok:false for about 5 min (6 consecutive failures at 60 s polls; the gateway publishes no failingSinceMs for it), limit 5 min for a provider polled every 60 s, last HTTP 200']);
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

// --- round-3 gateway: per-environment APNs keys (apns.mode/production/sandbox/problems) + the fanout block ---

test('healthy-r3 fixture (legacy key, clean counters) passes with no warning and summarizes the new blocks', () => {
  const v = evaluateStatus(statusFixture('healthy-r3'), { nowMs: NOW });
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.warnings, []);
  assert.match(v.summary, /apns=configured\/legacy/);
  assert.match(v.summary, /fanout=jobs:3,sent:41,no_key:0,dropped_budget:0/);
});

test('apns-split-no-production fixture: split keys without a production key fail (every production device is skipped)', () => {
  const v = evaluateStatus(statusFixture('apns-split-no-production'), { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /split per-environment keys but holds NO production key/);
  assert.match(v.problems[0]!, /App Store and TestFlight/);
  assert.match(v.summary, /apns=configured\/split\/production=NO/);
  // The skipped devices are also surfaced as a (non-failing) counter warning.
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0]!, /12 device push\(es\) skipped today \(UTC 2026-09-25\).*skipped_no_key/);
});

test('split mode fails unless apns.production is exactly true', () => {
  for (const production of [false, undefined, null, 'true', 1]) {
    const doc = statusFixture('healthy-r3');
    doc.apns = { configured: true, mode: 'split', production, sandbox: true, problems: [] };
    if (production === undefined) delete doc.apns.production;
    assert.equal(evaluateStatus(doc, { nowMs: NOW }).problems.length, 1, String(production));
  }
  const ok = statusFixture('healthy-r3');
  ok.apns = { configured: true, mode: 'split', production: true, sandbox: true, problems: [] };
  assert.deepEqual(evaluateStatus(ok, { nowMs: NOW }).problems, []);
});

test('apns-key-problems fixture: a non-empty apns.problems fails and names the key', () => {
  const v = evaluateStatus(statusFixture('apns-key-problems'), { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /APNs key configuration has 1 problem\(s\): APNS_KEY_ID_SANDBOX set without APNS_P8_SANDBOX/);
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0]!, /2 device push\(es\) skipped today/);
});

test('the reviewed outage (split, APNS_P8 gone, skipped_no_key=12) fails twice and is no longer "healthy"', () => {
  const doc = structuredClone(HEALTHY);
  doc.apns = { configured: true, mode: 'split', production: false, sandbox: true, problems: ['APNS_KEY_ID set without APNS_P8'] };
  doc.fanout = { ...statusFixture('healthy-r3').fanout, skipped_no_key: 12 };
  const v = evaluateStatus(doc, { nowMs: NOW });
  assert.equal(v.problems.length, 2);
  assert.match(v.problems.join(' | '), /APNS_KEY_ID set without APNS_P8.*NO production key/);
  assert.equal(v.warnings.length, 1);
});

test('fanout-warnings fixture: skipped_no_key > 0 and retry_dropped_budget > 0 warn, never fail', () => {
  const v = evaluateStatus(statusFixture('fanout-warnings'), { nowMs: NOW });
  assert.deepEqual(v.problems, []);
  assert.equal(v.warnings.length, 2);
  assert.match(v.warnings[0]!, /3 device push\(es\) skipped today \(UTC 2026-09-25\) because the gateway holds no APNs key/);
  assert.match(v.warnings[1]!, /40 transient push failure\(s\) today \(UTC 2026-09-25\) were dropped without a retry.*retry_dropped_budget/);
  assert.match(v.summary, /fanout=jobs:3,sent:41,no_key:3,dropped_budget:40/);
});

test('older gateways: missing mode/production/problems/fanout (or odd shapes) never fail or warn', () => {
  // The live capture predates round 3: apns is just {configured:true} and there is no fanout block.
  const legacyDoc = evaluateStatus(HEALTHY, { nowMs: NOW });
  assert.deepEqual(legacyDoc.problems, []);
  assert.deepEqual(legacyDoc.warnings, []);
  assert.match(legacyDoc.summary, /apns=configured fanout=n\/a/);

  const nullFanout = statusFixture('healthy-r3');
  nullFanout.fanout = null;
  const vn = evaluateStatus(nullFanout, { nowMs: NOW });
  assert.deepEqual([vn.problems, vn.warnings], [[], []]);
  assert.match(vn.summary, /fanout=none/);

  const odd = statusFixture('healthy-r3');
  odd.apns = { configured: true, mode: 'legacy', problems: 'not-an-array' };
  odd.fanout = { day: '2026-09-25' };
  const vo = evaluateStatus(odd, { nowMs: NOW });
  assert.deepEqual([vo.problems, vo.warnings], [[], []]);
  assert.match(vo.summary, /fanout=jobs:\?,sent:\?,no_key:\?,dropped_budget:\?/);
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
  doc.apns = { configured: true, mode: 'split', production: false, sandbox: true, problems: ['APNS_KEY_ID set without APNS_P8'] };
  assert.equal(evaluateStatus(doc, { nowMs: NOW }).problems.length, 7);
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
  for (const name of ['stale', 'provider-down', 'policy-fallback', 'degraded', 'low-headroom', 'apns-dry', 'apns-split-no-production', 'apns-key-problems']) {
    const r = await run({ routes: { [STATUS_URL]: [jsonResponse(statusFixture(name))] } });
    assert.equal(r.code, 1, name);
    assert.match(r.out, /::error title=Alert pipeline unhealthy::/, name);
  }
});

test('main: fan-out counter warnings are annotated and listed in the summary but keep exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alerts-watchdog-'));
  try {
    const summary = join(dir, 'summary.md');
    const lines: string[] = [];
    const f = fakeFetch({ [STATUS_URL]: [jsonResponse(statusFixture('fanout-warnings'))] });
    const code = await main({ argv: [], env: { GITHUB_STEP_SUMMARY: summary }, fetchImpl: f.impl, now: () => NOW, log: (l) => void lines.push(l), sleep: noSleep });
    assert.equal(code, 0);
    const out = lines.join('\n');
    assert.doesNotMatch(out, /::error/);
    assert.equal(lines.filter((l) => l.startsWith('::warning title=Alert pipeline::')).length, 2);
    assert.match(out, /alert pipeline healthy/);
    const md = readFileSync(summary, 'utf8');
    assert.match(md, /status\.json: healthy/);
    assert.match(md, /  - warning: 3 device push\(es\) skipped today/);
    assert.match(md, /  - warning: 40 transient push failure\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

// --- upstream freshness (X-4 / P1 #14): the feed manifest and the config bundle the gateway last read ---

test('freshness: a document without the fields (today\'s gateway) skips both checks', () => {
  const v = evaluateStatus(HEALTHY, { nowMs: NOW });
  assert.deepEqual(v.problems, []);
  assert.match(v.summary, /feed_manifest=n\/a config_bundle=n\/a/);
  assert.equal(DEFAULT_THRESHOLDS.maxFeedManifestAgeSec, 1_800);
  assert.equal(DEFAULT_THRESHOLDS.maxConfigBundleAgeSec, 10 * 86_400);
});

test('freshness: the feed manifest older than 30 min fails; the age is taken from generated_ms when present', () => {
  const doc = structuredClone(HEALTHY);
  Object.assign(doc, { feed_manifest_generated_ms: NOW - 1_700_000, feed_manifest_age_s: 1_690, config_bundle_generated_ms: NOW - 86_400_000, config_bundle_age_s: 86_390 });
  assert.deepEqual(evaluateStatus(doc, { nowMs: NOW }).problems, []);
  doc.feed_manifest_generated_ms = NOW - 1_801_000;
  const v = evaluateStatus(doc, { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /earthquakes-feed manifest the gateway last read is 30 min old \(limit 30 min\)/);
  assert.match(v.summary, /feed_manifest=1801s/);
});

test('freshness: without generated_ms the published age plus the document\'s own age is used', () => {
  const doc = structuredClone(HEALTHY);
  // Published 15 s before NOW with an age of 1,790 s: 1,805 s now.
  Object.assign(doc, { feed_manifest_age_s: 1_790 });
  const v = evaluateStatus(doc, { nowMs: NOW });
  assert.match(v.summary, /feed_manifest=1805s/);
  assert.equal(v.problems.length, 1);
});

test('freshness: the config bundle older than 10 days fails; a null age is a warning, not a problem', () => {
  const doc = structuredClone(HEALTHY);
  Object.assign(doc, { feed_manifest_generated_ms: null, feed_manifest_age_s: null, config_bundle_generated_ms: NOW - 11 * 86_400_000, config_bundle_age_s: 11 * 86_400 });
  const v = evaluateStatus(doc, { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /signed config bundle is 11\.0 days old \(limit 10 days\)/);
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0]!, /feed_manifest_age_s is null/);
});

test('freshness: the limits can be set on the command line', () => {
  const o = parseArgs(['--max-feed-manifest-age-sec', '900', '--max-config-bundle-age-sec', '3600']);
  assert.equal(o.thresholds.maxFeedManifestAgeSec, 900);
  assert.equal(o.thresholds.maxConfigBundleAgeSec, 3600);
});

// --- the USGS deletions query (GW-R15-1, round-16 gateways): a warning, never a failure ---

/** What a round-16 gateway publishes while USGS's `includedeleted=only` query fails: the provider stays ok, the two
 *  deletions fields appear, and the watermark (the deletions cursor) stops moving. */
const GEN_DEL = HEALTHY.generatedAtMs as number;
function deletionsFailing(failures: unknown, lastError: unknown = 'timeout', watermarkAgoMs = 2 * 3_600_000): Record<string, any> {
  const doc = structuredClone(HEALTHY);
  Object.assign(doc.detector.providers[0], { ok: true, consecutiveFailures: 0, watermarkMs: NOW - watermarkAgoMs, deletionsConsecutiveFailures: failures, deletionsLastError: lastError });
  return doc;
}

test('deletions: a streak of 3 warns with the reason and the cursor age; the run stays healthy', () => {
  assert.equal(DEFAULT_THRESHOLDS.deletionsFailures, 3);
  const v = evaluateStatus(deletionsFailing(3), { nowMs: NOW });
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.warnings, [
    "provider usgs's deletions query has failed 3 times in a row, last error timeout (slower than the gateway's fetch timeout): deleted events are not being withdrawn; its cursor (watermarkMs) is 2.0 h old (the next successful query asks from there, at most 7 days back) (warning at 3)",
  ]);
  assert.deepEqual(v.notes, []);
  assert.match(v.summary, /providers=usgs:ok\/deletions-FAIL\(3\),feed:ok,emsc:ok,gfz:ok/);
});

test('deletions: below the threshold it is a log note; at 0 or absent nothing is said', () => {
  const v = evaluateStatus(deletionsFailing(2, 'http'), { nowMs: NOW });
  assert.deepEqual(v.warnings, []);
  assert.deepEqual(v.notes, [
    "provider usgs's deletions query has failed 2 times in a row, last error http (an HTTP error status): deleted events are not being withdrawn; its cursor (watermarkMs) is 2.0 h old (the next successful query asks from there, at most 7 days back) (below the warning at 3)",
  ]);
  const one = evaluateStatus(deletionsFailing(1, null), { nowMs: NOW });
  assert.match(one.notes[0]!, /^provider usgs's deletions query has failed 1 time in a row: deleted events/);
  // The healthy capture (and every gateway before round 16) carries neither field.
  const healthy = evaluateStatus(HEALTHY, { nowMs: NOW });
  assert.deepEqual([healthy.warnings, healthy.notes], [[], []]);
  assert.match(healthy.summary, /providers=usgs:ok,feed:ok,emsc:ok,gfz:ok/);
  assert.equal(deletionsFailure(HEALTHY.detector.providers[0]), null);
});

test('deletions: missing, malformed or unknown values never break the check', () => {
  for (const bad of [0, -2, null, '12', Number.NaN, Number.POSITIVE_INFINITY, { n: 5 }, true]) {
    const v = evaluateStatus(deletionsFailing(bad), { nowMs: NOW });
    assert.deepEqual([v.problems, v.warnings, v.notes], [[], [], []], String(bad));
    assert.doesNotMatch(v.summary, /deletions/, String(bad));
  }
  assert.equal(deletionsFailure(null), null);
  assert.equal(deletionsFailure('usgs'), null);
  // An unknown or odd lastError: shown as is (cut to 32 characters) or left out; a missing or odd watermark drops the age.
  assert.deepEqual(deletionsFailure({ deletionsConsecutiveFailures: 4, deletionsLastError: 'tls' }), { failures: 4, why: ', last error tls', lasted: '' });
  assert.deepEqual(deletionsFailure({ deletionsConsecutiveFailures: 4, deletionsLastError: 'y'.repeat(80) }), { failures: 4, why: `, last error ${'y'.repeat(32)}`, lasted: '' });
  assert.deepEqual(deletionsFailure({ deletionsConsecutiveFailures: 4, deletionsLastError: { code: 1 } }), { failures: 4, why: '', lasted: '' });
  const doc = deletionsFailing(4, 'network');
  delete doc.detector.providers[0].watermarkMs;
  assert.deepEqual(evaluateStatus(doc, { nowMs: NOW }).warnings, [
    "provider usgs's deletions query has failed 4 times in a row, last error network (a network failure before the timeout): deleted events are not being withdrawn (warning at 3)",
  ]);
});

test('deletions: a cursor older than the gateway\'s 7-day window says deletions from the gap are lost (still a warning)', () => {
  assert.equal(DELETIONS_MAX_WINDOW_MS, 7 * 86_400_000);
  const inside = evaluateStatus(deletionsFailing(2_016, 'timeout', 6.5 * 86_400_000), { nowMs: NOW });
  assert.match(inside.warnings[0]!, /cursor \(watermarkMs\) is 6\.5 days old \(the next successful query asks from there, at most 7 days back\)/);
  const past = evaluateStatus(deletionsFailing(2_100, 'timeout', 7.25 * 86_400_000), { nowMs: NOW });
  assert.deepEqual(past.problems, []);
  assert.match(past.warnings[0]!, /cursor \(watermarkMs\) is 7\.3 days old, past the gateway's 7-day deletions window: a deletion from the start of the gap is no longer asked for/);
});

test('deletions: judged whatever ok says; a provider that is also down fails for its live query only', () => {
  const doc = deletionsFailing(12);
  Object.assign(doc.detector.providers[0], { ok: false, httpStatus: 0, consecutiveFailures: 12, lastError: 'timeout', consecutiveTimeouts: 12 });
  const v = evaluateStatus(doc, { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /^provider usgs is down: ok:false for about 19 min \(12 consecutive failures at 60 s polls/);
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0]!, /deletions query has failed 12 times in a row/);
  assert.match(v.summary, /usgs:FAIL\(12\)\/deletions-FAIL\(12\)/);
});

test('deletions and primary: a round-25 gateway\'s start adds how long the streak has lasted; a bad start adds nothing', () => {
  const doc = deletionsFailing(9, 'timeout');
  doc.detector.providers[0].deletionsFailingSinceMs = GEN_DEL - 45 * 60_000;
  assert.match(evaluateStatus(doc, { nowMs: NOW }).warnings[0]!, /^provider usgs's deletions query has failed 9 times in a row over 45 min, last error timeout/);
  for (const bad of [-1, 0, '1', null, GEN_DEL + 3_600_000]) {
    doc.detector.providers[0].deletionsFailingSinceMs = bad;
    assert.match(evaluateStatus(doc, { nowMs: NOW }).warnings[0]!, /^provider usgs's deletions query has failed 9 times in a row, last error timeout/, String(bad));
  }
  assert.equal(primaryFailure({ primaryConsecutiveFailures: 3, primaryFailingSinceMs: GEN_DEL - 90_000 }, GEN_DEL)!.lasted, ' over 90 s');
  assert.equal(primaryFailure({ primaryConsecutiveFailures: 3, primaryFailingSinceMs: GEN_DEL - 90_000 })!.lasted, ''); // no reference time
});

test('deletions: the threshold can be set on the command line', () => {
  const o = parseArgs(['--deletions-failures', '10']);
  assert.equal(o.thresholds.deletionsFailures, 10);
  const v = evaluateStatus(deletionsFailing(9), { nowMs: NOW, thresholds: o.thresholds });
  assert.deepEqual(v.warnings, []);
  assert.match(v.notes[0]!, /below the warning at 10/);
  assert.throws(() => parseArgs(['--deletions-failures', '-1']), /non-negative number/);
});

test('main: a failing deletions query is a warning annotation and keeps exit 0', async () => {
  const r = await run({ routes: { [STATUS_URL]: [jsonResponse(deletionsFailing(5, 'timeout'))] } });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /::error/);
  assert.match(r.out, /::warning title=Alert pipeline::provider usgs's deletions query has failed 5 times in a row/);
  assert.match(r.out, /alert pipeline healthy/);
});

// --- the USGS primary live query (2026-10-13 gateways): the summary-feed fallback is a warning, never a failure ---

/** What a 2026-10-13 gateway publishes while ComCat's FDSN live query fails and the summary feed delivers. */
function onSummary(failures: unknown, lastError: unknown = 'timeout', extra: Record<string, unknown> = {}): Record<string, any> {
  const doc = structuredClone(HEALTHY);
  Object.assign(doc.detector.providers[0], { ok: true, consecutiveFailures: 0, fallback: 'summary', primaryConsecutiveFailures: failures, primaryLastError: lastError, ...extra });
  return doc;
}

test('primary: a streak of 3 on the summary fallback warns with the reason; the run stays healthy', () => {
  assert.equal(DEFAULT_THRESHOLDS.primaryFailures, 3);
  const v = evaluateStatus(onSummary(18), { nowMs: NOW });
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.warnings, [
    "provider usgs's primary live query has failed 18 times in a row, last error timeout (slower than the gateway's fetch timeout): its live events come from the summary feed (fallback: summary), up to about two minutes later (warning at 3)",
  ]);
  assert.match(v.summary, /providers=usgs:ok\/primary-FAIL\(18\)\+summary,feed:ok,emsc:ok,gfz:ok/);
  const two = evaluateStatus(onSummary(2, 'http'), { nowMs: NOW });
  assert.deepEqual(two.warnings, []);
  assert.match(two.notes[0]!, /^provider usgs's primary live query has failed 2 times in a row, last error http .*\(below the warning at 3\)$/);
  assert.equal(parseArgs(['--primary-failures', '5']).thresholds.primaryFailures, 5);
});

test('primary: with the provider failing too, the provider line fails the run and no fallback warning is added', () => {
  const doc = onSummary(8, 'http', { ok: false, consecutiveFailures: 6, lastError: 'http', consecutiveTimeouts: 0, httpStatus: 503 });
  delete doc.detector.providers[0].fallback;
  const v = evaluateStatus(doc, { nowMs: NOW });
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0]!, /^provider usgs is down: ok:false for about 5 min \(6 consecutive failures/);
  assert.deepEqual(v.warnings, []);
  assert.match(v.summary, /usgs:FAIL\(6\)\/primary-FAIL\(8\),/);
});

test('primary: missing or malformed values never break the check', () => {
  for (const bad of [0, -1, null, '7', Number.NaN, { n: 1 }]) {
    const v = evaluateStatus(onSummary(bad), { nowMs: NOW });
    assert.deepEqual([v.problems, v.warnings, v.notes], [[], [], []], String(bad));
    assert.doesNotMatch(v.summary, /primary/, String(bad));
  }
  assert.equal(primaryFailure(HEALTHY.detector.providers[0]), null);
  assert.equal(primaryFailure(null), null);
  assert.deepEqual(primaryFailure({ primaryConsecutiveFailures: 3, primaryLastError: { x: 1 } }), { failures: 3, why: '', fallback: false, lasted: '' });
});

// --- round 25: provider outages judged by time and coverage (round 24 judged a count per polling cadence) ---

const GEN = HEALTHY.generatedAtMs as number;

/** The healthy capture with some providers failing: { id: [seconds failing, extra fields] } — the round-25 gateway's
 *  failingSinceMs, with a plausible count at the gateway's polling. A provider given `null` seconds publishes no start
 *  (an older gateway); then `count` must come in the extra fields. */
function failingFor(spec: Record<string, number | null | [number | null, Record<string, unknown>]>): Record<string, any> {
  const doc = structuredClone(HEALTHY);
  for (const p of doc.detector.providers) {
    const v = spec[p.id];
    if (v === undefined) continue;
    const [sec, extra] = Array.isArray(v) ? v : [v, {}];
    // The count the gateway would have reached: the most failures whose span at its polling fits in `sec`.
    let n = 1;
    while (sec !== null && streakSpanSec(p.id, n + 1) <= sec) n++;
    Object.assign(p, { ok: false, consecutiveFailures: n, httpStatus: 0, lastError: 'timeout', consecutiveTimeouts: n });
    if (sec !== null) p.failingSinceMs = GEN - sec * 1000;
    Object.assign(p, extra);
  }
  return doc;
}

test('cadence: the gateway polls EMSC and GFZ every 15 s tick, USGS and the feed every 60 s; backoff 60 s from 3, 300 s from 10', () => {
  assert.equal(GATEWAY_TICK_MS, 15_000);
  assert.deepEqual({ ...PROVIDER_MIN_INTERVAL_MS }, { usgs: 60_000, emsc: 10_000, gfz: 10_000, feed: 60_000 });
  assert.deepEqual(PROVIDER_BACKOFF_STEPS.map((s) => ({ ...s })), [{ atFailures: 10, intervalMs: 300_000 }, { atFailures: 3, intervalMs: 60_000 }]);
  assert.deepEqual(['emsc', 'gfz', 'usgs', 'feed', 'newsource'].map(pollIntervalMs), [15_000, 15_000, 60_000, 60_000, 60_000]);
  assert.deepEqual(['emsc', 'gfz', 'usgs', 'feed', 'newsource'].map(isFastProvider), [true, true, false, false, false]);
  assert.deepEqual([...DIRECT_PROVIDERS], ['usgs', 'emsc', 'gfz']);
  // A streak's span by its count (the fallback for a gateway without failingSinceMs): 3 EMSC failures are 30 s, 6 are
  // 3.5 min; 3 USGS failures 2 min.
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10, 11].map((n) => streakSpanSec('gfz', n)), [0, 15, 30, 90, 150, 210, 450, 750]);
  assert.deepEqual([1, 2, 3, 4, 10, 11].map((n) => streakSpanSec('usgs', n)), [0, 60, 120, 180, 540, 840]);
  assert.equal(streakSpanSec('usgs', 387), 113_640); // the 2026-10-04..06 USGS outage: about 31.6 h
});

test('the time limits: 3 min for EMSC/GFZ, 5 min for USGS, the feed and new ids; 2 min for two direct at once, 1 min for all three', () => {
  const t = { ...DEFAULT_THRESHOLDS };
  assert.deepEqual(
    [t.fastProviderDownSec, t.providerDownSec, t.twoDirectDownSec, t.allDirectDownSec, t.providerWarnSec],
    [180, 300, 120, 60, 60],
  );
  assert.deepEqual(['emsc', 'gfz', 'usgs', 'feed', 'newsource'].map((id) => providerDownSec(id, t)), [180, 180, 300, 300, 300]);
  // The count rules are gone: no threshold is a count of provider failures any more.
  assert.equal('providerFailures' in t, false);
  assert.equal('fastProviderFailures' in t, false);
  assert.throws(() => parseArgs(['--provider-failures', '3']), /unknown argument/);
  // Without a start the duration is the count's span at the gateway's polling (a lower bound of the time it lasted).
  for (const n of [1, 3, 6, 11]) assert.equal(streakDuration({ id: 'emsc', ok: false, consecutiveFailures: n }, GEN)!.sec, streakSpanSec('emsc', n));
  assert.deepEqual(streakDuration({ id: 'usgs', ok: false, consecutiveFailures: 3, failingSinceMs: GEN - 150_000 }, GEN), { sec: 150, measured: true, since: GEN - 150_000, failures: 3 });
  assert.deepEqual(streakDuration({ id: 'gfz', ok: false, consecutiveFailures: 4 }, GEN), { sec: 90, measured: false, failures: 4 });
  assert.equal(streakDuration({ id: 'gfz', ok: false }, GEN), null);
  assert.equal(streakDuration(null, GEN), null);
});

// The constants above mirror the gateway's source. When a platform checkout is at hand (SHELTER_PLATFORM_DIR, or the
// sibling ../platform of a local clone), compare them with it; CI has none and skips.
const platformDir = process.env.SHELTER_PLATFORM_DIR ?? join(import.meta.dirname, '..', '..', 'platform');
const gatewaySrc = join(platformDir, 'services', 'alerts-gateway', 'src');
test('cadence: the mirrored constants match the alerts-gateway source', { skip: existsSync(gatewaySrc) ? false : 'no platform checkout' }, () => {
  const read = (rel: string): string => readFileSync(join(gatewaySrc, rel), 'utf8');
  const ms = (v: string): number => Number(v.replace(/_/g, ''));
  const tick = /const TICK_INTERVAL_MS = ([\d_]+)/.exec(read('durable-objects/event-detector.ts'));
  assert.equal(ms(tick![1]!), GATEWAY_TICK_MS);
  const sources = read('detect/sources.ts');
  for (const [name, id] of [['EMSC_SOURCE', 'emsc'], ['GFZ_SOURCE', 'gfz'], ['USGS_SOURCE', 'usgs']] as const) {
    const m = new RegExp(`export const ${name}[^]*?minIntervalMs: ([\\d_]+)`).exec(sources);
    assert.equal(ms(m![1]!), PROVIDER_MIN_INTERVAL_MS[id], name);
  }
  const feed = /const MIN_INTERVAL_MS = ([\d_]+)/.exec(read('detect/feed-source.ts'));
  assert.equal(ms(feed![1]!), PROVIDER_MIN_INTERVAL_MS['feed']);
  const product = (v: string): number => v.split('*').reduce((n, f) => n * ms(f.trim()), 1);
  const steps = [...read('detect/provider-health.ts').matchAll(/\{ atFailures: (\d+), intervalMs: ([\d_ *]+?) \}/g)].map((m) => ({ atFailures: Number(m[1]), intervalMs: product(m[2]!) }));
  assert.deepEqual(steps, PROVIDER_BACKOFF_STEPS.map((s) => ({ ...s })));
  assert.match(sources, /ALL_SOURCES[^=]*= \[USGS_SOURCE, EMSC_SOURCE, GFZ_SOURCE\]/);
});

test('one provider: the 2026-10-09 GEOFON blip (about 40 s, at most 110 s as published) is a warning; GFZ at 3 min fails', () => {
  // A 40 s outage: 3 failures 15 s apart, then the 60 s backoff before the poll that clears it, so the streak can read up
  // to 90 s (110 s with slow ticks). Round 24 turned it red whenever USGS was down too; now it is a warning on its own.
  assert.match(evaluateStatus(failingFor({ gfz: 40 }), { nowMs: NOW }).notes[0]!, /^provider gfz is ok:false for 40 s/);
  for (const sec of [60, 90, 110, 179]) {
    const v = evaluateStatus(failingFor({ gfz: sec }), { nowMs: NOW });
    assert.deepEqual(v.problems, [], String(sec));
    assert.equal(v.warnings.length, 1, String(sec));
    assert.match(v.warnings[0]!, /^provider gfz is failing: ok:false for .* \(since .*\), a warning from 60 s, down at 3 min, \d+ consecutive failures, last HTTP 0, last error timeout .*: the other providers still deliver, so alerts still go out \(a quake only gfz reports may come later\)$/);
  }
  assert.match(evaluateStatus(failingFor({ gfz: 59 }), { nowMs: NOW }).notes[0]!, /^provider gfz is ok:false for 59 s \(since .*\), below the warning at 60 s, down at 3 min/);
  const down = evaluateStatus(failingFor({ gfz: 180 }), { nowMs: NOW });
  assert.equal(down.problems.length, 1);
  assert.match(down.problems[0]!, /^provider gfz is down: ok:false for 3 min \(since .*\), limit 3 min for a provider polled every 15 s, 5 consecutive failures/);
});

test('one provider: USGS and the feed fail at 5 min, warn from 1 min; a new id is judged like them', () => {
  for (const id of ['usgs', 'feed']) {
    assert.deepEqual(evaluateStatus(failingFor({ [id]: 299 }), { nowMs: NOW }).problems, [], id);
    assert.match(evaluateStatus(failingFor({ [id]: 299 }), { nowMs: NOW }).warnings[0]!, new RegExp(`^provider ${id} is failing: ok:false for 4\\.5 min`), id);
    const v = evaluateStatus(failingFor({ [id]: 300 }), { nowMs: NOW });
    assert.equal(v.problems.length, 1, id);
    assert.match(v.problems[0]!, new RegExp(`^provider ${id} is down: ok:false for 5 min \\(since .*\\), limit 5 min for a provider polled every 60 s`), id);
    // A USGS streak of 3 (2 min) was red before; now it is a warning: USGS ok:false already means FDSN and the summary feed fail.
    assert.deepEqual(evaluateStatus(failingFor({ [id]: 120 }), { nowMs: NOW }).problems, [], id);
  }
  const doc = structuredClone(HEALTHY);
  doc.detector.providers.push({ id: 'newsource', ok: false, consecutiveFailures: 4, failingSinceMs: GEN - 200_000 });
  assert.match(evaluateStatus(doc, { nowMs: NOW }).warnings[0]!, /^provider newsource is failing: .*down at 5 min/);
});

test('coverage: two of the three direct providers failing together for 2 min fail the run, whichever two', () => {
  for (const [a, b, c] of [['usgs', 'emsc', 'gfz'], ['usgs', 'gfz', 'emsc'], ['emsc', 'gfz', 'usgs']] as const) {
    const v = evaluateStatus(failingFor({ [a]: 150, [b]: 125 }), { nowMs: NOW });
    assert.deepEqual(v.problems, [`two of the three direct providers (${a} and ${b}) have been failing together for 2 min (limit 2 min): one direct source is left (${c}), with the feed backstop`], `${a}+${b}`);
    // Each provider's own line stays a warning (below its own limit) and points at the problem.
    assert.equal(v.warnings.length, 2);
    for (const w of v.warnings) assert.match(w, /: see the direct-provider problem above$/);
    // 119 s together is not yet: a warning per provider, no problem.
    const short = evaluateStatus(failingFor({ [a]: 600, [b]: 119 }), { nowMs: NOW });
    assert.equal(short.problems.length, 1); // only `a`, past its own limit
    assert.match(short.problems[0]!, new RegExp(`^provider ${a} is down`));
    assert.doesNotMatch(short.problems.join(' | '), /two of the three/);
  }
  // The round-24 rule failed EMSC and GFZ at 3 failures each when both blip at once (30 s); a blip of both, even
  // stretched to 90 s by the backoff, is two warnings now.
  const blips = evaluateStatus(failingFor({ emsc: 90, gfz: 90 }), { nowMs: NOW });
  assert.deepEqual(blips.problems, []);
  assert.equal(blips.warnings.length, 2);
  // The pair is the two longest streaks; the third one, failing for less, is named as failing too.
  const three = evaluateStatus(failingFor({ usgs: 30, emsc: 170, gfz: 130 }), { nowMs: NOW });
  assert.deepEqual(three.problems, ['two of the three direct providers (emsc and gfz) have been failing together for 2 min (limit 2 min): one direct source is left (usgs, failing too for 30 s), with the feed backstop']);
});

test('coverage: all three direct providers failing together for 1 min fail the run once (not also as a pair)', () => {
  const v = evaluateStatus(failingFor({ usgs: 65, emsc: 95, gfz: 80 }), { nowMs: NOW });
  assert.deepEqual(v.problems, [
    "all three direct providers (usgs, emsc, gfz) have been failing together for 65 s (limit 60 s): the gateway sees new quakes only through the feed backstop, minutes late; three agencies failing at once points at the gateway's side (its egress, DNS, the Workers runtime or a deploy)",
  ]);
  assert.equal(v.warnings.length, 3);
  // 59 s together: below every rule (each a warning or a note).
  const short = evaluateStatus(failingFor({ usgs: 59, emsc: 100, gfz: 100 }), { nowMs: NOW });
  assert.deepEqual(short.problems, []);
  // All three for 3 min: the all-three line plus EMSC's and GFZ's own limits.
  const long = evaluateStatus(failingFor({ usgs: 200, emsc: 200, gfz: 200 }), { nowMs: NOW });
  assert.equal(long.problems.length, 3);
  assert.match(long.problems[0]!, /^all three direct providers/);
  assert.match(long.problems[1]!, /^provider emsc is down/);
  assert.match(long.problems[2]!, /^provider gfz is down/);
});

test('coverage: the messages say when the feed backstop is failing too (an egress outage takes every source)', () => {
  // Round-25 review: the egress outage that fails all three direct providers fails the backstop too, and the page must
  // not tell the reader that the gateway still sees quakes through it. The verdicts stay as they were.
  const all = evaluateStatus(failingFor({ usgs: 65, emsc: 95, gfz: 80, feed: 65 }), { nowMs: NOW });
  assert.equal(all.problems.length, 1);
  assert.equal(
    all.problems[0],
    "all three direct providers (usgs, emsc, gfz) have been failing together for 65 s (limit 60 s): the feed backstop is failing too for 65 s, so the gateway sees no new quakes at all; every source failing at once points at the gateway's side (its egress, DNS, the Workers runtime or a deploy)",
  );
  const pair = evaluateStatus(failingFor({ emsc: 150, gfz: 125, feed: 30 }), { nowMs: NOW });
  assert.deepEqual(pair.problems, ['two of the three direct providers (emsc and gfz) have been failing together for 2 min (limit 2 min): one direct source is left (usgs); the feed backstop is failing too for 30 s']);
  // ok:false without a published streak is still failing, with no duration to give.
  const bare = failingFor({ emsc: 150, gfz: 125 });
  Object.assign(bare.detector.providers.find((p: { id: string }) => p.id === 'feed'), { ok: false });
  assert.match(evaluateStatus(bare, { nowMs: NOW }).problems[0]!, /: one direct source is left \(usgs\); the feed backstop is failing too$/);
  // A document without the backstop's entry claims nothing about it.
  const none = failingFor({ usgs: 65, emsc: 95, gfz: 80 });
  none.detector.providers = none.detector.providers.filter((p: { id: string }) => p.id !== 'feed');
  assert.match(evaluateStatus(none, { nowMs: NOW }).problems[0]!, /: the gateway sees no new quakes from a direct source \(status\.json lists no feed backstop\); three agencies/);
  const nonePair = failingFor({ emsc: 150, gfz: 125 });
  nonePair.detector.providers = nonePair.detector.providers.filter((p: { id: string }) => p.id !== 'feed');
  assert.match(evaluateStatus(nonePair, { nowMs: NOW }).problems[0]!, /: one direct source is left \(usgs\)$/);
  // The backstop is no direct provider: failing or not, the verdicts are those of the direct providers alone.
  for (const [spec, n] of [[{ usgs: 59, emsc: 100, gfz: 100, feed: 200 }, 0], [{ emsc: 119, gfz: 119, feed: 299 }, 0], [{ emsc: 120, gfz: 120, feed: 10 }, 1]] as const) {
    assert.equal(evaluateStatus(failingFor(spec), { nowMs: NOW }).problems.length, n, JSON.stringify(spec));
  }
});

test('coverage counts direct providers only: the feed backstop, a USGS on its summary fallback and an unknown streak do not', () => {
  // The feed is not a direct provider: EMSC and the feed failing for 2.5 min are two warnings, no coverage problem.
  const feed = evaluateStatus(failingFor({ feed: 150, emsc: 150 }), { nowMs: NOW });
  assert.deepEqual(feed.problems, []);
  assert.equal(feed.warnings.length, 2);
  // USGS ok on its summary fallback (#95) is not failing: EMSC failing beside it stays a warning.
  const doc = failingFor({ emsc: 150 });
  Object.assign(doc.detector.providers[0], { ok: true, consecutiveFailures: 0, fallback: 'summary', primaryConsecutiveFailures: 17, primaryLastError: 'timeout', primaryFailingSinceMs: GEN - 1_320_000 });
  const fb = evaluateStatus(doc, { nowMs: NOW });
  assert.deepEqual(fb.problems, []);
  assert.equal(fb.warnings.length, 2);
  assert.equal(fb.warnings[0], "provider usgs's primary live query has failed 17 times in a row over 22 min, last error timeout (slower than the gateway's fetch timeout): its live events come from the summary feed (fallback: summary), up to about two minutes later (warning at 3)");
  assert.match(fb.warnings[1]!, /^provider emsc is failing/);
  assert.match(fb.summary, /providers=usgs:ok\/primary-FAIL\(17\)\+summary,feed:ok,emsc:FAIL\(\d+\),gfz:ok/);
  // A direct provider ok:false with neither a start nor a count is left out of the coverage rules.
  const unknown = failingFor({ emsc: 300, gfz: 300 });
  Object.assign(unknown.detector.providers[0], { ok: false, consecutiveFailures: undefined });
  const u = evaluateStatus(unknown, { nowMs: NOW });
  assert.match(u.problems[0]!, /^two of the three direct providers \(emsc and gfz\)/);
});

test('an older gateway during the deploy: coverage by count is never earlier than round 24 judged', () => {
  // Round 24 failed EMSC and GFZ at 3 each "together" (30 s); by count they now span 30 s: warnings at most.
  const blip = failingFor({ emsc: [null, { consecutiveFailures: 3 }], gfz: [null, { consecutiveFailures: 3 }], usgs: [null, { consecutiveFailures: 2 }] });
  assert.deepEqual(evaluateStatus(blip, { nowMs: NOW }).problems, []);
  // 5 EMSC and 5 GFZ failures (2.5 min each by count): the pair rule, named as judged by count.
  const pair = evaluateStatus(failingFor({ emsc: [null, { consecutiveFailures: 5 }], gfz: [null, { consecutiveFailures: 5 }] }), { nowMs: NOW });
  assert.deepEqual(pair.problems, ['two of the three direct providers (emsc and gfz) have been failing together for 2.5 min (limit 2 min) (emsc and gfz judged by their failure counts: no failingSinceMs): one direct source is left (usgs), with the feed backstop']);
  // A mixed document (one streak older than the field): each judged by what it has.
  const mixed = evaluateStatus(failingFor({ usgs: [null, { consecutiveFailures: 3 }], emsc: 140 }), { nowMs: NOW });
  assert.deepEqual(mixed.problems, ['two of the three direct providers (emsc and usgs) have been failing together for 2 min (limit 2 min) (usgs judged by its failure count: no failingSinceMs): one direct source is left (gfz), with the feed backstop']);
  // Exhaustively for small counts: whenever the count rule is red now, round 24's rule was red too.
  const round24Red = (n: Record<string, number>): boolean => {
    const down = (id: string) => (n[id] ?? 0) >= 3;
    const together = DIRECT_PROVIDERS.filter(down).length >= 2;
    return Object.entries(n).some(([id, c]) => c >= (isFastProvider(id) ? (together && down(id) ? 3 : 6) : 3));
  };
  for (let u = 0; u <= 7; u++) for (let e = 0; e <= 7; e++) for (let g = 0; g <= 7; g++) {
    const spec: Record<string, [null, Record<string, unknown>]> = {};
    if (u) spec.usgs = [null, { consecutiveFailures: u }];
    if (e) spec.emsc = [null, { consecutiveFailures: e }];
    if (g) spec.gfz = [null, { consecutiveFailures: g }];
    const red = evaluateStatus(failingFor(spec), { nowMs: NOW }).problems.length > 0;
    if (red) assert.ok(round24Red({ usgs: u, emsc: e, gfz: g }), `usgs ${u} emsc ${e} gfz ${g}`);
  }
});

test('provider limits can be set on the command line', () => {
  const t = parseArgs(['--fast-provider-down-sec', '240', '--provider-down-sec', '600', '--two-direct-down-sec', '90', '--all-direct-down-sec', '30', '--provider-warn-sec', '120']).thresholds;
  assert.deepEqual([t.fastProviderDownSec, t.providerDownSec, t.twoDirectDownSec, t.allDirectDownSec, t.providerWarnSec], [240, 600, 90, 30, 120]);
  assert.deepEqual(evaluateStatus(failingFor({ emsc: 200 }), { nowMs: NOW, thresholds: t }).problems, []);
  assert.match(evaluateStatus(failingFor({ emsc: 240 }), { nowMs: NOW, thresholds: t }).problems[0]!, /limit 4 min/);
  assert.match(evaluateStatus(failingFor({ emsc: 100 }), { nowMs: NOW, thresholds: t }).notes[0]!, /below the warning at 2 min, down at 4 min/);
  assert.throws(() => parseArgs(['--provider-down-sec', '-1']), /non-negative number/);
});

test('main: a GFZ blip keeps exit 0 with a warning annotation; EMSC and GFZ down together for 2 min exit 1', async () => {
  const blip = await run({ routes: { [STATUS_URL]: [jsonResponse(failingFor({ gfz: 90 }))] } });
  assert.equal(blip.code, 0);
  assert.doesNotMatch(blip.out, /::error/);
  assert.match(blip.out, /::warning title=Alert pipeline::provider gfz is failing: ok:false for 90 s/);
  assert.match(blip.out, /alert pipeline healthy/);
  const both = await run({ routes: { [STATUS_URL]: [jsonResponse(failingFor({ emsc: 130, gfz: 125 }))] } });
  assert.equal(both.code, 1);
  assert.equal(both.lines.filter((l) => l.startsWith('::error title=Alert pipeline unhealthy::two of the three direct providers (emsc and gfz)')).length, 1);
});
