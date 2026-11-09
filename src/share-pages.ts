import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_MAP_HORIZON_DAYS, REPO } from './config.js';
import { canonicalOf, writeIfChanged } from './bitemporal.js';
import { inDetailWindow, liveSurvivor } from './event-detail.js';
import type { EventNode } from './types.js';

/**
 * Static share pages (share links, 2026-11; APIs.md, Share pages): `share/event/<feed id>.html` for every significant
 * live event of the detail window, plus the same page under each retired id whose live survivor has one, and
 * `share/event/404.html`, the generic page Cloudflare Pages answers (status 404) for every other path under
 * `share/event/`. The site `theshelter.app` maps `/event/:id` to `/share/event/:id` here with one static `_redirects`
 * rule, so a shared link gets a rich preview with no code running anywhere (no Worker or Function invocation).
 *
 * A page shows only what the feed holds for the id: never anything from a URL. Every value is HTML-escaped; there is no
 * script; the place is shown only in Latin script without control, format or bidi characters (else the coordinates);
 * the agency link is the chosen solution's own `url`, kept only when it parses as `https:` on an allow-listed host. The
 * bytes hold no run clock: a page changes only when its event does, so a deploy uploads only the pages that changed.
 * The headers (CSP with the stylesheet's hash, nosniff, no referrer, noindex) come from the `/share/*` rule of
 * `_headers` (pages-headers.ts), which is the only place a response header can be set for a static Pages file.
 */

export const SHARE_DIR = 'share/event';
/** The generic page's file name: Pages serves the nearest `404.html` for a path that matches no file. */
export const SHARE_NOT_FOUND = '404.html';
/**
 * At most this many share pages (live and retired ids together), the most significant events first. Cloudflare Pages'
 * free plan takes 20,000 files a deploy; the rest of the feed's deploy is ~1,400 files (2026-11-09), so the cap keeps
 * the deploy under 7,000 files whatever a busy month brings (validate.ts checks the room).
 */
export const SHARE_PAGE_CAP = 5_000;

export const SITE_ORIGIN = 'https://theshelter.app';
export const APP_STORE_ID = '6767608845';
export const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;
/** The site's static link-preview cards (built by the site, 1200 x 630): one per magnitude band and a generic one. */
export const OG_IMAGE_BASE = `${SITE_ORIGIN}/og/event`;
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
const SITE_NAME = 'Shelter';

/** The canonical, shareable URL of an event: the site path the app claims as a universal link. */
export const eventUrl = (feedId: string): string => `${SITE_ORIGIN}/event/${feedId}`;

/**
 * Agency event pages a share page may link, by exact host: only the hosts the feed's sources put in a solution's `url`
 * (2026-11-09: USGS alone carries one), each with its link text. A new host is added here deliberately.
 */
export const AGENCY_PAGE_HOSTS: ReadonlyMap<string, string> = new Map([['earthquake.usgs.gov', 'USGS event page']]);

/** The longest place text shown (code points); a longer one falls back to the coordinates. */
export const PLACE_MAX = 80;

/** PAGER alert levels (USGS); any other `alert` value (e.g. "pending") is not an alert. */
const PAGER_LEVELS = ['green', 'yellow', 'orange', 'red'] as const;

/**
 * The stylesheet, the page's only `<style>` element. Its sha256 is in the CSP (`style-src 'sha256-…'`), so it must
 * stay byte for byte what the pages embed, and no element may carry a `style` attribute. The site's look: black, the
 * app's dark card, the system font, readable from a 320 px phone up.
 */
