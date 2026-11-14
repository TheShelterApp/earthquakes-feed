import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { frozenProviders, silentProviders, updateActivity } from '../src/activity.js';
import {
  type BreakerIndex,
  type BreakerPlan,
  breakerPlan,
  breakerSkipRuns,
  breakerTracked,
  isNoAnswer,
  loadBreakers,
  saveBreakers,
  updateBreakers,
} from '../src/breaker.js';
import { BREAKER_RUN_INTERVAL_MS, BREAKER_SKIP_RUNS, BREAKER_TRIP_RUNS, FETCH_TIMEOUT_MS } from '../src/config.js';
import { PIN_HINT } from '../src/custom.js';
import { type FetchOutcome, type Fetcher, loadRegistry } from '../src/providers.js';
import { enrichStatusV2, updateProviderHealth } from '../src/status-v2.js';
import { fetchRunInputs } from '../src/sweep-cursor.js';
import type { ProviderConfig, ProviderStatus } from '../src/types.js';

// SHLTR-147: a source that does not answer for BREAKER_TRIP_RUNS runs is skipped for a growing back-off, then probed
// once; a skipped source is a failing one to everything that reads status.

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const registry = loadRegistry(here('../providers/registry.json'));
const byId = (id: string): ProviderConfig => registry.find((p) => p.id === id)!;
const NOW = Date.parse('2026-11-08T13:00:00Z');
const RUN = BREAKER_RUN_INTERVAL_MS;
const ABORTED = 'This operation was aborted';

const answered: ProviderStatus = { ok: true, http_status: 200, latency_ms: 900, events_returned: 12 };
const empty: ProviderStatus = { ok: true, http_status: 204, latency_ms: 300, events_returned: 0 };
const timedOut: ProviderStatus = { ok: false, error: ABORTED };
const http502: ProviderStatus = { ok: false, http_status: 502, latency_ms: 400, error: 'HTTP 502' };
const out = (provider: string, status: ProviderStatus): FetchOutcome => ({ provider, obs: [], status });
const noPlan: BreakerPlan = { skipped: {}, probing: [] };

/** One aggregate run of the breaker alone: plan, the outcomes `answer` gives the sources asked, update. */
function run(index: BreakerIndex, active: ProviderConfig[], nowMs: number, answer: (id: string) => ProviderStatus, seq = 1) {
  const plan = breakerPlan(index, active, nowMs);
  const outcomes = active.map((p) => out(p.id, plan.skipped[p.id] ?? answer(p.id)));
  return { plan, outcomes, ...updateBreakers(index, outcomes, plan, active, nowMs, seq) };
}

test('isNoAnswer: a timeout, an abort or a connection failure trips; an HTTP status, an empty answer, a parse error or a pinned certificate failure does not', () => {
  for (const error of [ABORTED, 'fetch failed', 'fetch failed (UND_ERR_CONNECT_TIMEOUT Connect Timeout Error)', 'timeout', 'timeout: no complete answer in 15000 ms', 'socket hang up', 'connect ECONNREFUSED 1.2.3.4:443', 'getaddrinfo ENOTFOUND x.example', '', 'deadline: 45000 ms spent after 2 attempt(s); last: This operation was aborted']) {
    assert.equal(isNoAnswer({ ok: false, error }), true, JSON.stringify(error));
  }
  assert.equal(isNoAnswer({ ok: false }), true, 'no message at all');
  assert.equal(isNoAnswer(http502), false);
  assert.equal(isNoAnswer({ ok: false, http_status: 504, error: ABORTED }), false, 'an http_status is an answer whatever the message');
  assert.equal(isNoAnswer({ ok: false, error: 'HTTP 503' }), false, "a custom adapter's HTTP error");
  assert.equal(isNoAnswer({ ok: false, error: 'deadline: 45000 ms spent after 3 attempt(s); last: HTTP 503' }), false);
  assert.equal(isNoAnswer({ ok: false, error: 'Unexpected token < in JSON at position 0' }), false, 'a parse error');
  assert.equal(isNoAnswer({ ok: false, error: `unable to verify the first certificate (${PIN_HINT})` }), false, 'tls_errors keeps it in view');
  assert.equal(isNoAnswer(empty), false);
  assert.equal(isNoAnswer(answered), false);
});

