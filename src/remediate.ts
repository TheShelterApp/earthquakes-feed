import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { type ArchiveRef, readArchivedDays } from './archive-io.js';
import { backfillCfg } from './backfill-cfg.js';
import { DATA_DIR, dataPaths } from './config.js';
import { GitHubStore, type HistoryStore, LocalStore } from './history-store.js';
import { FROZEN_AFTER_DAYS } from './partitions.js';
import { fetchProviderWindow, loadRegistry } from './providers.js';
import {
  type DayTask,
  type EditionRef,
  type RawRef,
  type RemediationIndex,
  RAW_REMEDIATION_KIND,
  buildDayEdition,
  editionProblems,
  editionAssetName,
  emptyRemediationIndex,
  fetchDayInWindows,
  indexText,
  nextFree,
  parseRawText,
  rawAssetName,
  rawText,
  remediationTag,
  remediationTasks,
} from './remediation.js';
import type { RawObs } from './types.js';

/**
 * FEED-DQ-1 / DQ-3 remediation run (src/remediation.ts; APIs.md, Saturated days).
 *
 *   npx tsx src/remediate.ts
 *
 * Environment:
 *   DATA_DIR                  a checkout (or copy) of the data branch; read only: knowledge/index/backfill.json (the
 *                             saturated days), archives.json, head.json, remediation.json
 *   REMEDIATION_OUT           output directory (default remediation-out): remediation.json (the new index, when it
 *                             changed) and report.json; the workflow's commit job copies the index to the data branch
 *   REMEDIATION_DRY_RUN=1     no Release, no upload: assets go to REMEDIATION_OUT/releases/<tag>/
 *   REMEDIATION_DAYS          only these tasks, e.g. "kagsr:2025-07-30,afad:2025-08-11" (default: every saturated day)
 *   REMEDIATION_MAX_DAYS      days per run (default 8)
 *
 * It writes nothing to DATA_DIR. One request at a time per source host, at least 1.1 s apart.
 */

const SPACING_MS = 1_100;
const DAY_MS = 86_400_000;
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const dayShift = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const assetUrl = (tag: string, asset: string): string => `https://github.com/TheShelterApp/earthquakes-feed/releases/download/${tag}/${asset}`;

const NOTES = (tag: string): string =>
  `Saturated-day remediation of earthquakes-feed for ${tag.slice(-4)}: immutable raw source answers ` +
  '(raw-<source>-<day>.ndjson.gz) and complete day editions (events-<day>.e<N>.ndjson.gz) for days whose backfill ' +
  'window filled the source page cap. The archived day is unchanged. Index: knowledge/index/remediation.json on the ' +
  'data branch; format: APIs.md, Saturated days.';

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

