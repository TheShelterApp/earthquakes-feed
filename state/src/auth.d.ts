// Types for state/src/auth.js. Only the tests import it from TypeScript.

export const ISSUER: string;
export const JWKS_URL: string;
export const SKEW_S: number;
export const JWKS_TTL_MS: number;
export const JWKS_STALE_MS: number;
export const REFETCH_MIN_MS: number;
export const KEYLESS_REFETCH_MS: number;
export const KEYLESS_RETRY_DELAY_MS: number;
export const JWKS_BUCKET_KEY: string;
export const BUCKET_READ_MIN_MS: number;
export const BUCKET_WRITE_MIN_MS: number;
export const BUCKET_RESTAMP_MS: number;
/** One (repository_id, workflow) pair: repository HOME is the Worker's REPOSITORY_ID, else a numeric id string. */
export interface Pair {
  repository: string;
  workflow: string;
  environment?: string;
  events?: readonly string[];
}
export type BlobRight = 'read' | 'write' | 'gc' | 'budget';
export type LaneRight = 'ref-read' | 'ref-write' | 'reflog' | 'restore';
export type Right = BlobRight | LaneRight | 'probe';
export interface LaneRules {
  read: readonly Pair[];
  write: readonly Pair[];
  reflog: readonly Pair[];
  restore: readonly Pair[];
}
export interface Policy {
  routes: Record<BlobRight, readonly Pair[]>;
  lanes: Record<string, LaneRules>;
  staging: readonly string[];
}
export const HOME: string;
export const ROUTE_POLICY: Record<BlobRight, readonly Pair[]>;
export const LANE_POLICY: Record<'main' | 'main-shadow' | 'first-solutions' | 'history', LaneRules>;
export const LANES: readonly string[];
export const REHEARSAL_LANE: RegExp;
export const RESTORE_ENVIRONMENT: string;
export const RESTORE_PAIR: Pair;
export const STAGING_WORKFLOWS: string[];
export const DEFAULT_POLICY: Policy;
export function workflowsFor(right: BlobRight, policy?: Policy): string[];
export function knownRepositories(homeId: string, policy?: Policy): string[];

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
/** The subset of the R2 binding the key store uses for its copy of the JWKS (JWKS_BUCKET_KEY). */
export interface JwksBucket {
  get(key: string): Promise<{ size: number; body: ReadableStream | null; customMetadata?: Record<string, string> } | null>;
  put(key: string, value: string, opts: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
}
/** The bucket operations one keyFor caused (metered apart from any route's reservation). */
export interface JwksCost {
  classA: number;
  classB: number;
  bytes: number;
}
/** keyFor's per-request deps. */
export interface KeyStoreRequest {
  bucket?: JwksBucket | null;
  meter?: (cost: JwksCost) => unknown;
  defer?: (p: Promise<unknown>) => void;
  events?: string[];
}
export interface KeyStore {
  keyFor(kid: string, cacheKey?: string, store?: KeyStoreRequest): Promise<CryptoKey>;
}
export function createKeyStore(deps?: {
  fetchJwks?: (timeoutMs?: number) => Promise<unknown>;
  cache?: JwksCache | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): KeyStore;
export function bearerToken(request: Request): string;
export function verifyToken(
  token: string,
  opts: { audience: string; repositoryIds: string[]; keyStore: KeyStore; cacheKey?: string; nowMs: number; store?: KeyStoreRequest },
): Promise<Record<string, unknown>>;
export function authorize(
  claims: Record<string, unknown>,
  right: Right,
  opts: { repositoryId: string; allowAnyRef: boolean; staging: boolean; lane?: string | null; policy?: Policy },
): string;
