import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { DATA_DIR, MAX_PUBLISHED_BYTES, SCHEMA_DIR, dataPaths } from './config.js';

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

// 1. observation log
for (const file of walk(p.observationsDir, (f) => f.endsWith('.ndjson'))) {
  for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    if (!vObs(JSON.parse(line))) fail(`${file}:${i + 1} observation: ${ajv.errorsText(vObs.errors)}`);
  }
}

// 2. summaries: schema + size gate
for (const file of walk(p.feedDir, (f) => f.endsWith('.geojson'))) {
  const bytes = statSync(file).size;
  if (bytes > MAX_PUBLISHED_BYTES) fail(`${file}: ${bytes} bytes exceeds ${MAX_PUBLISHED_BYTES} (jsDelivr limit)`);
  const fc = JSON.parse(readFileSync(file, 'utf8')) as { features?: unknown[] };
  for (const feat of (fc.features ?? []).slice(0, 200)) {
    if (!vFeat(feat)) {
      fail(`${file}: feature ${ajv.errorsText(vFeat.errors)}`);
      break;
    }
  }
}

// 3. event partitions size gate
for (const file of walk(p.eventsDir, (f) => f.endsWith('.gz'))) {
  const bytes = statSync(file).size;
  if (bytes > MAX_PUBLISHED_BYTES) fail(`${file}: ${bytes} bytes exceeds ${MAX_PUBLISHED_BYTES}`);
}

// 4. manifest
const manifestFile = join(p.feedDir, 'manifest.json');
try {
  if (!vManifest(JSON.parse(readFileSync(manifestFile, 'utf8')))) fail(`manifest: ${ajv.errorsText(vManifest.errors)}`);
} catch {
  console.warn('· no manifest.json yet (run derive first)');
}

if (errors) {
  console.error(`\nvalidate: FAILED with ${errors} error(s)`);
  process.exit(1);
}
console.log('validate: OK');
