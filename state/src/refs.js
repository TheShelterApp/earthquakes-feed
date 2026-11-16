// Protocol 2 of the state Worker (storage phase 4.0): compare-and-swap refs, one per writer lane, and the reflog.
//
// A ref (`refs/<lane>`) is one small canonical JSON document that names the lane's current generation blob (a CAS
// blob, cas.js) and its place in the chain:
//   {"data_commit","format":1,"generation","head_seq","lane","parent","seq","written","writer"[,"restore_of"]}
// The Worker swaps it only when the writer names the version it read (If-Match on the ETag; If-None-Match: * creates
// the lane once, the bootstrap), and only to its direct successor: seq = current seq + 1, parent = the current
// generation, head_seq never backwards (a restore must jump it forward). So two writers that read the same version can
// never both win: one gets 200, the other 412 with the current body, and fails closed (no automatic rebase).
//
// The reflog `gen/<lane>/<seq12>` holds a copy of every ref the lane ever had, written create-only right after the
// swap, so it is the GC root set, the backup index and the restore index (4.2). A Worker that dies between the swap
// and the reflog write leaves one entry missing; the next PUT of the lane repairs it from the current ref before it
// swaps (create-only again: an entry that exists is never rewritten). A reflog entry carries the ref's fields as R2
// custom metadata, so one listing page answers a GC or backup walk without a GET per entry.
//
// Subrequests per ref PUT (the Free plan allows 50; R2 binding calls may count against the larger internal limit):
//   1 GET refs/<lane>  2 HEAD the generation blob  3 PUT gen/<lane>/<cur.seq> create-only (the repair; refused when it
//   exists, which is the normal case)  4 PUT refs/<lane> onlyIf etagMatches (or create-only)  5 PUT gen/<lane>/<seq>
//   create-only. A swap refused at 4 re-GETs the ref for the 412 body instead of 5. At most 5 store operations
//   whatever happens, counted per request (x-feed-state-store-ops) and proved on staging (state-rehearsal.yml).
//
// Where the ref lives: `REF_BACKEND = "r2"` (the bucket, an R2 object whose ETag R2 assigns and whose put honours
// `onlyIf`) or `"do"`, the fallback if the staging race rehearsal shows that R2's conditional put is not an atomic
// compare-and-swap: the ref becomes a row of the existing BudgetLedger Durable Object (SQLite, one object, every method
// runs alone, so the check and the write are one transaction), behind the same HTTP API and with an ETag the Worker
// computes (the first 32 hex of the body's sha256). The reflog stays in R2 either way.

import { blobKey, isSha } from './cas.js';

export const REF_FORMAT = 1;
/** The protocol a client must send on every ref route (x-feed-state-protocol): ref writes are protocol 2. */
export const REF_PROTOCOL = 2;
export const MAX_REF_BYTES = 4096;
export const SEQ_DIGITS = 12;
export const MAX_SEQ = 10 ** SEQ_DIGITS - 1;
export const MAX_REFLOG_PAGE = 1000;
export const REF_PREFIX = 'refs/';
export const REFLOG_PREFIX = 'gen/';
/** Staging's rehearsal probes write under this prefix only (never refs/, gen/ or cas/). */
export const PROBE_PREFIX = 'rehearsal/';

/**
 * The create-only precondition of a put on the R2 binding. The binding documents `onlyIf` as an R2Conditional or a
 * Headers object with every conditional header but If-Range; `If-None-Match: *` (create only when no object exists) is
 * not spelled out for the binding, so the staging rehearsal proves it (create twice: the second must answer null) and
 * also probes R2Conditional's `etagDoesNotMatch: "*"`. If neither holds, the bootstrap of a lane is the runbook's
 * (state/README.md), and the reflog keeps its create-only intent only as far as the swap's own CAS guarantees it.
 */
export const createOnly = () => new Headers({ 'if-none-match': '*' });

const WRITER = /^([A-Za-z0-9._-]+\.ya?ml)\/([0-9]{1,20})-([0-9]{1,6})\/([A-Za-z0-9._-]{1,64})\/([0-9a-f]{16,64})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const COMMIT = /^[0-9a-f]{40}$/;
const FIELDS = new Set(['data_commit', 'format', 'generation', 'head_seq', 'lane', 'parent', 'restore_of', 'seq', 'written', 'writer']);

