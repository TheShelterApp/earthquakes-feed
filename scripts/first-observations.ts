/**
 * The earliest observation of each source for an event, from the observation log (read-only).
 *
 * Usage:
 *   DATA_DIR=<data branch checkout> npx tsx scripts/first-observations.ts <efd_… | provider:native_id>...
 *   LOG_DIRS=<dir>:<dir> …   also read these directories of log NDJSON (log months rolled to a Release:
 *                            gh release download archive-YYYY-MM -p observations-YYYY-MM.tar.zst, then extract)
 *
 * Prints one JSON object per argument: the event the id names now (op:merge lines followed to the last survivor)
 * and, for every provider report of it, the first op:observe line: when the feed first held it (`ingest_time`,
 * `lag_seconds` after the origin), the provider's own update time of that version where the source gives one, and
 * the solution as first seen. An event the log does not hold (backfilled history, or anything before 2026-07-05)
 * prints `"in_log": false`: its day-partition rows are each provider's solution at backfill time, not a first
 * observation (APIs.md, History and backfill).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataPaths } from '../src/config.js';
import { FirstObservationIndex } from '../src/first-observations.js';
import type { Observation } from '../src/types.js';

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (e.endsWith('.ndjson')) out.push(full);
  }
  return out;
}

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('usage: DATA_DIR=<data checkout> npx tsx scripts/first-observations.ts <efd_… | provider:native_id>...');
  process.exit(2);
}
const dirs = [dataPaths().observationsDir, ...(process.env.LOG_DIRS ?? '').split(':').filter(Boolean)];
const index = new FirstObservationIndex();
let lines = 0;
for (const file of dirs.flatMap(walk).sort()) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    index.add(JSON.parse(line) as Observation);
    lines++;
  }
}
console.error(`first-observations: ${lines} log lines from ${dirs.join(', ')}`);
for (const id of ids) {
  const hit = index.lookup(id);
  console.log(JSON.stringify(hit ? { query: id, in_log: true, ...hit } : { query: id, in_log: false }));
}
