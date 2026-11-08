/**
 * The re-merge's review table (C9/C10; APIs.md, Re-merged history): per unit, live M4.5+ and M6+ earthquakes before and
 * after the re-merge, the usgs-anchored counts, the residual (M4.5+ without a usgs row, near a usgs event or not), and,
 * with --comcat, ComCat's own count of the unit's days; then every M6+ fold and every fold that joins two usgs ids.
 * Read-only.
 *
 *   npx tsx scripts/remerge-verify.ts <remerge-out dir> [--comcat] [--out table.md] [--json rows.json]
 *       a remerge.yml run's report (the artifact remerge-report: months/<period>.json)
 *   npx tsx scripts/remerge-verify.ts --history <history-out dir> [--comcat] ...
 *       a history dry run (HISTORY_DRY_RUN=1): its history.json and releases/; each re-merged edition against the edition
 *       it was merged from (downloaded with gh when not in the directory)
 *   npx tsx scripts/remerge-verify.ts --from-index <data dir> [--comcat] [--only YYYY-MM,...] ...
 *       the published state: every merged archive month (archives.json) and history edition (history.json), each
 *       against what it was merged from, downloaded with gh
 *
 * Counts: earthquake types only (the feed's `type`), the 0,0 placeholders excluded (remerge.ts magnitudeCounts). The
 * anchor: distinct usgs ids with a row magnitude >= 4.5 / 6 in live events (remerge.ts anchorCounts). ComCat:
 * `count?eventtype=earthquake` over the unit's days, one request at a time, at least 1.1 s apart. Warnings: anchored
 * below ComCat by more than max(2, 1 %) (a completeness gap: ComCat published later than the feed read it), anchored
 * above ComCat (ComCat deleted events since).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { featureToNode } from '../src/bitemporal.js';
import { REPO } from '../src/config.js';
import { ghRetry } from '../src/gh.js';
import type { MergeMeta } from '../src/remerge.js';
import { anchorCounts, magnitudeCounts, usgsResidual } from '../src/remerge.js';
import type { EventNode } from '../src/types.js';

interface Fold {
  loser: string;
  survivor: string;
  reason: string;
  survivor_mag: number | null;
  loser_mag: number | null;
  time: string | null;
  survivor_usgs: string[];
  loser_usgs: string[];
  loser_providers?: string[];
}
interface Row {
  label: string;
  first_day: string;
  last_day: string;
  before: ReturnType<typeof magnitudeCounts>;
  after: ReturnType<typeof magnitudeCounts>;
  anchor_before: ReturnType<typeof anchorCounts>;
  anchor_after: ReturnType<typeof anchorCounts>;
  residual: { near: number; far: number } | null;
  folds: Fold[];
  comcat?: { m45: number; m6: number };
  warnings: string[];
}

const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(n);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt('--only')?.split(',').map((x) => x.trim()).filter(Boolean);
const work = mkdtempSync(join(tmpdir(), 'efd-remerge-verify-'));
const DAY = 86_400_000;
const nextDay = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

function members(file: string): Map<string, string> {
  const d = mkdtempSync(join(work, 'x-'));
  execFileSync('sh', ['-c', `zstd -d -q -c "$1" | tar -xf - -C "$2"`, 'sh', file, d]);
  const out = new Map<string, string>();
  for (const m of readdirSync(d).sort()) out.set(m, readFileSync(join(d, m), 'utf8'));
  rmSync(d, { recursive: true, force: true });
  return out;
}
function download(tag: string, asset: string): string {
  const f = join(work, asset);
  if (!existsSync(f)) ghRetry(['release', 'download', tag, '-R', REPO, '-p', asset, '-O', f, '--clobber']);
  return f;
}
const nodesOf = (m: Map<string, string>): EventNode[] =>
  [...m]
    .filter(([k]) => /^\d{2}\.ndjson$/.test(k))
    .flatMap(([, t]) => t.split('\n').filter((l) => l.trim()).map((l) => featureToNode(JSON.parse(l))));

function rowFromNodes(label: string, before: EventNode[], after: EventNode[], merge: MergeMeta, days: string[]): Row {
  const byId = new Map(after.map((n) => [n.feedId, n]));
  const folds: Fold[] = merge.merges.map((x) => {
    const s = byId.get(x.survivor);
    const l = byId.get(x.loser);
    return {
      ...x,
      survivor_mag: s?.mag ?? null,
      loser_mag: l?.mag ?? null,
      time: s ? new Date(s.eventTimeMs).toISOString() : null,
      survivor_usgs: s?.provenance.filter((r) => r.provider === 'usgs').map((r) => r.nativeId) ?? [],
      loser_usgs: l?.provenance.filter((r) => r.provider === 'usgs').map((r) => r.nativeId) ?? [],
      loser_providers: [...new Set(l?.provenance.map((r) => r.provider) ?? [])],
    };
  });
  const sorted = [...days].sort();
  return {
    label,
    first_day: sorted[0]!,
    last_day: sorted[sorted.length - 1]!,
    before: magnitudeCounts(before),
    after: magnitudeCounts(after),
    anchor_before: anchorCounts(before),
    anchor_after: anchorCounts(after),
    residual: usgsResidual(after),
    folds,
    warnings: [],
  };
}

const rows: Row[] = [];
if (flag('--history')) {
  const dir = opt('--history')!;
  const idx = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')) as { editions: { period: string; tag: string; asset: string; merged_from?: { asset: string }; withdrawn?: unknown }[] };
  for (const e of idx.editions) {
    if (!e.merged_from || e.withdrawn || (only && !only.includes(e.period))) continue;
    const local = join(dir, 'releases', e.tag, e.asset);
    if (!existsSync(local)) continue;
    const after = members(local);
    const baseLocal = join(dir, 'releases', e.tag, e.merged_from.asset);
    const before = members(existsSync(baseLocal) ? baseLocal : download(e.tag, e.merged_from.asset));
    const meta = JSON.parse(after.get('_edition.json')!) as { merge: MergeMeta; days: string[] };
    rows.push(rowFromNodes(`history ${e.period}`, nodesOf(before), nodesOf(after), meta.merge, meta.days));
  }
} else if (flag('--from-index')) {
  const dir = opt('--from-index')!;
  const archives = JSON.parse(readFileSync(join(dir, 'knowledge/index/archives.json'), 'utf8')) as {
    list: { period: string; tag: string; asset: string; merge_epoch?: number; built_on?: { asset: string }; days: string[] }[];
  };
  for (const e of archives.list) {
    if (!e.merge_epoch || !e.built_on || (only && !only.includes(e.period))) continue;
    const after = members(download(e.tag, e.asset));
    const meta = JSON.parse(after.get('_archive.json')!) as { merge: MergeMeta; remediation_days: { day: string }[] };
    // The base with its remediated days, as the merge read it.
    let before = nodesOf(members(download(e.tag, e.built_on.asset)));
    for (const r of meta.remediation_days) {
      const rem = JSON.parse(readFileSync(join(dir, 'knowledge/index/remediation.json'), 'utf8')) as { editions: { day: string; edition: number; tag: string; asset: string }[] };
      const ed = rem.editions.find((x) => x.day === r.day && x.edition === (r as unknown as { edition: number }).edition)!;
      const text = execFileSync('gzip', ['-dc', download(ed.tag, ed.asset)], { maxBuffer: 1 << 30 }).toString('utf8');
      const nodes = text.split('\n').filter((l) => l.trim()).map((l) => featureToNode(JSON.parse(l)));
      const ids = new Set(nodes.map((n) => n.feedId));
      before = [...before.filter((n) => !ids.has(n.feedId) && new Date(n.eventTimeMs).toISOString().slice(0, 10) !== r.day), ...nodes];
    }
    rows.push(rowFromNodes(`archive ${e.period}`, before, nodesOf(after), meta.merge, e.days));
  }
  const hpath = join(dir, 'knowledge/index/history.json');
  if (existsSync(hpath)) {
    const idx = JSON.parse(readFileSync(hpath, 'utf8')) as { editions: { period: string; tag: string; asset: string; merged_from?: { asset: string }; withdrawn?: unknown }[] };
    for (const e of idx.editions) {
      if (!e.merged_from || e.withdrawn || (only && !only.includes(e.period))) continue;
      const after = members(download(e.tag, e.asset));
      const before = members(download(e.tag, e.merged_from.asset));
      const meta = JSON.parse(after.get('_edition.json')!) as { merge: MergeMeta; days: string[] };
      rows.push(rowFromNodes(`history ${e.period}`, nodesOf(before), nodesOf(after), meta.merge, meta.days));
    }
  }
} else {
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('usage: npx tsx scripts/remerge-verify.ts <remerge-out dir> | --history <history-out dir> | --from-index <data dir>  [--comcat] [--only YYYY-MM,...] [--out table.md] [--json rows.json]');
    process.exit(2);
  }
  for (const f of readdirSync(join(dir, 'months')).filter((x) => x.endsWith('.json')).sort()) {
    const m = JSON.parse(readFileSync(join(dir, 'months', f), 'utf8')) as Row & { period: string; residual?: Row['residual'] };
    if (only && !only.includes(m.period)) continue;
    const [y, mo] = m.period.split('-').map(Number);
    const lastOfMonth = new Date(Date.UTC(y!, mo!, 0)).toISOString().slice(0, 10);
    rows.push({ ...m, label: `archive ${m.period}`, first_day: m.first_day ?? `${m.period}-01`, last_day: m.last_day ?? lastOfMonth, residual: m.residual ?? null, warnings: [] });
  }
}

if (flag('--comcat')) {
  for (const r of rows) {
    const count = async (min: number): Promise<number> => {
      const url = `https://earthquake.usgs.gov/fdsnws/event/1/count?starttime=${r.first_day}T00:00:00&endtime=${nextDay(r.last_day)}T00:00:00&minmagnitude=${min}&eventtype=earthquake`;
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, { headers: { 'user-agent': 'earthquakes-feed remerge-verify (+https://github.com/TheShelterApp/earthquakes-feed)' } });
        await new Promise((ok) => setTimeout(ok, 1100));
        if (res.ok) return Number((await res.text()).trim());
        if (attempt >= 3) throw new Error(`${url}: HTTP ${res.status}`);
      }
    };
    r.comcat = { m45: await count(4.5), m6: await count(6) };
  }
}

rmSync(work, { recursive: true, force: true });
for (const r of rows) {
  const a = r.anchor_after;
  if (r.comcat) {
    if (r.comcat.m45 - a.u45 > Math.max(2, Math.ceil(r.comcat.m45 * 0.01))) r.warnings.push(`anchored M4.5+ ${a.u45} < ComCat ${r.comcat.m45}: completeness gap`);
    if (a.u45 > r.comcat.m45) r.warnings.push(`anchored M4.5+ ${a.u45} > ComCat ${r.comcat.m45}: ComCat deleted events since`);
    if (a.u6 !== r.comcat.m6) r.warnings.push(`anchored M6+ ${a.u6} vs ComCat ${r.comcat.m6}`);
  }
  if (a.welds45 > r.anchor_before.welds45) r.warnings.push(`${a.welds45 - r.anchor_before.welds45} new weld(s) of two ComCat events`);
}

const pct = (b: number, x: number): string => (b ? `${(((x - b) / b) * 100).toFixed(0)} %` : '');
const lines: string[] = [];
lines.push('| Unit | Days | live before → after | M4.5+ before → after (Δ) | M6+ before → after | usgs-anchored M4.5+ / M6+ (ids) | ComCat M4.5+ / M6+ | M4.5+ without usgs (near / far) | Folds | Notes |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  lines.push(
    `| ${r.label} | ${r.first_day.slice(5)}..${r.last_day.slice(5)} | ${r.before.live} → ${r.after.live} | ${r.before.m45} → ${r.after.m45} (${pct(r.before.m45, r.after.m45)}) | ${r.before.m6} → ${r.after.m6} | ` +
      `${r.anchor_after.u45} / ${r.anchor_after.u6} | ${r.comcat ? `${r.comcat.m45} / ${r.comcat.m6}` : 'n/a'} | ${r.residual ? `${r.residual.near} / ${r.residual.far}` : 'n/a'} | ${r.folds.length} | ${r.warnings.join('; ')} |`,
  );
}
const sum = (f: (r: Row) => number): number => rows.reduce((s, r) => s + f(r), 0);
lines.push(
  `| **total** | ${rows.length} units | ${sum((r) => r.before.live)} → ${sum((r) => r.after.live)} | ${sum((r) => r.before.m45)} → ${sum((r) => r.after.m45)} | ${sum((r) => r.before.m6)} → ${sum((r) => r.after.m6)} | ` +
    `${sum((r) => r.anchor_after.u45)} / ${sum((r) => r.anchor_after.u6)} | ${rows.every((r) => r.comcat) ? `${sum((r) => r.comcat!.m45)} / ${sum((r) => r.comcat!.m6)}` : 'n/a'} | | ${sum((r) => r.folds.length)} | |`,
);
// Every fold that involves an M6+ event, one line per survivor (its losers listed).
const m6 = new Map<string, { r: Row; folds: Fold[] }>();
for (const r of rows) {
  for (const f of r.folds) {
    if ((f.survivor_mag ?? 0) < 6 && (f.loser_mag ?? 0) < 6) continue;
    const k = `${r.label} ${f.survivor}`;
    (m6.get(k) ?? m6.set(k, { r, folds: [] }).get(k)!).folds.push(f);
  }
}
const m6Folds = [...m6.values()].reduce((s, x) => s + x.folds.length, 0);
lines.push('', `### M6+ folds (${m6Folds} folds into ${m6.size} survivors)`, '', '| Unit | Time (UTC) | Survivor (M, usgs ids) | Losers: id (M; providers; distance/time from the reason) |', '|---|---|---|---|');
for (const { r, folds } of m6.values()) {
  const f0 = folds[0]!;
  const losers = folds
    .map((f) => {
      const dd = /d=([\d.]+) km dt=([\d.]+) s/.exec(f.reason);
      const how = dd ? `${dd[1]} km, ${dd[2]} s` : f.reason.split(':')[0];
      return `${f.loser.slice(-6)} (M${f.loser_mag != null ? f.loser_mag.toFixed(1) : '?'}; ${(f.loser_providers ?? []).join('+')}; ${how})`;
    })
    .join('; ');
  lines.push(`| ${r.label} | ${f0.time?.slice(0, 19) ?? ''} | ${f0.survivor} (M${f0.survivor_mag != null ? f0.survivor_mag.toFixed(1) : '?'}, ${f0.survivor_usgs.join(', ') || 'no usgs'}) | ${losers.replace(/\|/g, '/')} |`);
}
const twoUsgs = rows.flatMap((r) => r.folds.filter((f) => f.loser_usgs.length > 0 && f.survivor_usgs.some((u) => !f.loser_usgs.includes(u))).map((f) => ({ r, f })));
lines.push('', `### Folds joining two usgs ids (${twoUsgs.length})`, '');
for (const { r, f } of twoUsgs) lines.push(`- ${r.label} ${f.time ?? ''}: ${f.loser} (${f.loser_usgs.join(', ')}) into ${f.survivor} (${f.survivor_usgs.join(', ')}): ${f.reason}`);
const md = lines.join('\n') + '\n';
process.stdout.write(md);
const out = opt('--out');
if (out) writeFileSync(out, md);
const json = opt('--json');
if (json) writeFileSync(json, JSON.stringify(rows, null, 1) + '\n');
const bad = rows.filter((r) => r.anchor_after.welds45 > r.anchor_before.welds45 || r.anchor_after.u45 !== r.anchor_before.u45);
if (bad.length) {
  console.error(`remerge-verify: ${bad.length} unit(s) broke the ComCat anchor: ${bad.map((r) => r.label).join(', ')}`);
  process.exit(1);
}
