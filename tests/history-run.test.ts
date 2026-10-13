import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type RawHeader, RAW_KIND, rawFileText } from '../src/history-build.js';
import { type HistoryConfig, type HistoryEra, allPeriods, historyTag, rawAssetName } from '../src/history-config.js';
import type { HttpAnswer } from '../src/history-fetch.js';
import { emptyIndex, indexText, parseIndex } from '../src/history-index.js';
import {
  type HistoryState,
  STALL_ALARM_RUNS,
  STALL_ALARM_RUNS_ANY,
  emptyState,
  loadState,
  parseState,
  recordRun,
  walkTexts,
} from '../src/history-state.js';
import { DryRunStore, type HistoryStore, LocalStore } from '../src/history-store.js';
import { type Ctx, adoptOrphans, emptyReport, fetchUnits, runWalk, sealPeriods } from '../src/history.js';
import { loadRegistry } from '../src/providers.js';

// FEED-TEST-1: the deep-history walk's run decisions (src/history.ts): taking over assets a run uploaded but never
// indexed (adoptOrphans), and what a failing, rate-limited or successful source month does to the index (fetchUnits).
// A LocalStore stands in for the Releases; fetchRange gets a fake HTTP layer. Needs the zstd CLI (as the walk does).

const registry = loadRegistry();
const ERA: HistoryEra = { id: 'pilot', from: '2022-11-01', to: '2023-01-01', minMagnitude: null, sources: ['usgs'] };
const CFG: HistoryConfig = {
  enabled: true,
  boundary: '2023-07-06',
  eras: [ERA],
  maxUnitsPerRun: 4,
  maxSecondsPerRun: 600,
  requestSpacingMs: 1100,
  timeoutMs: 90_000,
  pageLimits: { usgs: 20000 },
};
const NOW_ISO = '2026-10-04T11:26:00.000Z';
const hasZstd = ((): boolean => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function ctxOf(over: Partial<Ctx> = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'history-run-'));
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  return {
    cfg: CFG,
    registry,
    byId: new Map(registry.map((p) => [p.id, p])),
    idx: emptyIndex(CFG.boundary),
    store: new LocalStore(join(dir, 'releases')),
    dryRun: true,
    work,
    archives: [],
    archivedDays: new Set(),
    deadline: Date.now() + 600_000,
    assetCache: new Map(),
    rawCache: new Map(),
    now: () => NOW_ISO,
    report: emptyReport(),
    ...over,
  };
}

/** A raw asset of `period` as the walk writes it (rows: USGS-shaped), zstd-compressed, at `dir/<asset>`. */
function rawAsset(dir: string, period: string, gen = 1, over: Partial<RawHeader> = {}): string {
  const p = allPeriods(CFG).find((x) => x.key === period)!;
  const header: RawHeader = {
    kind: RAW_KIND, version: 1, source: 'usgs', period, start: new Date(p.startMs).toISOString(), end: new Date(p.endMs).toISOString(),
    fetch_min_magnitude: null, fetched_at: NOW_ISO, rows: 0, response_rows: 0, parsed_rows: 0, duplicate_ids: 0, provider_count: 0,
    requests: 1, windows: [], user_agent: 'test', ...over,
  };
  const name = rawAssetName('usgs', period, gen);
  const plain = join(dir, name.replace(/\.zst$/, ''));
  writeFileSync(plain, rawFileText(header, []));
  execFileSync('zstd', ['-19', '-q', '-f', '--rm', plain, '-o', join(dir, name)]);
  return join(dir, name);
}

test('takeover: an orphan raw asset of a configured month is adopted; junk, empty and second copies become unused', { skip: !hasZstd && 'zstd not installed' }, () => {
  const ctx = ctxOf();
  const tag = historyTag('2022-12');
  ctx.store.ensureRelease(tag);
  const src = join(ctx.work, 'src');
  mkdirSync(src);
  ctx.store.upload(tag, rawAsset(src, '2022-12'));
  ctx.store.upload(tag, rawAsset(src, '2022-12', 2));
  writeFileSync(join(src, 'notes.txt'), 'x');
  ctx.store.upload(tag, join(src, 'notes.txt'));
  writeFileSync(join(src, rawAssetName('usgs', '2022-11', 1)), '');
  ctx.store.upload(historyTag('2022-11'), join(src, rawAssetName('usgs', '2022-11', 1)));
  // A raw whose header names another month than its file name.
  const wrongDir = join(src, 'wrong');
  mkdirSync(wrongDir);
  const wrong = rawAsset(wrongDir, '2022-11', 2, { start: '2022-11-02T00:00:00.000Z' });
  ctx.store.upload(historyTag('2022-11'), wrong);
  adoptOrphans(ctx);
  // Two complete copies of one source month: the first in name order is adopted ('…12.g2.ndjson…' sorts before
  // '…12.ndjson…'), the other is never used.
  assert.deepEqual(ctx.idx.raw.map((r) => r.asset), [rawAssetName('usgs', '2022-12', 2)]);
  assert.deepEqual(ctx.report.adopted, [`${tag}/${rawAssetName('usgs', '2022-12', 2)}`]);
  const unused = new Map(ctx.idx.unused.map((u) => [u.asset, u.reason]));
  assert.match(unused.get(rawAssetName('usgs', '2022-12', 1))!, /a second copy of a source month the index already holds/);
  assert.match(unused.get('notes.txt')!, /not a history asset name/);
  assert.match(unused.get(rawAssetName('usgs', '2022-11', 1))!, /incomplete upload/);
  assert.match(unused.get(rawAssetName('usgs', '2022-11', 2))!, /header does not match the configured month/);
  // A second pass changes nothing: every name is now known.
  const before = JSON.stringify(ctx.idx);
  adoptOrphans(ctx);
  assert.equal(JSON.stringify(ctx.idx), before);
});

