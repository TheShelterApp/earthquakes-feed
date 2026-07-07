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
interface LogArchiveEntry {
  period: string;
  tag: string;
  asset: string;
  bytes: number;
  sha256: string;
  files: number;
}
interface Archives {
  list: ArchiveEntry[];
  log_list?: LogArchiveEntry[];
}

const dayKey = (ms: number): string => isoFromMs(ms).slice(0, 10);
const sha256File = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
const gh = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8' });

/** Block synchronously for `ms` (this whole pipeline is sync execFileSync). */
const sleepMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Run a `gh` command, retrying transient GitHub API failures with backoff. The Releases
 * upload/download endpoints 404 (or 5xx/429) for a short window right after a release is
 * created — GitHub eventual consistency. A bare call then aborts the entire archive run
 * mid-way (2026-01 upload: `HTTP 404 .../releases/<id>/assets`). Non-transient errors
 * still fail loudly on the first try.
 */
function ghRetry(args: string[], attempts = 5): string {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return gh(args);
    } catch (e) {
      lastErr = e;
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error)?.message ?? '');
      // Transient = GitHub eventual consistency / rate / network. `Not Found` (case-
      // insensitive) already covers "release/asset not found"; the crucial addition is the
      // gh-specific "no assets to download" — an `upload --clobber`'s freshly-uploaded asset
      // isn't listed yet when the verify-download runs microseconds later.
      const transient =
        /HTTP (404|429|5\d\d)|rate limit|abuse|timed? ?out|EOF|ECONN|ETIMEDOUT|TLS|handshake|Not Found|no assets? to download|could not find|temporar/i.test(
          msg,
        );
      if (!transient || i === attempts - 1) break;
      const backoff = Math.min(30_000, 2_000 * 2 ** i);
      console.error(`gh ${args[0]} ${args[1]} failed (${i + 1}/${attempts}), retry in ${backoff / 1000}s: ${msg.trim().slice(0, 140)}`);
      sleepMs(backoff);
    }
  }
  throw lastErr;
}

/** Ensure a release tag exists — idempotent under create races / eventual consistency. */
function ensureRelease(tag: string, notes: string): void {
  try {
    gh(['release', 'view', tag, '-R', REPO]);
    return;
  } catch {
    /* not visible yet — create below */
  }
  try {
    gh(['release', 'create', tag, '-R', REPO, '--target', 'main', '--title', tag, '--notes', notes]);
  } catch {
    // Lost a create race or it materialized post-consistency; tolerate iff it now exists.
    sleepMs(3_000);
    gh(['release', 'view', tag, '-R', REPO]); // rethrows if genuinely absent
  }
}

