import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, dataPaths } from './config.js';
import { withinShrinkTolerance } from './gh.js';
import { type ReleaseIo, archiveLogFiles, ghReleaseIo, loadLogArchives, saveLogArchives } from './log-archive.js';
import { loadInventory, saveInventory } from './partitions.js';
import { createTar } from './tar.js';
import { isoFromMs } from './util.js';

const DAY = 86_400_000;

export interface ArchiveOptions {
  /** Months whose every day is older than this many days are cold (default 120). */
  hotDays: number;
  /** Cap months per run so a run stays short and doesn't hog the shared writer group (default 12). */
  maxMonths: number;
  /** Plan only: nothing is uploaded, indexed or removed (ARCHIVE_DRY_RUN=1). */
  dryRun: boolean;
  /** ARCHIVE_ALLOW_SHRINK=1: a re-roll may publish fewer events (a retracted source). */
  allowShrink: boolean;
  /** Where archive-blocked.txt goes (the workspace root, never the data checkout). */
  markerDir: string;
}

const optionsFromEnv = (): ArchiveOptions => ({
  hotDays: Number(process.env.ARCHIVE_HOT_DAYS ?? 120),
  maxMonths: Number(process.env.ARCHIVE_MAX_MONTHS ?? 12),
  dryRun: process.env.ARCHIVE_DRY_RUN === '1',
  allowShrink: process.env.ARCHIVE_ALLOW_SHRINK === '1',
  markerDir: process.cwd(),
});

/** The Release operations of the archive passes (gh in production, a stub in tests). No pass replaces an asset (C5,
 *  2026-11-08): a re-roll uploads under the next free name (`events-YYYY-MM.e<N>.tar.zst`; the unsuffixed asset is
 *  edition 1) and the previous asset stays where it is, listed in the entry's `previous[]`. */
export type ArchiveIo = ReleaseIo;
export const ghArchiveIo: ArchiveIo = ghReleaseIo;

/** A month's earlier asset (archives.json `previous[]`, newest first): a re-roll, a re-merge (src/remerge-archives.ts),
 *  or one withdrawn by scripts/remerge-rollback.ts. Never deleted. */
export interface PreviousAsset {
  asset: string;
  sha256: string;
  bytes: number;
  count: number;
  edition: number;
  /** The asset's days, when they may differ from the entry's (a re-merge can empty a day). */
  days?: string[];
  merge_epoch?: number;
  withdrawn_at?: string;
  reason?: string;
}

/** A remediation edition a re-merged archive month includes (src/remerge-archives.ts). */
export interface ArchiveRemediationRef {
  day: string;
  edition: number;
  sha256: string;
}

export interface ArchiveEntry {
  period: string;
  tag: string;
  asset: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Lines in the asset, every state. */
  count: number;
  days: string[];
  needs_reroll?: boolean;
  /** The asset's edition: 1 = the unsuffixed asset, N = `events-YYYY-MM.eN.tar.zst`. Absent = 1. */
  edition?: number;
  /** The re-merge epoch the asset is merged to (src/remerge-archives.ts); absent = never merged. A re-roll clears it. */
  merge_epoch?: number;
  /** config REMERGE_RULES the asset was merged under (absent = 1); an older value is merged again. */
  merge_rules?: number;
  /** A merged asset: its live and superseded lines, the asset it was merged from, and the remediation days it took. */
  live?: number;
  superseded?: number;
  built_on?: { asset: string; sha256: string; count: number };
  remediation?: ArchiveRemediationRef[];
  previous?: PreviousAsset[];
}

/** An asset of an `archive-YYYY-MM` Release that no entry uses (an upload whose index commit never landed and that
 *  could not be adopted): never reused, never deleted. */
export interface ArchiveUnused {
  tag: string;
  asset: string;
  reason: string;
  seen_at: string;
}
interface LogArchiveEntry {
  period: string;
  tag: string;
  asset: string;
  bytes: number;
  sha256: string;
  files: number;
}
export interface Archives {
  list: ArchiveEntry[];
  log_list?: LogArchiveEntry[];
  unused?: ArchiveUnused[];
}

