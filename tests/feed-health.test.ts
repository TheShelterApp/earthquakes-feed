import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import {
  classifyFailure,
  collect,
  decodeManifestV2,
  evaluateFeed,
  evaluateFreshness,
  evaluateRepoSize,
  evaluateSizes,
  evaluateSources,
  evaluateWalks,
  GITHUB_API,
  main,
  MANIFEST_V1_URL,
  MANIFEST_V2_URL,
  parseArgs,
  parseMarker,
  pickMarkerArtifact,
  readManifestV1,
  readZipEntries,
  REGISTRY_PATH,
  registryIds,
  STATUS_V1_URL,
  statusRefMs,
  ZIP_MAX_ENTRY_BYTES,
  type FeedInputs,
  type FetchImpl,
  type ManifestRead,
  type WalkRead,
} from '../scripts/feed-health.mjs';
import { mayTurnRed, parseFindingsDocument, RULES, type Finding } from '../scripts/lib/findings.mjs';
import { enrichStatusV2 } from '../src/status-v2.js';

// The feed health evaluator (scripts/feed-health.mjs, the `feed` job of .github/workflows/health.yml): the findings of
// the "[health] feed" board (alerting plan of 2026-10-22, section 3b). The cases of tests/health-check.test.ts (the
// inline scripts it replaces) are ported here. Fixture: tests/fixtures/feed-health/status-2026-10-22.json is the live
// v1/status.json of 2026-10-22 12:12:13Z as derive publishes it (built from the public data branch's status.json,
// provider_health.json and provider_activity.json with src/status-v2.ts), every one of its 42 sources ok; each case
// patches a structuredClone of it. Nothing here touches the network.

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const FIXTURES = join(import.meta.dirname, 'fixtures', 'feed-health');
const STATUS: Record<string, any> = JSON.parse(readFileSync(join(FIXTURES, 'status-2026-10-22.json'), 'utf8'));
const STATUS_MS = STATUS.generatedAt as number;
const REPO = 'TheShelterApp/earthquakes-feed';
const TOKEN = 'test-token-not-a-secret';
const ENV = { GH_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '4242' };
const ISO = (ms: number): string => new Date(ms).toISOString();

/** The fixture as of `genMs`, with `patch` applied to a clone. */
function statusAt(genMs: number = STATUS_MS, patch: (s: Record<string, any>) => void = () => {}): Record<string, any> {
  const s = structuredClone(STATUS);
  s.generatedAt = genMs;
  s.generated = ISO(genMs);
  for (const p of Object.values(s.providers) as Array<Record<string, any>>) p.lastSuccessAt = genMs;
  patch(s);
  return s;
}

/** A provider failing since `lastOkMs` (the enriched shape: error {kind, message, since}). */
function failing(s: Record<string, any>, id: string, lastOkMs: number | null, error: Record<string, unknown> | string | null = { kind: 'timeout', message: 'timed out after 30000 ms' }, extra: Record<string, unknown> = {}): void {
  const p = s.providers[id];
  assert.ok(p, `fixture has ${id}`);
  Object.assign(p, { ok: false, lastSuccessAt: lastOkMs, error: error !== null && typeof error === 'object' ? { since: lastOkMs ?? s.generatedAt, ...error } : error, ...extra });
}

const judge = (s: Record<string, any>) => evaluateSources(s, statusRefMs(s)!);
const byKey = (fs: Finding[]): Record<string, Finding> => Object.fromEntries(fs.map((f) => [f.key, f]));
const keys = (fs: Finding[]): string[] => fs.map((f) => f.key).sort();

test('the fixture: the live status of 2026-10-22 has 42 sources, all ok, so it judges to nothing', () => {
  assert.equal(Object.keys(STATUS.providers).length, 42);
  assert.equal(statusRefMs(STATUS), Date.parse('2026-10-22T12:12:13.014Z'));
  const r = judge(statusAt());
  assert.deepEqual(r.findings, []);
  // A status.json of before SD-E3 (no generatedAt) is judged by its ISO `generated`; neither: null.
  assert.equal(statusRefMs({ generated: '2026-10-22T12:12:13.014Z' }), STATUS_MS);
  assert.equal(statusRefMs({}), null);
  assert.equal(statusRefMs('x'), null);
});

// --- ported from tests/health-check.test.ts: silent, frozen, pinned leaves, TLS failures (FEED-3, FEED-SEC-1, round 24) ---

test('silent and frozen sources: one feed:source row each, rule quiet, members naming why, never the systemic line', () => {
  const s = statusAt(STATUS_MS, (x) => {
    x.degraded = ['egypt', 'bgs'];
    x.silent = { egypt: { last_non_empty_at: '2026-07-29T12:06:21.443Z', counted_from: '2026-07-05T00:00:00Z', silent_hours: 1608, budget_hours: 12 } };
    x.frozen = { bgs: { newest_origin: '2026-09-25T00:00:00.000Z', newest_origin_age_hours: 264.5, window_hours: 48, budget_hours: 216, rows: 40 } };
  });
  const r = judge(s);
  assert.deepEqual(keys(r.findings), ['feed:source:bgs', 'feed:source:egypt']);
  const f = byKey(r.findings);
  assert.equal(f['feed:source:egypt']!.rule, 'feed:source:quiet');
  assert.equal(f['feed:source:egypt']!.severity, 'P3');
  assert.deepEqual(f['feed:source:egypt']!.members, ['silent']);
  assert.equal(f['feed:source:egypt']!.text, 'egypt: no rows for 1608 h (budget 12 h, last rows 2026-07-29T12:06:21.443Z)');
  assert.equal(f['feed:source:egypt']!.sinceMs, Date.parse('2026-07-29T12:06:21.443Z'));
  assert.equal(f['feed:source:egypt']!.class, 'external');
  assert.equal(mayTurnRed(f['feed:source:egypt']!.class), false, 'one source is never a red run');
  assert.deepEqual(f['feed:source:bgs']!.members, ['frozen']);
  assert.equal(f['feed:source:bgs']!.text, 'bgs: frozen, 40 rows whose newest origin (2026-09-25T00:00:00.000Z) is 265 h old (window 48 h + budget 216 h)');
  assert.equal(f['feed:source:bgs']!.sinceMs, null);
  // A silent source never counted since its counting began reads "not since".
  const never = judge(statusAt(STATUS_MS, (x) => (x.silent = { egypt: { counted_from: '2026-07-05T00:00:00Z', silent_hours: 1608.4, budget_hours: 12 } })));
  assert.equal(never.findings[0]!.text, 'egypt: no rows for 1608 h (budget 12 h, last rows not since 2026-07-05T00:00:00Z)');
  assert.equal(never.findings[0]!.sinceMs, null);
  // A frozen source whose fetch also fails past its line: one row, both members, the fetch's rule.
  const both = judge(statusAt(STATUS_MS, (x) => {
    x.frozen = { bgs: { newest_origin: '2026-09-25T00:00:00.000Z', newest_origin_age_hours: 264.5, window_hours: 48, budget_hours: 216, rows: 40 } };
    failing(x, 'bgs', STATUS_MS - 13 * HOUR);
  }));
  assert.equal(both.findings.length, 1);
  assert.deepEqual(both.findings[0]!.members, ['fetch', 'frozen']);
  assert.equal(both.findings[0]!.rule, 'feed:source');
  assert.equal(both.findings[0]!.sinceMs, STATUS_MS - 13 * HOUR);
  assert.match(both.findings[0]!.text, /^bgs: fetch failing for 13\.0 h \(last successful fetch .*\), frozen, 40 rows .*, error: timed out after 30000 ms$/);
});

test('pinned leaves: under 7 days is feed:cert with sinceMs 7 days before its end (escalating at 2 days left); 192 days or no field: nothing', () => {
  const leaves = {
    tmd: { not_after: '2026-10-09T01:59:47.000Z', days_left: 3.1, issuer: 'GlobalSign GCC R6 AlphaSSL CA 2025', subject: '*.tmd.go.th', seen_at: '2026-10-06T00:00:00.000Z' },
    phivolcs: { not_after: '2027-04-16T23:59:59.000Z', days_left: 192.9, issuer: 'Amazon RSA 2048 M04', subject: 'phivolcs.dost.gov.ph', seen_at: '2026-10-06T00:00:00.000Z' },
  };
  const r = judge(statusAt(STATUS_MS, (x) => (x.tls_leaves = leaves)));
  assert.deepEqual(keys(r.findings), ['feed:cert:tmd']);
  const f = r.findings[0]!;
  assert.equal(f.rule, 'feed:cert');
  assert.equal(f.severity, 'P3');
  assert.equal(f.class, 'expiry');
  assert.equal(f.sinceMs, Date.parse('2026-10-09T01:59:47.000Z') - 7 * DAY);
  assert.equal(f.sinceMs! + RULES['feed:cert'].escalateAfterMs!, Date.parse('2026-10-09T01:59:47.000Z') - 2 * DAY, 'the escalation lands at 2 days left');
  assert.equal(f.text, 'tmd: leaf *.tmd.go.th (issuer GlobalSign GCC R6 AlphaSSL CA 2025) expires 2026-10-09T01:59:47.000Z, in 3.1 days (read 2026-10-06T00:00:00.000Z): pin a new intermediate if the issuer changed: providers/tls/README.md');
  assert.deepEqual(judge(statusAt(STATUS_MS, (x) => (x.tls_leaves = { phivolcs: leaves.phivolcs }))).findings, []);
  // A status.json without the field (before round 14), or with a leaf missing days_left: nothing.
  assert.deepEqual(judge(statusAt(STATUS_MS, (x) => delete x.tls_leaves)).findings, []);
  assert.deepEqual(judge(statusAt(STATUS_MS, (x) => (x.tls_leaves = { tmd: { not_after: 'x' } }))).findings, []);
  // An unparseable not_after: still a finding, with an unknown start.
  assert.equal(judge(statusAt(STATUS_MS, (x) => (x.tls_leaves = { tmd: { ...leaves.tmd, not_after: 'soon' } }))).findings[0]!.sinceMs, null);
});

