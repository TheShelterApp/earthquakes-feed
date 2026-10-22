import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  annotation,
  BACKSTOP_PROVIDER,
  budgetFinding,
  buildUsageRequest,
  CANARY_URL,
  canaryFinding,
  DELETIONS_MAX_WINDOW_MS,
  deletionsFailure,
  DIRECT_PROVIDERS,
  evaluateStatus,
  failureReason,
  fetchJson,
  GATEWAY_TICK_MS,
  GRAPHQL_URL,
  isFastProvider,
  main,
  parseArgs,
  parseUsageResponse,
  plainExitCode,
  pollIntervalMs,
  primaryFailure,
  PROVIDER_BACKOFF_STEPS,
  PROVIDER_MIN_INTERVAL_MS,
  STATUS_URL,
  streakDuration,
  streakSpanSec,
  unreadableFinding,
  usageFindings,
  usageMisconfigured,
  usageWindow,
  type FetchImpl,
  type Verdict,
} from '../scripts/alerts-watchdog.mjs';
import { RULES, parseFindingsDocument, type Finding, type FindingsDocument } from '../scripts/lib/findings.mjs';

// The alert-pipeline evaluator (scripts/alerts-watchdog.mjs, run by .github/workflows/health.yml): findings of the
// alerting plan of 2026-10-22, section 3a. Fixtures: tests/fixtures/alerts-status/healthy.json is a real capture of the
// public prod document; every other status fixture is that capture with one condition changed (the replay fixtures
// gfz-timeout-2026-10-21, usgs-down-2026-10-05 and budget-projected also move the whole capture in time). Nothing here
// touches the network.

const FIXTURES = join(import.meta.dirname, 'fixtures');
const statusFixture = (name: string): Record<string, any> => JSON.parse(readFileSync(join(FIXTURES, 'alerts-status', `${name}.json`), 'utf8'));
const cfFixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, 'cf-analytics', `${name}.json`), 'utf8'));

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T = (iso: string): number => Date.parse(iso);

const HEALTHY = statusFixture('healthy');
const GEN = HEALTHY.generatedAtMs as number;
/** 15 s after the healthy capture was generated. */
const NOW = GEN + 15_000;
const noSleep = async (): Promise<void> => {};

const provider = (doc: Record<string, any>, id: string): Record<string, any> => doc.detector.providers.find((p: { id: string }) => p.id === id);
const sev = (v: Verdict): string[] => v.findings.map((f) => `${f.key} ${f.severity}`);
const find = (v: Verdict, key: string): Finding | undefined => v.findings.find((f) => f.key === key);
const must = (v: Verdict, key: string): Finding => {
  const f = find(v, key);
  assert.ok(f, `no ${key} among ${JSON.stringify(sev(v))}`);
  return f;
};

/** The document moved in time as a whole: every epoch-ms field (…Ms) shifted, budget.day set to the new UTC day. */
function shifted(doc: Record<string, any>, toMs: number): Record<string, any> {
  const delta = toMs - (doc.generatedAtMs as number);
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o !== null && typeof o === 'object') {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (typeof v === 'number' && /Ms$/.test(k) && v > 1e12) (o as Record<string, unknown>)[k] = v + delta;
        else walk(v);
      }
    }
  };
  const d = structuredClone(doc);
  walk(d);
  if (d.budget) d.budget.day = new Date(toMs).toISOString().slice(0, 10);
  return d;
}

/** The most failures in a row whose span at the gateway's polling fits in `sec`. */
function countFor(id: string, sec: number): number {
  let n = 1;
  while (streakSpanSec(id, n + 1) <= sec) n++;
  return n;
}

/** The healthy capture with some providers failing: { id: [seconds failing, extra fields] } — the round-25 gateway's
 *  failingSinceMs, with a plausible count at the gateway's polling. A provider given `null` seconds publishes no start
 *  (an older gateway); then `consecutiveFailures` must come in the extra fields. */
