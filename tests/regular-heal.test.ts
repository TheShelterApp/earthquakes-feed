import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { HEAL_MAX_FOLDS_PER_RUN, dataPaths } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { runFeedSideSteps } from '../src/heal.js';
import { LogBuffer } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, RawObs } from '../src/types.js';

// FEED-6: the heal pass (Resolver.heal) runs every aggregate run, capped at HEAL_MAX_FOLDS_PER_RUN folds, instead of
// once per HEAL_EPOCH. Pairs the reports' own merge pass never reaches (a mint folds nothing; a revision may never come)
// fold on the next run.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);
const iso = (ms: number): string => new Date(ms).toISOString();
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const NOW = Date.parse('2026-10-04T09:00:00Z');
const KM_PER_DEG = 111.195;

function obs(provider: string, id: string, over: Partial<RawObs> = {}): RawObs {
  return {
    provider, providerEventId: id, eventTimeMs: NOW - 86_400_000, providerUpdatedMs: null, status: 'automatic',
    lat: 10, lon: 120, depth: 10, mag: 4.6, magType: 'mb', place: 'test', knownAliasIds: [], fields: {}, ...over,
  };
}

/** `n` pairs of reports of one quake each (USGS and GEOFON 5 km apart), placed apart the way production placed many
 *  before a rule change: the GEOFON report first 60 km off, then revised next to USGS's while no merge pass ran
 *  (merge=false). Each pair is mergeable, none folded. */
function unfolded(n: number): Map<string, EventNode> {
  const map = new Map<string, EventNode>();
  const quiet = new Resolver(map, prio, cfg, NOW, { merge: false });
  for (let i = 0; i < n; i++) {
    const at = { eventTimeMs: NOW - 86_400_000 + i * 3_600_000, lon: 120 + i };
    quiet.ingest(obs('usgs', `us6000ra${String(i).padStart(2, '0')}`, at), iso(NOW - 3_600_000));
    quiet.ingest(obs('geofon', `gfz2026ra${String(i).padStart(2, '0')}`, { ...at, lat: 10 + 60 / KM_PER_DEG }), iso(NOW - 3_600_000));
    quiet.ingest(obs('geofon', `gfz2026ra${String(i).padStart(2, '0')}`, { ...at, lat: 10 + 5 / KM_PER_DEG }), iso(NOW - 3_000_000));
  }
  assert.equal(live(map).length, 2 * n, 'setup: every pair apart');
  return map;
}

function sideRun(root: string, map: Map<string, EventNode>, seq: number, nowMs: number, healDue = false): { log: LogBuffer; side: ReturnType<typeof runFeedSideSteps> } {
  const log = new LogBuffer(seq, iso(nowMs));
  const side = runFeedSideSteps(root, new Resolver(map, prio, cfg, nowMs), log, { healDue, loadDays: 10, ingestTime: iso(nowMs) });
  return { log, side };
}

test('config: at most 100 folds a run', () => {
  assert.equal(HEAL_MAX_FOLDS_PER_RUN, 100);
});

test('every run folds what the reports left apart, logged like the epoch heal; a second run is a no-op', () => {
  const root = mkdtempSync(join(tmpdir(), 'regular-heal-'));
  try {
    const map = unfolded(3);
    const first = sideRun(root, map, 1000, NOW);
    assert.deepEqual(first.side.regularHeal, { merged: 3, survivors: 3, capped: false });
    assert.equal(first.side.heal, null, 'no epoch heal');
    assert.equal(existsSync(dataPaths(root).healMarker), false, 'the marker is the epoch heal’s only');
    assert.equal(live(map).length, 3);
    assert.deepEqual(first.log.lines.map((l) => l.op), ['merge', 'merge', 'merge', 'correction', 'correction', 'correction']);
    for (const l of first.log.lines) assert.ok(vObs(l), JSON.stringify(vObs.errors));
    for (const l of first.log.lines.filter((x) => x.op === 'correction')) assert.match(l.reason!, /^heal: absorbed efd_/);
    assert.deepEqual(first.log.lines.map((l) => l.seq), [1001, 1002, 1003, 1004, 1005, 1006]);

    const second = sideRun(root, map, first.log.seq, NOW + 300_000);
    assert.deepEqual(second.side.regularHeal, { merged: 0, survivors: 0, capped: false });
    assert.equal(second.log.lines.length, 0, 'idempotent: nothing written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the cap spreads a large heal over several runs, each one logged', () => {
  const map = unfolded(5);
  const runs: [number, boolean][] = [];
  for (let run = 0; run < 5; run++) {
    const { merges, capped } = new Resolver(map, prio, cfg, NOW).heal(iso(NOW + run * 300_000), 2);
    runs.push([merges.length, capped]);
  }
  assert.deepEqual(runs, [[2, true], [2, true], [1, false], [0, false], [0, false]]);
  assert.equal(live(map).length, 5);
});

test('an epoch heal run makes the epoch heal and no regular heal', () => {
  const root = mkdtempSync(join(tmpdir(), 'regular-heal-'));
  try {
    const map = unfolded(2);
    const { side } = sideRun(root, map, 50, NOW, true);
    assert.equal(side.regularHeal, null);
    assert.equal(side.heal?.merged, 2);
    assert.equal(existsSync(dataPaths(root).healMarker), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a heal leaves events outside the hot window alone', () => {
  const map = unfolded(1);
  const old = [...map.values()].map((n) => JSON.parse(JSON.stringify(n)) as EventNode);
  // Eight days later both events are past the 7-day hot window.
  const later = NOW + 8 * 86_400_000;
  const r = new Resolver(new Map(old.map((n) => [n.feedId, n])), prio, cfg, later);
  assert.equal(r.heal(iso(later)).merges.length, 0);
});
