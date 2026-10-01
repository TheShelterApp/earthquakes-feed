import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { CORRECTION_EPOCH } from '../src/config.js';
import { NRCAN_FILLED_REASON, correctedEpoch, correctionFloor, nrcanCorrections, runCorrection } from '../src/correction.js';
import { Resolver } from '../src/dedup.js';
import { englishHalf, fdsnTextColumns, parseFdsnText, rereadFdsnTextRow } from '../src/fdsn.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';
import { num, parseUtcMs } from '../src/util.js';

// PF-5h: Earthquakes Canada's FDSN text answer has 8 columns,
//   #EventID|Time|Latitude|Longitude|Depth/km|MagType|Magnitude|EventLocationName
// and until 2026-10-01 the parser read every column at its standard 14-column position, so every NRCan row was stored
// with magnitude, magnitude type and place null although its fields held them.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);
const iso = (ms: number): string => new Date(ms).toISOString();

const NRCAN_BODY = readFileSync(here('fixtures/nrcan-fdsn-text-2026-10-01.txt'), 'utf8');

// --- the parser ---

test('nrcan: the real 2026-10-01 answer parses with its magnitude, magnitude type and English place', () => {
  const stats = { rows: 0 };
  const rows = parseFdsnText(NRCAN_BODY, 'nrcan', stats);
  assert.equal(stats.rows, 47);
  assert.equal(rows.length, 47);
  const r = rows[0]!;
  assert.equal(r.providerEventId, '20260929.1159001');
  assert.equal(iso(r.eventTimeMs), '2026-09-29T11:59:05.000Z');
  assert.equal(r.lat, 47.9418);
  assert.equal(r.lon, -69.6187);
  assert.equal(r.depth, 19.94);
  assert.equal(r.mag, 0.75);
  assert.equal(r.magType, 'MwN');
  assert.equal(r.place, '14 km NNW of Rivière-du-Loup, QC');
  assert.equal(r.fields['EventLocationName'], '14 km NNW of Rivière-du-Loup, QC/14 km NNO de Rivière-du-Loup, QC', 'the original stays in fields');
  assert.deepEqual(Object.keys(r.fields), ['EventID', 'Time', 'Latitude', 'Longitude', 'Depth/km', 'MagType', 'Magnitude', 'EventLocationName']);
  assert.ok(rows.every((x) => x.mag != null && x.magType != null && x.place != null), 'every row of the answer has all three');
  const yukon = rows.find((x) => x.providerEventId === '20260924.0359001')!;
  assert.deepEqual([yukon.mag, yukon.magType, yukon.place], [2.8, 'ML', '149 km SSW of Haines Junction, YT']);
});

test('nrcan: magnitude types as NRCan writes them (Mw with a prime, MLy, ML1) and annotated places', () => {
  const body = [
    '#EventID|Time|Latitude|Longitude|Depth/km|MagType|Magnitude|EventLocationName',
    // Logged rows of 2026-07-20, 07-10 and 09-08 (fields as stored).
    "20260720.0647001|2026-07-20T06:47:09.000Z|49.6116|-129.1818|10|Mw'|4.84|172 km SW of Port Hardy, BC/172 km SO de Port Hardy, BC",
    '20260710.0030004|2026-07-10T00:30:35.000Z|54.8574|-118.764|5|M|4.13|Suspected industry-related event, 35 km S of Grande Prairie, AB/Événement lié à l\'industrie soupconné, 35 km S de Grande Prairie, AB',
    '20260908.2214001|2026-09-08T22:14:20.000Z|49.5|-117.0|5|ML|3.64|19 km ESE of Harrop/Procter, BC, felt/19 km ESE de Harrop/Procter, BC, ressenti',
  ].join('\n');
  const [a, b, c] = parseFdsnText(body, 'nrcan');
  assert.deepEqual([a!.mag, a!.magType, a!.place], [4.84, "Mw'", '172 km SW of Port Hardy, BC']);
  assert.deepEqual([b!.mag, b!.magType, b!.place], [4.13, 'M', 'Suspected industry-related event, 35 km S of Grande Prairie, AB']);
  assert.deepEqual([c!.mag, c!.magType, c!.place], [3.64, 'ML', '19 km ESE of Harrop/Procter, BC, felt'], 'a place name with its own slash');
});

