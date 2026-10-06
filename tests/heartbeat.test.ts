import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import worker, { inputsFor, workflowFor } from '../heartbeat/src/worker.js';

// The heartbeat Worker's fan-out (heartbeat/src/worker.js): one per-minute cron, at most one workflow per minute.

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
  const calls: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  try {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
    await worker.scheduled({ scheduledTime: Date.parse('2026-10-01T21:26:00Z') }, { GH_PAT: 'test-token' }, ctx);
    await worker.scheduled({ scheduledTime: Date.parse('2026-10-01T21:27:00Z') }, { GH_PAT: 'test-token' }, ctx);
    await Promise.all(waits);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.github.com/repos/TheShelterApp/earthquakes-feed/actions/workflows/history.yml/dispatches');
  assert.deepEqual(calls[0]!.body, { ref: 'main' });

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