export class RefError extends Error {
  /** status 400 (malformed), 409 (not the successor, or its generation blob is missing), 412, 428. */
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function refKey(lane) {
  return `${REF_PREFIX}${lane}`;
}

export function reflogKey(lane, seq) {
  return `${REFLOG_PREFIX}${lane}/${String(seq).padStart(SEQ_DIGITS, '0')}`;
}

/** JSON with every object's keys sorted, no whitespace: the one serialization a ref may have. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const isSeq = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_SEQ;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * A ref body as sent: canonical JSON of exactly the ref fields, for `lane`, at most MAX_REF_BYTES, written by the
 * calling run. `who` = {workflow, runId, runAttempt} of the token: the writer id must start with
 * `<workflow>/<run_id>-<run_attempt>/`, so the reflog's audit trail names the run that really wrote, and the nonce
 * after it is what a client recognises as its own write after an ambiguous answer. Throws RefError(400).
 */
export function parseRefBody(text, lane, who) {
  const bad = (why) => {
    throw new RefError(400, `ref body: ${why}`);
  };
  if (new TextEncoder().encode(text).byteLength > MAX_REF_BYTES) bad(`above ${MAX_REF_BYTES} bytes`);
  let ref;
  try {
    ref = JSON.parse(text);
  } catch {
    bad('not JSON');
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) bad('not a JSON object');
  for (const k of Object.keys(ref)) if (!FIELDS.has(k)) bad(`unknown field ${JSON.stringify(k.slice(0, 40))}`);
  if (ref.format !== REF_FORMAT) bad(`format must be ${REF_FORMAT}`);
  if (ref.lane !== lane) bad('lane is not the path\'s lane');
  if (!isSha(ref.generation)) bad('generation must be a lowercase sha256');
  if (!isSeq(ref.seq)) bad(`seq must be an integer 1..${MAX_SEQ}`);
  if (!(ref.parent === null || isSha(ref.parent))) bad('parent must be null or a lowercase sha256');
  if (!isCount(ref.head_seq)) bad('head_seq must be a non-negative integer');
  if (typeof ref.data_commit !== 'string' || !COMMIT.test(ref.data_commit)) bad('data_commit must be a 40-hex commit');
  if (typeof ref.written !== 'string' || !ISO.test(ref.written) || !Number.isFinite(Date.parse(ref.written))) bad('written must be an ISO-8601 UTC instant');
  const w = typeof ref.writer === 'string' ? WRITER.exec(ref.writer) : null;
  if (!w) bad('writer must be <workflow>/<run_id>-<attempt>/<step>/<hex nonce>');
  if (w[1] !== who.workflow || w[2] !== String(who.runId ?? '') || w[3] !== String(who.runAttempt ?? '')) {
    bad('writer does not name the calling run (<workflow>/<run_id>-<run_attempt>/…)');
  }
  if ('restore_of' in ref) {
    const r = ref.restore_of;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).sort().join() !== 'generation,seq' || !isSeq(r.seq) || !isSha(r.generation)) {
      bad('restore_of must be {"generation": sha256, "seq": n}');
    }
  }
  if (canonicalJson(ref) !== text) bad('not canonical (sorted keys, no whitespace)');
  return ref;
}

/** The successor rules against the current ref (null: the lane has none, only a create may follow). Throws 409. */
export function checkSuccessor(cur, next) {
  if (!cur) return;
  if (next.seq !== cur.seq + 1) throw new RefError(409, `seq must be ${cur.seq + 1} (the current seq + 1)`, { current_seq: cur.seq });
  if (next.parent !== cur.generation) throw new RefError(409, 'parent must be the current generation', { current_generation: cur.generation });
  if (next.restore_of ? next.head_seq <= cur.head_seq : next.head_seq < cur.head_seq) {
    throw new RefError(409, next.restore_of ? 'a restore must jump head_seq forward' : 'head_seq must not go backwards', { current_head_seq: cur.head_seq });
  }
}

/** The ref fields kept as a reflog entry's custom metadata (strings; well under R2's 2 KiB). */
export function reflogMetadata(ref) {
  return {
    seq: String(ref.seq),
    generation: ref.generation,
    parent: ref.parent ?? '',
    head_seq: String(ref.head_seq),
    data_commit: ref.data_commit,
    written: ref.written,
    writer: ref.writer,
    restore_of: ref.restore_of ? `${ref.restore_of.seq}:${ref.restore_of.generation}` : '',
  };
}

/** A strong HTTP ETag (quoted) from an R2 or computed etag; null when the header is absent or not one strong tag. */
export const httpEtag = (etag) => `"${etag}"`;
export function parseIfMatch(raw) {
  if (raw == null) return null;
  const m = /^\s*"([^"\s]{1,128})"\s*$/.exec(raw);
  return m ? m[1] : undefined;
}

/**
 * The precondition of a ref PUT: {create: true} (If-None-Match: *), {etag} (If-Match: "<etag>"), or a RefError: 428
 * when neither is sent, 400 when both are or a tag is not one strong tag (a weak W/ tag never matches a ref).
 */
