import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pagesHeaders } from '../src/pages-headers.js';
import {
  AGENCY_PAGE_HOSTS,
  PAGE_CSS,
  PAGE_CSS_HASH,
  SHARE_CSP,
  SHARE_DIR,
  SHARE_HEADERS,
  SHARE_NOT_FOUND,
  agencyPage,
  coordinateText,
  deriveSharePages,
  eventUrl,
  isSignificant,
  latinText,
  magBand,
  magE1,
  notFoundPageHtml,
  planSharePages,
  sharePageHtml,
  sharePageProblem,
  significanceOf,
  utcText,
  writeSharePages,
} from '../src/share-pages.js';
import type { EventNode, Extra, ProvenanceRow } from '../src/types.js';
import { deterministicFeedId, feedIdTimeMs } from '../src/ulid.js';

// Share links (2026-11, APIs.md Share pages): static pages for significant events, served by the feed's own Pages
// project, previewed by messengers. Nothing on a page may come from a URL, and nothing on the generic page from the id.

const NOW = Date.parse('2026-11-09T04:47:00Z');
const WINDOW = { startMs: Date.parse('2026-09-25T00:00:00Z'), endMs: NOW + 10 * 60_000 };

function row(provider: string, over: Partial<ProvenanceRow> = {}, fields: Extra = {}): ProvenanceRow {
  return {
    provider,
    nativeId: `${provider}1`,
    eventTimeMs: Date.parse('2026-11-09T03:34:59Z'),
    mag: 6.4,
    magType: 'mww',
    status: 'reviewed',
    providerUpdatedMs: null,
    lat: -10.9,
    lon: 165.6,
    depth: 17,
    place: null,
    chosen: false,
    license: 'US-PD',
    attribution: provider,
    doi: null,
    fields,
    ...over,
  };
}

let seq = 0;
function node(over: Partial<EventNode> & { fields?: Extra; providers?: string[] } = {}): EventNode {
  const t = over.eventTimeMs ?? Date.parse('2026-11-09T03:34:59.466Z');
  const lat = over.lat ?? -10.9 + seq * 0.1;
  const lon = over.lon ?? 165.6;
  seq++;
  const providers = over.providers ?? ['usgs', 'emsc'];
  const chosen = over.chosenProvider ?? providers[0]!;
  const { fields, providers: _p, ...rest } = over;
  return {
    feedId: deterministicFeedId(t, lat, lon),
    aliases: [],
    eventTimeMs: t,
    firstIngestTime: '2026-11-09T03:40:00.000Z',
    lastIngestTime: '2026-11-09T04:00:00.000Z',
    lat,
    lon,
    depth: 17,
    mag: 6.4,
    magType: 'mww',
    status: 'reviewed',
    place: '30 km WSW of Lata, Solomon Islands',
    chosenProvider: chosen,
    provenance: providers.map((p) => row(p, { chosen: p === chosen }, p === chosen ? (fields ?? {}) : {})),
    revision: 1,
    firstSeenSeq: 1,
    lastSeq: 2,
    state: 'live',
    geohash: 'x',
    ...rest,
  };
}

test('feedIdTimeMs: the 30 s bucket a feed id was minted at; null for anything else', () => {
  const t = Date.parse('2026-11-09T03:34:59.466Z');
  const id = deterministicFeedId(t, -10.9, 165.6);
  assert.equal(feedIdTimeMs(id), Date.parse('2026-11-09T03:35:00Z'), 'rounded to the bucket: here into the next minute');
  assert.equal(feedIdTimeMs('efd_01K1C81T70DYRK4ZYBSG4CQB3A'), Date.parse('2025-07-29T23:25:00Z'), 'the Kamchatka M8.8');
  assert.equal(feedIdTimeMs('efd_00QFMWG6YGF9PP681T409R5QC3'), Date.parse('1995-07-30T05:11:30Z'), 'a 1995 history id');
  for (const bad of ['', 'efd_', 'efd_01M6Z5Z7N0YS0YZKJ7H5HDQMV', 'efd_01M6Z5Z7N0YS0YZKJ7H5HDQMVEX', 'efd_01M6Z5Z7N0YS0YZKJ7H5HDQMVI', 'usgs:us7000tx16', 'efd_01m6z5z7n0ys0yzkj7h5hdqmve']) {
    assert.equal(feedIdTimeMs(bad), null, bad);
  }
});

