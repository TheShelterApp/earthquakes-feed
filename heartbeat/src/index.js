// The Worker's entry module (wrangler.toml `main`): the cron handler from worker.js and the dispatch ledger's Durable
// Object class. Only this module imports `cloudflare:workers`, so worker.js and ledger.js stay importable by the Node
// tests (tests/heartbeat.test.ts).
import { DurableObject } from 'cloudflare:workers';
import { SCHEMA, claimMinute, releaseMinute } from './ledger.js';

export { default } from './worker.js';

/** One instance (idFromName 'dispatch-ledger'), SQLite-backed (wrangler.toml migration v1). See ledger.js. */
export class DispatchLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(SCHEMA);
  }

  /** @returns {'claimed' | 'duplicate' | 'stale'} */
  claim(workflow, minute) {
    return claimMinute(this.ctx.storage.sql, workflow, minute, Date.now());
  }

  release(workflow, minute) {
    releaseMinute(this.ctx.storage.sql, workflow, minute);
  }
}