const http = (answer: (url: string) => HttpAnswer) => {
  const calls: string[] = [];
  return {
    calls,
    fetchOptions: {
      fetcher: async (url: string): Promise<HttpAnswer> => {
        calls.push(url);
        return answer(url);
      },
      sleep: async () => {},
      now: () => Date.now(),
    },
  };
};

test('fetch: a failing source month counts its failure, keeps the error and turns the run red once, on its 24th failed run', async () => {
  const h = http(() => ({ status: 500, body: 'boom', latencyMs: 1, retryAfterMs: null }));
  const ctx = ctxOf({ fetchOptions: h.fetchOptions });
  await fetchUnits(ctx, 4);
  const key = 'usgs:2022-12';
  assert.equal(ctx.idx.attempts[key]?.failures, 1);
  assert.equal(ctx.idx.attempts[key]?.since, NOW_ISO);
  assert.match(ctx.idx.attempts[key]!.last_error, /500/);
  assert.equal(ctx.report.failed.length, 1, 'one failed month stops the source for the run (the next month waits)');
  assert.deepEqual(ctx.report.blocked, []);
  assert.deepEqual(ctx.idx.raw, []);
  // The 24th failed run turns the run red.
  ctx.idx.attempts[key]!.failures = 23;
  ctx.report.failed = [];
  await fetchUnits(ctx, 4);
  assert.equal(ctx.idx.attempts[key]?.failures, 24);
  assert.equal(ctx.report.blocked.length, 1);
  assert.match(ctx.report.blocked[0]!, /usgs:2022-12 has failed 24 runs since/);
  // Once: the 48th failed run is not red again (the attempts entry in the index still says so).
  ctx.idx.attempts[key]!.failures = 47;
  ctx.report.blocked = [];
  await fetchUnits(ctx, 4);
  assert.equal(ctx.idx.attempts[key]?.failures, 48);
  assert.deepEqual(ctx.report.blocked, []);
});

test('fetch: a month that failed before no longer holds back its source\'s older months (round 23); a fresh failure still stops the source', { skip: !hasZstd && 'zstd not installed' }, async () => {
  // 2022-12 cannot be read (as EMSC's 2017-12 could not, for six days); 2022-11 answers.
  const h = http((url) =>
    url.includes('starttime=2022-12-')
      ? url.includes('/count?') ? { status: 200, body: '{"count":2}', latencyMs: 1, retryAfterMs: null } : { status: 200, body: '<html>', latencyMs: 1, retryAfterMs: null }
      : url.includes('/count?') ? { status: 200, body: '{"count":0}', latencyMs: 1, retryAfterMs: null } : { status: 204, body: '', latencyMs: 1, retryAfterMs: null },
  );
  // First failure: the source stops for the run, 2022-11 waits.
  const ctx = ctxOf({ fetchOptions: h.fetchOptions });
  await fetchUnits(ctx, 4);
  assert.equal(ctx.idx.attempts['usgs:2022-12']?.failures, 1);
  assert.equal(ctx.idx.raw.length, 0);
  // Next run: 2022-12 fails again, and 2022-11 is fetched all the same.
  await fetchUnits(ctx, 4);
  assert.equal(ctx.idx.attempts['usgs:2022-12']?.failures, 2);
  assert.deepEqual(ctx.idx.raw.map((r) => r.period), ['2022-11']);
});

test('fetch: a source failing everything costs at most three failed months a run, however many failed before', async () => {
  const era: HistoryEra = { ...ERA, from: '2022-05-01' };
  const h = http(() => ({ status: 500, body: 'boom', latencyMs: 1, retryAfterMs: null }));
  const ctx = ctxOf({ cfg: { ...CFG, eras: [era] }, fetchOptions: h.fetchOptions });
  for (const m of ['2022-12', '2022-11', '2022-10', '2022-09', '2022-08']) ctx.idx.attempts[`usgs:${m}`] = { failures: 5, since: NOW_ISO, last_error: 'HTTP 500' };
  await fetchUnits(ctx, 10);
  assert.equal(ctx.report.failed.length, 3);
  assert.equal(ctx.idx.attempts['usgs:2022-09']?.failures, 5, 'the fourth month is not asked');
});

