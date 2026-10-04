import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ACTIVITY_BUDGET_HOURS, activityBudgetHours, loadActivity, saveActivity, seedActivity, silentProviders, updateActivity } from '../src/activity.js';
import { isNoData } from '../src/fdsn.js';
import { fetchProvider, loadRegistry } from '../src/providers.js';
import { enrichStatusV2 } from '../src/status-v2.js';
import type { ProviderConfig } from '../src/types.js';
import type { FetchResult } from '../src/util.js';

// FEED-3: an HTTP 404 is an error unless the query asks nodata=404, and a source that keeps answering with no rows
// past its activity budget is reported silent (src/activity.ts).

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-04T10:00:00Z');

const fdsn = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'x', name: 'X', priority: 1, active: true, adapter: 'fdsn', parse: 'text', queryFormat: 'text',
  base: 'https://example.test/fdsnws/event/1/query', supportsTimeRange: true, refreshSeconds: 300, license: 'CC-BY-4.0',
  attribution: 'X', doi: null, contact: 'https://example.test', ...over,
});
const answer = (status: number, body = ''): ((url: string) => Promise<FetchResult>) => async () => ({ status, body, latencyMs: 1 });

test('isNoData: 204 always, 404 only when the query asks nodata=404', () => {
  assert.equal(isNoData({}, 204), true);
  assert.equal(isNoData({}, 404), false);
  assert.equal(isNoData({ params: { nodata: '404' } }, 404), true);
  assert.equal(isNoData({ params: { nodata: '404' } }, 204), true);
  assert.equal(isNoData({}, 200), false);
  assert.equal(isNoData({ params: { nodata: '404' } }, 410), false);
});

test('live fetch: a 404 is an error (the query path is gone), unless the source asks nodata=404', async () => {
  const gone = await fetchProvider(fdsn(), NOW, answer(404, 'Not Found'));
  assert.equal(gone.status.ok, false);
  assert.equal(gone.status.http_status, 404);
  assert.equal(gone.status.error, 'HTTP 404');
  const asked = await fetchProvider(fdsn({ params: { nodata: '404' } }), NOW, answer(404));
  assert.deepEqual(asked.status, { ok: true, http_status: 404, latency_ms: 1, events_returned: 0 });
  const quiet = await fetchProvider(fdsn(), NOW, answer(204));
  assert.deepEqual(quiet.status, { ok: true, http_status: 204, latency_ms: 1, events_returned: 0 });
});

test('no source in the registry asks nodata=404 today (a 404 from any of them is an error)', () => {
  for (const p of registry) assert.notEqual(p.params?.['nodata'], '404', p.id);
});

test('activity budget: 12 h by default, the registry value for a quiet source, none for an exempt or non-live one', () => {
  assert.equal(DEFAULT_ACTIVITY_BUDGET_HOURS, 12);
  assert.equal(activityBudgetHours(fdsn()), 12);
  assert.equal(activityBudgetHours(fdsn({ activityBudgetHours: 72 })), 72);
  assert.equal(activityBudgetHours(fdsn({ activityBudgetHours: null })), null);
  assert.equal(activityBudgetHours(fdsn({ liveActive: false })), null);
  assert.equal(activityBudgetHours(fdsn({ activityBudgetHours: 0 })), 12, 'a non-positive value falls back to the default');
});

test('registry budgets: KNMI and LMU exempt, ETHZ / IPMA / NRCan / USP 72 h, every other live source the default', () => {
  const byId = new Map(registry.map((p) => [p.id, p]));
  assert.equal(activityBudgetHours(byId.get('knmi')!), null);
  assert.equal(activityBudgetHours(byId.get('lmu')!), null);
  assert.equal(activityBudgetHours(byId.get('isc')!), null, 'ISC is not asked on the live path');
  for (const id of ['ethz', 'ipma', 'nrcan', 'usp']) assert.equal(activityBudgetHours(byId.get(id)!), 72, id);
  const special = new Set(['knmi', 'lmu', 'isc', 'ethz', 'ipma', 'nrcan', 'usp']);
  for (const p of registry.filter((x) => x.active && !special.has(x.id))) assert.equal(activityBudgetHours(p), 12, p.id);
});

test('updateActivity: rows move lastNonEmptyAt to now; an empty or failed answer keeps it; a new source starts its clock', () => {
  const prev = { a: { lastNonEmptyAt: NOW - 5 * HOUR, sinceMs: NOW - 100 * HOUR }, b: { lastNonEmptyAt: NOW - 5 * HOUR, sinceMs: NOW - 100 * HOUR } };
  const next = updateActivity(prev, { a: { ok: true, events_returned: 3 }, b: { ok: true, events_returned: 0 }, c: { ok: false } }, NOW);
  assert.deepEqual(next.a, { lastNonEmptyAt: NOW, sinceMs: NOW - 100 * HOUR });
  assert.deepEqual(next.b, prev.b);
  assert.deepEqual(next.c, { lastNonEmptyAt: null, sinceMs: NOW });
  assert.deepEqual(prev.a, { lastNonEmptyAt: NOW - 5 * HOUR, sinceMs: NOW - 100 * HOUR }, 'the previous index is not mutated');
});

