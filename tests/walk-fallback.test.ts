import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inputsFor, workflowFor } from '../heartbeat/src/worker.js';
import { MAX_DISPATCH_AGE_MS, WALKS, decide, dispatchBody, run, walkForSchedule, type FetchImpl } from '../scripts/walk-fallback.mjs';

// R16-FOLLOWUPS (7), round 22: the two walks that share the `earthquakes-feed-history` group (history.yml and
// first-solutions.yml's collect job) are started by the heartbeat Worker only; walk-fallback.yml dispatches one only
// when the Worker has missed it twice in a row (scripts/walk-fallback.mjs).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const yml = (name: string): string => readFileSync(here(`../.github/workflows/${name}`), 'utf8');
const MIN = 60_000;
const NOW = Date.parse('2026-10-06T21:29:40Z');

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch that answers the runs listing with `newest` (ISO, or null for none) and records every call. */
function fakeGitHub(newest: string | null, opts: { listStatus?: number[]; dispatchStatus?: number } = {}): { fetchImpl: FetchImpl; calls: Call[] } {
  const calls: Call[] = [];
  const listStatus = [...(opts.listStatus ?? [])];
  const fetchImpl: FetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
    if (method === 'POST') return new Response(null, { status: opts.dispatchStatus ?? 204 });
    const status = listStatus.shift() ?? 200;
    if (status !== 200) return new Response('{"message":"boom"}', { status });
    return Response.json({ total_count: newest ? 1 : 0, workflow_runs: newest ? [{ id: 1, event: 'workflow_dispatch', created_at: newest }] : [] });
  };
  return { fetchImpl, calls };
}

const env = (more: Record<string, string>): Record<string, string> => ({ GH_TOKEN: 't', GITHUB_REPOSITORY: 'TheShelterApp/earthquakes-feed', ...more });
const quiet = { log: (): void => {}, annotate: (): void => {}, sleep: async (): Promise<void> => {} };

