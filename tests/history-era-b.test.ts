import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resolver } from '../src/dedup.js';
import { DEEP_WALK_FLOOR, deepHistory } from '../src/first-solutions-collect.js';
import { type BuildInput, type RawHeader, type RawInput, buildEdition } from '../src/history-build.js';
import {
  FETCH_MARGIN_MAG,
  type HistoryConfig,
  type HistoryEra,
  allPeriods,
  configProblems,
  dayMs,
  eraPeriods,
  fetchFloorOf,
  loadHistoryConfig,
  rawAssetName,
} from '../src/history-config.js';
import {
  type HistoryIndex,
  editionIsCurrent,
  emptyIndex,
  eraIsRemerged,
  newerNeighbour,
  pendingUnits,
  periodsToRemerge,
  periodsToSeal,
  remergeNeighbour,
} from '../src/history-index.js';
import { verifyEdition } from '../src/history-verify.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { rowLicense } from '../src/row-license.js';
import type { EventNode, RawObs } from '../src/types.js';
import { deterministicFeedId } from '../src/ulid.js';

// Era B (1973-1999, ComCat alone, M4.5+; platform plan 2026-11-08 streams/eraB.md): the shipped era entry, the per-era
// fetch margin and expectRows, the side index's floor, ISC-GEM rows' own licence, and no re-merge of a single-source era.
// `B` below is the entry as planned (eraB.md §0); the shipped-config test checks providers/history.json equals it.

const registry = loadRegistry();
const shipped = loadHistoryConfig();
/** The planned providers/history.json entry (eraB.md §0). */
const B: HistoryEra = { id: 'B', from: '1973-01-01', to: '2000-01-01', minMagnitude: 4.5, fetchMarginMag: 0, expectRows: true, sources: ['usgs'] };
const A: HistoryEra = { id: 'A', from: '2000-01-01', to: '2022-07-01', minMagnitude: null, sources: ['usgs', 'emsc'] };
const cfgOf = (eras: HistoryEra[]): HistoryConfig => ({
  enabled: true,
  boundary: '2023-07-06',
  eras,
  maxUnitsPerRun: 48,
  maxSecondsPerRun: 600,
  requestSpacingMs: 1100,
  timeoutMs: 90_000,
  pageLimits: { usgs: 20000 },
});

test('shipped config: valid, and no current era has a fetch floor (the per-era margin changes nothing in production)', () => {
  assert.deepEqual(configProblems(shipped, registry), []);
  for (const era of shipped.eras.filter((e) => e.id !== 'B')) {
    assert.equal(era.minMagnitude, null, `era ${era.id}`);
    assert.equal(fetchFloorOf(era), null, `era ${era.id}`);
    assert.equal(era.fetchMarginMag, undefined, `era ${era.id}`);
    assert.equal(era.expectRows, undefined, `era ${era.id}`);
  }
  const a = shipped.eras.find((e) => e.id === 'A')!;
  assert.deepEqual([a.from, a.to, a.minMagnitude], ['2000-01-01', '2022-07-01', null]);
});

const shippedB = shipped.eras.find((e) => e.id === 'B');
test('shipped config: era B is ComCat alone from 1973 to era A, fetched from its floor, every month expected to have rows', { skip: !shippedB && 'era B is not configured yet (its config PR enables this test)' }, () => {
  assert.deepEqual(shippedB, B);
  assert.equal(fetchFloorOf(shippedB!), 4.5);
  assert.equal(shipped.eras.find((e) => e.id === 'A')!.from, shippedB!.to, 'no gap and no overlap at the 1999-12 / 2000-01 seam');
});

test('fetchMarginMag: FETCH_MARGIN_MAG when absent, needs a floor, stays within 0..1; expectRows must be a boolean', () => {
  assert.equal(fetchFloorOf({ ...B, fetchMarginMag: undefined }), 4);
  assert.equal(fetchFloorOf({ ...B, fetchMarginMag: undefined }), 4.5 - FETCH_MARGIN_MAG);
  assert.equal(fetchFloorOf({ ...B, minMagnitude: 4.7, fetchMarginMag: 0.4 }), 4.3, 'rounded: 4.7 - 0.4 is 4.300000000000001 in binary');
  assert.equal(fetchFloorOf(B), 4.5);
  assert.equal(fetchFloorOf(A), null);
  const problems = (era: HistoryEra): string => configProblems(cfgOf([era]), registry).join('; ');
  assert.equal(problems(B), '');
  assert.match(problems({ ...A, fetchMarginMag: 0 }), /fetchMarginMag needs a minMagnitude/);
  assert.match(problems({ ...B, fetchMarginMag: -0.1 }), /fetchMarginMag must be a number from 0 to 1/);
  assert.match(problems({ ...B, fetchMarginMag: 1.5 }), /fetchMarginMag must be a number from 0 to 1/);
  assert.match(problems({ ...B, fetchMarginMag: '0' as unknown as number }), /fetchMarginMag must be a number from 0 to 1/);
  assert.match(problems({ ...B, expectRows: 'yes' as unknown as boolean }), /expectRows must be a boolean/);
});

