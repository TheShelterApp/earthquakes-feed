// Types for heartbeat/src/ledger.js. Only the tests import it from TypeScript.

/** The subset of the Durable Object's `ctx.storage.sql` the ledger uses. */
export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

export const ACCEPT_MINUTES: number;
export const KEEP_MINUTES: number;
export const SCHEMA: string;
export function claimMinute(sql: Sql, workflow: string, minute: number, nowMs: number): 'claimed' | 'duplicate' | 'stale';
export function releaseMinute(sql: Sql, workflow: string, minute: number): void;
