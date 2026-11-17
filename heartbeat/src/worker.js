// Cloudflare Worker cron: drive the GitHub workflows GitHub itself throttles.
// Exactly one dispatch per (workflow, intended UTC minute): Cron Triggers can fire a minute more than once (2026-10-14:
// twice a minute, 30 s apart), so every activation claims its minute in the dispatch ledger first (ledger.js).
// ONE per-minute trigger, fanned out by the scheduled UTC minute (and, for the daily jobs, the hour). The schedules never
// share a minute, so this reproduces the old three-cron behaviour EXACTLY while spending a single cron trigger
// (the account is capped at 5 cron triggers on the Workers free tier):
//   minute % 5 === 0     -> aggregate (keep the feed fresh, every 5 min)
//   minute 7,22,37,52    -> health    (watchdog every 15 min; offset so it never lands on aggregate)
//   minute 41            -> backfill  (walk history backward, hourly)
//   minute 48            -> first-solutions (earliest-solutions side index, hourly; dispatched with tick=1, so
//                           the workflow goes ahead only while the repository variable FIRST_SOLUTIONS_SCHEDULE
//                           is `on`; its own hourly GitHub cron was delivered about 4 times a day on 2026-10-01)
//   minute 26            -> history   (deep-history walk, hourly; no inputs: the workflow's own first step reads
//                           providers/history.json and does nothing unless `enabled` is true. Its :29 GitHub cron was
//                           not delivered once between 2026-10-01 16:54 and 21:00 UTC. :26 is after the
//                           first-solutions collect job, which shares the walk's group `earthquakes-feed-history`
//                           and ends by about :22, and its run is over before :48; history.yml as a workflow is in
//                           no writer group, so a dispatch never queues beside aggregate, derive or backfill)
//   00:31, 06:31 UTC     -> state-backup (the state store's daily off-Cloudflare copy; no inputs). Twice a day: the
//                           backup is idempotent (a second run finds every day done, lists Releases and renews its
//                           marker). feed:state-backup ages the marker's newest day from its 00:00 UTC and goes P2 at
//                           36 h, i.e. at 12:00 UTC of the next day; with one dispatch a day a single lost dispatch or
//                           failed run (a GitHub 5xx, a skipped or more than an hour late activation, a transient store
//                           503, a Releases upload error) kept that day out until the next day's run, 12 h past the
//                           line. 06:31 retries the day 5.5 h before it (a whole backup takes minutes)
//   03:33 UTC            -> state-gc  (the state store's daily garbage collection; dispatched with tick=1, so the run
//                           is the scheduled run: STATE_GC_SCHEDULED decides dry run or delete, never the dispatch's
//                           dry_run default; it still passes the writer-queue gate and holds the writer lock)
//   Both daily jobs keep their own GitHub crons (00:41, 03:23) as the fallback for a Worker outage: GitHub delivered
//   neither on 2026-11-16 or 11-17 (it delays or drops this repository's schedules; remediate's 04:43 ran at 13:10).
//   A day with more runs is harmless: the backup never clobbers and skips every day that already has its asset, and a
//   second GC pass finds nothing new to delete. :31 and :33 are minutes no other workflow uses (no multiple of 5, none
//   of 7/22/26/37/41/48/52), so the ledger's (workflow, minute) claim is unchanged. 00:31, not earlier: the backup
//   archives the last data commit before 00:00 (GitHub's commits ?until=), and the 23:55 aggregate run can sit queued
//   behind the writer group and push after midnight; an archive is never replaced, so the first run of the day must
//   come after that push (31 minutes of margin; the old cron's 00:41 had 41). :33 is after the backup's catch-up.
//
// health used to run on a bare hourly GitHub cron and was delivered ~20 times per 48h with
// gaps of 2-4.5h. The 2026-07-31 12:02-12:30 Cloudflare Pages outage (522 on /pages/assets/
// upload, 5 red derive runs, Pages copy 33 min stale — past the 30-min contract) fell entirely
// inside the 11:01 -> 13:09 gap, so nothing was ever reported.
const REPO = 'TheShelterApp/earthquakes-feed';

/** The daily dispatches: [UTC hour, minute, workflow]. Their minutes are used by nothing hourly. */
export const DAILY = Object.freeze([
  Object.freeze([0, 31, 'state-backup.yml']),
  Object.freeze([3, 33, 'state-gc.yml']),
  Object.freeze([6, 31, 'state-backup.yml']),
]);