test('era B periods: 324 months walked after every era-A month, newest first; 1999-12 joins era A\'s 2000-01 edition', () => {
  const ps = eraPeriods(B);
  assert.equal(ps.length, 324);
  assert.deepEqual([ps[0]!.key, ps.at(-1)!.key], ['1999-12', '1973-01']);
  const cfg = cfgOf([A, B]);
  assert.deepEqual(configProblems(cfg, registry), []);
  const all = allPeriods(cfg);
  assert.equal(all.findIndex((p) => p.key === '1999-12'), eraPeriods(A).length);
  const idx: HistoryIndex = emptyIndex('2023-07-06');
  for (const s of ['usgs', 'emsc']) {
    idx.raw.push({ source: s, period: '2000-01', tag: 'history-2000', asset: rawAssetName(s, '2000-01'), url: '', sha256: s, bytes: 1, rows: 1, provider_count: null, start: '', end: '', fetch_min_magnitude: null, fetched_at: '' });
  }
  idx.editions.push({
    period: '2000-01', edition: 1, era: 'A', tag: 'history-2000', asset: 'events-2000-01.e1.tar.zst', url: '', sha256: 'e', bytes: 1, events: 1, days: ['2000-01-01'],
    sources: ['usgs', 'emsc'], min_magnitude: null, built_from: [rawAssetName('usgs', '2000-01'), rawAssetName('emsc', '2000-01')], context: null, joined_newer: 0,
  });
  const nb = newerNeighbour(cfg, idx, all.find((p) => p.key === '1999-12')!);
  assert.equal(nb.kind, 'edition');
  if (nb.kind === 'edition') assert.deepEqual([nb.day, nb.edition.asset], ['2000-01-01', 'events-2000-01.e1.tar.zst']);
  assert.equal(pendingUnits(cfg, idx).filter((u) => u.period.eraId === 'B').length, 324, 'one unit (ComCat) per era-B month');
});

const dec99 = eraPeriods(B)[0]!;
const T = dayMs('1999-12-15') + 3600_000;
const obs = (id: string, over: Partial<RawObs> = {}): RawObs => ({
  provider: 'usgs', providerEventId: id, eventTimeMs: T, providerUpdatedMs: null, status: 'reviewed', lat: 40, lon: 30, depth: 10, mag: 4.5,
  magType: 'mb', place: 'x', knownAliasIds: [], fields: { net: 'us' }, ...over,
});
const head = (rows: number, floor: number | null): RawHeader => ({
  kind: 'earthquakes-feed/history-raw', version: 1, source: 'usgs', period: '1999-12', start: new Date(dec99.startMs).toISOString(), end: new Date(dec99.endMs).toISOString(),
  fetch_min_magnitude: floor, fetched_at: '2026-11-09T00:00:00.000Z', rows, response_rows: rows, parsed_rows: rows, duplicate_ids: 0, provider_count: rows, requests: 2,
  windows: [{ start: new Date(dec99.startMs).toISOString(), end: new Date(dec99.endMs).toISOString(), rows, count: rows, http: 200, ms: 1 }], user_agent: 't',
});
const raw = (rows: RawObs[], floor: number | null = 4.5): RawInput => ({ asset: rawAssetName('usgs', '1999-12'), sha256: 'x', header: head(rows.length, floor), rows });
const input = (raws: RawInput[], over: Partial<BuildInput> = {}): BuildInput => ({ period: dec99, era: B, edition: 1, raws, context: null, registry, boundary: '2023-07-06', archivedDays: new Set(), ...over });

