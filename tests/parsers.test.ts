import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFdsnText, parseGeoJSON } from '../src/fdsn.js';

test('FDSN text: standard pipe-delimited row', () => {
  const body = [
    '#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType',
    'gfz2026abc|2026-07-04T12:38:02.140000|38.114|21.907|12.4|GFZ|GFZ|||mb|4.7|GFZ|Western Greece|earthquake',
  ].join('\n');
  const [o] = parseFdsnText(body, 'geofon');
  assert.equal(o!.providerEventId, 'gfz2026abc');
  assert.equal(o!.eventTimeMs, Date.parse('2026-07-04T12:38:02.140Z'));
  assert.equal(o!.lat, 38.114);
  assert.equal(o!.mag, 4.7);
  assert.equal(o!.magType, 'mb');
  assert.equal(o!.place, 'Western Greece');
});

test('FDSN text: SCEDC quirks — slash date, spaced pipes, "Longtitude" typo header', () => {
  const body = [
    '#EventID  | Time                | Latitude | Longtitude   | Depth/km | Author | Catalog | ET | GT   | MagType | Magnitude | MagAuthor | EventLocationName',
    '41286815 | 2026/07/04 23:14:10.1100 | 35.29667 | -117.8028333 |  6.95    | CI     | SCEDC   | eq | l |   l     |  1.36     | CI        |   WSW of Johannesburg, CA',
  ].join('\n');
  const [o] = parseFdsnText(body, 'scedc');
  assert.equal(o!.providerEventId, '41286815');
  assert.equal(o!.eventTimeMs, Date.parse('2026-07-04T23:14:10.110Z'), 'slash date + space separator normalized to UTC');
  assert.equal(o!.lat, 35.29667);
  assert.equal(o!.lon, -117.8028333);
  assert.equal(o!.mag, 1.36);
  assert.equal(o!.magType, 'l');
  assert.match(o!.place ?? '', /Johannesburg/);
});

test('FDSN text: rows with <5 columns are skipped', () => {
  const body = '#header\nbad|row\n\ngfz1|2026-07-04T00:00:00|10|20|5|A|C|||mb|3|A|Place|earthquake';
  assert.equal(parseFdsnText(body, 'x').length, 1);
});

test('GeoJSON: USGS format (ms time, ids -> same-provider aliases)', () => {
  const body = JSON.stringify({
    features: [
      {
        id: 'us7000nabc',
        properties: { mag: 4.6, magType: 'ml', place: 'Western Greece', time: 1783168682140, updated: 1783168920000, status: 'reviewed', ids: ',us7000nabc,gcmt123,', nst: 41, sig: 326, type: 'earthquake' },
        geometry: { type: 'Point', coordinates: [21.907, 38.114, 12.4] },
      },
    ],
  });
  const [o] = parseGeoJSON(body, 'usgs');
  assert.equal(o!.providerEventId, 'us7000nabc');
  assert.equal(o!.eventTimeMs, 1783168682140);
  assert.equal(o!.providerUpdatedMs, 1783168920000);
  assert.equal(o!.lat, 38.114);
  assert.equal(o!.depth, 12.4);
  assert.equal(o!.status, 'reviewed');
  assert.deepEqual(o!.knownAliasIds, ['usgs:gcmt123'], 'ids parsed, self excluded, provider-prefixed');
  assert.equal(o!.fields['sig'], 326);
  // capture-all: fields the old allowlist dropped are now retained verbatim.
  assert.equal(o!.fields['ids'], ',us7000nabc,gcmt123,', 'ids kept in full field vocabulary');
  assert.equal(o!.fields['nst'], 41);
});

test('FDSN text: every column captured under its header name (no allowlist)', () => {
  const body = [
    '#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType',
    'gfz2026abc|2026-07-04T12:38:02.140000|38.114|21.907|12.4|GFZ|GFZ-CAT|EMSC|1234|mb|4.7|GFZ|Western Greece|earthquake',
  ].join('\n');
  const [o] = parseFdsnText(body, 'geofon');
  assert.equal(o!.fields['Author'], 'GFZ', 'Author column retained (was dropped before)');
  assert.equal(o!.fields['Catalog'], 'GFZ-CAT');
  assert.equal(o!.fields['Contributor'], 'EMSC');
  assert.equal(o!.fields['ContributorID'], '1234');
  assert.equal(o!.fields['MagAuthor'], 'GFZ');
  assert.equal(o!.fields['EventType'], 'earthquake');
});

test('GeoJSON: EMSC format (ISO time string, lowercase magtype, flynn_region)', () => {
  const body = JSON.stringify({
    features: [
      {
        id: '20260704_0000117',
        properties: { time: '2026-07-04T12:38:06.0Z', mag: 4.7, magtype: 'mb', flynn_region: 'WESTERN GREECE', lastupdate: '2026-07-04T12:39:58.0Z', depth: 12 },
        geometry: { type: 'Point', coordinates: [21.91, 38.11] },
      },
    ],
  });
  const [o] = parseGeoJSON(body, 'emsc');
  assert.equal(o!.providerEventId, '20260704_0000117');
  assert.equal(o!.eventTimeMs, Date.parse('2026-07-04T12:38:06.0Z'), 'ISO string time parsed');
  assert.equal(o!.magType, 'mb', 'lowercase magtype mapped');
  assert.equal(o!.place, 'WESTERN GREECE');
  assert.equal(o!.depth, 12);
  assert.equal(o!.providerUpdatedMs, Date.parse('2026-07-04T12:39:58.0Z'));
});

test('GeoJSON: features missing coordinates or time are skipped', () => {
  const body = JSON.stringify({
    features: [
      { id: 'a', properties: { mag: 3 }, geometry: { type: 'Point', coordinates: [] } },
      { id: 'b', properties: { time: 1783168682140 }, geometry: { type: 'Point', coordinates: [1, 2] } },
    ],
  });
  assert.equal(parseGeoJSON(body, 'x').length, 1);
});
