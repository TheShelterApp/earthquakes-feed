import type { Extra, RawObs } from './types.js';
import { num, parseUtcMs } from './util.js';

const EXTRA_KEYS = ['nst', 'gap', 'dmin', 'rms', 'sig', 'tsunami', 'mmi', 'cdi', 'felt', 'alert', 'type', 'auth'];

function collectExtra(p: Record<string, unknown>): Extra {
  const e: Extra = {};
  for (const k of EXTRA_KEYS) {
    const v = p[k];
    if (v == null) continue;
    if (typeof v === 'number' || typeof v === 'string') e[k] = v;
  }
  return e;
}

/** Tolerant parser for USGS-GeoJSON and EMSC seismicportal `format=json` (a GeoJSON superset). */
export function parseGeoJSON(body: string, provider: string): RawObs[] {
  const json = JSON.parse(body) as { features?: unknown[] };
  const features = Array.isArray(json.features) ? json.features : [];
  const out: RawObs[] = [];
  for (const f of features) {
    const feat = f as { id?: unknown; properties?: Record<string, unknown>; geometry?: { coordinates?: unknown[] } };
    const p = feat.properties ?? {};
    const coords = Array.isArray(feat.geometry?.coordinates) ? feat.geometry!.coordinates! : [];
    const lon = num(coords[0]) ?? num(p['lon']) ?? num(p['longitude']);
    const lat = num(coords[1]) ?? num(p['lat']) ?? num(p['latitude']);
    if (lat == null || lon == null) continue;
    const eventTimeMs = parseUtcMs((p['time'] ?? p['origintime']) as string | number | null);
    if (eventTimeMs == null) continue;
    const providerEventId = String(feat.id ?? p['unid'] ?? p['source_id'] ?? p['eventid'] ?? '').trim();
    if (!providerEventId) continue;
    // USGS lists every contributing catalog id in `ids` (",us7000abc,ci12345,").
    // Registering them as same-provider aliases survives USGS preferred-id churn
    // and gives the dense-cell guard real id-level linkage (design §8.3/§8.4).
    const knownAliasIds: string[] = [];
    if (typeof p['ids'] === 'string') {
      for (const t of (p['ids'] as string).split(',')) {
        const id = t.trim();
        if (id && id !== providerEventId) knownAliasIds.push(`${provider}:${id}`);
      }
    }
    out.push({
      provider,
      providerEventId,
      eventTimeMs,
      providerUpdatedMs: parseUtcMs((p['updated'] ?? p['lastupdate']) as string | number | null),
      status: (p['status'] as string) ?? null,
      lat,
      lon,
      depth: num(p['depth']) ?? num(coords[2]),
      mag: num(p['mag']) ?? num(p['magnitude']),
      magType: (p['magType'] as string) ?? (p['magtype'] as string) ?? null,
      place: (p['place'] as string) ?? (p['flynn_region'] as string) ?? (p['region'] as string) ?? null,
      knownAliasIds,
      extra: collectExtra(p),
    });
  }
  return out;
}

/**
 * FDSN "text" bulletin:
 * #EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType
 */
export function parseFdsnText(body: string, provider: string): RawObs[] {
  const out: RawObs[] = [];
  for (const line of body.split('\n')) {
    const row = line.trim();
    if (!row || row.startsWith('#')) continue;
    const c = row.split('|');
    if (c.length < 5) continue;
    const eventTimeMs = parseUtcMs(c[1]);
    const lat = num(c[2]);
    const lon = num(c[3]);
    const providerEventId = (c[0] ?? '').trim();
    if (eventTimeMs == null || lat == null || lon == null || !providerEventId) continue;
    const extra: Extra = {};
    if (c[5]) extra['auth'] = c[5].trim();
    if (c[13]) extra['type'] = c[13].trim();
    out.push({
      provider,
      providerEventId,
      eventTimeMs,
      providerUpdatedMs: null,
      status: null,
      lat,
      lon,
      depth: num(c[4]),
      mag: num(c[10]),
      magType: (c[9] ?? '').trim() || null,
      place: (c[12] ?? '').trim() || null,
      knownAliasIds: [],
      extra,
    });
  }
  return out;
}
