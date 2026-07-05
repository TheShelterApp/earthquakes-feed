import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dataPaths } from '../src/config.js';
import { earliestEventMapDay, loadEventMap, saveEventMap } from '../src/bitemporal.js';
import { Resolver } from '../src/dedup.js';
import { onboardStep } from '../src/onboard.js';
import type { EventNode, ProviderConfig, RawObs } from '../src/types.js';
import type { WindowOutcome } from '../src/providers.js';

const cfg = (id: string, priority: number): ProviderConfig =>
  ({ id, priority, adapter: 'fdsn', license: 'x', attribution: id.toUpperCase(), doi: null } as ProviderConfig);
const ALL = [cfg('usgs', 0), cfg('emsc', 1)];

const NOW = Date.parse('2026-07-05T12:00:00Z');
const raw = (over: Partial<RawObs>): RawObs => ({
  provider: 'usgs', providerEventId: 'x', eventTimeMs: 0, providerUpdatedMs: null, status: 'reviewed',
  lat: 38.1, lon: 21.9, depth: 10, mag: 4.5, magType: 'ml', place: 'Greece', knownAliasIds: [], fields: {}, ...over,
});

function seedEventMap(root: string): void {
  // One USGS event ~5 days ago (inside the recent window [liveDay, now-2d]).
  const map = new Map<string, EventNode>();
  const r = new Resolver(map, new Map([['usgs', 0], ['emsc', 1]]), new Map(ALL.map((p) => [p.id, p])), NOW);
  r.ingest(raw({ provider: 'usgs', providerEventId: 'us1', eventTimeMs: Date.parse('2026-06-30T10:00:00Z') }), '2026-06-30T10:05:00Z');
  saveEventMap(root, map);
  mkdirSync(dataPaths(root).indexDir, { recursive: true });
  writeFileSync(dataPaths(root).head, JSON.stringify({ seq: 100, ingest_time: '2026-06-30T10:05:00Z' }) + '\n');
}

test('onboard: bootstrap seeds current sources as already-onboarded (no gap-fill for them)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'efd-onb-'));
  try {
    const res = await onboardStep(root, ALL, ALL, '2026-06-30', NOW, '2026-07-05T12:00:00Z', async () => {
      throw new Error('must not fetch on bootstrap');
    });
    assert.equal(res.bootstrapped, true);
    const st = JSON.parse(readFileSync(dataPaths(root).onboardCursor, 'utf8'));
    assert.deepEqual(st.onboarded.sort(), ['emsc', 'usgs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('onboard: a NEW source fills its recent window into the event_map (merges + mints)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'efd-onb-'));
  try {
    seedEventMap(root);
    const liveDay = earliestEventMapDay(root, NOW);
    assert.equal(liveDay, '2026-06-30');
    // Pretend only usgs was here before; emsc is the newly-added source.
    writeFileSync(dataPaths(root).onboardCursor, JSON.stringify({ onboarded: ['usgs'], pending: {} }) + '\n');

    // Stub: emsc reports the SAME quake (should merge onto us1) + one emsc-only quake.
    const stub = async (): Promise<WindowOutcome> =>
      ({
        provider: 'emsc',
        status: { ok: true, events_returned: 2 },
        overflow: false,
        obs: [
          raw({ provider: 'emsc', providerEventId: 'em1', eventTimeMs: Date.parse('2026-06-30T10:00:04Z'), lat: 38.11, lon: 21.9, mag: 4.6, magType: 'mb', place: 'GREECE' }),
          raw({ provider: 'emsc', providerEventId: 'em2', eventTimeMs: Date.parse('2026-07-01T05:00:00Z'), lat: 40.0, lon: 25.0, mag: 3.2, place: 'Aegean' }),
        ],
      } satisfies WindowOutcome);

    const res = await onboardStep(root, ALL, ALL, liveDay, NOW, '2026-07-05T12:00:00Z', stub);
    assert.equal(res.provider, 'emsc');
    assert.ok((res.changed ?? 0) >= 2, 'merged the shared event + minted the emsc-only event');

    const map = loadEventMap(root, {});
    const nodes = [...map.values()];
    const shared = nodes.find((n) => n.provenance.some((p) => p.nativeId === 'us1'))!;
    assert.ok(shared.provenance.some((p) => p.provider === 'emsc'), 'emsc merged into the existing USGS event');
    assert.ok(shared.aliases.includes('emsc:em1'));
    assert.ok(nodes.some((n) => n.provenance.some((p) => p.nativeId === 'em2')), 'emsc-only event minted');

    // Cursor walked back to the live floor; the next step completes onboarding.
    const done = await onboardStep(root, ALL, ALL, liveDay, NOW, '2026-07-05T12:00:00Z', async () => {
      throw new Error('should not fetch once at the floor');
    });
    assert.equal(done.done, true);
    const st = JSON.parse(readFileSync(dataPaths(root).onboardCursor, 'utf8'));
    assert.ok(st.onboarded.includes('emsc') && !('emsc' in st.pending), 'emsc handed off to deep backfill');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
