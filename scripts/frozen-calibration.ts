/**
 * Calibration of the frozen-source rule (src/activity.ts frozenProviders, round 14) on the observation log.
 *
 *   DATA_DIR=<data-branch checkout> npx tsx scripts/frozen-calibration.ts [fromIso toIso]
 *
 * For every live source with a frozen budget, hour by hour: the newest origin the log had received from it so far, and
 * how old that origin was. A source that lists without a time window may stand still that long in a quiet spell; the
 * report names each source's worst age and the spells past its frozen threshold (window + frozen budget). A spell during
 * which the source's fetch failed is an outage (failing, not frozen); check those against the status history
 * (status/history, or the `logs-YYYY-MM` Release assets). Read only.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { frozenBudgetHours } from '../src/activity.js';
import { DATA_DIR, dataPaths } from '../src/config.js';
import { activeProviders, liveLookbackMs, loadRegistry } from '../src/providers.js';

const HOUR = 3_600_000;
const [fromArg, toArg] = process.argv.slice(2);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) out.push(...files(f));
    else if (f.endsWith('.ndjson')) out.push(f);
  }
  return out.sort();
}

const seen = new Map<string, [number, number][]>();
for (const f of files(dataPaths(DATA_DIR).observationsDir)) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as { op?: string; provider?: string; ingest_time?: string; event_time?: string };
    if (o.op !== 'observe' || !o.provider || !o.ingest_time || !o.event_time) continue;
    const at = Date.parse(o.ingest_time);
    const ev = Math.min(Date.parse(o.event_time), at);
    if (Number.isFinite(at) && Number.isFinite(ev)) (seen.get(o.provider) ?? seen.set(o.provider, []).get(o.provider)!).push([at, ev]);
  }
}
// A loop, not Math.min(...xs): three months of the log are about a million rows, past the argument limit of a spread.
let first = Infinity;
let last = -Infinity;
for (const xs of seen.values()) {
  for (const [at] of xs) {
    if (at < first) first = at;
    if (at > last) last = at;
  }
}
const start = fromArg ? Date.parse(fromArg) : Math.ceil((first + 24 * HOUR) / HOUR) * HOUR;
const end = toArg ? Date.parse(toArg) : Math.floor(last / HOUR) * HOUR;
console.log(`observation log ${new Date(start).toISOString()} .. ${new Date(end).toISOString()}, hourly`);

const rows: string[] = [];
for (const p of activeProviders(loadRegistry())) {
  const budget = frozenBudgetHours(p);
  const xs = (seen.get(p.id) ?? []).sort((a, b) => a[0] - b[0]);
  if (budget == null || !xs.length) continue;
  const threshold = liveLookbackMs(p) / HOUR + budget;
  let i = 0;
  let newest = -Infinity;
  let worst = 0;
  let worstAt = start;
  let over: number | null = null;
  const spells: string[] = [];
  for (let t = start; t <= end; t += HOUR) {
    while (i < xs.length && xs[i]![0] <= t) newest = Math.max(newest, xs[i++]![1]);
    if (!Number.isFinite(newest)) continue;
    const age = (t - newest) / HOUR;
    if (age > worst) [worst, worstAt] = [age, t];
    if (age > threshold && over == null) over = t;
    if (age <= threshold && over != null) {
      spells.push(`${new Date(over).toISOString().slice(5, 13)} ${Math.round((t - over) / HOUR)} h`);
      over = null;
    }
  }
  if (over != null) spells.push(`${new Date(over).toISOString().slice(5, 13)} ${Math.round((end - over) / HOUR)} h (open)`);
  rows.push(
    `${p.id.padEnd(10)} ${p.supportsTimeRange ? 'window ' : 'list   '} threshold ${String(threshold).padStart(4)} h  worst ${worst.toFixed(1).padStart(7)} h at ${new Date(worstAt).toISOString().slice(5, 13)}  ${spells.length ? `past it: ${spells.join(', ')}` : ''}`,
  );
}
for (const r of rows.sort()) console.log(r);
