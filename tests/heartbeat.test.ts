import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACCEPT_MINUTES, KEEP_MINUTES, SCHEMA, claimMinute, releaseMinute, type Sql } from '../heartbeat/src/ledger.js';
import worker, { inputsFor, workflowFor } from '../heartbeat/src/worker.js';

// The heartbeat Worker's fan-out (heartbeat/src/worker.js): one per-minute cron, at most one workflow per minute, and
// exactly one dispatch per (workflow, intended minute) through the dispatch ledger (heartbeat/src/ledger.js).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const minutes = Array.from({ length: 60 }, (_, m) => m);
const minutesOf = (workflow: string): number[] => minutes.filter((m) => workflowFor(m) === workflow);

test('heartbeat: the hour, minute by minute', () => {
  assert.deepEqual(minutesOf('aggregate.yml'), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.deepEqual(minutesOf('health.yml'), [7, 22, 37, 52]);
  assert.deepEqual(minutesOf('backfill.yml'), [41]);
  assert.deepEqual(minutesOf('first-solutions.yml'), [48]);
  assert.deepEqual(minutesOf('history.yml'), [26]);
  // 19 dispatches an hour, every other minute does nothing.
  assert.equal(minutes.filter((m) => workflowFor(m) != null).length, 19);
});

test('heartbeat: history gets its own minute, away from the writers and from first-solutions', () => {
  const [m] = minutesOf('history.yml');
  assert.ok(m != null && m % 5 !== 0, 'never an aggregate minute');
  for (const other of ['backfill.yml', 'first-solutions.yml', 'health.yml']) assert.ok(!minutesOf(other).includes(m!), other);
  // After the first-solutions collect job (dispatched at :48, at most 45 minutes: over by :33 at the latest, by about
  // :22 in practice) and with its own 20-minute collect job over before the next :48.
  assert.ok(m! + 20 < minutesOf('first-solutions.yml')[0]!);
});

test('heartbeat: only first-solutions is dispatched with inputs (GitHub refuses inputs a workflow does not declare)', () => {
  assert.deepEqual(inputsFor('first-solutions.yml'), { tick: '1' });
  for (const w of ['history.yml', 'aggregate.yml', 'backfill.yml', 'health.yml']) assert.equal(inputsFor(w), null, w);
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
  assert.match(top, /concurrency:\n {2}group: earthquakes-feed-history\n {2}cancel-in-progress: false/);
  assert.equal((yml.match(/group: earthquakes-feed-writer/g) ?? []).length, 0);
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
    const workflow = workflowFor(m % 60);
    if (workflow) assert.equal(claimMinute(sql, workflow, m, m * 60_000 + 22_000), 'claimed');
  }
  const end = start + 1440;
  // Bounded: at most KEEP_MINUTES of rows (19 an hour).
  const rows = sql.rows();
  assert.ok(rows.length <= (KEEP_MINUTES / 60) * 19 + 1, String(rows.length));
  // Every claimable minute (not older than ACCEPT_MINUTES) is still refused as a duplicate, older ones as stale.
  for (let m = end - ACCEPT_MINUTES - 30; m < end; m++) {
    const workflow = workflowFor(m % 60);
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