test('era B build: a row at the floor is kept, none is below it, two ComCat events a second apart stay two, the output verifies', () => {
  const rows = [obs('usp1'), obs('ci1', { eventTimeMs: T + 1000, lat: 40.02, fields: { net: 'ci' } }), obs('usp2', { eventTimeMs: dayMs('1999-12-31') + 86_399_000, mag: 6.1 })];
  const out = buildEdition(input([raw(rows)]));
  assert.equal(out.meta.events, 3);
  assert.equal(out.meta.rows.below_floor, 0);
  assert.equal(out.meta.min_magnitude, 4.5);
  assert.deepEqual(verifyEdition(out.dayFiles, { period: dec99, boundary: '2023-07-06', archivedDays: new Set(), meta: out.meta, raws: [raw(rows)] }).errors, []);
  // Sealed with the re-merge on (the epoch raised before 1999-12 is sealed, decision A5): the same events, nothing folded.
  const merged = buildEdition(input([raw(rows)], { remergeEpoch: 1 }));
  assert.equal(merged.meta.events, 3, 'two ComCat ids never become one event');
  assert.deepEqual([merged.meta.merge?.epoch, merged.meta.merge?.merges.length], [1, 0]);
  assert.deepEqual([...merged.dayFiles.keys()], [...out.dayFiles.keys()]);
  // A raw fetched with the default margin (M4) is not this era's raw.
  assert.throws(() => buildEdition(input([raw(rows, 4)])), /fetched from M4, the era asks M4.5/);
});

test('era B build: a 1999-12-31 row that joins a 2000-01-01 era-A event is listed in joined_newer and never written', () => {
  const next = dayMs('2000-01-01');
  const map = new Map<string, EventNode>();
  new Resolver(map, priorityMap(registry), configMap(registry), next, { hotFloorMs: 0, merge: false }).ingest({ ...obs('em1', { eventTimeMs: next + 3000 }), provider: 'emsc', fields: {} }, '2026-10-06T00:00:00.000Z');
  const rows = [obs('uspEdge', { eventTimeMs: next - 4000 })];
  const out = buildEdition(input([raw(rows)], { context: { label: 'history-2000/events-2000-01.e1.tar.zst#01.ndjson', day: '2000-01-01', nodes: [...map.values()], sha256: 'cd'.repeat(32) } }));
  assert.equal(out.meta.events, 0);
  assert.equal(out.meta.rows.joined_newer, 1);
  assert.equal([...out.dayFiles.values()].join('').trim(), '');
});

test('era B ids: 1973 times are positive, so the feed id keeps its time prefix and sorts by time', () => {
  const a = deterministicFeedId(Date.parse('1973-01-01T00:00:10Z'), 1, 1);
  const b = deterministicFeedId(Date.parse('1999-12-31T23:59:50Z'), 1, 1);
  assert.match(a, /^efd_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.notEqual(a.slice(4, 14), '0000000000');
  assert.ok(a < b);
});

test('first-solutions: the side index never walks a deep month before DEEP_WALK_FLOOR (2000-01-01)', () => {
  const ed = (period: string, era: string) => ({ period, edition: 1, tag: `history-${period.slice(0, 4)}`, asset: `events-${period}.e1.tar.zst`, days: [`${period}-01`], built_from: [rawAssetName('usgs', period)], era });
  const months = ['2000-02', '2000-01', '1999-12', '1999-11'];
  const d = deepHistory({ boundary: '2000-03-01', editions: months.map((m) => ed(m, m < '2000' ? 'B' : 'A')) });
  assert.equal(DEEP_WALK_FLOOR, '2000-01-01');
  assert.equal(d.start, '2000-01-01');
  assert.deepEqual([...d.current.keys()].sort(), ['2000-01', '2000-02']);
});

test('row licence: a ComCat row whose preferred origin is ISC-GEM carries ISC-GEM\'s licence; every other row its provider\'s', () => {
  const usgs = registry.find((p) => p.id === 'usgs')!;
  const emsc = registry.find((p) => p.id === 'emsc')!;
  for (const net of ['iscgem', 'iscgemsup', 'ISCGEM']) {
    assert.deepEqual(rowLicense({ provider: 'usgs', fields: { net } }, usgs), {
      license: 'CC-BY-SA-3.0',
      attribution: 'ISC-GEM Global Instrumental Earthquake Catalogue (International Seismological Centre and GEM Foundation), via U.S. Geological Survey (ANSS ComCat)',
      doi: '10.31905/D808B825',
    });
  }
  // PDE and the ANSS regional networks ComCat serves stay US-PD (owner decision B3).
  for (const net of ['us', 'ak', 'nc', 'gcmt', undefined]) {
    assert.deepEqual(rowLicense({ provider: 'usgs', fields: net ? { net } : {} }, usgs), { license: 'US-PD', attribution: usgs.attribution, doi: usgs.doi });
  }
  assert.equal(rowLicense({ provider: 'emsc', fields: { net: 'iscgem' } }, emsc).license, emsc.license, 'only the provider that lists the catalogue');
  assert.deepEqual(rowLicense({ provider: 'nope', fields: {} }, undefined), { license: 'unknown', attribution: 'nope', doi: null });
});

test('row licence: the Resolver mints it per row (makeRow), so an ISC-GEM-preferred ComCat event is CC-BY-SA-3.0 in provenance', () => {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, priorityMap(registry), configMap(registry), Date.parse('2026-01-01T00:00:00Z'), { hotFloorMs: 0, merge: false });
  r.ingest(obs('iscgem17193343', { fields: { net: 'iscgem' } }), '2026-11-08T00:00:00.000Z');
  r.ingest(obs('usp0001', { eventTimeMs: T + 86_400_000 * 3, lat: -20 }), '2026-11-08T00:00:00.000Z');
  const rows = [...map.values()].flatMap((n) => n.provenance).sort((a, b) => (a.nativeId < b.nativeId ? -1 : 1));
  assert.deepEqual(rows.map((x) => [x.nativeId, x.license, x.doi]), [['iscgem17193343', 'CC-BY-SA-3.0', '10.31905/D808B825'], ['usp0001', 'US-PD', '10.5066/F7MS3QZH']]);
});

