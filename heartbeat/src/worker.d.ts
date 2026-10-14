// Types for heartbeat/src/worker.js (plain JavaScript, deployed as it is by wrangler). Only the tests import it from
// TypeScript.

/** The dispatch ledger's RPC surface (the DispatchLedger Durable Object in index.js, ledger.js). */
export interface LedgerStub {
  claim(workflow: string, minute: number): Promise<'claimed' | 'duplicate' | 'stale'>;
  release(workflow: string, minute: number): Promise<void>;
}
export interface LedgerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): LedgerStub;
}
export interface Env {
  GH_PAT: string;
  DISPATCH_LEDGER: LedgerNamespace;
}

/** The workflow file to dispatch for a UTC minute (0-59), or null. */
export function workflowFor(minute: number): string | null;
/** The `inputs` of that workflow's dispatch, or null for none. */
export function inputsFor(workflow: string): Record<string, string> | null;
/** The intended UTC minute of an activation, in epoch minutes. */
export function minuteOf(scheduledTime: number): number;
/** The name of the one ledger object. */
export const LEDGER_NAME: string;
/** One cron activation: claim, dispatch, release on failure. */
export function tick(scheduledTime: number, env: Env): Promise<void>;

declare const worker: {
  scheduled(event: { scheduledTime: number }, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<void>;
  fetch(): Promise<Response>;
};
export default worker;
