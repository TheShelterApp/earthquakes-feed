// The Worker's entry module (wrangler.toml `main`): the HTTP handler from worker.js and the budget ledger's Durable
// Object class. Only this module imports `cloudflare:workers`, so worker.js, auth.js, cas.js, refs.js and budget.js stay
// importable by the Node tests (tests/state-worker.test.ts, tests/state-refs.test.ts), as in heartbeat/src/index.js.
import { DurableObject } from 'cloudflare:workers';
import { charge, gcBegin, gcEnd, migrate, reflogCollision, refundRef, refundStored, reserve, snapshot } from './budget.js';
import { REFS_SCHEMA, refGetSql, refSwapSql } from './refs.js';

export { default } from './worker.js';

/**
 * One instance (idFromName 'global'), SQLite-backed (wrangler.toml migration v1). See budget.js. It also holds the
 * refs table of the ref fallback (REF_BACKEND = "do", refs.js): empty and unused while refs live in R2.
 */
export class BudgetLedger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    migrate(ctx.storage.sql, [REFS_SCHEMA]);
  }

  reserve(args) {
    return reserve(this.ctx.storage.sql, args);
  }

  charge(args) {
    charge(this.ctx.storage.sql, args);
  }

  refundStored(bytes, reservedMs) {
    refundStored(this.ctx.storage.sql, bytes, reservedMs);
  }

  refundRef(args) {
    refundRef(this.ctx.storage.sql, args);
  }

  reflogCollision(args) {
    reflogCollision(this.ctx.storage.sql, args);
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

  refGet(lane) {
    return refGetSql(this.ctx.storage.sql, lane);
  }

  refSwap(args) {
    return refSwapSql(this.ctx.storage.sql, args);
  }
}
