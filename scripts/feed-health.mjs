#!/usr/bin/env node
// Feed health evaluator (run by .github/workflows/health.yml's `feed` job): the feed's findings for the "[health] feed"
// board (alerting plan of 2026-10-22, section 3b). It replaces the health job's inline scripts (the live manifest
// check, the silent/frozen and pinned-certificate issue sets, the repository and data file sizes) and adds the walks'
// blocked markers.
//
// Stateless, like every health evaluator: it reads, judges as of one moment and writes one findings document
// (scripts/lib/findings.mjs); scripts/reconcile.mjs owns everything that needs memory (the 2-run confirmation of an
// unreachable manifest, resolving, escalation, the board issue). A condition below its line is a P4 sample; a fully
// clear condition emits nothing, because absence is what resolves a board entry. What could not be read this run is
// listed under `unjudged`, so reconcile freezes those entries instead of resolving them.
//
// It reads:
//   - the live v1/manifest.json and v2/manifest.json (the signed envelope the alerts gateway's backstop reads; its
//     signature is not verified here, only its payload's `generated` and `freshness.stale_after_seconds`) and
//     v1/status.json, 4 tries each, 3 s apart, 20 s per try. When a manifest is stale at the first read, or this run
//     sat in the runner queue for over 10 min, both manifests are read again 60 s later (once): a stall upstream of
//     the watchdog must not read as broken publishing (2026-07-25: the queue stalled 1 h 54 min);
//   - with GH_TOKEN and GITHUB_REPOSITORY (GitHub's own API only): this run's created_at (the queue time), the
//     repository's size, the data branch's tree (every file's size) and the newest walk-blocked-<workflow> artifact of
//     each maintenance walk (history, first-solutions, backfill, archive), whose zip holds the walk's blocked marker.
//     A read that fails leaves its keys unjudged and is the finding watcher:feed-github (platform board, P3 after 2
//     runs, never red), so a read that keeps failing does not freeze those rows unseen; without GH_TOKEN in Actions
//     every read fails, in a local run none is made;
//   - providers/registry.json from the checkout (the source ids a marker line is filed under).
//
//   node scripts/feed-health.mjs --findings findings/feed.json   # the CI invocation: writes the document
//   node scripts/feed-health.mjs                                 # prints the document (a local run: no GitHub parts)
//
// Exit codes: 0 the document was written (or printed), whatever it says · 3 a bad argument, or the --findings file
// cannot be written · anything else is a crash (the job goes red and reconcile reports the evaluator missing).
// The findings are plain log lines and a step-summary section, never annotations: reconcile annotates them. Only the
// evaluator's own failures are annotated, and a truncated data tree listing (a warning: some files went unjudged).
//
// Dependency-free (Node >= 22, global fetch). The pure helpers are exported for tests/feed-health.test.ts, which never
// touches the network. Types: feed-health.d.mts.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { annotation, fetchJson } from './alerts-watchdog.mjs';
import { ageText, findingsDocument, makeFinding, oneLine, RULES, utcText } from './lib/findings.mjs';

export const FEED_BASE = 'https://earthquakes-feed.theshelter.app';
export const MANIFEST_V1_URL = `${FEED_BASE}/v1/manifest.json`;
export const MANIFEST_V2_URL = `${FEED_BASE}/v2/manifest.json`;
export const STATUS_V1_URL = `${FEED_BASE}/v1/status.json`;
/** GitHub's REST API: the only host GH_TOKEN is ever sent to. */
export const GITHUB_API = 'https://api.github.com';
/** The checkout's provider registry (health.yml's sparse checkout includes it). */
export const REGISTRY_PATH = fileURLToPath(new URL('../providers/registry.json', import.meta.url));

/** A zip of a walk's blocked marker: one small text file. Anything bigger is refused, never inflated. */
export const ZIP_MAX_ENTRIES = 10;
export const ZIP_MAX_ENTRY_BYTES = 1_000_000;
const ZIP_MAX_DOWNLOAD_BYTES = 12_000_000;

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A status.json map (silent, frozen, tls_leaves, tls_errors); {} when absent or not a plain object. */
const plainMap = (v) => (isObject(v) ? v : {});
const errMsg = (e) => (e instanceof Error ? e.message : String(e));
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A source id that can be part of a finding key (scripts/lib/findings.mjs KEY_RE). */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,60}$/;
/** Today's hours in the silent and frozen lines (the aggregate already publishes them in hours). */
const hours = (x) => (isNum(x) ? Math.round(x) : '?');
const mb = (b) => (b / 1e6).toFixed(1);
const iso = (ms) => (isNum(ms) ? new Date(ms).toISOString() : '?');

// ---------------------------------------------------------------------------------------------------------
// Manifests: feed:freshness

/** The fetch settings of a manifest or status.json read (RULES['feed:freshness:unreachable'].limits). */
function manifestFetchOptions() {
  const { attempts, retryDelayMs, timeoutMs } = RULES['feed:freshness:unreachable'].limits;
  return { attempts, backoffMs: Array.from({ length: Math.max(1, attempts - 1) }, () => retryDelayMs), timeoutMs };
}

/** `stale_after_seconds` of a manifest's freshness block in ms, else the rule's default (1,800 s). */
function staleAfterOf(m) {
  const s = isObject(m.freshness) ? m.freshness.stale_after_seconds : undefined;
  return isNum(s) && s > 0 ? s * SEC : RULES['feed:freshness'].limits.defaultStaleAfterMs;
}

/** The v1 manifest as read: its `generated` (ms) and contract; an unusable body counts as unreachable. */
export function readManifestV1(json) {
  if (!isObject(json)) return { ok: false, message: 'v1/manifest.json is not a JSON object' };
  if (!isNum(json.generated) || json.generated <= 0) return { ok: false, message: 'v1/manifest.json has no numeric generated time' };
  return { ok: true, generatedMs: json.generated, staleAfterMs: staleAfterOf(json) };
}

/**
 * The v2 manifest, an envelope {payload: base64, sig, kid}: the payload decoded and parsed, the signature NOT verified
 * (the watchdog judges age; the gateway verifies). A payload that cannot be decoded counts as unreachable.
 */
