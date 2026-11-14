import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { featureToNode, nodeToFeature } from '../src/bitemporal.js';
import { AUTHORITY_WINDOW, ISC_COPY_DT_MS, LOCATION_JOIN_DT_MS, MAX_PAIR_DT_MS, MODERATE_EVENT_MAX_DT_MS, OVSICORI_WINDOW, REVIEWED_ID_WINDOWS, REVISED_ID_WINDOWS, TEMPORAL_MS } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { feedSideSteps, runFeedSideSteps } from '../src/heal.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import { anchorCounts, remergeGateProblems, remergeNodes, remergedDayFiles, snapshotUnit } from '../src/remerge.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// The offline re-merge (src/remerge.ts, C3) and the Resolver's context options (C1): pinned / frozen context, the pair
// pre-filter, the sliding windows, the final repoint, the gates.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const IT = '2026-11-08T00:00:00.000Z';
const DAY = 86_400_000;
const START = Date.parse('2024-06-01T00:00:00Z');
const END = Date.parse('2024-07-01T00:00:00Z');
const KM_PER_DEG = 111.195;

function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider, providerEventId: id, eventTimeMs: START + 10 * DAY, providerUpdatedMs: null, status: 'reviewed', lat: 10, lon: 120, depth: 10,
    mag: 6.1, magType: 'mww', place: 'test', knownAliasIds: [], fields: {}, ...over,
  };
}

/** One event per report, as the archives hold a quake that reached the backfill source by source (each walked alone,
 *  so no report found the others at first sight). */
function split(rows: RawObs[], nowMs = END): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  for (const row of rows) {
    const one = new Map<string, EventNode>();
    new Resolver(one, prio, cfg, nowMs, { hotFloorMs: 0, merge: false }).ingest(row, IT);
    // Feed ids are seeded by time and place: two reports a second apart in one spot may draw the same id alone.
    for (const [id, n] of one) {
      let fid = id;
      while (map.has(fid)) fid = `${fid}X`;
      n.feedId = fid;
      map.set(fid, n);
    }
  }
  return map;
}
const clone = (ns: Iterable<EventNode>): EventNode[] => [...ns].map((n) => structuredClone(n));
const memberDays = (ns: EventNode[]): Map<string, string> => new Map(ns.map((n) => [n.feedId, new Date(n.eventTimeMs).toISOString().slice(0, 10)]));
function remerge(own: EventNode[], over: Partial<Parameters<typeof remergeNodes>[0]> = {}) {
  return remergeNodes({ own, memberDay: memberDays(own), startMs: START, endMs: END, older: [], newer: [], anchored: new Set(), registry, ingestTime: IT, epoch: 1, ...over });
}
/** An M6 quake three agencies placed 20-35 km apart, a few seconds apart: three events at first sight, merge pass off. */
const m6Split = (t = START + 10 * DAY, idSuffix = ''): RawObs[] => [
  obs('usgs', `us6000test${idSuffix}`, { eventTimeMs: t, mag: 6.1, fields: { ids: `,us6000test${idSuffix},` } }),
  obs('geofon', `gfz2024test${idSuffix}`, { eventTimeMs: t + 2_000, lat: 10 + 22 / KM_PER_DEG, mag: 6.0, magType: 'mw' }),
  obs('emsc', `20240611_test${idSuffix}`, { eventTimeMs: t + 3_000, lat: 10 - 18 / KM_PER_DEG, mag: 5.9, magType: 'mw' }),
];

// --- C1: the Resolver's context options (live passes none of them) ---

test('Resolver context: a pinned node survives whatever the ranking says; two pinned nodes never fold, through the heal or a ComCat id', () => {
  const map = split(m6Split());
  assert.equal([...map.values()].filter((n) => n.state === 'live').length, 3);
  const geofon = [...map.values()].find((n) => n.chosenProvider === 'geofon')!;
  const r = new Resolver(map, prio, cfg, END, { hotFloorMs: 0, pinned: new Set([geofon.feedId]) });
  const { merges } = r.heal(IT);
  assert.equal(merges.length, 2);
  assert.ok(merges.every((m) => m.survivor.feedId === geofon.feedId), 'the pinned event survives both folds (usgs would rank first)');
  // Both sides pinned: nothing folds, not even through an exact ComCat id.
  const aec = obs('aec', 'ak024test', { eventTimeMs: START + 10 * DAY + 1_000, lat: 10.05, mag: 6.0, fields: {} });
  const usgs = obs('usgs', 'us6000twin', { eventTimeMs: START + 10 * DAY, lat: 10, mag: 6.1, fields: { ids: ',ak024test,us6000twin,' } });
  const twins = split([aec, usgs]);
  const live = [...twins.values()].filter((n) => n.state === 'live');
  if (live.length === 2) {
    const both = new Set(live.map((n) => n.feedId));
    const rp = new Resolver(twins, prio, cfg, END, { hotFloorMs: 0, pinned: both });
    assert.equal(rp.heal(IT).merges.length, 0);
    assert.equal(rp.whyNotMerged(live[0]!, live[1]!), 'pinned pair');
  }
});

