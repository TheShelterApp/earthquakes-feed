// Health findings: the one shape every health evaluator emits, the one table of rule constants, and the small pure
// helpers the evaluators and scripts/reconcile.mjs share (alerting plan of 2026-10-22, section 3, with the owner's
// decisions of that day).
//
// The evaluators (scripts/alerts-watchdog.mjs --findings, scripts/feed-health.mjs, scripts/platform-watchdog.mjs
// --findings) are stateless: each judges what it reads as of one moment and writes a findings document. Everything
// that needs memory across health runs (a 2-run confirmation, 4 of the last 8 runs, a 24 h hold, resolving after 2
// healthy runs, the escalation, the P2 red hour) belongs to the reconcile job, which takes those parameters from the
// RULES entry a finding names. An evaluator therefore emits a condition below its line as a P4 "sample": a sample never
// opens a board entry by itself, but it keeps an open entry open and counts toward a ratio rule.
//
// Severity ladder: P1 page (alerts are not reaching users, or will stop within hours or days), P2 urgent (redundancy
// lost, or a symptom a fallback still covers), P3 ticket (act within days, or one external source has been out long
// enough to matter), P4 info (normal churn: a job-summary row). A run goes red for an open P1 on every run and for a P2
// during its first hour only; a single external source, a maintenance walk and the watcher itself are never red.
//
// Dependency-free (Node >= 22): the health workflow runs it without `npm ci`. Types: findings.d.mts.

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Most severe first. */
export const SEVERITIES = Object.freeze(['P1', 'P2', 'P3', 'P4']);

/** The three permanent board issues, by board id: their exact titles (reconcile finds them by label, then title). */
export const BOARDS = Object.freeze({
  alerts: '[health] alert pipeline',
  feed: '[health] feed',
  platform: '[health] platform',
});
/** The label every board issue carries; the state is read with one listing of it (`--state all`). */
export const BOARD_LABEL = 'health-board';

/**
 * What kind of thing a finding is about. `external` (one outside agency or source), `maintenance` (a background walk)
 * and `watcher` (the monitoring itself) never turn a run red, whatever their severity (NEVER_RED_CLASSES).
 *   symptom      users or alerts are affected now, or will be once something expires
 *   redundancy   a redundant set lost members, or a backstop is gone, while the rest still covers
 *   external     one external agency or feed source is failing or quiet
 *   capacity     a quota, budget or size limit is approaching
 *   expiry       something ages toward an expiry (the config bundle, a pinned certificate)
 *   config       a configuration or publishing defect (a missing key, a partial publish)
 *   maintenance  a background walk (history, first-solutions, backfill, archive) is blocked
 *   watcher      the monitoring cannot do its job (a refused token, a missing evaluator, an API error)
 *   unknown      a document could not be read, so the state behind it cannot be judged
 */
export const CLASSES = Object.freeze(['symptom', 'redundancy', 'external', 'capacity', 'expiry', 'config', 'maintenance', 'watcher', 'unknown']);
export const NEVER_RED_CLASSES = Object.freeze(['external', 'maintenance', 'watcher']);

/** The evaluator jobs of health.yml; a findings document names one of them. */
export const EVALUATORS = Object.freeze(['alerts', 'feed', 'platform']);

/**
 * Healthchecks.io checks (plan section 4). The verdict checks get /fail while an open, unmuted P1/P2 finding names
 * them and /0 otherwise, on every run; gh-aging gets /fail while any open entry has passed its escalation line;
 * health-watchdog is pinged by workflow_dispatch runs only (/0 when every evaluator produced findings); selftest by
 * the selftest run (/fail, then /0). Owner decision 2026-10-22: no push channel for now, so every ping is skipped
 * while the HC_PING_KEY secret is unset (it is), and no check needs to exist.
 */
export const VERDICT_CHECKS = Object.freeze(['gh-detect', 'gh-deliver', 'gh-redundancy', 'gh-feed', 'gh-platform', 'gh-capacity']);
export const AGING_CHECK = 'gh-aging';
export const LIVENESS_CHECK = 'health-watchdog';
export const SELFTEST_CHECK = 'selftest';
export const CHECKS = Object.freeze([LIVENESS_CHECK, ...VERDICT_CHECKS, AGING_CHECK, SELFTEST_CHECK]);
/** Ping URLs are `${HC_PING_BASE}/<HC_PING_KEY>/<check>/0|fail`: capabilities, never echoed or logged. */
export const HC_PING_BASE = 'https://hc-ping.com';

/**
 * Pushover priorities for a push channel added later (recorded only; nothing sends them today). P1: emergency (2),
 * repeated until acknowledged, a Critical Alert on the iPhone. P2: high (1), which bypasses quiet hours (owner
 * decision 2026-10-22: P2 at night breaks through).
 */
