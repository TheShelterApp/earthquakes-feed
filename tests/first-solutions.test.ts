import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { FirstObservationIndex, earliestReport } from '../src/first-observations.js';
import {
  EMPTY_DAY_RETRIES,
  GONE_STREAK_LIMIT,
  type HttpAnswer,
  type LaneContext,
  Pacer,
  buildChunks,
  fetchPolitely,
  idsInPartition,
  runLane,
} from '../src/first-solutions-collect.js';
import { LOG_START_DAY, type SourceCursor, type WalkPlan, daysLeft, markDone, newSourceCursor, nextDay, recordFailure, stallLevel } from '../src/first-solutions-cursor.js';
import {
  type FirstSolutionRecord,
  FirstSolutionIndex,
  type HistorySource,
  HISTORY_SOURCES,
  lastSegment,
  mergeRecords,
  parseComcatSuperseded,
  parseGeonetHistory,
  parseQuakemlAllOrigins,
} from '../src/first-solutions.js';
import { loadRegistry } from '../src/providers.js';
import type { Observation } from '../src/types.js';
import { parseXml, textAt } from '../src/xml.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const COLLECTED = '2026-10-01T16:00:00.000Z';
const base = (provider: string, id: string, day: string) => ({ provider, providerEventId: id, day, collected: COLLECTED });
const source = (p: string): HistorySource => HISTORY_SOURCES.find((s) => s.provider === p)!;

// --- XML ---------------------------------------------------------------------------------------------------------------

test('xml: prefixes dropped, entities decoded, CDATA kept, self-closing tags, attributes in either quote', () => {
  const root = parseXml(`<?xml version="1.0"?><!-- c --><q:quakeml xmlns:q="x"><a k='v&amp;w' j="1"/><b>x &lt; y &#x41;&#66;<![CDATA[<raw>]]></b></q:quakeml>`);
  assert.equal(root.name, 'quakeml');
  assert.deepEqual(root.children[0]!.attrs, { k: 'v&w', j: '1' });
  assert.equal(textAt(root, 'b'), 'x < y AB<raw>');
  assert.throws(() => parseXml('<a><b></a>'), /unexpected <\/a>/);
  assert.throws(() => parseXml('<a>'), /unclosed <a>/);
});

// --- ComCat ------------------------------------------------------------------------------------------------------------

test('comcat: us7000st0n keeps all three versions; the first is mb 4.5 of 06-15 07:30, revised to 4.4 on 07-06', () => {
  const r = parseComcatSuperseded(fixture('comcat-superseded-us7000st0n.json'), base('usgs', 'us7000st0n', '2026-06-15'));
  assert.equal(r.method, 'comcat-superseded');
  assert.equal(r.ids, undefined, 'one id only');
  assert.deepEqual(
    r.versions.map((v) => [v.published, v.mag, v.magType, v.status, v.evaluation, v.source]),
    [
      ['2026-06-15T07:30:35.040Z', 4.5, 'mb', 'reviewed', 'preliminary', 'us'],
      ['2026-07-06T13:03:14.040Z', 4.4, 'mb', 'reviewed', 'confirmed', 'us'],
      ['2026-08-31T21:45:43.040Z', 4.4, 'mb', 'reviewed', 'reviewed', 'us'],
    ],
  );
  assert.deepEqual([r.versions[0]!.time, r.versions[0]!.lat, r.versions[0]!.lon, r.versions[0]!.depth], ['2026-06-15T06:58:32.374Z', -8.2929, 119.5941, 172.565]);
  assert.equal(r.missing, undefined);
});

test('comcat: us7000keq3 (M6.6, 2023-07-10) — the tsunami centres published first; internal-origin is left out', () => {
  const r = parseComcatSuperseded(fixture('comcat-superseded-us7000keq3.json'), base('usgs', 'us7000keq3', '2023-07-10'));
  assert.equal(r.versions.length, 8, 'the 8 origin products, not the internal-origin one');
  assert.deepEqual(
    r.versions.slice(0, 3).map((v) => [v.source, v.published, v.mag, v.magType, v.status]),
    [
      ['pt', '2023-07-10T20:34:17.883Z', 6.4, 'Mi', 'reviewed'],
      ['at', '2023-07-10T20:36:13.352Z', 6.4, 'Mi', 'reviewed'],
      ['us', '2023-07-10T20:46:00.040Z', 6.6, 'mww', 'reviewed'],
    ],
  );
  assert.deepEqual(r.ids, ['at00rxlkvc', 'pt23191050', 'us7000keq3', 'usauto7000keq3']);
});

