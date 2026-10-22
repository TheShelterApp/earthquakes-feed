#!/usr/bin/env node
// Platform watchdog: The Shelter's API and config Workers and the age of the signed config bundle (X-4; a findings
// evaluator since the alerting plan of 2026-10-22, section 3c; run by .github/workflows/health.yml every 15 min).
//
// Until 2026-10-04 nothing noticed when api.theshelter.app or config.theshelter.app stopped answering: the feed and
// alerts watchdogs read other hosts. Like the alerts watchdog it runs from GitHub on purpose (it must keep working when
// Cloudflare is the thing that broke). It judges, as findings (scripts/lib/findings.mjs; every line comes from RULES):
//   platform:api            /v1/health does not answer 200 with `ok: true` after 3 tries spread over at least 60 s, or
//                           reports `sessionKeySource: "ephemeral"` (the Worker lost SESSION_ES256_PRIVATE_CURRENT and
//                           signs sessions with a per-isolate key: every app session breaks with random 401s): P2
//   platform:api:envelope   `providerTokenEnvelope: "missing"` (account deletion cannot revoke at Apple): P3
//   platform:config-worker  /healthz does not answer 200 with `ok: true` (no signed bundle resolvable: 503): P3
//   config:bundle           the older of the data copy of the signed config bundle (what apps and the gateway load) and
//                           the signed alerts policy, by data.theshelter.app/alerts/status.json: P3 over 5 d, P2 over
//                           10 d, P1 over 25 d (the bundle expires at 30 d); under 5 d, the copy's version behind the
//                           version /healthz serves (an upload that stopped partway, 2026-10-19 v65/v66): P3, which
//                           reconcile holds for 24 h
// Health and status.json GETs are retried twice (2 s, 5 s); the API's three tries are 30 s apart, so an outage of
// under a minute (an edge blip, a deploy) is not reported.
//
// Two modes:
//   --findings <path>  writes a findings document (evaluator `platform`) for scripts/reconcile.mjs and exits 0 whatever
//                      it says; 3 when the path is missing or cannot be written. A bad argument is the finding
//                      watcher:platform-watchdog. Plain log lines and a step-summary section, no annotations for
//                      findings (reconcile prints those).
//   plain              annotations, and exit codes: 0 healthy · 1 a host is down or unhealthy · 3 the watchdog itself
//                      is misconfigured (or crashed).
//
//   node scripts/platform-watchdog.mjs [--findings findings/platform.json]
//   node scripts/platform-watchdog.mjs --api-url <url> --config-url <url> --status-url <url>
//
// Dependency-free (Node >= 22, global fetch). The pure helpers are exported for tests/platform-watchdog.test.ts.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATUS_URL, annotation, fetchJson } from './alerts-watchdog.mjs';
import { RULES, ageText, findingsDocument, makeFinding, oneLine, utcText } from './lib/findings.mjs';

export const API_HEALTH_URL = 'https://api.theshelter.app/v1/health';
export const CONFIG_HEALTH_URL = 'https://config.theshelter.app/healthz';

const DAY_MS = 86_400_000;
const API_LIMITS = RULES['platform:api'].limits;
const BUNDLE_LIMITS = RULES['config:bundle:age'].limits;
/** status.json older than this (the alerts:status:stale line, 300 s) is a stale copy: the version gap is not judged. */
const STATUS_MAX_AGE_MS = RULES['alerts:status:stale'].limits.maxAgeMs;
const BUNDLE_KEY = RULES['config:bundle:age'].key;

/** The API's tries: `attempts`, spread evenly over `spreadMs` (3 tries, 30 s apart: at least 60 s). */
export const API_RETRY = Object.freeze({
  attempts: API_LIMITS.attempts,
  backoffMs: Object.freeze(Array.from({ length: API_LIMITS.attempts - 1 }, () => API_LIMITS.spreadMs / (API_LIMITS.attempts - 1))),
});

/** Every key this evaluator judges: all of them are unjudged when it cannot run (a bad argument). */
export const PLATFORM_KEYS = Object.freeze([RULES['platform:api'].key, RULES['platform:api:envelope'].key, RULES['platform:config-worker'].key, BUNDLE_KEY]);

