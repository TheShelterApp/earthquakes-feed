#!/usr/bin/env node
// Alert-pipeline watchdog for The Shelter's alerts-gateway (run by .github/workflows/health.yml).
//
// It lives here, in GitHub Actions, on purpose: it must keep working when Cloudflare (where the gateway
// runs) does not, and GitHub's "failed workflow" email is its only alarm channel. The gateway's detector
// publishes the public, no-store document https://data.theshelter.app/alerts/status.json once a minute
// from its tick; this script reads it and exits non-zero when:
//   - generatedAtMs is older than 300 s (the detector stopped ticking or cannot publish),
//   - a detector provider is ok:false with consecutiveFailures >= 3,
//   - policy.fallback is true (the restrictive compiled policy runs instead of the signed one),
//   - degraded.active is true (the free-tier degradation ladder is shedding alert tiers),
//   - budget.headroomPct is below 20 (checked only when present),
//   - apns.configured is false (fan-outs run DRY: nothing reaches a phone).
// Optional usage half: when CF_ANALYTICS_TOKEN (Account Analytics: Read) is set, it also reads today's
// (UTC) account-wide Workers requests and D1 rows written from the GraphQL Analytics API and fails at 80 %
// of the Workers Free daily caps (100,000 each; at 100 % every Worker on the account fails closed until
// 00:00 UTC). Without the token that half is skipped silently.
//
// Exit codes: 0 healthy · 1 unhealthy (a confirmed problem) · 2 status.json unreadable after retries (the
// pipeline state is UNKNOWN; not a confirmed pipeline failure) · 3 the watchdog itself is misconfigured
// (bad argument, token without an account id, token rejected).
//
//   node scripts/alerts-watchdog.mjs                        # the CI invocation
//   node scripts/alerts-watchdog.mjs --selftest             # forces a failing headroom limit (proves the red path)
//   node scripts/alerts-watchdog.mjs --status-file doc.json # judge a saved document instead of fetching
//   flags: --url <url> --max-age-sec <n> --provider-failures <n> --min-headroom-pct <n> --usage-fail-pct <n>
//
// Dependency-free (Node >= 22, global fetch). The pure helpers are exported for
// tests/alerts-watchdog.test.ts, which never touches the network.

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const STATUS_URL = 'https://data.theshelter.app/alerts/status.json';
export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

export const DEFAULT_THRESHOLDS = Object.freeze({
  /** status.json older than this fails (the detector publishes every 60 s). */
  maxAgeSec: 300,
  /** a provider with ok:false fails once its consecutive-failure streak reaches this. */
  providerFailures: 3,
  /** budget.headroomPct below this fails. */
  minHeadroomPct: 20,
  /** account usage at or above this share (percent) of a Free daily cap fails. */
  usageFailPct: 80,
});

/** Workers Free daily caps (account-wide, reset 00:00 UTC). */
export const FREE_TIER_DAILY = Object.freeze({ workersRequests: 100_000, d1RowsWritten: 100_000 });

/** The selftest forces an impossible headroom limit so a healthy document must fail. */
export const SELFTEST_MIN_HEADROOM_PCT = 101;

const DAY_MS = 86_400_000;
const STATUS_BACKOFF_MS = [2_000, 5_000];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const errMsg = (e) => {
  if (!(e instanceof Error)) return String(e);
  // undici's "fetch failed" hides the useful part (ENOTFOUND, ECONNRESET, ...) in `cause`.
  const cause = e.cause;
  const detail = isObject(cause) ? (cause.code ?? cause.message) : undefined;
  return detail ? `${e.message} (${String(detail)})` : e.message;
};
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Judge a parsed status.json. Pure: `nowMs` is injected.
 * @returns {{ problems: string[], warnings: string[], notes: string[], summary: string }}
 *   problems fail the run; warnings become ::warning:: annotations; notes are log lines only.
 */