test('tracked: not the swept sources (usgs, emsc) nor one the live path does not ask (isc)', () => {
  assert.deepEqual(['usgs', 'emsc', 'isc', 'noa', 'geofon', 'cenc'].map((id) => breakerTracked(byId(id))), [false, false, false, true, true, true]);
  const active = ['usgs', 'emsc', 'isc'].map(byId);
  let index: BreakerIndex = {};
  for (let i = 0; i < 10; i++) index = run(index, active, NOW + i * RUN, () => timedOut).index;
  assert.deepEqual(index, {});
});

test('closed → open: one or two runs without an answer count, the third opens it; the next runs skip without a request', () => {
  const active = [byId('noa'), byId('geonet')];
  const answers = (noa: ProviderStatus) => (id: string): ProviderStatus => (id === 'noa' ? noa : answered);
  let r = run({}, active, NOW, answers(timedOut));
  assert.deepEqual(r.index, { noa: { failures: 1, lastError: ABORTED } });
  r = run(r.index, active, NOW + RUN, answers(timedOut));
  assert.deepEqual([r.index['noa']!.failures, r.opened], [2, []]);
  // A single blip (or two) never opens it: an answer clears the count.
  assert.deepEqual(run(r.index, active, NOW + 2 * RUN, answers(answered)).index, {});
  assert.deepEqual(run(r.index, active, NOW + 2 * RUN, answers(empty)).index, {}, 'an empty answer is an answer');
  r = run(r.index, active, NOW + 2 * RUN, answers(timedOut));
  assert.equal(BREAKER_TRIP_RUNS, 3);
  assert.deepEqual(r.opened, ['noa']);
  const noa = r.index['noa']!;
  assert.deepEqual([noa.failures, noa.opens, noa.skipRuns, noa.openSinceMs], [3, 1, 2, NOW + 2 * RUN]);
  // Two runs are skipped; the third run after the opening probes (half an interval of slack either way).
  assert.equal(noa.nextProbeMs, NOW + 2 * RUN + 3 * RUN - RUN / 2);
  for (const k of [3, 4]) {
    const plan = breakerPlan(r.index, active, NOW + k * RUN + 90_000);
    assert.deepEqual(Object.keys(plan.skipped), ['noa'], `run ${k}`);
    assert.deepEqual(plan.probing, []);
    const s = plan.skipped['noa']!;
    assert.equal(s.ok, false);
    assert.equal(s.skipped, 'breaker');
    assert.equal(s.http_status, undefined);
    assert.deepEqual(s.breaker, { open_since: '2026-11-08T13:10:00.000Z', next_probe: '2026-11-08T13:22:30.000Z', failures: 3, skip_runs: 2 });
    assert.match(s.error!, /^not asked: circuit breaker open after 3 runs without an answer \(last: This operation was aborted\)$/);
  }
  assert.deepEqual(breakerPlan(r.index, active, NOW + 5 * RUN - 120_000).probing, ['noa'], 'a run 2 min early still probes');
  // A skipped run leaves the entry as it was.
  const skippedRun = run(r.index, active, NOW + 3 * RUN, () => answered);
  assert.deepEqual(skippedRun.index, r.index);
  assert.deepEqual([skippedRun.opened, skippedRun.closed], [[], []]);
});

test('an HTTP error status never trips the breaker, however long it lasts', () => {
  const active = [byId('geofon')];
  let index: BreakerIndex = {};
  for (let i = 0; i < 20; i++) {
    const r = run(index, active, NOW + i * RUN, () => http502);
    assert.deepEqual([r.opened, Object.keys(r.plan.skipped)], [[], []]);
    index = r.index;
  }
  assert.deepEqual(index, {});
  // Nor does it extend a streak of timeouts: it resets it.
  index = run(run(index, active, NOW, () => timedOut).index, active, NOW + RUN, () => timedOut).index;
  assert.deepEqual(run(index, active, NOW + 2 * RUN, () => http502).index, {});
});

/** An index with noa opened at NOW (first opening). */
function openedAtNow(): BreakerIndex {
  const active = [byId('noa')];
  let index: BreakerIndex = {};
  for (let i = BREAKER_TRIP_RUNS - 1; i >= 0; i--) index = run(index, active, NOW - i * RUN, () => timedOut).index;
  assert.equal(index['noa']!.opens, 1);
  return index;
}

