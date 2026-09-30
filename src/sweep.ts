import { LATE_MINT_PROVIDERS } from './config.js';
import type { Resolver } from './dedup.js';
import type { LogBuffer } from './oplog.js';
import type { RawObs, Watermarks } from './types.js';

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
  /** Known events the sweep changed (one op:observe line each). */
  revisions: number;
  /** Events the sweep minted (status `late_minted`), in ingest order. */
  lateMinted: LateMint[];
  /** Unknown rows inside the hot window not minted beside another provider's event (status `late_withheld`). */
  lateWithheld: LateWithheld[];
  /** Rows older than the copy the feed already holds (Resolver.isOlderThanStored), skipped. */
  stale: number;
}

const lagDaysOf = (raw: RawObs, ingestTime: string): number => (Date.parse(ingestTime) - raw.eventTimeMs) / 86_400_000;

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
): SweepResult {
  let revisions = 0;
  const lateMinted: LateMint[] = [];
  const lateWithheld: LateWithheld[] = [];
  let stale = 0;
  for (const raw of updates) {
    if (raw.providerUpdatedMs != null) {
      watermarks[raw.provider] = Math.max(watermarks[raw.provider] ?? 0, raw.providerUpdatedMs);
    }
    if (resolver.isOlderThanStored(raw)) {
      stale++;
      continue;
    }
    if (!lateMintProviders.has(raw.provider)) {
      const r = resolver.reviseExisting(raw, ingestTime);
      if (r?.changed) {
        log.record(raw, r);
        revisions++;
      }
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
    if (!r.changed) continue;
    if (out.kind === 'revised') {
      log.record(raw, r);
      revisions++;
      continue;
    }
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
