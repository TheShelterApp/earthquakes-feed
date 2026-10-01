import { isoFromMs, parseUtcMs } from './util.js';
import { child, childrenNamed, descendants, parseXml, textAt, type XmlNode } from './xml.js';

/**
 * The earliest-solutions side index (PF-5i P-3): for each provider report, every solution the provider still keeps in
 * its own version history, with the time it published each one. Backfilled history (2023-07-06 .. 2026-07-04) holds
 * each source's solution as of the backfill run only, and the observation log holds what the feed first saw since
 * 2026-07-05; neither tells what a source published first. Sources that keep versions:
 *
 * - ComCat (`usgs`): `eventid=…&includesuperseded=true` returns every product of an event, superseded and deleted ones
 *   included, each with its `updateTime` (https://earthquake.usgs.gov/fdsnws/event/1/, read 2026-10-01). The `origin`
 *   products are the solutions: those of the tsunami centres (`pt`, `at`) are often minutes earlier than NEIC's (`us`)
 *   (us7000keq3, 2023-07-10: pt 6 min, at 8 min, us 18 min after origin). ComCat keeps no `usauto` origin (the event's
 *   `ids` name `usauto7000tgl2`, its products do not), so its first retained solution can be later than what the feed
 *   saw live. A network's own events (`nc`, `ci`, `ak`) carry that network's origins, which is how NCEDC's, SCEDC's and
 *   AEC's histories are read (`networkOf`). `internal-origin` products are left out (not public solutions).
 * - GeoNet (`geonet`): `api.geonet.org.nz/quake/history/{publicID}`, every location version with its
 *   `modificationTime` and `quality` (https://api.geonet.org.nz/, read 2026-10-01: "Not all quakes have a location
 *   history."). Measured 2026-10-01 15:40 UTC: GeoNet keeps a history for 365 days after origin only (events of
 *   2025-10-01 before about 15:40 had none, every later one had 7–67 versions), so its walk goes oldest first.
 *   GeoNet's first automatic versions can be another quake altogether (2026p685142, the M5.9 Banda Sea quake of
 *   2026-09-11: M3.5 at 624 km near Collingwood for its first 26 versions).
 * - SeisComP and INGV FDSN nodes: QuakeML with `includeallorigins=true&includeallmagnitudes=true` lists the origins
 *   the node still associates with the event, each with `creationInfo/creationTime`, and the event's own creation
 *   time. INGV allows it only with `eventid` (one request per event); ETHZ, USP, GEOFON, KNMI, IPGP and LMU answer it
 *   for a time window (one request per day). ETHZ and USP keep every origin (2023 events included, the first one
 *   seconds after origin at ETHZ); GEOFON, KNMI, IPGP and LMU keep only later ones (GEOFON 1–3, the others the final
 *   manual origin), so for them the event's creation time is the first publication time and the first values are
 *   unknown.
 *
 * Checked and left out (2026-10-01): EMSC (its QuakeML origins carry no creation time and the event's `creationTime`
 * is its last update), RESIF and RéNaSS (all origins, but without creation times), NRCan (creation time is the date
 * only), AusPass (creation time is the day the event was imported), NCEDC and SCEDC (no `includeallorigins`; read
 * through ComCat instead), IMO (`/events/{id}` gives the current solution only), KAGSR (no QuakeML), NOA (no content
 * to any query that day), ISC (its origins are the contributing agencies', not ISC's versions; walk paused), AFAD (an
 * update time only, already in the feed's rows) and the forward-only custom sources (no history at all).
 */

export const FIRST_SOLUTIONS_SCHEMA = 1;

export type HistoryMethod = 'comcat-superseded' | 'geonet-history' | 'quakeml-all-origins';

/** One solution as the provider's version history keeps it. */
export interface ProviderVersion {
  /** When the provider published this version: ComCat's product `updateTime`, GeoNet's `modificationTime`, the
   *  QuakeML origin's `creationInfo/creationTime`. */
  published: string;
  /** Origin time of this solution. */
  time: string;
  lat: number;
  lon: number;
  /** km */
  depth: number | null;
  mag: number | null;
  magType: string | null;
  /** The provider's own word for this version: ComCat `review-status`, GeoNet `quality`, QuakeML `evaluationMode`
   *  (lower case). */
  status: string | null;
  /** ComCat `evaluation-status` or QuakeML `evaluationStatus`, where given. */
  evaluation?: string;
  /** Who published it inside the provider: ComCat's product source (`us`, `pt`, `at`, `nc`, …) or the QuakeML
   *  `agencyID` / `author`. */
  source: string | null;
  /** The origin's own version number, where the node gives one (INGV). */
  version?: string;
}

