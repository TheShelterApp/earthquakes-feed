/**
 * One-off data repair: JMA observations whose lat/lon were written from the VXSE61
 * `cod` (sexagesimal DDMM.m) as if they were decimal degrees, leaving them out of
 * schema range (|lat|>90 or |lon|>180) and red-lining derive's validate gate.
 *
 * Re-parses each affected line's `fields.cod` with the corrected parser (parseJmaCod)
 * and rewrites only its top-level lat/lon; every other line is left byte-identical.
 * Append-only history is preserved — this fixes malformed values in place, it does not
 * rewrite git history.
 *
 *   npx tsx scripts/repair-jma-coords.ts [observationsDir]   # default: .data/knowledge/observations
 *   DRY_RUN=1 npx tsx scripts/repair-jma-coords.ts           # report only, write nothing
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJmaCod } from '../src/custom.js';

const dir = process.argv[2] ?? '.data/knowledge/observations';
const dryRun = process.env.DRY_RUN === '1';

function walk(d: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(d)) {
    const full = join(d, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ndjson')) out.push(full);
  }
  return out;
}

const inRange = (lat: number, lon: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

let filesTouched = 0;
let linesFixed = 0;
let unfixable = 0;

for (const file of walk(dir).sort()) {
  const raw = readFileSync(file, 'utf8');
  let changed = false;
  const out = raw
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      const o = JSON.parse(line) as { provider?: string; lat?: number; lon?: number; fields?: { cod?: unknown } };
      if (o.provider !== 'jma' || inRange(o.lat ?? NaN, o.lon ?? NaN)) return line;
      const c = parseJmaCod(String(o.fields?.cod ?? ''));
      if (!c || !inRange(c.lat, c.lon)) {
        unfixable++;
        console.error(`✗ ${file}: cannot repair (cod=${JSON.stringify(o.fields?.cod)}) — left as-is`);
        return line;
      }
      o.lat = c.lat;
      o.lon = c.lon;
      changed = true;
      linesFixed++;
      return JSON.stringify(o);
    })
    .join('\n');
  if (changed) {
    filesTouched++;
    if (!dryRun) writeFileSync(file, out);
    console.log(`${dryRun ? '[dry-run] would fix' : 'fixed'} ${file}`);
  }
}

console.log(`\nrepair-jma-coords: ${linesFixed} line(s) across ${filesTouched} file(s)${unfixable ? `, ${unfixable} unfixable` : ''}${dryRun ? ' (dry run, nothing written)' : ''}`);
if (unfixable) process.exit(1);
