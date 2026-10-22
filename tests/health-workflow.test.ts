import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs as alertsArgs } from '../scripts/alerts-watchdog.mjs';
import { parseArgs as feedArgs, REGISTRY_PATH } from '../scripts/feed-health.mjs';
import { EVALUATORS, HEALTH_FALLBACK_CRON, RULES, findingsDocument, makeFinding } from '../scripts/lib/findings.mjs';
import { parseArgs as platformArgs } from '../scripts/platform-watchdog.mjs';
import { SELFTEST_CRON, main as reconcileMain, parseArgs as reconcileArgs } from '../scripts/reconcile.mjs';

// The wiring of .github/workflows/health.yml (alerting plan of 2026-10-22, Phase 1a item 6) and of the walks' blocked
// markers (item 7): a gate job, three stateless evaluator jobs that hand reconcile one findings document each as an
// artifact, and one reconcile job, the only one that may write issues. The evaluators and reconcile have their own tests
// (tests/feed-health.test.ts, alerts-watchdog.test.ts, platform-watchdog.test.ts, reconcile.test.ts); this checks that
// the workflow files call them the way those scripts expect, and that what one job writes is what the next one reads.

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const health = read('.github/workflows/health.yml');
const top = health.slice(0, health.indexOf('\njobs:'));

/** The job ids of a workflow, in file order. */
function jobIds(yml: string): string[] {
  const lines = yml.split('\n');
  const at = lines.indexOf('jobs:');
  assert.ok(at > 0, 'a jobs: section');
  return lines.slice(at + 1).flatMap((l) => /^ {2}([a-z][\w-]*):\s*$/.exec(l)?.slice(1, 2) ?? []);
}

/** The block of job `id`, from its `  id:` line to the next job. */
function job(yml: string, id: string): string {
  const lines = yml.split('\n');
  const at = lines.indexOf('jobs:');
  const start = lines.findIndex((l, i) => i > at && l === `  ${id}:`);
  assert.ok(start > 0, `job ${id}`);
  const next = lines.findIndex((l, i) => i > start && /^ {2}[a-z][\w-]*:\s*$/.test(l));
  return lines.slice(start, next < 0 ? lines.length : next).join('\n');
}

/** The steps of a job block, each from its `      - ` line to the next, ending in a newline. */
const steps = (block: string): string[] => block.split(/\n(?= {6}- )/).slice(1).map((s) => (s.endsWith('\n') ? s : `${s}\n`));

/** The one step of `block` that contains `needle`. */
function stepWith(block: string, needle: string): string {
  const found = steps(block).filter((s) => s.includes(needle));
  assert.equal(found.length, 1, `exactly one step with ${needle}`);
  return found[0]!;
}

const SCRIPTS: Record<string, string> = { feed: 'feed-health.mjs', alerts: 'alerts-watchdog.mjs', platform: 'platform-watchdog.mjs' };

