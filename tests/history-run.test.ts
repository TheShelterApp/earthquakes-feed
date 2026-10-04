import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type RawHeader, RAW_KIND, rawFileText } from '../src/history-build.js';
import { type HistoryConfig, type HistoryEra, allPeriods, historyTag, rawAssetName } from '../src/history-config.js';
import type { HttpAnswer } from '../src/history-fetch.js';
import { emptyIndex } from '../src/history-index.js';
import { LocalStore } from '../src/history-store.js';
import { type Ctx, adoptOrphans, fetchUnits } from '../src/history.js';
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
    report: { fetched: [], sealed: [], adopted: [], failed: [], unused: [], blocked: [] },
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

test('fetch: a failing source month counts its failure, keeps the error and is blocked (red) on every 24th failed run', async () => {
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
