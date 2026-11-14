import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { workflowFor } from '../heartbeat/src/worker.js';
import {
  DESIGNS,
  INCIDENT_DISPATCHES,
  MAX_PENDING,
  SPARSE_BACKFILL_HOLD_MS,
  WRITER,
  incidentArrivals,
  maxAggregateWaitMs,
  maxWaiting,
  observedCancelled,
  replayArrivals,
  simulate,
  simulateDesign,
  summarize,
  syntheticArrivals,
  type Arrival,
  type Design,
  type RunRecord,
} from '../src/writer-group.js';
import { GATE_JOB, MAX_QUEUED, WRITERS } from '../scripts/writer-queue.mjs';

// FEED-OPS-4: the writer lock. The simulator (src/writer-group.ts) against GitHub's documented rules and against
// production hours, and the workflow layout that the round-14 design depends on.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const MIN = 60_000;
const arr = (id: string, at: number, holdMs: number, group: string | null = 'g', extra: Partial<Arrival> = {}): Arrival => ({ id, workflow: id.replace(/\d+$/, ''), at, group, holdMs, ...extra });

test('writer group: single queue, a newer arrival cancels the waiting one (GitHub default)', () => {
  const outs = simulate([arr('run1', 0, 3 * MIN), arr('wait2', 1 * MIN, MIN), arr('late3', 2 * MIN, MIN)]);
  const by = Object.fromEntries(outs.map((o) => [o.arrival.id, o]));
  assert.equal(by['run1']!.startedAt, 0);
  assert.equal(by['wait2']!.startedAt, null);
  assert.equal(by['wait2']!.cancelledBy?.id, 'late3');
  assert.equal(by['late3']!.startedAt, 3 * MIN, 'the newest starts when the running one ends');
});

test('writer group: queue max runs every arrival, first in first out, and cancels only past 100 waiting', () => {
  const outs = simulate([arr('run1', 0, 3 * MIN), arr('wait2', 1 * MIN, MIN), arr('late3', 2 * MIN, MIN)], () => 'max');
  assert.deepEqual(outs.map((o) => [o.arrival.id, o.startedAt, o.cancelledBy]), [
    ['run1', 0, null],
    ['wait2', 3 * MIN, null],
    ['late3', 4 * MIN, null],
  ]);
  const many = [arr('run0', 0, 1_000 * MIN), ...Array.from({ length: MAX_PENDING + 2 }, (_, i) => arr(`w${i + 1}`, 1 + i, MIN))];
  const outsMany = simulate(many, () => 'max');
  assert.equal(outsMany.filter((o) => o.cancelledBy).map((o) => o.arrival.id).join(','), `w${MAX_PENDING + 1},w${MAX_PENDING + 2}`);
});

test('writer group: a job outside every group never waits; a workflow_run follow arrives after its run ends', () => {
  const outs = simulate([
    arr('agg1', 0, 2 * MIN, 'g', { then: [{ workflow: 'derive', lagMs: 5_000, group: 'g', holdMs: 2 * MIN }] }),
    arr('side1', 30_000, 10_000, null),
    arr('agg2', 3 * MIN, 2 * MIN),
  ]);
  const side = outs.find((o) => o.arrival.id === 'side1')!;
  assert.equal(side.startedAt, 30_000);
  const derive = outs.find((o) => o.arrival.workflow === 'derive')!;
  assert.equal(derive.arrival.at, 2 * MIN + 5_000);
  assert.equal(derive.startedAt, 2 * MIN + 5_000);
  assert.equal(outs.find((o) => o.arrival.id === 'agg2')!.startedAt, 4 * MIN + 5_000, 'aggregate waits for the derive its predecessor caused');
});

