import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECLINED, type RegistryDatacenter, candidateId, candidateServices, suggestedEntry } from '../src/discover.js';

// Round 20 (issue #38): the monthly discovery suggested GeoShake with `license: "CC-BY-4.0"`, a value the script wrote for
// every candidate without reading any terms, and the id `api` (the host's first label). A reviewed and declined host must
// not come back as a new candidate every month.

test('discover: a declined source is listed with its issue, and GeoShake is one', () => {
  const g = DECLINED.find((d) => d.host === 'api.geoshake.org');
  assert.ok(g, 'GeoShake is declined');
  assert.equal(g.issue, 38);
  assert.ok(g.why.length > 20);
  assert.equal(new Set(DECLINED.map((d) => d.host)).size, DECLINED.length, 'one entry per host');
  for (const d of DECLINED) assert.equal(d.host, d.host.toLowerCase(), 'hosts are compared in lower case');
});

test('discover: the suggested entry claims no licence and names the operator, not the service', () => {
  const e = suggestedEntry({ dc: 'GeoShake Data Center', url: 'https://api.geoshake.org/fdsnws/event/1/query', fmt: 'text' });
  assert.equal(e['license'], 'unknown');
  assert.equal(e['id'], 'geoshake');
  assert.equal(e['active'], false);
  assert.equal(e['queryFormat'], 'text');
  assert.equal(suggestedEntry({ dc: 'X', url: 'https://example.org/fdsnws/event/1/query', fmt: 'geojson' })['queryFormat'], 'geojson');
  assert.equal(candidateId('www.isc.ac.uk'), 'isc');
  assert.equal(candidateId('service.ncedc.org'), 'ncedc');
  assert.equal(candidateId('eida2.gein.noa.gr'), 'eida2');
  assert.equal(candidateId('fdsnws.raspberryshakedata.com'), 'raspberryshakedata');
  assert.equal(candidateId('localhost'), 'localhost');
});

test('discover: a declined host is never probed again, from the FDSN registry or the curated leads (round 20 review)', () => {
  // The registry entry that produced issue #38 (fdsn.org/datacenters/detail/GEOSHAKE, read 2026-10-06), a new data centre,
  // and one the feed already reads.
  const registry: RegistryDatacenter[] = [
    {
      name: 'GEOSHAKE',
      fullName: 'GeoShake Data Center',
      repositories: [{ services: [{ name: 'fdsnws-station-1', url: 'https://api.geoshake.org/fdsnws/station/1/' }, { name: 'fdsnws-event-1', url: 'https://API.geoshake.org/fdsnws/event/1/' }] }],
    },
    { name: 'NEWDC', fullName: 'New Data Centre', repositories: [{ services: [{ name: 'fdsnws-event-1', url: 'https://ws.newdc.example/fdsnws/event/1/' }] }] },
    { name: 'EMSC', repositories: [{ services: [{ name: 'fdsnws-event-1', url: 'https://www.seismicportal.eu/fdsnws/event/1/' }] }] },
  ];
  const curated = [
    { dc: 'GeoShake (map host)', url: 'https://map.geoshake.org/fdsnws/event/1/query' },
    { dc: 'Curated lead', url: 'https://lead.example/fdsnws/event/1/query' },
  ];
  const known = new Set(['www.seismicportal.eu']);
  const declined = new Set(DECLINED.map((d) => d.host));
  const cand = candidateServices(registry, curated, known, declined);
  assert.deepEqual([...cand.keys()], ['ws.newdc.example', 'lead.example']);
  assert.equal(cand.get('ws.newdc.example')!.url, 'https://ws.newdc.example/fdsnws/event/1/query');
  // Without DECLINED, GeoShake comes back as it did on 2026-10-01 (the registry's host, then the curated map host).
  assert.deepEqual([...candidateServices(registry, curated, known, new Set()).keys()], ['api.geoshake.org', 'ws.newdc.example', 'map.geoshake.org', 'lead.example']);
});
