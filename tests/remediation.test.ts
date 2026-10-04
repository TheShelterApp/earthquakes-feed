import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resolver } from '../src/dedup.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import {
  MIN_WINDOW_MS,
  RAW_REMEDIATION_KIND,
  buildDayEdition,
  editionProblems,
  editionAssetName,
  fetchDayInWindows,
  nextFree,
  parseRawText,
  rawAssetName,
  rawText,
  remediationTag,
  remediationTasks,
  type WindowFetcher,
} from '../src/remediation.js';
import type { EventNode, RawObs } from '../src/types.js';

// FEED-DQ-1 / DQ-3: saturated backfill days are asked again in sub-day windows and published as additive day editions
// (src/remediation.ts); the archived day is never rewritten.

const registry = loadRegistry();
const DAY = '2025-07-30';
const D0 = Date.parse(`${DAY}T00:00:00Z`);
const HOUR = 3_600_000;

const kagsr = (id: string, tMs: number, over: Partial<RawObs> = {}): RawObs => ({
  provider: 'kagsr', providerEventId: id, eventTimeMs: tMs, providerUpdatedMs: null, status: null,
  lat: 52.5, lon: 160.3, depth: 20, mag: 4.6, magType: 'ML', place: 'Kamchatka', knownAliasIds: [], fields: { eventId: id }, ...over,
});

test('tasks: frozen saturated days only, Kamchatka first, then the Sındırgı days (AFAD), done ones skipped', () => {
  const cursor = {
    providers: {
      imo: { saturatedDays: ['2025-05-24', '2023-11-11'] },
      afad: { saturatedDays: ['2025-08-12', '2025-08-11', '2025-11-12'] },
      kagsr: { saturatedDays: ['2025-07-30'] },
      usgs: { saturatedDays: ['2026-09-30'] },
    },
  };
  const t = remediationTasks(cursor, '2026-09-24', new Set(['afad:2025-08-12']));
  assert.deepEqual(t.map((x) => `${x.provider}:${x.day}`), ['kagsr:2025-07-30', 'afad:2025-08-11', 'afad:2025-11-12', 'imo:2023-11-11', 'imo:2025-05-24']);
});

/** A source holding `times` on the day that answers at most `cap` rows per window (overflow = full). */
function source(times: number[], cap: number, fail?: (s: number) => boolean) {
  const calls: [number, number][] = [];
  const fetchWindow: WindowFetcher = async (s, e) => {
    calls.push([s, e]);
    if (fail?.(s)) return { obs: [], status: { ok: false, error: 'HTTP 503' }, overflow: false };
    // Like fetchProviderWindow: rows within the window ±60 s, overflow when the answer reaches the cap.
    const inWin = times.filter((t) => t >= s - 60_000 && t <= e + 60_000).map((t) => kagsr(`k${t}`, t));
    return { obs: inWin.slice(0, cap), status: { ok: true }, overflow: inWin.length >= cap };
  };
  return { calls, fetchWindow };
}

test('windows: a full window is halved until no window fills the cap; rows are deduplicated and kept to the day', async () => {
  // 600 events in the first hour (the aftershock storm), one an hour after; one row just before midnight.
  const times = [...Array.from({ length: 600 }, (_, i) => D0 + i * 6_000), ...Array.from({ length: 23 }, (_, i) => D0 + (i + 1) * HOUR + 30 * 60_000), D0 - 30_000];
  const src = source(times, 490);
  let clock = 0;
  const r = await fetchDayInWindows(DAY, src.fetchWindow, { spacingMs: 1_100, sleep: async (ms) => void (clock += ms), now: () => clock });
  assert.ok(r.ok);
  assert.equal(r.partial, false);
  assert.equal(r.rows.length, 623, 'every event of the day once, the row of the day before left out');
  assert.ok(r.rows.every((o) => o.eventTimeMs >= D0 && o.eventTimeMs < D0 + 24 * HOUR));
  assert.ok(r.windows.some((w) => w.split), 'the first 6-hour window was split');
  assert.equal(r.requests, src.calls.length);
  assert.ok(src.calls.every(([s, e]) => e > s && s >= D0 && e <= D0 + 24 * HOUR));
  assert.ok(clock >= (r.requests - 1) * 1_100 - 1, 'at least 1.1 s between requests');
});