export function decodeManifestV2(json) {
  if (!isObject(json)) return { ok: false, message: 'v2/manifest.json is not a JSON object' };
  const b64 = typeof json.payload === 'string' ? json.payload.replace(/\s+/g, '') : null;
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { ok: false, message: 'v2/manifest.json has no base64 payload' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    return { ok: false, message: `v2/manifest.json payload is not JSON (${oneLine(errMsg(e), 120)})` };
  }
  if (!isObject(payload)) return { ok: false, message: 'v2/manifest.json payload is not a JSON object' };
  if (!isNum(payload.generated) || payload.generated <= 0) return { ok: false, message: 'v2/manifest.json payload has no numeric generated time' };
  return { ok: true, generatedMs: payload.generated, staleAfterMs: staleAfterOf(payload) };
}

/** Whether a manifest read is past its contract as of `nowMs`. */
const isStale = (m, nowMs) => m.ok && nowMs - m.generatedMs > m.staleAfterMs;

/** " — this run itself waited N min in the runner queue" past the re-read line, else ''. */
function queueNote(queuedMs) {
  return queuedMs > RULES['feed:freshness'].limits.queueReReadMs ? ` — this run itself waited ${Math.round(queuedMs / MIN)} min in the runner queue` : '';
}

/**
 * feed:freshness. Stale: the older of the manifests read is past its own stale_after_seconds (P2, rule feed:freshness).
 * A manifest read stale is stale even when the other is unreachable (the older of the two is at least that old).
 * Otherwise, either manifest unreachable or undecodable after its retries: P2 by rule feed:freshness:unreachable
 * (reconcile shows P4 on the first run). Fresh: null.
 */
