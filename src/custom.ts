import { request as httpsRequest } from 'node:https';
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
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const sc = res.statusCode ?? 0;
          sc >= 200 && sc < 300 ? resolve(data) : reject(new Error(`HTTP ${sc}`));
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
//     encodes "+lat+lon-depth(m)/") ---
const jma: CustomAdapter = async (cfg) => {
  const list = JSON.parse(await getText(cfg.base, { timeoutMs: 12_000, retries: 2 })) as Record<string, unknown>[];
  const out: RawObs[] = [];
  for (const e of Array.isArray(list) ? list : []) {
    const m = String(e['cod'] ?? '').match(/([+-][\d.]+)([+-][\d.]+)([+-]\d+)?/);
    if (!m) continue;
    const lat = num(m[1]);
    const lon = num(m[2]);
    const t = parseUtcMs((e['at'] as string) ?? (e['rdt'] as string));
    if (lat == null || lon == null || t == null) continue;
    const depthM = m[3] != null ? num(m[3]) : null;
    out.push({
      provider: cfg.id, providerEventId: String(e['eid'] ?? ''), eventTimeMs: t,
      providerUpdatedMs: parseUtcMs(e['rdt'] as string), status: null, lat, lon,
      depth: depthM != null ? Math.abs(depthM) / 1000 : null, mag: num(e['mag']), magType: 'Mj',
      place: (e['en_anm'] as string) || (e['anm'] as string) || null, knownAliasIds: [], fields: flattenScalars(e),
    });
  }
  return out.filter((o) => o.providerEventId);
};

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

export const CUSTOM_ADAPTERS: Record<string, CustomAdapter> = { afad, cenc, tmd, kagsr, ncs, jma, mexico, ipma, igp, egypt, bgs, ign, imo, bmkg, inpres, ga, ovsicori, igepn, csn };
