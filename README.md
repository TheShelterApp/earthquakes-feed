# earthquakes-feed

An open, free earthquake feed. A GitHub Actions job aggregates earthquakes from 42
seismic networks on a schedule, deduplicates them into one feed, and commits the
result to Git — so the full history is queryable by both *when the quake happened*
and *when the feed learned about it*. Served worldwide over a CDN, free to consume.

- **Live:** <https://earthquakes-feed.theshelter.app>
- **Format:** a USGS-GeoJSON superset — any USGS-GeoJSON parser works unchanged.
- **Cost:** $0 to run (public-repo Actions) and $0 to consume (CDN, full CORS).
- **License:** [CDLA-Permissive-2.0](LICENSE); each record keeps its source's license in `provenance[]`.

An open community dataset stewarded by [TheShelterApp](https://github.com/TheShelterApp)
— see [GOVERNANCE.md](GOVERNANCE.md) and [RELATIONSHIP.md](RELATIONSHIP.md).

## Consuming the feed

Everything is plain GeoJSON/NDJSON over a CDN with `Access-Control-Allow-Origin: *`.
Start from the manifest; don't hardcode paths. **Full API reference: [APIs.md](APIs.md).**

```bash
# Catalog: every summary + partition, with freshness and cache hints:
curl -s https://earthquakes-feed.theshelter.app/v1/manifest.json

# The current day, all 42 sources deduped (one CORS-open request):
curl -s https://earthquakes-feed.theshelter.app/v1/all_day.geojson

# One recent day as a ready-to-render full-detail FeatureCollection (Pages; days in the
# live window — a partition's pages_url in manifest.json tells you it exists):
curl -s https://earthquakes-feed.theshelter.app/v1/events/2026-07-04.geojson

# The week kept current without re-downloading it: per-day files with sha256 fingerprints plus
# head_seq deltas (APIs.md, Live index):
curl -s https://earthquakes-feed.theshelter.app/v1/live/index.json

# The month under the week (M >= 2.5, days through today - 6) the same way, without deltas (APIs.md, Month index):
curl -s https://earthquakes-feed.theshelter.app/v1/live/month.json

# One event's full detail: the live events of its UTC hour, full-fat (APIs.md, Event detail):
curl -s https://earthquakes-feed.theshelter.app/v1/detail/2026-10-05T09.geojson

# The share page of a significant event (M4+, felt, a tsunami flag or a PAGER alert, about the last 45 days): static
# HTML for people and link previews, the target of https://theshelter.app/event/<feed id> (APIs.md, Share pages):
curl -s https://earthquakes-feed.theshelter.app/share/event/efd_01M6Z5Z7N0YS0YZKJ7H5HDQMVE

# Any frozen day as NDJSON, straight from the data branch (full history):
curl -s https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/events/2026/07/04.ndjson

# A day of the last 11 (not frozen yet) as NDJSON: the manifest's `url` for it, on Pages:
curl -s https://earthquakes-feed.theshelter.app/events/2026/10/13.ndjson

# Statistics: the catalog of the columnar day tables (today - 60 .. today) and the year and area files, each with
# its sha256 (APIs.md, Statistics; listed while providers/stats.json has derive_publish "on"):
curl -s https://earthquakes-feed.theshelter.app/v1/stats/index.json
```

### Statistics

`/v1/stats/` holds what a statistics screen needs without downloading day files or asking ComCat: one compact
columnar table per UTC day for the last 61 days (every live event with its magnitude, position, depth, place, chosen
provider, review status and report delay; the non-earthquakes and unusable rows counted), the current year and the two
before it as per-day magnitude bins plus their M5+ events, and every year since 1973 on a 0.1° grid for "near me" counts
(M4.5+ before 2000 from USGS ComCat). The index lists every file with its sha256 and the signed v2 manifest names the
index's sha256, so a client re-reads only the files whose fingerprint changed. The rows are the feed's own events,
merged by the feed's own rule (where an input is not yet re-merged, the stats builder runs the same `remergeNodes` over
it in memory); the statistics then collapse the reports of one quake that the merge keeps apart (the reconciliation:
other catalogues within 60 s, 100 km and 1.0 magnitude of an M4.5+ row, 200 km and 1.5 for M7+, ComCat's row kept) and leave out regional networks' M4.5+ solutions far outside their own
regions (ComCat's authoritative-region practice), counted per file; `collapsed_into` names the row each collapsed id
folded into, so an id shared from the live map still resolves after the collapse. The year and area files come from the `stats` workflow (`src/stats-history.ts`, every
6 h): it rebuilds a year when the checksums of its inputs change, checks each year against USGS ComCat's M6+ and M4.5+
counts before it commits the files to `data`, and keeps a year's previous files when the check fails. Format, row rule,
inputs and completeness epochs: [APIs.md](APIs.md#get-v1statsindexjson--statistics). `providers/stats.json` holds the
switches (`derive_publish` off / shadow / on, `history_enabled`).

### Rolling summary feeds (USGS-style matrix)

`/v1/{threshold}_{window}.geojson`, `threshold ∈ {all, 1.0, 2.5, 4.5, significant}`,
`window ∈ {hour, day, week, month}` — e.g. `4.5_week.geojson`, `all_hour.geojson`.
The threshold in the name is a *minimum*, not a promise: a file that would blow the size
budget is republished one magnitude rung higher (up to M≥5.0) — month files start at
M≥2.5, but a dense week escalates too. Read `metadata.min_mag` for the effective floor
instead of inferring it from the name. If even that doesn't fit, the **oldest** features
are dropped and `metadata.truncated: true` says so — the file then covers a shorter span
than its window name implies. `significant` is `sig≥600` or `mag≥6` (a predicate, so no
floor applies to it). Summaries carry **compact** Features — full top-level properties +
`feed` core (`aliases`, `chosen_provider`, …) but no `feed.provenance[]`; the full
per-provider detail lives in the day files and partitions below.

### Historical day slices

Same Features, two shapes per UTC day:

- `/v1/events/YYYY-MM-DD.geojson` — FeatureCollection on Cloudflare Pages for the days
  in the live window (~45 days); present **iff** the partition entry in `manifest.json`
  carries `pages_url`. Convenient for map time-sliders.
- `events/YYYY/MM/DD.ndjson` — one Feature per line, full history, on the `data`
  branch (via jsDelivr `@data`), and for the unfrozen days (the last 11) also on Pages
  at `https://earthquakes-feed.theshelter.app/events/YYYY/MM/DD.ndjson`, which their
  `url` names. Discover paths, counts, and `frozen`/`pages_url` through `manifest.json`.
  **From 2026-11-04, `@data/events/...` holds a day only once it is frozen; use
  `pages_url` / the manifest** (APIs.md, *Historical day partitions*).

Both shapes are **full-fat** (complete `feed.provenance[]` with each provider's original
`fields`) — only the rolling summaries are compact.

For an **immutable, cache-forever** copy of a `frozen` partition, pin it to the
manifest's `data_commit` (a git SHA) instead of the `@data` branch ref:
`https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@<data_commit>/events/YYYY/MM/DD.ndjson`.
Very old months live in Release tarballs — see `manifest.archives[]` (`partitions[]`
overrides `archives[]` for any day in both). An archive month's asset is `events-YYYY-MM.tar.zst`, or after a re-roll
or a re-merge `events-YYYY-MM.e<N>.tar.zst` (the entry names the current one; earlier ones stay in the Release, listed in
`previous[]`). Re-merged assets hold `superseded` lines beside the live ones: keep `feed.state === "live"`.

### The Feature shape

Top-level `properties` is the full USGS-standard set (`mag`, `place`, `time` in ms,
`updated`, `status`, `net`, `tz`/`url`/`felt`/`cdi`/`mmi`/`alert`/`sig`/`nst`/`dmin`/
`rms`/`gap`/`code`/`ids`/`sources`/`types`/`title`, …) plus cross-source extras when a
source provides them (`author`, `magAuthor`, `catalog`, `country`/`province`/…). A
top-level `source` (= `net`) sits beside `id`/`geometry`/`properties`; `coordinates`
omits the depth slot (never `null`) when unknown. These top-level values are a
**fill-only field merge** — the chosen provider's coherent solution leads, gaps fill
from the other providers, core geometry/magnitude is never mixed across solutions.

**No source field is ever dropped:** each provider's *complete* original vocabulary is
preserved verbatim under `provenance[].fields` (dedup is field-addressable, not a
lowest-common-denominator subset). Feed-specific data lives under `properties.feed`:

```jsonc
{
  "type": "Feature",
  "id": "efd_01KWQM1FJ06ZG64AHRSAVXS7CW",     // stable feed id, never churns
  "source": "usgs",                            // = properties.net (chosen network)
  "geometry": { "type": "Point", "coordinates": [lon, lat, depthKm] },  // [lon, lat] if depth unknown
  "properties": {
    "mag": 4.6, "magType": "ml", "place": "…", "time": 1783204207460,
    "updated": 1783204304415, "status": "reviewed", "net": "usgs", "type": "earthquake",
    "nst": 41, "dmin": 0.35, "rms": 0.82, "gap": 71, "felt": 12, "mmi": 3.4, "sig": 326,
    "feed": {
      "feed_id": "efd_…",
      "event_time": "…Z", "ingest_time": "…Z",   // the two clocks
      "first_seen_seq": 1516, "ingest_seq": 1702, "revision": 3, "state": "live", "tombstone": false,
      "chosen_provider": "usgs",
      "aliases": ["usgs:us7000nabc", "emsc:20260704_0000117"],
      "provenance": [ { "provider": "usgs", "native_id": "us7000nabc", "mag": 4.6,
        "status": "reviewed", "license": "US-PD", "attribution": "…", "chosen": true,
        "fields": { "code": "us7000nabc", "ids": ",us7000nabc,", "nst": 41, … } }, … ]
    }
  }
}
```

### Freshness

Scheduled runs are best-effort (GitHub delays low-activity crons — often ~hourly,
not every 5 min). Treat the feed as an archive that is usually minutes-fresh, not a
guaranteed real-time bus. Every FeatureCollection and the manifest carry
`metadata.generated` (ms epoch) and `metadata.age_seconds`; the manifest also carries
`freshness.stale_after_seconds` (default 1800). Consumers should mark the layer
degraded past that and fall back to their own real-time source (e.g. the EMSC
WebSocket) if they have one. For live-map dedup, index `feed.aliases[]` and merge a
WebSocket event that shares an alias or falls within ±60 s / ±10 km (for a large quake,
both ≥ M5.5, the window widens to `20 + 20·(min(M) − 5.5)` km, at most 50 km, while
|ΔM| ≤ 1 — see [APIs.md](APIs.md#realtime--client-dedup)). Drop every feature whose
`feed.state` is not `live`: an event superseded by a merge (once agencies' solutions
converged) or deleted (tombstoned) stays published, compact and non-live, for 48 h so
pollers see the removal ([APIs.md](APIs.md#retired-events)).

## Sources

42 networks, configured in [`providers/registry.json`](providers/registry.json)
(add more — see [CONTRIBUTING.md](CONTRIBUTING.md)). A server runner has no CORS limit,
so the feed carries national sources a browser can't reach directly, down to small
local magnitudes. Full credits: [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

- **Global (FDSN):** USGS/ANSS, EMSC/CSEM, GEOFON, ISC (reviewed but months-delayed — backfill-only).
- **Europe (FDSN):** INGV (Italy), RESIF + RéNaSS + IPGP (France), NOA (Greece), ETHZ (Switzerland), KNMI (Netherlands), LMU (Germany/Bavaria).
- **Americas / Oceania (FDSN):** NCEDC + SCEDC (California), NRCan (Canada), GeoNet (New Zealand), AusPass (Australia), USP (Brazil).
- **National APIs (custom adapters):** AFAD (Turkey, to ~M0.6), CENC (China), JMA (Japan), NCS (India), TMD (Thailand + Myanmar), CWA (Taiwan), KAGSR (Russia — Kamchatka/Kurils), BMKG (Indonesia), IGN (Spain), IMO (Iceland), IPMA (Portugal + Azores), BGS (UK), ENSN (Egypt), SSN (Mexico), IGP (Peru), OVSICORI (Costa Rica), IG-EPN (Ecuador), CSN (Chile), INPRES (Argentina), GA (Australia), AEC (Alaska — automatic solutions within minutes, published as `automatic`; its ids are ComCat ids).

A monthly [`discover.yml`](.github/workflows/discover.yml) scans the FDSN datacenter
registry and re-probes known-down endpoints, opening an issue with vetted candidates —
new sources are reviewed and enabled by hand, then **auto-backfilled** into history.

Kazakhstan, Kyrgyzstan, Uzbekistan, Tajikistan, Turkmenistan, Belarus, Ukraine, and
Pakistan have no open real-time earthquake API (KNDC is CTBTO-restricted; others publish
only delayed waveforms); Iran (IRSC) geo-restricts to domestic IPs, the Philippines
(PHIVOLCS) publishes an HTML bulletin with no machine API, and Romania (INFP) has no
reachable event service. Those regions are covered via the global catalogs until an
open, reachable source appears.

## Architecture

- **Source of truth** is an append-only **observation log**
  (`knowledge/observations/…`) on the `data` branch — one bitemporal record per
  provider report, with a global monotonic `seq`. It is never rewritten.
- Everything consumers read (summaries, day partitions, `manifest.json`) is a
  **rebuildable derived view** of that log.
- **Two phases:** `aggregate` (fetch → dedup → append the log) → `derive` (rebuild
  views, publish), both in every `aggregate` run, one after the other on the same checkout. Each source fetch is
  fail-open — one dead source loses nothing.
- **One writer at a time:** `aggregate`, `backfill`, `archive` (and `derive` dispatched by hand) share the concurrency
  group `earthquakes-feed-writer` with `queue: max`, so a run waits its turn instead of being cancelled by the next
  one; every commit to `data` goes through `scripts/push-data.sh` (fetch, rebase, retry, fail loudly on a conflict). The
  side-index commits of `history`, `first-solutions` and `remediate` write only their own files and push without the
  lock. `scripts/writer-group-sim.ts` replays a week of runs under GitHub's queue rules. The queue is bounded: see
  [Writer group](#writer-group).
- **History & growth:** `backfill` walks each source backward (paced, idempotent, ~3-yr
  target), and `archive` rolls cold months (>120 d) to GitHub Releases (un-metered) and
  prunes the tree — so the `data` branch stays bounded. The run logs (`status/history`, one
  file per day since round 17, and `changes/`) keep only the current month in the tree; finished months become immutable
  gzip assets of the `logs-YYYY-MM` releases ([APIs.md](APIs.md#run-logs)). The `health`
  workflow logs the repository's size and files `feed:repo-size` above 8 GB (5.48 GB on 2026-10-04, 5.64 GB on
  2026-10-06, about 67 MB a day: GitHub keeps about one compressed copy of every large file a commit rewrites, see
  [APIs.md](APIs.md#repository-size); `scripts/repo-growth/` measures it). `event_map` is sharded by
  event-day and UTC hour (`YYYY-MM-DD-HH.ndjson` since round 17) and pruned to a 45-day dedup horizon; identity older than that lives in the
  frozen day partitions. Every source with a time-range query reached the target
  (2023-07-06) in July 2026 except ISC, whose walk is paused; a backfilled row is the
  source's solution when it was fetched, while the log holds each report as first seen
  since 2026-07-05 (`scripts/first-observations.ts`; [APIs.md](APIs.md#history-and-backfill)).
  History before 2023-07-06 goes elsewhere: the `history` walk (switched by `providers/history.json` `enabled`; on since
  2026-10-01 for its first era, 2022-07-01 → 2023-07-06: ComCat in edition 1, the 17 FDSN sources that reached the 3-year
  target in edition 2; era A takes the same 17 back to 2000-01-01; era B is ComCat alone, M ≥ 4.5 only, back to
  1973-01-01) writes
  immutable `history-YYYY` Release assets only, and the `data` branch gains just `knowledge/index/history.json` and the
  walk's small `knowledge/index/history-state.json` ([APIs.md](APIs.md#deep-history-before-2023-07-06)).
- **Remediation editions:** a backfill day whose one-day window still filled a source's page cap
  (`saturatedDays`), and the 2026-06-28..07-03 seam that 15 sources never fetched, are asked
  again in sub-day windows by the `remediate` workflow and published as one additive, immutable
  edition per day in a `remediation-YYYY` Release; refills wait in a persistent queue until
  their month is archived, and the archived day is never rewritten. ComCat's late publications (M4.5+ solutions
  published or revised after the live day froze) are asked again once a day for the frozen, unarchived days of the
  last 45, each changed day getting a `late_usgs` edition built on its frozen partition
  ([APIs.md](APIs.md#remediation-editions-saturated-days-and-the-2026-07-seam)).
- **Re-merged history:** history written with the merge pass off (backfill, the deep-history build, remediation) keeps
  a quake that reached it source by source as several events; the offline re-merge (`src/remerge.ts`, config
  `REMERGE_EPOCH`, 0 = off) replays the live feed's identity steps over it in sliding 7-day windows and publishes the
  result as new assets beside the old ones: history editions `events-YYYY-MM.e<N+1>.tar.zst` (the hourly `history`
  walk), archive assets `events-YYYY-MM.e<N>.tar.zst` (`remerge.yml`, every 6 h, compare-and-set commit) and refreshed
  remediation editions. Losers become `superseded` and keep their rows; no asset is replaced or deleted (a re-roll takes
  the next free name too, the earlier asset listed in `previous[]`) ([APIs.md](APIs.md#re-merged-history)).
- **Earliest solutions:** `first-solutions` collects the version histories that ComCat,
  GeoNet, INGV and several SeisComP nodes keep (every solution they still hold, with its
  publication time) into a side index of Release assets, one request per second per
  source; `scripts/first-observations.ts` merges it with the log into each source's
  earliest published solution ([APIs.md](APIs.md#earliest-solutions-side-index)).
- **A newly-added source fills in automatically:** its recent live window is onboarded
  into the `event_map`, deep history is backfilled, and already-archived months are
  pulled from their Release, merged, and re-rolled — no manual steps, no gaps.
- **Serving split:** the live surface (summaries + recent day files + manifest) is
  published to **Cloudflare Pages** via Direct Upload (which doesn't consume the
  500 git-builds/month cap). The deploy (`scripts/pages-deploy.sh`) caps each of its
  three attempts at 7 minutes inside the job's budget; when every attempt fails, a live
  manifest under 15 minutes old keeps the run green with a warning (the next run deploys
  again), and `health`'s 30-minute freshness check stays the alarm. The R2 origin
  (`publish-r2`) is off while its settings are blank, and an R2 error never skips the
  Pages deploy. The same deploy carries the static share pages (`share/event/<feed id>.html`, at most 5,000, and a
  generic `404.html`; `src/share-pages.ts`), which `theshelter.app/event/<feed id>` redirects to: no Worker or Function
  runs for a shared link ([APIs.md](APIs.md#get-shareeventfeed-id--share-pages)). Full-history partitions serve from the `data` branch via
  **jsDelivr** (branch refs cache ~12 h — resolve through the manifest). Never
  `raw.githubusercontent.com` (60 req/hr/IP).

## Writer group

Every workflow that commits to `data` beyond its own side index takes the concurrency group `earthquakes-feed-writer`
(`queue: max`: first in, first out, up to 100 waiting), so one writes at a time. `aggregate`, the live feed's publisher,
waits in the same queue as everyone else: on 2026-11-08 a loop of 47 `backfill.yml` dispatches (a usgs refill, 4–5 s
apart) queued ahead of every aggregate run and the live manifest went 1 h 47 min stale (SHLTR-149;
`npx tsx scripts/writer-group-sim.ts incident` replays it). Since then:

- **The lock is job-level, behind a gate.** `backfill.yml`, `archive.yml` and `derive.yml` start with a `gate` job
  outside every group ([`scripts/writer-queue.mjs`](scripts/writer-queue.mjs)): it counts the writer runs created before
  its own that wait for the group or are about to enter it (aggregate included) and lets the writing job join only while
  fewer than 2 do. A refused dispatch fails in seconds with an `::error::` naming what waits; a refused scheduled run
  (backfill's hourly walk, also when the heartbeat Worker dispatches it without a window; archive's 6-hourly run) is a
  `::warning::` and a green run, and its next run does the work. `aggregate.yml` has no gate: it is never refused. The
  bound is "about 2": a gate that cannot see a run created a moment before its own can let a third in, and a gate
  that cannot read the queue refuses (the input `force` overrides both).
- **The locked part is short.** `backfill` holds the lock on a sparse, blobless checkout of `data` (the index files and
  the months of its windows): the full checkout was 94–101 s of the 2 min 15 s each backfill held it, the backfill
  itself 0–2 s. `archive` (4 runs a day) and `derive` (by hand) keep the full checkout: each reads most of the tree.
- **Health watches it.** `feed:writer-queue` (P2) opens when more than 3 writer runs wait, or when the live manifest is
  older than 15 minutes while any does ([Health watchdogs](#health-watchdogs-githubworkflowshealthyml)).

**Pacing.** Dispatch at most 2 writer runs at a time and the next ones as those finish, e.g. a refill of many windows:

```sh
for w in 2026-01-01/2026-01-08 2026-01-08/2026-01-15 …; do
  # Unfinished backfill runs among the newest 20 (the one holding the group included).
  while [ "$(gh run list -R TheShelterApp/earthquakes-feed -w backfill.yml -L 20 --json status -q '[.[] | select(.status != "completed")] | length')" -ge 2 ]; do sleep 30; done
  gh workflow run backfill.yml -R TheShelterApp/earthquakes-feed -f starttime="${w%/*}T00:00:00Z" -f endtime="${w#*/}T00:00:00Z" -f providers=usgs
  sleep 15
done
```

`node scripts/writer-queue.mjs status` (with `GH_TOKEN` and `GITHUB_REPOSITORY` set) prints the whole queue as the gates
see it. `-f force=true` joins whatever waits; every aggregate run then waits behind it, so keep it for a single urgent run. To
drain a queue that got too long: `gh run cancel <id>` for the surplus runs (never the one holding the group).

## Run locally

Requires Node 22+.

```bash
npm install
npm test          # identity / dedup / swarm-guard / revision tests
npm run typecheck

# Run the pipeline against a scratch dir (hits live public APIs, read-only):
DATA_DIR=.data npm run aggregate                 # fetch → dedup → append log
DATA_DIR=.data PUBLIC_DIR=public npm run derive  # summaries + day files + partitions + live and month index + detail hours + manifest
DATA_DIR=.data PUBLIC_DIR=public npm run validate
```

## Deploy (for a fork)

1. **Bootstrap the data branch:** `bash scripts/bootstrap-data-branch.sh && git push -u origin data`
2. **Cloudflare Pages** (for the live surface): create a Direct-Upload Pages project,
   point your domain at it, and add repo secrets `CF_API_TOKEN` + `CF_ACCOUNT_ID`.
3. **Enable Actions.** `aggregate` (with its derive steps) runs on a cron. Because GitHub throttles low-activity
   schedules, an external 5-minute heartbeat (`workflow_dispatch`) is recommended for tight freshness.

### The heartbeat Worker (`heartbeat/`)

A cron-only Cloudflare Worker that dispatches `aggregate` (every 5 min), `health` (every 15 min),
`backfill`, `first-solutions` and `history` (hourly) through the Actions API with a fine-grained
`GH_PAT` (Actions: write). It has no HTTP surface (`workers_dev = false`, `preview_urls = false`).
Cron Triggers are not exactly-once (on 2026-10-14 the one `* * * * *` trigger fired twice a minute, 30 s apart, and every
workflow was dispatched twice), so each activation first claims its (workflow, intended UTC minute) in a dispatch
ledger, one SQLite-backed Durable Object (`heartbeat/src/ledger.js`): exactly one activation per minute dispatches, a
failed dispatch releases its claim so a later activation of the minute may retry, an activation over an hour late is
skipped as stale, and an unreachable ledger never stops a dispatch. Each activation logs `dispatch …` or
`skip …: duplicate|stale` (`wrangler tail`).
**Deploy it only from `main`:** `bash heartbeat/deploy.sh` refuses unless the checkout is exactly
`origin/main` with no local change under `heartbeat/`, and tags the version with the main commit
(`wrangler deployments list` lists oldest first; the active version is the last entry). A change
to the Worker goes through a pull request like any other code and is deployed after the merge.

## Health watchdogs (`.github/workflows/health.yml`)

The heartbeat Worker dispatches `health.yml` every 15 minutes (:07, :22, :37, :52). The workflow's own `:25` cron is
the fallback for a Worker outage: it runs its checks only when no dispatched health run was created in the last 20
minutes (one that was cancelled or skipped does not count). One health run runs at a time (concurrency group
`health`). Every threshold is in one table, `RULES` in [`scripts/lib/findings.mjs`](scripts/lib/findings.mjs)
(alerting plan of 2026-10-22, Phase 1a).

- **`gate`** ([`scripts/reconcile.mjs`](scripts/reconcile.mjs) `--gate`): the fallback cron's skip, and the selftest.
- **Three evaluators**, run from GitHub on purpose, so they keep working when Cloudflare is the thing that broke. Each
  writes one findings document (the artifact `findings-<evaluator>`) and stays green whatever it judged; only a crash,
  or a findings file it cannot write, turns its job red.
  - `feed` ([`scripts/feed-health.mjs`](scripts/feed-health.mjs)): the live `v1` and `v2` manifests, `v1/status.json`,
    the files on `data`, the repository size, the walks' blocked markers and the writer queue (a GitHub read that fails
    is `watcher:feed-github`; a truncated listing of the `data` tree is a warning).
  - `alerts` ([`scripts/alerts-watchdog.mjs`](scripts/alerts-watchdog.mjs)): The Shelter's alert pipeline, from the
    alerts-gateway's public `https://data.theshelter.app/alerts/status.json`, the USGS `4.5_hour` canary and, with the
    `CF_ANALYTICS_TOKEN` secret, the account's daily usage (only account totals are logged, and an API error is
    redacted of the token and the account id: the run logs are public). The gateway constants it mirrors (polling,
    backoff, providers, free-tier caps) are checked against `tests/fixtures/platform-constants.json`: when the gateway
    changes one, update the mirror and that snapshot (`tests/platform-constants.test.ts` compares the snapshot with a
    platform checkout when one is at hand).
  - `platform` ([`scripts/platform-watchdog.mjs`](scripts/platform-watchdog.mjs)): `https://api.theshelter.app/v1/health`,
    `https://config.theshelter.app/healthz` and the config bundle's age.
- **`reconcile`** ([`scripts/reconcile.mjs`](scripts/reconcile.mjs)): the only job that writes issues. It applies each
  rule's holds, resolves, inhibitions, escalation and the silences, writes the boards and sets the run's conclusion. It
  runs after a failed evaluator too (its rows freeze), but not in a run cancelled by hand. Exit 1 is red for a finding;
  exit 3 is red because alerting itself is broken: the boards unreadable, a board body not created, not saved or too
  long even shrunk, a new board that cannot be labelled, board comments failing on two runs in a row, or no
  `GH_TOKEN`.

**Severity ladder.**

| Level | Meaning | Run | Board |
|---|---|---|---|
| P1 page | Alerts are not reaching users, or will stop within hours or days | Red on every run while it holds | Silent row |
| P2 urgent | Redundancy lost, or a symptom a fallback still covers | Red during its first hour, then green with `::error::` | Silent row |
| P3 ticket | Act within days, or one external source has been out long enough to matter | Green with `::warning::` | One comment when it enters, one when it escalates |
| P4 info | Normal churn, or a condition below its line | Green | The job summary only |

Red only on evidence: a P1 or P2 entry held open only by its resolve count, or by a P4 sample below its line (two
providers still down after all three were), is not red. A single external source, a maintenance walk and the watcher
itself never turn a run red. The shadow rules (`alerts:canary`, `alerts:provider-silent:<id>`, `alerts:latency:<id>`,
`feed:systemic`) only log "would notify" until a pull request promotes them.

**Boards.** Three permanent issues, `[health] alert pipeline`, `[health] feed` and `[health] platform` (label
`health-board`), all three created by the first `reconcile` run (a one-time "issue opened" notification to the
repository's watchers), then pinned and locked; they are never closed. Their numbers are kept in
`scripts/health-boards.json` (#124, #125, #126) and each board is read by its number: on 2026-10-22 the label listing
of two runs answered without the boards made minutes earlier, and each of them made another set. A numbered board that
was deleted makes every run red (exit 3) until it is restored or its replacement's number is put in the file, and so
does a missing or broken file; a board marked `null` there (still to be made) is created only when the REST and GraphQL
label listings both answered without it. Two issues
with a board's title: the numbered one (else the lower number) is the board, it continues from the newer state marker
of the two, and the other is retired (renamed "… (duplicate of #N)", unlabelled, unpinned and closed). Once a day the pins and locks are checked again (`GITHUB_TOKEN` may lack the right to pin, which is a warning; the
three boards take all three of the repository's pin slots). Each body lists the open rows, the rows still confirming or
holding, the shadow rules and a "Last 7 days" table (red runs, comments, push transitions, shadow would-notify), and
the alert-pipeline board the last selftest; it ends in a hidden `<!-- health-state v1 … -->` marker: the memory across
runs, so do not edit a body by hand (a broken marker starts the board empty). A body that would pass GitHub's limit
drops its log rows first, then shortens texts and lists fewer rows; the marker keeps every open row (over about a
hundred, the board is not written at all: exit 3). The label `health:p1` … `health:ok` is the board's worst open row.
- **Comments** only when a P3 enters and when it stays open past its rule's age line (the escalation, on a run where
  its finding is present). P1/P2 rows, a rise into P1/P2 (`config:bundle` by age, the promotion below), members leaving
  and resolutions are silent edits: the red run is the P1/P2 alarm, and it reaches the owner only. A comment goes out
  before the body that records it: one GitHub refuses is an `::error::`, rolled back and posted by the next run
  (`watcher:reconcile`), and a body that is not saved afterwards can repeat a comment, never lose one. A board locked
  against the bot is unlocked around its comment or body edit and locked again.
- **Holds.** A condition below its line is a P4 sample. Depending on the rule, a key enters after 2 runs in a row, on 4
  of the last 8 runs or after a 24 h hold, and resolves after 2 healthy runs (4 when it entered on the ratio). Runs
  count by time: a run less than 10 minutes after the previous one (a rerun, an extra dispatch) shares its sample slot,
  confirms nothing and is no healthy run of its own. A resolved key starts its samples afresh, so its next outage is a
  new episode. A finding whose start is unknown (a feed source that never fetched successfully) is held for its rule's
  line from the first run that saw it. While `status.json` is stale or unreadable every other `alerts:*` row is frozen,
  and so are the rows of an evaluator whose findings are missing; `status.json` unreadable for 60 minutes becomes a P1.
- **Inhibition.** While `feed:freshness` is open, `feed:source:*` and `alerts:provider:feed` send nothing; while
  `alerts:provider:usgs|emsc|gfz` is open, `feed:source:usgs|emsc|geofon` sends nothing; a coverage row mutes its
  providers. A held-back comment goes out once the parent resolves, only if the row's own finding is still present.

**Runbook**, one line per key (the row says since when and why):

| Key | Sev | When | First step |
|---|---|---|---|
| `alerts:status:stale` | P1 | `generatedAtMs` over 300 s old | The detector stopped ticking or publishing: the gateway Worker's logs and its last deploy |
| `alerts:status:unreadable` | P2 (2nd run); P1 after 60 min | 3 tries within 60 s fail; open for 60 min it is a P1 (`gh-detect`), since every other `alerts:*` row is frozen meanwhile | `data.theshelter.app` (edge, object), then the gateway's publishing |
| `alerts:coverage:all` | P1 | `usgs`, `emsc` and `gfz` all `ok: false` (or not polled) together for 60 s | Three agencies at once points at the gateway (egress, DNS, a deploy): its logs first |
| `alerts:coverage:two` | P2 | Two of them together for 180 s | One direct source and the feed backstop are left: which two, and their `lastError` |
| `alerts:provider:<id>` | P3 | `usgs` 30 min, `emsc` and `gfz` 60 min (15 min for `invalid` bodies), or 4 of the last 8 runs; escalates at 2 h (`usgs`, `invalid`) or 12 h | Usually the agency: act when it escalates; `invalid` means its format changed |
| `alerts:provider:<id>` (not polled) | P3 (2nd run) | `usgs`, `emsc` or `gfz` missing from `detector.providers` (all three when the list is empty); the coverage rows count it as failing | The gateway's last deploy and its provider configuration |
| `alerts:usgs:primary` | P3 | ComCat FDSN failing 6 h while the summary feed serves | Live USGS events arrive up to about 2 min later; ComCat's FDSN service |
| `alerts:usgs:deletions` | P3 | The deletions query failing 24 h; escalates at 5 d | Deleted quakes are not withdrawn: fix it inside the gateway's 7-day withdrawal window |
| `alerts:provider:feed` | P3 | The gateway's feed backstop `ok: false` 30 min | Muted while `feed:freshness` is open; else the gateway's read of `v2/manifest.json` |
| `alerts:budget` | P2 | The tightest of the gateway's five daily free-tier ratios projected to 0.75 of the day (from 02:00 UTC); resolves under 0.65 | What spends rows or requests (`budget` in `status.json`), before the degradation ladder sheds tiers |
| `alerts:degraded` | P1; P3 when forced | The degradation ladder is active | Relieve the budget cause; a forced override is a reminder to lift it |
| `alerts:policy` | P1 | The compiled fallback policy runs instead of the signed one | Republish or repair the signed alerts policy |
| `alerts:apns` | P1 / P3 | P1: APNs not configured, `apns.problems` not empty, or split mode without production; P3: today's `skipped_no_key` or `retry_dropped_budget` above 0 | The gateway's APNs keys for the environment named |
| `alerts:selftest` | P1 | The selftest (below) | Expected; never stored on a board |
| `feed:writer-queue` | P2 | More than 3 runs wait for (or are about to enter) the `earthquakes-feed-writer` group, or the older live manifest is over 15 min old while any does (unfinished runs older than 6 h are GitHub's ghosts and do not count) | [Writer group](#writer-group): cancel the surplus runs (`gh run cancel <id>`), pace the dispatches; usually a burst dispatched with `force=true` |
| `feed:freshness` | P2 (unreachable: 2nd run) | The older of the live `v1` and `v2` manifests past `stale_after_seconds` (1,800 s), confirmed by a re-read 60 s later; or a manifest unreachable | The aggregate runs, the heartbeat Worker and its `GH_PAT`, the Pages deploy; `v1` fresh and `v2` stale means signing stopped |
| `feed:status` | P3 (2nd run) | `v1/status.json` unreadable | The per-source rows are frozen meanwhile: the aggregate runs' Pages publish |
| `feed:source:<id>` | P3 | Its fetch failing from `lastSuccessAt` for 3 h (`usgs`, `emsc`, `geofon`), 12 h (the others) or 2 h (HTTP 401/403/404/410, a schema error, a certificate), or silent or frozen past its activity budget; for a source that never fetched successfully, that line counts from the first run that saw it; escalates at 24 h (core sources, definite errors) | Usually the agency; a certificate: [providers/tls/README.md](providers/tls/README.md); a 404 or a schema error: the adapter |
| `feed:cert:<id>` | P3 | A pinned leaf with under 7 days left; escalates at 2 days left | Pin the new leaf's intermediate if its issuer changed ([providers/tls/README.md](providers/tls/README.md)) |
| `feed:size` | P3 | A status-history day file over 5 MB, or any other file on `data` over 45 MB | Slim what grows ([APIs.md](APIs.md#run-logs)): GitHub rejects a pushed file above 100 MiB |
| `feed:repo-size` | P3 | The repository over 8,000,000 KB | [APIs.md](APIs.md#repository-size) |
| `feed:stats` | P2 (after 30 min) | `providers/stats.json` says `derive_publish: "on"` and the live v1 manifest has no `stats` pointer | derive's `::warning::stats dropped: …` says why; the live feed is unaffected and the app keeps its last verified statistics |
| `feed:stats-through` | P3 | With `history_enabled`, the statistics index's `through` null or more than 3 days behind the last frozen day | The stats builder's runs (`stats.yml`) and its ComCat gate |
| `feed:stats-days` | P3 | The statistics index names `missing_days` | A window day with neither an event-map day nor a partition on `data` |
| `walks:<workflow>:<source>` | P3 | A blocked marker of `history`, `first-solutions`, `backfill`, `archive`, `remerge` or `stats` (a year that failed its ComCat gate or its build, a failed verify) in the last 26 h (`run` for a line about the walk itself) | The walk run's warning; the row resolves 26 h after the last marker |
| `platform:api` | P2 | `/v1/health` not 200 `ok: true` after 3 tries over 60 s, or `sessionKeySource: "ephemeral"` | The API Worker; an ephemeral key means its session signing secret is missing (random 401s in the app) |
| `platform:api:envelope` | P3 | `providerTokenEnvelope: "missing"` | Account deletion cannot revoke at Apple until the envelope key is set |
| `platform:config-worker` | P3 | `/healthz` not 200 `ok: true`; escalates at 6 h | Apps read the data copy first and keep their last good config: the config Worker |
| `config:bundle` | P3 / P2 / P1 | The older of the config bundle's data copy and the signed policy over 5 / 10 / 25 days (the bundle expires at 30); or the copy's version behind `/healthz` for 24 h (a partial publish) | Rerun the config bundle's refresh, then check the copy reaches the host's version |
| `platform:cf-usage` | P2 / P1 | Only with `CF_ANALYTICS_TOKEN`: Workers requests or D1 rows written at 80 % (or a projected 100 %) / 95 % of the free daily caps | What spends them; the caps reset at 00:00 UTC |
| `watcher:<name>` | P3 (2nd run) | The monitoring itself: an evaluator without findings, a refused token, a usage query that failed, a GitHub read of the feed job (`feed-github`), board comments `reconcile` could not post (`reconcile`), no selftest for 35 days (`selftest-overdue`) | The job's log; the frozen rows wait for it; `selftest-overdue`: run the selftest |

**Silences.** The repository variable `HEALTH_SILENCES` mutes a key's comments and pings until a date, with no commit:
`key=until,reason;…`, where `key` is exact or a prefix ending in `*` and `until` is `YYYY-MM-DD` (the end of that UTC day)
or an ISO time with a zone (at most 20 entries). A silence lifts early when the key's severity rises, and it does not
change a red run; an expired or malformed entry is named in the run's warnings. For example
`gh variable set HEALTH_SILENCES --body 'feed:source:tmd=2026-11-01,new certificate chain' -R TheShelterApp/earthquakes-feed`.

**Who is told.**
- **A red run** sends GitHub's failed-workflow email (Settings → Notifications → Actions) to whoever GitHub notifies for
  that run: for the runs the heartbeat dispatches, the account that owns its `GH_PAT` (another account's PAT reroutes the
  email); for the cron runs, the last person who edited the cron line.
- **A board comment** notifies whoever subscribed to that board or watches the repository: subscribe to the three boards
  once they exist. Only P3 entries and escalations comment, so a P1 reaches the owner alone (the red run).
- **No push channel for now** (owner decision 2026-10-22): `reconcile` computes the Healthchecks.io pings (`gh-detect`,
  `gh-deliver`, `gh-redundancy`, `gh-feed`, `gh-platform`, `gh-capacity`, `gh-aging`, `health-watchdog`, `selftest`) but
  skips them while the `HC_PING_KEY` secret is unset.

**Selftest.** The monthly cron (09:17 UTC on the 1st) and `gh workflow run health.yml -f watchdog_selftest=true` force the
P1 `alerts:selftest`: the run must be red, which proves the red path and the email. `reconcile` records the last selftest
on the boards; GitHub can drop a scheduled run, so 35 days without one opens `watcher:selftest-overdue`.

**Walks and writers.** `history`, `first-solutions`, `backfill`, `archive`, `remerge` and `stats` keep a blocked run green: a `::warning::`,
and the marker as the artifact `walk-blocked-<workflow>`, which the `feed` job files as `walks:<workflow>:<source>`.
Only the newest marker of a walk counts, for 26 h. `backfill` and `stats` state every standing block on every run (an
open dispatched window, a stalled walk, an unreadable archive; a year whose ledger entry failed its ComCat gate), and a
run of theirs with nothing blocked uploads a marker with only a `#` line: the entry resolves on the next health run, no
hand clearing. A dispatched backfill window that overflowed, failed or held back a day stays open in
`knowledge/index/backfill.json` (`dispatched`) until dispatched ranges of that provider that answered in full cover it
(dispatch narrower ranges inside it). The other walks report a block once and rely on the 26 h hold.
`aggregate` and `derive` still go red on a failed publish (owner decision 2026-10-22); `feed:freshness` is the symptom
either way.

**Locally.** `npm test` covers every rule with fixtures and never calls the network.

```bash
node scripts/alerts-watchdog.mjs        # annotations and exit codes: 0 healthy, 1 a P1/P2, 2 unreadable, 3 misconfigured
node scripts/platform-watchdog.mjs      # the same for the API and config Workers: 0 healthy, 1 a host down, 3 misconfigured
node scripts/feed-health.mjs            # prints its findings document (without GH_TOKEN, no GitHub parts)
node scripts/alerts-watchdog.mjs --findings findings/alerts.json   # likewise feed-health.mjs and platform-watchdog.mjs
node scripts/reconcile.mjs --findings-dir findings --dry-run         # what the boards would say; writes and pings nothing
```

## Licensing & takedowns

The compilation is [CDLA-Permissive-2.0](LICENSE); each record carries its source's
own license in `provenance[].license`. We publish factual seismic parameters (not
copyrightable expression) and honor removal requests reactively — see
[TAKEDOWN.md](TAKEDOWN.md) and [SECURITY.md](SECURITY.md).

## Status

Live end-to-end: 42 sources, stateful field-level dedup (superset model — every source
field preserved), bitemporal log, 20 rolling feeds, per-day partitions + Pages day
files, manifest, CI, and Cloudflare Pages serving. `event_map` is sharded by day and hour and
pruned to a 45-day dedup horizon, with older identity preserved in the day partitions.

Running in production: `updatedafter` revision + `includedeleted` tombstone sweeps (the
ComCat revision sweep also adds events ComCat published days after their origin, inside the
7-day hot window — see [APIs.md](APIs.md#late-publications); each sweep keeps its own cursor in
`knowledge/index/sweeps.json`, which only a complete sweep advances, and ran a one-time 7-day
catch-up, `SWEEP_EPOCH`),
`op:merge` survivor selection (a large quake whose preliminary epicentres scattered across
agencies folds into one feed id once the solutions converge; the loser is published
superseded; two ids fold only when each is the other's best match), a one-time heal of the
hot window (`HEAL_EPOCH`, marker `knowledge/index/heal.json`), coordinate-less reports
(NCEDC's `0, 0` / M0 placeholders) dropped at ingest and retracted where already published (a
zeroed report of a known SCEDC / NCEDC id is that provider's withdrawal), `@sha` immutable partition URLs, paced historical **backfill** (~3-yr target) with
monthly **Release archival** of cold months (and re-roll when a new source backfills
into one), automatic **new-source onboarding** of the recent window, an external
5-minute Cloudflare-Worker **heartbeat**, and a monthly source **discovery-assist**.

**Roadmap:** knowledge-time snapshots; empirical swarm-guard calibration. Contributions
welcome.
