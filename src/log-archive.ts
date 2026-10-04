import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { REPO, dataPaths } from './config.js';
import { gh, ghRetry, ghRetryNet, sleepMs } from './gh.js';

/**
 * LIVE-2: the run logs leave the data branch's tree once their month is over (2026-10-04, owner answer 7 of the
 * engineering assessment). `status/history/YYYY-MM.ndjson` (one line per aggregate run, ~25 MB a month) and
 * `changes/YYYY-MM-DD.ndjson` (derive's change log, one file a day) were kept forever, so the tree every run checks out
 * grew by ~40 MB a month and every aggregate commit rewrote a month file of up to 25 MB. Nothing reads a finished
 * month (the Pages / R2 change log is the current day's file; status history is a record).
 *
 * A finished month's files become IMMUTABLE gzip Release assets in the release `logs-YYYY-MM` (one asset per file:
 * `status-history-YYYY-MM.ndjson.gz`, `changes-YYYY-MM-DD.ndjson.gz`), indexed in `knowledge/index/log_archives.json`
 * with the sha-256 of the asset and of its content, and the tree file is removed only after the uploaded asset was
 * downloaded back and both hashes matched (the verify-then-remove order of archive.ts). An asset is never replaced: an
 * asset of that name already in the release (a run that uploaded and died before its commit) is adopted only when its
 * content is byte-identical to the tree file, else the month is blocked and the file stays. History is never
 * rewritten; only the current month (and the first day of the next, LOG_ARCHIVE_GRACE_MS) stays in the tree.
 */
export const LOG_ARCHIVE_GRACE_MS = 86_400_000;
export const LOG_ARCHIVE_MAX_FILES = Number(process.env.LOG_ARCHIVE_MAX_FILES ?? 60);

export type LogKind = 'status_history' | 'changes';

export interface LogFile {
  kind: LogKind;
  /** Absolute path in the tree. */
  path: string;
  /** Path relative to the data root (what the index records). */
  file: string;
  /** YYYY-MM the file belongs to. */
  period: string;
}

export interface LogArchiveEntry {
  kind: LogKind;
  file: string;
  period: string;
  tag: string;
  asset: string;
  url: string;
  bytes: number;
  sha256: string;
  content_bytes: number;
  content_sha256: string;
  lines: number;
  archived_at: string;
}

export interface LogArchiveIndex {
  schema: 1;
  entries: LogArchiveEntry[];
}

/** The Release operations the pass needs (gh in production, a stub in tests). */
export interface ReleaseIo {
  ensureRelease(tag: string, notes: string): void;
  /** The release's assets (name, size); [] when the release has none. */
  assets(tag: string): { name: string; size: number }[];
  /** Upload WITHOUT replacing: an asset of that name must not exist. */
  upload(tag: string, file: string): void;
  download(tag: string, asset: string, out: string): void;
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const countLines = (b: Buffer): number => b.toString('utf8').split('\n').filter((l) => l.trim()).length;

/** Is the month over, by at least the grace (no writer can still append to it)? */
export function isFinishedMonth(period: string, nowMs: number): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return false;
  const nextMonthStart = Date.UTC(Number(m[1]), Number(m[2]), 1); // month index = MM → the following month
  return nowMs >= nextMonthStart + LOG_ARCHIVE_GRACE_MS;
}

/** `status-history-YYYY-MM.ndjson.gz` / `changes-YYYY-MM-DD.ndjson.gz`, from the tree file's own name. */
export const assetName = (f: Pick<LogFile, 'kind' | 'file'>): string =>
  `${f.kind === 'status_history' ? 'status-history' : 'changes'}-${basename(f.file, '.ndjson')}.ndjson.gz`;
export const logTag = (period: string): string => `logs-${period}`;

