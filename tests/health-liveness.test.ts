import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BOT_LOGIN, LIVENESS_RED_EVERY_MS, MENTION_HOLD_MS, decide, outageBody, outageMarker, run, summarizeRuns } from '../scripts/health-liveness.mjs';
import { HEALTH_DEAD_MS, HEALTH_STALE_MS } from '../scripts/lib/findings.mjs';
import { BOARD_NUMBERS_FILE, type FetchImpl, reconcile } from '../scripts/reconcile.mjs';

// Health's own liveness (owner decision 2026-11-19: Healthchecks.io dropped, its sign-up email never arrived):
// scripts/health-liveness.mjs on health-liveness.yml's own cron. It measures what health wrote (the boards' state), not
// whether its runs finished. Nothing here touches the network.

const MIN = 60_000;
const T = (iso: string): number => Date.parse(iso);
const REPO = 'TheShelterApp/earthquakes-feed';
const NOW = T('2026-11-19T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

interface FakeRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url?: string;
}
/** A health run created `createdAgo` before NOW that finished `doneAgo` before it. */
const ran = (id: number, doneAgo: number, conclusion = 'success', createdAgo = doneAgo + 3 * MIN): FakeRun => ({
  id,
  status: 'completed',
  conclusion,
  created_at: iso(NOW - createdAgo),
  updated_at: iso(NOW - doneAgo),
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
});
/** Health runs every 15 min for `hours` before NOW whose gate failed (red, nothing reconciled). */
const gateFailed = (hours: number): FakeRun[] => Array.from({ length: hours * 4 }, (_, i) => ran(500 - i, i * 15 * MIN + 2 * MIN, 'failure', i * 15 * MIN + 3 * MIN));

/** A board body as reconcile writes it, last reconciled at `ms` (its hidden state's updatedMs). */
const boardBody = (board: 'alerts' | 'feed' | 'platform', ms: number): string => reconcile(null, [], ms, [], { existing: [] }).bodies[board]!;

test('summarizeRuns: the newest completed run (any conclusion), the newest creation, the newest creation not completed', () => {
  const runs = [
    { id: 9, status: 'queued', conclusion: null, created_at: iso(NOW - 2 * MIN), updated_at: iso(NOW - 2 * MIN) },
    ran(8, 5 * MIN, 'cancelled'),
    ran(5, 20 * MIN, 'failure'),
    { id: 3, status: 'completed', conclusion: 'success', created_at: 'garbage', updated_at: 'garbage' },
    null,
  ];
  const s = summarizeRuns(runs);
  assert.deepEqual(s.lastRun, { id: 8, ms: NOW - 5 * MIN, conclusion: 'cancelled', url: `https://github.com/${REPO}/actions/runs/8` });
  assert.equal(s.newestCreatedMs, NOW - 2 * MIN);
  assert.equal(s.newestPendingCreatedMs, NOW - 2 * MIN);
  assert.equal(summarizeRuns([ran(1, 3 * MIN)]).newestPendingCreatedMs, null);
  assert.deepEqual(summarizeRuns(null), { lastRun: null, newestCreatedMs: null, newestPendingCreatedMs: null });
});

