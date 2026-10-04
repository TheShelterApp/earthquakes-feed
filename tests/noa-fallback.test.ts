import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Resolver } from '../src/dedup.js';
import { configMap, fetchProvider, liveLookbackMs, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, ProviderConfig } from '../src/types.js';
import type { FetchResult } from '../src/util.js';

// PF-5j-NOA: the node the FDSN registry lists for NOA, eida.gein.noa.gr, has answered every event query with 204
// since 2026-09-24 11:47 UTC, while NOA's second EIDA host eida2.gein.noa.gr serves the same catalogue under the same
// ids. The registry asks eida2 and keeps the registered node as the fallback.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const byId = (id: string): ProviderConfig => registry.find((p) => p.id === id)!;
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T21:00:00Z');
const BODY = readFileSync(here('fixtures/noa-eida2-fdsn-text-2026-10-01.txt'), 'utf8');
const ROWS = 12;

/** A fetcher that answers per host and records the hosts it was asked, in order. */
function hosts(answers: Record<string, FetchResult | Error>): { asked: string[]; fetcher: (url: string) => Promise<FetchResult> } {
  const asked: string[] = [];
  return {
    asked,
    fetcher: async (url) => {
      const host = new URL(url).host;
      asked.push(host);
      const a = answers[host];
      if (!a) throw new Error(`unexpected host ${host}`);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}
const ok = (body: string): FetchResult => ({ status: 200, body, latencyMs: 1 });
const empty: FetchResult = { status: 204, body: '', latencyMs: 1 };

test('noa: the registry asks eida2 first, the registered node second, for 7 days', () => {
  const p = byId('noa');
  assert.equal(new URL(p.base).host, 'eida2.gein.noa.gr');
  assert.equal(new URL(p.fallbackBase!).host, 'eida.gein.noa.gr');
  assert.equal(new URL(p.base).pathname, new URL(p.fallbackBase!).pathname);
  assert.equal(liveLookbackMs(p), 7 * DAY);
  // No other source has a fallback host.
  for (const x of registry.filter((r) => r.id !== 'noa')) assert.equal(x.fallbackBase, undefined, x.id);
});

test('noa: a base that answers with rows is the only host asked', async () => {
  const h = hosts({ 'eida2.gein.noa.gr': ok(BODY) });
  const out = await fetchProvider(byId('noa'), NOW, h.fetcher);
  assert.deepEqual(h.asked, ['eida2.gein.noa.gr']);
  assert.equal(out.obs.length, ROWS);
  assert.equal(out.status.ok, true);
  assert.equal(out.status.via, undefined);
  assert.ok(out.obs.every((o) => /^noa2026[a-z]{5}$/.test(o.providerEventId)));
  assert.ok(out.obs.every((o) => o.mag != null && o.magType === 'MLh' && !!o.place));
});

test('noa: an empty base hands over to the fallback, and status names the host that answered', async () => {
  const h = hosts({ 'eida2.gein.noa.gr': empty, 'eida.gein.noa.gr': ok(BODY) });
  const out = await fetchProvider(byId('noa'), NOW, h.fetcher);
  assert.deepEqual(h.asked, ['eida2.gein.noa.gr', 'eida.gein.noa.gr']);
  assert.equal(out.obs.length, ROWS);
  assert.deepEqual({ ok: out.status.ok, http: out.status.http_status, via: out.status.via }, { ok: true, http: 200, via: 'eida.gein.noa.gr' });
  // Both hosts get the same query.
  const urls: string[] = [];
  await fetchProvider(byId('noa'), NOW, async (url) => {
    urls.push(url);
    return urls.length === 1 ? empty : ok(BODY);
  });
  assert.equal(new URL(urls[0]!).search, new URL(urls[1]!).search);
  assert.equal(new URL(urls[0]!).searchParams.get('starttime'), '2026-09-24T21:00:00');
});

test('noa: a failing base hands over too; with no rows on either host the outcome is the base\'s own', async () => {
  const down = hosts({ 'eida2.gein.noa.gr': new Error('This operation was aborted'), 'eida.gein.noa.gr': ok(BODY) });
  const viaFallback = await fetchProvider(byId('noa'), NOW, down.fetcher);
  assert.equal(viaFallback.obs.length, ROWS);
  assert.equal(viaFallback.status.via, 'eida.gein.noa.gr');

  const http503 = hosts({ 'eida2.gein.noa.gr': { status: 503, body: '', latencyMs: 1 }, 'eida.gein.noa.gr': empty });
  const failed = await fetchProvider(byId('noa'), NOW, http503.fetcher);
  assert.deepEqual(http503.asked, ['eida2.gein.noa.gr', 'eida.gein.noa.gr']);
  assert.deepEqual({ ok: failed.status.ok, http: failed.status.http_status, via: failed.status.via }, { ok: false, http: 503, via: undefined });

  const quiet = hosts({ 'eida2.gein.noa.gr': empty, 'eida.gein.noa.gr': new Error('fetch failed') });
  const none = await fetchProvider(byId('noa'), NOW, quiet.fetcher);
  assert.deepEqual({ ok: none.status.ok, http: none.status.http_status, rows: none.status.events_returned }, { ok: true, http: 204, rows: 0 });
  assert.equal(none.obs.length, 0);
});

test('noa: a source without a fallback is asked once, whatever it answers', async () => {
  const h = hosts({ 'geofon.gfz.de': empty });
  const out = await fetchProvider(byId('geofon'), NOW, h.fetcher);
  assert.deepEqual(h.asked, ['geofon.gfz.de']);
  assert.equal(out.status.ok, true);
});

test('noa: the same ids from either host are one report each (no duplicate when the hosts swap)', async () => {
  const fromBase = await fetchProvider(byId('noa'), NOW, hosts({ 'eida2.gein.noa.gr': ok(BODY) }).fetcher);
  const fromFallback = await fetchProvider(byId('noa'), NOW, hosts({ 'eida2.gein.noa.gr': empty, 'eida.gein.noa.gr': ok(BODY) }).fetcher);
  const map = new Map<string, EventNode>();
  const first = fromBase.obs.map((o) => new Resolver(map, priorityMap(registry), configMap(registry), NOW).ingest(o, '2026-10-01T21:00:00.000Z'));
  assert.equal(first.filter((r) => r.changed).length, ROWS);
  const live = (): number => [...map.values()].filter((n) => n.state === 'live').length;
  const before = live();
  const again = fromFallback.obs.map((o) => new Resolver(map, priorityMap(registry), configMap(registry), NOW).ingest(o, '2026-10-01T21:05:00.000Z'));
  assert.equal(again.filter((r) => r.changed).length, 0);
  assert.equal(live(), before);
});