/** The tree's run-log files of finished months, oldest first. */
export function logFilesToArchive(root: string, nowMs: number): LogFile[] {
  const p = dataPaths(root);
  const out: LogFile[] = [];
  if (existsSync(p.statusHistoryDir)) {
    for (const f of readdirSync(p.statusHistoryDir)) {
      const m = /^(\d{4}-\d{2})\.ndjson$/.exec(f);
      if (m && isFinishedMonth(m[1]!, nowMs)) out.push({ kind: 'status_history', path: join(p.statusHistoryDir, f), file: relative(root, join(p.statusHistoryDir, f)), period: m[1]! });
    }
  }
  if (existsSync(p.changesDir)) {
    for (const f of readdirSync(p.changesDir)) {
      const m = /^((\d{4}-\d{2})-\d{2})\.ndjson$/.exec(f);
      if (m && isFinishedMonth(m[2]!, nowMs)) out.push({ kind: 'changes', path: join(p.changesDir, f), file: relative(root, join(p.changesDir, f)), period: m[2]! });
    }
  }
  return out.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export function loadLogArchives(root: string): LogArchiveIndex {
  const f = dataPaths(root).logArchivesIndex;
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as LogArchiveIndex) : { schema: 1, entries: [] };
}

export function saveLogArchives(root: string, idx: LogArchiveIndex): void {
  idx.entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  writeFileSync(dataPaths(root).logArchivesIndex, JSON.stringify(idx, null, 2) + '\n');
}

export interface LogArchiveResult {
  archived: LogArchiveEntry[];
  /** Files already archived (index entry, identical content) that were still in the tree: removed. */
  leftoversRemoved: string[];
  /** Asset names found in the release without an index entry, identical to the tree file: adopted. */
  adopted: string[];
  /** Files left in the tree with the reason (the job goes red through archive-blocked.txt). */
  blocked: string[];
}

/**
 * Archive the finished months' run logs (see the module comment). Mutates `index` and the tree; the caller saves the
 * index and commits. `dryRun` reads and plans only: no release is created, nothing is uploaded or removed.
 */
