#!/usr/bin/env node
// Health's own liveness (owner decision 2026-11-19), run by .github/workflows/health-liveness.yml on a GitHub cron of
// its own. It replaces the dead-man switch Healthchecks.io was to be (dropped: its sign-up email never arrived).
//
// health.yml is dispatched by the heartbeat Worker every 15 min, with its own `:25` cron as the fallback; when both stop
// (the Worker down or its GH_PAT refused, and GitHub not delivering the cron, which it often does not for this repo), no
// health run happens, nothing turns red and the boards simply stop changing: the one failure health cannot report
// itself. This check reads health.yml's runs from outside, on a path that shares nothing with the Worker:
//
//   - the last COMPLETED health run that judged (conclusion success, failure or timed_out: a red run is alive; a
//     cancelled, skipped or startup_failure run is not) finished over HEALTH_STALE_MS (45 min: three missed dispatches)
//     ago: dispatch health.yml once, as the Worker does (self-heal). Not again while any health run was created within
//     the last 45 min (it is queued or running, or failed at start: another dispatch would join it, not help);
//   - over HEALTH_DEAD_MS (90 min: the dispatch did not help either): one comment on the "[health] platform" board that
//     @mentions HEALTH_MENTION (GitHub Mobile pushes it), once per outage. The outage is the last completed run's id,
//     written into the comment as a hidden marker (`<!-- health-liveness v1 outage=<id> -->`); a comment of the bot
//     with that marker since the run finished means it was said. No state of its own and nothing in the board body, which
//     reconcile owns. The run that posts it is red (exit 1): GitHub's failed-run email is a second channel, once.
//
// The comment is the workflow's GITHUB_TOKEN's (github-actions[bot]), never the owner's PAT: GitHub never notifies a user
// of their own comment. Without HEALTH_MENTION the comment still goes out, unmentioned (the board's subscribers see it).
// When health runs again, its reconcile says so on the same board (reconcile.mjs livenessItem, with HEALTH_MENTION).
//
//   node scripts/health-liveness.mjs                # in health-liveness.yml
//   DRY_RUN=1 node scripts/health-liveness.mjs      # decide and print; dispatch and comment nothing
// Environment: GH_TOKEN (actions: write, issues: write), GITHUB_REPOSITORY, HEALTH_MENTION (repository variable),
// GITHUB_RUN_ID and GITHUB_SERVER_URL (the comment's run link), DRY_RUN.
// Exit codes: 0 healthy, or stale and dispatched, or the outage already said · 1 the outage was said this run, or a read,
// the dispatch or the comment failed (a dead health with a broken watcher must be seen) · 3 misconfigured.
//
// Dependency-free (Node >= 22, global fetch); it reuses reconcile.mjs's GitHub client and board comment (unlock around a
// locked board). The pure helpers are exported for tests/health-liveness.test.ts, which never touches the network.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BOARDS, HEALTH_DEAD_MS, HEALTH_STALE_MS, ageText, utcText } from './lib/findings.mjs';
import { BOARD_NUMBERS_FILE, annotation, githubClient, parseBoardNumbers, postComment, resolveMention } from './reconcile.mjs';

/** A health run with one of these conclusions judged (a red run is a live one); anything else is no sign of life. */
export const JUDGED = Object.freeze(['success', 'failure', 'timed_out']);
/** health.yml's runs read per pass: about 12 h of runs at four an hour, plus the gate-skipped cron runs. */
export const RUNS_PER_PAGE = 50;
/** The bot whose comment carries the outage marker (the board is locked: only collaborators and the bot comment). */
export const BOT_LOGIN = 'github-actions[bot]';
const MARKER_HEAD = 'health-liveness v1 outage=';

/** The hidden marker of the outage comment; the outage is the id of the last completed run ('none' without one). */
export function outageMarker(outage) {
  return `<!-- ${MARKER_HEAD}${String(outage).replace(/[^0-9a-z]/gi, '')} -->`;
}