test('open → half-open → closed: the probe that gets an answer (an HTTP error included) closes it and clears the count', () => {
  const active = [byId('noa')];
  const index = openedAtNow();
  for (const answer of [answered, empty, http502]) {
    const r = run(index, active, index['noa']!.nextProbeMs!, () => answer);
    assert.deepEqual(r.plan.probing, ['noa']);
    assert.deepEqual(r.plan.skipped, {});
    assert.deepEqual([r.closed, r.index], [['noa'], {}]);
  }
});

test('half-open → open: a probe without an answer re-opens it with the next, longer back-off, the open-since time kept; the cap holds', () => {
  const active = [byId('noa')];
  let index = openedAtNow();
  const seen: number[] = [index['noa']!.skipRuns!];
  for (let k = 2; k <= 8; k++) {
    const at = index['noa']!.nextProbeMs!;
    const r = run(index, active, at, () => timedOut, 1000 + k);
    assert.deepEqual(r.reopened, ['noa']);
    const noa = r.index['noa']!;
    assert.equal(noa.opens, k);
    assert.equal(noa.openSinceMs, NOW, 'open since the first opening');
    assert.equal(noa.failures, BREAKER_TRIP_RUNS + k - 1);
    assert.equal(noa.nextProbeMs, at + (noa.skipRuns! + 1) * RUN - RUN / 2);
    seen.push(noa.skipRuns!);
    index = r.index;
  }
  assert.deepEqual(BREAKER_SKIP_RUNS, [2, 4, 8, 12]);
  // Each back-off is its series value less a jitter of up to a quarter; from the fourth opening on, at most 12.
  const range = (opens: number): [number, number] => {
    const base = BREAKER_SKIP_RUNS[Math.min(opens, 4) - 1]!;
    return [base - Math.floor(base / 4), base];
  };
  seen.forEach((n, i) => {
    const [lo, hi] = range(i + 1);
    assert.ok(n >= lo && n <= hi, `opening ${i + 1}: ${n} runs, not in [${lo}, ${hi}]`);
  });
  assert.ok(seen[1]! < seen[3]!, 'the back-off grows');
});

test('breakerSkipRuns: deterministic per source and run, within [base - base/4, base], every jitter value reached', () => {
  for (let opens = 1; opens <= 6; opens++) {
    const base = BREAKER_SKIP_RUNS[Math.min(opens, BREAKER_SKIP_RUNS.length) - 1]!;
    const values = new Set<number>();
    for (let seq = 0; seq < 400; seq++) {
      const n = breakerSkipRuns(opens, 'noa', seq);
      assert.equal(n, breakerSkipRuns(opens, 'noa', seq));
      values.add(n);
    }
    assert.deepEqual([...values].sort((a, b) => a - b), Array.from({ length: Math.floor(base / 4) + 1 }, (_, i) => base - Math.floor(base / 4) + i), `opens ${opens}`);
  }
  // Two sources that opened on the same run do not all come back on the same one.
  const twelve = new Set(registry.filter(breakerTracked).map((p) => breakerSkipRuns(4, p.id, 123_456)));
  assert.ok(twelve.size > 1);
});

test('state file: missing or corrupt means all closed; an unreadable entry is dropped, the others kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'breaker-'));
  const path = join(dir, 'knowledge', 'index', 'provider_breakers.json');
  assert.deepEqual(loadBreakers(path), { index: {}, dropped: [] });
  const index = openedAtNow();
  saveBreakers(path, index);
  assert.deepEqual(loadBreakers(path), { index, dropped: [] });
  writeFileSync(path, '{"noa": {"failures": 3, "lastErr');
  assert.deepEqual(loadBreakers(path), { index: {}, dropped: ['(the file does not parse)'] });
  writeFileSync(path, '[]');
  assert.deepEqual(loadBreakers(path).index, {});
  writeFileSync(path, JSON.stringify({
    noa: index['noa'],
    geofon: { failures: 'three', lastError: ABORTED },
    cenc: { failures: 3, lastError: ABORTED, openSinceMs: NOW },
    ncs: { failures: 2, lastError: ABORTED, openSinceMs: NOW, opens: 1, skipRuns: 2, nextProbeMs: 'soon' },
    ipgp: null,
    ethz: { failures: 1, lastError: ABORTED },
  }));
  const loaded = loadBreakers(path);
  assert.deepEqual(loaded.index, { noa: index['noa'], ethz: { failures: 1, lastError: ABORTED } });
  assert.deepEqual(loaded.dropped, ['geofon', 'cenc', 'ncs', 'ipgp']);
  // A dropped entry is closed: the source is asked.
  assert.deepEqual(breakerPlan(loaded.index, ['cenc', 'ncs'].map(byId), NOW + RUN).skipped, {});
});

