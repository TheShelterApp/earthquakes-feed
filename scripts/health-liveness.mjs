#!/usr/bin/env node
// Health's own liveness (owner decision 2026-11-19), run by .github/workflows/health-liveness.yml on a GitHub cron of
// its own. It replaces the dead-man switch Healthchecks.io was to be (dropped: its sign-up email never arrived).
//
// health.yml is dispatched by the heartbeat Worker every 15 min, with its own `:25` cron as the fallback; when both stop
// (the Worker down or its GH_PAT refused, and GitHub not delivering the cron, which it often does not for this repo), no
// health run happens, nothing turns red and the boards simply stop changing. Runs that start but never reconcile (the
// gate job failing at checkout or setup-node, reconcile exiting 3 before it saved a board) are the same outage: the
// boards stop changing, no P1/P2 mention can go out, and only each run's failed-run email says anything. So this check
// measures what health WROTE, not whether its runs finished: the boards' newest state.updatedMs (reconcile rewrites every
// board's hidden state on every run that applies a fresh document; reconcile.mjs lastReconciledMs), the same time
// reconcile's own gap is measured from, so "health is down" here and "Health runs again" there describe one outage.
// It reads the boards and health.yml's runs from outside, on a path that shares nothing with the Worker:
//
//   - health last reconciled over HEALTH_STALE_MS (45 min: three missed dispatches) ago: dispatch health.yml once, as the
//     Worker does (self-heal). Not again while a health run was created within the last 45 min (it is queued or running,
//     or it ran and failed: another dispatch would join it or fail the same way);
//   - over HEALTH_DEAD_MS (90 min): one comment on the "[health] platform" board that @mentions HEALTH_MENTION (GitHub
//     Mobile pushes it), once per outage, and that run is red (exit 1: the failed-run email, a second channel). The
//     outage is everything since the last reconcile: a bot comment with the outage marker (`<!-- health-liveness v1
//     outage=<last reconcile ms> -->`, reconcile.mjs outageSaid) posted since then means it was said, whatever the run
//     listing shows. No state of its own and nothing in the board body, which reconcile owns. The mention waits up to
//     MENTION_HOLD_MS while a health run created in that window has not completed, this pass's dispatch included (a
//     late cron delivery after a short Worker blip would otherwise mention an outage its own dispatch heals minutes
//     later); a run that completed without reconciling holds nothing, and past 90 + 20 min nothing holds;
//   - health.yml not `active` (disabled on purpose with `gh workflow disable health.yml`, or by GitHub): nothing to
//     dispatch and nothing to say, a ::warning:: and green on every pass (re-enable it, and liveness resumes);
//   - a HEALTH_SILENCES entry matching `health:liveness` (reconcile's syntax, e.g. `health:liveness=2026-12-01,
//     maintenance`): a notice and green, no dispatch and no comment, until it ends.
//
// A failure of the check itself (a board or the runs unreadable, the dispatch or the comment refused) is an ::error::.
// The run is red only when no run of this workflow was red within LIVENESS_RED_EVERY_MS (24 h), so a failure that stays
// (a refused token, a missing board number) emails once a day, not on each of the 144 deliveries.
//
// The comment is the workflow's GITHUB_TOKEN's (github-actions[bot]), never the owner's PAT: GitHub never notifies a user
// of their own comment. Without HEALTH_MENTION the comment still goes out, unmentioned (the board's subscribers see it).
// When health reconciles again, reconcile answers it on the same board ("Health runs again").
//
//   node scripts/health-liveness.mjs                # in health-liveness.yml
//   DRY_RUN=1 node scripts/health-liveness.mjs      # decide and print; dispatch and comment nothing
// Environment: GH_TOKEN (actions: write, issues: write), GITHUB_REPOSITORY, HEALTH_MENTION and HEALTH_SILENCES
// (repository variables), GITHUB_RUN_ID and GITHUB_SERVER_URL (the comment's run link), DRY_RUN.
// Exit codes: 0 healthy, stale and dispatched, the outage held or already said, health.yml off, silenced, or a failure
// of this check already red within 24 h · 1 the outage was said this run, or a failure of this check (a dead health
// with a broken watcher must be seen) · 3 misconfigured.
//
// Dependency-free (Node >= 22, global fetch); it reuses reconcile.mjs's GitHub client, board state parser, silences and
// board comment (unlock around a locked board). The pure helpers are exported for tests/health-liveness.test.ts, which
// never touches the network.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BOARDS, HEALTH_DEAD_MS, HEALTH_STALE_MS, ageText, matchesKey, utcText } from './lib/findings.mjs';
import {
  BOARD_NUMBERS_FILE,
  BOT_LOGIN,
  annotation,
  githubClient,
  lastReconciledMs,
  outageMarker,
  outageSaid,
  parseBoardNumbers,
  parseBoardState,
  parseSilences,
  postComment,
  resolveMention,
} from './reconcile.mjs';