test('re-merge: era B months are never re-merged, at any epoch, and never re-sealed; 1999-12 still waits for a merged 2000-01', () => {
  assert.equal(eraIsRemerged(B), false);
  assert.equal(eraIsRemerged(A), true);
  if (shippedB) assert.equal(eraIsRemerged(shippedB), false);
  const cfg = cfgOf([A, B]);
  const idx: HistoryIndex = emptyIndex('2023-07-06');
  const raw1 = (s: string, period: string) => ({
    source: s, period, tag: `history-${period.slice(0, 4)}`, asset: rawAssetName(s, period), url: '', sha256: s, bytes: 1, rows: 1, provider_count: 1, start: '', end: '', fetch_min_magnitude: null, fetched_at: '',
  });
  const edition = (period: string, era: HistoryEra, merge_epoch?: number) => ({
    period, edition: 1, era: era.id, tag: `history-${period.slice(0, 4)}`, asset: `events-${period}.e1.tar.zst`, url: '', sha256: 'e', bytes: 1, events: 1, days: [`${period}-01`],
    sources: era.sources, min_magnitude: era.minMagnitude, built_from: era.sources.map((s) => rawAssetName(s, period)), context: null, joined_newer: 0,
    ...(merge_epoch != null ? { merge_epoch } : {}),
  });
  // Every month fetched and sealed at epoch 0 (no merge_epoch): era A's 2000-01 and every era-B month.
  for (const s of A.sources) idx.raw.push(raw1(s, '2000-01'));
  idx.editions.push(edition('2000-01', A));
  for (const p of eraPeriods(B)) {
    idx.raw.push(raw1('usgs', p.key));
    idx.editions.push(edition(p.key, B));
  }
  const all = allPeriods(cfg);
  const dec = all.find((p) => p.key === '1999-12')!;
  for (const epoch of [1, 2]) {
    const keys = periodsToRemerge(cfg, idx, epoch).map((p) => p.key);
    assert.ok(keys.includes('2000-01'), `epoch ${epoch}: era A is re-merged`);
    assert.equal(keys.filter((k) => k < '2000').length, 0, `epoch ${epoch}: no era-B month is re-merged (no e2)`);
  }
  assert.ok(eraPeriods(B).every((p) => editionIsCurrent(cfg, idx, p)), 'built_from-based: an unmerged era-B edition is current');
  assert.equal(periodsToSeal(cfg, idx).filter((p) => p.eraId === 'B').length, 0, 'nothing to re-seal');
  // A5: sealing 1999-12 with the epoch raised waits for 2000-01's merged edition, then joins it.
  assert.equal(remergeNeighbour(cfg, idx, [], dec, 1).kind, 'wait');
  idx.editions.push({ ...edition('2000-01', A, 1), edition: 2, asset: 'events-2000-01.e2.tar.zst' });
  const nb = remergeNeighbour(cfg, idx, [], dec, 1);
  assert.equal(nb.kind, 'edition');
  if (nb.kind === 'edition') assert.equal(nb.edition.asset, 'events-2000-01.e2.tar.zst');
});