function failingFor(spec: Record<string, number | null | [number | null, Record<string, unknown>]>, base: Record<string, any> = HEALTHY): Record<string, any> {
  const doc = structuredClone(base);
  const ref = doc.generatedAtMs as number;
  for (const p of doc.detector.providers) {
    const v = spec[p.id];
    if (v === undefined) continue;
    const [sec, extra] = Array.isArray(v) ? v : [v, {}];
    const n = sec === null ? 1 : countFor(p.id, sec);
    Object.assign(p, { ok: false, consecutiveFailures: n, httpStatus: 0, latencyMs: 4000, lastError: 'timeout', consecutiveTimeouts: n });
    if (sec !== null) p.failingSinceMs = ref - sec * 1000;
    Object.assign(p, extra);
  }
  return doc;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake fetch that answers from a queue per URL and records every call. */
function fakeFetch(routes: Record<string, Array<Response | Error>>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    const queue = routes[url];
    if (!queue || queue.length === 0) throw new Error(`unexpected fetch ${url}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  };
  return { impl, calls };
}

/** A USGS 4.5_hour summary with events of these origin times. */
const usgsSummary = (...events: Array<{ id: string; time: number; mag?: number }>) => ({
  type: 'FeatureCollection',
  features: events.map((e) => ({ type: 'Feature', id: e.id, properties: { mag: e.mag ?? 4.8, time: e.time, place: 'somewhere' }, geometry: null })),
});

// --- the document gate: unreadable, stale, fresh ---

test('healthy fixture (live prod capture): no finding; the canary unread is the only unjudged key', () => {
  const v = evaluateStatus(HEALTHY, { nowMs: NOW });
  assert.deepEqual(v.findings, []);
  assert.deepEqual(v.unjudged, ['alerts:canary']);
  assert.match(v.summary, /^age=15s providers=usgs:ok,feed:ok,emsc:ok,gfz:ok policy=signed\/v19 degraded=none budget=doRowsWritten:10%\/day apns=configured fanout=n\/a$/);
  // With a clear canary every key is judged.
  const clear = evaluateStatus(HEALTHY, { nowMs: NOW, canary: usgsSummary() });
  assert.deepEqual([clear.findings, clear.unjudged], [[], []]);
  assert.deepEqual(evaluateStatus(statusFixture('healthy-r3'), { nowMs: NOW, canary: usgsSummary() }).findings, []);
});

test('stale fixture: exactly alerts:status:stale P1 since generatedAtMs, and every alerts:* key unjudged', () => {
  const stale = statusFixture('stale');
  const v = evaluateStatus(stale, { nowMs: NOW, canary: usgsSummary() });
  assert.deepEqual(sev(v), ['alerts:status:stale P1']);
  assert.deepEqual(v.unjudged, ['alerts:*']);
  const f = v.findings[0]!;
  assert.deepEqual([f.rule, f.board, f.class, f.check, f.shadow, f.sinceMs], ['alerts:status:stale', 'alerts', 'symptom', 'gh-detect', false, stale.generatedAtMs]);
  assert.equal(f.text, 'status.json is 615 s old (line 300 s, generated 2026-09-25 19:37Z): the detector has stopped publishing, so alerts are not being detected');
  // A stale document's other fields are old: nothing else is judged, however bad it looks.
  const worse = failingFor({ usgs: 3_600, emsc: 3_600, gfz: 3_600 }, stale);
  worse.degraded = statusFixture('degraded').degraded;
  assert.deepEqual(sev(evaluateStatus(worse, { nowMs: NOW })), ['alerts:status:stale P1']);
  assert.equal(plainExitCode(v.findings), 1);
});

test('freshness boundary: 300 s is fresh, 300.001 s stale; a document from the future is a note, judged fresh', () => {
  assert.deepEqual(evaluateStatus(HEALTHY, { nowMs: GEN + 300_000 }).findings, []);
  assert.deepEqual(sev(evaluateStatus(HEALTHY, { nowMs: GEN + 300_001 })), ['alerts:status:stale P1']);
  const future = evaluateStatus(HEALTHY, { nowMs: GEN - 301_000 });
  assert.deepEqual(future.findings, []);
  assert.match(future.notes[0]!, /^generatedAtMs is 301 s in the future: clock skew/);
  assert.deepEqual(evaluateStatus(HEALTHY, { nowMs: GEN - 299_000 }).notes, ['canary: no USGS 4.5_hour summary this run (alerts:canary not judged)']);
});

test('unreadable: not an object, no generatedAtMs, no providers list -> only alerts:status:unreadable P2, alerts:* unjudged', () => {
  const noGen = structuredClone(HEALTHY);
  delete noGen.generatedAtMs;
  const noDetector = structuredClone(HEALTHY);
  delete noDetector.detector;
  const noList = structuredClone(HEALTHY);
  noList.detector.providers = { usgs: { ok: true } };
  const cases: Array<[unknown, RegExp]> = [
    [[1, 2], /^status\.json is not a JSON object\. The alert pipeline state is UNKNOWN\.$/],
    ['ok', /not a JSON object/],
    [null, /not a JSON object/],
    [noGen, /no numeric generatedAtMs/],
    [noDetector, /no detector\.providers list/],
    [noList, /no detector\.providers list/],
  ];
  for (const [doc, text] of cases) {
    const v = evaluateStatus(doc, { nowMs: NOW, canary: usgsSummary() });
    assert.deepEqual(sev(v), ['alerts:status:unreadable P2'], String(text));
    assert.deepEqual(v.unjudged, ['alerts:*']);
    const f = v.findings[0]!;
    assert.deepEqual([f.rule, f.class, f.check, f.sinceMs], ['alerts:status:unreadable', 'unknown', 'gh-platform', null]);
    assert.match(f.text, text);
    assert.equal(plainExitCode(v.findings), 2);
  }
  // The fetch-failure variant (main builds it): the same finding with the reason and the hint.
  const f = unreadableFinding('status.json could not be read (network error): network error: fetch failed after 3 attempts.');
  assert.deepEqual([f.key, f.severity, f.sinceMs, f.check], ['alerts:status:unreadable', 'P2', null, 'gh-platform']);
  assert.throws(() => evaluateStatus(HEALTHY, {} as { nowMs: number }), /nowMs is required/);
});

// --- one provider on its own: P4 samples below the line, P3 at it (an external source is never red) ---

const GFZ_BASE = statusFixture('gfz-timeout-2026-10-21');
const GFZ_START = T('2026-10-21T12:50:00Z');
/** The 2026-10-21 GEOFON outage (timeouts from 12:50Z) as the gateway published it at `iso`. */
function geofonAt(iso: string): Record<string, any> {
  const d = shifted(GFZ_BASE, T(iso));
  const n = countFor('gfz', (T(iso) - GFZ_START) / 1000);
  Object.assign(provider(d, 'gfz'), { failingSinceMs: GFZ_START, consecutiveFailures: n, consecutiveTimeouts: n });
  return d;
}

test('2026-10-21 GEOFON replay: P4 samples at 12:52-13:37, P3 by the 60-min line from 13:52; never coverage, never red', async () => {
  const runs: Array<[string, string]> = [
    ['2026-10-21T12:52:00Z', 'P4'],
    ['2026-10-21T13:07:00Z', 'P4'],
    ['2026-10-21T13:22:00Z', 'P4'],
    ['2026-10-21T13:37:00Z', 'P4'],
    ['2026-10-21T13:52:00Z', 'P3'],
    ['2026-10-21T15:22:00Z', 'P3'],
  ];
  for (const [iso, severity] of runs) {
    const doc = geofonAt(iso);
    const v = evaluateStatus(doc, { nowMs: T(iso) + 20_000, canary: usgsSummary() });
    assert.deepEqual(sev(v), [`alerts:provider:gfz ${severity}`], iso);
    const f = v.findings[0]!;
    assert.deepEqual([f.rule, f.class, f.board, f.check, f.sinceMs], ['alerts:provider:fast', 'external', 'alerts', null, GFZ_START], iso);
    assert.equal(plainExitCode(v.findings), 0, iso);
    const r = await run({ routes: { [STATUS_URL]: [jsonResponse(doc)] }, argv: ['--no-canary'], now: T(iso) + 20_000 });
    assert.equal(r.code, 0, iso);
    assert.doesNotMatch(r.out, /::error/, iso);
  }
  // The fixture itself is the 13:52 document: past the line, named with its reason.
  const at1352 = evaluateStatus(GFZ_BASE, { nowMs: T('2026-10-21T13:52:20Z') });
  assert.equal(
    must(at1352, 'alerts:provider:gfz').text,
    "provider gfz is failing: ok:false for 62 min (since 12:50:00 UTC), 20 consecutive failures, last HTTP 0, last error timeout (slower than the gateway's fetch timeout), 20 timeouts in a row (past the 60 min line for timeouts, network and HTTP errors): the other direct providers still deliver, so alerts still go out (a quake only gfz reports may come later)",
  );
  const p4 = evaluateStatus(geofonAt('2026-10-21T13:37:00Z'), { nowMs: T('2026-10-21T13:37:20Z') });
  assert.match(must(p4, 'alerts:provider:gfz').text, /ok:false for 47 min \(since 12:50:00 UTC\).*\(below the 60 min line for timeouts, network and HTTP errors\)/);
});

test('2026-10-16 short GFZ streaks (5 and 12 min) are P4 samples only', () => {
  for (const sec of [300, 720]) {
    const v = evaluateStatus(failingFor({ gfz: sec }), { nowMs: NOW, canary: usgsSummary() });
    assert.deepEqual(sev(v), ['alerts:provider:gfz P4'], String(sec));
    assert.equal(v.findings[0]!.sinceMs, GEN - sec * 1000);
  }
  // The 2026-10-09 blip (about 40 s, read as up to 110 s) too.
  assert.deepEqual(sev(evaluateStatus(failingFor({ gfz: 40 }), { nowMs: NOW })), ['alerts:provider:gfz P4']);
});

test('lastError invalid: GFZ at 16 min is P3 by the 15-min invalid line, at 14 min a P4; an unknown or missing error is transient', () => {
  const invalid = (sec: number) => failingFor({ gfz: [sec, { lastError: 'invalid', httpStatus: 200, consecutiveTimeouts: 0 }] });
  const p3 = must(evaluateStatus(invalid(16 * 60), { nowMs: NOW }), 'alerts:provider:gfz');
  assert.deepEqual([p3.severity, p3.rule], ['P3', 'alerts:provider:fast:invalid']);
  assert.match(p3.text, /last error invalid \(a body that does not parse or verify\) \(past the 15 min line for invalid bodies\)/);
  const p4 = must(evaluateStatus(invalid(14 * 60), { nowMs: NOW }), 'alerts:provider:gfz');
  assert.deepEqual([p4.severity, p4.rule], ['P4', 'alerts:provider:fast:invalid']);
  for (const lastError of ['tls', undefined, 42, 'http', 'network']) {
    const f = must(evaluateStatus(failingFor({ emsc: [16 * 60, { lastError }] }), { nowMs: NOW }), 'alerts:provider:emsc');
    assert.deepEqual([f.severity, f.rule], ['P4', 'alerts:provider:fast'], String(lastError));
  }
});

test('2026-10-04..06 USGS: 29 min a P4, 31 min P3; the round-14 count (387 failures, no start) is P3 too', () => {
  const at = (sec: number) => must(evaluateStatus(failingFor({ usgs: sec }), { nowMs: NOW }), 'alerts:provider:usgs');
  assert.deepEqual([at(29 * 60).severity, at(29 * 60).rule], ['P4', 'alerts:provider:usgs']);
  const p3 = at(31 * 60);
  assert.deepEqual([p3.severity, p3.rule, p3.class, p3.sinceMs], ['P3', 'alerts:provider:usgs', 'external', GEN - 31 * 60_000]);
  assert.match(p3.text, /\(past the 30 min line\): ComCat FDSN and its summary feed both fail; the other direct providers still deliver/);

  const fixture = statusFixture('usgs-down-2026-10-05');
  const ref = fixture.generatedAtMs as number;
  const v = evaluateStatus(fixture, { nowMs: ref + 30_000, canary: usgsSummary() });
  assert.deepEqual(sev(v), ['alerts:provider:usgs P3']);
  const f = v.findings[0]!;
  assert.equal(f.sinceMs, ref - streakSpanSec('usgs', 387) * 1000);
  assert.equal(
    f.text,
    "provider usgs is failing: ok:false for about 31.5 h (387 consecutive failures at 60 s polls; the gateway publishes no failingSinceMs for it), last HTTP 0, last error timeout (slower than the gateway's fetch timeout), 387 timeouts in a row (past the 30 min line): ComCat FDSN and its summary feed both fail; the other direct providers still deliver, so alerts still go out (a quake only usgs reports may come later)",
  );
  assert.equal(plainExitCode(v.findings), 0);
});

test('2026-10-04..06 USGS with EMSC failing too: coverage:two P2 at 181 s together (members usgs, emsc), a P4 at 179 s', () => {
  const both = (emscSec: number) => evaluateStatus(failingFor({ usgs: 31 * 60, emsc: emscSec }), { nowMs: NOW, canary: usgsSummary() });
  const v = both(181);
  const two = must(v, 'alerts:coverage:two');
  assert.deepEqual([two.severity, two.rule, two.class, two.check, two.members, two.sinceMs], ['P2', 'alerts:coverage:two', 'redundancy', 'gh-redundancy', ['usgs', 'emsc'], GEN - 181_000]);
  assert.equal(two.text, 'two of the three direct providers (usgs and emsc) have been failing together for 3 min (line 3 min): one direct source is left (gfz), with the feed backstop');
  // Two failing is below the all-three line: a P4 band sample of :all; each provider's own row points at the group.
  assert.deepEqual(sev(v), ['alerts:coverage:all P4', 'alerts:coverage:two P2', 'alerts:provider:usgs P3', 'alerts:provider:emsc P4']);
  assert.match(must(v, 'alerts:provider:emsc').text, /: 2 direct providers are failing: see alerts:coverage:two$/);
  assert.equal(plainExitCode(v.findings), 1);
  const below = both(179);
  assert.equal(must(below, 'alerts:coverage:two').severity, 'P4');
  assert.match(must(below, 'alerts:coverage:two').text, /are failing together for 2\.5 min: below the 3 min line$/);
  assert.equal(plainExitCode(below.findings), 0);
});

test('coverage: all three at 61 s -> :all P1 beside :two (P4 until 180 s, then P2); all three at 30 s both P4; one failing neither', () => {
  const v = evaluateStatus(failingFor({ usgs: 61, emsc: 95, gfz: 80 }), { nowMs: NOW });
  const all = must(v, 'alerts:coverage:all');
  assert.deepEqual([all.severity, all.class, all.check, all.members, all.sinceMs], ['P1', 'symptom', 'gh-detect', ['usgs', 'emsc', 'gfz'], GEN - 61_000]);
  assert.equal(all.text, "all three direct providers (usgs, emsc, gfz) have been failing together for 61 s (line 60 s): the gateway sees new quakes only through the feed backstop, minutes late; three agencies failing at once points at the gateway's side (its egress, DNS, the Workers runtime or a deploy)");
  // The two longest (emsc 95 s, gfz 80 s) have failed together for 80 s: below the pair's own 180 s line.
  const two = must(v, 'alerts:coverage:two');
  assert.deepEqual([two.severity, two.members, two.sinceMs], ['P4', ['usgs', 'emsc', 'gfz'], GEN - 80_000]);
  assert.equal(plainExitCode(v.findings), 1);
  // All three for 3 min: the accepted double alarm, :all P1 and :two P2.
  const long = evaluateStatus(failingFor({ usgs: 181, emsc: 200, gfz: 190 }), { nowMs: NOW });
  assert.deepEqual([must(long, 'alerts:coverage:all').severity, must(long, 'alerts:coverage:two').severity], ['P1', 'P2']);
  assert.match(must(long, 'alerts:coverage:two').text, /\(emsc and gfz\) have been failing together for 3 min \(line 3 min\): one direct source is left \(usgs, failing too for 3 min\)/);
  const short = evaluateStatus(failingFor({ usgs: 30, emsc: 30, gfz: 30 }), { nowMs: NOW });
  assert.deepEqual([must(short, 'alerts:coverage:all').severity, must(short, 'alerts:coverage:two').severity], ['P4', 'P4']);
  assert.match(must(short, 'alerts:coverage:all').text, /^3 of the 3 direct providers are failing \(usgs, emsc, gfz\), together for 30 s: below the all-three line \(all three for 60 s\)$/);
  const one = evaluateStatus(failingFor({ emsc: 3_600 }), { nowMs: NOW });
  assert.equal(find(one, 'alerts:coverage:all'), undefined);
  assert.equal(find(one, 'alerts:coverage:two'), undefined);
});

test('coverage: whichever two; the backstop and the summary fallback are no direct providers; a streakless one is left out', () => {
  for (const [a, b, c] of [['usgs', 'emsc', 'gfz'], ['usgs', 'gfz', 'emsc'], ['emsc', 'gfz', 'usgs']] as const) {
    const two = must(evaluateStatus(failingFor({ [a]: 200, [b]: 190 }), { nowMs: NOW }), 'alerts:coverage:two');
    assert.equal(two.severity, 'P2', `${a}+${b}`);
    assert.match(two.text, new RegExp(`one direct source is left \\(${c}\\), with the feed backstop$`));
  }
  // The feed is the backstop, not a direct provider.
  const feed = evaluateStatus(failingFor({ feed: 3_600, emsc: 3_600 }), { nowMs: NOW });
  assert.deepEqual(sev(feed), ['alerts:provider:feed P3', 'alerts:provider:emsc P3']);
  assert.equal(must(feed, 'alerts:provider:feed').rule, 'alerts:provider:feed');
  assert.match(must(feed, 'alerts:provider:feed').text, /the backstop behind the direct providers is failing/);
  // USGS ok on its summary fallback is not failing.
  const fb = failingFor({ emsc: 3_600 });
  Object.assign(provider(fb, 'usgs'), { fallback: 'summary', primaryConsecutiveFailures: 17, primaryLastError: 'timeout', primaryFailingSinceMs: GEN - 1_320_000 });
  assert.deepEqual(sev(evaluateStatus(fb, { nowMs: NOW })), ['alerts:provider:emsc P3', 'alerts:usgs:primary P4']);
  // A direct provider ok:false with neither a start nor a count stays out of coverage, but is a P4 sample of its own.
  const unknown = failingFor({ emsc: 300, gfz: 300 });
  Object.assign(provider(unknown, 'usgs'), { ok: false, consecutiveFailures: undefined });
  const u = evaluateStatus(unknown, { nowMs: NOW });
  assert.deepEqual(must(u, 'alerts:coverage:two').members, ['emsc', 'gfz']);
  const bare = must(u, 'alerts:provider:usgs');
  assert.deepEqual([bare.severity, bare.sinceMs], ['P4', null]);
  assert.match(bare.text, /^provider usgs is ok:false with no failure streak published/);
});

test('coverage: the texts say when the feed backstop fails too, or is not listed', () => {
  const all = evaluateStatus(failingFor({ usgs: 65, emsc: 95, gfz: 80, feed: 65 }), { nowMs: NOW });
  assert.match(must(all, 'alerts:coverage:all').text, /: the feed backstop is failing too for 65 s, so the gateway sees no new quakes at all; every source failing at once points at the gateway's side/);
  const pair = evaluateStatus(failingFor({ emsc: 200, gfz: 190, feed: 30 }), { nowMs: NOW });
  assert.match(must(pair, 'alerts:coverage:two').text, /one direct source is left \(usgs\); the feed backstop is failing too for 30 s$/);
  const none = failingFor({ usgs: 65, emsc: 95, gfz: 80 });
  none.detector.providers = none.detector.providers.filter((p: { id: string }) => p.id !== BACKSTOP_PROVIDER);
  assert.match(must(evaluateStatus(none, { nowMs: NOW }), 'alerts:coverage:all').text, /the gateway sees no new quakes from a direct source \(status\.json lists no feed backstop\)/);
});

test('an older gateway (counts only): a P1/P2 is never earlier than round 24 judged red', () => {
  const pair = evaluateStatus(failingFor({ emsc: [null, { consecutiveFailures: 6 }], gfz: [null, { consecutiveFailures: 6 }] }), { nowMs: NOW });
  assert.equal(must(pair, 'alerts:coverage:two').text, 'two of the three direct providers (emsc and gfz) have been failing together for 3.5 min (line 3 min) (emsc and gfz judged by their failure counts: no failingSinceMs): one direct source is left (usgs), with the feed backstop');
  const round24Red = (n: Record<string, number>): boolean => {
    const down = (id: string) => (n[id] ?? 0) >= 3;
    const together = DIRECT_PROVIDERS.filter(down).length >= 2;
    return Object.entries(n).some(([id, c]) => c >= (isFastProvider(id) ? (together && down(id) ? 3 : 6) : 3));
  };
  for (let u = 0; u <= 7; u++) for (let e = 0; e <= 7; e++) for (let g = 0; g <= 7; g++) {
    const spec: Record<string, [null, Record<string, unknown>]> = {};
    if (u) spec['usgs'] = [null, { consecutiveFailures: u }];
    if (e) spec['emsc'] = [null, { consecutiveFailures: e }];
    if (g) spec['gfz'] = [null, { consecutiveFailures: g }];
    const red = plainExitCode(evaluateStatus(failingFor(spec), { nowMs: NOW }).findings) === 1;
    if (red) assert.ok(round24Red({ usgs: u, emsc: e, gfz: g }), `usgs ${u} emsc ${e} gfz ${g}`);
  }
});

test('the provider keys: unknown ids are notes; a provider listed twice is judged once; damaged starts fall back to the count', () => {
  const doc = structuredClone(HEALTHY);
  doc.detector.providers.push({ id: 'newsource', ok: false, consecutiveFailures: 40, failingSinceMs: GEN - DAY });
  doc.detector.providers.push({ id: 'gfz', ok: false, consecutiveFailures: 99, failingSinceMs: GEN - DAY });
  doc.detector.providers.push({ ok: false });
  const v = evaluateStatus(doc, { nowMs: NOW });
  assert.deepEqual(v.findings, []);
  assert.deepEqual(v.notes.slice(0, 3), ['provider gfz is listed twice: the first entry is judged', 'a detector.providers entry has no id: skipped', 'provider newsource is ok:false: no rule judges this id']);
  for (const bad of ['1790365235218', -1, 0, null, Number.NaN, GEN + 3_600_000]) {
    const d = failingFor({ usgs: [null, { consecutiveFailures: 32, failingSinceMs: bad }] });
    const f = must(evaluateStatus(d, { nowMs: NOW }), 'alerts:provider:usgs');
    assert.deepEqual([f.severity, f.sinceMs], ['P3', GEN - streakSpanSec('usgs', 32) * 1000], String(bad));
  }
  const empty = structuredClone(HEALTHY);
  empty.detector.providers = [];
  const e = evaluateStatus(empty, { nowMs: NOW });
  assert.deepEqual(e.findings, []);
  assert.match(e.notes.join(' | '), /detector\.providers is empty: no alert source is being polled \| direct provider usgs is not listed/);
});

// --- USGS's sub-queries: the primary live query and the deletions query ---

/** What a 2026-10-13 gateway publishes while ComCat's FDSN live query fails and the summary feed delivers. */
function onSummary(sec: number | null, extra: Record<string, unknown> = {}): Record<string, any> {
  const doc = structuredClone(HEALTHY);
  Object.assign(provider(doc, 'usgs'), { ok: true, consecutiveFailures: 0, fallback: 'summary', primaryConsecutiveFailures: 18, primaryLastError: 'timeout', ...extra });
  if (sec !== null) provider(doc, 'usgs').primaryFailingSinceMs = GEN - sec * 1000;
  return doc;
}

test('primary: 5.9 h on the summary fallback a P4, 6.1 h P3; without a start the count estimates it', () => {
  const p4 = must(evaluateStatus(onSummary(5.9 * 3_600), { nowMs: NOW }), 'alerts:usgs:primary');
  assert.deepEqual([p4.severity, p4.rule, p4.class, p4.sinceMs], ['P4', 'alerts:usgs:primary', 'external', GEN - 5.9 * HOUR]);
  const p3 = must(evaluateStatus(onSummary(6.1 * 3_600), { nowMs: NOW }), 'alerts:usgs:primary');
  assert.equal(p3.severity, 'P3');
  assert.equal(p3.text, "USGS's primary live query (ComCat FDSN) has failed 18 times in a row over 6.1 h, last error timeout (slower than the gateway's fetch timeout) (line 6.0 h): its live events come from the summary feed (fallback: summary), up to about two minutes later");
  // 18 failures span 49 min at the gateway's backoff: a P4 by the count; 90 failures span 6.8 h.
  const byCount = must(evaluateStatus(onSummary(null), { nowMs: NOW }), 'alerts:usgs:primary');
  assert.deepEqual([byCount.severity, byCount.sinceMs], ['P4', GEN - streakSpanSec('usgs', 18) * 1000]);
  assert.match(byCount.text, /failed 18 times in a row \(about 49 min by its failure count\)/);
  assert.equal(must(evaluateStatus(onSummary(null, { primaryConsecutiveFailures: 90 }), { nowMs: NOW }), 'alerts:usgs:primary').severity, 'P3');
});

test('primary: no finding while USGS itself fails, without the summary fallback (a note), or with malformed values', () => {
  const down = onSummary(7 * 3_600, { ok: false, consecutiveFailures: 6, failingSinceMs: GEN - 300_000 });
  delete provider(down, 'usgs').fallback;
  assert.deepEqual(sev(evaluateStatus(down, { nowMs: NOW })), ['alerts:provider:usgs P4']);
  const noFallback = onSummary(7 * 3_600);
  delete provider(noFallback, 'usgs').fallback;
  const nf = evaluateStatus(noFallback, { nowMs: NOW });
  assert.deepEqual(nf.findings, []);
  assert.match(nf.notes[0]!, /^USGS's primary live query has failed 18 times in a row over 7\.0 h, last error timeout .*with no summary fallback published$/);
  for (const bad of [0, -1, null, '7', Number.NaN, { n: 1 }]) {
    assert.deepEqual(evaluateStatus(onSummary(null, { primaryConsecutiveFailures: bad }), { nowMs: NOW }).findings, [], String(bad));
  }
  assert.equal(primaryFailure(HEALTHY.detector.providers[0]), null);
  assert.equal(primaryFailure(null), null);
  assert.deepEqual(primaryFailure({ primaryConsecutiveFailures: 3, primaryLastError: { x: 1 } }), { failures: 3, why: '', fallback: false, lasted: '' });
  assert.equal(primaryFailure({ primaryConsecutiveFailures: 3, primaryFailingSinceMs: GEN - 90_000 }, GEN)!.lasted, ' over 90 s');
  assert.equal(primaryFailure({ primaryConsecutiveFailures: 3, primaryFailingSinceMs: GEN - 90_000 })!.lasted, ''); // no reference time
});

/** What a round-16+ gateway publishes while USGS's `includedeleted=only` query fails: the provider stays ok, the
 *  deletions fields appear, and the watermark (the deletions cursor) stops moving. */
function deletionsFailing(sec: number | null, extra: Record<string, unknown> = {}, watermarkAgoMs = 2 * HOUR): Record<string, any> {
  const doc = structuredClone(HEALTHY);
  Object.assign(provider(doc, 'usgs'), { ok: true, consecutiveFailures: 0, watermarkMs: GEN - watermarkAgoMs, deletionsConsecutiveFailures: 300, deletionsLastError: 'timeout', ...extra });
  if (sec !== null) provider(doc, 'usgs').deletionsFailingSinceMs = GEN - sec * 1000;
  return doc;
}

test('deletions: 23 h a P4, 25 h P3, with the cursor and the 7-day window in the text', () => {
  const p4 = must(evaluateStatus(deletionsFailing(23 * 3_600), { nowMs: NOW }), 'alerts:usgs:deletions');
  assert.deepEqual([p4.severity, p4.rule, p4.sinceMs], ['P4', 'alerts:usgs:deletions', GEN - 23 * HOUR]);
  const p3 = must(evaluateStatus(deletionsFailing(25 * 3_600, {}, 25 * HOUR), { nowMs: NOW }), 'alerts:usgs:deletions');
  assert.equal(p3.severity, 'P3');
  assert.equal(p3.text, "USGS's deletions query has failed 300 times in a row over 25.0 h, last error timeout (slower than the gateway's fetch timeout) (line 24.0 h): deleted events are not being withdrawn; its cursor (watermarkMs) is 25.0 h old (the next successful query asks from there, at most 7 days back)");
  assert.equal(DELETIONS_MAX_WINDOW_MS, 7 * DAY);
  const past = must(evaluateStatus(deletionsFailing(7.25 * 86_400, {}, 7.25 * DAY), { nowMs: NOW }), 'alerts:usgs:deletions');
  assert.match(past.text, /cursor \(watermarkMs\) is 7\.3 days old, past the gateway's 7-day deletions window: a deletion from the start of the gap is no longer asked for, and that event stays live$/);
  // No start: the count at the gateway's backoff (300 failures span about 24 h).
  const byCount = must(evaluateStatus(deletionsFailing(null), { nowMs: NOW }), 'alerts:usgs:deletions');
  assert.equal(byCount.sinceMs, GEN - streakSpanSec('usgs', 300) * 1000);
  assert.equal(byCount.severity, streakSpanSec('usgs', 300) * 1000 >= 24 * HOUR ? 'P3' : 'P4');
  assert.match(byCount.text, /failed 300 times in a row \(about 24\.\d h by its failure count\)/);
  // Judged whatever `ok` says: a USGS that is also down has both rows.
  const down = deletionsFailing(25 * 3_600, { ok: false, consecutiveFailures: 12, failingSinceMs: GEN - 40 * 60_000 });
  assert.deepEqual(sev(evaluateStatus(down, { nowMs: NOW })), ['alerts:provider:usgs P3', 'alerts:usgs:deletions P3']);
});

test('deletions: missing, malformed or unknown values never break the check', () => {
  for (const bad of [0, -2, null, '12', Number.NaN, Number.POSITIVE_INFINITY, { n: 5 }, true]) {
    const v = evaluateStatus(deletionsFailing(25 * 3_600, { deletionsConsecutiveFailures: bad }, 1 * HOUR), { nowMs: NOW });
    assert.deepEqual(v.findings, [], String(bad));
    assert.doesNotMatch(v.summary, /deletions/, String(bad));
  }
  assert.equal(deletionsFailure(null), null);
  assert.equal(deletionsFailure('usgs'), null);
  assert.equal(deletionsFailure(HEALTHY.detector.providers[0]), null);
  assert.deepEqual(deletionsFailure({ deletionsConsecutiveFailures: 4, deletionsLastError: 'tls' }), { failures: 4, why: ', last error tls', lasted: '' });
  assert.deepEqual(deletionsFailure({ deletionsConsecutiveFailures: 4, deletionsLastError: 'y'.repeat(80) }), { failures: 4, why: `, last error ${'y'.repeat(32)}`, lasted: '' });
  assert.deepEqual(deletionsFailure({ deletionsConsecutiveFailures: 4, deletionsLastError: { code: 1 } }), { failures: 4, why: '', lasted: '' });
  for (const bad of [-1, 0, '1', null, GEN + 3_600_000]) {
    assert.equal(deletionsFailure({ deletionsConsecutiveFailures: 9, deletionsFailingSinceMs: bad }, GEN)!.lasted, '', String(bad));
  }
  const noCursor = deletionsFailing(25 * 3_600);
  delete provider(noCursor, 'usgs').watermarkMs;
  assert.match(must(evaluateStatus(noCursor, { nowMs: NOW }), 'alerts:usgs:deletions').text, /: deleted events are not being withdrawn$/);
});

// --- shadow rules (logged as "would notify" only) ---

test('shadow: provider-silent fires on an old watermark of an ok provider; never for usgs while its deletions query fails', () => {
  const doc = structuredClone(HEALTHY);
  provider(doc, 'gfz').watermarkMs = GEN - 13 * HOUR;
  const f = must(evaluateStatus(doc, { nowMs: NOW }), 'alerts:provider-silent:gfz');
  assert.deepEqual([f.severity, f.rule, f.shadow, f.check, f.sinceMs], ['P3', 'alerts:provider-silent', true, null, GEN - 13 * HOUR + 12 * HOUR]);
  assert.equal(f.text, 'provider gfz is ok but its watermark (the newest M4+ origin it delivered) is 13.0 h old (line 12.0 h): it may be answering without delivering events');
  assert.equal(plainExitCode([f]), 0);
  // 11.9 h: below gfz's line. usgs and emsc have 3 h lines.
  provider(doc, 'gfz').watermarkMs = GEN - 11.9 * HOUR;
  provider(doc, 'emsc').watermarkMs = GEN - 3.1 * HOUR;
  assert.deepEqual(sev(evaluateStatus(doc, { nowMs: NOW })), ['alerts:provider-silent:emsc P3']);
  // A failing deletions query holds the USGS watermark still: no silent finding for it.
  const held = deletionsFailing(4 * 3_600, {}, 4 * HOUR);
  assert.deepEqual(sev(evaluateStatus(held, { nowMs: NOW })), ['alerts:usgs:deletions P4']);
  const plain = structuredClone(HEALTHY);
  provider(plain, 'usgs').watermarkMs = GEN - 4 * HOUR;
  assert.deepEqual(sev(evaluateStatus(plain, { nowMs: NOW })), ['alerts:provider-silent:usgs P3']);
  // Never for a failing provider, the feed backstop, or a missing watermark.
  const failing = failingFor({ gfz: 300 });
  provider(failing, 'gfz').watermarkMs = GEN - 20 * HOUR;
  provider(failing, 'feed').watermarkMs = GEN - 20 * HOUR;
  delete provider(failing, 'emsc').watermarkMs;
  assert.deepEqual(sev(evaluateStatus(failing, { nowMs: NOW })), ['alerts:provider:gfz P4']);
});

test('shadow: latency over 3,000 ms on an ok provider is a P4 sample; a failing provider at 4,000 ms is none', () => {
  const doc = structuredClone(HEALTHY);
  provider(doc, 'emsc').latencyMs = 3_001;
  provider(doc, 'feed').latencyMs = 3_000;
  const f = must(evaluateStatus(doc, { nowMs: NOW }), 'alerts:latency:emsc');
  assert.deepEqual([f.severity, f.rule, f.shadow, f.sinceMs, f.text], ['P4', 'alerts:latency', true, null, 'provider emsc answered in 3001 ms (line 3000 ms)']);
  assert.equal(evaluateStatus(doc, { nowMs: NOW }).findings.length, 1);
  assert.deepEqual(sev(evaluateStatus(failingFor({ gfz: [300, { latencyMs: 4_000 }] }), { nowMs: NOW })), ['alerts:provider:gfz P4']);
  // An id unusable in a key (the document is public input) is a note, never a crash.
  const odd = structuredClone(HEALTHY);
  odd.detector.providers.push({ id: 'Weird Id`', ok: true, latencyMs: 9_000 });
  const v = evaluateStatus(odd, { nowMs: NOW });
  assert.deepEqual(v.findings, []);
  assert.ok(v.notes.some((n) => /answered in 9000 ms: its id is not usable in a key/.test(n)));
});

test('shadow: the canary fires when USGS lists a 10-60 min old event newer than the newest detection', () => {
  const stalled = structuredClone(HEALTHY);
  stalled.lastEvent.atMs = NOW - 45 * MIN;
  const canary = usgsSummary({ id: 'us7000abcd', time: NOW - 20 * MIN, mag: 4.7 }, { id: 'us7000late', time: NOW - 2 * MIN });
  const f = canaryFinding(stalled, canary, NOW)!;
  assert.deepEqual([f.key, f.severity, f.shadow, f.sinceMs], ['alerts:canary', 'P4', true, NOW - 20 * MIN]);
  assert.equal(f.text, "USGS lists us7000abcd (M4.7, origin 20 min ago, 2026-09-25 19:27Z) but the gateway's newest detection (lastEvent.atMs) is 45 min old (2026-09-25 19:02Z): the detector may be ticking without detecting");
  const v = evaluateStatus(stalled, { nowMs: NOW, canary });
  assert.deepEqual(sev(v), ['alerts:canary P4']);
  assert.deepEqual(v.unjudged, []);
  assert.equal(plainExitCode(v.findings), 0);
  // The oldest event inside the window is the one judged.
  assert.equal(canaryFinding(stalled, usgsSummary({ id: 'a', time: NOW - 15 * MIN }, { id: 'b', time: NOW - 40 * MIN }), NOW)!.sinceMs, NOW - 40 * MIN);
  // A newer detection, an event 5 or 61 min old, no lastEvent at all.
  assert.equal(canaryFinding(HEALTHY, canary, NOW), null);
  assert.equal(canaryFinding(stalled, usgsSummary({ id: 'x', time: NOW - 5 * MIN }), NOW), null);
  assert.equal(canaryFinding(stalled, usgsSummary({ id: 'x', time: NOW - 61 * MIN }), NOW), null);
  const none = structuredClone(HEALTHY);
  delete none.lastEvent;
  assert.match(canaryFinding(none, canary, NOW)!.text, /newest detection \(lastEvent\.atMs\) is missing/);
  // canary null or garbage: a note, and the key is not judged.
  const unread = evaluateStatus(stalled, { nowMs: NOW, canary: null });
  assert.deepEqual([unread.findings, unread.unjudged], [[], ['alerts:canary']]);
  assert.match(unread.notes.join(' | '), /canary: no USGS 4\.5_hour summary this run/);
  const garbage = evaluateStatus(stalled, { nowMs: NOW, canary: { type: 'nope' } });
  assert.deepEqual(garbage.unjudged, ['alerts:canary']);
  assert.match(garbage.notes.join(' | '), /has no features list/);
  // Never against a stale document.
  assert.deepEqual(sev(evaluateStatus(stalled, { nowMs: GEN + 400_000, canary: usgsSummary({ id: 'x', time: GEN + 380_000 - 20 * MIN }) })), ['alerts:status:stale P1']);
});

// --- the free-tier budget, projected to the end of the UTC day ---

test('budget at 12:00Z: doRowsWritten 40,000 P2, 33,000 a P4, 32,000 none; none at 01:59Z or on another day', () => {
  const busy = statusFixture('budget-projected');
  const ref = busy.generatedAtMs as number;
  assert.equal(ref, T('2026-10-21T12:00:00Z'));
  const v = evaluateStatus(busy, { nowMs: ref + 20_000, canary: usgsSummary() });
  assert.deepEqual(sev(v), ['alerts:budget P2']);
  const f = v.findings[0]!;
  assert.deepEqual([f.rule, f.class, f.check, f.members, f.sinceMs], ['alerts:budget', 'capacity', 'gh-capacity', ['doRowsWritten'], null]);
  assert.equal(f.text, "the gateway's tightest daily free-tier budget, doRowsWritten, is at 40.0 % of its cap by 12:00 UTC, projected 80.0 % by the end of the UTC day (line 75.0 %; the gateway's own estimate, not Cloudflare billing)");
  assert.match(v.summary, /budget=doRowsWritten:80%\/day/);
  assert.equal(plainExitCode(v.findings), 1);
  const withRows = (n: number, at = ref) => {
    const d = shifted(busy, at);
    d.budget.doRowsWritten = n;
    return budgetFinding(d, at);
  };
  assert.equal(withRows(33_000)!.severity, 'P4');
  assert.equal(withRows(32_000), null);
  assert.equal(withRows(40_000, T('2026-10-21T01:59:00Z')), null);
  assert.equal(withRows(9_000, T('2026-10-21T02:00:00Z'))!.severity, 'P2'); // 9 % by 02:00 projects to 108 %
  const yesterday = structuredClone(busy);
  yesterday.budget.day = '2026-10-20';
  assert.equal(budgetFinding(yesterday, ref), null);
  assert.match(evaluateStatus(yesterday, { nowMs: ref }).summary, /budget=2026-10-20:not-projected/);
  // Every counter of the rule's caps is judged; the members are the ones past 0.65, tightest first; junk is skipped.
  const several = structuredClone(busy);
  Object.assign(several.budget, { doRowsRead: 3_500_000, doGbSec: 'lots', doRequests: -5 });
  const s = budgetFinding(several, ref)!;
  assert.deepEqual([s.severity, s.members], ['P2', ['doRowsRead', 'doRowsWritten']]);
  assert.match(s.text, /doRowsRead, is at 70\.0 % of its cap by 12:00 UTC, projected 140\.0 %.*; also past 65\.0 %: doRowsWritten 80\.0 %$/);
});

test('budget: the headroom rule and the feed/config ages are gone; the low-headroom fixture is judged by its projection', () => {
  const tenPct = structuredClone(HEALTHY);
  tenPct.budget.headroomPct = 10;
  assert.deepEqual(evaluateStatus(tenPct, { nowMs: NOW }).findings, []);
  const ages = structuredClone(HEALTHY);
  Object.assign(ages, { feed_manifest_generated_ms: NOW - 3 * HOUR, feed_manifest_age_s: 10_800, config_bundle_generated_ms: NOW - 20 * DAY, config_bundle_age_s: 20 * 86_400, config_policy_age_s: null });
  assert.deepEqual(evaluateStatus(ages, { nowMs: NOW }).findings, []);
  // 88,000 rows written by 19:47Z project to 107 % of the cap: the budget rule, not the headroom.
  const low = evaluateStatus(statusFixture('low-headroom'), { nowMs: NOW });
  assert.deepEqual(sev(low), ['alerts:budget P2']);
  assert.match(low.findings[0]!.text, /doRowsWritten, is at 88\.0 % of its cap by 19:47 UTC, projected 106\.7 %/);
  // No budget block at all: the key is not judged.
  const absent = structuredClone(HEALTHY);
  delete absent.budget;
  const a = evaluateStatus(absent, { nowMs: NOW, canary: usgsSummary() });
  assert.deepEqual([a.findings, a.unjudged], [[], ['alerts:budget']]);
  assert.match(a.summary, /budget=n\/a/);
});

// --- policy, degradation ladder, APNs ---

test('degraded: unforced P1, forced P3; policy fallback P1; absent blocks are notes and unjudged', () => {
  const d = must(evaluateStatus(statusFixture('degraded'), { nowMs: NOW }), 'alerts:degraded');
  assert.deepEqual([d.severity, d.class, d.check, d.text], ['P1', 'symptom', 'gh-deliver', 'the gateway is DEGRADED (level tier2-off, reason: budget_exhausted): some alert tiers are not being sent']);
  const forced = statusFixture('degraded');
  forced.degraded.forced = true;
  const fp = must(evaluateStatus(forced, { nowMs: NOW }), 'alerts:degraded');
  assert.deepEqual([fp.severity, fp.check], ['P3', null]);
  assert.match(fp.text, /^a forced override of the degradation ladder is on \(level tier2-off\)/);
  assert.equal(plainExitCode([fp]), 0);
  const p = must(evaluateStatus(statusFixture('policy-fallback'), { nowMs: NOW }), 'alerts:policy');
  assert.deepEqual([p.severity, p.check, p.text], ['P1', 'gh-deliver', 'the gateway runs the compiled FALLBACK alerts policy (v1, reason: expired): the signed policy is not live']);
  const sourceOnly = structuredClone(HEALTHY);
  sourceOnly.policy = { source: 'fallback', version: 1 };
  assert.deepEqual(sev(evaluateStatus(sourceOnly, { nowMs: NOW })), ['alerts:policy P1']);
  const partial = structuredClone(HEALTHY);
  delete partial.apns;
  partial.policy = null;
  delete partial.degraded;
  const v = evaluateStatus(partial, { nowMs: NOW, canary: usgsSummary() });
  assert.deepEqual(v.findings, []);
  assert.deepEqual(v.unjudged, ['alerts:policy', 'alerts:degraded', 'alerts:apns']);
  assert.equal(v.notes.length, 3);
});

test('APNs: dry, key problems and split without production are P1 with members; today\'s skipped/dropped pushes P3', () => {
  const dry = must(evaluateStatus(statusFixture('apns-dry'), { nowMs: NOW }), 'alerts:apns');
  assert.deepEqual([dry.severity, dry.check, dry.members], ['P1', 'gh-deliver', ['dry']]);
  assert.equal(dry.text, 'APNs is NOT configured on the gateway: fan-outs run DRY and no push reaches a device');
  const keys = must(evaluateStatus(statusFixture('apns-key-problems'), { nowMs: NOW }), 'alerts:apns');
  assert.deepEqual([keys.severity, keys.members], ['P1', ['key-problems', 'skipped_no_key']]);
  assert.match(keys.text, /^the APNs key configuration has 1 problem\(s\): APNS_KEY_ID_SANDBOX set without APNS_P8_SANDBOX; .*\. 2 device push\(es\) skipped today \(UTC 2026-09-25\)/);
  const split = evaluateStatus(statusFixture('apns-split-no-production'), { nowMs: NOW });
  assert.deepEqual([must(split, 'alerts:apns').severity, must(split, 'alerts:apns').members], ['P1', ['no-production', 'skipped_no_key']]);
  assert.match(split.summary, /apns=configured\/split\/production=NO/);
  for (const production of [false, undefined, null, 'true', 1]) {
    const doc = statusFixture('healthy-r3');
    doc.apns = { configured: true, mode: 'split', production, sandbox: true, problems: [] };
    if (production === undefined) delete doc.apns.production;
    assert.deepEqual(must(evaluateStatus(doc, { nowMs: NOW }), 'alerts:apns').members, ['no-production'], String(production));
  }
  const ok = statusFixture('healthy-r3');
  ok.apns = { configured: true, mode: 'split', production: true, sandbox: true, problems: [] };
  assert.deepEqual(evaluateStatus(ok, { nowMs: NOW }).findings, []);
  // The reviewed outage: split, APNS_P8 gone, skipped_no_key 12.
  const reviewed = structuredClone(HEALTHY);
  reviewed.apns = { configured: true, mode: 'split', production: false, sandbox: true, problems: ['APNS_KEY_ID set without APNS_P8'] };
  reviewed.fanout = { ...statusFixture('healthy-r3').fanout, skipped_no_key: 12 };
  assert.deepEqual(must(evaluateStatus(reviewed, { nowMs: NOW }), 'alerts:apns').members, ['key-problems', 'no-production', 'skipped_no_key']);
  // With production present: the counters are a P3.
  const counters = evaluateStatus(statusFixture('fanout-warnings'), { nowMs: NOW });
  const c = must(counters, 'alerts:apns');
  assert.deepEqual([c.severity, c.check, c.members], ['P3', null, ['skipped_no_key', 'retry_dropped_budget']]);
  assert.match(c.text, /^3 device push\(es\) skipped today \(UTC 2026-09-25\) because the gateway holds no APNs key.*\. 40 transient push failure\(s\) today \(UTC 2026-09-25\) were dropped without a retry/);
  assert.equal(plainExitCode(counters.findings), 0);
});

test('APNs: fields an older gateway does not publish are never a finding', () => {
  const legacy = evaluateStatus(HEALTHY, { nowMs: NOW, canary: usgsSummary() });
  assert.deepEqual([legacy.findings, legacy.unjudged], [[], []]);
  const nullFanout = statusFixture('healthy-r3');
  nullFanout.fanout = null;
  const vn = evaluateStatus(nullFanout, { nowMs: NOW });
  assert.deepEqual(vn.findings, []);
  assert.match(vn.summary, /fanout=none/);
  const odd = statusFixture('healthy-r3');
  odd.apns = { configured: true, mode: 'legacy', problems: 'not-an-array' };
  odd.fanout = { day: '2026-09-25' };
  const vo = evaluateStatus(odd, { nowMs: NOW });
  assert.deepEqual(vo.findings, []);
  assert.match(vo.summary, /fanout=jobs:\?,sent:\?,no_key:\?,dropped_budget:\?/);
  // apns.configured absent: a note, the key unjudged; a counter still judges it.
  const noConfigured = statusFixture('fanout-warnings');
  noConfigured.apns = {};
  const nc = evaluateStatus(noConfigured, { nowMs: NOW, canary: usgsSummary() });
  assert.deepEqual([sev(nc), nc.unjudged], [['alerts:apns P3'], []]);
  assert.match(nc.notes[0]!, /apns\.configured is absent/);
  // Each key fault on its own: a split mode without production is a P1 even without `configured`.
  const splitOnly = structuredClone(HEALTHY);
  splitOnly.apns = { mode: 'split', production: null };
  const so = evaluateStatus(splitOnly, { nowMs: NOW });
  assert.deepEqual(must(so, 'alerts:apns').members, ['no-production']);
  assert.match(so.summary, /apns=\?\/split\/production=NO/);
});

// --- the selftest ---

test('selftest: alerts:selftest P1 whatever the document says; plain exit 1', () => {
  const v = evaluateStatus(HEALTHY, { nowMs: NOW, canary: usgsSummary(), selftest: true });
  assert.deepEqual(sev(v), ['alerts:selftest P1']);
  const f = v.findings[0]!;
  assert.deepEqual([f.rule, f.check, f.shadow], ['alerts:selftest', 'selftest', false]);
  assert.match(f.text, /^forced by the selftest: this run must be red/);
  assert.equal(plainExitCode(v.findings), 1);
  assert.deepEqual(sev(evaluateStatus(statusFixture('stale'), { nowMs: NOW, selftest: true })), ['alerts:status:stale P1', 'alerts:selftest P1']);
  const unreadable = evaluateStatus('nope', { nowMs: NOW, selftest: true });
  assert.deepEqual(sev(unreadable), ['alerts:status:unreadable P2', 'alerts:selftest P1']);
  assert.equal(plainExitCode(unreadable.findings), 1);
});

// --- the usage half (fixtures only, the API is never called) ---

const usage = (workersRequests: number, d1RowsWritten = 0) => ({ ok: true as const, workersRequests, d1RowsWritten });

test('usage: 81 % P2 (gh-capacity), 96 % P1 (gh-deliver), 72 % a P4, 15 % at 03:00Z projects to 120 %: P2', () => {
  const noon = T('2026-10-21T12:00:00Z');
  const p2 = usageFindings(usage(81_000), noon);
  assert.equal(p2.findings.length, 1);
  const f = p2.findings[0]!;
  assert.deepEqual([f.key, f.rule, f.severity, f.board, f.class, f.check, f.members], ['platform:cf-usage', 'platform:cf-usage', 'P2', 'platform', 'capacity', 'gh-capacity', ['workersRequests']]);
  assert.equal(f.text, 'account Workers requests today: 81000 = 81.0 % of the Workers Free daily cap (100000/day), projected 162.0 % by 00:00 UTC; at 100 % every Worker on the account starts failing until 00:00 UTC (lines: P2 at 80.0 % or a projected 100.0 % from 02:00 UTC, P1 at 95.0 %)');
  const p1 = usageFindings(usage(10_000, 96_000), noon).findings[0]!;
  assert.deepEqual([p1.severity, p1.check, p1.members], ['P1', 'gh-deliver', ['d1RowsWritten']]);
  assert.match(p1.text, /^account D1 rows written today: 96000 = 96\.0 %/);
  const both = usageFindings(usage(81_000, 96_000), noon).findings[0]!;
  assert.deepEqual([both.severity, both.members], ['P1', ['d1RowsWritten', 'workersRequests']]);
  // 72 % at noon projects to 144 %: P2 by the projection; at 23:00Z it projects to 75 %: the P4 band.
  assert.equal(usageFindings(usage(72_000), noon).findings[0]!.severity, 'P2');
  const band = usageFindings(usage(72_000), T('2026-10-21T23:00:00Z')).findings[0]!;
  assert.deepEqual([band.severity, band.check], ['P4', null]);
  assert.deepEqual(usageFindings(usage(69_000), T('2026-10-21T23:00:00Z')).findings, []);
  // The projection from 02:00 UTC only: 15 % at 03:00Z is a P2, at 01:00Z nothing.
  assert.equal(usageFindings(usage(15_000), T('2026-10-21T03:00:00Z')).findings[0]!.severity, 'P2');
  assert.match(usageFindings(usage(15_000), T('2026-10-21T03:00:00Z')).findings[0]!.text, /projected 120\.0 % by 00:00 UTC/);
  const early = usageFindings(usage(15_000), T('2026-10-21T01:00:00Z'));
  assert.deepEqual([early.findings, early.unjudged], [[], []]);
  assert.match(early.summary, /^Workers requests 15000\/100000 \(15\.0 %, projected 360000\/day\) · D1 rows written 0\/100000/);
  // The caps come from the rule.
  assert.deepEqual({ ...(RULES['platform:cf-usage'].limits['caps'] as object) }, { workersRequests: 100_000, d1RowsWritten: 100_000 });
});

test('usage: a missing account id, a refused token and a transient error are watcher:cf-usage, the usage key unjudged', () => {
  const noon = T('2026-10-21T12:00:00Z');
  for (const [v, text] of [
    [usageMisconfigured(), /^CF_ANALYTICS_TOKEN is set but CF_ACCOUNT_ID is empty/],
    [usageFindings({ ok: false, kind: 'auth', message: 'not authorized for that account' }, noon), /^the account usage check was refused: not authorized for that account\. Fix or remove the CF_ANALYTICS_TOKEN secret$/],
    [usageFindings({ ok: false, kind: 'graphql', message: 'query timed out, please retry' }, noon), /^the account usage check is unavailable this run: query timed out/],
    [usageFindings({ ok: false, kind: 'shape', message: 'data.viewer.accounts is missing' }, noon), /unavailable this run: data\.viewer\.accounts is missing/],
  ] as const) {
    assert.deepEqual(v.findings.map((f) => [f.key, f.rule, f.severity, f.board, f.class]), [['watcher:cf-usage', 'watcher', 'P3', 'platform', 'watcher']]);
    assert.match(v.findings[0]!.text, text);
    assert.deepEqual(v.unjudged, ['platform:cf-usage']);
    assert.equal(plainExitCode(v.findings), 3);
  }
});

test('usage: parseUsageResponse sums every group into account totals and classifies errors', () => {
  assert.deepEqual(parseUsageResponse(cfFixture('usage-ok')), { ok: true, workersRequests: 16150, d1RowsWritten: 5944 });
  assert.deepEqual(parseUsageResponse(cfFixture('authz-error')), { ok: false, kind: 'auth', message: 'not authorized for that account' });
  const empty = parseUsageResponse(cfFixture('empty-accounts'));
  assert.equal(!empty.ok && empty.kind, 'auth');
  const transient = parseUsageResponse(cfFixture('transient-error'));
  assert.equal(!transient.ok && transient.kind, 'graphql');
  const noAccounts = parseUsageResponse({ data: { viewer: {} } });
  assert.equal(!noAccounts.ok && noAccounts.kind, 'shape');
  const badSum = parseUsageResponse({ data: { viewer: { accounts: [{ workers: [{ sum: {} }], d1: [] }] } } });
  assert.equal(!badSum.ok && badSum.kind, 'shape');
  const notObject = parseUsageResponse('nope');
  assert.equal(!notObject.ok && notObject.kind, 'shape');
});

test('usageWindow covers the current UTC day; buildUsageRequest asks for one account\'s totals', () => {
  const w = usageWindow(Date.UTC(2026, 8, 26, 6, 0, 0));
  assert.deepEqual(w, { date: '2026-09-26', datetimeStart: '2026-09-26T00:00:00.000Z', datetimeEnd: '2026-09-26T06:00:00.000Z', dayFraction: 0.25 });
  assert.equal(usageWindow(Date.UTC(2026, 8, 26, 0, 0, 5)).dayFraction, 1 / 1440);
  const req = buildUsageRequest('acct123', Date.UTC(2026, 8, 26, 12, 0, 0));
  assert.match(req.query, /workersInvocationsAdaptive\(/);
  assert.match(req.query, /d1AnalyticsAdaptiveGroups\(/);
  assert.match(req.query, /sum \{ requests \}/);
  assert.match(req.query, /sum \{ rowsWritten \}/);
  assert.deepEqual(req.variables, { accountTag: 'acct123', datetimeStart: '2026-09-26T00:00:00.000Z', datetimeEnd: '2026-09-26T12:00:00.000Z', date: '2026-09-26' });
});

// --- plainExitCode and the arguments ---

test('plainExitCode: 1 a non-shadow P1/P2 (unreadable aside), else 2 unreadable, else 3 a watcher, else 0', () => {
  const unreadable = unreadableFinding('x');
  const watcher = usageMisconfigured().findings[0]!;
  const p1 = must(evaluateStatus(statusFixture('degraded'), { nowMs: NOW }), 'alerts:degraded');
  const p3 = must(evaluateStatus(geofonAt('2026-10-21T15:22:00Z'), { nowMs: T('2026-10-21T15:22:00Z') }), 'alerts:provider:gfz');
  const shadow = { ...p1, shadow: true };
  assert.equal(plainExitCode([]), 0);
  assert.equal(plainExitCode([p3]), 0);
  assert.equal(plainExitCode([shadow]), 0);
  assert.equal(plainExitCode([watcher, p3]), 3);
  assert.equal(plainExitCode([unreadable, watcher]), 2);
  assert.equal(plainExitCode([unreadable, watcher, p1]), 1);
  assert.equal(plainExitCode(usageFindings(usage(81_000), T('2026-10-21T12:00:00Z')).findings), 1);
});

test('parseArgs: defaults, values, selftest via flag or env, the canary switches, and bad input', () => {
  assert.deepEqual(parseArgs([]), { url: STATUS_URL, statusFile: null, selftest: false, findingsPath: null, canaryUrl: CANARY_URL, canaryFile: null });
  assert.equal(CANARY_URL, 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_hour.geojson');
  const o = parseArgs(['--url', 'https://x/s.json', '--status-file', 's.json', '--findings', 'findings/alerts.json', '--canary-url', 'https://x/c.json', '--canary-file', 'c.json']);
  assert.deepEqual(o, { url: 'https://x/s.json', statusFile: 's.json', selftest: false, findingsPath: 'findings/alerts.json', canaryUrl: 'https://x/c.json', canaryFile: 'c.json' });
  const off = parseArgs(['--canary-file', 'c.json', '--no-canary', '--canary-url', 'https://x/c.json']);
  assert.deepEqual([off.canaryUrl, off.canaryFile], [null, null]);
  assert.equal(parseArgs(['--selftest']).selftest, true);
  assert.equal(parseArgs([], { WATCHDOG_SELFTEST: '1' }).selftest, true);
  assert.equal(parseArgs([], { WATCHDOG_SELFTEST: 'true' }).selftest, true);
  assert.equal(parseArgs([], { WATCHDOG_SELFTEST: '' }).selftest, false);
  assert.throws(() => parseArgs(['--url']), /--url needs a value/);
  assert.throws(() => parseArgs(['--findings', '--selftest']), /--findings needs a value/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['toString', '1']), /unknown argument/);
  // The numeric threshold flags are gone: every line comes from RULES.
  for (const flag of ['--max-age-sec', '--provider-down-sec', '--min-headroom-pct', '--usage-fail-pct', '--max-config-bundle-age-sec', '--deletions-failures']) {
    assert.throws(() => parseArgs([flag, '10']), /unknown argument/, flag);
  }
});

// --- main ---

interface RunOptions {
  routes?: Record<string, Array<Response | Error>>;
  env?: Record<string, string>;
  argv?: string[];
  now?: number;
  files?: Record<string, string>;
  writeFile?: (path: string, text: string) => void;
}
async function run(opts: RunOptions) {
  const lines: string[] = [];
  const written: Record<string, string> = {};
  const f = fakeFetch(opts.routes ?? {});
  const code = await main({
    argv: opts.argv ?? [],
    env: opts.env ?? {},
    fetchImpl: f.impl,
    now: () => opts.now ?? NOW,
    log: (l) => void lines.push(l),
    sleep: noSleep,
    readFile: (p) => {
      if (opts.files && Object.hasOwn(opts.files, p)) return opts.files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    writeFile: opts.writeFile ?? ((p, t) => void (written[p] = t)),
  });
  const doc = (p: string): FindingsDocument => {
    const parsed = parseFindingsDocument(JSON.parse(written[p]!));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    return parsed.doc;
  };
  return { code, lines, out: lines.join('\n'), calls: f.calls, written, doc };
}

const OUT = 'findings/alerts.json';
const TOKEN_ENV = { CF_ANALYTICS_TOKEN: 'test-token', CF_ACCOUNT_ID: 'acct123' };

test('main --findings: a valid document and exit 0 for a healthy, an unhealthy, an unreadable and a refused-token run', async () => {
  const healthy = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)], [CANARY_URL]: [jsonResponse(usgsSummary())] }, argv: ['--findings', OUT] });
  assert.equal(healthy.code, 0);
  const h = healthy.doc(OUT);
  assert.deepEqual([h.evaluator, h.generatedAtMs, h.findings, h.unjudged], ['alerts', NOW, [], []]);
  assert.ok(h.notes.includes('account usage: skipped (no CF_ANALYTICS_TOKEN)'));
  assert.match(healthy.out, /findings: wrote 0 findings to findings\/alerts\.json/);

  const unhealthy = await run({ routes: { [STATUS_URL]: [jsonResponse(statusFixture('degraded'))] }, argv: ['--findings', OUT, '--no-canary'] });
  assert.equal(unhealthy.code, 0);
  assert.deepEqual(unhealthy.doc(OUT).findings.map((f) => `${f.key} ${f.severity}`), ['alerts:degraded P1']);
  // No annotations for findings in this mode: reconcile prints those.
  assert.doesNotMatch(unhealthy.out, /::(error|warning|notice)/);
  assert.match(unhealthy.out, /^P1 alerts:degraded \(alerts:degraded\): the gateway is DEGRADED/m);

  const unreadable = await run({ routes: { [STATUS_URL]: [new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })] }, argv: ['--findings', OUT] });
  assert.equal(unreadable.code, 0);
  assert.equal(unreadable.calls.length, 3); // no canary for a document never read
  const u = unreadable.doc(OUT);
  assert.deepEqual([u.findings.map((f) => `${f.key} ${f.severity}`), u.unjudged], [['alerts:status:unreadable P2'], ['alerts:*']]);
  assert.equal(u.findings[0]!.text, 'status.json could not be read (network error): network error: fetch failed (ENOTFOUND) after 3 attempts. The alert pipeline state is UNKNOWN. This is a network or edge problem between GitHub and data.theshelter.app, not a confirmed pipeline failure. If it repeats on the next runs, check the alerts-gateway in the Cloudflare dashboard.');
  assert.doesNotMatch(unreadable.out, /::error/);

  const refused = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)], [GRAPHQL_URL]: [jsonResponse(cfFixture('authz-error'))] }, argv: ['--findings', OUT, '--no-canary'], env: TOKEN_ENV });
  assert.equal(refused.code, 0);
  const r = refused.doc(OUT);
  assert.deepEqual([r.findings.map((f) => `${f.key} ${f.severity}`), r.unjudged], [['watcher:cf-usage P3'], ['alerts:canary', 'platform:cf-usage']]);
});

