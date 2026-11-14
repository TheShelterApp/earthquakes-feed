#!/usr/bin/env node
// The writer queue (SHLTR-149): who waits for the `earthquakes-feed-writer` concurrency group, and the gate that keeps
// a non-aggregate writer out of it while it is backed up.
//
// The incident it answers (2026-11-08 15:05–17:05 UTC): 47 backfill.yml dispatches of a usgs refill, 4–5 s apart, all
// joined the group. The group runs `queue: max` (first in, first out, up to 100 pending), so every aggregate run (the
// live feed's publisher, dispatched every 5 min by the heartbeat Worker) waited behind all of them: each backfill held
// the group about 2 min 15 s (96 s of it the full checkout of the data branch), and the live manifest went 1 h 47 min
// stale. The pacing rule "at most 2 queued writer dispatches at a time" lived only in people's heads.
//
// The lock is job-level since then: every writer workflow but aggregate starts with a `gate` job outside every group,
// which runs this script, and its writing job (`needs: gate`) takes the group only when the gate admits it. A
// workflow-level lock could not be gated: a run waits for a workflow-level group before any of its steps runs.
//
//   node scripts/writer-queue.mjs gate     # in the gate job: decide, write admit=true|false to $GITHUB_OUTPUT
//   node scripts/writer-queue.mjs status   # print the queue (a local run with GH_TOKEN and GITHUB_REPOSITORY)
//
// Environment: GH_TOKEN (actions: read), GITHUB_REPOSITORY, GITHUB_RUN_ID (the gate's own run), WRITER_WORKFLOW (the
// gated workflow's file name), FORCE ('true': join whatever waits), RETRIED ('true': a refused run's work is done by
// the workflow's next scheduled run, so a refusal is a warning and a green run; otherwise it is an error and a failed
// run, so whoever dispatched it sees it).
// Exit codes: 0 admitted, or refused with RETRIED · 1 refused (a dispatch to repeat), or the queue could not be read
// (the gate fails closed: an outage of the API must not let a burst of dispatches through) · 3 misconfigured.
//
// What counts as queued: a writer run that waits for the group or is about to enter it, created before the gate's own
// run. Per run, from its jobs (GET /actions/runs/{id}/jobs): the writing job `in_progress` holds the group; the writing
// job listed in any other unfinished state (`queued`, `pending`, `waiting`, `requested`: GitHub documents a job held by
// its concurrency group as `pending`) waits; a run whose writing job is not listed yet (its gate is still deciding, or
// has just admitted it: GitHub lists a job only once its `needs` are met) is about to enter; a run whose gate failed or
// whose jobs were skipped was refused. aggregate is counted like any other writer, and it is never gated.
//
// Why the bound is "about 2", not exactly 2. Two gates can decide at the same moment. Each counts only the runs created
// before its own, so a burst of dispatches is ordered: the k-th gate sees the k-1 before it (deciding, admitted or
// waiting) and refuses once 2 of them are not refused. A run ahead whose gate has not decided yet counts as queued, so
// an undecided gate errs toward refusing. What can let a third run in: GitHub's run listing lags a run's creation by a
// moment, so a gate can miss a run created a second before its own; the ordering by run id makes that rare, not
// impossible. The hard backstops are elsewhere: a gated writer holds the group for seconds (backfill's sparse checkout;
// archive and derive run a few times a day at most), aggregate is never refused, and the feed health workflow files
// feed:writer-queue (P2) when more than 3 runs wait or the live manifest ages past 15 min while any does
// (scripts/feed-health.mjs).
//
// Dependency-free (Node >= 22, global fetch): the gate job and the health workflow run it without `npm ci`. The pure
// helpers are exported for tests/writer-queue.test.ts and scripts/feed-health.mjs. Types: writer-queue.d.mts.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const WRITER_GROUP = 'earthquakes-feed-writer';
/** At most this many writer runs wait (or are about to enter the group) once a gated run joins. */
export const MAX_QUEUED = 2;
/** The gate job's id in every gated workflow. */
export const GATE_JOB = 'gate';
/**
 * The members of the writer group: each workflow's writing job (the one that takes the group at job level), and whether
 * a gate guards it. tests/writer-queue.test.ts checks this table against the workflow files.
 */
export const WRITERS = Object.freeze({
  'aggregate.yml': Object.freeze({ lockJob: 'aggregate', gated: false }),
  'backfill.yml': Object.freeze({ lockJob: 'backfill', gated: true }),
  'archive.yml': Object.freeze({ lockJob: 'archive', gated: true }),
  'derive.yml': Object.freeze({ lockJob: 'derive', gated: true }),
});
/**
 * An unfinished run created longer ago than this is a ghost, not a queue: GitHub keeps a few runs `queued` or
 * `in_progress` for weeks with no job at all (a backfill run of 2026-10-07 and a derive run of 2026-09-13 were still
 * listed `queued` on 2026-11-14). A real wait is far shorter: at most 2 gated runs and aggregate's own arrivals.
 */