test('writer group: the gate refuses a gated arrival that finds 2 pending, never aggregate, and admits again once the queue drains', () => {
  const gate = { group: 'g', maxQueued: 2, gated: (a: Arrival) => a.workflow === 'backfill' };
  const outs = simulate(
    [
      arr('aggregate1', 0, 10 * MIN),
      arr('backfill1', 1_000, MIN),
      arr('backfill2', 2_000, MIN),
      arr('backfill3', 3_000, MIN),
      arr('aggregate2', 4_000, MIN),
      arr('backfill4', 10.5 * MIN, MIN),
      arr('backfill5', 12.5 * MIN, MIN),
    ],
    () => 'max',
    { gate },
  );
  const by = Object.fromEntries(outs.map((o) => [o.arrival.id, o]));
  assert.equal(by['backfill3']!.refused, true, 'the third backfill behind the holder is refused');
  assert.equal(by['aggregate2']!.refused, false, 'aggregate is never refused, whatever waits');
  assert.equal(by['aggregate2']!.startedAt, 12 * MIN, 'behind the holder and the two admitted backfills');
  // At 10.5 min backfill1 runs and backfill2 and aggregate2 wait: 2 pending, so backfill4 is refused too; at 12.5 min
  // aggregate2 runs and nothing waits, so backfill5 joins.
  assert.equal(by['backfill4']!.refused, true);
  assert.deepEqual([by['backfill5']!.refused, by['backfill5']!.startedAt], [false, 13 * MIN]);
  assert.equal(maxWaiting(outs, 'g', (a) => a.workflow === 'backfill'), 2);
});

test('writer group: the 2026-11-08 incident (47 backfill dispatches): round 14 starved the aggregate for over 100 minutes, the gate keeps it within minutes', () => {
  const r14 = DESIGNS.find((d) => d.foldDerive && d.sideCommitsOutside && d.writerQueue === 'max' && d.gateMaxQueued == null)!;
  const now = DESIGNS.find((d) => d.gateMaxQueued != null)!;
  const run = (d: Design) => {
    const outs = simulateDesign(incidentArrivals(d), d);
    const end = Math.max(...outs.map((o) => o.endedAt ?? 0));
    return { outs, wait: maxAggregateWaitMs(outs, end), s: summarize(outs) };
  };
  // Round 14 as it was: every dispatch queued, and the aggregate waited behind all of them (the manifest went 1 h 47 min
  // stale; this replay: 103 min).
  const before = run(r14);
  assert.equal(before.s['backfill']!.ran, INCIDENT_DISPATCHES);
  assert.ok(before.wait > 90 * MIN, `${before.wait / MIN} min`);
  assert.ok(maxWaiting(before.outs, WRITER, (a) => a.workflow === 'backfill') > 40);
  // SHLTR-149: at most 2 backfills wait at once, the rest are refused, and every aggregate run starts within 10 minutes
  // of its arrival, so the feed publishes at least every 10 minutes plus one run.
  const after = run(now);
  assert.equal(now.backfillHoldMs, SPARSE_BACKFILL_HOLD_MS);
  assert.ok(maxWaiting(after.outs, WRITER, (a) => a.workflow === 'backfill') <= MAX_QUEUED);
  assert.ok(after.s['backfill']!.refused >= INCIDENT_DISPATCHES - 6, JSON.stringify(after.s['backfill']));
  assert.ok(after.wait <= 10 * MIN, `${after.wait / MIN} min`);
  const starts = after.outs.filter((o) => o.arrival.workflow === 'aggregate').map((o) => o.startedAt!).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! <= 10 * MIN, `aggregate starts ${(starts[i]! - starts[i - 1]!) / MIN} min apart`);
  // The gate alone, with the full checkout's 2 min 15 s backfill: still within 10 minutes (holder + 2 queued).
  const gateOnly = run({ ...now, backfillHoldMs: undefined });
  assert.ok(gateOnly.wait <= 10 * MIN, `${gateOnly.wait / MIN} min`);
  assert.ok(gateOnly.wait > after.wait, 'the sparse checkout shortens the wait further');
});