export function preconditionOf(headers) {
  const ifMatch = headers.get('if-match');
  const ifNone = headers.get('if-none-match');
  if (ifMatch != null && ifNone != null) throw new RefError(400, 'send If-Match or If-None-Match, not both');
  if (ifNone != null) {
    if (ifNone.trim() !== '*') throw new RefError(400, 'If-None-Match must be * (create the lane\'s first ref)');
    return { create: true };
  }
  if (ifMatch == null) throw new RefError(428, 'a ref PUT needs If-Match: "<etag>" (or If-None-Match: * for the first ref)');
  const etag = parseIfMatch(ifMatch);
  if (!etag) throw new RefError(400, 'If-Match must be one strong ETag');
  return { etag };
}

// ---------------------------------------------------------------------------------------------------------------------
// Where the ref lives

/** The R2 ref store: the ref object in the bucket, swapped by R2's conditional put. */
export function r2RefStore(bucket) {
  return {
    kind: 'r2',
    async get(lane) {
      const o = await bucket.get(refKey(lane));
      return o ? { text: await o.text(), etag: o.etag } : null;
    },
    /** The swap: {etag} of the new ref, or null when the precondition no longer holds. */
    async swap(lane, pre, text, ref) {
      const o = await bucket.put(refKey(lane), text, {
        onlyIf: pre.create ? createOnly() : { etagMatches: pre.etag },
        httpMetadata: { contentType: 'application/json' },
        customMetadata: reflogMetadata(ref),
      });
      return o ? { etag: o.etag } : null;
    },
  };
}

