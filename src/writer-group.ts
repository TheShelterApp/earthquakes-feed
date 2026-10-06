/**
 * The `earthquakes-feed-writer` concurrency group, simulated (FEED-OPS-4; scripts/writer-group-sim.ts).
 *
 * Every workflow that commits to the `data` branch used to share one GitHub Actions concurrency group with the default
 * queue (`single`): at most one run holds the group and at most one waits; a run that arrives while another waits
 * cancels the waiting one and takes its place. In the week 2026-09-29 → 10-06 that cancelled 29 aggregate, 41 derive,
 * 8 backfill and 10 first-solutions commit jobs (14, 21, 2 and 2 of them inside the Actions incident of 10-05 19:11
 * UTC), and 3 history runs in the history group. The commit jobs had already spent about 31 minutes collecting; the
 * others had done nothing yet. Replayed here, the week gives 83 cancellations, 80 of them the runs GitHub cancelled.
 *
 * This module replays a list of arrivals (when a run or job enters its group, how long it holds it once started)
 * through GitHub's documented rules, so a schedule or a design can be compared on the same timestamps:
 * - `single` (GitHub's default): one running, one pending; a newer arrival cancels the pending one.
 * - `max` (`concurrency.queue: max`, GitHub changelog 2026-05-07): up to 100 pending, started first in, first out; an
 *   arrival that finds 100 waiting is cancelled itself.
 * A `null` group never waits (a job outside every group). `then` models a `workflow_run` chain: derive.yml used to be
 * triggered by every completed aggregate run and arrived in the same group a few seconds later.
 */

export type QueueMode = 'single' | 'max';

/** GitHub's cap on pending runs per group with `queue: max`. */
export const MAX_PENDING = 100;

export interface Follow {
  workflow: string;
  lagMs: number;
  group: string | null;
  holdMs: number;
  priorWorkMs?: number;
}

export interface Arrival {
  id: string;
  workflow: string;
  /** ms epoch: the run (workflow-level concurrency) or job (job-level) enters its group. */
  at: number;
  group: string | null;
  /** How long it holds the group once started (its job's run time). */
  holdMs: number;
  /** Work already done before it entered the group (a collect job's requests): lost if it is cancelled. */
  priorWorkMs?: number;
  /** Arrivals its completion causes (workflow_run), each `lagMs` after it ends. */
  then?: Follow[];
}

export interface Outcome {
  arrival: Arrival;
  startedAt: number | null;
  endedAt: number | null;
  /** The arrival that cancelled it while it waited (`single`), or itself when it found the queue full (`max`). */
  cancelledBy: Arrival | null;
}

interface GroupState {
  running: { a: Arrival; endsAt: number } | null;
  pending: Arrival[];
}

/**
 * Replay `arrivals` through the groups. `queue` gives each group's mode (default `single`). Deterministic: arrivals are
 * taken in time order (ties by id), a completion at the same instant as an arrival is handled first, so a run that
 * frees the group at t starts its successor before anything arriving at t is queued.
 */