test('a run where most sources get no answer (the runner, not the sources) counts no failure and re-opens nothing', () => {
  const active = ['noa', 'geonet', 'ingv', 'knmi', 'geofon', 'ethz', 'nrcan', 'ncedc'].map(byId);
  let index: BreakerIndex = { geonet: { failures: 2, lastError: ABORTED } };
  const r = run(index, active, NOW, (id) => (['noa', 'geonet', 'ingv', 'knmi', 'geofon'].includes(id) ? timedOut : answered));
  assert.equal(r.massFailure, true);
  assert.deepEqual([r.opened, r.index], [[], { geonet: { failures: 2, lastError: ABORTED } }]);
  // A probe that meets one stays due: the next run probes again.
  index = openedAtNow();
  const probe = run(index, active, index['noa']!.nextProbeMs!, (id) => (['noa', 'geonet', 'ingv', 'knmi', 'geofon'].includes(id) ? timedOut : answered));
  assert.deepEqual([probe.massFailure, probe.reopened, probe.index], [true, [], index]);
  assert.deepEqual(breakerPlan(probe.index, active, index['noa']!.nextProbeMs! + RUN).probing, ['noa']);
  // Half of them is not a mass failure.
  assert.equal(run({}, active, NOW, (id) => (['noa', 'geonet', 'ingv', 'knmi'].includes(id) ? timedOut : answered)).massFailure, false);
  // Entries of sources no longer active go.
  assert.deepEqual(updateBreakers({ gone: { failures: 2, lastError: ABORTED } }, [], noPlan, active, NOW, 1).index, {});
});

test('a skipped source is a failing one to the activity index, silent, frozen, lastSuccessAt and the v2 status', () => {
  const index = openedAtNow();
  const active = [byId('noa')];
  const skipped = breakerPlan(index, active, NOW + RUN).skipped['noa']!;
  const failing: ProviderStatus = timedOut;
  const t0 = NOW - 20 * 3_600_000;
  const prevActivity = { noa: { lastNonEmptyAt: t0, sinceMs: t0 - 86_400_000 } };
  const later = NOW + RUN;
  assert.deepEqual(updateActivity(prevActivity, { noa: skipped }, later), updateActivity(prevActivity, { noa: failing }, later));
  const act = updateActivity(prevActivity, { noa: skipped }, later);
  assert.deepEqual(silentProviders(act, active, later), silentProviders(updateActivity(prevActivity, { noa: failing }, later), active, later));
  assert.deepEqual(frozenProviders({ noa: { ok: skipped.ok, events_returned: skipped.events_returned, newestOriginMs: null } }, active, later), {});
  const health = updateProviderHealth({ noa: t0 }, { noa: { ...skipped } }, later);
  assert.deepEqual(health, { noa: t0 }, 'lastSuccessAt stays at the last answer');
  const v2 = enrichStatusV2({ generated: new Date(later).toISOString(), head_seq: 1, degraded: ['noa'], providers: { noa: { ...skipped } } }, { generatedMs: later, expectedIntervalSeconds: 300, staleAfterSeconds: 1800, health }) as {
    providers: Record<string, { ok: boolean; skipped?: string; lastSuccessAt: number; error: { since: number } | null; breaker?: unknown }>;
    degradedProviders: string[];
  };
  const p = v2.providers['noa']!;
  assert.deepEqual([p.ok, p.skipped, p.lastSuccessAt, p.error?.since], [false, 'breaker', t0, t0]);
  assert.ok(p.breaker);
  assert.deepEqual(v2.degradedProviders, ['noa']);
});