test('main --findings: an HTTP 404 names the missing document; a stale document reads no canary', async () => {
  const gone = await run({ routes: { [STATUS_URL]: [jsonResponse('gone', 404)] }, argv: ['--findings', OUT] });
  assert.equal(gone.code, 0);
  assert.equal(gone.calls.length, 1);
  assert.match(gone.doc(OUT).findings[0]!.text, /^status\.json could not be read \(HTTP 404\): HTTP 404 after 1 attempt\. The alert pipeline state is UNKNOWN\. The document is missing or blocked/);
  const stale = await run({ routes: { [STATUS_URL]: [jsonResponse(statusFixture('stale'))] }, argv: ['--findings', OUT] });
  assert.deepEqual(stale.calls.map((c) => c.url), [STATUS_URL]);
  assert.deepEqual(stale.doc(OUT).findings.map((f) => f.key), ['alerts:status:stale']);
});

test('main: the canary is read once with no retry; a failed read is a note; a saved summary can be judged', async () => {
  const stalled = structuredClone(HEALTHY);
  stalled.lastEvent.atMs = NOW - 45 * MIN;
  const failed = await run({ routes: { [STATUS_URL]: [jsonResponse(stalled)], [CANARY_URL]: [jsonResponse('busy', 503)] }, argv: ['--findings', OUT] });
  assert.equal(failed.code, 0);
  assert.deepEqual(failed.calls.map((c) => c.url), [STATUS_URL, CANARY_URL]);
  const fd = failed.doc(OUT);
  assert.deepEqual([fd.findings, fd.unjudged], [[], ['alerts:canary']]);
  assert.ok(fd.notes.includes("canary: USGS's 4.5_hour summary could not be read (HTTP 503)"));
  const summary = usgsSummary({ id: 'us7000abcd', time: NOW - 20 * MIN });
  const live = await run({ routes: { [STATUS_URL]: [jsonResponse(stalled)], [CANARY_URL]: [jsonResponse(summary)] }, argv: ['--findings', OUT] });
  assert.deepEqual(live.doc(OUT).findings.map((f) => [f.key, f.severity, f.shadow]), [['alerts:canary', 'P4', true]]);
  assert.match(live.out, /^shadow \(would notify\) P4 alerts:canary \(alerts:canary\): USGS lists us7000abcd/m);
  const saved = await run({ argv: ['--status-file', 's.json', '--canary-file', 'c.json'], files: { 's.json': JSON.stringify(stalled), 'c.json': JSON.stringify(summary) } });
  assert.equal(saved.code, 0);
  assert.deepEqual(saved.calls, []);
  assert.match(saved.out, /^shadow \(would notify\): P4 alerts:canary: USGS lists us7000abcd/m);
  const off = await run({ argv: ['--status-file', 's.json', '--no-canary'], files: { 's.json': JSON.stringify(HEALTHY) } });
  assert.match(off.out, /note: canary: off \(--no-canary\)/);
});