export function simulate(arrivals: readonly Arrival[], queue: (group: string) => QueueMode = () => 'single'): Outcome[] {
  const outcomes = new Map<Arrival, Outcome>();
  const groups = new Map<string, GroupState>();
  const incoming: Arrival[] = [...arrivals].sort(byTime);
  let followSeq = 0;
  const outOf = (a: Arrival): Outcome => {
    let o = outcomes.get(a);
    if (!o) outcomes.set(a, (o = { arrival: a, startedAt: null, endedAt: null, cancelledBy: null }));
    return o;
  };
  const state = (g: string): GroupState => {
    let s = groups.get(g);
    if (!s) groups.set(g, (s = { running: null, pending: [] }));
    return s;
  };
  // Ungrouped runs never wait; they only matter for their follows.
  const free: { a: Arrival; endsAt: number }[] = [];
  const start = (a: Arrival, t: number): { a: Arrival; endsAt: number } => {
    const o = outOf(a);
    o.startedAt = t;
    return { a, endsAt: t + Math.max(0, a.holdMs) };
  };
  const finish = (r: { a: Arrival; endsAt: number }): void => {
    outOf(r.a).endedAt = r.endsAt;
    for (const f of r.a.then ?? []) {
      const a: Arrival = { id: `${r.a.id}>${f.workflow}#${followSeq++}`, workflow: f.workflow, at: r.endsAt + f.lagMs, group: f.group, holdMs: f.holdMs };
      if (f.priorWorkMs != null) a.priorWorkMs = f.priorWorkMs;
      insertSorted(incoming, a);
    }
  };

  for (;;) {
    // The earliest completion among the running runs (grouped or not).
    let next: { kind: 'end'; t: number; group: string | null; idx: number } | null = null;
    for (const [g, s] of groups) if (s.running && (!next || s.running.endsAt < next.t)) next = { kind: 'end', t: s.running.endsAt, group: g, idx: -1 };
    for (let i = 0; i < free.length; i++) if (!next || free[i]!.endsAt < next.t) next = { kind: 'end', t: free[i]!.endsAt, group: null, idx: i };
    const arrival = incoming[0];
    if (!next && !arrival) break;
    if (next && (!arrival || next.t <= arrival.at)) {
      if (next.group == null) {
        const [r] = free.splice(next.idx, 1);
        finish(r!);
        continue;
      }
      const s = state(next.group);
      finish(s.running!);
      const successor = s.pending.shift();
      s.running = successor ? start(successor, next.t) : null;
      continue;
    }
    incoming.shift();
    const a = arrival!;
    outOf(a);
    if (a.group == null) {
      free.push(start(a, a.at));
      continue;
    }
    const s = state(a.group);
    if (!s.running) {
      s.running = start(a, a.at);
      continue;
    }
    if (queue(a.group) === 'max') {
      if (s.pending.length >= MAX_PENDING) outOf(a).cancelledBy = a;
      else s.pending.push(a);
      continue;
    }
    for (const p of s.pending.splice(0)) outOf(p).cancelledBy = a;
    s.pending.push(a);
  }
  return [...arrivals, ...[...outcomes.keys()].filter((a) => !arrivals.includes(a))].map((a) => outOf(a));
}

function byTime(a: Arrival, b: Arrival): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function insertSorted(list: Arrival[], a: Arrival): void {
  let i = list.length;
  while (i > 0 && byTime(list[i - 1]!, a) > 0) i--;
  list.splice(i, 0, a);
}

export interface WorkflowSummary {
  arrivals: number;
  ran: number;
  cancelled: number;
  /** Minutes of work done before the group that cancelled arrivals threw away. */
  lostWorkMin: number;
  /** Seconds between entering the group and starting: median, 90th percentile, max (runs that started). */
  waitS: { p50: number; p90: number; max: number };
  cancelledBy: Record<string, number>;
}

export function summarize(outcomes: readonly Outcome[]): Record<string, WorkflowSummary> {
  const by = new Map<string, Outcome[]>();
  for (const o of outcomes) (by.get(o.arrival.workflow) ?? by.set(o.arrival.workflow, []).get(o.arrival.workflow)!).push(o);
  const out: Record<string, WorkflowSummary> = {};
  for (const [wf, os] of [...by].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const waits = os.filter((o) => o.startedAt != null).map((o) => (o.startedAt! - o.arrival.at) / 1000).sort((a, b) => a - b);
    const q = (x: number): number => (waits.length ? Math.round(waits[Math.min(waits.length - 1, Math.floor(waits.length * x))]!) : 0);
    const cancelled = os.filter((o) => o.cancelledBy);
    const cancelledBy: Record<string, number> = {};
    for (const o of cancelled) cancelledBy[o.cancelledBy!.workflow] = (cancelledBy[o.cancelledBy!.workflow] ?? 0) + 1;
    out[wf] = {
      arrivals: os.length,
      ran: os.filter((o) => o.startedAt != null).length,
      cancelled: cancelled.length,
      lostWorkMin: Math.round(cancelled.reduce((s, o) => s + (o.arrival.priorWorkMs ?? 0), 0) / 60_000),
      waitS: { p50: q(0.5), p90: q(0.9), max: waits.length ? Math.round(waits[waits.length - 1]!) : 0 },
      cancelledBy,
    };
  }
  return out;
}

