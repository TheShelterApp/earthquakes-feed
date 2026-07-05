import { readFileSync, writeFileSync } from 'node:fs';
import { REGISTRY_PATH } from './config.js';
import type { ProviderConfig } from './types.js';

/**
 * Source discovery-assist (monthly): scans the FDSN datacenter registry for newly-registered
 * event services + re-probes a curated list of known-but-not-yet-added FDSN endpoints (dead /
 * blocked / moved when last checked — they sometimes revive), and writes a Markdown report of
 * any that now return events. It NEVER auto-adds a source — discovery only. A human vets each
 * (format quirks, timezone, license, reliability) and flips `active:true` in the registry.
 */
const FDSN_REGISTRY = 'https://www.fdsn.org/ws/datacenters/1/query';
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 20_000);
const startISO = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 19);

/** Known FDSN event endpoints outside the datacenter registry — down when last checked; kept
 *  here so a monthly re-probe surfaces them if they come back. Add new leads to this list. */
const CURATED: { dc: string; url: string }[] = [
  { dc: 'IGN (Spain)', url: 'http://fdsnws.sismologia.ign.es/fdsnws/event/1/query' },
  { dc: 'BGR (Germany)', url: 'http://eida.bgr.de/fdsnws/event/1/query' },
  { dc: 'University of Bergen (Norway)', url: 'http://eida.geo.uib.no/fdsnws/event/1/query' },
  { dc: 'KOERI (Turkey)', url: 'http://eida.koeri.boun.edu.tr/fdsnws/event/1/query' },
  { dc: 'NORSAR (Norway)', url: 'https://www.norsardata.no/fdsnws/event/1/query' },
  { dc: 'GeoSphere / ZAMG (Austria)', url: 'https://geoweb.zamg.ac.at/fdsnws/event/1/query' },
  { dc: 'SGC (Colombia)', url: 'https://sismo.sgc.gov.co/sgcsismo/fdsnws/event/1/query' },
  { dc: 'Geoscience Australia', url: 'https://earthquakes.ga.gov.au/fdsnws/event/1/query' },
  { dc: 'NIEP (Romania)', url: 'http://eida-sc3.infp.ro/fdsnws/event/1/query' },
  { dc: 'ICGC (Catalonia)', url: 'https://ws.icgc.cat/fdsnws/event/1/query' },
  { dc: 'Raspberry Shake', url: 'https://fdsnws.raspberryshakedata.com/fdsnws/event/1/query' },
];

const hostOf = (u: string): string => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
};

async function get(url: string): Promise<{ status: number; body: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'earthquakes-feed-discovery/1.0 (+https://earthquakes-feed.theshelter.app)' } });
    return { status: r.status, body: await r.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Live {
  dc: string;
  url: string;
  fmt: 'text' | 'geojson';
  n: number;
}

async function main(): Promise<void> {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as { providers: ProviderConfig[] };
  const known = new Set(registry.providers.map((p) => hostOf(p.base)));
  const cand = new Map<string, { dc: string; url: string }>();

  // 1) Newly-registered FDSN event services (the rare, high-value case).
  const reg = await get(FDSN_REGISTRY);
  let registryOk = false;
  if (reg && reg.status < 400) {
    try {
      const dcs = (JSON.parse(reg.body) as { datacenters?: { name?: string; fullName?: string; repositories?: { services?: { name?: string; url?: string }[] }[] }[] }).datacenters ?? [];
      for (const dc of dcs)
        for (const rp of dc.repositories ?? [])
          for (const s of rp.services ?? []) {
            if (!/^fdsnws-event/.test(s.name ?? '') || !s.url) continue;
            const url = s.url.replace(/\/+$/, '') + '/query';
            const host = hostOf(url);
            if (!known.has(host) && !cand.has(host)) cand.set(host, { dc: dc.fullName || dc.name || host, url });
          }
      registryOk = true;
    } catch {
      /* fall through to curated */
    }
  }

  // 2) Curated leads (re-probe the known-down endpoints).
  for (const c of CURATED) {
    const h = hostOf(c.url);
    if (!known.has(h) && !cand.has(h)) cand.set(h, c);
  }

  // 3) Probe each; keep endpoints returning events in a format the generic adapter can parse
  //    (text or geojson — QuakeML-only nodes aren't usable without a new parser).
  const live = (
    await Promise.all(
      [...cand.values()].map(async ({ dc, url }): Promise<Live | null> => {
        for (const fmt of ['text', 'geojson'] as const) {
          const r = await get(`${url}?format=${fmt}&limit=3&starttime=${startISO}&minmagnitude=2.5`);
          if (!r || r.status >= 400) continue;
          const b = r.body.trim();
          let n = 0;
          if (b.startsWith('{')) {
            try {
              n = ((JSON.parse(b) as { features?: unknown[] }).features ?? []).length;
            } catch {
              continue;
            }
          } else if (b.startsWith('<')) {
            continue; // QuakeML-only — not parseable by the generic FDSN adapter
          } else {
            n = b.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
          }
          if (n > 0) return { dc, url, fmt, n };
        }
        return null;
      }),
    )
  ).filter((x): x is Live => x != null);
  live.sort((a, b) => b.n - a.n);

  const L: string[] = [];
  L.push(`Scanned the [FDSN datacenter registry](${FDSN_REGISTRY})${registryOk ? '' : ' _(fetch failed — curated leads only)_'} + ${CURATED.length} curated leads against \`providers/registry.json\` (${known.size} known hosts, ${cand.size} probed).`);
  L.push('');
  if (!live.length) {
    L.push('**No new working FDSN event endpoints found** — all registered datacenters are already covered and the curated leads are still down.');
  } else {
    L.push(`**${live.length} candidate source(s) returned events.** Review each (format / timezone / license / reliability), then add to \`providers/registry.json\` and flip \`active:true\`:`);
    L.push('');
    for (const c of live) {
      const id = hostOf(c.url).split('.')[0]!.replace(/[^a-z0-9]/g, '') || 'src';
      L.push(`### ${c.dc} — probe returned ${c.n} event(s) as \`${c.fmt}\``);
      L.push('```json');
      L.push(
        JSON.stringify(
          { id, name: c.dc, priority: 25, active: false, adapter: 'fdsn', parse: c.fmt, queryFormat: c.fmt === 'geojson' ? 'geojson' : 'text', base: c.url, supportsTimeRange: true, refreshSeconds: 600, license: 'CC-BY-4.0', attribution: c.dc, doi: null, contact: '' },
          null,
          2,
        ),
      );
      L.push('```');
      L.push('');
    }
  }
  L.push('---');
  L.push('_Generated by `discover.yml` (monthly). Non-FDSN national feeds (e.g. Indonesia BMKG, Chile CSN) need bespoke adapters and are not auto-suggested here._');

  writeFileSync(process.env.REPORT_FILE ?? 'discovery-report.md', L.join('\n') + '\n');
  console.log(`candidates=${live.length}`);
}

main().catch((e) => {
  console.error('discover failed:', e);
  console.log('candidates=0');
  process.exit(0);
});
