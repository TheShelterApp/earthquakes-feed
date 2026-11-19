# The state Worker (`state/`)

The feed's mutable working state leaves git through this Worker (APIs.md "Repository size", phase 3). It is the only
way into one R2 bucket that holds content-addressed blobs: today the event map, one gzip blob per UTC day of the map's
NDJSON. Which blobs make up the map is recorded by the generation document `knowledge/index/generation.json`, which
stays in git in phase 3 and is committed with head, sweeps and watermarks in the same push, so git remains the single
compare-and-swap. The Worker itself holds no map logic: it stores and returns bytes by their sha256, collects garbage,
and keeps the store inside the free tier. Since storage phase 4.0 it also speaks protocol 2: one compare-and-swap ref
per writer lane and a create-only reflog ([below](#protocol-2-lane-refs-and-the-reflog-storage-phase-40)). Step 4.0 is
inert: nothing in the production pipeline calls the ref routes until 4.1 writes `refs/main-shadow`, and `MIN_PROTOCOL`
stays 1.

| | Production | Staging |
|---|---|---|
| Worker | `earthquakes-feed-state` | `earthquakes-feed-state-staging` |
| Host (custom domain, the only route) | `https://feed-state.theshelter.app` | `https://feed-state-staging.theshelter.app` |
| R2 bucket (binding `STATE`) | `earthquakes-feed-state` | `earthquakes-feed-state-staging` |
| Token audience (`AUDIENCE`) | `earthquakes-feed-state` | `earthquakes-feed-state-staging` |
| Refs admitted (`ALLOW_ANY_REF`) | `refs/heads/main` only (`0`) | any branch (`1`) |
| Data | the feed's | synthetic only (`state-rehearsal.yml`); staging never reads production data |

Code: `src/index.js` (entry, the `BudgetLedger` Durable Object class), `src/worker.js` (routes, logging),
`src/auth.js` (OIDC, the (repository_id, workflow) pairs), `src/cas.js` (keys, frames, GC page), `src/refs.js` (lane
refs, the reflog, the Durable Object fallback), `src/budget.js` (ceilings, priority lanes). Plain JavaScript deployed as
it is, like `heartbeat/`; the tests are `tests/state-worker.test.ts` and `tests/state-refs.test.ts` (in `npm test`,
offline, with an in-memory bucket that honours `onlyIf`, the ledger on node:sqlite and a locally generated RSA key
behind an injected JWKS; the refs tests drive the real Worker handler with the real client, `src/state-store.ts`).

## HTTP contract

Every request carries `Authorization: Bearer <GitHub Actions OIDC token>` (below). Every response carries
`x-request-id` (the zone's `cf-ray`, or a UUID); JSON answers are `application/json` with `Cache-Control: no-store`.
The client sends `User-Agent: earthquakes-feed-state-client/1` and `x-feed-state-protocol: 1`.

**`PUT /v1/cas/sha256/<hex>`** (write) stores one blob: the body is the gzip bytes, `<hex>` their sha256 (64 lowercase
hex digits; any other path is 404). Headers: `Content-Length` is required (411 without it: R2 refuses a stream of
unknown length, so a chunked upload is refused before it starts), at most 25 MiB (413), at least 1 byte (400);
`Content-Type: application/gzip`; no `Content-Encoding` (400: nothing between the client and R2 may rewrite the bytes
the sha names); `x-feed-state-protocol` ≥ `MIN_PROTOCOL` (426, body `{"error", "min_protocol"}`). The body goes straight
to `STATE.put(key, request.body, {sha256: <hex>, customMetadata: {encoding: "gzip", kind: "event_map-day", format: "1"},
httpMetadata: {contentType: "application/gzip"}})`: R2 itself checks the hash, so a key can never hold other bytes than
its name says. It is always a PUT, never "skip if present": the same key is the same bytes, and the write refreshes the
object's `uploaded`, which is what GC ages by. Answers:
- 200 `{"key": "cas/sha256/<first 2>/<hex>", "size": <bytes>, "uploaded": "<ISO-8601>"}`;
- 400 `{"error": "checksum mismatch: …", "retryable": false}` when R2 refuses the hash (error 10037 BadDigest): never
  retry, the client's bytes are not what it names;
- 503 `{"error": "store write failed"}` for any other bucket error (retryable).

**`POST /v1/cas:batchGet`** (read) returns 1..40 blobs in one stream. Body (≤ 8 KiB) `{"shas": ["<hex>", …]}`: 1 ≤ n ≤ 40,
unique, lowercase (400 otherwise). Answer 200 `application/octet-stream`, `Cache-Control: no-store, no-transform`, the
frames in the order asked, blobs fetched one at a time and piped (`body.pipeTo(writable, {preventClose: true})`):

```
BLOB <hex> <length>\n<length bytes>\n      a blob that exists
MISSING <hex>\n                            a blob that does not
END <count>\n                              the trailer, once, last; count = the number of frames = n
```

The status is sent before the blobs are read, so a bucket error after the first byte aborts the stream: there is no
trailer. The client fails closed on a MISSING frame it needs, on a wrong trailer, on bytes after the trailer, on a
length that does not end at a `\n`, and on any blob whose sha256 is not its frame's `<hex>`; it then decompresses and
checks the NDJSON's own sha256 and length against the generation document (the authoritative check). An absent trailer
(a stream cut short) is not trusted for what it did not deliver: the client keeps the blobs that arrived whole and
verified and asks again for the rest only. It asks for at most 2.5 MB of blobs a request (about 9 day blobs, by the
generation's `blob_bytes`), at most 3 requests at a time, each batch retried on its own (src/state-store.ts `getBlobs`):
a stall costs one small answer, not 10 MB, and an invocation reads about 9 blobs (about 10 subrequests), not 40.

**`POST /v1/gc`** (gc) runs one page of garbage collection. Body (≤ 1 MiB):

```
{"keep": ["<hex>", …], "current": ["<hex>", …], "cursor": null | "<cursor>", "minAgeDays": 30, "maxDeletes": 600, "dryRun": true}
```

- `keep`: 1..10,000 unique shas that must survive (the client's keep set: the generations at the last 31 UTC midnights,
  the current one, and every generation since the last good backup).
- `current`: on the first page (`cursor` null) 1..40 blobs of the live generation; on every later page it is absent or
  `[]`. The Worker refuses (409) unless `current ⊆ keep` (body `{"error", "outside": [...]}`) and every `current` blob
  exists (one HEAD each, body `{"error", "missing": [...]}`). A generation spans the 45-day map horizon (about 46
  blobs), more than one call may check, so the client (src/state-gc.ts `collect`) sorts every blob of the current
  generation by sha256 and splits them into chunks of 40. Every chunk but the last goes in a first-page call of its own
  with `dryRun: true` (a separate pass that lists one page and deletes nothing: one more Class A listing and up to 40
  HEADs, its counts not used); the last chunk goes with the real pass's first page. So every current blob is proven
  present before anything is deleted, though only the last chunk by the deleting call itself (the writer lock keeps
  the generation from changing in between). With about 46 blobs that is one extra dry-run call a run.
- `cursor`: null for the first page, then the `cursor` the previous page returned. The budget ledger holds the open
  pass: a cursor that is not the one the last page returned, or a `keep` set that differs from the first page's (by
  the sha256 of the sorted list), is refused with 409 `start again with cursor null`, so no page can delete with a
  keep set that was not checked against `current`.
- `minAgeDays`: an integer ≥ 14 (400 otherwise). `maxDeletes`: an integer 0..1,000. `dryRun`: true or false (required).

The page lists at most 1,000 keys under `cas/` from the cursor and deletes (one call, unless `dryRun`) the CAS blobs
that are not in `keep` and whose `uploaded` is older than `minAgeDays`, at most `maxDeletes` of them. A key that is not
exactly `cas/sha256/<first 2>/<64 hex>` is never deleted. Answer 200:

```
{"listed": n, "deleted": n, "bytesDeleted": n, "wouldDelete": n, "bytesWouldDelete": n, "kept": n, "young": n,
 "capped": n, "foreign": n, "cursor": "<cursor>" | null, "dryRun": bool}
```

`kept` = in keep, `young` = not old enough, `capped` = deletable but over `maxDeletes` (left for the next pass),
`foreign` = not a CAS key, `wouldDelete` / `bytesWouldDelete` = what the rules select: what was deleted or, in a dry
run, what would have been; `deleted` / `bytesDeleted` = what this call removed (0 in a dry run). Every listed key is
counted once: `listed` = `kept` + `young` + `capped` + `foreign` + `wouldDelete`. The client loops while
`cursor` is not null. GC runs inside the writer group (`state-gc.yml`, `earthquakes-feed-writer`), so no aggregate PUT
can refresh a blob between a page's listing and its delete.

**`GET /v1/budget`** (budget) answers 200 with today's counters and the ceilings, for `feed:state-budget`:

```
{"day": "YYYY-MM-DD",
 "used": {"class_a": n, "class_b": n, "bytes_written": n, "requests": n, "refused": n},
 "stored_bytes": n, "stored_seeded_at": "<ISO-8601>" | null, "gc_pass_open": bool,
 "ceilings": {"class_a": n, "class_b": n, "bytes_written": n, "stored_bytes": n}}
```

### Protocol 2: lane refs and the reflog (storage phase 4.0)

Additive routes: a protocol-1 client never calls them, and `MIN_PROTOCOL` stays 1 until 4.3 flips authority to the
refs. Every one needs `x-feed-state-protocol` ≥ 2 on a write (426 below; reads need none). A lane is `main` (aggregate,
derive, backfill, archive, state-gc under the writer lock), `main-shadow` (4.1's shadow of main), `first-solutions` or
`history` (the lockless lanes of 4.5); staging also admits `rehearsal-<run>[-x]` lanes for `state-rehearsal.yml`. Any
other lane is 404.

**A ref** (`refs/<lane>` in the bucket) is canonical JSON (keys sorted, no whitespace, at most 4 KiB):

```
{"data_commit":"<40 hex>","format":1,"generation":"<sha256 of the generation blob>","head_seq":n,"lane":"<lane>",
 "parent":"<sha256>"|null,"seq":n,"written":"<ISO-8601 Z>","writer":"<workflow>/<run_id>-<attempt>/<step>/<hex nonce>"
 [,"restore_of":{"generation":"<sha256>","seq":n}]}
```

The Worker refuses (400) a body with another field, another lane, a non-canonical serialization, or a `writer` that does
not start with the CALLING run's `<workflow>/<run_id>-<run_attempt>/` (from the token), so the reflog's audit trail
names the run that really wrote and the nonce is the client's own.

**`GET /v1/refs/<lane>`** (ref-read): 200 with the ref's exact bytes and a strong `ETag`, or 404 `{"error":"no ref"}`.
One Class B.

**`PUT /v1/refs/<lane>`** (ref-write; restore when the body has `restore_of`): exactly one of `If-Match: "<etag>"` (the
version the writer read) or `If-None-Match: *` (the lane's first ref, the bootstrap); neither is 428, both or a weak tag
400. The Worker then:

1. checks the lane's pairs (below) and the body;
2. GETs the current ref: a create on an existing lane, or an `If-Match` that is not its ETag (or no ref at all), is 412;
3. requires the successor: `seq` = current + 1, `parent` = the current `generation`, `head_seq` ≥ the current one (a
   restore: >), else 409 `{"error", "current_seq" | "current_generation" | "current_head_seq"}`. A create (no current
   ref) is the successor of the lane's REFLOG instead, which outlives the ref (it stays in R2 under either backend):
   an empty reflog takes `seq` 1 with `parent` null; otherwise `seq` = the last entry's seq + 1, `parent` = its
   `generation`, `head_seq` ≥ its own, and never `restore_of` (409 otherwise, with `reflog_seq`). It lists the reflog's
   tail (one Class A) in place of step 5, so a lost ref never restarts the chain on a taken slot;
4. HEADs the generation blob `cas/sha256/…/<generation>`: absent is 409 (blobs first, then the ref, invariant 2);
5. repairs the reflog entry of the CURRENT seq, create-only (a Worker that died between its swap and its reflog write
   left it missing; an entry that exists is never rewritten);
6. swaps: `STATE.put(refs/<lane>, body, {onlyIf: {etagMatches}})` (a create: create-only); a null answer (another
   writer swapped between steps 2 and 6) is 412, its body re-read;
7. writes the reflog entry of the NEW seq, create-only.

"Create-only" is the form `CREATE_ONLY_FORM` names (below). Answers: 200 `{"lane", "seq", "generation", "etag",
"reflog": {"previous": "none"|"present"|"repaired"|"rewritten", "entry": "created"|"exists"|"written"}}` with the new
`ETag` (`rewritten`/`written`: `CREATE_ONLY_FORM = "off"`, plain puts); 412 `{"error", "current": <ref>|null, "etag", "at": "read"|"swap"}` (`at`:
which check refused; the client fails closed, it never rebases); 409, 400, 428, 426 as above. `entry: "exists"` means the
swap happened but the new seq's reflog slot was already taken: two writers of one seq (the CAS was not atomic) or an
entry left by a lost ref. The answer stays 200 (the ref did move), the Worker logs an error and counts it in the day's
`reflog_collisions` (health: `feed:state-budget` member `reflog`, P1), and the client's `putRef` throws
`ReflogCollision` (kind `integrity`, never retried), so the run fails loudly instead of writing on. At most **5 store
operations** per PUT whatever happens (GET, HEAD, repair, swap, entry; a create lists the reflog's tail instead of the
repair; a refused swap re-GETs instead of writing the entry); every ref route answers `x-feed-state-store-ops` and `x-feed-state-ledger-calls` (one reservation, plus a
refund on a 412 or 409, or the collision count), which the rehearsal checks. Cost reserved (the worst case): 3 Class A, 3 Class B (GET, HEAD,
and the re-GET of a swap refused at the store), three bodies written; the stored
estimate gains the entry (and the ref object on a create), which a 412 or 409 gives back.

**`GET /v1/gen/<lane>?after=<seq>&limit=<1..1000>`** (reflog): one listing page, ascending:
`{"lane", "entries": [{"seq", "generation", "parent", "head_seq", "data_commit", "written", "writer", "restore_of",
"uploaded", "size"}], "next": <seq>|null}` (ask again with `after=next`). The entry's fields come from the R2 custom
metadata the Worker wrote with it, so a page is one Class A listing, no GET per entry. Keys `gen/<lane>/<seq, 12
digits>`; GC lists `cas/` only and never touches `refs/` or `gen/` (reflog retention is 4.2's).

**The ambiguous answer** (a timeout, a cut connection, a 5xx: the swap may or may not have happened): the client
(`swapRef`, `src/state-store.ts`) never repeats a ref PUT blindly. It re-GETs the ref: its own writer nonce there means
the write landed; the ETag still the one it named (no ref, for a create) means it did not, and the same body goes again
(a repeat that meets its own landed write gets a 412 whose `current` is its own, which also counts as landed); anything
else is someone else's write: a 412, fail closed.

**`POST /v1/rehearsal/<rehearsal lane>`** (staging only; 404 in production; `state-rehearsal.yml` only) runs one probe:
`{"op":"create-only","form":"headers"|"conditional"}` puts `rehearsal/<lane>/create-only-<form>` twice with the
binding's create-only precondition (`If-None-Match: *` as Headers, the form the Worker uses; or R2Conditional
`etagDoesNotMatch: "*"`) and answers what happened each time; `{"op":"drop-reflog","seq":n}` deletes one reflog entry,
so the rehearsal can watch the next PUT repair it. Every probe answer also carries `"worker": {"create_only",
"ref_backend"}`, the configuration the rehearsal judges its rows by.

### Create-only form (`CREATE_ONLY_FORM`)

The binding documents `onlyIf` as an R2Conditional or a Headers object, but spells out neither form for "create only
when no object exists", which the reflog (steps 5 and 7) and a lane's first ref (step 6 under `"r2"`) rely on. The var
picks the form: `"headers"` (`If-None-Match: *`, the default), `"conditional"` (R2Conditional `etagDoesNotMatch: "*"`),
or `"off"`. The rehearsal probes both forms and fails the configured one if the binding does not honour it, naming the
form that held (or `"off"` when neither did); the remedy is this var, never `REF_BACKEND = "do"`, whose reflog stays in
R2 with the same form. With `"off"` every create-only put is a plain put: the repair rewrites the current entry with its
same bytes, the new entry is written by the swap's winner alone (the swap's compare-and-swap, and the create rule of
step 3, keep each seq to one writer), a taken slot can no longer be detected, and under `"r2"` two racing creates could
both win, so every lane's first ref is written by the runbook bootstrap below.

### Ref backend (`REF_BACKEND`)

`"r2"` (default): the ref is an R2 object, swapped by the binding's conditional put. `"do"`: the fallback if the staging
race rehearsal shows that `onlyIf` is not an atomic compare-and-swap on the binding: the ref is a row of the existing
`BudgetLedger` Durable Object (table `refs`, created by every version since 4.0 and empty while unused; one object whose
methods run alone, so the check and the write are one SQLite transaction), its ETag the first 32 hex of the body's
sha256. Same HTTP API, same reflog (in R2), same store-operation bound. Switching moves no ref: do it before any lane has
a ref (4.0/4.1), or carry each lane over while no writer runs (the lane's writers disabled, as in the bootstrap
runbook below):

1. Under the OLD backend, `GET /v1/refs/<lane>` (the current ref, seq N) and page `GET /v1/gen/<lane>` to its end: the
   last entry must be seq N with the ref's `generation`. If entry N is missing (a Worker died after its swap), any PUT
   of the lane repairs it; do one before switching.
2. Switch `REF_BACKEND` and deploy; the lane now has no ref.
3. Dispatch the lane's seeding step with a create (`If-None-Match: *`) of a NEW body: `seq` N + 1, `parent` and
   `generation` both the old ref's `generation` (the same state, one step on), `head_seq` and `data_commit` the old
   ref's, `written` now, and the calling run's `writer` (the Worker refuses a copy of the old bytes: its `writer` names
   another run). The Worker checks it against the reflog's entry N (409 otherwise, `reflog_seq` naming what it found).
4. `GET /v1/refs/<lane>` shows seq N + 1 by the seeding run, and the reflog's last entry is that ref; then re-enable the
   writers.

A switch back is the same steps the other way. Both backends, and a create after a lost ref, are covered offline by
`tests/state-refs.test.ts`.

### Bootstrap of a lane (runbook)

A lane's first ref is written once with `If-None-Match: *` (seq 1, parent null). The Worker refuses a second create
itself (its GET sees the ref), so only two creates that race could both pass if the binding ignored the create-only
precondition. The
rehearsal proves the precondition (`create-only` probe, two racing creates); if it shows R2 honours neither form
(`CREATE_ONLY_FORM = "off"`) or two racing creates both won, every lane is bootstrapped by this runbook instead of by a
job: dispatch the lane's seeding step (4.1: the first shadow write;
4.3: `scripts/phase4/seed.ts`) **only while the lane's writers cannot run** (the writer group idle for `main`, the
lane's own workflow disabled for the lockless lanes), then check with `GET /v1/refs/<lane>` that `seq` and `writer` are
the seeding run's before re-enabling the writers.

**Errors shared by every route.** 401 `{"error": "unauthenticated", "reason"}` (no, malformed or invalid token);
403 `{"error": "forbidden", "reason"}` (a valid token of this repository that this route does not admit); 503
`{"error": "unavailable", "reason": "signing keys unavailable"}` with `Retry-After: 3` when no GitHub signing key can be
had (GitHub unreachable and no copy in the isolate, the colo cache or the bucket), or when the token's `kid` is not in
the copy and GitHub could not be asked (below); the client retries it after at most 3 s whatever the header says, so an
older Worker's `Retry-After: 30` is treated alike;
429 `{"error": "budget", "ceiling": "class_a" | "class_b" | "bytes_written" | "stored_bytes"}` above a ceiling (the
client never retries a budget 429; a zone rate-limit 429 is `text/plain` with `Retry-After` and is retried after it);
503 `{"error": "budget ledger unavailable"}` (retryable: an unmetered request is never let through); 404 for any other
path, 405 (with `Allow`) for another method on a known path; 500 `{"error": "misconfigured: …"}` when a var is missing
or malformed (a deploy error, never retried). Only a PUT's 400 `checksum mismatch` is an integrity failure for the
client; any other 400 is a request it should not have sent. The client tries at most 4 times on another 5xx, network
errors and a non-budget 429, after the answer's `Retry-After` when it is at most 60 s (a longer one ends the retries),
otherwise after a jittered backoff, at most 90 s of waiting a request; never on another 4xx.

## Authentication and policy

There is no static secret: a job that may call the store has `permissions: id-token: write` at JOB level (never at
workflow level) and asks GitHub for a token whose audience is the Worker's `AUDIENCE`. Tokens live about 5 minutes, so
the client mints one per call unless its cached one has more than 60 s left, and never passes one between steps.

The Worker verifies (401 on any failure):
- `alg` is exactly `RS256` (pinned: `none`, `HS256` and every other alg are refused before a key is looked at) and
  `kid` is present;
- the signature, with GitHub's key for that `kid` from the hard-coded
  `https://token.actions.githubusercontent.com/.well-known/jwks` (imported as RSASSA-PKCS1-v1_5/SHA-256; cached per
  isolate and in the Cache API for 1 h, an older copy used for up to 7 days while GitHub cannot be reached; with a
  usable copy the JWKS is fetched at most once a minute per isolate, also when a token names an unknown `kid`, so
  made-up kids cost nothing; see "The JWKS copy" below for a cold isolate);
- `iss` = `https://token.actions.githubusercontent.com`, `aud` = `AUDIENCE`, `exp` > now − 30 s, `nbf` ≤ now + 30 s, `iat`
  (if present) ≤ now + 30 s, and `repository_id` = `REPOSITORY_ID` (1289538519, the numeric id of
  TheShelterApp/earthquakes-feed: it survives a rename or a transfer, so no owner, repository or `sub` string is ever
  matched) or a peer repository that one of the pairs below names (none in 4.0).

**The JWKS copy** (since 2026-11-17). On 2026-11-16 aggregate runs 43907386794 and 43964170954 got 503
`unavailable`: a cold isolate whose colo had evicted the Cache API copy, and whose one GitHub fetch failed, had no key,
and the minute's refetch throttle then answered 503 to every other request of that isolate (both PUTs of one run). So:
- the bucket keeps the last good JWKS document at `meta/jwks/github-actions.json` (custom metadata `fetched_ms`, the
  instant GitHub served it, and `sha256`), outside `cas/`, so GC never lists or deletes it, and no route writes `meta/`;
- an isolate with no usable copy after the Cache API reads it (one GET, at most once per 10 s per isolate, or 2 s
  after a read that failed; concurrent cold requests wait for the one read instead of going to GitHub keyless) before
  it asks GitHub, and puts what it found back into the colo's cache; the 7-day stale bound counts from `fetched_ms`;
- after a successful fetch an isolate rewrites it when it differs from the copy the isolate knows of, when it knows of
  none, or when the known copy is a day old, at most once an hour per isolate (in practice about one PUT a colo a day);
  the write runs after the answer (`ctx.waitUntil`);
- with no usable key at all (keyless), a failed fetch is retried once in the same request after 0.75 s (3 s timeout),
  and the next request may fetch again 2 s later instead of a minute later; concurrent requests share one fetch. The
  unknown-`kid` throttle of a known key set is unchanged;
- an unknown `kid` is a 401 only when the isolate's last GitHub fetch succeeded (GitHub itself does not list it). After
  a failed fetch it is a 503 `unavailable` (reason `unknown kid, signing keys unconfirmed`): a copy can predate a key
  rotation (a bucket copy is rewritten at most once an hour per isolate), and the client retries a 503 but never a 401;
- stale-while-revalidate: a usable copy past its 1 h that holds the token's `kid` serves the request at once, and the
  isolate asks GitHub after the answer (`ctx.waitUntil`, the same minute's throttle). The bucket copy is restamped about
  once a day, so a cold isolate that adopts it is usually past the hour, and asking first held the request up to 5 s
  whenever GitHub was slow, inside the client's attempt timeout (which covers a batchGet's whole stream). An unknown
  `kid` and a keyless isolate still wait for GitHub.

These bucket operations happen before the token is verified, so no route reserves them: the Worker charges them to the
ledger's day row after the answer (`charge`: Class A, Class B and bytes written, never refused, no `requests`), and
logs them on the request's line (`jwks`, `jwks_ops`). They are not in `x-feed-state-store-ops`.

Subrequests of the JWKS path (`waitUntil` work counts toward the invocation too). A warm isolate: none. A cold isolate
whose colo cache has the copy: one (`cache.match`), plus the revalidation's GitHub fetch and `cache.put` once the copy
is past its hour (3). A cold isolate on a colo-cache miss with a bucket copy: `cache.match`, `bucket.get`, then (after
the answer) the GitHub fetch, the bucket `put` only when a rewrite is due, one `cache.put` (GitHub's copy, or the bucket
copy when the fetch failed) and one ledger `charge`: at most 6. Keyless (no bucket copy): `cache.match`, `bucket.get`,
two GitHub fetches, the bucket `put`, `cache.put` and `charge`: at most 7. A 40-blob batchGet (about 41 of its own;
the feed's client asks for about 9, so about 10) stays under 50 either way; a GC first page (44 of its own: `gcBegin`, 40 HEADs, a list, a delete, `gcEnd`) reaches 50
or 51 on such a cold isolate, which matters only if R2 and Durable Object calls count against the 50 (the open rehearsal
item under "Verify"; the 4.0 table's `x-feed-state-store-ops` does not include these).

Then it authorises (403): `ref_type` = `branch`, `runner_environment` = `github-hosted`, `event_name` ∈ {`schedule`,
`workflow_dispatch`} (no `push`, no `pull_request`), `ref` = `refs/heads/main` unless `ALLOW_ANY_REF` (staging), and
`workflow_ref` ends with `/.github/workflows/<file>@<ref>`, and (`repository_id`, `<file>`) is one of the right's
**pairs** (storage phase 4.0). A pair names its repository (`HOME` = `REPOSITORY_ID`, or a peer's numeric id), so when
phase 5.3's data repository gets its own `publish.yml` pair, a file of the same name in this repository (or this
repository's `aggregate.yml` name in the other one) matches nothing. A pair may also require the token's `environment`
claim and narrow the events (the restore). Blob routes (protocol 1; all pairs of this repository):

| Route | Workflows |
|---|---|
| read (`POST /v1/cas:batchGet`) | `aggregate.yml`, `derive.yml`, `first-solutions.yml`, `state-backup.yml`, `state-gc.yml` |
| write (`PUT /v1/cas/sha256/…`) | `aggregate.yml` |
| gc (`POST /v1/gc`) | `state-gc.yml` |
| budget (`GET /v1/budget`) | the readers and `health.yml` |
| staging only, every route but restore | `state-rehearsal.yml` |

Lane rights (protocol 2; the end state of the design, so 4.1–4.5 need no Worker deploy for authorisation alone; in 4.0
no production workflow calls them):

| Lane | ref-write (`PUT`) | ref-read (`GET`): the writers and | reflog (`GET /v1/gen`) | restore |
|---|---|---|---|---|
| `main` | `aggregate.yml`, `derive.yml`, `backfill.yml`, `archive.yml`, `state-gc.yml` | `remediate.yml`, `stats.yml`, `history.yml` | GC, backup, health | yes |
| `main-shadow` | `aggregate.yml`, `derive.yml`, `backfill.yml`, `archive.yml` | — | GC, backup, health | no |
| `first-solutions` | `first-solutions.yml` | `derive.yml` | GC, backup, health | yes |
| `history` | `history.yml`, `remerge.yml` | `derive.yml`, `stats.yml` | GC, backup, health | yes |

`state-gc.yml`, `state-backup.yml` and `health.yml` read every lane's ref and reflog. **Restore** is a ref PUT whose
body has `restore_of` (the reflog entry it restores) and whose `head_seq` jumps forward (409 otherwise; invariant 5:
seqs never repeat). It is admitted for exactly one pair: `state-restore.yml` of this repository, `event_name`
`workflow_dispatch`, with the token claim `environment: state-restore`. The claim proves only that the job named that
GitHub Environment, not that anyone reviewed it: GitHub creates an Environment a workflow names but that does not exist
yet, with no protection rules. So the review is real only once the owner has created `state-restore` with a required
reviewer (Owner setup, step 5), which must happen before any `state-restore.yml` lands on `main`. That pair also reads the refs and
the reflogs it restores from. The restore workflow without `restore_of` is no writer, a writer with `restore_of` is no
restorer (403 both), and the rehearsal workflow is never admitted, not even on staging.

Only the aggregate job persists the map. `derive.yml` runs derive alone (it never aggregates) and its prune is a pure
local edit of the generation document, so it holds no write right; a workflow is added to the write list only when it
calls persist. `health.yml` reads the budget (and from 4.2 the refs and reflogs, for its reconciler). Writes and GC also
need `x-feed-state-protocol` ≥ `MIN_PROTOCOL` (426), ref writes ≥ max(`MIN_PROTOCOL`, 2): the minimum is raised with
every incompatible layout change, so an old run re-run from the Actions UI (its token is still valid for main) cannot
write an old layout. The production client keeps sending 1 on the blob routes until 4.3, so 4.3's `MIN_PROTOCOL` 2
fences every pre-flip run.

## Budgets: never pay

R2 has no spend cap and its free tier is per account (10 GB-month, 1M Class A and 10M Class B operations a month;
DeleteObject is free), shared with the platform (about 0.4 GB). So the Worker meters itself: every authenticated
request first reserves its worst case in the `BudgetLedger` Durable Object (one SQLite-backed object, `global`, one
row per UTC day, rows older than 40 days pruned) and is refused with 429 `{"error":"budget"}` above a ceiling:

| Ceiling (var) | Production | Staging | Counts |
|---|---|---|---|
| `CLASS_A_PER_DAY` | 20,000 (≤ 620k a month) | 2,000 | a PUT 1, a GC page 1 (its list), a ref PUT 3, a reflog page 1 |
| `CLASS_B_PER_DAY` | 200,000 (≤ 6.2M a month) | 20,000 | a batchGet n (a missing blob too), a GC first page 1 per `current`, a ref GET 1, a ref PUT 3 |
| `BYTES_WRITTEN_PER_DAY` | 1 GiB | 256 MiB | a PUT's `Content-Length`, a ref PUT three bodies |
| `STORED_BYTES_MAX` | 6 GiB | 256 MiB | the running stored estimate, checked by every PUT and ref PUT |

**Priority lanes** (storage phase 4.0; the store stays on the account the platform uses, owner decision 2026-11-16, so
the budgets are shared and background work must never starve the feed). Every reservation names its lane by the
caller's workflow:

| Lane | Workflows | Refused above |
|---|---|---|
| critical | `aggregate.yml`, `derive.yml`, `state-restore.yml` (this repository) | 95 % of any ceiling |
| background | every other caller: GC, backup, history, first-solutions, stats, health, the rehearsal, a peer repository | 60 % of any ceiling |

So the last 35 % of every ceiling is the feed's alone. `GET /v1/budget` never reserves (health can always read it). The
day row counts `refused` and, apart, `refused_critical` (health: P1), `ref_conflicts` (412s on ref PUTs, for 4.3's
`feed:state-ref-conflict`) and `reflog_collisions` (ref swaps onto a taken reflog slot; health: P1); the snapshot also carries `meta_bytes` and `lanes` ({critical: 0.95, background: 0.6}).

The two environments together stay inside the account's free tier with room for the platform's own R2 use. The stored
estimate is raised by every PUT (an overwrite counts again: it errs high), lowered by what GC deletes, refunded when R2
refuses a PUT, and re-seeded at the end of every complete GC pass from what the pass listed and kept plus what was PUT
meanwhile plus `meta_bytes`: the ref and reflog bytes (outside `cas/`, so never listed by GC), kept in their own counter
that only a refund lowers until 4.2's reflog retention. The JWKS copy (above) is charged after the fact (`charge`: its GET
Class B, its PUT Class A and bytes written) and left out of the stored estimate: one object of a few KB, overwritten in
place. If GC stops, the estimate climbs by the day's writes until PUTs
are refused; `feed:state-budget` (above 60 % of a ceiling, where background work is refused) and `feed:state-gc` (no
successful GC in 3 days) fire long before. The ledger's new columns are added in place (`ALTER TABLE … ADD COLUMN`,
a no-op once present), so a rollback to a protocol-1 version still reads every row; that version's re-seed leaves the
meta bytes out (the estimate then reads low by them: tens of kB a day).

The feed's own use (2026-11-19, batches of at most 2.5 MB): phase 3a about 830 requests a day (about 290 aggregate
runs, each one batchGet for the shadow hydrate's sample of 4 days and about 1.4 PUTs; health's budget reads, the
backups' 6 batchGets a day and GC's pages), about 1,200 Class B a day. Phase 3b about 2,400 a day: each aggregate run
fetches all 46 days in 6 batchGets (about 1,750 a day), first-solutions' about 24 collects 6 each, the PUTs and health
as before; Class B about 14,400 a day (a blob is one GET however it is batched). A batch retried on every attempt (4)
on every run would be about 8,000 a day: under 10 % of the account's 100,000 even then. The ledger's Durable Object
rows follow the requests (one a request). Roughly 1-7 % of every ceiling. The ledger writes one day row per authenticated request (the account's Durable Object
limit is 100,000 rows written a day, shared with the heartbeat ledger and the alerts gateway); an unauthenticated request
never reaches a reservation or a blob. The one exception is bounded per isolate: an isolate with no signing key reads
the JWKS copy (and charges that GET) at most once per 10 s (2 s after a read that failed), whoever's token arrives.

**The Workers request cap is shared.** Workers Free allows 100,000 requests a day per account, and the platform's API
budgets most of it. When the account hits the cap, Cloudflare answers Error 1027 until 00:00 UTC: in phase 3a the
store calls fail, the shadow check reports `feed:state-shadow`, and the feed carries on from git; from phase 3b the feed
stops until the cap resets (APIs.md "Repository size", outage budget). The client tells it apart (kind `quota`: a 1027
page is never retried; a platform 429 that outlives the retries is `quota` too), and health raises `feed:state-quota`
(P1) when its own budget read or a job's state-shadow step met it.

## Logging

One JSON line per request (Workers Logs, kept 3 days; `wrangler tail` live):
`{"t":"feed-state","rid","method","route","path","workflow","run_id","run_attempt","repository_id","priority","lane",
"seq","restore_of","reflog","probe","sha","n","bytes","missing","deleted","dry_run","ops","ledger","status","ms","error",
"cause","jwks","jwks_ops"}` (fields that do not apply are absent; `jwks` lists what the key store did beyond its
isolate copy, e.g. `bucket-miss,github,bucket-write`, `bucket,github-failed`, `cache`, `bucket-failed` (the read threw),
`bucket,revalidate` (served from a stale copy, GitHub asked after the answer) or `github-failed,github-failed`,
and `jwks_ops` its bucket operations; `repository_id` only for a peer repository; `reflog` is
`<previous>/<entry>` of a ref PUT). A batchGet logs when its
stream ends. The token, the claims other than the run and workflow, and the request bodies are never logged. A failed
JWKS fetch logs `{"t":"feed-state","event":"jwks-fetch-failed","keyless"}` (the first of a keyless request's two
attempts with `"attempt":1`, a revalidation's with `"revalidate":true`); a failed read or write of the bucket copy `jwks-bucket-read-failed` /
`jwks-bucket-write-failed`, and a charge the ledger refused `jwks-charge-failed`.

## Owner setup (one time, per environment)

1. Create the bucket (R2 is already enabled on the account: the platform uses it):
   `npx wrangler r2 bucket create earthquakes-feed-state` (staging: `earthquakes-feed-state-staging`).
2. Deploy (below). The first deploy creates the custom domain and its DNS record on the zone `theshelter.app`, the
   Durable Object class (migration `v1`) and the bucket binding.
3. Zone `theshelter.app` (dashboard): the feed's runners call this host from GitHub's datacenter addresses, and the token
   is the authentication. Keep **Bot Fight Mode OFF** (it would challenge the runners). Check that the rate-limiting
   rule `worker-paths-per-ip` (50 requests / 10 s per IP on `/v1/*`) is scoped to the `api*`/`config*` hosts or excludes
   `feed-state*`; otherwise add a Configuration Rule for hostname `feed-state*.theshelter.app` with Browser Integrity
   Check off and exclude the host from the rate limit (platform/infra/wrangler/README.md lists the zone's rules).
4. Turn on Cloudflare usage notifications for R2 storage and operations (a second alarm beside the Worker's ceilings).
5. Before any `state-restore.yml` is merged (storage phase 4.2; production only, staging never admits a restore): in
   the repository's Settings → Environments, create the Environment `state-restore` with the owner as **required
   reviewer** and **deployment branches limited to `main`** (selected branches, rule `main`). Check that it is there
   with `gh api repos/TheShelterApp/earthquakes-feed/environments/state-restore --jq '.protection_rules'` (a
   `required_reviewers` rule naming the owner). Without it, the first dispatch of the restore workflow would create the
   Environment unprotected and the Worker would admit its restore with no review.

## Deploy

Only from `main`, after the change is merged, from a clean checkout at `origin/main`, with `npm ci` done at the
repository root:

```
FEED_STATE_CF_EMAIL=<the Cloudflare login's email> bash state/deploy.sh                # production
FEED_STATE_CF_EMAIL=<the Cloudflare login's email> bash state/deploy.sh --env staging  # staging
bash state/deploy.sh [--env staging] --dry-run                                          # bundle only, no login
```

`deploy.sh` refuses unless HEAD is the branch `main` at `origin/main` with a clean working tree (no change and no
untracked file), and unless `wrangler whoami` names `FEED_STATE_CF_EMAIL`; it deploys with `--env ""` (production, the
top level of `wrangler.toml`) or `--env staging`, and tags the version `main <commit>`. Wrangler reads its login from the
caller's environment (a separate profile through `XDG_CONFIG_HOME` works unchanged). Deploy staging first and run
`state-rehearsal.yml` against it before a production deploy that changes behaviour.

The first deploy follows the phase-3a merge (#155), which was inert; a second commit then switched the jobs on
(`${{ vars.FEED_STATE_BACKEND || 'worker' }}`), and the repository variable `FEED_STATE_BACKEND=off` is phase 3a's
kill switch: off, the feed's jobs never call the Worker and health judges no state row. The order (staging, the
rehearsal, production, the first GC and backup dispatches, then the switch commit) is APIs.md's phase-3a rollout.

## Rollback

`npx wrangler deployments list -c state/wrangler.toml --env ""` (or `--env staging`) lists the versions OLDEST first,
each with its `main <commit>` message; `npx wrangler rollback <version-id> -c state/wrangler.toml --env "" --message
"rollback to main <commit>"` makes an earlier version active at once. Then revert the change on `main` and deploy again
with `deploy.sh`, so the active Worker is again the code on `main`. A rollback never touches the bucket or the ledger:
the key layout and the ledger schema only ever grow (`CREATE TABLE IF NOT EXISTS`), so an older version reads them.
Lowering `MIN_PROTOCOL` in a rollback re-admits older clients; only do that together with the client rollback.
Rolling 4.0 back (redeploying the protocol-1 Worker) leaves `refs/`, `gen/` and `rehearsal/` keys and the `refs` table
in place, unread; nothing in production depends on them before 4.3.

## Verify

After every deploy (production host shown; staging the same with its host):

| Check | Expect |
|---|---|
| `curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://feed-state.theshelter.app/v1/cas:batchGet` | `401` from the Worker (JSON `{"error":"unauthenticated"}`, an `x-request-id`), not a zone `403`/`1010` or `429` |
| `curl -sS -o /dev/null -w '%{http_code}\n' https://feed-state.theshelter.app/` | `404` |
| `curl -sS -o /dev/null -w '%{http_code}\n' https://earthquakes-feed-state.<account>.workers.dev/` | no answer from the Worker (no workers.dev route) |
| `state-rehearsal.yml` on staging (dispatch from any branch) | PUT, batchGet (a present and a missing blob, the trailer), a 10037 PUT answered 400, GC dry run, `GET /v1/budget`: all as above; then the protocol-2 table in the job summary, every row `ok` (below) |
| `wrangler tail` during an aggregate run | one `feed-state` line per call with the run id, status 200 |

To rehearse on staging (not covered offline): the binding's error on a wrong `sha256` (expected `… (10037)`, mapped to
400), whether R2 binding calls count against the 50 or the 1,000 subrequest limit (a batchGet of 40 and a GC first page
of 40 HEADs stay under either on a warm isolate; a cold isolate's JWKS path adds up to 7, above, which takes a GC
first page to 50-51 under the stricter reading. A rehearsal cannot force the colo-cache miss of that worst case, so it
settles which limit applies: if R2 and Durable Object calls count against the 50, lower the Worker's `MAX_CURRENT` and
the client's `BATCH_MAX` to 36 together, client first), and the CPU time of a 40-blob batchGet and of a 1,000-key GC
page (`wrangler tail` shows `cpuTime`; Workers Free allows 10 ms per request).

**The 4.0 gate** (`src/state-rehearsal.ts` `rehearseRefs`, fresh `rehearsal-<run>-*` lanes each run; the job summary
has one row per check with what was expected and what the binding did):

| Check | Holds when | If not |
|---|---|---|
| R2 create-only, both forms (`info`, except the configured one) | the configured `CREATE_ONLY_FORM`: created, then refused, the first body kept | FAIL: set `CREATE_ONLY_FORM` to the form that held (`"off"` if none), rehearse again |
| Worker configuration | `REF_BACKEND`, `CREATE_ONLY_FORM` (`info`) | WARN with `"off"`: the runbook bootstrap |
| create twice | the second is 412 with the first ref | FAIL |
| two racing creates | one 200, one 412 | WARN under `"r2"`: the runbook bootstrap; FAIL under `"do"` |
| two racing writers on one ref, 6 rounds | every round one 200 and one 412 naming the winner; no reflog slot taken twice | FAIL: two 200s, a 412 naming another ref or a taken slot → `REF_BACKEND = "do"`; an error in a round → dispatch again |
| racers that met at the conditional put | at least one 412 came from the put itself (`at: "swap"`) | WARN: the race was not exercised, dispatch again |
| ambiguous outcome: answer dropped / never sent / a real 5 ms abort | `reconciled` / `retried` / any landed outcome, and the ref is ours | FAIL |
| a stale writer after another's swap, its 412 seen / its answer lost | the Worker's 412 (`at`) / a RefConflict from the re-read: fail closed | FAIL |
| reflog repair, then create-only | `repaired`, then `present` (`"off"`: `rewritten` twice) | FAIL: the create-only form, not the Durable Object |
| reflog complete | entries 1..seq, the last = the ref | FAIL |
| refused: no precondition, seq skip, missing blob, protocol 1, non-canonical body, restore by the rehearsal | 428, 409, 409, 426, 400, 403 | FAIL |
| store operations per ref PUT | ≤ 5 on every PUT | FAIL |
| budget ledger | the day's `ref_conflicts` and `meta_bytes` moved during the run by at least this run's seen 412s and landed ref and reflog bytes | FAIL (WARN when the UTC day turned) |

The summary ends with what each WARN or FAIL calls for (its remedy, one paragraph each). A step that cannot go on (a
setup PUT refused) ends the table with a `rehearsal aborted` FAIL row instead of losing it. A FAIL exits 1. `POST /v1/cas:batchPut` (≤ 16 blobs in one request) is not built in 4.0: it would ship only if the
rehearsal showed its CPU under 10 ms, and without it a run is about 10 requests, which is affordable.