const fixture = (): RunRecord[] =>
  readFileSync(here('fixtures/writer-runs-production-hours.ndjson'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunRecord);

test('writer group: five production hours (2026-10-01/02/05) replayed as they were reproduce GitHub\'s cancellations', () => {
  const runs = fixture();
  const current = DESIGNS[0]!;
  const outs = simulate(replayArrivals(runs, current), (g) => (g === WRITER ? current.writerQueue : 'single'));
  const sim = new Set(outs.filter((o) => o.cancelledBy).map((o) => o.arrival.id.replace(/:(run|collect|commit)$/, '')));
  const real = new Set(runs.filter(observedCancelled).map((r) => `${r.wf}:${r.run}`));
  assert.equal(real.size, 9);
  // 8 of the 9 runs GitHub cancelled are cancelled in the replay too, and the replay cancels one more (the order of two
  // arrivals 4 seconds apart, 2026-10-02 18:40).
  assert.equal([...real].filter((x) => sim.has(x)).length, 8);
  assert.equal(sim.size, 9);
  // Among them the three first-solutions commit jobs that had spent 31-33 minutes each on requests.
  const s = summarize(outs);
  assert.equal(s['first-solutions commit']!.cancelled, 3);
  assert.ok(s['first-solutions commit']!.lostWorkMin >= 90, String(s['first-solutions commit']!.lostWorkMin));
});

test('writer group: the round-14 layout cancels nothing in those hours and keeps the aggregate on time', () => {
  const runs = fixture();
  const r14 = DESIGNS.find((d) => d.foldDerive && d.sideCommitsOutside && d.writerQueue === 'max')!;
  const outs = simulateDesign(replayArrivals(runs, r14), r14);
  const s = summarize(outs);
  for (const [wf, x] of Object.entries(s)) if (wf !== 'history') assert.equal(x.cancelled, 0, wf);
  assert.equal(s['derive'], undefined, 'derive no longer arrives on its own');
  assert.ok(s['aggregate']!.waitS.p90 <= 10, JSON.stringify(s['aggregate']));
  // Behind the aggregate run it was dispatched a minute after, and at most one more arrival.
  assert.ok(s['backfill']!.waitS.max <= 300, JSON.stringify(s['backfill']));
  assert.equal(s['first-solutions commit']!.waitS.max, 0, 'the commit job no longer waits for the lock');
});

test('writer group: a synthetic week of the heartbeat schedule cancels writers today and none in the round-14 layout', () => {
  const runs = fixture();
  const cronAt: Record<string, number[]> = {};
  for (const r of runs) if (r.event === 'schedule') (cronAt[`${r.wf}.yml`] ??= []).push(Date.parse(r.created_at));
  const hold = {
    aggregate: [76e3, 83e3, 93e3, 109e3, 146e3, 158e3],
    derive: [92e3, 102e3, 108e3, 118e3, 137e3, 234e3],
    backfill: [76e3, 81e3, 87e3, 116e3, 130e3, 131e3],
    archive: [74e3, 75e3, 81e3, 93e3, 136e3, 136e3],
    historyCollect: [13e3, 15e3, 18e3, 24e3, 157e3, 160e3],
    fsCollect: [445e3, 1879e3, 1885e3, 1898e3, 1979e3, 1981e3],
    commit: [5e3, 5e3, 7e3, 9e3, 10e3, 15e3],
  } as const;
  const week = (design: (typeof DESIGNS)[number], seed: number) =>
    summarize(
      simulate(
        syntheticArrivals({ startMs: Date.parse('2026-10-01T00:00:00Z'), days: 7, heartbeat: workflowFor, dispatchLagMs: 27_000, cronAt, hold, workflowRunLagMs: 5_000, historyCommitShare: 0.03, seed }, design),
        (g) => (g === WRITER ? design.writerQueue : 'single'),
      ),
    );
  const writerCancels = (s: ReturnType<typeof week>): number =>
    ['aggregate', 'derive', 'backfill', 'archive', 'first-solutions commit', 'history commit'].reduce((n, wf) => n + (s[wf]?.cancelled ?? 0), 0);
  const now = week(DESIGNS[0]!, 1);
  const r14 = week(DESIGNS.find((d) => d.foldDerive && d.sideCommitsOutside && d.writerQueue === 'max')!, 1);
  assert.ok(writerCancels(now) > 0, JSON.stringify(now));
  assert.equal(writerCancels(r14), 0, JSON.stringify(r14));
  assert.equal(r14['aggregate']!.arrivals, 7 * 24 * 12 + (cronAt['aggregate.yml']?.length ?? 0));
  assert.ok(r14['backfill']!.waitS.p90 < 180, JSON.stringify(r14['backfill']));
});

// ---------------------------------------------------------------------------------------------------------------------
// The workflow layout.

const wfDir = here('../.github/workflows/');
const read = (rel: string): string => readFileSync(here(`../${rel}`), 'utf8');
const workflows = (): [string, string][] => readdirSync(wfDir).filter((f) => f.endsWith('.yml')).map((f) => [f, readFileSync(join(wfDir, f), 'utf8')]);

/** The jobs of a workflow by id: each job's text up to the next job. */
const jobsOf = (yml: string): Record<string, string> => {
  const body = yml.slice(yml.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const out: Record<string, string> = {};
  const starts = [...body.matchAll(/^ {2}([\w-]+):\n/gm)];
  starts.forEach((m, i) => (out[m[1]!] = body.slice(m.index!, starts[i + 1]?.index ?? body.length)));
  return out;
};

test('workflows: the writer lock is job-level (queue: max) on the writing job of each writer, and only there (SHLTR-149)', () => {
  const members: string[] = [];
  for (const [f, yml] of workflows()) {
    const top = yml.slice(0, yml.indexOf('\njobs:'));
    // A workflow-level lock makes a run wait before its first step: nothing could keep it out of the queue.
    assert.doesNotMatch(top, /group: earthquakes-feed-writer/, `${f}: a workflow-level writer lock`);
    for (const [job, text] of Object.entries(jobsOf(yml))) {
      if (!/group: earthquakes-feed-writer/.test(text)) continue;
      members.push(`${f}:${job}`);
      assert.match(text, /\n {4}concurrency:\n {6}group: earthquakes-feed-writer\n {6}cancel-in-progress: false\n {6}queue: max\n/, `${f}:${job}`);
    }
  }
  // scripts/writer-queue.mjs counts the queue by these jobs.
  assert.deepEqual(members.sort(), Object.entries(WRITERS).map(([f, w]) => `${f}:${w.lockJob}`).sort());
});

test('workflows: every writer but aggregate passes the gate first, outside every group, and joins only when admitted', () => {
  for (const [f, w] of Object.entries(WRITERS)) {
    const yml = read(`.github/workflows/${f}`);
    const jobs = jobsOf(yml);
    const lock = jobs[w.lockJob]!;
    if (!w.gated) {
      assert.equal(jobs[GATE_JOB], undefined, `${f}: aggregate is never gated`);
      assert.doesNotMatch(lock, /\n {4}name: /, `${f}: a job display name`);
      assert.doesNotMatch(lock, /needs:/, f);
      continue;
    }
    const gate = jobs[GATE_JOB];
    assert.ok(gate, `${f}: no gate job`);
    // The jobs API names a job by its id when it has no `name:`; scripts/writer-queue.mjs looks the jobs up by id.
    for (const text of [gate, lock]) assert.doesNotMatch(text, /\n {4}name: /, `${f}: a job display name`);
    // backfill's dry run (SHLTR-146) is a job of its own, only on dry_run, outside every group, read only; the gate
    // (and so the writing job) is skipped then.
    const dry = jobs['plan'];
    if (dry) {
      assert.equal(f, 'backfill.yml', `${f}: a dry-run job`);
      assert.match(dry, /^ {2}plan:\n {4}if: \$\{\{ inputs\.dry_run \}\}\n/, `${f}: the dry run only on dry_run`);
      assert.doesNotMatch(dry, /concurrency:/, `${f}: the dry run waits in no group`);
      assert.match(dry, /\n {4}permissions:\n {6}contents: read\n {4}steps:/, `${f}: the dry run reads only`);
      assert.doesNotMatch(dry, /git (commit|push)|push-data\.sh|walk-blocked-/, `${f}: the dry run writes nothing and uploads no marker`);
      assert.match(dry, /\n {10}BACKFILL_PHASE: plan\n/, f);
      assert.match(gate, /^ {2}gate:\n {4}if: \$\{\{ !inputs\.dry_run \}\}\n/, `${f}: no gate (and no writing job) on a dry run`);
    }
    assert.deepEqual(Object.keys(jobs).filter((j) => j !== 'plan'), [GATE_JOB, w.lockJob], `${f}: the gate, then the writing job`);
    assert.doesNotMatch(gate, /concurrency:/, `${f}: the gate must not wait in any group`);
    assert.match(gate, /\n {4}permissions:\n {6}contents: read\n(?: {6}#.*\n)* {6}actions: read\n/, `${f}: the gate reads the runs (actions: read)`);
    assert.match(gate, /\n {6}admit: \$\{\{ steps\.gate\.outputs\.admit \}\}\n/, f);
    assert.match(gate, /sparse-checkout: \|\n {12}\.nvmrc\n {12}scripts\/writer-queue\.mjs\n/, f);
    assert.match(gate, new RegExp(`\\n {10}WRITER_WORKFLOW: ${f.replace('.', '\\.')}\\n`), f);
    assert.match(gate, /\n {10}FORCE: \$\{\{ inputs\.force && 'true' \|\| '' \}\}\n/, f);
    assert.match(gate, /\n {8}run: node scripts\/writer-queue\.mjs gate\n/, f);
    assert.match(lock, /^ {2}[\w-]+:\n {4}needs: gate\n {4}if: needs\.gate\.outputs\.admit == 'true'\n/, `${f}: the writing job joins only when admitted`);
    // force is a boolean input, default false.
    assert.match(yml, /\n {6}force:\n {8}description: .+\n {8}type: boolean\n {8}default: false\n/, `${f}: the force input`);
  }
  // A refused walk (the cron, the heartbeat's dispatch without a window) and a refused scheduled archive retry on their
  // own: a warning. A dispatched window and a derive by hand: an error, so whoever dispatched it sees it.
  assert.ok(read('.github/workflows/backfill.yml').includes("RETRIED: ${{ (github.event_name == 'schedule' || !(inputs.starttime && inputs.endtime)) && 'true' || '' }}"));
  assert.ok(read('.github/workflows/archive.yml').includes("RETRIED: ${{ github.event_name == 'schedule' && 'true' || '' }}"));
  assert.doesNotMatch(read('.github/workflows/derive.yml'), /RETRIED:/);
});

test('workflows: backfill holds the lock on a sparse data checkout planned by the same environment as the run', () => {
  const job = jobsOf(read('.github/workflows/backfill.yml'))['backfill']!;
  assert.match(job, /\n {10}ref: data\n {10}path: \.data\n {10}fetch-depth: 1\n {10}sparse-checkout: \/knowledge\/index\/\*\.json\n {10}sparse-checkout-cone-mode: false\n/);
  const step = (name: string): string => {
    const at = job.indexOf(`- name: ${name}\n`);
    assert.ok(at > 0, name);
    const next = job.indexOf('\n      - ', at + 1);
    return job.slice(at, next < 0 ? undefined : next);
  };
  const plan = step("Check out the months of this run's windows");
  const run = step('Backfill');
  assert.ok(job.indexOf(plan) < job.indexOf(run));
  assert.match(plan, /\n {10}BACKFILL_PHASE: paths\n/);
  assert.match(plan, /git -C \.data sparse-checkout add --stdin < "\$BACKFILL_PATHS_OUT"/);
  // Every BACKFILL_* input of the run reaches the plan too, unchanged: the two compute the same windows.
  const inputs = (text: string): string[] => [...text.matchAll(/\n {10}(BACKFILL_(?!PHASE|PATHS_OUT)\w+: .*)/g)].map((m) => m[1]!).sort();
  assert.deepEqual(inputs(plan), inputs(run));
  assert.ok(inputs(run).length >= 3);
});

test('workflows: every commit to data is pushed by scripts/push-data.sh, nowhere else', () => {
  const sources: [string, string][] = [...workflows(), ['actions/derive-publish/action.yml', read('.github/actions/derive-publish/action.yml')]];
  let pushes = 0;
  for (const [f, text] of sources) {
    assert.doesNotMatch(text, /git push/, `${f} pushes by itself`);
    const commits = (text.match(/\bgit commit\b/g) ?? []).length;
    const viaScript = (text.match(/bash "\$GITHUB_WORKSPACE\/scripts\/push-data\.sh"/g) ?? []).length;
    assert.equal(viaScript, commits, `${f}: ${commits} commit(s), ${viaScript} push-data.sh call(s)`);
    pushes += viaScript;
  }
  // aggregate, derive's steps, backfill, archive, and the history / first-solutions / remediate / remerge / stats commit
  // jobs.
  assert.equal(pushes, 9);
});

test('workflows: derive runs at the end of every aggregate job, and derive.yml only by hand', () => {
  const agg = read('.github/workflows/aggregate.yml');
  const push = agg.indexOf('scripts/push-data.sh');
  const derive = agg.indexOf('uses: ./.github/actions/derive-publish');
  assert.ok(push > 0 && derive > push, 'derive after the aggregate commit is pushed');
  assert.match(agg, /- name: Aggregate\n {8}timeout-minutes: 4\n/);
  const d = read('.github/workflows/derive.yml');
  // Dispatched by hand only (its one input: force, SHLTR-149).
  assert.equal(d.slice(d.indexOf('\non:'), d.indexOf('\n    inputs:')), '\non:\n  workflow_dispatch:');
  assert.deepEqual([...d.slice(d.indexOf('\n    inputs:'), d.indexOf('\npermissions:')).matchAll(/^ {6}(\w+):$/gm)].map((m) => m[1]), ['force']);
  assert.match(d, /uses: \.\/\.github\/actions\/derive-publish/);
  // The composite reads each secret through an input, so each step sees only its own.
  const action = read('.github/actions/derive-publish/action.yml');
  assert.doesNotMatch(action, /\$\{\{ *secrets\./);
  for (const step of ['Derive views', 'Validate output', 'Commit & push derived views', 'Sign v2 manifest', 'Publish artifacts to R2', 'Publish live feed to Cloudflare Pages']) {
    assert.ok(action.includes(`- name: ${step}`), step);
  }
});

test('workflows: the side-index commit jobs push without the lock and stage only their own files', () => {
  for (const [f, own] of [
    ['history.yml', 'knowledge/index/history.json and history-state.json'],
    ['remediate.yml', 'knowledge/index/remediation.json'],
    ['first-solutions.yml', '$dir/cursor.json and chunks.ndjson'],
    ['stats.yml', 'v1/stats and knowledge/stats'],
  ] as const) {
    const yml = read(`.github/workflows/${f}`);
    const commit = yml.slice(yml.indexOf('\n  commit:'));
    assert.doesNotMatch(commit, /concurrency:/, f);
    assert.ok(commit.includes(`refusing to commit anything but ${own}`), f);
    // push-data.sh comes from a sparse checkout of main, taken before anything else lands in the workspace.
    const steps = commit.slice(commit.indexOf('steps:'));
    const first = steps.indexOf('- uses: actions/checkout@');
    assert.ok(first > 0 && first < steps.indexOf('- uses: actions/download-artifact@') && first < steps.indexOf('ref: data'), f);
    assert.match(steps.slice(first, first + 300), /sparse-checkout: scripts\/push-data\.sh/, f);
    assert.match(commit, /PUSH_ATTEMPTS=6 PUSH_BACKOFF_S=3 bash "\$GITHUB_WORKSPACE\/scripts\/push-data\.sh"/, f);
  }
});

test('workflows: remerge.yml shares the remediate group (both write remediation.json); its commit job applies compare-and-set and stages only archives.json and remediation.json (history.json for a rollback)', () => {
  const yml = read('.github/workflows/remerge.yml');
  const top = yml.slice(0, yml.indexOf('\njobs:'));
  assert.match(top, /\nconcurrency:\n {2}group: earthquakes-feed-remediate\n {2}cancel-in-progress: false\n/);
  assert.match(read('.github/workflows/remediate.yml'), /\nconcurrency:\n {2}group: earthquakes-feed-remediate\n/);
  const commit = yml.slice(yml.indexOf('\n  commit:'));
  assert.doesNotMatch(commit, /concurrency:/, 'no job-level lock (it would be cancelled while waiting)');
  const steps = commit.slice(commit.indexOf('steps:'));
  const first = steps.indexOf('- uses: actions/checkout@');
  assert.ok(first > 0 && first < steps.indexOf('uses: actions/download-artifact@') && first < steps.indexOf('ref: data'));
  assert.match(steps.slice(first, first + 400), /sparse-checkout: \|\n {12}scripts\/push-data\.sh\n {12}scripts\/remerge-commit\.mjs\n/);
  assert.match(commit, /node scripts\/remerge-commit\.mjs apply remerge-out\/pending\.json \.data/);
  assert.match(commit, /node scripts\/remerge-commit\.mjs rollback /);
  assert.ok(commit.includes("allowed='knowledge/index/(archives|remediation)\\.json'"));
  assert.ok(commit.includes('refusing to commit anything but knowledge/index/archives.json and remediation.json'));
  assert.match(commit, /PUSH_ATTEMPTS=6 PUSH_BACKOFF_S=3 bash "\$GITHUB_WORKSPACE\/scripts\/push-data\.sh"/);
});
