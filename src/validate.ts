import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { DATA_DIR, DOMAIN, MAX_PUBLISHED_BYTES, PUBLIC_DIR, SCHEMA_DIR, dataPaths } from './config.js';
import { deltaBoundViolations, readSilentLog } from './live-sync.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const compile = (name: string): ValidateFunction =>
  ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8')) as object);

const vObs = compile('observation.schema.json');
const vFeat = compile('feature.schema.json');
const vManifest = compile('manifest.schema.json');
const vLiveIndex = compile('live-index.schema.json');

/** Cloudflare Pages, Free plan: files per site (deploy) and bytes per file. */
const PAGES_MAX_FILES = 20_000;
const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;

let errors = 0;
const fail = (msg: string): void => {
  errors++;
  console.error(`✗ ${msg}`);
};

function walk(dir: string, match: (f: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full, match));
    else if (match(full)) out.push(full);
  }
  return out;
}

const p = dataPaths(DATA_DIR);
const publicV1 = join(PUBLIC_DIR, 'v1');

// 1. Observation log: schema + seq invariants (strictly increasing per file;
//    global max of the two most recent files must equal head.seq — M4).
const logFiles = walk(p.observationsDir, (f) => f.endsWith('.ndjson')).sort();
let globalMaxSeq = 0;
for (const file of logFiles) {
  let prevSeq = -1;
  for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as { seq?: number };
    if (!vObs(obj)) fail(`${file}:${i + 1} observation: ${ajv.errorsText(vObs.errors)}`);
    const seq = obj.seq ?? -1;
    if (seq <= prevSeq) fail(`${file}:${i + 1} seq not strictly increasing (${prevSeq} -> ${seq})`);
    prevSeq = seq;
    if (seq > globalMaxSeq) globalMaxSeq = seq;
  }
}
try {
  const head = JSON.parse(readFileSync(p.head, 'utf8')) as { seq: number };
  if (logFiles.length && head.seq !== globalMaxSeq) fail(`head.seq=${head.seq} != log max seq=${globalMaxSeq}`);
} catch {
  if (logFiles.length) fail('head.json missing/unreadable while log exists');
}

// 2. Published summaries (Pages artifact): schema + size gate + no future events.
//    /v1/events/ day files are the documented FULL-detail Pages surface (the compact
//    summaries point consumers there) — every LIVE feature must keep a non-empty
//    feed.provenance[]. A retired feature (superseded or tombstoned) rides along compact and
//    flagged non-live for RETIRED_VISIBLE_MS by contract, so it is exempt.
const nowMs = Date.now();
for (const file of walk(publicV1, (f) => f.endsWith('.geojson'))) {
  const bytes = statSync(file).size;
  // The hard gate stays the invariant — derive's own budget guard is a producer-side courtesy,
  // this is the backstop. Warn at 75% too: on 2026-07-14 the month files crossed the cap with
  // no prior signal and 51 consecutive derive runs failed for ~4h before anyone noticed.
  if (bytes > MAX_PUBLISHED_BYTES) fail(`${file}: ${bytes} bytes exceeds ${MAX_PUBLISHED_BYTES}`);
  else if (bytes > MAX_PUBLISHED_BYTES * 0.75) {
    console.warn(`::warning::${file}: ${bytes} bytes — ${((bytes / MAX_PUBLISHED_BYTES) * 100).toFixed(1)}% of the ${MAX_PUBLISHED_BYTES}-byte budget`);
  }
  const fc = JSON.parse(readFileSync(file, 'utf8')) as { metadata?: { generated?: unknown }; features?: { properties?: { time?: number; feed?: { state?: string; provenance?: unknown[] } } }[] };
  if (typeof fc.metadata?.generated !== 'number') fail(`${file}: metadata.generated must be ms-epoch int`);
  // The per-hour detail files (EVT-5) are full-fat like the day files, live events only.
  const isDayFile = file.includes(join(publicV1, 'events')) || file.includes(join(publicV1, 'detail'));
  for (const [i, feat] of (fc.features ?? []).entries()) {
    if (i < 200 && !vFeat(feat)) {
      fail(`${file}: feature ${ajv.errorsText(vFeat.errors)}`);
      break;
    }
    if (isDayFile) {
      const prov = feat.properties?.feed?.provenance;
      const state = feat.properties?.feed?.state;
      const retired = state === 'superseded' || state === 'tombstoned';
      if (!retired && (!Array.isArray(prov) || prov.length === 0)) {
        fail(`${file}: feature ${i} lost feed.provenance[] — day files must stay full-fat`);
        break;
      }
    } else if (i >= 200) break;
    const t = feat.properties?.time;
    if (typeof t === 'number' && t > nowMs + 15 * 60_000) fail(`${file}: future-timestamped event (time=${t})`);
  }
}

