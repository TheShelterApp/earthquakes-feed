import { AUTHORITY_REGIONS, type AuthorityBox, STATS_GLOBAL_PROVIDERS, STATS_REGION_CATALOGUE, STATS_REGION_MARGIN_DEG } from './config.js';
import { catalogueOf } from './util.js';

/**
 * The authoritative-region test (APIs.md, Statistics, Reconciliation; *Regional agencies outside their own region*):
 * ComCat's own practice, a regional network is authoritative for its own region and a global network everywhere. One
 * function for the statistics' reconciliation rule v3 (stats-table.ts isOutOfRegion leaves such rows out of the counts)
 * and the Resolver's authoritative-region window (dedup.ts authorityJoin, epoch 2: such an event joins the global
 * agencies' event of the quake), so the two agree on which events are a regional agency's solution of a distant quake.
 */

/** Whether a place lies in an authority box widened by `marginDeg` on every side (longitudes compared modulo 360). */
export const inAuthorityBox = (lat: number, lon: number, [latMin, latMax, lonMin, lonMax]: AuthorityBox, marginDeg: number): boolean =>
  lat >= latMin - marginDeg && lat <= latMax + marginDeg && [lon, lon - 360, lon + 360].some((x) => x >= lonMin - marginDeg && x <= lonMax + marginDeg);

/** The catalogue whose authoritative region judges a provider's solutions (IPGP's are judged by RéNaSS's region). */
export const authorityCatalogue = (provider: string): string => STATS_REGION_CATALOGUE.get(provider) ?? catalogueOf(provider);

/** Whether a provider has an authoritative region (AUTHORITY_REGIONS) and is not a global network. */
export const regionalProvider = (provider: string): boolean => !STATS_GLOBAL_PROVIDERS.has(provider) && AUTHORITY_REGIONS[authorityCatalogue(provider)] != null;

/**
 * True when none of `providers` is a global network (STATS_GLOBAL_PROVIDERS) and the place lies outside the
 * authoritative region (AUTHORITY_REGIONS plus STATS_REGION_MARGIN_DEG) of every one of them. A provider with no region
 * counts as global (never outside). False for no providers. The magnitude floor is the caller's.
 */
export function outsideAuthority(providers: Iterable<string>, lat: number, lon: number): boolean {
  let any = false;
  for (const p of providers) {
    any = true;
    if (STATS_GLOBAL_PROVIDERS.has(p)) return false;
    const boxes = AUTHORITY_REGIONS[authorityCatalogue(p)];
    if (!boxes) return false;
    if (boxes.some((b) => inAuthorityBox(lat, lon, b, STATS_REGION_MARGIN_DEG))) return false;
  }
  return any;
}
