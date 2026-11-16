// Authentication and authorisation of the state Worker: a GitHub Actions OIDC token, nothing else.
//
// No static secret exists anywhere (owner decision 2026-11-16): a job that may call the store asks GitHub for a token
// whose audience is this Worker (`id-token: write`, job level only), and the Worker checks GitHub's signature and the
// claims. A token lives about 5 minutes (exp - iat = 300 s in GitHub's example; nbf sits 600 s before iat), so the client
// mints one per call unless its cached one has more than 60 s left; the Worker is strict on exp and nbf with SKEW_S of
// clock skew, and only refuses an iat in the future.
//
// Verification (401 on any failure: the caller is not an identity this Worker knows):
// - the header's alg must be exactly RS256 (pinned: `none`, HS256 and every other alg are refused before any key is
//   looked at, so a token signed with the public key as an HMAC secret never verifies) and kid must be present;
// - the key comes from GitHub's JWKS at the hard-coded JWKS_URL (never discovered from the token or an issuer
//   document), imported as RSASSA-PKCS1-v1_5 / SHA-256;
// - iss, aud (the Worker's AUDIENCE: production and staging have different audiences, so a token minted for one is
//   refused by the other), exp, nbf, iat, and repository_id: REPOSITORY_ID or a peer repository some pair names (the
//   numeric id survives a rename or a transfer of the repository; owner, repository and workflow NAMES are never
//   matched in full, so a rename cannot lock the feed out).
//
// Authorisation (403: a token of a known repository, but not for this route):
// - ref_type branch, runner_environment github-hosted, event_name schedule or workflow_dispatch (no push, no
//   pull_request: a PR's ref is refs/pull/N/merge anyway), ref refs/heads/main unless ALLOW_ANY_REF (staging only);
// - workflow_ref must end with `/.github/workflows/<file>@<ref>`, and (repository_id, <file>) must be one of the
//   right's pairs, with the pair's `environment` claim and events when it names them (the restore).
//
// JWKS cache: the imported keys live per isolate and the JWKS document in the Cache API (it works on the Worker's custom
// domain) for JWKS_TTL_MS; an older copy is kept JWKS_STALE_MS and used when GitHub cannot be reached (stale-if-error,
// done here because the Cache API does not implement stale-if-error itself). The network is asked at most once per
// REFETCH_MIN_MS per isolate, whether the copy is old or a token names a kid the copy lacks (GitHub rotated its key), so
// a flood of tokens with made-up kids costs one JWKS fetch a minute.

export const ISSUER = 'https://token.actions.githubusercontent.com';
export const JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';
export const SKEW_S = 30;
export const JWKS_TTL_MS = 3_600_000;
export const JWKS_STALE_MS = 7 * 86_400_000;
export const REFETCH_MIN_MS = 60_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
// A GitHub OIDC token is about 1.2 KB; anything far larger is refused before it is decoded.
const MAX_TOKEN_CHARS = 8_192;

// Who may call what: (repository_id, workflow) PAIRS, never bare workflow file names (storage phase 4.0). A second
// repository (phase 5.3's new data repository, its own publish.yml) will be admitted by its own numeric id, and a
// file name it shares with this repository (publish.yml, aggregate.yml) then matches nothing here: every pair names
// the repository it belongs to. `repository: HOME` is the Worker's REPOSITORY_ID (this repository); a peer is a
// numeric id string. A pair may also require the token's `environment` claim (a GitHub Environment, whose required
// reviewers GitHub enforces before the job gets a token at all, once the Environment exists with them) and narrow the
// events.
export const HOME = 'home';
const pair = (workflow, extra = {}) => Object.freeze({ repository: HOME, workflow, ...extra });
const pairs = (...workflows) => Object.freeze(workflows.map((w) => pair(w)));

/** The workflows each blob route admits (protocol 1). */
export const ROUTE_POLICY = Object.freeze({
  // Readers: the jobs that hydrate the event map (aggregate, derive), first-solutions' collect job, the backup and GC
  // jobs (the backup tars the blobs; GC reads nothing today but may verify a blob it keeps).
  read: pairs('aggregate.yml', 'derive.yml', 'first-solutions.yml', 'state-backup.yml', 'state-gc.yml'),
  // Writers: only the aggregate job persists the event map. derive.yml's prune is a pure local edit of the generation
  // document (it never uploads a blob), so it holds no write right; add a workflow here only when it calls persist.
  write: pairs('aggregate.yml'),
  gc: pairs('state-gc.yml'),
  // Today's counters: every reader, plus the health watchdog (feed:state-budget). health holds no blob right.
  budget: pairs('aggregate.yml', 'derive.yml', 'first-solutions.yml', 'state-backup.yml', 'state-gc.yml', 'health.yml'),
});