test('latinText: Latin script, ASCII and a few marks only; control, format and bidi characters reject the text', () => {
  assert.equal(latinText('30 km WSW of Lata, Solomon Islands'), '30 km WSW of Lata, Solomon Islands');
  assert.equal(latinText('Norðurland'), 'Norðurland');
  assert.equal(latinText('020 km S 90° E of Malapatan (Sarangani)'), '020 km S 90° E of Malapatan (Sarangani)');
  assert.equal(latinText('  N  Bragança\u00A0 '), 'N Bragança', 'space separators collapse');
  for (const bad of [
    'Lata\u200B',
    '\u202Eatal',
    'Lata\u2066x\u2069',
    'a\u200Fb',
    'Lata\u0007',
    'Lata\nSolomon',
    'Lata\u2028',
    '\uFEFFLata',
    '\u041A\u0430\u043C\u0447\u0430\u0442\u043A\u0430',
    '\u5317\u4EAC',
    '',
    '   ',
    null,
    undefined,
  ]) {
    assert.equal(latinText(bad), null, JSON.stringify(bad));
  }
  assert.equal(latinText('x'.repeat(80)), 'x'.repeat(80));
  assert.equal(latinText('x'.repeat(81)), null, 'over the length cap');
});

test('latinText: NFC, combining diacritical marks only on a letter and at most two, no fullwidth forms', () => {
  assert.equal(latinText('Bragan\u0063\u0327a'), 'Bragan\u00E7a', 'NFC composes c + cedilla');
  assert.equal(latinText('Ha\u0323\u0302 Long'), 'H\u1EAD Long', 'two marks compose into one letter');
  assert.equal(latinText('q\u0307\u0323'), 'q\u0323\u0307', 'two marks a letter keeps, in canonical order');
  for (const bad of [
    'Lata\u0489',
    'L\u0430ta\u0301',
    'q\u0300\u0301\u0302',
    'a' + '\u0300'.repeat(8),
    '\u0301Lata',
    'Lata \u0301',
    '90\u0301 km',
    '\uFF2C\uFF41\uFF54\uFF41',
    'Lata\uFF0C Solomon',
  ]) {
    assert.equal(latinText(bad), null, JSON.stringify(bad));
  }
});

test('coordinates, UTC time, magnitude bands', () => {
  assert.equal(coordinateText(-10.94, 165.56), 'near 10.9°S 165.6°E');
  assert.equal(coordinateText(51.6, -159.85), 'near 51.6°N 159.9°W');
  assert.equal(coordinateText(0, 0), 'near 0.0°N 0.0°E');
  assert.equal(coordinateText(-0.04, -0.04), 'near 0.0°N 0.0°E', 'the hemisphere of the rounded value');
  assert.equal(coordinateText(-0.05, -0.05), 'near 0.1°S 0.1°W');
  assert.equal(coordinateText(-0, 179.96), 'near 0.0°N 180.0°E');
  assert.equal(utcText(Date.parse('2026-11-09T03:34:59.466Z')), '9 November 2026, 03:34 UTC');
  assert.equal(utcText(Date.parse('2025-01-01T00:00:00Z')), '1 January 2025, 00:00 UTC');
  assert.equal(magE1(3.96), 40);
  assert.equal(magE1(null), null);
  assert.equal(magE1(Number.NaN), null);
  assert.deepEqual([null, 2.94, 2.95, 3.0, 4.94, 5.0, 6.99, 6.95, 7.0, 9.1].map((m) => magBand(magE1(m))), ['generic', 'lt3', '3', '3', '4', '5', '7', '7', '7', '7']);
});

