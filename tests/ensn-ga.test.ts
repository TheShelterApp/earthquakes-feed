import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnsnRss, parseGaRss } from '../src/custom.js';
import { loadRegistry } from '../src/providers.js';

// Issue #59: ENSN Egypt and Geoscience Australia answered `ok` with no rows from 2026-07-29/30. Neither had stopped:
// ENSN moved to a Nanometrics Athena site (the old earthquakes.json lists only stations), GA rewrote its RSS
// descriptions. Fixtures: the live answers of 2026-10-06, four items each.

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), 'utf8');

test('ENSN: the Athena RSS gives one row per event, named by the event id', () => {
  const rows = parseEnsnRss(fixture('ensn-feed-2026-10-06.rss'), 'egypt');
  assert.deepEqual(rows.map((r) => r.providerEventId), ['1355', '1354', '1352', '1350']);
  const [r] = rows;
  assert.equal(r!.eventTimeMs, Date.parse('2026-10-05T21:35:29.470Z'));
  assert.equal(r!.lat, 27.7223);
  assert.equal(r!.lon, 34.5987);
  assert.equal(r!.depth, 19.65);
  assert.equal(r!.mag, 2.16);
  assert.equal(r!.magType, 'Ml');
  assert.equal(r!.place, '32.0 km SE of Sharm El-Sheikh', 'the major-place line, as the old JSON adapter took nearestMajorPlace');
  assert.equal(r!.status, null);
  assert.equal(r!.fields['event'], '20261005-4');
  assert.equal(r!.fields['origin_id'], '1416');
  assert.equal(r!.fields['place'], 'Red Sea; 31.0 km from Um el Sid, Egypt');
  assert.equal(rows[2]!.magType, 'Md');
  // An event outside Egypt (Crete) parses the same way.
  assert.equal(rows[3]!.lat, 35.2415);
  assert.equal(rows[3]!.mag, 4.1);
});

test('ENSN: southern / western hemispheres and a missing table fall back to the title', () => {
  const item = (title: string, desc: string, id = '7'): string =>
    `<rss><channel><item><title>${title}</title><link>https://ensn.nriag.sci.eg/en/events/${id}/summary</link><description><![CDATA[${desc}]]></description></item></channel></rss>`;
  const [a] = parseEnsnRss(item('2026-10-05 01:02:03.400; 1.5000°S, 20.2500°W; 3.10 mb; Somewhere', ''), 'egypt');
  assert.equal(a!.lat, -1.5);
  assert.equal(a!.lon, -20.25);
  assert.equal(a!.mag, 3.1);
  assert.equal(a!.magType, 'mb');
  assert.equal(a!.eventTimeMs, Date.parse('2026-10-05T01:02:03.400Z'));
  // No id in the link, no position, no time: skipped.
  assert.equal(parseEnsnRss(item('2026-10-05 01:02:03; ; 3.1 Ml', '', 'x'), 'egypt').length, 0);
  assert.equal(parseEnsnRss('<rss><channel></channel></rss>', 'egypt').length, 0);
  // The old JSON URL's answer (stations only) is not an RSS: no rows, as before the move.
  assert.equal(parseEnsnRss('{"data":{"page":{"stations":[],"eventCriterias":[]}}}', 'egypt').length, 0);
});

test('GA: the RSS since 2026-07-30 (sentence description, magnitude type in the title)', () => {
  const rows = parseGaRss(fixture('ga-all-recent-2026-10-06.rss'), 'ga');
  assert.deepEqual(rows.map((r) => r.providerEventId), ['ga2026ttevvc', 'ga2026tszrhk', 'ga2026tsrckp', 'ga2026tsqmiq']);
  const [r] = rows;
  // The ISO time, not the 12-hour "05/10/2026 08:22:58 (UTC)" before it.
  assert.equal(r!.eventTimeMs, Date.parse('2026-10-05T20:22:58.269Z'));
  assert.equal(r!.lat, -24.45);
  assert.equal(r!.lon, 179.997);
  assert.equal(r!.depth, 507);
  assert.equal(r!.mag, 5);
  assert.equal(r!.magType, 'Mw');
  assert.equal(r!.place, 'South of Fiji Islands');
  assert.equal(rows[1]!.magType, 'MLa075');
  assert.equal(rows[1]!.place, 'Near Port Hedland, WA');
});

test('GA: the RSS before 2026-07-30 still parses (description = the time, depth in <summary>)', () => {
  const old = `<rss><channel><item><title>Magnitude 5.0, South Philippine Sea</title><link>https://earthquakes.ga.gov.au/event/ga2026owbxbt</link><description>2026-07-29T00:39:41.185Z</description><summary>Depth 100.832710266113km, Damage Radius 14km, Felt Radius 174km</summary><georss:point>10.158 126.098</georss:point></item></channel></rss>`;
  const [r] = parseGaRss(old, 'ga');
  // The row the feed stored on 2026-07-29 (events/2026/07/29.ndjson): same id, time, place, depth, magnitude.
  assert.equal(r!.providerEventId, 'ga2026owbxbt');
  assert.equal(r!.eventTimeMs, Date.parse('2026-07-29T00:39:41.185Z'));
  assert.equal(r!.place, 'South Philippine Sea');
  assert.equal(r!.depth, 100.832710266113);
  assert.equal(r!.mag, 5);
  assert.equal(r!.magType, null);
});

test('registry: ENSN is read from its RSS', () => {
  const egypt = loadRegistry().find((p) => p.id === 'egypt')!;
  assert.equal(egypt.base, 'https://ensn.nriag.sci.eg/en/events/feed.rss');
  assert.equal(egypt.active, true);
  assert.equal(loadRegistry().find((p) => p.id === 'ga')!.base, 'https://earthquakes.ga.gov.au/feeds/all_recent.rss');
});
