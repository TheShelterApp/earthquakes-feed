import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nodeToFeature } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import { detailHourJson } from '../src/event-detail.js';
import { silentChangesAgainst } from '../src/live-sync.js';
import {
  NO_PARTITION_FORMAT,
  dayPartitionFile,
  dayPartitionText,
  ensurePartitionFormat,
  frozenBefore,
  loadPartitionFormat,
  partitionFormatProblems,
  writeDayPartition,
  type PartitionFormat,
} from '../src/partitions.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { AUTHOR_MODE_PROVIDERS, reviewStatusOfNode, reviewStatusOfRow } from '../src/review-status.js';
import { summaryFeats } from '../src/summaries.js';
import type { EventNode, RawObs } from '../src/types.js';

// PF-1 extras: `review_status` (automatic | reviewed) for the sources whose answer says it, on the surfaces derive
// rebuilds every run (the Pages day files included, since 2026-11-08); the NDJSON day partitions from the day
// knowledge/index/partition-format.json names on, so a frozen day keeps its bytes.

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

/** A renass node (automatic author) that USGS reviewed too: both rows say a status. */
function twoRowNode(): EventNode {
  const map = new Map();
  const r = new Resolver(map, priorityMap(registry), configMap(registry), NOW);
  const node = r.ingest(obs('renass', 'fr2026abc', { fields: { Author: 'scautoloc2@wvf01' } }), iso(NOW - 3600_000)).node;
  r.ingest(obs('usgs', 'us7000x', { status: 'reviewed', lat: 43.101, mag: 2.5, magType: 'ml' }), iso(NOW - 1800_000));
  return node;
}

const fmtFrom = (day: string | null): PartitionFormat => ({ version: 1, review_status_from: day });
const dayOf = (ms: number): string => iso(ms).slice(0, 10);
const prevDay = (day: string): string => dayOf(Date.parse(`${day}T00:00:00Z`) - 86_400_000);

test('opt-in: summaries and detail hours carry it, a plain feature does not', () => {
  const node = twoRowNode();
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
});

