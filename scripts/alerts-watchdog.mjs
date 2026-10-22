#!/usr/bin/env node
// Alert-pipeline evaluator for The Shelter's alerts-gateway (a findings evaluator since the alerting plan of 2026-10-22,
// section 3a; run by .github/workflows/health.yml every 15 min).
//
// It lives here, in GitHub Actions, on purpose: it must keep working when Cloudflare (where the gateway runs) does not.
// The gateway's detector publishes the public, no-store document https://data.theshelter.app/alerts/status.json once a
// minute from its tick; this script judges it as findings (scripts/lib/findings.mjs; every line comes from RULES): one
// finding per board row of "[health] alert pipeline", with the rule that judged it and the severity before the holds
// of scripts/reconcile.mjs. A condition below its line is a P4 sample (it keeps an open row open and counts toward
// "4 of the last 8 runs"); a condition that is fully clear emits nothing.
//
// The document gate, in this order:
//   unreadable   the fetch failed, the body is no JSON object, generatedAtMs is no number or detector.providers is no
//                list: only alerts:status:unreadable (P2; reconcile shows P4 on the first run), and alerts:* unjudged
//   stale        generatedAtMs older than 300 s: only alerts:status:stale (P1), and alerts:* unjudged (a stale
//                document's fields are old: nothing else enters or resolves on it)
//   fresh        every rule below, judged as of generatedAtMs (a streak does not grow while the document waits)
// The rules of a fresh document:
//   alerts:coverage:all / :two   all three direct providers (usgs, emsc, gfz) ok:false together for 60 s: P1; two or
//                                more together for 180 s: P2; P4 while two or more fail below those lines
//   alerts:provider:<id>         one provider's streak: emsc and gfz 60 min (15 min while lastError is invalid), usgs
//                                and the feed backstop 30 min: P3 (a single provider never turns a run red). A direct
//                                provider missing from detector.providers (all three when the list is empty) is not
//                                polled: P3 alerts:provider:unlisted, and the coverage rows count it as failing
//   alerts:usgs:primary          ComCat FDSN failing for 6 h while the summary feed serves: P3
//   alerts:usgs:deletions        the deletions query failing for 24 h (deleted events are not withdrawn): P3
//   alerts:budget                the gateway's tightest daily free-tier ratio, projected to the end of the UTC day
//                                (from 02:00 UTC), at 0.75: P2
//   alerts:degraded / :policy / :apns   the degradation ladder, the compiled fallback policy, the APNs keys: P1 (P3 for
//                                a forced override, and for today's skipped_no_key / retry_dropped_budget pushes)
//   shadow, logged only          alerts:provider-silent:<id> (ok but the watermark too old), alerts:latency:<id> (over
//                                3 s), alerts:canary (USGS lists a 10-60 min old M4.5+ event newer than the gateway's
//                                newest detection)
//   alerts:selftest              --selftest (or WATCHDOG_SELFTEST=1): a forced P1, the run must be red
// Optional fields an older gateway does not publish mean "unknown", never "problem".
//
// Optional usage half (board "[health] platform"): when CF_ANALYTICS_TOKEN (Account Analytics: Read) is set, it reads
// today's (UTC) account-wide Workers requests and D1 rows written from the GraphQL Analytics API: platform:cf-usage P1 at
// 95 % of a Workers Free daily cap, P2 at 80 % or a projected 100 % (from 02:00 UTC), P4 from 70 %. A token without
// CF_ACCOUNT_ID, a refused token or an unavailable API is watcher:cf-usage; the API's error text is redacted of the
// token and the account id before it reaches a finding or a log line. Without the token that half is skipped.
//
// Two modes:
//   --findings <path>  writes the findings document (evaluator `alerts`) for scripts/reconcile.mjs and exits 0 whatever
//                      it says; 3 when the path is missing or cannot be written; any other non-zero exit is a crash. A
//                      bad argument is the finding watcher:alerts-watchdog. Plain log lines and a step-summary section,
//                      no annotations for findings (reconcile prints those).
//   plain              (local runs) annotations (P1/P2 ::error::, P3 ::warning::) and exit codes: 0 healthy · 1 a P1/P2
//                      finding · 2 status.json unreadable (the pipeline state is UNKNOWN) · 3 the watchdog itself is
//                      misconfigured (a bad argument, a refused token, a usage query that failed).
//
//   node scripts/alerts-watchdog.mjs --findings findings/alerts.json        # the CI invocation
//   node scripts/alerts-watchdog.mjs --selftest                             # forces alerts:selftest (P1)
//   node scripts/alerts-watchdog.mjs --status-file doc.json --no-canary     # judge a saved document
//   flags: --url <url> --status-file <path> --selftest --findings <path> --canary-url <url> --canary-file <path>
//          --no-canary
//
// Dependency-free (Node >= 22, global fetch). The pure helpers are exported for tests/alerts-watchdog.test.ts, which
// never touches the network.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RULES, ageText, findingsDocument, makeFinding, oneLine, utcText } from './lib/findings.mjs';

export const STATUS_URL = 'https://data.theshelter.app/alerts/status.json';
export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
/** The canary's source (alerts:canary): USGS's public summary of the last hour's M4.5+ events. */
export const CANARY_URL = RULES['alerts:canary'].limits.url;

/** How far back the gateway's USGS deletions query reaches (alerts-gateway USGS_DELETIONS_MAX_WINDOW_MS = the
 *  detector's 7-day withdrawal floor): a deletion older than this when the query next succeeds is never withdrawn. */
export const DELETIONS_MAX_WINDOW_MS = 7 * 86_400_000;

/**
 * How often the alerts-gateway polls each detector provider (platform repo, services/alerts-gateway, read 2026-10-13):
 * the detector ticks every 15 s (src/durable-objects/event-detector.ts TICK_INTERVAL_MS) and polls a provider on a tick
 * once its minIntervalMs has passed since its last poll: EMSC and GFZ 10 s, so on every tick (src/detect/sources.ts
 * EMSC_SOURCE, GFZ_SOURCE), USGS 60 s (USGS_SOURCE), the feed backstop 60 s (src/detect/feed-source.ts MIN_INTERVAL_MS).
 * A failing provider is polled at most every 60 s from its 3rd failure in a row and every 300 s from its 10th
 * (src/detect/provider-health.ts BACKOFF_STEPS). An id missing here (a newer gateway) is judged as a 60 s provider.
 * Keep these in step with the gateway: they turn a failure count into a duration when no failingSinceMs is published.
 */
export const GATEWAY_TICK_MS = 15_000;
export const PROVIDER_MIN_INTERVAL_MS = Object.freeze({ usgs: 60_000, emsc: 10_000, gfz: 10_000, feed: 60_000 });
export const PROVIDER_BACKOFF_STEPS = Object.freeze([
  Object.freeze({ atFailures: 10, intervalMs: 300_000 }),
  Object.freeze({ atFailures: 3, intervalMs: 60_000 }),
]);
/** The gateway's own upstream sources (its ALL_SOURCES); the feed is the backstop behind them. */
export const DIRECT_PROVIDERS = Object.freeze(['usgs', 'emsc', 'gfz']);
/** The backstop's provider id (alerts-gateway src/detect/feed-source.ts): this feed, read every 60 s. */
export const BACKSTOP_PROVIDER = 'feed';