/**
 * The restore pair: only state-restore.yml, only dispatched by hand, and only in a job whose token carries
 * `environment: state-restore`. It is the one writer that may send `restore_of` (a ref PUT that jumps head_seq
 * forward); it reads the ref and the reflog it restores from. The rehearsal workflow is never admitted here, not even
 * on staging. The claim proves only that the job named the GitHub Environment, not that it was reviewed: GitHub creates
 * a named Environment that does not exist with no protection rules, so the owner's review holds only once the owner has
 * created `state-restore` with a required reviewer and deployments limited to main (state/README.md, Owner setup step
 * 5), before any state-restore.yml lands.
 */
export const RESTORE_ENVIRONMENT = 'state-restore';
export const RESTORE_PAIR = pair('state-restore.yml', { environment: RESTORE_ENVIRONMENT, events: Object.freeze(['workflow_dispatch']) });

/**
 * The CAS refs (protocol 2, state/src/refs.js): one per writer lane, each with its own read, write and reflog
 * pairs. In step 4.0 nothing in the production pipeline calls them (inert): 4.1 writes `main-shadow`, 4.3 makes `main`
 * the truth, 4.5 moves first-solutions and history to their lanes. The lists are the end state of the design, so those
 * steps need no Worker deploy for authorisation alone; a list only ever grants a lane, never a blob route.
 * - read: the lane's writers and every job that hydrates from it (remediate's head.seq, stats and history read
 *   refs/main from 4.2, health's reconciler compares ref and trailer);
 * - write: under the writer lock for main (aggregate, derive, backfill, archive and state-gc), the lockless lanes'
 *   own commit jobs;
 * - reflog: GC and backup find their roots there, health checks it for gaps; the restore pair reads it everywhere.
 */
const MAIN_WRITERS = ['aggregate.yml', 'derive.yml', 'backfill.yml', 'archive.yml', 'state-gc.yml'];
const MAINTENANCE = ['state-gc.yml', 'state-backup.yml', 'health.yml'];
const lane = ({ read, write, restore }) =>
  Object.freeze({
    read: Object.freeze([...pairs(...new Set([...write, ...read, ...MAINTENANCE])), ...(restore ? [RESTORE_PAIR] : [])]),
    write: pairs(...write),
    reflog: Object.freeze([...pairs(...MAINTENANCE), ...(restore ? [RESTORE_PAIR] : [])]),
    restore: Object.freeze(restore ? [RESTORE_PAIR] : []),
  });
export const LANE_POLICY = Object.freeze({
  main: lane({ write: MAIN_WRITERS, read: ['remediate.yml', 'stats.yml', 'history.yml'], restore: true }),
  // 4.1's shadow of main: written after each data push, compared at run start; never restored (it is rebuilt from git).
  'main-shadow': lane({ write: ['aggregate.yml', 'derive.yml', 'backfill.yml', 'archive.yml'], read: [], restore: false }),
  'first-solutions': lane({ write: ['first-solutions.yml'], read: ['derive.yml'], restore: true }),
  history: lane({ write: ['history.yml', 'remerge.yml'], read: ['derive.yml', 'stats.yml'], restore: true }),
});
export const LANES = Object.freeze(Object.keys(LANE_POLICY));
/** Staging only: a rehearsal lane per run (state-rehearsal.yml), so "create twice" always starts from no ref. */
export const REHEARSAL_LANE = /^rehearsal-[a-z0-9][a-z0-9-]{0,47}$/;

/** The rehearsal workflow (synthetic data only) is admitted on every route but restore, and only on staging. */
export const STAGING_WORKFLOWS = ['state-rehearsal.yml'];

/** The policy the Worker enforces (tests inject another, e.g. with a peer repository's pair). */
export const DEFAULT_POLICY = Object.freeze({ routes: ROUTE_POLICY, lanes: LANE_POLICY, staging: STAGING_WORKFLOWS });

/** The bare workflow names of HOME's pairs for a blob route (docs and tests). */
export function workflowsFor(right, policy = DEFAULT_POLICY) {
  return (policy.routes[right] ?? []).filter((p) => p.repository === HOME).map((p) => p.workflow);
}

/** Every repository id a token may come from: the Worker's own, plus each peer a pair names. */
export function knownRepositories(homeId, policy = DEFAULT_POLICY) {
  const ids = new Set([String(homeId)]);
  const add = (list) => {
    for (const p of list) if (p.repository !== HOME) ids.add(String(p.repository));
  };
  for (const list of Object.values(policy.routes)) add(list);
  for (const l of Object.values(policy.lanes)) for (const list of Object.values(l)) add(list);
  return [...ids];
}