/**
 * The newest judged completion (by updated_at, the run's last change: its completion) and the newest creation among
 * health.yml's runs as the Actions API lists them. Rows without a readable time are skipped.
 */
export function summarizeRuns(runs) {
  let lastCompleted = null;
  let newestCreatedMs = null;
  for (const r of Array.isArray(runs) ? runs : []) {
    if (r === null || typeof r !== 'object') continue;
    const created = Date.parse(String(r.created_at));
    if (Number.isFinite(created) && (newestCreatedMs === null || created > newestCreatedMs)) newestCreatedMs = created;
    if (r.status !== 'completed' || !JUDGED.includes(r.conclusion)) continue;
    const done = Date.parse(String(r.updated_at));
    if (!Number.isFinite(done) || (lastCompleted !== null && done <= lastCompleted.ms)) continue;
    lastCompleted = { id: Number.isInteger(r.id) ? r.id : null, ms: done, conclusion: r.conclusion, url: typeof r.html_url === 'string' ? r.html_url : null };
  }
  return { lastCompleted, newestCreatedMs };
}

/**
 * What to do. `lastCompletedMs` null (no judged run in the listing) counts as older than every line. `heal` says what
 * the self-heal does (or why it does not).
 * @returns {{ state: 'ok' | 'stale' | 'dead', ageMs: number, dispatch: boolean, heal: string | null, reason: string }}
 */
export function decide({ nowMs, lastCompletedMs, newestCreatedMs, staleMs = HEALTH_STALE_MS, deadMs = HEALTH_DEAD_MS }) {
  const ageMs = Number.isFinite(lastCompletedMs) ? nowMs - lastCompletedMs : Infinity;
  const age = Number.isFinite(ageMs) ? `the last completed health run finished ${ageText(ageMs)} ago` : 'no completed health run in the listing';
  if (ageMs <= staleMs) return { state: 'ok', ageMs, dispatch: false, heal: null, reason: `${age} (at most ${ageText(staleMs)})` };
  const createdAgo = Number.isFinite(newestCreatedMs) ? nowMs - newestCreatedMs : Infinity;
  // A run created within the line is queued, running or failed at its start: a dispatch would join it, not help.
  const dispatch = createdAgo > staleMs;
  const heal = dispatch ? 'dispatching health.yml' : `a health run was created ${ageText(createdAgo)} ago and has not completed: no dispatch`;
  return { state: ageMs > deadMs ? 'dead' : 'stale', ageMs, dispatch, heal, reason: `${age} (over ${ageText(ageMs > deadMs ? deadMs : staleMs)}): ${heal}` };
}

/** Whether a board comment already says this outage: the bot's, with its marker. */
export function outageSaid(comments, outage) {
  const marker = outageMarker(outage);
  return (Array.isArray(comments) ? comments : []).some((c) => c && typeof c.body === 'string' && c.body.includes(marker) && c.user?.login === BOT_LOGIN);
}

