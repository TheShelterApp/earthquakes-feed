import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_QUEUED,
  OPEN_RUN_STATUSES,
  STALE_RUN_MS,
  classifyRun,
  decideGate,
  queueOf,
  readQueue,
  run,
  workflowOf,
  type JobJson,
  type QueueEntry,
  type RunJson,
} from '../scripts/writer-queue.mjs';

// SHLTR-149: the writer gate (scripts/writer-queue.mjs) on fixture API answers: how a run of the writer group is
// classified from its jobs, the gate's decision, and the 10-dispatch loop of the acceptance (at most 2 queued, the rest
// refused at once).

const NOW = Date.parse('2026-11-14T15:00:00Z');
const REPO = 'TheShelterApp/earthquakes-feed';
const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString();
const runJson = (id: number, wf: string, status: string, minAgo = 1, event = 'workflow_dispatch'): RunJson => ({ id, path: `.github/workflows/${wf}`, status, event, created_at: iso(minAgo) });
const job = (name: string, status: string, conclusion: string | null = null): JobJson => ({ name, status, conclusion });

test('classifyRun: the writing job decides; before it is listed the run is about to enter; a failed gate or skipped jobs is a refusal', () => {
  const c = (wf: string, jobs: JobJson[], status = 'in_progress', minAgo = 1) => classifyRun(runJson(1, wf, status, minAgo), jobs, NOW);
  assert.equal(c('aggregate.yml', [job('aggregate', 'in_progress')]), 'holding');
  // A job held by its concurrency group is `pending`; any other unfinished state of the writing job is a wait too.
  for (const s of ['pending', 'queued', 'waiting', 'requested']) assert.equal(c('aggregate.yml', [job('aggregate', s)], 'pending'), 'waiting', s);
  assert.equal(c('backfill.yml', [job('gate', 'completed', 'success'), job('backfill', 'pending')]), 'waiting');
  assert.equal(c('backfill.yml', [job('gate', 'completed', 'success'), job('backfill', 'in_progress')]), 'holding');
  assert.equal(c('backfill.yml', [job('gate', 'completed', 'success'), job('backfill', 'completed', 'success')]), 'done');
  // GitHub lists a job only once its `needs` are met: the gate deciding, or just done.
  assert.equal(c('backfill.yml', [job('gate', 'in_progress')]), 'approaching');
  assert.equal(c('backfill.yml', [job('gate', 'completed', 'success')]), 'approaching');
  assert.equal(c('backfill.yml', []), 'approaching');
  assert.equal(c('archive.yml', [job('gate', 'completed', 'failure')]), 'refused');
  assert.equal(c('backfill.yml', [job('gate', 'completed', 'success'), job('backfill', 'completed', 'skipped')]), 'done');
  assert.equal(c('backfill.yml', [job('gate', 'completed', 'success'), { name: 'other', status: 'completed', conclusion: 'skipped' }]), 'refused');
  // backfill's dry run: its gate and writing job are skipped, so it never counts as queued.
  assert.equal(c('backfill.yml', [job('plan', 'in_progress'), job('gate', 'completed', 'skipped'), job('backfill', 'completed', 'skipped')]), 'done');
  assert.equal(c('backfill.yml', [job('plan', 'in_progress'), job('gate', 'completed', 'skipped')]), 'refused');
  assert.equal(c('derive.yml', [], 'completed'), 'done');
  // Ghosts: GitHub lists a few runs `queued` for weeks with no job (backfill 37655510824 of 2026-10-07).
  assert.equal(c('backfill.yml', [], 'queued', STALE_RUN_MS / 60_000 + 1), 'stale');
  assert.equal(c('history.yml', []), null);
  assert.equal(workflowOf({ path: '.github/workflows/derive.yml@refs/heads/main' }), 'derive.yml');
  assert.equal(workflowOf({ path: '.github/workflows/walk-fallback.yml' }), null);
});

test('queueOf: unfinished writer runs, oldest first, each once; finished runs and other workflows left out', () => {
  const q = queueOf(
    [
      { run: runJson(30, 'backfill.yml', 'in_progress'), jobs: [job('gate', 'in_progress')] },
      { run: runJson(10, 'aggregate.yml', 'in_progress'), jobs: [job('aggregate', 'in_progress')] },
      { run: runJson(20, 'aggregate.yml', 'pending'), jobs: [job('aggregate', 'pending')] },
      { run: runJson(20, 'aggregate.yml', 'pending'), jobs: [job('aggregate', 'pending')] },
      { run: runJson(25, 'history.yml', 'in_progress'), jobs: [] },
      { run: runJson(5, 'derive.yml', 'completed'), jobs: [] },
    ],
    NOW,
  );
  assert.deepEqual(q.map((e) => [e.id, e.workflow, e.state]), [
    [10, 'aggregate.yml', 'holding'],
    [20, 'aggregate.yml', 'waiting'],
    [30, 'backfill.yml', 'approaching'],
  ]);
});

