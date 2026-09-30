import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { eventDayKey } from './bitemporal.js';
import { CORRECTION_EPOCH, HOT_WINDOW_DAYS, LIVE_INDEX_DAYS, dataPaths } from './config.js';
import { parseAfad } from './custom.js';
import { Resolver } from './dedup.js';
import type { LogBuffer } from './oplog.js';
import type { EventNode, ProviderConfig, RawObs } from './types.js';

/** knowledge/index/correction.json — which one-time correction the data branch has had (config CORRECTION_EPOCH).
 *  Written by aggregate in the same commit as the correction's log lines, like heal.json: a run whose push fails
 *  leaves no marker, and the next run corrects again from the state that did land. */
export interface CorrectionMarker {
  epoch: number;
  ingest_time: string;
  /** The seq range of the correction's own lines. */
  first_seq: number | null;
  last_seq: number | null;
  /** The oldest event day it covered: the oldest day the manifest does not call frozen. Older days are untouched. */
  from_day: string;
  afad: AfadCorrection;
}

export interface AfadCorrection {
  /** Live AFAD rows (event day ≥ from_day) found 3 h before their own `date`. */
  found: number;
  /** Rows re-timed where they were (every row of their event is AFAD's). */
  retimed: number;
  /** Rows that had joined another source's event at their wrong time: withdrawn there and placed anew. */
  moved_out: number;
  /** op:merge lines of the fold pass over the events the re-timed rows touched (an AFAD event folding into EMSC's
   *  copy of it, or into another source's report of the same quake). */
  merged: number;
  /** Live events whose revision the folds moved (one op:correction line each). */
  survivors: number;
  /** Rows whose event moved to another UTC day. */
  day_changed: number;
}

/** The provider the epoch-1 AFAD correction re-reads. */
export const AFAD_PROVIDER = 'afad';
/** How early the pre-2026-10-01 parser stored every AFAD time (it read AFAD's UTC `date` as UTC+3). */
export const AFAD_LEGACY_OFFSET_MS = 3 * 3_600_000;
export const AFAD_RETIMED_REASON =
  'correction epoch 1: re-read with the fixed AFAD parser; AFAD times are UTC and this row had been stored 3 h early, as Turkish local time (PF-5e)';
export const AFAD_MOVED_OUT_REASON =
  'correction epoch 1: this AFAD row had joined the event at its 3 h early time; re-read at the right time, it is placed anew (PF-5e)';
/** The label of the op:correction lines of the fold pass (LogBuffer.recordFolds). */
export const CORRECTION_FOLD_LABEL = `correction epoch ${CORRECTION_EPOCH}`;

/** The epoch the data branch has been corrected to; 0 when it never was. */
export function correctedEpoch(root: string): number {
  const f = dataPaths(root).correctionMarker;
  if (!existsSync(f)) return 0;
  const m = JSON.parse(readFileSync(f, 'utf8')) as Partial<CorrectionMarker>;
  return typeof m.epoch === 'number' ? m.epoch : 0;
}

export function writeCorrectionMarker(root: string, marker: CorrectionMarker): void {
  const f = dataPaths(root).correctionMarker;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(marker, null, 2) + '\n');
}

/** The oldest event day the correction may touch: the manifest calls a day frozen once it is older than
 *  LIVE_INDEX_DAYS (partitions.ts FROZEN_AFTER_DAYS), and a frozen day's bytes never change again. */
export function correctionFloor(nowMs: number): { fromDay: string; floorMs: number } {
  const fromDay = eventDayKey(nowMs - LIVE_INDEX_DAYS * 86_400_000);
  return { fromDay, floorMs: Date.parse(`${fromDay}T00:00:00Z`) };
}

/** Every live AFAD row of an event at or after `floorMs` that the pre-2026-10-01 parser stored: re-read from its own
 *  stored field vocabulary with the fixed parser (parseAfad), it lands exactly AFAD_LEGACY_OFFSET_MS later and
 *  otherwise unchanged. Deterministic order (corrected time, then id), so the log lines replay. */
