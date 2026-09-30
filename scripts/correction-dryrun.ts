/**
 * Dry run of the one-time correction (config CORRECTION_EPOCH, src/correction.ts) against a local copy of the data
 * branch: loads the event_map exactly as aggregate does (LIVE_INDEX_DAYS), runs runCorrection in memory with its
 * marker sent to a scratch directory, and prints what it did and the duplicate counts before and after. No network;
 * writes nothing to the data directory.
 *
 * Usage:
 *   npx tsx scripts/correction-dryrun.ts --data <data-branch dir> [--now <iso>] [--lines <out.ndjson>] [--splits]
 *
 * <data-branch dir> needs knowledge/index (event_map shards + head.json), e.g.
 *   git archive origin/data knowledge/index | tar -x -C /tmp/data
 * --now defaults to head.ingest_time + 5 min (the next aggregate run). --lines writes the lines it would append;
 * --splits lists the AFAD rows still beside EMSC's AFAD-authored copy afterwards, with the gate that keeps them apart.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadState } from '../src/bitemporal.js';
import { LIVE_INDEX_DAYS } from '../src/config.js';
import { AFAD_LEGACY_OFFSET_MS, correctionFloor, runCorrection } from '../src/correction.js';
import { Resolver } from '../src/dedup.js';
import { haversineKm } from '../src/geo.js';
import { LogBuffer } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, ProvenanceRow } from '../src/types.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = opt('--data');
if (!dataDir) {
  console.error('usage: correction-dryrun --data <data-branch dir> [--now <iso>] [--lines <out.ndjson>] [--splits]');
  process.exit(2);
}
const head = JSON.parse(readFileSync(resolve(dataDir, 'knowledge/index/head.json'), 'utf8')) as { seq: number; ingest_time: string };
const nowMs = opt('--now') ? Date.parse(opt('--now')!) : Date.parse(head.ingest_time) + 5 * 60_000;
const ingestTime = new Date(nowMs).toISOString();
const registry = loadRegistry(resolve(new URL('../providers/registry.json', import.meta.url).pathname));
const state = loadState(dataDir, { sinceDays: LIVE_INDEX_DAYS, nowMs });
const { floorMs, fromDay } = correctionFloor(nowMs);

const liveFromFloor = (): EventNode[] => [...state.eventMap.values()].filter((n) => n.state === 'live' && n.eventTimeMs >= floorMs);
/** The ComCat catalog prefix of the regional networks' ids (NCEDC 75438707 is ComCat nc75438707). */
const COMCAT_ID_PREFIX = new Map([['ncedc', 'nc'], ['scedc', 'ci']]);
const isAfadCopy = (r: ProvenanceRow): boolean => r.provider === 'emsc' && r.fields['auth'] === 'AFAD';

/** AFAD rows and EMSC's AFAD-authored copies in different live events, ±2 s / 2 km apart (`shiftS` later). */
function copyPairs(live: EventNode[], shiftS: number): [EventNode, ProvenanceRow, EventNode][] {
  const bySec = new Map<number, [EventNode, ProvenanceRow][]>();
  for (const n of live) for (const r of n.provenance) if (isAfadCopy(r)) {
    const s = Math.round(r.eventTimeMs / 1000);
    (bySec.get(s) ?? bySec.set(s, []).get(s)!).push([n, r]);
  }
  const out: [EventNode, ProvenanceRow, EventNode][] = [];
  for (const n of live) for (const r of n.provenance) {
    if (r.provider !== 'afad') continue;
    const s0 = Math.round(r.eventTimeMs / 1000) + shiftS;
    let found: EventNode | null = null;
    for (let s = s0 - 2; s <= s0 + 2 && !found; s++) {
      for (const [m, e] of bySec.get(s) ?? []) if (m !== n && haversineKm(r.lat, r.lon, e.lat, e.lon) <= 2) found = m;
    }
    if (found) out.push([n, r, found]);
  }
  return out;
}

