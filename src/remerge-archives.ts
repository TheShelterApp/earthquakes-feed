import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { type ArchiveEntry, type ArchiveRemediationRef, type ArchiveUnused, type Archives, archiveAssetName, extractTarball, makeTarball, nextFreeEdition, uploadNew } from './archive.js';
import { featureToNode } from './bitemporal.js';
import { DATA_DIR, REMERGE_EPOCH, REMERGE_INGEST_TIME, REMERGE_MONTHS_PER_RUN, REMERGE_RULES, REPO, dataPaths } from './config.js';
import { type HistoryIndex, currentEdition as currentHistoryEdition } from './history-index.js';
import { type ReleaseIo, ghReleaseIo } from './log-archive.js';
import { loadRegistry } from './providers.js';
import {
  type ContextMeta,
  type MergeMeta,
  type RemergeResult,
  type UnitSnapshot,
  magnitudeCounts,
  mergeMeta,
  remergeGateProblems,
  remergeNodes,
  remergedDayFiles,
  snapshotUnit,
  normalizeUnit,
  usgsResidual,
} from './remerge.js';
import { type EditionRef, type EditionStats, type RemediationIndex, PARTITION_TAG, currentEdition, editionAssetName, editionProblems, emptyRemediationIndex, nextFree, remediationTag } from './remediation.js';
import type { EventNode, ProviderConfig } from './types.js';

/**
 * The archive re-merge (C5; .github/workflows/remerge.yml; APIs.md, Re-merged history). The monthly archives
 * (`archive-YYYY-MM`, backfilled with the merge pass off) are re-merged by src/remerge.ts into new assets
 * `events-YYYY-MM.e<N>.tar.zst` beside the old ones, never replacing them; each remediated day of such a month gets a
 * refreshed remediation edition built on the new asset (so "the highest edition replaces the archived day" stays
 * true). This collect step runs outside the writer lock and writes nothing to the data branch: it uploads, then lists
 * what it did in REMERGE_OUT/pending.json, which the commit job applies compare-and-set (scripts/remerge-commit.mjs).
 *
 *   npx tsx src/remerge-archives.ts
 *
 * Environment:
 *   DATA_DIR              a checkout of the data branch (sparse: knowledge/index/archives.json, remediation.json,
 *                         history.json; the in-tree day files of the newest month's newer context are read with
 *                         `git show`, so a blobless checkout is enough); read only
 *   REMERGE_OUT           output directory (default remerge-out): pending.json, report.json, months/<period>.json (each
 *                         month's merge block and counts, for scripts/remerge-verify.ts)
 *   REMERGE_DRY_RUN=1     nothing is uploaded: the assets go to REMERGE_OUT/releases/<tag>/; pending.json is written
 *                         but the workflow does not commit it
 *   REMERGE_EPOCH_OVERRIDE  dry runs only: merge to this epoch although config REMERGE_EPOCH is lower (the dry runs
 *                         before an epoch is switched on)
 *   REMERGE_NO_WAIT=1     dry runs only: a month does not wait for its newer month to be merged (that month's current
 *                         asset is the newer context), so a sample of months can be reviewed without merging every
 *                         newer month first
 *   REMERGE_MONTHS        months per run (default config REMERGE_MONTHS_PER_RUN)
 *   REMERGE_ONLY          only these months (comma-separated YYYY-MM)
 *   REMERGE_DEADLINE_S    no new month starts after this many seconds (default 2100)
 *
 * A month is selected when its entry is below the epoch and not waiting for a re-roll, newest first; it waits until
 * the next month's archive is merged (merged in this run counts), so a loser never points to an event that a later
 * merge of the newer month retires. A month whose remediated day was built on another asset than the entry's, or that
 * fails a gate, is blocked (remerge-blocked.txt, read by the health workflow as walk-blocked-remerge) and nothing of it
 * is uploaded.
 */

