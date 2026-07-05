import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { DATA_DIR, MAX_PUBLISHED_BYTES, PUBLIC_DIR, SCHEMA_DIR, dataPaths } from './config.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const compile = (name: string): ValidateFunction =>
  ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8')) as object);

const vObs = compile('observation.schema.json');
const vFeat = compile('feature.schema.json');
const vManifest = compile('manifest.schema.json');

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
const nowMs = Date.now();
for (const file of walk(publicV1, (f) => f.endsWith('.geojson'))) {
  const bytes = statSync(file).size;
  if (bytes > MAX_PUBLISHED_BYTES) fail(`${file}: ${bytes} bytes exceeds ${MAX_PUBLISHED_BYTES}`);
  const fc = JSON.parse(readFileSync(file, 'utf8')) as { metadata?: { generated?: unknown }; features?: { properties?: { time?: number } }[] };
  if (typeof fc.metadata?.generated !== 'number') fail(`${file}: metadata.generated must be ms-epoch int`);
  for (const feat of (fc.features ?? []).slice(0, 200)) {
    if (!vFeat(feat)) {
      fail(`${file}: feature ${ajv.errorsText(vFeat.errors)}`);
      break;
    }
    const t = feat.properties?.time;
    if (typeof t === 'number' && t > nowMs + 15 * 60_000) fail(`${file}: future-timestamped event (time=${t})`);
  }
}

// 3. Committed day partitions: plain NDJSON, size gate, first lines parse as Features.
for (const file of walk(p.eventsDir, (f) => f.endsWith('.ndjson'))) {
  const bytes = statSync(file).size;
  if (bytes > MAX_PUBLISHED_BYTES) fail(`${file}: ${bytes} bytes exceeds ${MAX_PUBLISHED_BYTES}`);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines.slice(0, 3)) {
    if (!vFeat(JSON.parse(line))) {
      fail(`${file}: partition line ${ajv.errorsText(vFeat.errors)}`);
      break;
    }
  }
}

// 4. Manifest (canonical Pages copy).
try {
  if (!vManifest(JSON.parse(readFileSync(join(publicV1, 'manifest.json'), 'utf8')))) {
    fail(`manifest: ${ajv.errorsText(vManifest.errors)}`);
  }
} catch {
  console.warn('· no public manifest.json yet (run derive first)');
}

if (errors) {
  console.error(`\nvalidate: FAILED with ${errors} error(s)`);
  process.exit(1);
}
console.log('validate: OK');
