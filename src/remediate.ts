import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { type ArchiveRef, readArchivedDays } from './archive-io.js';
import { backfillCfg } from './backfill-cfg.js';
import { featureToNode } from './bitemporal.js';
import { DATA_DIR, dataPaths } from './config.js';
import { DryRunStore, GitHubStore, type HistoryStore, LocalStore } from './history-store.js';
import { FROZEN_AFTER_DAYS, frozenBefore as frozenBeforeAt } from './partitions.js';
import { partitionBlobs } from './stats-history.js';
import { type WindowOutcome, fetchProviderWindow, loadRegistry } from './providers.js';
import {
  type AssetRef,
  type DayTask,
  type EditionRef,
  type EditionStats,
  type LateUsgsDiff,
  type LateUsgsMode,
  type RawRef,
  type RemediationIndex,
  type RemediationReason,
  EDITION_FORMAT,
  LATE_USGS_MAX_AGE_DAYS,
  LATE_USGS_PROVIDER,
  LATE_USGS_SCHEDULED,
  PARTITION_TAG,
  RAW_REMEDIATION_KIND,
  buildDayEdition,
  currentEdition,
  dayRaws,
  editionProblems,
  editionAssetName,
  emptyRemediationIndex,
  enqueueRefill,
  fetchDayInWindows,
  indexText,
  lateUsgsDays,
  lateUsgsDiff,
  lateUsgsKeeps,
  lateUsgsRowsOfNodes,
  lateUsgsRowsOfRaw,
  nextFree,
  partitionAsset,
  parseRawText,
  pruneQueue,
  queuePlan,
  rawAssetName,
  rawText,
  remediationTag,
  remediationTasks,
  tasksByDay,
} from './remediation.js';
import type { EventNode, ProviderConfig, RawObs } from './types.js';

/**
 * Remediation run (src/remediation.ts; APIs.md, Remediation editions): the saturated backfill days (FEED-DQ-1 / DQ-3),
 * explicit refills such as the 2026-06-28..07-03 seam, and ComCat's late publications on the frozen live-era days
 * (`late_usgs`, SHLTR-150), one complete edition per day.
 *
 *   npx tsx src/remediate.ts
 *
 * Environment:
 *   DATA_DIR                  a checkout (or copy) of the data branch; read only: knowledge/index/backfill.json (the
 *                             saturated days), archives.json, head.json, remediation.json
 *   REMEDIATION_OUT           output directory (default remediation-out): remediation.json (the new index, when it
 *                             changed) and report.json; the workflow's commit job copies the index to the data branch
 *   REMEDIATION_DRY_RUN=1     no Release, no upload: assets go to REMEDIATION_OUT/releases/<tag>/ (published assets are
 *                             read, never written)
 *   REMEDIATION_REFILL        a range YYYY-MM-DD..YYYY-MM-DD added to the persistent refill queue
 *                             (remediation.json `refill_queue`) with REMEDIATION_PROVIDERS; such a run does the queue
 *                             only, not the saturated days
 *   REMEDIATION_PROVIDERS     with REMEDIATION_REFILL: a comma list of source ids, or `bootstrap-2026-07-05` (the 15
 *                             sources the onboarding bootstrap of 2026-07-05 marked complete without filling them)
 *   REMEDIATION_QUEUE_ONLY=1  the queue only (the scheduled run)
 *   REMEDIATION_DAYS          only these tasks, e.g. "kagsr:2025-07-30,afad:2025-08-11"
 *   REMEDIATION_MAX_DAYS      days per run (default 8)
 *   REMEDIATION_LATE_USGS     the late-ComCat refresh: `on` (build and publish), `plan` (ask ComCat and diff, publish
 *                             nothing), `scheduled` (the mode LATE_USGS_SCHEDULED names), blank or `off` (none); a run
 *                             given `on` or `plan` does the queue and the refresh only, not the saturated days
 *   REMEDIATION_LATE_USGS_RANGE  the refresh's days instead of the last 45: YYYY-MM-DD..YYYY-MM-DD (at most 31 days; the
 *                             catch-up of the frozen days older than 45), frozen and unarchived days only
 *   REMEDIATION_LATE_MAX_DAYS editions the refresh builds per run at most (default 40); a changed day past it waits
 *   REMEDIATION_DEADLINE_S    no refresh day starts after this many seconds of the run (default 1200)
 *
 * The queue's days are taken as soon as their month is archived; the others stay queued. The refresh reads the day
 * partitions of DATA_DIR by blob (`git cat-file`: a blobless checkout is enough). It writes nothing to DATA_DIR. One
 * request at a time, at least 1.1 s apart.
 */