test('fetch + seal: EMSC events counted but answered as empty elements become an explicit gap in the raw header and the index; the month seals', { skip: !hasZstd && 'zstd not installed' }, async () => {
  const era: HistoryEra = { ...ERA, from: '2022-12-01', sources: ['emsc'] };
  const shown = Date.UTC(2022, 11, 22, 9, 10);
  const hidden = [Date.UTC(2022, 11, 22, 9, 0, 1), Date.UTC(2022, 11, 22, 9, 0, 2)];
  const feature = (t: number): string =>
    JSON.stringify({ id: `20221222_${t}`, type: 'Feature', properties: { time: new Date(t).toISOString(), mag: 3, magtype: 'ml', flynn_region: 'OAXACA, MEXICO', lastupdate: new Date(t).toISOString() }, geometry: { type: 'Point', coordinates: [-96, 16, -10] } });
  const h = http((url) => {
    const q = new URL(url).searchParams;
    const s = Date.parse(`${q.get('starttime')}Z`);
    const e = Date.parse(`${q.get('endtime')}Z`);
    const inWin = (t: number): boolean => t >= s && t <= e;
    const all = [shown, ...hidden].filter(inWin).sort((a, b) => b - a);
    if (url.includes('/count?')) return { status: 200, body: JSON.stringify({ count: all.length }), latencyMs: 1, retryAfterMs: null };
    if (!all.length) return { status: 204, body: '', latencyMs: 1, retryAfterMs: null };
    const parts = all.map((t) => (hidden.includes(t) ? '' : feature(t)));
    return { status: 200, body: `{"type":"FeatureCollection","metadata":{"count":${all.length}},"features":[${parts.join(',')}]}`, latencyMs: 1, retryAfterMs: null };
  });
  const ctx = ctxOf({ cfg: { ...CFG, eras: [era] }, fetchOptions: h.fetchOptions });
  await fetchUnits(ctx, 4, () => sealPeriods(ctx));
  assert.deepEqual(ctx.report.failed, []);
  const r = ctx.idx.raw[0]!;
  assert.deepEqual([r.source, r.period, r.rows, r.provider_count], ['emsc', '2022-12', 1, 3]);
  assert.equal(r.unserialized?.reduce((s, g) => s + g.count, 0), 2);
  assert.ok(r.unserialized!.every((g) => Date.parse(g.end) - Date.parse(g.start) <= 3600_000));
  assert.equal(ctx.report.gaps.length, 1);
  assert.match(ctx.report.gaps[0]!, /emsc:2022-12: 2 event\(s\) the source counts but answers as empty elements/);
  // The edition verifies against the raw asset: its rows plus its recorded gap meet the source's count.
  assert.deepEqual(ctx.report.sealed.length, 1, ctx.report.sealed.join(' '));
});

test('fetch: a source that asked not to be asked before a time (Retry-After) gets no request until then', async () => {
  const h = http(() => ({ status: 200, body: '{"count":0}', latencyMs: 1, retryAfterMs: null }));
  const ctx = ctxOf({ fetchOptions: h.fetchOptions });
  ctx.idx.attempts['usgs:2022-12'] = { failures: 1, since: NOW_ISO, last_error: 'HTTP 429', not_before: new Date(Date.now() + 3_600_000).toISOString() };
  await fetchUnits(ctx, 4);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(ctx.report.failed, []);
});

test('fetch: a month that answers is uploaded, read back and indexed, and its failure streak is cleared', { skip: !hasZstd && 'zstd not installed' }, async () => {
  // ComCat counts first; an empty month counts 0 and needs no query.
  const h = http((url) => (url.includes('/count?') ? { status: 200, body: '{"count":0}', latencyMs: 1, retryAfterMs: null } : { status: 204, body: '', latencyMs: 1, retryAfterMs: null }));
  const ctx = ctxOf({ fetchOptions: h.fetchOptions });
  ctx.idx.attempts['usgs:2022-12'] = { failures: 3, since: NOW_ISO, last_error: 'timeout' };
  await fetchUnits(ctx, 1);
  assert.equal(ctx.idx.raw.length, 1);
  const r = ctx.idx.raw[0]!;
  assert.deepEqual([r.source, r.period, r.rows, r.provider_count], ['usgs', '2022-12', 0, 0]);
  assert.equal(ctx.idx.attempts['usgs:2022-12'], undefined);
  assert.deepEqual(ctx.store.list(historyTag('2022-12')).map((a) => a.name), [r.asset]);
  assert.ok(h.calls.every((u) => u.includes('/count?')), 'an empty month costs its count requests only');
});