const DAY_MS = 86_400_000;
const STATUS_BACKOFF_MS = [2_000, 5_000];
const STATUS_TIMEOUT_MS = 15_000;
const CANARY_TIMEOUT_MS = 15_000;
/** A failingSinceMs this far past the document's own time is damage, not a start (a newer field, a broken clock). */
const START_SKEW_MS = 60_000;
/** A provider id usable in a key (`alerts:latency:<id>`): the document is public input. */
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const limits = (ruleId) => RULES[ruleId].limits;
const STALE_LIMITS = limits('alerts:status:stale');
const FAST_LIMITS = limits('alerts:provider:fast');
const INVALID_LIMITS = limits('alerts:provider:fast:invalid');

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
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (share) => `${(share * 100).toFixed(1)} %`;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Whole detector ticks covering `ms`: a poll can only happen on a tick. */
const onTicks = (ms) => Math.max(1, Math.ceil(ms / GATEWAY_TICK_MS)) * GATEWAY_TICK_MS;

/** How often the gateway polls a healthy provider (ms): its minIntervalMs on whole ticks; 60 s for an unknown id. */
export function pollIntervalMs(id) {
  return onTicks(Object.hasOwn(PROVIDER_MIN_INTERVAL_MS, id) ? PROVIDER_MIN_INTERVAL_MS[id] : 60_000);
}

/** Whether the gateway polls the provider on every detector tick (EMSC, GFZ): its streaks grow four times as fast. */
export function isFastProvider(id) {
  return pollIntervalMs(id) < 60_000;
}

/**
 * About how long a streak of `failures` polls in a row has lasted (s), from the first failed poll to the latest: the
 * poll interval between them, widened by the gateway's backoff. A lower bound: a tick that waits on a 4 s timeout
 * starts the next one later. Used only when the gateway publishes no start (before round 25, or a streak that began
 * before the field), so such a streak is judged a little later, never earlier.
 */
export function streakSpanSec(id, failures) {
  let ms = 0;
  for (let k = 1; k < failures; k++) {
    const step = PROVIDER_BACKOFF_STEPS.find((s) => k >= s.atFailures);
    ms += Math.max(pollIntervalMs(id), step ? onTicks(step.intervalMs) : 0);
  }
  return ms / 1000;
}

/** "45 s", "3.5 min", "31.5 h"; always rounded down, so a streak short of its line never reads as it. */
function spanText(sec) {
  if (sec < 120) return `${Math.floor(sec)} s`;
  if (sec < 7_200) return `${Math.floor(sec / 30) / 2} min`;
  return `${(Math.floor(sec / 360) / 10).toFixed(1)} h`;
}

/** A published start (failingSinceMs, primaryFailingSinceMs, deletionsFailingSinceMs) when it is a usable time. */
function usableStart(sinceMs, refMs) {
  return isNum(sinceMs) && sinceMs > 0 && isNum(refMs) && sinceMs <= refMs + START_SKEW_MS ? sinceMs : null;
}

/**
 * How long a failing provider entry has failed (s), as of `refMs` (the document's generatedAtMs): from the gateway's
 * `failingSinceMs` (round-25 gateways, published while the streak lasts) when it is a usable time, else estimated from
 * `consecutiveFailures` at the gateway's polling (streakSpanSec, a lower bound). Null when the entry carries neither.
 * @returns {{ sec: number, measured: boolean, since?: number, failures: number | null } | null}
 */
export function streakDuration(p, refMs) {
  if (!isObject(p)) return null;
  const id = typeof p.id === 'string' ? p.id : '?';
  const failures = isNum(p.consecutiveFailures) && p.consecutiveFailures >= 0 ? p.consecutiveFailures : null;
  const since = usableStart(p.failingSinceMs, refMs);
  if (since !== null) return { sec: Math.max(0, refMs - since) / 1000, measured: true, since, failures };
  if (failures === null || failures < 1) return null;
  return { sec: streakSpanSec(id, failures), measured: false, failures };
}

/** "for 6.5 min (since 05:12:30 UTC)" or "for about 5 min (6 consecutive failures at 60 s polls; no failingSinceMs)". */
function durationText(id, d) {
  if (d.measured) return `for ${spanText(d.sec)} (since ${new Date(d.since).toISOString().slice(11, 19)} UTC)`;
  return `for about ${spanText(d.sec)} (${plural(d.failures, 'consecutive failure')} at ${pollIntervalMs(id) / 1000} s polls; the gateway publishes no failingSinceMs for it)`;
}

/** What the gateway's `lastError` values mean (alerts-gateway status.ts, round 14). */
export const PROVIDER_ERRORS = Object.freeze({
  timeout: "slower than the gateway's fetch timeout",
  http: 'an HTTP error status',
  network: 'a network failure before the timeout',
  invalid: 'a body that does not parse or verify',
});

/** "last error timeout (slower than ...)" for an error code, cut to 32 characters (the document is public input). */
function errorCode(code) {
  const c = code.slice(0, 32);
  return `last error ${c}${Object.hasOwn(PROVIDER_ERRORS, c) ? ` (${PROVIDER_ERRORS[c]})` : ''}`;
}

/**
 * Why a failing provider fails, from the fields the gateway publishes since round 14 while a provider fails:
 * `lastError` (timeout | http | network | invalid) and `consecutiveTimeouts` (how many of the latest failures in a
 * row were timeouts). '' when the gateway does not publish them (a healthy provider, an older gateway, a streak
 * recorded before round 14). An unknown `lastError` string is shown as is (cut to 32 characters).
 */
export function failureReason(p) {
  if (!isObject(p)) return '';
  const parts = [];
  if (typeof p.lastError === 'string' && p.lastError !== '') parts.push(errorCode(p.lastError));
  if (isNum(p.consecutiveTimeouts) && p.consecutiveTimeouts > 0) parts.push(`${plural(p.consecutiveTimeouts, 'timeout')} in a row`);
  return parts.length > 0 ? `, ${parts.join(', ')}` : '';
}

/**
 * The deletions half of a provider entry (round-16 gateways, GW-R15-1): `deletionsConsecutiveFailures` and
 * `deletionsLastError` are published only while the provider's separate deletions query fails, and `ok` stays true
 * meanwhile. Returns null when the entry carries no positive streak (a healthy query, an older gateway, a provider
 * without a deletions query, or a malformed value), else the streak, a readable reason and, when the gateway publishes
 * `deletionsFailingSinceMs` (round 25), how long it has lasted as of `refMs` (`lasted`: " over 22 min", else '').
 */
export function deletionsFailure(p, refMs) {
  if (!isObject(p)) return null;
  const n = p.deletionsConsecutiveFailures;
  if (!isNum(n) || n <= 0) return null;
  const why = typeof p.deletionsLastError === 'string' && p.deletionsLastError !== '' ? `, ${errorCode(p.deletionsLastError)}` : '';
  return { failures: n, why, lasted: lastedText(p.deletionsFailingSinceMs, refMs) };
}

/** " over 22 min" for a sub-query streak whose start the gateway publishes (round 25), '' otherwise. */
function lastedText(sinceMs, refMs) {
  const since = usableStart(sinceMs, refMs);
  return since === null ? '' : ` over ${spanText(Math.max(0, refMs - since) / 1000)}`;
}

/**
 * The primary live query of a provider entry (2026-10-13 gateways, USGS FDSN): `primaryConsecutiveFailures` and
 * `primaryLastError` are published only while it fails; `fallback: 'summary'` says the provider stays ok on USGS's
 * summary feed meanwhile (absent while the provider itself fails too). Null when the entry carries no positive streak.
 * `lasted` is " over N min" from `primaryFailingSinceMs` (round 25) as of `refMs`, else ''.
 */
export function primaryFailure(p, refMs) {
  if (!isObject(p)) return null;
  const n = p.primaryConsecutiveFailures;
  if (!isNum(n) || n <= 0) return null;
  const why = typeof p.primaryLastError === 'string' && p.primaryLastError !== '' ? `, ${errorCode(p.primaryLastError)}` : '';
  return { failures: n, why, fallback: p.fallback === 'summary', lasted: lastedText(p.primaryFailingSinceMs, refMs) };
}

// ---------------------------------------------------------------------------------------------------------
// Findings

