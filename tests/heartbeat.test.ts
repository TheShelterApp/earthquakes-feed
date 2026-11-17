import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACCEPT_MINUTES, KEEP_MINUTES, SCHEMA, claimMinute, releaseMinute, type Sql } from '../heartbeat/src/ledger.js';
import worker, { DAILY, inputsFor, workflowFor } from '../heartbeat/src/worker.js';

// The heartbeat Worker's fan-out (heartbeat/src/worker.js): one per-minute cron, at most one workflow per minute, and
// exactly one dispatch per (workflow, intended minute) through the dispatch ledger (heartbeat/src/ledger.js).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const minutes = Array.from({ length: 60 }, (_, m) => m);
const hours = Array.from({ length: 24 }, (_, h) => h);
/** The minutes of an hour without a daily dispatch (09 UTC) a workflow is dispatched at. */
const minutesOf = (workflow: string, hour = 9): number[] => minutes.filter((m) => workflowFor(m, hour) === workflow);

test('heartbeat: the hour, minute by minute', () => {
  assert.deepEqual(minutesOf('aggregate.yml'), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.deepEqual(minutesOf('health.yml'), [7, 22, 37, 52]);
  assert.deepEqual(minutesOf('backfill.yml'), [41]);
  assert.deepEqual(minutesOf('first-solutions.yml'), [48]);
  assert.deepEqual(minutesOf('history.yml'), [26]);
  // 19 dispatches an hour, every other minute does nothing.
  assert.equal(minutes.filter((m) => workflowFor(m, 9) != null).length, 19);
});

test('heartbeat: the day: state-backup at 00:31 and 06:31, state-gc at 03:33 UTC, on minutes no hourly workflow uses', () => {
  const at = (workflow: string): string[] =>
    hours.flatMap((h) => minutes.filter((m) => workflowFor(m, h) === workflow).map((m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`));
  assert.deepEqual(at('state-backup.yml'), ['00:31', '06:31']);
  assert.deepEqual(at('state-gc.yml'), ['03:33']);
  // Every other hour is the plain hour; hours 0, 3 and 6 have one dispatch more, and every hourly workflow keeps its minutes.
  for (const h of hours) {
    assert.equal(minutes.filter((m) => workflowFor(m, h) != null).length, h === 0 || h === 3 || h === 6 ? 20 : 19, `hour ${h}`);
    for (const w of ['aggregate.yml', 'health.yml', 'backfill.yml', 'first-solutions.yml', 'history.yml']) assert.deepEqual(minutesOf(w, h), minutesOf(w), `${w} at hour ${h}`);
  }
  // A daily minute is free in every hour: no hourly workflow loses a tick to it, and (workflow, minute) stays one claim.
  for (const [, m] of DAILY) assert.equal(workflowFor(m, 9), null, `minute ${m} is unused by the hourly fan-out`);
  // 00:31 leaves the 23:55 aggregate run (queued behind the writer group) 31 minutes to push midnight's last commit
  // before the first archive of the day, which is never replaced; GC runs after that backup.
  const at0 = (w: string): number[] => DAILY.filter(([, , x]) => x === w).map(([h, m]) => h * 60 + m);
  const backups = at0('state-backup.yml');
  assert.ok(backups[0]! >= 30 && backups[0]! < at0('state-gc.yml')[0]!);
  // feed:state-backup goes P2 when the newest day is 36 h old, i.e. at 12:00 UTC of the next day: one lost dispatch or
  // failed run of the first backup is retried by the second, hours before that line (a backup takes minutes).
  assert.ok(backups[1]! <= 12 * 60 - 4 * 60, 'the second backup leaves hours before 12:00 UTC');
});

test('heartbeat: history gets its own minute, away from the writers and from first-solutions', () => {
  const [m] = minutesOf('history.yml');
  assert.ok(m != null && m % 5 !== 0, 'never an aggregate minute');
  for (const other of ['backfill.yml', 'first-solutions.yml', 'health.yml']) assert.ok(!minutesOf(other).includes(m!), other);
  // After the first-solutions collect job (dispatched at :48, at most 45 minutes: over by :33 at the latest, by about
  // :22 in practice) and with its own 20-minute collect job over before the next :48.
  assert.ok(m! + 20 < minutesOf('first-solutions.yml')[0]!);
});

test('heartbeat: only first-solutions and state-gc are dispatched with inputs (GitHub refuses inputs a workflow does not declare)', () => {
  assert.deepEqual(inputsFor('first-solutions.yml'), { tick: '1' });
  assert.deepEqual(inputsFor('state-gc.yml'), { tick: '1' });
  for (const w of ['history.yml', 'aggregate.yml', 'backfill.yml', 'health.yml', 'state-backup.yml']) assert.equal(inputsFor(w), null, w);
});

test('heartbeat: the daily state jobs are dispatched once on their minute; their GitHub crons stay as the fallback', async () => {
  const h = harness();
  await h.activate([
    '2026-11-17T00:31:22Z',
    '2026-11-17T00:31:51Z',
    '2026-11-17T01:31:22Z',
    '2026-11-17T03:33:22Z',
    '2026-11-17T03:33:51Z',
    '2026-11-17T04:33:22Z',
    '2026-11-17T06:31:22Z',
    '2026-11-17T06:31:51Z',
  ]);
  assert.deepEqual(
    h.calls.map((c) => [c.workflow, c.body]),
    [
      ['state-backup.yml', { ref: 'main' }],
      ['state-gc.yml', { ref: 'main', inputs: { tick: '1' } }],
      ['state-backup.yml', { ref: 'main' }],
    ],
  );
  assert.equal(h.logs.filter((l) => l.endsWith(': duplicate')).length, 3);
  assert.deepEqual(h.failures, []);

  // state-gc declares `tick`, and a tick is the scheduled run (STATE_GC_SCHEDULED; a refused gate is a warning), never
  // the dispatch's dry_run default. state-backup takes no inputs. Both keep their crons.
  const gc = readFileSync(here('../.github/workflows/state-gc.yml'), 'utf8');
  assert.match(gc, /\n {6}tick:\n {8}description: /);
  assert.ok(gc.includes("STATE_GC_DRY_RUN: ${{ (github.event_name == 'schedule' || inputs.tick == '1') && 'scheduled' || (inputs.dry_run && '1' || '') }}"));
  assert.ok(gc.includes("RETRIED: ${{ (github.event_name == 'schedule' || inputs.tick == '1') && 'true' || '' }}"));
  assert.match(gc, /schedule:\n {4}- cron: '23 3 \* \* \*'\n {2}workflow_dispatch:/);
  const backup = readFileSync(here('../.github/workflows/state-backup.yml'), 'utf8');
  assert.match(backup, /schedule:\n {4}- cron: '41 0 \* \* \*'\n {2}workflow_dispatch:\n\n/);
});

test('heartbeat: a history dispatch is a plain workflow_dispatch on main, and the workflow itself reads the enabled flag', async () => {
  const h = harness();
  await h.activate(['2026-10-01T21:26:00Z', '2026-10-01T21:27:00Z']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.url, 'https://api.github.com/repos/TheShelterApp/earthquakes-feed/actions/workflows/history.yml/dispatches');
  assert.deepEqual(h.calls[0]!.body, { ref: 'main' });

  // The dispatched run is gated by the workflow's first step, which reads providers/history.json; the walk is in its
  // own concurrency group, and no job takes the writer lock (FEED-OPS-4: the commit job pushes through
  // scripts/push-data.sh, tests/writer-group.test.ts).
  const yml = readFileSync(here('../.github/workflows/history.yml'), 'utf8');
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /jq -r '\.enabled' providers\/history\.json/);
  const top = yml.slice(0, yml.indexOf('\njobs:'));
  assert.match(top, /concurrency:\n {2}group: earthquakes-feed-history\n {2}cancel-in-progress: false\n {2}queue: max\n/);
  assert.equal((yml.match(/group: earthquakes-feed-writer/g) ?? []).length, 0);
});

test('workflows: both sides of the shared history group queue instead of cancelling a waiting run (FEED-WF-1)', () => {
  // history.yml holds the group at workflow level, first-solutions.yml in its collect job; with `queue: max` on both,
  // a newer arrival of one never cancels the other's pending run, whichever queued first.
  const fs = readFileSync(here('../.github/workflows/first-solutions.yml'), 'utf8');
  const collect = fs.slice(fs.indexOf('\n  collect:'), fs.indexOf('\n    steps:', fs.indexOf('\n  collect:')) + 1);
  assert.match(collect, /\n {4}concurrency:\n {6}group: earthquakes-feed-history\n {6}cancel-in-progress: false\n {6}queue: max\n/);
  assert.equal((fs.match(/group: earthquakes-feed-history/g) ?? []).length, 1, 'only the collect job takes the history group');
});

test('heartbeat: the Worker has no HTTP surface', async () => {
  const res = await worker.fetch();
  assert.equal(res.status, 404);
  const toml = readFileSync(here('../heartbeat/wrangler.toml'), 'utf8');
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^preview_urls = false$/m);
  assert.match(toml, /^crons = \["\* \* \* \* \*"\]$/m);
});

// --- The dispatch ledger: exactly one dispatch per (workflow, intended UTC minute) -----------------------------------

/** A node:sqlite database behind the Durable Object's `ctx.storage.sql.exec` shape, with the ledger's schema. */
function sqliteSql(): Sql & { rows(): { minute: number; workflow: string }[] } {
  const db = new DatabaseSync(':memory:');
  const exec = (query: string, ...bindings: unknown[]) => {
    const rows = db.prepare(query).all(...(bindings as SQLInputValue[]));
    return { toArray: () => rows };
  };
  exec(SCHEMA);
  return {
    exec,
    rows: () =>
      (exec('SELECT minute, workflow FROM dispatches ORDER BY minute, workflow').toArray() as { minute: number; workflow: string }[]).map(
        ({ minute, workflow }) => ({ minute, workflow }),
      ),
  };
}

type Status = number | 'network';

/**
 * The Worker with its dispatch ledger on node:sqlite (claim and release go through async calls, as the Durable Object's
 * RPC does) and a fake GitHub answering `statuses` in order, then 204. `activate` runs one cron activation per
 * scheduledTime (in order, or all at once with `concurrent`), with the ledger's clock `lateMs` after the scheduledTime.
 */
function harness(statuses: Status[] = [], ledgerDown = false) {
  const sql = sqliteSql();
  let now = 0;
  const names: string[] = [];
  const ledger = {
    claim: async (workflow: string, minute: number) => claimMinute(sql, workflow, minute, now),
    release: async (workflow: string, minute: number) => releaseMinute(sql, workflow, minute),
  };
  const env = {
    GH_PAT: 'test-token',
    DISPATCH_LEDGER: {
      idFromName: (name: string) => (names.push(name), name),
      get: () => {
        if (ledgerDown) throw new Error('Durable Object storage operation exceeded the daily limit');
        return ledger;
      },
    },
  };
  const calls: { url: string; workflow: string; body: unknown }[] = [];
  const logs: string[] = [];
  const failures: unknown[] = [];
  const activate = async (times: string[], { lateMs = 0, concurrent = false } = {}): Promise<void> => {
    const realFetch = globalThis.fetch;
    const realLog = console.log;
    const realError = console.error;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      calls.push({ url: String(url), workflow: String(url).split('/').at(-2)!, body: JSON.parse(init.body) });
      const status = statuses.shift() ?? 204;
      if (status === 'network') throw new TypeError('fetch failed');
      return new Response(status === 204 ? null : '{"message":"Server Error"}', { status });
    }) as unknown as typeof fetch;
    console.log = (...args: unknown[]) => void logs.push(args.join(' '));
    console.error = (...args: unknown[]) => void logs.push(args.join(' '));
    const one = async (at: string): Promise<void> => {
      const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
      try {
        const run = worker.scheduled({ scheduledTime: Date.parse(at) }, env, ctx);
        await run;
        await Promise.all(waits);
      } catch (err) {
        failures.push(err);
      }
    };
    try {
      if (concurrent) {
        await Promise.all(
          times.map((at) => {
            now = Date.parse(at) + lateMs;
            return one(at);
          }),
        );
      } else {
        for (const at of times) {
          now = Date.parse(at) + lateMs;
          await one(at);
        }
      }
    } finally {
      globalThis.fetch = realFetch;
      console.log = realLog;
      console.error = realError;
    }
  };
  const dispatched = (workflow: string): number => calls.filter((c) => c.workflow === workflow).length;
  return { sql, names, calls, logs, failures, activate, dispatched };
}

test('heartbeat: two activations of one minute dispatch once (2026-10-14: scheduledTime :22 and :51)', async () => {
  const h = harness();
  await h.activate(['2026-10-14T10:05:22Z', '2026-10-14T10:05:51Z'], { lateMs: 2_000 });
  assert.equal(h.dispatched('aggregate.yml'), 1);
  assert.deepEqual(h.logs, [
    'dispatch aggregate.yml 2026-10-14T10:05Z (scheduledTime 2026-10-14T10:05:22.000Z)',
    'skip aggregate.yml 2026-10-14T10:05Z (scheduledTime 2026-10-14T10:05:51.000Z): duplicate',
  ]);
  assert.deepEqual(h.failures, []);
  // One ledger object for every activation.
  assert.ok(h.names.length > 0 && h.names.every((n) => n === 'dispatch-ledger'));
});

test('heartbeat: a whole hour of doubled activations dispatches each workflow exactly on its minutes', async () => {
  const h = harness();
  const times = minutes.flatMap((m) => {
    const mm = String(m).padStart(2, '0');
    return [`2026-10-14T09:${mm}:22Z`, `2026-10-14T09:${mm}:51Z`];
  });
  await h.activate(times, { lateMs: 1_500 });
  assert.equal(h.calls.length, 19);
  for (const workflow of ['aggregate.yml', 'health.yml', 'backfill.yml', 'first-solutions.yml', 'history.yml']) {
    assert.equal(h.dispatched(workflow), minutesOf(workflow).length, workflow);
  }
  assert.equal(h.logs.filter((l) => l.startsWith('skip ')).length, 19);
});

test('heartbeat: 30 s jitter and concurrent arrivals inside the intended minute still dispatch once', async () => {
  const h = harness();
  await h.activate(['2026-10-14T10:05:00.000Z', '2026-10-14T10:05:22.400Z', '2026-10-14T10:05:51.900Z', '2026-10-14T10:05:59.999Z']);
  assert.equal(h.dispatched('aggregate.yml'), 1);
  // Three activations of 10:10 arriving at once (e.g. from different colos): the ledger serialises the claims.
  await h.activate(['2026-10-14T10:10:22Z', '2026-10-14T10:10:51Z', '2026-10-14T10:10:30Z'], { concurrent: true });
  assert.equal(h.dispatched('aggregate.yml'), 2);
  assert.equal(h.logs.filter((l) => l.endsWith(': duplicate')).length, 5);
});

test('heartbeat: two different minutes are two dispatches', async () => {
  const h = harness();
  await h.activate(['2026-10-14T10:05:22Z', '2026-10-14T10:07:22Z', '2026-10-14T10:10:22Z']);
  assert.equal(h.dispatched('aggregate.yml'), 2);
  assert.equal(h.dispatched('health.yml'), 1);
  // The same minute of the next hour is a different intended minute too.
  await h.activate(['2026-10-14T11:05:22Z']);
  assert.equal(h.dispatched('aggregate.yml'), 3);
  assert.deepEqual(h.failures, []);
});

test('heartbeat: a failed dispatch releases its claim, so the next activation of the minute retries it', async () => {
  // GitHub 5xx: the first activation fails, the duplicate 30 s later dispatches, a third is a duplicate again.
  const h = harness([503]);
  await h.activate(['2026-10-14T10:05:22Z', '2026-10-14T10:05:51Z', '2026-10-14T10:05:55Z']);
  assert.equal(h.dispatched('aggregate.yml'), 2);
  assert.equal(h.failures.length, 1);
  assert.match(h.logs[0]!, /^dispatch failed aggregate\.yml 2026-10-14T10:05Z .*GitHub 503/);
  assert.match(h.logs[1]!, /^dispatch aggregate\.yml 2026-10-14T10:05Z /);
  assert.match(h.logs[2]!, /^skip aggregate\.yml 2026-10-14T10:05Z .*: duplicate$/);

  // A network error (or the 10 s timeout) is a failure too.
  const n = harness(['network']);
  await n.activate(['2026-10-14T10:07:22Z', '2026-10-14T10:07:51Z']);
  assert.equal(n.dispatched('health.yml'), 2);
  assert.equal(n.failures.length, 1);
  assert.deepEqual(n.sql.rows(), [{ minute: Date.parse('2026-10-14T10:07:00Z') / 60_000, workflow: 'health.yml' }]);

  // Single activation that fails: no claim is left standing, and the next tick dispatches as usual.
  const s = harness([502]);
  await s.activate(['2026-10-14T10:05:00Z']);
  assert.deepEqual(s.sql.rows(), []);
  await s.activate(['2026-10-14T10:10:00Z']);
  assert.equal(s.dispatched('aggregate.yml'), 2);
});

test('heartbeat: late and out-of-order activations get one dispatch per intended minute; over an hour late is stale', async () => {
  const h = harness();
  await h.activate(['2026-10-14T10:10:00Z']);
  // 10:05 delivered six minutes late, after 10:10: its minute was never dispatched, so it is now.
  await h.activate(['2026-10-14T10:05:00Z'], { lateMs: 6 * 60_000 });
  assert.equal(h.dispatched('aggregate.yml'), 2);
  // Its duplicate, later still, is refused; so is a retry of 10:10.
  await h.activate(['2026-10-14T10:05:51Z'], { lateMs: 20 * 60_000 });
  await h.activate(['2026-10-14T10:10:00Z'], { lateMs: 45 * 60_000 });
  assert.equal(h.dispatched('aggregate.yml'), 2);
  // More than ACCEPT_MINUTES late: a newer activation of every workflow has superseded it.
  await h.activate(['2026-10-14T08:55:00Z'], { lateMs: (ACCEPT_MINUTES + 5) * 60_000 });
  assert.equal(h.dispatched('aggregate.yml'), 2);
  assert.match(h.logs.at(-1)!, /^skip aggregate\.yml 2026-10-14T08:55Z .*: stale$/);
});

test('heartbeat: a ledger that cannot be reached does not stop the feed (fail open)', async () => {
  const h = harness([], true);
  await h.activate(['2026-10-14T10:05:22Z']);
  assert.equal(h.dispatched('aggregate.yml'), 1);
  assert.match(h.logs[0]!, /^ledger unavailable, dispatching unguarded aggregate\.yml 2026-10-14T10:05Z /);
  assert.match(h.logs[1]!, /^dispatch aggregate\.yml 2026-10-14T10:05Z /);
});

test('heartbeat ledger: every minute still claimable keeps its row; older rows are pruned', () => {
  assert.ok(KEEP_MINUTES > ACCEPT_MINUTES);
  const sql = sqliteSql();
  const start = Date.parse('2026-10-14T00:00:00Z') / 60_000;
  // A day of dispatch minutes, each claimed on time.
  for (let m = start; m < start + 1440; m++) {
    const workflow = workflowFor(m % 60, Math.floor(m / 60) % 24);
    if (workflow) assert.equal(claimMinute(sql, workflow, m, m * 60_000 + 22_000), 'claimed');
  }
  const end = start + 1440;
  // Bounded: at most KEEP_MINUTES of rows (19 an hour).
  const rows = sql.rows();
  assert.ok(rows.length <= (KEEP_MINUTES / 60) * 19 + 1, String(rows.length));
  // Every claimable minute (not older than ACCEPT_MINUTES) is still refused as a duplicate, older ones as stale.
  for (let m = end - ACCEPT_MINUTES - 30; m < end; m++) {
    const workflow = workflowFor(m % 60, Math.floor(m / 60) % 24);
    if (!workflow) continue;
    const verdict = claimMinute(sql, workflow, m, end * 60_000);
    assert.equal(verdict, m >= end - ACCEPT_MINUTES ? 'duplicate' : 'stale', `minute ${m - start}`);
  }
  // Release removes exactly that claim.
  const last = rows.at(-1)!;
  releaseMinute(sql, last.workflow, last.minute);
  assert.equal(claimMinute(sql, last.workflow, last.minute, end * 60_000), 'claimed');
});

test('heartbeat: the ledger is one SQLite-backed Durable Object, exported by the entry module', () => {
  const toml = readFileSync(here('../heartbeat/wrangler.toml'), 'utf8');
  assert.match(toml, /^main = "src\/index\.js"$/m);
  assert.match(toml, /\[\[durable_objects\.bindings\]\]\nname = "DISPATCH_LEDGER"\nclass_name = "DispatchLedger"/);
  assert.match(toml, /\[\[migrations\]\]\ntag = "v1"\nnew_sqlite_classes = \["DispatchLedger"\]/);
  const entry = readFileSync(here('../heartbeat/src/index.js'), 'utf8');
  assert.match(entry, /^export \{ default \} from '\.\/worker\.js';$/m);
  assert.match(entry, /^export class DispatchLedger extends DurableObject \{$/m);
  assert.match(entry, /ctx\.storage\.sql\.exec\(SCHEMA\)/);
});

test('heartbeat deploy.sh: deploys only from origin/main, and only as the expected Cloudflare account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-deploy-'));
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    FAKE_WRANGLER_LOG: join(dir, 'wrangler.log'),
  };
  delete e.FEED_HEARTBEAT_CF_EMAIL;
  writeFileSync(join(dir, 'gitconfig'), '[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: work, env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', origin], { env: e });
  execFileSync('git', ['init', '-q', work], { env: e });
  mkdirSync(join(work, 'heartbeat'));
  copyFileSync(here('../heartbeat/deploy.sh'), join(work, 'heartbeat/deploy.sh'));
  writeFileSync(join(work, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(work, 'node_modules/.bin'), { recursive: true });
  const fake = join(work, 'node_modules/.bin/wrangler');
  writeFileSync(
    fake,
    '#!/usr/bin/env bash\nprintf \'%s|\' "$@" >> "$FAKE_WRANGLER_LOG"; echo >> "$FAKE_WRANGLER_LOG"\n' +
      'if [ "$1" = whoami ]; then echo "You are logged in with an OAuth Token, associated with the email owner@example.com."; fi\n',
  );
  chmodSync(fake, 0o755);
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync('bash', ['heartbeat/deploy.sh', ...args], { cwd: work, env: { ...e, ...extra }, encoding: 'utf8' });
    return { status: r.status, err: r.stderr };
  };
  const calls = (): string[] => {
    try {
      return readFileSync(e.FAKE_WRANGLER_LOG!, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const sha = git('rev-parse', '--short=10', 'HEAD').trim();

  // No account given, or another account logged in: refused before any deploy (a second heartbeat on another account
  // would dispatch every workflow twice: the dispatch ledger is per account).
  let res = run([]);
  assert.notEqual(res.status, 0);
  assert.match(res.err, /set FEED_HEARTBEAT_CF_EMAIL/);
  res = run([], { FEED_HEARTBEAT_CF_EMAIL: 'someone@else.example' });
  assert.notEqual(res.status, 0);
  assert.match(res.err, /not logged in as someone@else\.example/);
  assert.ok(!calls().some((c) => c.startsWith('deploy|')));
  assert.notEqual(run(['--force'], { FEED_HEARTBEAT_CF_EMAIL: 'owner@example.com' }).status, 0);

  // The expected account: deployed, tagged with the main commit. A dry run needs no login.
  res = run([], { FEED_HEARTBEAT_CF_EMAIL: 'owner@example.com' });
  assert.equal(res.status, 0, res.err);
  assert.equal(calls().at(-1), `deploy|--message|main ${sha}|`);
  res = run(['--dry-run']);
  assert.equal(res.status, 0, res.err);
  assert.equal(calls().at(-1), 'deploy|--dry-run|');

  // A commit ahead of origin/main: refused, wrangler never runs.
  const before = calls().length;
  writeFileSync(join(work, 'heartbeat/x.txt'), 'x');
  git('add', 'heartbeat/x.txt');
  git('commit', '-q', '-m', 'local');
  assert.match(run([], { FEED_HEARTBEAT_CF_EMAIL: 'owner@example.com' }).err, /is not origin\/main/);
  assert.equal(calls().length, before);
});
