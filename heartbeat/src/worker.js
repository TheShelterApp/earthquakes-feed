// Cloudflare Worker cron: drive the GitHub workflows GitHub itself throttles.
//   */5 * * * *        -> aggregate (keep the feed fresh)
//   41 * * * *         -> backfill  (walk history backward, hourly)
//   7,22,37,52 * * * * -> health    (watchdog; offset so it never lands on aggregate's tick)
//
// health used to run on a bare hourly GitHub cron and was delivered ~20 times per 48h with
// gaps of 2-4.5h. The 2026-07-31 12:02-12:30 Cloudflare Pages outage (522 on /pages/assets/
// upload, 5 red derive runs, Pages copy 33 min stale — past the 30-min contract) fell entirely
// inside the 11:01 -> 13:09 gap, so nothing was ever reported.
const REPO = 'TheShelterApp/earthquakes-feed';

/** Which workflow each cron drives; anything unlisted is the 5-minute aggregate tick. */
const BY_CRON = {
  '41 * * * *': 'backfill.yml',
  '7,22,37,52 * * * *': 'health.yml',
};

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
    ctx.waitUntil(dispatch(env, BY_CRON[event.cron] ?? 'aggregate.yml'));
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
