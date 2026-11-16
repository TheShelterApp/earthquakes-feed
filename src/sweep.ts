import { EVENT_MAP_HORIZON_DAYS, LATE_MINT_PROVIDERS } from './config.js';
import type { Resolver } from './dedup.js';
import type { LogBuffer } from './oplog.js';
import { byIngestOrder } from './quality.js';
import type { RawObs, Watermarks } from './types.js';
import { advanceWatermark } from './watermark.js';

/** One event the sweep minted (the run log names each). */
export interface LateMint {
  feedId: string;
  provider: string;
  providerEventId: string;
  mag: number | null;
  place: string | null;
  eventTime: string;
  /** Origin to this run's ingest time, in days. */
  lagDays: number;
}

/** One unknown row withheld beside another provider's event (Resolver.reviseOrMintInHotWindow). */
export interface LateWithheld {
  provider: string;
  providerEventId: string;
  mag: number | null;
  eventTime: string;
  /** The live event it most likely duplicates, and how far from it. */
  nearFeedId: string;
  nearProviders: string[];
  km: number;
  dtS: number;
}

export interface SweepResult {
  /** Known events the sweep changed (one op:observe line each; a revision of a row that represents nothing gets its
   *  line too, LogBuffer.recordIngest, and is not counted here). */
  revisions: number;
  /** Events the sweep minted (status `late_minted`), in ingest order. */
  lateMinted: LateMint[];
  /** Unknown rows inside the hot window not minted beside another provider's event (status `late_withheld`). */
  lateWithheld: LateWithheld[];
  /** Rows older than the copy the feed already holds (Resolver.isOlderThanStored), skipped. */
  stale: number;
}

const lagDaysOf = (raw: RawObs, ingestTime: string): number => (Date.parse(ingestTime) - raw.eventTimeMs) / 86_400_000;

const DAY_MS = 86_400_000;

/** The first instant derive loads (derive.ts: EVENT_MAP_HORIZON_DAYS of event-days, from 00:00 UTC of the oldest). */
export const deriveLoadFloorMs = (nowMs: number, horizonDays: number = EVENT_MAP_HORIZON_DAYS): number =>
  Math.floor((nowMs - horizonDays * DAY_MS) / DAY_MS) * DAY_MS;

/**
 * The `updatedafter` rows a run may apply, and those whose origin is below derive's load floor (2026-11-15 audit,
 * feed-live F1 residual). A run that loads the whole event-map horizon (a heal epoch, aggregate.ts) asks the sweeps
 * from one day below it, so a revision can move a node of the floor day across midnight onto the day before, which
 * derive never loads: derive rewrites the floor day's partition without the node and prunes the day below, so the
 * event drops out of the published feed. Such a revision is not applied (the event stays where it was) and the run
 * names it. Regular runs ask from about 11 days back, far above the floor, so nothing is dropped there.
 */
export function splitBelowDeriveFloor(rows: readonly RawObs[], floorMs: number): { kept: RawObs[]; dropped: RawObs[] } {
  const kept: RawObs[] = [];
  const dropped: RawObs[] = [];
  for (const r of rows) (r.eventTimeMs >= floorMs ? kept : dropped).push(r);
  return { kept, dropped };
}

/**
 * aggregate's preparation of the screened `updatedafter` rows for revisionSweep: the rows at or above derive's load
 * floor (splitBelowDeriveFloor), in ingest order, and the rows below it, which are not applied but still advance
 * their provider's watermark (`watermarks` is updated in place), as every report the run saw does, so the next
 * horizon-sized sweep does not fetch them again.
 */
export function sweepRowsAboveDeriveFloor(
  screened: readonly RawObs[],
  watermarks: Watermarks,
  nowMs: number,
): { updates: RawObs[]; belowFloor: RawObs[]; floorMs: number } {
  const floorMs = deriveLoadFloorMs(nowMs);
  const { kept, dropped } = splitBelowDeriveFloor(screened, floorMs);
  for (const raw of dropped) {
    if (raw.providerUpdatedMs != null) watermarks[raw.provider] = advanceWatermark(watermarks[raw.provider], raw.providerUpdatedMs, nowMs);
  }
  kept.sort(byIngestOrder);
  return { updates: kept, belowFloor: dropped, floorMs };
}