/** One line of a side-index chunk: one provider report and its retained versions. */
export interface FirstSolutionRecord {
  schema: 1;
  provider: string;
  /** The native id the feed holds for this report (the one the request named, for one-event requests). */
  provider_event_id: string;
  /** The event day of the feed partition this report was collected from (one-event requests), or the UTC day the
   *  window covered (one-day requests). */
  day: string;
  method: HistoryMethod;
  /** Every id the provider gives the event, when it names more than one (ComCat `ids`). */
  ids?: string[];
  /** The provider's creation time of the event (QuakeML `event/creationInfo/creationTime`), where given. */
  created: string | null;
  /** Every version the provider still keeps, oldest publication first. */
  versions: ProviderVersion[];
  /** Origins the provider lists without a creation time (left out of `versions`: their order is unknown). */
  undated?: number;
  /** When the provider deleted the event (ComCat: the latest `DELETE` origin product), if it did. */
  deleted?: string;
  /** Why there are no versions: the provider has no such event (`http 404`, `http 204`, `http 409`), keeps no history
   *  for it (`no history`), or the day's answer did not list it (`not in the day answer`). */
  missing?: string;
  /** When the request was answered; a version published later is not in `versions`. */
  collected: string;
}

/** A provider whose version history the collector reads. */
export interface HistorySource {
  provider: string;
  method: HistoryMethod;
  /** `event`: one request per feed report (the native id); `day`: one request per UTC day the feed holds rows of the
   *  provider on, listing every event of that day. */
  unit: 'event' | 'day';
  /** The request for one native id (`event`) or one UTC day `YYYY-MM-DD` (`day`). */
  url: (arg: string) => string;
  accept: string;
  timeoutMs: number;
  /** The provider keeps a history only for events younger than this many days (GeoNet, measured 2026-10-01). */
  retentionDays?: number;
  /** `day` sources: the feed's native id of a QuakeML event `publicID` (the id the node's FDSN text answer gives). */
  idOf?: (publicID: string) => string;
}

const QUAKEML_ACCEPT = 'application/xml, text/xml, */*';
const dayWindow = (day: string): string => {
  const next = isoFromMs(Date.parse(`${day}T00:00:00Z`) + 86_400_000).slice(0, 10);
  return `starttime=${day}T00:00:00&endtime=${next}T00:00:00`;
};
const allOriginsDay = (base: string) => (day: string): string =>
  `${base}?${dayWindow(day)}&format=xml&includeallorigins=true&includeallmagnitudes=true`;
/** The text after the last `/` of a QuakeML publicID: GEOFON's `smi:org.gfz-potsdam.de/geofon/gfz2026rvdx` is the
 *  feed's `gfz2026rvdx`. */
export const lastSegment = (publicID: string): string => publicID.slice(publicID.lastIndexOf('/') + 1);
const wholePublicId = (publicID: string): string => publicID;

/** The sources, in the order the collector starts their lanes. URLs are the registry's `base` (tests check). */
export const HISTORY_SOURCES: readonly HistorySource[] = [
  {
    provider: 'geonet',
    method: 'geonet-history',
    unit: 'event',
    url: (id) => `https://api.geonet.org.nz/quake/history/${encodeURIComponent(id)}`,
    accept: 'application/vnd.geo+json;version=2',
    timeoutMs: 30_000,
    retentionDays: 365,
  },
  {
    provider: 'usgs',
    method: 'comcat-superseded',
    unit: 'event',
    url: (id) => `https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=${encodeURIComponent(id)}&includesuperseded=true&format=geojson`,
    accept: 'application/json',
    timeoutMs: 30_000,
  },
  {
    provider: 'ingv',
    method: 'quakeml-all-origins',
    unit: 'event',
    url: (id) => `https://webservices.ingv.it/fdsnws/event/1/query?eventid=${encodeURIComponent(id)}&format=xml&includeallorigins=true&includeallmagnitudes=true`,
    accept: QUAKEML_ACCEPT,
    timeoutMs: 30_000,
  },
  // ETHZ and LMU give the whole publicID as their FDSN text EventID; the others the last segment.
  { provider: 'ethz', method: 'quakeml-all-origins', unit: 'day', url: allOriginsDay('https://eida.ethz.ch/fdsnws/event/1/query'), accept: QUAKEML_ACCEPT, timeoutMs: 60_000, idOf: wholePublicId },
  { provider: 'usp', method: 'quakeml-all-origins', unit: 'day', url: allOriginsDay('http://www.moho.iag.usp.br/fdsnws/event/1/query'), accept: QUAKEML_ACCEPT, timeoutMs: 60_000, idOf: lastSegment },
  { provider: 'geofon', method: 'quakeml-all-origins', unit: 'day', url: allOriginsDay('https://geofon.gfz.de/fdsnws/event/1/query'), accept: QUAKEML_ACCEPT, timeoutMs: 60_000, idOf: lastSegment },
  { provider: 'knmi', method: 'quakeml-all-origins', unit: 'day', url: allOriginsDay('https://rdsa.knmi.nl/fdsnws/event/1/query'), accept: QUAKEML_ACCEPT, timeoutMs: 60_000, idOf: lastSegment },
  { provider: 'ipgp', method: 'quakeml-all-origins', unit: 'day', url: allOriginsDay('http://ws.ipgp.fr/fdsnws/event/1/query'), accept: QUAKEML_ACCEPT, timeoutMs: 60_000, idOf: lastSegment },
  { provider: 'lmu', method: 'quakeml-all-origins', unit: 'day', url: allOriginsDay('https://erde.geophysik.uni-muenchen.de/fdsnws/event/1/query'), accept: QUAKEML_ACCEPT, timeoutMs: 60_000, idOf: wholePublicId },
];

