/**
 * Each source's earliest published solution of an event (read-only): the source's own version history, from the
 * earliest-solutions side index (PF-5i P-3, src/first-solutions.ts), merged with the observation log's first line of
 * the report (what the feed first saw, since 2026-07-05).
 *
 * Usage:
 *   DATA_DIR=<data branch checkout> npx tsx scripts/first-observations.ts <efd_… | provider:native_id>...
 *   FIRST_SOLUTIONS_DIRS=<dir>:<dir> …  read the side-index chunks in these directories, downloaded from the event
 *                                       month's Release: gh release download first-solutions-YYYY-MM
 *                                       -R TheShelterApp/earthquakes-feed -D <dir>
 *   LOG_DIRS=<dir>:<dir> …              also read these directories of log NDJSON (log months rolled to a Release:
 *                                       gh release download archive-YYYY-MM -p observations-YYYY-MM.tar.zst, then extract)
 *   EVENT_DIRS=<dir>:<dir> …            day partitions to find the reports of an event the log does not hold, by its
 *                                       feed id (DATA_DIR/events is always read; an archived month:
 *                                       gh release download archive-YYYY-MM -p events-YYYY-MM.tar.zst, then extract)
 *
 * Prints one JSON object per argument: the event the id names now (op:merge lines followed to the last survivor) and,
 * for every report of it, `first_solution` (the earliest solution whose values are known, with its provenance:
 * "provider version history" = the source's own publication time of that version, or "first seen by the feed" = the
 * log's first line, when the feed first held it), `first_published` (the earliest publication time known, which is
 * the source's creation time of the event where the source keeps only later origins), `provider_history` (the
 * source's retained versions, summarised) and `feed_first_seen` (the log's first line). A report the side index does
 * not hold yet and the log does not hold (backfilled history the collector has not reached) has neither.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { dataPaths } from '../src/config.js';
import { type EarliestReport, FirstObservationIndex, earliestReport } from '../src/first-observations.js';
import { FirstSolutionIndex, type FirstSolutionRecord } from '../src/first-solutions.js';
import type { Observation } from '../src/types.js';

function walk(dir: string, accept: (name: string) => boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(e)) out.push(full);
  }
  return out;
}

const dirsOf = (env: string | undefined): string[] => (env ?? '').split(':').filter(Boolean);

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('usage: DATA_DIR=<data checkout> [FIRST_SOLUTIONS_DIRS=…] npx tsx scripts/first-observations.ts <efd_… | provider:native_id>...');
  process.exit(2);
}

const logDirs = [dataPaths().observationsDir, ...dirsOf(process.env.LOG_DIRS)];
const log = new FirstObservationIndex();
let lines = 0;
for (const file of logDirs.flatMap((d) => walk(d, (n) => n.endsWith('.ndjson'))).sort()) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    log.add(JSON.parse(line) as Observation);
    lines++;
  }
}

const side = new FirstSolutionIndex();
const sideDirs = dirsOf(process.env.FIRST_SOLUTIONS_DIRS);
for (const file of sideDirs.flatMap((d) => walk(d, (n) => n.endsWith('.ndjson.gz') || n.endsWith('.ndjson'))).sort()) {
  const raw = readFileSync(file);
  const text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  for (const line of text.split('\n')) if (line.trim()) side.add(JSON.parse(line) as FirstSolutionRecord);
}
console.error(`first-observations: ${lines} log lines from ${logDirs.join(', ')}; ${side.records} side-index records from ${sideDirs.join(', ') || '(none)'}`);

/** The provider reports of an event the log does not hold, from its day partition. */
function reportsInPartitions(feedId: string): Array<{ provider: string; native_id: string }> | null {
  const dirs = [dataPaths().eventsDir, ...dirsOf(process.env.EVENT_DIRS)];
  const needle = `"id":"${feedId}"`;
  for (const file of dirs.flatMap((d) => walk(d, (n) => n.endsWith('.ndjson')))) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(needle)) continue;
    for (const line of text.split('\n')) {
      if (!line.includes(needle)) continue;
      const f = JSON.parse(line) as { id: string; properties?: { feed?: { provenance?: Array<{ provider: string; native_id: string }> } } };
      if (f.id === feedId) return f.properties?.feed?.provenance ?? [];
    }
  }
  return null;
}

for (const id of ids) {
  const hit = log.lookup(id);
  let reports: EarliestReport[] = [];
  let feedId: string | null = null;
  if (hit) {
    feedId = hit.feed_id;
    reports = hit.reports.map((r) => earliestReport(r.provider, r.provider_event_id, r, side));
  } else if (id.startsWith('efd_')) {
    const rows = reportsInPartitions(id);
    if (rows) {
      feedId = id;
      reports = rows.map((r) => earliestReport(r.provider, r.native_id, null, side));
    }
  } else {
    const i = id.indexOf(':');
    const report = earliestReport(id.slice(0, i), id.slice(i + 1), null, side);
    if (report.provider_history) reports = [report];
  }
  console.log(JSON.stringify({ query: id, feed_id: feedId, in_log: !!hit, reports }));
}
