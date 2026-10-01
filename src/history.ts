import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArchivedDays, type ArchiveRef } from './archive-io.js';
import { featureToNode } from './bitemporal.js';
import { DATA_DIR, dataPaths } from './config.js';
import { type ContextInput, type EditionMeta, type RawHeader, type RawInput, EDITION_KIND, RAW_KIND, buildEdition, parseRawText, rawFileText } from './history-build.js';
import {
  FETCH_LIMIT_DEFAULT,
  FETCH_MARGIN_MAG,
  type HistoryConfig,
  type HistoryEra,
  type Period,
  allPeriods,
  configProblems,
  editionAssetName,
  historyTag,
  loadHistoryConfig,
  nextEdition,
  nextRawGeneration,
  rawAssetName,
  releaseAssetUrl,
} from './history-config.js';
import { HISTORY_USER_AGENT, fetchRange } from './history-fetch.js';
import {
  type EditionEntry,
  type HistoryIndex,
  type RawEntry,
  currentEdition,
  emptyIndex,
  indexText,
  newerNeighbour,
  parseIndex,
  pendingUnits,
  periodsToSeal,
  rawOf,
} from './history-index.js';
import { type AssetInfo, GitHubStore, type HistoryStore, LocalStore } from './history-store.js';
import { verifyEdition } from './history-verify.js';
import { loadRegistry } from './providers.js';
import type { ProviderConfig } from './types.js';

/**
 * Deep history walker (PF-5j; design and safety rules: src/history-config.ts and APIs.md, Deep history).
 *
 *   npx tsx src/history.ts                 one run: fetch the next source months, seal the months that are complete
 *
 * Environment:
 *   DATA_DIR             a checkout (or a copy) of the data branch; read only: knowledge/index/backfill.json (the
 *                        boundary), archives.json (the frozen 3-year archives) and history.json (where the walk stands)
 *   HISTORY_OUT          output directory (default history-out): history.json (the new index, written when it
 *                        changed), report.json; the commit job copies history.json to the data branch
 *   HISTORY_DRY_RUN=1    no Release is created and nothing is uploaded: assets go to HISTORY_OUT/releases/<tag>/; a
 *                        later dry run continues from HISTORY_OUT/history.json
 *   HISTORY_FORCE=1      run although providers/history.json has enabled=false (local dry runs only)
 *   HISTORY_MAX_UNITS    override maxUnitsPerRun
 *
 * The run writes nothing to DATA_DIR. It exits non-zero only for a broken invariant (after writing the index of the
 * work already uploaded); a source that fails is retried next run and turns the run red once it has failed a day.
 */

const ALARM_FAILURES = 24;
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

interface Ctx {
  cfg: HistoryConfig;
  registry: ProviderConfig[];
  byId: Map<string, ProviderConfig>;
  idx: HistoryIndex;
  store: HistoryStore;
  dryRun: boolean;
  work: string;
  archives: ArchiveRef[];
  archivedDays: Set<string>;
  deadline: number;
  assetCache: Map<string, AssetInfo[]>;
  rawCache: Map<string, RawInput>;
  now: () => string;
  report: { fetched: string[]; sealed: string[]; adopted: string[]; failed: string[]; unused: string[]; blocked: string[] };
}

const eraOf = (cfg: HistoryConfig, p: Period): HistoryEra => cfg.eras.find((e) => e.id === p.eraId)!;
const fetchFloorOf = (era: HistoryEra): number | null => (era.minMagnitude == null ? null : era.minMagnitude - FETCH_MARGIN_MAG);

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
  ctx.assetCache.delete(tag);
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
function adoptOrphans(ctx: Ctx): void {
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
          const raws = e.meta.raw.map((x) => {
            const entry = ctx.idx.raw.find((r) => r.asset === x.asset);
            if (!entry || entry.sha256 !== x.sha256) throw new Error(`built from ${x.asset}, which the index does not hold with that checksum`);
            return loadRaw(ctx, entry.tag, entry.asset, entry.sha256);
          });
          const check = verifyEdition(e.dayFiles, { period: p, boundary: ctx.cfg.boundary, archivedDays: ctx.archivedDays, meta: e.meta, raws });
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
  };
}

