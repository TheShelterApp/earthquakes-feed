// The content-addressed blob store in the R2 bucket (binding STATE): key layout, the batchGet frame format and the GC
// page. The Worker routes (worker.js) authenticate, check the budget and then call these.
//
// Key namespace (S3-portable, one bucket): `cas/sha256/<first 2 hex>/<64 hex>` holds the blob whose STORED bytes have
// that sha256 (today: the gzip of one day of the event map's NDJSON). R2 checks the hash on every put (the `sha256` put
// option: a mismatch throws, error 10037 BadDigest), so a key can never hold other bytes than its name says, whatever
// the client did. Keying by the stored (gzip) bytes, not the NDJSON, means a gzip that changes with a Node/zlib bump is
// simply a new key: the generation document records the blob it actually uploaded, never a hash the store does not
// hold. The NDJSON's own sha256 lives in the generation document and is the client's authoritative check after
// decompressing.

export const BLOB_PREFIX = 'cas/';
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;
export const MAX_BATCH = 40;
export const MAX_CURRENT = 40;
export const MAX_KEEP = 10_000;
export const MIN_AGE_DAYS = 14;
export const MAX_DELETES = 1_000;
export const BLOB_METADATA = { encoding: 'gzip', kind: 'event_map-day', format: '1' };

const HEX64 = /^[0-9a-f]{64}$/;

export function isSha(s) {
  return typeof s === 'string' && HEX64.test(s);
}

export function blobKey(sha) {
  return `${BLOB_PREFIX}sha256/${sha.slice(0, 2)}/${sha}`;
}

/** The sha of a blob key, or null for any key that is not exactly a CAS blob key (GC never deletes those). */
export function shaOfKey(key) {
  const m = /^cas\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(key);
  return m && m[2].startsWith(m[1]) ? m[2] : null;
}

/** The R2 error code at the end of a binding error's message, e.g. "put: ... (10037)" → 10037, or null. */
export function r2ErrorCode(err) {
  const m = /\((\d{5,6})\)\s*$/.exec(String(err?.message ?? ''));
  return m ? Number(m[1]) : null;
}

/** Store one blob. Throws what the binding throws (the caller maps 10037 to a 400). */
export async function putBlob(bucket, sha, body) {
  const object = await bucket.put(blobKey(sha), body, {
    sha256: sha,
    customMetadata: BLOB_METADATA,
    httpMetadata: { contentType: 'application/gzip' },
  });
  if (!object) throw new Error('put returned null without a precondition');
  return object;
}

const encoder = new TextEncoder();

/**
 * Stream blobs in the batchGet frame format to a WritableStream, sequentially:
 *   per blob   `BLOB <sha> <length>\n` + <length> bytes + `\n`
 *   if absent  `MISSING <sha>\n`
 *   at the end `END <frames>\n` (frames = the number of BLOB and MISSING frames, which is the number of shas asked)
 * Each body is piped with pipeTo (preventClose), never read in a JS loop: the CPU cost stays the runtime's, not the
 * Worker's 10 ms. On any error the stream is aborted, so the client sees no trailer and fails closed.
 * Returns {found, missing, bytes}.
 */
export async function streamBlobs(bucket, shas, writable) {
  let writer = writable.getWriter();
  let found = 0;
  let missing = 0;
  let bytes = 0;
  try {
    for (const sha of shas) {
      const object = await bucket.get(blobKey(sha));
      if (!object) {
        await writer.write(encoder.encode(`MISSING ${sha}\n`));
        missing++;
        continue;
      }
      await writer.write(encoder.encode(`BLOB ${sha} ${object.size}\n`));
      writer.releaseLock();
      await object.body.pipeTo(writable, { preventClose: true });
      writer = writable.getWriter();
      await writer.write(encoder.encode('\n'));
      found++;
      bytes += object.size;
    }
    await writer.write(encoder.encode(`END ${shas.length}\n`));
    await writer.close();
    return { found, missing, bytes };
  } catch (err) {
    try {
      await writable.abort(err);
    } catch {
      try {
        await writer.abort(err);
      } catch {
        // Already errored: the client sees a truncated stream either way.
      }
    }
    throw err;
  }
}

/** The sha256 (hex) of the keep set, sorted: what ties a GC pass's later pages to its first. */
export async function keepHash(keep) {
  const sorted = [...keep].sort().join('\n');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(sorted));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One GC page: list ≤ 1000 keys under cas/ from cursor, delete (unless dryRun) the CAS blobs that are not in keep and
 * were uploaded more than minAgeDays ago, at most maxDeletes of them. Keys that are not CAS blob keys are never touched.
 * Returns {listed, deleted, wouldDelete, bytesDeleted, bytesWouldDelete, kept, young, capped, foreign, keptBytes,
 * cursor}: `wouldDelete`/`bytesWouldDelete` are what the rules select (deleted, or in a dry run what would be), while
 * `deleted`/`bytesDeleted` are what this call removed (0 in a dry run). Every listed key is counted exactly once in
 * kept, young, capped, foreign or wouldDelete.
 */
export async function gcPage(bucket, { keep, cursor, minAgeDays, maxDeletes, dryRun, nowMs }) {
  const keepSet = new Set(keep);
  const page = await bucket.list({ prefix: BLOB_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
  const cutoffMs = nowMs - minAgeDays * 86_400_000;
  const doomed = [];
  let doomedBytes = 0;
  let kept = 0;
  let young = 0;
  let capped = 0;
  let foreign = 0;
  let keptBytes = 0;
  for (const object of page.objects) {
    const sha = shaOfKey(object.key);
    const uploadedMs = new Date(object.uploaded).getTime();
    if (sha == null) {
      foreign++;
      keptBytes += object.size;
    } else if (keepSet.has(sha)) {
      kept++;
      keptBytes += object.size;
    } else if (!(uploadedMs < cutoffMs)) {
      young++;
      keptBytes += object.size;
    } else if (doomed.length >= maxDeletes) {
      capped++;
      keptBytes += object.size;
    } else {
      doomed.push(object.key);
      doomedBytes += object.size;
    }
  }
  if (!dryRun && doomed.length > 0) await bucket.delete(doomed);
  const next = page.truncated && page.cursor ? page.cursor : null;
  return {
    listed: page.objects.length,
    deleted: dryRun ? 0 : doomed.length,
    wouldDelete: doomed.length,
    bytesDeleted: dryRun ? 0 : doomedBytes,
    bytesWouldDelete: doomedBytes,
    kept,
    young,
    capped,
    foreign,
    keptBytes: dryRun ? keptBytes + doomedBytes : keptBytes,
    cursor: next,
  };
}