export function evaluateFreshness({ nowMs, v1, v2, queuedMs = 0, reRead = false }) {
  const reads = [['v1', v1], ['v2', v2]];
  const readable = reads.filter(([, m]) => m && m.ok);
  const unreachable = reads.filter(([, m]) => !m || !m.ok);
  if (readable.length > 0) {
    const [olderName, older] = readable.reduce((a, b) => (b[1].generatedMs < a[1].generatedMs ? b : a));
    if (isStale(older, nowMs)) {
      const ages = reads.map(([name, m]) => (m && m.ok ? `${name}/manifest.json generated ${ageText(nowMs - m.generatedMs)} ago` : `${name}/manifest.json unreachable`)).join(', ');
      const what = readable.length === 2 && olderName === 'v2' && !isStale(v1, nowMs)
        ? 'v1 is fresh, so the signing of v2 has stopped: the alerts backstop reads the old v2'
        : 'the feed has stopped publishing (heartbeat Worker, GH_PAT, Actions or Pages): apps and the alerts backstop run on stale data';
      return makeFinding('feed:freshness', {
        sinceMs: older.generatedMs + older.staleAfterMs,
        text: `live manifest is ${ageText(nowMs - older.generatedMs)} stale (contract: ${ageText(older.staleAfterMs)}): ${ages}${reRead ? '; confirmed by a re-read 60 s later' : ''}${queueNote(queuedMs)}; ${what}`,
      });
    }
  }
  if (unreachable.length > 0) {
    const members = unreachable.map(([name]) => name);
    // Each message names its manifest (collect's fetch failures and the decoders' messages alike).
    const why = unreachable.map(([name, m]) => oneLine(m?.message ?? `${name}/manifest.json not read`, 160)).join('; ');
    return makeFinding('feed:freshness:unreachable', {
      members,
      text: `${members.join(' and ')} manifest unreachable after its retries (${why}): the feed's freshness cannot be judged${queueNote(queuedMs)}`,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// status.json: feed:source:<id>, feed:cert:<id>, feed:systemic

const TLS_RE = /certificate|\bcert\b|CERT_|\bTLS\b|\bSSL\b|self[- ]signed|unable to verify|handshake/i;

/** A provider entry's error message: v2 `error.message` or a v1 error string; '' when none. */
function errorMessage(err) {
  if (typeof err === 'string') return err;
  if (isObject(err) && err.message != null) return String(err.message);
  return '';
}

/**
 * When a failing provider last fetched: lastSuccessAt, else error.since (ms, or an ISO time) when it is before the
 * document (`refMs`); null when the start is unknown. src/status-v2.ts publishes error.since = the document's own time
 * for a source with no lastSuccessAt (one that has never fetched successfully): no start, or it would read as a
 * failure that has just begun on every run.
 */
function failingStart(p, refMs) {
  if (isNum(p.lastSuccessAt)) return p.lastSuccessAt;
  const raw = isObject(p.error) ? p.error.since : undefined;
  const since = isNum(raw) ? raw : typeof raw === 'string' && Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : null;
  return since !== null && (!isNum(refMs) || since < refMs) ? since : null;
}

/**
 * Whether a failing provider's error is definite (a 2 h line, rule feed:source:definite) or transient: definite for an
 * http_status of 401/403/404/410, an error.kind of 'schema', or a TLS failure: the source's tls_errors entry, its pinned
 * leaf expired, or a certificate or handshake error message (error.kind files TLS under 'error').
 */
export function classifyFailure(provider, { tlsError = null, tlsLeaf = null } = {}) {
  const lim = RULES['feed:source:definite'].limits;
  const p = isObject(provider) ? provider : {};
  const kind = isObject(p.error) && typeof p.error.kind === 'string' ? p.error.kind : null;
  if (isNum(p.http_status) && lim.httpStatuses.includes(p.http_status)) return { definite: true, reason: `HTTP ${p.http_status}` };
  if (kind !== null && lim.errorKinds.includes(kind)) return { definite: true, reason: `a ${kind} error` };
  if (tlsError != null && tlsError !== false) {
    const since = isObject(tlsError) && tlsError.since ? ` since ${oneLine(tlsError.since, 40)}` : '';
    return { definite: true, reason: `a certificate failure (tls_errors${since})` };
  }
  if (isObject(tlsLeaf) && isNum(tlsLeaf.days_left) && tlsLeaf.days_left < 0) return { definite: true, reason: `its pinned leaf expired ${oneLine(tlsLeaf.not_after ?? '?', 40)}` };
  if (TLS_RE.test(errorMessage(p.error))) return { definite: true, reason: 'a certificate failure' };
  return { definite: false, reason: kind ? `a transient error (${oneLine(kind, 40)})` : 'a transient error' };
}

/** The time status.json was generated: `generatedAt` (ms), else its ISO `generated`; null when neither. */
export function statusRefMs(status) {
  if (!isObject(status)) return null;
  if (isNum(status.generatedAt)) return status.generatedAt;
  const ms = typeof status.generated === 'string' ? Date.parse(status.generated) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function silentLine(e) {
  const s = plainMap(e);
  return `no rows for ${hours(s.silent_hours)} h (budget ${hours(s.budget_hours)} h, last rows ${s.last_non_empty_at || `not since ${s.counted_from || '?'}`})`;
}

function frozenLine(e) {
  const f = plainMap(e);
  return `frozen, ${f.rows ?? '?'} rows whose newest origin (${f.newest_origin || '?'}) is ${hours(f.newest_origin_age_hours)} h old (window ${hours(f.window_hours)} h + budget ${hours(f.budget_hours)} h)`;
}

function certFinding(id, leaf) {
  const notAfterMs = typeof leaf.not_after === 'string' ? Date.parse(leaf.not_after) : NaN;
  return makeFinding('feed:cert', {
    id,
    sinceMs: Number.isFinite(notAfterMs) ? notAfterMs - RULES['feed:cert'].limits.leafLineMs : null,
    text: `${id}: leaf ${leaf.subject || '?'} (issuer ${leaf.issuer || '?'}) expires ${leaf.not_after || '?'}, in ${leaf.days_left} days (read ${leaf.seen_at || '?'}): pin a new intermediate if the issuer changed: providers/tls/README.md`,
  });
}

/**
 * The per-source findings of a readable status.json, judged as of the document (`refMs`), not now:
 *   feed:source:<id>  one row per source: its fetch failing past its line (2 h definite, 3 h core, 12 h other; a P4
 *                     sample from 30 min to the line), silent, frozen (P3, members ⊆ [fetch, silent, frozen]). A
 *                     source that has never fetched successfully (no start on record) is P3 with sinceMs null at
 *                     once: reconcile holds a finding without a start on its own clock;
 *   feed:cert:<id>    a pinned leaf with under 7 days left (P3);
 *   feed:systemic     (shadow) 2 or more core sources, or 6 or more in all, failing for 30 min or more (P2).
 * `opts.nowMs` only adds a note on the document's own age.
 */
export function evaluateSources(status, refMs, { nowMs } = {}) {
  const findings = [];
  const notes = [];
  const s = plainMap(status);
  const providers = plainMap(s.providers);
  const silent = plainMap(s.silent);
  const frozen = plainMap(s.frozen);
  const leaves = plainMap(s.tls_leaves);
  const tlsErrors = plainMap(s.tls_errors);
  const coreIds = RULES['feed:source:core'].limits.ids;
  const sys = RULES['feed:systemic'].limits;
  const longFailing = [];
  if (isNum(nowMs) && isNum(refMs) && nowMs - refMs > RULES['feed:freshness'].limits.defaultStaleAfterMs) {
    notes.push(`status.json was generated ${ageText(nowMs - refMs)} ago: its sources are judged as of ${utcText(refMs)}`);
  }

  const ids = [...new Set([...Object.keys(providers), ...Object.keys(silent), ...Object.keys(frozen)])].sort();
  for (const id of ids) {
    if (!SAFE_ID.test(id)) {
      notes.push(`skipped source id ${JSON.stringify(oneLine(id, 40))}: not usable in a key`);
      continue;
    }
    const p = isObject(providers[id]) ? providers[id] : null;
    const members = [];
    let fetchRule = null;
    let sample = false;
    let start = null;
    let fetchPart = '';
    let errorPart = '';
    if (p && p.ok === false) {
      start = failingStart(p, refMs);
      const cls = classifyFailure(p, { tlsError: tlsErrors[id], tlsLeaf: leaves[id] });
      fetchRule = cls.definite ? 'feed:source:definite' : coreIds.includes(id) ? 'feed:source:core' : 'feed:source';
      const { lineMs, resolveWithinMs } = RULES[fetchRule].limits;
      const kindText = cls.definite ? `definite: ${cls.reason}` : coreIds.includes(id) ? `a core source, ${cls.reason}` : cls.reason;
      if (start === null) {
        // Never fetched successfully: no start to measure the line from, so the finding carries sinceMs null at the
        // rule's severity and reconcile holds it on its own clock.
        members.push('fetch');
        fetchPart = `fetch failing, never fetched successfully (no successful fetch on record, so its failing time is unknown; ${kindText}, line ${ageText(lineMs)})`;
      } else {
        const age = refMs - start;
        if (age >= lineMs) members.push('fetch');
        else if (age >= resolveWithinMs) sample = true;
        fetchPart = `fetch failing for ${ageText(age)} (last successful fetch ${iso(start)}; ${kindText}, line ${ageText(lineMs)})`;
        if (age >= sys.continuousMs) longFailing.push(id);
      }
      const tlsText = isObject(tlsErrors[id]) ? oneLine(tlsErrors[id].error, 240) : '';
      errorPart = `error: ${oneLine(errorMessage(p.error), 240) || tlsText || 'no error message'}`;
    }
    if (Object.hasOwn(silent, id)) members.push('silent');
    if (Object.hasOwn(frozen, id)) members.push('frozen');
    if (members.length > 0 || sample) {
      const hasFetch = members.includes('fetch');
      const quietOnly = members.length > 0 && !hasFetch;
      const parts = [];
      if (fetchPart) parts.push(fetchPart);
      if (Object.hasOwn(silent, id)) parts.push(silentLine(silent[id]));
      if (Object.hasOwn(frozen, id)) parts.push(frozenLine(frozen[id]));
      if (errorPart) parts.push(errorPart);
      const lastRows = Object.hasOwn(silent, id) && typeof plainMap(silent[id]).last_non_empty_at === 'string' ? Date.parse(silent[id].last_non_empty_at) : NaN;
      findings.push(makeFinding(quietOnly ? 'feed:source:quiet' : fetchRule, {
        id,
        severity: members.length > 0 ? 'P3' : 'P4',
        sinceMs: quietOnly ? (Number.isFinite(lastRows) ? lastRows : null) : start,
        ...(members.length > 0 ? { members } : {}),
        text: `${id}: ${parts.join(', ')}`,
      }));
    }
  }

  // Pinned leaves under the line (FEED-SEC-1): a week's notice before a renewal under a new intermediate cuts the
  // source off; the escalation (5 days later) lands at 2 days left.
  for (const id of Object.keys(leaves).sort()) {
    const leaf = leaves[id];
    if (!SAFE_ID.test(id) || !isObject(leaf) || !isNum(leaf.days_left)) continue;
    if (leaf.days_left * DAY < RULES['feed:cert'].limits.leafLineMs) findings.push(certFinding(id, leaf));
  }

  const core = longFailing.filter((id) => sys.coreIds.includes(id));
  if (core.length >= sys.coreMin || longFailing.length >= sys.anyMin) {
    findings.push(makeFinding('feed:systemic', {
      members: longFailing,
      text: `${longFailing.length} sources have failed for ${ageText(sys.continuousMs)} or more (${core.length} of the core ${sys.coreIds.join(', ')}): ${longFailing.join(', ')}; the feed's coverage is reduced`,
    }));
  }
  return { findings, notes };
}

// ---------------------------------------------------------------------------------------------------------
// The data branch and the repository: feed:size, feed:repo-size

/**
 * feed:size from the data branch's recursive tree listing (GitHub API): a status/history day file
 * (YYYY-MM-DD.ndjson) over 5 MB, any other file over 45 MB (strict). Unreadable (null, no tree array): unjudged. A
 * truncated listing is judged as far as it goes, with a note.
 */
export function evaluateSizes(tree) {
  const { dayFileBytes, fileBytes } = RULES['feed:size'].limits;
  if (!isObject(tree) || !Array.isArray(tree.tree)) return { findings: [], unjudged: ['feed:size'], notes: ['data tree: unknown (no tree in the answer)'] };
  const isDayFile = (p) => /^status\/history\/\d{4}-\d{2}-\d{2}\.ndjson$/.test(p);
  const limitOf = (p) => (isDayFile(p) ? dayFileBytes : fileBytes);
  const blobs = tree.tree.filter((e) => isObject(e) && e.type === 'blob' && typeof e.path === 'string' && isNum(e.size));
  const notes = [];
  // The status history, whatever its file layout: its current file is rewritten by every aggregate commit.
  const history = blobs.filter((e) => e.path.startsWith('status/history/'));
  const largest = history.reduce((m, e) => (m && m.size >= e.size ? m : e), null);
  const total = history.reduce((n, e) => n + e.size, 0);
  const days = history.filter((e) => isDayFile(e.path)).length;
  notes.push(`status history: ${history.length} file(s) (${days} day file(s)), ${mb(total)} MB, largest ${largest ? `${largest.path} ${mb(largest.size)} MB` : 'none'} (line ${mb(dayFileBytes)} MB a day file, ${mb(fileBytes)} MB any other file)`);
  const dirs = {};
  for (const e of blobs) {
    const top = e.path.includes('/') ? e.path.slice(0, e.path.indexOf('/')) : '(root)';
    dirs[top] = (dirs[top] || 0) + e.size;
  }
  const all = blobs.reduce((n, e) => n + e.size, 0);
  notes.push(`data tree: ${blobs.length} files, ${mb(all)} MB (${Object.entries(dirs).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${mb(n)} MB`).join(', ')})${tree.truncated ? ', listing TRUNCATED' : ''}`);
  // A truncated listing (over 100,000 entries or 7 MB) may miss a file: said, never guessed.
  if (tree.truncated) notes.push('the data tree listing was truncated, so some files were not judged');
  const over = blobs.filter((e) => e.size > limitOf(e.path)).sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1));
  if (over.length === 0) return { findings: [], unjudged: [], notes };
  const shown = over.slice(0, 3).map((e) => `${e.path}: ${mb(e.size)} MB, over ${mb(limitOf(e.path))} MB (${e.path.startsWith('status/history/') ? 'the run log, rewritten by every aggregate commit' : 'a file on the data branch'})`);
  const more = over.length > shown.length ? `, +${over.length - shown.length} more` : '';
  return {
    findings: [makeFinding('feed:size', {
      members: over.map((e) => e.path),
      text: `${shown.join('; ')}${more}: every rewrite of a large file grows the repository, and GitHub rejects a pushed file above 100 MiB, which stops the feed publishing (APIs.md Run logs)`,
    })],
    unjudged: [],
    notes,
  };
}

/** feed:repo-size: GitHub's `size` of the repository (KB) over the line (8,000,000 KB); not a number: unjudged. */
export function evaluateRepoSize(kb) {
  const { maxKb } = RULES['feed:repo-size'].limits;
  if (!isNum(kb) || kb < 0) return { findings: [], unjudged: ['feed:repo-size'], notes: ['repository size: unknown'] };
  const gb = (kb / 1e6).toFixed(2);
  const notes = [`repository size: ${gb} GB (${kb} KB, line ${maxKb} KB)`];
  if (kb <= maxKb) return { findings: [], unjudged: [], notes };
  return {
    findings: [makeFinding('feed:repo-size', {
      text: `the repository is ${gb} GB (${kb} KB), over the ${maxKb} KB line: check what grows (the data branch tree by top-level directory; APIs.md Repository size); GitHub recommends staying under 10 GB`,
    })],
    unjudged: [],
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Walk markers: walks:<workflow>:<source>

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The lines of a blocked marker, each filed under the registry id that matches leftmost as a whole word (not inside a
 * longer id-like word: letters, digits, '_' and '-' delimit it), else 'run' (a line about the walk itself).
 */
export function parseMarker(text, ids) {
  const res = [...new Set([...ids].filter((id) => typeof id === 'string' && SAFE_ID.test(id)))].map((id) => [id, new RegExp(`(?<![a-z0-9_-])${escapeRe(id)}(?![a-z0-9_-])`)]);
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    let source = 'run';
    let at = Infinity;
    for (const [id, re] of res) {
      const m = re.exec(line);
      if (m && (m.index < at || (m.index === at && id.length > source.length))) {
        at = m.index;
        source = id;
      }
    }
    out.push({ source, line });
  }
  return out;
}

/**
 * The newest walk-blocked-<workflow> artifact of an artifacts listing (GET /repos/{repo}/actions/artifacts?name=…):
 * not expired, by created_at; null when there is none.
 */
export function pickMarkerArtifact(listing, name) {
  const list = isObject(listing) && Array.isArray(listing.artifacts) ? listing.artifacts : null;
  if (list === null) throw new Error('no artifacts list in the answer');
  let best = null;
  for (const a of list) {
    if (!isObject(a) || a.name !== name || a.expired === true || !isNum(a.id)) continue;
    const createdAtMs = typeof a.created_at === 'string' ? Date.parse(a.created_at) : NaN;
    if (!Number.isFinite(createdAtMs)) continue;
    if (!best || createdAtMs > best.createdAtMs) best = { id: a.id, createdAtMs, runId: isObject(a.workflow_run) && isNum(a.workflow_run.id) ? a.workflow_run.id : null };
  }
  return best;
}

/**
 * walks:<workflow>:<source> (P3, class maintenance: never red) for each line of the newest marker younger than 26 h;
 * the lines of one key merge into one finding. A read that failed (listing or zip): `walks:<workflow>:*` unjudged.
 */
export function evaluateWalks(reads, nowMs, ids) {
  const { markerHoldMs } = RULES.walks.limits;
  const findings = [];
  const unjudged = [];
  const notes = [];
  for (const r of reads) {
    if (!r.ok) {
      unjudged.push(`walks:${r.workflow}:*`);
      notes.push(`walks: ${r.workflow}: marker unreadable (${oneLine(r.message, 200)})`);
      continue;
    }
    const m = r.marker;
    if (!m) continue;
    if (!isNum(m.createdAtMs) || nowMs - m.createdAtMs >= markerHoldMs) {
      notes.push(`walks: ${r.workflow}: newest marker ${isNum(m.createdAtMs) ? `${ageText(nowMs - m.createdAtMs)} old` : 'of unknown age'}: the walk has moved on`);
      continue;
    }
    const lines = parseMarker(m.text, ids);
    if (lines.length === 0) {
      notes.push(`walks: ${r.workflow}: the marker of ${utcText(m.createdAtMs)} is empty`);
      continue;
    }
    const bySource = new Map();
    for (const l of lines) {
      if (!bySource.has(l.source)) bySource.set(l.source, []);
      bySource.get(l.source).push(l.line);
    }
    for (const [source, group] of bySource) {
      const more = group.length > 1 ? ` (+${group.length - 1} more)` : '';
      findings.push(makeFinding('walks', {
        id: `${r.workflow}:${source}`,
        sinceMs: m.createdAtMs,
        text: `${oneLine(group[0], 240)}${more} (marker of ${utcText(m.createdAtMs)}, run ${m.runId ?? '?'})`,
      }));
    }
  }
  return { findings, unjudged, notes };
}

/**
 * The entries of a small zip (a walk marker artifact): stored (method 0) or deflated (method 8), at most 10 entries of
 * at most 1 MB each. Throws on anything else (no zip, zip64, encryption, another method, a size over the limit).
 * @returns {Array<{ name: string, data: Buffer }>}
 */
export function readZipEntries(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22) throw new Error('not a zip (too short)');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 is not supported');
  if (count > ZIP_MAX_ENTRIES) throw new Error(`${count} entries, more than ${ZIP_MAX_ENTRIES}`);
  if (cdOffset + cdSize > eocd) throw new Error('the central directory is out of bounds');
  const out = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory entry ${n}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, Math.min(eocd, p + 46 + nameLen));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (flags & 0x1) throw new Error(`${name}: encrypted`);
    if (size > ZIP_MAX_ENTRY_BYTES || compressed > ZIP_MAX_DOWNLOAD_BYTES) throw new Error(`${name}: ${size} bytes, over ${ZIP_MAX_ENTRY_BYTES}`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compressed > buf.length) throw new Error(`${name}: data out of bounds`);
    const raw = buf.subarray(start, start + compressed);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: ZIP_MAX_ENTRY_BYTES });
      } catch (e) {
        throw new Error(`${name}: cannot inflate (${errMsg(e)})`);
      }
    } else throw new Error(`${name}: compression method ${method} is not supported`);
    if (data.length !== size) throw new Error(`${name}: ${data.length} bytes, the directory says ${size}`);
    out.push({ name, data });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The whole document

/** The source ids of providers/registry.json ({providers: [{id}]}, or a bare array of {id}). */
export function registryIds(text) {
  const json = JSON.parse(text);
  const list = Array.isArray(json) ? json : isObject(json) && Array.isArray(json.providers) ? json.providers : null;
  if (list === null) throw new Error('no providers list');
  return list.filter((p) => isObject(p) && typeof p.id === 'string').map((p) => p.id);
}

/**
 * Every feed finding of one run, from what collect() read. Pure.
 * @returns {{ findings: import('./lib/findings.d.mts').Finding[], unjudged: string[], notes: string[], summary: string }}
 */
export function evaluateFeed(inputs) {
  const { nowMs } = inputs;
  const findings = [];
  const unjudged = [];
  const notes = [...(inputs.notes ?? [])];
  const parts = [];
  const add = (r) => {
    findings.push(...r.findings);
    unjudged.push(...(r.unjudged ?? []));
    notes.push(...r.notes);
  };

  // Manifests.
  const fresh = evaluateFreshness({ nowMs, v1: inputs.v1, v2: inputs.v2, queuedMs: inputs.queuedMs ?? 0, reRead: inputs.reRead === true });
  if (fresh) findings.push(fresh);
  for (const [name, m] of [['v1', inputs.v1], ['v2', inputs.v2]]) {
    parts.push(m && m.ok ? `${name}=${ageText(nowMs - m.generatedMs)} (contract ${ageText(m.staleAfterMs)})` : `${name}=unreachable`);
  }
  parts.push(`queued=${ageText(inputs.queuedMs ?? 0)}${inputs.reRead ? ' re-read' : ''}`);

  // status.json.
  const status = inputs.status;
  const json = status && status.ok ? status.json : null;
  if (!isObject(json) || !isObject(json.providers)) {
    const why = status && !status.ok ? status.message : 'no providers in the answer';
    findings.push(makeFinding('feed:status', { text: `v1/status.json unreadable (${oneLine(why, 200)}): the per-source health of the feed is unknown this run` }));
    unjudged.push('feed:source:*', 'feed:cert:*', 'feed:systemic');
    parts.push('status=unreadable');
  } else {
    let refMs = statusRefMs(json);
    if (refMs === null) {
      refMs = nowMs;
      notes.push('status.json carries no generated time: its sources are judged as of now');
    }
    add({ ...evaluateSources(json, refMs, { nowMs }), unjudged: [] });
    const ids = Object.keys(json.providers);
    const failing = ids.filter((id) => isObject(json.providers[id]) && json.providers[id].ok === false).sort();
    const leaves = plainMap(json.tls_leaves);
    parts.push(
      `status=${utcText(refMs)} sources=${ids.length} failing=[${failing.join(',')}] silent=[${Object.keys(plainMap(json.silent)).sort().join(',')}] ` +
        `frozen=[${Object.keys(plainMap(json.frozen)).sort().join(',')}] tls_leaf_days=[${Object.keys(leaves).sort().map((id) => `${id}:${plainMap(leaves[id]).days_left}`).join(',')}]`,
    );
  }

  // Repository and data branch.
  const repo = inputs.repoSize;
  if (repo && !repo.ok) notes.push(`repository size: ${oneLine(repo.message, 200)}`);
  add(evaluateRepoSize(repo && repo.ok ? repo.kb : null));
  const tree = inputs.tree;
  if (tree && !tree.ok) notes.push(`data tree: ${oneLine(tree.message, 200)}`);
  add(evaluateSizes(tree && tree.ok ? tree.json : null));

  // Walk markers.
  add(evaluateWalks(inputs.walks ?? [], nowMs, inputs.ids ?? []));
  parts.push(`walks=${(inputs.walks ?? []).map((r) => `${r.workflow}:${!r.ok ? 'unreadable' : r.marker ? 'marker' : 'clear'}`).join(',')}`);

  // The GitHub reads (not in a local run): one that failed froze its keys above; watcher:feed-github says so on the
  // platform board, or a read that keeps failing (a lost `actions: read`, an API outage) would freeze them unseen.
  if (!inputs.githubSkipped) {
    const failed = [];
    if (inputs.queueError) failed.push(['run', "this run's created_at", inputs.queueError]);
    if (!repo || !repo.ok) failed.push(['repository', 'the repository size', repo ? repo.message : 'not read']);
    if (!tree || !tree.ok) failed.push(['data-tree', 'the data tree', tree ? tree.message : 'not read']);
    else if (!isObject(tree.json) || !Array.isArray(tree.json.tree)) failed.push(['data-tree', 'the data tree', 'no tree in the answer']);
    for (const r of inputs.walks ?? []) if (!r.ok) failed.push([`walks:${r.workflow}`, `the ${r.workflow} walk's marker`, r.message]);
    if (failed.length > 0) findings.push(githubWatcher(failed, [...new Set(unjudged)].filter((k) => k === 'feed:repo-size' || k === 'feed:size' || k.startsWith('walks:'))));
  }

  return { findings, unjudged: [...new Set(unjudged)], notes, summary: parts.join(' ') };
}

/**
 * watcher:feed-github (P3 after 2 runs, never red): the GitHub reads that failed ([member, what, why]; the reasons
 * grouped), and which keys they leave unjudged.
 */
function githubWatcher(failed, frozen) {
  const byWhy = new Map();
  for (const [, what, why] of failed) {
    const reason = oneLine(why, 160);
    byWhy.set(reason, [...(byWhy.get(reason) ?? []), what]);
  }
  const reads = [...byWhy].map(([why, whats]) => `${whats.join(', ')}: ${why}`).join('; ');
  const effect = frozen.length > 0 ? `${frozen.join(', ')} not judged this run` : 'the queue time is unknown this run (counted as 0)';
  return makeFinding('watcher', {
    id: 'feed-github',
    members: failed.map(([member]) => member),
    // The effect first: a long list of reasons is what the 500-character cut takes.
    text: `${effect}: the feed evaluator's GitHub reads failed (check the feed job's GH_TOKEN, actions: read, and GitHub's status): ${reads}`,
  });
}

// ---------------------------------------------------------------------------------------------------------
// I/O

const ghHeaders = (token) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'earthquakes-feed-health',
});

