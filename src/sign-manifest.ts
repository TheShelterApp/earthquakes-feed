import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Ed25519Signer, decodePkcs8 } from '@theshelter/signing';
import { DATA_DIR, PUBLIC_DIR, SCHEMA_DIR } from './config.js';
import { DEFAULT_KID, buildManifestV2, manifestV2Bytes, sha256Hex, signManifestV2, type ManifestV1, type TilesPointer } from './manifest-v2.js';

/**
 * Post-commit step of derive.yml: the v2 manifest pins every immutable URL to the data commit,
 * so it can only be built once that commit exists. Reads the v1 manifest derive wrote, hashes
 * the artifacts on disk, signs with the Actions secret and writes public/v2/manifest.json.
 *
 * Without FEED_SIGNING_KEY it warns and exits 0: the v1 pipeline must keep publishing while the
 * secret is being provisioned. Nothing here can affect v1 output.
 */
const key = process.env.FEED_SIGNING_KEY;
if (!key) {
  console.warn('::warning::FEED_SIGNING_KEY is not set — v2/manifest.json not written (v1 unaffected)');
  process.exit(0);
}
const dataCommit = process.env.DATA_COMMIT;
if (!dataCommit) {
  console.error('::error::DATA_COMMIT is required to sign the v2 manifest');
  process.exit(1);
}
const kid = process.env.FEED_SIGNING_KID ?? DEFAULT_KID;

const v1 = JSON.parse(readFileSync(join(PUBLIC_DIR, 'v1', 'manifest.json'), 'utf8')) as ManifestV1;
const tilesFile = process.env.TILES_POINTER;
const tiles: TilesPointer | null = tilesFile && existsSync(tilesFile) ? (JSON.parse(readFileSync(tilesFile, 'utf8')) as TilesPointer) : null;
if (tilesFile && !tiles) console.warn(`::warning::TILES_POINTER ${tilesFile} not found — tiles: null`);

const manifest = buildManifestV2({
  v1,
  dataCommit,
  tiles,
  // When R2 is the data origin (SD-E2) the manifest advertises it first; absent → Pages/mirrors only.
  ...(process.env.R2_PUBLIC_BASE ? { r2PublicBase: process.env.R2_PUBLIC_BASE } : {}),
  // partitions live in the data checkout, summaries only on Pages (public/)
  read: (path, kind) => new Uint8Array(readFileSync(join(kind === 'partition' ? DATA_DIR : PUBLIC_DIR, path))),
});

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, 'manifest-v2.schema.json'), 'utf8')) as object);
if (!validate(manifest)) {
  console.error(`::error::v2 manifest fails its schema: ${ajv.errorsText(validate.errors)}`);
  process.exit(1);
}

const signer = await Ed25519Signer.fromPkcs8(kid, 'feed', decodePkcs8(key));
const envelope = await signManifestV2(manifest, signer);
const outDir = join(PUBLIC_DIR, 'v2');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(envelope) + '\n');

const bytes = manifestV2Bytes(manifest);
console.log(
  `sign-manifest: v2/manifest.json kid=${kid} payload=${bytes.byteLength}B sha256=${sha256Hex(bytes).slice(0, 16)}… data_commit=${dataCommit.slice(0, 8)} partitions=${manifest.partitions.length} summaries=${Object.keys(manifest.summaries).length} tiles=${tiles ? tiles.version : 'none'}`,
);