test('agencyPage: the chosen solution\'s own url, https on an allow-listed host only', () => {
  const page = (url: unknown): ReturnType<typeof agencyPage> => agencyPage(node({ fields: { url: url as string } }));
  assert.deepEqual(page('https://earthquake.usgs.gov/earthquakes/eventpage/us7000tx16'), { href: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tx16', label: AGENCY_PAGE_HOSTS.get('earthquake.usgs.gov') });
  for (const bad of [
    'http://earthquake.usgs.gov/earthquakes/eventpage/us7000tx16',
    'https://earthquake.usgs.gov@evil.example/x',
    'https://evil.example/?earthquake.usgs.gov',
    'https://earthquake.usgs.gov.evil.example/x',
    'https://user:pw@earthquake.usgs.gov/x',
    'https://earthquake.usgs.gov:8443/x',
    'javascript:alert(1)',
    'not a url',
    42,
  ]) {
    assert.equal(page(bad), null, String(bad));
  }
  // Another provider's url is not the chosen agency's page.
  const n = node({ providers: ['emsc', 'usgs'] });
  n.provenance[1]!.fields = { url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us1' };
  assert.equal(agencyPage(n), null);
});

test('significance: M4.0+ as shown, a felt report, a tsunami flag or a PAGER alert', () => {
  assert.ok(isSignificant(significanceOf(node({ mag: 3.96 }))), '3.96 shows as M 4.0');
  assert.ok(!isSignificant(significanceOf(node({ mag: 3.94 }))));
  assert.ok(!isSignificant(significanceOf(node({ mag: null }))));
  assert.ok(isSignificant(significanceOf(node({ mag: 2.1, fields: { felt: 1 } }))));
  assert.ok(!isSignificant(significanceOf(node({ mag: 2.1, fields: { felt: 0 } }))));
  assert.ok(isSignificant(significanceOf(node({ mag: 3.1, fields: { tsunami: 1 } }))));
  assert.ok(isSignificant(significanceOf(node({ mag: 3.1, fields: { alert: 'green' } }))));
  assert.ok(!isSignificant(significanceOf(node({ mag: 3.1, fields: { alert: 'pending' } }))), 'not a PAGER level');
});

test('the page: the feed\'s values only, escaped, the canonical site URL everywhere, no script, the hashed stylesheet', () => {
  const n = node({ fields: { url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tx16' } });
  const html = sharePageHtml(n, new Map([['usgs', 'USGS (ANSS ComCat)']]));
  const url = eventUrl(n.feedId);
  assert.equal(url, `https://theshelter.app/event/${n.feedId}`);
  assert.ok(html.includes(`<link rel="canonical" href="${url}">`));
  assert.ok(html.includes(`<meta property="og:url" content="${url}">`));
  assert.ok(html.includes(`<meta name="apple-itunes-app" content="app-id=6767608845, app-argument=${url}">`));
  assert.ok(html.includes(`<a class="button" href="${url}">Open in Shelter</a>`));
  assert.ok(html.includes('<meta property="og:image" content="https://theshelter.app/og/event/6.png">'));
  assert.ok(html.includes('<meta property="og:title" content="M 6.4 · 30 km WSW of Lata, Solomon Islands">'));
  assert.ok(html.includes('<dd>9 November 2026, 03:34 UTC</dd>') && html.includes('<dd>17 km</dd>') && html.includes('<dd>2 agencies</dd>'));
  assert.ok(html.includes('<a href="https://earthquake.usgs.gov/earthquakes/eventpage/us7000tx16" rel="noopener noreferrer">USGS event page</a>'));
  assert.ok(html.includes('Data: USGS (ANSS ComCat) and 1 other agency'));
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
  assert.ok(!/<script/i.test(html) && !/\sstyle=/i.test(html));
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  assert.deepEqual(styles, [PAGE_CSS]);
  assert.equal(PAGE_CSS_HASH, `'sha256-${createHash('sha256').update(styles[0]!).digest('base64')}'`);
  assert.ok(SHARE_CSP.includes(`style-src ${PAGE_CSS_HASH}`) && SHARE_CSP.includes("default-src 'none'") && SHARE_CSP.includes('img-src https://theshelter.app;'));
  for (const src of html.matchAll(/<img src="([^"]+)"/g)) assert.ok(src[1]!.startsWith('https://theshelter.app/'), `${src[1]} is allowed by img-src`);
  assert.equal(sharePageHtml(n, new Map([['usgs', 'USGS (ANSS ComCat)']])), html, 'no run clock: the same event gives the same bytes');
});

test('the page escapes upstream text and falls back to coordinates for text it may not show', () => {
  const evil = sharePageHtml(node({ place: '<script>alert(1)</script> "x" & \'y\'', providers: ['geonet'] }));
  assert.ok(!/<script/i.test(evil));
  assert.ok(evil.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot; &amp; &#39;y&#39;'));
  assert.ok(evil.includes('Data: GEONET, compiled by'), 'an unknown provider name: its id; one agency');
  const bidi = sharePageHtml(node({ place: '\u202Eabc', lat: -10.94, lon: 165.56 }));
  assert.ok(bidi.includes('<p class="text">near 10.9°S 165.6°E</p>') && !bidi.includes('\u202E'));
  const cyr = sharePageHtml(node({ place: '\u041A\u0430\u043C\u0447\u0430\u0442\u043A\u0430', lat: 52.1, lon: 158.7 }));
  assert.ok(cyr.includes('near 52.1°N 158.7°E') && !/[\u0400-\u04FF]/.test(cyr));
  const nomag = sharePageHtml(node({ mag: null, depth: null, fields: { felt: 3 } }));
  assert.ok(nomag.includes('<h1>Earthquake</h1>') && nomag.includes('og/event/generic.png') && !nomag.includes('<dt>Depth</dt>'));
});

test('page check: a script, a style attribute on an element, another stylesheet, no canonical or banner; text reading style= is fine', () => {
  const ok = sharePageHtml(node({ place: '5 km N of X style=Y' }));
  assert.ok(ok.includes('<p class="text">5 km N of X style=Y</p>') && ok.includes('content="Magnitude 6.4 earthquake · 5 km N of X style=Y'));
  assert.equal(sharePageProblem(ok, false), null);
  assert.equal(sharePageProblem(notFoundPageHtml(), true), null);
  assert.match(sharePageProblem(ok.replace('</body>', '<script>x</script></body>'), false)!, /script/);
  assert.match(sharePageProblem(ok.replace('<p class="text">', '<p class="text" style="color:red">'), false)!, /style attribute/);
  assert.match(sharePageProblem(ok.replace('<h1>', '<h1 STYLE = x>'), false)!, /style attribute/);
  assert.match(sharePageProblem(ok.replace('</head>', '<style>a{}</style></head>'), false)!, /stylesheet/);
  assert.match(sharePageProblem(ok.replace(/<link rel="canonical"[^>]*>/, ''), false)!, /canonical/);
  assert.match(sharePageProblem(ok.replace(/app-argument=[^"]*"/, 'app-argument=https://evil.example/"'), false)!, /Smart App Banner/);
  assert.match(sharePageProblem(notFoundPageHtml().replace('</h1>', ' efd_x</h1>'), true)!, /feed id/);
  assert.match(sharePageProblem(notFoundPageHtml().replace('</h1>', ' 2026</h1>'), true)!, /year/);
});

test('the generic page shows no id, no date and no year; no script; the hashed stylesheet', () => {
  const html = notFoundPageHtml();
  assert.ok(!html.includes('efd_'));
  assert.ok(!/\b(19|20)\d\d\b/.test(html.replace(/https?:\/\/[^"\s]*/g, '')), 'no year outside URLs');
  assert.ok(!/<script/i.test(html) && !/\sstyle=/i.test(html));
  assert.deepEqual([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]), [PAGE_CSS]);
  assert.ok(html.includes('<title>An earthquake on Shelter</title>'));
  assert.ok(html.includes('<meta name="apple-itunes-app" content="app-id=6767608845">'), 'the banner without an app-argument');
  assert.ok(html.includes('https://theshelter.app/og/event/generic.png'));
  assert.ok(!html.includes('rel="canonical"') && !html.includes('og:url'));
});

test('plan: significant live events of the window, retired ids under their final survivor, the cap most significant first', () => {
  const big = node({ mag: 7.1 });
  const small = node({ mag: 2.0 });
  const felt = node({ mag: 2.0, fields: { felt: 4 } });
  const old = node({ mag: 6.0, eventTimeMs: WINDOW.startMs - 1 });
  const future = node({ mag: 6.0, eventTimeMs: WINDOW.endMs + 1 });
  const retiredA = node({ mag: 6.8, state: 'superseded', supersededBy: big.feedId });
  const retiredB = node({ mag: 6.9, state: 'superseded', supersededBy: retiredA.feedId });
  const gone = node({ mag: 6.0, state: 'tombstoned' });
  const intoGone = node({ mag: 6.0, state: 'superseded', supersededBy: gone.feedId });
  const intoSmall = node({ mag: 4.4, state: 'superseded', supersededBy: small.feedId });
  const loopA = node({ state: 'superseded' });
  const loopB = node({ state: 'superseded', supersededBy: loopA.feedId });
  loopA.supersededBy = loopB.feedId;
  const all = [small, felt, old, future, retiredA, retiredB, gone, intoGone, intoSmall, loopA, loopB, big];
  const p = planSharePages(all, WINDOW);
  assert.deepEqual(
    p.pages.map((x) => [x.id, x.event.feedId]),
    [[big.feedId, big.feedId], ...[retiredA.feedId, retiredB.feedId].sort().map((id) => [id, big.feedId]), [felt.feedId, felt.feedId]],
  );
  assert.deepEqual([p.live, p.retired, p.capped], [2, 2, 0]);
  // The cap: an event goes in with all its retired ids or not at all; the next one may still fit.
  const capped = planSharePages(all, WINDOW, 2);
  assert.deepEqual(capped.pages.map((x) => x.id), [felt.feedId]);
  assert.deepEqual([capped.live, capped.retired, capped.capped], [1, 0, 3]);
  // Order: PAGER level, tsunami, magnitude, felt, newer first.
  const red = node({ mag: 5.0, fields: { alert: 'red' } });
  const wave = node({ mag: 4.0, fields: { tsunami: 1 } });
  const m6new = node({ mag: 6.0, eventTimeMs: NOW - 1000 });
  const m6old = node({ mag: 6.0, eventTimeMs: NOW - 2000 });
  assert.deepEqual(planSharePages([m6old, wave, m6new, red], WINDOW).pages.map((x) => x.id), [red, wave, m6new, m6old].map((n) => n.feedId));
});

test('write: one page per id (a retired id gets its survivor\'s bytes), the generic page, stale files removed, stable bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'share-'));
  try {
    const live = node({ mag: 5.5 });
    const retired = node({ mag: 5.4, state: 'superseded', supersededBy: live.feedId });
    const share = join(dir, SHARE_DIR);
    mkdirSync(share, { recursive: true });
    writeFileSync(join(share, 'efd_00000000000000000000000000.html'), 'stale');
    const out = writeSharePages([live, retired, node({ mag: 1 })], { publicDir: dir, window: WINDOW });
    assert.deepEqual([out.pages, out.live, out.retired, out.capped, out.removed], [2, 1, 1, 0, 1]);
    assert.deepEqual(readdirSync(share).sort(), [SHARE_NOT_FOUND, `${live.feedId}.html`, `${retired.feedId}.html`].sort());
    const a = readFileSync(join(share, `${live.feedId}.html`), 'utf8');
    assert.equal(readFileSync(join(share, `${retired.feedId}.html`), 'utf8'), a, 'canonical = the survivor');
    assert.ok(a.includes(`<link rel="canonical" href="${eventUrl(live.feedId)}">`));
    assert.equal(readFileSync(join(share, SHARE_NOT_FOUND), 'utf8'), notFoundPageHtml());
    assert.ok(out.maxBytes > 0 && out.bytes > out.maxBytes);
    writeSharePages([live, retired], { publicDir: dir, window: WINDOW });
    assert.equal(readFileSync(join(share, `${live.feedId}.html`), 'utf8'), a);
    assert.deepEqual(out.rejected, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('write and derive step: a page the check rejects is left out with its retired ids and a warning; the rest ship', () => {
  const dir = mkdtempSync(join(tmpdir(), 'share-reject-'));
  try {
    const bad = node({ mag: 6.0 });
    const badRetired = node({ mag: 5.9, state: 'superseded', supersededBy: bad.feedId });
    const good = node({ mag: 5.0 });
    const share = join(dir, SHARE_DIR);
    mkdirSync(share, { recursive: true });
    writeFileSync(join(share, `${badRetired.feedId}.html`), 'an earlier run');
    const render = (n: EventNode, names?: ReadonlyMap<string, string>): string => {
      const html = sharePageHtml(n, names);
      return n.feedId === bad.feedId ? html.replace('</body>', '<script>x</script></body>') : html;
    };
    const warnings: string[] = [];
    const out = deriveSharePages([bad, badRetired, good], {
      publicDir: dir,
      window: WINDOW,
      warn: (m) => warnings.push(m),
      write: (nodes, o) => writeSharePages(nodes, { ...o, render }),
    });
    assert.ok(out);
    assert.deepEqual([out.pages, out.live, out.retired], [1, 1, 0]);
    assert.deepEqual(out.rejected, [{ id: bad.feedId, why: 'holds a script' }]);
    assert.deepEqual(readdirSync(share).sort(), [SHARE_NOT_FOUND, `${good.feedId}.html`].sort(), 'the retired id\'s old page is gone too');
    assert.deepEqual(warnings, [`share page ${bad.feedId} left out: holds a script`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('derive step: a throw drops share/ for the run with a warning, never the feed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'share-drop-'));
  try {
    mkdirSync(join(dir, SHARE_DIR), { recursive: true });
    writeFileSync(join(dir, SHARE_DIR, SHARE_NOT_FOUND), 'x');
    const warnings: string[] = [];
    const r = deriveSharePages([], {
      publicDir: dir,
      window: WINDOW,
      warn: (m) => warnings.push(m),
      write: () => {
        throw new Error('boom');
      },
    });
    assert.equal(r, null);
    assert.ok(!existsSync(join(dir, 'share')));
    assert.deepEqual(warnings, ['share pages dropped: boom']);
    assert.equal(deriveSharePages([], { publicDir: dir, window: null }), null, 'no window (no days): nothing');
    // The provider names are read inside the step: a registry error drops the pages, not derive.
    mkdirSync(join(dir, SHARE_DIR), { recursive: true });
    const unread = deriveSharePages([node({ mag: 5 })], {
      publicDir: dir,
      window: WINDOW,
      warn: (m) => warnings.push(m),
      providerNames: () => {
        throw new Error('registry unreadable');
      },
    });
    assert.equal(unread, null);
    assert.ok(!existsSync(join(dir, 'share')));
    assert.equal(warnings.pop(), 'share pages dropped: registry unreadable');
    const ok = deriveSharePages([node({ mag: 5 })], { publicDir: dir, window: WINDOW, warn: (m) => warnings.push(m), providerNames: () => new Map([['usgs', 'USGS']]) });
    assert.equal(ok?.pages, 1);
    assert.equal(warnings.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('_headers: /share/* gets the CSP, nosniff, no referrer, noindex and a short cache; no other rule reaches it', () => {
  const body = pagesHeaders(NOW, ['2026-11-09']);
  const blocks = body.split(/\n(?=\S)/);
  const share = blocks.filter((b) => b.split('\n')[0]!.startsWith('/share'));
  assert.equal(share.length, 1);
  assert.deepEqual(share[0]!.trim().split('\n'), ['/share/*', ...SHARE_HEADERS.map(([k, v]) => `  ${k}: ${v}`)]);
  assert.ok(share[0]!.includes(`  Content-Security-Policy: ${SHARE_CSP}`));
  assert.ok(!share[0]!.includes('Access-Control-Allow-Origin'));
  for (const b of blocks) {
    const pattern = b.split('\n')[0]!;
    if (pattern === '/share/*') continue;
    assert.ok(!pattern.startsWith('/share') && !pattern.startsWith('/*') && !pattern.startsWith('/:'), `${pattern} must not reach /share/`);
  }
});