/** The busiest the group's queue got (running + pending) over the replay. */
export function maxDepth(outcomes: readonly Outcome[], group: string): number {
  const ev: [number, number][] = [];
  for (const o of outcomes) {
    if (o.arrival.group !== group) continue;
    ev.push([o.arrival.at, 1]);
    const leave = o.endedAt ?? (o.cancelledBy ? o.cancelledBy.at : null);
    if (leave != null) ev.push([leave, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let d = 0;
  let m = 0;
  for (const [, x] of ev) m = Math.max(m, (d += x));
  return m;
}

// ---------------------------------------------------------------------------------------------------------------------
// Designs: the same runs under different workflow layouts.

export const WRITER = 'earthquakes-feed-writer';
export const HISTORY = 'earthquakes-feed-history';

export interface Design {
  name: string;
  /** derive's steps run at the end of the aggregate job (same checkout); derive.yml is dispatched by hand only. */
  foldDerive: boolean;
  /** The history / first-solutions / remediate commit jobs (each writes only its own index files) hold no group. */
  sideCommitsOutside: boolean;
  writerQueue: QueueMode;
}

export const DESIGNS: readonly Design[] = [
  { name: 'current (single queue, derive by workflow_run, commit jobs in the group)', foldDerive: false, sideCommitsOutside: false, writerQueue: 'single' },
  { name: 'queue: max only', foldDerive: false, sideCommitsOutside: false, writerQueue: 'max' },
  { name: 'derive folded + commit jobs outside, single queue', foldDerive: true, sideCommitsOutside: true, writerQueue: 'single' },
  { name: 'derive folded + commit jobs outside + queue: max (round 14)', foldDerive: true, sideCommitsOutside: true, writerQueue: 'max' },
];

/** One workflow run as `gh api …/actions/runs` and `…/runs/{id}/jobs` describe it (scripts/writer-group-sim.ts fetch). */
export interface RunRecord {
  wf: string;
  run: number;
  event: string;
  conclusion: string | null;
  created_at: string;
  jobs: JobRecord[];
}
export interface JobRecord {
  name: string;
  conclusion: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

/** Measured on 2026-10-03/04 (scripts/writer-group-sim.ts): the data checkout, setup-node and npm ci of a writer job. */
export const JOB_SETUP_MS = 75_000;
/** derive's own steps after that setup (derive, validate, commit, sign, R2, Pages): median of 40 jobs. */
export const DERIVE_TAIL_MS = 30_000;

const ms = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);
const jobHold = (j: JobRecord | undefined): number | null => {
  const s = ms(j?.started_at);
  const e = ms(j?.completed_at);
  return s != null && e != null && e >= s ? e - s : null;
};

function median(xs: number[], fallback: number): number {
  if (!xs.length) return fallback;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** True when the run (or its commit job) was cancelled in reality: what a replay of `current` should reproduce. */
export function observedCancelled(r: RunRecord): boolean {
  if (r.wf === 'history' || r.wf === 'first-solutions' || r.wf === 'remediate') {
    // A commit job runs for seconds: cancelled short of its 10-minute timeout, it was cancelled while it waited.
    const commit = r.jobs.find((j) => j.name === 'commit');
    if (commit) return commit.conclusion === 'cancelled' && (jobHold(commit) ?? 0) < 540_000;
    return r.conclusion === 'cancelled' && r.jobs.length === 0;
  }
  // Superseded while pending: the run never got a job (workflow-level concurrency).
  return r.conclusion === 'cancelled' && r.jobs.length === 0;
}

/** The arrivals of `runs` under `design`. Runs that never ran are given their workflow's median run time. */
export function replayArrivals(runs: readonly RunRecord[], design: Design): Arrival[] {
  const holds = new Map<string, number[]>();
  const note = (k: string, v: number | null): void => {
    if (v != null) (holds.get(k) ?? holds.set(k, []).get(k)!).push(v);
  };
  for (const r of runs) for (const j of r.jobs) if (j.conclusion === 'success') note(`${r.wf}:${j.name}`, jobHold(j));
  const med = (k: string, fallback: number): number => median(holds.get(k) ?? [], fallback);

  // derive's tail per aggregate run: the derive run its completion triggered (created within 2 minutes of its end).
  const derives = runs.filter((r) => r.wf === 'derive' && r.event === 'workflow_run').map((r) => ({ at: Date.parse(r.created_at), hold: jobHold(r.jobs[0]) })).sort((a, b) => a.at - b.at);
  const tailAfter = (endMs: number): number => {
    const d = derives.find((x) => x.at >= endMs && x.at <= endMs + 120_000 && x.hold != null);
    return d ? Math.max(15_000, d.hold! - JOB_SETUP_MS) : DERIVE_TAIL_MS;
  };

  const out: Arrival[] = [];
  const writerOrNull = design.sideCommitsOutside ? null : WRITER;
  for (const r of runs) {
    const created = Date.parse(r.created_at);
    const id = `${r.wf}:${r.run}`;
    switch (r.wf) {
      case 'aggregate':
      case 'backfill':
      case 'archive': {
        const j = r.jobs[0];
        let hold = jobHold(j) ?? med(`${r.wf}:${r.wf}`, 90_000);
        if (r.wf === 'aggregate' && design.foldDerive && j?.conclusion === 'success') hold += tailAfter(ms(j.completed_at)!);
        out.push({ id, workflow: r.wf, at: created, group: WRITER, holdMs: hold });
        break;
      }
      case 'derive': {
        if (design.foldDerive && r.event !== 'workflow_dispatch') break;
        // A run whose job was skipped (its aggregate failed) still passes through the group, for an instant.
        const j = r.jobs[0];
        const hold = r.conclusion === 'skipped' ? 2_000 : jobHold(j) ?? med('derive:derive', 110_000);
        out.push({ id, workflow: 'derive', at: created, group: WRITER, holdMs: hold });
        break;
      }
      case 'history':
      case 'first-solutions':
      case 'remediate': {
        const collect = r.jobs.find((j) => j.name === 'collect');
        // A commit job skipped by its `if` (nothing collected) never entered a group.
        const commit = r.jobs.find((j) => j.name === 'commit' && j.conclusion !== 'skipped');
        const collectHold = jobHold(collect) ?? med(`${r.wf}:collect`, 20_000);
        // history.yml / remediate.yml hold their own group for the whole run; first-solutions' collect job holds the
        // history group (job level).
        if (r.wf === 'history') out.push({ id: `${id}:run`, workflow: 'history', at: created, group: HISTORY, holdMs: collectHold + (jobHold(commit) ?? 0) });
        if (r.wf === 'first-solutions' && (collect || r.conclusion === 'cancelled')) {
          out.push({ id: `${id}:collect`, workflow: 'first-solutions collect', at: ms(collect?.created_at) ?? created, group: HISTORY, holdMs: collectHold });
        }
        if (commit && ms(commit.created_at) != null) {
          out.push({
            id: `${id}:commit`,
            workflow: `${r.wf} commit`,
            at: ms(commit.created_at)!,
            group: writerOrNull,
            holdMs: commit.conclusion === 'success' ? jobHold(commit) ?? med(`${r.wf}:commit`, 8_000) : med(`${r.wf}:commit`, 8_000),
            priorWorkMs: collectHold,
          });
        }
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// A synthetic week: the heartbeat Worker's schedule, GitHub's delivered cron timestamps, sampled run times.

/** Quantiles (p0, p10, p50, p90, p99, p100) of a run time in ms, sampled by piecewise-linear inverse CDF. */
export type Quantiles = readonly [number, number, number, number, number, number];
const Q_AT = [0, 0.1, 0.5, 0.9, 0.99, 1] as const;

export function sampleQuantiles(q: Quantiles, u: number): number {
  for (let i = 1; i < Q_AT.length; i++) {
    if (u <= Q_AT[i]!) {
      const f = (u - Q_AT[i - 1]!) / (Q_AT[i]! - Q_AT[i - 1]!);
      return q[i - 1]! + f * (q[i]! - q[i - 1]!);
    }
  }
  return q[q.length - 1]!;
}

/** mulberry32: a small seeded PRNG, so a synthetic week is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WeekInput {
  startMs: number;
  days: number;
  /** The workflow (file name) the heartbeat dispatches at a UTC minute (heartbeat/src/worker.js workflowFor). */
  heartbeat: (minute: number) => string | null;
  /** Seconds from the scheduled minute to the run's creation (the Worker's dispatch and GitHub's intake). */
  dispatchLagMs: number;
  /** GitHub's delivered scheduled runs per workflow (ms epoch), e.g. the week the replay measured. */
  cronAt: Record<string, number[]>;
  /** Job run times. */
  hold: Record<'aggregate' | 'derive' | 'backfill' | 'archive' | 'historyCollect' | 'fsCollect' | 'commit', Quantiles>;
  /** derive.yml's workflow_run arrival after an aggregate run ends. */
  workflowRunLagMs: number;
  /** Share of history runs that commit (the walk had something to do). */
  historyCommitShare: number;
  seed: number;
}

export function syntheticArrivals(w: WeekInput, design: Design): Arrival[] {
  const r = rng(w.seed);
  const sample = (k: keyof WeekInput['hold']): number => sampleQuantiles(w.hold[k], r());
  const out: Arrival[] = [];
  const writerOrNull = design.sideCommitsOutside ? null : WRITER;
  const derive = (): Follow[] =>
    design.foldDerive ? [] : [{ workflow: 'derive', lagMs: w.workflowRunLagMs, group: WRITER, holdMs: sample('derive') }];
  const add = (wf: string, at: number, n: number): void => {
    const id = `${wf}@${n}`;
    switch (wf) {
      case 'aggregate.yml': {
        const hold = sample('aggregate') + (design.foldDerive ? sampleQuantiles(w.hold.derive, r()) - JOB_SETUP_MS : 0);
        out.push({ id, workflow: 'aggregate', at, group: WRITER, holdMs: Math.max(20_000, hold), then: derive() });
        break;
      }
      case 'derive.yml':
        if (!design.foldDerive) out.push({ id, workflow: 'derive', at, group: WRITER, holdMs: sample('derive') });
        break;
      case 'backfill.yml':
        out.push({ id, workflow: 'backfill', at, group: WRITER, holdMs: sample('backfill') });
        break;
      case 'archive.yml':
        out.push({ id, workflow: 'archive', at, group: WRITER, holdMs: sample('archive') });
        break;
      case 'history.yml': {
        const commits = r() < w.historyCommitShare;
        const collect = commits ? sample('historyCollect') : 20_000;
        out.push({ id, workflow: 'history', at, group: HISTORY, holdMs: collect + (commits ? 8_000 : 0) });
        // Approximation: the commit job enters its group when the collect job would end if it started at once.
        if (commits) out.push({ id: `${id}:commit`, workflow: 'history commit', at: at + collect, group: writerOrNull, holdMs: sample('commit'), priorWorkMs: collect });
        break;
      }
      case 'first-solutions.yml': {
        const collect = sample('fsCollect');
        out.push({ id: `${id}:collect`, workflow: 'first-solutions collect', at, group: HISTORY, holdMs: collect, then: [{ workflow: 'first-solutions commit', lagMs: 1_000, group: writerOrNull, holdMs: sample('commit'), priorWorkMs: collect }] });
        break;
      }
    }
  };
  let n = 0;
  for (let t = w.startMs; t < w.startMs + w.days * 86_400_000; t += 60_000) {
    const wf = w.heartbeat(new Date(t).getUTCMinutes());
    if (wf && wf !== 'health.yml') add(wf, t + w.dispatchLagMs, n++);
  }
  for (const [wf, times] of Object.entries(w.cronAt)) for (const t of times) add(wf, t, n++);
  return out;
}
