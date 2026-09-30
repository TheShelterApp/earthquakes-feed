import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { eventDayKey } from '../src/bitemporal.js';
import { CORRECTION_EPOCH, SWARM_CELL_ABSOLUTE } from '../src/config.js';
import {
  AFAD_LEGACY_OFFSET_MS,
  AFAD_MOVED_OUT_REASON,
  AFAD_RETIMED_REASON,
  CORRECTION_FOLD_LABEL,
  afadCorrections,
  correctedEpoch,
  correctionFloor,
  runCorrection,
} from '../src/correction.js';
import { afadQueryUrl, parseAfad } from '../src/custom.js';
import { Resolver } from '../src/dedup.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';

// PF-5e: AFAD's apiv2 times are UTC without a zone suffix. Until 2026-10-01 the adapter read them as Turkish local
// time (UTC+3), so every AFAD event was stored 3 h early and EMSC's AFAD-authored copy of each quake stood beside it.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);
const iso = (ms: number): string => new Date(ms).toISOString();
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');

// --- the parser ---

test('afad parser: `date` and `lastUpdateDate` are UTC (the real 2026-09-30 response)', () => {
  const rows = parseAfad(JSON.parse(readFileSync(here('fixtures/afad-events.sample.json'), 'utf8')), 'afad');
  assert.deepEqual(rows.map((r) => r.providerEventId), ['730047', '730046', '730045', '722255'], 'rows without a time, an id or a location are skipped');
  const r730046 = rows[1]!;
  assert.equal(iso(r730046.eventTimeMs), '2026-09-30T19:19:18.000Z', "EMSC's AFAD-authored copy says 19:19:18Z; the old parser stored 16:19:18Z");
  assert.equal(r730046.lat, 38.46667);
  assert.equal(r730046.lon, 39.21483);
  assert.equal(r730046.mag, 0.9);
  assert.equal(r730046.magType, 'ML');
  assert.equal(r730046.providerUpdatedMs, null);
  assert.equal(r730046.fields['date'], '2026-09-30T19:19:18', 'the original vocabulary is kept verbatim');
  const updated = rows[3]!;
  assert.equal(iso(updated.eventTimeMs), '2026-07-06T06:10:08.000Z');
  assert.equal(iso(updated.providerUpdatedMs!), '2026-07-06T06:57:15.424Z', 'logged at 06:57:42 UTC, 27 s after the update: UTC too');
  // The newest `date` at 20:51 UTC was 19:34:46: as Turkish time it would be 16:34:46Z, four hours of silence.
  assert.ok(Date.parse('2026-09-30T20:51:40Z') - rows[0]!.eventTimeMs < 90 * 60_000);
});

test('afad query: the bounds are the UTC window itself, with no local-time padding', () => {
  const base = 'https://servisnet.afad.gov.tr/apigateway/deprem/apiv2/event/filter';
  const url = afadQueryUrl(base, Date.parse('2026-09-28T20:00:00Z'), Date.parse('2026-09-30T20:00:00Z'));
  assert.equal(url, `${base}?start=2026-09-28%2020:00:00&end=2026-09-30%2020:00:00&orderby=timedesc&limit=500`);
});

// --- EMSC's authored copy in a dense cell ---

const TR_LAT = 39.21;
const TR_LON = 28.11;
const T0 = Date.parse('2026-09-30T12:00:00Z');
const NOW = T0 + 3_600_000;
function afad(id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider: 'afad', providerEventId: id, eventTimeMs: T0, providerUpdatedMs: null, status: null,
    lat: TR_LAT, lon: TR_LON, depth: 7, mag: 1.6, magType: 'ML', place: 'Sındırgı (Balıkesir)',
    knownAliasIds: [], fields: { eventID: id, date: iso(T0).slice(0, 19) }, ...over,
  };
}
function emsc(id: string, auth: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider: 'emsc', providerEventId: id, eventTimeMs: T0, providerUpdatedMs: T0 + 600_000, status: null,
    lat: Math.round(TR_LAT * 1e4) / 1e4, lon: Math.round(TR_LON * 1e4) / 1e4, depth: 7, mag: 1.6, magType: 'ml',
    place: 'WESTERN TURKEY', knownAliasIds: [], fields: { auth, unid: id }, ...over,
  };
}
/** A cell with more live events than SWARM_CELL_ABSOLUTE: a location join there needs a shared id. */
function denseCell(): { map: Map<string, EventNode>; r: Resolver } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, NOW);
  for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
    r.ingest(afad(`70${i}`, { eventTimeMs: T0 - (i + 1) * 120_000, lat: TR_LAT + (i % 5) * 0.002 }), iso(NOW));
  }
  return { map, r };
}

