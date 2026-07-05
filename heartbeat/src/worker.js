// Cloudflare Worker cron: dispatch the aggregate workflow every 5 minutes.
const REPO = 'TheShelterApp/earthquakes-feed';
const WORKFLOW = 'aggregate.yml';

async function dispatch(env) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
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
    const body = await res.text();
    console.error(`dispatch failed: ${res.status} ${body}`);
    throw new Error(`dispatch ${res.status}`);
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  // Manual trigger for testing: GET the worker URL.
  async fetch(_req, env) {
    try {
      await dispatch(env);
      return new Response('aggregate dispatched\n');
    } catch (e) {
      return new Response(`error: ${e.message}\n`, { status: 502 });
    }
  },
};