export const STALE_RUN_MS = 6 * 60 * 60_000;
/** The run states GitHub lists unfinished runs under (GET /actions/runs?status=…). */
export const OPEN_RUN_STATUSES = Object.freeze(['queued', 'in_progress', 'pending', 'waiting', 'requested']);

const API = 'https://api.github.com';
const READ_ATTEMPTS = 3;
const READ_BACKOFF_MS = [2_000, 5_000];

/** The workflow file name of a run (`path` is `.github/workflows/<file>`, sometimes with `@<ref>`), or null. */
export function workflowOf(run) {
  const path = typeof run?.path === 'string' ? run.path.replace(/@.*$/, '') : '';
  const file = path.split('/').pop() ?? '';
  return Object.hasOwn(WRITERS, file) ? file : null;
}

/**
 * Where one writer run stands. `run` as GET /actions/runs lists it, `jobs` its jobs (GET /actions/runs/{id}/jobs).
 * 'holding' the group, 'waiting' for it, 'approaching' it (the writing job not listed yet), 'refused' by its gate,
 * 'done', 'stale' (a ghost: see STALE_RUN_MS), or null for a run of another workflow.
 */
export function classifyRun(run, jobs, nowMs) {
  const wf = workflowOf(run);
  if (!wf) return null;
  if (run.status === 'completed') return 'done';
  const created = Date.parse(run.created_at ?? '');
  if (Number.isFinite(created) && nowMs - created > STALE_RUN_MS) return 'stale';
  const list = Array.isArray(jobs) ? jobs : [];
  const lock = list.find((j) => j && j.name === WRITERS[wf].lockJob);
  if (lock) {
    if (lock.status === 'in_progress') return 'holding';
    if (lock.status === 'completed') return 'done';
    return 'waiting';
  }
  const gate = list.find((j) => j && j.name === GATE_JOB);
  if (gate && gate.status === 'completed' && gate.conclusion !== 'success') return 'refused';
  if (list.some((j) => j && j.conclusion === 'skipped')) return 'refused';
  return 'approaching';
}

/** Queued = waiting for the group, or about to enter it. */
export const isQueued = (state) => state === 'waiting' || state === 'approaching';

/**
 * The queue from a listing: `entries` are { run, jobs }. Returns every unfinished writer run's entry (id, workflow,
 * created, state), oldest first (by run id: GitHub's run ids increase with creation), ghosts and refused runs
 * included for the log.
 */