// 3. Committed day partitions: plain NDJSON, size gate, first lines parse as Features.
//    Full-fat invariant on EVERY line: partitions are the archival surface, so each
//    feature must carry a non-empty feed.provenance[] (the schema allows its absence only
//    because summaries are compact). Sole exception: a tombstoned event may have an empty
//    provenance — op:tombstone withdraws the deleting provider's row by design, and the
//    original observations stay in the append-only log.
for (const file of walk(p.eventsDir, (f) => f.endsWith('.ndjson'))) {
  const bytes = statSync(file).size;
  if (bytes > MAX_PUBLISHED_BYTES) fail(`${file}: ${bytes} bytes exceeds ${MAX_PUBLISHED_BYTES}`);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const feat = JSON.parse(line) as { properties?: { feed?: { state?: string; provenance?: unknown[] } } };
    if (i < 3 && !vFeat(feat)) {
      fail(`${file}: partition line ${ajv.errorsText(vFeat.errors)}`);
      break;
    }
    const feed = feat.properties?.feed;
    if (!Array.isArray(feed?.provenance) || (feed.provenance.length === 0 && feed.state !== 'tombstoned')) {
      fail(`${file}:${i + 1} partition feature lost feed.provenance[] (state=${feed?.state}) — partitions must stay full-fat`);
      break;
    }
  }
}

// 3b. The Pages copies of the unfrozen day partitions (round 25, storage option 4 phase 1; partitions.ts
//     writePagesPartition): byte for byte the partition derive wrote to the data checkout (sign-manifest.ts hashes that
//     one for the v2 sha256), and every manifest `url` on Pages names one of them, of an unfrozen day, with its `bytes`.
const pagesEventsDir = join(PUBLIC_DIR, 'events');
const pagesNdjson = walk(pagesEventsDir, (f) => f.endsWith('.ndjson'));
for (const file of pagesNdjson) {
  const rel = relative(PUBLIC_DIR, file).split(sep).join('/');
  const inData = join(DATA_DIR, rel);
  if (!existsSync(inData)) fail(`${file}: no partition ${rel} in the data checkout`);
  else if (!readFileSync(file).equals(readFileSync(inData))) fail(`${file}: differs from the data checkout's ${rel}`);
}
try {
  const m = JSON.parse(readFileSync(join(publicV1, 'manifest.json'), 'utf8')) as {
    partitions?: { date: string; path: string; url?: string; bytes?: number; frozen?: boolean }[];
  };
  let onPages = 0;
  for (const part of m.partitions ?? []) {
    if (!part.url?.startsWith(`https://${DOMAIN}/`)) continue;
    onPages++;
    if (part.url !== `https://${DOMAIN}/${part.path}`) fail(`manifest: partition ${part.date} url ${part.url} is not the Pages copy of ${part.path}`);
    if (part.frozen) fail(`manifest: frozen partition ${part.date} has a Pages url (frozen days stay on jsDelivr @data_commit)`);
    const f = join(PUBLIC_DIR, part.path);
    if (!existsSync(f)) fail(`manifest: partition ${part.date} url ${part.url} names no deployed file`);
    else if (part.bytes != null && statSync(f).size !== part.bytes) fail(`manifest: partition ${part.date} bytes ${part.bytes} != ${statSync(f).size} on Pages`);
  }
  if (onPages !== pagesNdjson.length) fail(`manifest: ${onPages} partition url(s) on Pages, ${pagesNdjson.length} NDJSON file(s) deployed`);
} catch (err) {
  if (existsSync(join(publicV1, 'manifest.json'))) fail(`manifest: unreadable (${err instanceof Error ? err.message : String(err)})`);
}