async function fetchUnits(ctx: Ctx, maxUnits: number): Promise<void> {
  const paces = new Map<string, { lastEndMs: number }>();
  const failedSources = new Set<string>();
  let done = 0;
  for (const u of pendingUnits(ctx.cfg, ctx.idx)) {
    if (done >= maxUnits || Date.now() > ctx.deadline) break;
    if (failedSources.has(u.source)) continue;
    const p = ctx.byId.get(u.source)!;
    const era = eraOf(ctx.cfg, u.period);
    const key = `${u.source}:${u.period.key}`;
    const fetchedAt = ctx.now();
    const host = new URL(p.base).host;
    const pace = paces.get(host) ?? paces.set(host, { lastEndMs: -Infinity }).get(host)!;
    const res = await fetchRange(p, u.period.startMs, u.period.endMs, {
      limit: ctx.cfg.pageLimits[u.source] ?? FETCH_LIMIT_DEFAULT,
      minMagnitude: fetchFloorOf(era),
      spacingMs: ctx.cfg.requestSpacingMs,
      timeoutMs: Math.max(ctx.cfg.timeoutMs, p.timeoutMs ?? 0),
      deadlineMs: ctx.deadline,
      pace,
    });
    done++;
    if (!res.ok && res.budget) {
      console.log(`history: ${key} not finished within the run's ${ctx.cfg.maxSecondsPerRun} s; asked again next run`);
      break;
    }
    if (!res.ok) {
      failedSources.add(u.source);
      const a = (ctx.idx.attempts[key] ??= { failures: 0, since: fetchedAt, last_error: '' });
      a.failures++;
      a.last_error = res.error.slice(0, 300);
      ctx.report.failed.push(`${key}: ${res.error} (${a.failures} failed run(s) since ${a.since}; ${res.requests} request(s))`);
      console.log(`::warning::history: ${key} failed: ${res.error} — ${a.failures} failed run(s) since ${a.since}`);
      if (a.failures >= ALARM_FAILURES && a.failures % ALARM_FAILURES === 0) {
        ctx.report.blocked.push(`history: ${key} has failed ${a.failures} runs since ${a.since} (last error: ${a.last_error}); fix the source or take it out of the era`);
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
    ctx.report.fetched.push(`${tag}/${asset}: ${res.rows.length} rows${count}, ${res.windows.length} window(s), ${res.requests} request(s), ${(bytes / 1e6).toFixed(2)} MB`);
    console.log(`history: ${key} -> ${tag}/${asset} (${res.rows.length} rows${count}, ${res.requests} requests)`);
  }
}

/** The frozen 3-year layer's first day, read from its archive (read only). */
function boundaryContext(ctx: Ctx, day: string): ContextInput {
  const entry = ctx.archives.find((a) => (a.days ?? []).includes(day));
  if (!entry) throw new Error(`the boundary day ${day} is not in an archive-YYYY-MM Release; history waits for the 3-year layer to be archived`);
  const res = readArchivedDays([entry], new Set([day]));
  if (res.failedMonths.size) throw new Error(`could not read ${entry.tag}/${entry.asset} for the boundary day ${day}`);
  return { label: `${entry.tag}/${entry.asset}#${day.slice(8, 10)}.ndjson`, day, nodes: res.days.get(day) ?? [] };
}

function editionContext(ctx: Ctx, e: EditionEntry, day: string): ContextInput {
  const loaded = loadEdition(ctx, e.tag, e.asset);
  if (loaded.sha256 !== e.sha256) throw new Error(`${e.tag}/${e.asset} has another checksum than the index lists`);
  const text = loaded.dayFiles.get(day) ?? '';
  const nodes = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => featureToNode(JSON.parse(l)));
  return { label: `${e.tag}/${e.asset}#${day.slice(8, 10)}.ndjson`, day, nodes };
}

function sealPeriods(ctx: Ctx): void {
  for (const p of periodsToSeal(ctx.cfg, ctx.idx)) {
    if (Date.now() > ctx.deadline) break;
    const nb = newerNeighbour(ctx.cfg, ctx.idx, p);
    if (nb.kind === 'wait') continue;
    const context = nb.kind === 'boundary' ? boundaryContext(ctx, nb.day) : nb.kind === 'edition' ? editionContext(ctx, nb.edition, nb.day) : null;
    const era = eraOf(ctx.cfg, p);
    const raws = era.sources.map((s) => {
      const e = rawOf(ctx.idx, s, p.key)!;
      return loadRaw(ctx, e.tag, e.asset, e.sha256);
    });
    const tag = historyTag(p.key);
    const edition = nextEdition(assetNames(ctx, tag), p.key, (currentEdition(ctx.idx, p.key)?.edition ?? 0) + 1);
    const built = buildEdition({ period: p, era, edition, raws, context, registry: ctx.registry, boundary: ctx.cfg.boundary, archivedDays: ctx.archivedDays });
    const check = verifyEdition(built.dayFiles, { period: p, boundary: ctx.cfg.boundary, archivedDays: ctx.archivedDays, meta: built.meta, raws });
    if (check.errors.length) throw new Error(`history ${p.key} e${edition} fails verification: ${check.errors.slice(0, 5).join('; ')}`);
    const asset = editionAssetName(p.key, edition);
    const dir = join(ctx.work, `build-${p.key}`);
    mkdirSync(dir, { recursive: true });
    for (const [day, text] of built.dayFiles) writeFileSync(join(dir, `${day.slice(8, 10)}.ndjson`), text);
    writeFileSync(join(dir, '_edition.json'), JSON.stringify(built.meta, null, 2) + '\n');
    const tar = join(ctx.work, asset.replace(/\.zst$/, ''));
    execFileSync('tar', ['-cf', tar, '-C', dir, ...readdirSync(dir).sort()]);
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
  const archives = existsSync(paths.archivesIndex) ? (JSON.parse(readFileSync(paths.archivesIndex, 'utf8')) as { list: ArchiveRef[] }).list : [];
  const archivedDays = new Set(archives.flatMap((a) => a.days ?? []));
  const localIndex = join(out, 'history.json');
  const indexIn = process.env.HISTORY_INDEX_IN ?? (dryRun && existsSync(localIndex) ? localIndex : join(paths.indexDir, 'history.json'));
  const before = existsSync(indexIn) ? readFileSync(indexIn, 'utf8') : null;
  const idx = before ? parseIndex(before) : emptyIndex(cfg.boundary);
  if (idx.boundary !== cfg.boundary) throw new Error(`history.json boundary ${idx.boundary} differs from the config's ${cfg.boundary}`);
  const work = mkdtempSync(join(tmpdir(), 'efd-history-'));
  const ctx: Ctx = {
    cfg,
    registry,
    byId: new Map(registry.map((p) => [p.id, p])),
    idx,
    store: dryRun ? new LocalStore(join(out, 'releases')) : new GitHubStore(),
    dryRun,
    work,
    archives,
    archivedDays,
    deadline: Date.now() + cfg.maxSecondsPerRun * 1000,
    assetCache: new Map(),
    rawCache: new Map(),
    now: () => new Date().toISOString(),
    report: { fetched: [], sealed: [], adopted: [], failed: [], unused: [], blocked: [] },
  };
  console.log(`history: ${ctx.store.label}; index from ${before ? indexIn : 'scratch'}; ${idx.raw.length} raw assets, ${idx.editions.length} editions`);
  let fatal: unknown = null;
  try {
    adoptOrphans(ctx);
    // An empty value (a blank workflow_dispatch input) means the config's number, never 0.
    await fetchUnits(ctx, process.env.HISTORY_MAX_UNITS ? Number(process.env.HISTORY_MAX_UNITS) : cfg.maxUnitsPerRun);
    sealPeriods(ctx);
  } catch (e) {
    fatal = e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // Whatever was uploaded is indexed, also when a later step failed: the index never lags the Releases by choice.
  const text = indexText(idx);
  const changed = text !== before;
  if (changed) writeFileSync(localIndex, text);
  setOutput('changed', String(changed));
  const pending = pendingUnits(cfg, idx).length;
  const unsealed = periodsToSeal(cfg, idx).length;
  const report = { ...ctx.report, pending_units: pending, unsealed_months: unsealed, index_changed: changed, index_bytes: Buffer.byteLength(text) };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    `history: fetched=${ctx.report.fetched.length} sealed=${ctx.report.sealed.length} adopted=${ctx.report.adopted.length} failed=${ctx.report.failed.length} ` +
      `unused=${ctx.report.unused.length} pending_units=${pending} unsealed_months=${unsealed} index_changed=${changed} (${Buffer.byteLength(text)} bytes)`,
  );
  const blocked = [...ctx.report.blocked];
  if (fatal) blocked.unshift(`history: ${fatal instanceof Error ? fatal.message : String(fatal)}`);
  if (blocked.length) {
    for (const m of blocked) console.error(`::error::${m}`);
    // Marker, not a failing step: the index of the uploaded work must still reach the commit job.
    writeFileSync('history-blocked.txt', blocked.join('\n') + '\n');
  }
}

main().catch((err) => {
  console.error('history failed:', err);
  process.exit(1);
});