export function queueOf(entries, nowMs) {
  const out = [];
  const seen = new Set();
  for (const e of entries ?? []) {
    const run = e?.run;
    if (!run || seen.has(run.id)) continue;
    const state = classifyRun(run, e.jobs, nowMs);
    if (state === null || state === 'done') continue;
    seen.add(run.id);
    out.push({ id: run.id, workflow: workflowOf(run), event: run.event ?? null, created: run.created_at ?? null, state });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** "backfill #42493027214 waiting" lines, joined. */
export function describe(queue) {
  return queue.length ? queue.map((q) => `${q.workflow.replace(/\.yml$/, '')} #${q.id} ${q.state}`).join(', ') : 'nothing';
}

/**
 * The gate's decision for run `selfId`: admit when fewer than `maxQueued` writer runs created before it are queued
 * (so at most `maxQueued` wait once it joins), or when `force` is set.
 */
export function decideGate({ queue, selfId, force = false, retried = false, workflow, maxQueued = MAX_QUEUED }) {
  const ahead = queue.filter((q) => q.id !== selfId && q.id < selfId && isQueued(q.state));
  const holding = queue.filter((q) => q.id !== selfId && q.state === 'holding');
  const seen = `${ahead.length} writer run(s) queued ahead (${describe(ahead)}); holding the group: ${describe(holding)}`;
  if (ahead.length < maxQueued) return { admit: true, level: 'notice', ahead, message: `${workflow}: joining the ${WRITER_GROUP} group: ${seen}` };
  if (force) {
    return { admit: true, level: 'warning', ahead, message: `${workflow}: force=true, joining the ${WRITER_GROUP} group although ${seen} (the bound is ${maxQueued}): the live feed's aggregate waits behind them` };
  }
  const how = retried
    ? 'the next scheduled run does its work'
    : `dispatch it again once the queue has drained (at most ${maxQueued} writer dispatches at a time), or with force=true to queue anyway (gh workflow run ${workflow} -f force=true …)`;
  return {
    admit: false,
    level: retried ? 'warning' : 'error',
    ahead,
    message: `${workflow}: not joining the ${WRITER_GROUP} group: ${seen}, at the bound of ${maxQueued}; every aggregate run (the live feed) would wait behind them; ${how}`,
  };
}

const headers = (token) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'earthquakes-feed-writer-queue',
});

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET a GitHub API path as JSON, 3 attempts on network errors, 5xx and 429. Throws with the last reason. */
async function getJson(path, { token, fetchImpl, sleep }) {
  let last = 'not attempted';
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(READ_BACKOFF_MS[attempt - 2] ?? 5_000);
    try {
      const res = await fetchImpl(`${API}${path}`, { headers: headers(token) });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = `network error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(`GET ${path}: ${last}`);
}

/**
 * Read the queue: every unfinished run of the repository (one listing per open status), then the jobs of each writer
 * run that is not a ghost. Throws when any read fails (the gate fails closed; health leaves the key unjudged).
 */
export async function readQueue({ repo, token, nowMs = Date.now(), fetchImpl = globalThis.fetch, sleep = sleepMs }) {
  const opts = { token, fetchImpl, sleep };
  const runs = new Map();
  for (const status of OPEN_RUN_STATUSES) {
    const page = await getJson(`/repos/${repo}/actions/runs?status=${status}&per_page=100`, opts);
    for (const run of Array.isArray(page?.workflow_runs) ? page.workflow_runs : []) if (workflowOf(run)) runs.set(run.id, run);
  }
  const entries = [];
  for (const run of runs.values()) {
    const state = classifyRun(run, [], nowMs);
    if (state === 'stale' || state === 'done') {
      entries.push({ run, jobs: [] });
      continue;
    }
    const page = await getJson(`/repos/${repo}/actions/runs/${encodeURIComponent(run.id)}/jobs?filter=latest&per_page=100`, opts);
    entries.push({ run, jobs: Array.isArray(page?.jobs) ? page.jobs : [] });
  }
  return queueOf(entries, nowMs);
}

const truthy = (v) => String(v ?? '').trim().toLowerCase() === 'true' || String(v ?? '').trim() === '1';

/** The CLI. Everything with a side effect is injectable for tests. @returns {Promise<number>} the exit code */
export async function run({ argv = process.argv.slice(2), env = process.env, nowMs = Date.now(), fetchImpl = globalThis.fetch, sleep = sleepMs, log = console.log, appendOutput = (f, s) => appendFileSync(f, s) } = {}) {
  const cmd = argv[0];
  const token = env.GH_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if ((cmd !== 'gate' && cmd !== 'status') || !token || !repo) {
    log('::error::writer-queue: usage `writer-queue.mjs gate|status` with GH_TOKEN and GITHUB_REPOSITORY set');
    return 3;
  }
  const workflow = env.WRITER_WORKFLOW ?? '';
  if (cmd === 'gate' && (!WRITERS[workflow]?.gated || !/^\d+$/.test(env.GITHUB_RUN_ID ?? ''))) {
    log(`::error::writer-queue: WRITER_WORKFLOW must name a gated writer (${Object.keys(WRITERS).filter((w) => WRITERS[w].gated).join(', ')}) and GITHUB_RUN_ID the gate's run; got ${JSON.stringify(workflow)}`);
    return 3;
  }
  const force = truthy(env.FORCE);
  let queue;
  try {
    queue = await readQueue({ repo, token, nowMs, fetchImpl, sleep });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (cmd === 'gate' && force) {
      log(`::warning::writer-queue: could not read the writer queue (${why}); force=true, joining anyway`);
      if (env.GITHUB_OUTPUT) appendOutput(env.GITHUB_OUTPUT, 'admit=true\n');
      return 0;
    }
    log(`::error::writer-queue: could not read the writer queue (${why})${cmd === 'gate' ? '; not joining the group (the gate fails closed): run it again, or with force=true' : ''}`);
    if (cmd === 'gate' && env.GITHUB_OUTPUT) appendOutput(env.GITHUB_OUTPUT, 'admit=false\n');
    return 1;
  }
  if (cmd === 'status') {
    log(`writer queue: ${describe(queue)}`);
    return 0;
  }
  const selfId = Number(env.GITHUB_RUN_ID);
  const d = decideGate({ queue, selfId, force, retried: truthy(env.RETRIED), workflow });
  log(`writer queue: ${describe(queue)}`);
  log(d.level === 'notice' ? d.message : `::${d.level}::${d.message}`);
  if (env.GITHUB_OUTPUT) appendOutput(env.GITHUB_OUTPUT, `admit=${d.admit}\n`);
  return d.admit || d.level === 'warning' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(`::error::writer-queue crashed: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