export const PUSH_PRIORITY = Object.freeze({ P1: 2, P2: 1 });

/** A P2 turns the run red during its first hour only, then the run is green with an ::error:: annotation. */
export const P2_RED_MS = HOUR;

/** health.yml's own fallback cron runs its checks only when no workflow_dispatch health run was created this recently. */
export const HEALTH_FALLBACK_CRON = '25 * * * *';
export const SCHEDULE_SKIP_MS = 20 * MIN;

/** The same agency in the gateway and in the feed: while the gateway's provider entry is open, the feed source's
 *  entry gets no comment (the alert-pipeline board already names it). */
export const AGENCY_PAIRS = Object.freeze({ usgs: 'usgs', emsc: 'emsc', gfz: 'geofon' });

/**
 * Inhibition (plan section 3b): while the `when` key is open, or present at P1-P3 in this run, the `mute` keys still
 * open and close as rows but send no comment and no ping, and cannot turn the run red. `muteMembers` mutes
 * `<prefix><member>` for every member of the inhibiting finding (a coverage finding mutes its providers: one notice per
 * group, the parent inhibits its children). A trailing `*` matches a key prefix.
 */
export const INHIBITIONS = Object.freeze([
  Object.freeze({ when: 'feed:freshness', mute: Object.freeze(['feed:source:*', 'alerts:provider:feed']) }),
  ...Object.entries(AGENCY_PAIRS).map(([gateway, feed]) => Object.freeze({ when: `alerts:provider:${gateway}`, mute: Object.freeze([`feed:source:${feed}`]) })),
  Object.freeze({ when: 'alerts:coverage:*', muteMembers: 'alerts:provider:' }),
]);

/** Findings documents (the evaluator jobs' artifacts) carry this schema id. */
export const FINDINGS_SCHEMA = 'health-findings/1';
/** The board body's hidden state marker: `<!-- health-state v1 {json} -->`. */
export const STATE_MARKER = 'health-state v1';

export const MAX_KEY_CHARS = 120;
export const MAX_TEXT_CHARS = 500;

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
};

/**
 * One rule. Reconcile parameters default to "at once": confirmRuns 1, holdMs 0, no ratio, resolve on the first run
 * without the finding, no escalation.
 */
function rule(id, r) {
  return Object.freeze({
    id,
    title: r.title,
    board: r.board,
    class: r.class,
    severity: r.severity,
    key: r.key ?? null,
    keyPrefix: r.keyPrefix ?? null,
    check: r.check ?? null,
    phase: r.phase ?? 1,
    shadow: r.shadow ?? false,
    confirmRuns: r.confirmRuns ?? 1,
    holdMs: r.holdMs ?? 0,
    ratio: r.ratio ? Object.freeze({ ...r.ratio }) : null,
    resolveRuns: r.resolveRuns ?? 1,
    resolveRunsAfterRatio: r.resolveRunsAfterRatio ?? r.resolveRuns ?? 1,
    resolveAfterMs: r.resolveAfterMs ?? 0,
    escalateAfterMs: r.escalateAfterMs ?? null,
    limits: deepFreeze({ ...(r.limits ?? {}) }),
  });
}

/** 4 of the last 8 health runs (about 2 h at the 15-min cadence) with the key present at any severity. */
const FOUR_OF_EIGHT = { min: 4, of: 8, severity: 'P3' };

/**
 * The rule table: every threshold of the plan's section 3 as adjusted by the owner on 2026-10-22, by rule id. A
 * finding names its rule; the rule's `key` (a single key) or `keyPrefix` (one key per member: `<prefix><id>`) says
 * which keys it judges. Several rules can judge one key (feed:freshness when stale or unreachable, config:bundle by age
 * or by the version gap): the board keeps one row per key, and the rule of the latest finding applies.
 *
 * Reconcile parameters (scripts/reconcile.mjs):
 *   severity       the severity the rule notifies at; an evaluator may emit P4 below its line, and another severity
 *                  where the rule says so (config:bundle P3/P2/P1, alerts:degraded forced P3)
 *   check          the verdict check a P1/P2 finding pings: one slug, or one per severity
 *   phase          1: evaluated from Phase 1a; 2: needs a gateway field (the plan's star), not emitted yet
 *   shadow         logs "would notify" only: never a comment, a ping or a red run (owner: the canary, watermark-age
 *                  and latency rules; the plan: feed:systemic)
 *   confirmRuns    consecutive runs with the finding before it takes its severity (P4 until then)
 *   holdMs         continuous presence, by reconcile's own run times, before it takes its severity (P4 until then)
 *   ratio          also enters (at ratio.severity) when present in at least `min` of the last `of` runs
 *   resolveRuns    consecutive runs without the finding that resolve an open entry (resolveRunsAfterRatio when it
 *                  entered by ratio), and absent for at least resolveAfterMs
 *   escalateAfterMs  an entry open this long, counted from its episode's start (the earliest sinceMs or first run
 *                  seen), escalates once: one board comment and gh-aging
 * `limits` are the evaluator's own thresholds.
 *
 * Not here on purpose (owner decision 2026-10-22): writer:aggregate / writer:derive. Transient publish failures of
 * aggregate.yml and derive.yml stay red runs, so those workflows are unchanged and no rule judges them.
 */
