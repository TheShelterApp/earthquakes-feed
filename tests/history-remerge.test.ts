import { REMERGE_RULES } from '../src/config.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nodeToFeature } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import { EDITION_KIND, type EditionMeta, belowFloor } from '../src/history-build.js';
import { type HistoryConfig, type HistoryEra, allPeriods, editionAssetName, historyTag } from '../src/history-config.js';
import { type EditionEntry, type HistoryIndex, currentEdition, editionIsCurrent, editionIsMerged, emptyIndex, periodsToRemerge, remergeNeighbour } from '../src/history-index.js';
import { LocalStore } from '../src/history-store.js';
import { verifyEdition } from '../src/history-verify.js';
import { type Ctx, adoptOrphans, emptyReport, remergePeriods } from '../src/history.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { remergeNodes, remergedDayFiles, mergeMeta } from '../src/remerge.js';
import { createTar } from '../src/tar.js';
import type { EventNode, RawObs } from '../src/types.js';

// The history re-merge (C4): new editions e(N+1) built from the current edition, the waits, adoption, the checks.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfgMap = configMap(registry);
const ERA: HistoryEra = { id: 'pilot', from: '2022-11-01', to: '2023-01-01', minMagnitude: null, sources: ['usgs', 'geofon', 'emsc'] };
const CFG: HistoryConfig = { enabled: true, boundary: '2023-07-06', eras: [ERA], maxUnitsPerRun: 4, maxSecondsPerRun: 600, requestSpacingMs: 1100, timeoutMs: 90_000, pageLimits: {} };
const NOW_ISO = '2026-11-08T10:00:00.000Z';
const KM = 111.195;
const hasZstd = ((): boolean => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

function obs(provider: string, id: string, t: number, over: Partial<RawObs> = {}): RawObs {
  return { provider, providerEventId: id, eventTimeMs: t, providerUpdatedMs: null, status: 'reviewed', lat: 10, lon: 120, depth: 10, mag: 6.1, magType: 'mww', place: 'test', knownAliasIds: [], fields: {}, ...over };
}
/** One event per report (as a month whose sources reached it one by one). */
function split(rows: RawObs[]): EventNode[] {
  const out: EventNode[] = [];
  for (const row of rows) {
    const one = new Map<string, EventNode>();
    new Resolver(one, prio, cfgMap, Date.parse(NOW_ISO), { hotFloorMs: 0, merge: false }).ingest(row, NOW_ISO);
    for (const n of one.values()) {
      while (out.some((o) => o.feedId === n.feedId)) n.feedId = `${n.feedId}X`;
      n.firstSeenSeq = 0;
      n.lastSeq = 0;
      out.push(n);
    }
  }
  return out;
}
const quake = (t: number, tag: string): RawObs[] => [
  obs('usgs', `us${tag}`, t, { fields: { ids: `,us${tag},` } }),
  obs('geofon', `gfz${tag}`, t + 2_000, { lat: 10 + 22 / KM, mag: 6.0, magType: 'mw' }),
  obs('emsc', `em${tag}`, t + 3_000, { lat: 10 - 18 / KM, mag: 5.9, magType: 'mw' }),
];

/** Write edition 1 of `period` (a tar.zst in the LocalStore) and its index entry; the raw entries it names too. */
function publishE1(ctx: Ctx, period: string, nodes: EventNode[]): EditionEntry {
  const p = allPeriods(CFG).find((x) => x.key === period)!;
  const byDay = new Map<string, EventNode[]>();
  for (const n of nodes) {
    const d = new Date(n.eventTimeMs).toISOString().slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(n);
  }
  const dayFiles = new Map([...byDay].sort().map(([d, ns]) => [d, ns.sort((a, b) => a.eventTimeMs - b.eventTimeMs).map((n) => JSON.stringify(nodeToFeature(n))).join('\n') + '\n']));
  const rows = nodes.reduce((s, n) => s + n.provenance.length, 0);
  const raws = ERA.sources.map((s) => ({ source: s, asset: `raw-${s}-${period}.ndjson.zst`, sha256: `sha-${s}`, rows: 1, provider_count: null }));
  const meta: EditionMeta = {
    kind: EDITION_KIND, version: 1, period, edition: 1, era: ERA.id, min_magnitude: null, boundary: CFG.boundary, start: new Date(p.startMs).toISOString(), end: new Date(p.endMs).toISOString(),
    sources: ERA.sources, raw: raws, context: null, events: nodes.length, days: [...dayFiles.keys()],
    rows: { fetched: rows, bad_coords: 0, coordinateless: 0, written: rows, joined_newer: 0, below_floor: 0 }, below_floor_events: 0, same_source_near_pairs: 0, joined_newer: [],
  };
  const dir = mkdtempSync(join(tmpdir(), `e1-${period}-`));
  const m = join(dir, 'm');
  mkdirSync(m);
  for (const [d, t] of dayFiles) writeFileSync(join(m, `${d.slice(8, 10)}.ndjson`), t);
  writeFileSync(join(m, '_edition.json'), JSON.stringify(meta, null, 2) + '\n');
  const asset = editionAssetName(period, 1);
  const tar = join(dir, asset.replace(/\.zst$/, ''));
  createTar(tar, m, readdirSync(m));
  execFileSync('zstd', ['-19', '-q', '-f', '--rm', tar, '-o', join(dir, asset)]);
  const tag = historyTag(period);
  ctx.store.ensureRelease(tag);
  ctx.store.upload(tag, join(dir, asset));
  for (const r of raws) ctx.idx.raw.push({ source: r.source, period, tag, asset: r.asset, url: '', sha256: r.sha256, bytes: 1, rows: 1, provider_count: null, start: meta.start, end: meta.end, fetch_min_magnitude: null, fetched_at: NOW_ISO });
  const entry: EditionEntry = {
    period, edition: 1, era: ERA.id, tag, asset, url: '', sha256: sha(join(dir, asset)), bytes: 1, events: nodes.length, days: meta.days, sources: ERA.sources,
    min_magnitude: null, built_from: raws.map((r) => r.asset), context: null, joined_newer: 0,
  };
  ctx.idx.editions.push(entry);
  return entry;
}

function ctxOf(over: Partial<Ctx> = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'history-remerge-'));
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  return {
    cfg: CFG, registry, byId: new Map(registry.map((p) => [p.id, p])), idx: emptyIndex(CFG.boundary), store: new LocalStore(join(dir, 'releases')), dryRun: true, work,
    archives: [], archivedDays: new Set(), deadline: Date.now() + 600_000, assetCache: new Map(), rawCache: new Map(), now: () => NOW_ISO, report: emptyReport(), remergeEpoch: 1, ...over,
  };
}
const loadMembers = (ctx: Ctx, e: EditionEntry): Map<string, string> => {
  const dir = mkdtempSync(join(tmpdir(), 'load-'));
  ctx.store.download(e.tag, e.asset, join(dir, e.asset));
  execFileSync('sh', ['-c', `zstd -d -q -c "$1" | tar -xf - -C "$2"`, 'sh', join(dir, e.asset), dir]);
  return new Map(readdirSync(dir).filter((f) => f !== e.asset).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
};

test('history re-merge: each month gets e2 built from e1 (newest first), built_from unchanged, the folds superseded, every check passing', { skip: !hasZstd && 'zstd not installed' }, () => {
  const ctx = ctxOf();
  const e1Dec = publishE1(ctx, '2022-12', split(quake(Date.parse('2022-12-10T05:00:00Z'), 'dec')));
  const e1Nov = publishE1(ctx, '2022-11', split([...quake(Date.parse('2022-11-15T05:00:00Z'), 'nov'), obs('usgs', 'usalone', Date.parse('2022-11-20T00:00:00Z'), { mag: 4 })]));
  assert.ok(editionIsCurrent(CFG, ctx.idx, allPeriods(CFG).find((p) => p.key === '2022-11')!));
  assert.deepEqual(periodsToRemerge(CFG, ctx.idx, 1).map((p) => p.key), ['2022-12', '2022-11']);
  assert.deepEqual(periodsToRemerge(CFG, ctx.idx, 0), [], 'nothing with the epoch at 0');
  remergePeriods(ctx);
  assert.equal(ctx.report.remerged.length, 2, ctx.report.blocked.join('\n'));
  for (const [period, e1, live] of [['2022-12', e1Dec, 1], ['2022-11', e1Nov, 2]] as const) {
    const e2 = currentEdition(ctx.idx, period)!;
    assert.equal(e2.edition, 2);
    assert.deepEqual(e2.built_from, e1.built_from, 'built_from stays: the month is not re-sealed');
    assert.deepEqual(e2.merged_from, { edition: 1, asset: e1.asset, sha256: e1.sha256 });
    assert.equal(e2.merge_epoch, 1);
    assert.ok(editionIsMerged(e2, 1));
    assert.equal(e2.events, live);
    assert.equal(e2.lines, e1.events);
    assert.equal(e2.superseded, 2);
    const members = loadMembers(ctx, e2);
    const meta = JSON.parse(members.get('_edition.json')!) as EditionMeta;
    assert.equal(meta.merge!.merges.length, 2);
    assert.equal(meta.rows.written, (JSON.parse(loadMembers(ctx, e1).get('_edition.json')!) as EditionMeta).rows.written, 'rows unchanged');
    const dayFiles = new Map([...members].filter(([k]) => k.endsWith('.ndjson')).map(([k, v]) => [`${period}-${k.slice(0, 2)}`, v]));
    const p = allPeriods(CFG).find((x) => x.key === period)!;
    assert.deepEqual(verifyEdition(dayFiles, { period: p, boundary: CFG.boundary, archivedDays: new Set(), meta }).errors, []);
    // The merged lines carry the review status (decision A4).
    assert.match(dayFiles.values().next().value!, /"review_status"/);
  }
  // November's newer context was December's merged edition (read from memory).
  const novMeta = JSON.parse(loadMembers(ctx, currentEdition(ctx.idx, '2022-11')!).get('_edition.json')!) as EditionMeta;
  assert.match(novMeta.merge!.newer_context!.label, /events-2022-12\.e2\.tar\.zst/);
  assert.deepEqual(periodsToRemerge(CFG, ctx.idx, 1), [], 'nothing left');
  // Lost index commits: the merged assets are adopted (each was merged from its month's current edition); a merged asset
  // of an edition that is no longer current is not. (An idle run lists no Release: here both months are to re-merge.)
  const e2 = currentEdition(ctx.idx, '2022-12')!;
  const e2Nov = currentEdition(ctx.idx, '2022-11')!;
  ctx.idx.editions = ctx.idx.editions.filter((e) => e !== e2 && e !== e2Nov);
  const dir = mkdtempSync(join(tmpdir(), 'stale-'));
  ctx.store.download(e2.tag, e2.asset, join(dir, 'events-2022-12.e3.tar.zst'));
  ctx.store.upload(e2.tag, join(dir, 'events-2022-12.e3.tar.zst'));
  ctx.assetCache.clear();
  adoptOrphans(ctx);
  assert.equal(currentEdition(ctx.idx, '2022-12')!.asset, e2.asset);
  assert.equal(currentEdition(ctx.idx, '2022-11')!.asset, e2Nov.asset);
  assert.deepEqual(ctx.report.adopted.sort(), [`history-2022/${e2Nov.asset}`, `history-2022/${e2.asset}`].sort());
  assert.match(ctx.report.unused.join('\n'), /events-2022-12\.e3\.tar\.zst: merged from events-2022-12\.e1\.tar\.zst, which is not the current edition/);
});

test('history re-merge: a month waits for its newer month to be merged, and the boundary month for its archive; withdrawn editions are never current', () => {
  const idx: HistoryIndex = emptyIndex('2023-01-01');
  const cfg: HistoryConfig = { ...CFG, boundary: '2023-01-01' };
  const entry = (period: string, edition: number, over: Partial<EditionEntry> = {}): EditionEntry => ({
    period, edition, era: ERA.id, tag: historyTag(period), asset: editionAssetName(period, edition), url: '', sha256: `${period}-${edition}`, bytes: 1, events: 1, days: [],
    sources: ERA.sources, min_magnitude: null, built_from: ERA.sources.map((s) => `raw-${s}-${period}`), context: null, joined_newer: 0, ...over,
  });
  for (const period of ['2022-11', '2022-12']) {
    for (const s of ERA.sources) idx.raw.push({ source: s, period, tag: '', asset: `raw-${s}-${period}`, url: '', sha256: '', bytes: 1, rows: 1, provider_count: null, start: '', end: '', fetch_min_magnitude: null, fetched_at: '' });
    idx.editions.push(entry(period, 1));
  }
  const nov = allPeriods(cfg).find((p) => p.key === '2022-11')!;
  const dec = allPeriods(cfg).find((p) => p.key === '2022-12')!;
  assert.equal(remergeNeighbour(cfg, idx, [], nov, 1).kind, 'wait', 'December is not merged');
  assert.equal(remergeNeighbour(cfg, idx, [], nov, 0).kind, 'edition', 'epoch 0: as before');
  const archive = { period: '2023-01', tag: 'archive-2023-01', asset: 'events-2023-01.tar.zst', days: ['2023-01-01'] };
  assert.equal(remergeNeighbour(cfg, idx, [archive], dec, 1).kind, 'wait', 'the boundary archive is not merged');
  assert.equal(remergeNeighbour(cfg, idx, [{ ...archive, merge_epoch: 1 }], dec, 1).kind, 'wait', 'merged under older input rules (REMERGE_RULES)');
  assert.equal(remergeNeighbour(cfg, idx, [{ ...archive, merge_epoch: 1, merge_rules: REMERGE_RULES }], dec, 1).kind, 'boundary');
  assert.equal(remergeNeighbour(cfg, idx, [{ ...archive, merge_epoch: 1, merge_rules: REMERGE_RULES, needs_reroll: true }], dec, 1).kind, 'wait');
  idx.editions.push(entry('2022-12', 2, { merge_epoch: 1, merge_rules: REMERGE_RULES, merged_from: { edition: 1, asset: 'x', sha256: 'y' } }));
  assert.equal(remergeNeighbour(cfg, idx, [], nov, 1).kind, 'edition');
  // A rollback withdraws e2: e1 is current again, and the month is to be merged again.
  idx.editions[idx.editions.length - 1]!.withdrawn = { at: NOW_ISO, reason: 'rollback' };
  assert.equal(currentEdition(idx, '2022-12')!.edition, 1);
  assert.equal(remergeNeighbour(cfg, idx, [], nov, 1).kind, 'wait');
});

test('verifyEdition: a merged edition passes; a lost id, a lost row, a dangling or chained pointer, a key live twice and an unlisted off-unit event fail', () => {
  const period = allPeriods(CFG).find((p) => p.key === '2022-11')!;
  const before = split([...quake(Date.parse('2022-11-15T05:00:00Z'), 'v'), obs('usgs', 'usoff', Date.parse('2022-12-01T00:00:10Z'), { mag: 4 })]);
  const prevFiles = new Map<string, string>();
  const memberDay = new Map(before.map((n) => [n.feedId, n.eventTimeMs >= period.endMs ? '2022-11-30' : new Date(n.eventTimeMs).toISOString().slice(0, 10)]));
  for (const n of before) {
    const d = memberDay.get(n.feedId)!;
    prevFiles.set(d, (prevFiles.get(d) ?? '') + JSON.stringify(nodeToFeature(n)) + '\n');
  }
  const prevMetaRows = before.reduce((s, n) => s + n.provenance.length, 0);
  const prevCheck = verifyEdition(prevFiles, { period, boundary: CFG.boundary, archivedDays: new Set() });
  const own = before.map((n) => structuredClone(n));
  const res = remergeNodes({ own, memberDay, startMs: period.startMs, endMs: period.endMs, older: [], newer: [], anchored: new Set(), registry, ingestTime: NOW_ISO, epoch: 1 });
  assert.equal(res.offUnit.length, 1);
  const files = remergedDayFiles(own, res.dayOf);
  const meta = (m = mergeMeta(res, { epoch: 1, ingestTime: NOW_ISO, from: { edition: 1, asset: 'a', sha256: 's' }, older: null, newer: null, anchored: new Set() })): EditionMeta => ({
    kind: EDITION_KIND, version: 1, period: '2022-11', edition: 2, era: 'pilot', min_magnitude: null, boundary: CFG.boundary, start: '', end: '', sources: [], raw: [], context: null,
    events: own.filter((n) => n.state === 'live').length, days: [...files.keys()],
    rows: { fetched: prevMetaRows, bad_coords: 0, coordinateless: 0, written: prevMetaRows, joined_newer: 0, below_floor: 0 }, below_floor_events: 0, same_source_near_pairs: 0, joined_newer: [],
    merge: m, lines: own.length, superseded: own.filter((n) => n.state === 'superseded').length,
  });
  const check = (f: Map<string, string>, m = meta()): string => verifyEdition(f, { period, boundary: CFG.boundary, archivedDays: new Set(), meta: m, prev: prevCheck }).errors.join('\n');
  assert.equal(check(files), '');
  const loser = own.find((n) => n.state === 'superseded')!;
  const edit = (fn: (line: Record<string, any>) => Record<string, any> | null): Map<string, string> =>
    new Map([...files].map(([d, t]) => [d, t.split('\n').filter(Boolean).map((l) => fn(JSON.parse(l))).filter((x) => x).map((x) => JSON.stringify(x)).join('\n') + '\n']));
  assert.match(check(edit((l) => (l.id === loser.feedId ? null : l))), /lines in the edition merged from|feed ids differ/);
  assert.match(check(edit((l) => (l.properties.feed.state === 'live' ? { ...l, properties: { ...l.properties, feed: { ...l.properties.feed, provenance: l.properties.feed.provenance.slice(0, 1) } } } : l.id === loser.feedId ? { ...l, properties: { ...l.properties, feed: { ...l.properties.feed, provenance: [] } } } : l))), /source id\(s\) of the edition merged from/);
  assert.match(check(edit((l) => (l.id === loser.feedId ? { ...l, properties: { ...l.properties, feed: { ...l.properties.feed, superseded_by: 'efd_nowhere' } } } : l))), /not in the edition nor in merge\.into_newer/);
  const other = own.find((n) => n.state === 'superseded' && n.feedId !== loser.feedId)!;
  assert.match(check(edit((l) => (l.id === other.feedId ? { ...l, properties: { ...l.properties, feed: { ...l.properties.feed, superseded_by: loser.feedId } } } : l))), /a superseded line \(a chain\)/);
  assert.match(check(edit((l) => (l.id === loser.feedId ? { ...l, properties: { ...l.properties, feed: { ...l.properties.feed, state: 'live' } } } : l)), { ...meta(), events: meta().events + 1, superseded: meta().superseded! - 1 }), /is in two events/);
  const m2 = meta();
  m2.merge = { ...m2.merge!, off_unit: [] };
  assert.match(check(files, m2), /is not on 2022-11-30/);
});

test('buildEdition floor after the re-merge: a live event under the floor goes with every event folded into it', () => {
  const nodes = split([...quake(Date.parse('2022-11-15T05:00:00Z'), 'f'), obs('usgs', 'ussmall', Date.parse('2022-11-16T00:00:00Z'), { mag: 3.9 }), obs('geofon', 'gsmall', Date.parse('2022-11-16T00:00:01Z'), { mag: 4.0, lat: 10.01 })]);
  remergeNodes({ own: nodes, memberDay: new Map(nodes.map((n) => [n.feedId, '2022-11-15'])), startMs: Date.parse('2022-11-01T00:00:00Z'), endMs: Date.parse('2022-12-01T00:00:00Z'), older: [], newer: [], anchored: new Set(), registry, ingestTime: NOW_ISO, epoch: 1 });
  const small = nodes.filter((n) => n.provenance.some((r) => r.nativeId === 'ussmall' || r.nativeId === 'gsmall'));
  assert.equal(small.filter((n) => n.state === 'live').length, 1, 'the small pair folded');
  const dropped = belowFloor(nodes, 4.5);
  assert.deepEqual([...dropped].sort(), small.map((n) => n.feedId).sort(), 'the survivor and its loser');
  assert.equal(belowFloor(nodes, null).size, 0);
});
