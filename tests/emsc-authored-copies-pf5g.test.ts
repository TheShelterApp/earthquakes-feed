import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMSC_AUTHORED_COPIES, SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// PF-5g: EMSC's copies of CENC, CSN, GeoNet (GNS), INGV, KOERI, NCS (NDI), IG-EPN (QUI), OVSICORI (UNA) and SSN (UNM)
// solutions count as that agency's identity, like AFAD's, IGN's, NC's and SCSN's before (config EMSC_AUTHORED_COPIES
// holds the per-agency evidence and the codes that did not pass). It matters in a dense cell, where the feed joins two
// reports only on a shared id: in September 2026, 13 GeoNet events (the Milford Sound swarm), 44 OVSICORI events (off
// Puntarenas) and one KOERI event stood beside EMSC's copy of their own solution. Every row below is a production
// observation-log line (seq 114733..195644), unchanged.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const iso = (ms: number): string => new Date(ms).toISOString();
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');

const LINES = new Map<number, RawObs>();
for (const l of readFileSync(here('fixtures/emsc-authored-copies-pf5g-2026-09.ndjson'), 'utf8').split('\n').filter(Boolean)) {
  const o = JSON.parse(l) as Observation;
  LINES.set(o.seq, observationToRaw(o));
}
const line = (seq: number, over: Partial<RawObs> = {}): RawObs => {
  const raw = LINES.get(seq);
  assert.ok(raw, `seq ${seq}`);
  return { ...raw, ...over, fields: { ...raw.fields, ...(over.fields ?? {}) } };
};

/** A Resolver whose grid cell around `at` holds more live events than SWARM_CELL_ABSOLUTE (a third provider's, 2 min
 *  apart and older than `at`, none sharing an id with anything): a location join there needs a shared id. */
function denseCell(at: RawObs, nowMs: number): { map: Map<string, EventNode>; r: Resolver; base: number } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs);
  for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
    const id = `bg${String(i).padStart(3, '0')}`;
    r.ingest(
      {
        provider: 'renass', providerEventId: id, eventTimeMs: at.eventTimeMs - (i + 1) * 120_000, providerUpdatedMs: null, status: null,
        lat: at.lat + ((i % 5) - 2) * 0.0005, lon: at.lon + ((i % 3) - 1) * 0.0005, depth: 5, mag: 1.2, magType: 'ml',
        place: 'background', knownAliasIds: [], fields: {},
      },
      iso(nowMs),
    );
  }
  return { map, r, base: live(map).length };
}

/** [EMSC auth code, the agency's line, EMSC's copy of it]: each copy is the agency's solution to EMSC's rounding. */
const PAIRS: [string, number, number][] = [
  ['CENC', 190418, 190424], // CC.20260930184025.5 = 20260930_0000111, Yunnan M4.3
  ['CSN', 182666, 182667], // 384640 = 20260927_0000159 (EMSC's first version), Tarapacá M3.9
  ['GNS', 130186, 130192], // 2026p660977 = 20260902_0000239, Milford Sound swarm M3.1 (GeoNet's file cuts the 0.982 s)
  ['INGV', 182993, 183002], // 47259672 = 20260927_0000229, Tyrrhenian M2.3
  ['KOERI', 195643, 195644], // koeri-20260930232844 = 20260930_0000294, Marmara M2.8 (KOERI cuts the 0.8 s)
  ['NDI', 190550, 190556], // NCS = 20260930_0000078, Madhya Pradesh M3.5
  ['QUI', 167568, 167569], // igepn2026sksk = 20260920_0000004, Ecuador M3.5 (IG-EPN cuts the 0.2 s)
  ['UNA', 169821, 169830], // 1450049 = 20260920_0000320 (EMSC's first version), Cartago M2.8
  ['UNM', 191252, 191258], // SSN = 20260930_0000208, Veracruz M4.0
];

