#!/usr/bin/env node
// The fallback of the two hourly walks (run by .github/workflows/walk-fallback.yml; R16-FOLLOWUPS (7), round 22).
//
// The deep-history walk (history.yml) and first-solutions' collect job share the concurrency group
// `earthquakes-feed-history`, so the two never ask a host at the same time. The heartbeat Worker dispatches them at
// fixed minutes (heartbeat/src/worker.js): history at :26 (a run held the group 5.4–17.8 min in the 20 era-A runs of
// 2026-10-06), first-solutions at :48 (its collect job held it 31.2–33.2 min in 53 runs of 10-04 → 10-06). The two
// turns fit the hour with about 4 minutes to spare on each side, so neither waits for the other.
//
// Until round 22 each walk also had its own hourly GitHub cron as the fallback for a Worker outage. GitHub delivered
// each of them 8 times in the 48 hours to 10-06 20:20 UTC, at whatever minute its scheduler reached them, while the
// Worker missed one first-solutions tick in those 48 hours (10-06 19:48). Every delivery was therefore a second run in
// the hour: a first-solutions cron run queued behind the Worker's run and then held the group from about :20 to :52,
// across history's :26 turn. Ten of the 48 heartbeat history runs waited 2.2–31 minutes (10-06 11:26: 26.8), nine
// behind a cron-started first-solutions run or the delay it passed on, one behind a cron-started history run; three
// cron runs were cancelled while they waited (GitHub keeps one pending run or job per group: a newer arrival cancels it).
//
// Now the walks have no cron of their own. This script runs on walk-fallback.yml's two crons and dispatches a walk
// exactly as the Worker does, and only when the Worker has missed it: when the walk's newest workflow_dispatch run is
// older than MAX_DISPATCH_AGE_MS, two hourly ticks and 5 minutes. A single missed tick costs the walk one hour, while
// a fallback run at a random minute puts the same second run into the hour that this change removes; after two missed
// ticks the Worker is taken to be down. A dispatch by this script is itself a workflow_dispatch run, so the next
// delivery within the window does nothing.
//
//   node scripts/walk-fallback.mjs                  # in walk-fallback.yml: SCHEDULE names the walk (the cron string)
//   WORKFLOW=history.yml DRY_RUN=1 node scripts/walk-fallback.mjs   # decide and print, dispatch nothing
// Environment: GH_TOKEN (actions: read, plus actions: write to dispatch), GITHUB_REPOSITORY (owner/name).
// Exit codes: 0 done (dispatched or nothing to do) · 1 the newest run could not be read or the dispatch failed (the
// run turns red: a Worker outage with a broken fallback must be seen) · 3 misconfigured (unknown walk, no token).
//
// Dependency-free (Node >= 22, global fetch). The pure helpers are exported for tests/walk-fallback.test.ts, which
// never touches the network.

import { pathToFileURL } from 'node:url';

/** The walks, the cron of walk-fallback.yml that stands in for each, and how the Worker dispatches it. */
export const WALKS = Object.freeze({
  'history.yml': Object.freeze({ cron: '29 * * * *', heartbeatMinute: 26, inputs: null }),
  'first-solutions.yml': Object.freeze({ cron: '50 * * * *', heartbeatMinute: 48, inputs: Object.freeze({ tick: '1' }) }),
});

/** Two hourly ticks of the Worker plus 5 minutes of dispatch lag (the Worker's runs are created 25–44 s after the minute). */
export const MAX_DISPATCH_AGE_MS = (2 * 60 + 5) * 60_000;

const API = 'https://api.github.com';
const READ_ATTEMPTS = 3;
const READ_BACKOFF_MS = 5_000;

/** The walk a walk-fallback.yml cron stands in for (github.event.schedule is the cron string), or null. */
export function walkForSchedule(schedule) {
  for (const [workflow, w] of Object.entries(WALKS)) if (w.cron === String(schedule ?? '').trim()) return workflow;
  return null;
}

/**
 * Whether to dispatch: only when the walk's newest workflow_dispatch run (the Worker's, an earlier fallback's or a
 * manual one) is older than `maxAgeMs`, or there is none.
 */
