// Types for state/src/refs.js. Only the tests import it from TypeScript.
import type { Sql } from './budget.js';

export const REF_FORMAT: number;
export const REF_PROTOCOL: number;
export const MAX_REF_BYTES: number;
export const SEQ_DIGITS: number;
export const MAX_SEQ: number;
export const MAX_REFLOG_PAGE: number;
export const REF_PREFIX: string;
export const REFLOG_PREFIX: string;
export const PROBE_PREFIX: string;
export const REFS_SCHEMA: string;
export function createOnly(): Headers;
export class RefError extends Error {
  constructor(status: number, message: string, extra?: Record<string, unknown>);
  status: number;
  extra: Record<string, unknown>;
}
export function refKey(lane: string): string;
export function reflogKey(lane: string, seq: number): string;
export function canonicalJson(v: unknown): string;
export function parseRefBody(text: string, lane: string, who: { workflow: string; runId: unknown; runAttempt: unknown }): Record<string, unknown>;
export function checkSuccessor(cur: Record<string, unknown> | null, next: Record<string, unknown>): void;
export function reflogMetadata(ref: Record<string, unknown>): Record<string, string>;
export function httpEtag(etag: string): string;
export function parseIfMatch(raw: string | null): string | null | undefined;
export function computedEtag(text: string): Promise<string>;
export function refGetSql(sql: Sql, lane: string): { text: string; etag: string } | null;
export function refSwapSql(sql: Sql, args: { lane: string; expect: string | null; text: string; etag: string; nowMs: number }): { ok: boolean };
