// The dispatch ledger: at most one dispatch per (workflow, intended UTC minute), whatever Cloudflare does.
//
// Cron Triggers are not exactly-once. During the 2026-10-14 "Cron Trigger Activation Issues" incident the one
// `* * * * *` trigger fired twice a minute (scheduledTime about :22 and :51 of the same minute), so every workflow was
// dispatched twice and the aggregate runs queued in the writer group (wait 10 -> 21 min against the 30-minute
// freshness contract). The Worker therefore claims (workflow, minute) in ONE SQLite-backed Durable Object before it
// dispatches: the object handles one call at a time and its storage is strongly consistent, so of any number of
// activations for the same minute, from any colo, in any order, exactly one wins the claim.
//
// - A claim is a row keyed (minute, workflow); `INSERT ... ON CONFLICT DO NOTHING RETURNING` tells the winner.
// - A dispatch that fails (GitHub non-2xx, network error, timeout) releases its claim, so a later activation of the
//   same minute (a duplicate, or a Cloudflare retry of the failed invocation) may retry it. GitHub may rarely have
//   created a run despite a 5xx; a second run of a minute is the lesser harm than a lost tick.
// - An activation more than ACCEPT_MINUTES late is refused as stale: every workflow runs at least hourly, so a newer
//   activation of the same workflow has superseded it, and a catch-up burst cannot queue a backlog of old ticks.
// - Rows are kept KEEP_MINUTES (longer than ACCEPT_MINUTES), so every minute that can still be claimed has its row:
//   duplicates are refused exactly; the table holds about 57 rows (19 an hour, 3 hours).
//
// Cost on the Workers Free plan (account-wide, shared with the alerts gateway: DO rows written 100,000/day, rows read
// 5,000,000/day, requests 100,000/day). Measured in workerd: a claim writes 2 rows (the insert and the one row pruned)
// and reads 3, a duplicate writes 0 and reads 2, a release writes 1. 19 dispatches an hour = about 912 rows written,
// 1,400 rows read and 456 requests a day (twice the reads and requests while Cloudflare doubles the activations).
//
// Pure functions over a `sql.exec(query, ...bindings)` handle (the Durable Object's `ctx.storage.sql`), so the tests
// run them on node:sqlite; heartbeat/src/index.js wraps them in the Durable Object class.

export const ACCEPT_MINUTES = 60;
export const KEEP_MINUTES = 180;

export const SCHEMA = `CREATE TABLE IF NOT EXISTS dispatches (
  minute INTEGER NOT NULL,
  workflow TEXT NOT NULL,
  claimed_ms INTEGER NOT NULL,
  PRIMARY KEY (minute, workflow)
) WITHOUT ROWID`;

/**
 * Claim (workflow, minute) — minute is the intended UTC minute in epoch minutes, floor(scheduledTime / 60000).
 * Returns 'claimed' (the caller dispatches), 'duplicate' (another activation of this minute holds the claim) or
 * 'stale' (more than ACCEPT_MINUTES late).
 */
export function claimMinute(sql, workflow, minute, nowMs) {
  const nowMinute = Math.floor(nowMs / 60_000);
  if (minute < nowMinute - ACCEPT_MINUTES) return 'stale';
  sql.exec('DELETE FROM dispatches WHERE minute < ?', nowMinute - KEEP_MINUTES);
  const won = sql
    .exec(
      'INSERT INTO dispatches (minute, workflow, claimed_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING minute',
      minute,
      workflow,
      nowMs,
    )
    .toArray();
  return won.length === 1 ? 'claimed' : 'duplicate';
}

/** Drop the claim of a dispatch that failed, so a later activation of the same minute may retry it. */
export function releaseMinute(sql, workflow, minute) {
  sql.exec('DELETE FROM dispatches WHERE minute = ? AND workflow = ?', minute, workflow);
}