export function afadCorrections(eventMap: Map<string, EventNode>, floorMs: number): RawObs[] {
  const out: RawObs[] = [];
  for (const node of eventMap.values()) {
    if (node.state !== 'live' || node.eventTimeMs < floorMs) continue;
    for (const r of node.provenance) {
      if (r.provider !== AFAD_PROVIDER) continue;
      const again = parseAfad([r.fields], r.provider)[0];
      if (!again || again.providerEventId !== r.nativeId) continue;
      if (again.eventTimeMs - r.eventTimeMs !== AFAD_LEGACY_OFFSET_MS) continue;
      if (again.lat !== r.lat || again.lon !== r.lon || again.depth !== r.depth || again.mag !== r.mag || again.magType !== r.magType || again.place !== r.place) continue;
      out.push(again);
    }
  }
  return out.sort((a, b) => a.eventTimeMs - b.eventTimeMs || (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0));
}

/** aggregate's one-time correction (config CORRECTION_EPOCH), run before the run's own reports over the days the
 *  manifest does not call frozen. It works on `eventMap` through a Resolver of its own whose window starts at that
 *  floor, so its folds reach every such day (the run's Resolver, built afterwards, keeps the usual 7-day window); a
 *  cell's density (the swarm guard) is still counted over the 7-day hot window, as in the regular pass.
 *  Every change is logged through `log` like the normal path.
 *
 *  AFAD (PF-5e): each row stored 3 h early is re-read (afadCorrections) and handed to Resolver.correctReport: an
 *  op:observe line with AFAD_RETIMED_REASON where the row moves with its event, or an op:tombstone line with
 *  AFAD_MOVED_OUT_REASON and an op:observe line where it leaves another source's event. Once every row is at its
 *  real time, Resolver.foldAround folds the events they touched into the events they belong to: op:merge lines, then
 *  an op:correction line per survivor (CORRECTION_FOLD_LABEL). Rows of frozen days keep their old time: the feed does
 *  not rewrite history. */
export function runCorrection(
  root: string,
  eventMap: Map<string, EventNode>,
  priority: Map<string, number>,
  cfg: Map<string, ProviderConfig>,
  log: LogBuffer,
  opts: { nowMs: number; ingestTime: string },
): CorrectionMarker {
  const firstSeq = log.seq + 1;
  const { fromDay, floorMs } = correctionFloor(opts.nowMs);
  // Its window starts at the floor, but a cell's density is counted over the hot window, as in the regular pass.
  const resolver = new Resolver(eventMap, priority, cfg, opts.nowMs, { hotFloorMs: floorMs, denseFloorMs: opts.nowMs - HOT_WINDOW_DAYS * 86_400_000 });

  const afad: AfadCorrection = { found: 0, retimed: 0, moved_out: 0, merged: 0, survivors: 0, day_changed: 0 };
  const corrections = afadCorrections(eventMap, floorMs);
  afad.found = corrections.length;
  const touched: string[] = [];
  for (const raw of corrections) {
    const dayBefore = eventDayKey(raw.eventTimeMs - AFAD_LEGACY_OFFSET_MS);
    const entries = resolver.correctReport(raw, opts.ingestTime);
    for (const e of entries) {
      log.record(e.raw, e.result, e.op, e.op === 'tombstone' ? AFAD_MOVED_OUT_REASON : AFAD_RETIMED_REASON);
      touched.push(e.result.node.feedId);
    }
    if (!entries.length) continue;
    if (entries.some((e) => e.op === 'tombstone')) afad.moved_out++;
    else afad.retimed++;
    if (eventDayKey(raw.eventTimeMs) !== dayBefore) afad.day_changed++;
  }
  const folds = resolver.foldAround(touched, opts.ingestTime);
  log.recordFolds(folds.merges, folds.survivors, CORRECTION_FOLD_LABEL);
  afad.merged = folds.merges.length;
  afad.survivors = folds.survivors.length;

  const wrote = log.seq >= firstSeq;
  const marker: CorrectionMarker = {
    epoch: CORRECTION_EPOCH,
    ingest_time: opts.ingestTime,
    first_seq: wrote ? firstSeq : null,
    last_seq: wrote ? log.seq : null,
    from_day: fromDay,
    afad,
  };
  writeCorrectionMarker(root, marker);
  return marker;
}