test('comcat: a deleted event keeps its version and the deletion time; us7000tgl2 names usauto but keeps no usauto origin', () => {
  const del = parseComcatSuperseded(fixture('comcat-superseded-aka2026lulrhk.json'), base('usgs', 'aka2026lulrhk', '2026-06-15'));
  assert.equal(del.versions.length, 1);
  assert.equal(del.versions[0]!.source, 'ak');
  assert.equal(del.deleted, '2026-06-17T22:29:56.051Z');
  const tgl2 = parseComcatSuperseded(fixture('comcat-superseded-us7000tgl2.json'), base('usgs', 'us7000tgl2', '2026-09-11'));
  assert.deepEqual(tgl2.ids, ['us7000tgl2', 'usauto7000tgl2']);
  assert.deepEqual(tgl2.versions.map((v) => [v.source, v.published, v.mag]), [['us', '2026-09-11T12:11:58.040Z', 5.9]]);
});

// --- GeoNet ------------------------------------------------------------------------------------------------------------

test('geonet: 29 versions of 2026p685142, the first 26 an automatic M3.5 at 624 km off New Zealand', () => {
  const r = parseGeonetHistory(fixture('geonet-history-2026p685142.json'), base('geonet', '2026p685142', '2026-09-11'));
  assert.equal(r.versions.length, 29);
  assert.deepEqual(
    [r.versions[0]!.published, r.versions[0]!.time, r.versions[0]!.lat, r.versions[0]!.lon, r.versions[0]!.depth, r.versions[0]!.mag, r.versions[0]!.status],
    ['2026-09-11T12:07:02.655Z', '2026-09-11T12:03:59.661Z', -39.0953, 170.33655, 624.4, 3.516, 'automatic'],
  );
  const best = r.versions.find((v) => v.status !== 'automatic')!;
  assert.deepEqual([best.published, best.lat, best.lon, best.mag, best.status], ['2026-09-11T12:09:37.676Z', -5.41176, 126.69263, 5.997, 'best']);
  assert.equal(r.versions.at(-1)!.published, '2026-09-11T12:27:40.423Z');
  const none = parseGeonetHistory('{"type":"FeatureCollection","features":[]}', base('geonet', '2025p183836', '2025-03-10'));
  assert.equal(none.missing, 'no history', 'GeoNet keeps no history after 365 days');
});

// --- QuakeML -----------------------------------------------------------------------------------------------------------

test('quakeml: INGV one-event answer — two origins with INGV version numbers, keyed by the requested id', () => {
  const [r, ...rest] = parseQuakemlAllOrigins(fixture('ingv-allorigins-41883962.xml'), 'ingv', '2025-03-10', COLLECTED, (p) => p, '41883962');
  assert.equal(rest.length, 0);
  assert.equal(r!.provider_event_id, '41883962');
  assert.equal(r!.created, '2025-03-10T00:48:31.000Z');
  assert.deepEqual(
    r!.versions.map((v) => [v.published, v.version, v.status, v.source, v.time]),
    [
      ['2025-03-10T00:48:31.000Z', '200', 'manual', 'INGV', '2025-03-10T00:41:01.880Z'],
      ['2025-05-05T16:59:38.000Z', '1000', 'manual', 'INGV', '2025-03-10T00:41:01.880Z'],
    ],
  );
  assert.ok(r!.versions.every((v) => v.magType === 'Md' && v.mag != null), 'each origin with its own Md');
});

test('quakeml: GEOFON keeps later origins only — the event creation time is earlier than every origin', () => {
  const [r] = parseQuakemlAllOrigins(fixture('geofon-allorigins-2026-09-11T1150.xml'), 'geofon', '2026-09-11', COLLECTED, lastSegment);
  assert.equal(r!.provider_event_id, 'gfz2026rvdx');
  assert.equal(r!.created, '2026-09-11T12:00:42.683Z');
  assert.deepEqual(
    r!.versions.map((v) => [v.published, v.status, v.mag, v.magType]),
    [
      ['2026-09-11T12:14:24.251Z', 'automatic', null, null],
      ['2026-09-11T12:31:35.243Z', null, 5.96, 'Mw'],
    ],
  );
});