test('a pinned source failing on its certificate is a definite feed:source finding naming the certificate error (TMD, 2026-10-13)', () => {
  // TMD failed every handshake from 2026-10-09 (its leaf renewed under another intermediate). error.kind files TLS under
  // 'error', so the certificate is recognised from tls_errors and the message.
  const gen = Date.parse('2026-10-16T02:00:00.000Z');
  const lastOk = Date.parse('2026-10-09T02:01:00.000Z');
  const phivolcs = { not_after: '2026-11-19T05:01:03.000Z', days_left: 36.5, issuer: 'GlobalSign RSA OV SSL CA 2018', subject: '*.phivolcs.dost.gov.ph', seen_at: '2026-10-13T17:56:58.926Z' };
  const message = "unable to verify the first certificate (the pinned intermediate no longer completes this host's chain: pin the one its leaf names, providers/tls/README.md)";
  const tlsErrors = { tmd: { error: message, since: '2026-10-09T02:01:00.000Z', last_at: '2026-10-16T02:00:00.000Z' } };
  const s = statusAt(gen, (x) => {
    x.tls_leaves = { phivolcs };
    x.tls_errors = tlsErrors;
    failing(x, 'tmd', lastOk, { kind: 'error', message });
  });
  const r = judge(s);
  assert.deepEqual(keys(r.findings), ['feed:source:tmd']);
  const f = r.findings[0]!;
  assert.equal(f.rule, 'feed:source:definite');
  assert.equal(f.severity, 'P3');
  assert.deepEqual(f.members, ['fetch']);
  assert.equal(f.sinceMs, lastOk);
  assert.equal(f.text, `tmd: fetch failing for 6.9 d (last successful fetch 2026-10-09T02:01:00.000Z; definite: a certificate failure (tls_errors since 2026-10-09T02:01:00.000Z), line 2.0 h), error: ${message}`);
  // With its expired leaf as well, both rows: the source and the certificate.
  const tmdLeaf = { not_after: '2026-10-09T01:59:47.000Z', days_left: -4.7, issuer: 'GlobalSign GCC R6 AlphaSSL CA 2025', subject: '*.tmd.go.th', seen_at: '2026-10-09T01:56:48.498Z' };
  const both = judge(statusAt(gen, (x) => {
    x.tls_leaves = { phivolcs, tmd: tmdLeaf };
    x.tls_errors = tlsErrors;
    failing(x, 'tmd', lastOk, { kind: 'error', message });
  }));
  assert.deepEqual(keys(both.findings), ['feed:cert:tmd', 'feed:source:tmd']);
  // The upstream text is one line without control characters or backticks.
  const odd = judge(statusAt(gen, (x) => {
    x.tls_errors = tlsErrors;
    failing(x, 'tmd', lastOk, { kind: 'error', message: 'a; b\nc`d' });
  }));
  assert.match(odd.findings[0]!.text, /, error: a; b c d$/);
  // Without a message of its own, the tls_errors text stands in.
  const bare = judge(statusAt(gen, (x) => {
    x.tls_errors = tlsErrors;
    failing(x, 'tmd', lastOk, null);
  }));
  assert.ok(bare.findings[0]!.text.endsWith(`error: ${message}`));
  // Fixed (no tls_errors, the source ok, the current leaf far from its end): nothing.
  assert.deepEqual(judge(statusAt(gen, (x) => ((x.tls_leaves = { phivolcs }), (x.tls_errors = {})))).findings, []);
});

/** The live status.json of 2026-10-13 18:07 UTC in miniature: TMD silent because its fetch fails (v2 error object). */
const tmdStatus = (generatedAt: number, lastOkAgoH = 112.2, message: unknown = "unable to verify the first certificate (the pinned intermediate no longer completes this host's chain: pin the one its leaf names, providers/tls/README.md)"): Record<string, any> =>
  statusAt(generatedAt, (x) => {
    x.degraded = ['tmd'];
    x.silent = { tmd: { last_non_empty_at: '2026-10-09T01:56:48.498Z', counted_from: '2026-07-05T05:42:10.043Z', silent_hours: lastOkAgoH, budget_hours: 12 } };
    x.frozen = {};
    x.tls_errors = {};
    Object.assign(x.providers.tmd, { ok: false, latency_ms: 6281, error: { kind: 'error', message, since: generatedAt - lastOkAgoH * HOUR }, observations: 0, lastSuccessAt: generatedAt - lastOkAgoH * HOUR, lastNonEmptyAt: generatedAt - lastOkAgoH * HOUR, silent: true });
  });

test('a silent source whose fetch fails is named with its error and failing time, not only "no rows" (round 24)', () => {
  const gen = Date.parse('2026-10-13T18:07:01.145Z');
  const r = judge(tmdStatus(gen));
  assert.equal(r.findings.length, 1);
  const f = r.findings[0]!;
  assert.equal(f.key, 'feed:source:tmd');
  assert.deepEqual(f.members, ['fetch', 'silent']);
  assert.equal(f.rule, 'feed:source:definite', 'its message names the certificate');
  assert.equal(f.sinceMs, gen - 112.2 * HOUR, 'with a fetch failing, the start is its last success');
  assert.equal(
    f.text,
    "tmd: fetch failing for 4.6 d (last successful fetch 2026-10-09T01:55:01.145Z; definite: a certificate failure, line 2.0 h), no rows for 112 h (budget 12 h, last rows 2026-10-09T01:56:48.498Z), error: unable to verify the first certificate (the pinned intermediate no longer completes this host's chain: pin the one its leaf names, providers/tls/README.md)",
  );
});

test('an answer without rows says only "no rows"; an unknown start keeps the source named, its failing time unknown', () => {
  const gen = Date.parse('2026-10-13T18:07:01.145Z');
  const quiet = tmdStatus(gen);
  Object.assign(quiet.providers.tmd, { ok: true, error: null, lastSuccessAt: gen });
  const q = judge(quiet).findings[0]!;
  assert.equal(q.text, 'tmd: no rows for 112 h (budget 12 h, last rows 2026-10-09T01:56:48.498Z)');
  assert.equal(q.rule, 'feed:source:quiet');
  assert.equal(q.sinceMs, Date.parse('2026-10-09T01:56:48.498Z'));
  // No last success and no error.since on record (a source that never succeeded): its fetch is a P3 member at once,
  // with no start (reconcile holds it on its own clock).
  const never = tmdStatus(gen);
  never.providers.tmd.lastSuccessAt = null;
  delete never.providers.tmd.error.since;
  const n = judge(never).findings[0]!;
  assert.deepEqual([n.severity, n.members, n.rule, n.sinceMs], ['P3', ['fetch', 'silent'], 'feed:source:definite', null]);
  assert.match(n.text, /^tmd: fetch failing, never fetched successfully \(no successful fetch on record, so its failing time is unknown; definite: a certificate failure, line 2\.0 h\), no rows for 112 h/);
  // error.since stands in for lastSuccessAt (ms, or an ISO time).
  const since = tmdStatus(gen);
  since.providers.tmd.lastSuccessAt = null;
  since.providers.tmd.error.since = ISO(gen - 3 * HOUR);
  assert.equal(judge(since).findings[0]!.sinceMs, gen - 3 * HOUR);
});

