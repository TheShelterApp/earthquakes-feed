import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BOT_LOGIN, decide, outageBody, outageMarker, outageSaid, run, summarizeRuns } from '../scripts/health-liveness.mjs';
import { HEALTH_DEAD_MS, HEALTH_STALE_MS } from '../scripts/lib/findings.mjs';
import { BOARD_NUMBERS_FILE, type FetchImpl } from '../scripts/reconcile.mjs';

// Health's own liveness (owner decision 2026-11-19: Healthchecks.io dropped, its sign-up email never arrived):
// scripts/health-liveness.mjs on health-liveness.yml's own cron. Nothing here touches the network.

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

test('summarizeRuns: the newest judged completion (a red run is alive) and the newest creation of any run', () => {
  const runs = [
    { id: 9, status: 'queued', conclusion: null, created_at: iso(NOW - 2 * MIN), updated_at: iso(NOW - 2 * MIN) },
    ran(8, 5 * MIN, 'cancelled'),
    ran(7, 6 * MIN, 'startup_failure'),
    ran(6, 7 * MIN, 'skipped'),
    ran(5, 20 * MIN, 'failure'),
    ran(4, 35 * MIN, 'success'),
    { id: 3, status: 'completed', conclusion: 'success', created_at: 'garbage', updated_at: 'garbage' },
    null,
  ];
  const s = summarizeRuns(runs);
  assert.deepEqual(s.lastCompleted, { id: 5, ms: NOW - 20 * MIN, conclusion: 'failure', url: `https://github.com/${REPO}/actions/runs/5` });
  assert.equal(s.newestCreatedMs, NOW - 2 * MIN);
  assert.deepEqual(summarizeRuns([ran(1, 3 * MIN, 'timed_out')]).lastCompleted?.conclusion, 'timed_out');
  assert.deepEqual(summarizeRuns(null), { lastCompleted: null, newestCreatedMs: null });
});

test('decide: at most 45 min is healthy; over 45 dispatch once (not while a run created within 45 min exists); over 90 dead', () => {
  const at = (doneAgo: number | null, createdAgo: number | null) =>
    decide({ nowMs: NOW, lastCompletedMs: doneAgo === null ? null : NOW - doneAgo, newestCreatedMs: createdAgo === null ? null : NOW - createdAgo });
  assert.equal(HEALTH_STALE_MS, 45 * MIN);
  assert.equal(HEALTH_DEAD_MS, 90 * MIN);
  assert.deepEqual(at(45 * MIN, 48 * MIN), { state: 'ok', ageMs: 45 * MIN, dispatch: false, heal: null, reason: 'the last completed health run finished 45 min ago (at most 45 min)' });
  const stale = at(46 * MIN, 49 * MIN);
  assert.deepEqual([stale.state, stale.dispatch], ['stale', true]);
  assert.equal(stale.reason, 'the last completed health run finished 46 min ago (over 45 min): dispatching health.yml');
  // A health run created 10 min ago (the Worker's, or this check's own dispatch) is queued, running or failed at start.
  const pending = at(60 * MIN, 10 * MIN);
  assert.deepEqual([pending.state, pending.dispatch], ['stale', false]);
  assert.match(pending.reason, /a health run was created 10 min ago and has not completed: no dispatch$/);
  const dead = at(91 * MIN, 91 * MIN);
  assert.deepEqual([dead.state, dead.dispatch], ['dead', true]);
  assert.match(dead.reason, /finished 91 min ago \(over 90 min\): dispatching health\.yml$/);
  // Runs are created every 15 min but none completes (a broken workflow file): dead, and no dispatch would help.
  assert.deepEqual([at(3 * 60 * MIN, 5 * MIN).state, at(3 * 60 * MIN, 5 * MIN).dispatch], ['dead', false]);
  const none = at(null, null);
  assert.deepEqual([none.state, none.dispatch, none.ageMs], ['dead', true, Infinity]);
  assert.match(none.reason, /^no completed health run in the listing \(over 90 min\)/);
});