test('config: EMSC copies of AFAD, CENC, CSN, GNS, IGN, INGV, KOERI, NC, NDI, QUI, SCSN, UNA and UNM count as the agency’s identity', () => {
  assert.deepEqual([...EMSC_AUTHORED_COPIES].sort(), [
    ['AFAD', 'afad'],
    ['CENC', 'cenc'],
    ['CSN', 'csn'],
    ['GNS', 'geonet'],
    ['IGN', 'ign'],
    ['INGV', 'ingv'],
    ['KOERI', 'koeri'],
    ['NC', 'ncedc'],
    ['NDI', 'ncs'],
    ['QUI', 'igepn'],
    ['SCSN', 'scedc'],
    ['UNA', 'ovsicori'],
    ['UNM', 'mexico'],
  ]);
  // Checked and not added (config EMSC_AUTHORED_COPIES says why).
  for (const code of ['BMKG', 'GFZ', 'ReNaSS', 'ETHZ', 'NOA', 'IMO', 'PIVS', 'JMA', 'GSRAS', 'CN', 'AK']) assert.equal(EMSC_AUTHORED_COPIES.get(code), undefined, code);
});

test('each agency added: in a dense cell EMSC’s copy and the agency’s report are one event, in both orders', () => {
  for (const [code, agencySeq, copySeq] of PAIRS) {
    const agency = line(agencySeq);
    const copy = line(copySeq);
    assert.equal(copy.provider, 'emsc');
    assert.equal(copy.fields['auth'], code);
    assert.equal(EMSC_AUTHORED_COPIES.get(code), agency.provider, code);
    const nowMs = Math.max(agency.eventTimeMs, copy.eventTimeMs) + 3_600_000;
    for (const order of [[agency, copy], [copy, agency]]) {
      const { map, r, base } = denseCell(agency, nowMs);
      for (const raw of order) r.ingest(raw, iso(nowMs));
      const label = `${code}: ${order.map((o) => o.provider).join(' → ')}`;
      assert.equal(live(map).length, base + 1, label);
      const n = live(map).find((x) => x.aliases.includes(`${agency.provider}:${agency.providerEventId}`))!;
      assert.equal(rowsOf(n), [`${agency.provider}:${agency.providerEventId}`, `emsc:${copy.providerEventId}`].sort().join(' '), label);
    }
  }
});

test('the dense-cell rule still holds for EMSC’s own solution beside the same agency reports', () => {
  for (const [code, agencySeq, copySeq] of PAIRS) {
    const agency = line(agencySeq);
    const own = line(copySeq, { fields: { auth: 'EMSC' } });
    const nowMs = Math.max(agency.eventTimeMs, own.eventTimeMs) + 3_600_000;
    const { map, r, base } = denseCell(agency, nowMs);
    r.ingest(agency, iso(nowMs));
    r.ingest(own, iso(nowMs));
    assert.equal(live(map).length, base + 2, code);
  }
});

test('|ΔM| = 0.1 between a copy and the agency’s row counts, 0.2 does not (REID_MAG_TOLERANCE)', () => {
  // INGV 47259672 (ML 2.3) and EMSC's copy, the copy's magnitude moved by 0.1 and 0.2 in both directions.
  const agency = line(182993);
  const nowMs = agency.eventTimeMs + 3_600_000;
  for (const [mag, joins] of [[2.4, true], [2.2, true], [2.5, false], [2.1, false]] as const) {
    const { map, r, base } = denseCell(agency, nowMs);
    r.ingest(agency, iso(nowMs));
    r.ingest(line(183002, { mag }), iso(nowMs));
    assert.equal(live(map).length, base + (joins ? 1 : 2), `copy M${mag}`);
  }
});

