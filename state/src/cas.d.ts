// Types for state/src/cas.js. Only the tests import it from TypeScript.

export const BLOB_PREFIX: string;
export const MAX_BLOB_BYTES: number;
export const MAX_BATCH: number;
export const MAX_CURRENT: number;
export const MAX_KEEP: number;
export const MIN_AGE_DAYS: number;
export const MAX_DELETES: number;
export const BLOB_METADATA: Record<string, string>;
export function isSha(s: unknown): boolean;
export function blobKey(sha: string): string;
export function shaOfKey(key: string): string | null;
export function r2ErrorCode(err: unknown): number | null;
export function keepHash(keep: string[]): Promise<string>;
