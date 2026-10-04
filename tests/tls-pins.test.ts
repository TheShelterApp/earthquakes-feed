import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { getText, pinnedCa } from '../src/custom.js';
import { loadRegistry } from '../src/providers.js';

// FEED-SEC-1: TMD and PHIVOLCS serve their leaf certificate without the intermediate. The feed fetched them with TLS
// verification off; now the registry pins the missing intermediate (providers/tls) and verification stays on.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registryPath = here('../providers/registry.json');
const registry = loadRegistry(registryPath);
const roots = rootCertificates.map((pem) => new X509Certificate(pem));

test('tls pins: TMD and PHIVOLCS name their intermediates, and no other source needs one', () => {
  const pinned = registry.filter((p) => p.tlsIntermediates?.length).map((p) => p.id).sort();
  assert.deepEqual(pinned, ['phivolcs', 'tmd']);
});

test('tls pins: each pinned file is a CA certificate issued and signed by a root in Node\'s store, and still valid', () => {
  for (const p of registry.filter((x) => x.tlsIntermediates?.length)) {
    const pems = pinnedCa(p, registryPath);
    assert.equal(pems.length, p.tlsIntermediates!.length, p.id);
    for (const pem of pems) {
      const cert = new X509Certificate(pem);
      assert.equal(cert.ca, true, `${p.id}: ${cert.subject} is a CA certificate`);
      const root = roots.find((r) => cert.checkIssued(r) && cert.verify(r.publicKey));
      assert.ok(root, `${p.id}: ${cert.subject} chains to a root Node trusts`);
      assert.ok(Date.parse(cert.validTo) > Date.now(), `${p.id}: ${cert.subject} expired ${cert.validTo}`);
    }
  }
});

test('tls pins: no adapter turns certificate verification off', () => {
  const src = readFileSync(here('../src/custom.ts'), 'utf8');
  assert.doesNotMatch(src, /rejectUnauthorized\s*:\s*false/);
  assert.doesNotMatch(src, /insecure\s*:\s*true/);
  assert.doesNotMatch(src, /NODE_TLS_REJECT_UNAUTHORIZED/);
});

/** A throwaway root → intermediate → leaf for localhost, made with the openssl CLI (null when it is not installed). */
function makeChain(): { dir: string; root: string; int: string; leafKey: string; leaf: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'tls-pins-'));
  const cfg = join(dir, 'openssl.cnf');
  writeFileSync(
    cfg,
    [
      '[req]', 'distinguished_name=dn', '[dn]',
      '[v3_ca]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash',
      '[v3_int]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid',
      '[v3_leaf]', 'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', 'subjectAltName=DNS:localhost', 'authorityKeyIdentifier=keyid',
    ].join('\n') + '\n',
  );
  const ossl = (...args: string[]): void => {
    execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  };
  try {
    ossl('req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.crt', '-days', '2', '-subj', '/CN=Feed Test Root', '-config', cfg, '-extensions', 'v3_ca');
    ossl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'int.key', '-out', 'int.csr', '-subj', '/CN=Feed Test Intermediate', '-config', cfg);
    ossl('x509', '-req', '-in', 'int.csr', '-CA', 'root.crt', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'int.crt', '-days', '2', '-extfile', cfg, '-extensions', 'v3_int');
    ossl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost', '-config', cfg);
    ossl('x509', '-req', '-in', 'leaf.csr', '-CA', 'int.crt', '-CAkey', 'int.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '2', '-extfile', cfg, '-extensions', 'v3_leaf');
  } catch {
    return null;
  }
  const read = (f: string): string => readFileSync(join(dir, f), 'utf8');
  return { dir, root: read('root.crt'), int: read('int.crt'), leafKey: read('leaf.key'), leaf: read('leaf.crt') };
}

test('pinned fetch: a leaf-only server verifies with the pinned intermediate, fails without it, and a trickle hits the deadline', async (t) => {
  const chain = makeChain();
  if (!chain) {
    t.skip('openssl CLI not available');
    return;
  }
  // The server sends its leaf only, like TMD and PHIVOLCS.
  const server = createServer({ key: chain.leafKey, cert: chain.leaf }, (req, res) => {
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const tick = setInterval(() => res.write('.'), 100);
      res.on('close', () => clearInterval(tick));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"events":[]}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    // The test root stands in for a root in Node's store; the intermediate is the pin.
    assert.equal(await getText(`https://localhost:${port}/ok`, { ca: [chain.int, chain.root], retries: 0, timeoutMs: 5_000 }), '{"events":[]}');
    await assert.rejects(getText(`https://localhost:${port}/ok`, { ca: [chain.root], retries: 0, timeoutMs: 5_000 }), (e: Error & { code?: string }) => e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    // Host-name checks stay on: the leaf names localhost only.
    await assert.rejects(getText(`https://127.0.0.1:${port}/ok`, { ca: [chain.int, chain.root], retries: 0, timeoutMs: 5_000 }), (e: Error & { code?: string }) => e.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
    // A server that keeps the socket busy without finishing: the idle timeout never fires, the deadline does.
    const t0 = Date.now();
    await assert.rejects(getText(`https://localhost:${port}/slow`, { ca: [chain.int, chain.root], retries: 0, timeoutMs: 600 }), /timeout/);
    assert.ok(Date.now() - t0 < 3_000, `the request ended at its deadline (${Date.now() - t0} ms)`);
    // The call's own deadline bounds the retries too.
    const t1 = Date.now();
    await assert.rejects(getText(`https://localhost:${port}/slow`, { ca: [chain.int, chain.root], retries: 5, timeoutMs: 600, deadlineMs: 1_500 }), /deadline|timeout/);
    assert.ok(Date.now() - t1 < 3_000, `retries stop at the call deadline (${Date.now() - t1} ms)`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