export class AuthError extends Error {
  /** status 401 (not authenticated), 403 (authenticated, not allowed) or 503 (keys unavailable: retry). */
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

const textDecoder = new TextDecoder();

function base64urlBytes(s) {
  // A length of 1 mod 4 is no base64 at all (atob throws a DOMException, which would surface as a 500).
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new AuthError(401, 'malformed token');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  let bin;
  try {
    bin = atob(b64);
  } catch {
    throw new AuthError(401, 'malformed token');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64urlJson(s) {
  try {
    const v = JSON.parse(textDecoder.decode(base64urlBytes(s)));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch (err) {
    if (err instanceof AuthError) throw err;
  }
  throw new AuthError(401, 'malformed token');
}

/** The bearer token of a request, or an AuthError(401). */
export function bearerToken(request) {
  const h = request.headers.get('authorization');
  if (!h) throw new AuthError(401, 'missing bearer token');
  const m = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(h);
  if (!m || m[1].length > MAX_TOKEN_CHARS) throw new AuthError(401, 'malformed token');
  return m[1];
}

async function importJwks(doc) {
  const keys = new Map();
  if (!doc || !Array.isArray(doc.keys)) throw new Error('JWKS without keys');
  for (const jwk of doc.keys) {
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
    if (jwk.alg != null && jwk.alg !== 'RS256') continue;
    if (jwk.use != null && jwk.use !== 'sig') continue;
    if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      keys.set(jwk.kid, key);
    } catch {
      // A key this runtime cannot import is skipped; a token naming it fails as an unknown kid.
    }
  }
  if (keys.size === 0) throw new Error('JWKS without a usable RS256 key');
  return keys;
}

async function fetchJwksFromGitHub() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), JWKS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(JWKS_URL, {
      headers: { accept: 'application/json', 'user-agent': 'earthquakes-feed-state' },
      signal: abort.signal,
    });
    if (res.status !== 200) throw new Error(`JWKS HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The per-isolate key store. deps: fetchJwks() → the JWKS document (default: GitHub), cache (a Cache API cache, or
 * null), cacheKey (a GET URL on the Worker's own host), now() → epoch ms.
 */
export function createKeyStore({ fetchJwks = fetchJwksFromGitHub, cache = null, now = Date.now } = {}) {
  /** @type {{keys: Map<string, CryptoKey>, fetchedMs: number} | null} */
  let current = null;
  let lastAttemptMs = -Infinity;
  let cacheChecked = false;

  async function fromCache(cacheKey) {
    if (!cache || !cacheKey) return null;
    try {
      const hit = await cache.match(cacheKey);
      if (!hit) return null;
      const fetchedMs = Number(hit.headers.get('x-jwks-fetched-ms'));
      if (!Number.isFinite(fetchedMs)) return null;
      return { keys: await importJwks(await hit.json()), fetchedMs };
    } catch {
      return null;
    }
  }

  async function refresh(cacheKey) {
    lastAttemptMs = now();
    const doc = await fetchJwks();
    const keys = await importJwks(doc);
    const fetchedMs = now();
    current = { keys, fetchedMs };
    if (cache && cacheKey) {
      try {
        await cache.put(
          cacheKey,
          new Response(JSON.stringify(doc), {
            headers: {
              'content-type': 'application/json',
              'cache-control': `max-age=${Math.floor(JWKS_STALE_MS / 1000)}`,
              'x-jwks-fetched-ms': String(fetchedMs),
            },
          }),
        );
      } catch {
        // The isolate copy still serves; the next isolate fetches again.
      }
    }
  }

  /** The verification key for kid, or an AuthError (401 unknown kid, 503 no keys at all). */
  async function keyFor(kid, cacheKey) {
    if (!cacheChecked || !current || now() - current.fetchedMs >= JWKS_TTL_MS) {
      cacheChecked = true;
      const cached = await fromCache(cacheKey);
      if (cached && (!current || cached.fetchedMs > current.fetchedMs)) current = cached;
    }
    const fresh = current != null && now() - current.fetchedMs < JWKS_TTL_MS;
    const known = current?.keys.get(kid);
    if (fresh && known) return known;
    if (now() - lastAttemptMs >= REFETCH_MIN_MS) {
      try {
        await refresh(cacheKey);
      } catch (err) {
        console.error(JSON.stringify({ t: 'feed-state', event: 'jwks-fetch-failed', error: String(err) }));
      }
    }
    if (current && now() - current.fetchedMs < JWKS_STALE_MS) {
      const key = current.keys.get(kid);
      if (key) return key;
      throw new AuthError(401, 'unknown kid');
    }
    throw new AuthError(503, 'signing keys unavailable');
  }

  return { keyFor };
}

/**
 * Verify a token's signature and its identity claims. Returns the claims, or throws an AuthError (401, or 503 when no
 * signing key can be had). opts: {audience, repositoryIds (knownRepositories), keyStore, cacheKey, nowMs}.
 */
export async function verifyToken(token, { audience, repositoryIds, keyStore, cacheKey, nowMs }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError(401, 'malformed token');
  const header = base64urlJson(parts[0]);
  // Pinned: RS256 only. Never trust the header's alg to choose the verification algorithm.
  if (header.alg !== 'RS256') throw new AuthError(401, 'alg not RS256');
  if (typeof header.kid !== 'string' || header.kid.length === 0) throw new AuthError(401, 'missing kid');
  const claims = base64urlJson(parts[1]);
  const signature = base64urlBytes(parts[2]);
  const key = await keyStore.keyFor(header.kid, cacheKey);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  if (!valid) throw new AuthError(401, 'bad signature');

  const now = Math.floor(nowMs / 1000);
  if (claims.iss !== ISSUER) throw new AuthError(401, 'wrong issuer');
  const aud = claims.aud;
  if (!(aud === audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === audience))) {
    throw new AuthError(401, 'wrong audience');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now - SKEW_S) throw new AuthError(401, 'expired');
  if (typeof claims.nbf !== 'number' || claims.nbf > now + SKEW_S) throw new AuthError(401, 'not yet valid');
  if (claims.iat != null && (typeof claims.iat !== 'number' || claims.iat > now + SKEW_S)) {
    throw new AuthError(401, 'issued in the future');
  }
  if (!repositoryIds.map(String).includes(String(claims.repository_id ?? ''))) throw new AuthError(401, 'wrong repository');
  return claims;
}

/** Whether claims match one pair: its repository (HOME = homeId), workflow, environment and events. */
function matches(p, claims, workflow, homeId) {
  const repo = p.repository === HOME ? String(homeId) : String(p.repository);
  if (String(claims.repository_id ?? '') !== repo || p.workflow !== workflow) return false;
  if (p.environment != null && claims.environment !== p.environment) return false;
  return !p.events || p.events.includes(claims.event_name);
}

/** The pairs a right admits: a blob route ('read' | 'write' | 'gc' | 'budget'), or a lane right ('ref-read' |
 *  'ref-write' | 'reflog' | 'restore') of `lane`. A rehearsal lane has no production pairs (staging adds its own). */
function pairsFor(right, lane, policy) {
  if (right.startsWith('ref-') || right === 'reflog' || right === 'restore') {
    const l = policy.lanes[lane];
    if (!l) return [];
    return { 'ref-read': l.read, 'ref-write': l.write, reflog: l.reflog, restore: l.restore }[right] ?? [];
  }
  return policy.routes[right] ?? [];
}

/**
 * Authorise verified claims for a right: a blob route, a lane right with opts.lane, or 'probe' (staging's rehearsal
 * probes). Returns the workflow file name, or throws an AuthError(403). opts: {repositoryId (the home id), allowAnyRef,
 * staging, lane, policy}. On staging the rehearsal workflow of the home repository is admitted on every right but
 * restore; a rehearsal lane admits nothing else.
 */
export function authorize(claims, right, { repositoryId, allowAnyRef, staging, lane = null, policy = DEFAULT_POLICY }) {
  if (claims.ref_type !== 'branch') throw new AuthError(403, 'ref_type not branch');
  if (claims.runner_environment !== 'github-hosted') throw new AuthError(403, 'runner not github-hosted');
  if (claims.event_name !== 'schedule' && claims.event_name !== 'workflow_dispatch') {
    throw new AuthError(403, `event ${String(claims.event_name)} not allowed`);
  }
  const ref = claims.ref;
  if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')) throw new AuthError(403, 'ref not a branch');
  if (!allowAnyRef && ref !== 'refs/heads/main') throw new AuthError(403, 'ref not main');
  const wr = claims.workflow_ref;
  const suffix = `@${ref}`;
  if (typeof wr !== 'string' || !wr.endsWith(suffix)) throw new AuthError(403, 'workflow_ref does not match ref');
  const m = /\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)$/.exec(wr.slice(0, -suffix.length));
  if (!m) throw new AuthError(403, 'workflow_ref not a workflow file');
  const workflow = m[1];
  const allowed = pairsFor(right, lane, policy);
  const rehearsal =
    staging && right !== 'restore' && String(claims.repository_id ?? '') === String(repositoryId) && policy.staging.includes(workflow);
  if (!(allowed.some((p) => matches(p, claims, workflow, repositoryId)) || rehearsal)) {
    throw new AuthError(403, `workflow ${workflow} not allowed on ${right}${lane ? ` ${lane}` : ''}`);
  }
  return workflow;
}