test('Resolver context: a frozen node never folds but counts for density; the heal never starts at a context node', () => {
  const map = split(m6Split());
  const ids = [...map.keys()];
  const frozen = new Set([ids[0]!]);
  const r = new Resolver(map, prio, cfg, END, { hotFloorMs: 0, frozen });
  const { merges } = r.heal(IT);
  assert.ok(merges.every((m) => !frozen.has(m.loser.feedId) && !frozen.has(m.survivor.feedId)));
  assert.equal(map.get(ids[0]!)!.state, 'live');
  assert.equal(r.whyNotMerged(map.get(ids[0]!)!, map.get(ids[1]!)!), 'frozen context');
  // Density: 50 frozen events in the cell make it dense, so a pair without a shared id stays apart.
  const swarm: RawObs[] = Array.from({ length: 50 }, (_, i) => obs('ingv', `swarm${i}`, { eventTimeMs: START + 9 * DAY + i * 600_000, lat: 10.01, lon: 120.01, mag: 2, magType: 'ml' }));
  const pair: RawObs[] = [
    obs('usgs', 'us7000pair', { eventTimeMs: START + 10 * DAY, lat: 10.02, lon: 120.02, mag: 3, magType: 'ml', fields: { ids: ',us7000pair,' } }),
    obs('geofon', 'gfzpair', { eventTimeMs: START + 10 * DAY + 1_000, lat: 10.025, lon: 120.02, mag: 3, magType: 'ml' }),
  ];
  const m2 = split([...swarm, ...pair]);
  const swarmIds = new Set([...m2.values()].filter((n) => n.chosenProvider === 'ingv').map((n) => n.feedId));
  assert.equal(new Resolver(clone(m2.values()).reduce((m, n) => m.set(n.feedId, n), new Map()), prio, cfg, END, { hotFloorMs: 0, frozen: swarmIds }).heal(IT).merges.length, 0, 'dense with the frozen swarm');
  const noSwarm = new Map([...m2].filter(([id]) => !swarmIds.has(id)).map(([id, n]) => [id, structuredClone(n)]));
  assert.equal(new Resolver(noSwarm, prio, cfg, END, { hotFloorMs: 0 }).heal(IT).merges.length, 1, 'not dense without it');
});

test('Resolver context: no row is re-homed out of or into a context event', () => {
  // An EMSC copy of a USGS solution standing in a GEOFON event, the USGS row in another event: live re-homes the copy.
  const rows: RawObs[] = [
    obs('usgs', 'us7000home', { eventTimeMs: START + 10 * DAY, lat: 10, mag: 4.2, magType: 'mb', fields: { ids: ',us7000home,' } }),
    obs('geofon', 'gfzhost', { eventTimeMs: START + 10 * DAY + 30_000, lat: 10.5, mag: 4.3, magType: 'mb' }),
  ];
  const map = split(rows);
  const host = [...map.values()].find((n) => n.chosenProvider === 'geofon')!;
  const home = [...map.values()].find((n) => n.chosenProvider === 'usgs')!;
  const copy = obs('emsc', '20240611_copy', { eventTimeMs: START + 10 * DAY, lat: 10, mag: 4.2, magType: 'mb', fields: { auth: 'NEIC' } });
  host.provenance.push({ ...copy, nativeId: copy.providerEventId, chosen: false, license: 'x', attribution: 'x', doi: null } as never);
  host.aliases.push('emsc:20240611_copy');
  for (const [pinned, frozen] of [[new Set([home.feedId]), new Set<string>()], [new Set<string>(), new Set([host.feedId])]] as const) {
    const m = new Map([...map].map(([id, n]) => [id, structuredClone(n)]));
    const r = new Resolver(m, prio, cfg, END, { hotFloorMs: 0, pinned, frozen });
    assert.equal(r.rehomeMisplacedCopies(IT).length, 0);
    assert.equal(m.get(host.feedId)!.provenance.length, 2);
  }
});