test('walk-fallback: the walks have no cron of their own; walk-fallback.yml holds one cron per walk', () => {
  for (const name of ['history.yml', 'first-solutions.yml']) {
    const text = yml(name);
    // The `on:` block: up to the next top-level key.
    const from = text.indexOf('\non:\n') + 1;
    const next = text.slice(from + 4).search(/^\S/m);
    const on = text.slice(from, next < 0 ? undefined : from + 4 + next);
    assert.doesNotMatch(on, /schedule:/, `${name} must not be scheduled: a delivered cron is a second run in the hour`);
    assert.match(on, /workflow_dispatch:/, name);
  }
  const fb = yml('walk-fallback.yml');
  const crons = [...fb.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(crons.sort(), Object.values(WALKS).map((w) => w.cron).sort());
  for (const [workflow, w] of Object.entries(WALKS)) assert.equal(walkForSchedule(w.cron), workflow);
  assert.equal(walkForSchedule('*/5 * * * *'), null);
  assert.equal(walkForSchedule(undefined), null);
  // Its own group: a fallback run that finds nothing to do never queues in, or cancels from, either walk's group.
  const top = fb.slice(0, fb.indexOf('\njobs:'));
  assert.match(top, /concurrency:\n {2}group: earthquakes-feed-walk-fallback\n/);
  assert.doesNotMatch(fb, /group: earthquakes-feed-(history|first-solutions)\b/);
  // actions: write only on the job that dispatches; the workflow default stays read-only.
  assert.match(top, /\npermissions:\n {2}contents: read\n/);
  assert.match(fb, /\n {6}actions: write\n/);
  assert.match(fb, /run: node scripts\/walk-fallback\.mjs\n/);
  assert.match(fb, /SCHEDULE: \$\{\{ github\.event\.schedule \}\}/);
});

test('walk-fallback: it dispatches a walk exactly as the heartbeat Worker does', () => {
  for (const [workflow, w] of Object.entries(WALKS)) {
    assert.equal(workflowFor(w.heartbeatMinute), workflow, `the Worker dispatches ${workflow} at :${w.heartbeatMinute}`);
    const inputs = inputsFor(workflow);
    assert.deepEqual(dispatchBody(workflow), inputs ? { ref: 'main', inputs } : { ref: 'main' });
  }
});

test('walk-fallback: the two turns fit the hour (schedule arithmetic, measured 2026-10-04 → 10-06)', () => {
  // The Worker's runs were created 25–44 s after the minute (96 runs); a history run held the group at most 17.8 min
  // (20 era-A runs on 10-06, p50 9.2), first-solutions' collect job at most 33.2 min (53 runs, p50 31.4); the runner
  // picked a job up within seconds.
  const lagMin = 44 / 60;
  const historyHoldMin = 17.8;
  const fsHoldMin = 33.2;
  const h = WALKS['history.yml'].heartbeatMinute;
  const f = WALKS['first-solutions.yml'].heartbeatMinute;
  const historyEnds = h + lagMin + historyHoldMin;
  const fsEnds = f + lagMin + fsHoldMin - 60;
  assert.ok(historyEnds < f, `history ends at :${historyEnds.toFixed(1)}, before first-solutions at :${f}`);
  assert.ok(fsEnds < h, `first-solutions ends at :${fsEnds.toFixed(1)}, before history at :${h}`);
  // About 4 minutes to spare on each side.
  assert.ok(f - historyEnds >= 3.4 && h - fsEnds >= 3.4);
  // One cron-started run more in the hour does not fit: that was the collision.
  assert.ok(historyHoldMin + 2 * fsHoldMin > 60);
});

test('walk-fallback: decide waits for two missed ticks', () => {
  assert.equal(MAX_DISPATCH_AGE_MS, 125 * MIN);
  // The Worker dispatched 3 min ago, an hour ago, or missed one tick: nothing to do.
  for (const ageMin of [0, 3, 59, 61, 119, 125]) assert.equal(decide({ nowMs: NOW, newestDispatchMs: NOW - ageMin * MIN }).dispatch, false, `${ageMin} min`);
  // Two ticks missed: dispatch.
  for (const ageMin of [126, 180, 24 * 60]) assert.equal(decide({ nowMs: NOW, newestDispatchMs: NOW - ageMin * MIN }).dispatch, true, `${ageMin} min`);
  assert.equal(decide({ nowMs: NOW, newestDispatchMs: null }).dispatch, true);
  assert.match(decide({ nowMs: NOW, newestDispatchMs: NOW - 3 * MIN }).reason, /3 min old/);
});

test('walk-fallback: a cron delivered while the Worker works reads one listing and dispatches nothing', async () => {
  for (const [workflow, w] of Object.entries(WALKS)) {
    const gh = fakeGitHub(new Date(NOW - 63 * MIN).toISOString());
    const lines: string[] = [];
    const code = await run({ env: env({ SCHEDULE: w.cron }), nowMs: NOW, fetchImpl: gh.fetchImpl, ...quiet, log: (l) => lines.push(l) });
    assert.equal(code, 0);
    assert.deepEqual(gh.calls.map((c) => [c.method, c.url]), [['GET', `https://api.github.com/repos/TheShelterApp/earthquakes-feed/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=1`]]);
    assert.match(lines.join('\n'), new RegExp(`${workflow.replace('.', '\\.')}: nothing to do`));
  }
});

test('walk-fallback: after two missed ticks it dispatches the walk on main with the Worker inputs', async () => {
  const stale = new Date(NOW - 130 * MIN).toISOString();
  const hist = fakeGitHub(stale);
  const notes: string[] = [];
  assert.equal(await run({ env: env({ SCHEDULE: '29 * * * *' }), nowMs: NOW, fetchImpl: hist.fetchImpl, ...quiet, annotate: (l) => notes.push(l) }), 0);
  assert.equal(hist.calls.length, 2);
  assert.deepEqual([hist.calls[1]!.method, hist.calls[1]!.url, hist.calls[1]!.body], ['POST', 'https://api.github.com/repos/TheShelterApp/earthquakes-feed/actions/workflows/history.yml/dispatches', { ref: 'main' }]);
  assert.match(notes.join('\n'), /^::warning::walk-fallback: dispatched history\.yml/m);

  const fs = fakeGitHub(stale);
  assert.equal(await run({ env: env({ SCHEDULE: '50 * * * *' }), nowMs: NOW, fetchImpl: fs.fetchImpl, ...quiet }), 0);
  assert.deepEqual(fs.calls[1]!.body, { ref: 'main', inputs: { tick: '1' } });

  // No workflow_dispatch run at all: dispatch.
  const none = fakeGitHub(null);
  assert.equal(await run({ env: env({ SCHEDULE: '29 * * * *' }), nowMs: NOW, fetchImpl: none.fetchImpl, ...quiet }), 0);
  assert.equal(none.calls.filter((c) => c.method === 'POST').length, 1);
});

test('walk-fallback: a dry run (the manual check) decides and dispatches nothing', async () => {
  const gh = fakeGitHub(new Date(NOW - 300 * MIN).toISOString());
  const lines: string[] = [];
  assert.equal(await run({ env: env({ WORKFLOW: 'first-solutions.yml', DRY_RUN: '1' }), nowMs: NOW, fetchImpl: gh.fetchImpl, ...quiet, log: (l) => lines.push(l) }), 0);
  assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(lines.join('\n'), /would dispatch \{"ref":"main","inputs":\{"tick":"1"\}\} \(dry run\)/);
});

test('walk-fallback: an unreadable listing is retried, then the run turns red without dispatching', async () => {
  const flaky = fakeGitHub(new Date(NOW - 10 * MIN).toISOString(), { listStatus: [502, 503] });
  assert.equal(await run({ env: env({ SCHEDULE: '29 * * * *' }), nowMs: NOW, fetchImpl: flaky.fetchImpl, ...quiet }), 0);
  assert.equal(flaky.calls.length, 3);

  const down = fakeGitHub(null, { listStatus: [500, 500, 500] });
  const notes: string[] = [];
  assert.equal(await run({ env: env({ SCHEDULE: '29 * * * *' }), nowMs: NOW, fetchImpl: down.fetchImpl, ...quiet, annotate: (l) => notes.push(l) }), 1);
  assert.equal(down.calls.length, 3);
  assert.equal(down.calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(notes.join('\n'), /::error::walk-fallback: cannot read the newest workflow_dispatch run of history\.yml: HTTP 500/);
});

test('walk-fallback: a refused dispatch turns the run red; an unknown walk or a missing token is a misconfiguration', async () => {
  const refused = fakeGitHub(new Date(NOW - 200 * MIN).toISOString(), { dispatchStatus: 403 });
  assert.equal(await run({ env: env({ SCHEDULE: '50 * * * *' }), nowMs: NOW, fetchImpl: refused.fetchImpl, ...quiet }), 1);
  const gh = fakeGitHub(null);
  assert.equal(await run({ env: env({ SCHEDULE: '9,24,39,54 * * * *' }), nowMs: NOW, fetchImpl: gh.fetchImpl, ...quiet }), 3);
  assert.equal(await run({ env: env({ WORKFLOW: 'aggregate.yml' }), nowMs: NOW, fetchImpl: gh.fetchImpl, ...quiet }), 3);
  assert.equal(await run({ env: { SCHEDULE: '29 * * * *', GITHUB_REPOSITORY: 'x/y' }, nowMs: NOW, fetchImpl: gh.fetchImpl, ...quiet }), 3);
  assert.equal(gh.calls.length, 0);
});