export const PAGE_CSS = [
  ':root{color-scheme:dark;--bg:#000;--card:#1C1C1C;--fg:#F2F2F7;--muted:rgba(242,242,247,.64);--faint:rgba(242,242,247,.5)}',
  '*{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:break-word}',
  'a{color:inherit;text-underline-offset:2px}',
  '.wrap{max-width:40rem;margin:0 auto;padding-left:16px;padding-right:16px}',
  'header{padding-top:20px;padding-bottom:12px}',
  '.brand{display:inline-flex;align-items:center;gap:10px;font-weight:600;text-decoration:none}',
  '.brand img{display:block;border-radius:8px}',
  'main{padding-top:4px;padding-bottom:28px}',
  '.card{background:var(--card);border-radius:28px;padding:28px 20px 24px}',
  '.label{margin:0 0 14px;color:var(--muted);font-size:.9375rem;font-weight:600}',
  'h1{margin:0;font-size:2.25rem;line-height:1.1;letter-spacing:-.01em}',
  '.text{margin:12px 0 0;font-size:1.1875rem;line-height:1.42}',
  '.facts{margin:20px 0 0;display:grid;gap:10px}',
  '.facts div{display:flex;justify-content:space-between;gap:16px;border-top:1px solid rgba(242,242,247,.12);padding-top:10px}',
  '.facts dt{color:var(--muted)}',
  '.facts dd{margin:0;text-align:right}',
  '.open{margin:24px 0 0}',
  '.button{display:block;padding:14px 20px;border-radius:14px;background:var(--fg);color:#000;font-weight:600;text-align:center;text-decoration:none}',
  '.source{margin:18px 0 0;color:var(--faint);font-size:.875rem}',
  '.store{margin:28px 0 0;text-align:center}',
  '.store a{display:inline-block}',
  '.store img{display:block;width:144px;height:auto}',
  'footer{padding-top:4px;padding-bottom:32px;color:var(--faint);font-size:.875rem;text-align:center}',
  '@media (min-width:600px){.card{border-radius:40px;padding:40px 36px 32px}h1{font-size:2.75rem}.text{font-size:1.375rem}}',
].join('');

/** The CSP source of PAGE_CSS: `'sha256-<base64>'`. */
export const PAGE_CSS_HASH = `'sha256-${createHash('sha256').update(PAGE_CSS, 'utf8').digest('base64')}'`;

/** The share pages' Content-Security-Policy: nothing but the stylesheet and the site's images; no script. */
export const SHARE_CSP = `default-src 'none'; img-src ${SITE_ORIGIN}; style-src ${PAGE_CSS_HASH}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/** The share pages' response headers (the `/share/*` rule of `_headers`). Short-lived: a page changes with its event. */
export const SHARE_HEADERS: readonly (readonly [string, string])[] = [
  ['Cache-Control', 'public, max-age=300'],
  ['Content-Security-Policy', SHARE_CSP],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['X-Robots-Tag', 'noindex'],
];

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for HTML content and for a double- or single-quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** Control, format (U+200B–200F, U+202A–202E, U+2066–2069, U+FEFF, …), surrogate, private-use and unassigned code
 *  points, and line or paragraph separators: any one rejects the text. */
const REJECTED = /[\p{C}\p{Zl}\p{Zp}]/u;
const LATIN = /^[\p{Script=Latin}\p{M}]$/u;
/** Typographic marks a place name uses beside ASCII: degree, quotes, dashes, middle dot. */
const MARKS = new Set(['°', '‘', '’', '“', '”', '–', '—', '·']);
/** Letters of the Latin script, combining marks, printable ASCII and MARKS: nothing else is shown. */
const isShownChar = (c: string): boolean => (c >= ' ' && c <= '~') || MARKS.has(c) || LATIN.test(c);

/**
 * A place or name as a share page may show it: space separators collapsed to one space and trimmed, or null when the
 * text is empty, holds a control, format or bidi character, a character outside the Latin script, printable ASCII and
 * a few typographic marks, or more than `max` code points.
 */
export function latinText(text: string | null | undefined, max = PLACE_MAX): string | null {
  if (typeof text !== 'string' || REJECTED.test(text)) return null;
  const chars = Array.from(text.replace(/\p{Zs}+/gu, ' ').trim());
  if (!chars.length || chars.length > max || !chars.every(isShownChar)) return null;
  return chars.join('');
}

