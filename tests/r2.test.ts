import assert from 'node:assert/strict';
import { test } from 'node:test';
import { R2Publisher, cacheControlFor, contentTypeFor, sha256Hex, type R2Config } from '../src/r2.js';

/** An in-memory S3 endpoint: records every request, answers HEAD/PUT like R2's S3 API. */
function fakeS3() {
  const store = new Map<string, { body: Uint8Array; headers: Record<string, string> }>();
  const seen: Array<{ method: string; url: string; auth: string | null; headers: Headers }> = [];
  const fetchLike: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const key = url.pathname.replace(/^\/[^/]+\//, ''); // strip /<bucket>/
    seen.push({ method: req.method, url: req.url, auth: req.headers.get('authorization'), headers: req.headers });
    if (req.method === 'HEAD') {
      const e = store.get(key);
      if (!e) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: e.headers });
    }
    if (req.method === 'PUT') {
      const body = new Uint8Array(await req.arrayBuffer());
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      store.set(key, { body, headers });
      return new Response(null, { status: 200, headers: { etag: '"fakemd5"' } });
    }
    return new Response('no', { status: 400 });
  };
  return { store, seen, fetch: fetchLike };
}

const cfg = (fetchLike: typeof fetch): R2Config => ({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'shelter-data-staging', accessKeyId: 'AKIATEST', secretAccessKey: 'secret', fetch: fetchLike });

test('signs every request with SigV4 for s3 and uses path-style keys', async () => {
  const s3 = fakeS3();
  await new R2Publisher(cfg(s3.fetch)).put({ key: 'v2/manifest.json', body: new TextEncoder().encode('{}'), contentType: 'application/json', cacheControl: 'public, max-age=0' });
  for (const r of s3.seen) {
    assert.match(r.auth ?? '', /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/auto\/s3\/aws4_request/);
    assert.ok(new URL(r.url).pathname.startsWith('/shelter-data-staging/'), 'path-style');
  }
});

test('stores the identity sha in metadata and Cache-Control/Content-Type; ACAO:*', async () => {
  const s3 = fakeS3();
  const body = new TextEncoder().encode('{"type":"FeatureCollection"}');
  await new R2Publisher(cfg(s3.fetch)).put({ key: 'v1/all_week.geojson', body, contentType: contentTypeFor('v1/all_week.geojson'), cacheControl: cacheControlFor('v1/all_week.geojson') });
  const put = s3.store.get('v1/all_week.geojson')!;
  assert.equal(put.headers['x-amz-meta-sha256'], sha256Hex(body));
  assert.equal(put.headers['content-type'], 'application/geo+json');
  assert.equal(put.headers['cache-control'], 'public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400');
  assert.equal(put.headers['access-control-allow-origin'], '*');
});

test('skip-by-sha: unchanged bytes HEAD-match and are not re-PUT; changed bytes are', async () => {
  const s3 = fakeS3();
  const pub = new R2Publisher(cfg(s3.fetch));
  const body = new TextEncoder().encode('one');
  assert.equal(await pub.put({ key: 'events/2026/09/06.ndjson', body, contentType: 'application/x-ndjson', cacheControl: 'x' }), 'put');
  assert.equal(await pub.put({ key: 'events/2026/09/06.ndjson', body, contentType: 'application/x-ndjson', cacheControl: 'x' }), 'skipped');
  const puts = s3.seen.filter((r) => r.method === 'PUT');
  assert.equal(puts.length, 1, 'only the first PUT happened');
  assert.equal(await pub.put({ key: 'events/2026/09/06.ndjson', body: new TextEncoder().encode('two'), contentType: 'application/x-ndjson', cacheControl: 'x' }), 'put');
});

test('cacheControlFor: immutable for frozen partitions, short for the rest', () => {
  assert.equal(cacheControlFor('events/2025/01/01.ndjson', { frozen: true }), 'public, max-age=31536000, immutable');
  assert.match(cacheControlFor('events/2026/09/06.ndjson', { frozen: false }), /max-age=0, s-maxage=60/);
  assert.match(cacheControlFor('v2/manifest.json'), /max-age=0, s-maxage=60, stale-while-revalidate=300/);
  assert.match(cacheControlFor('v1/status.json'), /stale-while-revalidate=120/);
});