test('authored copy: in a dense cell AFAD and EMSC’s AFAD-authored copy of the same solution are one event, in both orders', () => {
  for (const order of ['afad-first', 'emsc-first'] as const) {
    const { map, r } = denseCell();
    const before = live(map).length;
    const a = afad('730100');
    const e = emsc('20260930_0000100', 'AFAD');
    for (const raw of order === 'afad-first' ? [a, e] : [e, a]) r.ingest(raw, iso(NOW));
    assert.equal(live(map).length, before + 1, order);
  }
});

test('authored copy: another author, or a different solution, keeps the dense-cell rule', () => {
  const cases: [string, RawObs][] = [
    ['EMSC copy of KOERI', emsc('20260930_0000101', 'KOERI')],
    ['EMSC own solution', emsc('20260930_0000102', 'EMSC')],
    ['AFAD-authored, 3 s apart', emsc('20260930_0000103', 'AFAD', { eventTimeMs: T0 + 3_000 })],
    ['AFAD-authored, ΔM 0.3', emsc('20260930_0000104', 'AFAD', { mag: 1.9 })],
  ];
  for (const [label, e] of cases) {
    const { map, r } = denseCell();
    const before = live(map).length;
    r.ingest(afad('730101'), iso(NOW));
    r.ingest(e, iso(NOW));
    assert.equal(live(map).length, before + 2, label);
  }
});

// --- the one-time correction (correction epoch 1) on events as production held them on 2026-09-30 ---

const FIXTURE = readFileSync(here('fixtures/afad-event-map-2026-09.ndjson'), 'utf8').split('\n').filter(Boolean);
function fixtureMap(): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  for (const l of FIXTURE) {
    const n = JSON.parse(l) as EventNode;
    map.set(n.feedId, n);
  }
  return map;
}
const RUN = Date.parse('2026-09-30T20:52:00Z');
const HEAD_SEQ = 191_992;

function correct(map: Map<string, EventNode>, nowMs = RUN): { log: LogBuffer; marker: ReturnType<typeof runCorrection>; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'correction-'));
  const log = new LogBuffer(HEAD_SEQ, iso(nowMs));
  const marker = runCorrection(root, map, prio, cfg, log, { nowMs, ingestTime: iso(nowMs) });
  return { log, marker, root };
}

test('correction: the fixture holds what production published — every AFAD row 3 h before its own `date`', () => {
  const map = fixtureMap();
  const afadRows = [...map.values()].flatMap((n) => n.provenance.filter((r) => r.provider === 'afad'));
  assert.equal(afadRows.length, 7);
  for (const r of afadRows) assert.equal(Date.parse(`${r.fields['date']}Z`) - r.eventTimeMs, AFAD_LEGACY_OFFSET_MS, r.nativeId);
  assert.equal(afadCorrections(map, correctionFloor(RUN).floorMs).length, 7);
});

