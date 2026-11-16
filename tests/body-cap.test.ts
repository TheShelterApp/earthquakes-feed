import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { MAX_BODY_BYTES, getText } from '../src/custom.js';

// FEED-PROV-L5: getText read a source's whole body with no bound (and inflated a gzip body without one). A body past
// maxBytes (default MAX_BODY_BYTES) now aborts the request. The pinned (https) path is tested in tls-pins.test.ts.

test('body cap: the default is far above the largest real answer (PHIVOLCS 1.9 MB, 2026-11-16)', () => {
  assert.equal(MAX_BODY_BYTES, 32 * 1024 * 1024);
  assert.ok(MAX_BODY_BYTES > 10 * 1_877_164);
});

test('body cap: a fetched body past maxBytes is aborted, compressed or not; one under it reads as before', async () => {
  const text = 'Boğaziçi Üniversitesi\n';
  const server = createServer((req, res) => {
    if (req.url === '/big') {
      // Streamed in chunks, as a source that keeps sending would.
      res.writeHead(200, { 'content-type': 'text/plain' });
      let sent = 0;
      const tick = setInterval(() => {
        if (sent >= 5_000 || res.destroyed) {
          clearInterval(tick);
          res.end();
          return;
        }
        res.write('x'.repeat(500));
        sent += 500;
      }, 5);
      res.on('close', () => clearInterval(tick));
      return;
    }
    if (req.url === '/gzip') {
      // A few dozen bytes on the wire, 5,000 once inflated: the count is of the decoded bytes.
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.alloc(5_000, 0x61)));
      return;
    }
    if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('x'.repeat(5_000));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.repeat(10), 'utf8')]));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(getText(`${base}/big`, { retries: 0, maxBytes: 1_000 }), /body over 1000 bytes/);
    await assert.rejects(getText(`${base}/gzip`, { retries: 0, maxBytes: 1_000 }), /body over 1000 bytes/);
    assert.equal(await getText(`${base}/gzip`, { retries: 0, maxBytes: 5_000 }), 'a'.repeat(5_000), 'exactly the cap passes');
    assert.equal(await getText(`${base}/big`, { retries: 0 }), 'x'.repeat(5_000), 'the default cap lets a normal body through');
    // UTF-8 as res.text() decoded it: the BOM dropped, multi-byte characters intact.
    assert.equal(await getText(`${base}/ok`, { retries: 0, maxBytes: 1_000 }), text.repeat(10));
    // An error status is reported as before, its body not read.
    await assert.rejects(getText(`${base}/missing`, { retries: 0, maxBytes: 1_000 }), /^Error: HTTP 404$/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