test('fetch: a dry run limited to some sources (HISTORY_ONLY_SOURCES) asks only those sources', async () => {
  const era: HistoryEra = { ...ERA, sources: ['usgs', 'emsc', 'geofon'] };
  const h = http(() => ({ status: 500, body: 'boom', latencyMs: 1, retryAfterMs: null }));
  const ctx = ctxOf({ cfg: { ...CFG, eras: [era] }, fetchOptions: h.fetchOptions, onlySources: new Set(['geofon']) });
  await fetchUnits(ctx, 10);
  assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every((u) => u.startsWith('https://geofon.gfz.de/')), h.calls.join(' '));
  assert.deepEqual(Object.keys(ctx.idx.attempts), ['geofon:2022-12']);
});

/** GEOFON's 2022-12 already fetched with two rows (12-10 05:00 and 12-20 18:00), its raw asset in the store and the
 *  index, as an earlier run leaves it. */
function geofonDecemberFetched(ctx: Ctx): void {
  const rows = [Date.UTC(2022, 11, 10, 5), Date.UTC(2022, 11, 20, 18)].map((t, i) => ({
    provider: 'geofon', providerEventId: `gfz2022x${i}`, eventTimeMs: t, providerUpdatedMs: null, status: null, lat: 10, lon: 20 + i,
    depth: 10, mag: 4.5, magType: 'M', place: null, knownAliasIds: [], fields: {},
  }));
  const header: RawHeader = {
    kind: RAW_KIND, version: 1, source: 'geofon', period: '2022-12', start: '2022-12-01T00:00:00.000Z', end: '2023-01-01T00:00:00.000Z',
    fetch_min_magnitude: null, fetched_at: NOW_ISO, rows: 2, response_rows: 2, parsed_rows: 2, duplicate_ids: 0, provider_count: null,
    requests: 1, windows: [], user_agent: 'test',
  };
  const plain = join(ctx.work, 'raw-geofon-2022-12.ndjson');
  writeFileSync(plain, rawFileText(header, rows));
  execFileSync('zstd', ['-19', '-q', '-f', '--rm', plain, '-o', `${plain}.zst`]);
  const sha256 = createHash('sha256').update(readFileSync(`${plain}.zst`)).digest('hex');
  ctx.store.ensureRelease('history-2022');
  ctx.store.upload('history-2022', `${plain}.zst`);
  ctx.idx.raw.push({
    source: 'geofon', period: '2022-12', tag: 'history-2022', asset: 'raw-geofon-2022-12.ndjson.zst', url: 'x', sha256, bytes: 1, rows: 2,
    provider_count: null, start: header.start, end: header.end, fetch_min_magnitude: null, fetched_at: NOW_ISO,
  });
}
const FDSN_TEXT_HEADER = '#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName';

test('fetch: an empty month right before a month with rows is kept once the newer month still answers rows (the catalogue starts there)', { skip: !hasZstd && 'zstd not installed' }, async () => {
  const era: HistoryEra = { ...ERA, sources: ['geofon'] };
  const ctx = ctxOf({ cfg: { ...CFG, eras: [era] } });
  geofonDecemberFetched(ctx);
  // 2022-11 answers 204; December, asked again around its first row, still answers it.
  const h = http((url) =>
    url.includes('starttime=2022-12-')
      ? { status: 200, body: `${FDSN_TEXT_HEADER}\ngfz2022x0|2022-12-10T05:00:00.000|10|20|10|GFZ|GEOFON|GFZ|gfz2022x0|M|4.5|GFZ|Somewhere\n`, latencyMs: 1, retryAfterMs: null }
      : { status: 204, body: '', latencyMs: 1, retryAfterMs: null },
  );
  ctx.fetchOptions = h.fetchOptions;
  await fetchUnits(ctx, 4);
  assert.deepEqual(ctx.idx.raw.map((r) => [r.period, r.rows]), [['2022-12', 2], ['2022-11', 0]]);
  assert.deepEqual(ctx.report.empty_after_rows, ['geofon:2022-11: no rows, 2 in 2022-12 (which still answers rows: the source\'s catalogue starts here)']);
  assert.equal(h.calls.filter((u) => u.includes('starttime=2022-12-')).length, 1, 'one window of the newer month, around its first row');
  assert.match(h.calls[1]!, /starttime=2022-12-10T04%3A00%3A00&endtime=2022-12-10T06%3A00%3A00/);
});

test('fetch: an empty month is not kept while the source answers the newer month empty too (a service answering empty, PF-5j-NOA)', { skip: !hasZstd && 'zstd not installed' }, async () => {
  const era: HistoryEra = { ...ERA, sources: ['geofon'] };
  const ctx = ctxOf({ cfg: { ...CFG, eras: [era] } });
  geofonDecemberFetched(ctx);
  const h = http(() => ({ status: 204, body: '', latencyMs: 1, retryAfterMs: null }));
  ctx.fetchOptions = h.fetchOptions;
  await fetchUnits(ctx, 4);
  assert.deepEqual(ctx.idx.raw.map((r) => [r.period, r.rows]), [['2022-12', 2]], 'no raw asset for 2022-11');
  assert.deepEqual(ctx.store.list('history-2022').map((a) => a.name), ['raw-geofon-2022-12.ndjson.zst'], 'nothing uploaded');
  assert.deepEqual(ctx.report.empty_after_rows, []);
  assert.equal(ctx.idx.attempts['geofon:2022-11']?.failures, 1);
  assert.match(ctx.idx.attempts['geofon:2022-11']!.last_error, /answered no rows: 2022-12 answers none either in 2 two-hour window/);
  // The query of the month, then a window around December's first and last row (its middle row is the first).
  assert.equal(h.calls.length, 3);
});