test('correction: AFAD rows move to their real time and fold into the events they belong to', () => {
  const map = fixtureMap();
  const { log, marker, root } = correct(map);
  rmSync(root, { recursive: true, force: true });
  assert.deepEqual(marker.afad, { found: 7, retimed: 6, moved_out: 1, merged: 5, survivors: 5, day_changed: 2 });
  assert.equal(marker.epoch, CORRECTION_EPOCH);
  assert.equal(marker.from_day, '2026-09-20');
  assert.deepEqual(afadCorrections(map, correctionFloor(RUN).floorMs), [], 'no AFAD row is left 3 h early');
  for (const n of live(map)) {
    for (const r of n.provenance.filter((x) => x.provider === 'afad')) assert.equal(iso(r.eventTimeMs).slice(0, 19), r.fields['date'], r.nativeId);
  }
  const byRows = new Map(live(map).map((n) => [rowsOf(n), n]));
  // 730046 and EMSC's copy (auth AFAD, same second, same place): one event at 19:19:18.
  assert.equal(iso(byRows.get('afad:730046 emsc:20260930_0000241')!.eventTimeMs), '2026-09-30T19:19:18.000Z');
  // 729186 had joined EMSC's copy of another AFAD quake (729169, 26 s later at its wrong time): it leaves that
  // event and joins EMSC's copy of itself 3 h later; 729169 folds with its own copy.
  assert.ok(byRows.has('afad:729186 emsc:20260921_0000084'));
  assert.ok(byRows.has('afad:729169 emsc:20260921_0000022'));
  // 729496 folds into KOERI's and EMSC's own solutions of the quake (1 s, 3.3 km).
  assert.ok(byRows.has('afad:729496 emsc:20260924_0000012 koeri:koeri-20260924004656'));
  // 730047 has no copy yet: re-timed where it is.
  assert.equal(iso(byRows.get('afad:730047')!.eventTimeMs), '2026-09-30T19:34:46.000Z');
  // AFAD 729259 and 729260, 20 s apart at one place: EMSC copied 729260, and it goes to 729260, not to the one
  // corrected first (the folds wait until every row is at its real time).
  assert.ok(byRows.has('afad:729259'));
  assert.ok(byRows.has('afad:729260 emsc:20260921_0000381'));
  assert.equal(live(map).length, 7, '11 live events before, 729186 placed in one of its own, 5 folds');
  // A folded event's other id follows it.
  for (const n of map.values()) if (n.state === 'superseded') assert.equal(map.get(n.supersededBy!)?.state, 'live', n.feedId);
  // Lines: schema-valid, one seq each, the reasons name the correction.
  assert.deepEqual(log.lines.map((l) => l.seq), log.lines.map((_, i) => HEAD_SEQ + 1 + i));
  for (const l of log.lines) assert.ok(vObs(l), JSON.stringify(vObs.errors));
  assert.deepEqual(log.lines.map((l) => l.op), [
    'observe', 'tombstone', 'observe', 'observe', 'observe', 'observe', 'observe', 'observe',
    'merge', 'merge', 'merge', 'merge', 'merge',
    'correction', 'correction', 'correction', 'correction', 'correction',
  ]);
  assert.ok(log.lines.filter((l) => l.op === 'observe').every((l) => l.reason === AFAD_RETIMED_REASON));
  assert.equal(log.lines.find((l) => l.op === 'tombstone')!.reason, AFAD_MOVED_OUT_REASON);
  assert.ok(log.lines.filter((l) => l.op === 'correction').every((l) => l.reason!.startsWith(`${CORRECTION_FOLD_LABEL}: absorbed efd_`)));
  assert.equal(marker.first_seq, HEAD_SEQ + 1);
  assert.equal(marker.last_seq, HEAD_SEQ + log.lines.length);
  // Every live event carries its change as its last line.
  for (const n of live(map)) if (n.provenance.some((r) => r.provider === 'afad')) assert.ok(n.lastSeq > HEAD_SEQ, n.feedId);
});

test('correction: an event that moves to the next UTC day is filed under that day', () => {
  const map = fixtureMap();
  correct(map);
  const n729169 = live(map).find((n) => n.provenance.some((r) => r.nativeId === '729169'))!;
  assert.equal(eventDayKey(n729169.eventTimeMs), '2026-09-21', 'stored 2026-09-20 22:23:03, happened 2026-09-21 01:23:03');
});

test('correction: idempotent — a second run finds nothing and writes nothing; the marker says it ran', () => {
  const map = fixtureMap();
  const first = correct(map);
  assert.equal(correctedEpoch(first.root), CORRECTION_EPOCH);
  const again = correct(map, RUN + 300_000);
  assert.equal(again.marker.afad.found, 0);
  assert.deepEqual(again.log.lines, []);
  rmSync(first.root, { recursive: true, force: true });
  rmSync(again.root, { recursive: true, force: true });
});

