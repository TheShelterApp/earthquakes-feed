/**
 * FEED-OPS-4: how often the data-branch writers cancel each other, measured and simulated (src/writer-group.ts).
 *
 *   npx tsx scripts/writer-group-sim.ts fetch 2026-09-29 2026-10-06 > runs.ndjson
 *       Every run of the writer workflows created in [from, to) with its jobs (one `gh api` call per run, about 4,600
 *       for a week: mind the 5,000-an-hour API budget).
 *   npx tsx scripts/writer-group-sim.ts replay runs.ndjson [fromIso toIso]
 *       Replays the real arrivals under each design (src/writer-group.ts DESIGNS); for the current one it also checks
 *       the simulated cancellations against the ones GitHub made.
 *   npx tsx scripts/writer-group-sim.ts week runs.ndjson [seeds]
 *       A synthetic week: the heartbeat Worker's schedule (heartbeat/src/worker.js), the scheduled runs GitHub delivered
 *       in the measured week, run times drawn from that week's measured quantiles; `seeds` weeks (default 20).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { workflowFor } from '../heartbeat/src/worker.js';
import {
  DESIGNS,
  WRITER,
  maxDepth,
  observedCancelled,
  replayArrivals,
  simulate,
  summarize,
  syntheticArrivals,
  type Outcome,
  type Quantiles,
  type RunRecord,
} from '../src/writer-group.js';

const REPO = 'TheShelterApp/earthquakes-feed';
const WRITERS = ['aggregate', 'derive', 'backfill', 'archive', 'history', 'first-solutions', 'remediate'];

const gh = (path: string): unknown => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 << 20 }));

function fetchRuns(from: string, to: string): void {
  for (const wf of WRITERS) {
    // One day at a time: the runs list stops at 1,000 results per query.
    for (let d = Date.parse(`${from}T00:00:00Z`); d < Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
      const a = new Date(d).toISOString().slice(0, 19) + 'Z';
      const b = new Date(d + 86_400_000).toISOString().slice(0, 19) + 'Z';
      for (let page = 1; ; page++) {
        const res = gh(`repos/${REPO}/actions/workflows/${wf}.yml/runs?created=${a}..${b}&per_page=100&page=${page}`) as {
          workflow_runs: { id: number; event: string; conclusion: string | null; created_at: string }[];
        };
        for (const r of res.workflow_runs) {
          const jobs = (gh(`repos/${REPO}/actions/runs/${r.id}/jobs?filter=latest&per_page=50`) as { jobs: Record<string, string | null>[] }).jobs.map((j) => ({
            name: j['name'],
            conclusion: j['conclusion'],
            created_at: j['created_at'],
            started_at: j['started_at'],
            completed_at: j['completed_at'],
          }));
          process.stdout.write(JSON.stringify({ wf, run: r.id, event: r.event, conclusion: r.conclusion, created_at: r.created_at, jobs }) + '\n');
        }
        if (res.workflow_runs.length < 100) break;
      }
    }
  }
}

const load = (file: string): RunRecord[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunRecord);

function table(title: string, outs: Outcome[]): void {
  const s = summarize(outs);
  console.log(`\n${title}   (writer group at most ${maxDepth(outs, WRITER)} deep)`);
  console.log('  workflow                   arrivals   ran  cancelled  lost work  wait s p50/p90/max   cancelled by');
  for (const [wf, x] of Object.entries(s)) {
    console.log(
      `  ${wf.padEnd(26)} ${String(x.arrivals).padStart(8)} ${String(x.ran).padStart(5)} ${String(x.cancelled).padStart(10)} ${`${x.lostWorkMin} min`.padStart(10)}  ${`${x.waitS.p50}/${x.waitS.p90}/${x.waitS.max}`.padStart(18)}   ${JSON.stringify(x.cancelledBy)}`,
    );
  }
}

function replay(file: string, from?: string, to?: string): void {
  const runs = load(file).filter((r) => (!from || r.created_at >= from) && (!to || r.created_at < to));
  console.log(`${runs.length} runs ${from ?? runs.map((r) => r.created_at).sort()[0]} .. ${to ?? runs.map((r) => r.created_at).sort().at(-1)}`);
  for (const d of DESIGNS) {
    const outs = simulate(replayArrivals(runs, d), (g) => (g === WRITER ? d.writerQueue : 'single'));
    table(d.name, outs);
    if (d === DESIGNS[0]) {
      const sim = new Set(outs.filter((o) => o.cancelledBy).map((o) => o.arrival.id.replace(/:(run|collect|commit)$/, '')));
      const real = new Set(runs.filter(observedCancelled).map((r) => `${r.wf}:${r.run}`));
      const both = [...real].filter((x) => sim.has(x)).length;
      console.log(`  check against GitHub: ${real.size} cancelled in reality, ${sim.size} in the replay, ${both} in both`);
    }
  }
}

/** p0, p10, p50, p90, p99, p100 of the successful jobs' run times in the measured runs. */
function quantiles(runs: RunRecord[], wf: string, job: string, fallback: Quantiles): Quantiles {
  const xs = runs
    .flatMap((r) => (r.wf === wf ? r.jobs.filter((j) => j.name === job && j.conclusion === 'success') : []))
    .map((j) => Date.parse(j.completed_at!) - Date.parse(j.started_at!))
    .filter((x) => Number.isFinite(x) && x >= 0)
    .sort((a, b) => a - b);
  if (xs.length < 5) return fallback;
  const q = (p: number): number => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  return [xs[0]!, q(0.1), q(0.5), q(0.9), q(0.99), xs[xs.length - 1]!];
}

