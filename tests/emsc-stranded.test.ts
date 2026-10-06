import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { EMSC_STRANDED_MIN_DT_MS } from '../src/config.js';
import { REHOMED_REASON_PREFIX, Resolver } from '../src/dedup.js';
import { runFeedSideSteps } from '../src/heal.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';

// Round 14, the EMSC re-point guard: EMSC re-points one of its own event ids to another quake now and then, and the row
// stays in the event it joined. The fixture holds the real log lines of three such ids (each a copy of an agency EMSC's
// copy rules do not cover: JMA, and Argentina's INPRES under EMSC's code NSNA) and of one EMSC id that switched from
// JMA's minute-rounded copy to NEIC's solution of the same quake (2026-08-20), which must stay where it is.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');
const groups = (map: Map<string, EventNode>): string[] => live(map).map(rowsOf).sort();

const LINES: Observation[] = readFileSync(here('fixtures/emsc-stranded-2026.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Observation);

/** The lines of the quake on `day` (event time prefix), replayed as the runs that logged them saw them. */
function replayed(prefix: string, opts: { merge?: boolean } = {}): { map: Map<string, EventNode>; nowMs: number } {
  const lines = LINES.filter((o) => o.event_time.startsWith(prefix));
  const nowMs = Date.parse(lines.at(-1)!.ingest_time);
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs, opts);
  for (const o of lines) r.ingest(observationToRaw(o), o.ingest_time);
  return { map, nowMs };
}

const CASES: [string, string, string[], string[]][] = [
  // JMA's quakes of 11:10:17 and 11:11:06 (ids 20260728201017 / 201106, 14 km apart): EMSC's id copied the first, then
  // the second.
  ['2026-07-28T11:1', 'Kyushu 2026-07-28', ['emsc:20260728_0000230 jma:20260728201017', 'jma:20260728201106'], ['emsc:20260728_0000230 jma:20260728201106', 'jma:20260728201017']],
  // INPRES's quakes of 20:30:12 and 20:30:51, 235 km apart.
  ['2026-08-14T20:3', 'Argentina 2026-08-14', ['emsc:20260814_0000264 inpres:20260814203012', 'inpres:20260814203051'], ['emsc:20260814_0000264 inpres:20260814203051', 'inpres:20260814203012']],
  // INPRES's quakes of 17:34:10 and 17:33:34, 140 km apart.
  ['2026-08-20T17:3', 'Argentina 2026-08-20', ['emsc:20260820_0000521 inpres:20260820173410', 'inpres:20260820173334'], ['emsc:20260820_0000521 inpres:20260820173334', 'inpres:20260820173410']],
];

test('config: an EMSC row moves only when it is more than 10 s from every other row of its event', () => {
  assert.equal(EMSC_STRANDED_MIN_DT_MS, 10_000);
});

test('a re-pointed EMSC row stays where it joined at the revision, and the next run moves it to the row it copies', () => {
  for (const [prefix, label, before, after] of CASES) {
    const { map, nowMs } = replayed(prefix);
    assert.deepEqual(groups(map), before.sort(), `${label}: the revision itself moves nothing`);
    const scratch = mkdtempSync(join(tmpdir(), 'stranded-'));
    try {
      const it = new Date(nowMs + 300_000).toISOString();
      const log = new LogBuffer(500_000, it);
      const side = runFeedSideSteps(scratch, new Resolver(map, prio, cfg, nowMs + 300_000), log, { healDue: false, loadDays: 10, ingestTime: it });
      assert.equal(side.stranded, 1, label);
      assert.equal(side.rehomed, 0, `${label}: not a FEED-2 copy`);
      assert.deepEqual(groups(map), after.sort(), label);
      assert.deepEqual(log.lines.map((l) => l.op), ['tombstone', 'observe'], label);
      for (const l of log.lines) assert.ok(vObs(l), JSON.stringify(vObs.errors));
      assert.ok(log.lines[0]!.reason?.startsWith(REHOMED_REASON_PREFIX), log.lines[0]!.reason);
      assert.match(log.lines[0]!.reason!, /re-pointed, \d+\.\d s or more from every other row of efd_\w+; one quake with efd_\w+/);
      // Idempotent: nothing is stranded any more.
      const again = new LogBuffer(log.seq, it);
      assert.equal(runFeedSideSteps(scratch, new Resolver(map, prio, cfg, nowMs + 600_000), again, { healDue: false, loadDays: 10, ingestTime: it }).stranded, 0);
      assert.equal(again.lines.length, 0, label);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('EMSC listing the row again unchanged moves it as well, and the logged lines replay to the same events', () => {
  const [prefix] = CASES[1]!;
  const { map, nowMs } = replayed(prefix);
  const r = new Resolver(map, prio, cfg, nowMs);
  const emsc = LINES.filter((o) => o.provider === 'emsc' && o.event_time.startsWith(prefix)).at(-1)!;
  const log = new LogBuffer(emsc.seq, emsc.ingest_time);
  const raw = observationToRaw(emsc);
  log.record(raw, r.ingest(raw, emsc.ingest_time));
  assert.deepEqual(groups(map), CASES[1]![3].sort());
  assert.deepEqual(log.lines.map((l) => l.op), ['tombstone', 'observe']);
  // Replay: every line of the fixture day, then the logged lines (the re-home withdrawal skipped, as scripts/replay-dedup
  // does: the observe line after it re-does the move).
  const replay = new Map<string, EventNode>();
  const rr = new Resolver(replay, prio, cfg, nowMs);
  for (const o of [...LINES.filter((l) => l.event_time.startsWith(prefix)), ...log.lines]) {
    if (o.op === 'tombstone' && o.reason?.startsWith(REHOMED_REASON_PREFIX)) continue;
    rr.ingest(observationToRaw(o), o.ingest_time);
  }
  assert.deepEqual(groups(replay), groups(map));
});

test('EMSC switching from JMA’s minute-rounded copy to NEIC’s solution of the same quake stays one event', () => {
  // 2026-08-20 05:28: JMA's row (05:28:00, minute-rounded) and EMSC's copy of it, then EMSC's id takes NEIC's solution
  // (05:28:41, 36 km off) and ComCat's row of it arrives. The merge pass folds ComCat's event into EMSC's: no row is
  // stranded, nothing moves.
  const { map, nowMs } = replayed('2026-08-20T05:28');
  const before = groups(map);
  assert.deepEqual(before, ['emsc:20260820_0000216 jma:20260820142845 usgs:us6000tm2a']);
  const scratch = mkdtempSync(join(tmpdir(), 'stranded-'));
  try {
    const it = new Date(nowMs + 300_000).toISOString();
    const log = new LogBuffer(500_000, it);
    assert.equal(runFeedSideSteps(scratch, new Resolver(map, prio, cfg, nowMs + 300_000), log, { healDue: false, loadDays: 10, ingestTime: it }).stranded, 0);
    assert.deepEqual(groups(map), before);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a row within 10 s of another row of its event, a copy FEED-2 handles, or merge=false never moves', () => {
  const T = Date.parse('2026-08-14T20:30:12Z');
  const row = (provider: string, id: string, over: Partial<RawObs> = {}): RawObs => ({
    provider, providerEventId: id, eventTimeMs: T, providerUpdatedMs: null, status: null, lat: -27.99, lon: -66.67, depth: 10,
    mag: 2.7, magType: 'ml', place: 'Argentina', knownAliasIds: [], fields: { auth: 'NSNA' }, ...over,
  });
  const setup = (emscOver: Partial<RawObs>, opts: { merge?: boolean } = {}): Map<string, EventNode> => {
    const map = new Map<string, EventNode>();
    const r = new Resolver(map, prio, cfg, T + 3_600_000, opts);
    r.ingest(row('inpres', '1', { fields: {} }), '2026-08-14T20:36:00Z');
    r.ingest(row('emsc', 'e1'), '2026-08-14T20:36:00Z');
    // Another quake far away and its EMSC solution, then EMSC's id re-points there.
    r.ingest(row('inpres', '2', { fields: {}, lat: -25.879, lon: -66.505, eventTimeMs: T + 39_000 }), '2026-08-14T21:20:00Z');
    r.ingest(row('emsc', 'e1', { lat: -25.879, lon: -66.505, ...emscOver }), '2026-08-14T21:25:00Z');
    r.rehomeStrandedRows('2026-08-14T21:30:00Z');
    return map;
  };
  assert.deepEqual(groups(setup({ eventTimeMs: T + 39_000 })), ['emsc:e1 inpres:2', 'inpres:1'], 'moves (39 s)');
  assert.deepEqual(groups(setup({ eventTimeMs: T + 8_000 })), ['emsc:e1 inpres:1', 'inpres:2'], '8 s from its event’s row: stays');
  assert.deepEqual(groups(setup({ eventTimeMs: T + 39_000, fields: { auth: 'IGN' } })), ['emsc:e1 inpres:1', 'inpres:2'], 'an authored-copy code: FEED-2’s');
  assert.deepEqual(groups(setup({ eventTimeMs: T + 39_000 }, { merge: false })), ['emsc:e1 inpres:1', 'inpres:2'], 'merge=false');
});
