import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { workflowFor } from '../heartbeat/src/worker.js';
import {
  DESIGNS,
  MAX_PENDING,
  WRITER,
  observedCancelled,
  replayArrivals,
  simulate,
  summarize,
  syntheticArrivals,
  type Arrival,
  type RunRecord,
} from '../src/writer-group.js';

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
  const outs = simulate(replayArrivals(runs, r14), (g) => (g === WRITER ? r14.writerQueue : 'single'));
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

test('workflows: every member of the writer group waits in the queue (queue: max) and none uses it at job level', () => {
  const members: string[] = [];
  for (const [f, yml] of workflows()) {
    const top = yml.slice(0, yml.indexOf('\njobs:'));
    const jobs = yml.slice(yml.indexOf('\njobs:'));
    assert.doesNotMatch(jobs, /group: earthquakes-feed-writer/, `${f}: a job-level writer lock`);
    if (/group: earthquakes-feed-writer/.test(top)) {
      members.push(f);
      assert.match(top, /concurrency:\n {2}group: earthquakes-feed-writer\n {2}cancel-in-progress: false\n {2}queue: max\n/, f);
    }
  }
  assert.deepEqual(members.sort(), ['aggregate.yml', 'archive.yml', 'backfill.yml', 'derive.yml']);
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
  // aggregate, derive's steps, backfill, archive, and the history / first-solutions / remediate commit jobs.
  assert.equal(pushes, 7);
});

test('workflows: derive runs at the end of every aggregate job, and derive.yml only by hand', () => {
  const agg = read('.github/workflows/aggregate.yml');
  const push = agg.indexOf('scripts/push-data.sh');
  const derive = agg.indexOf('uses: ./.github/actions/derive-publish');
  assert.ok(push > 0 && derive > push, 'derive after the aggregate commit is pushed');
  assert.match(agg, /- name: Aggregate\n {8}timeout-minutes: 4\n/);
  const d = read('.github/workflows/derive.yml');
  assert.equal(d.slice(d.indexOf('\non:'), d.indexOf('\nconcurrency:')), '\non:\n  workflow_dispatch:\n');
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
    ['history.yml', 'knowledge/index/history.json'],
    ['remediate.yml', 'knowledge/index/remediation.json'],
    ['first-solutions.yml', '$dir/cursor.json and chunks.ndjson'],
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
