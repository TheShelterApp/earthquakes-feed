import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, dataPaths } from './config.js';
import { loadInventory, saveInventory } from './partitions.js';
import { isoFromMs } from './util.js';

const DAY = 86_400_000;
const HOT_DAYS = Number(process.env.ARCHIVE_HOT_DAYS ?? 120);
/** Cap months per run so a run stays short and doesn't hog the shared writer group. */
const MAX_MONTHS = Number(process.env.ARCHIVE_MAX_MONTHS ?? 12);
const DRY_RUN = process.env.ARCHIVE_DRY_RUN === '1';

interface ArchiveEntry {
  period: string;
  tag: string;
  asset: string;
  url: string;
  bytes: number;
  sha256: string;
  count: number;
  days: string[];
  needs_reroll?: boolean;
}
interface Archives {
  list: ArchiveEntry[];
}

const dayKey = (ms: number): string => isoFromMs(ms).slice(0, 10);
const sha256File = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
const gh = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8' });

const HAS_ZSTD = (() => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** tar a directory then compress (zstd -19, gzip fallback). Returns {path, asset}. */
function makeTarball(memberDir: string, members: string[], month: string): { path: string; asset: string } {
  const base = `events-${month}.tar`;
  const tar = join(memberDir, '..', base);
  execFileSync('tar', ['-cf', tar, '-C', memberDir, ...members]);
  if (HAS_ZSTD) {
    execFileSync('zstd', ['-19', '-q', '-f', '--rm', tar]);
    return { path: `${tar}.zst`, asset: `${base}.zst` };
  }
  execFileSync('gzip', ['-9', '-f', tar]);
  return { path: `${tar}.gz`, asset: `${base}.gz` };
}

/** Extract an archive asset (.tar.zst or .tar.gz) into a directory. */
function extractTarball(file: string, intoDir: string): void {
  if (file.endsWith('.zst')) {
    const tar = file.replace(/\.zst$/, '');
    execFileSync('zstd', ['-d', '-q', '-f', file, '-o', tar]);
    execFileSync('tar', ['-xf', tar, '-C', intoDir]);
  } else {
    execFileSync('tar', ['-xzf', file, '-C', intoDir]);
  }
}

function loadArchives(root: string): Archives {
  const f = dataPaths(root).archivesIndex;
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Archives) : { list: [] };
}
function saveArchives(root: string, a: Archives): void {
  a.list.sort((x, y) => (x.period < y.period ? -1 : 1));
  writeFileSync(dataPaths(root).archivesIndex, JSON.stringify(a, null, 2) + '\n');
}

/** Map YYYY-MM -> the day partition files it contains (in the tree). */
function eventMonths(eventsDir: string): Map<string, { days: string[]; files: string[] }> {
  const months = new Map<string, { days: string[]; files: string[] }>();
  if (!existsSync(eventsDir)) return months;
  for (const y of readdirSync(eventsDir)) {
    const yDir = join(eventsDir, y);
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of readdirSync(yDir)) {
      const mDir = join(yDir, m);
      for (const f of readdirSync(mDir)) {
        if (!f.endsWith('.ndjson')) continue;
        const day = `${y}-${m}-${f.slice(0, 2)}`;
        const key = `${y}-${m}`;
        const e = months.get(key) ?? months.set(key, { days: [], files: [] }).get(key)!;
        e.days.push(day);
        e.files.push(join(mDir, f));
      }
    }
  }
  return months;
}

function shardDays(root: string): Set<string> {
  const dir = dataPaths(root).eventMapDir;
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, 10)));
}

function main(): void {
  const root = dataPaths().root;
  const nowMs = Date.now();
  const cutoff = dayKey(nowMs - HOT_DAYS * DAY);
  const months = eventMonths(dataPaths(root).eventsDir);
  const archives = loadArchives(root);
  const inv = loadInventory(root);
  const shards = shardDays(root);
  const staging = mkdtempSync(join(tmpdir(), 'efd-archive-'));
  let archived = 0;

  try {
    for (const [month, { days, files }] of [...months.entries()].sort()) {
      if (archived >= MAX_MONTHS) {
        console.log(`archive: reached per-run cap (${MAX_MONTHS}); remaining months roll next run`);
        break;
      }
      // Only fully-cold months (every day older than the hot window).
      if (days.some((d) => d >= cutoff)) continue;
      const entry = archives.list.find((a) => a.period === month);
      if (entry && !entry.needs_reroll) continue;
      // Safety: 45-day shard horizon << 120-day archive horizon, so this must hold.
      if (days.some((d) => shards.has(d))) {
        console.error(`::error::refusing to archive ${month}: a live event_map shard exists`);
        continue;
      }

      const memberDir = join(staging, month);
      mkdirSync(memberDir, { recursive: true });
      // Re-roll: extract the old archive first so in-tree days overlay it (in-tree wins).
      if (entry?.needs_reroll && !DRY_RUN) {
        const old = join(staging, entry.asset);
        gh(['release', 'download', entry.tag, '-R', REPO, '-p', entry.asset, '-O', old, '--clobber']);
        extractTarball(old, memberDir);
      }
      for (const f of files) cpSync(f, join(memberDir, f.slice(-9))); // DD.ndjson

      const members = readdirSync(memberDir).sort();
      const { path: tarPath, asset } = makeTarball(memberDir, members, month);
      const bytes = statSync(tarPath).size;
      const sha256 = sha256File(tarPath);
      const tag = `archive-${month}`;
      const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

      if (!DRY_RUN) {
        try {
          gh(['release', 'view', tag, '-R', REPO]);
        } catch {
          gh(['release', 'create', tag, '-R', REPO, '--target', 'main', '--title', tag, '--notes', `Archived event partitions for ${month}.`]);
        }
        gh(['release', 'upload', tag, tarPath, '-R', REPO, '--clobber']);
        const verify = join(staging, `verify-${asset}`);
        gh(['release', 'download', tag, '-R', REPO, '-p', asset, '-O', verify, '--clobber']);
        if (sha256File(verify) !== sha256) throw new Error(`archive verify failed for ${month}`);
      }

      const count = days.reduce((n, d) => n + (inv[d]?.count ?? 0), 0);
      const next: ArchiveEntry = { period: month, tag, asset, url, bytes, sha256, count, days: days.sort(), needs_reroll: false };
      const idx = archives.list.findIndex((a) => a.period === month);
      if (idx >= 0) archives.list[idx] = next;
      else archives.list.push(next);

      // Only now (verified) remove the tree files + inventory entries.
      for (const f of files) rmSync(f);
      for (const d of days) delete inv[d];
      archived++;
      console.log(`archive: ${month} -> ${asset} (${(bytes / 1e6).toFixed(2)} MB, ${count} events)${DRY_RUN ? ' [dry-run]' : ''}`);
    }

    saveArchives(root, archives);
    saveInventory(root, inv);
    console.log(`archive: ${archived} month(s) archived`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main();
