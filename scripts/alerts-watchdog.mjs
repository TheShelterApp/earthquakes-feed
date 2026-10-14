#!/usr/bin/env node
// Alert-pipeline watchdog for The Shelter's alerts-gateway (run by .github/workflows/health.yml).
//
// It lives here, in GitHub Actions, on purpose: it must keep working when Cloudflare (where the gateway
// runs) does not, and GitHub's "failed workflow" email is its only alarm channel. The gateway's detector
// publishes the public, no-store document https://data.theshelter.app/alerts/status.json once a minute
// from its tick; this script reads it and exits non-zero when:
//   - generatedAtMs is older than 300 s (the detector stopped ticking or cannot publish),
//   - a detector provider has been ok:false for longer than its limit, judged by TIME (the gateway's failingSinceMs,
//     round-25 gateways; for an older gateway, or a streak older than the field, the time its consecutiveFailures span
//     at the gateway's polling): 3 min for EMSC and GFZ (polled every 15 s detector tick), 5 min for USGS, the feed
//     backstop and any other id (polled every 60 s); two of the three direct providers (USGS, EMSC, GFZ) failing
//     together for 2 min; all three failing together for 1 min (both messages say when the feed backstop is failing
//     too). A shorter streak from 1 min is a warning. The message names the gateway's lastError and
//     consecutiveTimeouts when the document carries them,
//   - policy.fallback is true (the restrictive compiled policy runs instead of the signed one),
//   - degraded.active is true (the free-tier degradation ladder is shedding alert tiers),
//   - budget.headroomPct is below 20 (checked only when present),
//   - apns.configured is false (fan-outs run DRY: nothing reaches a phone),
//   - apns.problems is a non-empty array (a half-set APNs key: that environment's devices get nothing),
//   - apns.mode is 'split' and apns.production is not true (every production device is skipped).
//   - feed_manifest_age_s (the earthquakes-feed manifest the detector's backstop reads every minute) is over
//     1,800 s: the feed has stopped publishing, whatever the heartbeat Worker or GitHub's crons are doing,
//   - config_bundle_age_s (the signed config bundle's public copy) is over 10 days: the app falls back to its
//     compiled defaults once the bundle expires.
// The two ages are published by gateways from round 13 on (X-4, CFG-6); a document without them skips the check, and
// a null age (not read since the gateway deployed) is a warning.
// It only warns (exit stays 0) when today's fanout.skipped_no_key or fanout.retry_dropped_budget is above 0, and when a
// provider's separate deletions query (USGS `includedeleted=only`, round-16 gateways) has failed 3 times in a row
// (`deletionsConsecutiveFailures` / `deletionsLastError`, published only while it fails). The provider stays ok
// meanwhile (its live events still go out), but deleted events are not withdrawn and its watermark (the deletions
// cursor) stands still; the gateway asks again from that cursor, at most 7 days back, so a shorter gap recovers.
// It also only warns when a provider's primary live query (USGS: ComCat FDSN, 2026-10-13 gateways) has failed 3 times
// in a row (`primaryConsecutiveFailures` / `primaryLastError`, with `fallback: 'summary'` while the provider is ok):
// the live events then come from USGS's summary feed, up to about two minutes later, and alerts still go out. Both
// warnings say how long the streak has lasted when the gateway publishes its start (deletionsFailingSinceMs /
// primaryFailingSinceMs, round 25).
// Fields an older gateway does not publish (apns.mode/production/problems, fanout, failingSinceMs) are never a problem.
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
//   flags: --url <url> --max-age-sec <n> --provider-down-sec <n> --fast-provider-down-sec <n> --two-direct-down-sec <n>
//          --all-direct-down-sec <n> --provider-warn-sec <n> --min-headroom-pct <n> --usage-fail-pct <n>
//          --max-feed-manifest-age-sec <n> --max-config-bundle-age-sec <n> --deletions-failures <n> --primary-failures <n>
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
  // Provider outages are judged by how long they have lasted, not by a failure count (round 25, 2026-10-14): a count
  // means 30 s on EMSC/GFZ and 2 min on USGS, and the old "3 while another direct provider is down" rule turned a 40 s
  // GEOFON blip red. The limits, from what was measured (round-24 sweep, 2026-10-06..13): USGS outages of 15-50 min
  // (since 2026-10-13 absorbed by its summary-feed fallback, so ok:false means FDSN AND the summary feed fail), one
  // GEOFON blip of about 40 s (2026-10-09), EMSC/GFZ polled every 15 s tick and backed off to 60 s from the 3rd failure,
  // USGS and the feed every 60 s, the feed's own data every 5 min, a health run every 15 min. A provider's streak can
  // look up to one backoff interval (60 s) longer than the outage (the poll that would clear it waits), so a 40 s blip
  // reads as at most about 90-110 s on EMSC/GFZ.
  /** a provider polled every 60 s (USGS, the feed backstop, an unknown id) failing this long fails the run: 5 failed polls
   *  in a row, the same evidence as 3 min of EMSC/GFZ. A USGS ok:false already means both FDSN and its summary feed fail,
   *  and the backstop's own source moves every 5 min (one aggregate cycle), so a shorter gap costs at most one cycle.
   *  Every measured real outage (15-50 min) is red at the first health run past it. */
  providerDownSec: 300,
  /** a provider polled every 15 s tick (EMSC, GFZ) failing this long fails the run: about 5 failed polls in a row (15 s,
   *  15 s, then 60 s apart under the backoff), about the old 6-failure line (3.5 min), and twice the longest a 40 s
   *  blip can look (90-110 s). */
  fastProviderDownSec: 180,
  /** two of the three direct providers (USGS, EMSC, GFZ) failing together this long fails the run: one direct source is
   *  left. Above the 90-110 s a fast provider's blip can look, below every single-provider limit. */
  twoDirectDownSec: 120,
  /** all three direct providers failing together this long fails the run: the gateway sees quakes only through the feed
   *  backstop, minutes late. USGS reaches 60 s only by failing two polls 60 s apart, so this is never one blip; three
   *  agencies failing at once points at the gateway's side (egress, DNS, the Workers runtime, a deploy). */
  allDirectDownSec: 60,
  /** a provider failing this long, below its limit, is a warning; a shorter streak (a single failed poll: up to 60 s on
   *  USGS, 15 s on EMSC/GFZ) is a log note. */
  providerWarnSec: 60,
  /** budget.headroomPct below this fails. */
  minHeadroomPct: 20,
  /** account usage at or above this share (percent) of a Free daily cap fails. */
  usageFailPct: 80,
  /** the feed manifest the gateway last read older than this fails (the feed's own freshness contract). */
  maxFeedManifestAgeSec: 1_800,
  /** the signed config bundle older than this fails (10 days). */
  maxConfigBundleAgeSec: 864_000,
  /** a provider's deletions query (USGS, GW-R15-1) failing this many times in a row warns (never fails): the same
   *  streak that turns a provider down. The gateway backs the query off to every 60 s after 3 failures and every 300 s
   *  after 10, so a health run every 15 min sees a streak of 3 or more only when it lasted minutes, not one slow poll. */
  deletionsFailures: 3,
  /** a provider's primary live query (USGS FDSN, 2026-10-13) failing this many times in a row warns (never fails) while
   *  its fallback (the summary feed) keeps the provider ok; the gateway backs it off by the same steps. */
  primaryFailures: 3,
});

