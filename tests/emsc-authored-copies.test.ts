import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { EMSC_AUTHORED_COPIES, HEAL_EPOCH, SWARM_CELL_ABSOLUTE } from '../src/config.js';
import { Resolver } from '../src/dedup.js';
import { LogBuffer, observationToRaw } from '../src/oplog.js';
import { configMap, loadRegistry, priorityMap } from '../src/providers.js';
import type { EventNode, Observation, RawObs } from '../src/types.js';
import { knownAliasIdsOf } from '../src/util.js';

// PF-5f: EMSC re-publishes some agencies' own solutions with `auth` naming the agency. Since PF-5e such a copy of an
// AFAD solution counts as AFAD's identity, the evidence a dense cell asks for before a location join. IGN, NC and
// SCSN copies behave the same way (checked over the observation log 2026-07-05..09-30 and the live services, see
// config EMSC_AUTHORED_COPIES), and until this change they stood beside the agency's event in the Granada and The
// Geysers cells: 27 IGN and 3 NC pairs in the 11 days to 2026-09-30. The rows below are the real ones.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const prio = priorityMap(registry);
const cfg = configMap(registry);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vObs = ajv.compile(JSON.parse(readFileSync(here('../schema/observation.schema.json'), 'utf8')) as object);
const iso = (ms: number): string => new Date(ms).toISOString();
const live = (map: Map<string, EventNode>): EventNode[] => [...map.values()].filter((n) => n.state === 'live');
const rowsOf = (n: EventNode): string => n.provenance.map((r) => `${r.provider}:${r.nativeId}`).sort().join(' ');
const NOW = Date.parse('2026-09-30T23:00:00Z');

/** Observation-log lines as production logged them (the latest line of each id; ComCat's first). */
const OBS = new Map<string, RawObs>();
for (const l of readFileSync(here('fixtures/emsc-authored-copies-2026-09.ndjson'), 'utf8').split('\n').filter(Boolean)) {
  const o = JSON.parse(l) as Observation;
  OBS.set(`${o.provider}:${o.provider_event_id}`, observationToRaw(o));
}
const obs = (key: string, over: Partial<RawObs> = {}): RawObs => {
  const raw = OBS.get(key);
  assert.ok(raw, key);
  return { ...raw, ...over, fields: { ...raw.fields, ...(over.fields ?? {}) } };
};

/** More live events than SWARM_CELL_ABSOLUTE around `at`, all older than it by 2 min steps, none sharing an id with
 *  anything below: a location join in that cell needs a shared id (or an authored copy). */
function denseAround(r: Resolver, at: { eventTimeMs: number; lat: number; lon: number }, provider: 'ign' | 'usgs', nowMs = NOW): void {
  for (let i = 0; i < SWARM_CELL_ABSOLUTE + 5; i++) {
    const id = provider === 'ign' ? `es2026bg${String(i).padStart(3, '0')}` : `nc7599${String(i).padStart(4, '0')}`;
    const fields: Record<string, string> = provider === 'usgs' ? { ids: `,${id},`, net: 'nc', code: id.slice(2) } : { evid: id };
    r.ingest(
      {
        provider, providerEventId: id, eventTimeMs: at.eventTimeMs - (i + 1) * 120_000, providerUpdatedMs: null, status: null,
        lat: at.lat + ((i % 5) - 2) * 0.0005, lon: at.lon + ((i % 3) - 1) * 0.0005, depth: 5, mag: 1.2, magType: 'md',
        place: 'background', knownAliasIds: knownAliasIdsOf(provider, id, fields), fields,
      },
      iso(nowMs),
    );
  }
}
function cell(at: RawObs, provider: 'ign' | 'usgs', nowMs = NOW): { map: Map<string, EventNode>; r: Resolver; base: number } {
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, prio, cfg, nowMs);
  denseAround(r, at, provider, nowMs);
  return { map, r, base: live(map).length };
}
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

test('config: EMSC copies of AFAD, IGN, NC and SCSN count as the agency’s identity', () => {
  // PF-5g added more codes (tests/emsc-authored-copies-pf5g.test.ts pins the whole map).
  for (const [code, provider] of [['AFAD', 'afad'], ['IGN', 'ign'], ['NC', 'ncedc'], ['SCSN', 'scedc']]) assert.equal(EMSC_AUTHORED_COPIES.get(code!), provider, code);
  assert.equal(HEAL_EPOCH, 2, 'the heal folds the copies minted beside the agency’s event before this change once');
});