test('health.yml: the heartbeat dispatch, the fallback cron the gate judges and the monthly selftest cron', () => {
  const crons = [...top.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(crons, [HEALTH_FALLBACK_CRON, SELFTEST_CRON]);
  assert.match(top, /workflow_dispatch:\n {4}inputs:\n {6}watchdog_selftest:\n {8}description: .+\n {8}type: boolean\n {8}default: false\n/);
});

test('health.yml: one run at a time, the five jobs, and only reconcile may write issues', () => {
  assert.match(top, /\nconcurrency:\n {2}group: health\n {2}cancel-in-progress: false\n/);
  assert.match(top, /\npermissions:\n {2}contents: read\n$/);
  assert.deepEqual(jobIds(health), ['gate', 'feed', 'alerts', 'platform', 'reconcile']);
  assert.equal((health.match(/issues: write/g) ?? []).length, 1);
  assert.match(job(health, 'reconcile'), /\n {4}permissions:\n {6}contents: read\n(?: {6}#.*\n)* {6}issues: write\n/);
  // The old issue steps and inline scripts are gone: every issue write is scripts/reconcile.mjs's.
  assert.doesNotMatch(health, /gh issue|gh api|node -e|curl /);
  for (const id of jobIds(health)) {
    const block = job(health, id);
    assert.match(block, /\n {4}runs-on: ubuntu-24\.04\n/, id);
    assert.match(block, /\n {4}timeout-minutes: \d+\n/, id);
    assert.match(block, /\n {4}permissions:\n/, `${id} sets its own permissions`);
    assert.match(block, /persist-credentials: false/, id);
  }
});

test('health.yml: the gate job hands reconcile --gate what it reads and exposes the outputs the other jobs compare', async () => {
  const gate = job(health, 'gate');
  assert.match(gate, /\n {6}actions: read\n/);
  assert.match(gate, /\n {6}run: \$\{\{ steps\.gate\.outputs\.run \}\}\n {6}selftest: \$\{\{ steps\.gate\.outputs\.selftest \}\}\n/);
  const step = stepWith(gate, 'reconcile.mjs --gate');
  assert.match(step, /\n {8}id: gate\n/);
  for (const line of ['GH_TOKEN: ${{ github.token }}', 'EVENT: ${{ github.event_name }}', 'SCHEDULE: ${{ github.event.schedule }}', 'SELFTEST_INPUT: ${{ inputs.watchdog_selftest }}']) {
    assert.ok(step.includes(`\n          ${line}\n`), line);
  }
  assert.match(step, /\n {8}run: node scripts\/reconcile\.mjs --gate\n/);
  assert.deepEqual(reconcileArgs(['--gate']), { gate: true, findingsDir: null, dryRun: false });

  // The values the workflow compares: run == 'true' (the evaluators and reconcile), selftest '1' (the alerts job).
  const gateOutput = async (env: Record<string, string>): Promise<string> => {
    let out = '';
    const code = await reconcileMain({ argv: ['--gate'], env: { ...env, GITHUB_OUTPUT: 'out' }, log: () => {}, appendFile: (_p, s) => void (out += s), now: () => Date.parse('2026-11-01T09:17:30Z') });
    assert.equal(code, 0);
    return out;
  };
  assert.equal(await gateOutput({ EVENT: 'schedule', SCHEDULE: SELFTEST_CRON }), 'run=true\nselftest=1\n');
  assert.equal(await gateOutput({ EVENT: 'workflow_dispatch', SELFTEST_INPUT: 'false' }), 'run=true\nselftest=0\n');
  assert.equal(await gateOutput({ EVENT: 'workflow_dispatch', SELFTEST_INPUT: 'true' }), 'run=true\nselftest=1\n');
  for (const id of ['feed', 'alerts', 'platform']) assert.match(job(health, id), /\n {4}needs: gate\n {4}if: needs\.gate\.outputs\.run == 'true'\n/, id);
});

test('health.yml: each evaluator job writes one findings document as the artifact findings-<evaluator>, and nothing else', () => {
  assert.deepEqual([...EVALUATORS].sort(), Object.keys(SCRIPTS).sort());
  for (const ev of EVALUATORS) {
    const block = job(health, ev);
    const path = `findings/${ev}.json`;
    const run = stepWith(block, `scripts/${SCRIPTS[ev]}`);
    assert.match(run, new RegExp(`\\n {8}run: node scripts/${SCRIPTS[ev]!.replace('.', '\\.')} --findings ${path.replace('.', '\\.')}\\n`), ev);
    const upload = stepWith(block, 'actions/upload-artifact@');
    assert.ok(upload.includes(`\n          name: findings-${ev}\n          path: ${path}\n          if-no-files-found: error\n`), ev);
    assert.doesNotMatch(block, /issues:|HC_PING_KEY|continue-on-error/, ev);
  }
  // Each script accepts the arguments the job gives it.
  assert.equal(feedArgs(['--findings', 'findings/feed.json']).findingsPath, 'findings/feed.json');
  assert.equal(alertsArgs(['--findings', 'findings/alerts.json'], {}).findingsPath, 'findings/alerts.json');
  assert.equal(platformArgs(['--findings', 'findings/platform.json']).findingsPath, 'findings/platform.json');
});

test('health.yml: the feed job checks out what feed-health reads and may read the walks\' marker artifacts', () => {
  const feed = job(health, 'feed');
  assert.match(feed, /\n {6}actions: read\n/);
  assert.match(feed, /sparse-checkout: \|\n {12}scripts\n {12}providers\n/);
  assert.match(REGISTRY_PATH.replace(/\\/g, '/'), /\/providers\/registry\.json$/);
  assert.ok(stepWith(feed, 'feed-health.mjs').includes('\n          GH_TOKEN: ${{ github.token }}\n'));
});

test('health.yml: the alerts job gets the selftest from the gate, the account-usage settings and nothing that writes', () => {
  const step = stepWith(job(health, 'alerts'), 'alerts-watchdog.mjs');
  assert.ok(step.includes('\n          WATCHDOG_SELFTEST: ${{ needs.gate.outputs.selftest }}\n'));
  assert.ok(step.includes('\n          CF_ANALYTICS_TOKEN: ${{ secrets.CF_ANALYTICS_TOKEN }}\n'));
  assert.ok(step.includes('\n          CF_ACCOUNT_ID: ${{ vars.CF_ANALYTICS_ACCOUNT_ID || secrets.CF_ACCOUNT_ID }}\n'));
  assert.equal(alertsArgs([], { WATCHDOG_SELFTEST: '1' }).selftest, true);
  assert.equal(alertsArgs([], { WATCHDOG_SELFTEST: '0' }).selftest, false);
  assert.equal(alertsArgs([], { WATCHDOG_SELFTEST: '' }).selftest, false);
});

test('health.yml: reconcile runs after every evaluator, even a failed one, but not in a cancelled run, and reads every findings artifact', () => {
  const block = job(health, 'reconcile');
  assert.match(block, /\n {4}needs: \[gate, feed, alerts, platform\]\n/);
  // !cancelled(), not always(): a run cancelled by hand would record its stopped evaluators as missing.
  assert.match(block, /\n {4}if: \$\{\{ !cancelled\(\) && needs\.gate\.outputs\.run == 'true' \}\}\n/);
  assert.doesNotMatch(health, /always\(\) && needs\.gate/);
  const download = stepWith(block, 'actions/download-artifact@');
  assert.ok(download.includes('\n          pattern: findings-*\n          path: findings\n          merge-multiple: true'));
  const run = stepWith(block, 'reconcile.mjs');
  assert.match(run, /\n {8}run: node scripts\/reconcile\.mjs --findings-dir findings\n/);
  for (const line of ['GH_TOKEN: ${{ github.token }}', 'HEALTH_SILENCES: ${{ vars.HEALTH_SILENCES }}', 'HC_PING_KEY: ${{ secrets.HC_PING_KEY }}']) {
    assert.ok(run.includes(`\n          ${line}\n`), line);
  }
  assert.deepEqual(reconcileArgs(['--findings-dir', 'findings']), { gate: false, findingsDir: 'findings', dryRun: false });
});

test('health.yml end to end: the documents the evaluator jobs upload are the ones reconcile reads; a missing one does not make reconcile exit red', async () => {
  const NOW = Date.parse('2026-10-22T12:07:00Z');
  /** The findings directory as the reconcile job's download leaves it: each job's upload path, merged. */
  const dirWith = (docs: Record<string, object>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'health-findings-'));
    for (const ev of Object.keys(docs)) {
      const path = /\n {10}path: (findings\/[a-z]+\.json)\n/.exec(stepWith(job(health, ev), 'actions/upload-artifact@'))![1]!;
      writeFileSync(join(dir, path.slice('findings/'.length)), JSON.stringify(docs[ev]));
    }
    return dir;
  };
  const doc = (evaluator: (typeof EVALUATORS)[number], findings: ReturnType<typeof makeFinding>[] = []) => findingsDocument({ evaluator, generatedAtMs: NOW - 30_000, findings });
  const dryRun = async (dir: string): Promise<{ code: number; log: string[] }> => {
    const log: string[] = [];
    const code = await reconcileMain({ argv: ['--findings-dir', dir, '--dry-run'], env: {}, now: () => NOW, log: (l) => void log.push(l) });
    return { code, log };
  };

  const all = await dryRun(dirWith({ feed: doc('feed'), alerts: doc('alerts'), platform: doc('platform') }));
  assert.equal(all.code, 0);
  assert.ok(all.log.includes('reconcile: findings from alerts (0), feed (0), platform (0)'), all.log.join('\n'));

  // An evaluator job that crashed uploads nothing: reconcile files its absence as a watcher finding (P3 after 2 runs)
  // and its own exit code stays 0. The run is red all the same: the evaluator's own job failed (no evaluator job has
  // continue-on-error, checked above).
  const crashed = await dryRun(dirWith({ feed: doc('feed'), alerts: doc('alerts') }));
  assert.equal(crashed.code, 0);
  assert.ok(crashed.log.some((l) => l.includes('watcher:evaluator:platform')), crashed.log.join('\n'));

  // The selftest's forced P1 (the alerts job with WATCHDOG_SELFTEST=1) turns the run red.
  const selftest = makeFinding('alerts:selftest', { text: 'forced by the selftest' });
  assert.equal((await dryRun(dirWith({ feed: doc('feed'), alerts: doc('alerts', [selftest]), platform: doc('platform') }))).code, 1);
});

// --- the walks (Phase 1a item 7): a blocked marker keeps the run green, with a warning and the marker artifact the feed
// evaluator reads (RULES.walks: walk-blocked-<workflow>, held 26 h) ---

const WALKS: Array<{ workflow: string; marker: string; writer: [string, string] }> = [
  { workflow: 'history', marker: 'history-blocked.txt', writer: ['src/history.ts', "'history-blocked.txt'"] },
  { workflow: 'first-solutions', marker: 'fs-out/blocked.txt', writer: ['src/first-solutions-collect.ts', "'blocked.txt'"] },
  { workflow: 'backfill', marker: 'backfill-blocked.txt', writer: ['src/backfill.ts', "'backfill-blocked.txt'"] },
  { workflow: 'archive', marker: 'archive-blocked.txt', writer: ['src/archive.ts', "'archive-blocked.txt'"] },
];

test('walks: a blocked marker is a warning on a green run and the artifact walk-blocked-<workflow>, kept past the 26 h hold', () => {
  const lim = RULES.walks.limits as { workflows: string[]; artifactPrefix: string; markerHoldMs: number };
  assert.deepEqual(WALKS.map((w) => w.workflow), lim.workflows);
  for (const { workflow, marker, writer } of WALKS) {
    const yml = read(`.github/workflows/${workflow}.yml`);
    assert.ok(read(writer[0]).includes(writer[1]), `${writer[0]} writes ${writer[1]}`);
    assert.doesNotMatch(yml, /- name: Fail if/, workflow);
    const warn = steps(yml).filter((s) => s.includes(`if [ -f ${marker} ]`));
    assert.equal(warn.length, 1, workflow);
    assert.match(warn[0]!, /\n {8}if: always\(\)\n/, workflow);
    assert.match(warn[0]!, /echo '::warning::/, workflow);
    assert.doesNotMatch(warn[0]!, /exit 1|::error::/, workflow);
    const upload = steps(yml).filter((s) => s.includes(`name: ${lim.artifactPrefix}${workflow}\n`));
    assert.equal(upload.length, 1, workflow);
    assert.match(upload[0]!, /\n {8}if: always\(\)( && !inputs\.dry_run)?\n {8}uses: actions\/upload-artifact@[0-9a-f]{40} # v/, workflow);
    assert.ok(upload[0]!.includes(`\n          path: ${marker}\n          if-no-files-found: ignore\n`), workflow);
    const days = Number(/\n {10}retention-days: (\d+)\n/.exec(upload[0]!)?.[1]);
    assert.ok(days * 86_400_000 > lim.markerHoldMs, `${workflow}: the marker outlives the hold`);
  }
  // first-solutions' collect writes its marker under FIRST_SOLUTIONS_OUT, which the workflow sets to fs-out.
  assert.match(read('.github/workflows/first-solutions.yml'), /\n {10}FIRST_SOLUTIONS_OUT: fs-out\n/);
});