/** The findings that mean "a host is down" (plain-mode exit 1, as before the findings). */
const DOWN_KEYS = Object.freeze([RULES['platform:api'].key, RULES['platform:config-worker'].key]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const errMsg = (e) => (e instanceof Error ? e.message : String(e));
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const days = (ms) => `${Math.round((ms / DAY_MS) * 10) / 10} d`;

/** A failed fetchJson result as one readable line (the body of a 503 often says why). */
function failure(r) {
  const what = r.kind === 'network' ? r.message : r.kind === 'parse' ? `HTTP ${r.status}, ${r.message}` : `HTTP ${r.status}`;
  const body = r.body ? `: ${String(r.body).replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return `${what} after ${r.attempts} attempt(s)${body}`;
}

/** A body that is not what the host should answer, shortened for a log line. */
const bodyText = (doc) => String(JSON.stringify(doc) ?? doc).slice(0, 200);

/**
 * Judge the API's /v1/health answer (a fetchJson result). Pure.
 * `unjudged` names the envelope key while the API cannot be read: an open envelope entry must not resolve then.
 * @returns {{ findings: import('./lib/findings.d.mts').Finding[], unjudged: string[], summary: string }}
 */
export function evaluateApiHealth(r) {
  const envelopeKey = RULES['platform:api:envelope'].key;
  if (!r.ok) {
    const text = `api.theshelter.app/v1/health is DOWN: ${failure(r)}. The app cannot sign in, post reports or refresh sessions`;
    return { findings: [makeFinding('platform:api', { text })], unjudged: [envelopeKey], summary: 'api=DOWN' };
  }
  const doc = r.json;
  if (!isObject(doc) || doc.ok !== true) {
    const text = `api.theshelter.app/v1/health answered without ok:true (${bodyText(doc)})`;
    return { findings: [makeFinding('platform:api', { text })], unjudged: [envelopeKey], summary: 'api=NOT-OK' };
  }
  const findings = [];
  if (doc.sessionKeySource === 'ephemeral') {
    findings.push(makeFinding('platform:api', {
      text: 'the API signs sessions with a per-isolate EPHEMERAL key (SESSION_ES256_PRIVATE_CURRENT missing): app sessions fail with random 401s',
    }));
  }
  if (doc.providerTokenEnvelope === 'missing') {
    findings.push(makeFinding('platform:api:envelope', {
      text: 'the API has no provider-token envelope key (ENVELOPE_AES256_CURRENT): Apple refresh tokens are not stored and account deletion cannot revoke at Apple',
    }));
  }
  const summary = `api=ok env=${String(doc.env ?? '?')} db=${String(doc.dbAdapter ?? '?')} sessionKey=${String(doc.sessionKeySource ?? '?')} envelope=${String(doc.providerTokenEnvelope ?? '?')}`;
  return { findings, unjudged: [], summary };
}

/**
 * Judge the config Worker's /healthz answer (a fetchJson result). Pure.
 * `version` is the bundle version the host serves (for the version gap); null when it is down or does not say.
 * @returns {{ findings: import('./lib/findings.d.mts').Finding[], summary: string, version: number | null }}
 */
export function evaluateConfigHealth(r) {
  const consequence = 'Apps load the data copy of the bundle first and keep their last good config; this host is their fallback when the copy fails';
  if (!r.ok) {
    const text = `config.theshelter.app/healthz is DOWN: ${failure(r)}. ${consequence}`;
    return { findings: [makeFinding('platform:config-worker', { text })], summary: 'config=DOWN', version: null };
  }
  const doc = r.json;
  if (!isObject(doc) || doc.ok !== true) {
    const text = `config.theshelter.app/healthz answered without ok:true (${bodyText(doc)}). ${consequence}`;
    return { findings: [makeFinding('platform:config-worker', { text })], summary: 'config=NOT-OK', version: null };
  }
  const version = isNum(doc.version) && doc.version > 0 ? doc.version : null;
  return { findings: [], summary: `config=ok source=${String(doc.source ?? '?')} version=${String(doc.version ?? '?')}`, version };
}

/**
 * The age of one signed copy named in status.json, as of `nowMs`: from `<x>_generated_ms` when usable, else the
 * published `<x>_age_s` plus the document's own age. `present`: the gateway publishes the fields at all.
 */
function copyAge(doc, genKey, ageKey, nowMs) {
  const present = Object.hasOwn(doc, genKey) || Object.hasOwn(doc, ageKey);
  if (isNum(doc[genKey]) && doc[genKey] > 0) return { present, ageMs: Math.max(0, nowMs - doc[genKey]), generatedMs: doc[genKey] };
  if (isNum(doc[ageKey]) && doc[ageKey] >= 0) {
    const ageMs = doc[ageKey] * 1_000 + Math.max(0, nowMs - doc.generatedAtMs);
    return { present, ageMs, generatedMs: nowMs - ageMs };
  }
  return { present, ageMs: null, generatedMs: null };
}

/**
 * Judge the config bundle (key config:bundle) from status.json and the version /healthz serves. Pure.
 *   age  the older of the bundle copy and the signed policy (the larger of the ages that are known): over p3AgeMs P3,
 *        over p2AgeMs P2, over p1AgeMs P1 (rule config:bundle:age; members `age`, plus `gap` when the gap also holds)
 *   gap  age not over p3AgeMs, and the copy's numeric config_bundle_version behind the host's numeric version: P3
 *        (rule config:bundle:gap, members `gap`; reconcile holds it 24 h). A copy ahead of the host is a note.
 * With no finding, `unjudged` is ['config:bundle'] when a part could not be judged: status.json unreadable, healthz
 * unreadable (`hostVersion` null) or status.json stale (the gap only: the ages still are), or the ages or the copy's
 * version null (never read by the gateway since it was deployed). Fields absent (an older gateway): nothing.
 * @param {{ status: import('./alerts-watchdog.d.mts').FetchResult, hostVersion: number | null, nowMs: number }} input
 */
export function evaluateConfigBundle({ status, hostVersion, nowMs }) {
  const findings = [];
  const notes = [];
  const doc = status && status.ok ? status.json : undefined;
  if (!status || !status.ok || !isObject(doc) || !isNum(doc.generatedAtMs)) {
    const why = !status || !status.ok ? failure(status ?? { kind: 'network', message: 'not read', attempts: 0 }) : !isObject(doc) ? 'the body is not an object' : 'generatedAtMs is not a number';
    notes.push(`status.json is unreadable (${why}): the config bundle's age and version gap are not judged this run`);
    return { findings, unjudged: [BUNDLE_KEY], notes, summary: 'config_bundle=unreadable' };
  }
  const bundle = copyAge(doc, 'config_bundle_generated_ms', 'config_bundle_age_s', nowMs);
  const policy = copyAge(doc, 'config_policy_generated_ms', 'config_policy_age_s', nowMs);
  const versionPresent = Object.hasOwn(doc, 'config_bundle_version');
  if (!bundle.present && !policy.present && !versionPresent) {
    return { findings, unjudged: [], notes, summary: 'config_bundle=n/a' };
  }
  const copyVersion = isNum(doc.config_bundle_version) && doc.config_bundle_version > 0 ? doc.config_bundle_version : null;
  const docAgeMs = nowMs - doc.generatedAtMs;
  const stale = docAgeMs > STATUS_MAX_AGE_MS;
  let unjudgedPart = false;

  // Ages. A null age: the gateway has not read that copy since it was deployed (the policy is also null while the
  // compiled fallback runs, which alerts:policy judges).
  const known = [bundle, policy].filter((c) => c.ageMs !== null);
  const older = known.length === 0 ? null : known.reduce((a, c) => (c.ageMs > a.ageMs ? c : a));
  if (older === null) {
    notes.push('status.json publishes no config bundle or policy age (null: the gateway has not read them since it was deployed, or the compiled fallback policy runs): the age is not judged this run');
    unjudgedPart = true;
  } else if (bundle.present && bundle.ageMs === null) {
    notes.push('config_bundle_age_s is null (the gateway has not read the data copy since it was deployed): the age is the signed policy\'s alone');
  } else if (policy.present && policy.ageMs === null) {
    notes.push('config_policy_age_s is null (the compiled fallback policy runs, which alerts:policy judges, or the gateway has not read the signed policy since it was deployed): the age is the bundle copy\'s alone');
  }
  let ageSeverity = null;
  if (older !== null) {
    if (older.ageMs > BUNDLE_LIMITS.p1AgeMs) ageSeverity = 'P1';
    else if (older.ageMs > BUNDLE_LIMITS.p2AgeMs) ageSeverity = 'P2';
    else if (older.ageMs > BUNDLE_LIMITS.p3AgeMs) ageSeverity = 'P3';
  }

  // The version gap: only on a fresh document (a stale one names an old copy version) against the host's version.
  let gap = false;
  if (stale) {
    notes.push(`status.json is ${Math.floor(docAgeMs / 1_000)} s old (over the ${STATUS_MAX_AGE_MS / 1_000} s line): the config bundle's version gap is not judged this run (its age is)`);
    unjudgedPart = true;
  } else if (hostVersion === null) {
    notes.push('config.theshelter.app/healthz gave no bundle version: the config bundle\'s version gap is not judged this run');
    unjudgedPart = true;
  } else if (copyVersion === null) {
    if (versionPresent) {
      notes.push('config_bundle_version is null (the gateway has not read the data copy since it was deployed): the version gap is not judged this run');
      unjudgedPart = true;
    }
  } else if (copyVersion < hostVersion) {
    gap = true;
  } else if (copyVersion > hostVersion) {
    notes.push(`the data copy serves v${copyVersion}, ahead of config.theshelter.app (v${hostVersion}): the host's read is behind, not a partial upload`);
  }
  const gapText = `the data copy serves v${copyVersion} while config.theshelter.app serves v${hostVersion}: an upload stopped partway (re-run the config refresh's failed jobs)`;

  if (ageSeverity !== null) {
    const line = { P1: BUNDLE_LIMITS.p1AgeMs, P2: BUNDLE_LIMITS.p2AgeMs, P3: BUNDLE_LIMITS.p3AgeMs }[ageSeverity];
    const bundlePart = bundle.ageMs === null
      ? 'the config bundle copy apps and the gateway load is of unknown age'
      : `the config bundle copy apps and the gateway load (v${copyVersion ?? '?'}, generated ${utcText(bundle.generatedMs)}) is ${ageText(bundle.ageMs)} old`;
    const policyPart = policy.ageMs === null ? 'the signed alerts policy\'s age is unknown' : `the signed alerts policy ${ageText(policy.ageMs)} (generated ${utcText(policy.generatedMs)})`;
    const ladder = `P3 over ${days(BUNDLE_LIMITS.p3AgeMs)}, P2 over ${days(BUNDLE_LIMITS.p2AgeMs)}, P1 over ${days(BUNDLE_LIMITS.p1AgeMs)}; at ${days(BUNDLE_LIMITS.expiresMs)} the bundle expires and apps fall back to compiled defaults`;
    const text = `${bundlePart}, ${policyPart}: over the ${days(line)} line (${ladder}): the config refresh has stopped or failed${gap ? `; also ${gapText}` : ''}`;
    findings.push(makeFinding('config:bundle:age', { severity: ageSeverity, sinceMs: older.generatedMs + BUNDLE_LIMITS.p3AgeMs, text, members: gap ? ['age', 'gap'] : ['age'] }));
  } else if (gap) {
    findings.push(makeFinding('config:bundle:gap', { text: gapText, members: ['gap'] }));
  }

  const ageField = (c) => (c.ageMs === null ? (c.present ? '?' : 'n/a') : ageText(c.ageMs).replace(' ', ''));
  const summary = `config_bundle=v${copyVersion ?? '?'} age=${ageField(bundle)} policy=${ageField(policy)} host=v${hostVersion ?? '?'}${stale ? ' status=STALE' : ''}`;
  return { findings, unjudged: findings.length === 0 && unjudgedPart ? [BUNDLE_KEY] : [], notes, summary };
}

