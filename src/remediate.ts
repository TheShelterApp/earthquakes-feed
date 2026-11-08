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
import { FROZEN_AFTER_DAYS } from './partitions.js';
import { type WindowOutcome, fetchProviderWindow, loadRegistry } from './providers.js';
import {
  type AssetRef,
  type DayTask,
  type EditionRef,
  type EditionStats,
  type RawRef,
  type RemediationIndex,
  type RemediationReason,
  EDITION_FORMAT,
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
  nextFree,
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
 * Remediation run (src/remediation.ts; APIs.md, Remediation editions): the saturated backfill days (FEED-DQ-1 / DQ-3)
 * and explicit refills such as the 2026-06-28..07-03 seam, one complete edition per day.
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
 *
 * The queue's days are taken as soon as their month is archived; the others stay queued. It writes nothing to
 * DATA_DIR. One request at a time, at least 1.1 s apart.
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
  `Remediation of earthquakes-feed for ${tag.slice(-4)}: saturated backfill days and the 2026-06-28..07-03 seam. ` +
  'Immutable raw source answers (raw-<source>-<day>.ndjson.gz) and complete day editions (events-<day>.e<N>.ndjson.gz) ' +
  'for days a source\'s backfill could not fetch whole or the live layer\'s start left empty. The archived day is ' +
  'unchanged. Index: knowledge/index/remediation.json on the data branch; format: APIs.md, Remediation editions.';

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
  work: string;
  nowMs: number;
  seqMarker: number;
  spacingMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DayRunResult {
  day: string;
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
  const reason: RemediationReason = tasks.some((t) => t.reason === 'seam') || (!tasks.length && dayRaws(idx, day).some((r) => r.reason === 'seam')) ? 'seam' : 'saturated';
  const base = archiveOf(deps.archives, day);
  const ctxDays = [dayShift(day, -1), day, dayShift(day, 1)];
  const unreadable = [...new Set(ctxDays.map((d) => d.slice(0, 7)).filter((m) => deps.arch.failedMonths.has(m)))];
  if (unreadable.length) {
    res.failed.push(`${day}: archive unreadable for ${unreadable.join(', ')}; asked again next run`);
    return res;
  }
  if (!base || !deps.arch.days.has(day)) {
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

  // 2) The context as consumers read it: the archived day; each neighbour's current edition, else its archived day.
  const context = new Map<string, EventNode[]>();
  const contextRefs: Record<string, AssetRef> = {};
  for (const d of ctxDays) {
    const ed = d === day ? undefined : currentEdition(idx, d);
    if (ed) {
      context.set(d, readIndexed(deps.store, ed, deps.work).split('\n').filter((l) => l.trim()).map((l) => featureToNode(JSON.parse(l))));
      contextRefs[d] = { tag: ed.tag, asset: ed.asset, sha256: ed.sha256 };
      continue;
    }
    const a = deps.arch.days.get(d);
    const ref = archiveOf(deps.archives, d);
    if (!a || !ref) continue; // a neighbour not archived (yet): its partition is not part of the context
    context.set(d, a);
    contextRefs[d] = { tag: ref.tag, asset: ref.asset, sha256: ref.sha256 ?? null };
  }

  // 3) Rows: the fetched ones, then every other raw of the day already indexed (the newest per source).
  const fetchedProviders = new Set(fetched.map((f) => f.task.provider));
  const others = dayRaws(idx, day).filter((r) => !fetchedProviders.has(r.provider));
  if (!fetched.length && !others.length) return res;
  const rows: RawObs[] = fetched.flatMap((f) => f.rows);
  for (const r of others) rows.push(...parseRawText(readIndexed(deps.store, r, deps.work)).rows);

  // 4) The edition (fresh nodes: buildDayEdition ingests into them), its check, then the uploads: raws first.
  const fresh = new Map([...context].map(([d, nodes]) => [d, nodes.map((n) => structuredClone(n))]));
  const built = buildDayEdition({ day, context: fresh, rows, registry: deps.registry, nowMs: deps.nowMs, ingestTime: nowIso, seqMarker: deps.seqMarker, fmt: EDITION_FORMAT });
  const problems = editionProblems(day, built.nodes, context);
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
    built_on: { tag: base.tag, asset: base.asset, sha256: base.sha256 ?? null },
    built_from: [...raws.map((r) => r.ref.asset), ...others.map((r) => r.asset)].sort(),
    reason,
    context: contextRefs,
    stats: built.stats, built_at: nowIso,
  };
  idx.editions.push(ed);
  res.edition = ed;
  res.line = summaryLine(day, `${tag}/${edName}`, fetched, built.stats);
  return res;
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

async function main(): Promise<void> {
  const out = process.env.REMEDIATION_OUT ?? 'remediation-out';
  const dryRun = process.env.REMEDIATION_DRY_RUN === '1';
  const maxDays = Number(process.env.REMEDIATION_MAX_DAYS || 8);
  const refill = process.env.REMEDIATION_REFILL?.trim() || '';
  const queueOnly = process.env.REMEDIATION_QUEUE_ONLY === '1' || refill !== '';
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