const SPACING_MS = 1_100;
const DAY_MS = 86_400_000;
/** The sources the onboarding bootstrap of 2026-07-05 seeded as onboarded although their 48-hour live lookback never
 *  reached the live floor (2026-06-28): the seam 2026-06-28 00:00 → 07-03 05:42 UTC (APIs.md, History and backfill). */
export const BOOTSTRAP_2026_07_05: readonly string[] = [
  'usgs', 'emsc', 'geofon', 'ingv', 'geonet', 'resif', 'noa', 'ethz', 'nrcan', 'ncedc', 'scedc', 'knmi', 'auspass', 'afad', 'kagsr',
];
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const dayShift = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const assetUrl = (tag: string, asset: string): string => `https://github.com/TheShelterApp/earthquakes-feed/releases/download/${tag}/${asset}`;

const NOTES = (tag: string): string =>
  `Remediation of earthquakes-feed for ${tag.slice(-4)}: saturated backfill days, the 2026-06-28..07-03 seam and ComCat's late publications. ` +
  'Immutable raw source answers (raw-<source>-<day>.ndjson.gz) and complete day editions (events-<day>.e<N>.ndjson.gz) ' +
  'for days a source\'s backfill could not fetch whole, the live layer\'s start left empty, or ComCat completed after ' +
  'the day froze. The archived day or frozen partition is unchanged. Index: knowledge/index/remediation.json on the ' +
  'data branch; format: APIs.md, Remediation editions.';