test('GNS: a copy of a GeoNet origin counts while GeoNet’s row is that origin, not once GeoNet has replaced it', () => {
  // 2026p664447: GeoNet's first origin (M3.4) is EMSC's copy 20260903_0000354; five minutes later GeoNet replaced it
  // with an MLv 1.7 origin 8.9 km away (GeoNet's quake history shows both).
  const first = line(133199);
  const copy = line(133200);
  const revised = line(133210);
  assert.equal(copy.fields['auth'], 'GNS');
  const nowMs = revised.eventTimeMs + 3_600_000;
  // As production saw it: the copy joins GeoNet's event at its first origin and stays there after GeoNet's revision.
  {
    const { map, r, base } = denseCell(first, nowMs);
    for (const raw of [first, copy, revised]) r.ingest(raw, iso(nowMs));
    assert.equal(live(map).length, base + 1);
    assert.equal(rowsOf(live(map).find((n) => n.aliases.includes('geonet:2026p664447'))!), 'emsc:20260903_0000354 geonet:2026p664447');
  }
  // Had the feed first seen GeoNet's revised origin, the copy of the replaced one is not that row's solution.
  {
    const { map, r, base } = denseCell(first, nowMs);
    for (const raw of [revised, copy]) r.ingest(raw, iso(nowMs));
    assert.equal(live(map).length, base + 2);
  }
});

test('UNA: an EMSC id that EMSC later points at another OVSICORI event does not weld the two events', () => {
  // EMSC's 20260910_0000383 first copied OVSICORI 1449691 (09:19:35, M2.7), then OVSICORI 1449690 (09:20:16, M2.5,
  // 41 s and 3.4 km away). Replayed in log order in a dense cell: the copy joins 1449691 once OVSICORI's row equals it
  // and stays there; the two OVSICORI events stay apart (OVSICORI's own two ids, 41 s apart).
  const seqs = [146385, 146386, 147928, 147929, 148021, 148493, 150233];
  const first = line(146385);
  const nowMs = line(150233).eventTimeMs + 3_600_000;
  const { map, r, base } = denseCell(first, nowMs);
  for (const s of seqs) r.ingest(line(s), iso(nowMs));
  assert.equal(live(map).length, base + 2);
  const a = live(map).find((n) => n.aliases.includes('ovsicori:1449691'))!;
  const b = live(map).find((n) => n.aliases.includes('ovsicori:1449690'))!;
  assert.equal(rowsOf(a), 'emsc:20260910_0000383 ovsicori:1449691');
  assert.equal(rowsOf(b), 'ovsicori:1449690');
  assert.ok(r.whyNotMerged(a, b), 'a gate keeps the two OVSICORI events apart');
  const ids = live(map).flatMap((n) => n.provenance.map((p) => `${p.provider}:${p.nativeId}`));
  assert.equal(new Set(ids).size, ids.length, 'no provider id on two live events');
});

test('KOERI: EMSC’s copy of KOERI’s ML is not the solution of KOERI’s row that carries the Mw', () => {
  // koeri-20260902094114 lists ML 3.2 and Mw 3.0; the feed's row carries the Mw, EMSC's copy 20260902_0000177 the ML.
  const agency = line(129751);
  const copy = line(129752);
  assert.equal(agency.fields['ML'], '3.2');
  assert.equal(copy.mag, 3.2);
  const nowMs = agency.eventTimeMs + 3_600_000;
  const { map, r, base } = denseCell(agency, nowMs);
  r.ingest(agency, iso(nowMs));
  r.ingest(copy, iso(nowMs));
  assert.equal(live(map).length, base + 2);
});

test('a code that did not pass stays outside the rule: BMKG, even where its copy is identical', () => {
  // bmkg:20260826T134343Z and EMSC's BMKG-authored 20260826_0000187: the same time, place and magnitude.
  const agency = line(114758);
  const copy = line(114733);
  assert.equal(copy.fields['auth'], 'BMKG');
  const nowMs = agency.eventTimeMs + 3_600_000;
  const { map, r, base } = denseCell(agency, nowMs);
  r.ingest(agency, iso(nowMs));
  r.ingest(copy, iso(nowMs));
  assert.equal(live(map).length, base + 2);
});