/** The `reason` on the op:tombstone line of a COMCAT_ID_PROVIDERS row withdrawn with a ComCat delete of its id
 *  (Resolver.withdrawComcatTwins, PF-5b). */
export const COMCAT_DELETE_REASON = 'withdrawn with ComCat: the event of this id was deleted upstream (the id is the ComCat id)';

/** The `reason` on a late mint's op:observe line, so the log itself tells it from a live mint. */
export const lateMintReason = (lagDays: number): string =>
  `first seen in the provider's updatedafter sweep, ${lagDays.toFixed(1)} d after origin`;

/**
 * aggregate's revision sweep (H2): the `updatedafter` rows, screened and in ingest order. Each row
 * advances its provider's watermark. A row stamped earlier than the copy of it the feed already
 * holds is skipped (`stale`): the sweeps' answer can predate this run's live one (PF-5c). A row of a
 * known event is a revision (Resolver.reviseExisting).
 * An unknown row is skipped, except for a `lateMintProviders` provider (config LATE_MINT_PROVIDERS,
 * PF-5a): there it is minted when its origin is inside the hot window
 * (Resolver.reviseOrMintInHotWindow), since that catalog publishes events days after their origin,
 * past the live query's lookback, and the sweep is the only path that ever sees them. (A row the live
 * query missed only because it was published between the two concurrent queries, or because the live
 * fetch failed, mints here too, as the live path would have.) An unknown row beside another
 * provider's live event (±60 s, ≤ 50 km, |ΔM| ≤ 1) is withheld instead: most likely the same quake,
 * which the feed already shows. A mint is a new observation of this run: one op:observe line with
 * this run's ingest time and seq, the event's own origin time, and a `reason` naming the sweep and
 * the lag. A late one never alerts: the alerts gateway reads only origins younger than 7 h.
 */
export function revisionSweep(
  resolver: Resolver,
  log: LogBuffer,
  updates: readonly RawObs[],
  watermarks: Watermarks,
  ingestTime: string,
  lateMintProviders: ReadonlySet<string> = LATE_MINT_PROVIDERS,
  /** The run clock the watermark ceiling is measured from (advanceWatermark); the ingest time by default. */
  nowMs: number = Date.parse(ingestTime),
): SweepResult {
  let revisions = 0;
  const lateMinted: LateMint[] = [];
  const lateWithheld: LateWithheld[] = [];
  let stale = 0;
  for (const raw of updates) {
    if (raw.providerUpdatedMs != null) {
      // Clamped like the live path (2026-11-15 audit): a future update stamp from a sweep row must not pin the very
      // watermark the next sweep asks `updatedafter` from.
      watermarks[raw.provider] = advanceWatermark(watermarks[raw.provider], raw.providerUpdatedMs, nowMs);
    }
    if (resolver.isOlderThanStored(raw)) {
      stale++;
      continue;
    }
    if (!lateMintProviders.has(raw.provider)) {
      const r = resolver.reviseExisting(raw, ingestTime);
      if (r && log.recordIngest(raw, r) && r.changed) revisions++;
      continue;
    }
    const out = resolver.reviseOrMintInHotWindow(raw, ingestTime);
    if (out.kind === 'skipped') continue;
    if (out.kind === 'withheld') {
      lateWithheld.push({
        provider: raw.provider,
        providerEventId: raw.providerEventId,
        mag: raw.mag,
        eventTime: new Date(raw.eventTimeMs).toISOString(),
        nearFeedId: out.near.feedId,
        nearProviders: [...new Set(out.near.provenance.map((r) => r.provider))].sort(),
        km: out.km,
        dtS: out.dtMs / 1000,
      });
      continue;
    }
    const r = out.result;
    if (out.kind === 'revised') {
      if (log.recordIngest(raw, r) && r.changed) revisions++;
      continue;
    }
    if (!r.changed) continue;
    const lagDays = lagDaysOf(raw, ingestTime);
    log.record(raw, r, 'observe', lateMintReason(lagDays));
    lateMinted.push({
      feedId: r.node.feedId,
      provider: raw.provider,
      providerEventId: raw.providerEventId,
      mag: raw.mag,
      place: raw.place,
      eventTime: new Date(raw.eventTimeMs).toISOString(),
      lagDays,
    });
  }
  return { revisions, lateMinted, lateWithheld, stale };
}
