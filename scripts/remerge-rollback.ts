/**
 * Roll back a re-merge epoch (C14; APIs.md, Re-merged history) on a local checkout of the data branch's index files:
 *
 *   npx tsx scripts/remerge-rollback.ts --epoch 1 [--period YYYY-MM,...] --data <data dir> [--dry-run]
 *
 * In production the same function runs in remerge.yml's commit job (input `rollback: <epoch>[:YYYY-MM,...]`), which
 * commits the three files. Set config REMERGE_EPOCH to 0 first (the kill switch), or the next runs merge again.
 *
 * - knowledge/index/archives.json: every entry merged to the epoch goes back to its `previous[0]` asset; the merged asset
 *   stays listed in `previous[]` with `withdrawn_at` and a reason;
 * - knowledge/index/history.json: every edition merged from another (`merged_from`) at the epoch gets `withdrawn`, so
 *   currentEdition falls back to the edition it was merged from;
 * - knowledge/index/remediation.json: every refreshed edition of the epoch gets `withdrawn`.
 *
 * No asset is deleted. Prints what it withdrew; --dry-run writes nothing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archivesText, historyText, remediationText, rollback } from './remerge-commit.mjs';

const args = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const epoch = Number(opt('--epoch'));
const dir = opt('--data');
if (!Number.isInteger(epoch) || epoch < 1 || !dir) {
  console.error('usage: npx tsx scripts/remerge-rollback.ts --epoch <n> [--period YYYY-MM,...] --data <data dir> [--dry-run]');
  process.exit(2);
}
const periods = opt('--period')?.split(',').map((x) => x.trim()).filter(Boolean) ?? null;
const file = (n: string): string => join(dir, 'knowledge/index', n);
const read = (n: string): Record<string, any> | null => (existsSync(file(n)) ? (JSON.parse(readFileSync(file(n), 'utf8')) as Record<string, any>) : null);
const idx = { archives: read('archives.json') as { list: Record<string, any>[] } | null, history: read('history.json') as { editions: Record<string, any>[] } | null, remediation: read('remediation.json') as { editions: Record<string, any>[] } | null };
const res = rollback(idx, epoch, { periods, at: new Date().toISOString(), reason: `rollback of re-merge epoch ${epoch}` });
for (const k of ['archives', 'history', 'remediation'] as const) for (const x of res[k]) console.log(`withdraw ${k}: ${x}`);
for (const p of res.problems) console.error(`problem: ${p}`);
if (!args.includes('--dry-run')) {
  if (idx.archives) writeFileSync(file('archives.json'), archivesText(idx.archives));
  if (idx.history) writeFileSync(file('history.json'), historyText(idx.history));
  if (idx.remediation) writeFileSync(file('remediation.json'), remediationText(idx.remediation));
}
console.log(`remerge-rollback: epoch ${epoch}: ${res.archives.length} archive month(s), ${res.history.length} history edition(s), ${res.remediation.length} remediation edition(s)${args.includes('--dry-run') ? ' (dry run, nothing written)' : ''}`);
if (res.problems.length) process.exit(1);
