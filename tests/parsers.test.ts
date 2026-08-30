import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGeosphere, parseJmaCod, parseJmaList, parseKoeri, parsePhivolcs } from '../src/custom.js';
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

test('JMA cod: routine bulletin — decimal degrees', () => {
  const c = parseJmaCod('+36.0+140.1-70000/');
  assert.equal(c!.lat, 36.0);
  assert.equal(c!.lon, 140.1);
  assert.equal(c!.depthKm, 70, 'depth metres -> km, sign dropped');
});

test('JMA cod: VXSE61 hypocenter update — sexagesimal DDMM.m stays in range', () => {
  // +3559.9+14005.7 = 35°59.9′N 140°05.7′E ≈ 36.0N 140.1E (Southern Ibaraki, the
  // 2026-08-22 M5.9 that read as lat 3559.9 / lon 14005.7 and red-lined derive).
  const c = parseJmaCod('+3559.9+14005.7-68000/');
  assert.ok(Math.abs(c!.lat) <= 90 && Math.abs(c!.lon) <= 180, 'in schema range');
  assert.ok(Math.abs(c!.lat - 35.998333) < 1e-5, `lat ${c!.lat}`);
  assert.ok(Math.abs(c!.lon - 140.095) < 1e-5, `lon ${c!.lon}`);
  assert.equal(c!.depthKm, 68);
});

test('JMA cod: southern/western signs and zero depth', () => {
  const c = parseJmaCod('-3330.0-07045.5+0/');
  assert.ok(Math.abs(c!.lat - -33.5) < 1e-9, `lat ${c!.lat}`);
  assert.ok(Math.abs(c!.lon - -70.758333) < 1e-5, `lon ${c!.lon}`);
  assert.equal(c!.depthKm, 0);
});

test('JMA cod: missing/empty cod yields null (record skipped)', () => {
  assert.equal(parseJmaCod(''), null);
  assert.equal(parseJmaCod('garbage'), null);
});

test('JMA list: multiple bulletins per eid collapse to one obs (latest ctt, no churn)', () => {
  // Real shape from 2026-08-22 M5.9 Ibaraki: 震度速報 (no cod), routine 震源・震度情報,
  // and the refined VXSE61 update — all under one eid. Emitting all made the feed churn
  // a revision every cycle; we keep only the latest-issued cod-bearing bulletin.
  const list = [
    { eid: 'E1', ctt: '20260823040012', ttl: '顕著な地震の震源要素更新のお知らせ', at: '2026-08-23T02:00:00+09:00', rdt: '2026-08-23T04:00:00+09:00', cod: '+3559.9+14005.7-68000/', mag: '5.9', anm: '茨城県南部' },
    { eid: 'E1', ctt: '20260823021215', ttl: '震源・震度情報', at: '2026-08-23T02:00:00+09:00', rdt: '2026-08-23T02:12:00+09:00', cod: '+36.0+140.1-70000/', mag: '5.9', anm: '茨城県南部' },
    { eid: 'E1', ctt: '20260823020221', ttl: '震度速報', at: '2026-08-23T02:00:00+09:00', rdt: '2026-08-23T02:02:00+09:00', cod: '', mag: '' },
    { eid: 'E2', ctt: '20260823010000', ttl: '震源・震度情報', at: '2026-08-23T01:00:00+09:00', rdt: '2026-08-23T01:05:00+09:00', cod: '+43.0+145.4-50000/', mag: '2.9', anm: '釧路沖' },
  ];
  const obs = parseJmaList(list, 'jma');
  assert.equal(obs.length, 2, 'one observation per eid');
  const e1 = obs.find((o) => o.providerEventId === 'E1')!;
  assert.equal(e1.fields['ttl'], '顕著な地震の震源要素更新のお知らせ', 'latest ctt wins (refined VXSE61)');
  assert.ok(Math.abs(e1.lat - 35.998333) < 1e-5 && Math.abs(e1.lon - 140.095) < 1e-5, 'in-range coords');
  assert.equal(e1.depth, 68);
});

