// The Worker's entry module (wrangler.toml `main`): the HTTP handler from worker.js and the budget ledger's Durable
// Object class. Only this module imports `cloudflare:workers`, so worker.js, auth.js, cas.js and budget.js stay
// importable by the Node tests (tests/state-worker.test.ts), as in heartbeat/src/index.js.
import { DurableObject } from 'cloudflare:workers';
import { SCHEMA, gcBegin, gcEnd, refundStored, reserve, snapshot } from './budget.js';

export { default } from './worker.js';

/** One instance (idFromName 'global'), SQLite-backed (wrangler.toml migration v1). See budget.js. */
export class BudgetLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
  }

  reserve(args) {
    return reserve(this.ctx.storage.sql, args);
  }

  refundStored(bytes) {
    refundStored(this.ctx.storage.sql, bytes);
  }

  gcBegin(args) {
    return gcBegin(this.ctx.storage.sql, args);
  }

  gcEnd(args) {
    gcEnd(this.ctx.storage.sql, args);
  }

  snapshot(args) {
    return snapshot(this.ctx.storage.sql, args);
  }
}
