// Types for state/src/worker.js (plain JavaScript, deployed as it is by wrangler). Only the tests import it from
// TypeScript.
import type { KeyStore, JwksCache, Policy } from './auth.js';

export const BUDGET_NAME: string;
export const PROTOCOL_HEADER: string;
export const CRITICAL_WORKFLOWS: string[];

/** The Worker's env: vars as strings, the R2 bucket and the budget ledger's namespace (shapes kept loose for fakes). */
export interface Env {
  ENVIRONMENT: string;
  REPOSITORY_ID: string;
  AUDIENCE: string;
  ALLOW_ANY_REF: string;
  MIN_PROTOCOL: string;
  REF_BACKEND: string;
  CLASS_A_PER_DAY: string;
  CLASS_B_PER_DAY: string;
  BYTES_WRITTEN_PER_DAY: string;
  STORED_BYTES_MAX: string;
  STATE: unknown;
  BUDGET: { idFromName(name: string): unknown; get(id: unknown): unknown };
}
export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}
export type Handler = (request: Request, env: Env, ctx?: Ctx) => Promise<Response>;

export function configFrom(env: Env): {
  repositoryId: string;
  audience: string;
  allowAnyRef: boolean;
  staging: boolean;
  minProtocol: number;
  refBackend: 'r2' | 'do';
  ceilings: Record<string, number>;
};
/** batchGet's pipe: an IdentityTransformStream where the runtime has one (Workers), a standard TransformStream otherwise. */
export function byteStream(): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
export function createHandler(deps?: {
  keyStore?: KeyStore;
  cache?: JwksCache | null;
  now?: () => number;
  log?: (line: string) => void;
  policy?: Policy;
}): Handler;

declare const worker: { fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> };
export default worker;
