#!/usr/bin/env node
// Up/down watchdog for The Shelter's API and config Workers (X-4; run by .github/workflows/health.yml every 15 min).
//
// Until 2026-10-04 nothing noticed when api.theshelter.app or config.theshelter.app stopped answering: the feed and
// alerts watchdogs read other hosts. Like the alerts watchdog it runs from GitHub on purpose (it must keep working
// when Cloudflare is the thing that broke) and its alarm is GitHub's failed-workflow email. It fails when:
//   - https://api.theshelter.app/v1/health does not answer 200 with `ok: true`, or reports
//     `sessionKeySource: "ephemeral"` (the Worker lost SESSION_ES256_PRIVATE_CURRENT and signs sessions with a
//     per-isolate key: every app session breaks with random 401s),
//   - https://config.theshelter.app/healthz does not answer 200 with `ok: true` (no signed bundle resolvable: 503).
// It warns when the API reports `providerTokenEnvelope: "missing"` (account deletion cannot revoke at Apple).
// Each GET is retried twice (2 s, 5 s) before it counts, so one edge hiccup does not page anyone.
//
// Exit codes: 0 healthy · 1 a host is down or unhealthy · 3 the watchdog itself is misconfigured.
//
//   node scripts/platform-watchdog.mjs
//   node scripts/platform-watchdog.mjs --api-url <url> --config-url <url>
//
// Dependency-free (Node >= 22, global fetch). The pure helpers are exported for tests/platform-watchdog.test.ts.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { annotation, fetchJson } from './alerts-watchdog.mjs';

export const API_HEALTH_URL = 'https://api.theshelter.app/v1/health';
export const CONFIG_HEALTH_URL = 'https://config.theshelter.app/healthz';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failed fetchJson result as one readable line (the body of a 503 often says why). */
function failure(r) {
  const what = r.kind === 'network' ? r.message : r.kind === 'parse' ? `HTTP ${r.status}, ${r.message}` : `HTTP ${r.status}`;
  const body = r.body ? `: ${String(r.body).replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return `${what} after ${r.attempts} attempt(s)${body}`;
}

/**
 * Judge the API's /v1/health answer (a fetchJson result). Pure.
 * @returns {{ problems: string[], warnings: string[], summary: string }}
 */
export function evaluateApiHealth(r) {
  const problems = [];
  const warnings = [];
  if (!r.ok) {
    problems.push(`api.theshelter.app/v1/health is DOWN: ${failure(r)}. The app cannot sign in, post reports or refresh sessions`);
    return { problems, warnings, summary: 'api=DOWN' };
  }
  const doc = r.json;
  if (!isObject(doc) || doc.ok !== true) {
    problems.push(`api.theshelter.app/v1/health answered without ok:true (${JSON.stringify(doc).slice(0, 200)})`);
    return { problems, warnings, summary: 'api=NOT-OK' };
  }
  if (doc.sessionKeySource === 'ephemeral') {
    problems.push('the API signs sessions with a per-isolate EPHEMERAL key (SESSION_ES256_PRIVATE_CURRENT missing): app sessions fail with random 401s');
  }
  if (doc.providerTokenEnvelope === 'missing') {
    warnings.push('the API has no provider-token envelope key (ENVELOPE_AES256_CURRENT): Apple refresh tokens are not stored and account deletion cannot revoke at Apple');
  }
  const summary = `api=ok env=${String(doc.env ?? '?')} db=${String(doc.dbAdapter ?? '?')} sessionKey=${String(doc.sessionKeySource ?? '?')} envelope=${String(doc.providerTokenEnvelope ?? '?')}`;
  return { problems, warnings, summary };
}

/**
 * Judge the config Worker's /healthz answer (a fetchJson result). Pure.
 * @returns {{ problems: string[], warnings: string[], summary: string }}
 */
export function evaluateConfigHealth(r) {
  const problems = [];
  const warnings = [];
  if (!r.ok) {
    problems.push(`config.theshelter.app/healthz is DOWN: ${failure(r)}. Installed apps get no signed config (kill switches, origins, thresholds) until it is back`);
    return { problems, warnings, summary: 'config=DOWN' };
  }
  const doc = r.json;
  if (!isObject(doc) || doc.ok !== true) {
    problems.push(`config.theshelter.app/healthz answered without ok:true (${JSON.stringify(doc).slice(0, 200)})`);
    return { problems, warnings, summary: 'config=NOT-OK' };
  }
  return { problems, warnings, summary: `config=ok source=${String(doc.source ?? '?')} version=${String(doc.version ?? '?')}` };
}

/** Parse argv into options; throws an Error with a readable message on a bad argument. */
export function parseArgs(argv) {
  const opts = { apiUrl: API_HEALTH_URL, configUrl: CONFIG_HEALTH_URL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = argv[i + 1];
    if (a === '--api-url' || a === '--config-url') {
      if (value === undefined || value.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      if (a === '--api-url') opts.apiUrl = value;
      else opts.configUrl = value;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  return opts;
}

/**
 * Run the watchdog. Everything with a side effect is injectable so tests stay offline.
 * @returns {Promise<number>} the exit code
 */
export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, log = console.log, sleep = sleepMs } = {}) {
  const summaryLines = ['### API and config watchdog', ''];
  const finish = (code) => {
    if (env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(env.GITHUB_STEP_SUMMARY, `${summaryLines.join('\n')}\n`);
      } catch {
        /* the summary is a convenience */
      }
    }
    return code;
  };
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    log(annotation('error', 'Platform watchdog misconfigured', e instanceof Error ? e.message : String(e)));
    return finish(3);
  }
  const init = { headers: { 'cache-control': 'no-cache', accept: 'application/json', 'user-agent': 'earthquakes-feed-health (+https://github.com/TheShelterApp/earthquakes-feed)' } };
  const [api, config] = await Promise.all([
    fetchJson(opts.apiUrl, { init, fetchImpl, sleep }),
    fetchJson(opts.configUrl, { init, fetchImpl, sleep }),
  ]);
  let unhealthy = false;
  for (const [name, verdict] of [['API', evaluateApiHealth(api)], ['Config', evaluateConfigHealth(config)]]) {
    log(`${name.toLowerCase()}: ${verdict.summary}`);
    for (const w of verdict.warnings) log(annotation('warning', `${name} Worker`, w));
    for (const p of verdict.problems) log(annotation('error', `${name} Worker unhealthy`, p));
    if (verdict.problems.length) unhealthy = true;
    summaryLines.push(`- ${name}: ${verdict.problems.length ? '**UNHEALTHY**' : 'healthy'} · \`${verdict.summary}\``);
    for (const p of verdict.problems) summaryLines.push(`  - ${p}`);
    for (const w of verdict.warnings) summaryLines.push(`  - warning: ${w}`);
  }
  if (unhealthy) return finish(1);
  log('api and config healthy');
  return finish(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(annotation('error', 'Platform watchdog crashed', e instanceof Error ? e.message : String(e)));
      process.exitCode = 3;
    },
  );
}