test('englishHalf: the halves meet at the middle slash; no slash or an even number keeps the place whole', () => {
  assert.equal(englishHalf('16 km SSE of Duncan, BC/16 km SSE de Duncan, BC'), '16 km SSE of Duncan, BC');
  assert.equal(englishHalf('13 km E of Harrop/Procter, BC/13 km E de Harrop/Procter, BC'), '13 km E of Harrop/Procter, BC');
  assert.equal(englishHalf('Southern Gulf Islands, BC'), 'Southern Gulf Islands, BC');
  assert.equal(englishHalf('North/East/South'), 'North/East/South', 'two slashes: no middle one');
  assert.equal(englishHalf('/French only'), '/French only', 'an empty English half keeps the whole');
});

test('englishHalf is NRCan’s only: another source’s slash stays', () => {
  const body = ['#EventID|Time|Latitude|Longitude|Depth/km|MagType|Magnitude|EventLocationName', 'x1|2026-09-29T11:59:05Z|47.9|-69.6|19|ML|1.1|North/South'].join('\n');
  assert.equal(parseFdsnText(body, 'nrcan')[0]!.place, 'North');
  assert.equal(parseFdsnText(body, 'knmi')[0]!.place, 'North/South');
});

// --- reading by header name changes nothing for the other sources ---

/** The pre-PF-5h reading: every column at its standard position. */
function positional(body: string, provider: string): Pick<RawObs, 'providerEventId' | 'eventTimeMs' | 'lat' | 'lon' | 'depth' | 'mag' | 'magType' | 'place'>[] {
  const out = [];
  for (const line of body.split('\n')) {
    const row = line.trim();
    if (!row || row.startsWith('#')) continue;
    const c = row.split('|');
    if (c.length < 5) continue;
    const eventTimeMs = parseUtcMs(c[1]);
    const lat = num(c[2]);
    const lon = num(c[3]);
    const providerEventId = (c[0] ?? '').trim();
    if (eventTimeMs == null || lat == null || lon == null || !providerEventId) continue;
    out.push({ providerEventId, eventTimeMs, lat, lon, depth: num(c[4]), mag: num(c[10]), magType: (c[9] ?? '').trim() || null, place: (c[12] ?? '').trim() || null });
  }
  void provider;
  return out;
}

const HEADERS = readFileSync(here('fixtures/fdsn-text-headers-2026-10-01.txt'), 'utf8')
  .split('## ')
  .slice(1)
  .map((block) => {
    const [id, ...lines] = block.split('\n');
    return { id: id!.trim(), body: lines.join('\n') };
  });

test('fdsn text: every source’s real header and row read by name exactly as by position, except NRCan’s', () => {
  const textSources = registry.filter((p) => p.parse === 'text').map((p) => p.id).sort();
  assert.deepEqual(HEADERS.map((h) => h.id).sort(), textSources, 'one block per FDSN text source in the registry');
  for (const { id, body } of HEADERS) {
    const byName = parseFdsnText(body, id).map(({ providerEventId, eventTimeMs, lat, lon, depth, mag, magType, place }) => ({ providerEventId, eventTimeMs, lat, lon, depth, mag, magType, place }));
    assert.equal(byName.length, 1, id);
    if (id === 'nrcan') {
      assert.deepEqual([byName[0]!.mag, byName[0]!.magType, byName[0]!.place], [0.75, 'MwN', '14 km NNW of Rivière-du-Loup, QC']);
      assert.deepEqual([positional(body, id)[0]!.mag, positional(body, id)[0]!.magType, positional(body, id)[0]!.place], [null, null, null], 'what the feed stored');
      continue;
    }
    assert.deepEqual(byName, positional(body, id), id);
  }
});