export function archiveLogFiles(
  root: string,
  index: LogArchiveIndex,
  nowMs: number,
  io: ReleaseIo,
  staging: string,
  opts: { maxFiles?: number; dryRun?: boolean; log?: (line: string) => void } = {},
): LogArchiveResult {
  const log = opts.log ?? console.log;
  const maxFiles = opts.maxFiles ?? LOG_ARCHIVE_MAX_FILES;
  const res: LogArchiveResult = { archived: [], leftoversRemoved: [], adopted: [], blocked: [] };
  mkdirSync(staging, { recursive: true });
  const archivedAt = new Date(nowMs).toISOString();
  let n = 0;
  for (const f of logFilesToArchive(root, nowMs)) {
    const content = readFileSync(f.path);
    const contentSha = sha256(content);
    const known = index.entries.find((e) => e.file === f.file);
    if (known) {
      // Archived by an earlier run whose tree removal did not land: remove it now if it is the same bytes.
      if (known.content_sha256 === contentSha) {
        if (!opts.dryRun) rmSync(f.path);
        res.leftoversRemoved.push(f.file);
      } else {
        res.blocked.push(`${f.file}: differs from its archived copy ${known.tag}/${known.asset} (content sha ${known.content_sha256.slice(0, 12)} vs ${contentSha.slice(0, 12)}); left in the tree`);
      }
      continue;
    }
    if (n >= maxFiles) {
      log(`log-archive: reached the per-run cap (${maxFiles}); the rest rolls next run`);
      break;
    }
    n++;
    const tag = logTag(f.period);
    const asset = assetName(f);
    const local = join(staging, asset);
    const gz = gzipSync(content, { level: 9 });
    writeFileSync(local, gz);
    const entry: LogArchiveEntry = {
      kind: f.kind,
      file: f.file,
      period: f.period,
      tag,
      asset,
      url: `https://github.com/${REPO}/releases/download/${tag}/${asset}`,
      bytes: gz.length,
      sha256: sha256(gz),
      content_bytes: content.length,
      content_sha256: contentSha,
      lines: countLines(content),
      archived_at: archivedAt,
    };
    if (opts.dryRun) {
      log(`log-archive: ${f.file} -> ${tag}/${asset} (${(content.length / 1e6).toFixed(2)} MB -> ${(gz.length / 1e6).toFixed(2)} MB, ${entry.lines} lines) [dry-run]`);
      continue;
    }
    io.ensureRelease(tag, `Run logs for ${f.period}: the aggregate status history and the daily change logs, moved out of the data branch's tree when the month ended (immutable; index: knowledge/index/log_archives.json on the data branch).`);
    const back = join(staging, `verify-${asset}`);
    const present = io.assets(tag).some((a) => a.name === asset);
    if (present) {
      // Uploaded by a run that did not commit: adopt it only if its content is exactly the tree file.
      io.download(tag, asset, back);
      const theirs = readFileSync(back);
      let theirContent: Buffer;
      try {
        theirContent = gunzipSync(theirs);
      } catch {
        res.blocked.push(`${f.file}: ${tag}/${asset} exists and is not a readable gzip; never replaced, left in the tree`);
        continue;
      }
      if (sha256(theirContent) !== contentSha) {
        res.blocked.push(`${f.file}: ${tag}/${asset} exists with other content; never replaced, left in the tree`);
        continue;
      }
      entry.bytes = theirs.length;
      entry.sha256 = sha256(theirs);
      res.adopted.push(asset);
    } else {
      try {
        io.upload(tag, local);
      } catch (e) {
        // A retried upload can fail with "already exists" after a first attempt landed: judge by the listing.
        if (!io.assets(tag).some((a) => a.name === asset)) {
          res.blocked.push(`${f.file}: upload of ${tag}/${asset} failed (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); left in the tree`);
          continue;
        }
      }
      io.download(tag, asset, back);
      const theirs = readFileSync(back);
      let ok = sha256(theirs) === entry.sha256;
      if (!ok) {
        // Another run's identical upload won the race: the same content is just as good.
        try {
          ok = sha256(gunzipSync(theirs)) === contentSha;
          if (ok) {
            entry.bytes = theirs.length;
            entry.sha256 = sha256(theirs);
          }
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        res.blocked.push(`${f.file}: ${tag}/${asset} did not verify after upload; left in the tree`);
        continue;
      }
    }
    // Verified: index it, then remove the tree copy.
    index.entries.push(entry);
    rmSync(f.path);
    res.archived.push(entry);
    log(`log-archive: ${f.file} -> ${tag}/${asset} (${(content.length / 1e6).toFixed(2)} MB -> ${(entry.bytes / 1e6).toFixed(2)} MB, ${entry.lines} lines)${present ? ' [adopted]' : ''}`);
  }
  return res;
}

/** The production ReleaseIo: gh with the archive pass's retry rules. */
export const ghReleaseIo: ReleaseIo = {
  /** Ensure a release tag exists — idempotent under create races / eventual consistency. */
  ensureRelease(tag, notes) {
    try {
      gh(['release', 'view', tag, '-R', REPO]); // bare: "not created yet" is the normal path
      return;
    } catch {
      /* not visible yet — create below */
    }
    try {
      // Retried: this runs once per month (up to 12/run), and a network blip on create used to
      // abort the whole archive run. Not-found is excluded — nothing to wait for on a create.
      ghRetryNet(['release', 'create', tag, '-R', REPO, '--target', 'main', '--title', tag, '--notes', notes]);
    } catch {
      // Lost a create race or it materialized post-consistency; tolerate iff it now exists.
      sleepMs(3_000);
      ghRetryNet(['release', 'view', tag, '-R', REPO]); // rethrows if genuinely absent
    }
  },
  assets(tag) {
    const out = ghRetry(['release', 'view', tag, '-R', REPO, '--json', 'assets', '--jq', '[.assets[] | {name, size}]']);
    return JSON.parse(out || '[]') as { name: string; size: number }[];
  },
  upload(tag, file) {
    ghRetry(['release', 'upload', tag, file, '-R', REPO]);
  },
  download(tag, asset, out) {
    ghRetry(['release', 'download', tag, '-R', REPO, '-p', asset, '-O', out, '--clobber']);
  },
};