test('decide: from the last reconcile; over 45 min dispatch once (not while a run created within 45 min exists); over 90 dead; the mention waits up to 20 min for a run still pending', () => {
  const at = (reconciledAgo: number | null, createdAgo: number | null = null, pendingAgo: number | null = null) =>
    decide({ nowMs: NOW, lastReconciledMs: reconciledAgo === null ? null : NOW - reconciledAgo, newestCreatedMs: createdAgo === null ? null : NOW - createdAgo, newestPendingCreatedMs: pendingAgo === null ? null : NOW - pendingAgo });
  assert.equal(HEALTH_STALE_MS, 45 * MIN);
  assert.equal(HEALTH_DEAD_MS, 90 * MIN);
  assert.equal(MENTION_HOLD_MS, 20 * MIN);
  assert.deepEqual(at(45 * MIN, 1 * MIN), { state: 'ok', ageMs: 45 * MIN, dispatch: false, hold: false, heal: null, reason: 'health last reconciled 45 min ago (at most 45 min)' });
  const stale = at(46 * MIN, 49 * MIN);
  assert.deepEqual([stale.state, stale.dispatch, stale.hold], ['stale', true, false]);
  assert.equal(stale.reason, 'health last reconciled 46 min ago (over 45 min): dispatching health.yml');
  const pending = at(60 * MIN, 10 * MIN, 10 * MIN);
  assert.deepEqual([pending.state, pending.dispatch], ['stale', false]);
  assert.match(pending.reason, /a health run created 10 min ago has not completed: no dispatch$/);
  // Runs are created every 15 min and finish red without reconciling (the gate fails): dead, no dispatch would help,
  // and nothing holds the mention.
  const gate = at(3 * 60 * MIN, 5 * MIN);
  assert.deepEqual([gate.state, gate.dispatch, gate.hold], ['dead', false, false]);
  assert.match(gate.reason, /a health run was created 5 min ago and completed without reconciling: no dispatch/);
  // A late first delivery (95 min): it dispatches, and the mention waits for that run.
  const late = at(95 * MIN, 95 * MIN);
  assert.deepEqual([late.state, late.dispatch, late.hold], ['dead', true, true]);
  assert.match(late.reason, /dispatching health\.yml; the mention waits up to 20 min for that run$/);
  assert.deepEqual([at(105 * MIN, 10 * MIN, 10 * MIN).hold, at(111 * MIN, 10 * MIN, 10 * MIN).hold], [true, false], 'nothing holds past 90 + 20 min');
  assert.equal(at(100 * MIN, 25 * MIN, 25 * MIN).hold, false, 'pending for over 20 min: no hold');
  const none = at(null, null);
  assert.deepEqual([none.state, none.dispatch, none.hold, none.ageMs], ['dead', true, false, Infinity]);
  assert.match(none.reason, /^no board holds a reconcile \(over 90 min\)/);
});