test('IGN: in the Granada cell IGN es2026teoxk and EMSC’s IGN-authored copy are one event, in both orders', () => {
  // IGN's file cuts the seconds' fraction off (19:50:56) and says mbLg; EMSC keeps IGN's 19:50:56.54 and says ml.
  const ign = obs('ign:es2026teoxk');
  const copy = obs('emsc:20260930_0000246');
  assert.equal(copy.fields['auth'], 'IGN');
  for (const order of [[ign, copy], [copy, ign]]) {
    const { map, r, base } = cell(ign, 'ign');
    for (const raw of order) r.ingest(raw, iso(NOW));
    assert.equal(live(map).length, base + 1, order.map((o) => o.provider).join(' → '));
    const n = live(map).find((x) => x.aliases.includes('ign:es2026teoxk'))!;
    assert.equal(rowsOf(n), 'emsc:20260930_0000246 ign:es2026teoxk');
  }
});

test('NC: in The Geysers cell EMSC’s NC-authored copy joins NCEDC’s and ComCat’s rows of the event, in every order', () => {
  // nc75443977: NCEDC's text service truncates Md 2.06 to "2.0", EMSC rounds it to 2.1; ComCat's row keeps 2.06.
  for (const id of ['75441981', '75443977']) {
    const rows = [obs(`ncedc:${id}`), obs(`usgs:nc${id}`), obs(`emsc:${id === '75441981' ? '20260930_0000253' : '20260928_0000265'}`)];
    assert.equal(rows[2]!.fields['auth'], 'NC');
    for (const order of permutations(rows)) {
      const { map, r, base } = cell(rows[0]!, 'usgs');
      for (const raw of order) r.ingest(raw, iso(NOW));
      assert.equal(live(map).length, base + 1, `${id}: ${order.map((o) => o.provider).join(' → ')}`);
    }
  }
});

test('NC: ComCat’s `nc` row alone and NCEDC’s row alone are each enough', () => {
  const copy = obs('emsc:20260928_0000265');
  const comcat = obs('usgs:nc75443977');
  for (const order of [[comcat, copy], [copy, comcat]]) {
    const { map, r, base } = cell(comcat, 'usgs');
    for (const raw of order) r.ingest(raw, iso(NOW));
    assert.equal(live(map).length, base + 1, `ComCat: ${order.map((o) => o.provider).join(' → ')}`);
  }
  const ncedc = obs('ncedc:75441981');
  for (const order of [[ncedc, obs('emsc:20260930_0000253')], [obs('emsc:20260930_0000253'), ncedc]]) {
    const { map, r, base } = cell(ncedc, 'usgs');
    for (const raw of order) r.ingest(raw, iso(NOW));
    assert.equal(live(map).length, base + 1, `NCEDC: ${order.map((o) => o.provider).join(' → ')}`);
  }
});

test('SCSN: EMSC’s SCSN-authored copy joins SCEDC’s and ComCat’s `ci` rows of the event in a dense cell, in every order', () => {
  const rows = [obs('scedc:41341239'), obs('usgs:ci41341239'), obs('emsc:20260930_0000276')];
  assert.equal(rows[2]!.fields['auth'], 'SCSN');
  for (const order of permutations(rows)) {
    const { map, r, base } = cell(rows[0]!, 'usgs');
    for (const raw of order) r.ingest(raw, iso(NOW));
    assert.equal(live(map).length, base + 1, order.map((o) => o.provider).join(' → '));
  }
});

test('the dense-cell rule still holds for anything that is not the agency’s own solution', () => {
  const ign = obs('ign:es2026teoxk');
  const nc = obs('usgs:nc75443977');
  const copyIgn = obs('emsc:20260930_0000246');
  const copyNc = obs('emsc:20260928_0000265');
  const cases: [string, RawObs, RawObs][] = [
    ['an unmapped author (EMSC copy of NN)', nc, { ...copyNc, fields: { ...copyNc.fields, auth: 'NN' } }],
    ['EMSC’s own solution', ign, { ...copyIgn, fields: { ...copyIgn.fields, auth: 'EMSC' } }],
    ['ComCat’s row of another network (nn…)', { ...nc, providerEventId: 'nn00912345', knownAliasIds: knownAliasIdsOf('usgs', 'nn00912345', { ids: ',nn00912345,' }), fields: { ids: ',nn00912345,', net: 'nn' } }, copyNc],
    ['ComCat’s row of NEIC (us…)', { ...nc, providerEventId: 'us7000abcd', knownAliasIds: knownAliasIdsOf('usgs', 'us7000abcd', { ids: ',us7000abcd,' }), fields: { ids: ',us7000abcd,', net: 'us' } }, copyNc],
    ['IGN-authored, 3 s apart', ign, { ...copyIgn, eventTimeMs: copyIgn.eventTimeMs + 3_000 }],
    ['IGN-authored, 2.5 km apart', ign, { ...copyIgn, lat: copyIgn.lat + 0.0225 }],
    ['IGN-authored, ΔM 0.3', ign, { ...copyIgn, mag: 1.8 }],
    // A copy of the agency's first magnitude: EMSC's ml 3.4 of nc75407577, whose first ComCat origin was ml 4.24.
    ['an NC copy with a magnitude NC’s row never had', obs('usgs:nc75407577'), obs('emsc:20260729_0000042')],
  ];
  for (const [label, agency, copy] of cases) {
    // An hour after the quake, so both reports are inside the hot window (nc75407577 is from July).
    const nowMs = agency.eventTimeMs + 3_600_000;
    const { map, r, base } = cell(agency, agency.provider === 'ign' ? 'ign' : 'usgs', nowMs);
    r.ingest(agency, iso(nowMs));
    r.ingest(copy, iso(nowMs));
    assert.equal(live(map).length, base + 2, label);
  }
});