test('GeoSphere Austria: keeps only own solutions; naive-UTC + [mag,type]', () => {
  const list = [
    { author: 'GeoSphere Austria', event_id: 111, datetime_utc: '2026-08-29T22:07:14.511540', lat: 47.82, lon: 16.14, depth: 3.17, reference_magnitude: [1.2, 'ml'], region: 'Wr. Neustadt', is_verified: true },
    { author: 'EMSC', event_id: 222, datetime_utc: '2026-08-29T00:00:00.000000', lat: 40.1, lon: 19.8, depth: 5, reference_magnitude: [4.5, 'mb'], region: 'Albania', is_verified: false },
  ];
  const o = parseGeosphere(list, 'geosphere');
  assert.equal(o.length, 1, 're-served EMSC row is dropped (arrives from emsc directly)');
  assert.equal(o[0]!.providerEventId, '111');
  assert.equal(o[0]!.eventTimeMs, Date.parse('2026-08-29T22:07:14.511Z'), 'naive-UTC + Z, µs trimmed');
  assert.equal(o[0]!.mag, 1.2);
  assert.equal(o[0]!.magType, 'ml');
  assert.equal(o[0]!.depth, 3.17, 'depth already km');
  assert.equal(o[0]!.status, 'reviewed', 'is_verified -> reviewed');
});

test('KOERI: fixed-width UTC list, Mw>ML>MD, synthesised id', () => {
  const pre =
    '<pre>\nDate       Time      Latit(N)  Long(E)   Depth(km)     MD   ML   Mw    Region\n' +
    '2026.08.30 08:04:16  39.2787   28.9977       16.1      -.-  1.0  -.-   YESILDERE-SIMAV (KUTAHYA)                         Quick\n</pre>';
  const o = parseKoeri(pre, 'koeri');
  assert.equal(o.length, 1, 'header line skipped, one data row');
  assert.equal(o[0]!.lat, 39.2787);
  assert.equal(o[0]!.lon, 28.9977);
  assert.equal(o[0]!.depth, 16.1);
  assert.equal(o[0]!.mag, 1.0);
  assert.equal(o[0]!.magType, 'ML', 'Mw absent (-.-), falls to ML');
  assert.equal(o[0]!.eventTimeMs, Date.parse('2026-08-30T08:04:16Z'));
  assert.equal(o[0]!.providerEventId, 'koeri-20260830080416', 'time-only id folds revisions');
  assert.match(o[0]!.place ?? '', /YESILDERE-SIMAV/);
});

test('PHIVOLCS: UTC from bulletin filename; backslash href; B1/B2 fold to one id', () => {
  const row = (bulletin: string, mag: string) =>
    `<tr><td><a href="2026_Earthquake_Information\\August\\${bulletin}.html">30 August 2026 - 04:42 PM</a></td>` +
    `<td>19.43</td><td>121.78</td><td>006</td><td>${mag}</td><td>017 km S 57 deg W of Babuyan Island (Cagayan)</td></tr>`;
  // Same event re-issued as B1 then B2F — must collapse to one observation (first seen wins).
  const html = `<table>${row('2026_0830_0842_B1', '2.0')}${row('2026_0830_0842_B2F', '2.1')}</table>`;
  const o = parsePhivolcs(html, 'phivolcs');
  assert.equal(o.length, 1, 'bulletin revisions share the UTC-minute id');
  assert.equal(o[0]!.providerEventId, '2026_0830_0842');
  assert.equal(o[0]!.eventTimeMs, Date.parse('2026-08-30T08:42:00Z'), 'UTC read from filename, not the PST cell');
  assert.equal(o[0]!.lat, 19.43);
  assert.equal(o[0]!.lon, 121.78);
  assert.equal(o[0]!.depth, 6, 'zero-padded "006" -> 6');
  assert.equal(o[0]!.mag, 2.0);
  assert.equal(o[0]!.magType, null, 'magType only in sub-bulletins');
  assert.match(o[0]!.place ?? '', /Babuyan/);
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