test('outageBody: the first line mentions the owner; the marker is the last reconcile', () => {
  const reconciled = NOW - 2 * 60 * MIN;
  const lastRun = { id: 5, ms: NOW - 4 * MIN, conclusion: 'failure', url: `https://github.com/${REPO}/actions/runs/5` };
  const decision = decide({ nowMs: NOW, lastReconciledMs: reconciled, newestCreatedMs: NOW - 5 * MIN });
  const body = outageBody({ mention: 'nickaroot', nowMs: NOW, lastReconciledMs: reconciled, lastRun, decision, dispatched: false, runUrl: `https://github.com/${REPO}/actions/runs/77` });
  const parts = body.split('\n\n');
  assert.equal(parts[0], '@nickaroot health is down: no health run reconciled for 2.0 h');
  assert.match(parts[1]!, /^\*\*Health liveness\*\* — health last reconciled at 2026-11-19 10:00Z, 2\.0 h ago \(the boards' state\) \(line 90 min\); the last completed health run \(https:\/\/github\.com\/TheShelterApp\/earthquakes-feed\/actions\/runs\/5, failure\) finished at 2026-11-19 11:56Z; a health run was created 5 min ago and completed without reconciling/);
  assert.equal(parts[2], `Run: https://github.com/${REPO}/actions/runs/77`);
  assert.equal(parts[3], outageMarker(reconciled));
  const quiet = outageBody({ mention: null, nowMs: NOW, lastReconciledMs: null, lastRun: null, decision: decide({ nowMs: NOW, lastReconciledMs: null }), dispatched: true, runUrl: null });
  assert.match(quiet, /^health is down: no health run reconciled for as long as the boards exist\n\n\*\*Health liveness\*\* — no board holds a reconcile \(line 90 min\); no completed health run is in the listing; this check dispatched health\.yml just now\./);
  assert.ok(quiet.endsWith(outageMarker('none')));
});

/** The three boards, health.yml (its state, runs and dispatch), this check's own red runs, the users API; records every call. */
class FakeGitHub {
  /** When each board was last reconciled (its state's updatedMs); null: a body without a state. */
  reconciled: Record<number, number | null> = { 124: NOW - 20 * MIN, 125: NOW - 20 * MIN, 126: NOW - 20 * MIN };
  runs: FakeRun[] = [];
  comments: Array<{ body: string; user: { login: string }; created_at: string }> = [];
  calls: Array<{ method: string; url: string; body: unknown }> = [];
  /** The time a comment is posted at. */
  clock = NOW;
  boardStatus = 200;
  listStatus = 200;
  workflowState = 'active';
  dispatchStatus = 204;
  commentsStatus = 200;
  commentStatus = 201;
  /** This check's own red runs (newest first). */
  ownFailed: Array<{ id: number; created_at: string; html_url: string }> = [];
  ownStatus = 200;
  /** 403: GitHub refuses the bot's comment while the board is locked. */
  lockedRejects = false;
  locked = true;
  reconcileAll(ms: number): void {
    for (const n of [124, 125, 126]) this.reconciled[n] = ms;
  }
  fetchImpl: FetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    this.calls.push({ method, url, body });
    const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    const path = url.replace('https://api.github.com', '');
    const issue = /^\/repos\/[^/]+\/[^/]+\/issues\/(124|125|126)$/.exec(path);
    if (method === 'GET' && issue) {
      if (this.boardStatus !== 200) return json({ message: 'boom' }, this.boardStatus);
      const n = Number(issue[1]);
      const board = ({ 124: 'alerts', 125: 'feed', 126: 'platform' } as const)[n as 124 | 125 | 126];
      const ms = this.reconciled[n];
      return json({ number: n, body: ms === null || ms === undefined ? 'no state' : boardBody(board, ms) });
    }
    if (method === 'GET' && path === `/repos/${REPO}/actions/workflows/health.yml`) return json({ id: 1, path: '.github/workflows/health.yml', state: this.workflowState });
    if (method === 'GET' && path === `/repos/${REPO}/actions/workflows/health.yml/runs?per_page=50`) {
      return this.listStatus === 200 ? json({ total_count: this.runs.length, workflow_runs: this.runs }) : json({ message: 'boom' }, this.listStatus);
    }
    if (method === 'GET' && path === `/repos/${REPO}/actions/workflows/health-liveness.yml/runs?status=failure&per_page=5`) {
      return this.ownStatus === 200 ? json({ workflow_runs: this.ownFailed }) : json({ message: 'boom' }, this.ownStatus);
    }
    if (method === 'POST' && path === `/repos/${REPO}/actions/workflows/health.yml/dispatches`) {
      if (this.dispatchStatus !== 204) return json({ message: 'boom' }, this.dispatchStatus);
      this.runs.unshift({ id: 1000 + this.runs.length, status: 'queued', conclusion: null, created_at: iso(this.clock), updated_at: iso(this.clock) });
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path.startsWith(`/repos/${REPO}/issues/126/comments?since=`)) {
      if (this.commentsStatus !== 200) return json({ message: 'boom' }, this.commentsStatus);
      const since = Date.parse(decodeURIComponent(path.split('since=')[1]!.split('&')[0]!));
      return json(this.comments.filter((c) => Date.parse(c.created_at) >= since));
    }
    if (method === 'POST' && path === `/repos/${REPO}/issues/126/comments`) {
      if (this.commentStatus !== 201) return json({ message: 'boom' }, this.commentStatus);
      if (this.lockedRejects && this.locked) return json({ message: 'Unable to create comment because issue is locked.' }, 403);
      this.comments.push({ body: String((body as { body: string }).body), user: { login: BOT_LOGIN }, created_at: iso(this.clock) });
      return json({ id: 1 }, 201);
    }
    if (path === `/repos/${REPO}/issues/126/lock`) {
      this.locked = method === 'PUT';
      return new Response(null, { status: 204 });
    }
    const user = /^\/users\/([^/]+)$/.exec(path);
    if (method === 'GET' && user) {
      const accounts: Record<string, { login: string; type: string }> = { nickaroot: { login: 'nickaroot', type: 'User' }, theshelterapp: { login: 'TheShelterApp', type: 'Organization' } };
      const a = accounts[decodeURIComponent(user[1]!).toLowerCase()];
      return a ? json(a) : json({ message: 'Not Found' }, 404);
    }
    return json({ message: 'Not Found' }, 404);
  };
  writes(): string[] {
    return this.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.replace('https://api.github.com', '')}`);
  }
}

const NUMBERS = JSON.stringify({ alerts: 124, feed: 125, platform: 126 });
const ENV = { GH_TOKEN: 't', GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '77', GITHUB_SERVER_URL: 'https://github.com', HEALTH_MENTION: 'nickaroot' };

async function pass(gh: FakeGitHub, env: Record<string, string> = {}, nowMs = NOW, numbers: string | null = NUMBERS): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  gh.clock = nowMs;
  const code = await run({
    env: { ...ENV, ...env },
    nowMs,
    fetchImpl: gh.fetchImpl,
    sleep: async () => {},
    log: (l) => lines.push(l),
    readFile: (p) => {
      if (p !== BOARD_NUMBERS_FILE || numbers === null) throw new Error(`ENOENT: ${p}`);
      return numbers;
    },
  });
  return { code, lines };
}
/** A world where health last reconciled `ago` before NOW, and its last run finished then. */
const downFor = (ago: number): FakeGitHub => {
  const gh = new FakeGitHub();
  gh.reconcileAll(NOW - ago);
  gh.runs = [ran(5, ago - MIN, 'success', ago + 2 * MIN)];
  return gh;
};

test('run: healthy reads the three boards only; stale dispatches once; a run created meanwhile holds the next dispatch', async () => {
  const gh = new FakeGitHub();
  gh.reconciled[124] = NOW - 3 * 60 * MIN;
  gh.reconciled[125] = null;
  assert.deepEqual(await pass(gh), { code: 0, lines: ['health-liveness: ok: health last reconciled 20 min ago (at most 45 min)'] }, 'the newest board counts');
  assert.deepEqual(gh.calls.map((c) => c.url.replace('https://api.github.com', '')), [124, 125, 126].map((n) => `/repos/${REPO}/issues/${n}`));

  const stale = downFor(50 * MIN);
  const first = await pass(stale);
  assert.equal(first.code, 0, 'a dispatch is the self-heal, not an alarm');
  assert.deepEqual(stale.writes(), [`POST /repos/${REPO}/actions/workflows/health.yml/dispatches`]);
  assert.deepEqual(stale.calls.find((c) => c.method === 'POST')!.body, { ref: 'main' });
  assert.ok(first.lines.some((l) => l.startsWith('::warning title=Health liveness::dispatched health.yml: health last reconciled 50 min ago')));
  // Ten minutes later the dispatched run is still queued: no second dispatch.
  const second = await pass(stale, {}, NOW + 10 * MIN);
  assert.equal(second.code, 0);
  assert.equal(stale.writes().length, 1);
  assert.match(second.lines[0]!, /a health run created 10 min ago has not completed: no dispatch$/);
});

test('run: health runs every 15 min but its gate fails (red runs, nothing reconciled) for 2 h: dead, mentioned once, red on that pass', async () => {
  const gh = new FakeGitHub();
  gh.reconcileAll(NOW - 2 * 60 * MIN);
  gh.runs = gateFailed(2);
  const first = await pass(gh);
  assert.equal(first.code, 1, 'red once: the failed-run email is the second channel');
  assert.deepEqual(gh.writes(), [`POST /repos/${REPO}/issues/126/comments`], 'no dispatch: runs keep being created and fail the same way');
  const listing = gh.calls.find((c) => c.url.includes('/issues/126/comments?since='))!;
  assert.ok(listing.url.endsWith(`since=${encodeURIComponent(iso(NOW - 2 * 60 * MIN))}&per_page=100`), 'comments since the last reconcile');
  assert.equal(gh.comments.length, 1);
  assert.match(gh.comments[0]!.body, /^@nickaroot health is down: no health run reconciled for 2\.0 h\n\n/);
  assert.match(gh.comments[0]!.body, /the last completed health run \(https:\/\/github\.com\/TheShelterApp\/earthquakes-feed\/actions\/runs\/500, failure\)/);
  assert.ok(gh.comments[0]!.body.endsWith(outageMarker(NOW - 2 * 60 * MIN)));
  assert.ok(first.lines.some((l) => l.startsWith('::error title=Health liveness::health is down: health last reconciled 2.0 h ago (over 90 min): a health run was created 3 min ago and completed without reconciling') && l.endsWith('; said on board #126 (mentions @nickaroot)')));

  // The next deliveries of the same outage: no comment, green.
  for (const later of [10, 20, 60]) {
    const again = await pass(gh, {}, NOW + later * MIN);
    assert.equal(again.code, 0, `${later} min later`);
    assert.ok(again.lines.includes('health-liveness: the outage since 2026-11-19 10:00Z is already on board #126: nothing more'));
  }
  assert.equal(gh.comments.length, 1);

  // Health reconciled once more and died again: a new outage, a new comment.
  gh.reconcileAll(NOW + 70 * MIN);
  assert.equal((await pass(gh, {}, NOW + 80 * MIN)).code, 0, 'alive again');
  const next = await pass(gh, {}, NOW + 4 * 60 * MIN);
  assert.equal(next.code, 1);
  assert.equal(gh.comments.length, 2);
  assert.ok(gh.comments[1]!.body.endsWith(outageMarker(NOW + 70 * MIN)));
});

test('run: the outage identity does not depend on the run listing: 50 cancelled runs later, the outage is still said once', async () => {
  const gh = downFor(3 * 60 * MIN);
  assert.equal((await pass(gh)).code, 1);
  assert.equal(gh.comments.length, 1);
  // Every run since was cancelled or failed at start: the listing holds no completed judged run any more.
  gh.runs = Array.from({ length: 50 }, (_, i) => ran(900 - i, i * 5 * MIN + MIN, i % 2 === 0 ? 'cancelled' : 'startup_failure', i * 5 * MIN + MIN));
  const later = await pass(gh, {}, NOW + 8 * 24 * 60 * MIN);
  assert.equal(later.code, 0);
  assert.equal(gh.comments.length, 1, 'not again, not even a week later');
});

test('run: a late first delivery dispatches and holds the mention for that run; the run reconciles, nothing is said; a refused dispatch holds nothing', async () => {
  const gh = downFor(95 * MIN);
  const first = await pass(gh);
  assert.equal(first.code, 0);
  assert.deepEqual(gh.writes(), [`POST /repos/${REPO}/actions/workflows/health.yml/dispatches`]);
  assert.ok(first.lines.includes('health-liveness: the mention waits for the health run that may still reconcile'));
  // 10 min later it is still queued: still held.
  assert.equal((await pass(gh, {}, NOW + 10 * MIN)).code, 0);
  assert.equal(gh.comments.length, 0);
  // It reconciled: healthy, nothing was ever said (and reconcile has nothing to answer).
  gh.reconcileAll(NOW + 12 * MIN);
  assert.equal((await pass(gh, {}, NOW + 20 * MIN)).code, 0);
  assert.equal(gh.comments.length, 0);

  // It never starts: past 90 + 20 min the mention goes out.
  const stuck = downFor(95 * MIN);
  await pass(stuck);
  assert.equal((await pass(stuck, {}, NOW + 16 * MIN)).code, 1);
  assert.equal(stuck.comments.length, 1);
  assert.match(stuck.comments[0]!.body, /^@nickaroot health is down: no health run reconciled for 111 min\n/);

  const refused = downFor(95 * MIN);
  refused.dispatchStatus = 403;
  const r = await pass(refused);
  assert.equal(r.code, 1);
  assert.equal(refused.comments.length, 1, 'nothing that could heal it is pending: said at once');
  assert.match(refused.comments[0]!.body, /; its dispatch of health\.yml failed\./);
  assert.ok(r.lines.some((l) => l.startsWith('::error title=Health liveness::dispatching health.yml failed: HTTP 403')));
});

test('run: health.yml switched off or a health:liveness silence: green and quiet on every pass; a failure of the check is red once a day', async () => {
  const off = downFor(3 * 60 * MIN);
  off.workflowState = 'disabled_manually';
  for (const later of [0, 10, 20]) {
    const p = await pass(off, {}, NOW + later * MIN);
    assert.equal(p.code, 0);
    assert.ok(p.lines.some((l) => l.startsWith('::warning title=Health liveness::health last reconciled') && l.endsWith('health.yml is disabled_manually: no dispatch, no comment (gh workflow enable health.yml resumes both)')));
  }
  assert.deepEqual(off.writes(), []);

  const silenced = downFor(3 * 60 * MIN);
  const s = await pass(silenced, { HEALTH_SILENCES: 'feed:source:tmd=2026-12-01; health:liveness=2026-11-20,moving the Worker' });
  assert.equal(s.code, 0);
  assert.deepEqual(silenced.writes(), []);
  assert.ok(s.lines.some((l) => l.startsWith('::notice title=Health liveness::') && l.includes('silenced until 2026-11-21 00:00Z by HEALTH_SILENCES "health:liveness=2026-11-20,moving the Worker": no dispatch, no comment')));
  assert.equal((await pass(downFor(3 * 60 * MIN), { HEALTH_SILENCES: 'health:*=2026-11-20' })).lines.some((l) => l.includes('silenced until')), true, 'a prefix matches');
  assert.equal((await pass(downFor(3 * 60 * MIN), { HEALTH_SILENCES: 'health:liveness=2026-11-18' })).code, 1, 'an expired silence silences nothing');

  // A refused dispatch while stale: red on the first pass, green with the ::error:: while a run of this check was red
  // within 24 h, red again after.
  const broken = downFor(50 * MIN);
  broken.dispatchStatus = 403;
  assert.equal((await pass(broken)).code, 1);
  assert.ok(broken.calls.some((c) => c.url.endsWith('/actions/workflows/health-liveness.yml/runs?status=failure&per_page=5')));
  broken.ownFailed = [{ id: 76, created_at: iso(NOW), html_url: `https://github.com/${REPO}/actions/runs/76` }];
  const again = await pass(broken, {}, NOW + 10 * MIN);
  assert.equal(again.code, 0);
  assert.ok(again.lines.some((l) => l.startsWith('::error title=Health liveness::dispatching health.yml failed: HTTP 403')));
  assert.ok(again.lines.includes(`health-liveness: a run of this check was already red at 2026-11-19 12:00Z (https://github.com/${REPO}/actions/runs/76): this one stays green; the ::error:: above says what fails now`));
  assert.equal(LIVENESS_RED_EVERY_MS, 24 * 60 * MIN);
  assert.equal((await pass(broken, {}, NOW + 24 * 60 * MIN)).code, 1);
  // Its own red run is not a prior one; an unreadable listing is red.
  broken.ownFailed = [{ id: 77, created_at: iso(NOW), html_url: '' }];
  assert.equal((await pass(broken, {}, NOW + 10 * MIN)).code, 1);
  broken.ownStatus = 500;
  broken.ownFailed = [{ id: 76, created_at: iso(NOW), html_url: '' }];
  assert.equal((await pass(broken, {}, NOW + 10 * MIN)).code, 1);
});