test('correction: frozen days keep their old time — only event days from now − 10 days are touched', () => {
  const map = fixtureMap();
  // Five days later, 2026-09-20 … 09-24 are frozen: 729169 (stored 09-20), 729186, 729259, 729260 (09-21) and
  // 729496 (09-23) stay.
  const later = Date.parse('2026-10-05T20:52:00Z');
  const { marker, root } = correct(map, later);
  rmSync(root, { recursive: true, force: true });
  assert.equal(marker.from_day, '2026-09-25');
  assert.equal(marker.afad.found, 2);
  for (const id of ['729169', '729186', '729259', '729260', '729496']) {
    const row = [...map.values()].flatMap((n) => n.provenance).find((r) => r.nativeId === id)!;
    assert.equal(Date.parse(`${row.fields['date']}Z`) - row.eventTimeMs, AFAD_LEGACY_OFFSET_MS, id);
  }
});

test('correction: the logged lines replay to the corrected events', () => {
  const map = fixtureMap();
  const { log, root } = correct(map);
  rmSync(root, { recursive: true, force: true });
  // Replaying the correction's op:observe lines on the published state moves the rows the same way (a replay folds
  // after each line, so the 729259 / 729260 pair and the row that moved out are left out here).
  const replayed = fixtureMap();
  const r = new Resolver(replayed, prio, cfg, RUN, { hotFloorMs: correctionFloor(RUN).floorMs });
  for (const l of log.lines.filter((x) => x.op === 'observe' && !['729186', '729259', '729260'].includes(x.provider_event_id))) r.ingest(observationToRaw(l), l.ingest_time);
  for (const id of ['730046', '729496', '730047']) {
    const a = live(map).find((n) => n.provenance.some((x) => x.nativeId === id))!;
    const b = live(replayed).find((n) => n.provenance.some((x) => x.nativeId === id))!;
    assert.equal(rowsOf(a), rowsOf(b), id);
    assert.equal(a.eventTimeMs, b.eventTimeMs, id);
  }
});

// --- the correction's swarm guard counts a cell over the 7-day hot window, as the regular pass does ---

/** An AFAD report as the pre-2026-10-01 parser stored it: 3 h before its own `date`. */
function legacyAfad(id: string, trueMs: number, lat: number, lon: number, mag: number): RawObs {
  const fields = { eventID: id, date: iso(trueMs).slice(0, 19), latitude: String(lat), longitude: String(lon), depth: '7', type: 'ML', magnitude: String(mag), location: 'Sivrice (Elazığ)' };
  return {
    provider: 'afad', providerEventId: id, eventTimeMs: trueMs - AFAD_LEGACY_OFFSET_MS, providerUpdatedMs: null, status: null,
    lat, lon, depth: 7, mag, magType: 'ML', place: 'Sivrice (Elazığ)', knownAliasIds: [], fields,
  };
}

test('correction: a cell busy only before the hot window is not a swarm cell for the correction’s folds', () => {
  for (const fillerAgeDays of [8.5, 3] as const) {
    const map = new Map<string, EventNode>();
    const quake = RUN - 5 * 86_400_000;
    const r = new Resolver(map, prio, cfg, RUN, { hotFloorMs: correctionFloor(RUN).floorMs });
    for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
      r.ingest(afad(`71${i}`, { eventTimeMs: RUN - fillerAgeDays * 86_400_000 - i * 120_000, lat: 38.46 + (i % 5) * 0.002, lon: 39.21 }), iso(RUN));
    }
    r.ingest(legacyAfad('730200', quake, 38.4667, 39.2148, 1.3), iso(RUN));
    // KOERI's own solution of the quake: 1 s, 1.1 km, ΔM 0.2 — no shared id, so a swarm cell keeps the two apart.
    r.ingest({ ...emsc('koeri-x', 'KOERI', { eventTimeMs: quake + 1_000, lat: 38.4767, lon: 39.2148, mag: 1.5 }), provider: 'koeri', providerEventId: 'koeri-x', fields: {} }, iso(RUN));
    const before = live(map).length;
    const { root } = correct(map);
    rmSync(root, { recursive: true, force: true });
    const folded = before - live(map).length;
    assert.equal(folded, fillerAgeDays === 8.5 ? 1 : 0, `fillers ${fillerAgeDays} days old`);
  }
});
