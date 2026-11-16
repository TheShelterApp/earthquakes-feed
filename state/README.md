# The state Worker (`state/`)

The feed's mutable working state leaves git through this Worker (APIs.md "Repository size", phase 3). It is the only
way into one R2 bucket that holds content-addressed blobs: today the event map, one gzip blob per UTC day of the map's
NDJSON. Which blobs make up the map is recorded by the generation document `knowledge/index/generation.json`, which
stays in git in phase 3 and is committed with head, sweeps and watermarks in the same push, so git remains the single
compare-and-swap. The Worker itself holds no map logic: it stores and returns bytes by their sha256, collects garbage,
and keeps the store inside the free tier.

| | Production | Staging |
|---|---|---|
| Worker | `earthquakes-feed-state` | `earthquakes-feed-state-staging` |
| Host (custom domain, the only route) | `https://feed-state.theshelter.app` | `https://feed-state-staging.theshelter.app` |
| R2 bucket (binding `STATE`) | `earthquakes-feed-state` | `earthquakes-feed-state-staging` |
| Token audience (`AUDIENCE`) | `earthquakes-feed-state` | `earthquakes-feed-state-staging` |
| Refs admitted (`ALLOW_ANY_REF`) | `refs/heads/main` only (`0`) | any branch (`1`) |
| Data | the feed's | synthetic only (`state-rehearsal.yml`); staging never reads production data |

Code: `src/index.js` (entry, the `BudgetLedger` Durable Object class), `src/worker.js` (routes, logging),
`src/auth.js` (OIDC), `src/cas.js` (keys, frames, GC page), `src/budget.js` (ceilings). Plain JavaScript deployed as it
is, like `heartbeat/`; the tests are `tests/state-worker.test.ts` (in `npm test`, offline, with an in-memory bucket,
the ledger on node:sqlite and a locally generated RSA key behind an injected JWKS).

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
trailer. The client fails closed on a MISSING frame it needs, on an absent or wrong trailer, on bytes after the
trailer, on a length that does not end at a `\n`, and on any blob whose sha256 is not its frame's `<hex>`; it then
decompresses and checks the NDJSON's own sha256 and length against the generation document (the authoritative check).

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

**Errors shared by every route.** 401 `{"error": "unauthenticated", "reason"}` (no, malformed or invalid token);
403 `{"error": "forbidden", "reason"}` (a valid token of this repository that this route does not admit); 503
`{"error": "unavailable"}` with `Retry-After: 30` when no GitHub signing key can be had (GitHub down and no cached key);
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
  isolate and in the Cache API for 1 h, an older copy used for up to 7 days while GitHub cannot be reached; the JWKS is
  fetched at most once a minute per isolate, also when a token names an unknown `kid`, so made-up kids cost nothing);
- `iss` = `https://token.actions.githubusercontent.com`, `aud` = `AUDIENCE`, `exp` > now − 30 s, `nbf` ≤ now + 30 s, `iat`
  (if present) ≤ now + 30 s, and `repository_id` = `REPOSITORY_ID` (1289538519, the numeric id of
  TheShelterApp/earthquakes-feed: it survives a rename or a transfer, so no owner, repository or `sub` string is ever
  matched).

Then it authorises (403): `ref_type` = `branch`, `runner_environment` = `github-hosted`, `event_name` ∈ {`schedule`,
`workflow_dispatch`} (no `push`, no `pull_request`), `ref` = `refs/heads/main` unless `ALLOW_ANY_REF` (staging), and
`workflow_ref` ends with `/.github/workflows/<file>@<ref>` with `<file>` in the route's allow-list:

| Route | Workflows |
|---|---|
| read (`POST /v1/cas:batchGet`) | `aggregate.yml`, `derive.yml`, `first-solutions.yml`, `state-backup.yml`, `state-gc.yml` |
| write (`PUT /v1/cas/sha256/…`) | `aggregate.yml` |
| gc (`POST /v1/gc`) | `state-gc.yml` |
| budget (`GET /v1/budget`) | the readers and `health.yml` |
| staging only, every route | `state-rehearsal.yml` |

Only the aggregate job persists the map. `derive.yml` runs derive alone (it never aggregates) and its prune is a pure
local edit of the generation document, so it holds no write right; a workflow is added to the write list only when it
calls persist. `health.yml` reads the budget and nothing else. Writes and GC also need `x-feed-state-protocol` ≥
`MIN_PROTOCOL` (426): the minimum is raised with every incompatible layout change, so an old run re-run from the Actions
UI (its token is still valid for main) cannot write an old layout.

## Budgets: never pay

