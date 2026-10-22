import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FetchImpl } from '../scripts/alerts-watchdog.mjs';
import { API_HEALTH_URL, CONFIG_HEALTH_URL, evaluateApiHealth, evaluateConfigHealth, main, parseArgs } from '../scripts/platform-watchdog.mjs';

// X-4: the API and config Workers' up/down watchdog (scripts/platform-watchdog.mjs, health.yml job `platform`).
// Bodies are the live prod answers of 2026-10-04; nothing here touches the network.

const API_OK = { ok: true, env: 'prod', dbAdapter: 'd1', dialect: 'sqlite', sessionKeySource: 'secret', providerTokenEnvelope: 'set', time: '2026-10-04T09:53:50.192Z' };
const CONFIG_OK = { ok: true, source: 'kv', version: 50 };
const ok = (json: unknown) => ({ ok: true as const, status: 200, json, attempts: 1 });
const noSleep = async (): Promise<void> => {};
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('api health: ok passes; an ephemeral session key fails; a missing envelope key only warns', () => {
  assert.deepEqual(evaluateApiHealth(ok(API_OK)), { problems: [], warnings: [], summary: 'api=ok env=prod db=d1 sessionKey=secret envelope=set' });
  const eph = evaluateApiHealth(ok({ ...API_OK, sessionKeySource: 'ephemeral' }));
  assert.equal(eph.problems.length, 1);
  assert.match(eph.problems[0]!, /EPHEMERAL/);
  const env = evaluateApiHealth(ok({ ...API_OK, providerTokenEnvelope: 'missing' }));
  assert.deepEqual(env.problems, []);
  assert.equal(env.warnings.length, 1);
  assert.match(evaluateApiHealth(ok({ ok: false })).problems[0]!, /without ok:true/);
});

test('api health: an unreachable or failing host is DOWN, with the reason', () => {
  const down = evaluateApiHealth({ ok: false, kind: 'http', status: 522, retryable: true, message: 'HTTP 522', body: '<html>Connection timed out</html>', attempts: 3 });
  assert.equal(down.summary, 'api=DOWN');
  assert.match(down.problems[0]!, /DOWN: HTTP 522 after 3 attempt\(s\): <html>Connection timed out<\/html>/);
  const net = evaluateApiHealth({ ok: false, kind: 'network', retryable: true, message: 'network error: fetch failed (ENOTFOUND)', attempts: 3 });
  assert.match(net.problems[0]!, /DOWN: network error: fetch failed \(ENOTFOUND\) after 3 attempt/);
});

test('config health: ok passes with source and version; a 503 (no bundle) is DOWN', () => {
  assert.deepEqual(evaluateConfigHealth(ok(CONFIG_OK)), { problems: [], warnings: [], summary: 'config=ok source=kv version=50' });
  const down = evaluateConfigHealth({ ok: false, kind: 'http', status: 503, retryable: true, message: 'HTTP 503', body: '{"ok":false,"source":null,"version":null}', attempts: 3 });
  assert.equal(down.summary, 'config=DOWN');
  assert.match(down.problems[0]!, /config\.theshelter\.app\/healthz is DOWN: HTTP 503 after 3 attempt\(s\): \{"ok":false/);
});

test('main: both healthy exits 0; one down exits 1 after the retries; a bad argument exits 3', async () => {
  const calls: string[] = [];
  const route = (answers: Record<string, () => Response>): FetchImpl => async (url) => {
    calls.push(url);
    const a = answers[url];
    if (!a) throw new Error(`unexpected ${url}`);
    return a();
  };
  const lines: string[] = [];
  assert.equal(await main({ argv: [], env: {}, fetchImpl: route({ [API_HEALTH_URL]: () => json(API_OK), [CONFIG_HEALTH_URL]: () => json(CONFIG_OK) }), log: (l) => lines.push(l), sleep: noSleep }), 0);
  assert.ok(lines.includes('api and config healthy'));
  calls.length = 0;
  const out: string[] = [];
  const code = await main({ argv: [], env: {}, fetchImpl: route({ [API_HEALTH_URL]: () => json(API_OK), [CONFIG_HEALTH_URL]: () => json({ ok: false }, 503) }), log: (l) => out.push(l), sleep: noSleep });
  assert.equal(code, 1);
  assert.equal(calls.filter((u) => u === CONFIG_HEALTH_URL).length, 3, 'a 503 is retried twice');
  assert.ok(out.some((l) => l.startsWith('::error title=Config Worker unhealthy::')));
  assert.equal(await main({ argv: ['--nope'], env: {}, fetchImpl: route({}), log: () => {}, sleep: noSleep }), 3);
  assert.deepEqual(parseArgs(['--api-url', 'https://a.test/h', '--config-url', 'https://c.test/h']), { apiUrl: 'https://a.test/h', configUrl: 'https://c.test/h' });
});
