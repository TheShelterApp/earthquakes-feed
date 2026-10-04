// Types for heartbeat/src/worker.js (plain JavaScript, deployed as it is by wrangler). Only the tests import it from
// TypeScript.

/** The workflow file to dispatch for a UTC minute (0-59), or null. */
export function workflowFor(minute: number): string | null;
/** The `inputs` of that workflow's dispatch, or null for none. */
export function inputsFor(workflow: string): Record<string, string> | null;

declare const worker: {
  scheduled(event: { scheduledTime: number }, env: { GH_PAT: string }, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void>;
  fetch(): Promise<Response>;
};
export default worker;
