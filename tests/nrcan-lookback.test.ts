import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOT_WINDOW_DAYS, QUERY_LOOKBACK_MS } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { configMap, fetchProvider, liveLookbackMs, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, ProviderConfig } from '../src/types.js';

// PF-5h (6): Earthquakes Canada publishes many events more than 2 days after their origin, past the live query's
// 2-day lookback. On 2026-10-01, 12 of the 57 events of its 8-day answer had reached the feed through no source.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const byId = (id: string): ProviderConfig => registry.find((p) => p.id === id)!;
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T01:59:00Z');
const NRCAN_BODY = readFileSync(here('fixtures/nrcan-fdsn-text-2026-10-01.txt'), 'utf8');

test('lookback: NRCan asks for 7 days, every other FDSN source keeps 2', () => {
  assert.equal(liveLookbackMs(byId('nrcan')), 7 * DAY);
  assert.equal(QUERY_LOOKBACK_MS, 2 * DAY);
  for (const p of registry.filter((x) => x.adapter === 'fdsn' && x.id !== 'nrcan')) {
    assert.equal(liveLookbackMs(p), QUERY_LOOKBACK_MS, p.id);
    assert.equal(p.lookbackDays, undefined, `${p.id} has no lookbackDays`);
  }
});

test('lookback: capped at the hot window; zero, negative or missing falls back to 2 days', () => {
  const p = byId('geofon');
  assert.equal(liveLookbackMs({ ...p, lookbackDays: 30 }), HOT_WINDOW_DAYS * DAY);
  assert.equal(liveLookbackMs({ ...p, lookbackDays: 0 }), QUERY_LOOKBACK_MS);
  assert.equal(liveLookbackMs({ ...p, lookbackDays: -3 }), QUERY_LOOKBACK_MS);
  assert.equal(liveLookbackMs({ ...p, lookbackDays: 3 }), 3 * DAY);
});

test('lookback: the live NRCan query starts 7 days back and the answer parses as before', async () => {
  const urls: string[] = [];
  const out = await fetchProvider(byId('nrcan'), NOW, async (url) => {
    urls.push(url);
    return { status: 200, body: NRCAN_BODY, latencyMs: 1 };
  });
  assert.equal(urls.length, 1);
  const q = new URL(urls[0]!).searchParams;
  assert.equal(q.get('starttime'), '2026-09-24T01:59:00');
  assert.equal(q.get('format'), 'text');
  assert.equal(out.status.ok, true);
  assert.equal(out.obs.length, 47);
  // The answer reaches back 7 days: rows older than 2 days are the ones the 2-day query missed.
  const older = out.obs.filter((o) => o.eventTimeMs < NOW - 2 * DAY);
  assert.ok(older.length >= 40, `rows older than 2 days: ${older.length}`);
  assert.ok(out.obs.every((o) => o.eventTimeMs >= NOW - 7 * DAY));
});

test('lookback: another FDSN source still asks for 2 days', async () => {
  const urls: string[] = [];
  await fetchProvider(byId('geofon'), NOW, async (url) => {
    urls.push(url);
    return { status: 204, body: '', latencyMs: 1 };
  });
  assert.equal(new URL(urls[0]!).searchParams.get('starttime'), '2026-09-29T01:59:00');
});

test('lookback: asking the same rows again every run changes nothing; a late row joins or mints once', async () => {
  // The 7-day answer is re-read every run: a row the feed already holds is a no-op, so the longer window adds no
  // churn and no duplicate; a row the 2-day window never saw enters once.
  const out = await fetchProvider(byId('nrcan'), NOW, async () => ({ status: 200, body: NRCAN_BODY, latencyMs: 1 }));
  const map = new Map<string, EventNode>();
  const resolver = new Resolver(map, priorityMap(registry), configMap(registry), NOW);
  const first = out.obs.map((o) => resolver.ingest(o, '2026-10-01T02:00:00.000Z'));
  assert.equal(first.filter((r) => r.changed).length, 47);
  const ids = new Set([...map.values()].filter((n) => n.state === 'live').map((n) => n.feedId));
  const again = out.obs.map((o) => new Resolver(map, priorityMap(registry), configMap(registry), NOW).ingest(o, '2026-10-01T02:05:00.000Z'));
  assert.equal(again.filter((r) => r.changed).length, 0, 'a second run over the same answer changes nothing');
  assert.deepEqual(new Set([...map.values()].filter((n) => n.state === 'live').map((n) => n.feedId)), ids);
});