test('windows: a window still full at the smallest size keeps its rows and marks the day partial; a failure fails the day', async () => {
  const dense = Array.from({ length: 2000 }, (_, i) => D0 + i * 150); // 2000 events in 5 minutes
  const r = await fetchDayInWindows(DAY, source(dense, 490).fetchWindow, { spacingMs: 0, sleep: async () => {} });
  assert.ok(r.ok);
  assert.equal(r.partial, true);
  assert.ok(r.windows.some((w) => w.saturated && Date.parse(w.end) - Date.parse(w.start) <= MIN_WINDOW_MS));
  const failed = await fetchDayInWindows(DAY, source([D0 + HOUR], 490, (s) => s >= D0 + 12 * HOUR).fetchWindow, { spacingMs: 0, sleep: async () => {} });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.rows, []);
  assert.match(failed.error!, /2025-07-30T12:00:00.000Z\.\.2025-07-30T18:00:00.000Z: HTTP 503/);
});

/** The archived day as a Resolver would have left it: nodes from the given reports. */
function archivedDay(raws: RawObs[]): Map<string, EventNode[]> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, priorityMap(registry), configMap(registry), D0 + 400 * 24 * HOUR, { hotFloorMs: 0, merge: false });
  for (const raw of raws) r.ingest(raw, '2026-07-20T00:00:00.000Z');
  const byDay = new Map<string, EventNode[]>();
  for (const n of map.values()) {
    const d = new Date(n.eventTimeMs).toISOString().slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(n);
  }
  return byDay;
}

test('edition: missing rows become events, known rows join or stay unchanged, the day is serialized like a partition', () => {
  const kept = kagsr('k1', D0 + HOUR);
  const usgs: RawObs = { ...kagsr('us7000abcd', D0 + 2 * HOUR + 1_000), provider: 'usgs', fields: { ids: ',us7000abcd,' }, mag: 5.0, magType: 'mb', providerUpdatedMs: D0 + 3 * HOUR };
  // EMSC's event 20 s before midnight, on the day before.
  const late: RawObs = { ...kagsr('20250729_0000999', D0 - 20_000), provider: 'emsc', fields: { unid: '20250729_0000999' } };
  const context = archivedDay([kept, usgs, late]);
  const rows = [kept, kagsr('k2', D0 + 2 * HOUR), kagsr('k3', D0 + 5 * HOUR, { lat: 53.9, lon: 158.9 }), kagsr('k4', D0 + 10_000)];
  const out = buildDayEdition({ day: DAY, context, rows, registry, nowMs: Date.parse('2026-10-04T12:00:00Z'), ingestTime: '2026-10-04T12:00:00.000Z', seqMarker: 202_999 });
  const s = out.stats;
  assert.deepEqual(
    { archived: s.archived_events, events: s.events, live: [s.live_before, s.live_after], changed: s.changed, unchanged: s.unchanged, new: s.new_events, retired: s.retired, off: s.off_day, neighbour: s.neighbour_joins },
    // k1 already there; k2 joins the ComCat event 1 s away; k3 is a new event; k4 joins EMSC's event of the day before
    // (23:59:40), which this edition does not carry.
    { archived: 2, events: 3, live: [2, 3], changed: 3, unchanged: 1, new: 1, retired: 0, off: 0, neighbour: 1 },
  );
  assert.deepEqual(s.provider_rows.kagsr, { before: 1, after: 3 });
  assert.equal(s.afad_retimed, 0);
  const lines = out.text.trim().split('\n').map((l) => JSON.parse(l) as { properties: { time: number } });
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((f) => f.properties.time), [...lines.map((f) => f.properties.time)].sort((a, b) => a - b), 'in event-time order');
  assert.ok(out.nodes.filter((n) => n.lastSeq === 202_999).length >= 2, 'changed nodes carry the run marker');
  assert.deepEqual(editionProblems(DAY, out.nodes), []);
  const twice = structuredClone(out.nodes[0]!);
  twice.feedId = 'efd_twice';
  assert.match(editionProblems(DAY, [...out.nodes, twice]).join('\n'), /is in two live events/);
  assert.match(editionProblems('2025-07-31', out.nodes).join('\n'), /is on 2025-07-30, not 2025-07-31/);
});