export const RULES = Object.freeze({
  // --- 3a. Alert pipeline: data.theshelter.app/alerts/status.json, board "[health] alert pipeline" ---
  'alerts:status:stale': rule('alerts:status:stale', {
    title: 'status.json stale',
    board: 'alerts', class: 'symptom', severity: 'P1', key: 'alerts:status:stale', check: 'gh-detect',
    // The detector publishes every 60 s: 5 missed publishes. While this or alerts:status:unreadable is present or
    // open, every other alerts:* key is frozen (nothing enters, nothing resolves): a stale document's fields are old.
    limits: { maxAgeMs: 300 * SEC },
  }),
  'alerts:status:unreadable': rule('alerts:status:unreadable', {
    title: 'status.json unreadable',
    // P2 in Phase 1 (nothing else sees the outage); P3 from Phase 2, when the gateway's own check owns it.
    board: 'alerts', class: 'unknown', severity: 'P2', key: 'alerts:status:unreadable', check: 'gh-platform',
    confirmRuns: 2,
    // 3 tries, all inside 60 s (fetchJson: 15 s per try, 2 s and 5 s apart).
    limits: { attempts: 3, withinMs: 60 * SEC },
  }),
  'alerts:coverage:all': rule('alerts:coverage:all', {
    title: 'all direct providers down',
    // usgs, emsc and gfz all ok:false, together (the shortest streak) at least 60 s. The evaluator emits P4 while two
    // or more fail, so the entry resolves only once at least 2 direct providers are ok.
    board: 'alerts', class: 'symptom', severity: 'P1', key: 'alerts:coverage:all', check: 'gh-detect',
    limits: { minTogetherMs: 60 * SEC },
  }),
  'alerts:coverage:two': rule('alerts:coverage:two', {
    title: 'two direct providers down',
    // Two or more direct providers ok:false together at least 180 s (120 s before the plan); resolves after 2 runs
    // with at most one failing.
    board: 'alerts', class: 'redundancy', severity: 'P2', key: 'alerts:coverage:two', check: 'gh-redundancy',
    resolveRuns: 2,
    limits: { minTogetherMs: 180 * SEC },
  }),
  'alerts:provider:fast': rule('alerts:provider:fast', {
    title: 'EMSC or GFZ failing',
    // A streak of at least 60 min whose lastError is timeout, network or http (or absent: an older gateway), or ok:false
    // in 4 of the last 8 runs. Escalation at 12 h. Resolves after 2 healthy runs, 4 when it entered by ratio.
    board: 'alerts', class: 'external', severity: 'P3', keyPrefix: 'alerts:provider:',
    ratio: FOUR_OF_EIGHT, resolveRuns: 2, resolveRunsAfterRatio: 4, escalateAfterMs: 12 * HOUR,
    limits: { ids: ['emsc', 'gfz'], lineMs: 60 * MIN, errors: ['timeout', 'network', 'http'] },
  }),
  'alerts:provider:fast:invalid': rule('alerts:provider:fast:invalid', {
    title: 'EMSC or GFZ answering invalid bodies',
    // lastError invalid (a body that does not parse or verify): the only non-transient class until the gateway
    // publishes the failing HTTP status inside the streak. 15 min line, escalation at 2 h.
    board: 'alerts', class: 'external', severity: 'P3', keyPrefix: 'alerts:provider:',
    ratio: FOUR_OF_EIGHT, resolveRuns: 2, resolveRunsAfterRatio: 4, escalateAfterMs: 2 * HOUR,
    limits: { ids: ['emsc', 'gfz'], lineMs: 15 * MIN, errors: ['invalid'] },
  }),
  'alerts:provider:usgs': rule('alerts:provider:usgs', {
    title: 'USGS failing',
    // ok:false means ComCat FDSN and the summary feed both fail. 30 min, or 4 of 8 runs; escalation at 2 h.
    board: 'alerts', class: 'external', severity: 'P3', key: 'alerts:provider:usgs',
    ratio: FOUR_OF_EIGHT, resolveRuns: 2, resolveRunsAfterRatio: 4, escalateAfterMs: 2 * HOUR,
    limits: { lineMs: 30 * MIN },
  }),
  'alerts:usgs:primary': rule('alerts:usgs:primary', {
    title: 'USGS on its summary-feed fallback',
    // primaryFailingSinceMs at least 6 h while the summary fallback serves (P4 below).
    board: 'alerts', class: 'external', severity: 'P3', key: 'alerts:usgs:primary',
    resolveRuns: 2,
    limits: { lineMs: 6 * HOUR },
  }),
  'alerts:usgs:deletions': rule('alerts:usgs:deletions', {
    title: 'USGS deletions query failing',
    // deletionsFailingSinceMs at least 24 h; escalation at 5 d, before the gateway's 7-day withdrawal window ends.
    board: 'alerts', class: 'external', severity: 'P3', key: 'alerts:usgs:deletions',
    resolveRuns: 2, escalateAfterMs: 5 * DAY,
    limits: { lineMs: 24 * HOUR, windowMs: 7 * DAY },
  }),
  'alerts:provider:feed': rule('alerts:provider:feed', {
    title: 'gateway feed backstop failing',
    // The backstop ok:false at least 30 min. Muted while feed:freshness is open (INHIBITIONS).
    board: 'alerts', class: 'redundancy', severity: 'P3', key: 'alerts:provider:feed',
    resolveRuns: 2,
    limits: { lineMs: 30 * MIN },
  }),
  'alerts:provider-silent': rule('alerts:provider-silent', {
    title: 'direct provider ok but its watermark old',
    // Shadow. ok:true, watermarkMs older than the line (usgs and emsc: the newest M4+ update; gfz: the newest M4+
    // origin, normally hours old). Not for the feed, nor for usgs while its deletions query fails (that holds its
    // watermark still). Lines to be calibrated from the run logs.
    board: 'alerts', class: 'external', severity: 'P3', keyPrefix: 'alerts:provider-silent:', shadow: true,
    limits: { watermarkMaxAgeMs: { usgs: 3 * HOUR, emsc: 3 * HOUR, gfz: 12 * HOUR } },
  }),
  'alerts:latency': rule('alerts:latency', {
    title: 'provider slow',
    // Shadow. latencyMs over 3,000 in 4 of the last 8 runs (each run over the line is a P4 sample).
    board: 'alerts', class: 'external', severity: 'P4', keyPrefix: 'alerts:latency:', shadow: true,
    ratio: { min: 4, of: 8, severity: 'P4' }, resolveRunsAfterRatio: 4,
    limits: { maxLatencyMs: 3_000 },
  }),
  'alerts:budget': rule('alerts:budget', {
    title: 'free-tier budget projected over the line',
    // The tightest of the gateway's five daily ratios (its own estimates, not Cloudflare billing), projected to the
    // end of the UTC day (ratio / fraction of the day passed), only from 02:00 UTC: P2 at 0.75; P4 from 0.65 (the
    // band that keeps an open entry open); absent below 0.65 or on a new UTC day.
    board: 'alerts', class: 'capacity', severity: 'P2', key: 'alerts:budget', check: 'gh-capacity',
    limits: {
      enterShare: 0.75,
      resolveShare: 0.65,
      projectFromMs: 2 * HOUR,
      // alerts-gateway src/status/budget.ts FREE_TIER, by status.json budget field.
      caps: { doRequests: 100_000, d1Reads: 5_000_000, doRowsRead: 5_000_000, doRowsWritten: 100_000, doGbSec: 13_000 },
    },
  }),
  'alerts:degraded': rule('alerts:degraded', {
    title: 'degradation ladder active',
    // degraded.active and not forced: P1. Forced by hand: a P3 reminder that an override is on.
    board: 'alerts', class: 'symptom', severity: 'P1', key: 'alerts:degraded', check: 'gh-deliver',
  }),
  'alerts:policy': rule('alerts:policy', {
    title: 'compiled fallback policy',
    board: 'alerts', class: 'symptom', severity: 'P1', key: 'alerts:policy', check: 'gh-deliver',
  }),
  'alerts:apns': rule('alerts:apns', {
    title: 'APNs',
    // P1: not configured, apns.problems not empty, or split mode without production. P3: today's skipped_no_key > 0
    // with production present, or retry_dropped_budget > 0 (cleared by the next UTC day).
    board: 'alerts', class: 'symptom', severity: 'P1', key: 'alerts:apns', check: 'gh-deliver',
  }),
  'alerts:canary': rule('alerts:canary', {
    title: 'detection canary',
    // Shadow. USGS 4.5_hour lists an event 10-60 min old (every one is above the M4.0 floor), status.json is fresh,
    // and lastEvent.atMs (a detection time) is older than that event's origin: a full detection stall.
    board: 'alerts', class: 'symptom', severity: 'P4', key: 'alerts:canary', shadow: true,
    limits: { minEventAgeMs: 10 * MIN, maxEventAgeMs: 60 * MIN, url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_hour.geojson' },
  }),
  'alerts:dispatch': rule('alerts:dispatch', {
    title: 'dispatch outbox stuck',
    // Phase 2 (needs dispatch {pending, oldestAgeSec, failedTicks}); the gateway's own gw-deliver check pings it.
    board: 'alerts', class: 'symptom', severity: 'P1', key: 'alerts:dispatch', phase: 2,
    limits: { maxOldestAgeMs: 120 * SEC, maxFailedTicks: 4, resolveOldestAgeMs: 30 * SEC },
  }),
  'alerts:fanout': rule('alerts:fanout', {
    title: 'fan-out failing',
    // Phase 2 (needs fanout.failedByReason): lastJob.status 'failed', any InvalidProviderToken, or failed / (sent +
    // failed) over 20 % in a job with at least 10 targets.
    board: 'alerts', class: 'symptom', severity: 'P1', key: 'alerts:fanout', phase: 2,
    limits: { maxFailedShare: 0.2, minTargets: 10 },
  }),
  'alerts:selftest': rule('alerts:selftest', {
    title: 'selftest',
    // The watchdog selftest (health.yml input watchdog_selftest, and the monthly selftest cron): a forced P1 that
    // must turn the run red. Never stored on a board; pings `selftest` /fail, then /0.
    board: 'alerts', class: 'symptom', severity: 'P1', key: 'alerts:selftest', check: SELFTEST_CHECK,
  }),

  // --- 3b. Feed: board "[health] feed" ---
  'feed:freshness': rule('feed:freshness', {
    title: 'feed manifest stale',
    // The older of the live v1/manifest.json and v2/manifest.json (the signed one the gateway's backstop reads) past
    // freshness.stale_after_seconds, confirmed by a re-read 60 s later (one re-read also when the run itself queued
    // over 10 min). While open it mutes feed:source:* and alerts:provider:feed.
    board: 'feed', class: 'symptom', severity: 'P2', key: 'feed:freshness', check: 'gh-feed',
    limits: { defaultStaleAfterMs: 1_800 * SEC, reReadAfterMs: 60 * SEC, queueReReadMs: 600 * SEC },
  }),
  'feed:freshness:unreachable': rule('feed:freshness:unreachable', {
    title: 'feed manifest unreachable',
    // Either manifest unreachable after its retries (or v2's payload unreadable): P4 on the first run, P2 on the second.
    board: 'feed', class: 'unknown', severity: 'P2', key: 'feed:freshness', check: 'gh-feed',
    confirmRuns: 2,
    limits: { attempts: 4, retryDelayMs: 3 * SEC, timeoutMs: 20 * SEC },
  }),
  'feed:systemic': rule('feed:systemic', {
    title: 'feed coverage lost',
    // Shadow. Two or more of usgs, emsc and geofon, or six or more sources, each failing continuously for at least
    // 30 min (from lastSuccessAt). Replaces the 13-of-42 one-run line, never reached in 2,493 runs.
    board: 'feed', class: 'redundancy', severity: 'P2', key: 'feed:systemic', check: 'gh-feed', shadow: true,
    resolveAfterMs: 30 * MIN,
    limits: { coreIds: ['usgs', 'emsc', 'geofon'], coreMin: 2, anyMin: 6, continuousMs: 30 * MIN },
  }),
  'feed:status': rule('feed:status', {
    title: 'feed status.json unreadable',
    board: 'feed', class: 'unknown', severity: 'P3', key: 'feed:status',
    confirmRuns: 2,
  }),
  'feed:source': rule('feed:source', {
    title: 'feed source failing',
    // One row per source (fetch failure, silent and frozen merged). A source other than the core three, failing
    // with a transient class: 12 h from lastSuccessAt. Absent (resolved) once lastSuccessAt is within 30 min.
    board: 'feed', class: 'external', severity: 'P3', keyPrefix: 'feed:source:',
    limits: { lineMs: 12 * HOUR, resolveWithinMs: 30 * MIN },
  }),
  'feed:source:core': rule('feed:source:core', {
    title: 'core feed source failing',
    board: 'feed', class: 'external', severity: 'P3', keyPrefix: 'feed:source:',
    escalateAfterMs: 24 * HOUR,
    limits: { ids: ['usgs', 'emsc', 'geofon'], lineMs: 3 * HOUR, resolveWithinMs: 30 * MIN },
  }),
  'feed:source:definite': rule('feed:source:definite', {
    title: 'feed source failing with a definite error',
    // Non-transient: http_status 401/403/404/410, error.kind 'schema', or a TLS failure (from error.message or the
    // source's tls_errors entry: error.kind files TLS under 'error'). 2 h line, escalation at 24 h.
    board: 'feed', class: 'external', severity: 'P3', keyPrefix: 'feed:source:',
    escalateAfterMs: 24 * HOUR,
    limits: { lineMs: 2 * HOUR, httpStatuses: [401, 403, 404, 410], errorKinds: ['schema'], resolveWithinMs: 30 * MIN },
  }),
  'feed:source:quiet': rule('feed:source:quiet', {
    title: 'feed source silent or frozen',
    // status.json silent / frozen: the aggregate's activity and frozen budgets (src/activity.ts) already applied.
    board: 'feed', class: 'external', severity: 'P3', keyPrefix: 'feed:source:',
  }),
  'feed:cert': rule('feed:cert', {
    title: 'pinned certificate expiring',
    // A pinned leaf with under 7 days left (sinceMs = notAfter - 7 d); escalation 5 d later, at 2 days left. A fetch
    // that fails on a certificate is feed:source:definite.
    board: 'feed', class: 'expiry', severity: 'P3', keyPrefix: 'feed:cert:',
    escalateAfterMs: 5 * DAY,
    limits: { leafLineMs: 7 * DAY },
  }),
  'feed:size': rule('feed:size', {
    title: 'data file over its size line',
    board: 'feed', class: 'capacity', severity: 'P3', key: 'feed:size',
    limits: { dayFileBytes: 5_000_000, fileBytes: 45_000_000 },
  }),
  'feed:repo-size': rule('feed:repo-size', {
    title: 'repository size',
    board: 'feed', class: 'capacity', severity: 'P3', key: 'feed:repo-size',
    // GitHub reports `size` in KB; 8 GB, under GitHub's recommended 10 GB.
    limits: { maxKb: 8_000_000 },
  }),
  'walks': rule('walks', {
    title: 'maintenance walk blocked',
    // A blocked marker of history, first-solutions, backfill or archive (those runs stay green with a ::warning:: and
    // upload the marker as artifact walk-blocked-<workflow>). Key walks:<workflow>:<source>. The walks alarm about
    // once a day, so a marker counts for 26 h: the walk has moved on when no marker is newer than that.
    board: 'feed', class: 'maintenance', severity: 'P3', keyPrefix: 'walks:',
    limits: { workflows: ['history', 'first-solutions', 'backfill', 'archive'], artifactPrefix: 'walk-blocked-', markerHoldMs: 26 * HOUR },
  }),

  // --- 3c. Platform and config: board "[health] platform" ---
  'platform:api': rule('platform:api', {
    title: 'API down',
    // /v1/health not 200 ok:true after 3 tries spread over at least 60 s, or signing with an ephemeral session key.
    board: 'platform', class: 'symptom', severity: 'P2', key: 'platform:api', check: 'gh-platform',
    limits: { attempts: 3, spreadMs: 60 * SEC },
  }),
  'platform:api:envelope': rule('platform:api:envelope', {
    title: 'API provider-token envelope key missing',
    board: 'platform', class: 'config', severity: 'P3', key: 'platform:api:envelope',
  }),
  'platform:config-worker': rule('platform:config-worker', {
    title: 'config Worker down',
    // /healthz not 200 ok:true: apps keep their last good config. Escalation at 6 h.
    board: 'platform', class: 'symptom', severity: 'P3', key: 'platform:config-worker',
    escalateAfterMs: 6 * HOUR,
  }),
  'config:bundle:age': rule('config:bundle:age', {
    title: 'config bundle old',
    // The older of the data copy (status.json config_bundle_age_s, what apps and the gateway load) and the signed
    // policy (config_policy_age_s): over 5 d P3, over 10 d P2, over 25 d P1 (the bundle expires at 30 d).
    board: 'platform', class: 'expiry', severity: 'P3', key: 'config:bundle', check: { P1: 'gh-deliver', P2: 'gh-platform' },
    limits: { p3AgeMs: 5 * DAY, p2AgeMs: 10 * DAY, p1AgeMs: 25 * DAY, expiresMs: 30 * DAY },
  }),
  'config:bundle:gap': rule('config:bundle:gap', {
    title: 'config partial publish',
    // The data copy's config_bundle_version behind the version config.theshelter.app/healthz serves for over 24 h:
    // an upload that stopped partway (2026-10-19, v65/v66).
    board: 'platform', class: 'config', severity: 'P3', key: 'config:bundle',
    holdMs: 24 * HOUR,
  }),
  'platform:cf-usage': rule('platform:cf-usage', {
    title: 'Cloudflare account usage',
    // Only with the CF_ANALYTICS_TOKEN secret (unset today). Workers requests and D1 rows written against the Workers
    // Free daily caps: P1 at 95 % actual; P2 at 80 % actual or 100 % projected from 02:00 UTC; P4 from 70 % (the band
    // that keeps an open entry open); absent below 70 % or on a new UTC day.
    board: 'platform', class: 'capacity', severity: 'P2', key: 'platform:cf-usage', check: { P1: 'gh-deliver', P2: 'gh-capacity' },
    limits: { p1ActualShare: 0.95, p2ActualShare: 0.8, p2ProjectedShare: 1, resolveShare: 0.7, projectFromMs: 2 * HOUR, caps: { workersRequests: 100_000, d1RowsWritten: 100_000 } },
  }),
  'watcher': rule('watcher', {
    title: 'watcher fault',
    // The monitoring itself: a refused or misconfigured token (alerts-watchdog exit 3), usage-query errors, GitHub API
    // errors, an evaluator that produced no findings. P3 after 2 runs, never red. HC_PING_KEY unset is NOT a fault
    // (owner decision 2026-10-22: no push channel for now).
    board: 'platform', class: 'watcher', severity: 'P3', keyPrefix: 'watcher:',
    confirmRuns: 2,
  }),
});

/** Severity rank: 1 for P1 (most severe) ... 4 for P4; Infinity for anything else. */
export function severityRank(s) {
  const i = SEVERITIES.indexOf(s);
  return i < 0 ? Infinity : i + 1;
}

/** Whether `a` is strictly more severe than `b` (a missing `b` is less severe than any severity). */
export function moreSevere(a, b) {
  return severityRank(a) < severityRank(b);
}

/** The more severe of the severities given (P4 when none). */
export function worstSeverity(...list) {
  let worst = 'P4';
  for (const s of list) if (moreSevere(s, worst)) worst = s;
  return worst;
}

/** Whether a finding of this class may turn a run red at all. */
export function mayTurnRed(cls) {
  return !NEVER_RED_CLASSES.includes(cls);
}

/** `pattern` matches `key` exactly, or as a prefix when it ends with `*`. */
export function matchesKey(pattern, key) {
  if (typeof pattern !== 'string' || typeof key !== 'string') return false;
  return pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern;
}

/** The check a rule's finding pings at `severity`: a P1/P2 only; one slug, or the slug of that severity. */
export function checkFor(r, severity) {
  if (!r || !r.check) return null;
  if (typeof r.check === 'string') return severity === 'P1' || severity === 'P2' ? r.check : null;
  return r.check[severity] ?? null;
}

/** The RULES entry of a finding (by its `rule`), or null. */
export function ruleOf(finding) {
  return finding && typeof finding.rule === 'string' && Object.hasOwn(RULES, finding.rule) ? RULES[finding.rule] : null;
}

/** Whether a rule judges `key`: its single key, or `<keyPrefix><member>` with a non-empty member. */
export function ruleJudgesKey(r, key) {
  if (!r || typeof key !== 'string') return false;
  if (r.key !== null) return key === r.key;
  return r.keyPrefix !== null && key.startsWith(r.keyPrefix) && key.length > r.keyPrefix.length;
}

/** "45 s", "3.5 min", "2.6 h", "4.4 d". Rounds down, so a span short of a line never reads as the line. */
export function ageText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '?';
  const s = Math.max(0, ms) / SEC;
  if (s < 120) return `${Math.floor(s)} s`;
  if (s < 7_200) return `${Math.floor(s / 30) / 2} min`;
  if (s < 172_800) return `${(Math.floor(s / 360) / 10).toFixed(1)} h`;
  return `${(Math.floor(s / 8_640) / 10).toFixed(1)} d`;
}

