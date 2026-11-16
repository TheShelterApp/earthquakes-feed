// Types for state/src/budget.js. Only the tests import it from TypeScript.

/** The subset of the Durable Object's `ctx.storage.sql` the ledger uses. */
export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

/** The Worker's ceilings, by the names of its vars. */
export interface Ceilings {
  CLASS_A_PER_DAY: number;
  CLASS_B_PER_DAY: number;
  BYTES_WRITTEN_PER_DAY: number;
  STORED_BYTES_MAX: number;
}
export interface Cost {
  classA?: number;
  classB?: number;
  bytes?: number;
}
export type Ceiling = 'class_a' | 'class_b' | 'bytes_written' | 'stored_bytes';
export type Verdict = { ok: true } | { ok: false; ceiling: Ceiling } | { ok: false; pass: true };
export interface Snapshot {
  day: string;
  used: { class_a: number; class_b: number; bytes_written: number; requests: number; refused: number };
  stored_bytes: number;
  stored_seeded_at: string | null;
  gc_pass_open: boolean;
  ceilings: Record<Ceiling, number>;
}

export const KEEP_DAYS: number;
export const SCHEMA: string[];
export const CEILINGS: Record<keyof Ceilings, Ceiling>;
export function utcDay(nowMs: number): string;
export function reserve(sql: Sql, args: { nowMs: number; cost: Cost; ceilings: Ceilings }): Verdict;
export function refundStored(sql: Sql, bytes: number): void;
export function gcBegin(
  sql: Sql,
  args: { nowMs: number; cursor: string | null; keepHash: string; cost: Cost; ceilings: Ceilings },
): Verdict;
export function gcEnd(
  sql: Sql,
  args: { nowMs: number; cursor: string | null; nextCursor: string | null; keepHash: string; keptBytes: number; deletedBytes: number },
): void;
export function snapshot(sql: Sql, args: { nowMs: number; ceilings: Ceilings }): Snapshot;
