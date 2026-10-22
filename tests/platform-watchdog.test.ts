import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { STATUS_URL } from '../scripts/alerts-watchdog.mjs';
import type { FetchImpl, FetchResult } from '../scripts/alerts-watchdog.mjs';
import { RULES, parseFindingsDocument } from '../scripts/lib/findings.mjs';
import type { Finding, FindingsDocument } from '../scripts/lib/findings.mjs';
import {
  API_HEALTH_URL,
  API_RETRY,
  CONFIG_HEALTH_URL,
  PLATFORM_KEYS,
  evaluateApiHealth,
  evaluateConfigBundle,
  evaluateConfigHealth,
  main,
  parseArgs,
  plainExitCode,
} from '../scripts/platform-watchdog.mjs';

// X-4 and the alerting plan of 2026-10-22 (section 3c): the platform findings evaluator (scripts/platform-watchdog.mjs,
// health.yml job `platform`). API and config bodies are the live prod answers of 2026-10-04; status.json documents are
// structuredClone of tests/fixtures/alerts-status/healthy.json with patches. Nothing here touches the network.

const HEALTHY_STATUS = JSON.parse(readFileSync(new URL('./fixtures/alerts-status/healthy.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const API_OK = { ok: true, env: 'prod', dbAdapter: 'd1', dialect: 'sqlite', sessionKeySource: 'secret', providerTokenEnvelope: 'set', time: '2026-10-04T09:53:50.192Z' };
const CONFIG_OK = { ok: true, source: 'kv', version: 50 };
const SEC = 1_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-22T12:00:00Z');
/** `x` days in ms, rounded (5.1 * DAY is not an integer in floating point). */
const d = (x: number): number => Math.round(x * DAY);

const ok = (json: unknown): FetchResult => ({ ok: true as const, status: 200, json, attempts: 1 });
const noSleep = async (): Promise<void> => {};
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fresh status.json (30 s old as of `nowMs`) with the healthy fixture's fields and `patch`. */
function statusDoc(nowMs: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...structuredClone(HEALTHY_STATUS), generatedAtMs: nowMs - 30 * SEC, ...patch };
}

/** The round-13 freshness block: the bundle copy (and, by default, the policy) generated `bundleAgeMs` ago. */
function freshness(nowMs: number, bundleAgeMs: number, { version = 65, policyAgeMs = bundleAgeMs }: { version?: number | null; policyAgeMs?: number | null } = {}): Record<string, unknown> {
  return {
    feed_manifest_generated_ms: nowMs - 600 * SEC,
    feed_manifest_age_s: 570,
    config_bundle_generated_ms: nowMs - bundleAgeMs,
    config_bundle_version: version,
    config_bundle_age_s: Math.round(bundleAgeMs / SEC) - 30,
    config_policy_generated_ms: policyAgeMs === null ? null : nowMs - policyAgeMs,
    config_policy_age_s: policyAgeMs === null ? null : Math.round(policyAgeMs / SEC) - 30,
  };
}

const bundleAt = (bundleAgeMs: number, opts: { version?: number | null; policyAgeMs?: number | null; hostVersion?: number | null } = {}) =>
  evaluateConfigBundle({ status: ok(statusDoc(NOW, freshness(NOW, bundleAgeMs, opts))), hostVersion: opts.hostVersion === undefined ? (opts.version ?? 65) : opts.hostVersion, nowMs: NOW });

const keySev = (fs: ReadonlyArray<Finding>) => fs.map((f) => `${f.key} ${f.severity}`);

// ---------------------------------------------------------------------------------------------------------
// API

test('api health: ok gives no finding; an ephemeral session key is platform:api P2; a missing envelope key platform:api:envelope P3', () => {
  assert.deepEqual(evaluateApiHealth(ok(API_OK)), { findings: [], unjudged: [], summary: 'api=ok env=prod db=d1 sessionKey=secret envelope=set' });

  const eph = evaluateApiHealth(ok({ ...API_OK, sessionKeySource: 'ephemeral' }));
  assert.equal(eph.findings.length, 1);
  const f = eph.findings[0]!;
  assert.deepEqual(
    { key: f.key, rule: f.rule, board: f.board, severity: f.severity, class: f.class, check: f.check, shadow: f.shadow, sinceMs: f.sinceMs },
    { key: 'platform:api', rule: 'platform:api', board: 'platform', severity: 'P2', class: 'symptom', check: 'gh-platform', shadow: false, sinceMs: null },
  );
  assert.match(f.text, /EPHEMERAL/);
  assert.deepEqual(eph.unjudged, []);

  const env = evaluateApiHealth(ok({ ...API_OK, providerTokenEnvelope: 'missing' }));
  assert.deepEqual(keySev(env.findings), ['platform:api:envelope P3']);
  assert.equal(env.findings[0]!.check, null);
  assert.equal(env.findings[0]!.class, 'config');
  assert.match(env.findings[0]!.text, /account deletion cannot revoke at Apple/);

  const both = evaluateApiHealth(ok({ ...API_OK, sessionKeySource: 'ephemeral', providerTokenEnvelope: 'missing' }));
  assert.deepEqual(keySev(both.findings), ['platform:api P2', 'platform:api:envelope P3']);
});

test('api health: a 200 without ok:true is platform:api P2, and the envelope is then not judged', () => {
  for (const body of [{ ok: false }, { ok: 'true' }, [1, 2], 'ok', null]) {
    const v = evaluateApiHealth(ok(body));
    assert.deepEqual(keySev(v.findings), ['platform:api P2'], JSON.stringify(body));
    assert.match(v.findings[0]!.text, /answered without ok:true/);
    assert.deepEqual(v.unjudged, ['platform:api:envelope']);
    assert.equal(v.summary, 'api=NOT-OK');
  }
});

test('api health: an unreachable or failing host is platform:api P2 with the reason; the envelope is not judged', () => {
  const down = evaluateApiHealth({ ok: false, kind: 'http', status: 522, retryable: true, message: 'HTTP 522', body: '<html>Connection timed out</html>', attempts: 3 });
  assert.equal(down.summary, 'api=DOWN');
  assert.deepEqual(keySev(down.findings), ['platform:api P2']);
  assert.match(down.findings[0]!.text, /DOWN: HTTP 522 after 3 attempt\(s\): <html>Connection timed out<\/html>/);
  assert.deepEqual(down.unjudged, ['platform:api:envelope']);
  const net = evaluateApiHealth({ ok: false, kind: 'network', retryable: true, message: 'network error: fetch failed (ENOTFOUND)', attempts: 3 });
  assert.match(net.findings[0]!.text, /DOWN: network error: fetch failed \(ENOTFOUND\) after 3 attempt/);
  const parse = evaluateApiHealth({ ok: false, kind: 'parse', status: 200, retryable: true, message: 'invalid JSON (Unexpected token)', attempts: 3 });
  assert.match(parse.findings[0]!.text, /DOWN: HTTP 200, invalid JSON/);
  // A multi-line error page stays one line in the finding.
  const page = evaluateApiHealth({ ok: false, kind: 'http', status: 502, retryable: true, message: 'HTTP 502', body: 'Bad\ngateway\n`x`', attempts: 3 });
  assert.doesNotMatch(page.findings[0]!.text, /[\n`]/);
});

test('API_RETRY: 3 tries spread over at least 60 s, from RULES', () => {
  assert.equal(API_RETRY.attempts, RULES['platform:api'].limits.attempts);
  assert.deepEqual([...API_RETRY.backoffMs], [30_000, 30_000]);
  assert.ok(API_RETRY.backoffMs.reduce((a, b) => a + b, 0) >= (RULES['platform:api'].limits.spreadMs as number));
});

// ---------------------------------------------------------------------------------------------------------
// Config Worker

test('config health: ok passes with its version; a 503 (no bundle) is platform:config-worker P3', () => {
  assert.deepEqual(evaluateConfigHealth(ok(CONFIG_OK)), { findings: [], summary: 'config=ok source=kv version=50', version: 50 });
  const down = evaluateConfigHealth({ ok: false, kind: 'http', status: 503, retryable: true, message: 'HTTP 503', body: '{"ok":false,"source":null,"version":null}', attempts: 3 });
  assert.equal(down.summary, 'config=DOWN');
  assert.equal(down.version, null);
  assert.deepEqual(keySev(down.findings), ['platform:config-worker P3']);
  const f = down.findings[0]!;
  assert.deepEqual({ rule: f.rule, board: f.board, class: f.class, check: f.check }, { rule: 'platform:config-worker', board: 'platform', class: 'symptom', check: null });
  assert.match(f.text, /config\.theshelter\.app\/healthz is DOWN: HTTP 503 after 3 attempt\(s\): \{"ok":false/);
  const notOk = evaluateConfigHealth(ok({ ok: false, version: 66 }));
  assert.deepEqual(keySev(notOk.findings), ['platform:config-worker P3']);
  assert.equal(notOk.version, null, 'an unhealthy host does not vouch for its version');
});

test('config health: ok:true without a usable version gives version null and no finding', () => {
  for (const version of [undefined, null, '66', 0, -1, Number.NaN]) {
    const v = evaluateConfigHealth(ok({ ok: true, source: 'r2', version }));
    assert.deepEqual(v.findings, []);
    assert.equal(v.version, null, String(version));
  }
  assert.equal(evaluateConfigHealth(ok({ ok: true, source: 'r2', version: 66 })).version, 66);
});

// ---------------------------------------------------------------------------------------------------------
// config:bundle by age

test('config bundle age: 4.9 d none, 5.1 d P3, 10.1 d P2 (gh-platform), 25.1 d P1 (gh-deliver)', () => {
  assert.deepEqual(bundleAt(d(4.9)), { findings: [], unjudged: [], notes: [], summary: 'config_bundle=v65 age=4.9d policy=4.9d host=v65' });

  const p3 = bundleAt(d(5.1)).findings;
  assert.equal(p3.length, 1);
  const f = p3[0]!;
  assert.deepEqual(
    { key: f.key, rule: f.rule, board: f.board, severity: f.severity, class: f.class, check: f.check, members: f.members, sinceMs: f.sinceMs },
    { key: 'config:bundle', rule: 'config:bundle:age', board: 'platform', severity: 'P3', class: 'expiry', check: null, members: ['age'], sinceMs: NOW - d(5.1) + 5 * DAY },
  );
  assert.match(f.text, /\(v65, generated 2026-10-17 09:36Z\) is 5\.1 d old/);
  assert.match(f.text, /over the 5 d line \(P3 over 5 d, P2 over 10 d, P1 over 25 d; at 30 d the bundle expires and apps fall back to compiled defaults\): the config refresh has stopped or failed$/);

  const p2 = bundleAt(d(10.1)).findings;
  assert.deepEqual(p2.map((x) => [x.severity, x.check, x.rule]), [['P2', 'gh-platform', 'config:bundle:age']]);
  assert.match(p2[0]!.text, /over the 10 d line/);
  const p1 = bundleAt(d(25.1)).findings;
  assert.deepEqual(p1.map((x) => [x.severity, x.check, x.rule]), [['P1', 'gh-deliver', 'config:bundle:age']]);
  assert.match(p1[0]!.text, /over the 25 d line/);
  // The lines are "over": exactly 5 d is not yet P3.
  assert.deepEqual(bundleAt(5 * DAY).findings, []);
});

test('config bundle age: the older of the bundle copy and the signed policy drives it', () => {
  const v = bundleAt(1 * DAY, { policyAgeMs: 6 * DAY });
  assert.deepEqual(keySev(v.findings), ['config:bundle P3']);
  assert.equal(v.findings[0]!.sinceMs, NOW - 6 * DAY + 5 * DAY, 'since the policy crossed the 5 d line');
  assert.match(v.findings[0]!.text, /is 24\.0 h old, the signed alerts policy 6\.0 d \(generated 2026-10-16 12:00Z\): over the 5 d line/);
  // The bundle older than the policy drives it the other way round.
  const b = bundleAt(11 * DAY, { policyAgeMs: 2 * DAY });
  assert.deepEqual(keySev(b.findings), ['config:bundle P2']);
  assert.equal(b.findings[0]!.sinceMs, NOW - 11 * DAY + 5 * DAY);
});

test('config bundle age: from *_age_s plus the document\'s own age when *_generated_ms is absent', () => {
  const doc = statusDoc(NOW, { generatedAtMs: NOW - 120 * SEC, config_bundle_age_s: 5 * 86_400 - 60, config_bundle_version: 65, config_policy_age_s: 3_600 });
  const v = evaluateConfigBundle({ status: ok(doc), hostVersion: 65, nowMs: NOW });
  assert.deepEqual(keySev(v.findings), ['config:bundle P3'], '5 d - 60 s published, plus 120 s since the publish');
  assert.equal(v.findings[0]!.sinceMs, NOW - (5 * DAY + 60 * SEC) + 5 * DAY);
  const younger = evaluateConfigBundle({ status: ok({ ...doc, generatedAtMs: NOW - 30 * SEC }), hostVersion: 65, nowMs: NOW });
  assert.deepEqual(younger.findings, [], '5 d - 30 s is under the line');
});

test('config bundle: null ages are a note and leave the key unjudged; absent fields (an older gateway) give nothing', () => {
  const nulls = evaluateConfigBundle({
    status: ok(statusDoc(NOW, { config_bundle_generated_ms: null, config_bundle_version: null, config_bundle_age_s: null, config_policy_generated_ms: null, config_policy_age_s: null })),
    hostVersion: 66,
    nowMs: NOW,
  });
  assert.deepEqual(nulls.findings, []);
  assert.deepEqual(nulls.unjudged, ['config:bundle']);
  assert.ok(nulls.notes.some((n) => /no config bundle or policy age/.test(n)), nulls.notes.join('\n'));
  assert.equal(nulls.summary, 'config_bundle=v? age=? policy=? host=v66');

  // The policy null (the compiled fallback runs: alerts:policy judges that) while the copy is known: a note only.
  const policyNull = bundleAt(1 * DAY, { policyAgeMs: null });
  assert.deepEqual(policyNull.findings, []);
  assert.deepEqual(policyNull.unjudged, []);
  assert.ok(policyNull.notes.some((n) => /config_policy_age_s is null/.test(n)));
  assert.deepEqual(keySev(bundleAt(6 * DAY, { policyAgeMs: null }).findings), ['config:bundle P3']);

  // The healthy fixture predates the freshness block.
  const absent = evaluateConfigBundle({ status: ok(statusDoc(NOW)), hostVersion: 66, nowMs: NOW });
  assert.deepEqual(absent, { findings: [], unjudged: [], notes: [], summary: 'config_bundle=n/a' });
});

// ---------------------------------------------------------------------------------------------------------
// config:bundle by the version gap

test('config bundle gap: the copy behind the host is config:bundle:gap P3; equal is clear; a copy ahead is a note', () => {
  const gap = bundleAt(1 * DAY, { version: 65, hostVersion: 66 });
  assert.equal(gap.findings.length, 1);
  const f = gap.findings[0]!;
  assert.deepEqual(
    { key: f.key, rule: f.rule, severity: f.severity, class: f.class, check: f.check, members: f.members, sinceMs: f.sinceMs },
    { key: 'config:bundle', rule: 'config:bundle:gap', severity: 'P3', class: 'config', check: null, members: ['gap'], sinceMs: null },
  );
  assert.equal(f.text, "the data copy serves v65 while config.theshelter.app serves v66: an upload stopped partway (re-run the config refresh's failed jobs)");
  assert.equal(RULES[f.rule].holdMs, 24 * 3_600_000, 'reconcile holds the gap 24 h');

  assert.deepEqual(bundleAt(1 * DAY, { version: 66, hostVersion: 66 }), { findings: [], unjudged: [], notes: [], summary: 'config_bundle=v66 age=24.0h policy=24.0h host=v66' });

  const ahead = bundleAt(1 * DAY, { version: 67, hostVersion: 66 });
  assert.deepEqual(ahead.findings, []);
  assert.deepEqual(ahead.unjudged, []);
  assert.ok(ahead.notes.some((n) => /serves v67, ahead of config\.theshelter\.app \(v66\)/.test(n)));
});

test('config bundle gap: not judged while healthz is down, status.json unreadable, or the copy version null', () => {
  const hostDown = bundleAt(1 * DAY, { version: 65, hostVersion: null });
  assert.deepEqual(hostDown.findings, []);
  assert.deepEqual(hostDown.unjudged, ['config:bundle']);
  assert.ok(hostDown.notes.some((n) => /healthz gave no bundle version/.test(n)));

  const unreadable: Array<[string, FetchResult]> = [
    ['fetch failure', { ok: false, kind: 'http', status: 503, retryable: true, message: 'HTTP 503', attempts: 3 }],
    ['network', { ok: false, kind: 'network', retryable: true, message: 'timed out after 15000 ms', attempts: 3 }],
    ['not an object', ok([1, 2])],
    ['null body', ok(null)],
    ['no generatedAtMs', ok({ ...statusDoc(NOW, freshness(NOW, DAY, { version: 65 })), generatedAtMs: 'yesterday' })],
  ];
  for (const [name, status] of unreadable) {
    const v = evaluateConfigBundle({ status, hostVersion: 66, nowMs: NOW });
    assert.deepEqual(v.findings, [], name);
    assert.deepEqual(v.unjudged, ['config:bundle'], name);
    assert.match(v.notes[0]!, /status\.json is unreadable/, name);
    assert.equal(v.summary, 'config_bundle=unreadable', name);
  }

  const versionNull = bundleAt(1 * DAY, { version: null, hostVersion: 66 });
  assert.deepEqual(versionNull.findings, []);
  assert.deepEqual(versionNull.unjudged, ['config:bundle']);
});

test('config bundle: a stale status.json judges the age only, the gap is unjudged', () => {
  const stale = (bundleAgeMs: number, docAgeMs: number) =>
    evaluateConfigBundle({ status: ok(statusDoc(NOW, { ...freshness(NOW, bundleAgeMs, { version: 65 }), generatedAtMs: NOW - docAgeMs })), hostVersion: 66, nowMs: NOW });
  const young = stale(1 * DAY, 301 * SEC);
  assert.deepEqual(young.findings, [], 'the gap of a stale copy is not judged');
  assert.deepEqual(young.unjudged, ['config:bundle']);
  assert.ok(young.notes.some((n) => /status\.json is 301 s old \(over the 300 s line\)/.test(n)), young.notes.join('\n'));
  assert.match(young.summary, /status=STALE/);

  const old = stale(6 * DAY, 3_600 * SEC);
  assert.deepEqual(keySev(old.findings), ['config:bundle P3']);
  assert.deepEqual(old.findings[0]!.members, ['age'], 'no gap member from a stale document');
  assert.deepEqual(old.unjudged, [], 'the key is judged present');

  // Exactly 300 s old is still fresh: the gap is judged.
  assert.deepEqual(keySev(stale(1 * DAY, 300 * SEC).findings), ['config:bundle P3']);
});

test('config bundle: age and gap together are one config:bundle:age finding with members [age, gap]', () => {
  const v = bundleAt(d(5.5), { version: 65, hostVersion: 66 });
  assert.deepEqual(keySev(v.findings), ['config:bundle P3']);
  assert.equal(v.findings[0]!.rule, 'config:bundle:age');
  assert.deepEqual(v.findings[0]!.members, ['age', 'gap']);
  assert.match(v.findings[0]!.text, /; also the data copy serves v65 while config\.theshelter\.app serves v66: an upload stopped partway/);
  // The longest text (4-digit versions, three-digit ages) still fits a finding uncut: the gap's advice survives.
  const long = bundleAt(d(123.4), { version: 1234, hostVersion: 1235, policyAgeMs: d(122.9) });
  const text = long.findings[0]!.text;
  assert.ok(text.length < 500, `${text.length}: ${text}`);
  assert.match(text, /serves v1234 while config\.theshelter\.app serves v1235: an upload stopped partway \(re-run the config refresh's failed jobs\)$/);
});

test('config v65/v66 replay (2026-10-19..11-11): gap, gap, then age P3 [age, gap], P2, P1', () => {
  // Refresh run 39241196240 (10-19 ~10:57Z) re-sealed the policy and moved config.theshelter.app to v66, then failed
  // at the upload: the data copy stayed v65, generated 2026-10-17T20:39Z.
  const copyGenerated = Date.parse('2026-10-17T20:39:00Z');
  const policyGenerated = Date.parse('2026-10-19T10:58:00Z');
  const at = (iso: string) => {
    const nowMs = Date.parse(iso);
    const doc = statusDoc(nowMs, {
      generatedAtMs: nowMs - 20 * SEC,
      config_bundle_generated_ms: copyGenerated,
      config_bundle_version: 65,
      config_bundle_age_s: Math.round((nowMs - 20 * SEC - copyGenerated) / SEC),
      config_policy_generated_ms: policyGenerated,
      config_policy_age_s: Math.round((nowMs - 20 * SEC - policyGenerated) / SEC),
    });
    const v = evaluateConfigBundle({ status: ok(doc), hostVersion: 66, nowMs });
    assert.equal(v.findings.length, 1, iso);
    const f = v.findings[0]!;
    return { rule: f.rule, severity: f.severity, members: f.members, check: f.check };
  };
  assert.deepEqual(at('2026-10-19T11:07:00Z'), { rule: 'config:bundle:gap', severity: 'P3', members: ['gap'], check: null });
  assert.deepEqual(at('2026-10-20T11:07:00Z'), { rule: 'config:bundle:gap', severity: 'P3', members: ['gap'], check: null });
  assert.deepEqual(at('2026-10-22T20:40:00Z'), { rule: 'config:bundle:age', severity: 'P3', members: ['age', 'gap'], check: null });
  assert.deepEqual(at('2026-10-27T20:40:00Z'), { rule: 'config:bundle:age', severity: 'P2', members: ['age', 'gap'], check: 'gh-platform' });
  assert.deepEqual(at('2026-11-11T20:40:00Z'), { rule: 'config:bundle:age', severity: 'P1', members: ['age', 'gap'], check: 'gh-deliver' });
  // One minute before the 5 d line it is still the gap.
  assert.equal(at('2026-10-22T20:38:00Z').rule, 'config:bundle:gap');
});

// ---------------------------------------------------------------------------------------------------------
// Exit codes and arguments

test('plainExitCode: 1 for a host down, else 3 for a watcher fault, else 0', () => {
  const k = (...keys: string[]) => keys.map((key) => ({ key }));
  assert.equal(plainExitCode([]), 0);
  assert.equal(plainExitCode(k('platform:api')), 1);
  assert.equal(plainExitCode(k('platform:config-worker')), 1);
  assert.equal(plainExitCode(k('platform:api:envelope')), 0);
  assert.equal(plainExitCode(k('config:bundle')), 0, 'a config bundle finding annotates but does not mean a host is down');
  assert.equal(plainExitCode(k('watcher:platform-watchdog')), 3);
  assert.equal(plainExitCode(k('watcher:platform-watchdog', 'platform:api')), 1);
});

test('parseArgs: defaults, every flag, and readable errors', () => {
  assert.deepEqual(parseArgs([]), { apiUrl: API_HEALTH_URL, configUrl: CONFIG_HEALTH_URL, statusUrl: STATUS_URL, findingsPath: null });
  assert.deepEqual(parseArgs(['--api-url', 'https://a.test/h', '--config-url', 'https://c.test/h', '--status-url', 'https://s.test/status.json', '--findings', 'findings/platform.json']), {
    apiUrl: 'https://a.test/h',
    configUrl: 'https://c.test/h',
    statusUrl: 'https://s.test/status.json',
    findingsPath: 'findings/platform.json',
  });
  assert.throws(() => parseArgs(['--nope']), /unknown argument "--nope"/);
  assert.throws(() => parseArgs(['--findings']), /--findings needs a value/);
  assert.throws(() => parseArgs(['--api-url', '--findings', 'x.json']), /--api-url needs a value/);
  assert.throws(() => parseArgs(['--max-age-sec', '10']), /unknown argument/);
});

// ---------------------------------------------------------------------------------------------------------
// main

type Answers = Record<string, () => Response>;
function route(answers: Answers, calls: string[] = []): FetchImpl {
  return async (url) => {
    calls.push(url);
    const a = answers[url];
    if (!a) throw new Error(`unexpected ${url}`);
    return a();
  };
}
const healthyAnswers = (statusPatch: Record<string, unknown> = freshness(NOW, DAY, { version: 50 })): Answers => ({
  [API_HEALTH_URL]: () => json(API_OK),
  [CONFIG_HEALTH_URL]: () => json(CONFIG_OK),
  [STATUS_URL]: () => json(statusDoc(NOW, statusPatch)),
});

/** Run main in --findings mode with an in-memory writer; returns the exit code, the parsed document and the log. */
async function runFindings(answers: Answers, { argv = ['--findings', 'findings/platform.json'], sleep = noSleep }: { argv?: string[]; sleep?: (ms: number) => Promise<void> } = {}) {
  const written: Record<string, string> = {};
  const lines: string[] = [];
  const code = await main({ argv, env: {}, fetchImpl: route(answers), now: () => NOW, log: (l) => lines.push(l), sleep, writeFile: (p, d) => { written[p] = d; } });
  const text = written['findings/platform.json'];
  const doc = text === undefined ? null : (JSON.parse(text) as FindingsDocument);
  return { code, doc, lines, written };
}

test('main --findings: a healthy platform writes an empty document reconcile accepts, and exits 0', async () => {
  const { code, doc, lines } = await runFindings(healthyAnswers());
  assert.equal(code, 0);
  assert.ok(doc);
  assert.equal(parseFindingsDocument(doc).ok, true);
  assert.deepEqual({ schema: doc.schema, evaluator: doc.evaluator, generatedAtMs: doc.generatedAtMs, findings: doc.findings, unjudged: doc.unjudged }, {
    schema: 'health-findings/1',
    evaluator: 'platform',
    generatedAtMs: NOW,
    findings: [],
    unjudged: [],
  });
  assert.ok(doc.notes.includes('config bundle: config_bundle=v50 age=24.0h policy=24.0h host=v50'), doc.notes.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('findings written to findings/platform.json: 0 finding(s), 0 unjudged')));
  assert.ok(!lines.some((l) => l.startsWith('::')), 'no annotations in findings mode');
});

test('main --findings: every host down still writes a valid document and exits 0, with the unreadable parts unjudged', async () => {
  const sleeps: number[] = [];
  const { code, doc, lines } = await runFindings(
    {
      [API_HEALTH_URL]: () => new Response('<html>Connection timed out</html>', { status: 522 }),
      [CONFIG_HEALTH_URL]: () => json({ ok: false, source: null, version: null }, 503),
      [STATUS_URL]: () => new Response('upstream error', { status: 502 }),
    },
    { sleep: async (ms) => { sleeps.push(ms); } },
  );
  assert.equal(code, 0);
  assert.ok(doc);
  assert.equal(parseFindingsDocument(doc).ok, true);
  assert.deepEqual(keySev(doc.findings), ['platform:api P2', 'platform:config-worker P3']);
  assert.deepEqual(doc.unjudged, ['platform:api:envelope', 'config:bundle']);
  assert.ok(doc.notes.some((n) => /status\.json is unreadable/.test(n)));
  assert.ok(!lines.some((l) => l.startsWith('::')), 'findings are not annotated: reconcile prints them');
  assert.ok(lines.includes('not judged: config:bundle'));
  // The API: 3 tries 30 s apart; config and status.json: the default 2 s and 5 s.
  assert.deepEqual([...sleeps].sort((a, b) => a - b), [2_000, 2_000, 5_000, 5_000, 30_000, 30_000]);
});

test('main: the API is tried 3 times over at least 60 s before platform:api', async () => {
  const calls: string[] = [];
  const apiSleeps: number[] = [];
  const written: Record<string, string> = {};
  const code = await main({
    argv: ['--findings', 'out.json', '--config-url', 'https://c.test/healthz', '--status-url', 'https://s.test/status.json'],
    env: {},
    fetchImpl: route({ [API_HEALTH_URL]: () => new Response('timeout', { status: 522 }), 'https://c.test/healthz': () => json(CONFIG_OK), 'https://s.test/status.json': () => json(statusDoc(NOW)) }, calls),
    now: () => NOW,
    log: () => {},
    sleep: async (ms) => { apiSleeps.push(ms); },
    writeFile: (p, d) => { written[p] = d; },
  });
  assert.equal(code, 0);
  assert.equal(calls.filter((u) => u === API_HEALTH_URL).length, 3);
  assert.ok(apiSleeps.reduce((a, b) => a + b, 0) >= 60_000);
  const doc = JSON.parse(written['out.json']!) as FindingsDocument;
  assert.deepEqual(keySev(doc.findings), ['platform:api P2']);
  assert.match(doc.findings[0]!.text, /HTTP 522 after 3 attempt\(s\)/);
  // A 404 is definite: no retry.
  calls.length = 0;
  await main({ argv: ['--findings', 'out.json'], env: {}, fetchImpl: route({ ...healthyAnswers(), [API_HEALTH_URL]: () => new Response('nope', { status: 404 }) }, calls), now: () => NOW, log: () => {}, sleep: noSleep, writeFile: () => {} });
  assert.equal(calls.filter((u) => u === API_HEALTH_URL).length, 1);
});

test('main --findings: the config v65/v66 gap and an old bundle are findings, with the gap judged against healthz', async () => {
  const answers: Answers = {
    [API_HEALTH_URL]: () => json({ ...API_OK, providerTokenEnvelope: 'missing' }),
    [CONFIG_HEALTH_URL]: () => json({ ok: true, source: 'r2', version: 66 }),
    [STATUS_URL]: () => json(statusDoc(NOW, freshness(NOW, 26 * DAY, { version: 65 }))),
  };
  const { code, doc } = await runFindings(answers);
  assert.equal(code, 0);
  assert.ok(doc);
  assert.deepEqual(keySev(doc.findings), ['platform:api:envelope P3', 'config:bundle P1']);
  assert.deepEqual(doc.findings[1]!.members, ['age', 'gap']);
  assert.equal(doc.findings[1]!.check, 'gh-deliver');
});

test('main plain mode: 0 healthy, 1 a host down, 0 with ::error:: for a config bundle P1, 3 for a bad argument', async () => {
  const lines: string[] = [];
  assert.equal(await main({ argv: [], env: {}, fetchImpl: route(healthyAnswers()), now: () => NOW, log: (l) => lines.push(l), sleep: noSleep }), 0);
  assert.ok(lines.includes('api and config healthy'));
  assert.ok(lines.includes('config bundle: config_bundle=v50 age=24.0h policy=24.0h host=v50'));

  const calls: string[] = [];
  const out: string[] = [];
  const down = await main({ argv: [], env: {}, fetchImpl: route({ ...healthyAnswers(), [CONFIG_HEALTH_URL]: () => json({ ok: false }, 503) }, calls), now: () => NOW, log: (l) => out.push(l), sleep: noSleep });
  assert.equal(down, 1);
  assert.equal(calls.filter((u) => u === CONFIG_HEALTH_URL).length, 3, 'a 503 is retried twice');
  assert.ok(out.some((l) => l.startsWith('::error title=Config Worker unhealthy::')));
  assert.ok(!out.includes('api and config healthy'));

  const eph: string[] = [];
  assert.equal(await main({ argv: [], env: {}, fetchImpl: route({ ...healthyAnswers(), [API_HEALTH_URL]: () => json({ ...API_OK, sessionKeySource: 'ephemeral', providerTokenEnvelope: 'missing' }) }), now: () => NOW, log: (l) => eph.push(l), sleep: noSleep }), 1);
  assert.ok(eph.some((l) => l.startsWith('::error title=API Worker unhealthy::the API signs sessions with a per-isolate EPHEMERAL key')));
  assert.ok(eph.some((l) => l.startsWith('::warning title=API Worker::the API has no provider-token envelope key')));

  const old: string[] = [];
  assert.equal(await main({ argv: [], env: {}, fetchImpl: route(healthyAnswers(freshness(NOW, 26 * DAY, { version: 50 }))), now: () => NOW, log: (l) => old.push(l), sleep: noSleep }), 0);
  assert.ok(old.some((l) => l.startsWith('::error title=Config bundle (P1)::')), old.join('\n'));
  const p3: string[] = [];
  assert.equal(await main({ argv: [], env: {}, fetchImpl: route(healthyAnswers(freshness(NOW, 6 * DAY, { version: 50 }))), now: () => NOW, log: (l) => p3.push(l), sleep: noSleep }), 0);
  assert.ok(p3.some((l) => l.startsWith('::warning title=Config bundle (P3)::')));

  const bad: string[] = [];
  const noCalls: string[] = [];
  assert.equal(await main({ argv: ['--nope'], env: {}, fetchImpl: route({}, noCalls), now: () => NOW, log: (l) => bad.push(l), sleep: noSleep }), 3);
  assert.ok(bad.some((l) => l.startsWith('::error title=Platform watchdog misconfigured::unknown argument')));
  assert.deepEqual(noCalls, []);
});

test('main: a bad argument with --findings writes watcher:platform-watchdog (P3) with every platform key unjudged, and exits 0', async () => {
  const calls: string[] = [];
  const written: Record<string, string> = {};
  const lines: string[] = [];
  const code = await main({ argv: ['--findings', 'findings/platform.json', '--max-age-sec', '10'], env: {}, fetchImpl: route({}, calls), now: () => NOW, log: (l) => lines.push(l), sleep: noSleep, writeFile: (p, d) => { written[p] = d; } });
  assert.equal(code, 0);
  assert.deepEqual(calls, [], 'nothing is fetched');
  const doc = JSON.parse(written['findings/platform.json']!) as FindingsDocument;
  assert.equal(parseFindingsDocument(doc).ok, true);
  assert.equal(doc.findings.length, 1);
  const f = doc.findings[0]!;
  assert.deepEqual({ key: f.key, rule: f.rule, severity: f.severity, class: f.class, board: f.board }, { key: 'watcher:platform-watchdog', rule: 'watcher', severity: 'P3', class: 'watcher', board: 'platform' });
  assert.match(f.text, /unknown argument "--max-age-sec"/);
  assert.deepEqual(doc.unjudged, [...PLATFORM_KEYS]);
  assert.deepEqual(doc.unjudged, ['platform:api', 'platform:api:envelope', 'platform:config-worker', 'config:bundle']);
  assert.ok(!lines.some((l) => l.startsWith('::')), 'the watcher finding is reconcile\'s to annotate');
  // The flag order does not matter.
  const again: Record<string, string> = {};
  assert.equal(await main({ argv: ['--nope', '--findings', 'x.json'], env: {}, fetchImpl: route({}), now: () => NOW, log: () => {}, sleep: noSleep, writeFile: (p, d) => { again[p] = d; } }), 0);
  assert.ok(again['x.json']);
  // --findings without a path cannot write anything: exit 3.
  const missing: string[] = [];
  assert.equal(await main({ argv: ['--findings'], env: {}, fetchImpl: route({}), now: () => NOW, log: (l) => missing.push(l), sleep: noSleep, writeFile: () => assert.fail('nothing to write') }), 3);
  assert.ok(missing.some((l) => l.startsWith('::error title=Platform watchdog misconfigured::--findings needs a value')));
});

test('main --findings: an unwritable path exits 3 with an ::error::', async () => {
  const lines: string[] = [];
  const code = await main({
    argv: ['--findings', 'findings/platform.json'],
    env: {},
    fetchImpl: route(healthyAnswers()),
    now: () => NOW,
    log: (l) => lines.push(l),
    sleep: noSleep,
    writeFile: () => {
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(code, 3);
  assert.ok(lines.some((l) => l.startsWith('::error title=Platform watchdog::cannot write the findings document findings/platform.json: EACCES')));
  // A bad argument whose document cannot be written is 3 as well.
  assert.equal(await main({ argv: ['--findings', 'f.json', '--nope'], env: {}, fetchImpl: route({}), now: () => NOW, log: () => {}, sleep: noSleep, writeFile: () => { throw new Error('EROFS'); } }), 3);
});

test('main --findings: the default writer creates the directory, and the step summary gets a section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-watchdog-'));
  try {
    const path = join(dir, 'findings', 'platform.json');
    const summary = join(dir, 'summary.md');
    const code = await main({
      argv: ['--findings', path],
      env: { GITHUB_STEP_SUMMARY: summary },
      fetchImpl: route({ ...healthyAnswers(), [CONFIG_HEALTH_URL]: () => json({ ok: true, source: 'r2', version: 51 }) }),
      now: () => NOW,
      log: () => {},
      sleep: noSleep,
    });
    assert.equal(code, 0);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as FindingsDocument;
    assert.equal(parseFindingsDocument(doc).ok, true);
    assert.deepEqual(doc.findings.map((f) => `${f.key} ${f.rule}`), ['config:bundle config:bundle:gap']);
    const md = readFileSync(summary, 'utf8');
    assert.match(md, /^### API and config watchdog/);
    assert.match(md, /- \*\*P3\*\* `config:bundle`: the data copy serves v50 while config\.theshelter\.app serves v51/);
    assert.match(md, /Findings: 1, unjudged: none\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
