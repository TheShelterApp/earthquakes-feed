import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readArchivedDays, type ArchiveRef } from './archive-io.js';
import { featureToNode } from './bitemporal.js';
import { DATA_DIR, REMERGE_EPOCH, REMERGE_INGEST_TIME, dataPaths } from './config.js';
import { type ContextInput, type EditionMeta, type RawHeader, type RawInput, EDITION_KIND, RAW_KIND, buildEdition, parseRawText, rawFileText } from './history-build.js';
import {
  FETCH_LIMIT_DEFAULT,
  type HistoryConfig,
  type HistoryEra,
  type Period,
  allPeriods,
  configProblems,
  dayKeyOf,
  editionAssetName,
  fetchFloorOf,
  historyTag,
  loadHistoryConfig,
  nextEdition,
  nextRawGeneration,
  rawAssetName,
  releaseAssetUrl,
} from './history-config.js';
import { type FetchRangeOptions, type FetchRangeResult, HISTORY_USER_AGENT, fetchRange, unserializedWindows } from './history-fetch.js';
import {
  type ArchiveIndexEntry,
  type EditionEntry,
  type HistoryIndex,
  type RawEntry,
  currentEdition,
  emptyIndex,
  indexText,
  parseIndex,
  pendingUnits,
  periodsToRemerge,
  periodsToSeal,
  rawOf,
  remergeNeighbour,
} from './history-index.js';
import { type HistoryState, type StallEntry, emptyState, loadState, recordRun, stateText, walkTexts } from './history-state.js';
import { type AssetInfo, DryRunStore, GitHubStore, type HistoryStore, LocalStore } from './history-store.js';
import { verifyEdition } from './history-verify.js';
import { type ContextMeta, mergeMeta, normalizeUnit, remergeGateProblems, remergeNodes, remergedDayFiles, snapshotUnit } from './remerge.js';
import { createTar } from './tar.js';
import type { EventNode } from './types.js';
import { loadRegistry } from './providers.js';
import type { ProviderConfig, RawObs } from './types.js';

/**
 * Deep history walker (PF-5j; design and safety rules: src/history-config.ts and APIs.md, Deep history).
 *
 *   npx tsx src/history.ts                 one run: fetch the next source months, seal the months that are complete
 *
 * Environment:
 *   DATA_DIR             a checkout (or a copy) of the data branch; read only: knowledge/index/backfill.json (the
 *                        boundary), archives.json (the frozen 3-year archives), history.json (where the walk stands)
 *                        and history-state.json (its streaks; absent before round 24)
 *   HISTORY_OUT          output directory (default history-out): history.json (the index) and history-state.json (the
 *                        walk's failure and no-progress streaks, src/history-state.ts), both written every run, and
 *                        report.json; the step output `changed` says whether either differs from the data branch's copy,
 *                        and the commit job copies both there (git commits only the one that changed)
 *   HISTORY_DRY_RUN=1    no Release is created and nothing is uploaded: assets go to HISTORY_OUT/releases/<tag>/; a
 *                        later dry run continues from HISTORY_OUT/history.json. The published assets the index lists
 *                        are read from the Releases (read only), so a dry run can build a month's next edition; it reads
 *                        HISTORY_OUT/history-state.json with it
 *   HISTORY_ONLY_SOURCES dry runs only: fetch the months of these sources (comma-separated provider ids) and no other;
 *                        a month is sealed only once every source of its era is there, so such a run seals nothing
 *                        new unless the others are already fetched
 *   HISTORY_REMERGE_EPOCH, HISTORY_REMERGE_ONLY (comma-separated YYYY-MM), HISTORY_REMERGE_NO_WAIT=1,
 *   HISTORY_MAX_SECONDS  dry runs only: re-merge to this epoch although config REMERGE_EPOCH is lower, only these
 *                        months, without waiting for the newer month to be merged (its published edition is the
 *                        context), within this time budget (the re-merge's review before a campaign)
 *   HISTORY_FORCE=1      run although providers/history.json has enabled=false (local dry runs only)
 *   HISTORY_MAX_UNITS    override maxUnitsPerRun
 *
 * The run writes nothing to DATA_DIR. It exits non-zero only for a broken invariant (after writing the index of the
 * work already uploaded); a source month that fails is retried next run and turns the run red once, after a day of
 * failed runs; a month that failed before no longer holds back its source's older months. A walk that makes no progress
 * (work left, nothing fetched, sealed or adopted) turns the run red after a day of such runs that no Retry-After and no
 * time budget explain, or three days of any, and then once a day while it lasts (round 24, src/history-state.ts).
 */

/** A source month that has failed this many runs turns the run red, once (history-state.json keeps its attempts entry);
 *  a walk that has stopped turns runs red by its own streak (src/history-state.ts). */
const ALARM_FAILURES = 24;
/** Failed source months per source per run at most: a month that failed before (`attempts`) no longer holds back the
 *  source's older months, but a source that fails everything costs at most this many failed months a run. */
const MAX_FAILED_UNITS_PER_SOURCE = 3;
const sha256File = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

function requireZstd(): void {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('zstd is required (history assets are .zst)');
  }
}
const zstdCompress = (file: string): string => {
  execFileSync('zstd', ['-19', '-q', '-f', '--rm', file, '-o', `${file}.zst`]);
  return `${file}.zst`;
};
const zstdText = (file: string): string => execFileSync('zstd', ['-d', '-q', '-c', file], { maxBuffer: 1 << 30 }).toString('utf8');
function extractTarZst(file: string, intoDir: string): void {
  mkdirSync(intoDir, { recursive: true });
  const tar = `${file}.tar-tmp`;
  execFileSync('zstd', ['-d', '-q', '-f', file, '-o', tar]);
  execFileSync('tar', ['-xf', tar, '-C', intoDir]);
  rmSync(tar, { force: true });
}

