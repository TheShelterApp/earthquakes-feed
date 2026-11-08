import type { ProviderConfig, RawObs } from './types.js';

/** A provenance row's licence, attribution and DOI. */
export interface RowLicense {
  license: string;
  attribution: string;
  doi: string | null;
}

/**
 * The licence a provenance row carries: normally its provider's (providers/registry.json). A provider that distributes
 * other catalogues' solutions lists them under `catalogues`, keyed by the row's `fields.net` (lower case), and such a
 * row carries that catalogue's licence, attribution and DOI instead ("Individual observations remain under each
 * source's own license", NOTICE). ComCat is the case today: its preferred origin can be ISC-GEM's (net `iscgem` or
 * `iscgemsup`, CC BY-SA 3.0); its ANSS regional networks (nc, ak, ci, ...) stay US-PD as ComCat distributes them.
 * The only place a row's licence is minted is Resolver.makeRow (src/dedup.ts); stored rows round-trip theirs.
 */
export function rowLicense(raw: Pick<RawObs, 'provider' | 'fields'>, cfg: ProviderConfig | undefined): RowLicense {
  const net = raw.fields?.['net'];
  const over = typeof net === 'string' ? cfg?.catalogues?.[net.toLowerCase()] : undefined;
  if (over) return { license: over.license, attribution: over.attribution, doi: over.doi ?? null };
  return { license: cfg?.license ?? 'unknown', attribution: cfg?.attribution ?? raw.provider, doi: cfg?.doi ?? null };
}
