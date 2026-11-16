import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUSTOM_ADAPTERS } from '../src/custom.js';
import { CUSTOM_WINDOW_CAP, fetchProviderWindow, loadRegistry } from '../src/providers.js';
import type { RawObs } from '../src/types.js';

// FEED-PROV-L6: a custom adapter's backfill window counted as an overflow when the adapter returned 490 rows or more,
// counted before the window filter. An adapter that returns a whole file or list holds rows outside the window, so a long
// file read as an overflow and the walk narrowed for nothing. The count is now of the window's rows.

const DAY = 86_400_000;
const START = Date.parse('2026-06-01T00:00:00Z');
const END = START + DAY;
const row = (i: number, t: number): RawObs => ({
  provider: 'test-list', providerEventId: `e${i}`, eventTimeMs: t, providerUpdatedMs: null, status: null,
  lat: 0, lon: 0, depth: 10, mag: 2, magType: null, place: null, knownAliasIds: [], fields: {},
});

test('custom window: overflow counts the rows inside the window, not the whole file the adapter read', async () => {
  const base = loadRegistry().find((p) => p.id === 'igp')!;
  const cfg = { ...base, id: 'test-list' };
  let rows: RawObs[] = [];
  CUSTOM_ADAPTERS['test-list'] = async () => rows;
  try {
    // A year file: 600 rows, 12 of them in the window.
    rows = Array.from({ length: 600 }, (_, i) => row(i, i < 12 ? START + i * 3_600_000 : START - (i + 1) * DAY / 10));
    let r = await fetchProviderWindow(cfg, START, END);
    assert.equal(r.obs.length, 12);
    assert.equal(r.status.events_returned, 600, 'status still counts what the adapter returned');
    assert.equal(r.overflow, false, 'the rows outside the window say nothing about whether it fits');
    // A window that holds the cap (AFAD's 500-row answer) is an overflow, as before.
    rows = Array.from({ length: CUSTOM_WINDOW_CAP }, (_, i) => row(i, START + i * 100_000));
    r = await fetchProviderWindow(cfg, START, END);
    assert.equal(r.obs.length, CUSTOM_WINDOW_CAP);
    assert.equal(r.overflow, true);
  } finally {
    delete CUSTOM_ADAPTERS['test-list'];
  }
});
