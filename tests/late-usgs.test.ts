import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { featureToNode, nodeToFeature } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import { LocalStore } from '../src/history-store.js';
import { dayPartitionText, frozenBefore } from '../src/partitions.js';
import { configMap, loadRegistry, priorityMap, type WindowOutcome } from '../src/providers.js';
import { type DayRunDeps, type FrozenPartition, dryRunNotice, remediateDay, resolveLateMode } from '../src/remediate.js';
import {
  EDITION_FORMAT,
  LATE_USGS_SCHEDULED,
  type LateUsgsRow,
  buildDayEdition,
  emptyRemediationIndex,
  lateUsgsDays,
  lateUsgsDiff,
  lateUsgsKeeps,
  lateUsgsRowsOfNodes,
  partitionAsset,
  pruneLateUsgs,
} from '../src/remediation.js';
import { LATE_COMCAT, comcatGate, editionReasons, gateCauses, verifyRow } from '../src/stats-history.js';
import type { EventNode, RawObs } from '../src/types.js';

// SHLTR-150: ComCat publishes and upgrades many M4.5+ solutions days or weeks after the origin, after the live day
// froze. The late-ComCat refresh asks ComCat again for the frozen, unarchived days of the last 45 and publishes a
// `late_usgs` remediation edition, built on the day's frozen partition, for each day whose M4.5+ set changed.

const registry = loadRegistry();
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-14T12:00:00Z');

const days = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

