import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderAttributions, statementWithLink } from '../scripts/gen-attributions.mjs';
import { NOTICE } from '../src/summaries.js';
import type { ProviderConfig } from '../src/types.js';

// Stream C4: NOTICE and ATTRIBUTIONS.md are generated from providers/registry.json, and the licences that ask for a
// verbatim statement beside the attribution (OGL – Canada 2.0, OGL v3.0 UK) get it, with the licence link, everywhere
// the feed names its sources.

const root = new URL('..', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');
const registry = JSON.parse(read('providers/registry.json')) as { providers: ProviderConfig[] };

/** The statements as the licences give them (open.canada.ca, nationalarchives.gov.uk; checked 2026-11-08). */
const OGL_CANADA = {
  notice: 'Contains information licensed under the Open Government Licence – Canada.',
  url: 'https://open.canada.ca/en/open-government-licence-canada',
};
const OGL_UK = {
  notice: 'Contains public sector information licensed under the Open Government Licence v3.0.',
  url: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
};
const BY_LICENSE: Record<string, typeof OGL_CANADA> = { 'OGL-Canada-2.0': OGL_CANADA, 'OGL-3.0': OGL_UK };

test('drift guard: the committed NOTICE and ATTRIBUTIONS.md are exactly what the generator renders from the registry', () => {
  const out = renderAttributions(registry);
  assert.equal(read('NOTICE'), out.notice, 'run `node scripts/gen-attributions.mjs`');
  assert.equal(read('ATTRIBUTIONS.md'), out.attributions, 'run `node scripts/gen-attributions.mjs`');
});

test('every OGL provider carries its licence statement verbatim and the licence URL', () => {
  const ogl = registry.providers.filter((p) => p.license in BY_LICENSE);
  assert.deepEqual(ogl.map((p) => p.id).sort(), ['bgs', 'nrcan']);
  for (const p of ogl) {
    const want = BY_LICENSE[p.license]!;
    assert.equal(p.attributionNotice, want.notice, p.id);
    assert.equal(p.licenseUrl, want.url, p.id);
  }
  assert.ok(OGL_CANADA.notice.includes('Licence – Canada'), 'the dash is U+2013');
  // A notice without its link would leave the licence's "link to this licence" half undone.
  for (const p of registry.providers) if (p.attributionNotice) assert.ok(p.licenseUrl, `${p.id}: attributionNotice needs licenseUrl`);
});

test('NOTICE and ATTRIBUTIONS.md name each statement; ATTRIBUTIONS.md links each licence', () => {
  const notice = read('NOTICE');
  const attributions = read('ATTRIBUTIONS.md');
  for (const { notice: statement, url } of [OGL_CANADA, OGL_UK]) {
    assert.ok(notice.includes(statementWithLink(statement, url)), statement);
    assert.ok(attributions.includes(statement), statement);
    assert.ok(attributions.includes(`](${url})`), url);
  }
  assert.ok(notice.includes('- Natural Resources Canada — Earthquakes Canada. Contains information licensed under the Open Government Licence – Canada (https://open.canada.ca/en/open-government-licence-canada).\n'));
});

test('the summaries, live and detail files carry both OGL statements in metadata.attribution', () => {
  for (const { notice: statement, url } of [OGL_CANADA, OGL_UK]) assert.ok(NOTICE.includes(statementWithLink(statement, url)), statement);
});

test('APIs.md states the OGL – Canada statement with its link in Licensing and in the Canada section', () => {
  const doc = read('APIs.md');
  const section = (heading: string): string => {
    const start = doc.indexOf(`\n${heading}\n`);
    assert.ok(start >= 0, heading);
    const next = doc.indexOf('\n## ', start + heading.length + 2);
    return doc.slice(start, next < 0 ? undefined : next);
  };
  for (const heading of ['## Licensing', '## Canada (NRCan)']) {
    const s = section(heading);
    assert.ok(s.includes(OGL_CANADA.notice.replace(/\.$/, '')), `${heading}: the statement`);
    assert.ok(s.includes(OGL_CANADA.url), `${heading}: the link`);
  }
});