test('edition: AFAD rows the archive holds 3 h early are re-read first, so the re-asked day has one time base', () => {
  const AFAD_DAY = '2025-08-11';
  const A0 = Date.parse(`${AFAD_DAY}T00:00:00Z`);
  const afad = (id: string, trueMs: number, legacy: boolean): RawObs => {
    const fields = { eventID: id, date: new Date(trueMs).toISOString().slice(0, 19), latitude: '39.2', longitude: '28.1', depth: '7', type: 'ML', magnitude: '2.1', location: 'Sındırgı (Balıkesir)' };
    return { provider: 'afad', providerEventId: id, eventTimeMs: trueMs - (legacy ? 3 * HOUR : 0), providerUpdatedMs: null, status: null, lat: 39.2, lon: 28.1, depth: 7, mag: 2.1, magType: 'ML', place: 'Sındırgı (Balıkesir)', knownAliasIds: [], fields };
  };
  // The archive: one AFAD row stored 3 h early (true 10:00), one whose true time is 01:00 the NEXT day (stored 22:00),
  // and on the day BEFORE one whose true time is 01:00 on this day (stored 22:00 the day before).
  const archive = archivedDay([afad('900001', A0 + 10 * HOUR, true), afad('900002', A0 + 25 * HOUR, true), afad('900000', A0 + HOUR, true)]);
  assert.deepEqual([...archive.keys()].sort(), ['2025-08-10', AFAD_DAY]);
  // The source, asked again: the first one, the one of 01:00 and a missing one, at their real times.
  const rows = [afad('900000', A0 + HOUR, false), afad('900001', A0 + 10 * HOUR, false), afad('900003', A0 + 12 * HOUR, false)];
  const context = new Map([...archive].map(([d, ns]) => [d, ns.map((n) => structuredClone(n))]));
  const out = buildDayEdition({ day: AFAD_DAY, context, rows, registry, nowMs: Date.parse('2026-10-04T12:00:00Z'), ingestTime: '2026-10-04T12:00:00.000Z', seqMarker: 1 });
  const s = out.stats;
  assert.equal(s.afad_retimed, 2, 'the archived day\'s two legacy rows re-read; the day before is not re-published, so not re-read');
  assert.equal(s.unchanged, 1, 'the re-asked row matches its re-read archived copy');
  assert.equal(s.new_events, 1);
  assert.equal(s.neighbour_joins, 1, '900000 is the day before\'s event (its archive keeps publishing it)');
  assert.equal(s.off_day, 1, 'the row whose real time is on the next day stays in this edition, the day its archive gave it');
  // Every archived event is in exactly one published day: 900000 in the day before's archive, 900002 here.
  assert.deepEqual(out.nodes.map((n) => [n.provenance[0]!.nativeId, new Date(n.eventTimeMs).toISOString()]), [
    ['900001', '2025-08-11T10:00:00.000Z'],
    ['900003', '2025-08-11T12:00:00.000Z'],
    ['900002', '2025-08-12T01:00:00.000Z'],
  ]);
  assert.deepEqual(editionProblems(AFAD_DAY, out.nodes, archive), []);
  assert.match(editionProblems(AFAD_DAY, out.nodes).join('\n'), /is on 2025-08-12, not 2025-08-11/, 'without the archive, only the day counts');
});

test('edition check: a report the archived day did not hold live, live in a neighbouring archived day, is refused', () => {
  const late: RawObs = { ...kagsr('20250729_0000999', D0 - 20_000), provider: 'emsc', fields: { unid: '20250729_0000999' } };
  const archive = archivedDay([kagsr('k1', D0 + HOUR), late]);
  const edition = archive.get(DAY)!.map((n) => structuredClone(n));
  assert.deepEqual(editionProblems(DAY, edition, archive), []);
  // The day before's EMSC report pulled into this day's event (a fold across midnight): published twice.
  const pulled = structuredClone(archive.get('2025-07-29')![0]!);
  pulled.feedId = 'efd_pulled';
  pulled.eventTimeMs = D0 + 1_000;
  assert.match(editionProblems(DAY, [...edition, pulled], archive).join('\n'), /emsc:20250729_0000999 would be live twice: in efd_pulled here and in efd_\w+ \(2025-07-29\)/);
});

test('raw asset: header + rows round-trip; a count that disagrees is refused; names never repeat', () => {
  const rows = [kagsr('a', D0 + 1), kagsr('b', D0 + 2)];
  const h = { kind: RAW_REMEDIATION_KIND as typeof RAW_REMEDIATION_KIND, version: 1 as const, provider: 'kagsr', day: DAY, fetched_at: 'x', rows: 2, requests: 5, partial: false, windows: [] };
  assert.deepEqual(parseRawText(rawText(h, rows)), { header: h, rows });
  assert.throws(() => parseRawText(rawText({ ...h, rows: 3 }, rows)), /holds 2 rows, its header says 3/);
  assert.equal(remediationTag(DAY), 'remediation-2025');
  assert.equal(rawAssetName('kagsr', DAY), 'raw-kagsr-2025-07-30.ndjson.gz');
  assert.equal(rawAssetName('kagsr', DAY, 2), 'raw-kagsr-2025-07-30.g2.ndjson.gz');
  assert.equal(editionAssetName(DAY, 3), 'events-2025-07-30.e3.ndjson.gz');
  const names = new Set(['events-2025-07-30.e1.ndjson.gz', 'events-2025-07-30.e2.ndjson.gz']);
  assert.equal(nextFree(names, (n) => editionAssetName(DAY, n)), 3);
  assert.equal(nextFree(names, (n) => editionAssetName(DAY, n), 2), 3);
});
