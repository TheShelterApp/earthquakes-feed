// The budget ledger: hard per-UTC-day ceilings on the R2 operations the state Worker may cause, so the feed's state
// store can never leave the free tier (owner decision 2026-11-16: never pay; R2 has no spend cap of its own).
//
// Every authenticated route reserves its worst case here BEFORE it touches the bucket, and is refused (429
// {"error":"budget"}) when the reservation would cross a ceiling:
// - Class A (PutObject, ListObjects): a PUT is 1, a GC page is 1 (its list; DeleteObject is free).
// - Class B (GetObject, HeadObject): a batchGet of n blobs is n (a missing blob still costs its GET), a GC first page
//   HEADs every `current` blob.
// - Bytes written: a PUT's Content-Length.
// - Stored bytes: a running estimate of the bucket's size, refusing a PUT that would take it above the ceiling. It is
//   raised by every PUT (an overwrite of an existing key counts again: the estimate errs high, never low), lowered by
//   the bytes a GC page deletes, refunded when a PUT fails, and re-seeded from the listing totals of every complete GC
//   pass (cursor null through to the page whose cursor is null) plus the bytes PUT while that pass ran (counted from
//   the first page's admission, before its listing, so no PUT of the pass's window is missed).
// The ceilings come from the Worker's vars and are passed in on every call, so a redeploy changes them at once.
//
// One object (idFromName 'global'), SQLite-backed (the only kind on the Workers Free plan). A method of the object runs
// alone and every statement here is synchronous, so each call is one atomic read-check-write. Cost (account-wide free
// limits, shared with the heartbeat ledger and the alerts gateway: rows written 100,000/day, rows read 5,000,000/day):
// one upsert of the day row per authenticated request (about 1,500 a day for the feed), one store-row update per PUT and
// per GC page; day rows older than KEEP_DAYS are pruned.
//
// The GC pass: a page with a cursor must continue the pass the ledger knows (the cursor the previous page returned and
// the same keep set, by hash). The first page (cursor null) is the one that proved every `current` blob exists and that
// `current` is inside `keep`; holding the pass here means no later page can delete with a different keep set.
//
// Pure functions over a `sql.exec(query, ...bindings)` handle (the Durable Object's `ctx.storage.sql`), so the tests run
// them on node:sqlite; state/src/index.js wraps them in the Durable Object class (as heartbeat/src/ledger.js does).