test('fetch: an empty month whose newer month cannot be checked (an error there) fails and is asked again next run', { skip: !hasZstd && 'zstd not installed' }, async () => {
  const era: HistoryEra = { ...ERA, sources: ['geofon'] };
  const ctx = ctxOf({ cfg: { ...CFG, eras: [era] } });
  geofonDecemberFetched(ctx);
  const h = http((url) => (url.includes('starttime=2022-12-') ? { status: 503, body: 'maintenance', latencyMs: 1, retryAfterMs: null } : { status: 204, body: '', latencyMs: 1, retryAfterMs: null }));
  ctx.fetchOptions = h.fetchOptions;
  await fetchUnits(ctx, 4);
  assert.deepEqual(ctx.idx.raw.map((r) => r.period), ['2022-12']);
  assert.match(ctx.idx.attempts['geofon:2022-11']!.last_error, /answered no rows: checking 2022-12 again: .*HTTP 503/);
});

test('dry-run store: reads published assets, writes only locally, never shadows a published name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-dryrun-'));
  const published = new LocalStore(join(dir, 'published'));
  const local = new LocalStore(join(dir, 'local'));
  const src = join(dir, 'raw-usgs-2022-12.ndjson.zst');
  writeFileSync(src, 'published bytes');
  published.upload('history-2022', src);
  const store = new DryRunStore(local, published);
  assert.deepEqual(store.list('history-2022').map((a) => a.name), ['raw-usgs-2022-12.ndjson.zst']);
  const back = join(dir, 'back');
  store.download('history-2022', 'raw-usgs-2022-12.ndjson.zst', back);
  assert.equal(readFileSync(back, 'utf8'), 'published bytes');
  assert.throws(() => store.upload('history-2022', src), /is published/);
  const mine = join(dir, 'raw-emsc-2022-12.ndjson.zst');
  writeFileSync(mine, 'local bytes');
  store.ensureRelease('history-2022');
  store.upload('history-2022', mine);
  assert.deepEqual(store.list('history-2022').map((a) => a.name), ['raw-emsc-2022-12.ndjson.zst', 'raw-usgs-2022-12.ndjson.zst']);
  assert.deepEqual(published.list('history-2022').map((a) => a.name), ['raw-usgs-2022-12.ndjson.zst'], 'nothing reached the published store');
});

test('fetch + seal: a month is sealed as soon as its last source arrives, newest first, each on its newer neighbour', { skip: !hasZstd && 'zstd not installed' }, async () => {
  const h = http((url) => (url.includes('/count?') ? { status: 200, body: '{"count":0}', latencyMs: 1, retryAfterMs: null } : { status: 204, body: '', latencyMs: 1, retryAfterMs: null }));
  const ctx = ctxOf({ fetchOptions: h.fetchOptions });
  const sealedAfter: number[] = [];
  await fetchUnits(ctx, 4, () => {
    sealPeriods(ctx);
    sealedAfter.push(ctx.idx.raw.length);
  });
  assert.deepEqual(sealedAfter, [1, 2], 'one seal per completed month, right after its fetch');
  // In the order they were sealed: the newest month first, the older one on its frozen first day.
  assert.deepEqual(ctx.idx.editions.map((e) => [e.period, e.edition, e.context]), [
    ['2022-12', 1, null],
    ['2022-11', 1, 'history-2022/events-2022-12.e1.tar.zst#01.ndjson'],
  ]);
  assert.deepEqual(ctx.report.sealed.length, 2);
  // The run's view of the Release follows its own uploads without listing it again after each one.
  assert.deepEqual(
    ctx.assetCache.get('history-2022')!.map((a) => a.name).sort(),
    ctx.store.list('history-2022').map((a) => a.name),
  );
});

// Round 24: the walk's streaks (attempts, and the no-progress streak) live in knowledge/index/history-state.json, so a
// run that only counts one more failure leaves the 2.5 MB index as it was; a walk that makes no progress turns the run
// red after a day of unexplained runs, then once a day while it lasts.

/** The two files of the data branch as the commit job leaves them (the state file absent before round 24). */
interface DataFiles {
  index: string;
  state: string | null;
}

const hourIso = (h: number): string => new Date(Date.parse(NOW_ISO) + h * 3_600_000).toISOString();

