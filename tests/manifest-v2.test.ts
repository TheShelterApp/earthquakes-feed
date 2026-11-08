import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { decodeRawPublicKey, generateEd25519, generateEd25519KeyMaterial, jcsBytes, toBase64 } from '@theshelter/signing';
import {
  DEFAULT_KID,
  FEED_PUBLIC_KEYS,
  RETIRED_FEED_KIDS,
  buildManifestV2,
  envelopeKeyCheck,
  manifestV2Bytes,
  sha256Hex,
  signManifestV2,
  verifyManifestV2,
  type ManifestV1,
} from '../src/manifest-v2.js';

const COMMIT = '9c1e0d3b5e5f4b0c8f6d1c1d0a2b3c4d5e6f7a8b';
const v1 = (): ManifestV1 => ({
  schema_version: 1,
  generated: 1_757_066_520_000,
  generated_iso: '2025-09-05T10:02:00.000Z',
  head_seq: 8_812_345,
  event_count: 4871,
  freshness: { expected_interval_seconds: 300, stale_after_seconds: 1800 },
  data_repo: 'TheShelterApp/earthquakes-feed',
  jsdelivr_base: 'https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data',
  data_commit: null,
  summaries: {
    all_week: { path: 'v1/all_week.geojson', url: 'https://earthquakes-feed.theshelter.app/v1/all_week.geojson', count: 4871 },
    '4.5_day': { path: 'v1/4.5_day.geojson', url: 'https://earthquakes-feed.theshelter.app/v1/4.5_day.geojson', count: 12 },
  },
  partitions: [
    { date: '2025-09-04', path: 'events/2025/09/04.ndjson', url: 'https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/events/2025/09/04.ndjson', pages_url: 'https://earthquakes-feed.theshelter.app/v1/events/2025-09-04.geojson', count: 690, bytes: 298_001, min_mag: 0.4, max_mag: 5.1, frozen: false },
    { date: '2025-08-01', path: 'events/2025/08/01.ndjson', url: 'https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/events/2025/08/01.ndjson', count: 701, bytes: 301_220, min_mag: null, max_mag: null, frozen: true },
  ],
  archives: [{ period: '2025-07', tag: 'events-2025-07' }],
});
const files: Record<string, string> = {
  'v1/all_week.geojson': '{"type":"FeatureCollection","features":[]}',
  'v1/4.5_day.geojson': '{"type":"FeatureCollection","features":[1]}',
  'events/2025/09/04.ndjson': '{"a":1}\n',
  'events/2025/08/01.ndjson': '{"b":2}\n',
};
const read = (path: string): Uint8Array => {
  const body = files[path];
  if (body === undefined) throw new Error(`missing ${path}`);
  return new TextEncoder().encode(body);
};
const build = (over: Partial<Parameters<typeof buildManifestV2>[0]> = {}) => buildManifestV2({ v1: v1(), dataCommit: COMMIT, read, ...over });

test('v2 carries v1 forward and adds origins, sha256s, expires, status_url, tiles', () => {
  const m = build({ tiles: { version: '1.0.0', url: 'https://github.com/TheShelterApp/region-tiles/releases/download/bundle-v1/regions.sqlite.gz', sizeBytes: 40_337_310, sha256: 'f'.repeat(64) } });
  assert.equal(m.schema_version, 2);
  assert.equal(m.generated, 1_757_066_520_000);
  assert.equal(m.expires, 1_757_066_520_000 + 1800 * 1000);
  assert.deepEqual(m.freshness, { expected_interval_seconds: 300, stale_after_seconds: 1800, offline_after_seconds: 3600 });
  assert.equal(m.data_commit, COMMIT);
  assert.deepEqual(
    m.origins.map((o) => o.id),
    ['pages', 'jsdelivr-sha', 'raw-sha', 'raw-data', 'release'],
  );
  assert.equal(m.origins[1]!.base, `https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@${COMMIT}/`);
  assert.equal(m.origins[3]!.mutable_only, true);
  assert.equal(m.status_url, 'https://earthquakes-feed.theshelter.app/v1/status.json');
  assert.equal(m.summaries['all_week']!.sha256, sha256Hex(read('v1/all_week.geojson')));
  assert.equal(m.summaries['all_week']!.bytes, files['v1/all_week.geojson']!.length);
  assert.equal(m.partitions[0]!.sha256, sha256Hex(read('events/2025/09/04.ndjson')));
  assert.equal(m.partitions[0]!.bytes, 8);
  assert.equal(m.partitions[1]!.frozen, true, 'frozen = immutable flag carried through');
  assert.equal(m.tiles?.version, '1.0.0');
  assert.deepEqual(m.archives, [{ period: '2025-07', tag: 'events-2025-07' }]);
  assert.equal(build().tiles, null, 'no pointer → tiles: null, never omitted');
  assert.equal(build({ offlineAfterSeconds: 7200 }).freshness.offline_after_seconds, 7200);
});

