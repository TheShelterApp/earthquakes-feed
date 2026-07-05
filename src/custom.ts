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

// --- Peru: IGP (year in the path; fecha_utc has the date, hora_utc the time-of-day) ---
const igp: CustomAdapter = async (cfg, nowMs) => {
  const year = new Date(nowMs).getUTCFullYear();
  const list = JSON.parse(await getText(`${cfg.base}${year}`, { timeoutMs: 12_000, retries: 2 })) as Record<string, unknown>[];
  const out: RawObs[] = [];
  for (const e of Array.isArray(list) ? list : []) {
    const lat = num(e['latitud']);
    const lon = num(e['longitud']);
    const dstr = String(e['fecha_utc'] ?? '').slice(0, 10);
    const tstr = String(e['hora_utc'] ?? '').slice(11, 19);
    const t = dstr ? parseUtcMs(`${dstr}T${tstr || '00:00:00'}Z`) : null;
    if (lat == null || lon == null || t == null) continue;
    out.push({
      provider: cfg.id, providerEventId: String(e['codigo'] ?? ''), eventTimeMs: t,
      providerUpdatedMs: parseUtcMs(e['updatedAt'] as string), status: null, lat, lon, depth: num(e['profundidad']),
      mag: num(e['magnitud']), magType: (e['tipomagnitud'] as string) || null, place: (e['referencia'] as string) || null,
      knownAliasIds: [], fields: flattenScalars(e),
    });
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

export const CUSTOM_ADAPTERS: Record<string, CustomAdapter> = { afad, cenc, tmd, kagsr, ncs, jma, mexico, ipma, igp, egypt, bgs };