export const KEEP_DAYS = 40;

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS days (
  day TEXT NOT NULL PRIMARY KEY,
  class_a INTEGER NOT NULL DEFAULT 0,
  class_b INTEGER NOT NULL DEFAULT 0,
  bytes_written INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  refused INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS store (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  seeded_ms INTEGER,
  pass_cursor TEXT,
  pass_keep TEXT,
  pass_bytes INTEGER,
  pass_started_ms INTEGER,
  put_since_pass INTEGER NOT NULL DEFAULT 0
)`,
  `INSERT INTO store (id) VALUES (1) ON CONFLICT DO NOTHING`,
];

/** The names of the ceilings, as the Worker's vars spell them, and the counter each one bounds. */
export const CEILINGS = {
  CLASS_A_PER_DAY: 'class_a',
  CLASS_B_PER_DAY: 'class_b',
  BYTES_WRITTEN_PER_DAY: 'bytes_written',
  STORED_BYTES_MAX: 'stored_bytes',
};

/** The UTC day (YYYY-MM-DD) of an epoch-ms instant. */
export function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function dayRow(sql, day) {
  const rows = sql
    .exec('SELECT class_a, class_b, bytes_written, requests, refused FROM days WHERE day = ?', day)
    .toArray();
  const r = rows[0];
  return r
    ? {
        class_a: Number(r.class_a),
        class_b: Number(r.class_b),
        bytes_written: Number(r.bytes_written),
        requests: Number(r.requests),
        refused: Number(r.refused),
      }
    : { class_a: 0, class_b: 0, bytes_written: 0, requests: 0, refused: 0 };
}

function storeRow(sql) {
  const r = sql
    .exec(
      'SELECT stored_bytes, seeded_ms, pass_cursor, pass_keep, pass_bytes, pass_started_ms, put_since_pass FROM store WHERE id = 1',
    )
    .toArray()[0];
  return {
    stored_bytes: Number(r.stored_bytes),
    seeded_ms: r.seeded_ms == null ? null : Number(r.seeded_ms),
    pass_cursor: r.pass_cursor == null ? null : String(r.pass_cursor),
    pass_keep: r.pass_keep == null ? null : String(r.pass_keep),
    pass_bytes: r.pass_bytes == null ? null : Number(r.pass_bytes),
    pass_started_ms: r.pass_started_ms == null ? null : Number(r.pass_started_ms),
    put_since_pass: Number(r.put_since_pass),
  };
}

/** The first day kept: rows before it are pruned. */
function pruneBefore(nowMs) {
  return utcDay(nowMs - KEEP_DAYS * 86_400_000);
}

/**
 * Reserve one request's worst-case cost for the UTC day of nowMs.
 * cost: {classA, classB, bytes} (bytes = bytes written AND added to the stored estimate).
 * Returns {ok: true} or {ok: false, ceiling} naming the first ceiling the reservation would cross; a refusal is counted
 * in the day's `refused` and reserves nothing.
 */
export function reserve(sql, { nowMs, cost, ceilings }) {
  const day = utcDay(nowMs);
  sql.exec('DELETE FROM days WHERE day < ?', pruneBefore(nowMs));
  const used = dayRow(sql, day);
  const store = storeRow(sql);
  const classA = cost.classA ?? 0;
  const classB = cost.classB ?? 0;
  const bytes = cost.bytes ?? 0;
  let ceiling = null;
  if (used.class_a + classA > ceilings.CLASS_A_PER_DAY) ceiling = 'class_a';
  else if (used.class_b + classB > ceilings.CLASS_B_PER_DAY) ceiling = 'class_b';
  else if (used.bytes_written + bytes > ceilings.BYTES_WRITTEN_PER_DAY) ceiling = 'bytes_written';
  else if (bytes > 0 && store.stored_bytes + bytes > ceilings.STORED_BYTES_MAX) ceiling = 'stored_bytes';
  if (ceiling) {
    sql.exec(
      `INSERT INTO days (day, requests, refused) VALUES (?, 1, 1)
       ON CONFLICT (day) DO UPDATE SET requests = requests + 1, refused = refused + 1`,
      day,
    );
    return { ok: false, ceiling };
  }
  sql.exec(
    `INSERT INTO days (day, class_a, class_b, bytes_written, requests) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (day) DO UPDATE SET class_a = class_a + excluded.class_a, class_b = class_b + excluded.class_b,
       bytes_written = bytes_written + excluded.bytes_written, requests = requests + 1`,
    day,
    classA,
    classB,
    bytes,
  );
  if (bytes > 0) {
    sql.exec(
      'UPDATE store SET stored_bytes = stored_bytes + ?, put_since_pass = put_since_pass + ? WHERE id = 1',
      bytes,
      bytes,
    );
  }
  return { ok: true };
}

/**
 * Give back stored bytes a reservation added for a PUT that did not store anything (R2 refused it). `reservedMs` is
 * the reservation's nowMs: a PUT reserved before the open GC pass began was never counted in that pass's
 * put_since_pass (gcBegin zeroed it), so its refund must not eat a later PUT's bytes there (the estimate would read low).
 */
export function refundStored(sql, bytes, reservedMs = null) {
  const store = storeRow(sql);
  const beforePass = store.pass_started_ms != null && reservedMs != null && reservedMs < store.pass_started_ms;
  sql.exec(
    'UPDATE store SET stored_bytes = MAX(0, stored_bytes - ?), put_since_pass = MAX(0, put_since_pass - ?) WHERE id = 1',
    bytes,
    beforePass ? 0 : bytes,
  );
}

/**
 * Admit one GC page: a page with a cursor must continue the pass the ledger holds (same cursor, same keep hash), then
 * the page's cost is reserved as in `reserve`. Returns {ok: true}, {ok: false, ceiling} or {ok: false, pass: true}.
 *
 * A first page (cursor null) that is admitted starts the pass here, in the same atomic call, BEFORE its listing:
 * put_since_pass restarts at 0 and pass_started_ms is set, so every PUT reserved from now on is added on top of what
 * the listing finds (one the listing also saw counts twice: the estimate errs high, never low).
 */
export function gcBegin(sql, { nowMs, cursor, keepHash, cost, ceilings }) {
  if (cursor != null) {
    const store = storeRow(sql);
    if (store.pass_cursor !== cursor || store.pass_keep !== keepHash) return { ok: false, pass: true };
  }
  const verdict = reserve(sql, { nowMs, cost, ceilings });
  if (verdict.ok && cursor == null) sql.exec('UPDATE store SET put_since_pass = 0, pass_started_ms = ? WHERE id = 1', nowMs);
  return verdict;
}

/**
 * Record one GC page: subtract the bytes it deleted, carry the pass on to nextCursor, and on the pass's last page
 * (nextCursor null) re-seed the stored estimate with what the pass listed and kept plus what was PUT meanwhile.
 * keptBytes is the size of every listed object the page did not delete.
 */
export function gcEnd(sql, { nowMs, cursor, nextCursor, keepHash, keptBytes, deletedBytes }) {
  sql.exec('UPDATE store SET stored_bytes = MAX(0, stored_bytes - ?) WHERE id = 1', deletedBytes);
  if (cursor == null) {
    // The pass began in gcBegin (put_since_pass and pass_started_ms); a PUT reserved since then stays counted.
    sql.exec('UPDATE store SET pass_bytes = ?, pass_keep = ? WHERE id = 1', keptBytes, keepHash);
  } else {
    sql.exec('UPDATE store SET pass_bytes = pass_bytes + ? WHERE id = 1', keptBytes);
  }
  if (nextCursor == null) {
    sql.exec(
      `UPDATE store SET stored_bytes = pass_bytes + put_since_pass, seeded_ms = ?, pass_cursor = NULL, pass_keep = NULL,
         pass_bytes = NULL, pass_started_ms = NULL, put_since_pass = 0 WHERE id = 1`,
      nowMs,
    );
  } else {
    sql.exec('UPDATE store SET pass_cursor = ? WHERE id = 1', nextCursor);
  }
}

/** Today's counters, the stored estimate and the ceilings (GET /v1/budget, read by feed-health). */
export function snapshot(sql, { nowMs, ceilings }) {
  const day = utcDay(nowMs);
  const used = dayRow(sql, day);
  const store = storeRow(sql);
  return {
    day,
    used,
    stored_bytes: store.stored_bytes,
    stored_seeded_at: store.seeded_ms == null ? null : new Date(store.seeded_ms).toISOString(),
    gc_pass_open: store.pass_cursor != null,
    ceilings: {
      class_a: ceilings.CLASS_A_PER_DAY,
      class_b: ceilings.CLASS_B_PER_DAY,
      bytes_written: ceilings.BYTES_WRITTEN_PER_DAY,
      stored_bytes: ceilings.STORED_BYTES_MAX,
    },
  };
}
