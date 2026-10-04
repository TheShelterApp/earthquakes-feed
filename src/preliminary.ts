import type { Extra } from './types.js';
import { haversineKm } from './geo.js';

/**
 * Preliminary solutions that a provider replaces with a reviewed one under a new id (FEED-5).
 *
 * Mexico's SSN puts a quick solution in its RSS as "Preliminar: M 4.4, 85 km al SUROESTE de MAPASTEPEC, CHIS" and
 * replaces it 5 to 25 minutes later with the reviewed item ("4.4, 188 km al SUROESTE de MAPASTEPEC, CHIS"). The
 * adapter's id is built from origin time and position, so the two never share an id, and the preliminary row stayed
 * in the feed as its own event, without a magnitude (the title parse wanted a leading number). In the observation log
 * 2026-07-05 → 2026-10-03: 29 preliminary items, 25 with a reviewed SSN item 0 to 18 s EARLIER in origin time and
 * 3 to 111 km away (preliminary positions are rough, two decimals), none in the same feed event; 4 with no reviewed
 * item within 3 minutes.
 *
 * A preliminary row is superseded by a reviewed row of the same provider whose origin is within 60 s and position
 * within 150 km: it is withdrawn from its event (op:tombstone with PRELIMINARY_SUPERSEDED_REASON; the event is
 * tombstoned when no row is left), and a preliminary report that arrives when its reviewed one is known is not
 * ingested at all, so the pair cannot flip back and forth.
 */
export const PRELIMINARY_PROVIDERS: ReadonlySet<string> = new Set(['mexico']);
export const PRELIMINARY_SUPERSEDE_MS = 60_000;
export const PRELIMINARY_SUPERSEDE_KM = 150;
export const PRELIMINARY_SUPERSEDED_REASON =
  'superseded by the provider: its reviewed solution (another id) has an origin within 60 s and 150 km of this preliminary one';

const PRELIMINARY_TITLE = /^\s*Preliminar\b/i;

/** A row or report of a PRELIMINARY_PROVIDERS source whose original title says it is preliminary. */
export function isPreliminary(r: { provider: string; fields: Extra }): boolean {
  return PRELIMINARY_PROVIDERS.has(r.provider) && PRELIMINARY_TITLE.test(String(r.fields['title'] ?? ''));
}

export interface Located {
  provider: string;
  eventTimeMs: number;
  lat: number;
  lon: number;
}

/** The reviewed solutions to compare preliminary ones against, sorted by origin time. */
export function finalsIndex<T extends Located & { fields: Extra }>(rows: Iterable<T>): T[] {
  const out: T[] = [];
  for (const r of rows) if (PRELIMINARY_PROVIDERS.has(r.provider) && !isPreliminary(r)) out.push(r);
  return out.sort((a, b) => a.eventTimeMs - b.eventTimeMs);
}

/** The reviewed solution (same provider, within 60 s and 150 km) that supersedes `p`, the closest in time; else null. */
export function supersedingFinal<T extends Located>(p: Located, finals: readonly T[]): T | null {
  let lo = 0;
  let hi = finals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (finals[mid]!.eventTimeMs < p.eventTimeMs - PRELIMINARY_SUPERSEDE_MS) lo = mid + 1;
    else hi = mid;
  }
  let best: T | null = null;
  for (let i = lo; i < finals.length && finals[i]!.eventTimeMs <= p.eventTimeMs + PRELIMINARY_SUPERSEDE_MS; i++) {
    const f = finals[i]!;
    if (f.provider !== p.provider) continue;
    if (haversineKm(p.lat, p.lon, f.lat, f.lon) > PRELIMINARY_SUPERSEDE_KM) continue;
    if (!best || Math.abs(f.eventTimeMs - p.eventTimeMs) < Math.abs(best.eventTimeMs - p.eventTimeMs)) best = f;
  }
  return best;
}
