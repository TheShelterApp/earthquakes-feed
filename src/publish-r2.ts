import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, PUBLIC_DIR } from './config.js';
import { R2Publisher, cacheControlFor, contentTypeFor, type PutObject } from './r2.js';

/**
 * SD-E2: publish the feed artifacts to the R2 `data` origin (S3 API), idempotently. Runs after
 * sign-manifest in derive.yml. Uploads exactly what the signed v2 manifest advertises — its own
 * bytes, every summary and every partition (with the manifest's `frozen` flag driving immutable
 * caching) — plus the v1 manifest and status.json. skip-by-sha keeps each run to the changed set.
 *
 * Without R2 credentials it warns and exits 0 so the Pages pipeline keeps publishing during
 * rollout — the R2 origin is additive, never a gate.
 */
interface V2Manifest {
  summaries: Record<string, { path: string }>;
  partitions: Array<{ path: string; frozen: boolean }>;
  changes: { path: string } | null;
}

const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_BUCKET } = process.env;
if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.warn('::warning::R2 credentials not set — skipping R2 publish (Pages origin unaffected)');
  process.exit(0);
}
if (!R2_S3_ENDPOINT || !R2_BUCKET) {
  console.error('::error::R2_S3_ENDPOINT and R2_BUCKET are required to publish to R2');
  process.exit(1);
}

const publicDir = PUBLIC_DIR;
const v1Dir = join(publicDir, 'v1');

/** Decode the signed envelope's payload to learn which artifacts to publish and which are frozen. */
function readSignedManifest(): V2Manifest {
  const env = JSON.parse(readFileSync(join(publicDir, 'v2', 'manifest.json'), 'utf8')) as { payload: string };
  return JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8')) as V2Manifest;
}

/** Build the upload list: {key, localPath, frozen?}. A key mirrors the manifest `path`. */
function plan(manifest: V2Manifest): Array<{ key: string; local: string; frozen?: boolean }> {
  const items: Array<{ key: string; local: string; frozen?: boolean }> = [
    { key: 'v2/manifest.json', local: join(publicDir, 'v2', 'manifest.json') },
    { key: 'v1/manifest.json', local: join(v1Dir, 'manifest.json') },
    { key: 'v1/status.json', local: join(v1Dir, 'status.json') },
  ];
  for (const s of Object.values(manifest.summaries)) items.push({ key: s.path, local: join(publicDir, s.path) });
  for (const p of manifest.partitions) items.push({ key: p.path, local: join(DATA_DIR, p.path), frozen: p.frozen });
  if (manifest.changes) items.push({ key: manifest.changes.path, local: join(publicDir, manifest.changes.path) });
  return items;
}

async function main(): Promise<void> {
  const manifest = readSignedManifest();
  const publisher = new R2Publisher({ endpoint: R2_S3_ENDPOINT!, bucket: R2_BUCKET!, accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! });

  let put = 0;
  let skipped = 0;
  let missing = 0;
  for (const item of plan(manifest)) {
    if (!existsSync(item.local)) {
      // Old partitions live only in Releases/jsDelivr, not the checked-out tree — not an error.
      missing++;
      continue;
    }
    const body = new Uint8Array(readFileSync(item.local));
    const obj: PutObject = { key: item.key, body, contentType: contentTypeFor(item.key), cacheControl: cacheControlFor(item.key, { frozen: item.frozen }) };
    const outcome = await publisher.put(obj);
    if (outcome === 'put') put++;
    else skipped++;
  }
  console.log(`publish-r2: bucket=${R2_BUCKET} put=${put} skipped=${skipped} missing=${missing}`);
}

await main();