export { BOT_LOGIN, outageMarker, outageSaid };

const MIN = 60_000;
/** health.yml's runs read per pass (the dispatch hold and the mention hold): about 12 h at four an hour. */
export const RUNS_PER_PAGE = 50;
/** The HEALTH_SILENCES key that silences this check (exact, or a prefix such as `health:*`). */
export const LIVENESS_KEY = 'health:liveness';
/** The mention waits this long for a health run that has not completed yet (this pass's dispatch, the Worker's). */
export const MENTION_HOLD_MS = 20 * MIN;
/** A failure of this check turns its run red at most once per this long (another run of it already red: green). */
export const LIVENESS_RED_EVERY_MS = 24 * 60 * MIN;
/** This check's own workflow file (its red runs, for the once-a-day red). */
export const SELF_WORKFLOW = 'health-liveness.yml';

/**
 * health.yml's runs as the Actions API lists them: the newest completed one (by updated_at, its completion; any
 * conclusion, for the comment), the newest creation of any run, and the newest creation of a run that has not completed.
 * Rows without a readable time are skipped.
 */
export function summarizeRuns(runs) {
  let lastRun = null;
  let newestCreatedMs = null;
  let newestPendingCreatedMs = null;
  for (const r of Array.isArray(runs) ? runs : []) {
    if (r === null || typeof r !== 'object') continue;
    const created = Date.parse(String(r.created_at));
    if (Number.isFinite(created)) {
      if (newestCreatedMs === null || created > newestCreatedMs) newestCreatedMs = created;
      if (r.status !== 'completed' && (newestPendingCreatedMs === null || created > newestPendingCreatedMs)) newestPendingCreatedMs = created;
    }
    if (r.status !== 'completed') continue;
    const done = Date.parse(String(r.updated_at));
    if (!Number.isFinite(done) || (lastRun !== null && done <= lastRun.ms)) continue;
    lastRun = { id: Number.isInteger(r.id) ? r.id : null, ms: done, conclusion: typeof r.conclusion === 'string' ? r.conclusion : '?', url: typeof r.html_url === 'string' ? r.html_url : null };
  }
  return { lastRun, newestCreatedMs, newestPendingCreatedMs };
}

/**
 * What to do. `lastReconciledMs` null (no board holds a state) counts as older than every line. The runs' fields are
 * only read when health is not ok. `hold`: dead, but the mention waits for a run that may still reconcile (when this
 * pass dispatches, the hold assumes the dispatch succeeds; run() drops it when it fails).
 * @returns {{ state: 'ok' | 'stale' | 'dead', ageMs: number, dispatch: boolean, hold: boolean, heal: string | null, reason: string }}
 */
export function decide({ nowMs, lastReconciledMs, newestCreatedMs = null, newestPendingCreatedMs = null, staleMs = HEALTH_STALE_MS, deadMs = HEALTH_DEAD_MS, holdMs = MENTION_HOLD_MS }) {
  const ageMs = Number.isFinite(lastReconciledMs) ? nowMs - lastReconciledMs : Infinity;
  const age = Number.isFinite(ageMs) ? `health last reconciled ${ageText(ageMs)} ago` : 'no board holds a reconcile';
  if (ageMs <= staleMs) return { state: 'ok', ageMs, dispatch: false, hold: false, heal: null, reason: `${age} (at most ${ageText(staleMs)})` };
  const createdAgo = Number.isFinite(newestCreatedMs) ? nowMs - newestCreatedMs : Infinity;
  const pendingAgo = Number.isFinite(newestPendingCreatedMs) ? nowMs - newestPendingCreatedMs : Infinity;
  // A run created within the line is queued, running, or ran and did not reconcile: a dispatch would join it or fail
  // the same way.
  const dispatch = createdAgo > staleMs;
  const dead = ageMs > deadMs;
  const hold = dead && ageMs <= deadMs + holdMs && (dispatch || pendingAgo <= holdMs);
  let heal;
  if (dispatch) heal = 'dispatching health.yml';
  else if (pendingAgo <= staleMs) heal = `a health run created ${ageText(pendingAgo)} ago has not completed: no dispatch`;
  else heal = `a health run was created ${ageText(createdAgo)} ago and completed without reconciling: no dispatch (it fails before or in reconcile; see its log)`;
  const held = hold ? `; the mention waits up to ${ageText(holdMs)} for that run` : '';
  return { state: dead ? 'dead' : 'stale', ageMs, dispatch, hold, heal, reason: `${age} (over ${ageText(dead ? deadMs : staleMs)}): ${heal}${held}` };
}