test('the Pages day file carries it on every day; the NDJSON partition only from review_status_from on', () => {
  const node = twoRowNode();
  const day = dayOf(node.eventTimeMs);
  type DayFile = { features: { properties: { review_status?: string; feed: { provenance: { provider: string; review_status?: string }[] } } }[] };
  for (const [label, fmt, partitionHasIt] of [
    ['no format yet', NO_PARTITION_FORMAT, false],
    ['a day before review_status_from', fmtFrom(dayOf(node.eventTimeMs + 86_400_000)), false],
    ['the day review_status_from names', fmtFrom(day), true],
    ['a day after review_status_from', fmtFrom(prevDay(day)), true],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'rs-'));
    try {
      const out = writeDayPartition(dir, day, [node], { publicV1: join(dir, 'v1'), nowMs: NOW, headIngestTime: iso(NOW), fmt });
      // (a) the Pages day file, whatever the format.
      const pages = JSON.parse(readFileSync(join(dir, 'v1', 'events', `${day}.geojson`), 'utf8')) as DayFile;
      const f = pages.features[0]!;
      assert.equal(f.properties.review_status, reviewStatusOfNode(node), `${label}: Pages event`);
      const rows = f.properties.feed.provenance;
      assert.equal(rows.find((r) => r.provider === 'renass')?.review_status, 'automatic', `${label}: Pages renass row`);
      assert.equal(rows.find((r) => r.provider === 'usgs')?.review_status, 'reviewed', `${label}: Pages usgs row`);
      // (b) the NDJSON partition.
      const ndjson = readFileSync(dayPartitionFile(dir, day), 'utf8');
      assert.equal(ndjson.includes('review_status'), partitionHasIt, `${label}: partition`);
      assert.equal(ndjson, JSON.stringify(nodeToFeature(node, { reviewStatus: partitionHasIt })) + '\n', label);
      // (c) the same bytes from the nodes alone.
      assert.equal(dayPartitionText([node], day, fmt), out.ndjson, `${label}: dayPartitionText`);
      assert.equal(out.ndjson, ndjson);
      // (f) and they pass validate's check 3c.
      assert.deepEqual(partitionFormatProblems(day, ndjson.split('\n'), fmt), [], label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('(d) ensurePartitionFormat fixes review_status_from once, at frozenBefore(now), and never moves it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-fmt-'));
  try {
    assert.deepEqual(loadPartitionFormat(dir), NO_PARTITION_FORMAT, 'absent: no day carries it');
    const first = ensurePartitionFormat(dir, NOW);
    assert.deepEqual(first, { version: 1, review_status_from: frozenBefore(NOW) });
    const file = join(dir, 'knowledge', 'index', 'partition-format.json');
    const bytes = readFileSync(file, 'utf8');
    assert.equal(bytes, JSON.stringify(first) + '\n');
    assert.deepEqual(loadPartitionFormat(dir), first);
    // Later runs, days later: the value stays, the file is not rewritten.
    const mtime = statSync(file).mtimeMs;
    assert.deepEqual(ensurePartitionFormat(dir, NOW + 30 * 86_400_000), first);
    assert.deepEqual(ensurePartitionFormat(dir, NOW + 30 * 86_400_000), first);
    assert.equal(readFileSync(file, 'utf8'), bytes);
    assert.equal(statSync(file).mtimeMs, mtime);
    // A file of another shape is an error, never a guess.
    writeFileSync(file, JSON.stringify({ version: 2, review_status_from: '2026-10-01' }));
    assert.throws(() => loadPartitionFormat(dir), /not a partition format/);
    writeFileSync(file, JSON.stringify({ version: 1, review_status_from: 'yesterday' }));
    assert.throws(() => ensurePartitionFormat(dir, NOW), /not a partition format/);
    writeFileSync(file, JSON.stringify({ version: 1, review_status_from: null }));
    assert.deepEqual(ensurePartitionFormat(dir, NOW), first, 'an explicit null is still unset: derive sets it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(e) silentChangesAgainst: a line differing only by review_status is no change; a magnitude change is, in either format', () => {
  const node = twoRowNode();
  const day = dayOf(node.eventTimeMs);
  const head = node.lastSeq;
  const plain = JSON.stringify(nodeToFeature(node));
  const withStatus = JSON.stringify(nodeToFeature(node, { reviewStatus: true }));
  assert.notEqual(plain, withStatus);
  for (const line of [plain, withStatus]) {
    assert.deepEqual(silentChangesAgainst(new Map([[node.feedId, line]]), [node], [day], head), [], 'the switch run');
  }
  const before = structuredClone(node);
  before.mag = (before.mag ?? 0) + 0.3;
  for (const line of [JSON.stringify(nodeToFeature(before)), JSON.stringify(nodeToFeature(before, { reviewStatus: true }))]) {
    assert.deepEqual(silentChangesAgainst(new Map([[node.feedId, line]]), [node], [day], head), [node.feedId], 'a real change');
  }
  // A change of the status itself, under the new format, is a change too.
  const reviewed = structuredClone(node);
  for (const r of reviewed.provenance) if (r.provider === 'renass') r.fields = { Author: 'jdoe' };
  const changed = JSON.stringify(nodeToFeature(reviewed, { reviewStatus: true }));
  assert.notEqual(changed, withStatus);
  assert.deepEqual(silentChangesAgainst(new Map([[node.feedId, changed]]), [node], [day], head), [node.feedId]);
});

test('(f) partitionFormatProblems: the field on a frozen-side day, or missing on a day that must carry it, is a problem', () => {
  const node = twoRowNode();
  const day = dayOf(node.eventTimeMs);
  const plain = JSON.stringify(nodeToFeature(node));
  const withStatus = JSON.stringify(nodeToFeature(node, { reviewStatus: true }));
  const later = fmtFrom(dayOf(node.eventTimeMs + 86_400_000));
  assert.equal(partitionFormatProblems(day, [withStatus], later).length, 1, 'a day before review_status_from carries it');
  assert.equal(partitionFormatProblems(day, [withStatus], NO_PARTITION_FORMAT).length, 1, 'no format yet, yet a line carries it');
  assert.match(partitionFormatProblems(day, [plain], fmtFrom(day))[0] ?? '', /review_status null, its row says/);
  assert.deepEqual(partitionFormatProblems(day, [plain], later), []);
  assert.deepEqual(partitionFormatProblems(day, [withStatus], fmtFrom(day)), []);
  // A row-level field alone on the frozen side is caught too.
  const rowOnly = JSON.parse(withStatus) as { properties: Record<string, unknown> };
  delete rowOnly.properties['review_status'];
  assert.equal(partitionFormatProblems(day, [JSON.stringify(rowOnly)], later).length, 1);
  // A retired event, or one whose row says nothing, need not carry it.
  const retired = structuredClone(node);
  retired.state = 'superseded';
  assert.deepEqual(partitionFormatProblems(day, [JSON.stringify(nodeToFeature(retired))], fmtFrom(day)), []);
  const silent = structuredClone(node);
  for (const r of silent.provenance) {
    r.status = null;
    r.fields = {};
  }
  assert.deepEqual(partitionFormatProblems(day, [JSON.stringify(nodeToFeature(silent))], fmtFrom(day)), []);
});