test('late_usgs days: frozen, unarchived partitions of the last 45 days whose next day is frozen too; a range replaces the window', () => {
  const fb = frozenBefore(NOW);
  assert.equal(fb, '2026-11-04', 'frozen after LIVE_INDEX_DAYS (10)');
  const partitionDays = new Set(days('2026-07-01', '2026-11-14'));
  const archivedDays = new Set([...days('2026-06-01', '2026-06-30'), '2026-10-01']);
  const d = lateUsgsDays({ nowMs: NOW, frozenBefore: fb, partitionDays, archivedDays });
  assert.equal(d[0], '2026-09-30', 'today - 45');
  assert.equal(d.at(-1), '2026-11-02', 'the last frozen day (11-03) has an unfrozen next day: not yet');
  assert.ok(!d.includes('2026-10-01'), 'an archived day is never a late_usgs day');
  assert.equal(d.length, 33);
  assert.ok(!d.some((x) => x >= fb), 'no unfrozen day (the live run owns them)');
  // A day without a partition on the data branch (rolled into an archive since, or never written) is skipped.
  partitionDays.delete('2026-10-10');
  assert.ok(!lateUsgsDays({ nowMs: NOW, frozenBefore: fb, partitionDays, archivedDays }).includes('2026-10-10'));
  // The catch-up: a dispatched range, older than 45 days, under the same rules.
  assert.deepEqual(lateUsgsDays({ nowMs: NOW, frozenBefore: fb, partitionDays, archivedDays, range: '2026-08-01..2026-08-31' }), days('2026-08-01', '2026-08-31'));
  assert.deepEqual(lateUsgsDays({ nowMs: NOW, frozenBefore: fb, partitionDays, archivedDays, range: '2026-06-28..2026-07-02' }), ['2026-07-01', '2026-07-02'], 'archived June stays out');
  assert.deepEqual(lateUsgsDays({ nowMs: NOW, frozenBefore: fb, partitionDays, archivedDays, range: '2026-10-30..2026-11-10' }), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.throws(() => lateUsgsDays({ nowMs: NOW, frozenBefore: fb, partitionDays, archivedDays, range: '2026-07-01..2026-08-31' }), /at most 31/);
});

const row = (id: string, mag: number | null, ids: string[] = []): LateUsgsRow => ({ id, ids: [id, ...ids], mag });

test('late_usgs diff: new and upgraded M4.5+ solutions, revisions of 0.3 or more and drops below M4.5 change the day; gone rows are reported only', () => {
  const held = [row('us1', 4.6), row('us2', 4.4), row('us3', 4.5), row('us4', 5.0), row('us5', 4.7), row('ak1', 4.8), row('us9', 3.1)];
  const fresh = [
    row('us1', 4.6), // unchanged
    row('us2', 4.6), // crossed up: added
    row('us3', 4.8), // +0.3 (0.2999… in floats): revised
    row('us4', 5.2), // +0.2: below the threshold
    row('us5', 4.4), // crossed down: lowered
    row('us7000new', 4.9), // a late publication: added
    row('us7000rev', 4.9, ['ak1']), // ComCat moved ak1's preferred id to the reviewing network's: the same solution
    row('us8', 4.2), // below M4.5 on both sides of nothing: ignored
  ];
  const d = lateUsgsDiff(held, fresh);
  assert.deepEqual(d.added, ['us2', 'us7000new']);
  assert.deepEqual(d.revised, [{ id: 'us3', from: 4.5, to: 4.8 }]);
  assert.deepEqual(d.lowered, [{ id: 'us5', from: 4.7, to: 4.4 }]);
  assert.deepEqual(d.gone, []);
  assert.equal(d.held, 5);
  assert.equal(d.fresh, 6);
  assert.equal(d.changed, true);
  // Only a row ComCat no longer lists: reported, not a change (an edition never removes a row).
  const gone = lateUsgsDiff([row('us1', 4.6), row('us6', 4.9)], [row('us1', 4.6)]);
  assert.deepEqual(gone.gone, ['us6']);
  assert.equal(gone.changed, false);
  // Unchanged and sub-threshold revisions do not change the day.
  assert.equal(lateUsgsDiff([row('us1', 4.6), row('us4', 5.0)], [row('us1', 4.6), row('us4', 4.8)]).changed, false);
  assert.equal(lateUsgsDiff([row('us4', 5.0)], [row('us4', 4.7)]).revised.length, 1, '−0.3 counts too');
  // A held row without a magnitude is below M4.5.
  assert.deepEqual(lateUsgsDiff([row('us1', null)], [row('us1', 4.5)]).added, ['us1']);
});

// --- the day run on a frozen partition ---

const D = '2026-09-15';
const D0 = Date.parse(`${D}T00:00:00Z`);
const usgs = (id: string, tMs: number, mag: number, over: Partial<RawObs> = {}): RawObs => ({
  provider: 'usgs', providerEventId: id, eventTimeMs: tMs, providerUpdatedMs: tMs + HOUR, status: 'reviewed',
  lat: -20.5, lon: -175.2, depth: 30, mag, magType: 'mb', place: 'Tonga', knownAliasIds: [], fields: { ids: `,${id},` }, ...over,
});
const emsc = (id: string, tMs: number, mag: number, over: Partial<RawObs> = {}): RawObs => ({
  provider: 'emsc', providerEventId: id, eventTimeMs: tMs, providerUpdatedMs: null, status: null,
  lat: -20.5, lon: -175.2, depth: 30, mag, magType: 'mb', place: 'TONGA', knownAliasIds: [], fields: { unid: id }, ...over,
});

/** The frozen partitions of 09-14..09-16 as the live run left them: ComCat's early set only. */
function frozenPartitions(): Map<string, FrozenPartition> {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, priorityMap(registry), configMap(registry), D0 + 2 * DAY_MS, { hotFloorMs: 0, merge: false });
  const live = [
    usgs('us1', D0 + 2 * HOUR, 4.6),
    emsc('e1', D0 + 2 * HOUR + 2_000, 4.5),
    usgs('us2', D0 + 5 * HOUR, 4.4, { lat: 36.1, lon: 70.9, place: 'Afghanistan' }),
    emsc('e2', D0 + 9 * HOUR, 4.7, { lat: -6.1, lon: 147.2, place: 'PAPUA NEW GUINEA' }),
    emsc('e3', D0 + 14 * HOUR, 3.2, { lat: 38.3, lon: 21.8, place: 'GREECE' }),
    emsc('prev', D0 - 3 * HOUR, 4.1, { lat: 38.3, lon: 21.8, place: 'GREECE' }),
    usgs('next', D0 + 30 * HOUR, 4.9, { lat: 52.1, lon: 160.3, place: 'Kamchatka' }),
  ];
  for (const raw of live) r.ingest(raw, '2026-09-16T00:00:00.000Z');
  const byDay = new Map<string, EventNode[]>();
  for (const n of map.values()) {
    const d = new Date(n.eventTimeMs).toISOString().slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(n);
  }
  const out = new Map<string, FrozenPartition>();
  for (const [d, nodes] of byDay) {
    const text = dayPartitionText(nodes, d, EDITION_FORMAT);
    const reread = text.split('\n').filter(Boolean).map((l) => featureToNode(JSON.parse(l)));
    out.set(d, { nodes: reread, ref: { tag: 'data', asset: partitionAsset(d), sha256: createHash('sha256').update(text).digest('hex'), blob: `blob-${d}` } });
  }
  return out;
}

