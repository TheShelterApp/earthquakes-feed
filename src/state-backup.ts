import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { REPO } from './config.js';
import { blobSizes, parseGeneration, type Generation } from './event-map-store.js';
import { GC_MAX_WINDOW_DAYS, GENERATION_PATH, githubSources, readBackupMarkerWithGh, type BackupMarker } from './state-gc.js';
import { backendFromEnv, casKey, getBlobs, sha256Hex, type StateBackend } from './state-store.js';

/**
 * The state store's off-Cloudflare backup (state-backup.yml; storage phase 3, APIs.md "Repository size"). For each UTC
 * day D, the state as of 00:00 UTC of D: the generation at the last `data` commit before that midnight, the commit's
 * cursors that go with it (head.json, sweeps.json, watermarks.json, the correction and heal markers, onboard.json), the
 * commit id, and every blob the generation names, in one deterministic tar (sorted members, mtime 0, uid/gid 0, mode
 * 0644: the same state gives the same bytes), zstd at a fixed level, as the asset `state-D.tar.zst` of the draft
 * Release `state-YYYY-MM` (D's month). GitHub does not count Release assets in the repository's size; the daily
 * states stay for ever. A Release is created as a draft and published once its month is over and every day of it with
 * a generation has its asset (GitHub's immutable releases, if ever switched on, freeze a Release at publication).
 *
 * Never --clobber: a name that exists is never replaced. An asset GitHub left incomplete (state other than
 * `uploaded`, or no digest) does not count, and the day is uploaded again as `state-D.g2.tar.zst` (`.g3`, …). Every
 * upload is checked against GitHub's sha256 digest of the asset before it counts.
 *
 * Catch-up: every day without a complete asset, oldest first, from BACKUP_CATCHUP_DAYS back, or further back to the
 * first day the previous marker had not copied (its first_missing, else the day after its newest), at most
 * GC_MAX_WINDOW_DAYS back. GC keeps the daily generations back to that same day (it reads the same marker), so a backup
 * stalled for longer than BACKUP_CATCHUP_DAYS still copies every day GC kept for it. A previous marker that names no day
 * (no generation yet, or the store off) widens the walk to GC_MAX_WINDOW_DAYS (GC holds everything then). A day before
 * the first generation (before phase 3a) has nothing to copy.
 *
 * Publishing a finished month is best effort: a refusal (a tag ruleset, say) is reported and retried by the next run,
 * and never costs the run its marker once every day is copied.
 *
 *   GH_TOKEN=… FEED_STATE_BACKEND=worker npx --no-install tsx src/state-backup.ts
 */

export const BACKUP_CATCHUP_DAYS = 25;
export const BACKUP_ZSTD_LEVEL = 19;
/** The commit's files that go with the generation (absent ones are left out; data_commit.txt lists what was found). */
export const BACKUP_COMPANIONS = [
  'knowledge/index/head.json',
  'knowledge/index/sweeps.json',
  'knowledge/index/watermarks.json',
  'knowledge/index/correction.json',
  'knowledge/index/heal.json',
  'knowledge/index/onboard.json',
] as const;

const DAY_MS = 86_400_000;
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number): string => dayKey(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

// ---------------------------------------------------------------------------------------------------------------------
// A deterministic ustar archive

const BLOCK = 512;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

/** A POSIX ustar archive of `members` (sorted by name; regular files, mode 0644, uid/gid 0, mtime 0, no user names). */
export function writeTar(members: ReadonlyMap<string, Uint8Array>): Buffer {
  const parts: Buffer[] = [];
  for (const name of [...members.keys()].sort()) {
    const data = members.get(name)!;
    if (Buffer.byteLength(name) > 100) throw new Error(`tar: member name over 100 bytes: ${name}`);
    const h = Buffer.alloc(BLOCK, 0);
    h.write(name, 0, 100, 'utf8');
    h.write(octal(0o644, 8), 100, 8, 'latin1');
    h.write(octal(0, 8), 108, 8, 'latin1');
    h.write(octal(0, 8), 116, 8, 'latin1');
    h.write(octal(data.length, 12), 124, 12, 'latin1');
    h.write(octal(0, 12), 136, 12, 'latin1');
    h.write('        ', 148, 8, 'latin1');
    h.write('0', 156, 1, 'latin1');
    h.write('ustar\0', 257, 6, 'latin1');
    h.write('00', 263, 2, 'latin1');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
    parts.push(h, Buffer.from(data), Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK, 0));
  }
  parts.push(Buffer.alloc(2 * BLOCK, 0));
  return Buffer.concat(parts);
}