/** "near 10.9°S 165.6°E": one decimal, hemisphere letters. */
export function coordinateText(lat: number, lon: number): string {
  const one = (v: number): string => (Math.round(Math.abs(v) * 10) / 10).toFixed(1);
  return `near ${one(lat)}°${lat < 0 ? 'S' : 'N'} ${one(lon)}°${lon < 0 ? 'W' : 'E'}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "9 November 2026, 03:34 UTC" (no locale data, so the same bytes on every runner). */
export function utcText(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** The magnitude as shown, x 10 (one decimal): null without a finite magnitude. */
export const magE1 = (mag: number | null): number | null => (typeof mag === 'number' && Number.isFinite(mag) ? Math.round(mag * 10) : null);

/** The link-preview card of a shown magnitude: `lt3`, `3` … `6`, `7` (7 and above), or `generic` without one. */
export function magBand(e1: number | null): string {
  if (e1 == null) return 'generic';
  if (e1 < 30) return 'lt3';
  if (e1 >= 70) return '7';
  return String(Math.floor(e1 / 10));
}

export const ogImageUrl = (band: string): string => `${OG_IMAGE_BASE}/${band}.png`;

const depthText = (km: number): string => `${Math.round(km * 10) / 10} km`;

/** The agency page of the chosen solution: its own `url`, only `https:` on an allow-listed host (exact match). */
export function agencyPage(node: EventNode): { href: string; label: string } | null {
  const chosen = node.provenance.find((r) => r.chosen) ?? node.provenance[0];
  const raw = chosen?.fields['url'];
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const label = AGENCY_PAGE_HOSTS.get(url.hostname);
  if (url.protocol !== 'https:' || !label || url.username || url.password || url.port) return null;
  return { href: url.href, label };
}

/** What makes an event worth a share page (D4): M4.0+ as shown, a felt report, a tsunami flag or a PAGER alert. */
export interface Significance {
  e1: number | null;
  felt: number;
  tsunami: boolean;
  /** Index into green, yellow, orange, red; -1 without an alert. */
  alert: number;
}

export function significanceOf(node: EventNode): Significance {
  const { canon } = canonicalOf(node);
  const felt = typeof canon['felt'] === 'number' && Number.isFinite(canon['felt']) ? canon['felt'] : 0;
  const tsunami = Number(canon['tsunami'] ?? 0) > 0;
  const alert = typeof canon['alert'] === 'string' ? PAGER_LEVELS.indexOf(canon['alert'].toLowerCase() as (typeof PAGER_LEVELS)[number]) : -1;
  return { e1: magE1(node.mag), felt, tsunami, alert };
}

export const isSignificant = (s: Significance): boolean => (s.e1 != null && s.e1 >= 40) || s.felt >= 1 || s.tsunami || s.alert >= 0;

/** Most significant first: PAGER level, tsunami flag, magnitude, felt reports, then the newer event, then the id. */
function compareSignificance(a: { s: Significance; n: EventNode }, b: { s: Significance; n: EventNode }): number {
  return (
    b.s.alert - a.s.alert ||
    Number(b.s.tsunami) - Number(a.s.tsunami) ||
    (b.s.e1 ?? -100) - (a.s.e1 ?? -100) ||
    b.s.felt - a.s.felt ||
    b.n.eventTimeMs - a.n.eventTimeMs ||
    (a.n.feedId < b.n.feedId ? -1 : a.n.feedId > b.n.feedId ? 1 : 0)
  );
}

/** The share page of a live event: the bytes served under its own id and under every retired id it absorbed. */
export function sharePageHtml(node: EventNode, providerNames: ReadonlyMap<string, string> = new Map()): string {
  const { place: rawPlace } = canonicalOf(node);
  const e1 = magE1(node.mag);
  const magText = e1 == null ? null : `M ${(e1 / 10).toFixed(1)}`;
  const place = latinText(rawPlace) ?? coordinateText(node.lat, node.lon);
  const when = utcText(node.eventTimeMs);
  const agencies = new Set(node.provenance.map((r) => r.provider)).size;
  const url = eventUrl(node.feedId);
  const image = ogImageUrl(magBand(e1));
  const title = `${magText ?? 'Earthquake'} · ${place}`;
  const depth = node.depth != null && Number.isFinite(node.depth) ? depthText(node.depth) : null;
  const sentence = `${[magText ? `Magnitude ${(e1! / 10).toFixed(1)} earthquake` : 'Earthquake', place, when, ...(depth ? [`depth ${depth}`] : [])].join(' · ')}. Open it in Shelter.`;
  const imageAlt = magText ? `Magnitude ${(e1! / 10).toFixed(1)} earthquake` : 'An earthquake';
  const agency = agencyPage(node);
  const chosenName = latinText(providerNames.get(node.chosenProvider), 120) ?? node.chosenProvider.toUpperCase();
  const others = agencies - 1;
  const facts: [string, string][] = [
    ['Time', when],
    ...(depth ? ([['Depth', depth]] as [string, string][]) : []),
    ['Reported by', `${agencies} ${agencies === 1 ? 'agency' : 'agencies'}`],
  ];
  const e = escapeHtml;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} · ${SITE_NAME}</title>
<meta name="description" content="${e(sentence)}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${e(url)}">
<meta name="theme-color" content="#000000">
<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}, app-argument=${e(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="${e(url)}">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(sentence)}">
<meta property="og:image" content="${e(image)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">
<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">
<meta property="og:image:alt" content="${e(imageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(sentence)}">
<meta name="twitter:image" content="${e(image)}">
<meta name="twitter:image:alt" content="${e(imageAlt)}">
<style>${PAGE_CSS}</style>
</head>
<body>
${BRAND_HEADER}
<main class="wrap">
<article class="card">
<p class="label">Earthquake</p>
<h1>${e(magText ?? 'Earthquake')}</h1>
<p class="text">${e(place)}</p>
<dl class="facts">
${facts.map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join('\n')}
</dl>
<p class="open"><a class="button" href="${e(url)}">Open in Shelter</a></p>
${agency ? `<p class="source"><a href="${e(agency.href)}" rel="noopener noreferrer">${e(agency.label)}</a></p>\n` : ''}<p class="source">Data: ${e(chosenName)}${others > 0 ? ` and ${others} other ${others === 1 ? 'agency' : 'agencies'}` : ''}, compiled by <a href="https://github.com/${REPO}/blob/main/ATTRIBUTIONS.md" rel="noopener noreferrer">earthquakes-feed</a>.</p>
</article>
${STORE_BADGE}
</main>
${LEGAL_FOOTER}
</body>
</html>
`;
}

