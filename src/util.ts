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

/** reviewed > provisional > automatic > unknown. */
export function statusRank(status: string | null): number {
  if (!status) return 0;
  const s = status.toLowerCase();
  if (s.includes('review')) return 3;
  if (s.includes('provisional') || s.includes('preliminary')) return 2;
  if (s.includes('automatic') || s.includes('auto')) return 1;
  return 0;
}