/** The outage comment: the first line is what GitHub Mobile shows (the owner, and that health is down). */
export function outageBody({ mention, nowMs, lastReconciledMs, lastRun, decision, dispatched, runUrl }) {
  const reconciled = Number.isFinite(lastReconciledMs) ? `health last reconciled at ${utcText(lastReconciledMs)}, ${ageText(nowMs - lastReconciledMs)} ago (the boards' state)` : 'no board holds a reconcile';
  const last = lastRun
    ? `the last completed health run${lastRun.url ? ` (${lastRun.url}, ${lastRun.conclusion})` : ` (${lastRun.conclusion})`} finished at ${utcText(lastRun.ms)}`
    : 'no completed health run is in the listing';
  const heal = dispatched ? 'this check dispatched health.yml just now' : decision.dispatch ? 'its dispatch of health.yml failed' : (decision.heal ?? 'no dispatch');
  const lines = [
    `${mention ? `@${mention} ` : ''}health is down: no health run reconciled for ${Number.isFinite(decision.ageMs) ? ageText(decision.ageMs) : 'as long as the boards exist'}`,
    `**Health liveness** — ${reconciled} (line ${ageText(HEALTH_DEAD_MS)}); ${last}; ${heal}. The boards are not judged or updated meanwhile, and no P1/P2 is mentioned. Check the heartbeat Worker (its \`GH_PAT\`, its last ticks), the Actions queue and health.yml's last runs (a red one that never reached reconcile: its gate or reconcile log); README "Health watchdogs".`,
    `Run: ${runUrl ?? '(a local run)'}`,
    outageMarker(lastReconciledMs ?? 'none'),
  ];
  return lines.join('\n\n');
}