/** "2026-10-21 12:50Z" (UTC, to the minute); '?' for a missing or bad time. */
export function utcText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '?';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '?' : `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/**
 * Untrusted text (an upstream error message, a marker line) as one line: no control characters or backticks, spaces
 * collapsed, at most `max` characters (cut with an ellipsis).
 */
export function oneLine(x, max = 240) {
  const s = String(x ?? '').replace(/[\u0000-\u001f\u007f`]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…` : s;
}

const KEY_RE = /^[a-z0-9][a-z0-9._:-]*$/;

/**
 * Build a finding of rule `ruleId`. `id` makes the key of a per-member rule (`<keyPrefix><id>`); `severity` defaults to
 * the rule's; `check` to the rule's check for that severity. board, class and shadow always come from the rule.
 * Throws a TypeError on an unknown rule or a finding that would not validate (an evaluator bug must crash its job,
 * which reconcile then reports, rather than write a document it rejects).
 * @returns {import('./findings.d.mts').Finding}
 */
export function makeFinding(ruleId, { id, key, severity, sinceMs = null, text, members, check } = {}) {
  if (!Object.hasOwn(RULES, ruleId)) throw new TypeError(`makeFinding: unknown rule ${JSON.stringify(ruleId)}`);
  const r = RULES[ruleId];
  const k = key ?? (r.key !== null ? r.key : `${r.keyPrefix}${id ?? ''}`);
  const sev = severity ?? r.severity;
  const f = {
    key: k,
    rule: ruleId,
    board: r.board,
    severity: sev,
    class: r.class,
    sinceMs: typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? sinceMs : null,
    text: oneLine(text, MAX_TEXT_CHARS),
    check: check === undefined ? checkFor(r, sev) : check,
    shadow: r.shadow,
  };
  if (members !== undefined) f.members = [...members].map((m) => oneLine(m, 120));
  const errors = validateFinding(f);
  if (errors.length > 0) throw new TypeError(`makeFinding(${ruleId}): ${errors.join('; ')}`);
  return f;
}

/** Every reason `f` is not a valid finding (empty when it is). */
export function validateFinding(f) {
  const errors = [];
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return ['not an object'];
  const r = ruleOf(f);
  if (!r) errors.push(`unknown rule ${JSON.stringify(f.rule)}`);
  if (typeof f.key !== 'string' || !KEY_RE.test(f.key) || f.key.length > MAX_KEY_CHARS) errors.push(`bad key ${JSON.stringify(f.key)}`);
  else if (r && !ruleJudgesKey(r, f.key)) errors.push(`rule ${r.id} does not judge key ${f.key}`);
  if (!SEVERITIES.includes(f.severity)) errors.push(`bad severity ${JSON.stringify(f.severity)}`);
  if (!Object.hasOwn(BOARDS, f.board)) errors.push(`bad board ${JSON.stringify(f.board)}`);
  else if (r && f.board !== r.board) errors.push(`board ${f.board} is not rule ${r.id}'s (${r.board})`);
  if (!CLASSES.includes(f.class)) errors.push(`bad class ${JSON.stringify(f.class)}`);
  else if (r && f.class !== r.class) errors.push(`class ${f.class} is not rule ${r.id}'s (${r.class})`);
  if (f.sinceMs !== null && (typeof f.sinceMs !== 'number' || !Number.isFinite(f.sinceMs))) errors.push('sinceMs is neither null nor a finite number');
  if (typeof f.text !== 'string' || f.text.trim() === '' || f.text.length > MAX_TEXT_CHARS) errors.push('text is empty or too long');
  if (f.check !== null && !CHECKS.includes(f.check)) errors.push(`bad check ${JSON.stringify(f.check)}`);
  if (typeof f.shadow !== 'boolean') errors.push('shadow is not a boolean');
  else if (r && f.shadow !== r.shadow) errors.push(`shadow ${f.shadow} is not rule ${r.id}'s`);
  if (f.members !== undefined && (!Array.isArray(f.members) || f.members.some((m) => typeof m !== 'string'))) errors.push('members is not a list of strings');
  return errors;
}