const entry = (id: number, workflow: string, state: QueueEntry['state']): QueueEntry => ({ id, workflow, event: 'workflow_dispatch', created: null, state });

test('decideGate: admitted while fewer than 2 runs created before it are queued; the holder, later runs and refused runs do not count', () => {
  const holder = entry(1, 'aggregate.yml', 'holding');
  assert.equal(decideGate({ queue: [holder, entry(9, 'backfill.yml', 'approaching')], selfId: 9, workflow: 'backfill.yml' }).admit, true);
  const one = decideGate({ queue: [holder, entry(2, 'aggregate.yml', 'waiting'), entry(9, 'backfill.yml', 'approaching')], selfId: 9, workflow: 'backfill.yml' });
  assert.deepEqual([one.admit, one.level, one.ahead.map((e) => e.id)], [true, 'notice', [2]]);
  const later = [holder, entry(2, 'backfill.yml', 'waiting'), entry(10, 'backfill.yml', 'approaching'), entry(11, 'backfill.yml', 'approaching')];
  assert.equal(decideGate({ queue: later, selfId: 9, workflow: 'backfill.yml' }).admit, true, 'runs created after it are theirs to decide');
  const refusedAhead = [holder, entry(2, 'backfill.yml', 'refused'), entry(3, 'backfill.yml', 'refused'), entry(4, 'derive.yml', 'stale')];
  assert.equal(decideGate({ queue: refusedAhead, selfId: 9, workflow: 'backfill.yml' }).admit, true);
  // At the bound: aggregate waiting counts like any writer.
  const full = [holder, entry(2, 'aggregate.yml', 'waiting'), entry(3, 'backfill.yml', 'approaching')];
  const no = decideGate({ queue: full, selfId: 9, workflow: 'backfill.yml' });
  assert.deepEqual([no.admit, no.level], [false, 'error']);
  assert.match(no.message, /^backfill\.yml: not joining the earthquakes-feed-writer group: 2 writer run\(s\) queued ahead \(aggregate #2 waiting, backfill #3 approaching\); holding the group: aggregate #1 holding, at the bound of 2; .*force=true/);
  const walk = decideGate({ queue: full, selfId: 9, workflow: 'backfill.yml', retried: true });
  assert.deepEqual([walk.admit, walk.level], [false, 'warning']);
  assert.match(walk.message, /the next scheduled run does its work$/);
  const forced = decideGate({ queue: full, selfId: 9, workflow: 'derive.yml', force: true });
  assert.deepEqual([forced.admit, forced.level], [true, 'warning']);
  assert.equal(MAX_QUEUED, 2);
});

test('decideGate: 10 backfill dispatches in a loop: 2 join, 8 are refused, whether the gates decide one after another or all at once', () => {
  const holder = entry(1, 'aggregate.yml', 'holding');
  const ids = Array.from({ length: 10 }, (_, i) => 100 + i);
  // One after another: each gate sees the earlier runs as decided (admitted: approaching or waiting; refused).
  const states = new Map<number, QueueEntry['state']>();
  for (const id of ids) {
    const queue = [holder, ...ids.filter((x) => x < id).map((x) => entry(x, 'backfill.yml', states.get(x)!)), entry(id, 'backfill.yml', 'approaching')];
    states.set(id, decideGate({ queue, selfId: id, workflow: 'backfill.yml' }).admit ? 'waiting' : 'refused');
  }
  assert.deepEqual(ids.filter((id) => states.get(id) === 'waiting'), [100, 101]);
  // All at once: every gate sees every other run still deciding (approaching): an undecided gate counts as queued, so
  // the same two join.
  const all = [holder, ...ids.map((id) => entry(id, 'backfill.yml', 'approaching'))];
  assert.deepEqual(ids.filter((id) => decideGate({ queue: all, selfId: id, workflow: 'backfill.yml' }).admit), [100, 101]);
});

/** A fake GitHub API: unfinished runs by status, jobs by run id; every call is recorded. */
function fakeApi(runs: RunJson[], jobs: Record<number, JobJson[]>, { failJobsOf = null as number | null, status = 200 } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }): Promise<Response> => {
    calls.push(url);
    assert.equal(init?.headers?.['authorization'], 'Bearer t');
    const u = new URL(url);
    assert.equal(u.host, 'api.github.com');
    if (status !== 200) return new Response('{}', { status });
    const m = /^\/repos\/TheShelterApp\/earthquakes-feed\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
    if (m) {
      if (Number(m[1]) === failJobsOf) return new Response('{}', { status: 502 });
      return Response.json({ total_count: (jobs[Number(m[1])] ?? []).length, jobs: jobs[Number(m[1])] ?? [] });
    }
    assert.equal(u.pathname, '/repos/TheShelterApp/earthquakes-feed/actions/runs');
    const st = u.searchParams.get('status');
    return Response.json({ workflow_runs: runs.filter((r) => r.status === st) });
  };
  return { fetchImpl, calls };
}