/**
 * The workflow to dispatch for a given UTC hour and minute, or null on the ~41 minutes/hour that do nothing.
 * Pure + exported so the fan-out can be unit-checked without the runtime. The order matters only if the
 * ranges overlapped — they don't (26, 31, 33, 41, 48 and 7/22/37/52 are never multiples of 5) — but the specific minutes
 * are matched before the every-5 fallback for clarity.
 */
export function workflowFor(minute, hour) {
  for (const [h, m, workflow] of DAILY) if (hour === h && minute === m) return workflow;
  if (minute === 41) return 'backfill.yml';
  if (minute === 48) return 'first-solutions.yml';
  if (minute === 26) return 'history.yml';
  if (minute === 7 || minute === 22 || minute === 37 || minute === 52) return 'health.yml';
  if (minute % 5 === 0) return 'aggregate.yml';
  return null;
}

/**
 * The `inputs` of a dispatch, or null for none. GitHub refuses inputs a workflow does not declare, so only the workflow
 * that declares `tick` gets it.
 */
export function inputsFor(workflow) {
  return workflow === 'first-solutions.yml' || workflow === 'state-gc.yml' ? { tick: '1' } : null;
}

// GitHub answers a dispatch in well under a second; the timeout bounds how long a claim can be in flight, so a failed
// dispatch has released its claim long before the next duplicate activation of the minute (30 s apart on 2026-10-14).
// AbortController + clearTimeout, not AbortSignal.timeout: a pending timer would keep the invocation open.
const DISPATCH_TIMEOUT_MS = 10_000;

async function dispatch(env, workflow) {
  const inputs = inputsFor(workflow);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GH_PAT}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'earthquakes-feed-heartbeat',
        'content-type': 'application/json',
      },
      body: JSON.stringify(inputs ? { ref: 'main', inputs } : { ref: 'main' }),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} ${(await res.text()).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The intended UTC minute of an activation, in epoch minutes: every activation of the same tick maps to it. */
export function minuteOf(scheduledTime) {
  return Math.floor(scheduledTime / 60_000);
}

/** The one dispatch ledger (heartbeat/src/ledger.js, Durable Object class DispatchLedger in index.js). */
export const LEDGER_NAME = 'dispatch-ledger';

/**
 * One cron activation: claim (workflow, minute) in the ledger, dispatch only if this activation won the claim, and
 * release the claim when the dispatch fails so a later activation of the same minute may retry. Logs one line per
 * activation of a dispatch minute: `dispatch ...`, `skip ...: duplicate|stale` or `dispatch failed ...`.
 *
 * If the ledger itself cannot be reached the Worker dispatches anyway (fail open): the feed's freshness must not depend
 * on the ledger, and the worst case is the pre-ledger behaviour (a duplicate dispatch while Cloudflare duplicates).
 */
export async function tick(scheduledTime, env) {
  const at = new Date(scheduledTime);
  const workflow = workflowFor(at.getUTCMinutes(), at.getUTCHours());
  if (!workflow) return;
  const minute = minuteOf(scheduledTime);
  const what = `${workflow} ${new Date(minute * 60_000).toISOString().slice(0, 16)}Z (scheduledTime ${new Date(scheduledTime).toISOString()})`;
  let claim = null;
  try {
    const ledger = env.DISPATCH_LEDGER.get(env.DISPATCH_LEDGER.idFromName(LEDGER_NAME));
    const verdict = await ledger.claim(workflow, minute);
    if (verdict !== 'claimed') {
      console.log(`skip ${what}: ${verdict}`);
      return;
    }
    claim = ledger;
  } catch (err) {
    console.error(`ledger unavailable, dispatching unguarded ${what}: ${err}`);
  }
  try {
    await dispatch(env, workflow);
  } catch (err) {
    if (claim) {
      try {
        await claim.release(workflow, minute);
      } catch (releaseErr) {
        console.error(`release failed ${what}: ${releaseErr}`);
      }
    }
    console.error(`dispatch failed ${what}: ${err}`);
    throw err;
  }
  console.log(`dispatch ${what}`);
}

export default {
  async scheduled(event, env) {
    // Use scheduledTime (the INTENDED tick), not Date.now(), so late delivery never shifts the minute.
    await tick(event.scheduledTime, env);
  },
  // No HTTP surface. The old "GET dispatches aggregate" test hook was reachable on the public workers.dev URL
  // with no auth: every GET spent a GitHub API call, burned a Worker request against the account-wide free-tier
  // cap, and — because aggregate/derive/backfill/archive share one concurrency group — a loop of GETs kept
  // cancelling the pending feed runs. Manual dispatch is `gh workflow run aggregate.yml`.
  async fetch() {
    return new Response('not found\n', { status: 404 });
  },
};