/**
 * The document an evaluator writes (its job's artifact). `unjudged` lists key patterns (exact, or a prefix ending in
 * `*`) the evaluator could not judge this run (an unreadable input): reconcile freezes those entries instead of
 * resolving them. A key that is also present in `findings` is judged present.
 * Throws a TypeError on an invalid finding or evaluator.
 */
export function findingsDocument({ evaluator, generatedAtMs, findings, unjudged = [], notes = [] }) {
  const doc = { schema: FINDINGS_SCHEMA, evaluator, generatedAtMs, findings: [...findings], unjudged: [...unjudged], notes: notes.map((n) => oneLine(n, MAX_TEXT_CHARS)) };
  const r = parseFindingsDocument(doc);
  if (!r.ok) throw new TypeError(`findingsDocument: ${r.error}`);
  return doc;
}

/**
 * Validate a parsed findings document (reconcile's input). One invalid finding rejects the whole document: dropping it
 * would read as "absent" and could resolve an open entry. The evaluator is then treated as missing for this run.
 * @returns {{ ok: true, doc: import('./findings.d.mts').FindingsDocument } | { ok: false, error: string }}
 */
export function parseFindingsDocument(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'not an object' };
  if (value.schema !== FINDINGS_SCHEMA) return { ok: false, error: `schema is ${JSON.stringify(value.schema)}, not ${FINDINGS_SCHEMA}` };
  if (!EVALUATORS.includes(value.evaluator)) return { ok: false, error: `unknown evaluator ${JSON.stringify(value.evaluator)}` };
  if (typeof value.generatedAtMs !== 'number' || !Number.isFinite(value.generatedAtMs)) return { ok: false, error: 'generatedAtMs is not a finite number' };
  if (!Array.isArray(value.findings)) return { ok: false, error: 'findings is not a list' };
  for (const [i, f] of value.findings.entries()) {
    const errors = validateFinding(f);
    if (errors.length > 0) return { ok: false, error: `finding ${i} (${typeof f?.key === 'string' ? f.key : '?'}): ${errors.join('; ')}` };
  }
  const strings = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  if (!strings(value.unjudged)) return { ok: false, error: 'unjudged is not a list of strings' };
  if (!strings(value.notes)) return { ok: false, error: 'notes is not a list of strings' };
  return { ok: true, doc: value };
}