test('main plain mode: exit 0 healthy, 1 a P1/P2, 2 unreadable, 3 misconfigured; annotations by severity', async () => {
  const healthy = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)] }, argv: ['--no-canary'] });
  assert.equal(healthy.code, 0);
  assert.doesNotMatch(healthy.out, /::error/);
  assert.match(healthy.out, /alert pipeline healthy/);
  assert.deepEqual(healthy.calls.map((c) => c.url), [STATUS_URL]);
  assert.deepEqual(healthy.written, {});

  for (const name of ['stale', 'policy-fallback', 'degraded', 'apns-dry', 'apns-split-no-production', 'apns-key-problems', 'low-headroom']) {
    const r = await run({ routes: { [STATUS_URL]: [jsonResponse(statusFixture(name))] }, argv: ['--no-canary'] });
    assert.equal(r.code, 1, name);
    assert.match(r.out, /^::error title=Alert pipeline unhealthy::alerts:/m, name);
  }
  const p3 = await run({ routes: { [STATUS_URL]: [jsonResponse(statusFixture('fanout-warnings'))] }, argv: ['--no-canary'] });
  assert.equal(p3.code, 0);
  assert.match(p3.out, /^::warning title=Alert pipeline::alerts:apns: 3 device push\(es\) skipped today/m);
  const p4 = await run({ routes: { [STATUS_URL]: [jsonResponse(statusFixture('provider-down'))] }, argv: ['--no-canary'] });
  assert.equal(p4.code, 0);
  assert.match(p4.out, /^P4 alerts:provider:usgs: provider usgs is failing/m);

  const unreadable = await run({ routes: { [STATUS_URL]: [jsonResponse('gone', 404)] } });
  assert.equal(unreadable.code, 2);
  assert.match(unreadable.out, /::error title=Alert watchdog could not read status.json::status.json could not be read \(HTTP 404\)/);
  assert.doesNotMatch(unreadable.out, /Alert pipeline unhealthy/);

  const refused = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)], [GRAPHQL_URL]: [jsonResponse(cfFixture('authz-error'))] }, argv: ['--no-canary'], env: TOKEN_ENV });
  assert.equal(refused.code, 3);
  assert.match(refused.out, /::error title=Alert watchdog misconfigured::the account usage check was refused/);
  const noAccount = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)] }, argv: ['--no-canary'], env: { CF_ANALYTICS_TOKEN: 'test-token' } });
  assert.equal(noAccount.code, 3);
  assert.deepEqual(noAccount.calls.map((c) => c.url), [STATUS_URL]);
  const transient = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)], [GRAPHQL_URL]: [jsonResponse('bad gateway', 502)] }, argv: ['--no-canary'], env: TOKEN_ENV });
  assert.equal(transient.code, 3);
  assert.match(transient.out, /unavailable this run: HTTP 502 after 3 attempt\(s\)/);

  // Precedence: an unhealthy pipeline outranks a refused token; unreadable outranks a refused token.
  const both = await run({ routes: { [STATUS_URL]: [jsonResponse(statusFixture('degraded'))], [GRAPHQL_URL]: [jsonResponse(cfFixture('authz-error'))] }, argv: ['--no-canary'], env: TOKEN_ENV });
  assert.equal(both.code, 1);
  const lost = await run({ routes: { [STATUS_URL]: [jsonResponse('gone', 404)], [GRAPHQL_URL]: [jsonResponse(cfFixture('authz-error'))] }, env: TOKEN_ENV });
  assert.equal(lost.code, 2);
});