function setOutput(key: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

/** Upload `file` (named as the asset) and read it back: the copy in the Release must be the bytes we hashed. */
function uploadVerified(store: HistoryStore, tag: string, file: string, sum: string, work: string): void {
  store.ensureRelease(tag);
  store.upload(tag, file);
  const back = join(work, `verify-${Date.now()}`);
  store.download(tag, file.split('/').pop()!, back);
  if (sha256(readFileSync(back)) !== sum) throw new Error(`uploaded ${tag}/${file.split('/').pop()} reads back with another checksum`);
  rmSync(back, { force: true });
}

/** `bootstrap-2026-07-05` or a comma list; every id must be an active source with a time-range backfill. */
export function resolveProviders(spec: string, registry: readonly ProviderConfig[]): string[] {
  const ids = spec.split(',').map((x) => x.trim()).filter(Boolean).flatMap((x) => (x === 'bootstrap-2026-07-05' ? [...BOOTSTRAP_2026_07_05] : [x]));
  if (!ids.length) throw new Error('no providers given for the refill');
  for (const id of ids) {
    const p = registry.find((x) => x.id === id);
    if (!p) throw new Error(`refill provider ${id} is not in the registry`);
    if (!p.active) throw new Error(`refill provider ${id} is not active`);
    if (!backfillCfg(p)) throw new Error(`refill provider ${id} has no time-range backfill (forward-only)`);
  }
  return [...new Set(ids)].sort();
}

export interface DayRunDeps {
  store: HistoryStore;
  registry: ProviderConfig[];
  fetchWindow: (p: ProviderConfig, startMs: number, endMs: number, minmag?: number) => Promise<WindowOutcome>;
  archives: (ArchiveRef & { sha256?: string })[];
  /** The archived days of the run and their neighbours (readArchivedDays). */
  arch: { days: Map<string, EventNode[]>; failedMonths: Set<string> };
  /** The frozen day partitions on the data branch the late_usgs days of the run and their neighbours are read from. */
  partitions?: Map<string, FrozenPartition>;
  /** false: a late_usgs day is fetched and diffed only, nothing is uploaded (the refresh's `plan` mode). */
  publish?: boolean;
  work: string;
  nowMs: number;
  seqMarker: number;
  spacingMs: number;
  sleep?: (ms: number) => Promise<void>;
}

/** A frozen day partition of the data branch, read by its blob. */
export interface FrozenPartition {
  nodes: EventNode[];
  ref: AssetRef;
}

export interface DayRunResult {
  day: string;
  /** late_usgs: ComCat's answer against the usgs rows the day holds, and where those rows were read. */
  late?: LateUsgsDiff & { held_from: string; base_changed: boolean };
  /** late_usgs in `plan` mode: the day changed and an `on` run would build its edition. */
  planned?: boolean;
  /** The edition built, when one was. */
  edition?: EditionRef;
  /** The raws uploaded (with or without an edition). */
  raws: RawRef[];
  failed: string[];
  line?: string;
}

const archiveOf = (archives: DayRunDeps['archives'], day: string): (ArchiveRef & { sha256?: string }) | undefined =>
  archives.find((a) => (a.days ?? []).includes(day));

/** Read a published asset of the index (an edition or a raw) and check it against the checksum the index lists. */
function readIndexed(store: HistoryStore, ref: { tag: string; asset: string; sha256: string }, work: string): string {
  const f = join(work, `read-${ref.asset}`);
  store.download(ref.tag, ref.asset, f);
  const bytes = readFileSync(f);
  rmSync(f, { force: true });
  if (sha256(bytes) !== ref.sha256) throw new Error(`${ref.tag}/${ref.asset} has another checksum than the index lists`);
  return gunzipSync(bytes).toString('utf8');
}

/**
 * One day: fetch its sources (sequentially, `spacingMs` apart), then
 *  - when a source failed: upload and index the successful raws only, build no edition (an edition never names a raw
 *    that is not there; the next run fetches the failed source and builds the edition from all the day's raws);
 *  - otherwise: the edition from the archived day, the neighbours as consumers read them (a neighbour's current
 *    remediation edition when one exists, else its archived day), the fetched rows and every other raw of the day the
 *    index holds; checked (editionProblems against that same context), then the raws and the edition uploaded, each
 *    read back.
 * Mutates `idx` (new raw and edition entries).
 */
export async function remediateDay(day: string, tasks: readonly DayTask[], idx: RemediationIndex, deps: DayRunDeps): Promise<DayRunResult> {
  const res: DayRunResult = { day, raws: [], failed: [] };
  const nowIso = new Date(deps.nowMs).toISOString();
  const reason: RemediationReason =
    tasks.some((t) => t.reason === 'seam') || (!tasks.length && dayRaws(idx, day).some((r) => r.reason === 'seam')) ? 'seam' : tasks.some((t) => t.reason === 'late_usgs') ? 'late_usgs' : 'saturated';
  const late = reason === 'late_usgs';
  const base = archiveOf(deps.archives, day);
  const part = late ? deps.partitions?.get(day) : undefined;
  const ctxDays = [dayShift(day, -1), day, dayShift(day, 1)];
  const unreadable = [...new Set(ctxDays.map((d) => d.slice(0, 7)).filter((m) => deps.arch.failedMonths.has(m)))];
  if (unreadable.length) {
    res.failed.push(`${day}: archive unreadable for ${unreadable.join(', ')}; asked again next run`);
    return res;
  }
  if (late) {
    // ComCat's late publications on a frozen day the archive has not rolled yet: built on the frozen partition. An
    // archived day is never a late_usgs day (its own remediation goes through the queue, built on its archive).
    if (base || deps.arch.days.has(day)) {
      res.failed.push(`${day}: archived; a late_usgs edition supplements a frozen partition that is not archived yet`);
      return res;
    }
    if (!part) {
      res.failed.push(`${day}: no frozen partition of the day on the data branch`);
      return res;
    }
    if (tasks.some((t) => t.provider !== LATE_USGS_PROVIDER || t.reason !== 'late_usgs')) {
      res.failed.push(`${day}: a late_usgs day asks ${LATE_USGS_PROVIDER} alone`);
      return res;
    }
  } else if (!base || !deps.arch.days.has(day)) {
    res.failed.push(`${day}: the day is in no archive; a remediation edition supplements an archived day only`);
    return res;
  }

  // 1) The sources, one after another.
  const fetched: { task: DayTask; rows: RawObs[]; requests: number; partial: boolean; windows: Awaited<ReturnType<typeof fetchDayInWindows>>['windows'] }[] = [];
  for (const t of tasks) {
    const p = deps.registry.find((x) => x.id === t.provider);
    if (!p) {
      res.failed.push(`${t.provider}:${day}: not in the registry`);
      continue;
    }
    const cfg = backfillCfg(p);
    const f = await fetchDayInWindows(day, (s, e) => deps.fetchWindow(p, s, e, cfg?.minmag), { spacingMs: deps.spacingMs, sleep: deps.sleep });
    if (!f.ok) {
      res.failed.push(`${t.provider}:${day}: ${f.error} (${f.requests} request(s)); asked again next run`);
      continue;
    }
    fetched.push({ task: t, rows: f.rows, requests: f.requests, partial: f.partial, windows: f.windows });
  }

  // 1b) late_usgs: only a day whose ComCat M4.5+ set changed since the rows it holds gets an edition.
  if (late && !res.failed.length && part) {
    const f = fetched.find((x) => x.task.provider === LATE_USGS_PROVIDER);
    if (!f) return res;
    const held = heldUsgsRows(day, idx, deps, part);
    const cur = currentEdition(idx, day);
    // An edition built on other bytes of the partition than the data branch holds now (a deliberate rewrite of a frozen
    // day since): rebuilt on the current partition whatever ComCat says.
    const baseChanged = cur != null && cur.built_on.tag === PARTITION_TAG && cur.built_on.sha256 !== part.ref.sha256;
    res.late = { ...lateUsgsDiff(held.rows, lateUsgsRowsOfRaw(f.rows)), held_from: held.from, base_changed: baseChanged };
    if (!res.late.changed && !baseChanged) return res;
    if (deps.publish === false) {
      res.planned = true;
      return res;
    }
  }

  const tag = remediationTag(day);
  const names = new Set(deps.store.list(tag).map((a) => a.name));
  const raws = fetched.map((f) => {
    const name = rawAssetName(f.task.provider, day, nextFree(names, (n) => rawAssetName(f.task.provider, day, n)));
    names.add(name);
    const bytes = gzipSync(rawText({ kind: RAW_REMEDIATION_KIND, version: 1, provider: f.task.provider, day, fetched_at: nowIso, rows: f.rows.length, requests: f.requests, partial: f.partial, windows: f.windows }, f.rows), { level: 9 });
    const file = join(deps.work, name);
    writeFileSync(file, bytes);
    const ref: RawRef = {
      provider: f.task.provider, day, tag, asset: name, url: assetUrl(tag, name), sha256: sha256(bytes), bytes: bytes.length,
      rows: f.rows.length, requests: f.requests, partial: f.partial, fetched_at: nowIso, reason: f.task.reason ?? 'saturated',
    };
    return { ref, file };
  });
  const uploadRaws = (): void => {
    for (const r of raws) {
      uploadVerified(deps.store, tag, r.file, r.ref.sha256, deps.work);
      idx.raw.push(r.ref);
      res.raws.push(r.ref);
    }
  };
  if (res.failed.length) {
    uploadRaws();
    if (raws.length) res.failed.push(`${day}: ${raws.length} raw(s) uploaded, no edition until every source of the day is fetched`);
    return res;
  }

  // 2) The context as consumers read it: the day as archived (late_usgs: its frozen partition); each neighbour's current
  //    edition, else its archived day, else (late_usgs) its frozen partition.
  const context = new Map<string, EventNode[]>();
  const contextRefs: Record<string, AssetRef> = {};
  for (const d of ctxDays) {
    if (late && d === day) {
      context.set(d, part!.nodes);
      contextRefs[d] = part!.ref;
      continue;
    }
    const ed = d === day ? undefined : currentEdition(idx, d);
    if (ed) {
      context.set(d, readEditionNodes(deps, ed));
      contextRefs[d] = { tag: ed.tag, asset: ed.asset, sha256: ed.sha256 };
      continue;
    }
    const a = deps.arch.days.get(d);
    const ref = archiveOf(deps.archives, d);
    if (a && ref) {
      context.set(d, a);
      contextRefs[d] = { tag: ref.tag, asset: ref.asset, sha256: ref.sha256 ?? null };
      continue;
    }
    const p = late && !ref ? deps.partitions?.get(d) : undefined;
    if (!p) continue; // a neighbour not archived (yet): its partition is not part of an archived day's context
    context.set(d, p.nodes);
    contextRefs[d] = p.ref;
  }

  // 3) Rows: the fetched ones, then every other raw of the day already indexed (the newest per source).
  const fetchedProviders = new Set(fetched.map((f) => f.task.provider));
  const others = dayRaws(idx, day).filter((r) => !fetchedProviders.has(r.provider));
  if (!fetched.length && !others.length) return res;
  const rows: RawObs[] = fetched.flatMap((f) => f.rows);
  for (const r of others) rows.push(...parseRawText(readIndexed(deps.store, r, deps.work)).rows);

  // 4) The edition (fresh nodes: buildDayEdition ingests into them), its check, then the uploads: raws first.
  const fresh = new Map([...context].map(([d, nodes]) => [d, nodes.map((n) => structuredClone(n))]));
  const built = buildDayEdition({ day, context: fresh, rows, registry: deps.registry, nowMs: deps.nowMs, ingestTime: nowIso, seqMarker: deps.seqMarker, fmt: EDITION_FORMAT, ...(late ? { afadRetime: false } : {}) });
  const problems = editionProblems(day, built.nodes, context);
  if (late) problems.push(...lateUsgsKeeps(part!.nodes, built.nodes));
  if (problems.length) {
    res.failed.push(`${day}: the edition fails its check: ${problems.slice(0, 3).join('; ')}`);
    return res;
  }
  const prevEdition = Math.max(0, ...idx.editions.filter((e) => e.day === day).map((e) => e.edition));
  const edition = nextFree(names, (n) => editionAssetName(day, n), prevEdition + 1);
  const edName = editionAssetName(day, edition);
  const edBytes = gzipSync(Buffer.from(built.text), { level: 9 });
  const edFile = join(deps.work, edName);
  writeFileSync(edFile, edBytes);
  const edSum = sha256(edBytes);
  uploadRaws();
  uploadVerified(deps.store, tag, edFile, edSum, deps.work);
  const ed: EditionRef = {
    day, edition, tag, asset: edName, url: assetUrl(tag, edName), sha256: edSum, bytes: edBytes.length,
    built_on: late ? part!.ref : { tag: base!.tag, asset: base!.asset, sha256: base!.sha256 ?? null },
    built_from: [...raws.map((r) => r.ref.asset), ...others.map((r) => r.asset)].sort(),
    reason,
    context: contextRefs,
    stats: built.stats, built_at: nowIso,
  };
  idx.editions.push(ed);
  res.edition = ed;
  res.line = summaryLine(day, `${tag}/${edName}`, fetched, built.stats) + (res.late ? `; late ComCat: ${lateLine(res.late)}` : '');
  return res;
}

function readEditionNodes(deps: DayRunDeps, ed: EditionRef): EventNode[] {
  return readIndexed(deps.store, ed, deps.work).split('\n').filter((l) => l.trim()).map((l) => featureToNode(JSON.parse(l)));
}

/**
 * The usgs rows a late_usgs day holds now, as ComCat's answer is compared with them: the usgs raw asset its current
 * edition is built from (what ComCat answered last time, whether or not every row of it could join the day: a row that
 * cannot is not asked about again), else the current edition's rows, else the frozen partition's.
 */
function heldUsgsRows(day: string, idx: RemediationIndex, deps: DayRunDeps, part: FrozenPartition): { rows: ReturnType<typeof lateUsgsRowsOfRaw>; from: string } {
  const cur = currentEdition(idx, day);
  if (!cur) return { rows: lateUsgsRowsOfNodes(part.nodes), from: part.ref.asset };
  const raw = idx.raw.filter((r) => r.day === day && r.provider === LATE_USGS_PROVIDER && cur.built_from.includes(r.asset)).sort((a, b) => (a.fetched_at < b.fetched_at ? 1 : a.fetched_at > b.fetched_at ? -1 : a.asset < b.asset ? 1 : -1))[0];
  if (raw) return { rows: lateUsgsRowsOfRaw(parseRawText(readIndexed(deps.store, raw, deps.work)).rows), from: `${raw.tag}/${raw.asset}` };
  return { rows: lateUsgsRowsOfNodes(readEditionNodes(deps, cur)), from: `${cur.tag}/${cur.asset}` };
}

export function lateLine(d: LateUsgsDiff & { held_from: string; base_changed: boolean }): string {
  const ids = (xs: string[]): string => (xs.length ? ` (${xs.slice(0, 5).join(', ')}${xs.length > 5 ? ', …' : ''})` : '');
  return (
    `M4.5+ held ${d.held} (${d.held_from}) vs ComCat ${d.fresh}: +${d.added.length} added${ids(d.added)}, ${d.revised.length} revised by ≥ 0.3${ids(d.revised.map((r) => `${r.id} ${r.from}->${r.to}`))}, ` +
    `${d.lowered.length} below M4.5 now${ids(d.lowered.map((r) => `${r.id} ${r.from}->${r.to}`))}, ${d.gone.length} gone upstream (kept)${ids(d.gone)}${d.base_changed ? '; the partition changed since the current edition' : ''}`
  );
}

function summaryLine(day: string, asset: string, fetched: { task: DayTask; rows: RawObs[]; requests: number; partial: boolean }[], s: EditionStats): string {
  const srcs = fetched.map((f) => `${f.task.provider} ${f.rows.length} rows/${f.requests} req${f.partial ? ' PARTIAL' : ''}`).join(', ') || 'no new fetch';
  const prov = Object.entries(s.provider_rows).map(([p, v]) => `${p} ${v.before}->${v.after}`).join(', ');
  return (
    `${day} -> ${asset}: ${srcs}; ` +
    `events ${s.archived_events} -> ${s.events}, live ${s.live_before} -> ${s.live_after} (+${s.new_events} new, ${s.retired} retired, ${s.off_day} off the day, ${s.neighbour_joins} joined a neighbouring day; rows ${s.changed} changed, ${s.unchanged} unchanged, ${s.screened} screened` +
    `${s.afad_retimed || s.afad_moved_out ? `; AFAD re-read ${s.afad_retimed} retimed, ${s.afad_moved_out} moved out, ${s.merged} folded` : ''}); rows by source: ${prov}`
  );
}

type LateReport = { day: string } & NonNullable<DayRunResult['late']>;

/** REMEDIATION_LATE_USGS: on | plan | off | blank (off) | scheduled (LATE_USGS_SCHEDULED, the scheduled run's mode). */
export function resolveLateMode(v: string | undefined, scheduled: LateUsgsMode = LATE_USGS_SCHEDULED): LateUsgsMode {
  const x = (v ?? '').trim();
  if (x === '' || x === 'off') return 'off';
  if (x === 'scheduled') return scheduled;
  if (x === 'on' || x === 'plan') return x;
  throw new Error(`REMEDIATION_LATE_USGS must be on, plan, off or scheduled, got "${x}"`);
}

/** A frozen day partition of the data checkout, read by its blob (a blobless checkout fetches it). */
function readPartition(dataDir: string, day: string, oid: string): FrozenPartition {
  const bytes = execFileSync('git', ['-C', dataDir, 'cat-file', 'blob', oid], { maxBuffer: 1 << 30 });
  const nodes = bytes.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => featureToNode(JSON.parse(l)));
  return { nodes, ref: { tag: PARTITION_TAG, asset: partitionAsset(day), sha256: sha256(bytes), blob: oid } };
}

