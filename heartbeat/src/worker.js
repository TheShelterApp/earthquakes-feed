// Cloudflare Worker cron: drive the GitHub workflows GitHub itself throttles.
// ONE per-minute trigger, fanned out by the scheduled minute. The three schedules never share a
// minute, so this reproduces the old three-cron behaviour EXACTLY while spending a single cron trigger
// (the account is capped at 5 cron triggers on the Workers free tier):
//   minute % 5 === 0     -> aggregate (keep the feed fresh, every 5 min)
//   minute 7,22,37,52    -> health    (watchdog every 15 min; offset so it never lands on aggregate)
//   minute 41            -> backfill  (walk history backward, hourly)
//
// health used to run on a bare hourly GitHub cron and was delivered ~20 times per 48h with
// gaps of 2-4.5h. The 2026-07-31 12:02-12:30 Cloudflare Pages outage (522 on /pages/assets/
// upload, 5 red derive runs, Pages copy 33 min stale — past the 30-min contract) fell entirely
// inside the 11:01 -> 13:09 gap, so nothing was ever reported.
const REPO = 'TheShelterApp/earthquakes-feed';

/**
 * The workflow to dispatch for a given UTC minute, or null on the ~43 minutes/hour that do nothing.
 * Pure + exported so the fan-out can be unit-checked without the runtime. The order matters only if the
 * ranges overlapped — they don't (41 and 7/22/37/52 are never multiples of 5) — but the specific minutes
 * are matched before the every-5 fallback for clarity.
 */
export function workflowFor(minute) {
  if (minute === 41) return 'backfill.yml';
  if (minute === 7 || minute === 22 || minute === 37 || minute === 52) return 'health.yml';
  if (minute % 5 === 0) return 'aggregate.yml';
  return null;
}

async function dispatch(env, workflow) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_PAT}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'earthquakes-feed-heartbeat',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (!res.ok) {
    console.error(`dispatch ${workflow} failed: ${res.status} ${await res.text()}`);
    throw new Error(`dispatch ${res.status}`);
  }
}

export default {
  async scheduled(event, env, ctx) {
    // Use scheduledTime (the INTENDED tick), not Date.now(), so late delivery never shifts the minute.
    const workflow = workflowFor(new Date(event.scheduledTime).getUTCMinutes());
    if (workflow) ctx.waitUntil(dispatch(env, workflow));
  },
  // Manual trigger for testing: GET the worker URL dispatches aggregate.
  async fetch(_req, env) {
    try {
      await dispatch(env, 'aggregate.yml');
      return new Response('aggregate dispatched\n');
    } catch (e) {
      return new Response(`error: ${e.message}\n`, { status: 502 });
    }
  },
};