// The acceptance check: a source that hangs costs the fetch phase its whole timeout (twice with a fallback host) until
// its breaker opens; from then on the phase is back within 2 s of the baseline on every run but the rare probe.
test('fetch phase wall time with a hung source: back at the baseline once the breaker opens (injected fetcher, virtual clock)', async () => {
  const active = ['noa', 'geonet', 'ingv', 'knmi', 'geofon', 'ethz'].map(byId);
  const hostOf = new Map<string, string>();
  for (const p of active) for (const b of [p.base, p.fallbackBase]) if (b) hostOf.set(new URL(b).host, p.id);
  const FAST_MS = 700;
  // Virtual time: each request costs its source FAST_MS, or its whole timeout when the source hangs; a source's
  // requests are sequential (base, then fallback), the sources run in parallel, so the phase lasts as long as the
  // costliest source.
  const phase = async (index: BreakerIndex, nowMs: number, seq: number, hung: boolean) => {
    const cost = new Map<string, number>();
    const fetcher: Fetcher = async (url, timeoutMs) => {
      const id = hostOf.get(new URL(url).host)!;
      if (id === 'noa' && hung) {
        cost.set(id, (cost.get(id) ?? 0) + timeoutMs);
        throw new Error(ABORTED);
      }
      cost.set(id, (cost.get(id) ?? 0) + FAST_MS);
      return { status: 204, body: '', latencyMs: FAST_MS };
    };
    const plan = breakerPlan(index, active, nowMs);
    const { live } = await fetchRunInputs(active, [], {}, { nowMs, originFloorMs: nowMs - 3 * 86_400_000, fetcher, skipLive: plan.skipped });
    const next = updateBreakers(index, live, plan, active, nowMs, seq);
    return { wallMs: Math.max(0, ...cost.values()), plan, live, next };
  };
  const baseline = (await phase({}, NOW, 0, false)).wallMs;
  assert.equal(baseline, 2 * FAST_MS, "NOA's empty answer on its host sends it to its fallback host too");
  const noaTimeout = byId('noa').timeoutMs ?? FETCH_TIMEOUT_MS;
  let index: BreakerIndex = {};
  const walls: number[] = [];
  const probes: number[] = [];
  const RUNS = 12 * 24; // a day of 5-minute runs with NOA hung throughout
  for (let i = 0; i < RUNS; i++) {
    const r = await phase(index, NOW + i * RUN, 50_000 + i, true);
    walls.push(r.wallMs);
    if (r.plan.probing.length) probes.push(i);
    const noa = r.live.find((o) => o.provider === 'noa')!;
    if (r.plan.skipped['noa']) {
      assert.equal(noa.status.skipped, 'breaker');
      assert.ok(r.wallMs <= baseline + 2_000, `run ${i}: ${r.wallMs} ms with NOA skipped`);
    } else {
      assert.equal(r.wallMs, 2 * noaTimeout, `run ${i}: NOA asked costs its timeout on both hosts`);
    }
    index = r.next.index;
  }
  // Three runs pay before it opens; then two skipped runs, and probes ever further apart, at most one an hour.
  assert.deepEqual(walls.slice(0, 4), [2 * noaTimeout, 2 * noaTimeout, 2 * noaTimeout, FAST_MS]);
  const gaps = probes.map((p, i) => p - (i === 0 ? BREAKER_TRIP_RUNS - 1 : probes[i - 1]!));
  assert.equal(gaps[0], 3, 'the first probe: two runs skipped after the opening');
  for (const g of gaps.slice(3)) assert.ok(g >= 10 && g <= 13, `gap ${g}`);
  const paying = walls.filter((w) => w > baseline + 2_000).length;
  assert.equal(paying, BREAKER_TRIP_RUNS + probes.length);
  assert.ok(paying <= 30, `${paying} of ${RUNS} runs paid the timeout (without the breaker: all ${RUNS})`);
  // NOA answers again: the next probe closes it and the source is asked on every run after.
  const at = index['noa']!.nextProbeMs!;
  const back = await phase(index, at, 99, false);
  assert.deepEqual([back.plan.probing, back.next.closed, back.next.index], [['noa'], ['noa'], {}]);
  assert.equal(back.wallMs, baseline);
});