export function evaluateStatus(doc, { nowMs, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const problems = [];
  const warnings = [];
  const notes = [];
  if (!isNum(nowMs)) throw new TypeError('evaluateStatus: nowMs is required');
  if (!isObject(doc)) {
    return { problems: ['status.json is not a JSON object'], warnings, notes, summary: 'not a JSON object' };
  }
  const parts = [];

  // 1. Freshness: the primary signal. The detector publishes from its tick, so a stale document means the
  //    detector is not ticking (or its R2 put keeps failing), whatever the rest of the document says.
  if (!isNum(doc.generatedAtMs)) {
    problems.push('generatedAtMs is missing or not a number: freshness cannot be judged');
    parts.push('age=?');
  } else {
    const ageSec = Math.round((nowMs - doc.generatedAtMs) / 1000);
    parts.push(`age=${ageSec}s`);
    if (ageSec > t.maxAgeSec) {
      problems.push(`status.json is ${ageSec} s old (limit ${t.maxAgeSec} s): the detector has stopped publishing, so alerts are not being detected`);
    } else if (ageSec < -t.maxAgeSec) {
      warnings.push(`generatedAtMs is ${-ageSec} s in the future: clock skew between the gateway and the runner?`);
    }
  }

  // 2. Providers: a single failed poll is normal (backoff handles it); a streak is an outage of that source.
  const providers = isObject(doc.detector) ? doc.detector.providers : undefined;
  if (!Array.isArray(providers)) {
    problems.push('detector.providers is missing: provider health cannot be judged');
    parts.push('providers=?');
  } else {
    if (providers.length === 0) warnings.push('detector.providers is empty: no alert source is being polled');
    const tags = [];
    for (const p of providers) {
      if (!isObject(p)) continue;
      const id = typeof p.id === 'string' ? p.id : '?';
      const fails = isNum(p.consecutiveFailures) ? p.consecutiveFailures : null;
      tags.push(`${id}:${p.ok === false ? `FAIL(${fails ?? '?'})` : 'ok'}`);
      if (p.ok !== false) continue;
      const http = isNum(p.httpStatus) ? `, last HTTP ${p.httpStatus}` : '';
      if (fails !== null && fails >= t.providerFailures) {
        problems.push(`provider ${id} is down: ok:false with ${fails} consecutive failures (limit ${t.providerFailures})${http}`);
      } else {
        notes.push(`provider ${id} is ok:false with ${fails ?? 'an unknown number of'} consecutive failures (below the limit of ${t.providerFailures})${http}`);
      }
    }
    parts.push(`providers=${tags.join(',') || 'none'}`);
  }

  // 3. Policy: the compiled fallback is deliberately restrictive; a silent revert (e.g. an expired signed
  //    policy) changes who gets alerted.
  const policy = doc.policy;
  if (isObject(policy)) {
    const version = isNum(policy.version) ? `v${policy.version}` : 'v?';
    parts.push(`policy=${String(policy.source ?? '?')}/${version}${policy.fallback === true ? '/FALLBACK' : ''}`);
    if (policy.fallback === true || policy.source === 'fallback') {
      problems.push(`the gateway runs the compiled FALLBACK alerts policy (${version}, reason: ${String(policy.reason ?? 'unknown')}): the signed policy is not live`);
    }
  } else {
    parts.push('policy=?');
    warnings.push('policy is absent: cannot tell whether the signed alerts policy is live');
  }

  // 4. Degradation ladder: active means alert tiers are being shed to stay inside the free tier.
  const degraded = doc.degraded;
  if (isObject(degraded)) {
    parts.push(`degraded=${String(degraded.level ?? '?')}`);
    if (degraded.active === true) {
      const why = degraded.forced === true ? 'a forced override' : `reason: ${String(degraded.reason ?? 'unknown')}`;
      problems.push(`the gateway is DEGRADED (level ${String(degraded.level ?? '?')}, ${why}): some alert tiers are not being sent`);
    }
  } else {
    parts.push('degraded=?');
    warnings.push('degraded is absent: cannot tell whether the degradation ladder is active');
  }

  // 5. Free-tier headroom against the tightest gateway resource (only when the document carries it).
  const headroom = isObject(doc.budget) ? doc.budget.headroomPct : undefined;
  if (isNum(headroom)) {
    parts.push(`headroom=${headroom}%`);
    if (headroom < t.minHeadroomPct) {
      problems.push(`free-tier headroom is ${headroom} % (limit ${t.minHeadroomPct} %): the gateway is close to a Workers Free daily cap and will start shedding alerts`);
    }
  } else {
    parts.push('headroom=n/a');
  }

  // 6. APNs: configured:false means DRY mode; every fan-out "succeeds" and nothing is delivered.
  const apns = doc.apns;
  if (isObject(apns) && typeof apns.configured === 'boolean') {
    parts.push(`apns=${apns.configured ? 'configured' : 'DRY'}`);
    if (!apns.configured) {
      problems.push('APNs is NOT configured on the gateway: fan-outs run DRY and no push reaches a device');
    }
  } else {
    parts.push('apns=?');
    warnings.push('apns.configured is absent: cannot tell whether real pushes are being sent');
  }

  if (isObject(doc.budget) && typeof doc.budget.day === 'string') parts.push(`budget-day=${doc.budget.day}`);
  return { problems, warnings, notes, summary: parts.join(' ') };
}

async function fetchOnce(url, init, fetchImpl, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      return { ok: false, kind: 'http', status: res.status, retryable, message: `HTTP ${res.status}`, body: text.slice(0, 500) };
    }
    try {
      return { ok: true, status: res.status, json: JSON.parse(text) };
    } catch (e) {
      // A truncated body parses as garbage too, so this is retried like a network error.
      return { ok: false, kind: 'parse', status: res.status, retryable: true, message: `invalid JSON (${errMsg(e)})` };
    }
  } catch (e) {
    const message = ctrl.signal.aborted ? `timed out after ${timeoutMs} ms` : `network error: ${errMsg(e)}`;
    return { ok: false, kind: 'network', retryable: true, message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET/POST with a per-attempt timeout and bounded retries (network errors, 5xx/408/429 and unparseable
 * bodies are retried; other 4xx are not). Never throws.
 */
export async function fetchJson(url, { init = {}, fetchImpl = globalThis.fetch, attempts = 3, backoffMs = STATUS_BACKOFF_MS, timeoutMs = 15_000, sleep = sleepMs } = {}) {
  let result = { ok: false, kind: 'network', retryable: false, message: 'not attempted' };
  let attempt = 0;
  while (attempt < attempts) {
    if (attempt > 0) await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
    attempt += 1;
    result = await fetchOnce(url, init, fetchImpl, timeoutMs);
    if (result.ok || !result.retryable) break;
  }
  return { ...result, attempts: attempt };
}

// ---------------------------------------------------------------------------------------------------------
// Usage half (optional): account-wide Workers requests + D1 rows written today, via GraphQL Analytics.

export const USAGE_QUERY = `query ShelterFreeTierUsage($accountTag: string!, $datetimeStart: string, $datetimeEnd: string, $date: Date) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd }) {
        sum { requests }
        dimensions { scriptName }
      }
      d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date }) {
        sum { rowsWritten }
        dimensions { databaseId }
      }
    }
  }
}`;

/** The current UTC day: its date, its start, now, and the elapsed share of the day (>= 1 minute). */
export function usageWindow(nowMs) {
  const dayStartMs = nowMs - (nowMs % DAY_MS);
  return {
    date: new Date(dayStartMs).toISOString().slice(0, 10),
    datetimeStart: new Date(dayStartMs).toISOString(),
    datetimeEnd: new Date(nowMs).toISOString(),
    dayFraction: Math.max(1 / 1440, (nowMs - dayStartMs) / DAY_MS),
  };
}

export function buildUsageRequest(accountTag, nowMs) {
  const w = usageWindow(nowMs);
  return { query: USAGE_QUERY, variables: { accountTag, datetimeStart: w.datetimeStart, datetimeEnd: w.datetimeEnd, date: w.date } };
}

const AUTH_RE = /authz|authn|not authori[sz]ed|unauthori[sz]ed|forbidden|permission|authentication/i;

/**
 * Parse a GraphQL Analytics response for USAGE_QUERY.
 * Only account totals come out: the run logs of this public repository must not list Worker or database names.
 * @returns {{ ok: true, workersRequests: number, d1RowsWritten: number }
 *   | { ok: false, kind: 'auth' | 'graphql' | 'shape', message: string }}
 */
export function parseUsageResponse(json) {
  if (!isObject(json)) return { ok: false, kind: 'shape', message: 'the response is not a JSON object' };
  const errors = Array.isArray(json.errors) ? json.errors.filter(isObject) : [];
  if (errors.length > 0) {
    const message = errors.map((e) => String(e.message ?? 'unknown error')).join('; ').slice(0, 500);
    const auth = errors.some((e) => AUTH_RE.test(String(e.message ?? '')) || AUTH_RE.test(String(isObject(e.extensions) ? e.extensions.code ?? '' : '')));
    return { ok: false, kind: auth ? 'auth' : 'graphql', message };
  }
  const viewer = isObject(json.data) ? json.data.viewer : undefined;
  const accounts = isObject(viewer) ? viewer.accounts : undefined;
  if (!Array.isArray(accounts)) return { ok: false, kind: 'shape', message: 'data.viewer.accounts is missing' };
  if (accounts.length === 0) {
    return { ok: false, kind: 'auth', message: 'the token cannot see this account (viewer.accounts is empty): wrong account id, or the token lacks Account Analytics: Read' };
  }
  const account = accounts[0];
  if (!isObject(account) || !Array.isArray(account.workers) || !Array.isArray(account.d1)) {
    return { ok: false, kind: 'shape', message: 'the account has no workers/d1 groups in the response' };
  }
  let workersRequests = 0;
  for (const g of account.workers) {
    const n = isObject(g) && isObject(g.sum) ? g.sum.requests : undefined;
    if (!isNum(n)) return { ok: false, kind: 'shape', message: 'a workers group has no numeric sum.requests' };
    workersRequests += n;
  }
  let d1RowsWritten = 0;
  for (const g of account.d1) {
    const n = isObject(g) && isObject(g.sum) ? g.sum.rowsWritten : undefined;
    if (!isNum(n)) return { ok: false, kind: 'shape', message: 'a d1 group has no numeric sum.rowsWritten' };
    d1RowsWritten += n;
  }
  return { ok: true, workersRequests, d1RowsWritten };
}

/**
 * Judge today's usage against the Free caps. Fails on the ACTUAL usage so far (a linear projection early in
 * the UTC day is too noisy to page on); the projection is logged for context.
 */
export function evaluateUsage(usage, { dayFraction, failPct = DEFAULT_THRESHOLDS.usageFailPct, caps = FREE_TIER_DAILY }) {
  const problems = [];
  const rows = [
    ['Workers requests', usage.workersRequests, caps.workersRequests, 'every Worker on the account (api, config, alerts-gateway) starts failing'],
    ['D1 rows written', usage.d1RowsWritten, caps.d1RowsWritten, 'every D1 write on the account (sign-in, device registration, reports) starts failing'],
  ];
  const parts = [];
  for (const [label, used, cap, consequence] of rows) {
    const share = (used / cap) * 100;
    const projected = Math.round(used / dayFraction);
    parts.push(`${label} ${used}/${cap} (${share.toFixed(1)} %, projected ${projected}/day)`);
    if (share >= failPct) {
      problems.push(`account ${label} today: ${used} = ${share.toFixed(1)} % of the Workers Free cap (${cap}/day; limit ${failPct} %). At 100 % ${consequence} until 00:00 UTC`);
    }
  }
  return { problems, summary: parts.join(' · ') };
}

/**
 * Query the usage. Never throws.
 * @returns {Promise<ReturnType<typeof parseUsageResponse>>}
 */
export async function fetchUsage({ token, accountTag, nowMs, fetchImpl = globalThis.fetch, sleep = sleepMs }) {
  const r = await fetchJson(GRAPHQL_URL, {
    init: {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(buildUsageRequest(accountTag, nowMs)),
    },
    fetchImpl,
    sleep,
    timeoutMs: 20_000,
  });
  if (r.ok) return parseUsageResponse(r.json);
  if (r.kind === 'http' && (r.status === 401 || r.status === 403)) {
    return { ok: false, kind: 'auth', message: `HTTP ${r.status}: the token was rejected` };
  }
  return { ok: false, kind: 'graphql', message: `${r.message} after ${r.attempts} attempt(s)` };
}

// ---------------------------------------------------------------------------------------------------------
// CLI

/** A GitHub Actions workflow command (annotation), with the documented escaping. */
export function annotation(level, title, message) {
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return `::${level} title=${escProp(title)}::${esc(message)}`;
}

const NUMERIC_FLAGS = {
  '--max-age-sec': 'maxAgeSec',
  '--provider-failures': 'providerFailures',
  '--min-headroom-pct': 'minHeadroomPct',
  '--usage-fail-pct': 'usageFailPct',
};

/** Parse argv + env into options; throws an Error with a readable message on a bad argument. */
export function parseArgs(argv, env = {}) {
  const opts = { url: STATUS_URL, statusFile: null, selftest: env.WATCHDOG_SELFTEST === '1' || env.WATCHDOG_SELFTEST === 'true', thresholds: { ...DEFAULT_THRESHOLDS } };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') {
      opts.selftest = true;
      continue;
    }
    const value = argv[i + 1];
    if (a === '--url' || a === '--status-file' || Object.hasOwn(NUMERIC_FLAGS, a)) {
      if (value === undefined || value.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      if (a === '--url') opts.url = value;
      else if (a === '--status-file') opts.statusFile = value;
      else {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) throw new Error(`${a} must be a non-negative number, got ${JSON.stringify(value)}`);
        opts.thresholds[NUMERIC_FLAGS[a]] = n;
      }
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (opts.selftest) opts.thresholds.minHeadroomPct = SELFTEST_MIN_HEADROOM_PCT;
  return opts;
}

/**
 * Run the watchdog. Everything with a side effect is injectable so tests stay offline.
 * @returns {Promise<number>} the exit code
 */
export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console.log, sleep = sleepMs, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const summaryLines = ['### Alert-pipeline watchdog', ''];
  const finish = (code) => {
    if (env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(env.GITHUB_STEP_SUMMARY, `${summaryLines.join('\n')}\n`);
      } catch (e) {
        log(annotation('warning', 'Alert watchdog', `could not write the step summary: ${errMsg(e)}`));
      }
    }
    return code;
  };

  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    log(annotation('error', 'Alert watchdog misconfigured', errMsg(e)));
    summaryLines.push(`- misconfigured: ${errMsg(e)}`);
    return finish(3);
  }
  const tag = opts.selftest ? '[selftest] ' : '';
  if (opts.selftest) {
    log(annotation('notice', 'Alert watchdog selftest', `the headroom limit is forced to ${SELFTEST_MIN_HEADROOM_PCT} %, so this run MUST fail with a headroom problem; any other outcome means the red path is broken`));
  }

  let unhealthy = false;
  let unreadable = false;
  let misconfigured = false;

  // --- status.json ---
  let doc = null;
  if (opts.statusFile) {
    try {
      doc = JSON.parse(readFile(opts.statusFile));
    } catch (e) {
      log(annotation('error', 'Alert watchdog could not read status.json', `${opts.statusFile}: ${errMsg(e)}`));
      unreadable = true;
    }
  } else {
    const r = await fetchJson(opts.url, { init: { headers: { 'cache-control': 'no-cache', accept: 'application/json' } }, fetchImpl, sleep });
    if (r.ok) {
      doc = r.json;
    } else {
      unreadable = true;
      const what = r.kind === 'network' ? 'network error' : r.kind === 'parse' ? 'unparseable body' : `HTTP ${r.status}`;
      // A deterministic 4xx is not a flaky network: the object is gone or something (WAF, bucket domain) hides it.
      const hint = r.kind === 'http' && !r.retryable
        ? 'The document is missing or blocked: the gateway may have stopped publishing it, or a zone/bucket change hides it.'
        : 'This is a network or edge problem between GitHub and data.theshelter.app, not a confirmed pipeline failure.';
      log(annotation('error', `Alert watchdog could not read status.json (${what})`,
        `${r.message} after ${r.attempts} attempt(s) from ${opts.url}. The alert pipeline state is UNKNOWN. ${hint} If it repeats on the next runs, check the alerts-gateway in the Cloudflare dashboard.`));
      summaryLines.push(`- status.json: **UNREADABLE** (${r.message}, ${r.attempts} attempt(s))`);
    }
  }
  if (doc !== null) {
    const verdict = evaluateStatus(doc, { nowMs: now(), thresholds: opts.thresholds });
    log(`alerts status: ${verdict.summary}`);
    for (const n of verdict.notes) log(`note: ${n}`);
    for (const w of verdict.warnings) log(annotation('warning', 'Alert pipeline', w));
    for (const p of verdict.problems) log(annotation('error', `${tag}Alert pipeline unhealthy`, p));
    if (verdict.problems.length > 0) unhealthy = true;
    summaryLines.push(`- status.json: ${verdict.problems.length > 0 ? `**UNHEALTHY** (${verdict.problems.length} problem(s))` : 'healthy'} · \`${verdict.summary}\``);
    for (const p of verdict.problems) summaryLines.push(`  - ${p}`);
  }

  // --- optional account usage ---
  const token = env.CF_ANALYTICS_TOKEN;
  if (!token) {
    summaryLines.push('- account usage: skipped (no CF_ANALYTICS_TOKEN)');
  } else if (!env.CF_ACCOUNT_ID) {
    misconfigured = true;
    log(annotation('error', 'Alert watchdog misconfigured', 'CF_ANALYTICS_TOKEN is set but CF_ACCOUNT_ID is empty: the usage check cannot run'));
    summaryLines.push('- account usage: **misconfigured** (no account id)');
  } else {
    const nowMs = now();
    const u = await fetchUsage({ token, accountTag: env.CF_ACCOUNT_ID, nowMs, fetchImpl, sleep });
    if (u.ok) {
      const verdict = evaluateUsage(u, { dayFraction: usageWindow(nowMs).dayFraction, failPct: opts.thresholds.usageFailPct });
      log(`account usage today (UTC): ${verdict.summary}`);
      for (const p of verdict.problems) log(annotation('error', 'Cloudflare free-tier usage high', p));
      if (verdict.problems.length > 0) unhealthy = true;
      summaryLines.push(`- account usage: ${verdict.problems.length > 0 ? `**OVER the ${opts.thresholds.usageFailPct} % line**` : 'ok'} · ${verdict.summary}`);
    } else if (u.kind === 'auth') {
      misconfigured = true;
      log(annotation('error', 'Alert watchdog misconfigured', `the usage check was refused: ${u.message}. Fix or remove the CF_ANALYTICS_TOKEN secret.`));
      summaryLines.push(`- account usage: **refused** (${u.message})`);
    } else {
      // Transient analytics trouble must not page anyone: the status.json half above is the primary signal.
      log(annotation('warning', 'Cloudflare usage unavailable', `${u.message} (the usage half is skipped for this run)`));
      summaryLines.push(`- account usage: unavailable (${u.message})`);
    }
  }

  if (unhealthy) return finish(1);
  if (unreadable) return finish(2);
  if (misconfigured) return finish(3);
  log(`${tag}alert pipeline healthy`);
  return finish(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(annotation('error', 'Alert watchdog crashed', errMsg(e)));
      process.exitCode = 3;
    },
  );
}
