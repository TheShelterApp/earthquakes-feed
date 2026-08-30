import { request as httpsRequest } from 'node:https';
import { gunzipSync, strFromU8, unzipSync, unzlibSync } from 'fflate';
import { QUERY_LOOKBACK_MS } from './config.js';
import type { ProviderConfig, RawObs } from './types.js';
import { flattenScalars, num, parseUtcMs } from './util.js';

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface GetOpts {
  timeoutMs?: number;
  retries?: number;
  ua?: string;
  /** Relax TLS verification for THIS request only — for gov endpoints that serve an
   *  incomplete certificate chain (e.g. TMD). Scoped, never global. */
  insecure?: boolean;
}

function once(url: string, timeoutMs: number, ua: string, insecure: boolean): Promise<string> {
  if (!insecure) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': ua, accept: '*/*' } })
      .then(async (res) => {
        const body = await res.text();
        if (res.status >= 200 && res.status < 300) return body;
        throw new Error(`HTTP ${res.status}`);
      })
      .finally(() => clearTimeout(timer));
  }
  return new Promise<string>((resolve, reject) => {
    const u = new URL(url);
    const req = httpsRequest(
      { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET', headers: { 'user-agent': ua, accept: '*/*' }, rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        // Collect raw bytes — some gov CDNs (e.g. PHIVOLCS) return content-encoding: gzip
        // regardless of Accept-Encoding, so decode by the header rather than assuming utf8.
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const sc = res.statusCode ?? 0;
          if (sc < 200 || sc >= 300) return reject(new Error(`HTTP ${sc}`));
          try {
            let buf: Uint8Array = Buffer.concat(chunks);
            const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
            if (enc.includes('gzip')) buf = gunzipSync(buf);
            else if (enc.includes('deflate')) buf = unzlibSync(buf);
            resolve(strFromU8(buf));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function getText(url: string, opts: GetOpts = {}): Promise<string> {
  // National-agency endpoints commonly UA-gate non-browser clients — default to a browser UA.
  const { timeoutMs = 10_000, retries = 1, ua = BROWSER_UA, insecure = false } = opts;
  let lastErr: unknown = new Error('no attempt');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await once(url, timeoutMs, ua, insecure);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Fetch a binary body (for zip bundles). S3/CDN endpoints — valid TLS, no UA gating. */
async function getBinary(url: string, opts: { timeoutMs?: number; retries?: number } = {}): Promise<Uint8Array> {
  const { timeoutMs = 15_000, retries = 2 } = opts;
  let lastErr: unknown = new Error('no attempt');
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': BROWSER_UA, accept: '*/*' } });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** "YYYY-MM-DD HH:MM:SS" from epoch-ms (UTC). */
const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** Parse a naive local timestamp and shift by its UTC offset (hours) to get true UTC ms. */
const shiftUtc = (local: unknown, offsetHours: number): number | null => {
  const ms = parseUtcMs(local as string | number | null);
  return ms == null ? null : ms - offsetHours * 3_600_000;
};
const htmlDecode = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

export interface Window {
  startMs: number;
  endMs: number;
}
export type CustomAdapter = (cfg: ProviderConfig, nowMs: number, window?: Window) => Promise<RawObs[]>;

// --- Turkey: AFAD (query is local time UTC+3, dense down to ~M0.6) ---
const afad: CustomAdapter = async (cfg, nowMs, window) => {
  const startMs = window ? window.startMs : nowMs - QUERY_LOOKBACK_MS;
  const endMs = window ? window.endMs : nowMs;
  // Pad ±4h so the UTC window is fully covered by the local-time (UTC+3) query bounds;
  // fetchProviderWindow re-filters to the exact UTC window afterward.
  const start = fmt(startMs - 4 * 3_600_000).replace(' ', '%20');
  const end = fmt(endMs + 4 * 3_600_000).replace(' ', '%20');
  const url = `${cfg.base}?start=${start}&end=${end}&orderby=timedesc&limit=500`;
  const raw = JSON.parse(await getText(url, { timeoutMs: 12_000, retries: 2 })) as unknown;
  const list = Array.isArray(raw) ? raw : ((raw as { eventList?: unknown[] }).eventList ?? []);
  const out: RawObs[] = [];
  for (const e of list as Record<string, unknown>[]) {
    const t = shiftUtc(e['date'], 3);
    const lat = num(e['latitude']);
    const lon = num(e['longitude']);
    if (t == null || lat == null || lon == null) continue;
    out.push({
      provider: cfg.id, providerEventId: String(e['eventID'] ?? ''), eventTimeMs: t,
      providerUpdatedMs: shiftUtc(e['lastUpdateDate'], 3),
      status: null, lat, lon, depth: num(e['depth']),
      mag: num(e['magnitude']), magType: (e['type'] as string) ?? null,
      place: (e['location'] as string) ?? null, knownAliasIds: [], fields: flattenScalars(e),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- China: CENC (Beijing time UTC+8) ---
const cenc: CustomAdapter = async (cfg) => {
  const raw = JSON.parse(await getText(cfg.base, { timeoutMs: 12_000, retries: 1 })) as unknown;
  const list = Array.isArray(raw) ? raw : ((raw as { data?: unknown[] }).data ?? []);
  const out: RawObs[] = [];
  for (const e of list as Record<string, unknown>[]) {
    const t = shiftUtc(e['time'], 8);
    const lat = num(e['latitude']);
    const lon = num(e['longitude']);
    if (t == null || lat == null || lon == null) continue;
    out.push({
      provider: cfg.id, providerEventId: String(e['id'] ?? ''), eventTimeMs: t, providerUpdatedMs: null,
      status: null, lat, lon, depth: num(e['depth']), mag: num(e['magnitude']), magType: null,
      place: (e['location'] as string) ?? null, knownAliasIds: [], fields: flattenScalars(e),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- Thailand + Myanmar: TMD (otime already UTC) ---
const tmd: CustomAdapter = async (cfg) => {
  // TMD serves an incomplete TLS chain (missing GlobalSign intermediate) → scoped insecure fetch.
  const raw = JSON.parse(await getText(cfg.base, { timeoutMs: 15_000, retries: 2, insecure: true })) as { events?: Record<string, unknown>[] };
  const out: RawObs[] = [];
  for (const e of raw.events ?? []) {
    const t = parseUtcMs(e['otime'] as string);
    const lat = num(e['lat']);
    const lon = num(e['lon']);
    if (t == null || lat == null || lon == null) continue;
    out.push({
      provider: cfg.id, providerEventId: String(e['eventID'] ?? ''), eventTimeMs: t, providerUpdatedMs: null,
      status: null, lat, lon, depth: num(e['depth']), mag: num(e['mag']), magType: null,
      place: (e['region'] as string) ?? null, knownAliasIds: [], fields: flattenScalars(e),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- Russia (Kamchatka/Kurils): KAGSR — non-standard FDSN geojson (UTC), flaky ---
const kagsr: CustomAdapter = async (cfg, nowMs, window) => {
  const startMs = window ? window.startMs : nowMs - QUERY_LOOKBACK_MS;
  const endMs = window ? window.endMs : nowMs;
  const url = `${cfg.base}?format=geojson&starttime=${fmt(startMs).replace(' ', 'T')}&endtime=${fmt(endMs).replace(' ', 'T')}`;
  const body = await getText(url, { timeoutMs: 15_000, retries: 3, ua: BROWSER_UA });
  const json = JSON.parse(body) as { features?: { geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }[] };
  const out: RawObs[] = [];
  for (const f of json.features ?? []) {
    const p = f.properties ?? {};
    const coords = f.geometry?.coordinates ?? [];
    const lat = num(p['latitude']) ?? num(coords[1]);
    const lon = num(p['longitude']) ?? num(coords[0]);
    const t = parseUtcMs(p['time'] as string);
    if (t == null || lat == null || lon == null) continue;
    const loc = p['nearestLocality'] as { name?: string } | undefined;
    out.push({
      provider: cfg.id, providerEventId: String(p['eventId'] ?? p['eventName'] ?? ''), eventTimeMs: t,
      providerUpdatedMs: null, status: null, lat, lon, depth: num(p['depth']),
      mag: num(p['magnitude']), magType: (p['magnitudeType'] as string) ?? null,
      place: loc?.name ?? null, knownAliasIds: [], fields: flattenScalars(p),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- India: NCS/RISEQ — events embedded as data-json attributes (IST UTC+5:30) ---
const ncs: CustomAdapter = async (cfg) => {
  const html = await getText(cfg.base, { timeoutMs: 15_000, retries: 1, ua: BROWSER_UA });
  const matches = [...html.matchAll(/data-json=(?:"([^"]*)"|'([^']*)')/g)];
  const out: RawObs[] = [];
  for (const m of matches) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(htmlDecode(m[1] ?? m[2] ?? '')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = shiftUtc(String(obj['origin_time'] ?? '').replace(/\s*IST\s*$/i, ''), 5.5);
    const ll = String(obj['lat_long'] ?? '').split(',');
    const lat = num(ll[0]);
    const lon = num(ll[1]);
    const md = String(obj['magnitude_depth'] ?? '');
    const mag = num(md.match(/M:\s*([-\d.]+)/)?.[1] ?? null);
    const depth = num(md.match(/D:\s*([-\d.]+)/)?.[1] ?? null);
    if (t == null || lat == null || lon == null) continue;
    out.push({
      provider: cfg.id, providerEventId: String(obj['event_id'] ?? ''), eventTimeMs: t, providerUpdatedMs: null,
      status: (obj['event_type'] as string) ?? null, lat, lon, depth, mag, magType: null,
      place: (String(obj['event_name'] ?? '').replace(/^M:\s*[-\d.]+\s*-\s*/i, '') || null), knownAliasIds: [], fields: flattenScalars(obj),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- Japan: JMA official hypocenter/intensity list (times carry +09:00 offset; `cod`
//     encodes "±lat±lon±depth(m)/" in ISO 6709) ---

/** One ISO 6709 angular component ("+36.0", "+3559.9", "+14005.7"). `degDigits` is the
 *  fixed width of the degrees field: 2 for latitude, 3 for longitude. ISO 6709 is
 *  self-describing by integer width: degDigits ⇒ decimal degrees; degDigits+2 ⇒
 *  degrees+minutes (DDMM.m); degDigits+4 ⇒ degrees+minutes+seconds. */
function iso6709(component: string, degDigits: number): number | null {
  const m = /^([+-])(\d+)(\.\d+)?$/.exec(component);
  if (!m) return num(component);
  const sign = m[1] === '-' ? -1 : 1;
  const int = m[2]!;
  const frac = m[3] ?? '';
  if (int.length <= degDigits) return sign * Number(int + frac);
  if (int.length === degDigits + 2) {
    return sign * (Number(int.slice(0, degDigits)) + Number(int.slice(degDigits) + frac) / 60);
  }
  if (int.length === degDigits + 4) {
    return (
      sign *
      (Number(int.slice(0, degDigits)) +
        Number(int.slice(degDigits, degDigits + 2)) / 60 +
        Number(int.slice(degDigits + 2) + frac) / 3600)
    );
  }
  return sign * Number(int + frac);
}

/** Parse a JMA `cod` hypocenter string. Routine bulletins give decimal degrees
 *  (`+36.0+140.1-70000/`); the VXSE61 "顕著な地震の震源要素更新" hypocenter-element update
 *  gives sexagesimal degrees+minutes (`+3559.9+14005.7-68000/` = 35°59.9′N 140°05.7′E).
 *  Both are ISO 6709 — reading either as a raw decimal put lat/lon out of range and
 *  red-lined derive's validate gate for the whole feed (2026-08-22). Depth is metres. */
export function parseJmaCod(cod: string): { lat: number; lon: number; depthKm: number | null } | null {
  const m = /([+-][\d.]+)([+-][\d.]+)([+-]\d+)?/.exec(cod ?? '');
  if (!m) return null;
  const lat = iso6709(m[1]!, 2);
  const lon = iso6709(m[2]!, 3);
  if (lat == null || lon == null) return null;
  const depthM = m[3] != null ? num(m[3]) : null;
  return { lat, lon, depthKm: depthM != null ? Math.abs(depthM) / 1000 : null };
}

/** Build JMA observations from a decoded list.json. JMA publishes several bulletins per
 *  quake under ONE `eid` — 震度速報 (intensity only, no hypocenter), 震源に関する情報,
 *  震源・震度情報, then a refined 顕著な地震の震源要素更新 for notable events — each a
 *  separate entry with its own `cod`. Emitting every bulletin made one feed flip-flop
 *  between differing solutions and churn a fresh revision every cycle (2026-08-22).
 *  Collapse to one observation per eid: the latest-issued (`ctt`, a sortable
 *  YYYYMMDDHHMMSS stamp) bulletin that actually carries a hypocenter. */
export function parseJmaList(list: unknown, providerId: string): RawObs[] {
  const best = new Map<string, Record<string, unknown>>();
  for (const e of Array.isArray(list) ? (list as Record<string, unknown>[]) : []) {
    const eid = String(e['eid'] ?? '');
    if (!eid || !parseJmaCod(String(e['cod'] ?? ''))) continue; // skip 震度速報 (empty cod)
    const cur = best.get(eid);
    if (!cur || String(e['ctt'] ?? '') > String(cur['ctt'] ?? '')) best.set(eid, e);
  }
  const out: RawObs[] = [];
  for (const e of best.values()) {
    const c = parseJmaCod(String(e['cod'] ?? ''))!;
    const t = parseUtcMs((e['at'] as string) ?? (e['rdt'] as string));
    if (t == null) continue;
    out.push({
      provider: providerId, providerEventId: String(e['eid']), eventTimeMs: t,
      providerUpdatedMs: parseUtcMs(e['rdt'] as string), status: null, lat: c.lat, lon: c.lon,
      depth: c.depthKm, mag: num(e['mag']), magType: 'Mj',
      place: (e['en_anm'] as string) || (e['anm'] as string) || null, knownAliasIds: [], fields: flattenScalars(e),
    });
  }
  return out;
}

const jma: CustomAdapter = async (cfg) =>
  parseJmaList(JSON.parse(await getText(cfg.base, { timeoutMs: 12_000, retries: 2 })), cfg.id);

// --- Mexico: SSN/UNAM (RSS; local time America/Mexico_City = UTC-6, no DST) ---
const mexico: CustomAdapter = async (cfg) => {
  const xml = await getText(cfg.base, { timeoutMs: 12_000, retries: 2 });
  const out: RawObs[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1]!;
    const lat = num(/<geo:lat>([^<]+)</.exec(it)?.[1]);
    const lon = num(/<geo:long>([^<]+)</.exec(it)?.[1]);
    const desc = /<description>([\s\S]*?)<\/description>/.exec(it)?.[1] ?? '';
    const local = /Fecha:\s*([\d-]+ [\d:]+)/.exec(desc)?.[1] ?? null;
    const t = local ? shiftUtc(local, -6) : null;
    if (lat == null || lon == null || t == null) continue;
    const title = htmlDecode(/<title>([^<]+)</.exec(it)?.[1] ?? '');
    out.push({
      provider: cfg.id, providerEventId: `${local!.replace(/[ :]/g, '')}_${lat}_${lon}`, eventTimeMs: t,
      providerUpdatedMs: null, status: null, lat, lon, depth: num(/Profundidad:\s*([\d.]+)/.exec(desc)?.[1]),
      mag: num(/^([\d.]+)/.exec(title)?.[1]), magType: null, place: title.replace(/^[\d.]+,\s*/, '') || null,
      knownAliasIds: [], fields: { title, description: desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() },
    });
  }
  return out;
};

// --- Portugal + Azores: IPMA (UTC times; areas 3=Azores, 7=mainland; magnitud -99 = none) ---
const ipma: CustomAdapter = async (cfg) => {
  const out: RawObs[] = [];
  for (const area of ['3', '7']) {
    let list: Record<string, unknown>[] = [];
    try {
      list = (JSON.parse(await getText(`${cfg.base}${area}.json`, { timeoutMs: 12_000, retries: 1 })) as { data?: Record<string, unknown>[] }).data ?? [];
    } catch {
      continue;
    }
    for (const e of list) {
      const lat = num(e['lat']);
      const lon = num(e['lon']);
      const t = parseUtcMs(e['time'] as string);
      if (lat == null || lon == null || t == null) continue;
      const mag = num(e['magnitud']);
      out.push({
        provider: cfg.id, providerEventId: String(e['sismoId'] || `${e['time']}_${lat}_${lon}`), eventTimeMs: t,
        providerUpdatedMs: parseUtcMs(e['dataUpdate'] as string), status: null, lat, lon, depth: num(e['depth']),
        mag: mag != null && mag > -90 ? mag : null, magType: (e['magType'] as string) || null,
        place: (e['obsRegion'] as string) || null, knownAliasIds: [], fields: flattenScalars(e),
      });
    }
  }
  return out.filter((o) => o.providerEventId);
};

// --- Peru: IGP (one JSON file per year; fecha_utc has the date, hora_utc the time-of-day) ---
const igp: CustomAdapter = async (cfg, nowMs, window) => {
  const endMs = window ? window.endMs : nowMs;
  const startMs = window ? window.startMs : endMs;
  const out: RawObs[] = [];
  // Live = current year; backfill = every year the window spans (each is one file).
  for (let year = new Date(startMs).getUTCFullYear(); year <= new Date(endMs).getUTCFullYear(); year++) {
    let list: Record<string, unknown>[] = [];
    try {
      const j = JSON.parse(await getText(`${cfg.base}${year}`, { timeoutMs: 15_000, retries: 2 }));
      list = Array.isArray(j) ? j : [];
    } catch {
      continue;
    }
    for (const e of list) {
      const lat = num(e['latitud']);
      const lon = num(e['longitud']);
      const dstr = String(e['fecha_utc'] ?? '').slice(0, 10);
      const tstr = String(e['hora_utc'] ?? '').slice(11, 19);
      const t = dstr ? parseUtcMs(`${dstr}T${tstr || '00:00:00'}Z`) : null;
      if (lat == null || lon == null || t == null) continue;
      // In a backfill window keep only in-range events, so overflow reflects the window, not the year.
      if (window && (t < startMs - 60_000 || t > endMs + 60_000)) continue;
      out.push({
        provider: cfg.id, providerEventId: String(e['codigo'] ?? ''), eventTimeMs: t,
        providerUpdatedMs: parseUtcMs(e['updatedAt'] as string), status: null, lat, lon, depth: num(e['profundidad']),
        mag: num(e['magnitud']), magType: (e['tipomagnitud'] as string) || null, place: (e['referencia'] as string) || null,
        knownAliasIds: [], fields: flattenScalars(e),
      });
    }
  }
  return out.filter((o) => o.providerEventId);
};

// --- Egypt: ENSN/NRIAG (JSON; `time` is UNIX epoch seconds) ---
const egypt: CustomAdapter = async (cfg) => {
  const j = JSON.parse(await getText(cfg.base, { timeoutMs: 12_000, retries: 2 })) as { data?: { earthquakes?: Record<string, unknown>[] } };
  const out: RawObs[] = [];
  for (const e of j.data?.earthquakes ?? []) {
    const lat = num(e['latitude']);
    const lon = num(e['longitude']);
    const ts = num(e['time']);
    if (lat == null || lon == null || ts == null) continue;
    out.push({
      provider: cfg.id, providerEventId: String(e['id'] ?? e['name'] ?? ''), eventTimeMs: Math.round(ts * 1000),
      providerUpdatedMs: null, status: e['isManual'] === true ? 'reviewed' : 'automatic', lat, lon, depth: num(e['depth']),
      mag: num(e['magnitudeValue']), magType: (e['magnitudeType'] as string) || null,
      place: (e['nearestMajorPlace'] as string) || (e['nearestPlace'] as string) || null, knownAliasIds: [], fields: flattenScalars(e),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- United Kingdom: BGS (RSS; pubDate is RFC822 in GMT/UTC) ---
const bgs: CustomAdapter = async (cfg) => {
  const xml = await getText(cfg.base, { timeoutMs: 12_000, retries: 2 });
  const out: RawObs[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1]!;
    const lat = num(/<geo:lat>([^<]+)</.exec(it)?.[1]);
    const lon = num(/<geo:long>([^<]+)</.exec(it)?.[1]);
    const pub = /<pubDate>([^<]+)</.exec(it)?.[1];
    const t = pub ? Date.parse(`${pub} GMT`) : NaN;
    if (lat == null || lon == null || !Number.isFinite(t)) continue;
    const desc = htmlDecode(/<description>([\s\S]*?)<\/description>/.exec(it)?.[1] ?? '');
    const link = /<link>([^<]+)</.exec(it)?.[1] ?? '';
    out.push({
      provider: cfg.id, providerEventId: /(\d{14})/.exec(link)?.[1] ?? `${t}_${lat}_${lon}`, eventTimeMs: t,
      providerUpdatedMs: null, status: null, lat, lon, depth: num(/Depth:\s*([\d.]+)/.exec(desc)?.[1]),
      mag: num(/Magnitude:\s*([\d.]+)/.exec(desc)?.[1]), magType: null,
      place: (/Location:\s*([^;]+)/.exec(desc)?.[1] ?? '').trim() || null, knownAliasIds: [],
      fields: { title: htmlDecode(/<title>([^<]+)</.exec(it)?.[1] ?? ''), description: desc.trim() },
    });
  }
  return out;
};

/** Extract the first balanced {...} object after a marker (for JS-wrapped JSON, e.g. IGN). */
function jsonObjectAfter(src: string, marker: string): string | null {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const start = src.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

// --- Spain: IGN (JS-wrapped GeoJSON; `dias30` = 30-day superset; `fecha` is UTC) ---
const ign: CustomAdapter = async (cfg) => {
  const js = await getText(cfg.base, { timeoutMs: 15_000, retries: 2 });
  const objText = jsonObjectAfter(js, 'dias30');
  if (!objText) return [];
  let fc: { features?: { geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }[] };
  try {
    fc = JSON.parse(objText);
  } catch {
    return [];
  }
  const out: RawObs[] = [];
  for (const f of fc.features ?? []) {
    const p = f.properties ?? {};
    const c = f.geometry?.coordinates ?? [];
    const lat = num(c[1]);
    const lon = num(c[0]);
    const t = parseUtcMs(p['fecha'] as string);
    if (lat == null || lon == null || t == null) continue;
    out.push({
      provider: cfg.id, providerEventId: String(p['evid'] ?? ''), eventTimeMs: t, providerUpdatedMs: null,
      status: null, lat, lon, depth: num(p['depth']), mag: num(p['mag']), magType: (p['magtype'] as string) || null,
      place: (p['loc'] as string)?.trim() || null, knownAliasIds: [], fields: flattenScalars(p),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- Iceland: IMO "Quakes API" (clean GeoJSON, `time` already UTC, supports a time window) ---
const imo: CustomAdapter = async (cfg, nowMs, window) => {
  const startMs = window ? window.startMs : nowMs - QUERY_LOOKBACK_MS;
  const endMs = window ? window.endMs : nowMs;
  const start = new Date(startMs).toISOString().slice(0, 19);
  const end = new Date(endMs).toISOString().slice(0, 19);
  // Live keeps every micro-quake; backfill applies backfill.minmag (Iceland's M<1 swarm
  // seismicity is enormous — an unfiltered 3-year backfill would dwarf the whole feed).
  const sizeMin = window ? (cfg.backfill?.minmag ?? -3) : -3;
  const url = `${cfg.base}?start_time=${start}&end_time=${end}&size_min=${sizeMin}&format=json`;
  const j = JSON.parse(await getText(url, { timeoutMs: 15_000, retries: 2 })) as {
    features?: { geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }[];
  };
  const out: RawObs[] = [];
  for (const f of j.features ?? []) {
    const p = f.properties ?? {};
    const c = f.geometry?.coordinates ?? [];
    const lat = num(c[1]);
    const lon = num(c[0]);
    const t = parseUtcMs(p['time'] as string);
    if (lat == null || lon == null || t == null) continue;
    out.push({
      provider: cfg.id, providerEventId: String(p['event_id'] ?? ''), eventTimeMs: t,
      providerUpdatedMs: parseUtcMs(p['updated_time'] as string),
      status: p['evaluation_mode'] === 'manual' ? 'reviewed' : 'automatic', lat, lon, depth: num(p['depth']),
      mag: num(p['magnitude']), magType: (p['magnitude_type'] as string) || null, place: (p['region'] as string) || null,
      knownAliasIds: [], fields: flattenScalars(p),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- Indonesia: BMKG (two latest-N JSON feeds; `DateTime` is UTC; needs a desktop UA) ---
const bmkg: CustomAdapter = async (cfg) => {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  const out: RawObs[] = [];
  const seen = new Set<string>();
  for (const file of ['gempaterkini.json', 'gempadirasakan.json']) {
    let list: Record<string, unknown>[] = [];
    try {
      const j = JSON.parse(await getText(`${cfg.base}${file}`, { timeoutMs: 12_000, retries: 2, ua: UA })) as { Infogempa?: { gempa?: unknown } };
      const g = j.Infogempa?.gempa;
      list = Array.isArray(g) ? (g as Record<string, unknown>[]) : g ? [g as Record<string, unknown>] : [];
    } catch {
      continue;
    }
    for (const e of list) {
      const t = parseUtcMs(e['DateTime'] as string);
      const ll = String(e['Coordinates'] ?? '').split(',');
      const lat = num(ll[0]);
      const lon = num(ll[1]);
      if (t == null || lat == null || lon == null) continue;
      // No native event id → derive a stable one from the UTC origin time (second resolution).
      const id = `bmkg:${new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        provider: cfg.id, providerEventId: id, eventTimeMs: t, providerUpdatedMs: null, status: null,
        lat, lon, depth: num(String(e['Kedalaman'] ?? '').replace(/[^\d.]/g, '')), mag: num(e['Magnitude']),
        magType: null, place: (e['Wilayah'] as string) || null, knownAliasIds: [], fields: flattenScalars(e),
      });
    }
  }
  return out;
};

// --- Argentina: INPRES (bespoke <lista><item> XML; `idSismo` is 14-digit UTC YYYYMMDDHHMMSS) ---
const inpres: CustomAdapter = async (cfg) => {
  const xml = await getText(cfg.base, { timeoutMs: 12_000, retries: 2 });
  const out: RawObs[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1]!;
    const tag = (n: string): string | null => (new RegExp(`<${n}>([^<]*)<`).exec(it)?.[1] ?? '').trim() || null;
    const id = tag('idSismo') ?? '';
    const lat = num(tag('latitud'));
    const lon = num(tag('longitud'));
    const t = /^\d{14}$/.test(id)
      ? parseUtcMs(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(8, 10)}:${id.slice(10, 12)}:${id.slice(12, 14)}Z`)
      : null;
    if (lat == null || lon == null || t == null) continue;
    out.push({
      provider: cfg.id, providerEventId: id, eventTimeMs: t, providerUpdatedMs: null, status: null,
      lat, lon, depth: num(tag('prof')), mag: num(tag('mg')), magType: null, place: tag('prov'), knownAliasIds: [],
      fields: flattenScalars({ idSismo: id, prof: tag('prof'), mg: tag('mg'), prov: tag('prov'), fecha: tag('fecha'), hora: tag('hora') } as Record<string, unknown>),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- Australia: Geoscience Australia (RSS; times UTC; georss:point = "lat lon") ---
const ga: CustomAdapter = async (cfg) => {
  const xml = await getText(cfg.base, { timeoutMs: 12_000, retries: 2 });
  const out: RawObs[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1]!;
    const id = (/<link>([^<]+)</.exec(it)?.[1] ?? '').split('/').pop()?.trim() ?? '';
    const pt = (/<georss:point>([^<]+)</.exec(it)?.[1] ?? '').trim().split(/\s+/);
    const lat = num(pt[0]);
    const lon = num(pt[1]);
    const desc = (/<description>([^<]+)</.exec(it)?.[1] ?? '').replace(/\(UTC\)/i, '').trim();
    const t = parseUtcMs(desc);
    if (!id || lat == null || lon == null || t == null) continue;
    const title = htmlDecode(/<title>([^<]+)</.exec(it)?.[1] ?? '');
    const summary = htmlDecode(/<summary>([\s\S]*?)<\/summary>/.exec(it)?.[1] ?? '').trim();
    out.push({
      provider: cfg.id, providerEventId: id, eventTimeMs: t, providerUpdatedMs: null, status: null,
      lat, lon, depth: num(/Depth\s*([\d.]+)\s*km/i.exec(summary)?.[1]),
      mag: num(/Magnitude\s*([\d.]+)/i.exec(title)?.[1]), magType: null,
      place: title.replace(/^Magnitude\s*[\d.]+,\s*/i, '').trim() || null, knownAliasIds: [],
      fields: { title, description: desc, summary },
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- Costa Rica: OVSICORI-UNA (Leaflet L.marker JS; "Fecha y Hora Local" is UTC-6, no DST) ---
const ovsicori: CustomAdapter = async (cfg) => {
  const html = await getText(cfg.base, { timeoutMs: 15_000, retries: 2 });
  const out: RawObs[] = [];
  const re = /L\.marker\(\[(-?\d+\.?\d*),(-?\d+\.?\d*)\],\{icon:\s*eq(\d+)\}\)\.bindPopup\('([\s\S]*?)',\{minWidth/g;
  for (const m of html.matchAll(re)) {
    const lat = num(m[1]);
    const lon = num(m[2]); // already signed (west negative) in the marker array
    const id = m[3]!;
    const popup = m[4]!;
    const local = /Fecha y Hora Local:<\/td>\s*<td[^>]*>([\d-]+ [\d:]+)</.exec(popup)?.[1];
    const t = local ? shiftUtc(local, -6) : null;
    if (lat == null || lon == null || t == null) continue;
    out.push({
      provider: cfg.id, providerEventId: id, eventTimeMs: t, providerUpdatedMs: null,
      status: /Revisado:<\/td>\s*<td[^>]*>\s*y\s*</i.test(popup) ? 'reviewed' : 'automatic',
      lat, lon, depth: num(/Prof\.\s*\[km\]:<\/td>\s*<td[^>]*>([\d.]+)</.exec(popup)?.[1]),
      mag: num(/Magnitud:<\/td>\s*<td[^>]*>([\d.]+)</.exec(popup)?.[1]), magType: null,
      place: htmlDecode((/Ubicacion:<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/.exec(popup)?.[1] ?? '').trim()) || null,
      knownAliasIds: [],
      fields: flattenScalars({ eqid: id, fecha_local: local, autor: (/Autor:<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/.exec(popup)?.[1] ?? '').trim() } as Record<string, unknown>),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- Ecuador: IG-EPN "Últimos 50 eventos" HTML table (13 cols; cell[11] = Fecha UTC) ---
const igepn: CustomAdapter = async (cfg) => {
  const html = await getText(cfg.base, { timeoutMs: 15_000, retries: 2 });
  const out: RawObs[] = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]!.replace(/<[^>]+>/g, '').trim());
    if (c.length < 13 || !/^\d+$/.test(c[0]!)) continue;
    const t = parseUtcMs(c[11]!);
    const latM = /([\d.]+)\D*([NS])/i.exec(c[5]!);
    const lonM = /([\d.]+)\D*([EWO])/i.exec(c[6]!);
    if (t == null || !latM || !lonM) continue;
    const lat = num(latM[1])! * (latM[2]!.toUpperCase() === 'S' ? -1 : 1);
    const lon = num(lonM[1])! * (/[WO]/i.test(lonM[2]!) ? -1 : 1);
    out.push({
      provider: cfg.id, providerEventId: c[1]!, eventTimeMs: t, providerUpdatedMs: null,
      status: /revisad/i.test(c[10] ?? '') ? 'reviewed' : 'automatic', lat, lon, depth: num(c[7]),
      mag: num(c[2]), magType: c[3] || null, place: c[8] || null, knownAliasIds: [],
      fields: flattenScalars({ evento: c[1], tipo_magnitud: c[3], region: c[8], ciudad: c[9], estado: c[10] } as Record<string, unknown>),
    });
  }
  return out.filter((o) => o.providerEventId);
};

// --- Chile: CSN per-UTC-day HTML catalog (td[1] is already UTC; id from the informe href) ---
const csn: CustomAdapter = async (cfg, nowMs, window) => {
  const out: RawObs[] = [];
  const seen = new Set<string>();
  const DAY = 86_400_000;
  // Live: today + yesterday (catches late/revised events near UTC midnight). Backfill: every
  // UTC day the window spans (each day is one page), newest-first, capped for safety.
  const days: number[] = [];
  if (window) {
    for (let ms = Math.floor(window.endMs / DAY) * DAY; ms >= window.startMs - DAY; ms -= DAY) days.push(ms);
    if (days.length > 40) days.length = 40;
  } else {
    days.push(nowMs, nowMs - DAY);
  }
  for (const dms of days) {
    const d = new Date(dms);
    const y = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    let html: string;
    try {
      html = await getText(`${cfg.base}${y}/${mm}/${y}${mm}${dd}.html`, { timeoutMs: 12_000, retries: 1 });
    } catch {
      continue;
    }
    for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const c = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]!);
      if (c.length < 5) continue;
      const id = /\/informes\/\d{4}\/\d{2}\/(\d+)\.html/.exec(c[0]!)?.[1];
      if (!id || seen.has(id)) continue;
      const t = parseUtcMs(c[1]!.replace(/<[^>]+>/g, '').trim()); // td[1] = Fecha UTC
      const ll = c[2]!.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').trim().split(/\s+/);
      const lat = num(ll[0]);
      const lon = num(ll[1]);
      if (t == null || lat == null || lon == null) continue;
      seen.add(id);
      const magTxt = c[4]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      out.push({
        provider: cfg.id, providerEventId: id, eventTimeMs: t, providerUpdatedMs: null, status: null,
        lat, lon, depth: num(c[3]!.replace(/[^\d.]/g, '')), mag: num(/^([\d.]+)/.exec(magTxt)?.[1]),
        magType: magTxt.replace(/^[\d.]+\s*/, '') || null,
        place: htmlDecode((c[0]!.split(/<br\s*\/?>/i)[1] ?? '').replace(/<[^>]+>/g, '').trim()) || null,
        knownAliasIds: [], fields: {},
      });
    }
  }
  return out;
};

// --- Taiwan: CWA (two S3 zip bundles of per-event XML; OriginTime carries +08:00) ---
const cwa: CustomAdapter = async (cfg) => {
  const out: RawObs[] = [];
  const seen = new Set<string>();
  // BOTH bundles: E-A0015 = significant/felt, E-A0016 = small-area minor (only place the
  // frequent small quakes appear). Each is ~16 per-event XML files.
  for (const file of ['E-A0015-001.zip', 'E-A0016-001.zip']) {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(await getBinary(`${cfg.base}${file}`, { timeoutMs: 20_000, retries: 2 }));
    } catch {
      continue;
    }
    for (const name of Object.keys(files)) {
      if (!/\.xml$/i.test(name)) continue;
      const xml = strFromU8(files[name]!);
      const tag = (n: string): string | null => {
        const m = new RegExp(`<(?:\\w+:)?${n}>([\\s\\S]*?)</(?:\\w+:)?${n}>`).exec(xml);
        return m ? m[1]!.trim() : null;
      };
      const t = parseUtcMs(tag('OriginTime')); // ISO with +08:00 → parseUtcMs converts to UTC
      const lat = num(tag('EpicenterLatitude'));
      const lon = num(tag('EpicenterLongitude'));
      // Stable id = the 16-digit event id in the Web URL. <EarthquakeNo> is a constant
      // placeholder (115000) for every E-A0016 report, so it can't be the id.
      const id = /\/details\/(\d+)/.exec(tag('Web') ?? '')?.[1] ?? tag('identifier') ?? '';
      if (t == null || lat == null || lon == null || !id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        provider: cfg.id, providerEventId: id, eventTimeMs: t, providerUpdatedMs: null, status: 'reviewed',
        lat, lon, depth: num(tag('FocalDepth')), mag: num(tag('MagnitudeValue')), magType: 'ML',
        place: tag('Location'), knownAliasIds: [],
        fields: flattenScalars({ identifier: tag('identifier'), magnitudeType: tag('MagnitudeType'), location: tag('Location'), reportContent: tag('ReportContent'), web: tag('Web') } as Record<string, unknown>),
      });
    }
  }
  return out.filter((o) => o.providerEventId);
};

// --- Austria: GeoSphere Austria (ex-ZAMG). A flat JSON array of the last ~14 days
//     WORLDWIDE; we keep only GeoSphere's own solutions (author === 'GeoSphere Austria')
//     — the re-served USGS/EMSC/INGV/GFZ rows already arrive from those sources direct.
//     `datetime_utc` is naive-UTC ISO (append 'Z'); reference_magnitude is [value, type]. ---
export function parseGeosphere(list: unknown, providerId: string): RawObs[] {
  const arr = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  const out: RawObs[] = [];
  for (const e of arr) {
    if (String(e['author'] ?? '') !== 'GeoSphere Austria') continue;
    const t = parseUtcMs(`${e['datetime_utc']}Z`);
    const lat = num(e['lat']);
    const lon = num(e['lon']);
    if (t == null || lat == null || lon == null) continue;
    const refMag = Array.isArray(e['reference_magnitude']) ? (e['reference_magnitude'] as unknown[]) : [];
    out.push({
      provider: providerId, providerEventId: String(e['event_id'] ?? ''), eventTimeMs: t,
      providerUpdatedMs: null, status: e['is_verified'] === true ? 'reviewed' : 'automatic',
      lat, lon, depth: num(e['depth']), mag: num(refMag[0]), magType: (refMag[1] as string) || null,
      place: (e['region'] as string) || (e['epicenter'] as string) || null, knownAliasIds: [], fields: flattenScalars(e),
    });
  }
  return out.filter((o) => o.providerEventId);
}

const geosphere: CustomAdapter = async (cfg) =>
  parseGeosphere(JSON.parse(await getText(cfg.base, { timeoutMs: 12_000, retries: 2 })), cfg.id);

// --- Turkey: KOERI / Kandilli quick determinations (lasteq.asp = English list, times
//     already in UTC, pure ASCII). Fixed-width text inside a single <pre>. No native
//     event id — synthesise one from the UTC origin second so re-issued rows fold as a
//     revision. `-.-` marks an absent magnitude; prefer Mw > ML > MD. ---
export function parseKoeri(html: string, providerId: string): RawObs[] {
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html)?.[1] ?? '';
  const out: RawObs[] = [];
  for (const l of pre.split('\n')) {
    if (!/^\d{4}\.\d{2}\.\d{2} /.test(l)) continue;
    const s = (a: number, b?: number): string => l.slice(a, b).trim();
    const lat = num(s(21, 28));
    const lon = num(s(31, 38));
    const t = parseUtcMs(`${s(0, 10).replace(/\./g, '-')}T${s(11, 19)}Z`);
    if (lat == null || lon == null || t == null) continue;
    const md = s(55, 58), ml = s(60, 63), mw = s(65, 68);
    let mag: number | null = null;
    let magType: string | null = null;
    for (const [v, ty] of [[mw, 'Mw'], [ml, 'ML'], [md, 'MD']] as const) {
      const n = num(v);
      if (n != null) { mag = n; magType = ty; break; }
    }
    const sol = s(121);
    out.push({
      provider: providerId, providerEventId: `koeri-${s(0, 10).replace(/\./g, '')}${s(11, 19).replace(/:/g, '')}`,
      eventTimeMs: t, providerUpdatedMs: null, status: /revise|reviz/i.test(sol) ? 'reviewed' : 'automatic',
      lat, lon, depth: num(s(44, 49)), mag, magType,
      place: s(71, 113) || null, knownAliasIds: [], fields: { region: s(71, 113), solution: sol, MD: md, ML: ml, Mw: mw },
    });
  }
  return out;
}

const koeri: CustomAdapter = async (cfg) =>
  parseKoeri(await getText(cfg.base, { timeoutMs: 12_000, retries: 2 }), cfg.id);

// --- Philippines: PHIVOLCS. Hand-authored HTML whose data rows link to per-event
//     bulletins; the bulletin FILENAME encodes the origin time in UTC (YYYY_MMDD_HHMM),
//     used for both the timestamp and the dedup id (trailing _B1/_B2F = a bulletin
//     revision of the same event). Cells: [PST datetime] [lat°N] [lon°E] [depth km]
//     [mag] [place]. magType lives only in the sub-bulletins, so it is left null. ---
export function parsePhivolcs(html: string, providerId: string): RawObs[] {
  const out: RawObs[] = [];
  const seen = new Set<string>();
  for (const row of html.split(/<tr[ >]/i)) {
    const href = /href="([^"]*_Earthquake_Information[^"]*?(\d{4})_(\d{4})_(\d{4})_[^"]*\.html)"/i.exec(row);
    if (!href) continue;
    const [, file, yyyy, mmdd, hhmm] = href;
    const id = `${yyyy}_${mmdd}_${hhmm}`; // UTC origin-minute; folds B1/B2 revisions
    if (seen.has(id)) continue;
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      htmlDecode(m[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
    );
    if (tds.length < 6) continue;
    const lat = num(tds[1]);
    const lon = num(tds[2]);
    const t = parseUtcMs(`${yyyy}-${mmdd!.slice(0, 2)}-${mmdd!.slice(2)}T${hhmm!.slice(0, 2)}:${hhmm!.slice(2)}:00Z`);
    if (lat == null || lon == null || t == null) continue;
    seen.add(id);
    out.push({
      provider: providerId, providerEventId: id, eventTimeMs: t, providerUpdatedMs: null, status: null,
      lat, lon, depth: num(tds[3]), mag: num(tds[4]), magType: null,
      place: tds[5] || null, knownAliasIds: [],
      fields: { datetime_local: tds[0]!, place: tds[5]!, bulletin: file!.split(/[\\/]/).pop() ?? '' },
    });
  }
  return out;
}

const phivolcs: CustomAdapter = async (cfg) =>
  // dost.gov.ph serves an incomplete TLS chain (UNABLE_TO_VERIFY_LEAF_SIGNATURE) — scoped insecure fetch.
  parsePhivolcs(await getText(cfg.base, { timeoutMs: 20_000, retries: 2, insecure: true }), cfg.id);

export const CUSTOM_ADAPTERS: Record<string, CustomAdapter> = { afad, cenc, tmd, kagsr, ncs, jma, mexico, ipma, igp, egypt, bgs, ign, imo, bmkg, inpres, ga, ovsicori, igepn, csn, cwa, geosphere, koeri, phivolcs };
