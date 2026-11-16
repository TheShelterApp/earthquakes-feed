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
//   refused by the other), exp, nbf, iat, and repository_id (the numeric id survives a rename or a transfer of the
//   repository; owner, repository and workflow NAMES are never matched in full, so a rename cannot lock the feed out).
//
// Authorisation (403: a token from this repository, but not for this route):
// - ref_type branch, runner_environment github-hosted, event_name schedule or workflow_dispatch (no push, no
//   pull_request: a PR's ref is refs/pull/N/merge anyway), ref refs/heads/main unless ALLOW_ANY_REF (staging only);
// - workflow_ref must end with `/.github/workflows/<file>@<ref>` and <file> must be in the route's allow-list.
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

/** The workflows each route admits (file names under .github/workflows of this repository). */
export const ROUTE_WORKFLOWS = {
  // Readers: the jobs that hydrate the event map (aggregate, derive), first-solutions' collect job, the backup and GC
  // jobs (the backup tars the blobs; GC reads nothing today but may verify a blob it keeps).
  read: ['aggregate.yml', 'derive.yml', 'first-solutions.yml', 'state-backup.yml', 'state-gc.yml'],
  // Writers: only the aggregate job persists the event map. derive.yml's prune is a pure local edit of the generation
  // document (it never uploads a blob), so it holds no write right; add a workflow here only when it calls persist.
  write: ['aggregate.yml'],
  gc: ['state-gc.yml'],
  // Today's counters: every reader, plus the health watchdog (feed:state-budget). health holds no blob right.
  budget: ['aggregate.yml', 'derive.yml', 'first-solutions.yml', 'state-backup.yml', 'state-gc.yml', 'health.yml'],
};
/** The rehearsal workflow (synthetic data only) is admitted on every route, and only on staging. */
export const STAGING_WORKFLOWS = ['state-rehearsal.yml'];

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
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new AuthError(401, 'malformed token');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
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
 * signing key can be had). opts: {audience, repositoryId, keyStore, cacheKey, nowMs}.
 */
export async function verifyToken(token, { audience, repositoryId, keyStore, cacheKey, nowMs }) {
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
  if (String(claims.repository_id ?? '') !== String(repositoryId)) throw new AuthError(401, 'wrong repository');
  return claims;
}

/**
 * Authorise verified claims for a route ('read' | 'write' | 'gc' | 'budget'). Returns the workflow file name, or throws
 * an AuthError(403). opts: {allowAnyRef, staging}.
 */
export function authorize(claims, route, { allowAnyRef, staging }) {
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
  const allowed = ROUTE_WORKFLOWS[route] ?? [];
  if (!(allowed.includes(workflow) || (staging && STAGING_WORKFLOWS.includes(workflow)))) {
    throw new AuthError(403, `workflow ${workflow} not allowed on ${route}`);
  }
  return workflow;
}