/** `<base>.tar.<ext>` for edition 1, `<base>.e<N>.tar.<ext>` after it. */
export const archiveAssetName = (base: string, edition: number, ext: string): string => `${base}${edition > 1 ? `.e${edition}` : ''}.tar.${ext}`;

/** The first edition from `from` whose name is not taken in the Release (assets are never replaced). */
export function nextFreeEdition(names: ReadonlySet<string>, base: string, ext: string, from = 1): number {
  let n = Math.max(1, from);
  while (names.has(archiveAssetName(base, n, ext))) n++;
  return n;
}

/** Upload without replacing. A retried upload can fail with "already exists" after a first attempt landed: judged by
 *  the listing; the caller's read-back verifies the bytes. */
export function uploadNew(io: ReleaseIo, tag: string, file: string): void {
  try {
    io.upload(tag, file);
  } catch (e) {
    const name = file.split('/').pop()!;
    if (!io.assets(tag).some((a) => a.name === name)) throw e;
  }
}

const dayKey = (ms: number): string => isoFromMs(ms).slice(0, 10);
const sha256File = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

const HAS_ZSTD = (() => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const TAR_EXT = HAS_ZSTD ? 'zst' : 'gz';

/** tar a directory (deterministically, src/tar.ts) then compress (zstd -19, gzip fallback). Returns {path, asset}.
 *  `name` is the asset name without `.tar.<ext>`. */
export function makeTarball(memberDir: string, members: string[], name: string): { path: string; asset: string } {
  const base = `${name}.tar`;
  const tar = join(memberDir, '..', base);
  createTar(tar, memberDir, members);
  if (HAS_ZSTD) {
    execFileSync('zstd', ['-19', '-q', '-f', '--rm', tar]);
    return { path: `${tar}.zst`, asset: `${base}.zst` };
  }
  execFileSync('gzip', ['-9', '-f', '-n', tar]);
  return { path: `${tar}.gz`, asset: `${base}.gz` };
}

/** Extract an archive asset (.tar.zst or .tar.gz) into a directory. */
export function extractTarball(file: string, intoDir: string): void {
  if (file.endsWith('.zst')) {
    const tar = file.replace(/\.zst$/, '');
    execFileSync('zstd', ['-d', '-q', '-f', file, '-o', tar]);
    execFileSync('tar', ['-xf', tar, '-C', intoDir]);
  } else {
    execFileSync('tar', ['-xzf', file, '-C', intoDir]);
  }
}

export function loadArchives(root: string): Archives {
  const f = dataPaths(root).archivesIndex;
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Archives) : { list: [] };
}
export function saveArchives(root: string, a: Archives): void {
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

/** The asset names of a Release; empty when it does not exist yet. */
function listNames(io: ReleaseIo, tag: string): Set<string> {
  try {
    return new Set(io.assets(tag).map((a) => a.name));
  } catch {
    return new Set();
  }
}

/** Roll fully-cold ingest-months of the observation log into Release tarballs, then prune. */
function archiveLog(root: string, cutoff: string, archives: Archives, staging: string, io: ArchiveIo, opts: ArchiveOptions): number {
  const obsDir = dataPaths(root).observationsDir;
  const done = new Set((archives.log_list ?? []).map((a) => a.period));
  let n = 0;
  for (const [month, { files, days, monthDir }] of [...observationMonths(obsDir).entries()].sort()) {
    if (n >= opts.maxMonths || done.has(month) || days.some((d) => d >= cutoff)) continue;
    const memberDir = join(staging, `obs-${month}`);
    mkdirSync(memberDir, { recursive: true });
    for (const f of files) cpSync(f, join(memberDir, f.split('/').slice(-3).join('_'))); // YYYY_MM_DD_HH.ndjson? use DD_HH
    const members = readdirSync(memberDir).sort();
    const tag = `archive-${month}`;
    // The next free name: an upload of an earlier run whose index commit never landed is never replaced.
    const taken = opts.dryRun ? new Set<string>() : listNames(io, tag);
    const name = archiveAssetName(`observations-${month}`, nextFreeEdition(taken, `observations-${month}`, TAR_EXT), TAR_EXT).replace(/\.tar\.(zst|gz)$/, '');
    const { path: tarPath, asset } = makeTarball(memberDir, members, name);
    const bytes = statSync(tarPath).size;
    const sha256 = sha256File(tarPath);
    if (!opts.dryRun) {
      io.ensureRelease(tag, `Archive for ${month}.`);
      uploadNew(io, tag, tarPath);
      const verify = join(staging, `verify-${asset}`);
      io.download(tag, asset, verify);
      if (sha256File(verify) !== sha256) throw new Error(`log archive verify failed for ${month}`);
    }
    // Same as the event pass: indexing + pruning the log month are the mutating half, so a
    // DRY_RUN preview must not do them (it was deleting the observation hours it only previewed).
    if (!opts.dryRun) {
      (archives.log_list ??= []).push({ period: month, tag, asset, bytes, sha256, files: files.length });
      rmSync(monthDir, { recursive: true, force: true });
    }
    n++;
    console.log(`archive-log: ${month} -> ${asset} (${(bytes / 1e6).toFixed(2)} MB, ${files.length} hours)${opts.dryRun ? ' [dry-run]' : ''}`);
  }
  return n;
}

export interface ArchiveResult {
  archived: string[];
  logArchived: number;
  runLogs: number;
  blocked: string[];
  /** Every cold month was looked at (the per-run cap did not stop the run): `blocked` is then every standing block, and
   *  archive.yml uploads a '#' marker when it is empty (SHLTR-151). A blocked month keeps needs_reroll (or stays in the
   *  tree) and is tried, and reported, again by every run. */
  complete: boolean;
}

/**
 * The archive run (archive.yml): cold event months, cold observation-log months, finished run-log months. Every
 * Release call goes through `io`, so the decisions (which month, verify before index and prune, the shrink guard, dry
 * run) are tested with a stub (tests/archive.test.ts).
 */
export function runArchive(root: string, nowMs: number, io: ArchiveIo, opts: ArchiveOptions): ArchiveResult {
  const cutoff = dayKey(nowMs - opts.hotDays * DAY);
  const months = eventMonths(dataPaths(root).eventsDir);
  const archives = loadArchives(root);
  const inv = loadInventory(root);
  const shards = shardDays(root);
  const staging = mkdtempSync(join(tmpdir(), 'efd-archive-'));
  let archived = 0;
  const archivedMonths: string[] = [];
  const blocked: string[] = [];
  let complete = true;

  try {
    for (const [month, { days, files }] of [...months.entries()].sort()) {
      if (archived >= opts.maxMonths) {
        console.log(`archive: reached per-run cap (${opts.maxMonths}); remaining months roll next run`);
        complete = false;
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
      // Re-roll: extract the old archive first so in-tree days overlay it (in-tree wins). Done
      // under DRY_RUN too — the download is read-only, and without it memberDir holds the in-tree
      // overlay alone, which makes both the preview and the shrink guard below meaningless.
      if (entry?.needs_reroll) {
        // Own dir, original basename: `gh release upload` names the asset after the file, so the
        // prior copy must keep its name — and must NOT sit at staging/<asset>, which makeTarball
        // overwrites with the new tarball.
        const old = join(staging, 'prior', entry.asset);
        mkdirSync(join(staging, 'prior'), { recursive: true });
        try {
          io.download(entry.tag, entry.asset, old);
          extractTarball(old, memberDir);
          // A merged asset's metadata (`_archive.json`) describes that asset only: the re-roll is merged again.
          for (const m of readdirSync(memberDir)) if (m.startsWith('_') && m.endsWith('.json')) rmSync(join(memberDir, m));
        } catch (e) {
          // The prior asset is gone or unreadable — e.g. (before 2026-11-08, when re-rolls replaced the asset) a failed
          // `upload --clobber` deleted it before the re-upload landed (2026-01). Recover IFF the tree already holds every day the entry
          // claims: re-materialized re-roll days are COMPLETE merged days, so an in-tree
          // superset of entry.days fully replaces the lost asset. If any archived day is
          // missing from the tree, skip the month (keep needs_reroll + in-tree) rather than
          // rebuild a partial archive that would silently drop those days.
          const inTreeDays = new Set(files.map((f) => `${month}-${f.slice(-9, -7)}`));
          const missing = (entry.days ?? []).filter((d) => !inTreeDays.has(d));
          if (missing.length) {
            console.error(
              `::error::cannot re-roll ${month}: prior asset ${entry.asset} unavailable and ${missing.length} archived day(s) not in tree (${missing.slice(0, 3).join(', ')}…); leaving in place for recovery`,
            );
            rmSync(memberDir, { recursive: true, force: true });
            blocked.push(`${month}: prior asset ${entry.asset} unavailable and ${missing.length} archived day(s) not in tree (${missing.slice(0, 3).join(', ')})`);
            continue;
          }
          console.warn(
            `::warning::re-roll ${month}: prior asset ${entry.asset} lost; rebuilding from ${files.length} in-tree day(s) (complete superset of the ${entry.days?.length ?? 0} archived day(s))`,
          );
          // fall through with an empty memberDir — the in-tree copy below is authoritative.
        }
      }
      for (const f of files) cpSync(f, join(memberDir, f.slice(-9))); // DD.ndjson

      const members = readdirSync(memberDir).sort();
      // Days/count reflect the FULL tarball (old archive + any re-materialized in-tree days
      // on re-roll), derived from the members actually written — not just the in-tree overlay,
      // so the entry stays accurate when a backfilled new source re-rolls a cold month. Computed
      // BEFORE the upload because `count` is what the shrink guard below decides on.
      const memberDays = members.filter((m) => m.endsWith('.ndjson'));
      const allDays = memberDays.map((m) => `${month}-${m.slice(0, 2)}`).sort();
      let count = 0;
      for (const m of memberDays) count += readFileSync(join(memberDir, m), 'utf8').split('\n').filter(Boolean).length;

      // A re-roll must never publish FEWER events than the entry it replaces. When backfill
      // could not read a month back from its Release it rewrote those days from fresh provider
      // rows alone, and the next re-roll made the truncation authoritative — silently, green
      // (2026-07: 2025-12 45181 -> 29319, 2026-01 41818 -> 26264). A retracted source is the
      // only legitimate shrink, hence the escape hatch. Applies under DRY_RUN too — previewing a
      // re-roll without this check is exactly how the truncation looked safe.
      if (entry?.count && !withinShrinkTolerance(entry.count, count) && !opts.allowShrink) {
        console.error(
          `::error::refusing to re-roll ${month}: ${entry.count} -> ${count} events (-${entry.count - count}); keeping the published asset + index entry (ARCHIVE_ALLOW_SHRINK=1 overrides if the shrink is real)`,
        );
        blocked.push(`${month}: refused shrink ${entry.count} -> ${count} events (-${entry.count - count})`);
        continue;
      }

      const tag = `archive-${month}`;
      // Never --clobber (C5): the next free name after the entry's edition and every asset in the Release, so a re-roll
      // leaves the published asset where it is (2026-07-07: a failed `--clobber` left 2026-01 without an asset for 10.7 h)
      // and an upload whose index commit never landed is never overwritten.
      const taken = listNames(io, tag);
      const edition = nextFreeEdition(taken, `events-${month}`, TAR_EXT, entry ? (entry.edition ?? 1) + 1 : 1);
      const name = archiveAssetName(`events-${month}`, edition, TAR_EXT).replace(/\.tar\.(zst|gz)$/, '');
      const { path: tarPath, asset } = makeTarball(memberDir, members, name);
      const bytes = statSync(tarPath).size;
      const sha256 = sha256File(tarPath);
      const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

      if (!opts.dryRun) {
        io.ensureRelease(tag, `Archived event partitions for ${month}.`);
        uploadNew(io, tag, tarPath);
        const verify = join(staging, `verify-${asset}`);
        io.download(tag, asset, verify);
        if (sha256File(verify) !== sha256) throw new Error(`archive verify failed for ${month}`);
      }

      // Index + prune are the mutating half, so DRY_RUN stops here: without this it rewrote the
      // entry (count/bytes/sha256 of a tarball it never uploaded) and deleted the in-tree days,
      // leaving archives.json — which derive copies verbatim into the published manifest —
      // advertising a checksum no consumer could match.
      if (!opts.dryRun) {
        // The new asset is not merged (merge_epoch absent): remerge.yml merges it again. The one it replaces is listed.
        const previous: PreviousAsset[] = entry
          ? [
              { asset: entry.asset, sha256: entry.sha256, bytes: entry.bytes, count: entry.count, edition: entry.edition ?? 1, days: entry.days, ...(entry.merge_epoch != null ? { merge_epoch: entry.merge_epoch } : {}) },
              ...(entry.previous ?? []),
            ]
          : [];
        const next: ArchiveEntry = {
          period: month, tag, asset, url, bytes, sha256, count, days: allDays, needs_reroll: false,
          ...(edition > 1 ? { edition } : {}),
          ...(previous.length ? { previous } : {}),
        };
        const idx = archives.list.findIndex((a) => a.period === month);
        if (idx >= 0) archives.list[idx] = next;
        else archives.list.push(next);

        // Only now (verified) remove the RE-MATERIALIZED in-tree files + their inventory entries
        // (the old-archive days were never in-tree). `days`/`files` are in-tree only.
        for (const f of files) rmSync(f);
        for (const d of days) delete inv[d];
      }
      archived++;
      archivedMonths.push(month);
      console.log(`archive: ${month} -> ${asset} (${(bytes / 1e6).toFixed(2)} MB, ${count} events)${opts.dryRun ? ' [dry-run]' : ''}`);
    }

    // A month left stuck (unavailable prior asset, or a refused shrink) keeps needs_reroll and
    // waits for the next run — but it must not hide behind a green job until someone notices.
    // Exiting non-zero HERE would skip the commit step (Actions defaults later steps to
    // `if: success()`), discarding the uploaded assets' index entries and the pruned tree — the
    // run would redo and re-discard the same work forever. So: drop a marker, exit 0, let the
    // commit land, and let a trailing `if: always()` step turn the job red. Workspace root, never
    // .data — a marker under .data would get committed to the data branch.
    // Second pass: roll the observation log's cold ingest-months to Releases too.
    const logArchived = archiveLog(root, cutoff, archives, staging, io, opts);

    // Third pass (LIVE-2, src/log-archive.ts): the finished months' run logs (status/history, changes/) become
    // immutable gzip assets of `logs-YYYY-MM`, verified before the tree copy goes; only the current month stays.
    const logIndex = loadLogArchives(root);
    const runLogs = archiveLogFiles(root, logIndex, nowMs, io, join(staging, 'run-logs'), { dryRun: opts.dryRun });
    for (const b of runLogs.blocked) console.error(`::error::log-archive: ${b}`);
    blocked.push(...runLogs.blocked.map((b) => `run log ${b}`));
    if (!opts.dryRun) saveLogArchives(root, logIndex);

    if (blocked.length) writeFileSync(join(opts.markerDir, 'archive-blocked.txt'), blocked.join('\n') + '\n');

    saveArchives(root, archives);
    saveInventory(root, inv);
    console.log(
      `archive: ${archived} event-month(s) + ${logArchived} log-month(s) + ${runLogs.archived.length} run-log file(s) archived` +
        (runLogs.adopted.length ? `, ${runLogs.adopted.length} adopted` : '') +
        (runLogs.leftoversRemoved.length ? `, ${runLogs.leftoversRemoved.length} leftover(s) removed` : '') +
        (blocked.length ? `, ${blocked.length} blocked` : ''),
    );
    return { archived: archivedMonths, logArchived, runLogs: runLogs.archived.length, blocked, complete };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = runArchive(dataPaths().root, Date.now(), ghArchiveIo, optionsFromEnv());
  // archive.yml uploads a '#' marker (nothing blocked) only after a run that looked at every cold month.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `complete=${res.complete}\n`);
}