/** How far back the gateway's USGS deletions query reaches (alerts-gateway USGS_DELETIONS_MAX_WINDOW_MS = the
 *  detector's 7-day withdrawal floor): a deletion older than this when the query next succeeds is never withdrawn. */
export const DELETIONS_MAX_WINDOW_MS = 7 * 86_400_000;

/**
 * How often the alerts-gateway polls each detector provider (platform repo, services/alerts-gateway, read 2026-10-13):
 * the detector ticks every 15 s (src/durable-objects/event-detector.ts TICK_INTERVAL_MS) and polls a provider on a tick
 * once its minIntervalMs has passed since its last poll: EMSC and GFZ 10 s, so on every tick (src/detect/sources.ts
 * EMSC_SOURCE, GFZ_SOURCE), USGS 60 s (USGS_SOURCE), the feed backstop 60 s (src/detect/feed-source.ts MIN_INTERVAL_MS).
 * A failing provider is polled at most every 60 s from its 3rd failure in a row and every 300 s from its 10th
 * (src/detect/provider-health.ts BACKOFF_STEPS). An id missing here (a newer gateway) is judged as a 60 s provider, by
 * the stricter limit. Keep these in step with the gateway.
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
 * starts the next one later. Used only when the gateway publishes no failingSinceMs (before round 25, or a streak that
 * began before the field), so such a streak is judged a little later, never earlier.
 */
