import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// What `npm ci` installs, in every workflow job and locally (.npmrc; 2026-11-15 audit, FEED-SEC-2 and FEED-SEC-3).

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
interface LockEntry {
  integrity?: string;
  resolved?: string;
  hasInstallScript?: boolean;
  link?: boolean;
}
const lockPackages = (): [string, LockEntry][] =>
  Object.entries((JSON.parse(read('package-lock.json')) as { packages: Record<string, LockEntry> }).packages).filter(([k]) => k !== '');

// FEED-SEC-2: the GitLab registry publishes only a sha1 shasum for @theshelter/signing, so that is the one entry npm
// can pin with sha1; every other entry is sha512. The sha1 is the tarball's known shasum (.npmrc says how to check it),
// and a hand re-pin to sha512 is accepted.
test('package-lock: every integrity is sha512, except the documented sha1 of the GitLab-hosted @theshelter/signing', () => {
  const SIGNING = 'node_modules/@theshelter/signing';
  const SIGNING_SHA1 = 'sha1-gx4Mql1W6GETPCM+KNgYAzmZG/M=';
  let pinned = 0;
  for (const [key, entry] of lockPackages()) {
    if (entry.link || entry.integrity === undefined) continue;
    pinned++;
    if (key === SIGNING && entry.integrity === SIGNING_SHA1) {
      assert.match(entry.resolved ?? '', /^https:\/\/gitlab\.com\/api\/v4\/projects\/86141814\/packages\/npm\/@theshelter\/signing\/-\/@theshelter\/signing-0\.1\.0\.tgz$/);
      continue;
    }
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, `${key}: ${entry.integrity}`);
  }
  assert.ok(pinned > 10);
  assert.equal(Buffer.from(SIGNING_SHA1.slice(5), 'base64').toString('hex'), '831e0caa5d56e861133c233e28d8180339991bf3');
  assert.match(read('.npmrc'), /831e0caa5d56e861133c233e28d8180339991bf3/, '.npmrc names the sha1 to check');
});

// FEED-SEC-3: no dependency's install script runs, in CI (whose jobs later hold the Cloudflare, R2 and signing secrets)
// or locally. A new package with an install script must be looked at: does it work without it?
test('.npmrc: install scripts off; only the reviewed packages have one; the root package has no pre/post scripts', () => {
  assert.match(read('.npmrc'), /^ignore-scripts=true$/m);
  const withScript = lockPackages().filter(([, e]) => e.hasInstallScript).map(([k]) => k).sort();
  assert.deepEqual(withScript, ['node_modules/esbuild', 'node_modules/fsevents', 'node_modules/workerd']);
  // `npm run x` and `npm test` still run x with ignore-scripts, but never prex/postx (nor prepare/install hooks).
  const scripts = Object.keys((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts);
  const hooks = scripts.filter((s) => /^(pre|post)/.test(s) || ['install', 'prepare', 'prepublish', 'prepack', 'postpack'].includes(s));
  assert.deepEqual(hooks, [], 'a lifecycle script would be skipped silently');
});