const BRAND_HEADER = `<header class="wrap"><a class="brand" href="${SITE_ORIGIN}/"><img src="${SITE_ORIGIN}/images/icon.png" alt="" width="28" height="28">${SITE_NAME}</a></header>`;
const STORE_BADGE = `<p class="store"><a href="${APP_STORE_URL}"><img src="${SITE_ORIGIN}/images/app-store-badge.png" alt="Download on the App Store" width="144" height="50"></a></p>`;
const LEGAL_FOOTER = `<footer class="wrap"><a href="${SITE_ORIGIN}/privacy">Privacy</a> · <a href="${SITE_ORIGIN}/support">Support</a> · <a href="${SITE_ORIGIN}/terms">Terms</a></footer>`;

/**
 * `share/event/404.html`: what every id without a page gets (an older or smaller event, a mistyped or crafted id). It
 * says nothing about the id: no date, no id, nothing a crafted link could put on a preview. Served at any id, so every
 * link is absolute.
 */
export function notFoundPageHtml(): string {
  const title = `An earthquake on ${SITE_NAME}`;
  const description = 'Follow earthquakes around the world and near you in Shelter.';
  const image = ogImageUrl('generic');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#000000">
<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${image}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">
<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">
<meta property="og:image:alt" content="${title}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
<meta name="twitter:image:alt" content="${title}">
<style>${PAGE_CSS}</style>
</head>
<body>
${BRAND_HEADER}
<main class="wrap">
<article class="card">
<p class="label">Earthquake</p>
<h1>${title}</h1>
<p class="text">This link has no page here. Pages cover the last ${EVENT_MAP_HORIZON_DAYS} days: earthquakes of magnitude 4 and above, felt earthquakes and those with a tsunami flag or an impact alert. Shelter shows the latest earthquakes around the world.</p>
<p class="open"><a class="button" href="${SITE_ORIGIN}/">Get Shelter</a></p>
</article>
${STORE_BADGE}
</main>
${LEGAL_FOOTER}
</body>
</html>
`;
}

/** One share page: the id it is served under and the live event it shows. */
export interface SharePage {
  id: string;
  event: EventNode;
}

/**
 * Which pages a run writes: the significant live events of `window`, most significant first, each followed by the
 * retired ids whose live survivor it is, until SHARE_PAGE_CAP (an event goes in with all its retired ids or not at all).
 */
export function planSharePages(
  nodes: Iterable<EventNode>,
  window: { startMs: number; endMs: number },
  cap = SHARE_PAGE_CAP,
): { pages: SharePage[]; live: number; retired: number; capped: number } {
  const all = [...nodes];
  const byId = new Map(all.map((n) => [n.feedId, n]));
  const ranked: { s: Significance; n: EventNode }[] = [];
  for (const n of all) {
    if (!inDetailWindow(n, window)) continue;
    const s = significanceOf(n);
    if (isSignificant(s)) ranked.push({ s, n });
  }
  ranked.sort(compareSignificance);
  const absorbed = new Map<string, string[]>();
  for (const n of all) {
    if (n.state !== 'superseded') continue;
    const s = liveSurvivor(n, byId);
    if (s) (absorbed.get(s.feedId) ?? absorbed.set(s.feedId, []).get(s.feedId)!).push(n.feedId);
  }
  const pages: SharePage[] = [];
  let live = 0;
  let retired = 0;
  let capped = 0;
  for (const { n } of ranked) {
    const ids = (absorbed.get(n.feedId) ?? []).sort();
    if (pages.length + 1 + ids.length > cap) {
      capped += 1 + ids.length;
      continue;
    }
    pages.push({ id: n.feedId, event: n });
    live++;
    for (const id of ids) pages.push({ id, event: n });
    retired += ids.length;
  }
  return { pages, live, retired, capped };
}

export interface ShareWrite {
  /** Pages written (live + retired), the 404 page not counted. */
  pages: number;
  live: number;
  retired: number;
  /** Significant events (with their retired ids) left out by the cap. */
  capped: number;
  /** Bytes of every page and the 404 page; the largest page. */
  bytes: number;
  maxBytes: number;
  /** Page files of an earlier local run removed (CI starts from an empty public/). */
  removed: number;
  ms: number;
}

/** Writes the run's share pages under `<publicDir>/share/event/` and removes any other file there. */
export function writeSharePages(
  nodes: Iterable<EventNode>,
  opts: { publicDir: string; window: { startMs: number; endMs: number }; providerNames?: ReadonlyMap<string, string>; cap?: number },
): ShareWrite {
  const started = performance.now();
  const dir = join(opts.publicDir, SHARE_DIR);
  const plan = planSharePages(nodes, opts.window, opts.cap);
  const written = new Set<string>();
  const html = new Map<string, string>();
  let bytes = 0;
  let maxBytes = 0;
  const put = (name: string, body: string): void => {
    writeIfChanged(join(dir, name), body);
    written.add(name);
    const b = Buffer.byteLength(body);
    bytes += b;
    if (name !== SHARE_NOT_FOUND) maxBytes = Math.max(maxBytes, b);
  };
  for (const p of plan.pages) {
    let body = html.get(p.event.feedId);
    if (body == null) html.set(p.event.feedId, (body = sharePageHtml(p.event, opts.providerNames)));
    put(`${p.id}.html`, body);
  }
  put(SHARE_NOT_FOUND, notFoundPageHtml());
  let removed = 0;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (written.has(f)) continue;
      rmSync(join(dir, f), { recursive: true, force: true });
      removed++;
    }
  }
  return { pages: plan.pages.length, live: plan.live, retired: plan.retired, capped: plan.capped, bytes, maxBytes, removed, ms: performance.now() - started };
}

/**
 * derive's share-page step: the pages are an extra for link previews and must never stop the live feed, so a throw
 * removes `<publicDir>/share/` (every shared link then gets the site's fallback until the next run), prints
 * `::warning::share pages dropped: <reason>` and returns null.
 */
export function deriveSharePages(
  nodes: Iterable<EventNode>,
  opts: { publicDir: string; window: { startMs: number; endMs: number } | null; providerNames?: ReadonlyMap<string, string>; warn?: (m: string) => void; write?: typeof writeSharePages },
): ShareWrite | null {
  const warn = opts.warn ?? ((m: string) => console.warn(`::warning::${m}`));
  if (!opts.window) return null;
  try {
    return (opts.write ?? writeSharePages)(nodes, { publicDir: opts.publicDir, window: opts.window, ...(opts.providerNames ? { providerNames: opts.providerNames } : {}) });
  } catch (err) {
    let reason = err instanceof Error ? err.message : String(err);
    try {
      rmSync(join(opts.publicDir, 'share'), { recursive: true, force: true });
    } catch (rmErr) {
      reason += ` (and removing share/ failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)})`;
    }
    warn(`share pages dropped: ${reason}`);
    return null;
  }
}
