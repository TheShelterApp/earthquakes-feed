#!/usr/bin/env node
// Free-tier usage alarm (server-content plan of 2026-11-27, guard G11; run by .github/workflows/usage-alarm.yml twice a
// day). It reads the Cloudflare account's usage from the GraphQL Analytics API and fails the run (GitHub emails the
// owner) before a free-tier limit is reached:
//   R2 Class B   month-to-date over 60 % of the monthly allowance, or the linear month-end projection over 80 %
//   R2 Class A   month-to-date over 60 %
//   Workers      requests yesterday (UTC) over 70 % of the daily allowance
//   D1           rows written yesterday (UTC) over 60 % of the daily allowance
// A dataset the plan or the token cannot read fails the run BY NAME; missing data is never read as zero (an empty answer
// counts as missing: this account always has traffic in all three).
//
// The repository is public: the log and the job summary show shares in percent only, never an absolute count, the
// account id or the token (an API error is reduced to its status, never echoed).
//
// Sources (accessed 2026-11-27):
//   R2 operation classes and free tier (Class A 1,000,000 and Class B 10,000,000 a month; HeadObject and GetObject are
//   Class B; DeleteObject, DeleteBucket and AbortMultipartUpload are free): https://developers.cloudflare.com/r2/pricing/
//   R2 dataset r2OperationsAdaptiveGroups (dimensions actionType, bucketName, datetime; sum requests; at most 31 days):
//   https://developers.cloudflare.com/r2/platform/metrics-analytics/
//   Workers dataset workersInvocationsAdaptive (filter datetime_geq / datetime_lt; sum requests):
//   https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
//   D1 dataset d1AnalyticsAdaptiveGroups (filter date_geq / date_leq; sum rowsWritten; dimensions date, databaseId):
//   https://developers.cloudflare.com/d1/observability/metrics-analytics/
//   Workers Free 100,000 requests a day and D1 Free 100,000 rows written a day: https://developers.cloudflare.com/workers/platform/limits/
//   and https://developers.cloudflare.com/d1/platform/limits/ (the platform's own mirror: tests/fixtures/platform-constants.json).
//
//   CF_ANALYTICS_TOKEN=... CF_ACCOUNT_ID=... node scripts/usage-alarm.mjs
//   node scripts/usage-alarm.mjs --file <fixture.json> [--now <ISO time>]   (no network; tests/usage-alarm.test.ts)
//
// Exit codes: 0 within the lines · 1 a line crossed · 3 a dataset unavailable, or the alarm itself misconfigured.
// Dependency-free (Node >= 22, global fetch).

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/** R2 free tier, operations a month. */
export const R2_CLASS_A_LIMIT = 1_000_000;
export const R2_CLASS_B_LIMIT = 10_000_000;
/** Workers Free requests a day; D1 Free rows written a day. */
export const WORKERS_DAILY_LIMIT = 100_000;
export const D1_ROWS_WRITTEN_DAILY_LIMIT = 100_000;

/** The alarm lines. Class B's projection line is 80 % of the month's allowance. */
export const CLASS_B_SHARE_LINE = 0.6;
export const CLASS_B_PROJECTION_LINE = 0.8;
export const CLASS_A_SHARE_LINE = 0.6;
export const WORKERS_REQUESTS_LINE = 70_000;
export const D1_ROWS_WRITTEN_LINE = 60_000;
/** The projection is not judged before this much of the month has passed (day 1's partial data swings it). */
export const MIN_PROJECTION_DAYS = 1;

