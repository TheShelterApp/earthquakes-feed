import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HEAL_EPOCH, dataPaths } from './config.js';
import type { Resolver } from './dedup.js';
import type { LogBuffer } from './oplog.js';

/** knowledge/index/heal.json — which one-time heal the data branch has had (config HEAL_EPOCH).
 *  Written by aggregate in the same commit as the heal's log lines, so the heal and its marker
 *  land together or not at all: a run whose push fails leaves no marker, and the next run heals
 *  again from the state that did land. */
export interface HealMarker {
  epoch: number;
  ingest_time: string;
  /** The seq range of the heal's own lines (op:tombstone retractions, op:merge, op:correction). */
  first_seq: number | null;
  last_seq: number | null;
  /** Event-map days the heal run loaded (the retraction covers all of them). */
  horizon_days: number;
  retracted: number;
  merged: number;
  survivors: number;
}

/** The epoch the data branch has been healed to; 0 when it never was. */
export function healedEpoch(root: string): number {
  const f = dataPaths(root).healMarker;
  if (!existsSync(f)) return 0;
  const m = JSON.parse(readFileSync(f, 'utf8')) as Partial<HealMarker>;
  return typeof m.epoch === 'number' ? m.epoch : 0;
}

export function writeHealMarker(root: string, marker: HealMarker): void {
  const f = dataPaths(root).healMarker;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(marker, null, 2) + '\n');
}

export const RETRACTION_REASON = 'coordinate-less: lat 0, lon 0 and magnitude 0 or none (not located)';

export interface FeedSideResult {
  /** Rows the coordinate-less retraction withdrew (one op:tombstone line each). */
  retracted: number;
  retractedByProvider: Record<string, number>;
  /** The marker written when this run healed, else null. */
  heal: HealMarker | null;
}

/** aggregate's feed-side steps, after the provider paths of the run: the coordinate-less
 *  retraction (every run; a no-op once nothing is left) and, when `healDue`, the one-time heal
 *  (Resolver.heal) and its marker. Every change is logged through `log` like the normal path:
 *  op:tombstone per withdrawn row (with a reason), op:merge per fold, op:correction per heal
 *  survivor. */
export function runFeedSideSteps(
  root: string,
  resolver: Resolver,
  log: LogBuffer,
  opts: { healDue: boolean; loadDays: number; ingestTime: string },
): FeedSideResult {
  const firstSeq = log.seq + 1;
  const retractedByProvider: Record<string, number> = {};
  const retractions = resolver.retractCoordinateless(opts.ingestTime);
  for (const { raw, result } of retractions) {
    log.record(raw, result, 'tombstone', RETRACTION_REASON);
    retractedByProvider[raw.provider] = (retractedByProvider[raw.provider] ?? 0) + 1;
  }
  let heal: HealMarker | null = null;
  if (opts.healDue) {
    const { merges, survivors } = resolver.heal(opts.ingestTime);
    log.recordHeal(merges, survivors, HEAL_EPOCH);
    const wrote = log.seq >= firstSeq;
    heal = {
      epoch: HEAL_EPOCH,
      ingest_time: opts.ingestTime,
      first_seq: wrote ? firstSeq : null,
      last_seq: wrote ? log.seq : null,
      horizon_days: opts.loadDays,
      retracted: retractions.length,
      merged: merges.length,
      survivors: survivors.length,
    };
    writeHealMarker(root, heal);
  }
  return { retracted: retractions.length, retractedByProvider, heal };
}