R2 has no spend cap and its free tier is per account (10 GB-month, 1M Class A and 10M Class B operations a month;
DeleteObject is free), shared with the platform (about 0.4 GB). So the Worker meters itself: every authenticated
request first reserves its worst case in the `BudgetLedger` Durable Object (one SQLite-backed object, `global`, one
row per UTC day, rows older than 40 days pruned) and is refused with 429 `{"error":"budget"}` above a ceiling:

| Ceiling (var) | Production | Staging | Counts |
|---|---|---|---|
| `CLASS_A_PER_DAY` | 20,000 (≤ 620k a month) | 2,000 | a PUT 1, a GC page 1 (its list) |
| `CLASS_B_PER_DAY` | 200,000 (≤ 6.2M a month) | 20,000 | a batchGet n (a missing blob too), a GC first page 1 per `current` |
| `BYTES_WRITTEN_PER_DAY` | 1 GiB | 256 MiB | a PUT's `Content-Length` |
| `STORED_BYTES_MAX` | 6 GiB | 256 MiB | the running stored estimate, checked by every PUT |

The two environments together stay inside the account's free tier with room for the platform's own R2 use. The stored
estimate is raised by every PUT (an overwrite counts again: it errs high), lowered by what GC deletes, refunded when R2
refuses a PUT, and re-seeded at the end of every complete GC pass from what the pass listed and kept plus what was PUT
meanwhile. If GC stops, the estimate climbs by the day's writes until PUTs are refused; `feed:state-budget` (above 70 %
of a ceiling) and `feed:state-gc` (no successful GC in 3 days) fire long before.

The feed's own use: about 1,500 requests a day (about 288 aggregate runs, each one or two batchGets and a few PUTs),
roughly 1-2 % of every ceiling. The ledger writes one day row per authenticated request (the account's Durable Object
limit is 100,000 rows written a day, shared with the heartbeat ledger and the alerts gateway); an unauthenticated request
never reaches the ledger or the bucket.

**The Workers request cap is shared.** Workers Free allows 100,000 requests a day per account, and the platform's API
budgets most of it. When the account hits the cap, Cloudflare answers Error 1027 until 00:00 UTC: in phase 3a the
store calls fail, the shadow check reports `feed:state-shadow`, and the feed carries on from git; from phase 3b the feed
stops until the cap resets (APIs.md "Repository size", outage budget).

## Logging

One JSON line per request (Workers Logs, kept 3 days; `wrangler tail` live):
`{"t":"feed-state","rid","method","route","path","workflow","run_id","run_attempt","sha","n","bytes","missing",
"deleted","dry_run","status","ms","error","cause"}` (fields that do not apply are absent). A batchGet logs when its
stream ends. The token, the claims other than the run and workflow, and the request bodies are never logged. A failed
JWKS fetch logs `{"t":"feed-state","event":"jwks-fetch-failed"}`.

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

## Rollback

`npx wrangler deployments list -c state/wrangler.toml --env ""` (or `--env staging`) lists the versions OLDEST first,
each with its `main <commit>` message; `npx wrangler rollback <version-id> -c state/wrangler.toml --env "" --message
"rollback to main <commit>"` makes an earlier version active at once. Then revert the change on `main` and deploy again
with `deploy.sh`, so the active Worker is again the code on `main`. A rollback never touches the bucket or the ledger:
the key layout and the ledger schema only ever grow (`CREATE TABLE IF NOT EXISTS`), so an older version reads them.
Lowering `MIN_PROTOCOL` in a rollback re-admits older clients; only do that together with the client rollback.

## Verify

After every deploy (production host shown; staging the same with its host):

| Check | Expect |
|---|---|
| `curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://feed-state.theshelter.app/v1/cas:batchGet` | `401` from the Worker (JSON `{"error":"unauthenticated"}`, an `x-request-id`), not a zone `403`/`1010` or `429` |
| `curl -sS -o /dev/null -w '%{http_code}\n' https://feed-state.theshelter.app/` | `404` |
| `curl -sS -o /dev/null -w '%{http_code}\n' https://earthquakes-feed-state.<account>.workers.dev/` | no answer from the Worker (no workers.dev route) |
| `state-rehearsal.yml` on staging (dispatch from any branch) | PUT, batchGet (a present and a missing blob, the trailer), a 10037 PUT answered 400, GC dry run, `GET /v1/budget`: all as above |
| `wrangler tail` during an aggregate run | one `feed-state` line per call with the run id, status 200 |

To rehearse on staging (not covered offline): the binding's error on a wrong `sha256` (expected `… (10037)`, mapped to
400), whether R2 binding calls count against the 50 or the 1,000 subrequest limit (a batchGet of 40 and a GC first page
of 40 HEADs stay under either), and the CPU time of a 40-blob batchGet and of a 1,000-key GC page (`wrangler tail`
shows `cpuTime`; Workers Free allows 10 ms per request).