/** "HTTP 500 after 3 attempt(s)" for a failed fetchJson result. */
const failText = (r) => `${r.message} after ${r.attempts} attempt(s)`;

/** GET with a per-attempt timeout, retried on network errors, 5xx, 408 and 429: the raw bytes. Never throws. */
async function fetchBytes(url, { headers, fetchImpl, sleep, attempts = 3, timeoutMs = 30_000 }) {
  let last = 'not attempted';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(attempt === 2 ? 2_000 : 5_000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers, signal: ctrl.signal });
      if (!res.ok) {
        last = `HTTP ${res.status}`;
        if (res.status >= 500 || res.status === 408 || res.status === 429) continue;
        return { ok: false, message: last };
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > ZIP_MAX_DOWNLOAD_BYTES) return { ok: false, message: `${declared} bytes, over ${ZIP_MAX_DOWNLOAD_BYTES}` };
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > ZIP_MAX_DOWNLOAD_BYTES) return { ok: false, message: `${bytes.length} bytes, over ${ZIP_MAX_DOWNLOAD_BYTES}` };
      return { ok: true, bytes };
    } catch (e) {
      last = ctrl.signal.aborted ? `timed out after ${timeoutMs} ms` : `network error: ${errMsg(e)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, message: `${last} after ${attempts} attempt(s)` };
}

/** One walk's newest marker: the listing, then (when it is younger than the hold) the artifact's zip. */
async function readWalk(workflow, { gh, token, repo, fetchImpl, sleep, nowMs }) {
  const { artifactPrefix, markerHoldMs } = RULES.walks.limits;
  const name = `${artifactPrefix}${workflow}`;
  const listed = await gh(`/repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=10`);
  if (!listed.ok) return { workflow, ok: false, message: `listing ${name}: ${failText(listed)}` };
  let art;
  try {
    art = pickMarkerArtifact(listed.json, name);
  } catch (e) {
    return { workflow, ok: false, message: `listing ${name}: ${errMsg(e)}` };
  }
  if (!art) return { workflow, ok: true, marker: null };
  if (nowMs - art.createdAtMs >= markerHoldMs) return { workflow, ok: true, marker: { createdAtMs: art.createdAtMs, runId: art.runId, artifactId: art.id, text: '' } };
  const zip = await fetchBytes(`${GITHUB_API}/repos/${repo}/actions/artifacts/${art.id}/zip`, { headers: ghHeaders(token), fetchImpl, sleep });
  if (!zip.ok) return { workflow, ok: false, message: `artifact ${art.id} of ${name}: ${zip.message}` };
  try {
    const text = readZipEntries(zip.bytes).filter((e) => !e.name.endsWith('/')).map((e) => e.data.toString('utf8')).join('\n');
    return { workflow, ok: true, marker: { createdAtMs: art.createdAtMs, runId: art.runId, artifactId: art.id, text } };
  } catch (e) {
    return { workflow, ok: false, message: `artifact ${art.id} of ${name}: not a readable zip (${errMsg(e)})` };
  }
}

/**
 * Everything GitHub tells, started at once: queue time, repository size, data tree, walk markers (promises, so the
 * re-read decision waits for the queue time only). Never rejects. `notes` fills in as they settle. Without GH_TOKEN or
 * GITHUB_REPOSITORY nothing is read: on purpose in a local run (`skipped`), a failed read of every part in Actions.
 */
function collectGitHub({ env, fetchImpl, sleep, now }) {
  const token = env.GH_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const workflows = RULES.walks.limits.workflows;
  if (!token || !repo) {
    const local = env.GITHUB_ACTIONS !== 'true';
    const message = local ? 'no GH_TOKEN or GITHUB_REPOSITORY (a local run)' : 'GH_TOKEN or GITHUB_REPOSITORY is not set in the job';
    return {
      queue: Promise.resolve({ ms: 0, error: local ? null : message }),
      repoSize: Promise.resolve({ ok: false, message }),
      tree: Promise.resolve({ ok: false, message }),
      walks: Promise.resolve(workflows.map((workflow) => ({ workflow, ok: false, message }))),
      notes: [`GitHub parts not judged: ${message}`],
      skipped: local ? message : null,
    };
  }
  const gh = (path, opts = {}) => fetchJson(`${GITHUB_API}${path}`, { init: { headers: ghHeaders(token) }, fetchImpl, sleep, attempts: 3, backoffMs: [2_000, 5_000], ...opts });
  const notes = [];
  const queue = (async () => {
    if (!env.GITHUB_RUN_ID) {
      notes.push('queue time unknown (no GITHUB_RUN_ID): counted as 0');
      return { ms: 0, error: null };
    }
    const r = await gh(`/repos/${repo}/actions/runs/${encodeURIComponent(env.GITHUB_RUN_ID)}`);
    const created = r.ok && isObject(r.json) && typeof r.json.created_at === 'string' ? Date.parse(r.json.created_at) : NaN;
    if (!Number.isFinite(created)) {
      const error = r.ok ? 'no created_at in the answer' : failText(r);
      notes.push(`queue time unknown (${error}): counted as 0`);
      return { ms: 0, error };
    }
    return { ms: Math.max(0, now() - created), error: null };
  })();
  const repoSize = gh(`/repos/${repo}`).then((r) => {
    if (!r.ok) return { ok: false, message: failText(r) };
    return isObject(r.json) && isNum(r.json.size) ? { ok: true, kb: r.json.size } : { ok: false, message: 'no size in the answer' };
  });
  const tree = gh(`/repos/${repo}/git/trees/data?recursive=1`, { timeoutMs: 60_000 }).then((r) => (r.ok ? { ok: true, json: r.json } : { ok: false, message: failText(r) }));
  const walks = Promise.all(workflows.map((workflow) => readWalk(workflow, { gh, token, repo, fetchImpl, sleep, nowMs: now() })));
  return { queue, repoSize, tree, walks, notes, skipped: null };
}

/**
 * Read everything a feed judgement needs. Never throws on a network or API error (each input then reads as
 * unreadable); `nowMs` of the result is the time of the judgement, after the last manifest read.
 * `nowMs` (a fixed clock) is an alternative to `now` for tests.
 * @returns {Promise<import('./feed-health.d.mts').FeedInputs>}
 */
export async function collect({ env = process.env, fetchImpl = globalThis.fetch, nowMs, now, sleep = sleepMs, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const clock = typeof now === 'function' ? now : isNum(nowMs) ? () => nowMs : () => Date.now();
  const notes = [];
  const feedInit = { headers: { 'cache-control': 'no-cache', accept: 'application/json' } };
  const read = (url) => fetchJson(url, { init: feedInit, fetchImpl, sleep, ...manifestFetchOptions() });
  const asManifest = (r, decode, name) => (r.ok ? decode(r.json) : { ok: false, message: `${name}/manifest.json: ${failText(r)}` });

  const gh = collectGitHub({ env, fetchImpl, sleep, now: clock });
  const [r1, r2, rs, queue] = await Promise.all([read(MANIFEST_V1_URL), read(MANIFEST_V2_URL), read(STATUS_V1_URL), gh.queue]);
  const queuedMs = queue.ms;
  let v1 = asManifest(r1, readManifestV1, 'v1');
  let v2 = asManifest(r2, decodeManifestV2, 'v2');
  const status = rs.ok ? { ok: true, json: rs.json } : { ok: false, message: failText(rs) };

  // One re-read, 60 s later: a stale manifest is confirmed (or a deploy that was landing is seen), and a run that sat
  // in the runner queue gives publishing the chance to catch up before it judges.
  const lim = RULES['feed:freshness'].limits;
  const firstMs = clock();
  let reRead = false;
  if (isStale(v1, firstMs) || isStale(v2, firstMs) || queuedMs > lim.queueReReadMs) {
    const why = queuedMs > lim.queueReReadMs ? `this run waited ${Math.round(queuedMs / MIN)} min in the runner queue` : 'a manifest was stale at the first read';
    await sleep(lim.reReadAfterMs);
    reRead = true;
    const [a, b] = await Promise.all([read(MANIFEST_V1_URL), read(MANIFEST_V2_URL)]);
    const n1 = asManifest(a, readManifestV1, 'v1');
    const n2 = asManifest(b, decodeManifestV2, 'v2');
    // A failed re-read keeps the first copy.
    if (n1.ok || !v1.ok) v1 = n1;
    else notes.push(`the re-read failed (${n1.message}): v1 is judged on its first copy`);
    if (n2.ok || !v2.ok) v2 = n2;
    else notes.push(`the re-read failed (${n2.message}): v2 is judged on its first copy`);
    notes.push(`re-read both manifests ${ageText(lim.reReadAfterMs)} later (${why})`);
  }

  // The registry's ids name a marker line's source; the status's ids stand in when the registry cannot be read.
  let ids = [];
  try {
    ids = registryIds(readFile(REGISTRY_PATH));
  } catch (e) {
    const fromStatus = status.ok && isObject(status.json) && isObject(status.json.providers) ? Object.keys(status.json.providers) : [];
    ids = fromStatus;
    notes.push(`providers/registry.json unreadable (${oneLine(errMsg(e), 120)}): marker lines are filed by status.json's ${fromStatus.length} source ids`);
  }

  const [repoSize, tree, walks] = await Promise.all([gh.repoSize, gh.tree, gh.walks]);
  return { nowMs: clock(), v1, v2, reRead, queuedMs, queueError: queue.error, githubSkipped: gh.skipped, status, repoSize, tree, walks, ids, notes: [...gh.notes, ...notes] };
}