/** One production run: the index and the state read back from text, a fresh run context on the same Releases, the
 *  run, and the two texts the commit job copies to the data branch. */
async function hourly(store: HistoryStore, files: DataFiles, nowIso: string, h: ReturnType<typeof http>, over: Partial<Ctx> = {}) {
  const idx = parseIndex(files.index);
  const state = loadState(idx, files.state);
  const ctx = ctxOf({ idx, store, now: () => nowIso, fetchOptions: h.fetchOptions, ...over });
  const run = await runWalk(ctx, state, ctx.cfg.maxUnitsPerRun);
  const out = walkTexts(idx, state, indexText);
  return { ctx, run, files: { index: out.index, state: out.state } as DataFiles };
}
const stallAlarms = (ctx: Ctx): string[] => ctx.report.blocked.filter((m) => m.includes('no progress'));
const failing = http(() => ({ status: 500, body: 'boom', latencyMs: 1, retryAfterMs: null }));
const answering = () => http((url) => (url.includes('/count?') ? { status: 200, body: '{"count":0}', latencyMs: 1, retryAfterMs: null } : { status: 204, body: '', latencyMs: 1, retryAfterMs: null }));

test('state: a run that only counts one more failure leaves history.json byte for byte; the next run reads the streak back from history-state.json and goes on; success clears it, and a run with nothing to do changes neither file', { skip: !hasZstd && 'zstd not installed' }, async () => {
  const store = new LocalStore(join(mkdtempSync(join(tmpdir(), 'history-state-')), 'releases'));
  const start: DataFiles = { index: indexText(emptyIndex(CFG.boundary)), state: null };
  const r1 = await hourly(store, start, hourIso(0), failing);
  assert.equal(r1.files.index, start.index, 'no index commit for a failure');
  assert.deepEqual(parseState(r1.files.state!).attempts['usgs:2022-12'], { failures: 1, since: hourIso(0), last_error: r1.ctx.idx.attempts['usgs:2022-12']!.last_error });
  const r2 = await hourly(store, r1.files, hourIso(1), failing);
  assert.equal(r2.files.index, start.index);
  const s2 = parseState(r2.files.state!);
  assert.equal(s2.attempts['usgs:2022-12']?.failures, 2, 'counted on from the state file');
  assert.equal(s2.attempts['usgs:2022-12']?.since, hourIso(0));
  assert.equal(s2.attempts['usgs:2022-11']?.failures, 1, 'the failed month no longer holds back the older one (round 23)');
  assert.deepEqual(s2.stall, { since: hourIso(0), runs: 2, unexplained: 2, alarmed_at: null });
  // The source answers again: both months are fetched and sealed, the index gains them, the streaks go.
  const r3 = await hourly(store, r2.files, hourIso(2), answering());
  assert.notEqual(r3.files.index, start.index);
  assert.deepEqual(parseIndex(r3.files.index).raw.map((r) => r.period), ['2022-11', '2022-12']);
  assert.deepEqual(parseIndex(r3.files.index).attempts, {}, 'the index holds no streaks');
  assert.deepEqual(parseState(r3.files.state!), emptyState());
  // The era is walked to its end: a run finds nothing to do and changes nothing (the commit job commits nothing).
  const quiet = answering();
  const r4 = await hourly(store, r3.files, hourIso(3), quiet);
  assert.deepEqual(r4.files, r3.files);
  assert.deepEqual(quiet.calls, []);
});

test('state: the streaks an index still holds (written before round 24) move to the state file, and the index is written once without them', () => {
  const idx = emptyIndex(CFG.boundary);
  idx.attempts['emsc:2017-12'] = { failures: 150, since: '2026-10-07T01:33:00.000Z', last_error: 'unreadable answer' };
  const before = indexText(idx);
  const state = loadState(parseIndex(before), null);
  assert.equal(state.attempts['emsc:2017-12']?.failures, 150);
  const idx2 = parseIndex(before);
  const out = walkTexts(idx2, loadState(idx2, null), indexText);
  assert.equal(out.index, indexText(emptyIndex(CFG.boundary)));
  assert.equal(parseState(out.state).attempts['emsc:2017-12']?.failures, 150);
  // With the state file there and the index's own streaks empty, the state file's are the current ones.
  const idx3 = parseIndex(out.index);
  assert.equal(loadState(idx3, out.state).attempts['emsc:2017-12']?.failures, 150);
  assert.equal(idx3.attempts['emsc:2017-12']?.failures, 150, 'the run works on the state file\'s streaks');
});