test('silentProviders: past the budget only, counted from the last rows or from the clock start', () => {
  const providers = [fdsn({ id: 'active' }), fdsn({ id: 'edge' }), fdsn({ id: 'quiet', activityBudgetHours: 72 }), fdsn({ id: 'exempt', activityBudgetHours: null }), fdsn({ id: 'never' }), fdsn({ id: 'unknown' })];
  const index = {
    active: { lastNonEmptyAt: NOW - 13 * HOUR, sinceMs: NOW - 1000 * HOUR },
    edge: { lastNonEmptyAt: NOW - 12 * HOUR, sinceMs: NOW - 1000 * HOUR },
    quiet: { lastNonEmptyAt: NOW - 50 * HOUR, sinceMs: NOW - 1000 * HOUR },
    exempt: { lastNonEmptyAt: NOW - 900 * HOUR, sinceMs: NOW - 1000 * HOUR },
    never: { lastNonEmptyAt: null, sinceMs: NOW - 20 * HOUR },
    gone: { lastNonEmptyAt: NOW - 900 * HOUR, sinceMs: NOW - 1000 * HOUR },
  };
  const silent = silentProviders(index, providers, NOW);
  assert.deepEqual(Object.keys(silent).sort(), ['active', 'never']);
  assert.deepEqual(silent.active, { last_non_empty_at: '2026-10-03T21:00:00.000Z', counted_from: '2026-08-23T18:00:00.000Z', silent_hours: 13, budget_hours: 12 });
  assert.deepEqual(silent.never, { last_non_empty_at: null, counted_from: '2026-10-03T14:00:00.000Z', silent_hours: 20, budget_hours: 12 });
  // A quiet source crosses its own 72 h, not the default.
  assert.deepEqual(Object.keys(silentProviders({ quiet: { lastNonEmptyAt: NOW - 73 * HOUR, sinceMs: 0 } }, providers, NOW)), ['quiet']);
});

/** A status-history line as aggregate wrote it. */
const line = (iso: string, providers: Record<string, { ok: boolean; events_returned?: number }>): string => JSON.stringify({ generated: iso, head_seq: 1, providers });

test('seedActivity: the last run with rows per source, from every month file in order; unreadable lines are skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'activity-'));
  const hist = join(dir, 'status', 'history');
  mkdirSync(hist, { recursive: true });
  writeFileSync(
    join(hist, '2026-07.ndjson'),
    [
      line('2026-07-29T12:06:21.443Z', { egypt: { ok: true, events_returned: 4 }, noa: { ok: true, events_returned: 60 } }),
      line('2026-07-29T12:11:00.000Z', { egypt: { ok: true, events_returned: 0 }, noa: { ok: false } }),
      '{not json',
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(hist, '2026-09.ndjson'),
    [
      line('2026-09-24T11:46:50.515Z', { egypt: { ok: true, events_returned: 0 }, noa: { ok: true, events_returned: 120 }, isc: { ok: true, events_returned: 0 } }),
      line('2026-09-24T12:01:43.000Z', { egypt: { ok: true, events_returned: 0 }, noa: { ok: true, events_returned: 0 }, isc: { ok: true, events_returned: 0 } }),
    ].join('\n') + '\n',
  );
  writeFileSync(join(hist, 'notes.txt'), 'ignored\n');
  const index = seedActivity(hist);
  assert.deepEqual(index, {
    egypt: { lastNonEmptyAt: Date.parse('2026-07-29T12:06:21.443Z'), sinceMs: Date.parse('2026-07-29T12:06:21.443Z') },
    noa: { lastNonEmptyAt: Date.parse('2026-09-24T11:46:50.515Z'), sinceMs: Date.parse('2026-07-29T12:06:21.443Z') },
    isc: { lastNonEmptyAt: null, sinceMs: Date.parse('2026-09-24T11:46:50.515Z') },
  });
  // With no index file the run seeds; once saved, the file is read back as it was written.
  const path = join(dir, 'provider_activity.json');
  const first = loadActivity(path, hist);
  assert.equal(first.seeded, true);
  saveActivity(path, first.index);
  const second = loadActivity(path, hist);
  assert.equal(second.seeded, false);
  assert.deepEqual(second.index, index);
  // No status history at all: an empty index, every clock starts at the first run.
  assert.deepEqual(seedActivity(join(dir, 'missing')), {});
});

test('status v2: a silent source keeps ok, gains silent + lastNonEmptyAt, and is listed in silentProviders', () => {
  const generatedMs = NOW;
  const raw = {
    generated: '2026-10-04T10:00:00.000Z',
    head_seq: 7,
    degraded: ['bmkg', 'tmd'],
    silent: { tmd: { last_non_empty_at: '2026-08-18T03:56:48.419Z', counted_from: '2026-07-05T05:42:10.043Z', silent_hours: 1134.1, budget_hours: 12 } },
    providers: { tmd: { ok: true, latency_ms: 2040, events_returned: 0 }, bmkg: { ok: false, error: 'HTTP 503', http_status: 503 } },
  };
  const v2 = enrichStatusV2(raw, {
    generatedMs, expectedIntervalSeconds: 300, staleAfterSeconds: 1800, health: { tmd: generatedMs },
    lastNonEmpty: { tmd: Date.parse('2026-08-18T03:56:48.419Z'), bmkg: generatedMs - HOUR },
  }) as Record<string, any>;
  assert.deepEqual(v2.silentProviders, ['tmd']);
  assert.deepEqual(v2.degradedProviders, ['bmkg', 'tmd']);
  assert.equal(v2.providers.tmd.ok, true);
  assert.equal(v2.providers.tmd.silent, true);
  assert.equal(v2.providers.tmd.error, null);
  assert.equal(v2.providers.tmd.lastNonEmptyAt, Date.parse('2026-08-18T03:56:48.419Z'));
  assert.equal(v2.providers.bmkg.silent, false);
  assert.equal(v2.silent.tmd.budget_hours, 12, 'the raw silent object passes through');
});