/** alerts:status:unreadable (P2, sinceMs null): reconcile confirms it on its second run in a row. */
export function unreadableFinding(message) {
  return makeFinding('alerts:status:unreadable', { severity: 'P2', sinceMs: null, text: message });
}

function selftestFinding() {
  return makeFinding('alerts:selftest', { text: 'forced by the selftest: this run must be red; any other outcome means the red path is broken' });
}

/** The gate result for a document that cannot be judged: only alerts:status:unreadable, every alerts:* key unjudged. */
function unreadableVerdict(message, summary, selftest) {
  return { findings: [unreadableFinding(message), ...(selftest ? [selftestFinding()] : [])], unjudged: ['alerts:*'], notes: [], summary };
}

/** The document gate: unreadable, stale (older than alerts:status:stale's line) or fresh. */
function statusGate(doc, nowMs) {
  const unknown = 'The alert pipeline state is UNKNOWN.';
  if (!isObject(doc)) return { state: 'unreadable', message: `status.json is not a JSON object. ${unknown}`, summary: 'not a JSON object' };
  if (!isNum(doc.generatedAtMs)) {
    return { state: 'unreadable', message: `status.json has no numeric generatedAtMs, so its freshness cannot be judged. ${unknown}`, summary: 'age=?' };
  }
  const providers = isObject(doc.detector) ? doc.detector.providers : undefined;
  if (!Array.isArray(providers)) {
    return { state: 'unreadable', message: `status.json has no detector.providers list, so provider health cannot be judged. ${unknown}`, summary: 'providers=?' };
  }
  const ageMs = nowMs - doc.generatedAtMs;
  return { state: ageMs > STALE_LIMITS.maxAgeMs ? 'stale' : 'fresh', ageMs, providers };
}

/** The rule that judges one failing provider on its own, or null for an id no rule judges. */
function providerRule(id, p) {
  if (FAST_LIMITS.ids.includes(id)) return INVALID_LIMITS.errors.includes(p.lastError) ? 'alerts:provider:fast:invalid' : 'alerts:provider:fast';
  if (id === 'usgs') return 'alerts:provider:usgs';
  if (id === BACKSTOP_PROVIDER) return 'alerts:provider:feed';
  return null;
}

/**
 * The gateway's own daily counters (status.json `budget`, its estimates, not Cloudflare billing) against the caps of
 * alerts:budget: each counter's share of its free-tier cap, and that share projected to the end of the UTC day (share ÷
 * the fraction of the day passed), tightest projection first. Null when `budget.day` is not the UTC day of `refMs`
 * (a new day resets the counters) or before 02:00 UTC (projectFromMs: too early to project).
 */
function budgetRows(doc, refMs) {
  if (!isObject(doc) || !isObject(doc.budget) || !isNum(refMs)) return null;
  const l = limits('alerts:budget');
  const dayStart = refMs - (((refMs % DAY_MS) + DAY_MS) % DAY_MS);
  const elapsed = refMs - dayStart;
  if (doc.budget.day !== isoDate(dayStart) || elapsed < l.projectFromMs) return null;
  const fraction = elapsed / DAY_MS;
  const rows = [];
  for (const [field, cap] of Object.entries(l.caps)) {
    const value = doc.budget[field];
    if (!isNum(value) || value < 0) continue;
    rows.push({ field, actual: value / cap, projected: value / cap / fraction });
  }
  return rows.sort((a, b) => b.projected - a.projected);
}

/**
 * alerts:budget: P2 when the tightest projection of the gateway's daily counters (budgetRows) reaches enterShare (0.75),
 * a P4 sample from resolveShare (0.65), null below, on another UTC day or before 02:00 UTC. Members: the counters
 * projected past resolveShare.
 */
export function budgetFinding(doc, refMs) {
  const rows = budgetRows(doc, refMs);
  const top = rows?.[0];
  const l = limits('alerts:budget');
  if (!top || top.projected < l.resolveShare) return null;
  const severity = top.projected >= l.enterShare ? 'P2' : 'P4';
  const others = rows.slice(1).filter((r) => r.projected >= l.resolveShare);
  const also = others.length > 0 ? `; also past ${pct(l.resolveShare)}: ${others.map((r) => `${r.field} ${pct(r.projected)}`).join(', ')}` : '';
  return makeFinding('alerts:budget', {
    severity,
    text: `the gateway's tightest daily free-tier budget, ${top.field}, is at ${pct(top.actual)} of its cap by ${new Date(refMs).toISOString().slice(11, 16)} UTC, projected ${pct(top.projected)} by the end of the UTC day (line ${pct(l.enterShare)}; the gateway's own estimate, not Cloudflare billing)${also}`,
    members: [top.field, ...others.map((r) => r.field)],
  });
}

/**
 * alerts:canary (shadow): USGS's 4.5_hour summary lists events whose origin is 10-60 min old (each above the M4.0
 * detection floor); when the gateway's newest detection (`lastEvent.atMs`, a detection time) is older than the oldest
 * of them, the detector has detected nothing since that event happened: a full detection stall. P4 or null; only for a
 * fresh document (evaluateStatus decides).
 */
export function canaryFinding(doc, geojson, nowMs) {
  if (!isObject(geojson) || !Array.isArray(geojson.features) || !isNum(nowMs)) return null;
  const l = limits('alerts:canary');
  let oldest = null;
  for (const f of geojson.features) {
    const props = isObject(f) && isObject(f.properties) ? f.properties : null;
    if (!props || !isNum(props.time)) continue;
    const age = nowMs - props.time;
    if (age < l.minEventAgeMs || age > l.maxEventAgeMs) continue;
    if (oldest === null || props.time < oldest.time) {
      oldest = { time: props.time, id: oneLine(f.id ?? props.code ?? '?', 40), mag: isNum(props.mag) ? props.mag : null };
    }
  }
  if (oldest === null) return null;
  const lastAt = isObject(doc) && isObject(doc.lastEvent) && isNum(doc.lastEvent.atMs) ? doc.lastEvent.atMs : 0;
  if (lastAt >= oldest.time) return null;
  const detected = lastAt > 0 ? `${ageText(nowMs - lastAt)} old (${utcText(lastAt)})` : 'missing';
  return makeFinding('alerts:canary', {
    severity: 'P4',
    sinceMs: oldest.time,
    text: `USGS lists ${oldest.id} (M${oldest.mag ?? '?'}, origin ${ageText(nowMs - oldest.time)} ago, ${utcText(oldest.time)}) but the gateway's newest detection (lastEvent.atMs) is ${detected}: the detector may be ticking without detecting`,
  });
}

/**
 * Judge a parsed status.json as findings. Pure: `nowMs` is injected; `canary` is the parsed USGS 4.5_hour summary, or
 * null when it was not read (alerts:canary is then unjudged); `selftest` adds alerts:selftest (P1) whatever the
 * document says.
 * @returns {{ findings: import('./lib/findings.d.mts').Finding[], unjudged: string[], notes: string[], summary: string }}
 */
