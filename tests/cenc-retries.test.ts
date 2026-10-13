import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { CUSTOM_ADAPTERS } from '../src/custom.js';
import { loadRegistry } from '../src/providers.js';

// Feed sweep report 3.10 (round 24): about 24 % of CENC's fetches failed in the week to 2026-10-13, and a failed fetch
// is asked again only on the next 5-minute run, so a CENC event could reach the feed up to about 20 minutes late. The
// adapter now makes three attempts (two retries, as AFAD, TMD and most other custom adapters do) instead of two; each
// attempt is bounded at 12 s and the whole call by getText's 45 s deadline.

test('cenc: a failing fetch is asked three times (two retries) before the run gives up on it', async () => {
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
    assert.equal(connections, 3);
    // The backoffs between attempts (0.6 s, then 1.2 s) keep a dropped source to a couple of seconds.
    assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