test('pre-filter: MAX_PAIR_DT_MS is at least every pair-time window; heals with and without it are identical on production fixtures', () => {
  const windows = [TEMPORAL_MS, MODERATE_EVENT_MAX_DT_MS, OVSICORI_WINDOW.maxDtMs, LOCATION_JOIN_DT_MS, AUTHORITY_WINDOW.maxDtMs, ISC_COPY_DT_MS, ...[...REVISED_ID_WINDOWS.values()].map((w) => w.dtMs), ...[...REVIEWED_ID_WINDOWS.values()].flatMap((w) => [w.near.dtMs, w.far.dtMs])];
  for (const w of windows) assert.ok(MAX_PAIR_DT_MS >= w, `${w} ms`);
  const scatter = readFileSync(here('fixtures/m5-scatter-2026-10-06-event-map.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventNode);
  const loyalty = readFileSync(here('fixtures/loyalty-2026-09-25.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Observation);
  const loyaltyMap = (): Map<string, EventNode> => {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, Date.parse('2026-09-27T12:00:00Z'), { merge: false, hotFloorMs: 0 });
    for (const o of loyalty) r.ingest(observationToRaw(o), o.ingest_time);
    return map;
  };
  for (const [label, make, now] of [
    ['m5-scatter', () => new Map(scatter.map((n) => [n.feedId, structuredClone(n)])), Date.parse('2026-10-06T12:00:00Z')],
    ['loyalty', loyaltyMap, Date.parse('2026-09-27T12:00:00Z')],
  ] as const) {
    const out = (pre: boolean): string => {
      const map = make();
      const res = new Resolver(map, prio, cfg, now, pre ? { pairPrefilterMs: MAX_PAIR_DT_MS } : {}).heal(IT);
      return JSON.stringify([res.merges.map((m) => [m.loser.feedId, m.survivor.feedId, m.reason]), [...map.values()].map((n) => nodeToFeature(n))]);
    };
    const a = out(false);
    assert.equal(out(true), a, label);
    assert.ok(JSON.parse(a)[0].length > 0, `${label} folds something`);
  }
});

// --- C2: one rule ---

test('feedSideSteps: withdrawals off skips the coordinate-less retraction and the held withdrawal; on, it is what aggregate runs', () => {
  const rows = [obs('usgs', 'us7000zero', { lat: 0, lon: 0, mag: 0 }), obs('geofon', 'gfzzero', { lat: 0.05, lon: 0, mag: 0, eventTimeMs: START + 10 * DAY + 1_000 })];
  const nodes = [...split(rows).values()];
  // A coordinate-less row inside an event with a located row (the shape the retraction acts on).
  nodes[0]!.provenance.push({ ...nodes[1]!.provenance[0]!, lat: 0, lon: 0, mag: 0, provider: 'emsc', nativeId: 'x0', chosen: false });
  const map = new Map(nodes.map((n) => [n.feedId, structuredClone(n)]));
  const off = feedSideSteps(new Resolver(map, prio, cfg, END, { hotFloorMs: 0 }), IT, { healDue: true, maxFolds: Infinity, withdrawals: false });
  assert.equal(off.retractions.length, 0);
  assert.equal(off.held.length, 0);
  const map2 = new Map(nodes.map((n) => [n.feedId, structuredClone(n)]));
  const on = feedSideSteps(new Resolver(map2, prio, cfg, END, { hotFloorMs: 0 }), IT, { healDue: true, maxFolds: Infinity, withdrawals: true });
  assert.ok(on.retractions.length > 0, 'the retraction runs with withdrawals on');
  // runFeedSideSteps = feedSideSteps(withdrawals on) + the log: the same steps in the same order.
  const map3 = new Map(nodes.map((n) => [n.feedId, structuredClone(n)]));
  const log = new LogBuffer(100, IT);
  const scratch = mkdtempSync(join(tmpdir(), 'remerge-heal-'));
  const res = runFeedSideSteps(scratch, new Resolver(map3, prio, cfg, END, { hotFloorMs: 0 }), log, { healDue: false, loadDays: 10, ingestTime: IT });
  assert.equal(res.retracted, on.retractions.length);
  assert.deepEqual([...map3.values()].map((n) => nodeToFeature(n)).length, [...map2.values()].length);
});

// --- C3: remergeNodes ---

test('remerge: a split M6 (usgs, geofon, emsc built with the merge pass off) becomes 1 live and 2 superseded, every row kept', () => {
  const own = [...split(m6Split()).values()];
  const before = snapshotUnit(own);
  const res = remerge(own);
  assert.equal(own.filter((n) => n.state === 'live').length, 1);
  assert.equal(own.filter((n) => n.state === 'superseded').length, 2);
  const survivor = own.find((n) => n.state === 'live')!;
  assert.equal(survivor.chosenProvider, 'usgs');
  assert.equal(survivor.provenance.length, 3);
  for (const l of own.filter((n) => n.state === 'superseded')) {
    assert.equal(l.supersededBy, survivor.feedId);
    assert.equal(l.provenance.length, 1, 'the loser keeps a frozen copy of its rows');
    assert.equal(l.lastIngestTime, IT);
  }
  assert.deepEqual(remergeGateProblems(before, own, res), []);
  assert.equal(res.merges.length, 2);
  assert.equal(res.live_before, 3);
  assert.equal(res.live_after, 1);
});

test('remerge: density is counted over 7 days: 60 events in a cell over 30 days fold a pair the sliding replay sees, which one heal over the month does not', () => {
  // 60 swarm events spread over 30 days (14 in any 7 days), then a twin pair without a shared id.
  const swarm: RawObs[] = Array.from({ length: 60 }, (_, i) => obs('ingv', `sw${i}`, { eventTimeMs: START + Math.floor(i / 2) * DAY + (i % 2) * 3_600_000, lat: 10.01, lon: 120.01, mag: 2, magType: 'ml' }));
  const pair: RawObs[] = [
    obs('usgs', 'us7000dense', { eventTimeMs: START + 20 * DAY + 600_000, lat: 10.02, lon: 120.02, mag: 3, magType: 'ml', fields: { ids: ',us7000dense,' } }),
    obs('geofon', 'gfzdense', { eventTimeMs: START + 20 * DAY + 601_000, lat: 10.025, lon: 120.02, mag: 3, magType: 'ml' }),
  ];
  const nodes = [...split([...swarm, ...pair]).values()];
  const month = new Map(nodes.map((n) => [n.feedId, structuredClone(n)]));
  assert.equal(new Resolver(month, prio, cfg, END, { hotFloorMs: 0 }).heal(IT).merges.length, 0, 'one Resolver over the month: the cell holds 62 events, dense');
  const own = clone(nodes);
  const res = remerge(own);
  assert.equal(res.merges.length, 1, 'the sliding windows see at most 16 events in the cell');
});

test('remerge: a pair across a day seam folds; a fold into the newer context goes to into_newer; anchored events survive', () => {
  const seam = m6Split(Date.parse('2024-06-14T23:59:59Z'), 's');
  const own = [...split(seam).values()];
  const res = remerge(own);
  assert.equal(own.filter((n) => n.state === 'live').length, 1, 'events on two days fold');
  // A quake at the month's end whose usgs event is in the newer month's first day (pinned context).
  const edge = m6Split(Date.parse('2024-06-30T23:59:58Z'), 'e');
  const all = [...split(edge).values()];
  const newer = all.filter((n) => n.eventTimeMs >= END);
  const mine = all.filter((n) => n.eventTimeMs < END);
  assert.ok(newer.length >= 1 && mine.length >= 1);
  const r2 = remerge(mine, { newer: clone(newer), memberDay: memberDays(mine) });
  assert.ok(r2.intoNewer.length >= 1);
  for (const x of r2.intoNewer) {
    assert.ok(newer.some((n) => n.feedId === x.survivor), 'the survivor is the newer month’s event');
    assert.equal(mine.find((n) => n.feedId === x.loser)!.supersededBy, x.survivor);
  }
  assert.ok(newer.every((n) => n.state === 'live'), 'the context itself is unchanged');
  // Anchored: the older unit points to the geofon event, so it survives although usgs ranks first.
  const own3 = [...split(m6Split(START + 12 * DAY, 'a')).values()];
  const anchor = own3.find((n) => n.chosenProvider === 'geofon')!.feedId;
  remerge(own3, { anchored: new Set([anchor]) });
  assert.equal(own3.find((n) => n.feedId === anchor)!.state, 'live');
  assert.equal(own3.filter((n) => n.state === 'live').length, 1);
});

test('remerge: an event whose time left the unit stays in its member day (off_unit); a coordinate-less row stays (no withdrawals)', () => {
  const own = [...split([obs('usgs', 'us7000off', { eventTimeMs: END + 3_600_000 }), obs('geofon', 'gfzzero2', { lat: 0, lon: 0, mag: 0 })]).values()];
  const memberDay = new Map(own.map((n) => [n.feedId, '2024-06-30']));
  const res = remerge(own, { memberDay });
  const off = own.find((n) => n.chosenProvider === 'usgs')!;
  assert.deepEqual(res.offUnit, [off.feedId]);
  assert.equal(res.dayOf.get(off.feedId), '2024-06-30');
  const zero = own.find((n) => n.chosenProvider === 'geofon')!;
  assert.equal(zero.state, 'live');
  assert.equal(zero.provenance.length, 1);
});

test('remerge: identical bytes on two runs', () => {
  const rows = [...m6Split(), ...m6Split(START + 3 * DAY, 'b'), ...m6Split(START + 20 * DAY + 1, 'c')];
  const run = (): string => {
    const own = [...split(rows).values()];
    const res = remerge(own);
    return JSON.stringify([...remergedDayFiles(own, res.dayOf)]) + JSON.stringify(res.merges);
  };
  assert.equal(run(), run());
});

test('remerge: parity with aggregate\'s feed-side steps on a fixture with nothing to withdraw (the Loyalty Islands M7.0)', () => {
  const loyalty = readFileSync(here('fixtures/loyalty-2026-09-25.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Observation);
  const now = Date.parse('2026-09-27T12:00:00Z');
  const build = (): EventNode[] => {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, now, { merge: false, hotFloorMs: 0 });
    for (const o of loyalty) r.ingest(observationToRaw(o), o.ingest_time);
    return [...map.values()];
  };
  const live = new Map(build().map((n) => [n.feedId, n]));
  runFeedSideSteps(mkdtempSync(join(tmpdir(), 'remerge-parity-')), new Resolver(live, prio, cfg, now), new LogBuffer(0, IT), { healDue: true, loadDays: 10, ingestTime: IT });
  const own = build();
  const t = Math.min(...own.map((n) => n.eventTimeMs));
  remergeNodes({ own, memberDay: memberDays(own), startMs: Math.floor(t / DAY) * DAY, endMs: Math.floor(t / DAY) * DAY + DAY, older: [], newer: [], anchored: new Set(), registry, ingestTime: IT, epoch: 1 });
  const liveIds = (ns: Iterable<EventNode>): string[] => [...ns].filter((n) => n.state === 'live').map((n) => n.feedId).sort();
  assert.deepEqual(liveIds(own), liveIds(live.values()));
});

test('remerge: the real 2024-06 split fixture (4 quakes M5.5-5.9, each 3 events in the archive) folds to 4 events; the ComCat anchor holds', () => {
  const own = readFileSync(here('fixtures/remerge-2024-06-split.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => featureToNode(JSON.parse(l)));
  assert.equal(own.length, 12);
  const before = snapshotUnit(own);
  const res = remerge(own);
  assert.deepEqual(remergeGateProblems(before, own, res), []);
  assert.equal(res.merges.length, 8);
  assert.equal(own.filter((n) => n.state === 'live').length, 4);
  const a = anchorCounts(own);
  assert.equal(a.u45, before.anchor.u45);
  assert.equal(a.e45, a.u45, 'every live event holds one usgs id at most');
  assert.equal(a.welds45, 0);
  for (const n of own.filter((x) => x.state === 'live')) assert.ok(n.provenance.some((r) => r.provider === 'usgs'));
});

test('gates: a lost id, a lost row, a dangling pointer, a chain and a key live twice are each refused', () => {
  const own = [...split(m6Split()).values()];
  const before = snapshotUnit(own);
  const res = remerge(own);
  const live = own.find((n) => n.state === 'live')!;
  const loser = own.find((n) => n.state === 'superseded')!;
  const variants: [string, (ns: EventNode[]) => EventNode[], RegExp][] = [
    ['lost id', (ns) => ns.filter((n) => n.feedId !== loser.feedId), /was lost/],
    ['lost row', (ns) => ns.map((n) => (n.feedId === loser.feedId ? { ...n, provenance: [] } : n.feedId === live.feedId ? { ...n, provenance: n.provenance.filter((r) => r.provider !== loser.provenance[0]!.provider) } : n)), /row\(s\) lost/],
    ['dangling', (ns) => ns.map((n) => (n.feedId === loser.feedId ? { ...n, supersededBy: 'efd_nowhere' } : n)), /does not resolve/],
    ['chain', (ns) => ns.map((n) => (n.state === 'superseded' && n.feedId !== loser.feedId ? { ...n, supersededBy: loser.feedId } : n)), /does not resolve/],
    ['live twice', (ns) => ns.map((n) => (n.feedId === loser.feedId ? { ...n, state: 'live' as const } : n)), /is live in/],
  ];
  for (const [label, mutate, re] of variants) assert.match(remergeGateProblems(before, mutate(own.map((n) => structuredClone(n))), res).join('\n'), re, label);
});

test('normalization (REMERGE_RULES 3, row-normalize.ts): archived AFAD rows stored 3 h early are re-timed by the PF-5e rule in AFAD-only events, left in mixed ones; then they fold with the quake', async () => {
  const { afadCorrections, AFAD_LEGACY_OFFSET_MS } = await import('../src/correction.js');
  const { normalizeUnit } = await import('../src/remerge.js');
  const fixture = readFileSync(here('fixtures/afad-event-map-2026-09.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventNode);
  const corrections = afadCorrections(new Map(fixture.map((n) => [n.feedId, n])), -Infinity);
  assert.ok(corrections.length > 0, 'the fixture holds legacy AFAD rows');
  const own = fixture.map((n) => structuredClone(n));
  const before = snapshotUnit(own);
  const counts = normalizeUnit(own, registry);
  assert.equal(counts.afad_retimed + counts.afad_joined_kept, corrections.length);
  assert.ok(counts.afad_retimed > 0);
  for (const c of corrections) {
    const n = own.find((x) => x.provenance.some((p) => p.provider === 'afad' && p.nativeId === c.providerEventId))!;
    const row = n.provenance.find((p) => p.provider === 'afad' && p.nativeId === c.providerEventId)!;
    if (n.provenance.every((p) => p.provider === 'afad')) assert.equal(row.eventTimeMs, c.eventTimeMs, 'moved to the real time');
    else assert.equal(row.eventTimeMs, c.eventTimeMs - AFAD_LEGACY_OFFSET_MS, 'left where it stands');
  }
  const after = snapshotUnit(own);
  assert.deepEqual([...after.ids].sort(), [...before.ids].sort(), 'no id minted or lost');
  assert.deepEqual([...after.keys].sort(), [...before.keys].sort(), 'no row lost');
  const again = normalizeUnit(own, registry);
  assert.equal(again.afad_retimed, 0, 'idempotent');
  assert.equal(again.afad_joined_kept, counts.afad_joined_kept);
  // A re-timed AFAD event now sits on the quake's EMSC event and folds into it.
  const target = corrections.find((c) => own.find((x) => x.provenance.some((p) => p.nativeId === c.providerEventId))!.provenance.every((p) => p.provider === 'afad'))!;
  const [emsc] = split([obs('emsc', '20250423_marmara', { eventTimeMs: target.eventTimeMs + 1_000, lat: target.lat + 0.02, lon: target.lon, mag: target.mag, magType: 'ml', status: 'reviewed' })]).values();
  const unit = [...own, emsc!];
  const t = Math.min(...unit.map((n) => n.eventTimeMs));
  const res = remergeNodes({ own: unit, memberDay: memberDays(unit), startMs: Math.floor(t / DAY) * DAY, endMs: Math.max(...unit.map((n) => n.eventTimeMs)) + DAY, older: [], newer: [], anchored: new Set(), registry, ingestTime: IT, epoch: 1 });
  const afadNode = unit.find((x) => x.provenance.some((p) => p.provider === 'afad' && p.nativeId === target.providerEventId))!;
  assert.ok(res.merges.some((m) => m.loser === afadNode.feedId || m.loser === emsc!.feedId), 'the re-timed AFAD event folds with the EMSC event of its quake');
});
