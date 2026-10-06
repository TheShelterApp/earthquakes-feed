import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nodeToFeature } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import { detailHourJson } from '../src/event-detail.js';
import { dayPartitionFile, writeDayPartition } from '../src/partitions.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { AUTHOR_MODE_PROVIDERS, reviewStatusOfNode, reviewStatusOfRow } from '../src/review-status.js';
import { summaryFeats } from '../src/summaries.js';
import type { RawObs } from '../src/types.js';

// PF-1 extras: `review_status` (automatic | reviewed) for the sources whose answer says it, on the surfaces derive
// rebuilds every run; the day partitions and Pages day files keep their bytes.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const NOW = Date.parse('2026-10-05T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const row = (provider: string, status: string | null, fields: Record<string, string> = {}) => ({ provider, status, fields });

test('a status the adapter already normalized is taken as it is, whatever its case; other values say nothing', () => {
  assert.equal(reviewStatusOfRow(row('usgs', 'reviewed')), 'reviewed');
  assert.equal(reviewStatusOfRow(row('usgs', 'automatic')), 'automatic');
  assert.equal(reviewStatusOfRow(row('ncs', 'Reviewed')), 'reviewed', "NCS's own spelling");
  assert.equal(reviewStatusOfRow(row('usgs', 'deleted')), null);
  assert.equal(reviewStatusOfRow(row('emsc', null, { source_catalog: 'EMSC-RTS' })), null, 'EMSC does not say it in what the feed reads');
  assert.equal(reviewStatusOfRow(row('ingv', null, { Author: 'SURVEY-INGV' })), null, 'not an author-mode source');
});

test('the SeisComP author rule agrees with each service\'s own evaluationMode on every event of the 2026-10-06 sample', () => {
  const fx = JSON.parse(readFileSync(here('fixtures/fdsn-author-modes-2026-10-06.json'), 'utf8')) as {
    rows: { provider: string; author: string; evaluationMode: string; events: number }[];
  };
  let events = 0;
  for (const r of fx.rows) {
    assert.ok(AUTHOR_MODE_PROVIDERS.has(r.provider));
    const expected = r.evaluationMode === 'automatic' ? 'automatic' : 'reviewed';
    assert.equal(reviewStatusOfRow(row(r.provider, null, { Author: r.author })), expected, `${r.provider} ${r.author}`);
    events += r.events;
  }
  assert.equal(events, 799);
  assert.ok(fx.rows.some((r) => r.evaluationMode === 'automatic' && r.provider === 'renass'));
});

test("ETHZ's automatic locators (the all-origins fixture of 2025-03-10) read automatic, its analysts reviewed", () => {
  const xml = readFileSync(here('fixtures/ethz-allorigins-2025-03-10.xml'), 'utf8');
  const origins = [...xml.matchAll(/<origin [^>]*>([\s\S]*?)<\/origin>/g)].map((m) => ({
    mode: /<evaluationMode>([^<]+)</.exec(m[1]!)?.[1],
    author: /<author>([^<]+)<\/author>/.exec(m[1]!)?.[1],
  }));
  const withBoth = origins.filter((o) => o.mode && o.author);
  assert.ok(withBoth.length >= 10);
  assert.ok(withBoth.some((o) => o.mode === 'manual') && withBoth.some((o) => o.mode === 'automatic'));
  for (const o of withBoth) {
    assert.equal(reviewStatusOfRow(row('ethz', null, { Author: o.author! })), o.mode === 'automatic' ? 'automatic' : 'reviewed', o.author);
  }
  assert.equal(reviewStatusOfRow(row('noa', null, { Author: '--' })), null);
  assert.equal(reviewStatusOfRow(row('renass', null)), null);
});

function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider,
    providerEventId: id,
    eventTimeMs: NOW - 2 * 3600_000,
    providerUpdatedMs: null,
    status: null,
    lat: 43.1,
    lon: 6.2,
    depth: 8,
    mag: 2.4,
    magType: 'MLv',
    place: 'Alpes-Maritimes',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
}

test('opt-in: summaries and detail hours carry it, the day partitions and Pages day files keep their bytes', () => {
  const map = new Map();
  const r = new Resolver(map, priorityMap(registry), configMap(registry), NOW);
  const node = r.ingest(obs('renass', 'fr2026abc', { fields: { Author: 'scautoloc2@wvf01' } }), iso(NOW - 3600_000)).node;
  r.ingest(obs('usgs', 'us7000x', { status: 'reviewed', lat: 43.101, mag: 2.5, magType: 'ml' }), iso(NOW - 1800_000));
  assert.equal(reviewStatusOfNode(node), node.chosenProvider === 'usgs' ? 'reviewed' : 'automatic');

  const plain = JSON.stringify(nodeToFeature(node));
  assert.ok(!plain.includes('review_status'), 'not without the option');
  const compact = summaryFeats([node], NOW)[0]!.feature as { properties: Record<string, unknown> };
  assert.equal(compact.properties['review_status'], reviewStatusOfNode(node));
  const detail = JSON.parse(detailHourJson(iso(node.eventTimeMs).slice(0, 13), [node])) as {
    features: { properties: { review_status?: string; feed: { provenance: { provider: string; review_status?: string }[] } } }[];
  };
  const rows = detail.features[0]!.properties.feed.provenance;
  assert.equal(rows.find((p) => p.provider === 'renass')?.review_status, 'automatic');
  if (rows.some((p) => p.provider === 'usgs')) assert.equal(rows.find((p) => p.provider === 'usgs')?.review_status, 'reviewed');

  const dir = mkdtempSync(join(tmpdir(), 'rs-'));
  try {
    const day = iso(node.eventTimeMs).slice(0, 10);
    writeDayPartition(dir, day, [node], { publicV1: join(dir, 'v1'), nowMs: NOW, headIngestTime: iso(NOW) });
    assert.ok(!readFileSync(dayPartitionFile(dir, day), 'utf8').includes('review_status'), 'the tree partition is unchanged');
    assert.ok(!readFileSync(join(dir, 'v1', 'events', `${day}.geojson`), 'utf8').includes('review_status'), 'the Pages day file too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