/** R2 operation names by billing class (pricing page). Any other name (the free ones) counts toward neither. */
export const CLASS_A_ACTIONS = Object.freeze([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
  'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption',
  'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);
export const CLASS_B_ACTIONS = Object.freeze([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);

/** Dataset names, as the messages name them. */
export const DATASETS = Object.freeze({
  r2: 'r2OperationsAdaptiveGroups',
  workers: 'workersInvocationsAdaptive',
  d1: 'd1AnalyticsAdaptiveGroups',
});

/** What to do when it fires, in this order (the plan's switch order; core is never switched off by this alarm). */
export const ACTION_ORDER = Object.freeze([
  'remove `learn` from ios-config (the signed config\'s content list)',
  'switch the `quiz_compare` flag off',
  'core is never switched off by this alarm',
]);

const DAY_MS = 86_400_000;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (x) => `${Math.round(x * 1000) / 10} %`;

/** UTC month start, next month start and today's start of `nowMs`. */
export function periods(nowMs) {
  const n = new Date(nowMs);
  const y = n.getUTCFullYear();
  const m = n.getUTCMonth();
  const monthStart = Date.UTC(y, m, 1);
  const nextMonth = Date.UTC(y, m + 1, 1);
  const todayStart = Date.UTC(y, m, n.getUTCDate());
  return { monthStart, nextMonth, todayStart, yesterdayStart: todayStart - DAY_MS };
}

const dateOnly = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The three GraphQL requests (query text, variables). `accountTag` goes in a variable, never into the text. */
export function buildRequests(accountTag, nowMs) {
  const p = periods(nowMs);
  const iso = (ms) => new Date(ms).toISOString();
  return {
    r2: {
      query: `query R2Month($accountTag: string!, $start: Time, $end: Time) { viewer { accounts(filter: { accountTag: $accountTag }) { r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { requests } dimensions { actionType } } } } }`,
      variables: { accountTag, start: iso(p.monthStart), end: iso(nowMs) },
    },
    workers: {
      query: `query WorkersDay($accountTag: string!, $start: Time, $end: Time) { viewer { accounts(filter: { accountTag: $accountTag }) { workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { requests } dimensions { scriptName } } } } }`,
      variables: { accountTag, start: iso(p.yesterdayStart), end: iso(p.todayStart) },
    },
    d1: {
      query: `query D1Day($accountTag: string!, $day: Date) { viewer { accounts(filter: { accountTag: $accountTag }) { d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $day, date_leq: $day }) { sum { rowsWritten } dimensions { databaseId } } } } }`,
      variables: { accountTag, day: dateOnly(p.yesterdayStart) },
    },
  };
}

/**
 * The rows of one dataset from a GraphQL response body, or an `unavailable` reason (no secrets in it): an errors array,
 * no account, a null or missing dataset, or no rows at all.
 */
export function datasetRows(body, dataset) {
  if (!isObject(body)) return { unavailable: 'no readable answer' };
  if (Array.isArray(body.errors) && body.errors.length > 0) return { unavailable: 'the API refused the query (plan, token permission or schema)' };
  const accounts = body.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return { unavailable: 'the account is not visible to the token' };
  const rows = accounts[0]?.[dataset];
  if (!Array.isArray(rows)) return { unavailable: 'the dataset is missing from the answer' };
  if (rows.length === 0) return { unavailable: 'the dataset returned no rows' };
  return { rows };
}

/** The sum of `sum.<field>` over rows; null when any row lacks a finite number (a partial read is no read). */
function sumField(rows, field) {
  let total = 0;
  for (const r of rows) {
    const v = r?.sum?.[field];
    if (!isNum(v)) return null;
    total += v;
  }
  return total;
}

/** Month-to-date Class A and Class B requests from r2OperationsAdaptiveGroups rows (summed over every bucket). */
export function r2Classes(rows) {
  let a = 0;
  let b = 0;
  for (const r of rows) {
    const n = r?.sum?.requests;
    const name = r?.dimensions?.actionType;
    if (!isNum(n) || typeof name !== 'string') return null;
    if (CLASS_A_ACTIONS.includes(name)) a += n;
    else if (CLASS_B_ACTIONS.includes(name)) b += n;
  }
  return { a, b };
}

/**
 * Judge the three answers. `answers` is { r2, workers, d1 }, each a GraphQL response body. Returns
 * { lines, failures, unavailable, exitCode }; lines carry shares only.
 */
export function evaluate(answers, nowMs) {
  const p = periods(nowMs);
  const lines = [];
  const failures = [];
  const unavailable = [];

  const r2 = datasetRows(answers.r2, DATASETS.r2);
  const classes = r2.rows ? r2Classes(r2.rows) : null;
  if (!classes) unavailable.push(`${DATASETS.r2}: ${r2.unavailable ?? 'rows without a request count or action name'}`);
  else {
    const elapsedDays = (nowMs - p.monthStart) / DAY_MS;
    const monthDays = (p.nextMonth - p.monthStart) / DAY_MS;
    const bShare = classes.b / R2_CLASS_B_LIMIT;
    const aShare = classes.a / R2_CLASS_A_LIMIT;
    lines.push(`R2 Class B, month to date: ${pct(bShare)} of the free tier (alarm at ${pct(CLASS_B_SHARE_LINE)})`);
    if (bShare > CLASS_B_SHARE_LINE) failures.push(`R2 Class B is at ${pct(bShare)} of the monthly free tier (line ${pct(CLASS_B_SHARE_LINE)})`);
    if (elapsedDays >= MIN_PROJECTION_DAYS) {
      const projection = (bShare * monthDays) / elapsedDays;
      lines.push(`R2 Class B, month-end projection: ${pct(projection)} (alarm at ${pct(CLASS_B_PROJECTION_LINE)})`);
      if (projection > CLASS_B_PROJECTION_LINE) failures.push(`R2 Class B projects to ${pct(projection)} of the monthly free tier by month end (line ${pct(CLASS_B_PROJECTION_LINE)})`);
    } else lines.push(`R2 Class B, month-end projection: not judged before day ${MIN_PROJECTION_DAYS + 1} of the month`);
    lines.push(`R2 Class A, month to date: ${pct(aShare)} of the free tier (alarm at ${pct(CLASS_A_SHARE_LINE)})`);
    if (aShare > CLASS_A_SHARE_LINE) failures.push(`R2 Class A is at ${pct(aShare)} of the monthly free tier (line ${pct(CLASS_A_SHARE_LINE)})`);
  }

  const w = datasetRows(answers.workers, DATASETS.workers);
  const wTotal = w.rows ? sumField(w.rows, 'requests') : null;
  if (wTotal === null) unavailable.push(`${DATASETS.workers}: ${w.unavailable ?? 'rows without a request count'}`);
  else {
    const share = wTotal / WORKERS_DAILY_LIMIT;
    const line = WORKERS_REQUESTS_LINE / WORKERS_DAILY_LIMIT;
    lines.push(`Workers requests, yesterday: ${pct(share)} of the daily free tier (alarm at ${pct(line)})`);
    if (wTotal > WORKERS_REQUESTS_LINE) failures.push(`Workers requests were at ${pct(share)} of the daily free tier yesterday (line ${pct(line)})`);
  }

  const d = datasetRows(answers.d1, DATASETS.d1);
  const dTotal = d.rows ? sumField(d.rows, 'rowsWritten') : null;
  if (dTotal === null) unavailable.push(`${DATASETS.d1}: ${d.unavailable ?? 'rows without a rowsWritten count'}`);
  else {
    const share = dTotal / D1_ROWS_WRITTEN_DAILY_LIMIT;
    const line = D1_ROWS_WRITTEN_LINE / D1_ROWS_WRITTEN_DAILY_LIMIT;
    lines.push(`D1 rows written, yesterday: ${pct(share)} of the daily free tier (alarm at ${pct(line)})`);
    if (dTotal > D1_ROWS_WRITTEN_LINE) failures.push(`D1 rows written were at ${pct(share)} of the daily free tier yesterday (line ${pct(line)})`);
  }

  return { lines, failures, unavailable, exitCode: failures.length > 0 ? 1 : unavailable.length > 0 ? 3 : 0 };
}

/** One GraphQL request; the answer body, or { errors } with a status-only reason (never the response text). */
async function query(fetchImpl, token, req) {
  try {
    const res = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) return { errors: [{ message: `HTTP ${res.status}` }] };
    return await res.json();
  } catch {
    return { errors: [{ message: 'request failed' }] };
  }
}

export function parseArgs(argv) {
  const opts = { file: null, now: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '--now') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = fetch, now = () => Date.now(), log = console.log, summaryPath = env.GITHUB_STEP_SUMMARY } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    log(`::error title=usage alarm::${e.message}`);
    return 3;
  }
  const nowMs = opts.now ? Date.parse(opts.now) : now();
  if (!isNum(nowMs)) {
    log('::error title=usage alarm::--now is not a time');
    return 3;
  }
  let answers;
  if (opts.file) {
    try {
      answers = JSON.parse(readFileSync(opts.file, 'utf8'));
    } catch {
      log('::error title=usage alarm::the fixture file cannot be read');
      return 3;
    }
  } else {
    const token = env.CF_ANALYTICS_TOKEN;
    const account = env.CF_ACCOUNT_ID;
    if (!token || !account) {
      log(`::error title=usage alarm::${!token ? 'CF_ANALYTICS_TOKEN' : 'CF_ACCOUNT_ID (the repository variable CF_ANALYTICS_ACCOUNT_ID)'} is not set: the alarm cannot run`);
      return 3;
    }
    const reqs = buildRequests(account, nowMs);
    answers = {};
    for (const k of Object.keys(reqs)) answers[k] = await query(fetchImpl, token, reqs[k]);
  }
  const r = evaluate(answers ?? {}, nowMs);
  const out = ['Free-tier usage (shares of the free tier, percent only)', ...r.lines.map((l) => `- ${l}`)];
  for (const f of r.failures) out.push(`FAILED: ${f}`);
  for (const u of r.unavailable) out.push(`UNAVAILABLE: ${u}`);
  if (r.failures.length > 0) {
    out.push('Action order:');
    ACTION_ORDER.forEach((s, i) => out.push(`  ${i + 1}. ${s}`));
  }
  for (const l of out) log(l);
  for (const f of r.failures) log(`::error title=free-tier usage::${f}`);
  for (const u of r.unavailable) log(`::error title=usage dataset unavailable::${u}`);
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `## Free-tier usage\n\n${out.map((l) => (l.startsWith('- ') || l.startsWith('  ') ? l : `${l}\n`)).join('\n')}\n`);
    } catch {
      // The log has the same lines.
    }
  }
  return r.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
