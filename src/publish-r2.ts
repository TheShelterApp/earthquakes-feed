import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, PUBLIC_DIR } from './config.js';
import { R2Publisher, cacheControlFor, contentTypeFor, r2Settings, type PutObject } from './r2.js';

/**
 * SD-E2: publish the feed artifacts to the R2 `data` origin (S3 API), idempotently. Runs after
 * sign-manifest in .github/actions/derive-publish. Uploads exactly what the signed v2 manifest advertises — its own
 * bytes, every summary and every partition (with the manifest's `frozen` flag driving immutable
 * caching) — plus the v1 manifest and status.json. skip-by-sha keeps each run to the changed set.
 *
 * The R2 origin is additive, never a gate (r2Settings): with every R2 setting blank, the publish is off on purpose and
 * says so in a plain log line (it printed a warning on every aggregate run, about 288 a day); with only some set, it
 * warns and exits 0. In .github/actions/derive-publish this step runs before the Pages deploy, so after a successful
 * publish the v2 manifest never advertises R2 objects not yet uploaded. A failure here is recorded there and fails the
 * job only after the Pages deploy (from 2026-09-06 to 09-17 an R2 error skipped 8 Pages deploys); that deploy's v2
 * manifest still names the `cdn` origin when R2_PUBLIC_BASE is set, so a reader finds a changed file there old or
 * missing by its sha256 and takes the next origin (`pages`). A skip with R2_PUBLIC_BASE set does the same.
 */
interface V2Manifest {
  summaries: Record<string, { path: string }>;
  partitions: Array<{ path: string; frozen: boolean }>;
  changes: { path: string } | null;
}

const settings = r2Settings(process.env);
if (settings.state === 'off') {
  console.log('R2 publish off: no R2 setting is set (the Pages origin is unaffected)');
  process.exit(0);
}
if (settings.state === 'incomplete') {
  console.log(`::warning::R2 settings incomplete (set: ${settings.set.join(', ')}; blank: ${settings.missing.join(', ')}) — skipping the R2 publish (the Pages origin is unaffected)`);
  process.exit(0);
}
const r2 = settings.config;

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
  const publisher = new R2Publisher(r2);

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
  console.log(`publish-r2: bucket=${r2.bucket} put=${put} skipped=${skipped} missing=${missing}`);
}

await main();
