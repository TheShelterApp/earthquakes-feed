// Types for state/src/auth.js. Only the tests import it from TypeScript.

export const ISSUER: string;
export const JWKS_URL: string;
export const SKEW_S: number;
export const JWKS_TTL_MS: number;
export const JWKS_STALE_MS: number;
export const REFETCH_MIN_MS: number;
export const ROUTE_WORKFLOWS: Record<'read' | 'write' | 'gc' | 'budget', string[]>;
export const STAGING_WORKFLOWS: string[];

export class AuthError extends Error {
  constructor(status: 401 | 403 | 503, reason: string);
  status: 401 | 403 | 503;
  reason: string;
}

/** The subset of the Cache API the key store uses. */
export interface JwksCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}
export interface KeyStore {
  keyFor(kid: string, cacheKey?: string): Promise<CryptoKey>;
}
export function createKeyStore(deps?: { fetchJwks?: () => Promise<unknown>; cache?: JwksCache | null; now?: () => number }): KeyStore;
export function bearerToken(request: Request): string;
export function verifyToken(
  token: string,
  opts: { audience: string; repositoryId: string; keyStore: KeyStore; cacheKey?: string; nowMs: number },
): Promise<Record<string, unknown>>;
export function authorize(
  claims: Record<string, unknown>,
  route: 'read' | 'write' | 'gc' | 'budget',
  opts: { allowAnyRef: boolean; staging: boolean },
): string;