export function decide({ nowMs, newestDispatchMs, maxAgeMs = MAX_DISPATCH_AGE_MS }) {
  if (newestDispatchMs == null || !Number.isFinite(newestDispatchMs)) {
    return { dispatch: true, ageMin: null, reason: 'no workflow_dispatch run found' };
  }
  const ageMin = Math.round((nowMs - newestDispatchMs) / 60_000);
  if (nowMs - newestDispatchMs > maxAgeMs) {
    return { dispatch: true, ageMin, reason: `the newest workflow_dispatch run is ${ageMin} min old (more than ${Math.round(maxAgeMs / 60_000)}): the heartbeat Worker has missed it` };
  }
  return { dispatch: false, ageMin, reason: `the newest workflow_dispatch run is ${ageMin} min old (at most ${Math.round(maxAgeMs / 60_000)}): the heartbeat Worker is dispatching it` };
}

/** The body of the dispatch: the Worker's own (heartbeat/src/worker.js inputsFor). */
export function dispatchBody(workflow) {
  const inputs = WALKS[workflow]?.inputs;
  return inputs ? { ref: 'main', inputs: { ...inputs } } : { ref: 'main' };
}

const headers = (token) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'earthquakes-feed-walk-fallback',
});

/** created_at (ms) of the walk's newest workflow_dispatch run, null when it has none; throws when unreadable. */
export async function newestDispatchMs({ repo, workflow, token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const url = `${API}/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=1`;
  let last = null;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: headers(token) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const run = body?.workflow_runs?.[0];
      if (!run) return null;
      const ms = Date.parse(run.created_at);
      if (!Number.isFinite(ms)) throw new Error(`unreadable created_at ${JSON.stringify(run.created_at)}`);
      return ms;
    } catch (e) {
      last = e;
      if (attempt < READ_ATTEMPTS) await sleep(READ_BACKOFF_MS * attempt);
    }
  }
  throw new Error(`cannot read the newest workflow_dispatch run of ${workflow}: ${last?.message ?? last}`);
}

/** One fallback pass; returns the exit code. `log` gets plain lines, `annotate` GitHub workflow commands. */
export async function run({ env, nowMs = Date.now(), fetchImpl = fetch, sleep, log = console.log, annotate = console.log }) {
  const workflow = env.WORKFLOW ? env.WORKFLOW : walkForSchedule(env.SCHEDULE);
  if (!workflow || !WALKS[workflow]) {
    annotate(`::error::walk-fallback: no walk for ${env.WORKFLOW ? `WORKFLOW=${env.WORKFLOW}` : `schedule ${JSON.stringify(env.SCHEDULE ?? '')}`} (known: ${Object.entries(WALKS).map(([w, x]) => `${w} on '${x.cron}'`).join(', ')})`);
    return 3;
  }
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GH_TOKEN;
  if (!repo || !token) {
    annotate('::error::walk-fallback: GH_TOKEN and GITHUB_REPOSITORY are required');
    return 3;
  }
  let newest;
  try {
    newest = await newestDispatchMs({ repo, workflow, token, fetchImpl, ...(sleep ? { sleep } : {}) });
  } catch (e) {
    annotate(`::error::walk-fallback: ${e.message}`);
    return 1;
  }
  const verdict = decide({ nowMs, newestDispatchMs: newest });
  if (!verdict.dispatch) {
    log(`walk-fallback: ${workflow}: nothing to do; ${verdict.reason}`);
    return 0;
  }
  const dry = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  if (dry) {
    log(`walk-fallback: ${workflow}: would dispatch ${JSON.stringify(dispatchBody(workflow))} (dry run); ${verdict.reason}`);
    return 0;
  }
  const res = await fetchImpl(`${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify(dispatchBody(workflow)),
  });
  if (!res.ok) {
    annotate(`::error::walk-fallback: dispatching ${workflow} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    return 1;
  }
  annotate(`::warning::walk-fallback: dispatched ${workflow} ${JSON.stringify(dispatchBody(workflow))}; ${verdict.reason}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await run({ env: process.env }));
}
