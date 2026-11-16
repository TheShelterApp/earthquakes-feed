import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { applyWindowResult } from '../src/backfill-plan.js';
import { backfillCfg } from '../src/backfill-cfg.js';
import { AFAD_STORE_EVENTS, CUSTOM_ADAPTERS, afadStoreFloorMs } from '../src/custom.js';
import { fetchProviderWindow, loadRegistry } from '../src/providers.js';

// FEED-DI-2: AFAD's event API answers from its newest 1,000 events only. retentionDays (7) keeps backfill off the days
// that store no longer reaches at AFAD's usual rate, but a swarm shortens it to a day or two, and a window starting
// before the store answered only its part after it, recorded as filled. A window query now first asks the store over
// [window start, now]: when that answer fills the store and its oldest event is after the window start, the window fails.

const DAY = 86_400_000;
const START = Date.parse('2026-11-10T00:00:00Z');
const END = START + DAY;
const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const rows = (n: number, oldestMs: number): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => ({ eventID: String(900_000 + i), date: utc(oldestMs + (n - 1 - i) * 60_000), latitude: 39.2, longitude: 28.1, depth: 7, magnitude: 1.2, type: 'ML', location: 'Sindirgi (Balikesir)' }));

/** A local AFAD: the store probe (limit=1000) and the window query (limit=500) answer their own bodies. */
async function serveAfad(probe: unknown, window: unknown, fn: (base: string, asked: string[]) => Promise<void>): Promise<void> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const limit = new URL(req.url ?? '', 'http://x').searchParams.get('limit') ?? '';
    asked.push(limit);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(limit === String(AFAD_STORE_EVENTS) ? probe : window));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/filter`, asked);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('afad store: the floor is the oldest event of an answer that fills the store, none when it holds fewer', () => {
  assert.equal(afadStoreFloorMs(rows(AFAD_STORE_EVENTS, START + 6 * 3_600_000)), START + 6 * 3_600_000);
  assert.equal(afadStoreFloorMs({ eventList: rows(AFAD_STORE_EVENTS, START) }), START);
  assert.equal(afadStoreFloorMs(rows(AFAD_STORE_EVENTS - 1, START + 6 * 3_600_000)), null, 'fewer: the store reaches back past the start');
  assert.equal(afadStoreFloorMs(null), null);
});

test('afad store: a window starting before the store fails and is not asked; one inside it is answered', async () => {
  const afad = loadRegistry().find((p) => p.id === 'afad')!;
  // A swarm: the newest 1,000 events begin 6 h into the window's day (the 2025-08 Sindirgi days held 500 each).
  const inWindow = rows(120, START + 6 * 3_600_000);
  await serveAfad(rows(AFAD_STORE_EVENTS, START + 6 * 3_600_000), inWindow, async (base, asked) => {
    const cfg = { ...afad, base };
    await assert.rejects(CUSTOM_ADAPTERS.afad!(cfg, END, { startMs: START, endMs: END }), /^Error: afad: its newest 1000 events, all it answers for, begin at 2026-11-10T06:00:00\.000Z, after the window start 2026-11-10T00:00:00\.000Z: the window cannot be answered in full \(FEED-DI-2\)$/);
    assert.deepEqual(asked, ['1000'], 'the window itself is not asked');
    // Backfill sees a failure, never a filled window: a dispatched one is a block, a walk's is halved.
    const r = await fetchProviderWindow(cfg, START, END);
    assert.equal(r.status.ok, false);
    assert.match(r.status.error ?? '', /cannot be answered in full/);
    const j = { p: cfg, cfg: backfillCfg(cfg)!, cur: null, startMs: START, endMs: END };
    const { verdict, blocker } = applyWindowResult(j, r, { ingestTime: new Date(END).toISOString(), targetMs: 0, untouchable: false });
    assert.equal(verdict.kind, 'failed');
    assert.match(blocker ?? '', /dispatched window .* of afad failed: afad: its newest 1000 events/);
  });
  // The store reaches back past the window start (fewer than 1,000 events since): the window is asked and answered.
  await serveAfad(rows(400, START - DAY), inWindow, async (base, asked) => {
    const got = await CUSTOM_ADAPTERS.afad!({ ...afad, base }, END, { startMs: START, endMs: END });
    assert.equal(got.length, 120);
    assert.deepEqual(asked, ['1000', '500']);
  });
  // A full store that begins at the window start (within the 60 s slack) covers it.
  await serveAfad(rows(AFAD_STORE_EVENTS, START + 30_000), inWindow, async (base) => {
    assert.equal((await CUSTOM_ADAPTERS.afad!({ ...afad, base }, END, { startMs: START, endMs: END })).length, 120);
  });
});

test('afad store: the live path asks once, as before', async () => {
  const afad = loadRegistry().find((p) => p.id === 'afad')!;
  await serveAfad(rows(AFAD_STORE_EVENTS, START), rows(10, END - 3_600_000), async (base, asked) => {
    assert.equal((await CUSTOM_ADAPTERS.afad!({ ...afad, base }, END)).length, 10);
    assert.deepEqual(asked, ['500']);
  });
});