export function evaluateStatus(doc, { nowMs, canary = null, selftest = false } = {}) {
  if (!isNum(nowMs)) throw new TypeError('evaluateStatus: nowMs is required');
  const gate = statusGate(doc, nowMs);
  if (gate.state === 'unreadable') return unreadableVerdict(gate.message, gate.summary, selftest);

  const findings = [];
  const unjudged = [];
  const notes = [];
  const ageSec = Math.round(gate.ageMs / 1000);
  if (gate.state === 'stale') {
    findings.push(makeFinding('alerts:status:stale', {
      sinceMs: doc.generatedAtMs,
      text: `status.json is ${ageSec} s old (line ${STALE_LIMITS.maxAgeMs / 1000} s, generated ${utcText(doc.generatedAtMs)}): the detector has stopped publishing, so alerts are not being detected`,
    }));
    if (selftest) findings.push(selftestFinding());
    return { findings, unjudged: ['alerts:*'], notes, summary: `age=${ageSec}s STALE` };
  }

  // Fresh: every rule is judged as of the document's own time, so a streak reads the same until the next document.
  const refMs = doc.generatedAtMs;
  const parts = [`age=${ageSec}s`];
  if (gate.ageMs < -STALE_LIMITS.maxAgeMs) notes.push(`generatedAtMs is ${-ageSec} s in the future: clock skew between the gateway and the runner? (judged as of generatedAtMs)`);

  // 1. Providers, by the first entry of each id.
  const entries = new Map();
  for (const p of gate.providers) {
    if (!isObject(p) || typeof p.id !== 'string' || p.id === '') {
      notes.push('a detector.providers entry has no id: skipped');
    } else if (entries.has(p.id)) {
      notes.push(`provider ${oneLine(p.id, 40)} is listed twice: the first entry is judged`);
    } else {
      entries.set(p.id, p);
    }
  }
  // A direct provider the document does not list is not polled: the gateway lost it (a deploy, a configuration change).
  // It is neither healthy nor silent: its row says so (alerts:provider:unlisted, below), and the coverage rows count it
  // as failing for as long as it is missing (an empty list is all three). Without a usgs entry USGS's sub-queries are
  // unknown: frozen, not resolved.
  const unlisted = DIRECT_PROVIDERS.filter((id) => !entries.has(id));
  if (entries.size === 0) notes.push('detector.providers is empty: no alert source is being polled');
  if (unlisted.includes('usgs')) unjudged.push('alerts:usgs:*');
  const durations = new Map();
  for (const [id, p] of entries) {
    if (p.ok !== false) continue;
    const d = streakDuration(p, refMs);
    if (d) durations.set(id, d);
  }

  // 2. Coverage: the redundant set of direct providers. Ongoing streaks overlap for as long as the shortest of them, so
  //    "together" is the shortest duration of the group; a provider that is not polled counts as failing with no end
  //    to its streak. A direct provider ok:false with no streak is left out.
  const directFailing = DIRECT_PROVIDERS.filter((id) => durations.has(id) || unlisted.includes(id));
  const backstop = entries.get(BACKSTOP_PROVIDER);
  const backstopDown = isObject(backstop) && backstop.ok === false;
  const backstopFor = durations.has(BACKSTOP_PROVIDER) ? ` for ${spanText(durations.get(BACKSTOP_PROVIDER).sec)}` : '';
  if (directFailing.length >= 2) {
    const sec = (id) => (durations.has(id) ? durations.get(id).sec : Infinity);
    const sinceOf = (s) => (Number.isFinite(s) ? refMs - s * 1000 : null);
    const longest = [...directFailing].sort((a, b) => sec(b) - sec(a));
    const togetherAll = Math.min(...directFailing.map(sec));
    const togetherPair = sec(longest[1]);
    const byCount = (ids) => {
      const est = ids.filter((id) => durations.has(id) && !durations.get(id).measured);
      return est.length > 0 ? ` (${est.join(' and ')} judged by ${est.length === 1 ? 'its failure count' : 'their failure counts'}: no failingSinceMs)` : '';
    };
    // "have been failing together for 3 min"; with a provider that is not polled, "are out: usgs failing for 4 min, gfz
    // not polled (missing from detector.providers)".
    const andList = (ids) => (ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}` : ids.join(''));
    const group = (ids, verb) => {
      const off = ids.filter((id) => unlisted.includes(id));
      const on = ids.filter((id) => !unlisted.includes(id));
      if (off.length === 0) return `${verb} together for ${spanText(Math.min(...ids.map(sec)))}`;
      const parts = on.length > 0 ? [`${andList(on)} failing${on.length > 1 ? ' together' : ''} for ${spanText(Math.min(...on.map(sec)))}`] : [];
      return `are out: ${[...parts, `${andList(off)} not polled (missing from detector.providers)`].join(', ')}`;
    };
    const anyUnlisted = directFailing.some((id) => unlisted.includes(id));
    const allRule = limits('alerts:coverage:all');
    const all = directFailing.length === DIRECT_PROVIDERS.length && togetherAll * 1000 >= allRule.minTogetherMs;
    let allText;
    if (all) {
      const outcome = backstopDown
        ? `the feed backstop is failing too${backstopFor}, so the gateway sees no new quakes at all`
        : backstop
          ? 'the gateway sees new quakes only through the feed backstop, minutes late'
          : 'the gateway sees no new quakes from a direct source (status.json lists no feed backstop)';
      const cause = anyUnlisted
        ? 'a direct provider missing from detector.providers points at a deploy or a configuration change of the gateway'
        : `${backstopDown ? 'every source' : 'three agencies'} failing at once points at the gateway's side (its egress, DNS, the Workers runtime or a deploy)`;
      allText = `all three direct providers (${DIRECT_PROVIDERS.join(', ')}) ${group(directFailing, 'have been failing')} (line ${spanText(allRule.minTogetherMs / 1000)})${byCount(directFailing)}: ${outcome}; ${cause}`;
    } else if (anyUnlisted) {
      allText = `${directFailing.length} of the 3 direct providers ${group(directFailing, 'are failing')}: below the all-three line (all three for ${spanText(allRule.minTogetherMs / 1000)})`;
    } else {
      allText = `${directFailing.length} of the 3 direct providers are failing (${directFailing.join(', ')}), together for ${spanText(togetherAll)}: below the all-three line (all three for ${spanText(allRule.minTogetherMs / 1000)})`;
    }
    findings.push(makeFinding('alerts:coverage:all', { severity: all ? 'P1' : 'P4', sinceMs: sinceOf(togetherAll), text: allText, members: directFailing }));

    const twoRule = limits('alerts:coverage:two');
    const pair = longest.slice(0, 2);
    const two = togetherPair * 1000 >= twoRule.minTogetherMs;
    const rest = DIRECT_PROVIDERS.filter((id) => !pair.includes(id))
      .map((id) => (durations.has(id) ? `${id}, failing too for ${spanText(sec(id))}` : unlisted.includes(id) ? `${id}, not polled either` : id))
      .join(', ');
    const behind = backstopDown ? `; the feed backstop is failing too${backstopFor}` : backstop ? ', with the feed backstop' : '';
    const twoText = two
      ? `two of the three direct providers (${pair.join(' and ')}) ${group(pair, 'have been failing')} (line ${spanText(twoRule.minTogetherMs / 1000)})${byCount(pair)}: one direct source is left (${rest})${behind}`
      : `two of the three direct providers (${pair.join(' and ')}) ${group(pair, 'are failing')}: below the ${spanText(twoRule.minTogetherMs / 1000)} line${backstopDown ? behind : ''}`;
    findings.push(makeFinding('alerts:coverage:two', { severity: two ? 'P2' : 'P4', sinceMs: sinceOf(togetherPair), text: twoText, members: directFailing }));
  }

  // 3. One provider on its own: a P3 at its line, a P4 sample below it (reconcile also enters at 4 of the last 8 runs).
  const tags = [];
  for (const [id, p] of entries) {
    const shown = oneLine(id, 40);
    const fails = isNum(p.consecutiveFailures) ? p.consecutiveFailures : null;
    const prim = primaryFailure(p, refMs);
    const del = deletionsFailure(p, refMs);
    tags.push(`${shown}:${p.ok === false ? `FAIL(${fails ?? '?'})` : 'ok'}${prim ? `/primary-FAIL(${prim.failures})${prim.fallback ? '+summary' : ''}` : ''}${del ? `/deletions-FAIL(${del.failures})` : ''}`);
    if (id !== 'usgs' && (prim || del)) notes.push(`provider ${shown} publishes a failing ${prim ? 'primary' : 'deletions'} query: no rule judges it for this id`);
    if (p.ok !== false) continue;
    const ruleId = providerRule(id, p);
    const http = isNum(p.httpStatus) ? `, last HTTP ${p.httpStatus}` : '';
    const why = failureReason(p);
    if (ruleId === null) {
      notes.push(`provider ${shown} is ok:false${http}${why}: no rule judges this id`);
      continue;
    }
    const d = durations.get(id) ?? null;
    if (d === null) {
      // ok:false is evidence of a failure even without a streak: a P4 sample that keeps an open row open and counts
      // toward 4 of the last 8 runs (no streak, no line to judge).
      findings.push(makeFinding(ruleId, { id, severity: 'P4', sinceMs: null, text: `provider ${id} is ok:false with no failure streak published (neither failingSinceMs nor consecutiveFailures)${http}${why}` }));
      continue;
    }
    const line = limits(ruleId).lineMs;
    const severity = d.sec * 1000 >= line ? 'P3' : 'P4';
    const count = d.measured && fails !== null ? `, ${plural(fails, 'consecutive failure')}` : '';
    const lineWhat = ruleId === 'alerts:provider:fast:invalid' ? ' for invalid bodies' : ruleId === 'alerts:provider:fast' ? ' for timeouts, network and HTTP errors' : '';
    let consequence;
    if (id === BACKSTOP_PROVIDER) {
      consequence = 'the backstop behind the direct providers is failing: a quake they miss is not picked up from the feed';
    } else if (directFailing.length >= 2) {
      consequence = `${directFailing.length} direct providers are failing${unlisted.length > 0 ? ' or not polled' : ''}: see alerts:coverage:two`;
    } else {
      consequence = `${id === 'usgs' ? 'ComCat FDSN and its summary feed both fail; ' : ''}the other direct providers still deliver, so alerts still go out (a quake only ${id} reports may come later)`;
    }
    findings.push(makeFinding(ruleId, {
      id,
      severity,
      sinceMs: d.measured ? d.since : refMs - d.sec * 1000,
      text: `provider ${id} is failing: ok:false ${durationText(id, d)}${count}${http}${why} (${severity === 'P3' ? 'past' : 'below'} the ${spanText(line / 1000)} line${lineWhat}): ${consequence}`,
    }));
  }
  // A direct provider that is not polled: P3 (after reconcile's 2 runs), at once, with no streak to measure.
  for (const id of unlisted) {
    tags.push(`${id}:NOT-LISTED`);
    const why = entries.size === 0 ? 'detector.providers is empty, so the gateway polls no source at all' : `direct provider ${id} is not listed in detector.providers, so the gateway does not poll it`;
    findings.push(makeFinding('alerts:provider:unlisted', {
      id,
      sinceMs: null,
      text: `${why}: a deploy or a configuration change of the gateway? The coverage rows count ${id} as failing while it is missing`,
    }));
  }
  parts.push(`providers=${tags.join(',') || 'none'}`);

  // 4. USGS's sub-queries: the primary live query (ComCat FDSN) while the summary feed keeps the provider ok, and the
  //    deletions query (judged whatever `ok` says: it never fails the provider).
  const usgs = entries.get('usgs');
  if (usgs) {
    const prim = primaryFailure(usgs, refMs);
    if (prim && usgs.ok !== false && prim.fallback) {
      const line = limits('alerts:usgs:primary').lineMs;
      const start = usableStart(usgs.primaryFailingSinceMs, refMs) ?? refMs - streakSpanSec('usgs', prim.failures) * 1000;
      const lasted = prim.lasted || ` (about ${spanText((refMs - start) / 1000)} by its failure count)`;
      findings.push(makeFinding('alerts:usgs:primary', {
        severity: refMs - start >= line ? 'P3' : 'P4',
        sinceMs: start,
        text: `USGS's primary live query (ComCat FDSN) has failed ${plural(prim.failures, 'time')} in a row${lasted}${prim.why} (line ${spanText(line / 1000)}): its live events come from the summary feed (fallback: summary), up to about two minutes later`,
      }));
    } else if (prim && usgs.ok !== false) {
      notes.push(`USGS's primary live query has failed ${plural(prim.failures, 'time')} in a row${prim.lasted}${prim.why}, with no summary fallback published`);
    }
    const del = deletionsFailure(usgs, refMs);
    if (del) {
      const line = limits('alerts:usgs:deletions').lineMs;
      const start = usableStart(usgs.deletionsFailingSinceMs, refMs) ?? refMs - streakSpanSec('usgs', del.failures) * 1000;
      const lasted = del.lasted || ` (about ${spanText((refMs - start) / 1000)} by its failure count)`;
      let cursor = '';
      if (isNum(usgs.watermarkMs) && usgs.watermarkMs > 0) {
        const lagMs = Math.max(0, refMs - usgs.watermarkMs);
        const lag = lagMs >= 172_800_000 ? `${(lagMs / 86_400_000).toFixed(1)} days` : `${(lagMs / 3_600_000).toFixed(1)} h`;
        cursor = lagMs > DELETIONS_MAX_WINDOW_MS
          ? `; its cursor (watermarkMs) is ${lag} old, past the gateway's 7-day deletions window: a deletion from the start of the gap is no longer asked for, and that event stays live`
          : `; its cursor (watermarkMs) is ${lag} old (the next successful query asks from there, at most 7 days back)`;
      }
      findings.push(makeFinding('alerts:usgs:deletions', {
        severity: refMs - start >= line ? 'P3' : 'P4',
        sinceMs: start,
        text: `USGS's deletions query has failed ${plural(del.failures, 'time')} in a row${lasted}${del.why} (line ${spanText(line / 1000)}): deleted events are not being withdrawn${cursor}`,
      }));
    }
  }

  // 5. Shadow rules (logged as "would notify" only): a provider ok but its watermark too old, a slow provider.
  const silentLines = limits('alerts:provider-silent').watermarkMaxAgeMs;
  for (const [id, maxAgeMs] of Object.entries(silentLines)) {
    const p = entries.get(id);
    if (!p || p.ok === false || !isNum(p.watermarkMs) || p.watermarkMs <= 0) continue;
    // A failing deletions query holds the USGS watermark (its deletions cursor) still.
    if (id === 'usgs' && deletionsFailure(p, refMs)) continue;
    const age = refMs - p.watermarkMs;
    if (age <= maxAgeMs) continue;
    findings.push(makeFinding('alerts:provider-silent', {
      id,
      severity: 'P3',
      sinceMs: p.watermarkMs + maxAgeMs,
      text: `provider ${id} is ok but its watermark (the newest M4+ ${id === 'gfz' ? 'origin' : 'update'} it delivered) is ${ageText(age)} old (line ${ageText(maxAgeMs)}): it may be answering without delivering events`,
    }));
  }
  const maxLatencyMs = limits('alerts:latency').maxLatencyMs;
  for (const [id, p] of entries) {
    if (p.ok === false || !isNum(p.latencyMs) || p.latencyMs <= maxLatencyMs) continue;
    if (!PROVIDER_ID_RE.test(id)) {
      notes.push(`provider ${oneLine(id, 40)} answered in ${Math.round(p.latencyMs)} ms: its id is not usable in a key`);
      continue;
    }
    findings.push(makeFinding('alerts:latency', { id, severity: 'P4', text: `provider ${id} answered in ${Math.round(p.latencyMs)} ms (line ${maxLatencyMs} ms)` }));
  }

  // 6. Policy: the compiled fallback is deliberately restrictive; a silent revert (an expired signed policy) changes
  //    who gets alerted.
  const policy = doc.policy;
  if (isObject(policy)) {
    const version = isNum(policy.version) ? `v${policy.version}` : 'v?';
    parts.push(`policy=${oneLine(policy.source ?? '?', 32)}/${version}${policy.fallback === true ? '/FALLBACK' : ''}`);
    if (policy.fallback === true || policy.source === 'fallback') {
      findings.push(makeFinding('alerts:policy', { text: `the gateway runs the compiled FALLBACK alerts policy (${version}, reason: ${oneLine(policy.reason ?? 'unknown', 80)}): the signed policy is not live` }));
    }
  } else {
    parts.push('policy=?');
    notes.push('policy is absent: cannot tell whether the signed alerts policy is live (alerts:policy not judged)');
    unjudged.push('alerts:policy');
  }

  // 7. Degradation ladder: active means alert tiers are being shed to stay inside the free tier.
  const degraded = doc.degraded;
  if (isObject(degraded)) {
    const level = oneLine(degraded.level ?? '?', 40);
    parts.push(`degraded=${level}`);
    if (degraded.active === true) {
      findings.push(degraded.forced === true
        ? makeFinding('alerts:degraded', { severity: 'P3', text: `a forced override of the degradation ladder is on (level ${level}): some alert tiers are not being sent until it is lifted` })
        : makeFinding('alerts:degraded', { text: `the gateway is DEGRADED (level ${level}, reason: ${oneLine(degraded.reason ?? 'unknown', 80)}): some alert tiers are not being sent` }));
    }
  } else {
    parts.push('degraded=?');
    notes.push('degraded is absent: cannot tell whether the degradation ladder is active (alerts:degraded not judged)');
    unjudged.push('alerts:degraded');
  }

  // 8. Free-tier budget, projected to the end of the UTC day (the headroomPct < 20 rule is gone: the ladder covers it).
  const budget = budgetFinding(doc, refMs);
  if (budget) findings.push(budget);
  if (isObject(doc.budget)) {
    const top = budgetRows(doc, refMs)?.[0];
    parts.push(top ? `budget=${top.field}:${Math.round(top.projected * 100)}%/day` : `budget=${oneLine(doc.budget.day ?? '?', 16)}:not-projected`);
  } else {
    parts.push('budget=n/a');
    notes.push('budget is absent: the free-tier budget cannot be judged (alerts:budget not judged)');
    unjudged.push('alerts:budget');
  }

  // 9. APNs: configured:false means DRY mode (every fan-out "succeeds" and nothing is delivered). Round-3 gateways add
  //    the per-environment key state: configured stays true in 'split' mode without a production key, and then every
  //    production device (every App Store and TestFlight install) is skipped as skipped_no_key. Today's fan-out counters
  //    (round 3) are a P3: a few skipped or dropped pushes are worth a look, not a page.
  const apns = doc.apns;
  const fanout = doc.fanout;
  const severe = [];
  const minor = [];
  const texts = [];
  // Each key fault is judged on its own: an older gateway may publish some of these fields and not others.
  const apnsKnown = isObject(apns) && typeof apns.configured === 'boolean';
  if (isObject(apns)) {
    const mode = typeof apns.mode === 'string' ? `/${oneLine(apns.mode, 16)}` : '';
    const splitNoProduction = apns.mode === 'split' && apns.production !== true;
    parts.push(`apns=${apns.configured === true ? 'configured' : apns.configured === false ? 'DRY' : '?'}${mode}${splitNoProduction ? '/production=NO' : ''}`);
    if (apns.configured === false) {
      severe.push('dry');
      texts.push('APNs is NOT configured on the gateway: fan-outs run DRY and no push reaches a device');
    }
    if (Array.isArray(apns.problems) && apns.problems.length > 0) {
      severe.push('key-problems');
      texts.push(`the APNs key configuration has ${apns.problems.length} problem(s): ${apns.problems.map((x) => oneLine(x, 80)).join('; ')}; devices in an APNs environment without a complete key get no push`);
    }
    if (splitNoProduction) {
      severe.push('no-production');
      texts.push(`the gateway runs split per-environment keys but holds NO production key (apns.production is ${oneLine(JSON.stringify(apns.production) ?? 'absent', 16)}): every App Store and TestFlight device is skipped and receives no alert`);
    }
  } else {
    parts.push('apns=?');
  }
  if (!apnsKnown) notes.push('apns.configured is absent: cannot tell whether real pushes are being sent');
  if (isObject(fanout)) {
    const n = (v) => (isNum(v) ? v : '?');
    parts.push(`fanout=jobs:${n(fanout.jobs)},sent:${n(fanout.sent)},no_key:${n(fanout.skipped_no_key)},dropped_budget:${n(fanout.retry_dropped_budget)}`);
    const day = typeof fanout.day === 'string' ? ` (UTC ${oneLine(fanout.day, 16)})` : '';
    if (isNum(fanout.skipped_no_key) && fanout.skipped_no_key > 0) {
      minor.push('skipped_no_key');
      texts.push(`${fanout.skipped_no_key} device push(es) skipped today${day} because the gateway holds no APNs key for their push environment (fanout.skipped_no_key)`);
    }
    if (isNum(fanout.retry_dropped_budget) && fanout.retry_dropped_budget > 0) {
      minor.push('retry_dropped_budget');
      texts.push(`${fanout.retry_dropped_budget} transient push failure(s) today${day} were dropped without a retry: the fan-out job's retry budget was spent (fanout.retry_dropped_budget)`);
    }
  } else {
    parts.push(fanout === null ? 'fanout=none' : 'fanout=n/a');
  }
  if (severe.length > 0 || minor.length > 0) {
    findings.push(makeFinding('alerts:apns', { severity: severe.length > 0 ? 'P1' : 'P3', text: texts.join('. '), members: [...severe, ...minor] }));
  } else if (!apnsKnown) {
    unjudged.push('alerts:apns');
  }

  // 10. The canary (shadow): only with USGS's 4.5_hour summary, only against a fresh document.
  if (canary === null) {
    notes.push('canary: no USGS 4.5_hour summary this run (alerts:canary not judged)');
    unjudged.push('alerts:canary');
  } else if (!isObject(canary) || !Array.isArray(canary.features)) {
    notes.push('canary: the USGS 4.5_hour summary has no features list (alerts:canary not judged)');
    unjudged.push('alerts:canary');
  } else {
    const c = canaryFinding(doc, canary, nowMs);
    if (c) findings.push(c);
    parts.push(`canary=${canary.features.length}`);
  }

  if (selftest) findings.push(selftestFinding());
  return { findings, unjudged, notes, summary: parts.join(' ') };
}

