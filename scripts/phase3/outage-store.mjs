// A stand-in state Worker that is down, for scripts/phase3/dryrun.sh --outage (APIs.md "Outage budget"): it listens on
// 127.0.0.1 only, mints a JWT-shaped token on /token (the GitHub OIDC endpoint's shape: {"value": "<a>.<b>.<c>"}, an
// hour's `exp`), so the real WorkerBackend gets past its token and meets the outage at the store itself, and answers
// every store request as `mode` says:
//   502          Cloudflare's bad gateway, an HTML body (retried by the client as any 5xx);
//   unavailable  503 {"error":"unavailable"} with Retry-After 30 (the Worker without GitHub's signing keys; the client
//                waits at most 3 s, KEYS_UNAVAILABLE_WAIT_MS);
//   hang         never answers (each attempt ends at its timeout; the step's deadline ends the retries).
// It never writes anything: a run that met it must have changed nothing in the real store.
//
//   node scripts/phase3/outage-store.mjs <mode> <port-file> <request-log>
// The port goes to <port-file> once it listens; one line per request to <request-log>. Stop it with a signal.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [mode, portFile, requestLog] = process.argv.slice(2);
if (!['502', 'unavailable', 'hang'].includes(mode ?? '') || !portFile || !requestLog) {
  console.error('usage: outage-store.mjs 502|unavailable|hang <port-file> <request-log>');
  process.exit(3);
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const server = createServer((req, res) => {
  appendFileSync(requestLog, `${new Date().toISOString()} ${req.method} ${req.url}\n`);
  if (req.url?.startsWith('/token')) {
    const token = `${b64({ alg: 'none' })}.${b64({ aud: 'earthquakes-feed-state', exp: Math.floor(Date.now() / 1000) + 3600 })}.dryrun`;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value: token }));
    return;
  }
  req.resume();
  if (mode === 'hang') return;
  if (mode === '502') res.writeHead(502, { 'content-type': 'text/html' }).end('<html><body>502 Bad Gateway (dry run)</body></html>');
  else res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' }).end('{"error":"unavailable"}');
});
server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => process.exit(0));