test('outageSaid / outageBody: the bot\'s comment with the outage\'s marker; the first line mentions the owner', () => {
  const marker = outageMarker(5);
  assert.equal(marker, '<!-- health-liveness v1 outage=5 -->');
  assert.equal(outageMarker('none'), '<!-- health-liveness v1 outage=none -->');
  assert.equal(outageMarker('5 --> x'), '<!-- health-liveness v1 outage=5x -->', 'nothing can close the marker early');
  const bot = { login: BOT_LOGIN };
  assert.equal(outageSaid([{ body: `x\n\n${marker}`, user: bot }], 5), true);
  assert.equal(outageSaid([{ body: `x\n\n${marker}`, user: { login: 'someone' } }], 5), false, 'a copy by a person does not count');
  assert.equal(outageSaid([{ body: `x\n\n${outageMarker(4)}`, user: bot }], 5), false, 'an earlier outage');
  assert.equal(outageSaid([{ body: `x\n\n${outageMarker(50)}`, user: bot }], 5), false, 'not a prefix match');
  assert.equal(outageSaid(null, 5), false);

  const lastCompleted = { id: 5, ms: NOW - 2 * 60 * MIN, conclusion: 'success', url: `https://github.com/${REPO}/actions/runs/5` };
  const decision = decide({ nowMs: NOW, lastCompletedMs: lastCompleted.ms, newestCreatedMs: lastCompleted.ms });
  const body = outageBody({ mention: 'nickaroot', nowMs: NOW, lastCompleted, decision, dispatched: true, runUrl: `https://github.com/${REPO}/actions/runs/77` });
  const parts = body.split('\n\n');
  assert.equal(parts[0], '@nickaroot health is down: no completed health run for 2.0 h');
  assert.match(parts[1]!, /^\*\*Health liveness\*\* — the last completed health run \(https:\/\/github\.com\/TheShelterApp\/earthquakes-feed\/actions\/runs\/5, success\) finished at 2026-11-19 10:00Z, 2\.0 h ago \(line 90 min\); this check dispatched health\.yml just now\. /);
  assert.equal(parts[2], `Run: https://github.com/${REPO}/actions/runs/77`);
  assert.equal(parts[3], marker);
  const quiet = outageBody({ mention: null, nowMs: NOW, lastCompleted: null, decision: decide({ nowMs: NOW, lastCompletedMs: null, newestCreatedMs: NOW - 5 * MIN }), dispatched: false, runUrl: null });
  assert.match(quiet, /^health is down: no completed health run for the whole listing\n\n\*\*Health liveness\*\* — no completed health run is in the listing \(line 90 min\); a health run was created 5 min ago and has not completed: no dispatch\./);
  assert.ok(quiet.endsWith(outageMarker('none')));
});

