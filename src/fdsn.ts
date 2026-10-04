import type { Extra, RawObs } from './types.js';
import { flattenScalars, knownAliasIdsOf, num, parseUtcMs } from './util.js';

/**
 * An FDSN answer that means "no events match" (FEED-3). The FDSN web-service spec answers 204 by default and 404 only
 * when the query asks for it with `nodata=404`; any other 404 means the query path itself is gone (a moved or retired
 * service) and is an error, never a quiet source. Before 2026-10-04 a 404 counted as an empty success everywhere.
 */
export function isNoData(p: { params?: Record<string, string> }, status: number): boolean {
  return status === 204 || (status === 404 && p.params?.['nodata'] === '404');
}

/** How many records a response held before the parser dropped any (a sweep pages on it). */
export interface ParseStats {
  rows: number;
}

/** Tolerant parser for USGS-GeoJSON and EMSC seismicportal `format=json` (a GeoJSON superset). */
export function parseGeoJSON(body: string, provider: string, stats?: ParseStats): RawObs[] {
  const json = JSON.parse(body) as { features?: unknown[] };
  const features = Array.isArray(json.features) ? json.features : [];
  if (stats) stats.rows = features.length;
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
    // USGS lists every contributing catalog id in `ids` — same-provider aliases (see knownAliasIdsOf).
    const knownAliasIds = knownAliasIdsOf(provider, providerEventId, p);
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
      // Capture the provider's ENTIRE property vocabulary, not a fixed allowlist.
      fields: flattenScalars(p),
    });
  }
  return out;
}

/**
 * The columns of an FDSN "text" bulletin the parser reads, found by the name the response's `#` header line gives
 * them (case and spaces ignored), with the position a standard header has them at:
 * #EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType
 * Headers differ between nodes: SCEDC names two columns ET / GT and spells Longitude "Longtitude", RéNaSS and RESIF
 * say MagnitudeType / MagnitudeAuthor, INGV says Depth/Km, IPGP and SCEDC send no EventType, and Earthquakes Canada
 * (NRCan) sends eight columns: #EventID|Time|Latitude|Longitude|Depth/km|MagType|Magnitude|EventLocationName.
 * Until 2026-10-01 the parser read every column at its standard position, so NRCan's magnitude, magnitude type and
 * place (its columns 6, 5 and 7) were read from columns 10, 9 and 12, which NRCan does not have: every NRCan row was
 * stored without them (PF-5h). Every other node's header has these columns at the standard positions, so reading them
 * by name changes nothing there.
 */
const FDSN_TEXT_COLUMNS = {
  id: { names: ['eventid'], standard: 0 },
  time: { names: ['time'], standard: 1 },
  lat: { names: ['latitude'], standard: 2 },
  lon: { names: ['longitude', 'longtitude'], standard: 3 },
  depth: { names: ['depth/km', 'depth'], standard: 4 },
  magType: { names: ['magtype', 'magnitudetype'], standard: 9 },
  mag: { names: ['magnitude'], standard: 10 },
  place: { names: ['eventlocationname'], standard: 12 },
} as const;
export type FdsnTextColumn = keyof typeof FDSN_TEXT_COLUMNS;

/** Where each column the parser reads sits in a row, from the header's column names. A header that does not name the
 *  four columns every row needs (EventID, Time, Latitude, Longitude), or no header at all (LMU writes its header
 *  line without the `#`), leaves the standard positions; otherwise a column the header does not name is absent. */
export function fdsnTextColumns(header: readonly string[]): Record<FdsnTextColumn, number | null> {
  const names = header.map((h) => h.replace(/\s+/g, '').toLowerCase());
  const keys = Object.keys(FDSN_TEXT_COLUMNS) as FdsnTextColumn[];
  const named = (k: FdsnTextColumn): number | null => {
    for (const n of FDSN_TEXT_COLUMNS[k].names) {
      const i = names.indexOf(n);
      if (i >= 0) return i;
    }
    return null;
  };
  const byName = (['id', 'time', 'lat', 'lon'] as const).every((k) => named(k) != null);
  return Object.fromEntries(keys.map((k) => [k, byName ? named(k) : FDSN_TEXT_COLUMNS[k].standard])) as Record<FdsnTextColumn, number | null>;
}