/** The outage comment: the first line is what GitHub Mobile shows (the owner, and that health is down). */
export function outageBody({ mention, nowMs, lastCompleted, decision, dispatched, runUrl }) {
  const last = lastCompleted
    ? `the last completed health run${lastCompleted.url ? ` (${lastCompleted.url}, ${lastCompleted.conclusion})` : ` (${lastCompleted.conclusion})`} finished at ${utcText(lastCompleted.ms)}, ${ageText(nowMs - lastCompleted.ms)} ago`
    : 'no completed health run is in the listing';
  const heal = dispatched ? 'this check dispatched health.yml just now' : decision.dispatch ? 'its dispatch of health.yml failed' : (decision.heal ?? 'no dispatch');
  const lines = [
    `${mention ? `@${mention} ` : ''}health is down: no completed health run for ${Number.isFinite(decision.ageMs) ? ageText(decision.ageMs) : 'the whole listing'}`,
    `**Health liveness** — ${last} (line ${ageText(HEALTH_DEAD_MS)}); ${heal}. The boards are not judged or updated meanwhile. Check the heartbeat Worker (its \`GH_PAT\`, its last ticks), the Actions queue and health.yml's last runs; README "Health watchdogs".`,
    `Run: ${runUrl ?? '(a local run)'}`,
    outageMarker(lastCompleted?.id ?? 'none'),
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
  const runs = await gh.call('GET', `/repos/${repo}/actions/workflows/health.yml/runs?per_page=${RUNS_PER_PAGE}`);
  if (!runs.ok || !Array.isArray(runs.json?.workflow_runs)) {
    log(annotation('error', 'Health liveness', `cannot list health.yml's runs: ${runs.ok ? 'no workflow_runs' : runs.message}`));
    return 1;
  }
  const { lastCompleted, newestCreatedMs } = summarizeRuns(runs.json.workflow_runs);
  const decision = decide({ nowMs, lastCompletedMs: lastCompleted?.ms ?? null, newestCreatedMs });
  log(`health-liveness: ${decision.state}: ${decision.reason}`);
  if (decision.state === 'ok') return 0;

  let code = 0;
  let dispatched = false;
  if (decision.dispatch) {
    if (dry) log('health-liveness: would dispatch health.yml {"ref":"main"} (dry run)');
    else {
      const r = await gh.call('POST', `/repos/${repo}/actions/workflows/health.yml/dispatches`, { ref: 'main' });
      if (r.ok) {
        dispatched = true;
        log(annotation('warning', 'Health liveness', `dispatched health.yml: ${decision.reason}`));
      } else {
        log(annotation('error', 'Health liveness', `dispatching health.yml failed: ${r.message}`));
        code = 1;
      }
    }
  }
  if (decision.state !== 'dead') return code;

  // Dead: say it once per outage on the platform board.
  let numbersText = null;
  try {
    numbersText = readFile(BOARD_NUMBERS_FILE);
  } catch {
    numbersText = null;
  }
  const { numbers, error } = parseBoardNumbers(numbersText);
  const board = numbers.platform;
  if (error || !board) {
    log(annotation('error', 'Health liveness', `health is down and the "${BOARDS.platform}" board has no number (${error ?? `null in ${BOARD_NUMBERS_FILE}`}): no comment`));
    return 1;
  }
  // The outage's comments come after its last completed run (or, without one, in the last week).
  const outage = lastCompleted?.id ?? 'none';
  const since = new Date(lastCompleted?.ms ?? nowMs - 7 * 24 * 60 * 60_000).toISOString();
  const read = await gh.call('GET', `/repos/${repo}/issues/${board}/comments?since=${encodeURIComponent(since)}&per_page=100`);
  if (!read.ok || !Array.isArray(read.json)) {
    log(annotation('error', 'Health liveness', `cannot read board #${board}'s comments: ${read.ok ? 'not a list' : read.message} (health is down: ${decision.reason})`));
    return 1;
  }
  if (outageSaid(read.json, outage)) {
    log(`health-liveness: the outage since run ${outage} is already on board #${board}: nothing more`);
    return code;
  }
  const warnings = [];
  const mention = await resolveMention({ gh, value: env.HEALTH_MENTION, warn: (m) => warnings.push(m) });
  for (const w of warnings) log(annotation('warning', 'Health liveness', w));
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const body = outageBody({ mention, nowMs, lastCompleted, decision, dispatched, runUrl });
  if (dry) {
    log(`----- comment on board #${board} (dry run, not posted) -----\n${body}`);
    return code;
  }
  const posted = await postComment({ gh, repo, issue: { number: board, locked: true }, body, sleep: sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), log, warn: (m) => log(annotation('warning', 'Health liveness', m)) });
  if (!posted.ok) {
    log(annotation('error', 'Health liveness', `cannot comment on board #${board}: ${posted.message} (health is down: ${decision.reason}); the next run tries again`));
    return 1;
  }
  // Red once per outage: GitHub's failed-run email is the second channel.
  log(annotation('error', 'Health liveness', `health is down: ${decision.reason}; said on board #${board}${mention ? ` (mentions @${mention})` : ' (HEALTH_MENTION unset: no mention)'}`));
  return 1;
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