// 4. The live index (PRB-2, live-sync.ts): every day file and delta it lists exists with the listed bytes and sha256,
//    the days are consecutive, and a delta holds only features above its from_seq (a client applies it on that bound)
//    or silent changes the log names (live-sync.ts: such a feature keeps its older seq).
const liveIndexFile = join(publicV1, 'live', 'index.json');
if (existsSync(liveIndexFile)) {
  const idx = JSON.parse(readFileSync(liveIndexFile, 'utf8')) as {
    head_seq?: number;
    days?: { date: string; path: string; bytes: number; sha256: string; count: number }[];
    deltas?: { name: string; path: string; bytes: number; sha256: string; from_seq: number; head_seq: number; count: number }[];
  };
  const read = (rel: string): string | null => {
    const f = join(PUBLIC_DIR, rel);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  };
  const check = (what: string, rel: string, bytes: number, sha: string): string | null => {
    const body = read(rel);
    if (body == null) {
      fail(`live index: ${what} ${rel} is missing`);
      return null;
    }
    if (Buffer.byteLength(body) !== bytes) fail(`live index: ${what} ${rel} has ${Buffer.byteLength(body)} bytes, the index says ${bytes}`);
    if (createHash('sha256').update(body).digest('hex') !== sha) fail(`live index: ${what} ${rel} sha256 differs from the index`);
    return body;
  };
  const silentLog = readSilentLog(DATA_DIR);
  if (!vLiveIndex(idx)) fail(`live index: ${ajv.errorsText(vLiveIndex.errors)}`);
  const days = idx.days ?? [];
  if (!days.length) fail('live index: no days');
  for (const [i, d] of days.entries()) {
    if (i > 0 && Date.parse(`${d.date}T00:00:00Z`) - Date.parse(`${days[i - 1]!.date}T00:00:00Z`) !== 86_400_000) {
      fail(`live index: days not consecutive at ${d.date}`);
    }
    check('day', d.path, d.bytes, d.sha256);
  }
  for (const d of idx.deltas ?? []) {
    if (d.head_seq !== idx.head_seq || d.from_seq > d.head_seq) fail(`live index: delta ${d.name} seq bounds ${d.from_seq}..${d.head_seq} (head ${idx.head_seq})`);
    const body = check('delta', d.path, d.bytes, d.sha256);
    if (!body) continue;
    const fc = JSON.parse(body) as { features?: { id?: string; properties?: { feed?: { ingest_seq?: number } } }[] };
    // A feature at or below from_seq is a silent change (live-sync.ts) only when the log derive just wrote names it.
    const low = deltaBoundViolations(fc.features ?? [], d.from_seq, silentLog);
    if (low.length) {
      fail(`live index: delta ${d.name} holds ${low.length} feature(s) at or below its from_seq ${d.from_seq} that the silent log does not name (${low.slice(0, 5).join(', ')})`);
    }
    if ((fc.features ?? []).length !== d.count) fail(`live index: delta ${d.name} count ${d.count} != ${(fc.features ?? []).length} features`);
  }
}

// 5. Manifest (canonical Pages copy).
try {
  if (!vManifest(JSON.parse(readFileSync(join(publicV1, 'manifest.json'), 'utf8')))) {
    fail(`manifest: ${ajv.errorsText(vManifest.errors)}`);
  }
} catch {
  console.warn('· no public manifest.json yet (run derive first)');
}

// 6. Cloudflare Pages limits (developers.cloudflare.com/pages/platform/limits, Free plan): at most 20,000 files per
//    deploy and 25 MiB per file. A deploy past either fails; warn from 75 % of the file count.
const deployed = walk(PUBLIC_DIR, () => true);
if (deployed.length) {
  if (deployed.length > PAGES_MAX_FILES) fail(`Pages: ${deployed.length} files, over the ${PAGES_MAX_FILES}-file limit`);
  else if (deployed.length > PAGES_MAX_FILES * 0.75) console.warn(`::warning::Pages: ${deployed.length} files, ${((deployed.length / PAGES_MAX_FILES) * 100).toFixed(1)}% of the ${PAGES_MAX_FILES}-file limit`);
  let total = 0;
  for (const f of deployed) {
    const size = statSync(f).size;
    total += size;
    if (size > PAGES_MAX_FILE_BYTES) fail(`Pages: ${f} is ${size} bytes, over the ${PAGES_MAX_FILE_BYTES}-byte file limit`);
  }
  console.log(`validate: Pages deploy ${deployed.length} files (limit ${PAGES_MAX_FILES}), ${(total / 1e6).toFixed(1)} MB, ${pagesNdjson.length} NDJSON partition(s)`);
}

if (errors) {
  console.error(`\nvalidate: FAILED with ${errors} error(s)`);
  process.exit(1);
}
console.log('validate: OK');