test('advertises the R2 cdn origin first when r2PublicBase is set', () => {
  const m = build({ r2PublicBase: 'https://data-staging.theshelter.app' });
  assert.deepEqual(m.origins.map((o) => o.id), ['cdn', 'pages', 'jsdelivr-sha', 'raw-sha', 'raw-data', 'release']);
  assert.equal(m.origins[0]!.base, 'https://data-staging.theshelter.app/');
  assert.equal(build().origins[0]!.id, 'pages', 'no r2PublicBase → no cdn origin');
});

test('payload bytes are reproducible across runs and independent of input key order', () => {
  const a = manifestV2Bytes(build());
  const b = manifestV2Bytes(build());
  assert.deepEqual(a, b);
  const shuffled = v1();
  const { partitions, summaries, ...rest } = shuffled;
  const reordered = { ...Object.fromEntries(Object.entries(rest).reverse()), summaries: Object.fromEntries(Object.entries(summaries).reverse()), partitions } as ManifestV1;
  assert.deepEqual(manifestV2Bytes(buildManifestV2({ v1: reordered, dataCommit: COMMIT, read })), a);
  const text = new TextDecoder().decode(a);
  assert.ok(text.startsWith('{"archives":['), 'RFC 8785: keys sorted, no whitespace');
  assert.equal(text.includes(' '), false);
});

test('signs with Ed25519 and verifies; a tampered payload or signature is rejected', async () => {
  const { signer, verifier } = await generateEd25519('feed-2026a', 'feed');
  const m = build();
  const env = await signManifestV2(m, signer);
  assert.equal(env.kid, 'feed-2026a');
  assert.deepEqual(await verifyManifestV2(env, verifier), m);
  const tampered = { ...env, payload: toBase64(jcsBytes({ ...m, data_commit: 'a'.repeat(40) })) };
  await assert.rejects(verifyManifestV2(tampered, verifier), (e: { code?: string }) => e.code === 'BadSignature');
  const other = await generateEd25519('feed-2026b', 'feed');
  await assert.rejects(verifyManifestV2(env, other.verifier), (e: { code?: string }) => e.code === 'UnknownKid');
});

test('carries the SD-E3 changes ref when provided; null otherwise', () => {
  const bytes = new TextEncoder().encode('{"id":"efd_1","seq":8809002}\n{"id":"efd_2","seq":8812345}\n');
  const m = build({ changes: { path: 'v1/changes/2026-09-05.ndjson', bytes } });
  assert.equal(m.changes?.path, 'v1/changes/2026-09-05.ndjson');
  assert.equal(m.changes?.firstSeq, 8809002);
  assert.equal(m.changes?.lastSeq, 8812345);
  assert.equal(m.changes?.size, bytes.byteLength);
  assert.match(m.changes!.sha256, /^[0-9a-f]{64}$/);
  assert.equal(build().changes, null, 'no changes input → changes: null');
});

test('the payload validates against schema/manifest-v2.schema.json; a bad data_commit does not', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync('schema/manifest-v2.schema.json', 'utf8')) as object);
  assert.equal(validate(build()), true, ajv.errorsText(validate.errors));
  assert.equal(validate(build({ tiles: { version: '1.0.0', url: 'https://x/y.gz', sizeBytes: 1, sha256: 'a'.repeat(64) } })), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...build(), data_commit: 'short' }), false);
  assert.throws(() => build({ dataCommit: 'HEAD' }), /full git sha/);
});

test('a missing artifact fails the build instead of signing a manifest that lies', () => {
  assert.throws(() => build({ read: (p) => (p.endsWith('01.ndjson') ? read('events/2025/09/04.ndjson') : (() => { throw new Error(`missing ${p}`); })()) }), /missing/);
});

// ---- Signing kid and the published keys (stream C3) ----

test('DEFAULT_KID is the current signer and every published key is a raw 32-byte Ed25519 key', () => {
  assert.equal(DEFAULT_KID, 'feed-2026c');
  assert.ok(DEFAULT_KID in FEED_PUBLIC_KEYS);
  for (const [kid, b64] of Object.entries(FEED_PUBLIC_KEYS)) assert.equal(decodeRawPublicKey(b64).byteLength, 32, kid);
  for (const kid of RETIRED_FEED_KIDS) assert.ok(!(kid in FEED_PUBLIC_KEYS), `${kid} is retired`);
});