/** argv to options; throws an Error with a readable message on a bad argument. */
export function parseArgs(argv) {
  const opts = { findingsPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--findings') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error('--findings needs a path');
      opts.findingsPath = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  return opts;
}

/** The default writer: creates the file's directory first (health.yml writes findings/feed.json into a fresh checkout). */
function writeFileWithDir(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

const cell = (s) => String(s).replace(/\|/g, '\\|');

/**
 * Run the evaluator. Everything with a side effect is injectable so tests stay offline.
 * @returns {Promise<number>} the exit code
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = sleepMs,
  log = console.log,
  readFile = (p) => readFileSync(p, 'utf8'),
  writeFile = writeFileWithDir,
} = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    log(annotation('error', 'Feed health misconfigured', errMsg(e)));
    return 3;
  }

  const inputs = await collect({ env, fetchImpl, now, sleep, readFile });
  const verdict = evaluateFeed(inputs);
  const doc = findingsDocument({ evaluator: 'feed', generatedAtMs: inputs.nowMs, findings: verdict.findings, unjudged: verdict.unjudged, notes: verdict.notes });

  log(`feed health: ${verdict.summary}`);
  for (const f of doc.findings) {
    log(`finding ${f.severity} ${f.key} [${f.rule}]${f.shadow ? ' (shadow)' : ''}${f.sinceMs !== null ? ` since ${utcText(f.sinceMs)}` : ''}: ${f.text}`);
  }
  for (const n of doc.notes) log(`note: ${n}`);
  if (doc.unjudged.length > 0) log(`not judged this run: ${doc.unjudged.join(', ')}`);
  // GitHub lists at most 100,000 entries (7 MB): feed:size was judged only as far as the listing went.
  if (inputs.tree.ok && isObject(inputs.tree.json) && inputs.tree.json.truncated === true) {
    log(annotation('warning', 'Data file size', 'the data tree listing was truncated, so some files were not judged'));
  }

  let code = 0;
  if (opts.findingsPath) {
    try {
      writeFile(opts.findingsPath, `${JSON.stringify(doc, null, 2)}\n`);
      log(`findings: ${doc.findings.length} written to ${opts.findingsPath}`);
    } catch (e) {
      log(annotation('error', 'Feed health could not write its findings', `${opts.findingsPath}: ${errMsg(e)}`));
      code = 3;
    }
  } else {
    log(JSON.stringify(doc, null, 2));
  }

  if (env.GITHUB_STEP_SUMMARY) {
    const lines = ['### Feed health', '', `\`${verdict.summary}\``, ''];
    if (doc.findings.length > 0) {
      lines.push('| Sev | Key | Rule | Since | Condition |', '|---|---|---|---|---|');
      for (const f of doc.findings) lines.push(`| ${f.severity}${f.shadow ? ' (shadow)' : ''} | \`${f.key}\` | ${f.rule} | ${f.sinceMs !== null ? utcText(f.sinceMs) : ''} | ${cell(f.text)} |`);
    } else {
      lines.push('No feed findings.');
    }
    if (doc.unjudged.length > 0) lines.push('', `Not judged this run: ${doc.unjudged.map((u) => `\`${u}\``).join(', ')}`);
    if (doc.notes.length > 0) lines.push('', ...doc.notes.map((n) => `- ${n}`));
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
    } catch (e) {
      log(annotation('warning', 'Feed health', `could not write the step summary: ${errMsg(e)}`));
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(annotation('error', 'Feed health crashed', errMsg(e)));
      process.exitCode = 1;
    },
  );
}
