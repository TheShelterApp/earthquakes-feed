import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_DIR } from './config.js';
import { pinManifestV1, type ManifestV1 } from './manifest-v2.js';

/**
 * Post-commit step of derive-publish ("Pin manifest to the data commit"): the published v1 manifest
 * (PUBLIC_DIR/v1/manifest.json) gets `data_commit` and, for every frozen day, the immutable jsDelivr
 * `@<data_commit>` url instead of `@data` (pinManifestV1), as the signed v2 manifest has. The copy on the
 * `data` branch keeps `data_commit: null` and `@data`: it cannot name the commit it is part of.
 */
const dataCommit = process.env.DATA_COMMIT ?? '';
const file = join(PUBLIC_DIR, 'v1', 'manifest.json');
const v1 = JSON.parse(readFileSync(file, 'utf8')) as ManifestV1;
const pinned = pinManifestV1(v1, dataCommit);
writeFileSync(file, JSON.stringify(pinned, null, 2));
const moved = pinned.partitions.filter((p, i) => p.url !== v1.partitions[i]!.url).length;
console.log(`data_commit=${dataCommit.slice(0, 8)}; ${moved} frozen partition url(s) pinned to it`);