async function main(): Promise<void> {
  const out = process.env.REMEDIATION_OUT ?? 'remediation-out';
  const dryRun = process.env.REMEDIATION_DRY_RUN === '1';
  const maxDays = Number(process.env.REMEDIATION_MAX_DAYS || 8);
  mkdirSync(out, { recursive: true });
  const registry = loadRegistry();
  const byId = new Map(registry.map((p) => [p.id, p]));
  const paths = dataPaths(DATA_DIR);
  const cursor = JSON.parse(readFileSync(paths.backfillCursor, 'utf8')) as { providers: Record<string, { saturatedDays?: string[] }> };
  const archives = existsSync(paths.archivesIndex) ? (JSON.parse(readFileSync(paths.archivesIndex, 'utf8')) as { list: (ArchiveRef & { sha256?: string })[] }).list : [];
  const head = existsSync(paths.head) ? (JSON.parse(readFileSync(paths.head, 'utf8')) as { seq: number }) : { seq: 0 };
  const localIndex = join(out, 'remediation.json');
  const indexIn = dryRun && existsSync(localIndex) ? localIndex : paths.remediationIndex;
  const before = existsSync(indexIn) ? readFileSync(indexIn, 'utf8') : null;
  const idx: RemediationIndex = before ? (JSON.parse(before) as RemediationIndex) : emptyRemediationIndex();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const frozenBefore = new Date(nowMs - FROZEN_AFTER_DAYS * DAY_MS).toISOString().slice(0, 10);
  const done = new Set(idx.raw.map((r) => `${r.provider}:${r.day}`));
  let tasks: DayTask[] = remediationTasks(cursor, frozenBefore, done);
  if (process.env.REMEDIATION_DAYS) {
    const only = new Set(process.env.REMEDIATION_DAYS.split(',').map((x) => x.trim()));
    tasks = tasks.filter((t) => only.has(`${t.provider}:${t.day}`));
  }
  const store: HistoryStore = dryRun ? new LocalStore(join(out, 'releases')) : new GitHubStore(NOTES);
  const work = mkdtempSync(join(tmpdir(), 'efd-remediate-'));
  const report = { done: [] as string[], failed: [] as string[], pending: Math.max(0, tasks.length - maxDays) };
  console.log(`remediate: ${store.label}; ${tasks.length} saturated day(s) to do (${tasks.map((t) => `${t.provider}:${t.day}`).join(', ') || 'none'}); ${maxDays} per run`);
  // The archived days of this run's tasks and their neighbours, read once (one download per month, read only).
  const runTasks = tasks.slice(0, maxDays);
  const ctxAll = new Set(runTasks.flatMap((t) => [dayShift(t.day, -1), t.day, dayShift(t.day, 1)]));
  const arch = readArchivedDays(archives, ctxAll);
  try {
    for (const t of runTasks) {
      const p = byId.get(t.provider);
      if (!p) {
        report.failed.push(`${t.provider}:${t.day}: not in the registry`);
        continue;
      }
      const cfg = backfillCfg(p);
      // 1) The source's day in sub-day windows.
      const f = await fetchDayInWindows(t.day, (s, e) => fetchProviderWindow(p, s, e, cfg?.minmag), { spacingMs: SPACING_MS });
      if (!f.ok) {
        report.failed.push(`${t.provider}:${t.day}: ${f.error} (${f.requests} request(s)); asked again next run`);
        console.log(`::warning::remediate: ${t.provider}:${t.day} failed: ${f.error}`);
        continue;
      }
      // 2) The archived day and its neighbours (read only).
      const ctxDays = [dayShift(t.day, -1), t.day, dayShift(t.day, 1)];
      const unreadable = ctxDays.map((d) => d.slice(0, 7)).filter((m) => arch.failedMonths.has(m));
      if (unreadable.length) {
        report.failed.push(`${t.provider}:${t.day}: archive unreadable for ${[...new Set(unreadable)].join(', ')}; asked again next run`);
        continue;
      }
      const context = new Map(ctxDays.filter((d) => arch.days.has(d)).map((d) => [d, arch.days.get(d)!]));
      const base = archives.find((a) => (a.days ?? []).includes(t.day));
      if (!base || !arch.days.has(t.day)) {
        report.failed.push(`${t.provider}:${t.day}: the day is in no archive; a remediation edition supplements an archived day only`);
        continue;
      }
      // 3) Rows of every provider already remediated on this day, read back from their raw assets.
      const tag = remediationTag(t.day);
      const others = idx.raw.filter((r) => r.day === t.day && r.provider !== t.provider);
      const rows: RawObs[] = [...f.rows];
      for (const r of others) {
        const fpath = join(work, r.asset);
        store.download(r.tag, r.asset, fpath);
        const bytes = readFileSync(fpath);
        if (sha256(bytes) !== r.sha256) throw new Error(`${r.tag}/${r.asset} has another checksum than the index lists`);
        rows.push(...parseRawText(gunzipSync(bytes).toString('utf8')).rows);
      }
      // 4) The edition, then the uploads (raw first: an edition never names a raw asset that is not there).
      // Fresh nodes per task: buildDayEdition ingests into them.
      const fresh = new Map([...context].map(([d, nodes]) => [d, nodes.map((n) => structuredClone(n))]));
      const built = buildDayEdition({ day: t.day, context: fresh, rows, registry, nowMs, ingestTime: nowIso, seqMarker: head.seq });
      const problems = editionProblems(t.day, built.nodes);
      if (problems.length) {
        report.failed.push(`${t.provider}:${t.day}: the edition fails its check: ${problems.slice(0, 3).join('; ')}`);
        continue;
      }
      const names = new Set(store.list(tag).map((a) => a.name));
      const rawName = rawAssetName(t.provider, t.day, nextFree(names, (n) => rawAssetName(t.provider, t.day, n)));
      const rawBytes = gzipSync(rawText({ kind: RAW_REMEDIATION_KIND, version: 1, provider: t.provider, day: t.day, fetched_at: nowIso, rows: f.rows.length, requests: f.requests, partial: f.partial, windows: f.windows }, f.rows), { level: 9 });
      const rawFile = join(work, rawName);
      writeFileSync(rawFile, rawBytes);
      const rawSum = sha256(rawBytes);
      const prevEdition = Math.max(0, ...idx.editions.filter((e) => e.day === t.day).map((e) => e.edition));
      const edition = nextFree(names, (n) => editionAssetName(t.day, n), prevEdition + 1);
      const edName = editionAssetName(t.day, edition);
      const edBytes = gzipSync(Buffer.from(built.text), { level: 9 });
      const edFile = join(work, edName);
      writeFileSync(edFile, edBytes);
      const edSum = sha256(edBytes);
      uploadVerified(store, tag, rawFile, rawSum, work);
      const rawRef: RawRef = {
        provider: t.provider, day: t.day, tag, asset: rawName, url: assetUrl(tag, rawName), sha256: rawSum, bytes: rawBytes.length,
        rows: f.rows.length, requests: f.requests, partial: f.partial, fetched_at: nowIso,
      };
      idx.raw.push(rawRef);
      uploadVerified(store, tag, edFile, edSum, work);
      const ed: EditionRef = {
        day: t.day, edition, tag, asset: edName, url: assetUrl(tag, edName), sha256: edSum, bytes: edBytes.length,
        built_on: { tag: base.tag, asset: base.asset, sha256: base.sha256 ?? null },
        built_from: [rawName, ...others.map((r) => r.asset)].sort(),
        stats: built.stats, built_at: nowIso,
      };
      idx.editions.push(ed);
      const s = built.stats;
      const line =
        `${t.provider}:${t.day} -> ${tag}/${edName}: ${f.rows.length} rows in ${f.windows.filter((w) => !w.split).length} window(s) (${f.requests} requests${f.partial ? ', PARTIAL' : ''}); ` +
        `events ${s.archived_events} -> ${s.events}, live ${s.live_before} -> ${s.live_after} (+${s.new_events} new, ${s.retired} retired, ${s.left_day} left the day; rows ${s.changed} changed, ${s.unchanged} unchanged, ${s.screened} screened` +
        `${s.afad_retimed || s.afad_moved_out ? `; AFAD re-read ${s.afad_retimed} retimed, ${s.afad_moved_out} moved out, ${s.merged} folded` : ''}); ` +
        `${t.provider} rows ${s.provider_rows[t.provider]?.before ?? 0} -> ${s.provider_rows[t.provider]?.after ?? 0}`;
      report.done.push(line);
      console.log(`remediate: ${line}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const text = indexText(idx);
  const changed = text !== before;
  if (changed) writeFileSync(localIndex, text);
  setOutput('changed', String(changed));
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`remediate: done=${report.done.length} failed=${report.failed.length} pending=${report.pending} index_changed=${changed}`);
  if (report.failed.length) for (const m of report.failed) console.log(`::warning::remediate: ${m}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('remediate failed:', err);
    process.exit(1);
  });
}
