import { CATALOGUE_MIRRORS, CATALOGUE_MIRROR_ID_PREFIX, COMCAT_ID_PREFIX, COMCAT_PROVIDER } from './config.js';

export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Parse a seismic timestamp to epoch-ms, assuming UTC when no zone is present. */
export function parseUtcMs(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = v.trim();
  if (!t) return null;
  // Slash dates (SCEDC: 2026/07/04 23:14:10.1100) → ISO dashes.
  t = t.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3');
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t)) {
    t = t.replace(' ', 'T');
    t = t.replace(/(\.\d{3})\d+/, '$1'); // trim >3 fractional digits
    if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(t)) t += 'Z';
  }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

export const isoFromMs = (ms: number): string => new Date(ms).toISOString();

export function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Flatten a source record into a scalar field-map, losslessly capturing its WHOLE
 * vocabulary: nested objects become dotted keys (`nearestLocality.distance`), arrays are
 * JSON-serialized, null/empty are dropped. No allowlist — every field a provider emits is
 * kept verbatim under its original name.
 */
export function flattenScalars(
  obj: Record<string, unknown>,
  prefix = '',
  out: Record<string, number | string | boolean | null> = {},
): Record<string, number | string | boolean | null> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v == null || v === '') continue;
    if (Array.isArray(v)) out[key] = JSON.stringify(v);
    else if (typeof v === 'object') flattenScalars(v as Record<string, unknown>, key, out);
    else if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/** Deterministic stringify with recursively sorted keys (for hashing / golden output). */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) throw new Error('circular');
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export interface FetchResult {
  status: number;
  body: string;
  latencyMs: number;
}

export async function fetchText(url: string, timeoutMs: number): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent': 'earthquakes-feed/0.1 (+https://earthquakes-feed.theshelter.app)',
        accept: 'application/json, text/plain, */*',
      },
    });
    const body = await res.text();
    return { status: res.status, body, latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

/** The ComCat event id a COMCAT_ID_PROVIDERS native id names (AEC `aka2026…` → itself, NCEDC `75438707` →
 *  `nc75438707`, SCEDC `41341119` → `ci41341119`), or null for any other provider. */
export function comcatIdOf(provider: string, nativeId: string): string | null {
  const prefix = COMCAT_ID_PREFIX.get(provider);
  return prefix == null || !nativeId ? null : `${prefix}${nativeId}`;
}

/** The inverse of comcatIdOf: the native id `provider` would give the ComCat event `comcatId`, or null when the
 *  ComCat id is not of that provider's catalog (`nc75438707` → NCEDC `75438707`; any id → AEC's own). */
export function nativeIdOfComcat(provider: string, comcatId: string): string | null {
  const prefix = COMCAT_ID_PREFIX.get(provider);
  if (prefix == null || !comcatId.startsWith(prefix) || comcatId.length === prefix.length) return null;
  return comcatId.slice(prefix.length);
}

/** The catalogue a source's ids belong to (config CATALOGUE_MIRRORS): the mirrored source for a mirror (`renass` for
 *  `resif`), the source itself otherwise. */
export function catalogueOf(provider: string): string {
  return CATALOGUE_MIRRORS.get(provider) ?? provider;
}

/** The other sources serving `provider`'s catalogue (`renass` for `resif` and `resif` for `renass`, `auspass` for
 *  `ga`); empty for a source without a mirror. */
export function mirrorsOf(provider: string): string[] {
  const own = catalogueOf(provider);
  const out = own === provider ? [] : [own];
  for (const [mirror, of] of CATALOGUE_MIRRORS) if (of === own && mirror !== provider) out.push(mirror);
  return out;
}

/** A source's event id in its catalogue's own form (config CATALOGUE_MIRROR_ID_PREFIX): GA's `ga2026tgusvy` for AusPass's
 *  `smi:local/ga2026tgusvy`; the id itself for every other source, and for a mirror's id without the prefix. */
export function catalogueIdOf(provider: string, nativeId: string): string {
  const prefix = CATALOGUE_MIRROR_ID_PREFIX.get(provider);
  return prefix && nativeId.length > prefix.length && nativeId.startsWith(prefix) ? nativeId.slice(prefix.length) : nativeId;
}

/** The alias keys of the same report at the other sources of its catalogue (`renass:<id>` for `resif` and `<id>`;
 *  `ga:<id>` for `auspass` and `smi:local/<id>`, `auspass:smi:local/<id>` for `ga` and `<id>`). */
export function mirrorKeys(provider: string, nativeId: string): string[] {
  if (!nativeId) return [];
  const id = catalogueIdOf(provider, nativeId);
  return mirrorsOf(provider).map((p) => `${p}:${CATALOGUE_MIRROR_ID_PREFIX.get(p) ?? ''}${id}`);
}

/** Whether two rows are one event of one catalogue: the same catalogue (catalogueOf) and the same id in the catalogue's
 *  own form (catalogueIdOf), so AusPass's `smi:local/<id>` and GA's `<id>` are one event, and RESIF's and RéNaSS's
 *  `<id>`. */
export function sameCatalogueEvent(providerA: string, idA: string, providerB: string, idB: string): boolean {
  return catalogueOf(providerA) === catalogueOf(providerB) && catalogueIdOf(providerA, idA) === catalogueIdOf(providerB, idB);
}

/** Same-provider alias ids carried in a report's own vocabulary: USGS lists every contributing
 *  catalog id in `ids` (",us7000abc,ci12345,"). Registering them as `provider:id` aliases
 *  survives USGS preferred-id churn and gives the dense-cell guard real id-level linkage
 *  (design §8.3/§8.4). The same parse serves the adapters and the node-to-node merge pass.
 *  A COMCAT_ID_PROVIDERS report also names the ComCat row of its own id (comcatIdOf: `usgs:aka2026…` for AEC,
 *  PF-5b; `usgs:nc75438707` for NCEDC 75438707 and `usgs:ci41341119` for SCEDC 41341119, PF-5d). A catalogue mirror's
 *  twin (config CATALOGUE_MIRRORS) is not named here: these ids are stored with every raw row (deep-history raw assets),
 *  so the Resolver derives the twin from the provider and the id instead (mirrorKeys). */
export function knownAliasIdsOf(provider: string, providerEventId: string, fields: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  const comcatId = comcatIdOf(provider, providerEventId);
  if (comcatId) out.push(`${COMCAT_PROVIDER}:${comcatId}`);
  const ids = fields?.['ids'];
  if (typeof ids !== 'string') return out;
  for (const t of ids.split(',')) {
    const id = t.trim();
    if (id && id !== providerEventId) out.push(`${provider}:${id}`);
  }
  return out;
}

/** reviewed > provisional > automatic > unknown. */
export function statusRank(status: string | null): number {
  if (!status) return 0;
  const s = status.toLowerCase();
  if (s.includes('review')) return 3;
  if (s.includes('provisional') || s.includes('preliminary')) return 2;
  if (s.includes('automatic') || s.includes('auto')) return 1;
  return 0;
}