test('envelopeKeyCheck: ok under its own key, mismatch under a foreign key of the same kid, unknown-kid otherwise', async () => {
  const mine = await generateEd25519('feed-test', 'feed');
  const other = await generateEd25519('feed-test', 'feed');
  const env = await signManifestV2(buildManifestV2({ v1: v1(), dataCommit: COMMIT, read }), mine.signer);
  assert.equal(await envelopeKeyCheck(env, { 'feed-test': toBase64(mine.rawPublicKey) }), 'ok');
  assert.equal(await envelopeKeyCheck(env, { 'feed-test': toBase64(other.rawPublicKey) }), 'mismatch');
  assert.equal(await envelopeKeyCheck(env, { 'feed-other': toBase64(mine.rawPublicKey) }), 'unknown-kid');
  assert.equal(await envelopeKeyCheck(env), 'unknown-kid', 'the default keyring knows only the feed kids');
  assert.equal(await envelopeKeyCheck({ ...env, sig: env.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }, { 'feed-test': toBase64(mine.rawPublicKey) }), 'mismatch');
  assert.equal(await envelopeKeyCheck({ ...env, sig: 'not base64!' }, { 'feed-test': toBase64(mine.rawPublicKey) }), 'mismatch');
});

test('doc drift: the APIs.md signing-key table matches FEED_PUBLIC_KEYS and marks every retired kid', () => {
  const doc = readFileSync(new URL('../APIs.md', import.meta.url), 'utf8');
  const rows = [...doc.matchAll(/^\| `(feed-[0-9a-z]+)` \| `([A-Za-z0-9+/=]+)` \| (.+) \|$/gm)].map((m) => ({ kid: m[1]!, key: m[2]!, status: m[3]! }));
  assert.ok(rows.length >= 3, 'the table is found');
  const live = Object.fromEntries(rows.filter((r) => !/retired/i.test(r.status)).map((r) => [r.kid, r.key]));
  assert.deepEqual(live, { ...FEED_PUBLIC_KEYS });
  for (const kid of RETIRED_FEED_KIDS) {
    const row = rows.find((r) => r.kid === kid);
    assert.ok(row && /retired/i.test(row.status), `${kid} is listed as retired`);
  }
  assert.match(doc, /"kid": "feed-2026c"/);
});

test('sign-manifest: a key that is not the published key of its kid writes no v2 manifest and sets v2_failed; an unknown kid warns and writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sign-manifest-'));
  const pub = join(root, 'public');
  const data = join(root, 'data');
  mkdirSync(join(pub, 'v1'), { recursive: true });
  mkdirSync(data);
  const m = { ...v1(), summaries: {}, partitions: [] };
  writeFileSync(join(pub, 'v1', 'manifest.json'), JSON.stringify(m));
  // A throwaway test key: it is no feed key, so under kid feed-2026c it must be refused.
  const material = await generateEd25519KeyMaterial('feed-test');
  const run = (kid: string) => {
    const out = join(root, `out-${kid || 'empty'}`);
    writeFileSync(out, '');
    rmSync(join(pub, 'v2'), { recursive: true, force: true });
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/sign-manifest.ts'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, FEED_SIGNING_KEY: material.privateKeyPkcs8Base64, FEED_SIGNING_KID: kid, DATA_COMMIT: COMMIT, DATA_DIR: data, PUBLIC_DIR: pub, GITHUB_OUTPUT: out, TILES_POINTER: '', R2_PUBLIC_BASE: '' },
      encoding: 'utf8',
    });
    return { status: r.status, log: r.stdout + r.stderr, output: readFileSync(out, 'utf8'), written: existsSync(join(pub, 'v2', 'manifest.json')) };
  };
  for (const kid of ['feed-2026c', '']) {
    const r = run(kid);
    assert.equal(r.status, 0, r.log);
    assert.equal(r.written, false, `${kid || 'empty → DEFAULT_KID'}: no v2 manifest`);
    assert.equal(r.output, 'v2_failed=1\n');
    assert.match(r.log, /::error::v2 manifest signature does not verify under the published key of kid=feed-2026c/);
    assert.ok(!r.log.includes(material.privateKeyPkcs8Base64), 'no key material in the log');
  }
  const u = run('feed-test');
  assert.equal(u.status, 0, u.log);
  assert.equal(u.written, true);
  assert.equal(u.output, '');
  assert.match(u.log, /::warning::kid=feed-test has no published public key/);
  assert.match(u.log, /sign-manifest: v2\/manifest\.json kid=feed-test key=unknown-kid /);
});
