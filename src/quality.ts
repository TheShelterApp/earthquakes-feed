import type { RawObs } from './types.js';

/** What the ingest screens read: a fresh report, or a stored provenance row. */
interface Located {
  lat: number;
  lon: number;
  mag: number | null;
}

/** A lat/lon that physics and the schema (±90 / ±180) forbid. A single provider emitting
 *  such coordinates would otherwise red-line derive's validate gate for the entire feed
 *  (JMA's DDMM.m `cod`, 2026-08-22), so every ingest path drops them at the door. */
export const hasBadCoords = (r: Located): boolean =>
  !Number.isFinite(r.lat) || !Number.isFinite(r.lon) || Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180;

/** A report that has no location at all: exactly lat 0 AND lon 0 with magnitude 0 or none.
 *  NCEDC publishes such placeholders (`0.00000, 0.00000`, depth 0, `MU 0.0`, ~40 a day,
 *  386 of the 8,292 features in all_week on 2026-09-28) and they were served as live events
 *  in the Gulf of Guinea. The rule is exact on purpose: a real event near 0°N 0°E keeps a
 *  non-zero magnitude and a non-zero coordinate, so it is never caught. -0 counts as 0. */
export const isCoordinateless = (r: Located): boolean => r.lat === 0 && r.lon === 0 && (r.mag == null || r.mag === 0);

export type ScreenReason = 'bad_coords' | 'coordinateless';

/** Why a report never enters the Resolver, or null when it may. */
export function screenReason(r: Located): ScreenReason | null {
  if (hasBadCoords(r)) return 'bad_coords';
  if (isCoordinateless(r)) return 'coordinateless';
  return null;
}

export interface ScreenTally {
  bad_coords: number;
  coordinateless: number;
  /** Per reason, per provider — the scale a provider regression shows up at. */
  byProvider: Record<ScreenReason, Record<string, number>>;
}

export const emptyTally = (): ScreenTally => ({ bad_coords: 0, coordinateless: 0, byProvider: { bad_coords: {}, coordinateless: {} } });

/** Drop the reports `screenReason` rejects, counting them into `tally`. `allow` lists the
 *  reasons a path lets through: the delete sweep keeps coordinate-less rows (withdrawing a
 *  placeholder is correct, and there is nothing to place on a map). `zeroed`, when given,
 *  collects the coordinate-less reports dropped here: one whose id the feed already holds is
 *  its provider's withdrawal (Resolver.withdrawZeroed), not a report to throw away. */
export function screen<T extends RawObs>(arr: T[], tally: ScreenTally, allow: ReadonlySet<ScreenReason> = new Set(), zeroed?: T[]): T[] {
  return arr.filter((r) => {
    const why = screenReason(r);
    if (!why || allow.has(why)) return true;
    tally[why]++;
    tally.byProvider[why][r.provider] = (tally.byProvider[why][r.provider] ?? 0) + 1;
    if (why === 'coordinateless') zeroed?.push(r);
    return false;
  });
}

/** Deterministic ingest order (idempotency, design §8.10): event time, provider, provider id. */
export const byIngestOrder = (a: RawObs, b: RawObs): number =>
  a.eventTimeMs - b.eventTimeMs ||
  (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
  (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0);