test('fdsn text: columns found by name, spaces and case ignored, with the spellings the nodes use', () => {
  const split = (h: string): string[] => h.replace(/^#/, '').split('|').map((s) => s.trim());
  assert.deepEqual(fdsnTextColumns(split('#EventID|Time|Latitude|Longitude|Depth/km|MagType|Magnitude|EventLocationName')), { id: 0, time: 1, lat: 2, lon: 3, depth: 4, magType: 5, mag: 6, place: 7 });
  const scedc = fdsnTextColumns(split('#EventID  | Time | Latitude | Longtitude   | Depth/km | Author | Catalog | ET | GT   | MagType | Magnitude | MagAuthor | EventLocationName'));
  assert.deepEqual(scedc, { id: 0, time: 1, lat: 2, lon: 3, depth: 4, magType: 9, mag: 10, place: 12 });
  const renass = fdsnTextColumns(split('# EventID | Time | Latitude | Longitude | Depth/km | Author | Catalog | Contributor | ContributorID | MagnitudeType | Magnitude | MagnitudeAuthor | EventLocationName | EventType'));
  assert.deepEqual(renass, { id: 0, time: 1, lat: 2, lon: 3, depth: 4, magType: 9, mag: 10, place: 12 });
  assert.equal(fdsnTextColumns(split('#EventID|Time|Latitude|Longitude|Depth/Km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType')).depth, 4, 'INGV');
  // No header (LMU writes it without the `#`), or one that does not name the location columns: standard positions.
  const standard = { id: 0, time: 1, lat: 2, lon: 3, depth: 4, magType: 9, mag: 10, place: 12 };
  assert.deepEqual(fdsnTextColumns([]), standard);
  assert.deepEqual(fdsnTextColumns(split('# generated by some node')), standard);
  // A named header without a column leaves it out.
  assert.deepEqual(fdsnTextColumns(split('#EventID|Time|Latitude|Longitude')), { id: 0, time: 1, lat: 2, lon: 3, depth: null, magType: null, mag: null, place: null });
});

test('rereadFdsnTextRow: a stored row read again from its fields is the row the answer gives', () => {
  for (const r of parseFdsnText(NRCAN_BODY, 'nrcan')) assert.deepEqual(rereadFdsnTextRow(r.fields, 'nrcan'), r, r.providerEventId);
  for (const { id, body } of HEADERS) {
    const [r] = parseFdsnText(body, id);
    if (Object.keys(r!.fields).every((k) => /^col\d+$/.test(k))) continue; // LMU: its fields are named by position
    assert.deepEqual(rereadFdsnTextRow(r!.fields, id), r, id);
  }
  assert.equal(rereadFdsnTextRow({}, 'nrcan'), null);
});

// --- NRCan publishes a revised magnitude under a new id ---

/** An NRCan row as the fixed parser reads it, from fields as the feed logged them. */
function nrcan(id: string, time: string, lat: number, lon: number, magType: string, mag: string): RawObs {
  const body = ['#EventID|Time|Latitude|Longitude|Depth/km|MagType|Magnitude|EventLocationName', `${id}|${time}|${lat}|${lon}|10|${magType}|${mag}|172 km SW of Port Hardy, BC/172 km SO de Port Hardy, BC`].join('\n');
  return parseFdsnText(body, 'nrcan')[0]!;
}

test('nrcan versions: a revised magnitude under the next id at the same origin is one event (2026-07-20)', () => {
  const NOW = Date.parse('2026-07-20T14:00:00Z');
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  // Logged 07:31 and 13:41 UTC; NRCan's list kept only the second.
  r.ingest(nrcan('20260720.0647001', '2026-07-20T06:47:09.000Z', 49.6116, -129.1818, "Mw'", '4.84'), iso(NOW));
  r.ingest(nrcan('20260720.0647002', '2026-07-20T06:47:09.000Z', 49.6116, -129.1818, "Mw'", '4.73'), iso(NOW));
  const live = [...map.values()].filter((n) => n.state === 'live');
  assert.equal(live.length, 1);
  assert.deepEqual(live[0]!.provenance.map((p) => p.nativeId).sort(), ['20260720.0647001', '20260720.0647002']);
});

test('nrcan versions: another place, or another source’s two ids, stay two events', () => {
  const NOW = Date.parse('2026-07-14T19:00:00Z');
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  // 20260714.1058001 and .1058004: the same minute, 4.3 km apart (NRCan relocated it): distinct by NRCan's own ids.
  r.ingest(nrcan('20260714.1058001', '2026-07-14T10:58:07.000Z', 50.5072, -130.2742, 'Mw', '4.17'), iso(NOW));
  r.ingest(nrcan('20260714.1058004', '2026-07-14T10:58:07.000Z', 50.48, -130.3173, 'mb', '4.54'), iso(NOW));
  assert.equal([...map.values()].filter((n) => n.state === 'live').length, 2);
  // INGV's two ids at one origin and place with magnitudes 0.3 apart: still two events (the rule is NRCan's only).
  const map2 = new Map<string, EventNode>();
  const r2 = new Resolver(map2, prio, cfg, NOW);
  const ingv = (id: string, mag: number): RawObs => ({
    provider: 'ingv', providerEventId: id, eventTimeMs: Date.parse('2026-07-14T10:00:00Z'), providerUpdatedMs: null, status: null,
    lat: 43.6, lon: 12.55, depth: 10, mag, magType: 'ML', place: 'Piobbico', knownAliasIds: [], fields: { EventID: id },
  });
  r2.ingest(ingv('46000001', 2.0), iso(NOW));
  r2.ingest(ingv('46000002', 2.3), iso(NOW));
  assert.equal([...map2.values()].filter((n) => n.state === 'live').length, 2);
});

// --- the one-time correction, epoch 2, on events as production held them on 2026-10-01 ---

const FIXTURE = readFileSync(here('fixtures/nrcan-event-map-2026-10-01.ndjson'), 'utf8').split('\n').filter(Boolean);
function fixtureMap(): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  for (const l of FIXTURE) {
    const n = JSON.parse(l) as EventNode;
    map.set(n.feedId, n);
  }
  return map;
}
/** The next aggregate run after data e67b8c5eb4 (head 01:56:29 UTC): event days from 2026-09-21 are not frozen. */
const RUN = Date.parse('2026-10-01T02:01:29.336Z');
const HEAD_SEQ = 195_862;
const FROZEN = ['efd_01M2YEQE60ZAB5C8PX3AWF67NR', 'efd_01M300PVTGR0XEDRF5JQRC3Z38'];
const nrcanRow = (n: EventNode) => n.provenance.find((r) => r.provider === 'nrcan')!;