function metrics(label: string): void {
  const live = liveFromFloor();
  let afadRows = 0;
  let early = 0;
  for (const n of live) for (const r of n.provenance) if (r.provider === 'afad') {
    afadRows++;
    if (Date.parse(`${r.fields['date']}Z`) - r.eventTimeMs === AFAD_LEGACY_OFFSET_MS) early++;
  }
  const alias = new Map<string, EventNode>();
  for (const n of live) for (const a of n.aliases) alias.set(a, n);
  let regionalSplits = 0;
  for (const n of live) for (const r of n.provenance) {
    const prefix = COMCAT_ID_PREFIX.get(r.provider);
    if (prefix == null) continue;
    const o = alias.get(`usgs:${prefix}${r.nativeId}`);
    if (o && o !== n) regionalSplits++;
  }
  let providerTwice = 0;
  for (const n of live) if (new Set(n.provenance.map((r) => r.provider)).size < n.provenance.length) providerTwice++;
  const owner = new Map<string, string>();
  let aliasTwice = 0;
  for (const n of state.eventMap.values()) {
    if (n.state !== 'live') continue;
    for (const a of n.aliases) {
      if (owner.has(a) && owner.get(a) !== n.feedId) aliasTwice++;
      owner.set(a, n.feedId);
    }
  }
  console.log(
    `${label}: live events from ${fromDay}: ${live.length}; AFAD rows ${afadRows}, 3 h early ${early}; AFAD / EMSC-copy pairs in two events: ` +
      `same time ${copyPairs(live, 0).length}, 3 h apart ${copyPairs(live, AFAD_LEGACY_OFFSET_MS / 1000).length}; ComCat-id rows in another event ` +
      `than ComCat's row of the id ${regionalSplits}; events holding one provider twice ${providerTwice}; aliases on two live events ${aliasTwice}`,
  );
}

/** Every provider row on a live event (the whole loaded window): the correction moves rows, it never drops one. */
const liveRowKeys = (): Set<string> =>
  new Set([...state.eventMap.values()].filter((n) => n.state === 'live').flatMap((n) => n.provenance.map((r) => `${r.provider}:${r.nativeId}`)));
const keysBefore = liveRowKeys();
metrics('before');
const log = new LogBuffer(head.seq, ingestTime);
const scratch = mkdtempSync(join(tmpdir(), 'correction-dryrun-'));
const marker = runCorrection(scratch, state.eventMap, priorityMap(registry), configMap(registry), log, { nowMs, ingestTime });
rmSync(scratch, { recursive: true, force: true });
metrics('after ');
const keysAfter = liveRowKeys();
const lost = [...keysBefore].filter((k) => !keysAfter.has(k));
const gained = [...keysAfter].filter((k) => !keysBefore.has(k));
console.log(`provider rows on live events: before ${keysBefore.size}, after ${keysAfter.size}; lost ${lost.length}${lost.length ? ` (${lost.slice(0, 10).join(', ')})` : ''}; gained ${gained.length}`);
console.log(`marker: ${JSON.stringify(marker)}`);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(new URL('../schema/observation.schema.json', import.meta.url), 'utf8')) as object);
const ops: Record<string, number> = {};
for (const l of log.lines) ops[l.op] = (ops[l.op] ?? 0) + 1;
const invalid = log.lines.filter((l) => !vObs(l as object)).length;
const contiguous = log.lines.every((l, i) => l.seq === head.seq + 1 + i);
console.log(`lines: ${log.lines.length} ${JSON.stringify(ops)}; schema-invalid ${invalid}; seq contiguous from ${head.seq + 1}: ${contiguous}`);
const merges = log.lines.filter((l): l is Observation & { reason: string } => l.op === 'merge' && typeof l.reason === 'string');
const num = (re: RegExp): number[] => merges.map((m) => re.exec(m.reason)).filter((x): x is RegExpExecArray => x != null).map((x) => Number(x[1]));
const q = (v: number[], p: number): number => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * p))] ?? NaN;
const dist = num(/ d=([\d.]+) km/);
const dt = num(/ dt=([\d.]+) s/);
if (dist.length) console.log(`proximity folds: ${dist.length}; d km p50 ${q(dist, 0.5)} p99 ${q(dist, 0.99)} max ${Math.max(...dist)}; dt s p50 ${q(dt, 0.5)} p99 ${q(dt, 0.99)} max ${Math.max(...dt)}`);
const exact = merges.filter((m) => m.reason.startsWith('exact id')).length;
if (exact) console.log(`exact-id folds: ${exact}`);
if (opt('--lines')) writeFileSync(opt('--lines')!, log.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
if (args.includes('--splits')) {
  const r = new Resolver(state.eventMap, priorityMap(registry), configMap(registry), nowMs, { hotFloorMs: floorMs });
  const rows = (n: EventNode): string => n.provenance.map((x) => `${x.provider}:${x.nativeId} ${new Date(x.eventTimeMs).toISOString().slice(11, 19)} M${x.mag}`).join(', ');
  for (const [n, , m] of copyPairs(liveFromFloor(), 0)) console.log(`  still split: ${n.feedId} [${rows(n)}] / ${m.feedId} [${rows(m)}]: ${r.whyNotMerged(n, m)}`);
}
