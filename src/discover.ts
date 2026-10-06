import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
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

/** Event services a human reviewed and decided not to add (APIs.md, *Sources looked at and not added*): never probed and
 *  never listed as a candidate again, so a monthly run does not reopen the decision; the report names them in one
 *  line. Remove an entry to have the host probed again. */
export const DECLINED: { host: string; dc: string; issue: number; why: string }[] = [
  {
    host: 'api.geoshake.org',
    dc: 'GeoShake Data Center',
    issue: 38,
    why: 'a community MEMS network: 4 events in its whole catalogue (2026-09-18 → 10-03, Puerto Rico), each a quake the feed already had or a mislocated one; its "magnitude" is an intensity (MMI), not a magnitude, and its site terms forbid automated access without consent (round 20)',
  },
];

/** Labels of a host name that name a service, not its operator (`api.geoshake.org` → `geoshake`). */
const GENERIC_HOST_LABELS = new Set(['api', 'www', 'ws', 'service', 'services', 'webservices', 'fdsnws', 'data']);

/** The registry id a candidate's entry suggests: the host's first label that is not a generic service label. */
export function candidateId(host: string): string {
  const labels = host.toLowerCase().split('.');
  const label = labels.slice(0, -1).find((l) => !GENERIC_HOST_LABELS.has(l)) ?? labels[0] ?? '';
  return label.replace(/[^a-z0-9]/g, '') || 'src';
}

/** The registry entry the report suggests for a candidate. The probe reads no licence: `license` is "unknown" until a
 *  human reads the source's terms (the entry is never added automatically). */
export function suggestedEntry(c: { dc: string; url: string; fmt: 'text' | 'geojson' }): Record<string, unknown> {
  return {
    id: candidateId(hostOf(c.url)),
    name: c.dc,
    priority: 25,
    active: false,
    adapter: 'fdsn',
    parse: c.fmt,
    queryFormat: c.fmt === 'geojson' ? 'geojson' : 'text',
    base: c.url,
    supportsTimeRange: true,
    refreshSeconds: 600,
    license: 'unknown',
    attribution: c.dc,
    doi: null,
    contact: '',
  };
}

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
  // A source's fallback host (NOA's registered node, PF-5j-NOA) is known too: when it answers again it is not a new source.
  const known = new Set(registry.providers.flatMap((p) => [p.base, ...(p.fallbackBase ? [p.fallbackBase] : [])]).map(hostOf));
  // A declined host is skipped like a known one, and named in the report.
  const declined = new Set(DECLINED.map((d) => d.host));
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
            if (!known.has(host) && !declined.has(host) && !cand.has(host)) cand.set(host, { dc: dc.fullName || dc.name || host, url });
          }
      registryOk = true;
    } catch {
      /* fall through to curated */
    }
  }

  // 2) Curated leads (re-probe the known-down endpoints).
  for (const c of CURATED) {
    const h = hostOf(c.url);
    if (!known.has(h) && !declined.has(h) && !cand.has(h)) cand.set(h, c);
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
  L.push(`Reviewed and not added, not probed (\`DECLINED\` in src/discover.ts): ${DECLINED.map((d) => `${d.dc} (${d.host}, #${d.issue})`).join(', ')}.`);
  L.push('');
  if (!live.length) {
    L.push('**No new working FDSN event endpoints found** — all registered datacenters are already covered and the curated leads are still down.');
  } else {
    L.push(`**${live.length} candidate source(s) returned events.** Review each (format / timezone / license / terms / reliability / whether its events are its own solutions or copies), then add to \`providers/registry.json\` and flip \`active:true\`, or add it to \`DECLINED\` with the issue that holds the evidence. The suggested entry's \`license\` is \`unknown\`: the probe reads none.`);
    L.push('');
    for (const c of live) {
      L.push(`### ${c.dc} — probe returned ${c.n} event(s) as \`${c.fmt}\``);
      L.push('```json');
      L.push(JSON.stringify(suggestedEntry(c), null, 2));
      L.push('```');
      L.push('');
    }
  }
  L.push('---');
  L.push('_Generated by `discover.yml` (monthly). Non-FDSN national feeds (e.g. Indonesia BMKG, Chile CSN) need bespoke adapters and are not auto-suggested here._');

  writeFileSync(process.env.REPORT_FILE ?? 'discovery-report.md', L.join('\n') + '\n');
  console.log(`candidates=${live.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('discover failed:', e);
    console.log('candidates=0');
    process.exit(0);
  });
}