/** Sources whose place is written in English and French, "<English>/<French>" (Earthquakes Canada:
 *  "16 km SSE of Duncan, BC/16 km SSE de Duncan, BC"). The feed's `place` is the English half, as the JMA adapter
 *  takes `en_anm`; `fields.EventLocationName` keeps the original. */
const BILINGUAL_PLACE_PROVIDERS: ReadonlySet<string> = new Set(['nrcan']);

/** The English half of an "<English>/<French>" place. A place name with a slash of its own is in both halves
 *  ("19 km ESE of Harrop/Procter, BC, felt/19 km ESE de Harrop/Procter, BC, ressenti"), so the halves meet at the
 *  middle slash; a place with no slash or an even number of them is kept whole. */
export function englishHalf(place: string): string {
  const slashes: number[] = [];
  for (let i = 0; i < place.length; i++) if (place[i] === '/') slashes.push(i);
  if (slashes.length % 2 === 0) return place;
  return place.slice(0, slashes[(slashes.length - 1) / 2]).trim() || place;
}

/**
 * FDSN "text" bulletin: one `|`-separated row per event under a `#` header line that names the columns
 * (FDSN_TEXT_COLUMNS). Every column is also kept verbatim in `fields` under its header name.
 */
export function parseFdsnText(body: string, provider: string, stats?: ParseStats): RawObs[] {
  const lines = body.split('\n');
  if (stats) stats.rows = lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  // Header names the columns (they vary: SCEDC adds ET/GT + a "Longtitude" typo; RESIF
  // uses MagnitudeType/MagnitudeAuthor; NRCan sends 8) — capture every column verbatim by its real name.
  const header = lines.find((l) => l.startsWith('#'));
  const cols = header ? header.replace(/^#/, '').split('|').map((s) => s.trim()) : [];
  const at = fdsnTextColumns(cols);
  const bilingual = BILINGUAL_PLACE_PROVIDERS.has(provider);
  const out: RawObs[] = [];
  for (const line of lines) {
    const row = line.trim();
    if (!row || row.startsWith('#')) continue;
    const c = row.split('|');
    if (c.length < 5) continue;
    // The cell as sent (num / parseUtcMs read it as before; strings are trimmed).
    const cell = (k: FdsnTextColumn): string | undefined => {
      const i = at[k];
      return i == null ? undefined : c[i];
    };
    const eventTimeMs = parseUtcMs(cell('time'));
    const lat = num(cell('lat'));
    const lon = num(cell('lon'));
    const providerEventId = (cell('id') ?? '').trim();
    if (eventTimeMs == null || lat == null || lon == null || !providerEventId) continue;
    const fields: Extra = {};
    for (let i = 0; i < c.length; i++) {
      const name = cols[i] ?? `col${i}`;
      const val = (c[i] ?? '').trim();
      if (val) fields[name] = val;
    }
    const place = (cell('place') ?? '').trim() || null;
    out.push({
      provider,
      providerEventId,
      eventTimeMs,
      providerUpdatedMs: null,
      status: null,
      lat,
      lon,
      depth: num(cell('depth')),
      mag: num(cell('mag')),
      magType: (cell('magType') ?? '').trim() || null,
      place: place != null && bilingual ? englishHalf(place) : place,
      // NCEDC / SCEDC ids name ComCat's `nc…` / `ci…` event (config COMCAT_ID_PREFIX, PF-5d).
      knownAliasIds: knownAliasIdsOf(provider, providerEventId, fields),
      fields,
    });
  }
  return out;
}

/** A stored FDSN text row read again from its own `fields` (every non-empty column under its header name, in header
 *  order), as parseFdsnText reads it from a response: the one-time correction re-reads NRCan's rows this way
 *  (src/correction.ts, PF-5h). Null when the fields do not make a row. */
export function rereadFdsnTextRow(fields: Extra, provider: string): RawObs | null {
  const names = Object.keys(fields);
  if (!names.length) return null;
  const header = `#${names.join('|')}`;
  const row = names.map((n) => String(fields[n] ?? '')).join('|');
  return parseFdsnText(`${header}\n${row}`, provider)[0] ?? null;
}