test('run: no mention without HEALTH_MENTION or for an organization; a locked board is unlocked around the comment; dry run writes nothing', async () => {
  const unset = downFor(2 * 60 * MIN);
  await pass(unset, { HEALTH_MENTION: '' });
  assert.match(unset.comments[0]!.body, /^health is down: /, 'unset: the comment goes out unmentioned');
  assert.ok(!unset.calls.some((c) => c.url.includes('/users/')));

  const org = downFor(2 * 60 * MIN);
  const o = await pass(org, { HEALTH_MENTION: 'TheShelterApp' });
  assert.match(org.comments[0]!.body, /^health is down: /);
  assert.ok(o.lines.some((l) => l.startsWith('::warning title=Health liveness::HEALTH_MENTION "TheShelterApp" is a GitHub Organization, not a user')));

  const locked = downFor(2 * 60 * MIN);
  locked.lockedRejects = true;
  const l = await pass(locked);
  assert.equal(l.code, 1);
  assert.deepEqual(locked.writes().slice(1), [
    `POST /repos/${REPO}/issues/126/comments`,
    `DELETE /repos/${REPO}/issues/126/lock`,
    `POST /repos/${REPO}/issues/126/comments`,
    `PUT /repos/${REPO}/issues/126/lock`,
  ]);
  assert.equal(locked.comments.length, 1);
  assert.equal(locked.locked, true);

  const dry = downFor(95 * MIN);
  const d = await pass(dry, { DRY_RUN: '1' });
  assert.equal(d.code, 0);
  assert.deepEqual(dry.writes(), []);
  assert.ok(d.lines.includes('health-liveness: would dispatch health.yml {"ref":"main"} (dry run)'));
  assert.ok(d.lines.includes('health-liveness: the mention waits for the health run that may still reconcile'), 'the dry run assumes its dispatch');
  const dd = await pass(downFor(2 * 60 * MIN + 30 * MIN), { DRY_RUN: '1' });
  assert.ok(dd.lines.some((x) => x.startsWith('----- comment on board #126 (dry run, not posted) -----\n@nickaroot health is down: ')));
});

