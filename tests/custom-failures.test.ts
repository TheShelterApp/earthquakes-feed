import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { CUSTOM_ADAPTERS } from '../src/custom.js';
import { fetchProvider, loadRegistry } from '../src/providers.js';
import type { ProviderConfig } from '../src/types.js';

// FEED-PROV-L3: the multi-request custom adapters (IPMA, IGP, BMKG, CSN, CWA) caught each request's error and went on,
// and IGN returned no rows when its file had no readable `dias30`. With every request failing the run recorded the
// source as ok with 0 rows, which only the silent-provider budget (12 h) noticed. Now an adapter whose every request
// failed throws (status ok: false, the error named); some requests failing keeps the others' rows.

const registry = loadRegistry();
const cfgOf = (id: string, base: string): ProviderConfig => ({ ...registry.find((p) => p.id === id)!, base });

/** A local source: `routes` maps a path to its body; any other path answers 404. Every path asked is logged. */
async function serve(routes: Record<string, string | Uint8Array>, fn: (base: string, asked: string[]) => Promise<void>): Promise<void> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    asked.push(path);
    const body = routes[path];
    if (body == null) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, asked);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const NOW = Date.parse('2026-11-16T12:00:00Z');
const ipmaArea = JSON.stringify({ data: [{ sismoId: 'a1', time: '2026-11-16T10:00:00', lat: 38.1, lon: -9.2, depth: 10, magnitud: 2.1, magType: 'ML', obsRegion: 'Lisboa' }] });
const igpYear = JSON.stringify([{ codigo: 'IGP/CENSIS/RS 2026-0900', fecha_utc: '2026-11-16T00:00:00', hora_utc: '1970-01-01T10:00:00', latitud: -12.1, longitud: -77.1, profundidad: 30, magnitud: 4.0, referencia: 'Lima' }]);
const bmkgFile = JSON.stringify({ Infogempa: { gempa: [{ DateTime: '2026-11-16T10:00:00+00:00', Coordinates: '-7.1,110.2', Kedalaman: '10 km', Magnitude: '3.1', Wilayah: 'Jawa' }] } });
const csnPage = '<table><tr><td><a href="https://www.sismologia.cl/sismicidad/informes/2026/11/123456.html">2026-11-16 07:00:00</a><br>10 km al S de Lugar</td>' +
  '<td>2026-11-16 10:00:00</td><td>-33.1<br>-71.2</td><td>40 km</td><td>3.2 Ml</td></tr></table>';
const cwaXml = '<cwaopendata><identifier>x</identifier><Web>https://scweb.cwa.gov.tw/zh-tw/earthquake/details/1150000000000001</Web>' +
  '<OriginTime>2026-11-16T18:00:00+08:00</OriginTime><EpicenterLatitude>23.5</EpicenterLatitude><EpicenterLongitude>121.5</EpicenterLongitude>' +
  '<FocalDepth>10</FocalDepth><MagnitudeValue>4.1</MagnitudeValue><Location>Hualien</Location></cwaopendata>';