export const ARCHIVE_EDITION_KIND = 'earthquakes-feed/archive-edition';
const DAY = 86_400_000;
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const sha256File = (f: string): string => sha256(readFileSync(f));
const dayShift = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const assetUrl = (tag: string, asset: string): string => `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
const monthEnd = (period: string): number => {
  const [y, m] = period.split('-').map(Number);
  return Date.UTC(y!, m!, 1);
};
const monthStart = (period: string): number => {
  const [y, m] = period.split('-').map(Number);
  return Date.UTC(y!, m! - 1, 1);
};
const textNodes = (text: string): EventNode[] =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => featureToNode(JSON.parse(l)));

/** `_archive.json`, the metadata member of a re-merged archive asset (C8). */
export interface ArchiveEditionMeta {
  kind: typeof ARCHIVE_EDITION_KIND;
  version: 1;
  period: string;
  edition: number;
  built_on: { asset: string; sha256: string; count: number };
  remediation_days: ArchiveRemediationRef[];
  merge: MergeMeta;
  count: number;
  live: number;
  superseded: number;
  days: string[];
}

/** The months a run takes: below the epoch, not waiting for a re-roll, newest first, at most `max`. */
/** Whether an entry is merged to the epoch under the current input rules (config REMERGE_RULES). */
export const archiveIsMerged = (e: Pick<ArchiveEntry, 'merge_epoch' | 'merge_rules'>, epoch: number, rules: number = REMERGE_RULES): boolean =>
  (e.merge_epoch ?? 0) >= epoch && (e.merge_rules ?? 1) >= rules;

export function selectMonths(list: readonly ArchiveEntry[], epoch: number, max: number, only?: ReadonlySet<string>, rules: number = REMERGE_RULES): ArchiveEntry[] {
  if (epoch <= 0) return [];
  return list
    .filter((e) => !archiveIsMerged(e, epoch, rules) && !e.needs_reroll && (!only || only.has(e.period)))
    .sort((a, b) => (a.period < b.period ? 1 : -1))
    .slice(0, Math.max(0, max));
}

export interface PendingMonth {
  period: string;
  base_sha256: string;
  entry: ArchiveEntry;
  remediation_editions: EditionRef[];
}
export interface Pending {
  version: 1;
  epoch: number;
  months: PendingMonth[];
  unused: ArchiveUnused[];
}

export interface MonthReport {
  period: string;
  asset: string | null;
  adopted: boolean;
  before: ReturnType<typeof magnitudeCounts>;
  after: ReturnType<typeof magnitudeCounts>;
  anchor_before: UnitSnapshot['anchor'];
  anchor_after: ReturnType<typeof snapshotUnit>['anchor'];
  folds: number;
  into_newer: number;
  off_unit: number;
  remediation_days: string[];
  windows: number;
  slowest_ms: number;
  ms: number;
  /** Live M4.5+ earthquakes without a usgs row after the merge (remerge.ts usgsResidual). */
  residual?: { near: number; far: number };
  /** The input normalization's counts (remerge.ts normalizeUnit). */
  normalized?: import('./remerge.js').NormalizeCounts;
  /** The unit's days, [first, last]. */
  first_day?: string;
  last_day?: string;
}

export interface RunReport {
  epoch: number;
  dry_run: boolean;
  merged: MonthReport[];
  waiting: string[];
  blocked: string[];
  unused: string[];
  budget: string[];
}

export interface RemergeArchivesCtx {
  root: string;
  out: string;
  work: string;
  io: ReleaseIo;
  dryRun: boolean;
  epoch: number;
  ingestTime: string;
  deadline: number;
  registry: ProviderConfig[];
  archives: Archives;
  remediation: RemediationIndex;
  history: HistoryIndex | null;
  now: () => string;
  /** The in-tree day file of `day` ('' when the data branch has none). Default: the checkout, else `git show`. */
  readTreeDay?: (day: string) => string;
  /** Dry runs only (REMERGE_NO_WAIT=1): a month does not wait for its newer month to be merged. */
  noWait?: boolean;
}

/** The members of a tar asset (DD.ndjson and _*.json), downloaded once per run and checked against `sha`. */
type Members = Map<string, string>;

class AssetCache {
  private readonly cache = new Map<string, Members>();
  constructor(private readonly ctx: RemergeArchivesCtx) {}
  members(tag: string, asset: string, sha: string | null): Members {
    const key = `${tag}/${asset}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const dir = mkdtempSync(join(this.ctx.work, 'asset-'));
    const file = join(dir, asset);
    this.ctx.io.download(tag, asset, file);
    const got = sha256File(file);
    if (sha && got !== sha) throw new Error(`${tag}/${asset} has checksum ${got}, the index says ${sha}`);
    const into = join(dir, 'x');
    mkdirSync(into);
    if (asset.endsWith('.tar.zst') || asset.endsWith('.tar.gz')) extractTarball(file, into);
    const out: Members = new Map();
    for (const m of readdirSync(into).sort()) out.set(m, readFileSync(join(into, m), 'utf8'));
    rmSync(dir, { recursive: true, force: true });
    // A few months at a time: the one being merged and its two neighbours.
    if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, out);
    return out;
  }
  put(tag: string, asset: string, members: Members): void {
    this.cache.set(`${tag}/${asset}`, members);
  }
}

