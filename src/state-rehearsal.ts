import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveEventMap } from './bitemporal.js';
import { dataPaths } from './config.js';
import { hydrate, persist, readGeneration } from './event-map-store.js';
import { collect, GC_MIN_AGE_DAYS } from './state-gc.js';
import { backupMembers, compressBackup, decompressBackup, readTar, verifyBackup, writeTar } from './state-backup.js';
import { backendFromEnv, casKey, getBlobs, type StateBackend } from './state-store.js';
import type { EventNode } from './types.js';

/**
 * The state store's rehearsal (state-rehearsal.yml, dispatched by hand from any branch; storage phase 3). It runs the
 * client's whole path against the STAGING Worker and bucket (feed-state-staging.theshelter.app, audience
 * earthquakes-feed-state-staging, which admits any branch of this repository) on synthetic data only: staging never
 * reads production's state. A temporary data root with a synthetic event map of REHEARSAL_DAYS days (feed ids unique
 * to the run, so every blob is new) is persisted, shadow-hydrated (no mismatch), changed and persisted again (one
 * upload), hydrated authoritatively into a second root (the same bytes), restored from a backup archive of its
 * generation (scripts/state-restore.ts's path), then GC runs as a dry run with the current generation as its keep set,
 * and the budget is read. Any failure exits 1.
 *
 *   FEED_STATE_BACKEND=worker FEED_STATE_URL=https://feed-state-staging.theshelter.app \
 *   FEED_STATE_AUDIENCE=earthquakes-feed-state-staging npx --no-install tsx src/state-rehearsal.ts
 */

export const REHEARSAL_DAYS = 3;
const DAY_MS = 86_400_000;

function syntheticNode(run: string, i: number, eventTimeMs: number, lastSeq: number): EventNode {
  const iso = new Date(eventTimeMs).toISOString();
  return {
    feedId: `efd_rehearsal_${run}_${String(i).padStart(4, '0')}`,
    aliases: [`rehearsal:${run}:${i}`],
    eventTimeMs,
    firstIngestTime: iso,
    lastIngestTime: iso,
    lat: (i % 160) - 80,
    lon: ((i * 37) % 360) - 180,
    depth: 10,
    mag: 3 + (i % 30) / 10,
    magType: 'ml',
    status: 'automatic',
    place: 'synthetic rehearsal event',
    chosenProvider: 'rehearsal',
    provenance: [],
    revision: 1,
    firstSeenSeq: lastSeq,
    lastSeq,
    state: 'live',
    geohash: 'rehearsal',
  };
}