test('main plain mode: the usage half fails at 80 % and sends the token only to the GraphQL API', async () => {
  const routes = () => ({ [STATUS_URL]: [jsonResponse(HEALTHY)], [CANARY_URL]: [jsonResponse(usgsSummary())] });
  const ok = await run({ routes: { ...routes(), [GRAPHQL_URL]: [jsonResponse(cfFixture('usage-ok'))] }, env: TOKEN_ENV });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /account usage today \(UTC\): Workers requests 16150\/100000/);
  assert.doesNotMatch(ok.out, /shelter-api-prod|00000000-0000/, 'no Worker or database names in the public run log');
  assert.deepEqual(ok.calls.map((c) => c.url).sort(), [CANARY_URL, GRAPHQL_URL, STATUS_URL].sort());
  for (const c of ok.calls) {
    assert.equal(new Headers(c.init?.headers).get('authorization'), c.url === GRAPHQL_URL ? 'Bearer test-token' : null, c.url);
  }
  const gql = ok.calls.find((c) => c.url === GRAPHQL_URL)!;
  assert.equal(gql.init?.method, 'POST');
  assert.equal(JSON.parse(String(gql.init?.body)).variables.accountTag, 'acct123');
  assert.doesNotMatch(ok.out, /test-token/);

  const over = await run({ routes: { ...routes(), [GRAPHQL_URL]: [jsonResponse(cfFixture('usage-over'))] }, env: TOKEN_ENV });
  assert.equal(over.code, 1);
  assert.match(over.out, /::error title=Cloudflare free-tier usage high::platform:cf-usage: account D1 rows written today: 85000 = 85\.0 %/);
});

