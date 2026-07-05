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

export const CUSTOM_ADAPTERS: Record<string, CustomAdapter> = { afad, cenc, tmd, kagsr, ncs };
