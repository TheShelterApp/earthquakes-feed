import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { featureToNode } from '../src/bitemporal.js';
import { HEAL_EPOCH, HOT_WINDOW_DAYS } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { healedEpoch, runFeedSideSteps, writeHealMarker } from '../src/heal.js';
import { LogBuffer } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';
import { deterministicFeedId } from '../src/ulid.js';

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);

/** The Loyalty Islands M7.0 of 2026-09-25 21:23 UTC as production published it: six live ids. */
const T0 = Date.parse('2026-09-25T21:23:03Z');
const USGS_ID = 'efd_01M3D76ES08HGFRSA05T71J8ZF';
const published = readFileSync(here('fixtures/loyalty-2026-09-25-published.ndjson'), 'utf8').split('\n').filter(Boolean);
function loyaltyMap(): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  for (const l of published) {
    const n = featureToNode(JSON.parse(l));
    map.set(n.feedId, n);
  }
  return map;
}
const INSIDE = Date.parse('2026-09-28T15:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

test('heal: the six published Loyalty ids fold into the USGS id with no report behind it', () => {
  const map = loyaltyMap();
  const r = new Resolver(map, prio, cfg, INSIDE);
  const { merges, survivors } = r.heal(iso(INSIDE));
  assert.equal(merges.length, 5);
  assert.deepEqual(survivors.map((n) => n.feedId), [USGS_ID]);
  const live = [...map.values()].filter((n) => n.state === 'live');
  assert.deepEqual(live.map((n) => n.feedId), [USGS_ID], 'one live id — the one the app already shows');
  assert.equal(live[0]!.aliases.length, 12, 'all 12 provider ids');
  for (const n of map.values()) if (n !== live[0]) assert.equal(n.supersededBy, USGS_ID, `${n.feedId} points at the survivor`);
  assert.deepEqual(r.heal(iso(INSIDE + 300_000)).merges, [], 'idempotent: a second pass folds nothing');
});

test('heal lines: op:merge per fold, then op:correction per survivor — schema-valid, one seq per change', () => {
  const map = loyaltyMap();
  const r = new Resolver(map, prio, cfg, INSIDE);
  const { merges, survivors } = r.heal(iso(INSIDE));
  const log = new LogBuffer(184_629, iso(INSIDE));
  log.recordHeal(merges, survivors, HEAL_EPOCH);
  assert.deepEqual(log.lines.map((l) => l.op), ['merge', 'merge', 'merge', 'merge', 'merge', 'correction']);
  assert.deepEqual(log.lines.map((l) => l.seq), [184_630, 184_631, 184_632, 184_633, 184_634, 184_635]);
  for (const l of log.lines) assert.ok(vObs(l), ajv.errorsText(vObs.errors));
  for (const l of log.lines.slice(0, 5)) assert.equal(l.superseded_by, USGS_ID, 'every op:merge names the final survivor');
  const corr = log.lines[5]!;
  const survivor = map.get(USGS_ID)!;
  assert.equal(corr.feed_id, USGS_ID);
  assert.equal(corr.revision, survivor.revision);
  assert.equal(corr.provider, survivor.chosenProvider);
  assert.match(corr.reason!, new RegExp(`^heal epoch ${HEAL_EPOCH}: absorbed (efd_[0-9A-Z]{26}, ){4}efd_[0-9A-Z]{26}$`));
  assert.equal(survivor.lastSeq, corr.seq, "the survivor's ingest_seq is its own line");
  const seqs = [...map.values()].map((n) => n.lastSeq);
  assert.equal(new Set(seqs).size, seqs.length, 'no two nodes share a lastSeq (the change-log stays strictly increasing)');
  assert.equal(log.merged, 5);
});

test('heal is bounded by the hot window and off on paths with no log (merge=false)', () => {
  const late = T0 + HOT_WINDOW_DAYS * 86_400_000 + 3600_000;
  assert.deepEqual(new Resolver(loyaltyMap(), prio, cfg, late).heal(iso(late)).merges, [], 'an hour past event time + 7 d: nothing');
  assert.deepEqual(new Resolver(loyaltyMap(), prio, cfg, INSIDE, { merge: false }).heal(iso(INSIDE)).merges, []);
});

/** Puerto Rico, 2026-09-27 (dense Guánica cell, so none of these joined at first sight): USGS's
 *  M1.2 at 06:05:40.79, and 22.6 s later one M2.0 reported by both EMSC and USGS to the
 *  millisecond. The EMSC node is within the window of both USGS nodes; its twin is the second. */
const PR_T = Date.parse('2026-09-27T06:05:40.790Z');
function node(provider: string, id: string, over: Partial<RawObs>): EventNode {
  const map = new Map<string, EventNode>();
  const raw: RawObs = {
    provider,
    providerEventId: id,
    eventTimeMs: PR_T,
    providerUpdatedMs: null,
    status: provider === 'usgs' ? 'reviewed' : null,
    lat: 17.9211667,
    lon: -66.9456667,
    depth: 6.76,
    mag: 1.2,
    magType: 'md',
    place: 'Guánica, Puerto Rico',
    knownAliasIds: [],
    fields: {},
    ...over,
  };
  return new Resolver(map, prio, cfg, PR_T + 86_400_000).ingest(raw, '2026-09-27T07:42:02.919Z').node;
}
function puertoRico(): { map: Map<string, EventNode>; small: EventNode; emsc: EventNode; twin: EventNode } {
  const small = node('usgs', 'pr71534823', {});
  const emsc = node('emsc', '20260927_0000066', { eventTimeMs: PR_T + 22_590, lat: 17.9067, lon: -66.9518, depth: 8.4, mag: 2.0 });
  const twin = node('usgs', 'pr71534788', { eventTimeMs: PR_T + 22_590, lat: 17.9066667, lon: -66.9518333, depth: 8.37, mag: 2.01 });
  // Minted apart, the twins get the same content-seeded id; in one map the second takes the salted one.
  if (twin.feedId === emsc.feedId) twin.feedId = deterministicFeedId(twin.eventTimeMs, twin.lat, twin.lon, 1);
  const map = new Map<string, EventNode>([small, emsc, twin].map((n) => [n.feedId, n]));
  return { map, small, emsc, twin };
}

test('mutual best: the heal folds EMSC into its twin, not into the nearer-in-order M1.2 22.6 s earlier', () => {
  const { map, small, emsc, twin } = puertoRico();
  const r = new Resolver(map, prio, cfg, PR_T + 86_400_000);
  // Every gate accepts EMSC with either USGS node; only the pairing decides.
  assert.equal(r.whyNotMerged(small, emsc), null);
  assert.equal(r.whyNotMerged(twin, emsc), null);
  const { merges } = r.heal('2026-09-27T12:00:00.000Z');
  assert.deepEqual(merges.map((m) => [m.loser.feedId, m.survivor.feedId]), [[emsc.feedId, twin.feedId]]);
  assert.equal(small.state, 'live', 'the M1.2 stays its own event');
  assert.notEqual(r.whyNotMerged(small, twin), null, 'two USGS reviewed ids 22.6 s and ΔM 0.8 apart never fold');
});

test('mutual best on the report path: a revision of the M1.2 folds the neighbour pair, never EMSC into itself', () => {
  const { map, small, emsc, twin } = puertoRico();
  const r = new Resolver(map, prio, cfg, PR_T + 86_400_000);
  const res = r.ingest(
    { provider: 'usgs', providerEventId: 'pr71534823', eventTimeMs: PR_T, providerUpdatedMs: PR_T + 7200_000, status: 'reviewed', lat: 17.9212, lon: -66.9457, depth: 6.8, mag: 1.2, magType: 'md', place: 'Guánica, Puerto Rico', knownAliasIds: [], fields: {} },
    '2026-09-27T09:00:00.000Z',
  );
  assert.equal(res.node, small, 'the report lands on its own event');
  assert.deepEqual(res.merges.map((m) => [m.loser.feedId, m.survivor.feedId]), [[emsc.feedId, twin.feedId]], 'the neighbour pair folds first');
  assert.equal(small.state, 'live');
});

test('runFeedSideSteps with the heal due: logs, then writes the marker; the marker makes the next run skip it', () => {
  const root = mkdtempSync(join(tmpdir(), 'efd-heal-'));
  try {
    assert.equal(healedEpoch(root), 0, 'never healed');
    const map = loyaltyMap();
    const log = new LogBuffer(1000, iso(INSIDE));
    const res = runFeedSideSteps(root, new Resolver(map, prio, cfg, INSIDE), log, { healDue: true, loadDays: 45, ingestTime: iso(INSIDE) });
    assert.deepEqual(res.heal, {
      epoch: HEAL_EPOCH,
      ingest_time: iso(INSIDE),
      first_seq: 1001,
      last_seq: 1006,
      horizon_days: 45,
      retracted: 0,
      merged: 5,
      survivors: 1,
    });
    assert.equal(healedEpoch(root), HEAL_EPOCH);
    assert.ok(healedEpoch(root) >= HEAL_EPOCH, 'aggregate: healDue = healedEpoch < HEAL_EPOCH is now false');
    // A heal that finds nothing still records the epoch (and no seq range).
    const empty = mkdtempSync(join(tmpdir(), 'efd-heal-'));
    try {
      const r2 = runFeedSideSteps(empty, new Resolver(new Map(), prio, cfg, INSIDE), new LogBuffer(7, iso(INSIDE)), { healDue: true, loadDays: 45, ingestTime: iso(INSIDE) });
      assert.equal(r2.heal?.first_seq, null);
      assert.equal(healedEpoch(empty), HEAL_EPOCH);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    writeHealMarker(root, { ...res.heal!, epoch: 0 });
    assert.equal(healedEpoch(root), 0, 'a lower epoch on the branch means a heal is due again');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