/** ComCat today: us2 upgraded across M4.5, the PNG quake EMSC held published late (us7000png), and a late quake of
 *  its own (us7000own). */
const COMCAT = [
  usgs('us1', D0 + 2 * HOUR, 4.6),
  usgs('us2', D0 + 5 * HOUR, 4.6, { lat: 36.1, lon: 70.9, place: 'Afghanistan' }),
  usgs('us7000png', D0 + 9 * HOUR + 1_500, 4.8, { lat: -6.12, lon: 147.25, place: 'Papua New Guinea' }),
  usgs('us7000own', D0 + 20 * HOUR, 4.5, { lat: -56.3, lon: -27.1, place: 'South Sandwich Islands' }),
];
function comcat(rows: RawObs[]): { fetchWindow: DayRunDeps['fetchWindow']; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchWindow: async (p, s, e) => {
      calls.push(p.id);
      const obs = rows.filter((r) => r.provider === p.id && r.eventTimeMs >= s - 60_000 && r.eventTimeMs <= e + 60_000);
      return { provider: p.id, obs, status: { ok: true, events_returned: obs.length }, overflow: false } as WindowOutcome;
    },
  };
}
const lateDeps = (dir: string, partitions: Map<string, FrozenPartition>, fetchWindow: DayRunDeps['fetchWindow'], over: Partial<DayRunDeps> = {}): DayRunDeps => ({
  store: new LocalStore(join(dir, 'releases')), registry, fetchWindow, archives: [], arch: { days: new Map(), failedMonths: new Set() }, partitions,
  work: dir, nowMs: NOW, seqMarker: 900_000, spacingMs: 0, sleep: async () => {}, ...over,
});
const task = [{ provider: 'usgs', day: D, reason: 'late_usgs' as const }];
const assets = (dir: string): string[] => {
  try {
    return readdirSync(join(dir, 'releases', 'remediation-2026')).sort();
  } catch {
    return [];
  }
};