export async function rehearse(backend: StateBackend, opts: { nowMs?: number; log?: (l: string) => void; nodesPerDay?: number } = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const nowMs = opts.nowMs ?? Date.now();
  const run = randomUUID().slice(0, 8);
  const steps: string[] = [];
  const step = (s: string): void => {
    steps.push(s);
    log(`rehearsal: ${s}`);
  };
  const a = mkdtempSync(join(tmpdir(), 'state-rehearsal-a-'));
  const b = mkdtempSync(join(tmpdir(), 'state-rehearsal-b-'));
  try {
    for (const r of [a, b]) {
      mkdirSync(dataPaths(r).indexDir, { recursive: true });
      writeFileSync(dataPaths(r).head, JSON.stringify({ seq: 1, ingest_time: new Date(nowMs).toISOString() }) + '\n');
    }
    const map = new Map<string, EventNode>();
    const perDay = opts.nodesPerDay ?? 200;
    for (let d = 0; d < REHEARSAL_DAYS; d++) {
      for (let i = 0; i < perDay; i++) {
        const n = syntheticNode(run, d * perDay + i, nowMs - (d + 0.5) * DAY_MS + i * 1000, 1);
        map.set(n.feedId, n);
      }
    }
    saveEventMap(a, map);
    const cutoffDay = new Date(nowMs - 45 * DAY_MS).toISOString().slice(0, 10);
    const p1 = await persist(a, backend, { cutoffDay });
    if (p1.uploaded.length !== REHEARSAL_DAYS) throw new Error(`persist uploaded ${p1.uploaded.length} day(s), expected ${REHEARSAL_DAYS}`);
    step(`persist: ${p1.uploaded.length} day blob(s) uploaded (${(p1.uploadedBytes / 1e3).toFixed(0)} kB)`);
    const h1 = await hydrate(a, backend, { mode: 'shadow' });
    if (h1.mismatches.length || h1.days !== REHEARSAL_DAYS) throw new Error(`shadow hydrate: ${h1.days} day(s), mismatches ${h1.mismatches.join('; ')}`);
    step(`shadow hydrate: ${h1.days} day(s) fetched and verified, identical to the checkout`);
    writeFileSync(dataPaths(a).head, JSON.stringify({ seq: 2, ingest_time: new Date(nowMs).toISOString() }) + '\n');
    const first = map.values().next().value!;
    map.set(first.feedId, { ...first, lastSeq: 2, place: 'revised synthetic rehearsal event' });
    saveEventMap(a, map);
    const p2 = await persist(a, backend, { cutoffDay });
    if (p2.uploaded.length !== 1 || !p2.written) throw new Error(`the second persist uploaded ${p2.uploaded.length} day(s), expected 1`);
    step(`persist after one revision: 1 day uploaded, generation at seq ${p2.headSeq}`);
    writeFileSync(dataPaths(b).generation, readFileSync(dataPaths(a).generation));
    writeFileSync(dataPaths(b).head, readFileSync(dataPaths(a).head));
    const h2 = await hydrate(b, backend, { mode: 'authoritative', env: {} });
    const dirA = dataPaths(a).eventMapDir;
    const dirB = dataPaths(b).eventMapDir;
    for (const f of readdirSync(dirA)) {
      if (!readFileSync(join(dirA, f)).equals(readFileSync(join(dirB, f)))) throw new Error(`authoritative hydrate: ${f} differs`);
    }
    step(`authoritative hydrate into a second root: ${h2.written.length} day file(s), byte for byte the first root's`);
    // The restore path (scripts/state-restore.ts) on the same synthetic state: the daily backup archive of the
    // generation, built, verified, and its blobs PUT again (the same keys: a restore into a store that kept them).
    const genText = readFileSync(dataPaths(a).generation, 'utf8');
    const blobs = await getBlobs(backend, Object.values(readGeneration(a)!.generation.days).map((e) => e.blob));
    const archive = readTar(decompressBackup(compressBackup(writeTar(backupMembers('0'.repeat(40), genText, new Map(), blobs)))));
    const restored = verifyBackup(archive);
    for (const e of Object.values(restored.generation.days)) await backend.put(e.blob, archive.get(casKey(e.blob))!);
    step(`restore: a backup archive of the generation verified and its ${Object.keys(restored.generation.days).length} blob(s) PUT again`);
    const current = Object.values(readGeneration(a)!.generation.days).map((e) => e.blob).sort();
    const gc = await collect(backend, { keep: current, current, windowFrom: '', boundaries: [], holdReason: null }, { dryRun: true });
    step(`GC dry run (keep = the current generation, min age ${GC_MIN_AGE_DAYS} days): ${gc.pages} page(s), ${gc.listed} listed, would delete ${gc.deleted}`);
    const budget = await backend.budget();
    step(`budget: ${JSON.stringify(budget).slice(0, 300)}`);
    return steps;
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!/staging/.test(env.FEED_STATE_URL ?? '') || !/staging/.test(env.FEED_STATE_AUDIENCE ?? '')) {
    console.error('::error::the rehearsal runs against the staging store only (FEED_STATE_URL and FEED_STATE_AUDIENCE naming staging)');
    return 3;
  }
  const backend = backendFromEnv(env);
  if (!backend) {
    console.error('::error::FEED_STATE_BACKEND is not set');
    return 3;
  }
  const steps = await rehearse(backend, { log: (l) => console.log(l) });
  if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `### State store rehearsal (staging)\n\n${steps.map((s) => `- ${s}`).join('\n')}\n`, { flag: 'a' });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`::error::state rehearsal: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