export function streakSpanSec(id, failures) {
  let ms = 0;
  for (let k = 1; k < failures; k++) {
    const step = PROVIDER_BACKOFF_STEPS.find((s) => k >= s.atFailures);
    ms += Math.max(pollIntervalMs(id), step ? onTicks(step.intervalMs) : 0);
  }
  return ms / 1000;
}

/** "45 s", "3.5 min", "31.6 h"; seconds and minutes round down, so a streak short of its limit never reads as it. */
function spanText(sec) {
  if (sec < 120) return `${Math.floor(sec)} s`;
  if (sec < 7_200) return `${Math.floor(sec / 30) / 2} min`;
  return `${(sec / 3_600).toFixed(1)} h`;
}

/** A failingSinceMs this far past the document's own time is damage, not a start (a newer field, a broken clock). */
const START_SKEW_MS = 60_000;

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
  if (isNum(p.failingSinceMs) && p.failingSinceMs > 0 && isNum(refMs) && p.failingSinceMs <= refMs + START_SKEW_MS) {
    return { sec: Math.max(0, refMs - p.failingSinceMs) / 1000, measured: true, since: p.failingSinceMs, failures };
  }
  if (failures === null || failures < 1) return null;
  return { sec: streakSpanSec(id, failures), measured: false, failures };
}

/** The red line (s) for one failing provider on its own: fastProviderDownSec for EMSC/GFZ, providerDownSec otherwise. */
export function providerDownSec(id, t) {
  return isFastProvider(id) ? t.fastProviderDownSec : t.providerDownSec;
}

/** "for 6.5 min (since 05:12:30 UTC)" or "for about 5 min (6 consecutive failures at 60 s polls; no failingSinceMs)". */
function durationText(id, d) {
  if (d.measured) return `for ${spanText(d.sec)} (since ${new Date(d.since).toISOString().slice(11, 19)} UTC)`;
  return `for about ${spanText(d.sec)} (${d.failures} consecutive failure${d.failures === 1 ? '' : 's'} at ${pollIntervalMs(id) / 1000} s polls; the gateway publishes no failingSinceMs for it)`;
}

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

/** What the gateway's `lastError` values mean (alerts-gateway status.ts, round 14). */
export const PROVIDER_ERRORS = Object.freeze({
  timeout: "slower than the gateway's fetch timeout",
  http: 'an HTTP error status',
  network: 'a network failure before the timeout',
  invalid: 'a body that does not parse or verify',
});

/**
 * Why a failing provider fails, from the fields the gateway publishes since round 14 while a provider fails:
 * `lastError` (timeout | http | network | invalid) and `consecutiveTimeouts` (how many of the latest failures in a
 * row were timeouts). '' when the gateway does not publish them (a healthy provider, an older gateway, a streak
 * recorded before round 14), so the message is then exactly what it was. An unknown `lastError` string is shown as
 * is (cut to 32 characters: the document is public input).
 */