test('late_usgs day: a changed day gets an edition on its frozen partition that adds ComCat\'s rows and keeps every other row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efd-late-'));
  try {
    const parts = frozenPartitions();
    const base = parts.get(D)!;
    const idx = emptyRemediationIndex();
    const r = await remediateDay(D, task, idx, lateDeps(dir, parts, comcat(COMCAT).fetchWindow));
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.late!.added, ['us2', 'us7000own', 'us7000png']);
    assert.equal(r.late!.held_from, 'events/2026/09/15.ndjson');
    const ed = r.edition!;
    assert.equal(ed.reason, 'late_usgs');
    assert.equal(ed.asset, 'events-2026-09-15.e1.ndjson.gz');
    assert.deepEqual(ed.built_on, base.ref, 'built on the frozen partition: tag data, its sha256 and blob');
    assert.deepEqual(ed.built_from, ['raw-usgs-2026-09-15.ndjson.gz']);
    assert.deepEqual(Object.fromEntries(Object.entries(ed.context!).map(([d, c]) => [d, c.tag])), { '2026-09-14': 'data', '2026-09-15': 'data', '2026-09-16': 'data' });
    assert.equal(idx.raw[0]!.reason, 'late_usgs');
    // ComCat's rows join the events the day holds (the PNG quake EMSC held) or mint their own; nothing else moves.
    assert.deepEqual(ed.stats.provider_rows.usgs, { before: 2, after: 4 });
    assert.equal(ed.stats.provider_rows.emsc, undefined, 'EMSC\'s rows are untouched');
    assert.equal(ed.stats.new_events, 1, 'us7000own; us7000png joined EMSC\'s event');
    assert.equal(ed.stats.events, ed.stats.archived_events + 1);
    const text = gunzipSync(readFileSync(join(dir, 'releases', 'remediation-2026', ed.asset))).toString('utf8');
    const nodes = text.split('\n').filter(Boolean).map((l) => featureToNode(JSON.parse(l)));
    assert.deepEqual(lateUsgsKeeps(base.nodes, nodes), []);
    for (const n of base.nodes) assert.ok(nodes.some((m) => m.feedId === n.feedId), `${n.feedId} kept`);
    const m45 = lateUsgsRowsOfNodes(nodes).filter((x) => (x.mag ?? 0) >= 4.5).map((x) => x.id).sort();
    assert.deepEqual(m45, ['us1', 'us2', 'us7000own', 'us7000png'], 'the day now holds ComCat\'s M4.5+ set');
    const png = nodes.find((n) => n.provenance.some((p) => p.nativeId === 'us7000png'))!;
    assert.deepEqual(png.provenance.map((p) => p.provider).sort(), ['emsc', 'usgs']);

    // The next day's run: ComCat answers the same, compared with the raw the edition took: nothing is published.
    const before = assets(dir);
    const again = await remediateDay(D, task, idx, lateDeps(dir, parts, comcat(COMCAT).fetchWindow));
    assert.deepEqual(again.failed, []);
    assert.equal(again.edition, undefined);
    assert.equal(again.late!.changed, false);
    assert.equal(again.late!.held_from, 'remediation-2026/raw-usgs-2026-09-15.ndjson.gz');
    assert.deepEqual(assets(dir), before, 'an unchanged day uploads nothing');
    assert.equal(idx.editions.length, 1);

    // ComCat revises us7000own by 0.4 a week later: the next edition, again on the partition, from the new raw only.
    const revised = COMCAT.map((x) => (x.providerEventId === 'us7000own' ? { ...x, mag: 4.9 } : x));
    const third = await remediateDay(D, task, idx, lateDeps(dir, parts, comcat(revised).fetchWindow));
    assert.deepEqual(third.late!.revised, [{ id: 'us7000own', from: 4.5, to: 4.9 }]);
    assert.equal(third.edition!.edition, 2);
    assert.deepEqual(third.edition!.built_from, ['raw-usgs-2026-09-15.g2.ndjson.gz']);
    assert.deepEqual(third.edition!.built_on, base.ref);
    assert.equal(third.edition!.stats.new_events, 3 - 2, 'built on the partition again: us7000own is minted again, us2 and us7000png join');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('late_usgs day: no new edition while ComCat is unchanged since the last edition; one late_usgs entry per day in the index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efd-late-'));
  try {
    const parts = frozenPartitions();
    const idx = emptyRemediationIndex();
    const deps = (rows: RawObs[]) => lateDeps(dir, parts, comcat(rows).fetchWindow);
    const e1 = (await remediateDay(D, task, idx, deps(COMCAT))).edition!;
    // ComCat revises us7000own: e2 replaces e1 in the index (the asset stays in the Release).
    const revised = COMCAT.map((x) => (x.providerEventId === 'us7000own' ? { ...x, mag: 4.9 } : x));
    const second = await remediateDay(D, task, idx, deps(revised));
    assert.equal(second.edition!.edition, 2);
    assert.deepEqual(second.pruned, ['events-2026-09-15.e1.ndjson.gz', 'raw-usgs-2026-09-15.ndjson.gz']);
    assert.deepEqual(idx.editions.map((e) => e.asset), ['events-2026-09-15.e2.ndjson.gz']);
    assert.deepEqual(idx.editions[0]!.superseded, [e1.asset]);
    assert.deepEqual(idx.raw.map((r) => r.asset), ['raw-usgs-2026-09-15.g2.ndjson.gz'], 'only the raw the current edition is built from');
    assert.ok(assets(dir).includes(e1.asset) && assets(dir).includes('raw-usgs-2026-09-15.ndjson.gz'), 'superseded assets stay');
    // Daily runs with ComCat as e2 took it: compared with e2's raw, not with the partition (which still differs).
    const before = assets(dir);
    for (let k = 0; k < 3; k++) {
      const r = await remediateDay(D, task, idx, deps(revised));
      assert.equal(r.edition, undefined);
      assert.equal(r.late!.changed, false);
      assert.equal(r.late!.held_from, 'remediation-2026/raw-usgs-2026-09-15.g2.ndjson.gz');
    }
    assert.ok(lateUsgsDiff(lateUsgsRowsOfNodes(parts.get(D)!.nodes), lateUsgsRowsOfNodes(parts.get(D)!.nodes).concat([{ id: 'us7000own', ids: ['us7000own'], mag: 4.9 }])).changed, 'against the partition it would re-qualify');
    assert.deepEqual(assets(dir), before);
    assert.equal(idx.editions.length, 1);
    // A third change: e3, and the index still holds one entry naming both earlier ones.
    const third = await remediateDay(D, task, idx, deps(revised.map((x) => (x.providerEventId === 'us7000own' ? { ...x, mag: 4.5 } : x))));
    assert.equal(third.edition!.edition, 3);
    assert.deepEqual(idx.editions.map((e) => [e.asset, e.superseded]), [['events-2026-09-15.e3.ndjson.gz', ['events-2026-09-15.e1.ndjson.gz', 'events-2026-09-15.e2.ndjson.gz']]]);
    assert.deepEqual(idx.raw.map((r) => r.asset), ['raw-usgs-2026-09-15.g3.ndjson.gz']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('late_usgs prune: only earlier late_usgs editions of the day leave the index; other reasons, other days and withdrawn entries stay', () => {
  const ref = (day: string, edition: number, reason: 'late_usgs' | 'seam', tag = 'data') => ({
    day, edition, tag: 'remediation-2026', asset: `events-${day}.e${edition}.ndjson.gz`, url: '', sha256: 'x', bytes: 1,
    built_on: { tag, asset: 'a', sha256: 'b' }, built_from: [`raw-${day}-${edition}`], reason, stats: {} as never, built_at: '',
  });
  const raw = (day: string, edition: number, reason: 'late_usgs' | 'seam') => ({ provider: 'usgs', day, tag: 'remediation-2026', asset: `raw-${day}-${edition}`, url: '', sha256: 'x', bytes: 1, rows: 1, requests: 1, partial: false, fetched_at: '', reason });
  const idx = emptyRemediationIndex();
  idx.editions.push(ref('2026-09-15', 1, 'late_usgs'), { ...ref('2026-09-15', 2, 'late_usgs'), withdrawn: { at: '', reason: 'r' } }, ref('2026-09-16', 1, 'late_usgs'), ref('2026-06-29', 1, 'seam', 'archive-2026-06'));
  idx.raw.push(raw('2026-09-15', 1, 'late_usgs'), raw('2026-09-16', 1, 'late_usgs'), raw('2026-06-29', 1, 'seam'));
  const cur = ref('2026-09-15', 3, 'late_usgs');
  idx.editions.push(cur);
  idx.raw.push(raw('2026-09-15', 3, 'late_usgs'));
  assert.deepEqual(pruneLateUsgs(idx, cur), ['events-2026-09-15.e1.ndjson.gz', 'raw-2026-09-15-1']);
  assert.deepEqual(idx.editions.map((e) => e.asset), ['events-2026-09-15.e2.ndjson.gz', 'events-2026-09-16.e1.ndjson.gz', 'events-2026-06-29.e1.ndjson.gz', 'events-2026-09-15.e3.ndjson.gz']);
  assert.deepEqual(idx.raw.map((r) => r.asset), ['raw-2026-09-16-1', 'raw-2026-06-29-1', 'raw-2026-09-15-3']);
  assert.deepEqual(pruneLateUsgs(idx, ref('2026-06-29', 2, 'seam', 'archive-2026-06')), [], 'never for another reason');
});

test('late_usgs day: plan mode diffs only; an unchanged day, an archived day and a day without a partition publish nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efd-late-'));
  try {
    const parts = frozenPartitions();
    const idx = emptyRemediationIndex();
    const plan = await remediateDay(D, task, idx, lateDeps(dir, parts, comcat(COMCAT).fetchWindow, { publish: false }));
    assert.equal(plan.planned, true);
    assert.equal(plan.late!.changed, true);
    assert.deepEqual(idx, emptyRemediationIndex());
    assert.deepEqual(assets(dir), []);
    // ComCat as the partition holds it: unchanged.
    const same = comcat([usgs('us1', D0 + 2 * HOUR, 4.6), usgs('us2', D0 + 5 * HOUR, 4.4, { lat: 36.1, lon: 70.9 })]);
    const r = await remediateDay(D, task, idx, lateDeps(dir, parts, same.fetchWindow));
    assert.equal(r.late!.changed, false);
    assert.equal(r.edition, undefined);
    assert.deepEqual(same.calls, ['usgs', 'usgs', 'usgs', 'usgs'], 'one whole-day fetch in 6-hour windows');
    assert.deepEqual(assets(dir), []);
    // An archived day is the queue's (built on its archive), never a late_usgs day.
    const archived = await remediateDay(D, task, idx, lateDeps(dir, parts, comcat(COMCAT).fetchWindow, {
      archives: [{ period: '2026-09', tag: 'archive-2026-09', asset: 'events-2026-09.tar.zst', days: [D], sha256: 'x' } as DayRunDeps['archives'][number]],
    }));
    assert.match(archived.failed.join('\n'), /archived; a late_usgs edition supplements a frozen partition/);
    parts.delete(D);
    const none = await remediateDay(D, task, idx, lateDeps(dir, parts, comcat(COMCAT).fetchWindow));
    assert.match(none.failed.join('\n'), /no frozen partition/);
    assert.deepEqual(assets(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('late_usgs day: the partition\'s AFAD rows stored 3 h early (before 2026-10-01) are left as they are; only ComCat\'s rows are added', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'efd-late-'));
  try {
    const legacyAfad = (id: string, trueMs: number): RawObs => ({
      provider: 'afad', providerEventId: id, eventTimeMs: trueMs - 3 * HOUR, providerUpdatedMs: null, status: null, lat: 39.2, lon: 28.1, depth: 7, mag: 2.1, magType: 'ML',
      place: 'S\u0131nd\u0131rg\u0131 (Bal\u0131kesir)', knownAliasIds: [],
      fields: { eventID: id, date: new Date(trueMs).toISOString().slice(0, 19), latitude: '39.2', longitude: '28.1', depth: '7', type: 'ML', magnitude: '2.1', location: 'S\u0131nd\u0131rg\u0131 (Bal\u0131kesir)' },
    });
    const parts = frozenPartitions();
    // The day's partition gains two AFAD rows as the pre-2026-10-01 parser stored them (one re-reads onto the next day).
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, priorityMap(registry), configMap(registry), D0 + 2 * DAY_MS, { hotFloorMs: 0, merge: false });
    r.ingest(legacyAfad('900001', D0 + 10 * HOUR), '2026-09-16T00:00:00.000Z');
    r.ingest(legacyAfad('900002', D0 + 25 * HOUR), '2026-09-16T00:00:00.000Z');
    const base = parts.get(D)!;
    const nodes = [...base.nodes, ...[...map.values()].map((n) => featureToNode(JSON.parse(JSON.stringify(nodeToFeature(n)))))];
    parts.set(D, { nodes, ref: { ...base.ref, sha256: 'with-afad' } });
    // An edition of another reason would re-read them (the fixture holds two legacy rows).
    const ctx = new Map([...parts].map(([d, p]) => [d, p.nodes.map((n) => structuredClone(n))]));
    assert.equal(buildDayEdition({ day: D, context: ctx, rows: [], registry, nowMs: NOW, ingestTime: '2026-11-14T12:00:00.000Z', seqMarker: 1, fmt: EDITION_FORMAT }).stats.afad_retimed, 2);
    const res = await remediateDay(D, task, emptyRemediationIndex(), lateDeps(dir, parts, comcat(COMCAT).fetchWindow));
    assert.deepEqual(res.failed, []);
    assert.equal(res.edition!.stats.afad_retimed, 0);
    assert.equal(res.edition!.stats.afad_moved_out, 0);
    assert.deepEqual(res.edition!.stats.provider_rows.afad, undefined, 'AFAD\'s rows are untouched');
    const text = gunzipSync(readFileSync(join(dir, 'releases', 'remediation-2026', res.edition!.asset))).toString('utf8');
    const out = text.split('\n').filter(Boolean).map((l) => featureToNode(JSON.parse(l)));
    for (const n of nodes.filter((x) => x.provenance.some((p) => p.provider === 'afad'))) {
      const m = out.find((x) => x.feedId === n.feedId)!;
      assert.equal(m.state, 'live');
      assert.equal(m.eventTimeMs, n.eventTimeMs, 'kept at its stored time');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('late_usgs keeps: a build that drops an event or a report, or retires another source\'s live row, is refused', () => {
  const base = frozenPartitions().get(D)!.nodes;
  assert.deepEqual(lateUsgsKeeps(base, base), []);
  assert.match(lateUsgsKeeps(base, base.slice(1)).join('\n'), /of the partition is not in the edition/);
  const retired = base.map((n) => (n.provenance.some((p) => p.provider === 'emsc') ? { ...n, state: 'superseded' as const } : n));
  assert.match(lateUsgsKeeps(base, retired).join('\n'), /emsc:e\d was live in the partition and is not live in the edition/);
  const noRow = base.map((n) => ({ ...n, provenance: n.provenance.filter((p) => p.nativeId !== 'e2') }));
  assert.match(lateUsgsKeeps(base, noRow).join('\n'), /emsc:e2 of the partition is not in the edition/);
});

test('late_usgs mode: the scheduled run takes LATE_USGS_SCHEDULED; blank is off; anything else is refused', () => {
  assert.equal(LATE_USGS_SCHEDULED, 'on', 'the scheduled run publishes since the 2026-11-14 campaign (120 editions, 0 failures)');
  assert.equal(resolveLateMode(undefined), 'off');
  assert.equal(resolveLateMode(''), 'off');
  assert.equal(resolveLateMode('off'), 'off');
  assert.equal(resolveLateMode('scheduled'), LATE_USGS_SCHEDULED);
  assert.equal(resolveLateMode('scheduled', 'on'), 'on');
  assert.equal(resolveLateMode('plan'), 'plan');
  assert.equal(resolveLateMode(' on '), 'on');
  assert.throws(() => resolveLateMode('yes'), /must be on, plan, off or scheduled/);
});

// --- the statistics' warning names the cause ---

const GATE = { eraB: { m6: [0.98, 1.02] as [number, number], m45: [0.98, 1.02] as [number, number] }, default: { m6: [0.85, 1.2] as [number, number], m45: [0.85, 1.4] as [number, number] }, current_year: 'warn' as const };

test('stats gate: the open year below ComCat warns with "late ComCat", above it with "split copies"; a closed year keeps the bare numbers', async () => {
  const count = (m6: number, m45: number) => async (_s: number, _e: number, min: number) => (min >= 6 ? m6 : m45);
  const low = await comcatGate({ year: 2026, through: '2026-11-03', eraB: false, currentYear: true, feed: { m6: 100, m45: 7000 }, gate: GATE, count: count(110, 8400) });
  assert.equal(low.gate, 'warn');
  assert.match(low.message!, /^late ComCat: M6\+ 100 vs ComCat 110/);
  const both = await comcatGate({ year: 2026, through: '2026-11-03', eraB: false, currentYear: true, feed: { m6: 150, m45: 7000 }, gate: GATE, count: count(110, 8400) });
  assert.match(both.message!, /^late ComCat \+ split copies: /);
  const closed = await comcatGate({ year: 2025, through: '2026-11-03', eraB: false, currentYear: false, feed: { m6: 100, m45: 7000 }, gate: GATE, count: count(110, 8400) });
  assert.equal(closed.gate, 'fail');
  assert.match(closed.message!, /^M6\+ 100 vs ComCat 110/);
  assert.deepEqual(gateCauses({ m6: 1, m45: 1 }, GATE.default), ['no ComCat ratio']);
  assert.equal(LATE_COMCAT, 'late ComCat');
});

test('stats verify: a month that is not settled yet and below ComCat names "late ComCat"; a settled one keeps the bare numbers', () => {
  const b = GATE.default;
  const settling = verifyRow('2026-10', { n45: 660, m6: 12, dup: 0 }, { m45: 780, m6: 12 }, b, false, true);
  assert.equal(settling.ok, false, 'still reported as off ComCat');
  assert.match(settling.note!, /^late ComCat, settles within 45 days: M4\.5\+ ratio 0\.8462/);
  assert.equal(verifyRow('2026-08', { n45: 660, m6: 12, dup: 0 }, { m45: 780, m6: 12 }, b, false, false).note, 'M4.5+ ratio 0.8462, M6+ 12 vs 12');
  assert.equal(verifyRow('2025-08', { n45: 1125, m6: 30, dup: 0 }, { m45: 983, m6: 14 }, b, false, true).note, 'M4.5+ ratio 1.1445, M6+ 30 vs 14', 'above ComCat is not late ComCat');
});

test('dry runs say so; the stats log names the editions by reason (the 2026-11-14 campaign ran as dry runs and published nothing)', () => {
  assert.equal(dryRunNotice(false, 32), null);
  assert.match(dryRunNotice(true, 32)!, /^DRY RUN: 32 edition\(s\) built into the workflow artifact remediation-dry-run; nothing was uploaded .* dry_run=false to publish\.$/);
  const idx = emptyRemediationIndex();
  assert.equal(editionReasons(idx), 'none');
  const e = (reason?: 'late_usgs' | 'seam') => ({ ...(reason ? { reason } : {}) }) as never;
  idx.editions.push(e('seam'), e(), e('late_usgs'), e('late_usgs'));
  assert.equal(editionReasons(idx), 'late_usgs 2, saturated 1, seam 1');
});
