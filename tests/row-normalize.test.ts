import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { featureToNode, nodeToFeature } from '../src/bitemporal.js';
import { parseFdsnText } from '../src/fdsn.js';
import { loadRegistry } from '../src/providers.js';
import { AFAD_LEGACY_OFFSET_MS, iscUntrustedMagnitude, normalizeRowTimes, normalizeRows } from '../src/row-normalize.js';
import type { EventNode } from '../src/types.js';

// ISC's preliminary bulletin gives Geoscience Australia's (AUST) automatic Mw as many events' magnitude, 1-3 units high
// in a large quake's aftershock sequence; AFAD rows stored before 2026-10-01 are 3 h early (PF-5e). Fixtures: ISC's
// FDSN text answer of 2026-11-08 for 2025-09-18 18:58-19:09 (M5+) and 2025-08-22 05:18:00-05:19:30, and eight lines of
// the archives 2025-08 / 2025-09 as published.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const ISC_TEXT = readFileSync(here('fixtures/isc-fdsn-text-2026-11-08.txt'), 'utf8');
const lines = (): EventNode[] =>
  readFileSync(here('fixtures/isc-afad-archive-2025.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => featureToNode(JSON.parse(l)));
const byId = (nodes: EventNode[], id: string): EventNode => nodes.find((n) => n.feedId === id)!;

test('ISC: AUST moment magnitudes are read without a magnitude; times and every other magnitude as sent', () => {
  const rows = parseFdsnText(ISC_TEXT, 'isc');
  assert.equal(rows.length, 10);
  const get = (id: string) => rows.find((r) => r.providerEventId === id)!;
  // "Mw 8.22 AUST" on DSN's hypocentre, 10 minutes after the Kamchatka Mw 7.86: an aftershock NEIC puts at mb 5.2-5.8.
  const phantom = get('644158618');
  assert.equal(phantom.eventTimeMs, Date.parse('2025-09-18T19:08:09.910Z'));
  assert.equal(phantom.mag, null);
  assert.equal(phantom.magType, null);
  assert.equal(phantom.fields['Magnitude'], '8.22');
  assert.equal(phantom.fields['MagAuthor'], 'AUST');
  // "Mw 7.02 AUST" for the Drake Passage aftershock of 05:18:56 (ComCat us6000r2z8, mb 5.1).
  assert.equal(get('643915176').mag, null);
  assert.equal(get('643915176').eventTimeMs, Date.parse('2025-08-22T05:18:56.640Z'));
  // "Mw 6.03 AUST" for the Scotia Sea quake ComCat lists at mb 5.4 (us7000qx2n).
  assert.equal(get('644158089').mag, null);
  // The mainshock (GCMT), KRSC's Ml, NEIC's mb: kept.
  assert.deepEqual([get('644156780').mag, get('644156780').magType], [7.86, 'MW']);
  assert.deepEqual([get('646754433').mag, get('646754433').magType], [5.1, 'Ml']);
  assert.deepEqual([get('644179391').mag, get('644179391').magType], [5.8, 'mb']);
  // Another provider's AUST magnitude is not touched (the rule is about ISC's preferred magnitude).
  assert.equal(parseFdsnText(ISC_TEXT, 'scedc').find((r) => r.providerEventId === '644158618')!.mag, 8.22);
});

test('iscUntrustedMagnitude: ISC rows, AUST, moment magnitudes only', () => {
  assert.equal(iscUntrustedMagnitude('isc', { MagAuthor: 'AUST', MagType: 'Mw' }), true);
  assert.equal(iscUntrustedMagnitude('isc', { MagAuthor: 'AUST', MagType: 'Mww' }), true);
  assert.equal(iscUntrustedMagnitude('isc', { MagAuthor: 'AUST', MagType: 'ML' }), false);
  assert.equal(iscUntrustedMagnitude('isc', { MagAuthor: 'GCMT', MagType: 'MW' }), false);
  assert.equal(iscUntrustedMagnitude('emsc', { MagAuthor: 'AUST', MagType: 'Mw' }), false);
  assert.equal(iscUntrustedMagnitude('isc', {}), false);
});

test('normalizeRows: published ISC and AFAD rows corrected, representatives re-derived, nothing else', () => {
  const input = lines();
  const snapshot = JSON.stringify(input);
  const res = normalizeRows(input, registry);
  assert.equal(JSON.stringify(input), snapshot, 'the input is not changed');
  assert.deepEqual(res.counts, {
    afad_retimed: 2,
    afad_joined_kept: 1,
    isc_magnitude_dropped: 4,
    isc_magnitude_dropped_chosen: 2,
    events_changed: 6,
    day_changed: 1,
  });
  assert.equal(res.rows.length, input.length);
  assert.deepEqual(res.rows.map((n) => n.feedId), input.map((n) => n.feedId));

  // The ISC-only "M8.22" and "M7.02": no magnitude now, at the time ISC gives.
  for (const [id, t] of [
    ['efd_01K5F3KWM0CN8NNFVEV282F820', '2025-09-18T19:08:09.910Z'],
    ['efd_01K383EHD0ADW7TXXAA4G3X7D2', '2025-08-22T05:18:56.640Z'],
  ] as const) {
    const n = byId(res.rows, id);
    assert.equal(n.mag, null);
    assert.equal(n.magType, null);
    assert.equal(n.eventTimeMs, Date.parse(t));
    assert.equal(n.provenance[0]!.fields['Magnitude'] !== undefined, true, 'fields keep the value');
    const f = nodeToFeature(n) as { properties: { mag: number | null; time: number } };
    assert.equal(f.properties.mag, null);
  }
  // ISC's AUST row inside EMSC's and GEOFON's events: dropped there; those events keep their own representative.
  const emsc = byId(res.rows, 'efd_01K1Q4MKB00S8RYJVM2E6B6QG9');
  assert.equal(emsc.chosenProvider, 'emsc');
  assert.equal(emsc.mag, 6.4);
  assert.equal(emsc.provenance.find((r) => r.provider === 'isc')!.mag, null);
  assert.equal(byId(res.rows, 'efd_01K1Q1EZCGGRSEQSE9S6CN0EKE').mag, 5.22);
  // ISC's GCMT magnitude: the same object back.
  const gcmt = 'efd_01K452RKQ0XHZFB9516GHVDBG2';
  assert.equal(byId(res.rows, gcmt), byId(input, gcmt));

  // AFAD: the Sindirgi M6.1 of 2025-08-10 at 16:53:46 UTC (19:53:46 Turkish time), not 13:53:46.
  const sindirgi = byId(res.rows, 'efd_01K2A44X601CH3XNB2DTHQVQHV');
  assert.equal(sindirgi.eventTimeMs, Date.parse('2025-08-10T16:53:46Z'));
  assert.equal(sindirgi.eventTimeMs - byId(input, sindirgi.feedId).eventTimeMs, AFAD_LEGACY_OFFSET_MS);
  assert.equal(sindirgi.mag, 6.1);
  // 23:54:54 stored, 02:54:54 the next day really: the day changes.
  assert.equal(byId(res.rows, 'efd_01K418WF10JX982M0H3WMWDY9G').eventTimeMs, Date.parse('2025-09-01T02:54:54Z'));
  // An AFAD row that joined EMSC's event at its wrong time stays (moving it out would mint an event).
  const joined = 'efd_01K1HKY9V0F6X9S6XZ3GDJVJ23';
  assert.deepEqual(res.afadJoined, [joined]);
  assert.equal(byId(res.rows, joined), byId(input, joined));
  assert.deepEqual(res.changed.sort(), [
    'efd_01K1Q1EZCGGRSEQSE9S6CN0EKE',
    'efd_01K1Q4MKB00S8RYJVM2E6B6QG9',
    'efd_01K2A44X601CH3XNB2DTHQVQHV',
    'efd_01K383EHD0ADW7TXXAA4G3X7D2',
    'efd_01K418WF10JX982M0H3WMWDY9G',
    'efd_01K5F3KWM0CN8NNFVEV282F820',
  ]);
});

test('normalizeRows is idempotent, and normalizeRowTimes is the same function', () => {
  const once = normalizeRows(lines(), registry);
  const twice = normalizeRows(once.rows, registry);
  assert.deepEqual(twice.changed, []);
  assert.equal(twice.counts.afad_joined_kept, 1);
  assert.deepEqual(twice.rows, once.rows);
  assert.equal(normalizeRowTimes, normalizeRows);
});