test('main: the selftest turns a healthy document red in plain mode and is a finding in findings mode', async () => {
  const plain = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)] }, argv: ['--no-canary'], env: { WATCHDOG_SELFTEST: '1' } });
  assert.equal(plain.code, 1);
  assert.match(plain.out, /::notice title=Alert watchdog selftest::/);
  assert.match(plain.out, /::error title=\[selftest\] Alert pipeline unhealthy::alerts:selftest: forced by the selftest/);
  const doc = await run({ routes: { [STATUS_URL]: [jsonResponse(HEALTHY)] }, argv: ['--findings', OUT, '--no-canary', '--selftest'] });
  assert.equal(doc.code, 0);
  assert.deepEqual(doc.doc(OUT).findings.map((f) => `${f.key} ${f.severity}`), ['alerts:selftest P1']);
  assert.doesNotMatch(doc.out, /::/);
});

test('main: a bad argument is watcher:alerts-watchdog with --findings (exit 0), exit 3 without; a missing or unwritable path exits 3', async () => {
  const bad = await run({ argv: ['--findings', OUT, '--max-age-sec', '600'] });
  assert.equal(bad.code, 0);
  assert.deepEqual(bad.calls, []);
  const d = bad.doc(OUT);
  assert.deepEqual(d.findings.map((f) => [f.key, f.rule, f.severity, f.board]), [['watcher:alerts-watchdog', 'watcher', 'P3', 'platform']]);
  assert.match(d.findings[0]!.text, /cannot run: unknown argument "--max-age-sec"/);
  assert.deepEqual(d.unjudged, ['alerts:*', 'platform:cf-usage']);
  assert.doesNotMatch(bad.out, /::error/);

  const plainBad = await run({ argv: ['--bogus'] });
  assert.equal(plainBad.code, 3);
  assert.match(plainBad.out, /::error title=Alert watchdog misconfigured::unknown argument "--bogus"/);
  const noPath = await run({ argv: ['--findings'] });
  assert.equal(noPath.code, 3);
  assert.match(noPath.out, /::error title=Alert watchdog misconfigured::--findings needs a value/);
  const unwritable = await run({
    routes: { [STATUS_URL]: [jsonResponse(HEALTHY)] },
    argv: ['--findings', '/nonexistent/alerts.json', '--no-canary'],
    writeFile: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(unwritable.code, 3);
  assert.match(unwritable.out, /::error title=Alert watchdog could not write its findings::\/nonexistent\/alerts.json: EACCES/);
});

test('main: the default writer creates the findings directory; the step summary lists the findings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alerts-watchdog-'));
  try {
    const path = join(dir, 'findings', 'alerts.json');
    const summary = join(dir, 'summary.md');
    const lines: string[] = [];
    const f = fakeFetch({ [STATUS_URL]: [jsonResponse(geofonAt('2026-10-21T15:22:00Z'))] });
    const code = await main({ argv: ['--findings', path, '--no-canary'], env: { GITHUB_STEP_SUMMARY: summary }, fetchImpl: f.impl, now: () => T('2026-10-21T15:22:20Z'), log: (l) => void lines.push(l), sleep: noSleep });
    assert.equal(code, 0);
    const parsed = parseFindingsDocument(JSON.parse(readFileSync(path, 'utf8')));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.doc.findings.map((x) => `${x.key} ${x.severity}`), ['alerts:provider:gfz P3']);
    const md = readFileSync(summary, 'utf8');
    assert.match(md, /^### Alert-pipeline watchdog$/m);
    assert.match(md, /^- status\.json: warnings · `age=20s providers=usgs:ok,feed:ok,emsc:ok,gfz:FAIL\(\d+\)/m);
    assert.match(md, /^- \*\*P3\*\* `alerts:provider:gfz` \(alerts:provider:fast\): provider gfz is failing: ok:false for 2\.5 h/m);
    assert.match(md, /^- not judged this run: `alerts:canary`$/m);
    assert.match(md, /^- note: account usage: skipped \(no CF_ANALYTICS_TOKEN\)$/m);
    assert.doesNotMatch(md, /^- account usage:/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- fetchJson: bounded retries, network vs HTTP vs parse ---

test('fetchJson retries a network error twice with backoff, then reports kind=network', async () => {
  const slept: number[] = [];
  const f = fakeFetch({ [STATUS_URL]: [new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })] });
  const r = await fetchJson(STATUS_URL, { fetchImpl: f.impl, sleep: async (ms) => void slept.push(ms) });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(slept, [2000, 5000]);
  if (!r.ok) {
    assert.equal(r.kind, 'network');
    assert.match(r.message, /network error: fetch failed \(ECONNRESET\)/);
  }
});

test('fetchJson recovers when a retry succeeds', async () => {
  const f = fakeFetch({ [STATUS_URL]: [new TypeError('fetch failed'), jsonResponse('oops', 502), jsonResponse(HEALTHY)] });
  const r = await fetchJson(STATUS_URL, { fetchImpl: f.impl, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

test('fetchJson does not retry a 404, retries an unparseable body, and times out', async () => {
  const notFound = fakeFetch({ [STATUS_URL]: [jsonResponse('missing', 404)] });
  const r404 = await fetchJson(STATUS_URL, { fetchImpl: notFound.impl, sleep: noSleep });
  assert.equal(r404.attempts, 1);
  assert.equal(!r404.ok && r404.kind, 'http');

  const garbage = fakeFetch({ [STATUS_URL]: [jsonResponse('{"trunc', 200)] });
  const rParse = await fetchJson(STATUS_URL, { fetchImpl: garbage.impl, sleep: noSleep });
  assert.equal(rParse.attempts, 3);
  assert.equal(!rParse.ok && rParse.kind, 'parse');

  const hang: FetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const rTimeout = await fetchJson(STATUS_URL, { fetchImpl: hang, sleep: noSleep, attempts: 1, timeoutMs: 20 });
  assert.equal(!rTimeout.ok && rTimeout.message, 'timed out after 20 ms');
});

test('annotation escapes the workflow-command metacharacters', () => {
  assert.equal(annotation('error', 'a: b, c', '50% done\nnext'), '::error title=a%3A b%2C c::50%25 done%0Anext');
});

// --- the gateway's polling cadence (turns a failure count into a duration) ---

test('failureReason: lastError and consecutiveTimeouts named; missing, malformed or unknown values never break it', () => {
  assert.equal(failureReason({ lastError: 'network', consecutiveTimeouts: 0 }), ', last error network (a network failure before the timeout)');
  assert.equal(failureReason({ lastError: 'timeout', consecutiveTimeouts: 1 }), ", last error timeout (slower than the gateway's fetch timeout), 1 timeout in a row");
  assert.equal(failureReason({}), '');
  assert.equal(failureReason(null), '');
  assert.equal(failureReason({ lastError: '', consecutiveTimeouts: -1 }), '');
  assert.equal(failureReason({ lastError: 42, consecutiveTimeouts: '3' }), '');
  assert.equal(failureReason({ consecutiveTimeouts: Number.NaN }), '');
  assert.equal(failureReason({ lastError: 'tls', consecutiveTimeouts: 2 }), ', last error tls, 2 timeouts in a row');
  assert.equal(failureReason({ lastError: 'x'.repeat(100) }), `, last error ${'x'.repeat(32)}`);
});

test('cadence: the gateway polls EMSC and GFZ every 15 s tick, USGS and the feed every 60 s; backoff 60 s from 3, 300 s from 10', () => {
  assert.equal(GATEWAY_TICK_MS, 15_000);
  assert.deepEqual({ ...PROVIDER_MIN_INTERVAL_MS }, { usgs: 60_000, emsc: 10_000, gfz: 10_000, feed: 60_000 });
  assert.deepEqual(PROVIDER_BACKOFF_STEPS.map((s) => ({ ...s })), [{ atFailures: 10, intervalMs: 300_000 }, { atFailures: 3, intervalMs: 60_000 }]);
  assert.deepEqual(['emsc', 'gfz', 'usgs', 'feed', 'newsource'].map(pollIntervalMs), [15_000, 15_000, 60_000, 60_000, 60_000]);
  assert.deepEqual(['emsc', 'gfz', 'usgs', 'feed', 'newsource'].map(isFastProvider), [true, true, false, false, false]);
  assert.deepEqual([...DIRECT_PROVIDERS], ['usgs', 'emsc', 'gfz']);
  assert.equal(BACKSTOP_PROVIDER, 'feed');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10, 11].map((n) => streakSpanSec('gfz', n)), [0, 15, 30, 90, 150, 210, 450, 750]);
  assert.deepEqual([1, 2, 3, 4, 10, 11].map((n) => streakSpanSec('usgs', n)), [0, 60, 120, 180, 540, 840]);
  assert.equal(streakSpanSec('usgs', 387), 113_640); // the 2026-10-04..06 USGS outage: about 31.6 h
});

test('streakDuration: measured from failingSinceMs when usable, else the count at the gateway\'s polling, else null', () => {
  for (const n of [1, 3, 6, 11]) assert.equal(streakDuration({ id: 'emsc', ok: false, consecutiveFailures: n }, GEN)!.sec, streakSpanSec('emsc', n));
  assert.deepEqual(streakDuration({ id: 'usgs', ok: false, consecutiveFailures: 3, failingSinceMs: GEN - 150_000 }, GEN), { sec: 150, measured: true, since: GEN - 150_000, failures: 3 });
  assert.deepEqual(streakDuration({ id: 'gfz', ok: false, consecutiveFailures: 4 }, GEN), { sec: 90, measured: false, failures: 4 });
  // A start up to 60 s past the document's time is clock skew (0 s); further is damage (the count).
  assert.deepEqual(streakDuration({ id: 'gfz', ok: false, consecutiveFailures: 4, failingSinceMs: GEN + 30_000 }, GEN), { sec: 0, measured: true, since: GEN + 30_000, failures: 4 });
  assert.equal(streakDuration({ id: 'gfz', ok: false, consecutiveFailures: 4, failingSinceMs: GEN + 61_000 }, GEN)!.measured, false);
  assert.equal(streakDuration({ id: 'gfz', ok: false }, GEN), null);
  assert.equal(streakDuration(null, GEN), null);
});

// The constants above mirror the gateway's source. When a platform checkout is at hand (SHELTER_PLATFORM_DIR, or the
// sibling ../platform of a local clone), compare them with it; CI has none and skips.
const platformDir = process.env.SHELTER_PLATFORM_DIR ?? join(import.meta.dirname, '..', '..', 'platform');
const gatewaySrc = join(platformDir, 'services', 'alerts-gateway', 'src');
test('cadence: the mirrored constants match the alerts-gateway source', { skip: existsSync(gatewaySrc) ? false : 'no platform checkout' }, () => {
  const read = (rel: string): string => readFileSync(join(gatewaySrc, rel), 'utf8');
  const ms = (v: string): number => Number(v.replace(/_/g, ''));
  const tick = /const TICK_INTERVAL_MS = ([\d_]+)/.exec(read('durable-objects/event-detector.ts'));
  assert.equal(ms(tick![1]!), GATEWAY_TICK_MS);
  const sources = read('detect/sources.ts');
  for (const [name, id] of [['EMSC_SOURCE', 'emsc'], ['GFZ_SOURCE', 'gfz'], ['USGS_SOURCE', 'usgs']] as const) {
    const m = new RegExp(`export const ${name}[^]*?minIntervalMs: ([\\d_]+)`).exec(sources);
    assert.equal(ms(m![1]!), PROVIDER_MIN_INTERVAL_MS[id], name);
  }
  const feed = /const MIN_INTERVAL_MS = ([\d_]+)/.exec(read('detect/feed-source.ts'));
  assert.equal(ms(feed![1]!), PROVIDER_MIN_INTERVAL_MS['feed']);
  const product = (v: string): number => v.split('*').reduce((n, f) => n * ms(f.trim()), 1);
  const steps = [...read('detect/provider-health.ts').matchAll(/\{ atFailures: (\d+), intervalMs: ([\d_ *]+?) \}/g)].map((m) => ({ atFailures: Number(m[1]), intervalMs: product(m[2]!) }));
  assert.deepEqual(steps, PROVIDER_BACKOFF_STEPS.map((s) => ({ ...s })));
  assert.match(sources, /ALL_SOURCES[^=]*= \[USGS_SOURCE, EMSC_SOURCE, GFZ_SOURCE\]/);
});

// --- every finding this evaluator emits is one its rule judges ---

test('every emitted finding validates against its rule, and the rules used are this evaluator\'s', () => {
  const docs: Array<[unknown, { canary?: unknown; selftest?: boolean; nowMs?: number }]> = [
    [failingFor({ usgs: 4_000, emsc: 4_000, gfz: 4_000, feed: 4_000 }), { selftest: true }],
    [statusFixture('apns-split-no-production'), {}],
    [statusFixture('fanout-warnings'), {}],
    [statusFixture('low-headroom'), {}],
    [deletionsFailing(25 * 3_600, { fallback: 'summary', primaryConsecutiveFailures: 90 }), {}],
    ['garbage', {}],
    [statusFixture('stale'), {}],
  ];
  const rules = new Set<string>();
  for (const [doc, opts] of docs) {
    const v = evaluateStatus(doc, { nowMs: NOW, ...opts });
    const parsed = parseFindingsDocument({ schema: 'health-findings/1', evaluator: 'alerts', generatedAtMs: NOW, findings: v.findings, unjudged: v.unjudged, notes: v.notes });
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    for (const f of v.findings) rules.add(f.rule);
  }
  for (const r of rules) assert.equal(RULES[r as keyof typeof RULES].phase, 1, r);
  assert.ok(![...rules].some((r) => r === 'alerts:dispatch' || r === 'alerts:fanout'));
});