test('quakeml: KNMI keeps the manual origin only; ETHZ keeps every automatic origin, ids are the whole publicID', () => {
  const [k] = parseQuakemlAllOrigins(fixture('knmi-allorigins-2025-03-10.xml'), 'knmi', '2025-03-10', COLLECTED, lastSegment);
  assert.equal(k!.provider_event_id, 'knmi2025evlc');
  assert.equal(k!.created, '2025-03-10T15:37:56.308Z');
  assert.deepEqual(k!.versions.map((v) => [v.published, v.status, v.evaluation, v.magType]), [['2025-03-10T19:34:45.296Z', 'manual', 'reviewed', 'MLbes']]);
  const e = parseQuakemlAllOrigins(fixture('ethz-allorigins-2025-03-10.xml'), 'ethz', '2025-03-10', COLLECTED, (p) => p);
  assert.equal(e.length, 5);
  assert.ok(e.every((r) => r.provider_event_id.startsWith('smi:ch.ethz.sed/sc20a/Event/2025e')));
  assert.equal(e.reduce((s, r) => s + r.versions.length, 0), 29, 'every origin of the day has a creation time');
  for (const r of e) {
    assert.ok(r.versions.length >= 1);
    assert.ok(r.created! <= r.versions.at(-1)!.published);
    assert.deepEqual(r.versions.map((v) => v.published), [...r.versions.map((v) => v.published)].sort(), 'oldest publication first');
  }
});

// --- sources -----------------------------------------------------------------------------------------------------------

test('sources: every history source is a registry provider, FDSN URLs on the registry base, one host per source', () => {
  const reg = new Map(loadRegistry().map((p) => [p.id, p]));
  const hosts = new Set<string>();
  for (const s of HISTORY_SOURCES) {
    const p = reg.get(s.provider);
    assert.ok(p, s.provider);
    const url = s.url(s.unit === 'day' ? '2026-06-15' : 'X');
    // GeoNet's history is its quake API, not its FDSN node.
    if (s.method !== 'geonet-history') assert.ok(url.startsWith(`${p.base}?`), `${s.provider}: ${url}`);
    hosts.add(new URL(url).host);
    if (s.unit === 'day') assert.match(url, /starttime=2026-06-15T00:00:00&endtime=2026-06-16T00:00:00&format=xml&includeallorigins=true&includeallmagnitudes=true$/);
  }
  assert.equal(hosts.size, HISTORY_SOURCES.length);
});

// --- cursor ------------------------------------------------------------------------------------------------------------

const PLAN: WalkPlan = { targetStart: '2023-07-06', logStart: LOG_START_DAY, settledEnd: '2026-09-20', retentionStart: null };

test('cursor: done days merge into ranges; the days since the log began first, then history backward', () => {
  const c = newSourceCursor();
  assert.equal(nextDay(c, PLAN), '2026-07-05');
  c.done = [['2026-07-05', '2026-09-20']];
  assert.equal(nextDay(c, PLAN), '2026-07-04', 'caught up: history, from the day before the log');
  markDone(c, '2026-07-04');
  markDone(c, '2026-07-02');
  assert.deepEqual(c.done, [['2026-07-02', '2026-07-02'], ['2026-07-04', '2026-09-20']]);
  assert.equal(nextDay(c, PLAN), '2026-07-03');
  markDone(c, '2026-07-03');
  assert.deepEqual(c.done, [['2026-07-02', '2026-09-20']]);
  assert.equal(nextDay(c, { ...PLAN, settledEnd: '2026-09-21' }), '2026-09-21', 'a newly settled day before more history');
  c.done = [['2023-07-06', '2026-09-20']];
  assert.equal(nextDay(c, PLAN), null);
  assert.equal(nextDay(c, { ...PLAN, settledEnd: '2026-09-21' }), '2026-09-21', 'a newly settled day');
  assert.equal(nextDay(c, { ...PLAN, targetStart: '2022-07-06' }), '2023-07-05', 'a deeper target (P-4) extends the walk');
  c.pending = { day: '2026-06-01', offset: 10 };
  assert.equal(nextDay(c, PLAN), '2026-06-01', 'a pending day first');
});

test('cursor: a retention source walks oldest first from the first day it still keeps', () => {
  const plan = { ...PLAN, retentionStart: '2025-10-02' };
  const c = newSourceCursor();
  assert.equal(nextDay(c, plan), '2025-10-02');
  markDone(c, '2025-10-02');
  assert.equal(nextDay(c, plan), '2025-10-03');
  assert.equal(daysLeft(c, plan), 353);
  assert.equal(daysLeft(newSourceCursor(), PLAN), 1173);
});

