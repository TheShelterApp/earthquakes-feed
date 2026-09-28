import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CACHE_CONTROL, PAGES_HEADER_RULE_LIMIT, pagesHeaders } from '../src/pages-headers.js';

/** Cloudflare Pages `_headers` semantics (developers.cloudflare.com/pages/configuration/headers):
 *  a rule is a path pattern followed by indented `Name: value` lines; `*` is a splat matching
 *  anything (slashes included), `:name` a placeholder matching one segment (no "/"); EVERY
 *  matching rule applies, and a header set by several is joined with ", ". */
function parse(body: string): { pattern: RegExp; source: string; headers: [string, string][] }[] {
  const rules: { pattern: RegExp; source: string; headers: [string, string][] }[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    if (!line.startsWith(' ')) {
      const re = line
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z]\w*)/g, '[^/]+'))
        .join('.*');
      rules.push({ pattern: new RegExp(`^${re}$`), source: line, headers: [] });
    } else {
      const [name, ...rest] = line.trim().split(':');
      rules.at(-1)!.headers.push([name!.trim(), rest.join(':').trim()]);
    }
  }
  return rules;
}

function served(body: string, path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of parse(body)) {
    if (!r.pattern.test(path)) continue;
    for (const [k, v] of r.headers) out.set(k, out.has(k) ? `${out.get(k)}, ${v}` : v);
  }
  return out;
}

const NOW = Date.parse('2026-09-28T13:46:00Z');
const DAYS = Array.from({ length: 45 }, (_, i) => new Date(NOW - i * 86_400_000).toISOString().slice(0, 10));

test('every published path gets exactly one Cache-Control and one Access-Control-Allow-Origin', () => {
  const body = pagesHeaders(NOW, DAYS);
  const paths = [
    '/v1/manifest.json',
    '/v1/status.json',
    '/v1/all_week.geojson',
    '/v1/significant_month.geojson',
    '/v1/changes/2026-09-28.ndjson',
    '/v2/manifest.json',
    ...DAYS.map((d) => `/v1/events/${d}.geojson`),
  ];
  for (const p of paths) {
    const h = served(body, p);
    const cc = h.get('Cache-Control');
    assert.ok(cc, `${p}: has Cache-Control`);
    assert.ok(Object.values(CACHE_CONTROL).includes(cc as never), `${p}: one value, not a joined list (got "${cc}")`);
    assert.equal(h.get('Access-Control-Allow-Origin'), '*', `${p}: exactly one CORS origin`);
  }
});

test('lifetimes: top-level 30 s, today and yesterday 300 s, older days 3600 s, change-log and v2 edge-only', () => {
  const body = pagesHeaders(NOW, DAYS);
  assert.equal(served(body, '/v1/all_week.geojson').get('Cache-Control'), CACHE_CONTROL.top);
  assert.equal(served(body, '/v1/manifest.json').get('Cache-Control'), CACHE_CONTROL.top);
  assert.equal(served(body, '/v1/events/2026-09-28.geojson').get('Cache-Control'), CACHE_CONTROL.hotDay);
  assert.equal(served(body, '/v1/events/2026-09-27.geojson').get('Cache-Control'), CACHE_CONTROL.hotDay, 'late reports still land in yesterday');
  assert.equal(served(body, '/v1/events/2026-09-26.geojson').get('Cache-Control'), CACHE_CONTROL.coldDay);
  assert.equal(served(body, '/v1/events/2026-08-15.geojson').get('Cache-Control'), CACHE_CONTROL.coldDay);
  assert.equal(served(body, '/v1/changes/2026-09-28.ndjson').get('Cache-Control'), CACHE_CONTROL.changes);
  assert.equal(served(body, '/v2/manifest.json').get('Cache-Control'), CACHE_CONTROL.v2);
  // A future-dated day file (an event minutes past midnight) is hot too.
  assert.equal(served(pagesHeaders(NOW, [...DAYS, '2026-09-29']), '/v1/events/2026-09-29.geojson').get('Cache-Control'), CACHE_CONTROL.hotDay);
});

test('the pre-fix rules overlapped: the same check fails on the old file', () => {
  const old = [
    '/v1/*',
    '  Cache-Control: public, max-age=30, stale-while-revalidate=120',
    '  Access-Control-Allow-Origin: *',
    '/v1/events/*',
    '  Cache-Control: public, max-age=3600',
    '  Access-Control-Allow-Origin: *',
    '/v1/events/2026-09-28.geojson',
    '  Cache-Control: public, max-age=300, stale-while-revalidate=600',
    '  Access-Control-Allow-Origin: *',
  ].join('\n');
  const h = served(old, '/v1/events/2026-09-28.geojson');
  assert.equal(h.get('Access-Control-Allow-Origin'), '*, *, *', 'what production served on 2026-09-28');
  assert.match(h.get('Cache-Control')!, /max-age=30.*max-age=3600.*max-age=300/);
});

test('within the Pages limits; a day list past the rule limit shares one placeholder rule', () => {
  const body = pagesHeaders(NOW, DAYS);
  const rules = parse(body);
  assert.ok(rules.length <= PAGES_HEADER_RULE_LIMIT, `${rules.length} rules`);
  assert.equal(rules.length, 3 + DAYS.length);
  assert.ok(body.split('\n').every((l) => l.length <= 2000));
  const many = Array.from({ length: 150 }, (_, i) => new Date(NOW - i * 86_400_000).toISOString().slice(0, 10));
  const big = pagesHeaders(NOW, many);
  assert.equal(parse(big).length, 4);
  for (const d of [many[0]!, many[149]!]) {
    assert.equal(served(big, `/v1/events/${d}.geojson`).get('Cache-Control'), CACHE_CONTROL.hotDay);
    assert.equal(served(big, `/v1/events/${d}.geojson`).get('Access-Control-Allow-Origin'), '*');
  }
  assert.equal(served(big, '/v1/all_day.geojson').get('Cache-Control'), CACHE_CONTROL.top, 'the placeholder rule stays in events/');
});