/** Plain-mode exit code: 1 when a host is down or unhealthy (as before the findings), else 3 for a watcher fault, else 0. */
export function plainExitCode(findings) {
  if (findings.some((f) => DOWN_KEYS.includes(f.key))) return 1;
  if (findings.some((f) => f.key.startsWith(RULES.watcher.keyPrefix))) return 3;
  return 0;
}

const VALUE_FLAGS = { '--api-url': 'apiUrl', '--config-url': 'configUrl', '--status-url': 'statusUrl', '--findings': 'findingsPath' };

/** Parse argv into options; throws an Error with a readable message on a bad argument. */
export function parseArgs(argv) {
  const opts = { apiUrl: API_HEALTH_URL, configUrl: CONFIG_HEALTH_URL, statusUrl: STATUS_URL, findingsPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!Object.hasOwn(VALUE_FLAGS, a)) throw new Error(`unknown argument ${JSON.stringify(a)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--') || value === '') throw new Error(`${a} needs a value`);
    i += 1;
    opts[VALUE_FLAGS[a]] = value;
  }
  return opts;
}

/** The --findings path of an argv that does not parse otherwise (a bad argument still writes a document), or null. */
function findingsPathOf(argv) {
  const i = argv.lastIndexOf('--findings');
  const value = i < 0 ? undefined : argv[i + 1];
  return value === undefined || value === '' || value.startsWith('--') ? null : value;
}

const writeFileDefault = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** Plain-mode annotation of one finding: a host down is an error (exit 1), otherwise by severity. */
function findingAnnotation(f) {
  const titles = { 'platform:api': 'API Worker unhealthy', 'platform:api:envelope': 'API Worker', 'platform:config-worker': 'Config Worker unhealthy' };
  const title = titles[f.key] ?? (f.key.startsWith(RULES.watcher.keyPrefix) ? 'Platform watchdog misconfigured' : `Config bundle (${f.severity})`);
  const level = DOWN_KEYS.includes(f.key) || f.severity === 'P1' || f.severity === 'P2' ? 'error' : f.severity === 'P3' ? 'warning' : 'notice';
  return annotation(level, title, f.text);
}

/**
 * Run the watchdog. Everything with a side effect is injectable so tests stay offline.
 * @returns {Promise<number>} the exit code
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = console.log,
  sleep = sleepMs,
  writeFile = writeFileDefault,
} = {}) {
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
  /** Write the findings document; 0 when written, 3 (with an ::error::, the evaluator's own failure) otherwise. */
  const writeDocument = (path, { findings, unjudged, notes }) => {
    const doc = findingsDocument({ evaluator: 'platform', generatedAtMs: now(), findings, unjudged, notes });
    try {
      writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
    } catch (e) {
      log(annotation('error', 'Platform watchdog', `cannot write the findings document ${path}: ${errMsg(e)}`));
      summaryLines.push(`- **findings not written** to \`${path}\`: ${oneLine(errMsg(e))}`);
      return 3;
    }
    log(`findings written to ${path}: ${findings.length} finding(s), ${unjudged.length} unjudged`);
    summaryLines.push('', `Findings: ${findings.length}, unjudged: ${unjudged.length ? unjudged.map((u) => `\`${u}\``).join(', ') : 'none'}.`);
    return 0;
  };

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    const message = errMsg(e);
    const findingsPath = findingsPathOf(argv);
    summaryLines.push(`- misconfigured: ${oneLine(message)}`);
    if (findingsPath === null) {
      log(annotation('error', 'Platform watchdog misconfigured', message));
      return finish(3);
    }
    // In findings mode the bad argument is a watcher finding (reconcile reports it); nothing else is judged.
    log(`platform watchdog misconfigured: ${message}`);
    const findings = [makeFinding('watcher', { id: 'platform-watchdog', text: `the platform watchdog cannot run: ${message}` })];
    return finish(writeDocument(findingsPath, { findings, unjudged: [...PLATFORM_KEYS], notes: [] }));
  }

  const init = { headers: { 'cache-control': 'no-cache', accept: 'application/json', 'user-agent': 'earthquakes-feed-health (+https://github.com/TheShelterApp/earthquakes-feed)' } };
  const [api, config, status] = await Promise.all([
    fetchJson(opts.apiUrl, { init, fetchImpl, sleep, attempts: API_RETRY.attempts, backoffMs: [...API_RETRY.backoffMs] }),
    fetchJson(opts.configUrl, { init, fetchImpl, sleep }),
    // The status document is judged as of when it was read (the API's tries take a minute longer).
    fetchJson(opts.statusUrl, { init, fetchImpl, sleep }).then((r) => ({ r, readMs: now() })),
  ]);
  const apiVerdict = evaluateApiHealth(api);
  const configVerdict = evaluateConfigHealth(config);
  const bundleVerdict = evaluateConfigBundle({ status: status.r, hostVersion: configVerdict.version, nowMs: status.readMs });
  const findings = [...apiVerdict.findings, ...configVerdict.findings, ...bundleVerdict.findings];
  const unjudged = [...apiVerdict.unjudged, ...bundleVerdict.unjudged];
  const summaries = [`api: ${apiVerdict.summary}`, `config: ${configVerdict.summary}`, `config bundle: ${bundleVerdict.summary}`];

  for (const s of summaries) log(s);
  for (const n of bundleVerdict.notes) log(`note: ${n}`);
  for (const s of summaries) summaryLines.push(`- \`${s}\``);
  for (const f of findings) summaryLines.push(`- **${f.severity}** \`${f.key}\`: ${f.text}`);
  for (const n of bundleVerdict.notes) summaryLines.push(`- note: ${n}`);

  if (opts.findingsPath !== null) {
    for (const f of findings) log(`${f.severity} ${f.key}: ${f.text}`);
    for (const u of unjudged) log(`not judged: ${u}`);
    return finish(writeDocument(opts.findingsPath, { findings, unjudged, notes: [...summaries, ...bundleVerdict.notes] }));
  }

  for (const f of findings) log(findingAnnotation(f));
  const code = plainExitCode(findings);
  if (code === 0) log('api and config healthy');
  return finish(code);
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