export function failureReason(p) {
  if (!isObject(p)) return '';
  const parts = [];
  if (typeof p.lastError === 'string' && p.lastError !== '') {
    const code = p.lastError.slice(0, 32);
    const gloss = Object.hasOwn(PROVIDER_ERRORS, code) ? ` (${PROVIDER_ERRORS[code]})` : '';
    parts.push(`last error ${code}${gloss}`);
  }
  if (isNum(p.consecutiveTimeouts) && p.consecutiveTimeouts > 0) {
    const n = p.consecutiveTimeouts;
    parts.push(`${n} timeout${n === 1 ? '' : 's'} in a row`);
  }
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
  let why = '';
  if (typeof p.deletionsLastError === 'string' && p.deletionsLastError !== '') {
    const code = p.deletionsLastError.slice(0, 32);
    const gloss = Object.hasOwn(PROVIDER_ERRORS, code) ? ` (${PROVIDER_ERRORS[code]})` : '';
    why = `, last error ${code}${gloss}`;
  }
  return { failures: n, why, lasted: lastedText(p.deletionsFailingSinceMs, refMs) };
}

/** " over 22 min" for a sub-query streak whose start the gateway publishes (round 25), '' otherwise. */
function lastedText(sinceMs, refMs) {
  if (!isNum(sinceMs) || sinceMs <= 0 || !isNum(refMs) || sinceMs > refMs + START_SKEW_MS) return '';
  return ` over ${spanText(Math.max(0, refMs - sinceMs) / 1000)}`;
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
  let why = '';
  if (typeof p.primaryLastError === 'string' && p.primaryLastError !== '') {
    const code = p.primaryLastError.slice(0, 32);
    const gloss = Object.hasOwn(PROVIDER_ERRORS, code) ? ` (${PROVIDER_ERRORS[code]})` : '';
    why = `, last error ${code}${gloss}`;
  }
  return { failures: n, why, fallback: p.fallback === 'summary', lasted: lastedText(p.primaryFailingSinceMs, refMs) };
}

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

  // 2. Providers: an outage is judged by how long it has lasted (round 25; see DEFAULT_THRESHOLDS for the measured
  //    limits). One provider: 3 min for EMSC/GFZ, 5 min for the rest. Coverage: two of the three direct providers
  //    failing together for 2 min leave one direct source; all three for 1 min leave only the feed backstop. Ongoing
  //    streaks overlap for as long as the shortest of them, so "together" is the shortest duration of the group. A
  //    duration comes from the gateway's failingSinceMs, else from the failure count (streakDuration).
  const providers = isObject(doc.detector) ? doc.detector.providers : undefined;
  if (!Array.isArray(providers)) {
    problems.push('detector.providers is missing: provider health cannot be judged');
    parts.push('providers=?');
  } else {
    if (providers.length === 0) warnings.push('detector.providers is empty: no alert source is being polled');
    const tags = [];
    const refMs = isNum(doc.generatedAtMs) ? doc.generatedAtMs : nowMs;
    const durations = new Map();
    for (const p of providers) {
      if (!isObject(p) || p.ok !== false || typeof p.id !== 'string' || durations.has(p.id)) continue;
      const d = streakDuration(p, refMs);
      if (d) durations.set(p.id, d);
    }
    const directFailing = DIRECT_PROVIDERS.filter((id) => durations.has(id)).sort((a, b) => durations.get(b).sec - durations.get(a).sec);
    const together = (ids) => Math.min(...ids.map((id) => durations.get(id).sec));
    const byCount = (ids) => {
      const est = ids.filter((id) => !durations.get(id).measured);
      return est.length > 0 ? ` (${est.join(' and ')} judged by ${est.length === 1 ? 'its failure count' : 'their failure counts'}: no failingSinceMs)` : '';
    };
    // What is left besides the direct providers: the feed backstop, unless it fails too. An outage of the gateway's
    // egress (the likely cause when every direct provider fails at once) takes the backstop with it, and then the
    // gateway sees no new quake at all; the coverage messages must not say it still has the backstop then. Text only:
    // the backstop's state changes no verdict.
    const backstop = providers.find((p) => isObject(p) && p.id === BACKSTOP_PROVIDER);
    const backstopDown = isObject(backstop) && backstop.ok === false;
    const backstopFor = durations.has(BACKSTOP_PROVIDER) ? ` for ${spanText(durations.get(BACKSTOP_PROVIDER).sec)}` : '';
    const inGroup = new Set();
    if (directFailing.length === DIRECT_PROVIDERS.length && together(directFailing) >= t.allDirectDownSec) {
      for (const id of directFailing) inGroup.add(id);
      const left = backstopDown
        ? `the feed backstop is failing too${backstopFor}, so the gateway sees no new quakes at all; every source failing at once`
        : backstop
          ? 'the gateway sees new quakes only through the feed backstop, minutes late; three agencies failing at once'
          : 'the gateway sees no new quakes from a direct source (status.json lists no feed backstop); three agencies failing at once';
      problems.push(`all three direct providers (${DIRECT_PROVIDERS.join(', ')}) have been failing together for ${spanText(together(directFailing))} (limit ${spanText(t.allDirectDownSec)})${byCount(directFailing)}: ${left} points at the gateway's side (its egress, DNS, the Workers runtime or a deploy)`);
    } else if (directFailing.length >= 2 && together(directFailing.slice(0, 2)) >= t.twoDirectDownSec) {
      const pair = directFailing.slice(0, 2);
      for (const id of pair) inGroup.add(id);
      const left = DIRECT_PROVIDERS.filter((id) => !pair.includes(id))
        .map((id) => (durations.has(id) ? `${id}, failing too for ${spanText(durations.get(id).sec)}` : id))
        .join(', ');
      const behind = backstopDown ? `; the feed backstop is failing too${backstopFor}` : backstop ? ', with the feed backstop' : '';
      problems.push(`two of the three direct providers (${pair.join(' and ')}) have been failing together for ${spanText(together(pair))} (limit ${spanText(t.twoDirectDownSec)})${byCount(pair)}: one direct source is left (${left})${behind}`);
    }
    for (const p of providers) {
      if (!isObject(p)) continue;
      const id = typeof p.id === 'string' ? p.id : '?';
      const fails = isNum(p.consecutiveFailures) ? p.consecutiveFailures : null;
      const del = deletionsFailure(p, refMs);
      const prim = primaryFailure(p, refMs);
      tags.push(`${id}:${p.ok === false ? `FAIL(${fails ?? '?'})` : 'ok'}${prim ? `/primary-FAIL(${prim.failures})${prim.fallback ? '+summary' : ''}` : ''}${del ? `/deletions-FAIL(${del.failures})` : ''}`);
      // The primary live query (USGS FDSN): while the provider is ok on its fallback, a warning only — alerts still go
      // out, from the summary feed. While the provider fails too, the provider line below says so.
      if (prim && p.ok !== false && prim.fallback) {
        const text = `provider ${id}'s primary live query has failed ${prim.failures} time${prim.failures === 1 ? '' : 's'} in a row${prim.lasted}${prim.why}: its live events come from the summary feed (fallback: summary), up to about two minutes later`;
        if (prim.failures >= t.primaryFailures) warnings.push(`${text} (warning at ${t.primaryFailures})`);
        else notes.push(`${text} (below the warning at ${t.primaryFailures})`);
      }
      // The deletions query (USGS): judged whatever `ok` says, since it never fails the provider. A warning only — a
      // gap shorter than the gateway's 7-day deletions window recovers by itself on the next successful query.
      if (del) {
        let cursor = '';
        if (isNum(p.watermarkMs) && p.watermarkMs > 0) {
          const lagMs = Math.max(0, nowMs - p.watermarkMs);
          const lag = lagMs >= 172_800_000 ? `${(lagMs / 86_400_000).toFixed(1)} days` : `${(lagMs / 3_600_000).toFixed(1)} h`;
          cursor = lagMs > DELETIONS_MAX_WINDOW_MS
            ? `; its cursor (watermarkMs) is ${lag} old, past the gateway's 7-day deletions window: a deletion from the start of the gap is no longer asked for, and that event stays live`
            : `; its cursor (watermarkMs) is ${lag} old (the next successful query asks from there, at most 7 days back)`;
        }
        const text = `provider ${id}'s deletions query has failed ${del.failures} time${del.failures === 1 ? '' : 's'} in a row${del.lasted}${del.why}: deleted events are not being withdrawn${cursor}`;
        if (del.failures >= t.deletionsFailures) warnings.push(`${text} (warning at ${t.deletionsFailures})`);
        else notes.push(`${text} (below the warning at ${t.deletionsFailures})`);
      }
      if (p.ok !== false) continue;
      const http = isNum(p.httpStatus) ? `, last HTTP ${p.httpStatus}` : '';
      const why = failureReason(p);
      const d = streakDuration(p, refMs);
      if (!d) {
        notes.push(`provider ${id} is ok:false with no failure streak published (neither failingSinceMs nor consecutiveFailures)${http}${why}`);
        continue;
      }
      const downSec = providerDownSec(id, t);
      const count = d.measured && fails !== null ? `, ${fails} consecutive failure${fails === 1 ? '' : 's'}` : '';
      const tail = `${count}${http}${why}`;
      if (d.sec >= downSec) {
        problems.push(`provider ${id} is down: ok:false ${durationText(id, d)}, limit ${spanText(downSec)} for a provider polled every ${pollIntervalMs(id) / 1000} s${tail}`);
      } else if (d.sec >= t.providerWarnSec) {
        const consequence = inGroup.has(id)
          ? 'see the direct-provider problem above'
          : `the other providers still deliver, so alerts still go out (a quake only ${id} reports may come later)`;
        warnings.push(`provider ${id} is failing: ok:false ${durationText(id, d)}, a warning from ${spanText(t.providerWarnSec)}, down at ${spanText(downSec)}${tail}: ${consequence}`);
      } else {
        notes.push(`provider ${id} is ok:false ${durationText(id, d)}, below the warning at ${spanText(t.providerWarnSec)}, down at ${spanText(downSec)}${tail}`);
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
  //    Round-3 gateways add the per-environment key state (mode/production/sandbox/problems). configured stays
  //    true in 'split' mode even when the production key is missing, and then every production device (every
  //    App Store and TestFlight install) is skipped as skipped_no_key, so both are judged here. Older gateways
  //    omit these fields, and an absent field is never a problem.
  const apns = doc.apns;
  const splitNoProduction = isObject(apns) && apns.mode === 'split' && apns.production !== true;
  if (isObject(apns) && typeof apns.configured === 'boolean') {
    const mode = typeof apns.mode === 'string' ? `/${apns.mode}` : '';
    parts.push(`apns=${apns.configured ? 'configured' : 'DRY'}${mode}${splitNoProduction ? '/production=NO' : ''}`);
    if (!apns.configured) {
      problems.push('APNs is NOT configured on the gateway: fan-outs run DRY and no push reaches a device');
    }
  } else {
    parts.push('apns=?');
    warnings.push('apns.configured is absent: cannot tell whether real pushes are being sent');
  }
  if (isObject(apns) && Array.isArray(apns.problems) && apns.problems.length > 0) {
    problems.push(`the gateway's APNs key configuration has ${apns.problems.length} problem(s): ${apns.problems.map(String).join('; ')}. Devices in an APNs environment without a complete key get no push`);
  }
  if (splitNoProduction) {
    problems.push(`the gateway runs split per-environment keys but holds NO production key (apns.production is ${JSON.stringify(apns.production) ?? 'absent'}): every App Store and TestFlight device (push_env=production) is skipped and receives no alert`);
  }

  // 7. Fan-out counters for the current UTC day (round-3 gateways; absent or null on older ones or before the
  //    first job). Warnings only: a few skipped or dropped pushes are worth a look, not a page; the key faults
  //    that skip every production device already fail above.
  const fanout = doc.fanout;
  if (isObject(fanout)) {
    const n = (v) => (isNum(v) ? v : '?');
    parts.push(`fanout=jobs:${n(fanout.jobs)},sent:${n(fanout.sent)},no_key:${n(fanout.skipped_no_key)},dropped_budget:${n(fanout.retry_dropped_budget)}`);
    const day = typeof fanout.day === 'string' ? ` (UTC ${fanout.day})` : '';
    if (isNum(fanout.skipped_no_key) && fanout.skipped_no_key > 0) {
      warnings.push(`${fanout.skipped_no_key} device push(es) skipped today${day} because the gateway holds no APNs key for their push environment (fanout.skipped_no_key): those devices received no alert`);
    }
    if (isNum(fanout.retry_dropped_budget) && fanout.retry_dropped_budget > 0) {
      warnings.push(`${fanout.retry_dropped_budget} transient push failure(s) today${day} were dropped without a retry because the fan-out job's retry budget was spent (fanout.retry_dropped_budget)`);
    }
  } else {
    parts.push(fanout === null ? 'fanout=none' : 'fanout=n/a');
  }

  // 8. Upstream freshness (X-4 / P1 #14, round-13 gateways): the detector records when the earthquakes-feed manifest
  //    and the config bundle it last verified were generated. The age now is (now - *_generated_ms) when present, else
  //    the published *_age_s plus the document's own age. An absent field (an older gateway) skips the check; null
  //    (never read since this build deployed) is a warning.
  const freshness = (label, genKey, ageKey, limitSec, problem) => {
    if (!Object.hasOwn(doc, genKey) && !Object.hasOwn(doc, ageKey)) {
      parts.push(`${label}=n/a`);
      return;
    }
    let ageSec = null;
    if (isNum(doc[genKey])) ageSec = Math.round((nowMs - doc[genKey]) / 1000);
    else if (isNum(doc[ageKey])) ageSec = Math.round(doc[ageKey] + (isNum(doc.generatedAtMs) ? Math.max(0, nowMs - doc.generatedAtMs) / 1000 : 0));
    if (ageSec === null) {
      parts.push(`${label}=?`);
      warnings.push(`${ageKey} is null: the gateway has not read the ${label} successfully since it was deployed`);
      return;
    }
    parts.push(`${label}=${ageSec}s`);
    if (ageSec > limitSec) problems.push(problem(ageSec, limitSec));
  };
  freshness('feed_manifest', 'feed_manifest_generated_ms', 'feed_manifest_age_s', t.maxFeedManifestAgeSec, (a, l) =>
    `the earthquakes-feed manifest the gateway last read is ${Math.round(a / 60)} min old (limit ${Math.round(l / 60)} min): the feed has stopped publishing (heartbeat Worker, GH_PAT, Actions or Pages), and the alerts backstop and the app run on stale data`);
  freshness('config_bundle', 'config_bundle_generated_ms', 'config_bundle_age_s', t.maxConfigBundleAgeSec, (a, l) =>
    `the signed config bundle is ${(a / 86_400).toFixed(1)} days old (limit ${Math.round(l / 86_400)} days): its refresh has stopped, and installed apps fall back to compiled defaults once it expires`);

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
  '--provider-down-sec': 'providerDownSec',
  '--fast-provider-down-sec': 'fastProviderDownSec',
  '--two-direct-down-sec': 'twoDirectDownSec',
  '--all-direct-down-sec': 'allDirectDownSec',
  '--provider-warn-sec': 'providerWarnSec',
  '--min-headroom-pct': 'minHeadroomPct',
  '--usage-fail-pct': 'usageFailPct',
  '--max-feed-manifest-age-sec': 'maxFeedManifestAgeSec',
  '--max-config-bundle-age-sec': 'maxConfigBundleAgeSec',
  '--deletions-failures': 'deletionsFailures',
  '--primary-failures': 'primaryFailures',
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
    for (const w of verdict.warnings) summaryLines.push(`  - warning: ${w}`);
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