test('state: the streak of a source month the index already holds (fetched by a run whose commit was lost, then adopted) is dropped', () => {
  const idx = emptyIndex(CFG.boundary);
  idx.raw.push({ source: 'usgs', period: '2022-12', tag: 'history-2022', asset: 'raw-usgs-2022-12.ndjson.zst', url: 'x', sha256: 'x', bytes: 1, rows: 0, provider_count: 0, start: '2022-12-01T00:00:00.000Z', end: '2023-01-01T00:00:00.000Z', fetch_min_magnitude: null, fetched_at: NOW_ISO });
  const state = loadState(idx, null);
  state.attempts['usgs:2022-12'] = { failures: 3, since: NOW_ISO, last_error: 'timeout' };
  state.attempts['usgs:2022-11'] = { failures: 1, since: NOW_ISO, last_error: 'timeout' };
  assert.deepEqual(Object.keys(parseState(walkTexts(idx, state, indexText).state).attempts), ['usgs:2022-11']);
});

test('stall: a day of runs with work left and nothing fetched, sealed or adopted turns the run red, then once a day while it lasts; progress ends it', { skip: !hasZstd && 'zstd not installed' }, async () => {
  const store = new LocalStore(join(mkdtempSync(join(tmpdir(), 'history-stall-')), 'releases'));
  let files: DataFiles = { index: indexText(emptyIndex(CFG.boundary)), state: null };
  const red: number[] = [];
  let last: Ctx | null = null;
  for (let h = 0; h < 48; h++) {
    const r = await hourly(store, files, hourIso(h), failing);
    if (stallAlarms(r.ctx).length) red.push(h);
    if (h === STALL_ALARM_RUNS - 1) last = r.ctx;
    files = r.files;
  }
  // The 24th run (hour 23), then 23 h later (hour 46); not every 24th failure of a month, not every run after.
  assert.deepEqual(red, [23, 46]);
  const msg = stallAlarms(last!)[0]!;
  assert.match(msg, /no progress for 24 run\(s\) since 2026-10-04T11:26:00\.000Z \(24 of them with no Retry-After or time budget to explain them\): 2 source month\(s\) to fetch and 0 complete month\(s\) to seal/);
  assert.match(msg, /failing: usgs:2022-12 \(24 failed run\(s\) since 2026-10-04T11:26:00\.000Z: .*HTTP 500.*\); usgs:2022-11 \(23 failed run\(s\)/);
  assert.equal(files.index, indexText(emptyIndex(CFG.boundary)), '48 failed runs, not one index commit');
  assert.deepEqual(parseState(files.state!).stall, { since: hourIso(0), runs: 48, unexplained: 48, alarmed_at: hourIso(46) });
  const ok = await hourly(store, files, hourIso(48), answering());
  assert.deepEqual(stallAlarms(ok.ctx), []);
  assert.equal(parseState(ok.files.state!).stall, null);
});

test('stall: runs that only wait for a Retry-After or run out of time are explained and do not count toward the day; a failure does', async () => {
  const store = new LocalStore(join(mkdtempSync(join(tmpdir(), 'history-held-')), 'releases'));
  const idx = emptyIndex(CFG.boundary);
  const state = loadState(idx, null);
  state.attempts['usgs:2022-12'] = { failures: 1, since: NOW_ISO, last_error: 'HTTP 429', not_before: new Date(Date.now() + 3_600_000).toISOString() };
  const start = walkTexts(idx, state, indexText);
  // Held by its Retry-After: no request.
  const held = http(() => ({ status: 500, body: 'boom', latencyMs: 1, retryAfterMs: null }));
  const r1 = await hourly(store, start, hourIso(0), held);
  assert.deepEqual(held.calls, []);
  assert.equal(r1.ctx.report.held.length, 1);
  assert.deepEqual(parseState(r1.files.state!).stall, { since: hourIso(0), runs: 1, unexplained: 0, alarmed_at: null });
  // The pause is over; the run's time budget is spent before the first month is asked.
  const s1 = parseState(r1.files.state!);
  delete s1.attempts['usgs:2022-12']!.not_before;
  const r2 = await hourly(store, { index: r1.files.index, state: JSON.stringify(s1) }, hourIso(1), held, { deadline: Date.now() - 1 });
  assert.deepEqual(r2.ctx.report.budget, ['fetching from usgs:2022-12 on']);
  assert.deepEqual(parseState(r2.files.state!).stall, { since: hourIso(0), runs: 2, unexplained: 0, alarmed_at: null });
  // A source that answers 429 through every retry is rate-limited too, and is not asked for its older months.
  const limited = http(() => ({ status: 429, body: 'slow down', latencyMs: 1, retryAfterMs: 1_000 }));
  const r3 = await hourly(store, r2.files, hourIso(2), limited);
  assert.deepEqual(r3.ctx.report.rate_limited.map((x) => x.split(':').slice(0, 2).join(':')), ['usgs:2022-12']);
  assert.ok(limited.calls.every((u) => u.includes('starttime=2022-12-')), 'the source stops for the run');
  assert.deepEqual(parseState(r3.files.state!).stall, { since: hourIso(0), runs: 3, unexplained: 0, alarmed_at: null });
  // A failure of another kind counts.
  const r4 = await hourly(store, r3.files, hourIso(3), held);
  assert.deepEqual(parseState(r4.files.state!).stall, { since: hourIso(0), runs: 4, unexplained: 1, alarmed_at: null });
});

test('stall: the thresholds — 24 unexplained runs, or 72 runs of any kind; the repeat after 23 h; no work left ends the streak', () => {
  const s: HistoryState = emptyState();
  const idle = (explained: boolean) => ({ progress: false, workLeft: true, explained });
  const t = (h: number): string => hourIso(h);
  for (let h = 0; h < STALL_ALARM_RUNS_ANY - 1; h++) assert.equal(recordRun(s, idle(true), t(h)), false, `explained run ${h}`);
  assert.equal(recordRun(s, idle(true), t(71)), true, 'the 72nd run of any kind');
  assert.equal(recordRun(s, idle(true), t(72)), false);
  assert.equal(recordRun(s, idle(true), t(71 + 23)), true, 'the repeat, 23 h later');
  assert.equal(recordRun(s, { progress: false, workLeft: false, explained: false }, t(95)), false);
  assert.equal(s.stall, null, 'no work left: the streak ends');
  for (let h = 0; h < STALL_ALARM_RUNS - 1; h++) recordRun(s, idle(h % 2 === 0), t(100 + h));
  assert.equal((s.stall as HistoryState['stall'])?.unexplained, 11, 'every other run unexplained');
  for (let h = 0; h < 12; h++) assert.equal(recordRun(s, idle(false), t(123 + h)), false);
  assert.equal(recordRun(s, idle(false), t(135)), true, 'the 24th unexplained run, explained ones between');
  assert.equal(recordRun(s, { progress: true, workLeft: true, explained: false }, t(136)), false);
  assert.equal(s.stall, null, 'progress ends the streak');
});

// Review of round 24 (#99): the two time-budget cases that make a no-progress run explained (counted toward the 72-run
// alarm, not the 24-run one) had no test, and either marker could be dropped with every test green.
test('stall: a month whose fetch the time budget cuts short, and a seal the budget leaves to the next run, are explained', { skip: !hasZstd && 'zstd not installed' }, async () => {
  const store = new LocalStore(join(mkdtempSync(join(tmpdir(), 'history-budget-')), 'releases'));
  // ComCat answers the month's count, and the run's time is up before the query itself goes out: the month is asked
  // from its start again next run (a month never fetched whole within maxSecondsPerRun).
  let late = false;
  const calls: string[] = [];
  const cut = {
    calls,
    fetchOptions: {
      fetcher: async (url: string): Promise<HttpAnswer> => {
        calls.push(url);
        late = true;
        return { status: 200, body: '{"count":3}', latencyMs: 1, retryAfterMs: null };
      },
      sleep: async () => {},
      now: () => (late ? Date.now() + 3_600_000 : Date.now()),
    },
  };
  const start: DataFiles = { index: indexText(emptyIndex(CFG.boundary)), state: null };
  const r1 = await hourly(store, start, hourIso(0), cut);
  assert.equal(calls.length, 1, 'the count only');
  assert.match(calls[0]!, /\/count\?.*starttime=2022-12-01/);
  assert.deepEqual(r1.ctx.report.budget, ['usgs:2022-12']);
  assert.deepEqual(r1.ctx.report.failed, [], 'not a failure: no streak for the month');
  assert.equal(r1.files.index, start.index);
  assert.deepEqual(parseState(r1.files.state!), { version: 1, attempts: {}, stall: { since: hourIso(0), runs: 1, unexplained: 0, alarmed_at: null } });

  // Both months fetched, neither sealed, and the time is up before the first seal: the seals wait for the next run.
  const idx = emptyIndex(CFG.boundary);
  for (const period of ['2022-11', '2022-12']) {
    const p = allPeriods(CFG).find((x) => x.key === period)!;
    idx.raw.push({
      source: 'usgs', period, tag: historyTag(period), asset: rawAssetName('usgs', period, 1), url: 'x', sha256: 'x', bytes: 1, rows: 0, provider_count: 0,
      start: new Date(p.startMs).toISOString(), end: new Date(p.endMs).toISOString(), fetch_min_magnitude: null, fetched_at: NOW_ISO,
    });
  }
  const idle = http(() => ({ status: 500, body: 'boom', latencyMs: 1, retryAfterMs: null }));
  const r2 = await hourly(store, { index: indexText(idx), state: r1.files.state }, hourIso(1), idle, { deadline: Date.now() - 1 });
  assert.deepEqual(idle.calls, [], 'nothing left to fetch');
  assert.deepEqual(r2.run, { fatal: null, pending: 0, unsealed: 2 });
  assert.ok(r2.ctx.report.budget.includes('sealing 2022-12 on'), JSON.stringify(r2.ctx.report.budget));
  assert.deepEqual(r2.ctx.report.sealed, []);
  assert.deepEqual(parseState(r2.files.state!).stall, { since: hourIso(0), runs: 2, unexplained: 0, alarmed_at: null });
});
