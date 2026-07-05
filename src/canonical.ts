import type { Extra } from './types.js';
import { num } from './util.js';

/**
 * Canonical auxiliary field vocabulary: one normalized key <- many source spellings,
 * grounded in the live field audit of every provider. The CORE solution fields
 * (lat/lon/depth/mag/magType/time/status) are deliberately NOT here — they stay coherent
 * from the single chosen provider and are never cross-filled, because mixing one solution's
 * depth with another's magnitude is unphysical. Everything else is fill-only merged.
 */
interface Spec {
  key: string;
  aliases: string[];
  num?: boolean;
}

const CANON: Spec[] = [
  // USGS-standard superset (kept USGS-compatible; always surfaced at top level).
  { key: 'tz', aliases: ['tz'], num: true },
  { key: 'url', aliases: ['url'] },
  { key: 'detail', aliases: ['detail'] },
  { key: 'felt', aliases: ['felt'], num: true },
  { key: 'cdi', aliases: ['cdi'], num: true },
  { key: 'mmi', aliases: ['mmi'], num: true },
  { key: 'alert', aliases: ['alert'] },
  { key: 'tsunami', aliases: ['tsunami'], num: true },
  { key: 'sig', aliases: ['sig'], num: true },
  { key: 'nst', aliases: ['nst'], num: true },
  { key: 'dmin', aliases: ['dmin'], num: true },
  { key: 'rms', aliases: ['rms'], num: true },
  { key: 'gap', aliases: ['gap'], num: true },
  { key: 'type', aliases: ['type', 'EventType', 'event_type', 'evtype'] },
  { key: 'title', aliases: ['title'] },
  { key: 'code', aliases: ['code'] },
  { key: 'ids', aliases: ['ids'] },
  { key: 'sources', aliases: ['sources'] },
  { key: 'types', aliases: ['types'] },
  // Cross-source attribution + geo-admin (surfaced only when a source actually provides it).
  { key: 'author', aliases: ['Author', 'auth', 'agency'] },
  { key: 'magAuthor', aliases: ['MagAuthor', 'MagnitudeAuthor'] },
  { key: 'catalog', aliases: ['Catalog', 'source_catalog'] },
  { key: 'contributor', aliases: ['Contributor'] },
  { key: 'contributorId', aliases: ['ContributorID'] },
  { key: 'country', aliases: ['country'] },
  { key: 'province', aliases: ['province'] },
  { key: 'district', aliases: ['district'] },
  { key: 'neighborhood', aliases: ['neighborhood'] },
  { key: 'region', aliases: ['region'] },
];

/** USGS-standard nullable keys always emitted at top level (null when absent) for parser parity. */
export const NULLABLE_STD_KEYS = ['tz', 'url', 'detail', 'felt', 'cdi', 'mmi', 'alert', 'sig', 'nst', 'dmin', 'rms', 'gap', 'title', 'code', 'ids', 'sources', 'types'] as const;
/** Extra canonical keys surfaced at top level only when a source provides them. */
export const EXTRA_CANON_KEYS = ['author', 'magAuthor', 'catalog', 'contributor', 'contributorId', 'country', 'province', 'district', 'neighborhood', 'region'] as const;
const QUALITY_KEYS = ['nst', 'gap', 'dmin', 'rms'] as const;

function pick(fields: Extra, spec: Spec): number | string | boolean | null {
  for (const a of spec.aliases) {
    const v = fields[a];
    if (v != null && v !== '') return spec.num ? num(v) : v;
  }
  return null;
}

/**
 * Fill-only merge across provider records in preference order (chosen first): the first
 * non-null value per canonical key wins; a present value is never overwritten by a later
 * record. Guarantees no field is empty if ANY contributing provider reported it, while the
 * chosen provider's own values take precedence.
 */
export function mergeCanonical(orderedFields: Extra[]): Extra {
  const out: Extra = {};
  for (const s of CANON) {
    for (const f of orderedFields) {
      const v = pick(f, s);
      if (v != null) {
        out[s.key] = v;
        break;
      }
    }
  }
  return out;
}

/** How many quality metrics (nst/gap/dmin/rms) a record carries — a richness signal. */
export function qualityCount(fields: Extra): number {
  let n = 0;
  for (const k of QUALITY_KEYS) if (fields[k] != null) n++;
  return n;
}