function correct(map: Map<string, EventNode>, fromEpoch: number, nowMs = RUN): { log: LogBuffer; marker: ReturnType<typeof runCorrection>; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'correction-'));
  const log = new LogBuffer(HEAD_SEQ, iso(nowMs));
  const marker = runCorrection(root, map, prio, cfg, log, { nowMs, ingestTime: iso(nowMs), fromEpoch });
  return { log, marker, root };
}

test('correction: the fixture holds what production published — NRCan rows without magnitude, type or place', () => {
  const map = fixtureMap();
  const rows = [...map.values()].map(nrcanRow);
  assert.equal(rows.length, 9);
  for (const r of rows) {
    assert.deepEqual([r.mag, r.magType, r.place], [null, null, null], r.nativeId);
    assert.ok(r.fields['Magnitude'] && r.fields['MagType'] && r.fields['EventLocationName'], r.nativeId);
  }
  assert.equal(correctionFloor(RUN).fromDay, '2026-09-21');
  assert.equal(nrcanCorrections(map, correctionFloor(RUN).floorMs).length, 7, 'the two rows of 2026-09-20 are frozen');
});

test('correction epoch 2: a branch at epoch 1 gets the NRCan step alone; rows are filled where they are', () => {
  const map = fixtureMap();
  const before = new Map([...map.values()].map((n) => [n.feedId, { revision: n.revision, chosen: n.chosenProvider, mag: n.mag, rows: n.provenance.length }]));
  const { log, marker, root } = correct(map, 1);
  assert.equal(correctedEpoch(root), CORRECTION_EPOCH);
  rmSync(root, { recursive: true, force: true });
  assert.equal(CORRECTION_EPOCH, 2);
  assert.equal(marker.from_epoch, 1);
  assert.equal(marker.afad, null);
  assert.equal(marker.comcat_id, null);
  assert.deepEqual(marker.nrcan, { found: 7, filled: 7, chosen: 3, merged: 0, survivors: 0 });
  assert.equal(marker.from_day, '2026-09-21');
  // One schema-valid op:observe line per filled row, seq contiguous, the reason names the fix.
  assert.equal(log.lines.length, 7);
  assert.deepEqual(log.lines.map((l) => l.seq), log.lines.map((_, i) => HEAD_SEQ + 1 + i));
  for (const l of log.lines) {
    assert.ok(vObs(l), JSON.stringify(vObs.errors));
    assert.equal(l.op, 'observe');
    assert.equal(l.provider, 'nrcan');
    assert.equal(l.reason, NRCAN_FILLED_REASON);
    assert.ok(l.mag != null && l.magType != null && l.place != null);
  }
  assert.deepEqual([marker.first_seq, marker.last_seq], [HEAD_SEQ + 1, HEAD_SEQ + 7]);
  for (const n of map.values()) {
    const b = before.get(n.feedId)!;
    const r = nrcanRow(n);
    assert.equal(n.provenance.length, b.rows, 'no row moves');
    assert.equal(n.state, 'live');
    if (FROZEN.includes(n.feedId)) {
      assert.deepEqual([r.mag, r.magType, r.place, n.revision], [null, null, null, b.revision], `${n.feedId} is frozen`);
      continue;
    }
    assert.equal(r.mag, num(r.fields['Magnitude']), n.feedId);
    assert.equal(r.magType, r.fields['MagType'], n.feedId);
    assert.equal(r.place, englishHalf(String(r.fields['EventLocationName'])), n.feedId);
    assert.equal(n.revision, b.revision + 1, `${n.feedId}: every fill moves the revision`);
    assert.ok(n.lastSeq > HEAD_SEQ, n.feedId);
    assert.equal(n.lastIngestTime, iso(RUN));
    if (b.chosen === 'nrcan') {
      // NRCan-only events show the magnitude and place now.
      assert.equal(n.mag, r.mag);
      assert.equal(n.place, r.place);
    } else {
      // Another source still represents the event; its solution is unchanged.
      assert.equal(n.chosenProvider, b.chosen, n.feedId);
      assert.equal(n.mag, b.mag, n.feedId);
    }
  }
  const malbaie = map.get('efd_01M3PBAX5GZBZBZQS69ASD7FR6')!;
  assert.deepEqual([malbaie.mag, malbaie.magType, malbaie.place], [0.5, 'MwN', '5 km S of La Malbaie, QC']);
});