async function main(): Promise<void> {
  const out = process.env.REMEDIATION_OUT ?? 'remediation-out';
  const dryRun = process.env.REMEDIATION_DRY_RUN === '1';
  const maxDays = Number(process.env.REMEDIATION_MAX_DAYS || 8);
  const refill = process.env.REMEDIATION_REFILL?.trim() || '';
  const lateMode = resolveLateMode(process.env.REMEDIATION_LATE_USGS);
  const lateRange = process.env.REMEDIATION_LATE_USGS_RANGE?.trim() || '';
  if (lateRange && lateMode === 'off') throw new Error('REMEDIATION_LATE_USGS_RANGE is given without REMEDIATION_LATE_USGS on or plan');
  const lateMax = Number(process.env.REMEDIATION_LATE_MAX_DAYS || 40);
  const deadlineMs = Number(process.env.REMEDIATION_DEADLINE_S || 1200) * 1000;
  const startedMs = Date.now();
  // A dispatch of the refresh does the queue and the refresh, not the saturated days.
  const lateDispatch = ['on', 'plan'].includes((process.env.REMEDIATION_LATE_USGS ?? '').trim());
  const queueOnly = process.env.REMEDIATION_QUEUE_ONLY === '1' || refill !== '' || lateDispatch;
  mkdirSync(out, { recursive: true });
  const registry = loadRegistry();
  const paths = dataPaths(DATA_DIR);
  const cursor = JSON.parse(readFileSync(paths.backfillCursor, 'utf8')) as { providers: Record<string, { saturatedDays?: string[] }> };
  const archives = existsSync(paths.archivesIndex) ? (JSON.parse(readFileSync(paths.archivesIndex, 'utf8')) as { list: (ArchiveRef & { sha256?: string })[] }).list : [];
  const archivedDays = new Set(archives.flatMap((a) => a.days ?? []));
  const head = existsSync(paths.head) ? (JSON.parse(readFileSync(paths.head, 'utf8')) as { seq: number }) : { seq: 0 };
  const localIndex = join(out, 'remediation.json');
  const indexIn = dryRun && existsSync(localIndex) ? localIndex : paths.remediationIndex;
  const before = existsSync(indexIn) ? readFileSync(indexIn, 'utf8') : null;
  const idx: RemediationIndex = before ? (JSON.parse(before) as RemediationIndex) : emptyRemediationIndex();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const frozenBefore = new Date(nowMs - FROZEN_AFTER_DAYS * DAY_MS).toISOString().slice(0, 10);

  if (refill) {
    const providers = resolveProviders(process.env.REMEDIATION_PROVIDERS ?? '', registry);
    const added = enqueueRefill(idx, refill, providers, 'seam', nowIso);
    console.log(`remediate: refill ${refill} for ${providers.join(',')} ${added ? 'queued' : 'already queued'}`);
  } else if (process.env.REMEDIATION_PROVIDERS?.trim()) {
    throw new Error('REMEDIATION_PROVIDERS is given without REMEDIATION_REFILL');
  }

  const done = new Set(idx.raw.map((r) => `${r.provider}:${r.day}`));
  const plan = queuePlan(idx, archivedDays);
  let tasks: DayTask[] = [...(queueOnly ? [] : remediationTasks(cursor, frozenBefore, done)), ...plan.tasks];
  let editionOnly = plan.editionOnly;
  if (process.env.REMEDIATION_DAYS) {
    const only = new Set(process.env.REMEDIATION_DAYS.split(',').map((x) => x.trim()));
    tasks = tasks.filter((t) => only.has(`${t.provider}:${t.day}`));
    editionOnly = editionOnly.filter((d) => [...only].some((k) => k.endsWith(`:${d}`)));
  }
  const byDay = tasksByDay(tasks);
  for (const d of editionOnly) if (!byDay.has(d)) byDay.set(d, []);
  const days = [...byDay.keys()].sort();
  const runDays = days.slice(0, maxDays);

  const store: HistoryStore = dryRun ? new DryRunStore(new LocalStore(join(out, 'releases')), new GitHubStore(NOTES)) : new GitHubStore(NOTES);
  const work = mkdtempSync(join(tmpdir(), 'efd-remediate-'));
  const report = {
    done: [] as string[],
    failed: [] as string[],
    pending: days.length - runDays.length,
    waiting: plan.waiting,
    days: [] as { day: string; edition: string | null; raws: string[]; stats: EditionStats | null; failed: string[] }[],
    queue_done: [] as string[],
    queue: [] as unknown[],
    late_usgs: { mode: lateMode, range: lateRange || null, days: [] as string[], checked: [] as LateReport[], built: [] as string[], planned: [] as string[], unchanged: 0, failed: [] as string[], not_reached: [] as string[] },
  };
  console.log(
    `remediate: ${store.label}; ${days.length} day(s) to do (${days.map((d) => `${d}[${(byDay.get(d) ?? []).map((t) => t.provider).join(',') || 'edition'}]`).join(' ') || 'none'}); ` +
      `${maxDays} per run; queued days waiting for their archive: ${plan.waiting.join(', ') || 'none'}`,
  );
  // The archived days of this run and their neighbours, read once (one download per month, read only).
  const ctxAll = new Set(runDays.flatMap((d) => [dayShift(d, -1), d, dayShift(d, 1)]));
  const arch = readArchivedDays(archives, ctxAll);
  try {
    for (const day of runDays) {
      const r = await remediateDay(day, byDay.get(day) ?? [], idx, { store, registry, fetchWindow: fetchProviderWindow, archives, arch, work, nowMs, seqMarker: head.seq, spacingMs: SPACING_MS });
      report.failed.push(...r.failed);
      if (r.line) {
        report.done.push(r.line);
        console.log(`remediate: ${r.line}`);
      }
      for (const m of r.failed) console.log(`::warning::remediate: ${m}`);
      report.days.push({ day, edition: r.edition?.asset ?? null, raws: r.raws.map((x) => x.asset), stats: r.edition?.stats ?? null, failed: r.failed });
    }

    // The late-ComCat refresh (SHLTR-150): the frozen, unarchived days of the last 45 (or the dispatched range), oldest
    // first, each read from its partition by blob; at most `lateMax` editions and no day started past the deadline.
    if (lateMode !== 'off') {
      const lastFrozen = dayShift(frozenBeforeAt(nowMs), -1);
      const blobs = partitionBlobs(DATA_DIR, lastFrozen);
      const lateDays = lateUsgsDays({ nowMs, frozenBefore: frozenBeforeAt(nowMs), partitionDays: new Set(blobs.keys()), archivedDays, ...(lateRange ? { range: lateRange } : {}) });
      report.late_usgs.days = lateDays;
      console.log(`remediate: late ComCat (${lateMode}): ${lateDays.length} frozen day(s) not archived${lateRange ? ` in ${lateRange}` : ` of the last ${LATE_USGS_MAX_AGE_DAYS}`}: ${lateDays[0] ?? '-'}..${lateDays.at(-1) ?? '-'}`);
      const partitions = new Map<string, FrozenPartition>();
      const lateArch = readArchivedDays(archives, new Set(lateDays.flatMap((d) => [dayShift(d, -1), dayShift(d, 1)]).filter((d) => archivedDays.has(d))));
      for (const day of lateDays) {
        if (Date.now() - startedMs > deadlineMs || report.late_usgs.built.length >= lateMax) {
          report.late_usgs.not_reached.push(day);
          continue;
        }
        for (const d of [dayShift(day, -1), day, dayShift(day, 1)]) {
          const oid = blobs.get(d);
          if (oid && !partitions.has(d) && !archivedDays.has(d)) partitions.set(d, readPartition(DATA_DIR, d, oid));
        }
        const r = await remediateDay(day, [{ provider: LATE_USGS_PROVIDER, day, reason: 'late_usgs' }], idx, {
          store, registry, fetchWindow: fetchProviderWindow, archives, arch: lateArch, partitions, publish: lateMode === 'on', work, nowMs, seqMarker: head.seq, spacingMs: SPACING_MS,
        });
        // Only the partitions of the next day's context stay in memory.
        for (const d of [...partitions.keys()]) if (d < day) partitions.delete(d);
        if (r.late) report.late_usgs.checked.push({ day, ...r.late });
        if (r.failed.length) {
          report.late_usgs.failed.push(...r.failed);
          report.failed.push(...r.failed);
          for (const m of r.failed) console.log(`::warning::remediate: ${m}`);
        } else if (r.edition) {
          report.late_usgs.built.push(r.edition.asset);
          report.done.push(r.line!);
          console.log(`remediate: ${r.line}`);
        } else if (r.planned) {
          report.late_usgs.planned.push(day);
          console.log(`remediate: ${day} would get a late_usgs edition: ${lateLine(r.late!)}`);
        } else {
          report.late_usgs.unchanged++;
          if (r.late) console.log(`remediate: ${day} unchanged: ${lateLine(r.late)}`);
        }
        report.days.push({ day, edition: r.edition?.asset ?? null, raws: r.raws.map((x) => x.asset), stats: r.edition?.stats ?? null, failed: r.failed });
      }
      const L = report.late_usgs;
      console.log(`remediate: late ComCat (${lateMode}): ${L.checked.length} day(s) checked, ${L.built.length} edition(s) built, ${L.planned.length} would be built, ${L.unchanged} unchanged, ${L.failed.length} failure(s), ${L.not_reached.length} not reached (next run)`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  report.queue_done = pruneQueue(idx).map((e) => `${e.range} (${e.providers.join(',')})`);
  report.queue = idx.refill_queue ?? [];
  const text = indexText(idx);
  const changed = text !== before;
  if (changed) writeFileSync(localIndex, text);
  setOutput('changed', String(changed));
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`remediate: done=${report.done.length} failed=${report.failed.length} pending=${report.pending} waiting=${report.waiting.length} queue=${(idx.refill_queue ?? []).map((e) => e.range).join(' ') || 'empty'} index_changed=${changed}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('remediate failed:', err);
    process.exit(1);
  });
}