const fixtureRuns = (): { runs: RunJson[]; jobs: Record<number, JobJson[]> } => ({
  runs: [
    runJson(500, 'aggregate.yml', 'in_progress', 2),
    runJson(501, 'aggregate.yml', 'in_progress', 1),
    runJson(502, 'backfill.yml', 'in_progress', 1),
    runJson(503, 'backfill.yml', 'in_progress', 0.5),
    runJson(504, 'first-solutions.yml', 'in_progress', 20),
    // A ghost like backfill run 37655510824 (queued since 2026-10-07, no job).
    runJson(499, 'backfill.yml', 'queued', 60 * 24 * 38),
  ],
  jobs: {
    500: [job('aggregate', 'in_progress')],
    501: [job('aggregate', 'pending')],
    502: [job('gate', 'completed', 'success'), job('backfill', 'pending')],
    503: [job('gate', 'in_progress')],
  },
});

test('readQueue: one listing per open status, then the jobs of each writer run that is not a ghost', async () => {
  const { runs, jobs } = fixtureRuns();
  const api = fakeApi(runs, jobs);
  const q = await readQueue({ repo: REPO, token: 't', nowMs: NOW, fetchImpl: api.fetchImpl, sleep: async () => {} });
  assert.deepEqual(q.map((e) => [e.id, e.state]), [[499, 'stale'], [500, 'holding'], [501, 'waiting'], [502, 'waiting'], [503, 'approaching']]);
  assert.equal(api.calls.filter((c) => c.includes('/jobs')).length, 4, 'no jobs read for the ghost or for other workflows');
  assert.equal(api.calls.filter((c) => !c.includes('/jobs')).length, OPEN_RUN_STATUSES.length);
});

test('run gate: refused at the bound (exit 1, admit=false, an ::error:: naming the queue); a walk tick is a warning; force joins', async () => {
  const { runs, jobs } = fixtureRuns();
  const env = (over: Record<string, string> = {}) => ({ GH_TOKEN: 't', GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '503', WRITER_WORKFLOW: 'backfill.yml', GITHUB_OUTPUT: '/out', ...over });
  const go = async (e: Record<string, string>, api = fakeApi(runs, jobs)) => {
    const lines: string[] = [];
    let out = '';
    const code = await run({ argv: ['gate'], env: e, nowMs: NOW, fetchImpl: api.fetchImpl, sleep: async () => {}, log: (l) => lines.push(l), appendOutput: (_f, t) => (out += t) });
    return { code, lines, out };
  };
  // 503 sees 501 (aggregate waiting) and 502 (backfill waiting) ahead.
  const refused = await go(env());
  assert.deepEqual([refused.code, refused.out], [1, 'admit=false\n']);
  assert.ok(refused.lines.some((l) => /^::error::backfill\.yml: not joining .*aggregate #501 waiting, backfill #502 waiting.*force=true/.test(l)), refused.lines.join('\n'));
  const walk = await go(env({ RETRIED: 'true' }));
  assert.deepEqual([walk.code, walk.out], [0, 'admit=false\n']);
  assert.ok(walk.lines.some((l) => l.startsWith('::warning::backfill.yml: not joining')));
  const forced = await go(env({ FORCE: 'true' }));
  assert.deepEqual([forced.code, forced.out], [0, 'admit=true\n']);
  // 502's own gate, earlier: only 501 was ahead.
  const early = await go(env({ GITHUB_RUN_ID: '502' }));
  assert.deepEqual([early.code, early.out], [0, 'admit=true\n']);
  // The queue cannot be read: fail closed, unless forced.
  const broken = await go(env(), fakeApi(runs, jobs, { failJobsOf: 501 }));
  assert.deepEqual([broken.code, broken.out], [1, 'admit=false\n']);
  assert.ok(broken.lines.some((l) => /^::error::writer-queue: could not read the writer queue \(GET .*jobs.*HTTP 502\); not joining/.test(l)), broken.lines.join('\n'));
  const brokenForced = await go(env({ FORCE: 'true' }), fakeApi(runs, jobs, { status: 403 }));
  assert.deepEqual([brokenForced.code, brokenForced.out], [0, 'admit=true\n']);
  // Misconfigured: aggregate is never gated; no token.
  assert.equal((await go(env({ WRITER_WORKFLOW: 'aggregate.yml' }))).code, 3);
  assert.equal((await go(env({ GH_TOKEN: '' }))).code, 3);
});