function week(file: string, seeds: number): void {
  const runs = load(file);
  const created = runs.map((r) => Date.parse(r.created_at)).sort((a, b) => a - b);
  const startMs = Math.floor(created[0]! / 86_400_000) * 86_400_000;
  const days = 7;
  const cronAt: Record<string, number[]> = {};
  for (const r of runs) if (r.event === 'schedule') (cronAt[`${r.wf}.yml`] ??= []).push(Date.parse(r.created_at));
  // Seconds from the scheduled minute to the run's creation, for the Worker's aggregate dispatches.
  const lags = runs.filter((r) => r.wf === 'aggregate' && r.event === 'workflow_dispatch').map((r) => Date.parse(r.created_at) % 60_000).sort((a, b) => a - b);
  const dispatchLagMs = lags[Math.floor(lags.length / 2)] ?? 27_000;
  const hold = {
    aggregate: quantiles(runs, 'aggregate', 'aggregate', [70e3, 82e3, 89e3, 104e3, 112e3, 146e3]),
    derive: quantiles(runs, 'derive', 'derive', [90e3, 100e3, 107e3, 113e3, 135e3, 208e3]),
    backfill: quantiles(runs, 'backfill', 'backfill', [70e3, 79e3, 84e3, 87e3, 95e3, 95e3]),
    archive: quantiles(runs, 'archive', 'archive', [70e3, 75e3, 81e3, 136e3, 136e3, 136e3]),
    historyCollect: quantiles(runs, 'history', 'collect', [14e3, 14e3, 18e3, 23e3, 29e3, 29e3]),
    fsCollect: quantiles(runs, 'first-solutions', 'collect', [1870e3, 1879e3, 1883e3, 1886e3, 1918e3, 1918e3]),
    commit: quantiles(runs, 'first-solutions', 'commit', [4e3, 5e3, 7e3, 9e3, 10e3, 10e3]),
  };
  const historyRuns = runs.filter((r) => r.wf === 'history');
  const historyCommitShare = historyRuns.length ? historyRuns.filter((r) => r.jobs.some((j) => j.name === 'commit' && j.conclusion === 'success')).length / historyRuns.length : 0.1;
  console.log(`synthetic week from ${new Date(startMs).toISOString()}, ${seeds} seeds; dispatch lag ${Math.round(dispatchLagMs / 1000)} s; delivered crons ${JSON.stringify(Object.fromEntries(Object.entries(cronAt).map(([k, v]) => [k, v.length])))}; history commits ${Math.round(historyCommitShare * 100)} %`);
  console.log(`run time quantiles (s, p0/p10/p50/p90/p99/max): ${JSON.stringify(Object.fromEntries(Object.entries(hold).map(([k, v]) => [k, v.map((x) => Math.round(x / 1000)).join('/')])))}`);
  for (const d of DESIGNS) {
    const all: Outcome[] = [];
    let depth = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const outs = simulate(
        syntheticArrivals({ startMs, days, heartbeat: workflowFor, dispatchLagMs, cronAt, hold, workflowRunLagMs: 5_000, historyCommitShare, seed }, d),
        (g) => (g === WRITER ? d.writerQueue : 'single'),
      );
      depth = Math.max(depth, maxDepth(outs, WRITER));
      all.push(...outs);
    }
    const s = summarize(all);
    console.log(`\n${d.name}   (per week, mean of ${seeds}; writer group at most ${depth} deep)`);
    for (const [wf, x] of Object.entries(s)) {
      console.log(`  ${wf.padEnd(26)} arrivals ${(x.arrivals / seeds).toFixed(0).padStart(5)}  cancelled ${(x.cancelled / seeds).toFixed(1).padStart(6)}  lost work ${(x.lostWorkMin / seeds).toFixed(0).padStart(4)} min  wait s p50/p90/max ${x.waitS.p50}/${x.waitS.p90}/${x.waitS.max}`);
    }
  }
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'fetch' && a && b) fetchRuns(a, b);
else if (cmd === 'replay' && a) replay(a, b, c);
else if (cmd === 'week' && a) week(a, Number(b ?? 20));
else {
  console.error('usage: writer-group-sim.ts fetch <from> <to> | replay <runs.ndjson> [fromIso toIso] | week <runs.ndjson> [seeds]');
  process.exit(2);
}