test('the error text is one line without control characters or backticks, cut at 240; a v1 string error and no message work too', () => {
  const gen = Date.parse('2026-10-13T18:07:01.145Z');
  const nasty = judge(tmdStatus(gen, 60, 'HTTP 502;\n::error::injected `code`\r\nproblem=x' + 'y'.repeat(400))).findings[0]!;
  assert.ok(!/[\u0000-\u001f`]/.test(nasty.text), nasty.text);
  assert.ok(nasty.text.length <= 500);
  const err = nasty.text.slice(nasty.text.indexOf(', error: ') + 9);
  assert.match(err, /^HTTP 502; ::error::injected code problem=xy+…$/);
  assert.equal(err.length, 240);
  assert.equal(nasty.rule, 'feed:source', 'an HTTP 502 is transient');
  const v1 = tmdStatus(gen, 60);
  v1.providers.tmd.error = 'deadline: 45000 ms spent after 3 attempt(s); last: This operation was aborted';
  assert.match(judge(v1).findings[0]!.text, /, error: deadline: 45000 ms spent after 3 attempt\(s\); last: This operation was aborted$/);
  const none = tmdStatus(gen, 60);
  none.providers.tmd.error = null;
  assert.match(judge(none).findings[0]!.text, /, error: no error message$/);
  // A source id that cannot be part of a key is skipped with a note, never a crash.
  const odd = statusAt(STATUS_MS, (x) => (x.silent = { 'Bad Id!': { silent_hours: 13 } }));
  const r = judge(odd);
  assert.deepEqual(r.findings, []);
  assert.match(r.notes.join('\n'), /skipped source id "Bad Id!"/);
});

// --- feed:source lines and classes ---

test('feed:source lines: 12 h for a transient error, 3 h for a core source, 2 h for a definite one; P4 from 30 min to the line', () => {
  const at = (id: string, ageMs: number, error?: Record<string, unknown> | string | null, extra: Record<string, unknown> = {}): Finding[] =>
    judge(statusAt(STATUS_MS, (x) => failing(x, id, STATUS_MS - ageMs, error, extra))).findings;
  const one = (fs: Finding[]): Finding => {
    assert.equal(fs.length, 1, JSON.stringify(fs));
    return fs[0]!;
  };
  // tmd, transient: 11.9 h a sample, 12.1 h the line.
  let f = one(at('tmd', 11.9 * HOUR));
  assert.deepEqual([f.key, f.rule, f.severity, f.members, f.sinceMs], ['feed:source:tmd', 'feed:source', 'P4', undefined, STATUS_MS - 11.9 * HOUR]);
  f = one(at('tmd', 12.1 * HOUR));
  assert.deepEqual([f.rule, f.severity, f.members], ['feed:source', 'P3', ['fetch']]);
  assert.match(f.text, /^tmd: fetch failing for 12\.1 h \(last successful fetch .*; a transient error \(timeout\), line 12\.0 h\), error: timed out after 30000 ms$/);
  // usgs, core: 2.9 h a sample, 3.1 h the line (escalating at 24 h).
  f = one(at('usgs', 2.9 * HOUR));
  assert.deepEqual([f.rule, f.severity], ['feed:source:core', 'P4']);
  f = one(at('usgs', 3.1 * HOUR));
  assert.deepEqual([f.rule, f.severity, f.members], ['feed:source:core', 'P3', ['fetch']]);
  assert.match(f.text, /a core source, a transient error \(timeout\), line 3\.0 h/);
  // kagsr answering 404: definite, 2 h.
  f = one(at('kagsr', 2.1 * HOUR, { kind: 'http', message: 'HTTP 404' }, { http_status: 404 }));
  assert.deepEqual([f.rule, f.severity], ['feed:source:definite', 'P3']);
  assert.match(f.text, /definite: HTTP 404, line 2\.0 h/);
  assert.equal(one(at('kagsr', 1.9 * HOUR, { kind: 'http', message: 'HTTP 404' }, { http_status: 404 })).severity, 'P4');
  // A definite class wins over core: usgs answering 403 is on the 2 h line.
  assert.equal(one(at('usgs', 2.1 * HOUR, { kind: 'http', message: 'HTTP 403' }, { http_status: 403 })).rule, 'feed:source:definite');
  // error.kind schema: definite.
  f = one(at('ign', 2.5 * HOUR, { kind: 'schema', message: 'missing field properties' }));
  assert.deepEqual([f.rule, f.severity], ['feed:source:definite', 'P3']);
  // A 500 is transient.
  assert.equal(one(at('ign', 2.5 * HOUR, { kind: 'http', message: 'HTTP 500' }, { http_status: 500 })).severity, 'P4');
  // Failing 20 min (under 30 min: the entry resolves), or ok: nothing.
  assert.deepEqual(at('tmd', 20 * MIN), []);
  assert.deepEqual(at('usgs', 29.9 * MIN), []);
  assert.deepEqual(judge(statusAt()).findings, []);
  // No lastSuccessAt and no error.since (a v1 string error): never fetched successfully, P3 with an unknown start.
  f = one(at('tmd', 0, 'HTTP 503', { lastSuccessAt: null }));
  assert.deepEqual([f.severity, f.sinceMs, f.rule, f.members], ['P3', null, 'feed:source', ['fetch']]);
  assert.match(f.text, /^tmd: fetch failing, never fetched successfully \(no successful fetch on record, so its failing time is unknown; a transient error, line 12\.0 h\), error: HTTP 503$/);
  // Every threshold is the rule table's.
  assert.equal(RULES['feed:source'].limits.lineMs, 12 * HOUR);
  assert.equal(RULES['feed:source:core'].limits.lineMs, 3 * HOUR);
  assert.equal(RULES['feed:source:definite'].limits.lineMs, 2 * HOUR);
});

test('a source that has never fetched successfully, as derive publishes it (error.since = the document time): P3 with no start, a 404 too', () => {
  // src/status-v2.ts, unchanged: a source without a success on record gets lastSuccessAt null and error.since = the
  // document's own time. Read as a start, that failure began "just now" on every run and never reached a line.
  const raw = {
    generated: ISO(STATUS_MS),
    head_seq: 1,
    providers: {
      newsrc: { ok: false, http_status: 404, error: 'HTTP 404', events_returned: 0 },
      slowsrc: { ok: false, error: 'timed out after 30000 ms', events_returned: 0 },
      usgs: { ok: false, http_status: 503, error: 'HTTP 503', events_returned: 0 },
      emsc: { ok: true, http_status: 200, events_returned: 12 },
    },
  };
  const opts = { generatedMs: STATUS_MS, expectedIntervalSeconds: 300, staleAfterSeconds: 1_800 };
  const status = enrichStatusV2(raw, { ...opts, health: { emsc: STATUS_MS } }) as Record<string, any>;
  assert.deepEqual([status.providers.newsrc.lastSuccessAt, status.providers.newsrc.error.since, status.generatedAt], [null, STATUS_MS, STATUS_MS]);
  const r = judge(status);
  assert.deepEqual(r.findings.map((f) => [f.key, f.rule, f.severity, f.members, f.sinceMs]), [
    ['feed:source:newsrc', 'feed:source:definite', 'P3', ['fetch'], null],
    ['feed:source:slowsrc', 'feed:source', 'P3', ['fetch'], null],
    ['feed:source:usgs', 'feed:source:core', 'P3', ['fetch'], null],
  ]);
  assert.equal(byKey(r.findings)['feed:source:newsrc']!.text, 'newsrc: fetch failing, never fetched successfully (no successful fetch on record, so its failing time is unknown; definite: HTTP 404, line 2.0 h), error: HTTP 404');
  assert.ok(r.findings.every((f) => f.check === null && !f.shadow && !mayTurnRed(f.class)), 'one source never turns a run red');
  // A start that is known wins: a success on record (lastSuccessAt, and error.since with it) is measured as before.
  const known = judge(enrichStatusV2(raw, { ...opts, health: { newsrc: STATUS_MS - 3 * HOUR } }));
  assert.deepEqual(known.findings.filter((f) => f.key === 'feed:source:newsrc').map((f) => [f.severity, f.members, f.sinceMs]), [['P3', ['fetch'], STATUS_MS - 3 * HOUR]]);
  // An error.since at or after the document's time is no start either (ms or ISO alike).
  for (const since of [STATUS_MS, STATUS_MS + MIN, ISO(STATUS_MS)]) {
    const odd = statusAt(STATUS_MS, (x) => failing(x, 'tmd', null, { kind: 'http', message: 'HTTP 410', since }, { http_status: 410 }));
    assert.deepEqual(judge(odd).findings.map((f) => [f.key, f.rule, f.severity, f.sinceMs]), [['feed:source:tmd', 'feed:source:definite', 'P3', null]], String(since));
  }
});

test('TMD replay (2026-10-09): certificate failing from 02:01Z; nothing at 02:20, a sample at 03:30, definite P3 at 04:02 from 02:01', () => {
  const lastOk = Date.parse('2026-10-09T02:01:00.000Z');
  const message = 'unable to verify the first certificate';
  const at = (iso: string): Finding[] =>
    judge(statusAt(Date.parse(iso), (x) => {
      x.tls_errors = { tmd: { error: message, since: ISO(lastOk), last_at: iso } };
      failing(x, 'tmd', lastOk, { kind: 'error', message });
    })).findings;
  assert.deepEqual(at('2026-10-09T02:20:00.000Z'), []);
  const sample = at('2026-10-09T03:30:00.000Z');
  assert.deepEqual(sample.map((f) => [f.key, f.rule, f.severity, f.sinceMs]), [['feed:source:tmd', 'feed:source:definite', 'P4', lastOk]]);
  const p3 = at('2026-10-09T04:02:00.000Z');
  assert.deepEqual(p3.map((f) => [f.key, f.rule, f.severity, f.sinceMs]), [['feed:source:tmd', 'feed:source:definite', 'P3', lastOk]]);
  assert.equal(p3[0]!.check, null, 'a P3 pings no verdict check');
  // Judged as of the document, not now: the same document read an hour later judges the same.
  const s = statusAt(Date.parse('2026-10-09T03:30:00.000Z'), (x) => failing(x, 'tmd', lastOk, { kind: 'error', message }));
  assert.equal(evaluateSources(s, statusRefMs(s)!, { nowMs: s.generatedAt + HOUR }).findings[0]!.severity, 'P4');
  assert.match(evaluateSources(s, statusRefMs(s)!, { nowMs: s.generatedAt + HOUR }).notes.join(), /status\.json was generated 60 min ago: its sources are judged as of 2026-10-09 03:30Z/);
});

test('classifyFailure: definite for 401/403/404/410, a schema error or a TLS failure; transient otherwise', () => {
  for (const code of [401, 403, 404, 410]) assert.deepEqual(classifyFailure({ ok: false, http_status: code, error: { kind: 'http', message: `HTTP ${code}` } }), { definite: true, reason: `HTTP ${code}` });
  for (const code of [429, 500, 502, 503]) assert.equal(classifyFailure({ ok: false, http_status: code, error: { kind: 'http', message: `HTTP ${code}` } }).definite, false);
  assert.deepEqual(classifyFailure({ ok: false, error: { kind: 'schema', message: 'x' } }), { definite: true, reason: 'a schema error' });
  assert.equal(classifyFailure({ ok: false, error: 'x' }, { tlsError: { error: 'chain', since: '2026-10-09T02:01:00.000Z' } }).definite, true);
  assert.match(classifyFailure({ ok: false, error: 'x' }, { tlsLeaf: { days_left: -0.1, not_after: '2026-10-09T01:59:47.000Z' } }).reason, /pinned leaf expired 2026-10-09/);
  assert.equal(classifyFailure({ ok: false, error: 'x' }, { tlsLeaf: { days_left: 3 } }).definite, false, 'a leaf about to expire is feed:cert, not a failure');
  for (const message of ['certificate has expired', 'CERT_HAS_EXPIRED', 'self-signed certificate in certificate chain', 'self signed', 'unable to verify the first certificate', 'SSL routines:ssl3_read_bytes', 'TLS alert', 'handshake failure', 'bad cert']) {
    assert.equal(classifyFailure({ ok: false, error: { kind: 'error', message } }).definite, true, message);
    assert.equal(classifyFailure({ ok: false, error: message }).definite, true, `${message} (v1 string)`);
  }
  for (const message of ['timed out after 30000 ms', 'fetch failed', 'ECONNRESET', 'concert hall', 'certainly not', '']) {
    assert.equal(classifyFailure({ ok: false, error: { kind: 'timeout', message } }).definite, false, message);
  }
  assert.deepEqual(classifyFailure(null), { definite: false, reason: 'a transient error' });
});

test('feed:systemic (shadow): 2 core sources or 6 in all failing for 30 min or more is a P2; 5 others, or core under 30 min, nothing', () => {
  const sys = (fail: Record<string, number>): Finding | undefined =>
    byKey(judge(statusAt(STATUS_MS, (x) => {
      for (const [id, ageMs] of Object.entries(fail)) failing(x, id, STATUS_MS - ageMs);
    })).findings)['feed:systemic'];
  const two = sys({ usgs: 31 * MIN, emsc: 31 * MIN });
  assert.ok(two);
  assert.deepEqual([two.severity, two.shadow, two.check, two.rule], ['P2', true, 'gh-feed', 'feed:systemic']);
  assert.deepEqual(two.members, ['emsc', 'usgs']);
  assert.equal(two.text, "2 sources have failed for 30 min or more (2 of the core usgs, emsc, geofon): emsc, usgs; the feed's coverage is reduced");
  assert.equal(sys({ usgs: 29 * MIN, emsc: 31 * MIN }), undefined);
  assert.equal(sys({ usgs: 31 * MIN }), undefined);
  const six = sys({ tmd: 31 * MIN, ign: 2 * HOUR, bgs: 40 * MIN, ga: 31 * MIN, imo: DAY, koeri: 31 * MIN });
  assert.ok(six);
  assert.equal(six.members!.length, 6);
  assert.equal(sys({ tmd: 31 * MIN, ign: 2 * HOUR, bgs: 40 * MIN, ga: 31 * MIN, imo: DAY }), undefined);
  // A source with no start on record never counts.
  assert.equal(byKey(judge(statusAt(STATUS_MS, (x) => {
    failing(x, 'usgs', STATUS_MS - HOUR);
    failing(x, 'emsc', null, 'HTTP 503');
  })).findings)['feed:systemic'], undefined);
});

// --- manifests: feed:freshness ---

const NOW = STATUS_MS + 2 * MIN;
const v1Manifest = (generated: number, staleAfter: number | null = 1800): Record<string, unknown> => ({
  schema_version: 1,
  generated,
  generated_iso: ISO(generated),
  head_seq: 7,
  event_count: 10,
  ...(staleAfter === null ? {} : { freshness: { expected_interval_seconds: 300, stale_after_seconds: staleAfter } }),
});
const v2Envelope = (generated: number, staleAfter: number | null = 1800): Record<string, unknown> => ({
  payload: Buffer.from(JSON.stringify({ ...v1Manifest(generated, staleAfter), schema_version: 2 })).toString('base64'),
  sig: 'c2lnbmF0dXJl',
  kid: 'feed-2026a',
});
const okRead = (generatedMs: number, staleAfterMs = 1_800 * SEC): ManifestRead => ({ ok: true, generatedMs, staleAfterMs });

test('manifest reads: v1 its generated time; v2 its base64 payload decoded (not verified); anything unusable reads as unreachable', () => {
  assert.deepEqual(readManifestV1(v1Manifest(NOW - MIN)), okRead(NOW - MIN));
  assert.deepEqual(readManifestV1(v1Manifest(NOW - MIN, 3600)), okRead(NOW - MIN, 3_600 * SEC));
  assert.deepEqual(readManifestV1(v1Manifest(NOW - MIN, null)), okRead(NOW - MIN), 'default 1,800 s');
  assert.equal(readManifestV1({ generated: '2026-10-22' }).ok, false);
  assert.equal(readManifestV1([]).ok, false);
  assert.deepEqual(decodeManifestV2(v2Envelope(NOW - MIN, 900)), okRead(NOW - MIN, 900 * SEC));
  for (const bad of [null, {}, { payload: 7 }, { payload: '!!not base64!!' }, { payload: 'abc' }, { payload: Buffer.from('not json').toString('base64') }, { payload: Buffer.from('[1]').toString('base64') }, { payload: Buffer.from('{"generated":"x"}').toString('base64') }]) {
    const r = decodeManifestV2(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

test('feed:freshness: both fresh nothing; v2 41 min old with v1 fresh is P2 (the signing has stopped); the contract is each manifest\'s own', () => {
  assert.equal(evaluateFreshness({ nowMs: NOW, v1: okRead(NOW - MIN), v2: okRead(NOW - 2 * MIN), queuedMs: 0, reRead: false }), null);
  const f = evaluateFreshness({ nowMs: NOW, v1: okRead(NOW - MIN), v2: okRead(NOW - 41 * MIN), queuedMs: 0, reRead: true })!;
  assert.deepEqual([f.key, f.rule, f.severity, f.check, f.class, f.shadow], ['feed:freshness', 'feed:freshness', 'P2', 'gh-feed', 'symptom', false]);
  assert.equal(f.sinceMs, NOW - 41 * MIN + 30 * MIN);
  assert.equal(f.text, 'live manifest is 41 min stale (contract: 30 min): v1/manifest.json generated 60 s ago, v2/manifest.json generated 41 min ago; confirmed by a re-read 60 s later; v1 is fresh, so the signing of v2 has stopped: the alerts backstop reads the old v2');
  // Both old: publishing stopped.
  assert.match(evaluateFreshness({ nowMs: NOW, v1: okRead(NOW - 50 * MIN), v2: okRead(NOW - 52 * MIN) })!.text, /^live manifest is 52 min stale .*; the feed has stopped publishing/);
  // stale_after_seconds honoured: 3,600 s holds a 50 min old manifest fresh; past it, stale.
  assert.equal(evaluateFreshness({ nowMs: NOW, v1: okRead(NOW - 50 * MIN, 3_600 * SEC), v2: okRead(NOW - 50 * MIN, 3_600 * SEC) }), null);
  assert.equal(evaluateFreshness({ nowMs: NOW, v1: okRead(NOW - 61 * MIN, 3_600 * SEC), v2: okRead(NOW - MIN) })!.severity, 'P2');
  // The default contract (1,800 s) applies to a manifest without freshness.
  assert.equal(RULES['feed:freshness'].limits.defaultStaleAfterMs, 1_800 * SEC);
  assert.equal(evaluateFreshness({ nowMs: NOW, v1: readManifestV1(v1Manifest(NOW - 31 * MIN, null)), v2: okRead(NOW - MIN) })!.severity, 'P2');
  assert.equal(evaluateFreshness({ nowMs: NOW, v1: readManifestV1(v1Manifest(NOW - 29 * MIN, null)), v2: okRead(NOW - MIN) }), null);
  // The queue note of today's alarm.
  assert.match(evaluateFreshness({ nowMs: NOW, v1: okRead(NOW - 40 * MIN), v2: okRead(NOW - 40 * MIN), queuedMs: 12 * MIN, reRead: true })!.text, /; confirmed by a re-read 60 s later — this run itself waited 12 min in the runner queue; /);
});

test('feed:freshness unreachable: v1 or v2 unreadable after its retries is the unreachable rule (P2, confirmed by reconcile); a stale one read wins', () => {
  const gone: ManifestRead = { ok: false, message: 'v2/manifest.json: HTTP 404 after 1 attempt(s)' };
  const f = evaluateFreshness({ nowMs: NOW, v1: okRead(NOW - MIN), v2: gone })!;
  assert.deepEqual([f.key, f.rule, f.severity, f.members, f.sinceMs, f.class], ['feed:freshness', 'feed:freshness:unreachable', 'P2', ['v2'], null, 'unknown']);
  assert.equal(RULES['feed:freshness:unreachable'].confirmRuns, 2, 'reconcile shows it as P4 on its first run');
  assert.equal(f.text, "v2 manifest unreachable after its retries (v2/manifest.json: HTTP 404 after 1 attempt(s)): the feed's freshness cannot be judged");
  assert.deepEqual(evaluateFreshness({ nowMs: NOW, v1: gone, v2: gone })!.members, ['v1', 'v2']);
  assert.deepEqual(evaluateFreshness({ nowMs: NOW, v1: gone, v2: decodeManifestV2({ payload: 'garbage!' }) })!.members, ['v1', 'v2']);
  // The one read is stale: the older of the two is at least that old, so it is stale (P2 at once), not unreachable.
  const stale = evaluateFreshness({ nowMs: NOW, v1: okRead(NOW - 45 * MIN), v2: gone })!;
  assert.equal(stale.rule, 'feed:freshness');
  assert.match(stale.text, /v2\/manifest\.json unreachable/);
});

// --- data branch and repository sizes (ported) ---

const blob = (path: string, size: number) => ({ path, mode: '100644', type: 'blob', sha: '0'.repeat(40), size });
const dirEntry = (path: string) => ({ path, mode: '040000', type: 'tree', sha: '1'.repeat(40) });
/** The data tree of 2026-10-06 11:4x UTC in miniature: the October run log at 6.5 MB, a day partition, an index. */
const todaysTree = (historySize = 6_495_366, extra: object[] = []): Record<string, unknown> => ({
  sha: 'f'.repeat(40),
  truncated: false,
  tree: [
    blob('manifest.json', 150_000),
    dirEntry('events'),
    blob('events/2026/10/05.ndjson', 2_364_837),
    dirEntry('knowledge/index/event_map'),
    blob('knowledge/index/event_map/2026-10-05.ndjson', 950_000),
    dirEntry('status/history'),
    blob('status/history/2026-10.ndjson', historySize),
    ...extra,
  ],
});
const sizeMembers = (tree: unknown): string[] => evaluateSizes(tree).findings[0]?.members ?? [];

test('data file sizes: today\'s tree is logged as notes and judges to nothing', () => {
  const r = evaluateSizes(todaysTree());
  assert.deepEqual([r.findings, r.unjudged], [[], []]);
  assert.match(r.notes.join('\n'), /status history: 1 file\(s\) \(0 day file\(s\)\), 6\.5 MB, largest status\/history\/2026-10\.ndjson 6\.5 MB \(line 5\.0 MB a day file, 45\.0 MB any other file\)/);
  assert.match(r.notes.join('\n'), /data tree: 4 files, 10\.0 MB \(status 6\.5 MB, events 2\.4 MB, knowledge 0\.9 MB, \(root\) 0\.1 MB\)/);
});

test('data file sizes: a run-log file past 45 MB and any other large file are one feed:size finding, largest first', () => {
  const r = evaluateSizes(todaysTree(46_200_000, [blob('knowledge/index/huge.json', 52_000_000)]));
  assert.equal(r.findings.length, 1);
  const f = r.findings[0]!;
  assert.deepEqual([f.key, f.rule, f.severity, f.class], ['feed:size', 'feed:size', 'P3', 'capacity']);
  assert.deepEqual(f.members, ['knowledge/index/huge.json', 'status/history/2026-10.ndjson']);
  assert.equal(
    f.text,
    'knowledge/index/huge.json: 52.0 MB, over 45.0 MB (a file on the data branch); status/history/2026-10.ndjson: 46.2 MB, over 45.0 MB (the run log, rewritten by every aggregate commit): every rewrite of a large file grows the repository, and GitHub rejects a pushed file above 100 MiB, which stops the feed publishing (APIs.md Run logs)',
  );
  // The boundary is strict, like the aggregate's.
  assert.deepEqual(sizeMembers(todaysTree(45_000_000)), []);
  assert.deepEqual(sizeMembers(todaysTree(45_000_001)), ['status/history/2026-10.ndjson']);
  // More than three files: the first three named, the rest counted; every one a member.
  const many = evaluateSizes(todaysTree(1, Array.from({ length: 5 }, (_, i) => blob(`big/${i}.bin`, 46_000_000 + i)))).findings[0]!;
  assert.equal(many.members!.length, 5);
  assert.match(many.text, /, \+2 more: every rewrite/);
});

test('data file sizes: day files (YYYY-MM-DD.ndjson) past 5 MB, the month file of before only past 45 MB', () => {
  const days = Array.from({ length: 3 }, (_, i) => blob(`status/history/2026-10-${String(i + 7).padStart(2, '0')}.ndjson`, 1_300_000 + i * 1000));
  const calm = evaluateSizes(todaysTree(6_495_366, days));
  assert.match(calm.notes.join('\n'), /status history: 4 file\(s\) \(3 day file\(s\)\), 10\.4 MB, largest status\/history\/2026-10\.ndjson 6\.5 MB/);
  assert.deepEqual(calm.findings, [], 'a 6.5 MB month file is under its 45 MB line');
  const grown = evaluateSizes(todaysTree(6_495_366, [...days, blob('status/history/2026-10-10.ndjson', 5_200_000)]));
  assert.deepEqual(grown.findings[0]!.members, ['status/history/2026-10-10.ndjson']);
  assert.match(grown.findings[0]!.text, /^status\/history\/2026-10-10\.ndjson: 5\.2 MB, over 5\.0 MB \(the run log/);
  assert.deepEqual(sizeMembers(todaysTree(1, [blob('status/history/2026-10-10.ndjson', 5_000_000)])), []);
  // Only a day file's name gets the day line.
  assert.deepEqual(sizeMembers(todaysTree(1, [blob('status/history/2026-10-10.ndjson.gz', 6_000_000), blob('status/history/notes.txt', 6_000_000)])), []);
  assert.equal(RULES['feed:size'].limits.dayFileBytes, 5_000_000);
  assert.equal(RULES['feed:size'].limits.fileBytes, 45_000_000);
});

test('data file sizes: any layout under status/history is summed and its largest file named (gzip, sub-folders)', () => {
  const days = Array.from({ length: 6 }, (_, i) => blob(`status/history/2026-10/${String(i + 1).padStart(2, '0')}.ndjson`, 1_300_000 + i * 1000));
  const r = evaluateSizes({ truncated: false, tree: [dirEntry('status/history'), dirEntry('status/history/2026-10'), ...days, blob('status/history/2026-09.ndjson.gz', 4_000_000), blob('status.json', 9_000)] });
  assert.match(r.notes.join('\n'), /status history: 7 file\(s\) \(0 day file\(s\)\), 11\.8 MB, largest status\/history\/2026-09\.ndjson\.gz 4\.0 MB/);
  assert.deepEqual(r.findings, []);
  const moved = evaluateSizes({ truncated: false, tree: [blob('logs/status/2026-10.ndjson', 47_000_000)] });
  assert.match(moved.notes.join('\n'), /status history: 0 file\(s\) \(0 day file\(s\)\), 0\.0 MB, largest none/);
  assert.deepEqual(moved.findings[0]!.members, ['logs/status/2026-10.ndjson']);
});

test('data file sizes: a truncated listing is a note; an unreadable answer leaves feed:size unjudged', () => {
  const t = evaluateSizes({ ...todaysTree(), truncated: true });
  assert.match(t.notes.join('\n'), /listing TRUNCATED/);
  assert.match(t.notes.join('\n'), /the data tree listing was truncated, so some files were not judged/);
  assert.deepEqual(t.unjudged, []);
  for (const bad of [null, '', 'not json', { message: 'Not Found' }, { tree: 'x' }]) {
    const r = evaluateSizes(bad);
    assert.deepEqual([r.findings, r.unjudged], [[], ['feed:size']], JSON.stringify(bad));
    assert.match(r.notes.join(), /data tree: unknown/);
  }
  // Entries without a numeric size (submodules, odd shapes) are skipped, not counted.
  const odd = evaluateSizes({ truncated: false, tree: [null, { path: 'status/history/x', type: 'blob' }, { type: 'blob', size: 99_000_000 }, blob('status/history/2026-10.ndjson', 10)] });
  assert.match(odd.notes.join('\n'), /status history: 1 file\(s\) \(0 day file\(s\)\)/);
  assert.deepEqual(odd.findings, []);
});

test('feed:repo-size: over 8,000,000 KB is P3; at the line nothing; not a number unjudged', () => {
  const calm = evaluateRepoSize(6_100_000);
  assert.deepEqual([calm.findings, calm.unjudged, calm.notes], [[], [], ['repository size: 6.10 GB (6100000 KB, line 8000000 KB)']]);
  assert.deepEqual(evaluateRepoSize(8_000_000).findings, []);
  const over = evaluateRepoSize(8_000_001).findings[0]!;
  assert.deepEqual([over.key, over.severity, over.class], ['feed:repo-size', 'P3', 'capacity']);
  assert.match(over.text, /^the repository is 8\.00 GB \(8000001 KB\), over the 8000000 KB line: check what grows/);
  for (const bad of [null, undefined, '8000001', -1, Number.NaN]) assert.deepEqual(evaluateRepoSize(bad).unjudged, ['feed:repo-size']);
});

// --- walk markers ---

const IDS = registryIds(readFileSync(REGISTRY_PATH, 'utf8'));

test('the registry: 42 ids from providers/registry.json; a bare array works; anything else throws', () => {
  assert.equal(IDS.length, 42);
  for (const id of ['usgs', 'emsc', 'geofon', 'tmd', 'ign', 'ga', 'noa']) assert.ok(IDS.includes(id), id);
  assert.deepEqual(registryIds('[{"id":"a"},{"x":1},{"id":"b"}]'), ['a', 'b']);
  assert.throws(() => registryIds('{}'), /no providers list/);
  assert.throws(() => registryIds('not json'));
});

test('parseMarker: each line under the leftmost whole-word registry id, else run', () => {
  const lines = parseMarker(
    [
      'first-solutions emsc: 30 failed runs in a row since 2026-10-20T10:00:00.000Z: HTTP 503',
      '',
      'history: tmd/2024-03 has failed 3 runs since 2026-10-19T00:00:00.000Z (last error: timeout)',
      'backfill: dispatched window 2026-01-01..2026-01-08 of geofon failed: usgs also slow',
      'history: no progress for 24 run(s) since 2026-10-21T00:00:00.000Z; the walk has stopped',
      '2026-09: refused shrink 120 -> 80 events (-40)',
      'run log status/history/2026-08.ndjson: kept',
      'ignore geofon-allorigins and usgs_x, but ga.',
    ].join('\r\n'),
    IDS,
  );
  assert.deepEqual(lines.map((l) => l.source), ['emsc', 'tmd', 'geofon', 'run', 'run', 'run', 'ga']);
  assert.equal(lines[0]!.line, 'first-solutions emsc: 30 failed runs in a row since 2026-10-20T10:00:00.000Z: HTTP 503');
  assert.deepEqual(parseMarker('usgs and emsc', ['emsc', 'usgs']).map((l) => l.source), ['usgs']);
  assert.deepEqual(parseMarker('  \n\n', IDS), []);
  // An id that cannot be part of a key is never used.
  assert.deepEqual(parseMarker('Bad: x', ['Bad']).map((l) => l.source), ['run']);
});

const MARKER_AT = NOW - 2 * HOUR;
const walk = (workflow: string, text: string, createdAtMs = MARKER_AT, runId: number | null = 18_000_001): WalkRead => ({ workflow, ok: true, marker: { createdAtMs, runId, text } });

test('evaluateWalks: a marker under 26 h is one P3 per walks:<workflow>:<source>, lines merged; older, clear or unreadable markers', () => {
  const r = evaluateWalks(
    [
      walk('first-solutions', 'first-solutions emsc: 30 failed runs in a row since 2026-10-20T10:00:00.000Z: HTTP 503\nfirst-solutions emsc: second line\nfirst-solutions geofon: 31 failed runs'),
      walk('backfill', 'backfill: no progress, the walk has stopped'),
      { workflow: 'history', ok: true, marker: null },
      { workflow: 'archive', ok: false, message: 'listing walk-blocked-archive: HTTP 500 after 3 attempt(s)' },
    ],
    NOW,
    IDS,
  );
  assert.deepEqual(keys(r.findings), ['walks:backfill:run', 'walks:first-solutions:emsc', 'walks:first-solutions:geofon']);
  const f = byKey(r.findings)['walks:first-solutions:emsc']!;
  assert.deepEqual([f.rule, f.severity, f.class, f.board, f.sinceMs, f.check], ['walks', 'P3', 'maintenance', 'feed', MARKER_AT, null]);
  assert.equal(mayTurnRed(f.class), false, 'a maintenance walk is never red');
  assert.equal(f.text, `first-solutions emsc: 30 failed runs in a row since 2026-10-20T10:00:00.000Z: HTTP 503 (+1 more) (marker of 2026-10-22 10:14Z, run 18000001)`);
  assert.deepEqual(r.unjudged, ['walks:archive:*']);
  assert.match(r.notes.join('\n'), /walks: archive: marker unreadable \(listing walk-blocked-archive: HTTP 500 after 3 attempt\(s\)\)/);
  // 27 h old: the walk has moved on.
  const old = evaluateWalks([walk('history', 'history: tmd stalled', NOW - 27 * HOUR)], NOW, IDS);
  assert.deepEqual([old.findings, old.unjudged], [[], []]);
  assert.match(old.notes.join(), /history: newest marker 27\.0 h old: the walk has moved on/);
  assert.equal(RULES.walks.limits.markerHoldMs, 26 * HOUR);
  assert.equal(evaluateWalks([walk('history', 'x', NOW - 25.9 * HOUR)], NOW, IDS).findings.length, 1);
  // An empty marker: a note.
  assert.match(evaluateWalks([walk('history', '\n')], NOW, IDS).notes.join(), /is empty/);
  // A very long line is cut to one line of 240.
  const long = evaluateWalks([walk('history', `history: tmd ${'z'.repeat(600)}`)], NOW, IDS).findings[0]!;
  assert.ok(long.text.length < 300);
});

test('pickMarkerArtifact: the newest non-expired artifact of that name; none; a body without a list throws', () => {
  const name = 'walk-blocked-history';
  const art = (id: number, createdAgoH: number, extra: Record<string, unknown> = {}) => ({ id, name, expired: false, created_at: ISO(NOW - createdAgoH * HOUR), workflow_run: { id: id * 10 }, ...extra });
  assert.deepEqual(pickMarkerArtifact({ artifacts: [art(1, 30), art(2, 2), art(3, 5)] }, name), { id: 2, createdAtMs: NOW - 2 * HOUR, runId: 20 });
  assert.deepEqual(pickMarkerArtifact({ artifacts: [art(1, 30), art(2, 2, { expired: true })] }, name), { id: 1, createdAtMs: NOW - 30 * HOUR, runId: 10 });
  assert.equal(pickMarkerArtifact({ artifacts: [art(2, 2, { expired: true })] }, name), null);
  assert.equal(pickMarkerArtifact({ artifacts: [art(2, 2, { name: 'walk-blocked-history-2' })] }, name), null);
  assert.equal(pickMarkerArtifact({ total_count: 0, artifacts: [] }, name), null);
  assert.deepEqual(pickMarkerArtifact({ artifacts: [art(4, 1, { workflow_run: null })] }, name), { id: 4, createdAtMs: NOW - HOUR, runId: null });
  assert.throws(() => pickMarkerArtifact({ message: 'Server Error' }, name), /no artifacts list/);
});

test('readZipEntries: fflate zips, deflated and stored, both read; refuses no zip, too many entries, too large an entry, a lying size', () => {
  const text = 'first-solutions emsc: 30 failed runs in a row\n';
  const deflated = zipSync({ 'blocked.txt': strToU8(text) });
  const stored = zipSync({ 'blocked.txt': [strToU8(text), { level: 0 }] });
  assert.equal(new DataView(stored.buffer).getUint16(8, true), 0, 'stored');
  assert.equal(new DataView(deflated.buffer).getUint16(8, true), 8, 'deflated');
  for (const z of [deflated, stored]) {
    const e = readZipEntries(z);
    assert.deepEqual(e.map((x) => [x.name, x.data.toString('utf8')]), [['blocked.txt', text]]);
  }
  assert.equal(readZipEntries(deflated.buffer.slice(deflated.byteOffset, deflated.byteOffset + deflated.byteLength) as ArrayBuffer).length, 1, 'an ArrayBuffer');
  assert.deepEqual(readZipEntries(zipSync({ 'a.txt': strToU8('a'), 'dir/b.txt': strToU8('b') })).map((x) => x.name), ['a.txt', 'dir/b.txt']);
  assert.throws(() => readZipEntries(Buffer.from('this is not a zip file, just text that is long enough')), /not a zip/);
  assert.throws(() => readZipEntries(new Uint8Array(4)), /too short/);
  assert.throws(() => readZipEntries(zipSync(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`${i}.txt`, strToU8('x')])))), /11 entries, more than 10/);
  assert.throws(() => readZipEntries(zipSync({ 'big.txt': new Uint8Array(ZIP_MAX_ENTRY_BYTES + 1) })), /over 1000000/);
  // A central directory that understates the size never inflates past the limit.
  const bomb = Buffer.from(zipSync({ 'b.txt': new Uint8Array(2_000_000) }));
  const cen = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(100, cen + 24);
  assert.throws(() => readZipEntries(bomb), /cannot inflate/);
  // A cut-off zip.
  assert.throws(() => readZipEntries(deflated.subarray(10)));
});

// --- evaluateFeed and the I/O wrapper ---

const healthyInputs = (over: Partial<FeedInputs> = {}): FeedInputs => ({
  nowMs: NOW,
  v1: okRead(NOW - MIN),
  v2: okRead(NOW - MIN),
  reRead: false,
  queuedMs: 0,
  status: { ok: true, json: statusAt() },
  repoSize: { ok: true, kb: 6_100_000 },
  tree: { ok: true, json: todaysTree() },
  walks: ['history', 'first-solutions', 'backfill', 'archive'].map((workflow) => ({ workflow, ok: true, marker: null })),
  ids: IDS,
  notes: [],
  ...over,
});

test('evaluateFeed: a healthy run is no finding and nothing unjudged; status.json unreadable is feed:status and three unjudged patterns', () => {
  const ok = evaluateFeed(healthyInputs());
  assert.deepEqual([ok.findings, ok.unjudged], [[], []]);
  assert.match(ok.summary, /^v1=60 s \(contract 30 min\) v2=60 s \(contract 30 min\) queued=0 s status=2026-10-22 12:12Z sources=42 failing=\[\] silent=\[\] frozen=\[\] tls_leaf_days=\[phivolcs:27\.7,tmd:171\.6\] walks=history:clear,first-solutions:clear,backfill:clear,archive:clear$/);
  for (const status of [{ ok: false as const, message: 'HTTP 502 after 4 attempt(s)' }, { ok: true as const, json: { generated: 'x' } }, { ok: true as const, json: [] }]) {
    const r = evaluateFeed(healthyInputs({ status }));
    assert.deepEqual(r.findings.map((f) => [f.key, f.severity, f.rule]), [['feed:status', 'P3', 'feed:status']]);
    assert.deepEqual(r.unjudged, ['feed:source:*', 'feed:cert:*', 'feed:systemic']);
    assert.match(r.findings[0]!.text, /^v1\/status\.json unreadable \(.+\): the per-source health of the feed is unknown this run$/);
  }
  // A status.json without a generated time is judged as of now, with a note.
  const noTime = evaluateFeed(healthyInputs({ status: { ok: true, json: statusAt(STATUS_MS, (x) => (delete x.generatedAt, delete x.generated)) } }));
  assert.match(noTime.notes.join(), /carries no generated time/);
  // GitHub parts unreadable: each unjudged.
  const gh = evaluateFeed(healthyInputs({ repoSize: { ok: false, message: 'HTTP 403 after 1 attempt(s)' }, tree: { ok: false, message: 'HTTP 500 after 3 attempt(s)' }, walks: [{ workflow: 'history', ok: false, message: 'x' }] }));
  assert.deepEqual(gh.unjudged, ['feed:repo-size', 'feed:size', 'walks:history:*']);
  assert.match(gh.notes.join('\n'), /repository size: HTTP 403 after 1 attempt\(s\)/);
  // ... and one watcher finding says so (platform board, P3 after 2 runs, never red), or the rows freeze unseen.
  assert.deepEqual(gh.findings.map((f) => [f.key, f.rule, f.board, f.severity, f.class, f.members]), [['watcher:feed-github', 'watcher', 'platform', 'P3', 'watcher', ['repository', 'data-tree', 'walks:history']]]);
  assert.equal(
    gh.findings[0]!.text,
    "feed:repo-size, feed:size, walks:history:* not judged this run: the feed evaluator's GitHub reads failed (check the feed job's GH_TOKEN, actions: read, and GitHub's status): the repository size: HTTP 403 after 1 attempt(s); the data tree: HTTP 500 after 3 attempt(s); the history walk's marker: x",
  );
});

test('evaluateFeed: watcher:feed-github for every GitHub read that fails, the reasons grouped; none in a local run', () => {
  const watcher = (over: Partial<FeedInputs>): Finding | undefined => evaluateFeed(healthyInputs(over)).findings.find((f) => f.key === 'watcher:feed-github');
  // This run's created_at alone: nothing is unjudged, the queue time is 0.
  const queue = watcher({ queueError: 'HTTP 404 after 1 attempt(s)' })!;
  assert.deepEqual(queue.members, ['run']);
  assert.match(queue.text, /^the queue time is unknown this run \(counted as 0\): .*: this run's created_at: HTTP 404 after 1 attempt\(s\)$/);
  // An answer without the field read: a tree answer without its list.
  const noTree = evaluateFeed(healthyInputs({ tree: { ok: true, json: { sha: 'x' } } }));
  assert.deepEqual([noTree.unjudged, noTree.findings.map((f) => [f.key, f.members])], [['feed:size'], [['watcher:feed-github', ['data-tree']]]]);
  // One reason for many reads (GH_TOKEN missing in Actions, a lost permission) is said once.
  const why = 'HTTP 403 after 1 attempt(s)';
  const lost = watcher({ walks: ['history', 'first-solutions', 'backfill', 'archive'].map((workflow) => ({ workflow, ok: false as const, message: why })) })!;
  assert.match(lost.text, /: the history walk's marker, the first-solutions walk's marker, the backfill walk's marker, the archive walk's marker: HTTP 403 after 1 attempt\(s\)$/);
  // Every read fine, or a local run that reads none on purpose: no watcher.
  assert.equal(watcher({}), undefined);
  const local = 'no GH_TOKEN or GITHUB_REPOSITORY (a local run)';
  const skipped = evaluateFeed(healthyInputs({ githubSkipped: local, repoSize: { ok: false, message: local }, tree: { ok: false, message: local }, walks: [{ workflow: 'history', ok: false, message: local }] }));
  assert.deepEqual([skipped.findings, skipped.unjudged], [[], ['feed:repo-size', 'feed:size', 'walks:history:*']]);
});

/** A fetch stub routing by exact URL (or a RegExp); unmatched URLs fail like a network error. Records every call. */
function stub(routes: Array<[string | RegExp, (url: string, n: number) => Response | Promise<Response>]>) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const counts = new Map<string, number>();
  const fetchImpl: FetchImpl = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.authorization ?? null });
    for (const [m, r] of routes) {
      if (typeof m === 'string' ? url === m : m.test(url)) {
        const n = (counts.get(String(m)) ?? 0) + 1;
        counts.set(String(m), n);
        return r(url, n);
      }
    }
    throw new TypeError(`fetch failed (no route for ${url})`);
  };
  return { fetchImpl, calls };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const API_REPO = `${GITHUB_API}/repos/${REPO}`;
const listing = (workflow: string) => `${API_REPO}/actions/artifacts?name=walk-blocked-${workflow}&per_page=10`;

/** A clock that `sleep` advances, so a 60 s re-read moves time like the real one. */
function clock(start = NOW) {
  let t = start;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps };
}

/** The healthy world of 2026-10-22 12:14Z: fresh manifests, the fixture status, a small repository, no walk marker. */
function world(over: Array<[string | RegExp, (url: string, n: number) => Response | Promise<Response>]> = [], createdAt = NOW - 30 * SEC) {
  return stub([
    ...over,
    [MANIFEST_V1_URL, () => json(v1Manifest(NOW - MIN))],
    [MANIFEST_V2_URL, () => json(v2Envelope(NOW - MIN))],
    [STATUS_V1_URL, () => json(statusAt())],
    [`${API_REPO}/actions/runs/4242`, () => json({ id: 4242, created_at: ISO(createdAt) })],
    [API_REPO, () => json({ full_name: REPO, size: 6_100_000 })],
    [`${API_REPO}/git/trees/data?recursive=1`, () => json(todaysTree())],
    [/\/actions\/artifacts\?name=walk-blocked-/, () => json({ total_count: 0, artifacts: [] })],
  ]);
}

test('collect: a stale first read is read again 60 s later (once) and judged on the re-read', async () => {
  const c = clock();
  const w = world([
    [MANIFEST_V1_URL, (_u, n) => json(v1Manifest(n === 1 ? NOW - 40 * MIN : NOW + 30 * SEC))],
    [MANIFEST_V2_URL, (_u, n) => json(v2Envelope(n === 1 ? NOW - 40 * MIN : NOW + 30 * SEC))],
  ]);
  const inputs = await collect({ env: ENV, fetchImpl: w.fetchImpl, now: c.now, sleep: c.sleep });
  assert.equal(c.sleeps.filter((ms) => ms === 60_000).length, 1);
  assert.equal(inputs.reRead, true);
  assert.equal(inputs.nowMs, NOW + 60_000);
  assert.deepEqual(inputs.v1, okRead(NOW + 30 * SEC));
  const r = evaluateFeed(inputs);
  assert.deepEqual(r.findings, []);
  assert.match(r.notes.join('\n'), /re-read both manifests 60 s later \(a manifest was stale at the first read\)/);
  // Still stale at the re-read: P2, "confirmed".
  const c2 = clock();
  const stale = world([
    [MANIFEST_V1_URL, () => json(v1Manifest(NOW - 40 * MIN))],
    [MANIFEST_V2_URL, () => json(v2Envelope(NOW - 40 * MIN))],
  ]);
  const r2 = evaluateFeed(await collect({ env: ENV, fetchImpl: stale.fetchImpl, now: c2.now, sleep: c2.sleep }));
  assert.equal(c2.sleeps.filter((ms) => ms === 60_000).length, 1, 'at most once');
  assert.deepEqual(r2.findings.map((f) => [f.key, f.rule, f.severity]), [['feed:freshness', 'feed:freshness', 'P2']]);
  assert.match(r2.findings[0]!.text, /^live manifest is 41 min stale .*; confirmed by a re-read 60 s later; the feed has stopped publishing/);
  // A failed re-read keeps the first copy.
  const c3 = clock();
  const flaky = world([[MANIFEST_V2_URL, (_u, n) => (n === 1 ? json(v2Envelope(NOW - 40 * MIN)) : json({ message: 'gone' }, 404))]]);
  const in3 = await collect({ env: ENV, fetchImpl: flaky.fetchImpl, now: c3.now, sleep: c3.sleep });
  assert.deepEqual(in3.v2, okRead(NOW - 40 * MIN));
  assert.match(in3.notes.join('\n'), /the re-read failed \(v2\/manifest\.json: HTTP 404 after 1 attempt\(s\)\): v2 is judged on its first copy/);
});

test('collect: a run queued 12 min re-reads even when fresh, and says so; a fresh run on time reads once', async () => {
  const c = clock();
  const w = world([], NOW - 12 * MIN);
  const inputs = await collect({ env: ENV, fetchImpl: w.fetchImpl, now: c.now, sleep: c.sleep });
  assert.equal(inputs.queuedMs, 12 * MIN);
  assert.equal(inputs.reRead, true);
  assert.deepEqual(c.sleeps, [60_000]);
  const r = evaluateFeed(inputs);
  assert.deepEqual(r.findings, []);
  assert.match(r.notes.join('\n'), /re-read both manifests 60 s later \(this run waited 12 min in the runner queue\)/);
  assert.match(r.summary, /queued=12 min re-read/);
  // Queued and stale: the alarm names the queue.
  const c2 = clock();
  const stale = world([[MANIFEST_V2_URL, () => json(v2Envelope(NOW - 50 * MIN))]], NOW - 12 * MIN);
  const f = evaluateFeed(await collect({ env: ENV, fetchImpl: stale.fetchImpl, now: c2.now, sleep: c2.sleep })).findings[0]!;
  assert.match(f.text, /confirmed by a re-read 60 s later — this run itself waited 12 min in the runner queue; v1 is fresh, so the signing of v2 has stopped/);
  // On time and fresh: one read, no sleep at all.
  const c3 = clock();
  const calm = world();
  const in3 = await collect({ env: ENV, fetchImpl: calm.fetchImpl, now: c3.now, sleep: c3.sleep });
  assert.deepEqual([in3.reRead, c3.sleeps, in3.queuedMs], [false, [], 30 * SEC]);
  assert.equal(calm.calls.filter((x) => x.url === MANIFEST_V1_URL).length, 1);
});

test('collect: manifests use 4 tries 3 s apart; a 404 or a garbage v2 payload is the unreachable rule', async () => {
  const c = clock();
  const w = world([[MANIFEST_V2_URL, () => new Response('Bad Gateway', { status: 502 })]]);
  const inputs = await collect({ env: ENV, fetchImpl: w.fetchImpl, now: c.now, sleep: c.sleep });
  assert.equal(w.calls.filter((x) => x.url === MANIFEST_V2_URL).length, 4);
  assert.deepEqual(c.sleeps, [3_000, 3_000, 3_000]);
  const f = evaluateFeed(inputs).findings[0]!;
  assert.deepEqual([f.rule, f.members], ['feed:freshness:unreachable', ['v2']]);
  assert.match(f.text, /HTTP 502 after 4 attempt\(s\)/);
  const c2 = clock();
  const garbage = world([[MANIFEST_V2_URL, () => json({ payload: 'bm90IGpzb24=', sig: 'x', kid: 'y' })]]);
  const g = evaluateFeed(await collect({ env: ENV, fetchImpl: garbage.fetchImpl, now: c2.now, sleep: c2.sleep })).findings[0]!;
  assert.deepEqual([g.rule, g.members], ['feed:freshness:unreachable', ['v2']]);
  assert.match(g.text, /payload is not JSON/);
  const c3 = clock();
  const gone = world([[MANIFEST_V2_URL, () => json({ message: 'Not Found' }, 404)]]);
  assert.equal(evaluateFeed(await collect({ env: ENV, fetchImpl: gone.fetchImpl, now: c3.now, sleep: c3.sleep })).findings[0]!.rule, 'feed:freshness:unreachable');
  assert.deepEqual(c3.sleeps, [], 'a 404 is not retried');
});

test('collect: walk markers: the newest artifact under 26 h is downloaded and read; older or expired ones are not; failures leave the walk unjudged', async () => {
  const marker = 'first-solutions emsc: 30 failed runs in a row since 2026-10-20T10:00:00.000Z: HTTP 503\n';
  const artifact = (id: number, agoMs: number, extra: Record<string, unknown> = {}) => ({ id, name: '', expired: false, created_at: ISO(NOW - agoMs), workflow_run: { id: 900 + id }, ...extra });
  const c = clock();
  const w = world([
    [listing('first-solutions'), () => json({ total_count: 2, artifacts: [{ ...artifact(11, 2 * HOUR), name: 'walk-blocked-first-solutions' }, { ...artifact(10, 30 * HOUR), name: 'walk-blocked-first-solutions' }] })],
    [`${API_REPO}/actions/artifacts/11/zip`, () => new Response(zipSync({ 'blocked.txt': strToU8(marker) }))],
    [listing('backfill'), () => json({ total_count: 1, artifacts: [{ ...artifact(20, 27 * HOUR), name: 'walk-blocked-backfill' }] })],
    [listing('archive'), () => json({ total_count: 2, artifacts: [{ ...artifact(31, HOUR, { expired: true }), name: 'walk-blocked-archive' }] })],
    [listing('history'), () => new Response('oops', { status: 500 })],
  ]);
  const r = evaluateFeed(await collect({ env: ENV, fetchImpl: w.fetchImpl, now: c.now, sleep: c.sleep }));
  assert.deepEqual(keys(r.findings), ['walks:first-solutions:emsc', 'watcher:feed-github']);
  assert.match(r.findings[0]!.text, /\(marker of 2026-10-22 10:14Z, run 911\)$/);
  assert.deepEqual(r.unjudged, ['walks:history:*']);
  assert.match(byKey(r.findings)['watcher:feed-github']!.text, /^walks:history:\* not judged this run: .*: the history walk's marker: listing walk-blocked-history: HTTP 500 after 3 attempt\(s\)$/);
  assert.match(r.notes.join('\n'), /walks: history: marker unreadable \(listing walk-blocked-history: HTTP 500 after 3 attempt\(s\)\)/);
  assert.match(r.notes.join('\n'), /walks: backfill: newest marker 27\.0 h old: the walk has moved on/);
  const zips = w.calls.filter((x) => x.url.endsWith('/zip')).map((x) => x.url);
  assert.deepEqual(zips, [`${API_REPO}/actions/artifacts/11/zip`], 'only the young, unexpired marker is downloaded');
  // A stored zip reads the same; a non-zip is a note and leaves the walk unjudged.
  const c2 = clock();
  const w2 = world([
    [listing('history'), () => json({ artifacts: [{ ...artifact(40, HOUR), name: 'walk-blocked-history' }] })],
    [`${API_REPO}/actions/artifacts/40/zip`, () => new Response(zipSync({ 'history-blocked.txt': [strToU8('history: no progress for 24 run(s)\n'), { level: 0 }] }))],
    [listing('archive'), () => json({ artifacts: [{ ...artifact(41, HOUR), name: 'walk-blocked-archive' }] })],
    [`${API_REPO}/actions/artifacts/41/zip`, () => new Response('<html>not a zip</html>')],
  ]);
  const r2 = evaluateFeed(await collect({ env: ENV, fetchImpl: w2.fetchImpl, now: c2.now, sleep: c2.sleep }));
  assert.deepEqual(keys(r2.findings), ['walks:history:run', 'watcher:feed-github']);
  assert.deepEqual(byKey(r2.findings)['watcher:feed-github']!.members, ['walks:archive']);
  assert.deepEqual(r2.unjudged, ['walks:archive:*']);
  assert.match(r2.notes.join('\n'), /artifact 41 of walk-blocked-archive: not a readable zip \(not a zip/);
});

test('main --findings: a healthy run writes a valid document and exits 0; only GitHub calls carry the token, and it is never logged', async () => {
  const c = clock();
  const w = world();
  const logs: string[] = [];
  const written: Record<string, string> = {};
  const code = await main({ argv: ['--findings', 'findings/feed.json'], env: ENV, fetchImpl: w.fetchImpl, now: c.now, sleep: c.sleep, log: (l) => logs.push(l), writeFile: (p, d) => void (written[p] = d) });
  assert.equal(code, 0);
  const doc = JSON.parse(written['findings/feed.json']!);
  const parsed = parseFindingsDocument(doc);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual([doc.evaluator, doc.generatedAtMs, doc.findings, doc.unjudged], ['feed', NOW, [], []]);
  for (const call of w.calls) {
    if (call.url.startsWith(`${GITHUB_API}/`)) assert.equal(call.auth, `Bearer ${TOKEN}`, call.url);
    else assert.equal(call.auth, null, call.url);
  }
  assert.ok(!logs.join('\n').includes(TOKEN));
  assert.match(logs[0]!, /^feed health: v1=60 s/);
});

test('main --findings: an unhealthy feed is still exit 0, with plain log lines (no annotations) and a step summary', async () => {
  const c = clock();
  const w = world([
    [STATUS_V1_URL, () => json(tmdStatus(STATUS_MS))],
    [API_REPO, () => json({ size: 8_100_000 })],
  ]);
  const logs: string[] = [];
  const written: Record<string, string> = {};
  const dir = mkdtempSync(join(tmpdir(), 'feed-health-'));
  const summary = join(dir, 'summary.md');
  const code = await main({ argv: ['--findings', 'f.json'], env: { ...ENV, GITHUB_STEP_SUMMARY: summary }, fetchImpl: w.fetchImpl, now: c.now, sleep: c.sleep, log: (l) => logs.push(l), writeFile: (p, d) => void (written[p] = d) });
  assert.equal(code, 0);
  const doc = JSON.parse(written['f.json']!);
  assert.deepEqual(doc.findings.map((f: Finding) => f.key).sort(), ['feed:repo-size', 'feed:source:tmd']);
  assert.ok(!logs.some((l) => l.startsWith('::')), 'reconcile annotates findings, the evaluator does not');
  assert.ok(logs.some((l) => /^finding P3 feed:source:tmd \[feed:source:definite\] since 2026-10-17 /.test(l)), logs.join('\n'));
  const md = readFileSync(summary, 'utf8');
  assert.match(md, /^### Feed health\n/);
  assert.match(md, /\| P3 \| `feed:source:tmd` \| feed:source:definite \|/);
});

test('main: every network call failing still writes a document: unreachable manifests, feed:status, every GitHub part unjudged; exit 0', async () => {
  const c = clock();
  const w = stub([]);
  const written: Record<string, string> = {};
  const code = await main({ argv: ['--findings', 'f.json'], env: ENV, fetchImpl: w.fetchImpl, now: c.now, sleep: c.sleep, log: () => {}, writeFile: (p, d) => void (written[p] = d) });
  assert.equal(code, 0);
  const doc = JSON.parse(written['f.json']!);
  assert.ok(parseFindingsDocument(doc).ok);
  assert.deepEqual(doc.findings.map((f: Finding) => [f.key, f.rule, f.severity, f.members ?? null]), [
    ['feed:freshness', 'feed:freshness:unreachable', 'P2', ['v1', 'v2']],
    ['feed:status', 'feed:status', 'P3', null],
    ['watcher:feed-github', 'watcher', 'P3', ['run', 'repository', 'data-tree', 'walks:history', 'walks:first-solutions', 'walks:backfill', 'walks:archive']],
  ]);
  assert.match(doc.findings[2].text, /^feed:repo-size, feed:size, walks:history:\*, walks:first-solutions:\*, walks:backfill:\*, walks:archive:\* not judged this run: the feed evaluator's GitHub reads failed/);
  assert.ok(doc.findings[2].text.length <= 500);
  assert.deepEqual(doc.unjudged, ['feed:source:*', 'feed:cert:*', 'feed:systemic', 'feed:repo-size', 'feed:size', 'walks:history:*', 'walks:first-solutions:*', 'walks:backfill:*', 'walks:archive:*']);
  assert.match(doc.notes.join('\n'), /queue time unknown \(network error: .*\): counted as 0/);
});

test('main: no GH_TOKEN (a local run): the GitHub parts are unjudged, nothing is asked of GitHub, the document is printed; exit 0', async () => {
  const c = clock();
  const w = world();
  const logs: string[] = [];
  const code = await main({ argv: [], env: {}, fetchImpl: w.fetchImpl, now: c.now, sleep: c.sleep, log: (l) => logs.push(l) });
  assert.equal(code, 0);
  assert.equal(w.calls.filter((x) => x.url.startsWith(GITHUB_API)).length, 0);
  const printed = logs.find((l) => l.startsWith('{'))!;
  const doc = JSON.parse(printed);
  assert.ok(parseFindingsDocument(doc).ok);
  assert.deepEqual(doc.findings, []);
  assert.deepEqual(doc.unjudged, ['feed:repo-size', 'feed:size', 'walks:history:*', 'walks:first-solutions:*', 'walks:backfill:*', 'walks:archive:*']);
  assert.match(doc.notes.join(), /GitHub parts not judged: no GH_TOKEN or GITHUB_REPOSITORY \(a local run\)/);
  // A token without the run id: the queue time is 0, with a note.
  const c2 = clock();
  const inputs = await collect({ env: { GH_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO }, fetchImpl: world().fetchImpl, now: c2.now, sleep: c2.sleep });
  assert.equal(inputs.queuedMs, 0);
  assert.match(inputs.notes.join(), /no GITHUB_RUN_ID/);
});

test('main: in Actions, no GH_TOKEN or a failed created_at read is watcher:feed-github; a truncated tree listing is a warning', async () => {
  const written: Record<string, string> = {};
  const findingsOf = async (env: Record<string, string>, w = world()): Promise<{ doc: { findings: Finding[]; unjudged: string[] }; logs: string[] }> => {
    const c = clock();
    const logs: string[] = [];
    assert.equal(await main({ argv: ['--findings', 'f.json'], env, fetchImpl: w.fetchImpl, now: c.now, sleep: c.sleep, log: (l) => logs.push(l), writeFile: (p, d) => void (written[p] = d) }), 0);
    const doc = JSON.parse(written['f.json']!);
    assert.ok(parseFindingsDocument(doc).ok);
    return { doc, logs };
  };
  // GH_TOKEN dropped from the feed job: every GitHub part unjudged, and the watcher names the cause once.
  const noToken = (await findingsOf({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: '4242' })).doc;
  assert.deepEqual(noToken.unjudged, ['feed:repo-size', 'feed:size', 'walks:history:*', 'walks:first-solutions:*', 'walks:backfill:*', 'walks:archive:*']);
  assert.deepEqual(noToken.findings.map((f) => [f.key, f.members]), [['watcher:feed-github', ['run', 'repository', 'data-tree', 'walks:history', 'walks:first-solutions', 'walks:backfill', 'walks:archive']]]);
  assert.match(noToken.findings[0]!.text, /: this run's created_at, the repository size, the data tree, the history walk's marker, .*the archive walk's marker: GH_TOKEN or GITHUB_REPOSITORY is not set in the job$/);
  // This run's created_at unreadable: the queue time is 0, and the watcher says why.
  const runGone = await findingsOf(ENV, world([[`${API_REPO}/actions/runs/4242`, () => json({ message: 'Not Found' }, 404)]]));
  assert.deepEqual(runGone.doc.findings.map((f) => [f.key, f.members]), [['watcher:feed-github', ['run']]]);
  assert.deepEqual(runGone.doc.unjudged, []);
  assert.match(runGone.doc.findings[0]!.text, /^the queue time is unknown this run \(counted as 0\): .*: this run's created_at: HTTP 404 after 1 attempt\(s\)$/);
  // A truncated listing is judged as far as it goes, with the warning the health job always gave.
  const truncated = await findingsOf(ENV, world([[`${API_REPO}/git/trees/data?recursive=1`, () => json({ ...todaysTree(), truncated: true })]]));
  assert.deepEqual([truncated.doc.findings, truncated.doc.unjudged], [[], []]);
  assert.deepEqual(truncated.logs.filter((l) => l.startsWith('::')), ['::warning title=Data file size::the data tree listing was truncated, so some files were not judged']);
  assert.ok(!(await findingsOf(ENV)).logs.some((l) => l.startsWith('::')));
});

test('main: the registry unreadable files marker lines by status.json\'s ids', async () => {
  const c = clock();
  const w = world([
    [listing('history'), () => json({ artifacts: [{ id: 5, name: 'walk-blocked-history', expired: false, created_at: ISO(NOW - HOUR), workflow_run: { id: 6 } }] })],
    [`${API_REPO}/actions/artifacts/5/zip`, () => new Response(zipSync({ 'history-blocked.txt': strToU8('history: tmd/2024-03 has failed 3 runs\n') }))],
  ]);
  const inputs = await collect({ env: ENV, fetchImpl: w.fetchImpl, now: c.now, sleep: c.sleep, readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(inputs.ids.length, 42);
  assert.match(inputs.notes.join(), /providers\/registry\.json unreadable \(ENOENT\)/);
  assert.deepEqual(keys(evaluateFeed(inputs).findings), ['walks:history:tmd']);
});

test('main: exit 3 for a bad argument or an unwritable --findings path; the default writer creates the directory', async () => {
  const logs: string[] = [];
  assert.equal(await main({ argv: ['--findings'], env: {}, fetchImpl: stub([]).fetchImpl, log: (l) => logs.push(l) }), 3);
  assert.match(logs.join('\n'), /^::error title=Feed health misconfigured::--findings needs a path$/m);
  assert.equal(await main({ argv: ['--bogus'], env: {}, fetchImpl: stub([]).fetchImpl, log: () => {} }), 3);
  assert.throws(() => parseArgs(['--findings', '--x']), /needs a path/);
  assert.deepEqual(parseArgs(['--findings', 'a/b.json']), { findingsPath: 'a/b.json' });
  const c = clock();
  const out: string[] = [];
  const code = await main({ argv: ['--findings', 'x.json'], env: ENV, fetchImpl: world().fetchImpl, now: c.now, sleep: c.sleep, log: (l) => out.push(l), writeFile: () => { throw new Error('EACCES: permission denied'); } });
  assert.equal(code, 3);
  assert.match(out.join('\n'), /^::error title=Feed health could not write its findings::x\.json: EACCES: permission denied$/m);
  // The real writer: findings/feed.json in a fresh checkout has no findings/ yet.
  const dir = mkdtempSync(join(tmpdir(), 'feed-health-write-'));
  const path = join(dir, 'findings', 'feed.json');
  const c2 = clock();
  assert.equal(await main({ argv: ['--findings', path], env: ENV, fetchImpl: world().fetchImpl, now: c2.now, sleep: c2.sleep, log: () => {} }), 0);
  assert.ok(existsSync(path));
  assert.ok(parseFindingsDocument(JSON.parse(readFileSync(path, 'utf8'))).ok);
});
