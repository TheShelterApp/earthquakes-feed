// Cloudflare Worker cron: drive the GitHub workflows GitHub itself throttles.
//   */5 * * * *  -> aggregate (keep the feed fresh)
//   41 * * * *   -> backfill  (walk history backward, hourly)
const REPO = 'TheShelterApp/earthquakes-feed';

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
    const workflow = event.cron === '41 * * * *' ? 'backfill.yml' : 'aggregate.yml';
    ctx.waitUntil(dispatch(env, workflow));
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