const HAS_ZSTD = (() => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** tar a directory then compress (zstd -19, gzip fallback). Returns {path, asset}. */
function makeTarball(memberDir: string, members: string[], baseName: string): { path: string; asset: string } {
  const base = `${baseName}.tar`;
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

/** Map ingest YYYY-MM -> its observation-log files (knowledge/observations/ingest=YYYY/MM/DD/HH.ndjson). */
function observationMonths(obsDir: string): Map<string, { files: string[]; days: string[]; monthDir: string }> {
  const months = new Map<string, { files: string[]; days: string[]; monthDir: string }>();
  if (!existsSync(obsDir)) return months;
  for (const yEntry of readdirSync(obsDir)) {
    const m = /^ingest=(\d{4})$/.exec(yEntry);
    if (!m) continue;
    const yyyy = m[1]!;
    const yDir = join(obsDir, yEntry);
    for (const mm of readdirSync(yDir)) {
      if (!/^\d{2}$/.test(mm)) continue;
      const monthDir = join(yDir, mm);
      const key = `${yyyy}-${mm}`;
      const e = months.get(key) ?? months.set(key, { files: [], days: [], monthDir }).get(key)!;
      for (const dd of readdirSync(monthDir)) {
        const ddDir = join(monthDir, dd);
        if (!/^\d{2}$/.test(dd)) continue;
        for (const f of readdirSync(ddDir)) {
          if (f.endsWith('.ndjson')) {
            e.files.push(join(ddDir, f));
            if (!e.days.includes(`${key}-${dd}`)) e.days.push(`${key}-${dd}`);
          }
        }
      }
    }
  }
  return months;
}

/** Roll fully-cold ingest-months of the observation log into Release tarballs, then prune. */
function archiveLog(root: string, cutoff: string, archives: Archives, staging: string): number {
  const obsDir = dataPaths(root).observationsDir;
  const done = new Set((archives.log_list ?? []).map((a) => a.period));
  let n = 0;
  for (const [month, { files, days, monthDir }] of [...observationMonths(obsDir).entries()].sort()) {
    if (n >= MAX_MONTHS || done.has(month) || days.some((d) => d >= cutoff)) continue;
    const memberDir = join(staging, `obs-${month}`);
    mkdirSync(memberDir, { recursive: true });
    for (const f of files) cpSync(f, join(memberDir, f.split('/').slice(-3).join('_'))); // YYYY_MM_DD_HH.ndjson? use DD_HH
    const members = readdirSync(memberDir).sort();
    const { path: tarPath, asset } = makeTarball(memberDir, members, `observations-${month}`);
    const tag = `archive-${month}`;
    const bytes = statSync(tarPath).size;
    const sha256 = sha256File(tarPath);
    if (!DRY_RUN) {
      ensureRelease(tag, `Archive for ${month}.`);
      ghRetry(['release', 'upload', tag, tarPath, '-R', REPO, '--clobber']);
      const verify = join(staging, `verify-${asset}`);
      ghRetry(['release', 'download', tag, '-R', REPO, '-p', asset, '-O', verify, '--clobber']);
      if (sha256File(verify) !== sha256) throw new Error(`log archive verify failed for ${month}`);
    }
    (archives.log_list ??= []).push({ period: month, tag, asset, bytes, sha256, files: files.length });
    rmSync(monthDir, { recursive: true, force: true });
    n++;
    console.log(`archive-log: ${month} -> ${asset} (${(bytes / 1e6).toFixed(2)} MB, ${files.length} hours)${DRY_RUN ? ' [dry-run]' : ''}`);
  }
  return n;
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
        ghRetry(['release', 'download', entry.tag, '-R', REPO, '-p', entry.asset, '-O', old, '--clobber']);
        extractTarball(old, memberDir);
      }
      for (const f of files) cpSync(f, join(memberDir, f.slice(-9))); // DD.ndjson

      const members = readdirSync(memberDir).sort();
      const { path: tarPath, asset } = makeTarball(memberDir, members, `events-${month}`);
      const bytes = statSync(tarPath).size;
      const sha256 = sha256File(tarPath);
      const tag = `archive-${month}`;
      const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

      if (!DRY_RUN) {
        ensureRelease(tag, `Archived event partitions for ${month}.`);
        ghRetry(['release', 'upload', tag, tarPath, '-R', REPO, '--clobber']);
        const verify = join(staging, `verify-${asset}`);
        ghRetry(['release', 'download', tag, '-R', REPO, '-p', asset, '-O', verify, '--clobber']);
        if (sha256File(verify) !== sha256) throw new Error(`archive verify failed for ${month}`);
      }

      // Days/count reflect the FULL tarball (old archive + any re-materialized in-tree days
      // on re-roll), derived from the members actually written — not just the in-tree overlay,
      // so the entry stays accurate when a backfilled new source re-rolls a cold month.
      const memberDays = members.filter((m) => m.endsWith('.ndjson'));
      const allDays = memberDays.map((m) => `${month}-${m.slice(0, 2)}`).sort();
      let count = 0;
      for (const m of memberDays) count += readFileSync(join(memberDir, m), 'utf8').split('\n').filter(Boolean).length;
      const next: ArchiveEntry = { period: month, tag, asset, url, bytes, sha256, count, days: allDays, needs_reroll: false };
      const idx = archives.list.findIndex((a) => a.period === month);
      if (idx >= 0) archives.list[idx] = next;
      else archives.list.push(next);

      // Only now (verified) remove the RE-MATERIALIZED in-tree files + their inventory entries
      // (the old-archive days were never in-tree). `days`/`files` are in-tree only.
      for (const f of files) rmSync(f);
      for (const d of days) delete inv[d];
      archived++;
      console.log(`archive: ${month} -> ${asset} (${(bytes / 1e6).toFixed(2)} MB, ${count} events)${DRY_RUN ? ' [dry-run]' : ''}`);
    }

    // Second pass: roll the observation log's cold ingest-months to Releases too.
    const logArchived = archiveLog(root, cutoff, archives, staging);

    saveArchives(root, archives);
    saveInventory(root, inv);
    console.log(`archive: ${archived} event-month(s) + ${logArchived} log-month(s) archived`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main();