/** health.yml's runs, the platform board's comments, the users API; records every call. */
class FakeGitHub {
  runs: FakeRun[] = [];
  comments: Array<{ body: string; user: { login: string } }> = [];
  calls: Array<{ method: string; url: string; body: unknown }> = [];
  listStatus = 200;
  dispatchStatus = 204;
  commentsStatus = 200;
  /** 403: GitHub refuses the bot's comment while the board is locked. */
  lockedRejects = false;
  locked = true;
  fetchImpl: FetchImpl = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    this.calls.push({ method, url, body });
    const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    const path = url.replace('https://api.github.com', '');
    if (method === 'GET' && path === `/repos/${REPO}/actions/workflows/health.yml/runs?per_page=50`) {
      return this.listStatus === 200 ? json({ total_count: this.runs.length, workflow_runs: this.runs }) : json({ message: 'boom' }, this.listStatus);
    }
    if (method === 'POST' && path === `/repos/${REPO}/actions/workflows/health.yml/dispatches`) {
      if (this.dispatchStatus !== 204) return json({ message: 'boom' }, this.dispatchStatus);
      this.runs.unshift({ id: 1000 + this.runs.length, status: 'queued', conclusion: null, created_at: iso(NOW), updated_at: iso(NOW) });
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path.startsWith(`/repos/${REPO}/issues/126/comments?since=`)) {
      return this.commentsStatus === 200 ? json(this.comments) : json({ message: 'boom' }, this.commentsStatus);
    }
    if (method === 'POST' && path === `/repos/${REPO}/issues/126/comments`) {
      if (this.lockedRejects && this.locked) return json({ message: 'Unable to create comment because issue is locked.' }, 403);
      this.comments.push({ body: String((body as { body: string }).body), user: { login: BOT_LOGIN } });
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

test('run: healthy does nothing; stale dispatches once; a run created meanwhile holds the next dispatch', async () => {
  const gh = new FakeGitHub();
  gh.runs = [ran(5, 20 * MIN)];
  assert.deepEqual(await pass(gh), { code: 0, lines: ['health-liveness: ok: the last completed health run finished 20 min ago (at most 45 min)'] });
  assert.deepEqual(gh.writes(), []);

  const stale = new FakeGitHub();
  stale.runs = [ran(5, 50 * MIN)];
  const first = await pass(stale);
  assert.equal(first.code, 0, 'a dispatch is the self-heal, not an alarm');
  assert.deepEqual(stale.writes(), [`POST /repos/${REPO}/actions/workflows/health.yml/dispatches`]);
  assert.deepEqual(stale.calls.find((c) => c.method === 'POST')!.body, { ref: 'main' });
  assert.ok(first.lines.some((l) => l.startsWith('::warning title=Health liveness::dispatched health.yml: the last completed health run finished 50 min ago')));
  // Ten minutes later the dispatched run is still queued: no second dispatch.
  const second = await pass(stale, {}, NOW + 10 * MIN);
  assert.equal(second.code, 0);
  assert.equal(stale.writes().length, 1);
  assert.match(second.lines[0]!, /a health run was created 10 min ago and has not completed: no dispatch$/);

  const broken = new FakeGitHub();
  broken.runs = [ran(5, 50 * MIN)];
  broken.dispatchStatus = 403;
  const refused = await pass(broken);
  assert.equal(refused.code, 1, 'a dead health with a broken self-heal must be seen');
  assert.ok(refused.lines.some((l) => l.startsWith('::error title=Health liveness::dispatching health.yml failed: HTTP 403')));
});

test('run: dead for 90 min mentions the owner on the platform board once per outage, red on that run only', async () => {
  const gh = new FakeGitHub();
  gh.runs = [ran(5, 2 * 60 * MIN)];
  const first = await pass(gh);
  assert.equal(first.code, 1, 'red once: the failed-run email is the second channel');
  assert.deepEqual(gh.writes(), [`POST /repos/${REPO}/actions/workflows/health.yml/dispatches`, `POST /repos/${REPO}/issues/126/comments`]);
  const listing = gh.calls.find((c) => c.url.includes('/issues/126/comments?since='))!;
  assert.ok(listing.url.endsWith(`since=${encodeURIComponent(iso(NOW - 2 * 60 * MIN))}&per_page=100`), 'comments since the outage began');
  assert.equal(gh.comments.length, 1);
  assert.match(gh.comments[0]!.body, /^@nickaroot health is down: no completed health run for 2\.0 h\n\n/);
  assert.ok(gh.comments[0]!.body.endsWith(outageMarker(5)));
  assert.ok(first.lines.some((l) => l === '::error title=Health liveness::health is down: the last completed health run finished 2.0 h ago (over 90 min): dispatching health.yml; said on board #126 (mentions @nickaroot)'));

  // The next deliveries of the same outage: no comment, no dispatch (the run it created is still queued), green.
  for (const later of [10, 20, 60]) {
    const again = await pass(gh, {}, NOW + later * MIN);
    assert.equal(again.code, 0, `${later} min later`);
    assert.ok(again.lines.includes('health-liveness: the outage since run 5 is already on board #126: nothing more'));
  }
  assert.equal(gh.comments.length, 1);
  assert.equal(gh.writes().length, 3, 'one more dispatch only once the first is 45 min old');

  // Health ran once more and died again: a new outage, a new comment.
  gh.runs.unshift({ ...ran(6, 0), created_at: iso(NOW + 55 * MIN), updated_at: iso(NOW + 60 * MIN) });
  assert.equal((await pass(gh, {}, NOW + 70 * MIN)).code, 0, 'alive again');
  const next = await pass(gh, {}, NOW + 3 * 60 * MIN);
  assert.equal(next.code, 1);
  assert.equal(gh.comments.length, 2);
  assert.ok(gh.comments[1]!.body.endsWith(outageMarker(6)));
});

test('run: no mention without HEALTH_MENTION or for an organization; a locked board is unlocked around the comment; dry run writes nothing', async () => {
  const unset = new FakeGitHub();
  unset.runs = [ran(5, 2 * 60 * MIN)];
  await pass(unset, { HEALTH_MENTION: '' });
  assert.match(unset.comments[0]!.body, /^health is down: /, 'unset: the comment goes out unmentioned');
  assert.ok(!unset.calls.some((c) => c.url.includes('/users/')));

  const org = new FakeGitHub();
  org.runs = [ran(5, 2 * 60 * MIN)];
  const o = await pass(org, { HEALTH_MENTION: 'TheShelterApp' });
  assert.match(org.comments[0]!.body, /^health is down: /);
  assert.ok(o.lines.some((l) => l.startsWith('::warning title=Health liveness::HEALTH_MENTION "TheShelterApp" is a GitHub Organization, not a user')));

  const locked = new FakeGitHub();
  locked.runs = [ran(5, 2 * 60 * MIN)];
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

  const dry = new FakeGitHub();
  dry.runs = [ran(5, 2 * 60 * MIN)];
  const d = await pass(dry, { DRY_RUN: '1' });
  assert.equal(d.code, 0);
  assert.deepEqual(dry.writes(), []);
  assert.ok(d.lines.includes('health-liveness: would dispatch health.yml {"ref":"main"} (dry run)'));
  assert.ok(d.lines.some((x) => x.startsWith('----- comment on board #126 (dry run, not posted) -----\n@nickaroot health is down: ')));
});

test('run: an unreadable listing, comments or board number is red; no token is misconfigured', async () => {
  const gh = new FakeGitHub();
  gh.listStatus = 502;
  const list = await pass(gh);
  assert.equal(list.code, 1);
  assert.ok(list.lines.some((l) => l.startsWith("::error title=Health liveness::cannot list health.yml's runs: HTTP 502")));
  assert.equal(gh.calls.length, 3, 'a read is tried three times');

  const comments = new FakeGitHub();
  comments.runs = [ran(5, 2 * 60 * MIN)];
  comments.commentsStatus = 500;
  assert.equal((await pass(comments)).code, 1);
  assert.equal(comments.comments.length, 0);

  const numbers = new FakeGitHub();
  numbers.runs = [ran(5, 2 * 60 * MIN)];
  const n = await pass(numbers, {}, NOW, JSON.stringify({ alerts: 124, feed: 125, platform: null }));
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
  assert.match(yml, /\n {8}run: node scripts\/health-liveness\.mjs\n/);
  assert.match(yml, /\n {10}sparse-checkout: scripts\n/);
  assert.match(yml, /\n {8}default: true\n/, 'a manual run is a dry run by default');
  assert.doesNotMatch(yml, /GH_PAT|HC_PING/);
});