test('cursor: a stall warns from 24 failed runs and goes red on every 24th from 72', () => {
  const c = newSourceCursor();
  for (let i = 0; i < 23; i++) recordFailure(c, 'HTTP 503', `t${i}`);
  assert.equal(stallLevel(c), 'ok');
  recordFailure(c, 'HTTP 503', 't23');
  assert.equal(stallLevel(c), 'warn');
  assert.equal(c.failingSince, 't0');
  while (c.failures < 72) recordFailure(c, 'HTTP 503', 'x');
  assert.equal(stallLevel(c), 'alarm');
  recordFailure(c, 'HTTP 503', 'x');
  assert.equal(stallLevel(c), 'warn');
});

// --- requests ----------------------------------------------------------------------------------------------------------

function clock() {
  let t = 0;
  return { now: () => t, wait: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

test('fetch: paced per host, transient errors retried with pauses, 404 is gone, a long Retry-After stops', async () => {
  const c = clock();
  const pacer = new Pacer(1000, c.now, c.wait);
  const starts: number[] = [];
  const answers: HttpAnswer[] = [
    { status: 503, body: '', retryAfterMs: null },
    { status: 200, body: '{}', retryAfterMs: null },
    { status: 404, body: 'nope', retryAfterMs: null },
    { status: 429, body: '', retryAfterMs: 600_000 },
  ];
  const get = async (): Promise<HttpAnswer> => {
    starts.push(c.now());
    c.advance(200);
    return answers.shift()!;
  };
  const src = { timeoutMs: 1, accept: '*/*' };
  assert.deepEqual(await fetchPolitely('https://h.example/a', src, pacer, get, c.wait), { kind: 'ok', status: 200, body: '{}', attempts: 2 });
  assert.deepEqual(await fetchPolitely('https://h.example/b', src, pacer, get, c.wait), { kind: 'gone', status: 404, attempts: 1 });
  const stop = await fetchPolitely('https://h.example/c', src, pacer, get, c.wait);
  assert.equal(stop.kind, 'fail');
  assert.match((stop as { error: string }).error, /HTTP 429, Retry-After 600 s/);
  assert.deepEqual(starts, [0, 2200, 3200, 4200], 'a 2 s pause before the retry, then at least 1 s between starts');
});

// --- lanes -------------------------------------------------------------------------------------------------------------

const partitionLine = (provider: string, ids: string[]): string =>
  JSON.stringify({ type: 'Feature', id: `efd_${ids[0]}`, properties: { feed: { provenance: ids.map((native_id) => ({ provider, native_id })) } } });

function laneCtx(days: Record<string, string>, get: (url: string) => HttpAnswer, opts: Partial<LaneContext> = {}): LaneContext & { calls: string[] } {
  const c = clock();
  const calls: string[] = [];
  return {
    deadlineMs: 1e12,
    now: c.now,
    collectedAt: () => COLLECTED,
    pacer: new Pacer(1000, c.now, c.wait),
    wait: c.wait,
    get: async (url) => {
      calls.push(url);
      c.advance(100);
      return get(url);
    },
    partitions: { dayText: async (d) => days[d] ?? '' },
    // History only (nothing settled since the log began): 2026-07-04 back to 2026-07-01.
    plan: () => ({ ...PLAN, targetStart: '2026-07-01', settledEnd: '2026-07-04' }),
    calls,
    ...opts,
  };
}

const geonetBody = fixture('geonet-history-2026p685142.json');

test('lane: one-event source — ids in code-point order, resumes at the pending offset, stops at the deadline', async () => {
  assert.deepEqual(idsInPartition([partitionLine('geonet', ['b', 'a']), partitionLine('usgs', ['x']), partitionLine('geonet', ['a', 'c'])].join('\n'), 'geonet'), ['a', 'b', 'c']);
  const days = { '2026-07-04': [partitionLine('geonet', ['g3', 'g1', 'g2'])].join('\n') };
  const cur: SourceCursor = { ...newSourceCursor(), pending: { day: '2026-07-04', offset: 1 } };
  const ctx = laneCtx(days, () => ({ status: 200, body: geonetBody, retryAfterMs: null }), {});
  const stopped = await runLane(source('geonet'), cur, { ...ctx, deadlineMs: 0 });
  assert.equal(stopped.requests, 0, 'nothing after the deadline');
  assert.deepEqual(cur.pending, { day: '2026-07-04', offset: 1 });
  // The deadline falls after the first request: g2 is collected, g3 stays pending.
  const once = await runLane(source('geonet'), cur, { ...ctx, deadlineMs: 50 });
  assert.equal(once.records.length, 1);
  assert.deepEqual(cur.pending, { day: '2026-07-04', offset: 2 });
  const res = await runLane(source('geonet'), cur, ctx);
  assert.deepEqual(ctx.calls.map((u) => u.split('/').pop()), ['g2', 'g3'], 'g1 was done before, g2 is not asked twice');
  assert.equal(res.daysDone[0], '2026-07-04');
  assert.equal(ctx.calls.length, 2, 'the other days hold no GeoNet report: done without a request');
  assert.deepEqual(cur.done, [['2026-07-01', '2026-07-04']]);
  assert.equal(cur.pending, undefined);
  assert.equal(res.records.length, 1);
  assert.equal(res.records[0]!.versions.length, 29);
});

test('lane: a failed request keeps the day pending at that report; a streak of missing answers is dropped and stops', async () => {
  const days = { '2026-07-04': partitionLine('usgs', ['u1', 'u2', 'u3']) };
  const cur = newSourceCursor();
  const res = await runLane(source('usgs'), cur, laneCtx(days, (url) => (url.includes('u2') ? { status: 503, body: '', retryAfterMs: null } : { status: 200, body: fixture('comcat-superseded-us7000st0n.json'), retryAfterMs: null })));
  assert.equal(res.records.length, 1);
  assert.deepEqual(cur.pending, { day: '2026-07-04', offset: 1 });
  assert.match(res.error!, /usgs:u2: HTTP 503/);
  assert.equal(res.requests, 5, 'u1 once, u2 four times');

  const many = Array.from({ length: GONE_STREAK_LIMIT + 5 }, (_, i) => `n${String(i).padStart(3, '0')}`);
  const cur2 = newSourceCursor();
  const res2 = await runLane(source('usgs'), cur2, laneCtx({ '2026-07-04': partitionLine('usgs', ['a0', ...many]) }, (url) => (url.includes('a0') ? { status: 200, body: fixture('comcat-superseded-us7000st0n.json'), retryAfterMs: null } : { status: 404, body: '', retryAfterMs: null })));
  assert.equal(res2.records.length, 1, 'the streak records are dropped');
  assert.deepEqual(cur2.pending, { day: '2026-07-04', offset: 1 });
  assert.match(res2.error!, new RegExp(`${GONE_STREAK_LIMIT} answers in a row`));
});

test('lane: day source — a day without reports costs no request; 204 is asked again, then recorded as missing', async () => {
  const geofonDay = fixture('geofon-allorigins-2026-09-11T1150.xml');
  const days = { '2026-07-04': partitionLine('geofon', ['gfz2026rvdx', 'gfz2026zzzz']), '2026-07-02': partitionLine('geofon', ['gfz2026aaaa']) };
  const cur = newSourceCursor();
  const ctx = laneCtx(days, (url) => (url.includes('starttime=2026-07-04') ? { status: 200, body: geofonDay, retryAfterMs: null } : { status: 204, body: '', retryAfterMs: null }));
  const r1 = await runLane(source('geofon'), cur, ctx);
  assert.deepEqual(r1.daysDone, ['2026-07-04', '2026-07-03']);
  assert.deepEqual(r1.records.map((r) => [r.provider_event_id, r.versions.length, r.missing ?? null]), [
    ['gfz2026rvdx', 2, null],
    ['gfz2026zzzz', 0, 'not in the day answer'],
  ]);
  assert.deepEqual(cur.pending, { day: '2026-07-02', offset: 0, empty: 1 });
  assert.match(r1.error!, /no content \(HTTP 204\)/);
  for (let i = 2; i < EMPTY_DAY_RETRIES; i++) await runLane(source('geofon'), cur, ctx);
  const last = await runLane(source('geofon'), cur, ctx);
  assert.deepEqual(last.records.map((r) => [r.provider_event_id, r.missing]), [['gfz2026aaaa', 'http 204']]);
  assert.ok(last.daysDone.includes('2026-07-02'));
  assert.equal(ctx.calls.filter((u) => u.includes('starttime=2026-07-03')).length, 0, 'no reports that day, no request');
});

test('lane: a day query the node refuses (HTTP 400) stops the lane and records nothing', async () => {
  const cur = newSourceCursor();
  const res = await runLane(source('ethz'), cur, laneCtx({ '2026-07-04': partitionLine('ethz', ['e1']) }, () => ({ status: 400, body: 'includeallmagnitudes is not supported', retryAfterMs: null })));
  assert.equal(res.records.length, 0);
  assert.deepEqual(res.daysDone, []);
  assert.match(res.error!, /2026-07-04: HTTP 400 to the day query/);
  assert.deepEqual(cur.done, []);
});

test('lane: a one-off slice with only some ids leaves the cursor alone', async () => {
  const days = { '2026-06-15': partitionLine('geonet', ['g1', 'g2']) };
  const cur = newSourceCursor();
  const ctx = laneCtx(days, () => ({ status: 200, body: geonetBody, retryAfterMs: null }), { days: ['2026-06-15'], onlyIds: new Map([['geonet', new Set(['g2'])]]) });
  const res = await runLane(source('geonet'), cur, ctx);
  assert.deepEqual(ctx.calls.map((u) => u.split('/').pop()), ['g2']);
  assert.equal(res.records.length, 1);
  assert.deepEqual(cur, newSourceCursor());
  const other = await runLane(source('usgs'), newSourceCursor(), ctx);
  assert.equal(other.requests, 0, 'a provider the ids do not name is skipped');
});

// --- chunks and the merged answer --------------------------------------------------------------------------------------

test('chunks: one gzip NDJSON per event month, records in (day, id) order, named by the run', () => {
  const st0n = parseComcatSuperseded(fixture('comcat-superseded-us7000st0n.json'), base('usgs', 'us7000st0n', '2026-06-15'));
  const tgl2 = parseComcatSuperseded(fixture('comcat-superseded-us7000tgl2.json'), base('usgs', 'us7000tgl2', '2026-09-11'));
  const keq3 = parseComcatSuperseded(fixture('comcat-superseded-us7000keq3.json'), base('usgs', 'us7000keq3', '2026-06-01'));
  const chunks = buildChunks('usgs', [tgl2, st0n, keq3], 'r1-1');
  assert.deepEqual(chunks.map((c) => [c.line.asset, c.line.records, c.line.days]), [
    ['fs-usgs-2026-06-r1-1.ndjson.gz', 2, ['2026-06-01', '2026-06-15']],
    ['fs-usgs-2026-09-r1-1.ndjson.gz', 1, ['2026-09-11', '2026-09-11']],
  ]);
  const lines = gunzipSync(chunks[0]!.body).toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as FirstSolutionRecord);
  assert.deepEqual(lines.map((r) => r.provider_event_id), ['us7000keq3', 'us7000st0n']);
  assert.equal(buildChunks('usgs', [st0n, keq3], 'r1-1')[0]!.line.sha256, chunks[0]!.line.sha256, 'deterministic');
});

test('index: records of one report merge (versions united, later collection wins); ComCat aliases find the record', () => {
  const a = parseComcatSuperseded(fixture('comcat-superseded-us7000keq3.json'), base('usgs', 'us7000keq3', '2023-07-10'));
  const b: FirstSolutionRecord = { ...a, versions: a.versions.slice(0, 2), collected: '2026-09-01T00:00:00.000Z' };
  const m = mergeRecords(b, a);
  assert.equal(m.versions.length, 8);
  assert.equal(m.collected, COLLECTED);
  const idx = new FirstSolutionIndex();
  idx.add(b);
  idx.add(a);
  assert.equal(idx.get('usgs', 'pt23191050')!.provider_event_id, 'us7000keq3');
  assert.equal(idx.get('usgs', 'us7000keq3')!.versions.length, 8);
  const missing: FirstSolutionRecord = { ...a, versions: [], missing: 'http 404', collected: '2026-10-02T00:00:00.000Z' };
  assert.equal(mergeRecords(a, missing).missing, undefined, 'a record with versions beats a later miss');
});

const LOG = fixture('first-solutions-log-2026-09-11.ndjson').trim().split('\n').map((l) => JSON.parse(l) as Observation);

test('earliest: us7000tgl2 — ComCat published its origin at 12:11:58, five minutes before the feed first held it', () => {
  const log = new FirstObservationIndex();
  for (const l of LOG) log.add(l);
  const side = new FirstSolutionIndex();
  side.add(parseComcatSuperseded(fixture('comcat-superseded-us7000tgl2.json'), base('usgs', 'us7000tgl2', '2026-09-11')));
  const seen = log.lookup('usgs:us7000tgl2')!.reports.find((r) => r.provider === 'usgs')!;
  const r = earliestReport('usgs', 'us7000tgl2', seen, side);
  assert.deepEqual(r.first_published, { at: '2026-09-11T12:11:58.040Z', provenance: 'provider version history' });
  assert.deepEqual([r.first_solution!.mag, r.first_solution!.magType, r.first_solution!.source], [5.9, 'mww', 'us']);
  assert.equal(r.feed_first_seen!.ingest_time, '2026-09-11T12:16:45.423Z');
  // Without the history, the log's first line is the answer.
  assert.deepEqual(earliestReport('usgs', 'us7000tgl2', seen, new FirstSolutionIndex()).first_solution!.provenance, 'first seen by the feed');
});

test('earliest: GeoNet 2026p685142 — the history starts 4 min before the feed saw the first "best" version', () => {
  const log = new FirstObservationIndex();
  for (const l of LOG) log.add(l);
  const side = new FirstSolutionIndex();
  side.add(parseGeonetHistory(geonetBody, base('geonet', '2026p685142', '2026-09-11')));
  const seen = log.lookup('geonet:2026p685142')!.reports[0]!;
  const r = earliestReport('geonet', '2026p685142', seen, side);
  assert.equal(r.first_solution!.at, '2026-09-11T12:07:02.655Z');
  assert.equal(r.first_solution!.status, 'automatic');
  assert.equal(r.provider_history!.first_non_automatic!.published, '2026-09-11T12:09:37.676Z');
  assert.deepEqual([seen.lat, seen.lon, seen.mag], [-5.412, 126.693, 6], 'the feed first held the first best version (12:09:37) at 12:11:51');
});

test('earliest: the feed wins when its first sight precedes every retained version; creation time comes first where earlier', () => {
  const side = new FirstSolutionIndex();
  side.add(parseComcatSuperseded(fixture('comcat-superseded-us7000tgl2.json'), base('usgs', 'us7000tgl2', '2026-09-11')));
  const seen = {
    provider: 'usgs', provider_event_id: 'us7000tgl2', seq: 1, ingest_time: '2026-09-11T12:05:00.000Z', provider_updated: null,
    event_time: '2026-09-11T11:56:20.000Z', lat: -7.3, lon: 128.9, depth: 10, mag: 6.2, magType: 'mww', place: null, status: 'automatic', lag_seconds: 520,
  };
  const r = earliestReport('usgs', 'us7000tgl2', seen, side);
  assert.deepEqual([r.first_solution!.provenance, r.first_solution!.at, r.first_solution!.mag], ['first seen by the feed', '2026-09-11T12:05:00.000Z', 6.2]);

  const g = new FirstSolutionIndex();
  g.add(parseQuakemlAllOrigins(fixture('geofon-allorigins-2026-09-11T1150.xml'), 'geofon', '2026-09-11', COLLECTED, lastSegment)[0]!);
  const gr = earliestReport('geofon', 'gfz2026rvdx', null, g);
  assert.deepEqual(gr.first_published, { at: '2026-09-11T12:00:42.683Z', provenance: 'provider event creation time' });
  assert.equal(gr.first_solution!.at, '2026-09-11T12:14:24.251Z', 'the first values GEOFON still keeps');
});

test('earliest: NCEDC reads its history from the ComCat event of its id, through the nc origins', () => {
  const side = new FirstSolutionIndex();
  side.add(parseComcatSuperseded(fixture('comcat-superseded-nc75143581.json'), base('usgs', 'nc75143581', '2025-03-06')));
  const r = earliestReport('ncedc', '75143581', null, side);
  assert.equal(r.provider_history!.via, 'usgs:nc75143581');
  assert.deepEqual([r.first_solution!.source, r.first_solution!.at, r.first_solution!.status], ['nc', '2025-03-06T01:02:46.940Z', 'automatic']);
  assert.equal(earliestReport('scedc', '75143581', null, side).provider_history, null, 'no ComCat record of ci75143581');
});
