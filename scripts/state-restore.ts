/**
 * Restore the state store from a daily backup (storage phase 3; APIs.md "Repository size", restore runbook). Only for
 * a store that lost blobs or was corrupted, never as a routine rollback: a restored generation is older than the
 * cursors git holds, so the generation commit that follows bumps SWEEP_EPOCH (a 7-day sweep catch-up re-asks the
 * sources for what changed since).
 *
 *   gh release download state-2026-11 -R TheShelterApp/earthquakes-feed -p state-2026-11-20.tar.zst
 *   npx tsx scripts/state-restore.ts state-2026-11-20.tar.zst --out restored/      # verify, unpack (cas/… + the cursors)
 *   FEED_STATE_BACKEND=fs:<dir> npx tsx scripts/state-restore.ts <asset> --put     # PUT every blob through the backend
 *   npx tsx scripts/state-restore.ts <asset> --data-dir .data                      # write its generation.json there
 *
 * The archive is verified first (every blob the generation names, its sha256 and size). `--put` with
 * FEED_STATE_BACKEND=worker works only from a workflow the Worker allows to write: on staging, state-rehearsal.yml (the
 * rehearsal of a restore); production's bucket is filled by the owner from `--out`'s cas/ directory with their own
 * Cloudflare credentials (`rclone copy restored/cas r2:earthquakes-feed-state/cas`), or through the Worker by an
 * allow-listed workflow. Then, under the writer lock (README "Writer group"), the generation is committed by hand:
 * `--data-dir` writes it into a fresh checkout of `data`, with SWEEP_EPOCH bumped in src/config.ts on main first.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataPaths } from '../src/config.js';
import { decompressBackup, readTar, verifyBackup } from '../src/state-backup.js';
import { backendFromEnv, casKey } from '../src/state-store.js';

async function main(argv: string[]): Promise<number> {
  const asset = argv[0];
  if (!asset || asset.startsWith('--')) {
    console.error('usage: state-restore.ts <state-YYYY-MM-DD.tar.zst> [--out <dir>] [--put] [--data-dir <dir>]');
    return 3;
  }
  const arg = (name: string): string | null => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? null) : null);
  const members = readTar(decompressBackup(readFileSync(asset)));
  const { generation, commit } = verifyBackup(members);
  const days = Object.keys(generation.days).sort();
  console.log(`restore: ${asset} verified: data commit ${commit}, generation at seq ${generation.head_seq}, ${days.length} day(s) ${days[0] ?? ''} … ${days.at(-1) ?? ''}`);
  const out = arg('--out');
  if (out) {
    for (const [name, bytes] of members) {
      const f = join(out, ...name.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, bytes);
    }
    console.log(`restore: ${members.size} member(s) written under ${out}`);
  }
  if (argv.includes('--put')) {
    const backend = backendFromEnv();
    if (!backend) {
      console.error('restore: --put needs FEED_STATE_BACKEND');
      return 3;
    }
    for (const e of Object.values(generation.days)) await backend.put(e.blob, members.get(casKey(e.blob))!);
    console.log(`restore: ${days.length} blob(s) PUT to ${backend.label}`);
  }
  const dataDir = arg('--data-dir');
  if (dataDir) {
    writeFileSync(dataPaths(dataDir).generation, members.get('generation.json')!);
    console.log(`restore: ${dataPaths(dataDir).generation} written; commit it under the writer lock with SWEEP_EPOCH bumped (APIs.md, restore runbook)`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`restore: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