/** Providers whose history is the ComCat event of the same id, read through the network's own origin products (the
 *  ComCat product `source`): NCEDC 75438707 is ComCat `nc75438707` (util.ts comcatIdOf), SCEDC 41341119 is
 *  `ci41341119`, AEC `aka2026…` is the same id with `ak` origins. */
export const COMCAT_NETWORK_OF: ReadonlyMap<string, string> = new Map([
  ['ncedc', 'nc'],
  ['scedc', 'ci'],
  ['aec', 'ak'],
]);

// --- parsing ---------------------------------------------------------------------------------------------------------

const round = (x: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};
const finite = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const isoOf = (v: string | number | null | undefined): string | null => {
  const ms = parseUtcMs(v ?? null);
  return ms == null ? null : isoFromMs(ms);
};
const lower = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);

/** Oldest publication first; ties by origin time, then source, so a chunk is byte-identical for the same answer. */
export function sortVersions(vs: ProviderVersion[]): ProviderVersion[] {
  const key = (v: ProviderVersion): string => `${v.published}|${v.time}|${v.source ?? ''}|${v.mag ?? ''}`;
  return vs.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function version(fields: {
  published: string | null;
  time: string | null;
  lat: number | null;
  lon: number | null;
  depthKm: number | null;
  mag: number | null;
  magType: string | null;
  status: string | null;
  evaluation?: string | null;
  source: string | null;
  version?: string | null;
}): ProviderVersion | null {
  if (!fields.published || !fields.time || fields.lat == null || fields.lon == null) return null;
  const v: ProviderVersion = {
    published: fields.published,
    time: fields.time,
    lat: round(fields.lat, 5),
    lon: round(fields.lon, 5),
    depth: fields.depthKm == null ? null : round(fields.depthKm, 3),
    mag: fields.mag == null ? null : round(fields.mag, 3),
    magType: fields.magType || null,
    status: fields.status,
    source: fields.source,
  };
  if (fields.evaluation) v.evaluation = fields.evaluation;
  if (fields.version) v.version = fields.version;
  return v;
}

interface RecordBase {
  provider: string;
  providerEventId: string;
  day: string;
  collected: string;
}

const emptyRecord = (b: RecordBase, method: HistoryMethod, missing: string): FirstSolutionRecord => ({
  schema: 1,
  provider: b.provider,
  provider_event_id: b.providerEventId,
  day: b.day,
  method,
  created: null,
  versions: [],
  missing,
  collected: b.collected,
});

/** A record for a report whose request answered with no event (404, 204, 409 …). */
export function missingRecord(src: HistorySource, b: RecordBase, missing: string): FirstSolutionRecord {
  return emptyRecord(b, src.method, missing);
}

/** ComCat's `eventid=…&includesuperseded=true&format=geojson` answer: one Feature whose `properties.products.origin`
 *  holds every origin version (`status` UPDATE with properties, or DELETE without). */
export function parseComcatSuperseded(body: string, b: RecordBase): FirstSolutionRecord {
  const feature = JSON.parse(body) as {
    id?: string;
    properties?: { ids?: string; products?: Record<string, Array<{ source?: string; code?: string; status?: string; updateTime?: number; properties?: Record<string, string> }>> };
  };
  const products = feature.properties?.products ?? {};
  const versions: ProviderVersion[] = [];
  const lastUpdate = new Map<string, number>();
  const lastDelete = new Map<string, number>();
  for (const p of products['origin'] ?? []) {
    const key = `${p.source}|${p.code}`;
    const at = finite(p.updateTime);
    if (at == null) continue;
    if ((p.status ?? '').toUpperCase() === 'DELETE') {
      lastDelete.set(key, Math.max(lastDelete.get(key) ?? 0, at));
      continue;
    }
    lastUpdate.set(key, Math.max(lastUpdate.get(key) ?? 0, at));
    const q = p.properties ?? {};
    const v = version({
      published: isoFromMs(at),
      time: isoOf(q['eventtime']),
      lat: finite(q['latitude']),
      lon: finite(q['longitude']),
      depthKm: finite(q['depth']),
      mag: finite(q['magnitude']),
      magType: q['magnitude-type'] ?? null,
      status: lower(q['review-status']),
      evaluation: lower(q['evaluation-status']),
      source: lower(p.source),
    });
    if (v) versions.push(v);
  }
  // Deleted when every origin product's latest version is a DELETE (an event ComCat removed).
  let deleted: number | null = null;
  if (lastDelete.size) {
    const keys = new Set([...lastUpdate.keys(), ...lastDelete.keys()]);
    let all = true;
    for (const k of keys) {
      const d = lastDelete.get(k);
      if (d == null || d < (lastUpdate.get(k) ?? 0)) all = false;
      else deleted = Math.max(deleted ?? 0, d);
    }
    if (!all) deleted = null;
  }
  const ids = (feature.properties?.ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const rec: FirstSolutionRecord = {
    schema: 1,
    provider: b.provider,
    provider_event_id: b.providerEventId,
    day: b.day,
    method: 'comcat-superseded',
    created: null,
    versions: sortVersions(versions),
    collected: b.collected,
  };
  const allIds = [...new Set([b.providerEventId, ...(feature.id ? [feature.id] : []), ...ids])];
  if (allIds.length > 1) rec.ids = allIds.sort();
  if (deleted != null) rec.deleted = isoFromMs(deleted);
  if (!versions.length && deleted == null) rec.missing = 'no origin products';
  return rec;
}

/** GeoNet's `quake/history/{publicID}` answer: a FeatureCollection, one Feature per location version. */
export function parseGeonetHistory(body: string, b: RecordBase): FirstSolutionRecord {
  const json = JSON.parse(body) as { features?: Array<{ geometry?: { coordinates?: unknown[] }; properties?: Record<string, unknown> }> };
  const versions: ProviderVersion[] = [];
  for (const f of json.features ?? []) {
    const p = f.properties ?? {};
    const c = f.geometry?.coordinates ?? [];
    const v = version({
      published: isoOf(p['modificationTime'] as string),
      time: isoOf(p['time'] as string),
      lat: finite(c[1]),
      lon: finite(c[0]),
      depthKm: finite(p['depth']),
      mag: finite(p['magnitude']),
      magType: null,
      status: lower(p['quality']),
      source: null,
    });
    if (v) versions.push(v);
  }
  const rec: FirstSolutionRecord = {
    schema: 1,
    provider: b.provider,
    provider_event_id: b.providerEventId,
    day: b.day,
    method: 'geonet-history',
    created: null,
    versions: sortVersions(versions),
    collected: b.collected,
  };
  if (!versions.length) rec.missing = 'no history';
  return rec;
}

/** The magnitude a QuakeML origin carried: the event's preferred magnitude when it belongs to this origin, else this
 *  origin's magnitude of the preferred one's type, else its first. */
function originMagnitude(originId: string, mags: XmlNode[], preferredMagId: string | null): XmlNode | undefined {
  const own = mags.filter((m) => textAt(m, 'originID') === originId);
  if (!own.length) return undefined;
  const preferred = preferredMagId ? mags.find((m) => m.attrs['publicID'] === preferredMagId) : undefined;
  if (preferred && own.includes(preferred)) return preferred;
  const type = preferred ? textAt(preferred, 'type') : null;
  return (type && own.find((m) => textAt(m, 'type') === type)) || own[0];
}

/** QuakeML with all origins: one record per event. `idOf` gives the feed's native id of an event publicID; a
 *  one-event request names its id instead (`requestedId`). */
export function parseQuakemlAllOrigins(
  body: string,
  provider: string,
  day: string,
  collected: string,
  idOf: (publicID: string) => string,
  requestedId?: string,
): FirstSolutionRecord[] {
  if (!body.trim()) return [];
  const root = parseXml(body);
  const events = descendants(root, 'event');
  const out: FirstSolutionRecord[] = [];
  for (const ev of events) {
    const publicID = ev.attrs['publicID'] ?? '';
    const id = requestedId && events.length === 1 ? requestedId : idOf(publicID);
    if (!id) continue;
    const mags = childrenNamed(ev, 'magnitude');
    const preferredMagId = textAt(ev, 'preferredMagnitudeID');
    const versions: ProviderVersion[] = [];
    let undated = 0;
    for (const o of childrenNamed(ev, 'origin')) {
      const ci = child(o, 'creationInfo');
      const published = isoOf(textAt(ci, 'creationTime'));
      if (!published) {
        undated++;
        continue;
      }
      const m = originMagnitude(o.attrs['publicID'] ?? '', mags, preferredMagId);
      const depthM = finite(textAt(o, 'depth', 'value'));
      const v = version({
        published,
        time: isoOf(textAt(o, 'time', 'value')),
        lat: finite(textAt(o, 'latitude', 'value')),
        lon: finite(textAt(o, 'longitude', 'value')),
        depthKm: depthM == null ? null : depthM / 1000,
        mag: finite(textAt(m, 'mag', 'value')),
        magType: textAt(m, 'type'),
        status: lower(textAt(o, 'evaluationMode')) ?? lower(textAt(o, 'evaluationStatus')),
        evaluation: lower(textAt(o, 'evaluationStatus')),
        source: textAt(ci, 'agencyID') ?? textAt(ci, 'author'),
        version: textAt(ci, 'version'),
      });
      if (v) versions.push(v);
      else undated++;
    }
    const rec: FirstSolutionRecord = {
      schema: 1,
      provider,
      provider_event_id: id,
      day,
      method: 'quakeml-all-origins',
      created: isoOf(textAt(child(ev, 'creationInfo'), 'creationTime')),
      versions: sortVersions(versions),
      collected,
    };
    if (undated) rec.undated = undated;
    if (!versions.length && !rec.created) rec.missing = 'no dated origin';
    out.push(rec);
  }
  return out;
}

// --- reading chunks back ---------------------------------------------------------------------------------------------

const versionKey = (v: ProviderVersion): string => `${v.published}|${v.source ?? ''}|${v.time}|${v.lat}|${v.lon}|${v.mag ?? ''}`;

/** Two records of one report (a re-collection, or a chunk of a run whose cursor never landed) as one: every version
 *  either kept, the earlier creation time, the later collection time; `missing` only if neither has a version. */
export function mergeRecords(a: FirstSolutionRecord, b: FirstSolutionRecord): FirstSolutionRecord {
  const byKey = new Map<string, ProviderVersion>();
  for (const v of [...a.versions, ...b.versions]) byKey.set(versionKey(v), v);
  const versions = sortVersions([...byKey.values()]);
  const created = [a.created, b.created].filter((c): c is string => !!c).sort()[0] ?? null;
  const newer = a.collected >= b.collected ? a : b;
  const out: FirstSolutionRecord = { ...newer, versions, created };
  const ids = [...new Set([...(a.ids ?? []), ...(b.ids ?? [])])].sort();
  if (ids.length) out.ids = ids;
  else delete out.ids;
  const deleted = [a.deleted, b.deleted].filter((d): d is string => !!d).sort().pop();
  if (deleted) out.deleted = deleted;
  else delete out.deleted;
  if (versions.length || created) delete out.missing;
  else out.missing = newer.missing ?? a.missing ?? b.missing;
  const undated = Math.max(a.undated ?? 0, b.undated ?? 0);
  if (undated) out.undated = undated;
  else delete out.undated;
  return out;
}

/** Every record read from the chunks, by `provider:id` (each ComCat alias in `ids` too). */
export class FirstSolutionIndex {
  private readonly byKey = new Map<string, FirstSolutionRecord>();
  private readonly aliasOf = new Map<string, string>();
  records = 0;

  add(r: FirstSolutionRecord): void {
    this.records++;
    const key = `${r.provider}:${r.provider_event_id}`;
    const had = this.byKey.get(key);
    const merged = had ? mergeRecords(had, r) : r;
    this.byKey.set(key, merged);
    for (const id of merged.ids ?? []) {
      const alias = `${r.provider}:${id}`;
      if (alias !== key && !this.byKey.has(alias)) this.aliasOf.set(alias, key);
    }
  }

  /** The record of a report, found by its own id or (ComCat) by any id the provider gives the event. */
  get(provider: string, id: string): FirstSolutionRecord | null {
    const key = `${provider}:${id}`;
    return this.byKey.get(key) ?? this.byKey.get(this.aliasOf.get(key) ?? '') ?? null;
  }
}