// --- the heal (epoch 2) over events as production held them on 2026-09-30 ---

const SPLITS = readFileSync(here('fixtures/emsc-authored-splits-2026-09.ndjson'), 'utf8').split('\n').filter(Boolean);
/** The fixture's live events (IGN and NC pairs minted apart in their dense cells before this change, and CI 41339663's
 *  event holding EMSC's copy of CI 41339671) with each dense cell's background around them. */
function splitMap(): { map: Map<string, EventNode>; r: Resolver; fixture: string[] } {
  const map = new Map<string, EventNode>();
  for (const l of SPLITS) {
    const n = JSON.parse(l) as EventNode;
    map.set(n.feedId, n);
  }
  const fixture = [...map.keys()];
  const r = new Resolver(map, prio, cfg, NOW);
  for (const id of ['efd_01M3SXXK50Y7GGTMJYTAJE0B05', 'efd_01M3MRXR2G1GVXZGGCY2MHYF6P']) denseAround(r, map.get(id)!, 'ign');
  for (const id of ['efd_01M3T15Z00WZHCYH90PPDX3QX2', 'efd_01M3MTT5NGYGHWNBGZ0VQEW4TT']) denseAround(r, map.get(id)!, 'usgs');
  return { map, r, fixture };
}

test('heal: each IGN / NC pair folds into one event; CI 41339663’s event keeps EMSC’s copy of 41339671 and stays apart', () => {
  const { map, r, fixture } = splitMap();
  const idsBefore = new Set(fixture.flatMap((f) => map.get(f)!.provenance.map((p) => `${p.provider}:${p.nativeId}`)));
  const { merges, survivors } = r.heal(iso(NOW));
  assert.equal(merges.length, 4, merges.map((m) => `${m.loser.feedId} → ${m.survivor.feedId}: ${m.reason}`).join('\n'));
  const groups = survivors.map(rowsOf).sort();
  assert.deepEqual(groups, [
    'emsc:20260928_0000265 ncedc:75443977 usgs:nc75443977',
    'emsc:20260928_0000267 ign:es2026taxtr',
    'emsc:20260930_0000246 ign:es2026teoxk',
    'emsc:20260930_0000253 ncedc:75441981 usgs:nc75441981',
  ]);
  for (const m of merges) {
    assert.ok(Math.abs(m.survivor.eventTimeMs - m.loser.eventTimeMs) < 1_000, `${m.loser.feedId}: within IGN's truncation`);
    assert.match(m.reason, /^proximity: d=0\.0 km /);
  }
  // Two CI quakes 15.75 s apart: EMSC's copy of the second joined the first one's event before the second arrived.
  // CI's own ids keep them apart (same provider under distinct native ids), as before.
  const a = map.get('efd_01M3GEJ8CGQZ6N5TJE8XTWJ7FG')!;
  const b = map.get('efd_01M3GEK5P0578GD2BVZTHXT9FN')!;
  assert.equal(a.state, 'live');
  assert.equal(b.state, 'live');
  assert.equal(r.whyNotMerged(a, b), 'same provider under distinct native ids');
  // No provider id lost: every one of them still sits on exactly one live event.
  const liveIds = live(map).flatMap((n) => n.provenance.map((p) => `${p.provider}:${p.nativeId}`));
  for (const k of idsBefore) assert.equal(liveIds.filter((x) => x === k).length, 1, k);
  assert.deepEqual(r.heal(iso(NOW + 300_000)).merges, [], 'idempotent');
});

test('heal lines: op:merge per fold, then op:correction per survivor, schema-valid, labelled epoch 2', () => {
  const { r } = splitMap();
  const { merges, survivors } = r.heal(iso(NOW));
  const log = new LogBuffer(195_540, iso(NOW));
  log.recordHeal(merges, survivors, HEAL_EPOCH);
  assert.deepEqual(log.lines.map((l) => l.op), ['merge', 'merge', 'merge', 'merge', 'correction', 'correction', 'correction', 'correction']);
  for (const l of log.lines) assert.ok(vObs(l), ajv.errorsText(vObs.errors));
  for (const l of log.lines.filter((x) => x.op === 'correction')) assert.match(l.reason!, /^heal epoch 2: absorbed efd_[0-9A-Z]{26}$/);
});