/** One pass; returns the exit code. `log` gets plain lines and annotations. */
export async function run({ env, nowMs = Date.now(), fetchImpl = globalThis.fetch, sleep, log = console.log, readFile = (p) => readFileSync(p, 'utf8') }) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const token = env.GH_TOKEN ?? '';
  if (!repo || !token) {
    log(annotation('error', 'Health liveness', 'GH_TOKEN and GITHUB_REPOSITORY are required'));
    return 3;
  }
  const dry = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const gh = githubClient({ token, fetchImpl, userAgent: 'earthquakes-feed-health-liveness', ...(sleep ? { sleep } : {}) });
  const problems = [];

  // The end of a pass: green without a failure of this check; with one, red unless a run of this check was already red
  // within LIVENESS_RED_EVERY_MS (the failure stays, or another one came: either way the owner was told today). A
  // listing that cannot be read: red. `said`: this pass posted the outage comment, always red.
  const finish = async (said = false) => {
    for (const p of problems) log(annotation('error', 'Health liveness', p));
    if (said) return 1;
    if (problems.length === 0) return 0;
    const own = await gh.call('GET', `/repos/${repo}/actions/workflows/${SELF_WORKFLOW}/runs?status=failure&per_page=5`);
    const prior = own.ok && Array.isArray(own.json?.workflow_runs)
      ? own.json.workflow_runs.find((r) => r && String(r.id) !== String(env.GITHUB_RUN_ID ?? '') && nowMs - Date.parse(String(r.created_at)) < LIVENESS_RED_EVERY_MS)
      : undefined;
    if (prior) {
      log(`health-liveness: a run of this check was already red at ${utcText(Date.parse(String(prior.created_at)))} (${prior.html_url ?? prior.id}): this one stays green; the ::error:: above says what fails now`);
      return 0;
    }
    return 1;
  };

  // 1. When health last reconciled: the boards' hidden state, read by number (scripts/health-boards.json).
  let numbersText = null;
  try {
    numbersText = readFile(BOARD_NUMBERS_FILE);
  } catch {
    numbersText = null;
  }
  const { numbers, error } = parseBoardNumbers(numbersText);
  if (error) {
    problems.push(`cannot tell whether health reconciles: ${error}`);
    return finish();
  }
  const states = {};
  for (const [b, n] of Object.entries(numbers)) {
    const r = await gh.call('GET', `/repos/${repo}/issues/${n}`);
    if (!r.ok || typeof r.json?.body !== 'string') {
      problems.push(`cannot read board #${n} "${BOARDS[b]}": ${r.ok ? 'no body' : r.message} (whether health reconciles is unknown)`);
      return finish();
    }
    states[b] = parseBoardState(r.json.body.replace(/\r\n/g, '\n'), b);
  }
  const reconciledMs = lastReconciledMs(states);
  let decision = decide({ nowMs, lastReconciledMs: reconciledMs });
  if (decision.state === 'ok') {
    log(`health-liveness: ok: ${decision.reason}`);
    return 0;
  }

  // 2. Silenced, or health.yml switched off: nothing to dispatch and nothing to say.
  const silence = parseSilences(env.HEALTH_SILENCES ?? '', nowMs).silences.find((s) => matchesKey(s.pattern, LIVENESS_KEY));
  if (silence) {
    log(annotation('notice', 'Health liveness', `${decision.reason}; silenced until ${utcText(silence.untilMs)} by HEALTH_SILENCES "${silence.spec}": no dispatch, no comment`));
    return 0;
  }
  const wf = await gh.call('GET', `/repos/${repo}/actions/workflows/health.yml`);
  if (wf.ok && typeof wf.json?.state === 'string' && wf.json.state !== 'active') {
    log(annotation('warning', 'Health liveness', `${decision.reason}; health.yml is ${wf.json.state}: no dispatch, no comment (gh workflow enable health.yml resumes both)`));
    return 0;
  }

  // 3. health.yml's runs: the dispatch and mention holds.
  const runs = await gh.call('GET', `/repos/${repo}/actions/workflows/health.yml/runs?per_page=${RUNS_PER_PAGE}`);
  if (!runs.ok || !Array.isArray(runs.json?.workflow_runs)) {
    problems.push(`cannot list health.yml's runs: ${runs.ok ? 'no workflow_runs' : runs.message} (${decision.reason})`);
    return finish();
  }
  const { lastRun, newestCreatedMs, newestPendingCreatedMs } = summarizeRuns(runs.json.workflow_runs);
  decision = decide({ nowMs, lastReconciledMs: reconciledMs, newestCreatedMs, newestPendingCreatedMs });
  log(`health-liveness: ${decision.state}: ${decision.reason}`);

  let dispatched = false;
  if (decision.dispatch) {
    if (dry) log('health-liveness: would dispatch health.yml {"ref":"main"} (dry run)');
    else {
      const r = await gh.call('POST', `/repos/${repo}/actions/workflows/health.yml/dispatches`, { ref: 'main' });
      if (r.ok) {
        dispatched = true;
        log(annotation('warning', 'Health liveness', `dispatched health.yml: ${decision.reason}`));
      } else {
        problems.push(`dispatching health.yml failed: ${r.message} (${decision.reason})`);
      }
    }
  }
  if (decision.state !== 'dead') return finish();
  if (decision.hold && (!decision.dispatch || dispatched || dry)) {
    log('health-liveness: the mention waits for the health run that may still reconcile');
    return finish();
  }

  // 4. Dead: say it once per outage on the platform board.
  const board = numbers.platform;
  if (!board) {
    problems.push(`health is down and the "${BOARDS.platform}" board has no number (null in ${BOARD_NUMBERS_FILE}): no comment`);
    return finish();
  }
  // The outage began at the last reconcile (without one, look back a week).
  const sinceMs = reconciledMs ?? nowMs - 7 * 24 * 60 * MIN;
  const read = await gh.call('GET', `/repos/${repo}/issues/${board}/comments?since=${encodeURIComponent(new Date(sinceMs).toISOString())}&per_page=100`);
  if (!read.ok || !Array.isArray(read.json)) {
    problems.push(`cannot read board #${board}'s comments: ${read.ok ? 'not a list' : read.message} (health is down: ${decision.reason})`);
    return finish();
  }
  if (outageSaid(read.json, sinceMs)) {
    log(`health-liveness: the outage since ${Number.isFinite(reconciledMs) ? utcText(reconciledMs) : 'the boards were made'} is already on board #${board}: nothing more`);
    return finish();
  }
  const warnings = [];
  const mention = await resolveMention({ gh, value: env.HEALTH_MENTION, warn: (m) => warnings.push(m) });
  for (const w of warnings) log(annotation('warning', 'Health liveness', w));
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const body = outageBody({ mention, nowMs, lastReconciledMs: reconciledMs, lastRun, decision, dispatched, runUrl });
  if (dry) {
    log(`----- comment on board #${board} (dry run, not posted) -----\n${body}`);
    return finish();
  }
  const posted = await postComment({ gh, repo, issue: { number: board, locked: true }, body, sleep: sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), log, warn: (m) => log(annotation('warning', 'Health liveness', m)) });
  if (!posted.ok) {
    problems.push(`cannot comment on board #${board}: ${posted.message} (health is down: ${decision.reason}); the next run tries again`);
    return finish();
  }
  // Red on the pass that says it: GitHub's failed-run email is the second channel.
  log(annotation('error', 'Health liveness', `health is down: ${decision.reason}; said on board #${board}${mention ? ` (mentions @${mention})` : ' (HEALTH_MENTION unset or no user: no mention)'}`));
  return finish(true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ env: process.env }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(annotation('error', 'Health liveness crashed', e instanceof Error ? e.message : String(e)));
      process.exitCode = 3;
    },
  );
}