// ---------------------------------------------------------------------------------------------------------
// HTTP

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
 * `text` with every occurrence of each non-empty secret (any letter case) replaced by ***. A Cloudflare API error can
 * echo the account id it was asked about, and its text reaches the public run log, the findings artifact and a board
 * body, where GitHub's secret masking does not apply.
 */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets ?? []) {
    if (typeof s === 'string' && s !== '') out = out.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '***');
  }
  return out;
}

/**
 * Parse a GraphQL Analytics response for USAGE_QUERY.
 * Only account totals come out: the run logs of this public repository must not list Worker or database names.
 * `secrets` (the token, the account id) are redacted from error messages before they are cut to length.
 * @returns {{ ok: true, workersRequests: number, d1RowsWritten: number }
 *   | { ok: false, kind: 'auth' | 'graphql' | 'shape', message: string }}
 */
export function parseUsageResponse(json, { secrets = [] } = {}) {
  if (!isObject(json)) return { ok: false, kind: 'shape', message: 'the response is not a JSON object' };
  const errors = Array.isArray(json.errors) ? json.errors.filter(isObject) : [];
  if (errors.length > 0) {
    const message = errors.map((e) => redact(String(e.message ?? 'unknown error'), secrets)).join('; ').slice(0, 500);
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
 * Query the usage. Never throws. Every message it returns has the token and the account id redacted.
 * @returns {Promise<ReturnType<typeof parseUsageResponse>>}
 */
export async function fetchUsage({ token, accountTag, nowMs, fetchImpl = globalThis.fetch, sleep = sleepMs }) {
  const secrets = [token, accountTag];
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
  if (r.ok) return parseUsageResponse(r.json, { secrets });
  if (r.kind === 'http' && (r.status === 401 || r.status === 403)) {
    return { ok: false, kind: 'auth', message: `HTTP ${r.status}: the token was rejected` };
  }
  return { ok: false, kind: 'graphql', message: redact(`${r.message} after ${r.attempts} attempt(s)`, secrets) };
}

/** watcher:cf-usage (P3; reconcile confirms it on the 2nd run): the usage half could not judge, platform:cf-usage frozen. */
function usageWatcher(message, summary) {
  return { findings: [makeFinding('watcher', { id: 'cf-usage', text: message })], unjudged: ['platform:cf-usage'], notes: [], summary };
}

/** The usage half when CF_ANALYTICS_TOKEN is set but CF_ACCOUNT_ID is empty. */
export function usageMisconfigured() {
  return usageWatcher('CF_ANALYTICS_TOKEN is set but CF_ACCOUNT_ID is empty: the account usage check cannot run', 'misconfigured (no account id)');
}

/**
 * Judge today's account usage (a fetchUsage result) as of `nowMs` against the Workers Free daily caps of
 * platform:cf-usage: P1 when a resource's actual share reaches 0.95; P2 at 0.8, or a share projected to the end of the
 * UTC day (share ÷ the fraction of the day passed, only from 02:00 UTC) of 1.0; P4 from 0.7 (the band that keeps an open
 * row open); nothing below. A refused token or an unavailable API is watcher:cf-usage. Pure.
 * @returns {{ findings: import('./lib/findings.d.mts').Finding[], unjudged: string[], notes: string[], summary: string }}
 */
export function usageFindings(r, nowMs) {
  if (!isObject(r) || r.ok !== true) {
    const message = isObject(r) && typeof r.message === 'string' ? r.message : 'no result';
    return isObject(r) && r.kind === 'auth'
      ? usageWatcher(`the account usage check was refused: ${message}. Fix or remove the CF_ANALYTICS_TOKEN secret`, `refused (${oneLine(message, 120)})`)
      : usageWatcher(`the account usage check is unavailable this run: ${message}`, `unavailable (${oneLine(message, 120)})`);
  }
  const l = limits('platform:cf-usage');
  const w = usageWindow(nowMs);
  const projecting = nowMs - Date.parse(w.datetimeStart) >= l.projectFromMs;
  const rows = [
    ['workersRequests', 'Workers requests', r.workersRequests, l.caps.workersRequests, 'every Worker on the account starts failing'],
    ['d1RowsWritten', 'D1 rows written', r.d1RowsWritten, l.caps.d1RowsWritten, 'every D1 write on the account (sign-in, device registration, reports) starts failing'],
  ].map(([id, label, used, cap, consequence]) => ({ id, label, used, cap, consequence, actual: used / cap, projected: used / cap / w.dayFraction }));
  const summary = rows.map((x) => `${x.label} ${x.used}/${x.cap} (${pct(x.actual)}, projected ${Math.round(x.used / w.dayFraction)}/day)`).join(' · ');
  const sevOf = (x) => {
    if (x.actual >= l.p1ActualShare) return 'P1';
    if (x.actual >= l.p2ActualShare || (projecting && x.projected >= l.p2ProjectedShare)) return 'P2';
    if (x.actual >= l.resolveShare) return 'P4';
    return null;
  };
  const hit = rows.map((x) => ({ ...x, severity: sevOf(x) })).filter((x) => x.severity !== null);
  if (hit.length === 0) return { findings: [], unjudged: [], notes: [], summary };
  hit.sort((a, b) => a.severity.localeCompare(b.severity) || b.actual - a.actual);
  const severity = hit[0].severity;
  const text = `${hit
    .map((x) => `account ${x.label} today: ${x.used} = ${pct(x.actual)} of the Workers Free daily cap (${x.cap}/day)${projecting ? `, projected ${pct(x.projected)} by 00:00 UTC` : ''}; at 100 % ${x.consequence} until 00:00 UTC`)
    .join('. ')} (lines: P2 at ${pct(l.p2ActualShare)} or a projected ${pct(l.p2ProjectedShare)} from 02:00 UTC, P1 at ${pct(l.p1ActualShare)})`;
  return { findings: [makeFinding('platform:cf-usage', { severity, text, members: hit.map((x) => x.id) })], unjudged: [], notes: [], summary };
}

// ---------------------------------------------------------------------------------------------------------
// CLI

/** A GitHub Actions workflow command (annotation), with the documented escaping. */
export function annotation(level, title, message) {
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return `::${level} title=${escProp(title)}::${esc(message)}`;
}

/**
 * The plain-mode exit code of a set of findings: 1 for any non-shadow P1/P2 except alerts:status:unreadable; else 2 for
 * alerts:status:unreadable (the pipeline state is unknown, not a confirmed failure); else 3 for a watcher:* finding
 * (the watchdog itself is misconfigured); else 0.
 */
export function plainExitCode(findings) {
  const unreadable = RULES['alerts:status:unreadable'].key;
  if (findings.some((f) => !f.shadow && (f.severity === 'P1' || f.severity === 'P2') && f.key !== unreadable)) return 1;
  if (findings.some((f) => f.key === unreadable)) return 2;
  if (findings.some((f) => f.key.startsWith(RULES.watcher.keyPrefix))) return 3;
  return 0;
}

const VALUE_FLAGS = Object.freeze(['--url', '--status-file', '--findings', '--canary-url', '--canary-file']);

/** Parse argv + env into options; throws an Error with a readable message on a bad argument. */
export function parseArgs(argv, env = {}) {
  const opts = {
    url: STATUS_URL,
    statusFile: null,
    selftest: env.WATCHDOG_SELFTEST === '1' || env.WATCHDOG_SELFTEST === 'true',
    findingsPath: null,
    canaryUrl: CANARY_URL,
    canaryFile: null,
  };
  let noCanary = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') {
      opts.selftest = true;
      continue;
    }
    if (a === '--no-canary') {
      noCanary = true;
      continue;
    }
    if (VALUE_FLAGS.includes(a)) {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      if (a === '--url') opts.url = value;
      else if (a === '--status-file') opts.statusFile = value;
      else if (a === '--findings') opts.findingsPath = value;
      else if (a === '--canary-url') opts.canaryUrl = value;
      else opts.canaryFile = value;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (noCanary) {
    opts.canaryUrl = null;
    opts.canaryFile = null;
  }
  return opts;
}

/** The --findings path of an argv that may not parse otherwise (a bad argument is then written as a finding). */
function findingsPathOf(argv) {
  const i = argv.indexOf('--findings');
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value !== undefined && value !== '' && !value.startsWith('--') ? value : null;
}

/** Write a file, creating its directory (the health workflow's `findings/`). */
function writeFileMkdir(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The plain-mode annotation of a non-shadow P1-P3 finding. */
function findingAnnotation(f, tag) {
  if (f.key.startsWith(RULES.watcher.keyPrefix)) return annotation('error', 'Alert watchdog misconfigured', f.text);
  if (f.key === RULES['alerts:status:unreadable'].key) return annotation('error', 'Alert watchdog could not read status.json', f.text);
  const level = f.severity === 'P3' ? 'warning' : 'error';
  const title = f.board === 'platform' ? 'Cloudflare free-tier usage high' : level === 'error' ? `${tag}Alert pipeline unhealthy` : 'Alert pipeline';
  return annotation(level, title, `${f.key}: ${f.text}`);
}

/** Text from the public document as step-summary markdown: no raw HTML. */
const md = (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** status.json's one-word verdict for the step summary. */
function statusVerdict(findings) {
  const has = (pred) => findings.some(pred);
  if (has((f) => f.key === RULES['alerts:status:unreadable'].key)) return '**UNREADABLE**';
  if (has((f) => f.key === RULES['alerts:status:stale'].key)) return '**STALE**';
  const red = findings.filter((f) => !f.shadow && (f.severity === 'P1' || f.severity === 'P2') && f.key !== RULES['alerts:selftest'].key);
  if (red.length > 0) return `**UNHEALTHY** (${plural(red.length, 'P1/P2 finding')})`;
  return has((f) => !f.shadow && f.severity === 'P3') ? 'warnings' : 'healthy';
}

/**
 * Run the evaluator. Everything with a side effect is injectable so tests stay offline.
 * @returns {Promise<number>} the exit code
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = console.log,
  sleep = sleepMs,
  readFile = (p) => readFileSync(p, 'utf8'),
  writeFile = writeFileMkdir,
} = {}) {
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
  const writeDocument = (path, doc) => {
    try {
      writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
      log(`findings: wrote ${plural(doc.findings.length, 'finding')} to ${path}`);
      return 0;
    } catch (e) {
      log(annotation('error', 'Alert watchdog could not write its findings', `${path}: ${errMsg(e)}`));
      summaryLines.push(`- findings: **not written** (${oneLine(errMsg(e), 200)})`);
      return 3;
    }
  };

  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    const path = findingsPathOf(argv);
    summaryLines.push(`- misconfigured: ${oneLine(errMsg(e), 200)}`);
    if (path === null) {
      log(annotation('error', 'Alert watchdog misconfigured', errMsg(e)));
      return finish(3);
    }
    // In findings mode a bad argument is a watcher finding, and nothing else is judged this run.
    log(`misconfigured: ${errMsg(e)}`);
    const doc = findingsDocument({
      evaluator: 'alerts',
      generatedAtMs: now(),
      findings: [makeFinding('watcher', { id: 'alerts-watchdog', text: `the alert-pipeline watchdog cannot run: ${errMsg(e)}` })],
      unjudged: ['alerts:*', 'platform:cf-usage'],
    });
    return finish(writeDocument(path, doc));
  }
  const findingsMode = opts.findingsPath !== null;
  const tag = opts.selftest ? '[selftest] ' : '';
  if (opts.selftest) {
    const text = 'alerts:selftest (P1) is forced, so this run MUST be red; any other outcome means the red path is broken';
    log(findingsMode ? `selftest: ${text}` : annotation('notice', 'Alert watchdog selftest', text));
  }

  // --- status.json ---
  let doc = null;
  let readError = null;
  if (opts.statusFile) {
    try {
      doc = JSON.parse(readFile(opts.statusFile));
    } catch (e) {
      readError = `status.json could not be read from the file given (${errMsg(e)}). The alert pipeline state is UNKNOWN.`;
      log(`status.json: ${opts.statusFile}: ${errMsg(e)}`);
    }
  } else {
    const r = await fetchJson(opts.url, {
      init: { headers: { 'cache-control': 'no-cache', accept: 'application/json' } },
      fetchImpl,
      sleep,
      attempts: limits('alerts:status:unreadable').attempts,
      backoffMs: STATUS_BACKOFF_MS,
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    if (r.ok) {
      doc = r.json;
    } else {
      const what = r.kind === 'network' ? 'network error' : r.kind === 'parse' ? 'unparseable body' : `HTTP ${r.status}`;
      // A deterministic 4xx is not a flaky network: the object is gone or something (WAF, bucket domain) hides it.
      const hint = r.kind === 'http' && !r.retryable
        ? 'The document is missing or blocked: the gateway may have stopped publishing it, or a zone or bucket change hides it.'
        : 'This is a network or edge problem between GitHub and data.theshelter.app, not a confirmed pipeline failure.';
      readError = `status.json could not be read (${what}): ${r.message} after ${plural(r.attempts, 'attempt')}. The alert pipeline state is UNKNOWN. ${hint} If it repeats on the next runs, check the alerts-gateway in the Cloudflare dashboard.`;
      log(`status.json: ${r.message} after ${plural(r.attempts, 'attempt')} from ${opts.url}`);
    }
  }
  const nowMs = now();

  // --- the canary: read only for a fresh document (it is judged against nothing else) ---
  const notes = [];
  let canary = null;
  if (doc !== null && statusGate(doc, nowMs).state === 'fresh') {
    if (opts.canaryFile) {
      try {
        canary = JSON.parse(readFile(opts.canaryFile));
      } catch (e) {
        notes.push(`canary: the file given could not be read (${errMsg(e)})`);
      }
    } else if (opts.canaryUrl) {
      const c = await fetchJson(opts.canaryUrl, { init: { headers: { accept: 'application/json' } }, fetchImpl, sleep, attempts: 1, timeoutMs: CANARY_TIMEOUT_MS });
      if (c.ok) canary = c.json;
      else notes.push(`canary: USGS's 4.5_hour summary could not be read (${c.message})`);
    } else {
      notes.push('canary: off (--no-canary)');
    }
  }
  const status = readError !== null
    ? unreadableVerdict(readError, 'unreadable', opts.selftest)
    : evaluateStatus(doc, { nowMs, canary, selftest: opts.selftest });

  // --- optional account usage ---
  let usage;
  const token = env.CF_ANALYTICS_TOKEN;
  if (!token) {
    usage = { findings: [], unjudged: [], notes: ['account usage: skipped (no CF_ANALYTICS_TOKEN)'], summary: '' };
  } else if (!env.CF_ACCOUNT_ID) {
    usage = usageMisconfigured();
  } else {
    usage = usageFindings(await fetchUsage({ token, accountTag: env.CF_ACCOUNT_ID, nowMs, fetchImpl, sleep }), nowMs);
  }

  const findings = [...status.findings, ...usage.findings];
  const unjudged = [...new Set([...status.unjudged, ...usage.unjudged])];
  notes.push(...status.notes, ...usage.notes);

  log(`alerts status: ${status.summary}`);
  if (usage.summary !== '') log(`account usage today (UTC): ${usage.summary}`);
  for (const n of notes) log(`note: ${n}`);
  summaryLines.push(`- status.json: ${statusVerdict(status.findings)} · \`${status.summary}\``);
  if (usage.summary !== '') summaryLines.push(`- account usage: ${md(usage.summary)}`);
  for (const f of findings) {
    summaryLines.push(`- ${f.shadow ? 'shadow (would notify) ' : ''}**${f.severity}** \`${f.key}\` (${f.rule}): ${md(f.text)}`);
  }
  if (unjudged.length > 0) summaryLines.push(`- not judged this run: ${unjudged.map((k) => `\`${k}\``).join(', ')}`);
  for (const n of notes) summaryLines.push(`- note: ${md(oneLine(n, 500))}`);

  if (findingsMode) {
    for (const f of findings) log(`${f.shadow ? 'shadow (would notify) ' : ''}${f.severity} ${f.key} (${f.rule}): ${f.text}`);
    if (unjudged.length > 0) log(`not judged this run: ${unjudged.join(', ')}`);
    const out = findingsDocument({ evaluator: 'alerts', generatedAtMs: nowMs, findings, unjudged, notes });
    return finish(writeDocument(opts.findingsPath, out));
  }

  for (const f of findings) {
    if (f.shadow) log(`shadow (would notify): ${f.severity} ${f.key}: ${f.text}`);
    else if (f.severity === 'P4') log(`P4 ${f.key}: ${f.text}`);
    else log(findingAnnotation(f, tag));
  }
  const code = plainExitCode(findings);
  if (code === 0) log(`${tag}alert pipeline healthy`);
  return finish(code);
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