function setOutput(key: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/** What a run did, for report.json and the no-progress streak. */
export interface Report {
  fetched: string[];
  sealed: string[];
  adopted: string[];
  /** Every failed source month, the rate-limited ones (`rate_limited`) included. */
  failed: string[];
  unused: string[];
  blocked: string[];
  empty_after_rows: string[];
  gaps: string[];
  /** Sources left alone this run because they asked (Retry-After) not to be asked before a time. */
  held: string[];
  /** Failed source months the source rate-limited (a Retry-After over the backoff cap, or HTTP 429 through every
   *  retry): a subset of `failed`. */
  rate_limited: string[];
  /** What the run's time budget (maxSecondsPerRun) cut short: a source month's fetch, or the fetches and seals left. */
  budget: string[];
  /** Months re-merged to the current epoch this run (remergePeriods; a new edition each). */
  remerged: string[];
}

export const emptyReport = (): Report => ({
  fetched: [], sealed: [], adopted: [], failed: [], unused: [], blocked: [], empty_after_rows: [], gaps: [], held: [], rate_limited: [], budget: [], remerged: [],
});

/** One run's state. Exported with adoptOrphans and fetchUnits for tests/history-run.test.ts (FEED-TEST-1). */
export interface Ctx {
  cfg: HistoryConfig;
  registry: ProviderConfig[];
  byId: Map<string, ProviderConfig>;
  idx: HistoryIndex;
  store: HistoryStore;
  dryRun: boolean;
  work: string;
  archives: (ArchiveRef & ArchiveIndexEntry)[];
  archivedDays: Set<string>;
  deadline: number;
  assetCache: Map<string, AssetInfo[]>;
  rawCache: Map<string, RawInput>;
  now: () => string;
  report: Report;
  /** Dry runs only (HISTORY_ONLY_SOURCES): fetch these sources' months and no other. */
  onlySources?: ReadonlySet<string>;
  /** Tests only: the HTTP layer and clock of fetchRange (production uses its defaults). */
  fetchOptions?: Pick<FetchRangeOptions, 'fetcher' | 'sleep' | 'now'>;
  /** The re-merge epoch (config REMERGE_EPOCH; tests and dry runs set it: HISTORY_REMERGE_EPOCH). */
  remergeEpoch?: number;
  /** Dry runs only (HISTORY_REMERGE_ONLY): re-merge these months and no other. */
  remergeOnly?: ReadonlySet<string>;
  /** Dry runs only (HISTORY_REMERGE_NO_WAIT=1): a month does not wait for its newer neighbour to be merged; the
   *  neighbour is read as published (to measure months out of order before the campaign). */
  remergeNoWait?: boolean;
  /** Tests only: the archived days the re-merge's boundary context reads (production: readArchivedDays). */
  readArchive?: (entries: ArchiveRef[], days: Set<string>) => { days: Map<string, EventNode[]>; failedMonths: Set<string> };
}

const epochOf = (ctx: Ctx): number => ctx.remergeEpoch ?? REMERGE_EPOCH;

const eraOf = (cfg: HistoryConfig, p: Period): HistoryEra => cfg.eras.find((e) => e.id === p.eraId)!;

function assets(ctx: Ctx, tag: string): AssetInfo[] {
  let a = ctx.assetCache.get(tag);
  if (!a) ctx.assetCache.set(tag, (a = ctx.store.list(tag)));
  return a;
}
const assetNames = (ctx: Ctx, tag: string): Set<string> => new Set(assets(ctx, tag).map((a) => a.name));

/** Upload `file` (named as the asset) and read it back: the copy in the Release must be the bytes we checked. */
function uploadVerified(ctx: Ctx, tag: string, file: string, sha256: string): void {
  ctx.store.ensureRelease(tag);
  ctx.store.upload(tag, file);
  // The run's view of the Release gains the asset it just uploaded (no new listing per upload: the GITHUB_TOKEN's
  // 1,000 REST requests per hour are shared by every workflow of the repository).
  const name = file.split('/').pop()!;
  const cached = ctx.assetCache.get(tag);
  if (cached) cached.push({ name, size: readFileSync(file).length, state: 'uploaded' });
  const back = join(ctx.work, `verify-${Date.now()}`);
  ctx.store.download(tag, file.split('/').pop()!, back);
  if (sha256File(back) !== sha256) throw new Error(`uploaded ${tag}/${file.split('/').pop()} reads back with another checksum`);
  rmSync(back, { force: true });
}

/** A raw asset, downloaded once per run and checked against the index entry's checksum when there is one. */
function loadRaw(ctx: Ctx, tag: string, asset: string, sha256?: string): RawInput {
  const hit = ctx.rawCache.get(asset);
  if (hit) return hit;
  const f = join(ctx.work, asset);
  ctx.store.download(tag, asset, f);
  const sha = sha256File(f);
  if (sha256 && sha !== sha256) throw new Error(`${tag}/${asset} has checksum ${sha}, the index says ${sha256}`);
  const { header, rows } = parseRawText(zstdText(f));
  rmSync(f, { force: true });
  const r: RawInput = { asset, sha256: sha, header, rows };
  ctx.rawCache.set(asset, r);
  return r;
}

function rawEntryOf(tag: string, asset: string, sha256: string, bytes: number, h: RawHeader): RawEntry {
  const gaps = unserializedWindows(h.windows);
  return {
    source: h.source,
    period: h.period,
    tag,
    asset,
    url: releaseAssetUrl(tag, asset),
    sha256,
    bytes,
    rows: h.rows,
    provider_count: h.provider_count,
    start: h.start,
    end: h.end,
    fetch_min_magnitude: h.fetch_min_magnitude,
    fetched_at: h.fetched_at,
    ...(gaps.length ? { unserialized: gaps } : {}),
  };
}

/** An edition asset's day files and `_edition.json`. */
function loadEdition(ctx: Ctx, tag: string, asset: string): { meta: EditionMeta; dayFiles: Map<string, string>; sha256: string; bytes: number } {
  const f = join(ctx.work, asset);
  ctx.store.download(tag, asset, f);
  const sha256 = sha256File(f);
  const bytes = readFileSync(f).length;
  const dir = join(ctx.work, `${asset}.d`);
  extractTarZst(f, dir);
  const meta = JSON.parse(readFileSync(join(dir, '_edition.json'), 'utf8')) as EditionMeta;
  if (meta.kind !== EDITION_KIND) throw new Error(`${asset}: _edition.json is not an edition`);
  const dayFiles = new Map<string, string>();
  for (const m of readdirSync(dir).filter((x) => x.endsWith('.ndjson')).sort()) dayFiles.set(`${meta.period}-${m.slice(0, 2)}`, readFileSync(join(dir, m), 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  rmSync(f, { force: true });
  return { meta, dayFiles, sha256, bytes };
}

function markUnused(ctx: Ctx, tag: string, asset: string, why: string): void {
  if (ctx.idx.unused.some((u) => u.tag === tag && u.asset === asset)) return;
  // No runner paths in the published index: the work directory is named by the asset alone.
  const reason = why.split(`${ctx.work}/`).join('').replace(/\s+/g, ' ').trim().slice(0, 300);
  ctx.idx.unused.push({ tag, asset, reason, seen_at: ctx.now() });
  ctx.report.unused.push(`${tag}/${asset}: ${reason}`);
}

/**
 * Assets in the Releases that the index does not list: a run whose index commit never landed (its commit job was
 * cancelled while it waited for the writer lock) or whose upload broke. A complete, readable one is adopted; any other
 * is listed as unused and its name is never used again.
 */
export function adoptOrphans(ctx: Ctx): void {
  // Idle run: nothing to fetch and nothing to seal means no orphan can exist, so the Releases are not listed (one
  // listing per history-* tag, about 100 REST calls of the shared hourly budget with 51 tags). Proof: the walk uploads
  // only a raw asset of a pending unit (fetchUnits) and only an edition of a period to seal (sealPeriods), and it
  // indexes both in the same run. An orphan is the upload of a run whose index never landed, so the committed index
  // this run read still holds that unit pending or that period unsealed. An orphan that sits beside an indexed copy
  // (a later run fetched the month again) is never adopted anyway: it only stays out of `unused`, and no name is reused
  // because new names are chosen from a fresh listing (nextRawGeneration, nextEdition). The same holds for a re-merged
  // edition (remergePeriods): its period is still to be re-merged in the index that never landed it.
  if (pendingUnits(ctx.cfg, ctx.idx).length === 0 && periodsToSeal(ctx.cfg, ctx.idx).length === 0 && periodsToRemerge(ctx.cfg, ctx.idx, epochOf(ctx)).length === 0) return;
  const periods = new Map(allPeriods(ctx.cfg).map((p) => [p.key, p]));
  const tags = [...new Set([...periods.keys()].map(historyTag))];
  const known = new Set([...ctx.idx.raw.map((r) => r.asset), ...ctx.idx.editions.map((e) => e.asset), ...ctx.idx.unused.map((u) => u.asset)]);
  for (const tag of tags) {
    const list = assets(ctx, tag);
    // Raw assets first: an orphan edition is checked against the raw assets it names.
    const ordered = [...list].sort((a, b) => Number(b.name.startsWith('raw-')) - Number(a.name.startsWith('raw-')) || (a.name < b.name ? -1 : 1));
    for (const a of ordered) {
      if (known.has(a.name)) continue;
      if (a.state !== 'uploaded' || a.size === 0) {
        markUnused(ctx, tag, a.name, `incomplete upload (state ${a.state}, ${a.size} bytes)`);
        continue;
      }
      const raw = /^raw-([a-z0-9]+)-(\d{4}-\d{2})(?:\.g\d+)?\.ndjson\.zst$/.exec(a.name);
      const ed = /^events-(\d{4}-\d{2})\.e(\d+)\.tar\.zst$/.exec(a.name);
      try {
        if (raw) {
          const [, source, period] = raw;
          const p = periods.get(period!);
          if (!p || !eraOf(ctx.cfg, p).sources.includes(source!)) {
            markUnused(ctx, tag, a.name, 'not a source month of the configured eras');
            continue;
          }
          if (rawOf(ctx.idx, source!, period!)) {
            markUnused(ctx, tag, a.name, 'a second copy of a source month the index already holds');
            continue;
          }
          const r = loadRaw(ctx, tag, a.name);
          const h = r.header;
          if (h.source !== source || h.period !== period || Date.parse(h.start) !== p.startMs || Date.parse(h.end) !== p.endMs || h.fetch_min_magnitude !== fetchFloorOf(eraOf(ctx.cfg, p))) {
            markUnused(ctx, tag, a.name, `header does not match the configured month (${h.source} ${h.start}..${h.end} M${h.fetch_min_magnitude})`);
            continue;
          }
          ctx.idx.raw.push(rawEntryOf(tag, a.name, r.sha256, a.size, h));
          ctx.report.adopted.push(`${tag}/${a.name}`);
        } else if (ed) {
          const [, period, n] = ed;
          const p = periods.get(period!);
          if (!p) {
            markUnused(ctx, tag, a.name, 'not a month of the configured eras');
            continue;
          }
          const e = loadEdition(ctx, tag, a.name);
          const base = { period: p, boundary: ctx.cfg.boundary, archivedDays: ctx.archivedDays, meta: e.meta };
          let check: ReturnType<typeof verifyEdition>;
          const from = e.meta.merge?.from;
          if (from) {
            // A re-merged edition: checked against the edition it names, which must be the month's current one (a merge
            // of an edition that is no longer current is never adopted).
            const cur = currentEdition(ctx.idx, period!);
            if (!cur || cur.asset !== from.asset || cur.sha256 !== from.sha256) {
              markUnused(ctx, tag, a.name, `merged from ${from.asset}, which is not the current edition of ${period}`);
              continue;
            }
            const prev = loadEdition(ctx, cur.tag, cur.asset);
            if (prev.sha256 !== cur.sha256) throw new Error(`${cur.asset} has another checksum than the index lists`);
            const prevCheck = verifyEdition(prev.dayFiles, { period: p, boundary: ctx.cfg.boundary, archivedDays: ctx.archivedDays, meta: prev.meta });
            check = verifyEdition(e.dayFiles, { ...base, prev: prevCheck });
          } else {
            const raws = e.meta.raw.map((x) => {
              const entry = ctx.idx.raw.find((r) => r.asset === x.asset);
              if (!entry || entry.sha256 !== x.sha256) throw new Error(`built from ${x.asset}, which the index does not hold with that checksum`);
              return loadRaw(ctx, entry.tag, entry.asset, entry.sha256);
            });
            check = verifyEdition(e.dayFiles, { ...base, raws });
          }
          if (check.errors.length || e.meta.edition !== Number(n)) {
            markUnused(ctx, tag, a.name, `fails verification: ${check.errors.slice(0, 3).join('; ') || 'edition number'}`);
            continue;
          }
          ctx.idx.editions.push(editionEntryOf(tag, a.name, e.sha256, e.bytes, e.meta));
          ctx.report.adopted.push(`${tag}/${a.name}`);
        } else {
          markUnused(ctx, tag, a.name, 'not a history asset name');
        }
      } catch (err) {
        markUnused(ctx, tag, a.name, `unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

function editionEntryOf(tag: string, asset: string, sha256: string, bytes: number, m: EditionMeta): EditionEntry {
  return {
    period: m.period,
    edition: m.edition,
    era: m.era,
    tag,
    asset,
    url: releaseAssetUrl(tag, asset),
    sha256,
    bytes,
    events: m.events,
    days: m.days,
    sources: m.sources,
    min_magnitude: m.min_magnitude,
    built_from: m.raw.map((r) => r.asset),
    context: m.context ? m.context.label : null,
    joined_newer: m.rows.joined_newer,
    ...(m.merge ? { merge_epoch: m.merge.epoch, merge_rules: m.merge.rules ?? 1 } : {}),
    ...(m.merge?.from ? { merged_from: m.merge.from } : {}),
    ...(m.lines != null ? { lines: m.lines } : {}),
    ...(m.superseded != null ? { superseded: m.superseded } : {}),
  };
}

/** Rows of the newer month the check asks for again: its first, middle and last row (by origin time). */
const PROBE_ROWS = 3;
const PROBE_HALF_WINDOW_MS = 3_600_000;

/**
 * Does the source still answer rows it gave for `newer` (its raw asset `newerRaw`)? Asks a two-hour window around up to
 * PROBE_ROWS of those rows, one at a time, and stops at the first window that answers a row. An error, or no row in any
 * window, means the source is not answering as it did (a service answering empty while it is broken, or the newer
 * month's events gone); a run whose time budget ends during the check says so (`budget`).
 */
export async function stillAnswersRows(
  ctx: Ctx,
  p: ProviderConfig,
  newer: Period,
  newerRaw: RawEntry,
  options: FetchRangeOptions,
): Promise<{ ok: true; requests: number } | { ok: false; error: string; requests: number; budget?: boolean }> {
  let rows: RawObs[];
  try {
    rows = [...loadRaw(ctx, newerRaw.tag, newerRaw.asset, newerRaw.sha256).rows].sort((a, b) => a.eventTimeMs - b.eventTimeMs);
  } catch (e) {
    return { ok: false, error: `could not read ${newerRaw.asset} to check it (${e instanceof Error ? e.message : String(e)})`, requests: 0 };
  }
  const picks = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])].slice(0, PROBE_ROWS).map((i) => rows[i]!);
  let requests = 0;
  for (const r of picks) {
    const ws = Math.max(newer.startMs, r.eventTimeMs - PROBE_HALF_WINDOW_MS);
    const we = Math.min(newer.endMs, r.eventTimeMs + PROBE_HALF_WINDOW_MS);
    const res = await fetchRange(p, ws, we, options);
    requests += res.requests;
    if (!res.ok) return { ok: false, error: `checking ${newer.key} again: ${res.error}`, requests, ...(res.budget ? { budget: true } : {}) };
    if (res.rows.length > 0) return { ok: true, requests };
  }
  return {
    ok: false,
    error: `${newer.key} answers none either in ${picks.length} two-hour window(s) around rows it answered on ${newerRaw.fetched_at} (a service answering empty; asked again next run)`,
    requests,
  };
}

/** Fetch up to `maxUnits` pending source months. `onMonthComplete` runs when a fetch completes a month (every source of
 *  its era fetched): the walk seals it there and then, so editions follow the fetches within the run instead of waiting
 *  for a run whose fetching ends before its time budget does. */
export async function fetchUnits(ctx: Ctx, maxUnits: number, onMonthComplete?: (p: Period) => void): Promise<void> {
  const paces = new Map<string, { lastEndMs: number }>();
  const failedSources = new Set<string>();
  const failuresThisRun = new Map<string, number>();
  let done = 0;
  for (const u of pendingUnits(ctx.cfg, ctx.idx)) {
    if (done >= maxUnits) break;
    if (ctx.onlySources && !ctx.onlySources.has(u.source)) continue;
    if (failedSources.has(u.source)) continue;
    if (Date.now() > ctx.deadline) {
      ctx.report.budget.push(`fetching from ${u.source}:${u.period.key} on`);
      break;
    }
    const waitUntil = Object.entries(ctx.idx.attempts)
      .filter(([k, v]) => k.startsWith(`${u.source}:`) && v.not_before)
      .map(([, v]) => Date.parse(v.not_before!))
      .reduce((m, t) => Math.max(m, t), -Infinity);
    if (waitUntil > Date.now()) {
      failedSources.add(u.source);
      ctx.report.held.push(`${u.source} until ${new Date(waitUntil).toISOString()}`);
      console.log(`history: ${u.source} asked not to be asked before ${new Date(waitUntil).toISOString()} (Retry-After); its months wait`);
      continue;
    }
    const p = ctx.byId.get(u.source)!;
    const era = eraOf(ctx.cfg, u.period);
    const key = `${u.source}:${u.period.key}`;
    const fetchedAt = ctx.now();
    const host = new URL(p.base).host;
    const pace = paces.get(host) ?? paces.set(host, { lastEndMs: -Infinity }).get(host)!;
    const fetchOptions = (minMagnitude: number | null): FetchRangeOptions => ({
      limit: ctx.cfg.pageLimits[u.source] ?? FETCH_LIMIT_DEFAULT,
      minMagnitude,
      spacingMs: ctx.cfg.requestSpacingMs,
      timeoutMs: Math.max(ctx.cfg.timeoutMs, p.timeoutMs ?? 0),
      deadlineMs: ctx.deadline,
      pace,
      ...ctx.fetchOptions,
    });
    let res: FetchRangeResult = await fetchRange(p, u.period.startMs, u.period.endMs, fetchOptions(fetchFloorOf(era)));
    done++;
    // An empty month right before one with rows is either where the source's catalogue starts (going back) or a
    // service that answers empty while it is broken (NOA's registered node answered 204 to every query for ten days,
    // PF-5j-NOA). A raw asset is immutable and a sealed month is never fetched again, so the empty answer is kept only
    // once the source still answers rows it gave for the newer month; otherwise the month fails like any other failure
    // and is asked again next run (round 15 review).
    // An era whose every month has rows (expectRows) takes an empty answer as a fault without probing: the month fails
    // and is asked again next run.
    let emptyAfter: { newer: string; rows: number } | null = null;
    if (res.ok && res.rows.length === 0 && era.expectRows) {
      res = { ok: false, error: `${key} answered no rows (count ${res.providerCount ?? 'n/a'}) where every month of era ${era.id} has rows`, windows: res.windows, requests: res.requests };
    } else if (res.ok && res.rows.length === 0) {
      const newer = allPeriods(ctx.cfg).find((q) => q.startMs === u.period.endMs);
      const newerRaw = newer ? rawOf(ctx.idx, u.source, newer.key) : undefined;
      if (newer && newerRaw && newerRaw.rows > 0) {
        const check = await stillAnswersRows(ctx, p, newer, newerRaw, fetchOptions(newerRaw.fetch_min_magnitude));
        const requests = res.requests + check.requests;
        if (check.ok) {
          emptyAfter = { newer: newer.key, rows: newerRaw.rows };
          res = { ...res, requests };
        } else {
          res = { ok: false, error: `${key} answered no rows: ${check.error}`, windows: res.windows, requests, ...(check.budget ? { budget: true } : {}) };
        }
      }
    }
    if (!res.ok && res.budget) {
      ctx.report.budget.push(key);
      console.log(`history: ${key} not finished within the run's ${ctx.cfg.maxSecondsPerRun} s; asked again next run`);
      break;
    }
    if (!res.ok) {
      const failedBefore = (ctx.idx.attempts[key]?.failures ?? 0) > 0;
      const n = (failuresThisRun.get(u.source) ?? 0) + 1;
      failuresThisRun.set(u.source, n);
      // A month that fails for the first time stops its source for the run (most failures are the source's, and pass).
      // One that failed before is likely the month's own (an answer the walk cannot read, round 23: EMSC 2017-12 held
      // the whole walk for six days): the source goes on with its older months, up to MAX_FAILED_UNITS_PER_SOURCE
      // failed months a run. A rate limit always stops it: a pause asked for over the backoff cap (the source is then left
      // alone until the time it named), or HTTP 429 through every retry (round 24).
      const rateLimited = res.retryAfterMs != null || /\bHTTP 429\b/.test(res.error);
      if (!failedBefore || n >= MAX_FAILED_UNITS_PER_SOURCE || rateLimited) failedSources.add(u.source);
      const a = (ctx.idx.attempts[key] ??= { failures: 0, since: fetchedAt, last_error: '' });
      a.failures++;
      a.last_error = res.error.slice(0, 300);
      if (res.retryAfterMs != null) a.not_before = new Date(Date.now() + res.retryAfterMs).toISOString();
      else delete a.not_before;
      ctx.report.failed.push(`${key}: ${res.error} (${a.failures} failed run(s) since ${a.since}; ${res.requests} request(s))`);
      if (rateLimited) ctx.report.rate_limited.push(`${key}: ${res.error.slice(0, 120)}`);
      console.log(`::warning::history: ${key} failed: ${res.error} — ${a.failures} failed run(s) since ${a.since}`);
      if (a.failures === ALARM_FAILURES) {
        ctx.report.blocked.push(
          `history: ${key} has failed ${a.failures} runs since ${a.since} (last error: ${a.last_error}); the source's older months go on, ` +
            `but no month from ${u.period.key} back is sealed until it is fetched: fix the source or take it out of the era`,
        );
      }
      continue;
    }
    const header: RawHeader = {
      kind: RAW_KIND,
      version: 1,
      source: u.source,
      period: u.period.key,
      start: new Date(u.period.startMs).toISOString(),
      end: new Date(u.period.endMs).toISOString(),
      fetch_min_magnitude: fetchFloorOf(era),
      fetched_at: fetchedAt,
      rows: res.rows.length,
      response_rows: res.responseRows,
      parsed_rows: res.parsedRows,
      duplicate_ids: res.duplicateIds,
      provider_count: res.providerCount,
      ...(res.unserialized > 0 ? { unserialized_rows: res.unserialized } : {}),
      requests: res.requests,
      windows: res.windows,
      user_agent: HISTORY_USER_AGENT,
    };
    const tag = historyTag(u.period.key);
    const asset = rawAssetName(u.source, u.period.key, nextRawGeneration(assetNames(ctx, tag), u.source, u.period.key));
    const plain = join(ctx.work, asset.replace(/\.zst$/, ''));
    writeFileSync(plain, rawFileText(header, res.rows));
    const file = zstdCompress(plain);
    const sha = sha256File(file);
    const bytes = readFileSync(file).length;
    uploadVerified(ctx, tag, file, sha);
    ctx.rawCache.set(asset, { asset, sha256: sha, header, rows: [...res.rows] });
    ctx.idx.raw.push(rawEntryOf(tag, asset, sha, bytes, header));
    delete ctx.idx.attempts[key];
    rmSync(file, { force: true });
    const count = res.providerCount != null ? `, the source's count ${res.providerCount}` : '';
    if (res.unserialized > 0) {
      const gaps = unserializedWindows(res.windows).map((g) => `${g.start}..${g.end} ${g.count}`).join(', ');
      ctx.report.gaps.push(`${key}: ${res.unserialized} event(s) the source counts but answers as empty elements (${gaps})`);
      console.log(`::warning::history: ${key}: ${res.unserialized} event(s) the source counts but does not answer, recorded as a gap in the index (${gaps})`);
    }
    if (emptyAfter) {
      ctx.report.empty_after_rows.push(`${key}: no rows, ${emptyAfter.rows} in ${emptyAfter.newer} (which still answers rows: the source's catalogue starts here)`);
      console.log(`::warning::history: ${key} answered no rows where ${emptyAfter.newer} has ${emptyAfter.rows}, and ${emptyAfter.newer} still answers rows: the start of the catalogue`);
    }
    ctx.report.fetched.push(`${tag}/${asset}: ${res.rows.length} rows${count}, ${res.windows.length} window(s), ${res.requests} request(s), ${(bytes / 1e6).toFixed(2)} MB`);
    console.log(`history: ${key} -> ${tag}/${asset} (${res.rows.length} rows${count}, ${res.requests} requests)`);
    if (onMonthComplete && era.sources.every((s) => rawOf(ctx.idx, s, u.period.key))) onMonthComplete(u.period);
  }
}

/** The frozen 3-year layer's first day, read from its archive (read only). */
function boundaryContext(ctx: Ctx, day: string): ContextInput {
  const entry = ctx.archives.find((a) => (a.days ?? []).includes(day));
  if (!entry) throw new Error(`the boundary day ${day} is not in an archive-YYYY-MM Release; history waits for the 3-year layer to be archived`);
  const res = readArchivedDays([entry], new Set([day]));
  if (res.failedMonths.size) throw new Error(`could not read ${entry.tag}/${entry.asset} for the boundary day ${day}`);
  return { label: `${entry.tag}/${entry.asset}#${day.slice(8, 10)}.ndjson`, day, nodes: res.days.get(day) ?? [], sha256: entry.sha256 ?? null };
}

function editionContext(ctx: Ctx, e: EditionEntry, day: string): ContextInput {
  const loaded = loadEdition(ctx, e.tag, e.asset);
  if (loaded.sha256 !== e.sha256) throw new Error(`${e.tag}/${e.asset} has another checksum than the index lists`);
  const text = loaded.dayFiles.get(day) ?? '';
  const nodes = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => featureToNode(JSON.parse(l)));
  return { label: `${e.tag}/${e.asset}#${day.slice(8, 10)}.ndjson`, day, nodes, sha256: e.sha256 };
}

/** Build, verify and upload the next edition of every month that is complete and stale, newest first (a month waits
 *  until its newer neighbour is frozen). Exported for tests/history-run.test.ts. */
export function sealPeriods(ctx: Ctx): void {
  for (const p of periodsToSeal(ctx.cfg, ctx.idx)) {
    // With the re-merge on, a new edition is merged as it is built (buildEdition), so its newer neighbour must be merged
    // first, like remergePeriods' (remergeNeighbour is newerNeighbour while the epoch is 0).
    const nb = remergeNeighbour(ctx.cfg, ctx.idx, ctx.archives, p, epochOf(ctx));
    if (nb.kind === 'wait') continue;
    if (Date.now() > ctx.deadline) {
      // A run calls this before, during and after its fetches (runWalk): the month the budget stopped at is listed once
      // (R24-FOLLOWUPS (5)).
      const entry = `sealing ${p.key} on`;
      if (!ctx.report.budget.includes(entry)) ctx.report.budget.push(entry);
      break;
    }
    const context = nb.kind === 'boundary' ? boundaryContext(ctx, nb.day) : nb.kind === 'edition' ? editionContext(ctx, nb.edition, nb.day) : null;
    const era = eraOf(ctx.cfg, p);
    const raws = era.sources.map((s) => {
      const e = rawOf(ctx.idx, s, p.key)!;
      return loadRaw(ctx, e.tag, e.asset, e.sha256);
    });
    const tag = historyTag(p.key);
    const edition = nextEdition(assetNames(ctx, tag), p.key, (currentEdition(ctx.idx, p.key)?.edition ?? 0) + 1);
    const built = buildEdition({ period: p, era, edition, raws, context, registry: ctx.registry, boundary: ctx.cfg.boundary, archivedDays: ctx.archivedDays, remergeEpoch: epochOf(ctx) });
    const check = verifyEdition(built.dayFiles, { period: p, boundary: ctx.cfg.boundary, archivedDays: ctx.archivedDays, meta: built.meta, raws });
    if (check.errors.length) throw new Error(`history ${p.key} e${edition} fails verification: ${check.errors.slice(0, 5).join('; ')}`);
    const asset = editionAssetName(p.key, edition);
    const dir = join(ctx.work, `build-${p.key}`);
    mkdirSync(dir, { recursive: true });
    for (const [day, text] of built.dayFiles) writeFileSync(join(dir, `${day.slice(8, 10)}.ndjson`), text);
    writeFileSync(join(dir, '_edition.json'), JSON.stringify(built.meta, null, 2) + '\n');
    const tar = join(ctx.work, asset.replace(/\.zst$/, ''));
    createTar(tar, dir, readdirSync(dir));
    const file = zstdCompress(tar);
    const sha = sha256File(file);
    const bytes = readFileSync(file).length;
    uploadVerified(ctx, tag, file, sha);
    ctx.idx.editions.push(editionEntryOf(tag, asset, sha, bytes, built.meta));
    rmSync(dir, { recursive: true, force: true });
    rmSync(file, { force: true });
    const m = built.meta;
    ctx.report.sealed.push(
      `${tag}/${asset}: ${m.events} events on ${m.days.length} day(s) from ${m.rows.fetched} rows (${m.rows.written} written, ${m.rows.joined_newer} joined the newer neighbour, ` +
        `${m.rows.below_floor} below the floor, ${m.rows.bad_coords + m.rows.coordinateless} screened); context ${m.context?.label ?? 'none'}; ${(bytes / 1e6).toFixed(2)} MB`,
    );
    console.log(`history: sealed ${tag}/${asset} (${m.events} events, ${m.rows.joined_newer} joined the newer neighbour)`);
  }
}

const DAY_MS = 86_400_000;
const dayAfter = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const linesToNodes = (text: string): EventNode[] =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => featureToNode(JSON.parse(l)));

/** A loaded edition kept for the run: the walk re-merges newest first, so the month it just used as older context is
 *  the next one it merges. */
type LoadedEdition = ReturnType<typeof loadEdition> & { entry: EditionEntry };
function loadCurrent(ctx: Ctx, cache: Map<string, LoadedEdition>, e: EditionEntry, keep?: string): LoadedEdition {
  const hit = cache.get(e.asset);
  if (hit) return hit;
  const loaded = loadEdition(ctx, e.tag, e.asset);
  if (loaded.sha256 !== e.sha256) throw new Error(`${e.tag}/${e.asset} has checksum ${loaded.sha256}, the index says ${e.sha256}`);
  const out = { ...loaded, entry: e };
  // At most two editions in memory: the month being merged (`keep`) and the one just loaded.
  for (const k of [...cache.keys()]) if (k !== keep) cache.delete(k);
  cache.set(e.asset, out);
  return out;
}

/**
 * The history re-merge (config REMERGE_EPOCH, src/remerge.ts; APIs.md, Re-merged history): each month whose current
 * edition is current (its raw assets) but not merged to the epoch gets a new edition e(N+1), built from e(N) and nothing
 * else: the same lines, the same feed ids and source ids, losers superseded into their survivors. Newest first; a month
 * waits for its newer neighbour (remergeNeighbour: the newer month merged, or the boundary's archive merged). Context:
 * the newer neighbour's first 7 days (pinned) and the older month's last 7 days (frozen). A month that fails a gate is
 * listed in `blocked` and nothing is uploaded for it. Exported for tests/history-run.test.ts.
 */
export function remergePeriods(ctx: Ctx): void {
  const epoch = epochOf(ctx);
  if (epoch <= 0) return;
  const cache = new Map<string, LoadedEdition>();
  const periods = allPeriods(ctx.cfg);
  // The edition this run just wrote: the next (older) month's newer context, read from memory.
  let lastMerged: { asset: string; dayFiles: Map<string, string> } | null = null;
  for (const p of periodsToRemerge(ctx.cfg, ctx.idx, epoch)) {
    if (ctx.remergeOnly && !ctx.remergeOnly.has(p.key)) continue;
    const nb = remergeNeighbour(ctx.cfg, ctx.idx, ctx.archives, p, ctx.remergeNoWait ? 0 : epoch);
    if (nb.kind === 'wait') continue;
    if (Date.now() > ctx.deadline) {
      const entry = `re-merging ${p.key} on`;
      if (!ctx.report.budget.includes(entry)) ctx.report.budget.push(entry);
      break;
    }
    const started = Date.now();
    const prevEntry = currentEdition(ctx.idx, p.key)!;
    const prev = loadCurrent(ctx, cache, prevEntry);
    const own: EventNode[] = [];
    const memberDay = new Map<string, string>();
    for (const [day, text] of prev.dayFiles) {
      for (const n of linesToNodes(text)) {
        own.push(n);
        memberDay.set(n.feedId, day);
      }
    }
    // Newer context: the first 7 days after the month (the newer edition, or the archive at the boundary), pinned.
    const newerDays = Array.from({ length: 7 }, (_, i) => dayAfter(dayKeyOf(p.endMs), i));
    let newer: EventNode[] = [];
    let newerMeta: ContextMeta | null = null;
    if (nb.kind === 'edition') {
      let files = lastMerged?.asset === nb.edition.asset ? lastMerged.dayFiles : null;
      if (!files) {
        const ed = loadEdition(ctx, nb.edition.tag, nb.edition.asset);
        if (ed.sha256 !== nb.edition.sha256) throw new Error(`${nb.edition.asset} has another checksum than the index lists`);
        files = ed.dayFiles;
      }
      const dayFilesOfNewer = files;
      const days = newerDays.filter((d) => dayFilesOfNewer.has(d));
      newer = days.flatMap((d) => linesToNodes(dayFilesOfNewer.get(d)!));
      newerMeta = { label: `${nb.edition.tag}/${nb.edition.asset}`, sha256: nb.edition.sha256, days };
    } else if (nb.kind === 'boundary') {
      const entries = ctx.archives.filter((a) => (a.days ?? []).some((d) => newerDays.includes(d)));
      const read = (ctx.readArchive ?? readArchivedDays)(entries, new Set(newerDays));
      if (read.failedMonths.size) {
        ctx.report.blocked.push(`history: re-merge of ${p.key} waits: the archive of the boundary days could not be read (${[...read.failedMonths].join(', ')})`);
        continue;
      }
      const days = newerDays.filter((d) => read.days.has(d));
      newer = days.flatMap((d) => read.days.get(d)!);
      const a = entries[0];
      newerMeta = { label: entries.map((x) => `${x.tag}/${x.asset}`).join(' + '), sha256: a?.sha256 ?? null, days };
    }
    // Older context: the older month's last 7 days (its current edition, merged or not), frozen; its into_newer
    // survivors are this month's anchored events.
    const olderP = periods.find((q) => q.endMs === p.startMs);
    const olderEntry = olderP ? currentEdition(ctx.idx, olderP.key) : undefined;
    let older: EventNode[] = [];
    let olderMeta: ContextMeta | null = null;
    const anchored = new Set<string>();
    if (olderEntry) {
      const od = loadCurrent(ctx, cache, olderEntry, prevEntry.asset);
      const days = Array.from({ length: 7 }, (_, i) => dayAfter(dayKeyOf(p.startMs), i - 7)).filter((d) => od.dayFiles.has(d));
      older = days.flatMap((d) => linesToNodes(od.dayFiles.get(d)!));
      olderMeta = { label: `${olderEntry.tag}/${olderEntry.asset}`, sha256: olderEntry.sha256, days };
      const ownIds = new Set(own.map((n) => n.feedId));
      for (const x of od.meta.merge?.into_newer ?? []) if (ownIds.has(x.survivor)) anchored.add(x.survivor);
    }
    const before = snapshotUnit(own);
    let res: ReturnType<typeof remergeNodes>;
    let normalized: ReturnType<typeof normalizeUnit>;
    try {
      normalized = normalizeUnit(own, ctx.registry);
      normalizeUnit(older, ctx.registry);
      normalizeUnit(newer, ctx.registry);
      res = remergeNodes({ own, memberDay, startMs: p.startMs, endMs: p.endMs, older, newer, anchored, registry: ctx.registry, ingestTime: REMERGE_INGEST_TIME, epoch });
    } catch (e) {
      ctx.report.blocked.push(`history: re-merge of ${p.key} blocked: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const gates = remergeGateProblems(before, own, res);
    if (gates.length) {
      ctx.report.blocked.push(`history: re-merge of ${p.key} blocked by its gates: ${gates.slice(0, 5).join('; ')}`);
      continue;
    }
    const tag = historyTag(p.key);
    const edition = nextEdition(assetNames(ctx, tag), p.key, prevEntry.edition + 1);
    const dayFiles = remergedDayFiles(own, res.dayOf);
    const live = own.filter((n) => n.state === 'live').length;
    const meta: EditionMeta = {
      ...prev.meta,
      edition,
      events: live,
      days: [...dayFiles.keys()],
      merge: mergeMeta(res, {
        epoch,
        ingestTime: REMERGE_INGEST_TIME,
        from: { edition: prevEntry.edition, asset: prevEntry.asset, sha256: prevEntry.sha256 },
        older: olderMeta,
        newer: newerMeta,
        anchored,
        normalized,
      }),
      lines: own.length,
      superseded: own.filter((n) => n.state === 'superseded').length,
    };
    const prevCheck = verifyEdition(prev.dayFiles, { period: p, boundary: ctx.cfg.boundary, archivedDays: ctx.archivedDays, meta: prev.meta });
    const check = verifyEdition(dayFiles, { period: p, boundary: ctx.cfg.boundary, archivedDays: ctx.archivedDays, meta, prev: prevCheck });
    if (check.errors.length) {
      ctx.report.blocked.push(`history: re-merge of ${p.key} e${edition} fails verification: ${check.errors.slice(0, 5).join('; ')}`);
      continue;
    }
    const asset = editionAssetName(p.key, edition);
    const dir = join(ctx.work, `remerge-${p.key}`);
    mkdirSync(dir, { recursive: true });
    for (const [day, text] of dayFiles) writeFileSync(join(dir, `${day.slice(8, 10)}.ndjson`), text);
    writeFileSync(join(dir, '_edition.json'), JSON.stringify(meta, null, 2) + '\n');
    const tar = join(ctx.work, asset.replace(/\.zst$/, ''));
    createTar(tar, dir, readdirSync(dir));
    const file = zstdCompress(tar);
    const sha = sha256File(file);
    const bytes = readFileSync(file).length;
    uploadVerified(ctx, tag, file, sha);
    ctx.idx.editions.push(editionEntryOf(tag, asset, sha, bytes, meta));
    rmSync(dir, { recursive: true, force: true });
    rmSync(file, { force: true });
    lastMerged = { asset, dayFiles };
    cache.delete(prevEntry.asset);
    const m = meta.merge!;
    ctx.report.remerged.push(
      `${tag}/${asset}: ${m.live_before} -> ${m.live_after} live (${m.merges.length} folded, ${m.into_newer.length} into the newer month, ${m.off_unit.length} off the month) ` +
        `from ${prevEntry.asset} in ${m.steps.windows} window(s), slowest ${res.steps.slowest_ms} ms, ${((Date.now() - started) / 1000).toFixed(1)} s in all; ${(bytes / 1e6).toFixed(2)} MB`,
    );
    console.log(`history: re-merged ${p.key} -> ${tag}/${asset} (${m.live_before} -> ${m.live_after} live)`);
  }
}

/** The red-run text of a no-progress streak: what is left and the months that keep failing. */
function stallMessage(ctx: Ctx, st: StallEntry, pending: number, unsealed: number): string {
  const failing = Object.entries(ctx.idx.attempts)
    .sort(([ka, a], [kb, b]) => b.failures - a.failures || (ka < kb ? -1 : 1))
    .slice(0, 5)
    .map(([k, a]) => `${k} (${a.failures} failed run(s) since ${a.since}: ${a.last_error.slice(0, 120)})`);
  return (
    `history: no progress for ${st.runs} run(s) since ${st.since} (${st.unexplained} of them with no Retry-After or time budget to explain them): ` +
    `${pending} source month(s) to fetch and ${unsealed} complete month(s) to seal, and nothing fetched, sealed or adopted` +
    (failing.length ? `; failing: ${failing.join('; ')}` : '') +
    '; the walk has stopped: fix the source or take it out of the era (red once a day while it lasts)'
  );
}

/**
 * One run of the walk: take over assets an earlier run uploaded but never indexed, seal the months an earlier run left
 * complete, fetch (sealing each month as its last source arrives), then count the run into the no-progress streak of
 * `state` (whose `attempts` is `ctx.idx.attempts`, src/history-state.ts). A broken invariant comes back as `fatal`,
 * after the run is counted, and is never thrown: the index of the work already uploaded must still be written.
 * Exported for tests/history-run.test.ts.
 */
export async function runWalk(ctx: Ctx, state: HistoryState, maxUnits: number): Promise<{ fatal: unknown; pending: number; unsealed: number }> {
  let fatal: unknown = null;
  try {
    adoptOrphans(ctx);
    // Months left complete but unsealed by an earlier run first, then each month as its last source arrives: a run
    // whose fetching uses the whole time budget (era A's walk) still seals what it completed.
    sealPeriods(ctx);
    // The re-merge of the sealed months (newest first; none while REMERGE_EPOCH is 0), before the fetches: the walk's
    // remaining fetches are the slower work and resume next run.
    remergePeriods(ctx);
    await fetchUnits(ctx, maxUnits, () => sealPeriods(ctx));
    sealPeriods(ctx);
  } catch (e) {
    fatal = e;
  }
  const pending = pendingUnits(ctx.cfg, ctx.idx).length;
  const unsealed = periodsToSeal(ctx.cfg, ctx.idx).length + periodsToRemerge(ctx.cfg, ctx.idx, epochOf(ctx)).length;
  const r = ctx.report;
  const progress = r.fetched.length + r.sealed.length + r.adopted.length + r.remerged.length > 0;
  // Explained: the run waited for a source's Retry-After or ran out of time, and nothing failed for another reason.
  const explained = !fatal && r.failed.length === r.rate_limited.length && r.held.length + r.rate_limited.length + r.budget.length > 0;
  if (recordRun(state, { progress, workLeft: pending + unsealed > 0, explained }, ctx.now())) r.blocked.push(stallMessage(ctx, state.stall!, pending, unsealed));
  else if (state.stall) {
    const st = state.stall;
    console.log(`history: no progress this run: ${st.runs} run(s) in a row since ${st.since}, ${st.unexplained} of them unexplained${explained ? '' : ' (this one too)'}`);
  }
  return { fatal, pending, unsealed };
}

async function main(): Promise<void> {
  const cfg = loadHistoryConfig();
  const out = process.env.HISTORY_OUT ?? 'history-out';
  const dryRun = process.env.HISTORY_DRY_RUN === '1';
  mkdirSync(out, { recursive: true });
  if (!cfg.enabled && process.env.HISTORY_FORCE !== '1') {
    console.log('history: providers/history.json has enabled=false; nothing to do');
    setOutput('changed', 'false');
    return;
  }
  requireZstd();
  const registry = loadRegistry();
  const problems = configProblems(cfg, registry);
  if (problems.length) throw new Error(`providers/history.json: ${problems.join('; ')}`);
  const paths = dataPaths(DATA_DIR);
  const backfill = JSON.parse(readFileSync(paths.backfillCursor, 'utf8')) as { targetStart?: string };
  // The boundary is where backfill's 3-year walk stopped: history must end exactly there, never inside it.
  if (backfill.targetStart !== cfg.boundary) throw new Error(`boundary ${cfg.boundary} differs from backfill.json targetStart ${backfill.targetStart}`);
  const archives = existsSync(paths.archivesIndex) ? (JSON.parse(readFileSync(paths.archivesIndex, 'utf8')) as { list: (ArchiveRef & ArchiveIndexEntry)[] }).list : [];
  const archivedDays = new Set(archives.flatMap((a) => a.days ?? []));
  const localIndex = join(out, 'history.json');
  const localState = join(out, 'history-state.json');
  const indexIn = process.env.HISTORY_INDEX_IN ?? (dryRun && existsSync(localIndex) ? localIndex : join(paths.indexDir, 'history.json'));
  // The state is read beside the index it belongs to: the data branch's, or a local dry run's own.
  const stateIn = join(dirname(indexIn), 'history-state.json');
  const before = existsSync(indexIn) ? readFileSync(indexIn, 'utf8') : null;
  const stateBefore = existsSync(stateIn) ? readFileSync(stateIn, 'utf8') : null;
  const idx = before ? parseIndex(before) : emptyIndex(cfg.boundary);
  if (idx.boundary !== cfg.boundary) throw new Error(`history.json boundary ${idx.boundary} differs from the config's ${cfg.boundary}`);
  const state = loadState(idx, stateBefore);
  const onlySources = process.env.HISTORY_ONLY_SOURCES?.trim()
    ? new Set(process.env.HISTORY_ONLY_SOURCES.split(',').map((x) => x.trim()).filter(Boolean))
    : undefined;
  if (onlySources && !dryRun) throw new Error('HISTORY_ONLY_SOURCES is for dry runs only (a production run walks every source of the era)');
  // Re-merge dry runs before the epoch is switched on (scripts/remerge-verify.ts --history reads the result).
  const remergeEpoch = process.env.HISTORY_REMERGE_EPOCH?.trim() ? Number(process.env.HISTORY_REMERGE_EPOCH) : undefined;
  const remergeOnly = process.env.HISTORY_REMERGE_ONLY?.trim() ? new Set(process.env.HISTORY_REMERGE_ONLY.split(',').map((x) => x.trim()).filter(Boolean)) : undefined;
  const remergeNoWait = process.env.HISTORY_REMERGE_NO_WAIT === '1';
  const maxSeconds = process.env.HISTORY_MAX_SECONDS?.trim() ? Number(process.env.HISTORY_MAX_SECONDS) : cfg.maxSecondsPerRun;
  if ((remergeEpoch != null || remergeOnly || remergeNoWait || maxSeconds !== cfg.maxSecondsPerRun) && !dryRun) {
    throw new Error('HISTORY_REMERGE_EPOCH, HISTORY_REMERGE_ONLY, HISTORY_REMERGE_NO_WAIT and HISTORY_MAX_SECONDS are for dry runs only');
  }
  for (const s of onlySources ?? []) if (!cfg.eras.some((e) => e.sources.includes(s))) throw new Error(`HISTORY_ONLY_SOURCES: ${s} is a source of no era`);
  const work = mkdtempSync(join(tmpdir(), 'efd-history-'));
  const ctx: Ctx = {
    cfg,
    registry,
    byId: new Map(registry.map((p) => [p.id, p])),
    idx,
    store: dryRun ? new DryRunStore(new LocalStore(join(out, 'releases')), new GitHubStore()) : new GitHubStore(),
    dryRun,
    work,
    archives,
    archivedDays,
    deadline: Date.now() + maxSeconds * 1000,
    assetCache: new Map(),
    rawCache: new Map(),
    now: () => new Date().toISOString(),
    report: emptyReport(),
    ...(onlySources ? { onlySources } : {}),
    ...(remergeEpoch != null ? { remergeEpoch } : {}),
    ...(remergeOnly ? { remergeOnly } : {}),
    ...(remergeNoWait ? { remergeNoWait } : {}),
  };
  console.log(
    `history: ${ctx.store.label}; index from ${before ? indexIn : 'scratch'}; ${idx.raw.length} raw assets, ${idx.editions.length} editions; ` +
      `state from ${stateBefore ? stateIn : 'scratch'}: ${Object.keys(state.attempts).length} failing source month(s), ` +
      (state.stall ? `no progress for ${state.stall.runs} run(s) since ${state.stall.since}` : 'no stall'),
  );
  let run: Awaited<ReturnType<typeof runWalk>>;
  try {
    // An empty value (a blank workflow_dispatch input) means the config's number, never 0.
    run = await runWalk(ctx, state, process.env.HISTORY_MAX_UNITS ? Number(process.env.HISTORY_MAX_UNITS) : cfg.maxUnitsPerRun);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const { fatal, pending, unsealed } = run;
  // Whatever was uploaded is indexed, also when a later step failed: the index never lags the Releases by choice. The
  // streaks go to the state file: a run that only counts one more failure leaves the index as it was (round 24).
  const files = walkTexts(idx, state, indexText);
  const indexChanged = files.index !== before;
  const stateChanged = files.state !== (stateBefore ?? stateText(emptyState()));
  writeFileSync(localIndex, files.index);
  writeFileSync(localState, files.state);
  setOutput('changed', String(indexChanged || stateChanged));
  const report = {
    ...ctx.report,
    pending_units: pending,
    unsealed_months: unsealed,
    stall: state.stall,
    index_changed: indexChanged,
    index_bytes: Buffer.byteLength(files.index),
    state_changed: stateChanged,
    state_bytes: Buffer.byteLength(files.state),
  };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    `history: fetched=${ctx.report.fetched.length} sealed=${ctx.report.sealed.length} remerged=${ctx.report.remerged.length} adopted=${ctx.report.adopted.length} failed=${ctx.report.failed.length} ` +
      `held=${ctx.report.held.length} rate_limited=${ctx.report.rate_limited.length} budget=${ctx.report.budget.length} ` +
      `unused=${ctx.report.unused.length} empty_after_rows=${ctx.report.empty_after_rows.length} gaps=${ctx.report.gaps.length} pending_units=${pending} unsealed_months=${unsealed} ` +
      `stall=${state.stall ? `${state.stall.runs}/${state.stall.unexplained}` : 'none'} ` +
      `index_changed=${indexChanged} (${Buffer.byteLength(files.index)} bytes) state_changed=${stateChanged} (${Buffer.byteLength(files.state)} bytes)`,
  );
  const blocked = [...ctx.report.blocked];
  if (fatal) blocked.unshift(`history: ${fatal instanceof Error ? fatal.message : String(fatal)}`);
  if (blocked.length) {
    for (const m of blocked) console.error(`::error::${m}`);
    // Marker, not a failing step: the index of the uploaded work must still reach the commit job.
    writeFileSync('history-blocked.txt', blocked.join('\n') + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((err) => {
  console.error('history failed:', err);
  process.exit(1);
});
