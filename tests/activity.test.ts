import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ACTIVITY_BUDGET_HOURS,
  FROZEN_BUDGET_FACTOR,
  activityBudgetHours,
  frozenBudgetHours,
  frozenProviders,
  loadActivity,
  saveActivity,
  seedActivity,
  silentProviders,
  tlsLeafStatus,
  updateActivity,
} from '../src/activity.js';
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

// Round 14: FEED-3's blind spot, a source whose file stands still but still lists old rows (frozen).

test('frozen budget: three activity budgets by default, the registry value for a last-N list, none where silence has none', () => {
  assert.equal(FROZEN_BUDGET_FACTOR, 3);
  assert.equal(frozenBudgetHours(fdsn()), 36);
  assert.equal(frozenBudgetHours(fdsn({ activityBudgetHours: 72 })), 216);
  assert.equal(frozenBudgetHours(fdsn({ frozenBudgetHours: 216 })), 216);
  assert.equal(frozenBudgetHours(fdsn({ activityBudgetHours: null })), null);
  assert.equal(frozenBudgetHours(fdsn({ frozenBudgetHours: null })), null);
  assert.equal(frozenBudgetHours(fdsn({ liveActive: false })), null);
  const byId = new Map(registry.map((p) => [p.id, p]));
  for (const id of ['bgs', 'igepn', 'cwa']) assert.equal(frozenBudgetHours(byId.get(id)!), 216, id);
  for (const id of ['cenc', 'geosphere', 'bmkg', 'egypt', 'ga', 'tmd']) assert.equal(frozenBudgetHours(byId.get(id)!), 36, id);
  assert.deepEqual(registry.filter((p) => p.frozenBudgetHours !== undefined).map((p) => p.id).sort(), ['bgs', 'cwa', 'igepn']);
});

test('frozenProviders: rows whose newest origin stands past window + frozen budget; never an empty, failed or windowed answer', () => {
  const list = fdsn({ id: 'list', supportsTimeRange: false });
  const lastN = fdsn({ id: 'lastn', supportsTimeRange: false, frozenBudgetHours: 216 });
  const late = fdsn({ id: 'late', lookbackDays: 8 });
  const providers = [list, lastN, late, fdsn({ id: 'empty' }), fdsn({ id: 'failed' }), fdsn({ id: 'exempt', activityBudgetHours: null })];
  const frozen = frozenProviders(
    {
      list: { ok: true, events_returned: 30, newestOriginMs: NOW - 85 * HOUR },
      lastn: { ok: true, events_returned: 32, newestOriginMs: NOW - 180 * HOUR },
      late: { ok: true, events_returned: 4, newestOriginMs: NOW - 200 * HOUR },
      empty: { ok: true, events_returned: 0, newestOriginMs: null },
      failed: { ok: false, newestOriginMs: null },
      exempt: { ok: true, events_returned: 3, newestOriginMs: NOW - 900 * HOUR },
    },
    providers,
    NOW,
  );
  assert.deepEqual(frozen, { list: { newest_origin: new Date(NOW - 85 * HOUR).toISOString(), newest_origin_age_hours: 85, window_hours: 48, budget_hours: 36, rows: 30 } });
  // At the threshold itself it is not frozen yet; a source the registry stopped asking is not reported.
  assert.deepEqual(frozenProviders({ list: { ok: true, events_returned: 1, newestOriginMs: NOW - 84 * HOUR } }, [list], NOW), {});
  assert.deepEqual(frozenProviders({ gone: { ok: true, events_returned: 1, newestOriginMs: 0 } }, [list], NOW), {});
  // An 8-day window: frozen only past 192 + 36 h.
  assert.deepEqual(Object.keys(frozenProviders({ late: { ok: true, events_returned: 4, newestOriginMs: NOW - 229 * HOUR } }, [late], NOW)), ['late']);
});

test('updateActivity: a pinned leaf read in this run replaces the kept one; a run without one keeps it', () => {
  const prev = { tmd: { lastNonEmptyAt: NOW - HOUR, sinceMs: 0, tlsLeaf: { notAfterMs: 1, issuer: 'old', subject: 'old', seenAt: 0 } } };
  const leaf = { notAfterMs: Date.parse('2026-10-09T01:59:47Z'), issuer: 'GlobalSign GCC R6 AlphaSSL CA 2025', subject: '*.tmd.go.th' };
  const next = updateActivity(prev, { tmd: { ok: true, events_returned: 20 } }, NOW, { tmd: leaf });
  assert.deepEqual(next.tmd, { lastNonEmptyAt: NOW, sinceMs: 0, tlsLeaf: { ...leaf, seenAt: NOW } });
  const kept = updateActivity(next, { tmd: { ok: false } }, NOW + HOUR);
  assert.deepEqual(kept.tmd!.tlsLeaf, { ...leaf, seenAt: NOW });
  assert.deepEqual(tlsLeafStatus(kept.tmd!.tlsLeaf!, Date.parse('2026-10-06T00:00:00Z')), {
    not_after: '2026-10-09T01:59:47.000Z',
    days_left: 3.1,
    issuer: 'GlobalSign GCC R6 AlphaSSL CA 2025',
    subject: '*.tmd.go.th',
    seen_at: new Date(NOW).toISOString(),
  });
});

test('status v2: a frozen source keeps ok, gains frozen, and is listed in frozenProviders; tls_leaves pass through', () => {
  const raw = {
    generated: '2026-10-06T00:00:00.000Z',
    head_seq: 1,
    degraded: ['bgs'],
    silent: {},
    frozen: { bgs: { newest_origin: '2026-09-25T00:00:00.000Z', newest_origin_age_hours: 264.5, window_hours: 48, budget_hours: 216, rows: 40 } },
    tls_leaves: { tmd: { not_after: '2026-10-09T01:59:47.000Z', days_left: 3.1, issuer: 'x', subject: 'y', seen_at: '2026-10-06T00:00:00.000Z' } },
    providers: { bgs: { ok: true, events_returned: 40, newest_origin: '2026-09-25T00:00:00.000Z' }, usgs: { ok: true, events_returned: 400 } },
  };
  const v2 = enrichStatusV2(raw, { generatedMs: Date.parse(raw.generated), expectedIntervalSeconds: 300, staleAfterSeconds: 1800, health: {} }) as Record<string, any>;
  assert.deepEqual(v2['frozenProviders'], ['bgs']);
  assert.equal(v2['providers'].bgs.frozen, true);
  assert.equal(v2['providers'].bgs.ok, true);
  assert.equal(v2['providers'].bgs.newest_origin, '2026-09-25T00:00:00.000Z');
  assert.equal(v2['providers'].usgs.frozen, false);
  assert.deepEqual(v2['tls_leaves'], raw.tls_leaves);
});
