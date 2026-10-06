import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { seedActivity } from '../src/activity.js';
import { HISTORY_OMITTED_PROVIDER_FIELDS, historyStatus, saveMeta } from '../src/bitemporal.js';
import { dataPaths } from '../src/config.js';

// FEED-R15-1 (round 16): the status/history line leaves out the per-provider fields of the current run
// (`newest_origin`, `tls_leaf`); status.json keeps them, and the line keeps the top-level `frozen` and `tls_leaves`.

const LEAF = { not_after: '2026-10-09T01:59:47.000Z', days_left: 3.1, issuer: 'CN=R11', subject: 'CN=tmd.go.th', seen_at: '2026-10-06T00:00:00.000Z' };

function status(generated: string) {
  return {
    generated,
    head_seq: 7,
    degraded: ['bgs'],
    silent: {},
    frozen: { bgs: { newest_origin: '2026-09-25T00:00:00.000Z', newest_origin_age_hours: 264.5, window_hours: 48, budget_hours: 216, rows: 40 } },
    tls_leaves: { tmd: LEAF },
    providers: {
      usgs: { ok: true, http_status: 200, latency_ms: 812, events_returned: 400, newest_origin: '2026-10-06T00:58:00.000Z' },
      bgs: { ok: true, http_status: 200, latency_ms: 300, events_returned: 40, newest_origin: '2026-09-25T00:00:00.000Z' },
      tmd: { ok: true, http_status: 200, latency_ms: 950, events_returned: 12, newest_origin: '2026-10-05T22:10:00.000Z', tls_leaf: LEAF },
      ingv: { ok: false, http_status: 503, error: 'HTTP 503' },
      quiet: { ok: true, http_status: 204, events_returned: 0 },
    },
    sweeps: { epoch: 1, updated: {}, deleted: {} },
  };
}

test('historyStatus drops newest_origin and tls_leaf from every provider and keeps everything else', () => {
  const s = status('2026-10-06T01:00:00.000Z');
  const before = JSON.stringify(s);
  const h = historyStatus(s) as ReturnType<typeof status>;
  assert.equal(JSON.stringify(s), before, 'the status itself is not changed');
  for (const [id, p] of Object.entries(h.providers)) {
    for (const k of HISTORY_OMITTED_PROVIDER_FIELDS) assert.equal(k in p, false, `${id}.${k}`);
  }
  assert.deepEqual(h.providers.usgs, { ok: true, http_status: 200, latency_ms: 812, events_returned: 400 });
  assert.deepEqual(h.providers.tmd, { ok: true, http_status: 200, latency_ms: 950, events_returned: 12 });
  assert.deepEqual(h.providers.ingv, s.providers.ingv);
  assert.deepEqual(h.providers.quiet, s.providers.quiet);
  // The top level is untouched: frozen keeps the frozen source's newest origin, tls_leaves every pinned leaf.
  const { providers: _a, ...topH } = h;
  const { providers: _b, ...topS } = s;
  assert.deepEqual(topH, topS);
  assert.deepEqual(h.tls_leaves, { tmd: LEAF });
  assert.equal(h.frozen.bgs.newest_origin, '2026-09-25T00:00:00.000Z');
});

test('historyStatus passes a status without a providers object through as is', () => {
  for (const v of [null, undefined, 3, 'x', [1, 2], { generated: 'g' }, { providers: null }, { providers: [1] }]) {
    assert.equal(historyStatus(v), v);
  }
  const odd = { providers: { a: null, b: 'x', c: { ok: true, newest_origin: 'n' } } };
  assert.deepEqual(historyStatus(odd), { providers: { a: null, b: 'x', c: { ok: true } } });
});

test('saveMeta: status.json is the full status, the month line is the slim one, and the size is returned', () => {
  const root = mkdtempSync(join(tmpdir(), 'efd-status-history-'));
  const p = dataPaths(root);
  const s1 = status('2026-10-06T01:00:00.000Z');
  const s2 = status('2026-10-06T01:05:00.000Z');
  saveMeta(root, { seq: 7, ingest_time: s1.generated }, {}, s1);
  const r = saveMeta(root, { seq: 8, ingest_time: s2.generated }, {}, s2);
  assert.deepEqual(JSON.parse(readFileSync(p.status, 'utf8')), s2);
  assert.equal(r.historyFile, join(p.statusHistoryDir, '2026-10.ndjson'));
  const text = readFileSync(r.historyFile, 'utf8');
  assert.equal(r.historyBytes, Buffer.byteLength(text));
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]!), historyStatus(s2));
  assert.equal(lines[1]!.includes('newest_origin_age_hours'), true, 'frozen stays in the line');
  assert.equal(lines[1]!.includes('"tls_leaf"'), false);
  assert.equal(lines[1]!.length < JSON.stringify(s2).length, true);
  // The month follows the head's ingest time.
  const r3 = saveMeta(root, { seq: 9, ingest_time: '2026-11-01T00:00:00.000Z' }, {}, status('2026-11-01T00:00:00.000Z'));
  assert.equal(r3.historyFile, join(p.statusHistoryDir, '2026-11.ndjson'));
});

test('the activity seed reads slim lines as it read full ones', () => {
  const full = mkdtempSync(join(tmpdir(), 'efd-status-history-full-'));
  const slim = mkdtempSync(join(tmpdir(), 'efd-status-history-slim-'));
  const times = ['2026-10-05T23:55:00.000Z', '2026-10-06T00:00:00.000Z', '2026-10-06T00:05:00.000Z'];
  const fullLines: string[] = [];
  for (const t of times) {
    const s = status(t);
    if (t === times[2]) s.providers.tmd = { ok: true, http_status: 200, latency_ms: 1, events_returned: 0, newest_origin: 'x', tls_leaf: LEAF } as never;
    fullLines.push(JSON.stringify(s)); // a line written before round 16: the full status
    saveMeta(slim, { seq: 1, ingest_time: t }, {}, s);
  }
  mkdirSync(dataPaths(full).statusHistoryDir, { recursive: true });
  writeFileSync(join(dataPaths(full).statusHistoryDir, '2026-10.ndjson'), fullLines.join('\n') + '\n');
  const a = seedActivity(dataPaths(full).statusHistoryDir);
  const b = seedActivity(dataPaths(slim).statusHistoryDir);
  assert.deepEqual(b, a);
  assert.equal(b['tmd']!.lastNonEmptyAt, Date.parse(times[1]!));
  assert.equal(b['ingv']!.lastNonEmptyAt, null);
});