/** The members of a ustar archive (regular files only; a bad checksum or truncation throws). */
export function readTar(tar: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let pos = 0;
  for (;;) {
    if (pos + BLOCK > tar.length) throw new Error('tar: truncated (no end blocks)');
    const h = tar.subarray(pos, pos + BLOCK);
    if (h.every((b) => b === 0)) break;
    const stored = parseInt(h.toString('latin1', 148, 156).replace(/\0.*$/, '').trim(), 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (stored !== sum) throw new Error(`tar: bad header checksum at ${pos}`);
    const field = (a: number, b: number): string => h.toString('utf8', a, b).replace(/\0.*$/s, '');
    const prefix = field(345, 500);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156]!);
    pos += BLOCK;
    if (pos + size > tar.length) throw new Error(`tar: ${name} truncated`);
    if (type === '0' || type === '\0') out.set(name, Buffer.from(tar.subarray(pos, pos + size)));
    pos += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

export const compressBackup = (tar: Buffer): Buffer => zstdCompressSync(tar, { params: { [zlibConstants.ZSTD_c_compressionLevel]: BACKUP_ZSTD_LEVEL } });
export const decompressBackup = (zst: Buffer): Buffer => zstdDecompressSync(zst);

/** The members of a day's backup (generation.json, data_commit.txt, the companions found, the blobs under cas/). */
export function backupMembers(commit: string, generationText: string, companions: ReadonlyMap<string, Buffer>, blobs: ReadonlyMap<string, Buffer>): Map<string, Uint8Array> {
  const g = parseGeneration(generationText);
  const m = new Map<string, Uint8Array>();
  m.set('generation.json', Buffer.from(generationText));
  m.set('data_commit.txt', Buffer.from(`${commit}\n${[...companions.keys()].sort().join('\n')}${companions.size ? '\n' : ''}`));
  for (const [path, bytes] of companions) m.set(path.replace(/^knowledge\/index\//, ''), bytes);
  for (const e of Object.values(g.days)) {
    const b = blobs.get(e.blob);
    if (!b) throw new Error(`backup: blob ${e.blob} missing`);
    m.set(casKey(e.blob), b);
  }
  return m;
}

/** Check a day's backup (decompressed tar members): the generation parses and every blob it names is there with its
 *  sha256 and size. Returns the generation. Used after building an asset and by scripts/state-restore.ts. */
export function verifyBackup(members: ReadonlyMap<string, Buffer>): { generation: Generation; commit: string } {
  const text = members.get('generation.json');
  if (!text) throw new Error('backup: no generation.json');
  const generation = parseGeneration(text.toString('utf8'));
  const commit = (members.get('data_commit.txt')?.toString('utf8') ?? '').split('\n')[0] ?? '';
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('backup: no commit id in data_commit.txt');
  for (const [day, e] of Object.entries(generation.days)) {
    const b = members.get(casKey(e.blob));
    if (!b) throw new Error(`backup: ${day}'s blob ${e.blob} is not in the archive`);
    if (b.length !== e.blob_bytes || sha256Hex(b) !== e.blob) throw new Error(`backup: ${day}'s blob ${e.blob} does not match the generation`);
  }
  return { generation, commit };
}

// ---------------------------------------------------------------------------------------------------------------------
// Releases

export interface ReleaseAsset {
  name: string;
  size: number;
  state: string;
  /** GitHub's `sha256:<hex>`, or null. */
  digest: string | null;
}

export interface BackupIo {
  commitBefore(iso: string): Promise<string | null>;
  fileAt(ref: string, path: string): Promise<Buffer | null>;
  /** The Release's assets, or null when there is no Release `tag` (drafts included). */
  assets(tag: string): ReleaseAsset[] | null;
  createDraft(tag: string): void;
  upload(tag: string, file: string): void;
  isDraft(tag: string): boolean | null;
  publish(tag: string): void;
}

export const releaseTag = (day: string): string => `state-${day.slice(0, 7)}`;
const ASSET = /^state-(\d{4}-\d{2}-\d{2})(?:\.g(\d+))?\.tar\.zst$/;

/** A complete asset: uploaded, non-empty, with a digest. */
export const completeAsset = (a: ReleaseAsset): boolean => a.state === 'uploaded' && a.size > 0 && typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(a.digest);

/** The day's asset that counts (the first complete one), and the next free name for an upload. */
export function dayAssets(assets: readonly ReleaseAsset[], day: string): { complete: ReleaseAsset | null; nextName: string } {
  let maxGen = 0;
  let complete: ReleaseAsset | null = null;
  for (const a of assets) {
    const m = ASSET.exec(a.name);
    if (!m || m[1] !== day) continue;
    maxGen = Math.max(maxGen, m[2] ? Number(m[2]) : 1);
    if (!complete && completeAsset(a)) complete = a;
  }
  return { complete, nextName: maxGen === 0 ? `state-${day}.tar.zst` : `state-${day}.g${maxGen + 1}.tar.zst` };
}

const gh = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });

/** BackupIo over GitHub (gh, GH_TOKEN with contents: write: draft Releases are listed only to writers). */
export function githubBackupIo(token: string, repo: string = REPO): BackupIo {
  const src = githubSources(token, repo);
  const releaseId = (tag: string): string | null => {
    const id = gh(['api', '--paginate', `repos/${repo}/releases?per_page=100`, '--jq', `.[] | select(.tag_name == "${tag}") | .id`]).trim().split('\n')[0];
    return id || null;
  };
  return {
    commitBefore: (iso) => src.commitBefore(iso),
    async fileAt(ref, path) {
      try {
        return Buffer.from(gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${path}?ref=${ref}`]), 'utf8');
      } catch (e) {
        if (/HTTP 404|Not Found/i.test(String((e as { stderr?: string }).stderr ?? ''))) return null;
        throw e;
      }
    },
    assets(tag) {
      const id = releaseId(tag);
      if (!id) return null;
      const out = gh(['api', '--paginate', `repos/${repo}/releases/${id}/assets?per_page=100`, '--jq', '.[] | [.name, .size, .state, (.digest // "")] | @tsv']);
      return out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [name, size, state, digest] = l.split('\t');
          return { name: name!, size: Number(size), state: state ?? '', digest: digest || null };
        });
    },
    createDraft(tag) {
      gh(['release', 'create', tag, '-R', repo, '--draft', '--latest=false', '--title', tag, '--notes', `Daily states of the earthquakes-feed state store (storage phase 3): state-YYYY-MM-DD.tar.zst holds the generation at the last data commit before 00:00 UTC of that day, its cursors and every blob it names. Format and restore: APIs.md, Repository size.`]);
    },
    upload(tag, file) {
      // No --clobber, ever: an existing name makes the upload fail.
      gh(['release', 'upload', tag, file, '-R', repo]);
    },
    isDraft(tag) {
      const id = releaseId(tag);
      if (!id) return null;
      return gh(['api', `repos/${repo}/releases/${id}`, '--jq', '.draft']).trim() === 'true';
    },
    publish(tag) {
      gh(['release', 'edit', tag, '-R', repo, '--draft=false', '--latest=false']);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The run

export interface BackupResult {
  uploaded: string[];
  /** Days with no generation at their midnight (before phase 3a): nothing to copy. */
  noGeneration: string[];
  failed: { day: string; error: string }[];
  published: string[];
  /** Finished months whose publication failed (retried by the next run; the marker is still written). */
  publishFailed: { tag: string; error: string }[];
  /** The first day this run looked at. */
  from: string;
  /** The newest day with a complete asset, and the oldest day of the window with a generation but none. */
  newest: string | null;
  firstMissing: string | null;
}

/** The first day a run backs up (module comment): BACKUP_CATCHUP_DAYS back, or the previous marker's first uncopied
 *  day when that is older, never more than GC_MAX_WINDOW_DAYS back. */
export function backupFrom(today: string, previous: BackupMarker | null | undefined): string {
  const usual = addDays(today, -BACKUP_CATCHUP_DAYS);
  const oldest = addDays(today, -GC_MAX_WINDOW_DAYS);
  if (!previous) return usual;
  const first = previous.first_missing ?? (previous.newest ? addDays(previous.newest, 1) : oldest);
  return first < usual ? (first < oldest ? oldest : first) : usual;
}

/** Back up every day from backupFrom(today, opts.previous) to today that has no complete asset yet. */
export async function runBackup(
  io: BackupIo,
  backend: StateBackend,
  opts: { nowMs: number; workDir: string; log?: (l: string) => void; previous?: BackupMarker | null },
): Promise<BackupResult> {
  const log = opts.log ?? (() => {});
  const today = dayKey(opts.nowMs);
  const from = backupFrom(today, opts.previous);
  const res: BackupResult = { uploaded: [], noGeneration: [], failed: [], published: [], publishFailed: [], from, newest: null, firstMissing: null };
  const assetsOf = new Map<string, ReleaseAsset[] | null>();
  const assets = (tag: string): ReleaseAsset[] | null => {
    if (!assetsOf.has(tag)) assetsOf.set(tag, io.assets(tag));
    return assetsOf.get(tag)!;
  };
  for (let day = from; day <= today; day = addDays(day, 1)) {
    const tag = releaseTag(day);
    const held = dayAssets(assets(tag) ?? [], day);
    if (held.complete) {
      res.newest = day;
      continue;
    }
    try {
      const commit = await io.commitBefore(`${day}T00:00:00Z`);
      const genBytes = commit ? await io.fileAt(commit, GENERATION_PATH) : null;
      if (!commit || !genBytes) {
        res.noGeneration.push(day);
        continue;
      }
      const text = genBytes.toString('utf8');
      const g = parseGeneration(text);
      const companions = new Map<string, Buffer>();
      for (const p of BACKUP_COMPANIONS) {
        const b = await io.fileAt(commit, p);
        if (b) companions.set(p, b);
      }
      const blobs = await getBlobs(backend, Object.values(g.days).map((e) => e.blob), { sizes: blobSizes(g) });
      const zst = compressBackup(writeTar(backupMembers(commit, text, companions, blobs)));
      verifyBackup(readTar(decompressBackup(zst)));
      const file = join(opts.workDir, held.nextName);
      writeFileSync(file, zst);
      if (assets(tag) == null) {
        io.createDraft(tag);
        assetsOf.delete(tag);
      }
      io.upload(tag, file);
      assetsOf.delete(tag);
      const up = (assets(tag) ?? []).find((a) => a.name === held.nextName);
      const want = `sha256:${createHash('sha256').update(zst).digest('hex')}`;
      if (!up || !completeAsset(up) || up.digest !== want || up.size !== zst.length) {
        throw new Error(`the uploaded ${held.nextName} reads back as ${up ? `${up.state}, ${up.size} bytes, ${up.digest}` : 'absent'}, expected ${zst.length} bytes, ${want}`);
      }
      res.uploaded.push(day);
      res.newest = day;
      log(`state backup ${day}: ${tag}/${held.nextName}, ${Object.keys(g.days).length} day blob(s), ${(zst.length / 1e6).toFixed(1)} MB, data commit ${commit.slice(0, 12)}`);
    } catch (e) {
      res.failed.push({ day, error: e instanceof Error ? e.message : String(e) });
      res.firstMissing ??= day;
      log(`::error title=State backup::${day}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Publish each draft month that is over and complete: every day of it has a complete asset or no generation.
  const months = new Set<string>();
  for (let day = addDays(from, -31); day < `${today.slice(0, 7)}-01`; day = addDays(day, 1)) months.add(day.slice(0, 7));
  for (const month of [...months].sort()) {
    const tag = `state-${month}`;
    try {
      if (io.isDraft(tag) !== true) continue;
      let complete = true;
      for (let day = `${month}-01`; day.startsWith(month); day = addDays(day, 1)) {
        if (dayAssets(assets(tag) ?? [], day).complete) continue;
        const commit = await io.commitBefore(`${day}T00:00:00Z`);
        if (commit && (await io.fileAt(commit, GENERATION_PATH))) {
          complete = false;
          break;
        }
      }
      if (complete) {
        io.publish(tag);
        res.published.push(tag);
        log(`state backup: ${tag} is complete and published`);
      }
    } catch (e) {
      // Every day's asset is already uploaded and verified: a month that cannot be published (yet) stays a draft, the
      // next run tries again, and the run keeps its marker.
      const error = e instanceof Error ? e.message : String(e);
      res.publishFailed.push({ tag, error });
      log(`::warning title=State backup::${tag} could not be published (it stays a draft; the next run tries again): ${error}`);
    }
  }
  return res;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const token = env.GH_TOKEN;
  const backend = backendFromEnv(env);
  if (!backend) {
    // The store is off (FEED_STATE_BACKEND off or unset): nothing to copy. The marker names no day,
    // so health ages it by its own date (feed:state-backup) and GC reads it as no backup (a hold).
    console.log('state backup: the state store is off (FEED_STATE_BACKEND off): nothing copied');
    if (env.STATE_BACKUP_MARKER_DIR) {
      mkdirSync(env.STATE_BACKUP_MARKER_DIR, { recursive: true });
      const marker = { ok: true, off: true, at: new Date().toISOString(), run_id: env.GITHUB_RUN_ID, newest: null, first_missing: null, uploaded: [], published: [] };
      writeFileSync(join(env.STATE_BACKUP_MARKER_DIR, 'state-backup.json'), `${JSON.stringify(marker, null, 2)}\n`);
    }
    return 0;
  }
  if (!token) {
    console.error('::error::state backup: GH_TOKEN must be set');
    return 3;
  }
  const work = mkdtempSync(join(tmpdir(), 'state-backup-'));
  try {
    const nowMs = Date.now();
    // The previous marker (of a trusted run only): how far back the copying has to reach (backupFrom).
    const previous = readBackupMarkerWithGh();
    const r = await runBackup(githubBackupIo(token), backend, { nowMs, workDir: work, log: (l) => console.log(l), previous });
    const summary =
      `uploaded ${r.uploaded.length} day(s)${r.uploaded.length ? ` (${r.uploaded.join(', ')})` : ''}; newest ${r.newest ?? 'none'}` +
      `${r.noGeneration.length ? `; ${r.noGeneration.length} day(s) before the first generation` : ''}` +
      `${r.published.length ? `; published ${r.published.join(', ')}` : ''}${r.publishFailed.length ? `; NOT PUBLISHED ${r.publishFailed.map((f) => f.tag).join(', ')}` : ''}` +
      `${r.failed.length ? `; FAILED ${r.failed.map((f) => f.day).join(', ')}` : ''}; from ${r.from}`;
    console.log(`state backup: ${summary}`);
    if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `### State backup\n\n${summary}\n`, { flag: 'a' });
    if (env.STATE_BACKUP_MARKER_DIR && !r.failed.length) {
      mkdirSync(env.STATE_BACKUP_MARKER_DIR, { recursive: true });
      const marker = { ok: true, at: new Date(nowMs).toISOString(), run_id: env.GITHUB_RUN_ID, newest: r.newest, first_missing: r.firstMissing, uploaded: r.uploaded, published: r.published, publish_failed: r.publishFailed, from: r.from };
      writeFileSync(join(env.STATE_BACKUP_MARKER_DIR, 'state-backup.json'), `${JSON.stringify(marker, null, 2)}\n`);
    }
    return r.failed.length ? 1 : 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`::error::state backup: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
