import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { CUSTOM_ADAPTERS } from '../src/custom.js';
import { loadRegistry } from '../src/providers.js';

// CENC's retries (src/custom.ts). Round 24 (#101, feed sweep 3.10) raised them from one to two, since about a quarter of
// the aggregate's CENC fetches fail. The review measured the run log (status/history, 2026-10-01 to 10-13, 3,693
// runs): the first attempt failed in 930 runs, each with a connect timeout of about 10.5 s, and the retry failed too in
// 906 of them (97 %). In the first 14 runs with two retries, 4 failed all three attempts (33 s each): 29 % of runs,
// against 25 % before. A third attempt does not help, and in each run it fails it adds 11 s to the aggregate's fetch
// phase, so CENC is back to one retry. The failures do not cluster from run to run (a run fails 24 % of the time after a
// failed run, 25 % after a good one), so the next run 5 minutes later fetches CENC as usual.

test('cenc: a failing fetch is asked twice (one retry): a third attempt seconds later almost never helps', async () => {
  const cenc = loadRegistry().find((p) => p.id === 'cenc')!;
  let connections = 0;
  // Every connection is dropped at once: the TLS handshake fails, as a reset from the source's host would.
  const server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const t0 = Date.now();
    await assert.rejects(CUSTOM_ADAPTERS.cenc!({ ...cenc, base: `https://127.0.0.1:${port}/data/data.json` }, Date.now()));
    assert.equal(connections, 2);
    // The backoff between the attempts (0.6 s) keeps a dropped source to about a second.
    assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