test('run: unreadable boards, numbers, runs or comments and a refused comment are failures of the check (red); no token is misconfigured', async () => {
  const boards = new FakeGitHub();
  boards.boardStatus = 502;
  const b = await pass(boards);
  assert.equal(b.code, 1);
  assert.ok(b.lines.some((l) => l.startsWith('::error title=Health liveness::cannot read board #124 "[health] alert pipeline": HTTP 502')));
  assert.equal(boards.calls.filter((c) => c.url.endsWith('/issues/124')).length, 3, 'a read is tried three times');

  const numbers = await pass(new FakeGitHub(), {}, NOW, null);
  assert.equal(numbers.code, 1);
  assert.ok(numbers.lines.some((l) => l.includes('cannot tell whether health reconciles: scripts/health-boards.json is missing')));

  const list = downFor(2 * 60 * MIN);
  list.listStatus = 502;
  const li = await pass(list);
  assert.equal(li.code, 1);
  assert.ok(li.lines.some((l) => l.startsWith("::error title=Health liveness::cannot list health.yml's runs: HTTP 502")));

  const comments = downFor(3 * 60 * MIN);
  comments.commentsStatus = 500;
  assert.equal((await pass(comments)).code, 1);
  assert.equal(comments.comments.length, 0);

  const refused = downFor(3 * 60 * MIN);
  refused.commentStatus = 500;
  const r = await pass(refused);
  assert.equal(r.code, 1);
  assert.ok(r.lines.some((l) => l.startsWith('::error title=Health liveness::cannot comment on board #126: HTTP 500')));

  const platform = downFor(3 * 60 * MIN);
  const n = await pass(platform, {}, NOW, JSON.stringify({ alerts: 124, feed: 125, platform: null }));
  assert.equal(n.code, 1);
  assert.ok(n.lines.some((l) => l.includes('the "[health] platform" board has no number')));

  assert.equal((await pass(new FakeGitHub(), { GH_TOKEN: '' })).code, 3);
});

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

test('health-liveness.yml: its own cron (independent of the heartbeat Worker), the bot token, the two write scopes, the variable', () => {
  const yml = read('.github/workflows/health-liveness.yml');
  assert.match(yml, /\non:\n {2}schedule:\n {4}- cron: '3,13,23,33,43,53 \* \* \* \*'\n/);
  assert.doesNotMatch(read('heartbeat/src/worker.js'), /health-liveness/, 'the Worker never dispatches it: it watches the Worker\'s work');
  assert.match(yml, /\n {6}actions: write\n/);
  assert.match(yml, /\n {6}issues: write\n/);
  assert.match(yml, /\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n/);
  assert.match(yml, /\n {10}HEALTH_MENTION: \$\{\{ vars\.HEALTH_MENTION \}\}\n/);
  assert.match(yml, /\n {10}HEALTH_SILENCES: \$\{\{ vars\.HEALTH_SILENCES \}\}\n/);
  assert.match(yml, /\n {8}run: node scripts\/health-liveness\.mjs\n/);
  assert.match(yml, /\n {10}sparse-checkout: scripts\n/);
  assert.match(yml, /\n {8}default: true\n/, 'a manual run is a dry run by default');
  assert.doesNotMatch(yml, /GH_PAT|HC_PING/);
});