function readTreeDayDefault(root: string, day: string): string {
  const rel = `events/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}.ndjson`;
  const f = join(root, rel);
  if (existsSync(f)) return readFileSync(f, 'utf8');
  try {
    // A blobless sparse checkout: git fetches the one blob.
    return execFileSync('git', ['-C', root, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Context days, each read from where the feed publishes it: an archive month's current asset, a deep-history month's
 *  current edition (before the 3-year layer), else the data branch's day partition. Also the `into_newer` survivors the
 *  sources' merge metadata name (an older unit's anchors). */
function contextDays(ctx: RemergeArchivesCtx, cache: AssetCache, days: string[], merged: ReadonlyMap<string, { asset: string; members: Members }>): { nodes: EventNode[]; meta: ContextMeta | null; intoNewer: string[] } {
  const nodes: EventNode[] = [];
  const labels: string[] = [];
  const shas: string[] = [];
  const found: string[] = [];
  const intoNewer: string[] = [];
  for (const day of days) {
    const period = day.slice(0, 7);
    const a = ctx.archives.list.find((e) => (e.days ?? []).includes(day));
    let members: Members | null = null;
    let label = '';
    let sha: string | null = null;
    if (a) {
      const m = merged.get(a.period);
      members = m ? m.members : cache.members(a.tag, a.asset, a.sha256);
      label = `${a.tag}/${m ? m.asset : a.asset}`;
      sha = m ? null : a.sha256;
      const meta = members.get('_archive.json');
      if (meta) for (const x of (JSON.parse(meta) as ArchiveEditionMeta).merge.into_newer) intoNewer.push(x.survivor);
    } else {
      const ed = ctx.history ? currentHistoryEdition(ctx.history, period) : undefined;
      if (ed && ed.days.includes(day)) {
        members = cache.members(ed.tag, ed.asset, ed.sha256);
        label = `${ed.tag}/${ed.asset}`;
        sha = ed.sha256;
        const meta = members.get('_edition.json');
        if (meta) for (const x of (JSON.parse(meta) as { merge?: MergeMeta }).merge?.into_newer ?? []) intoNewer.push(x.survivor);
      }
    }
    let text = '';
    if (members) text = members.get(`${day.slice(8, 10)}.ndjson`) ?? '';
    else {
      text = (ctx.readTreeDay ?? ((d: string) => readTreeDayDefault(ctx.root, d)))(day);
      label = text ? 'data:events' : '';
    }
    if (!text) continue;
    nodes.push(...textNodes(text));
    found.push(day);
    if (label && !labels.includes(label)) labels.push(label);
    if (sha && !shas.includes(sha)) shas.push(sha);
  }
  return { nodes, meta: found.length ? { label: labels.join(' + '), sha256: shas.length === 1 ? shas[0]! : null, days: found } : null, intoNewer };
}

function writeAssetLocal(ctx: RemergeArchivesCtx, tag: string, file: string): void {
  if (ctx.dryRun) {
    const dir = join(ctx.out, 'releases', tag);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file.split('/').pop()!), readFileSync(file));
    return;
  }
  ctx.io.ensureRelease(tag, tag.startsWith('remediation-') ? `Saturated-day remediation of earthquakes-feed for ${tag.slice(-4)}.` : `Archived event partitions for ${tag.slice(-7)}.`);
  uploadNew(ctx.io, tag, file);
  const back = `${file}.verify`;
  ctx.io.download(tag, file.split('/').pop()!, back);
  if (sha256File(back) !== sha256File(file)) throw new Error(`uploaded ${tag}/${file.split('/').pop()} reads back with another checksum`);
  rmSync(back, { force: true });
}

function listNames(io: ReleaseIo, tag: string): Set<string> {
  try {
    return new Set(io.assets(tag).map((a) => a.name));
  } catch {
    return new Set();
  }
}

/** The refreshed remediation edition of `day`: the merged month's day file, built on the new archive asset. */
function refreshedEdition(
  ctx: RemergeArchivesCtx,
  prev: EditionRef,
  prevText: string,
  day: string,
  text: string,
  nodes: EventNode[],
  res: RemergeResult,
  archive: { tag: string; asset: string; sha256: string },
): { ref: EditionRef; file: string; reused: boolean } {
  const tag = remediationTag(day);
  const bytes = gzipSync(Buffer.from(text), { level: 9 });
  const sum = sha256(bytes);
  const names = ctx.dryRun ? new Set<string>() : listNames(ctx.io, tag);
  // A late_usgs edition's `superseded` assets left the index (pruneLateUsgs) but are not unindexed uploads.
  const indexed = new Set(ctx.remediation.editions.filter((e) => e.tag === tag).flatMap((e) => [e.asset, ...(e.superseded ?? [])]));
  // An earlier run's identical upload whose commit never landed (gzip without a timestamp: same bytes) is reused.
  let asset: string | null = null;
  for (const n of names) {
    if (!indexed.has(n) && n.startsWith(`events-${day}.e`)) {
      const f = join(ctx.work, `probe-${n}`);
      ctx.io.download(tag, n, f);
      if (sha256File(f) === sum) asset = n;
      rmSync(f, { force: true });
      if (asset) break;
    }
  }
  const reused = asset != null;
  const highest = Math.max(0, ...ctx.remediation.editions.filter((e) => e.day === day).map((e) => e.edition));
  const edition = reused ? Number(/\.e(\d+)\.ndjson\.gz$/.exec(asset!)![1]) : nextFree(names, (n) => editionAssetName(day, n), highest + 1);
  asset ??= editionAssetName(day, edition);
  const file = join(ctx.work, asset);
  writeFileSync(file, bytes);
  const prevIds = new Map<string, string>();
  const before = textNodes(prevText);
  for (const n of before) prevIds.set(n.feedId, n.state);
  const liveBefore = [...prevIds.values()].filter((s) => s === 'live').length;
  const stats: EditionStats = {
    archived_events: before.length,
    events: nodes.length,
    live_before: liveBefore,
    live_after: nodes.filter((n) => n.state === 'live').length,
    rows: 0,
    changed: 0,
    unchanged: 0,
    screened: 0,
    new_events: 0,
    retired: nodes.filter((n) => prevIds.get(n.feedId) === 'live' && n.state !== 'live').length,
    off_day: nodes.filter((n) => new Date(n.eventTimeMs).toISOString().slice(0, 10) !== day).length,
    neighbour_joins: 0,
    afad_retimed: 0,
    afad_moved_out: 0,
    merged: res.merges.filter((m) => nodes.some((n) => n.feedId === m.loser)).length,
    provider_rows: {},
    remerge: { epoch: ctx.epoch, from_edition: prev.edition },
  };
  const ref: EditionRef = {
    day,
    edition,
    tag,
    asset,
    url: assetUrl(tag, asset),
    sha256: sum,
    bytes: bytes.length,
    built_on: archive,
    built_from: prev.built_from,
    ...(prev.reason ? { reason: prev.reason } : {}),
    stats,
    built_at: ctx.now(),
  };
  return { ref, file, reused };
}

/** Re-merge one month. Returns the pending entry, or a reason it was blocked (nothing uploaded then). */
export function remergeMonth(
  ctx: RemergeArchivesCtx,
  cache: AssetCache,
  entry: ArchiveEntry,
  merged: Map<string, { asset: string; members: Members }>,
  report: RunReport,
  unused: ArchiveUnused[],
): PendingMonth | { blocked: string } {
  const t0 = performance.now();
  const period = entry.period;
  const base = cache.members(entry.tag, entry.asset, entry.sha256);
  // 1. The base: every DD.ndjson member (its `_*.json` metadata describes the old asset only).
  const memberText = new Map<string, string>();
  for (const [m, text] of base) if (/^\d{2}\.ndjson$/.test(m)) memberText.set(`${period}-${m.slice(0, 2)}`, text);
  // 2. Remediated days: the current edition replaces the member, when it was built on this very asset.
  const remediated: EditionRef[] = [];
  const prevEditionText = new Map<string, string>();
  for (const day of [...memberText.keys()].sort()) {
    const ed = currentEdition(ctx.remediation, day);
    if (!ed) continue;
    if (ed.built_on.sha256 !== entry.sha256) {
      // Built on an earlier asset of the month (a re-roll since: a backfill fill of other days): still the day's input
      // when the re-roll left that day's file byte for byte as the edition's base had it; else the edition must be
      // rebuilt on the new asset first (remediate.yml), and the month waits. A late_usgs edition is built on the day's
      // frozen partition before the month rolled (built_on tag "data"): the same when the archive holds that file byte
      // for byte.
      const prior = (entry.previous ?? []).find((p) => p.sha256 === ed.built_on.sha256);
      const dd = `${day.slice(8, 10)}.ndjson`;
      const onPartition = ed.built_on.tag === PARTITION_TAG && base.has(dd) && sha256(Buffer.from(base.get(dd)!, 'utf8')) === ed.built_on.sha256;
      const same = onPartition || (prior != null && cache.members(entry.tag, prior.asset, prior.sha256).get(dd) === base.get(dd));
      if (!same) return { blocked: `${period}: remediation ${ed.asset} of ${day} was built on ${ed.built_on.asset} (${String(ed.built_on.sha256).slice(0, 12)}), not on the entry's ${entry.asset}${prior ? ', and the re-roll changed that day' : ''}` };
    }
    const f = join(ctx.work, ed.asset);
    ctx.io.download(ed.tag, ed.asset, f);
    const b = readFileSync(f);
    rmSync(f, { force: true });
    if (sha256(b) !== ed.sha256) return { blocked: `${period}: ${ed.tag}/${ed.asset} has another checksum than the index lists` };
    const text = gunzipSync(b).toString('utf8');
    prevEditionText.set(ed.asset, text);
    memberText.set(day, text);
    remediated.push(ed);
  }
  const own: EventNode[] = [];
  const memberDay = new Map<string, string>();
  for (const [day, text] of [...memberText].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const n of textNodes(text)) {
      own.push(n);
      memberDay.set(n.feedId, day);
    }
  }
  const days = [...memberText.keys()].sort();
  const first = days[0]!;
  const last = days[days.length - 1]!;
  // 3. Context: the 7 days before the month's first day (frozen) and after its last (pinned).
  const olderDays = Array.from({ length: 7 }, (_, i) => dayShift(first, i - 7));
  const newerDays = Array.from({ length: 7 }, (_, i) => dayShift(last, i + 1));
  const older = contextDays(ctx, cache, olderDays, merged);
  const newer = contextDays(ctx, cache, newerDays, merged);
  const ownIds = new Set(own.map((n) => n.feedId));
  const anchored = new Set(older.intoNewer.filter((id) => ownIds.has(id)));
  const before = snapshotUnit(own);
  const countsBefore = magnitudeCounts(own);
  // 4. The input normalization (REMERGE_RULES), then the merge and the gates.
  let res: RemergeResult;
  let normalized: ReturnType<typeof normalizeUnit>;
  try {
    normalized = normalizeUnit(own, ctx.registry);
    // The context windows read the same corrected rows (the unit's own are the ones published anew).
    normalizeUnit(older.nodes, ctx.registry);
    normalizeUnit(newer.nodes, ctx.registry);
    res = remergeNodes({
      own,
      memberDay,
      startMs: Math.max(monthStart(period), Date.parse(`${first}T00:00:00Z`)),
      endMs: monthEnd(period),
      older: older.nodes,
      newer: newer.nodes,
      anchored,
      registry: ctx.registry,
      ingestTime: ctx.ingestTime,
      epoch: ctx.epoch,
    });
  } catch (e) {
    return { blocked: `${period}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const gates = remergeGateProblems(before, own, res);
  if (gates.length) return { blocked: `${period}: gates: ${gates.slice(0, 5).join('; ')}` };
  const dayFiles = remergedDayFiles(own, res.dayOf);
  // 5. The archive asset: the day files and _archive.json, under the next free name after the indexed ones. The output is
  // deterministic, so an earlier run's upload of that name whose commit never landed has exactly these bytes and is
  // adopted; an unindexed asset with other bytes goes to archives.json `unused` and its name is never used again.
  const tag = entry.tag;
  const listing = ctx.dryRun ? new Set<string>() : listNames(ctx.io, tag);
  const known = new Set([entry.asset, ...(entry.previous ?? []).map((x) => x.asset), ...(ctx.archives.unused ?? []).filter((u) => u.tag === tag).map((u) => u.asset)]);
  const live = own.filter((n) => n.state === 'live').length;
  const dir = mkdtempSync(join(ctx.work, `m-${period}-`));
  const memberDir = join(dir, 'm');
  mkdirSync(memberDir);
  const members: Members = new Map();
  for (const [day, text] of dayFiles) {
    writeFileSync(join(memberDir, `${day.slice(8, 10)}.ndjson`), text);
    members.set(`${day.slice(8, 10)}.ndjson`, text);
  }
  const build = (edition: number): { meta: ArchiveEditionMeta; asset: string; tarPath: string; sum: string; bytes: number } => {
    const asset = archiveAssetName(`events-${period}`, edition, 'zst');
    const meta: ArchiveEditionMeta = {
      kind: ARCHIVE_EDITION_KIND,
      version: 1,
      period,
      edition,
      built_on: { asset: entry.asset, sha256: entry.sha256, count: entry.count },
      remediation_days: remediated.map((r) => ({ day: r.day, edition: r.edition, sha256: r.sha256 })),
      merge: mergeMeta(res, {
        epoch: ctx.epoch,
        ingestTime: ctx.ingestTime,
        from: { edition: entry.edition ?? 1, asset: entry.asset, sha256: entry.sha256 },
        older: older.meta,
        newer: newer.meta,
        anchored,
        normalized,
      }),
      count: own.length,
      live,
      superseded: own.length - live - own.filter((n) => n.state === 'tombstoned').length,
      days: [...dayFiles.keys()],
    };
    const metaText = JSON.stringify(meta, null, 2) + '\n';
    writeFileSync(join(memberDir, '_archive.json'), metaText);
    members.set('_archive.json', metaText);
    const { path: tarPath } = makeTarball(memberDir, readdirSync(memberDir), asset.replace(/\.tar\.zst$/, ''));
    return { meta, asset, tarPath, sum: sha256File(tarPath), bytes: readFileSync(tarPath).length };
  };
  const sameBytes = (name: string, sum: string): boolean => {
    const f = join(ctx.work, `probe-${name}`);
    try {
      ctx.io.download(tag, name, f);
      return sha256File(f) === sum;
    } catch {
      return false;
    } finally {
      rmSync(f, { force: true });
    }
  };
  const markUnused = (name: string, reason: string): void => {
    if (unused.some((u) => u.tag === tag && u.asset === name)) return;
    unused.push({ tag, asset: name, reason, seen_at: ctx.now() });
    report.unused.push(`${tag}/${name}: ${reason}`);
  };
  let edition = nextFreeEdition(known, `events-${period}`, 'zst', (entry.edition ?? 1) + 1);
  let built = build(edition);
  let adopted = false;
  if (listing.has(built.asset)) {
    if (sameBytes(built.asset, built.sum)) adopted = true;
    else {
      markUnused(built.asset, 'an unindexed asset with other bytes than this run merged (an earlier run or other code)');
      edition = nextFreeEdition(new Set([...known, ...listing]), `events-${period}`, 'zst', edition + 1);
      built = build(edition);
    }
  }
  for (const n of [...listing].sort()) {
    if (n === built.asset || known.has(n) || !/^events-\d{4}-\d{2}\.e\d+\.tar\.zst$/.test(n)) continue;
    markUnused(n, 'an unindexed merged asset of the month that this run did not reproduce');
  }
  const { meta, asset, tarPath, sum, bytes } = built;
  // 6. The refreshed remediation editions (checked before anything is uploaded).
  const mergedDays = new Map([...dayFiles].map(([d, t]) => [d, textNodes(t)]));
  const refreshed: { ref: EditionRef; file: string; reused: boolean }[] = [];
  for (const r of remediated) {
    const text = dayFiles.get(r.day) ?? '';
    const nodes = mergedDays.get(r.day) ?? [];
    const problems = editionProblems(r.day, nodes, mergedDays);
    if (problems.length) return { blocked: `${period}: the refreshed edition of ${r.day} fails its check: ${problems.slice(0, 3).join('; ')}` };
    refreshed.push(refreshedEdition(ctx, r, prevEditionText.get(r.asset) ?? '', r.day, text, nodes, res, { tag, asset, sha256: sum }));
  }
  if (!adopted) writeAssetLocal(ctx, tag, tarPath);
  for (const r of refreshed) if (!r.reused) writeAssetLocal(ctx, r.ref.tag, r.file);
  rmSync(dir, { recursive: true, force: true });
  // Only the month just merged is read again (as the next, older month's newer context): keep no other in memory.
  merged.clear();
  merged.set(period, { asset, members });
  const next: ArchiveEntry = {
    period,
    tag,
    asset,
    url: assetUrl(tag, asset),
    bytes,
    sha256: sum,
    count: own.length,
    days: [...dayFiles.keys()],
    needs_reroll: false,
    edition,
    merge_epoch: ctx.epoch,
    merge_rules: REMERGE_RULES,
    live,
    superseded: meta.superseded,
    built_on: meta.built_on,
    ...(remediated.length ? { remediation: meta.remediation_days } : {}),
  };
  writeMonthReport(ctx, report, {
    period,
    asset,
    adopted,
    before: countsBefore,
    after: magnitudeCounts(own),
    anchor_before: before.anchor,
    anchor_after: snapshotUnit(own).anchor,
    folds: res.merges.length,
    into_newer: res.intoNewer.length,
    off_unit: res.offUnit.length,
    remediation_days: remediated.map((r) => r.day),
    windows: res.steps.windows,
    slowest_ms: res.steps.slowest_ms,
    ms: Math.round(performance.now() - t0),
    residual: usgsResidual(own),
    normalized,
    first_day: first,
    last_day: last,
  }, meta, own);
  return { period, base_sha256: entry.sha256, entry: next, remediation_editions: refreshed.map((r) => r.ref) };
}

function writeMonthReport(ctx: RemergeArchivesCtx, report: RunReport, m: MonthReport, meta: ArchiveEditionMeta, own: EventNode[]): void {
  report.merged.push(m);
  const dir = join(ctx.out, 'months');
  mkdirSync(dir, { recursive: true });
  // The folds with their survivors' magnitudes and ids, for the review table (scripts/remerge-verify.ts).
  const byId = new Map(own.map((n) => [n.feedId, n]));
  const folds = meta.merge.merges.map((x) => {
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
  writeFileSync(join(dir, `${m.period}.json`), JSON.stringify({ ...m, merge: { ...meta.merge, merges: undefined }, folds }, null, 1) + '\n');
}

/** One collect run (see the module comment). Writes pending.json and report.json; returns them. */
export function runRemergeArchives(ctx: RemergeArchivesCtx, opts: { max: number; only?: ReadonlySet<string> }): { pending: Pending; report: RunReport } {
  const report: RunReport = { epoch: ctx.epoch, dry_run: ctx.dryRun, merged: [], waiting: [], blocked: [], unused: [], budget: [] };
  const pending: Pending = { version: 1, epoch: ctx.epoch, months: [], unused: [] };
  const cache = new AssetCache(ctx);
  const merged = new Map<string, { asset: string; members: Members }>();
  const selected = selectMonths(ctx.archives.list, ctx.epoch, opts.max, opts.only);
  const sortedList = [...ctx.archives.list].sort((a, b) => (a.period < b.period ? -1 : 1));
  for (const entry of selected) {
    if (Date.now() > ctx.deadline) {
      report.budget.push(`re-merging ${entry.period} on`);
      break;
    }
    // The next month must be merged first (in an earlier run or this one); the newest archive's newer neighbour is the
    // data branch's day partitions.
    const i = sortedList.findIndex((e) => e.period === entry.period);
    const newerEntry = sortedList[i + 1];
    if (!ctx.noWait && newerEntry && !merged.has(newerEntry.period) && (!archiveIsMerged(newerEntry, ctx.epoch) || newerEntry.needs_reroll)) {
      report.waiting.push(`${entry.period}: waits for ${newerEntry.period} to be merged`);
      continue;
    }
    try {
      const r = remergeMonth(ctx, cache, entry, merged, report, pending.unused);
      if ('blocked' in r) {
        report.blocked.push(`remerge: ${r.blocked}`);
        console.log(`::warning::remerge: ${r.blocked}`);
        continue;
      }
      pending.months.push(r);
      // Written after every month: a run that dies later (a runner lost, the memory limit) still leaves what it did.
      writeOutputs(ctx, pending, report);
      const m = report.merged[report.merged.length - 1]!;
      console.log(
        `remerge: ${entry.period} -> ${r.entry.asset}: live ${m.before.live} -> ${m.after.live}, M4.5+ ${m.before.m45} -> ${m.after.m45}, M6+ ${m.before.m6} -> ${m.after.m6}, ` +
          `${m.folds} folds, ${m.into_newer} into the newer month, normalized: AFAD re-timed ${m.normalized?.afad_retimed ?? 0} (${m.normalized?.afad_joined_kept ?? 0} joined and kept), ISC magnitudes dropped ${m.normalized?.isc_magnitude_dropped ?? 0}, ${r.remediation_editions.length} remediation edition(s)` +
          `${m.remediation_days.length ? ` (day inputs: ${r.entry.remediation!.map((x) => `${x.day} e${x.edition}`).join(', ')})` : ''}${m.adopted ? ', adopted (an earlier upload of the same bytes)' : ''}; ${m.ms} ms`,
      );
    } catch (e) {
      report.blocked.push(`remerge: ${entry.period}: ${e instanceof Error ? e.message : String(e)}`);
      console.log(`::warning::remerge: ${entry.period}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  writeOutputs(ctx, pending, report);
  return { pending, report };
}

function writeOutputs(ctx: RemergeArchivesCtx, pending: Pending, report: RunReport): void {
  mkdirSync(ctx.out, { recursive: true });
  writeFileSync(join(ctx.out, 'pending.json'), JSON.stringify(pending, null, 2) + '\n');
  writeFileSync(join(ctx.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

function setOutput(key: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/** A local stand-in for the Releases of a dry run: reads go to GitHub, nothing is written there. */
const dryRunIo: ReleaseIo = {
  ...ghReleaseIo,
  ensureRelease() {
    throw new Error('dry run: no Release is created');
  },
  upload() {
    throw new Error('dry run: nothing is uploaded');
  },
};

function main(): void {
  const out = process.env.REMERGE_OUT ?? 'remerge-out';
  const dryRun = process.env.REMERGE_DRY_RUN === '1';
  const override = Number(process.env.REMERGE_EPOCH_OVERRIDE || 0);
  if (override && !dryRun) throw new Error('REMERGE_EPOCH_OVERRIDE is for dry runs only');
  const noWait = process.env.REMERGE_NO_WAIT === '1';
  if (noWait && !dryRun) throw new Error('REMERGE_NO_WAIT is for dry runs only');
  const epoch = override || REMERGE_EPOCH;
  mkdirSync(out, { recursive: true });
  const paths = dataPaths(DATA_DIR);
  const archives = existsSync(paths.archivesIndex) ? (JSON.parse(readFileSync(paths.archivesIndex, 'utf8')) as Archives) : { list: [] };
  const remediation = existsSync(paths.remediationIndex) ? (JSON.parse(readFileSync(paths.remediationIndex, 'utf8')) as RemediationIndex) : emptyRemediationIndex();
  const historyFile = join(paths.indexDir, 'history.json');
  const history = existsSync(historyFile) ? (JSON.parse(readFileSync(historyFile, 'utf8')) as HistoryIndex) : null;
  const work = mkdtempSync(join(tmpdir(), 'efd-remerge-'));
  const only = process.env.REMERGE_ONLY?.trim() ? new Set(process.env.REMERGE_ONLY.split(',').map((x) => x.trim()).filter(Boolean)) : undefined;
  const ctx: RemergeArchivesCtx = {
    root: paths.root,
    out,
    work,
    io: dryRun ? dryRunIo : ghReleaseIo,
    dryRun,
    epoch,
    ingestTime: REMERGE_INGEST_TIME,
    deadline: Date.now() + Number(process.env.REMERGE_DEADLINE_S || 2100) * 1000,
    registry: loadRegistry(),
    archives,
    remediation,
    history,
    now: () => new Date().toISOString(),
    ...(noWait ? { noWait } : {}),
  };
  console.log(`remerge: epoch ${epoch} rules ${REMERGE_RULES}${dryRun ? ' (dry run)' : ''}; ${archives.list.length} archive month(s), ${archives.list.filter((e) => archiveIsMerged(e, epoch)).length} merged`);
  let res: ReturnType<typeof runRemergeArchives>;
  try {
    res = runRemergeArchives(ctx, { max: Number(process.env.REMERGE_MONTHS || REMERGE_MONTHS_PER_RUN), ...(only ? { only } : {}) });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const { pending, report } = res;
  setOutput('changed', String(pending.months.length + pending.unused.length > 0));
  console.log(`remerge: merged=${report.merged.length} waiting=${report.waiting.length} blocked=${report.blocked.length} unused=${report.unused.length} budget=${report.budget.length}`);
  if (report.blocked.length) writeFileSync('remerge-blocked.txt', report.blocked.join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error('remerge failed:', err);
    process.exit(1);
  }
}