/** The ETag of a ref kept in the Durable Object: the first 32 hex of the body's sha256 (R2 uses an MD5 of 32 hex). */
export async function computedEtag(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The Durable Object ref store (REF_BACKEND = "do"): refGet / refSwap on the BudgetLedger object. */
export function doRefStore(stub) {
  return {
    kind: 'do',
    async get(lane) {
      return (await stub.refGet(lane)) ?? null;
    },
    async swap(lane, pre, text) {
      const etag = await computedEtag(text);
      const r = await stub.refSwap({ lane, expect: pre.create ? null : pre.etag, text, etag, nowMs: Date.now() });
      return r.ok ? { etag } : null;
    },
  };
}

/** The refs table of the BudgetLedger object (the fallback's state; created by budget.js migrate). */
export const REFS_SCHEMA = `CREATE TABLE IF NOT EXISTS refs (
  lane TEXT NOT NULL PRIMARY KEY,
  body TEXT NOT NULL,
  etag TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
) WITHOUT ROWID`;

/** The Durable Object side of refGet: {text, etag} or null. */
export function refGetSql(sql, lane) {
  const r = sql.exec('SELECT body, etag FROM refs WHERE lane = ?', lane).toArray()[0];
  return r ? { text: String(r.body), etag: String(r.etag) } : null;
}

/**
 * The Durable Object side of refSwap, one atomic call: expect null creates the lane's row only when it has none,
 * expect <etag> replaces the row only while it still holds that etag. {ok: true} or {ok: false}.
 */
export function refSwapSql(sql, { lane, expect, text, etag, nowMs }) {
  const cur = refGetSql(sql, lane);
  if (expect == null ? cur != null : !cur || cur.etag !== expect) return { ok: false };
  sql.exec(
    `INSERT INTO refs (lane, body, etag, updated_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT (lane) DO UPDATE SET body = excluded.body, etag = excluded.etag, updated_ms = excluded.updated_ms`,
    lane,
    text,
    etag,
    nowMs,
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// The routes' work, after authentication, the protocol gate and the budget reservation

/** A put that only creates: true when it wrote, false when an object was already there. */
async function putCreateOnly(bucket, key, text, ref) {
  const o = await bucket.put(key, text, {
    onlyIf: createOnly(),
    httpMetadata: { contentType: 'application/json' },
    customMetadata: reflogMetadata(ref),
  });
  return o != null;
}

/**
 * The 412 RefError for a lane whose current ref is `cur` (null: none). `at` says which check refused: 'read' (the GET
 * already showed another version) or 'swap' (the conditional put itself refused: two writers met at the store, which
 * is what the race rehearsal needs to have seen to prove the CAS atomic).
 */
function conflict(cur, at) {
  let current = null;
  if (cur) {
    try {
      current = JSON.parse(cur.text);
    } catch {
      current = null;
    }
  }
  return new RefError(412, 'precondition failed: the ref is not the version named', { current, etag: cur ? httpEtag(cur.etag) : null, at });
}

/**
 * PUT /v1/refs/<lane>: the six steps above over `store` (r2RefStore or doRefStore) and `bucket`. `ref` is the parsed
 * body, `text` its canonical bytes. Returns {etag, reflog: {previous: 'none' | 'present' | 'repaired', entry: 'created'
 * | 'exists'}}; throws RefError 412 (with the current body and its ETag), 409 (not the successor, or the generation
 * blob is missing; `at`: 'read' or 'swap', the check that refused). `entry: 'exists'` means the swap happened but the reflog slot of the new seq was already taken: a
 * second writer of the same seq (the CAS was not atomic) or an entry left by a lost ref; the client treats it as an
 * integrity failure, the log line names it.
 */
export async function putRef({ store, bucket, lane, pre, text, ref }) {
  const cur = await store.get(lane);
  if (pre.create ? cur != null : !cur || cur.etag !== pre.etag) throw conflict(cur, 'read');
  let curRef = null;
  if (cur) {
    try {
      curRef = JSON.parse(cur.text);
    } catch {
      throw new RefError(409, 'the current ref is not JSON: repair it by the runbook');
    }
  }
  checkSuccessor(curRef, ref);
  if (!(await bucket.head(blobKey(ref.generation)))) throw new RefError(409, 'the generation blob is missing from the store', { generation: ref.generation });
  let previous = 'none';
  if (curRef) previous = (await putCreateOnly(bucket, reflogKey(lane, curRef.seq), cur.text, curRef)) ? 'repaired' : 'present';
  const swapped = await store.swap(lane, pre, text, ref);
  if (!swapped) throw conflict(await store.get(lane), 'swap');
  const entry = (await putCreateOnly(bucket, reflogKey(lane, ref.seq), text, ref)) ? 'created' : 'exists';
  return { etag: swapped.etag, reflog: { previous, entry } };
}

/**
 * GET /v1/gen/<lane>?after=<seq>&limit=<n>: one listing page of the reflog, ascending by seq, from the entry after
 * `after` (0: from the first). Each entry is the metadata of a ref the lane had. `next` is the last seq of a truncated
 * page (ask again with after=next), null at the end. One Class A operation (a listing) a page.
 */
export async function reflogPage(bucket, lane, after, limit) {
  const prefix = `${REFLOG_PREFIX}${lane}/`;
  const page = await bucket.list({
    prefix,
    limit,
    include: ['customMetadata'],
    ...(after > 0 ? { startAfter: reflogKey(lane, after) } : {}),
  });
  const entries = [];
  for (const o of page.objects) {
    const m = /^(\d{12})$/.exec(o.key.slice(prefix.length));
    if (!m) continue;
    const md = o.customMetadata ?? {};
    const [rSeq, rGen] = (md.restore_of ?? '').split(':');
    entries.push({
      seq: Number(m[1]),
      generation: md.generation ?? null,
      parent: md.parent ? md.parent : null,
      head_seq: md.head_seq != null ? Number(md.head_seq) : null,
      data_commit: md.data_commit ?? null,
      written: md.written ?? null,
      writer: md.writer ?? null,
      restore_of: rSeq && rGen ? { seq: Number(rSeq), generation: rGen } : null,
      uploaded: new Date(o.uploaded).toISOString(),
      size: o.size,
    });
  }
  return { lane, entries, next: page.truncated && entries.length ? entries.at(-1).seq : null };
}

/**
 * Staging's rehearsal probes (state-rehearsal.yml on a rehearsal lane only; production has no such route):
 * - `create-only`: put one key under rehearsal/<lane>/ twice with the create-only precondition in the given form
 *   ("headers": If-None-Match: *, the form the Worker uses; "conditional": R2Conditional etagDoesNotMatch "*"), and
 *   report what the binding did each time ("created" / "refused" / "error: …"). 2 Class A.
 * - `drop-reflog`: delete gen/<lane>/<seq> (a crash between swap and reflog write, staged), so the next PUT's repair
 *   is observable. DeleteObject is free.
 */
export async function probe(bucket, lane, body) {
  if (body.op === 'create-only') {
    const form = body.form;
    if (form !== 'headers' && form !== 'conditional') throw new RefError(400, 'form must be headers or conditional');
    const key = `${PROBE_PREFIX}${lane}/create-only-${form}`;
    const onlyIf = form === 'headers' ? createOnly() : { etagDoesNotMatch: '*' };
    const results = [];
    for (const n of [1, 2]) {
      try {
        const o = await bucket.put(key, `probe ${n}`, { onlyIf });
        results.push(o ? 'created' : 'refused');
      } catch (err) {
        results.push(`error: ${String(err?.message ?? err).slice(0, 200)}`);
      }
    }
    const kept = await bucket.get(key);
    return { op: 'create-only', form, first: results[0], second: results[1], kept: kept ? await kept.text() : null };
  }
  if (body.op === 'drop-reflog') {
    if (!isSeq(body.seq)) throw new RefError(400, 'seq must be an integer');
    await bucket.delete(reflogKey(lane, body.seq));
    return { op: 'drop-reflog', seq: body.seq };
  }
  throw new RefError(400, 'op must be create-only or drop-reflog');
}