test('correction epoch 2: idempotent — a second run finds nothing; a branch at epoch 2 makes no step', () => {
  const map = fixtureMap();
  const first = correct(map, 1);
  const again = correct(map, 1, RUN + 300_000);
  assert.deepEqual(again.marker.nrcan, { found: 0, filled: 0, chosen: 0, merged: 0, survivors: 0 });
  assert.deepEqual(again.log.lines, []);
  const none = correct(fixtureMap(), 2);
  assert.deepEqual([none.marker.afad, none.marker.comcat_id, none.marker.nrcan, none.log.lines.length], [null, null, null, 0]);
  for (const x of [first, again, none]) rmSync(x.root, { recursive: true, force: true });
});

test('correction: a branch never corrected makes every step, the NRCan one included', () => {
  const map = fixtureMap();
  const { marker, root } = correct(map, 0);
  rmSync(root, { recursive: true, force: true });
  assert.equal(marker.afad?.found, 0);
  assert.deepEqual(marker.comcat_id, { merged: 0, survivors: 0 });
  assert.equal(marker.nrcan?.filled, 7);
});

test('correction epoch 2: the logged lines replay to the filled rows', () => {
  const map = fixtureMap();
  const { log, root } = correct(map, 1);
  rmSync(root, { recursive: true, force: true });
  const replayed = fixtureMap();
  const r = new Resolver(replayed, prio, cfg, RUN, { hotFloorMs: correctionFloor(RUN).floorMs });
  for (const l of log.lines) r.ingest(observationToRaw(l), l.ingest_time);
  for (const n of map.values()) {
    const m = replayed.get(n.feedId)!;
    assert.deepEqual(m.provenance.map((x) => [x.provider, x.nativeId, x.mag, x.magType, x.place, x.chosen]), n.provenance.map((x) => [x.provider, x.nativeId, x.mag, x.magType, x.place, x.chosen]), n.feedId);
  }
});