test('custom adapters: every request failing throws and names the last error; one failing keeps the other rows', async () => {
  // IPMA: two area files.
  await serve({}, async (base) => {
    await assert.rejects(CUSTOM_ADAPTERS.ipma!(cfgOf('ipma', base), NOW), /^Error: ipma: every request failed \(2; last: HTTP 404\)$/);
  });
  await serve({ '/7.json': ipmaArea }, async (base) => {
    assert.deepEqual((await CUSTOM_ADAPTERS.ipma!(cfgOf('ipma', base), NOW)).map((o) => o.providerEventId), ['a1']);
  });
  // BMKG: two lists.
  await serve({}, async (base) => {
    await assert.rejects(CUSTOM_ADAPTERS.bmkg!(cfgOf('bmkg', base), NOW), /^Error: bmkg: every request failed \(2; last: HTTP 404\)$/);
  });
  await serve({ '/gempadirasakan.json': bmkgFile }, async (base) => {
    assert.equal((await CUSTOM_ADAPTERS.bmkg!(cfgOf('bmkg', base), NOW)).length, 1);
  });
  // CSN: today's and yesterday's pages live; a backfill window's day pages.
  await serve({}, async (base) => {
    await assert.rejects(CUSTOM_ADAPTERS.csn!(cfgOf('csn', base), NOW), /^Error: csn: every request failed \(2; last: HTTP 404\)$/);
  });
  await serve({ '/2026/11/20261116.html': csnPage }, async (base) => {
    assert.deepEqual((await CUSTOM_ADAPTERS.csn!(cfgOf('csn', base), NOW)).map((o) => o.providerEventId), ['123456'], "yesterday's page missing is no error");
  });
  // CWA: two zip bundles.
  await serve({}, async (base) => {
    await assert.rejects(CUSTOM_ADAPTERS.cwa!(cfgOf('cwa', base), NOW), /^Error: cwa: every request failed \(2; last: HTTP 404\)$/);
  });
  await serve({ '/E-A0016-001.zip': zipSync({ 'a.xml': strToU8(cwaXml) }) }, async (base) => {
    assert.deepEqual((await CUSTOM_ADAPTERS.cwa!(cfgOf('cwa', base), NOW)).map((o) => o.providerEventId), ['1150000000000001']);
  });
  // IGP: a body that does not parse fails like an error status.
  await serve({ '/2026': '<html>maintenance</html>' }, async (base) => {
    await assert.rejects(CUSTOM_ADAPTERS.igp!(cfgOf('igp', base), NOW), /^Error: igp: every request failed \(1; last: .*JSON/);
  });
  await serve({ '/2026': igpYear }, async (base) => {
    assert.equal((await CUSTOM_ADAPTERS.igp!(cfgOf('igp', base), NOW)).length, 1);
  });
});

test('custom adapters: the run records a source whose every request failed as failed, with the error', async () => {
  await serve({}, async (base) => {
    const r = await fetchProvider(cfgOf('ipma', base), NOW);
    assert.equal(r.status.ok, false);
    assert.equal(r.status.error, 'ipma: every request failed (2; last: HTTP 404)');
    assert.deepEqual(r.obs, []);
  });
});

// FEED-PROV-L2: IGP's live path read only the current year's file, so on 1 January a 31 December event IGP published or
// revised after midnight UTC was never fetched live. It now reads every year of the live lookback (2 days).
test('igp: the live path reads the previous year\'s file in the first two days of January, the current one otherwise', async () => {
  const dec31 = JSON.stringify([{ codigo: 'IGP/CENSIS/RS 2026-1000', fecha_utc: '2026-12-31T00:00:00', hora_utc: '1970-01-01T23:50:00', latitud: -12.1, longitud: -77.1, profundidad: 30, magnitud: 4.0, referencia: 'Lima' }]);
  await serve({ '/2026': dec31 }, async (base, asked) => {
    // 2027-01-01 00:30Z: the 2027 file does not exist yet (404); the 2026 one holds the event.
    const rows = await CUSTOM_ADAPTERS.igp!(cfgOf('igp', base), Date.parse('2027-01-01T00:30:00Z'));
    assert.deepEqual(rows.map((o) => o.providerEventId), ['IGP/CENSIS/RS 2026-1000']);
    assert.deepEqual([...new Set(asked)], ['/2026', '/2027']);
  });
  await serve({ '/2027': '[]' }, async (base, asked) => {
    await CUSTOM_ADAPTERS.igp!(cfgOf('igp', base), Date.parse('2027-01-03T00:30:00Z'));
    assert.deepEqual(asked, ['/2027'], 'from 3 January on, one file');
  });
});

test('ign: a file without a readable dias30 is an error, not an empty list', async () => {
  await serve({ '/a.js': 'var dias3 = {"features": []};' }, async (base) => {
    await assert.rejects(CUSTOM_ADAPTERS.ign!(cfgOf('ign', `${base}a.js`), NOW), /^Error: ign: no dias30 object in the answer/);
  });
  await serve({ '/a.js': 'var dias30 = {"features": [ {"x": 1,} ]};' }, async (base) => {
    await assert.rejects(CUSTOM_ADAPTERS.ign!(cfgOf('ign', `${base}a.js`), NOW), /^Error: ign: dias30 does not parse/);
  });
  await serve({ '/a.js': 'var dias30 = {"features": []};' }, async (base) => {
    assert.deepEqual(await CUSTOM_ADAPTERS.ign!(cfgOf('ign', `${base}a.js`), NOW), [], 'an empty list stays a valid answer');
  });
});
