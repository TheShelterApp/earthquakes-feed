/**
 * Verify deep-history assets (PF-5j) independently of the run that made them (read-only).
 *
 * Usage:
 *   npx tsx scripts/history-verify.ts <releases dir> <history.json> [--recount]
 *
 *   <releases dir>  assets laid out as <tag>/<asset>: a dry run's HISTORY_OUT/releases, or the `history-YYYY`
 *                   Releases downloaded with `gh release download history-YYYY -D <dir>/history-YYYY`
 *   <history.json>  the index that lists them (HISTORY_OUT/history.json, or the data branch's
 *                   knowledge/index/history.json)
 *   --recount       ask each source with a count service (ComCat) again, one request per raw asset 1.1 s apart, for
 *                   its count of the asset's range today, and compare it with the count recorded at fetch time
 *
 * For every current events edition: every line against schema/feature.schema.json, the day of every event, one event
 * per feed id and per source id, `_edition.json` against the day files, every raw row accounted for (written, joined
 * to the frozen newer neighbour, or under the era's floor), each raw asset's rows against the source's own count, and
 * the checksums the index lists. Across editions: no feed id and no source id in two months. Exits 1 on any error.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EditionMeta, type RawInput, parseRawText } from '../src/history-build.js';
import { allPeriods, loadHistoryConfig } from '../src/history-config.js';
import { HISTORY_USER_AGENT, historyQueryUrl } from '../src/history-fetch.js';
import { currentEdition, parseIndex } from '../src/history-index.js';
import { verifyEdition } from '../src/history-verify.js';
import { loadRegistry } from '../src/providers.js';

const [dir, indexPath, ...flags] = process.argv.slice(2);
if (!dir || !indexPath) {
  console.error('usage: npx tsx scripts/history-verify.ts <releases dir> <history.json> [--recount]');
  process.exit(2);
}
const recount = flags.includes('--recount');
const cfg = loadHistoryConfig();
const registry = loadRegistry();
const idx = parseIndex(readFileSync(indexPath, 'utf8'));
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
const errors: string[] = [];
const work = mkdtempSync(join(tmpdir(), 'efd-history-verify-'));

const raws = new Map<string, RawInput>();
for (const r of idx.raw) {
  const f = join(dir, r.tag, r.asset);
  const s = sha(f);
  if (s !== r.sha256) errors.push(`${r.asset}: checksum ${s}, the index says ${r.sha256}`);
  const { header, rows } = parseRawText(execFileSync('zstd', ['-d', '-q', '-c', f], { maxBuffer: 1 << 30 }).toString('utf8'));
  if (header.rows !== r.rows || header.provider_count !== r.provider_count) errors.push(`${r.asset}: header and index differ`);
  raws.set(r.asset, { asset: r.asset, sha256: s, header, rows });
}

const allIds = new Map<string, string>();
const allKeys = new Map<string, string>();
let totalEvents = 0;
for (const p of allPeriods(cfg)) {
  const e = currentEdition(idx, p.key);
  if (!e) continue;
  const f = join(dir, e.tag, e.asset);
  if (sha(f) !== e.sha256) errors.push(`${e.asset}: checksum differs from the index`);
  const d = join(work, e.asset);
  execFileSync('mkdir', ['-p', d]);
  execFileSync('sh', ['-c', `zstd -d -q -c "$1" | tar -xf - -C "$2"`, 'sh', f, d]);
  const meta = JSON.parse(readFileSync(join(d, '_edition.json'), 'utf8')) as EditionMeta;
  const dayFiles = new Map<string, string>();
  for (const m of readdirSync(d).filter((x) => x.endsWith('.ndjson')).sort()) dayFiles.set(`${p.key}-${m.slice(0, 2)}`, readFileSync(join(d, m), 'utf8'));
  const editionRaws = e.built_from.map((a) => raws.get(a)!);
  const check = verifyEdition(dayFiles, { period: p, boundary: cfg.boundary, archivedDays: new Set(), meta, raws: editionRaws });
  for (const m of check.errors) errors.push(`${e.asset}: ${m}`);
  for (const [day, text] of dayFiles) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const feat = JSON.parse(line) as { id: string; properties: { feed: { provenance: { provider: string; native_id: string }[] } } };
      const prevId = allIds.get(feat.id);
      if (prevId && prevId !== e.asset) errors.push(`${feat.id} is in ${prevId} and ${e.asset}`);
      allIds.set(feat.id, e.asset);
      for (const r of feat.properties.feed.provenance) {
        const k = `${r.provider}:${r.native_id}`;
        const prev = allKeys.get(k);
        if (prev && prev !== e.asset) errors.push(`${k} is in ${prev} and ${e.asset} (${day})`);
        allKeys.set(k, e.asset);
      }
    }
  }
  totalEvents += check.events;
  const counts = editionRaws.map((r) => `${r.header.source} ${r.rows.length} rows / count ${r.header.provider_count ?? 'n/a'}`).join(', ');
  console.log(
    `${p.key} ${e.asset}: ${check.events} events, ${check.rows} rows (${counts}); joined the newer neighbour ${meta.rows.joined_newer}; ` +
      `same-source pairs within 60 s / 10 km ${meta.same_source_near_pairs}; context ${meta.context?.label ?? 'none'}; ${check.errors.length ? 'FAIL' : 'ok'}`,
  );
}
rmSync(work, { recursive: true, force: true });

if (recount) {
  const byId = new Map(registry.map((p) => [p.id, p]));
  for (const r of idx.raw) {
    if (r.provider_count == null) continue;
    const p = byId.get(r.source)!;
    const url = historyQueryUrl(p, Date.parse(r.start), Date.parse(r.end), { limit: 0, minMagnitude: r.fetch_min_magnitude, count: true });
    const res = await fetch(url, { headers: { 'user-agent': HISTORY_USER_AGENT } });
    const n = (JSON.parse(await res.text()) as { count?: number }).count;
    const same = n === r.provider_count;
    console.log(`recount ${r.asset}: the source counts ${n} today, ${r.provider_count} at fetch time (${r.fetched_at}); rows kept ${r.rows}${same ? '' : '  <- differs'}`);
    if (!same) console.log(`::warning::${r.asset}: the source's count moved from ${r.provider_count} to ${n} since the fetch (the catalogue changed; the asset stays as fetched)`);
    await new Promise((res2) => setTimeout(res2, 1100));
  }
}

console.log(`history-verify: ${idx.editions.length} edition(s), ${totalEvents} events in the current editions, ${idx.raw.length} raw asset(s), ${errors.length} error(s)`);
if (errors.length) {
  for (const m of errors.slice(0, 50)) console.error(`✗ ${m}`);
  process.exit(1);
}
