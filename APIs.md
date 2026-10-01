# earthquakes-feed — API reference

A static-file API over a CDN. No server, no keys, no rate limits, full CORS
(`Access-Control-Allow-Origin: *`). Everything is GeoJSON or NDJSON.

**Golden rule:** fetch `manifest.json` first and resolve every other path from it.
Don't hardcode partition/summary paths or `@sha` URLs — they can move (freezing,
archival, redaction).

## Surfaces

| Surface | Base | Use | Cache |
|---|---|---|---|
| Cloudflare Pages | `https://earthquakes-feed.theshelter.app/v1/` | live feed, recent day files, manifest | summaries + manifest `max-age=30` + SWR; day files `max-age=300` (today, yesterday) / `3600` (older) |
| jsDelivr (branch) | `https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/` | full-history partitions | ~12 h |
| jsDelivr (`@sha`) | `…@<data_commit>/` | immutable frozen partitions | 1 year, immutable |
| GitHub Releases | `archive-YYYY-MM` assets | very old months (bulk) | immutable, no CORS |

## Endpoints

### `GET /v1/manifest.json`

The catalog. Fields:

| Field | Meaning |
|---|---|
| `generated` / `generated_iso` | when this manifest was built (ms epoch / ISO) |
| `head_seq` | global monotonic knowledge clock |
| `event_count` | live events in the rolling window |
| `freshness.stale_after_seconds` | treat the feed as degraded past this age (default 1800) |
| `data_commit` | git SHA for building immutable partition URLs |
| `summaries` | map of `{name: {path, url, count}}` for the 20 rolling feeds (`count` = live events in that file) |
| `partitions[]` | per-day: `{date, path, url, pages_url?, count, bytes, min_mag, max_mag, frozen}` |
| `archives[]` | rolled-up cold months: `{period, tag, asset, url, bytes, sha256, count, days[]}` |

`partitions[]` overrides `archives[]` for any day present in both.

### `GET /v2/manifest.json` — signed catalog

The same catalog, wrapped so a client can trust it from **any** origin (Pages, jsDelivr,
raw.githubusercontent, a mirror):

```json
{ "payload": "<base64>", "sig": "<base64>", "kid": "feed-2026a" }
```

`payload` is the exact bytes that were signed — RFC 8785 canonical JSON of the object below —
and `sig` is Ed25519 over those bytes. Verify **before** parsing; embed the public key for
each `kid` (rotation = a second `kid` in the app, then a swap). Everything v1 has is carried
forward with the same names, plus:

| Field | Meaning |
|---|---|
| `schema_version` | `2` |
| `expires` | `generated + freshness.stale_after_seconds·1000` — past this, show "data may be delayed" |
| `freshness.offline_after_seconds` | past this since the last successful fetch, treat the client as offline (default 2× stale) |
| `data_commit` | always set (the data-branch commit every URL below is pinned to) |
| `origins[]` | `{id, base, max_object_bytes?, mutable_only?}` — prefixes a `path` is appended to: `pages`, `jsdelivr-sha`, `raw-sha`, `raw-data` (head only), `release` |
| `status_url` | where `/v1/status.json` lives |
| `summaries` | v1 entries plus `bytes` and `sha256` of the file |
| `partitions[]` | v1 entries plus `sha256`; `frozen: true` means the bytes never change again (a day is frozen once it is older than the 10 days the 5-minute run can still revise, delete or add to — see *Late publications*) |
| `tiles` | the offline region bundle `{version, url, sizeBytes, sha256}` (from `region-tiles/regions-db.json`), or `null` |

Current signing keys (raw Ed25519 public key, base64):

| `kid` | public key | since |
|---|---|---|
| `feed-2026a` | `d3VM4u2RaSbJ7BC3HPI8PX9XCS7xTlUHA5hRKID9hKo=` | 2026-09-06 |

A `sha256` that does not match the bytes you fetched means the origin is stale or lying —
try the next origin. Signing is done by the `derive` workflow after the data commit exists
(`src/sign-manifest.ts`); the private key never leaves the Actions secret. Verification
helpers: [`@theshelter/signing`](https://www.npmjs.com/package/@theshelter/signing)
(`openBytes` + `decodeJsonPayload`), or CryptoKit `Curve25519.Signing.PublicKey` on Apple
platforms. Schema: `schema/manifest-v2.schema.json`.

### `GET /v1/{threshold}_{window}.geojson` — rolling summaries

`threshold ∈ {all, 1.0, 2.5, 4.5, significant}`, `window ∈ {hour, day, week, month}`
(20 files, USGS-style). A `FeatureCollection` with `metadata` (`generated` ms,
`age_seconds`, `count`, `attribution`, `min_mag` when a floor applies, `truncated` when
features were dropped). The threshold in the name is a **minimum**: any summary may be
published with a higher floor when it would otherwise exceed the size budget — month
files start at M≥2.5, and a dense week or day escalates one magnitude rung at a time (up
to M≥5.0). **`metadata.min_mag` is the effective floor — read it, don't infer it from the
name.** If a file still doesn't fit, its **oldest** features are dropped and
`metadata.truncated: true` is set: the file covers a shorter span than its window name.
`significant` is `sig≥600 || mag≥6` — a predicate, not a floor, so it carries no
`min_mag` (it can still be truncated). Summary Features are **compact**: full top-level
properties + `feed` core (`feed_id`, clocks, `state`, `aliases`, `chosen_provider`) but no
`feed.provenance[]` — fetch the day files (`/v1/events/…`) or NDJSON partitions for each
provider's full solution and original vocabulary.

```bash
curl -s https://earthquakes-feed.theshelter.app/v1/all_day.geojson
```

### `GET /v1/events/YYYY-MM-DD.geojson` — recent day (map time-slider)

Ready-to-render `FeatureCollection` for one UTC day: the live events **full-fat**
(complete `feed.provenance[]` incl. `fields`), plus — compact, flagged `feed.state:
"superseded"` or `"tombstoned"` — the events folded into another one or deleted in the last
48 h (see *Retired events* below). Exists for the days currently in the live
event-map window (~45 days) — a partition's `pages_url` is present in `manifest.json`
**iff** its day file is actually deployed; for any other day use the partition `url`
(NDJSON, same full-fat Features, one per line).

### Historical day partitions (full history)

One Feature per line (NDJSON), all states (`live`/`tombstoned`/`superseded`), every
line full-fat. Resolve the path and freshness from `manifest.partitions[]`:

```bash
# via branch (12 h cache):
curl -s https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/events/2026/07/04.ndjson
# immutable (cache forever) — use manifest.data_commit for a frozen day:
curl -s https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@<data_commit>/events/2026/07/04.ndjson
```

### `GET /v1/status.json`

Last run's per-provider health, counts, timings, `degraded[]`. Counts include `merged`
(`op:merge` lines), `bad_coords_dropped`, `coordinateless_dropped` (coordinate-less reports
refused at ingest), `coordinateless_withdrawn` (those among them that withdrew a known id, see
below), `coordinateless_retracted`, `late_minted` and `late_withheld` (see *Late publications*);
the heal run also carries `heal`, and the one-time correction run `correction` (see *Turkey (AFAD)*,
*California (NCEDC, SCEDC)* and *Canada (NRCan)*). `sweeps.updated` / `sweeps.deleted` hold the outcome (`ok`,
`http_status`, `latency_ms`, `events_returned`, `error`) of each source's `updatedafter` revision
query and `includedeleted` delete query in that run, with where the sweep stands: `since` (the
`updatedafter` it asked from), `pages`, `through` (its cursor after the run: the moment the last
complete sweep was sent, so a sweep that did not complete keeps the previous one and the next run
asks for the same window again), `epoch` (the catch-up epoch recorded with that cursor) and
`catch_up: true` on the one-time catch-up run. `sweeps.epoch` is the current catch-up epoch.
`comcat_twins_withdrawn` counts the AEC rows a ComCat delete withdrew in that run,
`twin_withheld` the AEC reports held back beside another source's event, and `absent.aec`
(`count`, the first 20 `ids`) the live AEC ids younger than 10 days that AEC's file no longer
lists (see *Alaska (AEC)*; logged, never retracted).

## The Feature

USGS-GeoJSON superset. Top-level `properties` is the full USGS-standard set (`mag`,
`magType`, `place`, `time` ms, `updated` ms, `status`, `net`, `tsunami`, `sig`, `nst`,
`dmin`, `rms`, `gap`, `tz`, `url`, `felt`, `cdi`, `mmi`, `alert`, `code`, `ids`,
`sources`, `types`, `title`, `type`) plus cross-source extras when present (`author`,
`magAuthor`, `catalog`, `contributor`, `country`/`province`/`district`/…). These are a
**fill-only field merge**: the chosen provider's coherent solution leads, gaps fill from
other providers, core geometry/magnitude is never mixed. A top-level **`source`** (=
`properties.net`, the chosen network) sits beside `id`/`geometry`/`properties` for
clients that key a source enum off one required field. `geometry.coordinates` is
`[lon, lat]` or `[lon, lat, depthKm]` — the depth slot is **omitted (never null)** when
unknown, so a strictly typed `[Double]`/`[number]` decoder never trips. Feed data is
under `properties.feed`:

| `feed.*` | Meaning |
|---|---|
| `feed_id` | stable id (`efd_<ULID>`), never churns |
| `event_time` / `ingest_time` | the two clocks (origin time / when we learned it) |
| `first_seen_seq` / `ingest_seq` / `revision` | knowledge-clock scalars |
| `state` / `tombstone` | `live`\|`tombstoned`\|`superseded` (filter `state==='live'` for a map; see *Retired events*) |
| `superseded_by` | on a `superseded` feature: the feed id it folded into (`op:merge`); the survivor carries this feature's `aliases[]` |
| `chosen_provider` | which provenance row won the top-level fields |
| `aliases[]` | every `provider:native_id` for this event (for realtime dedup) |
| `provenance[]` | every reporting provider with its solution + `license`/`attribution`/`doi`, and `fields` = that provider's **complete original vocabulary** (nothing dropped). Present in day files + partitions; omitted from the compact rolling summaries |

## Freshness contract

Scheduled runs are best-effort. A consumer should compute
`age = (Date.now() - metadata.generated) / 1000` and, if it exceeds
`manifest.freshness.stale_after_seconds`, mark the layer **degraded** and fall back to
its own realtime source (e.g. the EMSC WebSocket) if it has one.
The v2 manifest adds `freshness.offline_after_seconds`: if a consumer's **own last successful
fetch** (of any origin) is older than that, it is offline, not merely behind — a stronger state
than degraded, and the two are shown differently.

## Realtime + client dedup

The feed is a near-real-time *archive*, not a millisecond bus. Clients that also run
the EMSC WebSocket should reconcile: index `feed.aliases[]`, and treat a WebSocket
event as the same quake if it shares an alias or falls within **±60 s / ±10 km** — for a
large quake (both magnitudes ≥ 5.5) the spatial window is `20 + 20·(min(M) − 5.5)` km,
capped at 50 km (M5.5 → 20, M6.0 → 30, M6.5 → 40, M7.0 → 50), and only while |ΔM| ≤ 1.0; both
windows shrink with the magnitude difference. Those are the feed's own identity rules
(`src/dedup.ts`): agencies' preliminary epicentres of one M6–7 quake scatter by tens of
km, and a provider re-publishing one solution under a second id (≤ 2 s, ≤ 2 km,
|ΔM| ≤ 0.1) is the same event, not a new one. Exactly 0.1 counts, for every pair of magnitudes (since 2026-10-01;
before, floating point made 2.3 vs 2.2 count and 1.5 vs 1.4 not). When the feed folds two existing ids it
folds a pair only when each is the other's best match (distance and time, relative to the
pair's window), so a report is never welded to a neighbour while its own twin stays apart.

## Retired events

An event can leave the live set in two ways: an upstream delete (`state: "tombstoned"`,
`tombstone: true`) or a fold into another event once revised solutions converge
(`state: "superseded"`, `superseded_by: <feed_id>`, an `op:merge` line in the observation
log). Either way the event stays published in the rolling summaries and the Pages day file
for **48 h after it retired** (the fold or the delete) — **compact and non-live** — so a
poller that treats absence as "still there" sees the removal once; after that it lives only
in the day partitions (full-fat, every state). Tombstoned events joined that 48 h
republication on 2026-09-28 (until then they left those files at once). Consumers must drop
every feature whose `feed.state !== "live"` (or whose `tombstone` is true) — never plot one:
a tombstoned marker keeps its last solution, which for a retracted placeholder is 0, 0;
`metadata.count` counts live features only. The
survivor of a merge keeps the loser's `aliases[]` and provenance rows, so the loser's
provider ids resolve to it, and its `first_ingest_time` / `first_seen_seq` become the
earlier of the two. `superseded_by` names the event that was live when the line was written:
if that survivor later folds into another event in its turn, every event folded into it
follows (a new revision and its own `op:merge` line). Folds happen only in the aggregate run
(the one that writes the observation log — never in backfill or new-source onboarding) and
only for events within 7 days of their origin time (the hot window): events the feed split
before a rule change heal on their next revision if it comes within those 7 days, and stay
split otherwise. On 2026-09-28 a one-time heal ran the same pass over every live event in the
hot window once (the Loyalty Islands M7.0 of 2026-09-25 was six ids): its folds are ordinary
`op:merge` lines, and each survivor gets one `op:correction` line carrying its new revision
(`reason` lists what it absorbed); `knowledge/index/heal.json` on the `data` branch records
it. A second heal (epoch 2) runs the same pass once more when EMSC's copies of IGN, NC and SCSN
solutions start counting as the agency's own report (see *EMSC's copies of agencies'
solutions*). The agencies added to that list on 2026-10-01 and the exact-0.1 magnitude rule
(see *Realtime + client dedup*) came without a heal: they apply to reports and revisions from then on.
Historical partitions are never rewritten.

A report with no location — exactly 0° N, 0° E with magnitude 0 or none (NCEDC publishes such
placeholders, `MU 0.0`) — is never ingested. When the id is one the feed already holds, the
report is the provider's withdrawal (SCEDC and NCEDC delete an event by re-publishing its id
that way, magType `un` / `MU`): the feed withdraws that provider's row exactly like an upstream
delete — an `op:tombstone` line with `reason` "withdrawn by the provider: …", and the event is
`tombstoned` when no other provider reports it (a later located report of the id brings it
back). The ones published before that rule were retracted by the feed itself through the same
path: `state: "tombstoned"`, an `op:tombstone` line with a `reason`, off the live set of the
rolling summaries and the Pages day files (published there only as non-live tombstones for
48 h, like every retired event). That retraction covered the 45-day event map (event days
from 2026-08-14); older history is never rewritten, so the day partitions before 2026-08-14
(1,909 such features in 2026-05-01…08-13) and the monthly Release archives still carry these
placeholders as `live`. A consumer of that history should drop every feature at exactly 0, 0
with magnitude 0 or none.

## Late publications

A source can publish an event days after its origin: ComCat (the `usgs` source) releases many
events only after analyst review, for example in Alaska, Texas, Oklahoma and the Pacific
Northwest (184 of 693 M ≥ 2.5 events with origins 2026-09-10…20 never reached the feed before
this rule; a sample of 21 of them had been published 2.1–16.8 days after origin). Each run asks
the sources for recent origins (the FDSN ones for the last 48 h, NRCan for 7 days), plus ComCat and EMSC for every
event updated since its last complete sweep. A ComCat event the feed has never seen enters
the feed from that second query when its origin is within the last **7 days** (the window in
which the feed matches reports by time and place). It is a new event of that run:
`feed.first_ingest_time` (and its `op:observe` line's `ingest_time`) is days after
`feed.event_time`; it lands in the day partition and day file of its **origin** day, and in a
rolling summary only while its origin is inside that summary's window. Its log line carries a
`reason` ("first seen in the provider's updatedafter sweep, … d after origin"), and
`status.json` counts the run's additions as `late_minted`. A late event whose origin is older
than 7 days is not added. A late ComCat report within ±60 s, 50 km and one magnitude unit of
another source's live event is withheld (`late_withheld`) rather than added as a second event:
it is most likely that quake, which the feed already shows. A consumer that alerts on new events
must gate on `properties.time`, not on arrival; the feed never presents a late event as a recent
one. Because a late event (like a revision or an upstream delete) can still change a day up to
10 days old, `manifest.partitions[].frozen` turns true only after that (it was 3 days until
2026-09-30).

## History and backfill

The feed's history has two parts, and what "the earliest observation of a source" can mean differs between them.

**Observed live, since 2026-07-05.** Every report that changed the feed is a line of the observation log
(`knowledge/observations/ingest=YYYY/MM/DD/HH.ndjson` on the `data` branch; an ingest month older than 120 days moves
to the Release `archive-YYYY-MM` as `observations-YYYY-MM.tar.zst`). The log is append-only, and a report's first
line is the version of it the feed saw first: `ingest_time` (when the feed first held it, a few minutes after the
source published it at best: runs are about 5 minutes apart and GitHub delays some), `provider_updated` (the source's
own time of that version, given by `usgs`, `emsc`, `imo`, `ipma`, `jma` and `igp`, and by `afad` for an event it has
revised (`lastUpdateDate`, 28 of 9,071 logged AFAD reports by 2026-10-01); no source's list gives a creation time)
and the solution itself. `scripts/first-observations.ts` prints that for an event, named by its feed id or by any
`provider:native_id`, with superseded ids followed to their survivor. A source that revises within minutes
(EMSC often does) may have had a version the feed never saw. Reports the feed held back have no line until they join
an event (`twin_withheld` AEC reports, `late_withheld` ComCat reports), and a later revision of a row that represents
nothing and moves nothing can update the event without a line; neither changes which line is first.

**Filled by backfill.** History before that, and the history of a source added later, comes from `backfill`: one
window per source and run (hourly), walking each source that has a time-range query backwards into the day
partitions and the monthly Release archives. Backfill writes no log lines. A backfilled row is the source's solution
on the day the backfill fetched it (2026-07-05…07-25 for most of history), with the source's update time of that
version where the source gives one: neither the source's first solution nor necessarily its last (ComCat's
`us7000st0n` of 2026-06-15 is held at mb 4.5 from ComCat's version of 07:30 UTC that day; ComCat revised it to 4.4 on
2026-07-06 and 2026-08-31). A backfilled event's `feed.first_ingest_time` is the backfill run's time and its
`first_seen_seq` the log position then.

Where the walk stands (`knowledge/index/backfill.json`, 2026-10-01):

| Sources | Earliest day | Note |
|---|---|---|
| `usgs`, `emsc`, `geofon`, `ingv`, `geonet`, `resif`, `noa`, `ethz`, `nrcan`, `ncedc`, `scedc`, `knmi`, `auspass`, `renass`, `ipgp`, `usp`, `lmu`, `afad`, `kagsr`, `imo`, `csn` | 2023-07-06 | the 3-year target, reached 2026-07-06…07-25; the walk goes no further |
| `igp` | 2024-08 in practice | walked to 2023-07-06, but IGP's yearly files give UTC times only from 2024-08-15 on and the adapter skips a row without one: the 928 IGP reports of 2023-07-06…2024-08-15 are missing (889 of those quakes are in the feed through another source) |
| `isc` | 2025-08-03 | paused (below); ISC rows also fill 2024-05 and 2025-02 (one-off fills) |
| `aec`, `cenc`, `ncs`, `tmd`, `bmkg`, `jma`, `mexico`, `ipma`, `egypt`, `bgs`, `ign`, `inpres`, `ga`, `ovsicori`, `igepn`, `cwa`, `geosphere`, `koeri`, `phivolcs` | the source's first live run (whatever its list then held of the last 7 days) | forward-only: no time-range query |

A source's walk reports its failures: a window that fails is halved for the next run (a window whose answer is too
large to stream within the timeout fails as a timeout, never as an overflow), each failure is logged with its error,
the cursor keeps `lastError` and `failingSince`, a streak of 24 runs adds a warning to every run, and from 72 runs at a
one-day window the run turns red about once a day. Before 2026-10-01 a failing walk stayed silent and kept its
window: ISC's 21-day window (more than 5,000 rows, about 35 s against ISC's 30 s timeout) failed 1,861 runs in a row,
all green, from July to 2026-10-01. ISC's walk is paused since (`backfill.enabled: false` in the registry): every
day it has left before the target lies in a frozen month already rolled to a Release, and finishing it means pulling
those 26 monthly archives back (2023-07…2025-08, about 760 days), adding about a fifth more events to them (ISC's own small events: a local test of the window
2025-07-29…08-02 added 1,695 events to its 8,869 and an ISC row to 1,249 others) and re-rolling every archive. That is
a deliberate one-off, like a heal, not an automatic step.

## Deep history (before 2023-07-06)

History older than the 3-year layer above is built by a separate walk, `history` (`.github/workflows/history.yml`,
`src/history*.ts`), that never commits a day partition, never touches an `archive-YYYY-MM` Release and never rewrites a
frozen day. It runs only while `providers/history.json` says `"enabled": true`; the first era configured is a pilot:
ComCat (`usgs`), every magnitude, 2022-07-01 up to the boundary 2023-07-06 (the 3-year layer's first day, which must
equal `knowledge/index/backfill.json` `targetStart`).

**Where it lives.** Everything is an immutable asset of a Release `history-YYYY` (the year of the month):

| Asset | What it is |
|---|---|
| `raw-<source>-<YYYY-MM>.ndjson.zst` | one source's answer for one month, normalised by the feed's parser: a header line (`kind: "earthquakes-feed/history-raw"`: the range, the queries' windows, the rows each answered, the source's own count where it has a count service (ComCat), `fetched_at`), then one report per line |
| `events-<YYYY-MM>.e<N>.tar.zst` | the month's events: `DD.ndjson` day files in the day partitions' feature format (the same as `archive-YYYY-MM`), plus `_edition.json` (sources, the raw assets it was built from with their checksums, row counts, `joined_newer`) |

An asset is never overwritten or deleted. A failed upload leaves its name behind as `unused` and the walk takes the next
free name (`raw-usgs-2022-12.g2.ndjson.zst`); when a source joins an era, each month gets a new edition (`e2`) built
from all its raw assets, newest month first, and the older edition stays. The index of all of it is the only file the
walk adds to the `data` branch: `knowledge/index/history.json` (read it through jsDelivr,
`https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/knowledge/index/history.json`). It lists each raw asset
(`url`, `sha256`, `bytes`, `rows`, `provider_count`, `fetched_at`) and each edition (`url`, `sha256`, `events`, `days`,
`sources`, `built_from`); a month's current edition is its highest `edition`. Each `_edition.json` names its newer
neighbour (`context`: the asset and day it read, with that asset's `sha256` as its index listed it), so a later re-roll of
`archive-2023-07` stays visible against the edition built on the earlier copy. A month is a calendar month: an era
starts on the first day of a month and ends on the first day of a month or at the boundary. The manifest does not list the deep
history (yet), and the app does not read it.

**How a month is built.** Offline, from the month's raw assets only, by the backfill's own identity resolution (one
`Resolver`, hot floor 0, merge pass off) in the deterministic ingest order: the same raw assets always give the same
events with the same feed ids (ids are seeded by time and place). The month's newer neighbour is frozen first (the walk
goes backwards): the 3-year layer's first day for the month before the boundary, else the first day of the newer month's
current edition. Its events are loaded read-only, so a quake whose reports straddle midnight stays one event: a report
of this month that joins one of them is not written (that day is immutable) and is listed in `_edition.json`
`joined_newer` with the event's feed id. Before an edition is uploaded every line is checked against
`schema/feature.schema.json`, every event lies on its file's day inside the month and before the boundary, no feed id
and no source id is in two events, and every fetched report is written, joined to the neighbour or under the era's
magnitude floor; `scripts/history-verify.ts` runs the same checks on downloaded assets and can re-ask ComCat for its
counts.

**What a deep event says.** A row is the source's solution on the day the walk fetched it (`fetched_at`), as for
backfilled rows. `feed.first_ingest_time` / `ingest_time` are that fetch time, and `first_seen_seq` / `ingest_seq` are
0: the event never passed through the observation log. There is no `pages_url` and no Pages day file.

**Pace.** One request at a time per host, at least `requestSpacingMs` (1.1 s) apart, HTTP 429 / 5xx answered with
Retry-After or a doubling pause from 5 s (at most 2 min; a source that asks for a longer pause is left alone until the
time it named, `attempts[].not_before` in the index), a window that fills the page or times out split in two, a
month that cannot be fetched whole fetched again next run (a source that fails a day of runs turns the run red). ComCat
is asked for its count first and every window's rows must equal the count. At most `maxUnitsPerRun` source months and
`maxSecondsPerRun` per hourly run; the collect job runs outside the writer lock and only the index commit takes it.

## EMSC's copies of agencies' solutions

EMSC republishes many agencies' own solutions; `fields.auth` of the `emsc` provenance row names the
authoring agency. Where the feed also reads that agency, an EMSC row with one of the `auth` codes below
and the same solution as the agency's row (within 2 s, 2 km and 0.1 magnitude units) counts as the
agency's report:

| `auth` | the agency's row | counts since |
|---|---|---|
| `AFAD` | `afad` | 2026-10-01 (see *Turkey (AFAD)*) |
| `IGN` | `ign` | 2026-09-30 |
| `NC` | `ncedc`, or ComCat's `nc…` row | 2026-09-30 |
| `SCSN` | `scedc`, or ComCat's `ci…` row | 2026-09-30 |
| `CENC` | `cenc` | 2026-10-01 |
| `CSN` | `csn` | 2026-10-01 |
| `GNS` | `geonet` | 2026-10-01 |
| `INGV` | `ingv` | 2026-10-01 |
| `KOERI` | `koeri` | 2026-10-01 |
| `NDI` | `ncs` | 2026-10-01 |
| `QUI` | `igepn` | 2026-10-01 |
| `UNA` | `ovsicori` | 2026-10-01 |
| `UNM` | `mexico` | 2026-10-01 |

A code is on the list only where EMSC's copy is the agency's solution up to rounding: at least 90 %
of the copies equal in time and place a version of the agency's solution the feed saw (or, for
GeoNet, one in GeoNet's own origin history), at least 85 % in magnitude too, and no copy is the
same solution of two different agency events. EMSC rounds (four decimals, two for CSN; 0.1 in
magnitude and depth) and relabels some magnitude types (IGN's `mbLg` and GeoNet's `MLv` as `ml`);
IGN's, KOERI's, GeoNet's and IG-EPN's own lists cut the time to the second, IGN's the depth to whole
km. A copy often carries an earlier version of the agency's solution (EMSC copies GeoNet's origin
of the moment and seldom follows a revision; it follows CSN's), and EMSC replaces many copies with
its own solution later (most of KOERI's and AFAD's): such a copy counts only while it is within
those limits of the agency's row. Where KOERI gives both ML and Mw the feed's row carries the Mw
while EMSC copies the ML, so those copies do not count. Not on the list: BMKG (its public lists
carry another solution), PHIVOLCS and JMA (their lists give the origin to the minute), GFZ,
ReNaSS, ETHZ, NOA, IMO (too many copies differ from every version the feed saw), GSRAS (not
KAGSR's solution), CN (the feed's NRCan rows carry no magnitude), the agencies with fewer than 50
copies (IPMA, IGP, GA, CWA, IPGP's observatories, BGS, USP, KNMI, AEC), and the US networks EMSC
names (NEIC, PR, HV, TX, …), which reach the feed only through ComCat.

This matters where many small quakes fall into one cell (the Granada basin, The Geysers, Sındırgı,
the Milford Sound and Puntarenas swarms): there the feed joins two reports only on a shared id,
and before a code was on the list its EMSC copy stood beside the agency's event (27 IGN, 3 NC and
1 SCSN pairs in the 11 days to 2026-09-30; in September 2026 13 GeoNet, 44 OVSICORI and 1 KOERI
pairs, identical in time and place). The heal of epoch 2 (see *Retired events*) folded the IGN,
NC and SCSN pairs inside the 7-day hot window once; the codes added on 2026-10-01 apply from
then on, without a heal, and older days keep both events (the day partitions 2026-06-01…09-19 hold 276 IGN, 97 NC and
36 SCSN copies as live events of their own, and the September GeoNet and OVSICORI pairs stay
too; drop a live feature whose only row is `emsc` with one of these `auth` codes when another live
feature holds the agency's row within those limits). A copy of a solution the agency has revised
since stays a separate event in such a cell. An EMSC event id sometimes moves to another agency
event (EMSC's `20260910_0000383` copied OVSICORI 1449691, then 1449690, 41 s later): the row
stays in the event it joined, and the two agency events stay apart.

## Alaska (AEC)

The `aec` source reads the file behind the Alaska Earthquake Center's public map: about 14 days
of Alaska and Aleutian events, rewritten every ~43 s. Its automatic SeisComP solutions arrive
within minutes and are published with `status: "automatic"`; the analyst's solution replaces
one later as `"reviewed"` (hours to days after origin). The feed reads AEC's rows only while the
origin is inside the 7-day live window, and AEC reviews many events only later (on 2026-09-30,
94 % of the file's rows 3 to 7 days old were still automatic), so a later review reaches the feed
only through ComCat's row of the same id, which the ComCat sweep still attaches up to about 10
days after origin; an AEC-only event that ComCat has not published by then stays `automatic`. Many Alaska events reach ComCat only
after that review, so before this source 40 % of AEC's M ≥ 2.5 events never reached the feed.
An automatic solution nobody has confirmed can be a false event: a consumer that alerts should
not act on a feature whose only provenance row is an `aec` row with status `automatic`.
AEC's `event_name` is the event's ComCat id (`aka2026…`), so the feed joins it to the `usgs` row
of the same id exactly, whatever the distance between the two solutions: the AEC row carries the
alias `usgs:<id>` and a ComCat event that lists the id in its `ids` (under another preferred id,
such as `us7000…`) is the same event. The reviewed ComCat solution leads when both exist. An AEC
report that matches no event by id or by the usual time-and-place rules is not added when another
source's live event lies within ±60 s, 50 km and one magnitude unit and holds no AEC row
(`twin_withheld`): AEC lists every Alaska quake once, so that is most likely the same quake
located differently (an automatic AEC solution 15 km from the Alaska Volcano Observatory's);
it is looked at again every run and joins by id as soon as ComCat publishes it. An AEC solution joins
another source's event by time and place only when the two origins are within 8 s and one and a half
magnitude units (every same-quake join seen was within 3.4 s; the Alaska Volcano Observatory quakes
ComCat keeps apart from AEC's are 13 s or more apart): before 2026-10-01 an automatic AEC M4.5 20 s
from a reviewed M1.5 could be shown as the M1.5, and two quakes ComCat publishes as two could be shown
as one. A ComCat event that finds an event only through its AEC row, while that event's ComCat row is
another quake by ComCat's own ids, stays a separate event. A
ComCat delete of the id withdraws the AEC row too (an `op:tombstone` line with a `reason`), and
the event is `tombstoned` when no other source reports it; AEC's file listing the id afterwards
does not bring it back. The file has no update time and no delete marker. The source is
forward-only: no backfill before its first run beyond the 7-day window that run ingested.

## California (NCEDC, SCEDC)

The `ncedc` and `scedc` sources read the Northern and Southern California networks' own catalogues.
Their event ids are the ids ComCat gives the same events with the network's prefix (NCEDC
`75438707` is ComCat `nc75438707`, SCEDC `41341119` is `ci41341119`), so since 2026-10-01 the feed
joins such a row to ComCat's row of that id exactly, in either arrival order and also when ComCat
prefers another id and lists the network's id in `ids`. Before that nothing linked the two ids, and
where many small quakes fall into one cell (The Geysers) the feed joins two reports only on a shared
id, so the regional row and ComCat's row of the same event were published as two events (286 NCEDC
and 18 SCEDC ones in the 10 days to 2026-10-01, identical in time and place). The one-time correction
of 2026-10-01 (see *Turkey (AFAD)*) folded the ones in the days not yet frozen into ComCat's event:
`op:merge` lines with an `exact id` reason and an `op:correction` line for each survivor. Frozen days
keep both events: the day partitions 2026-06-01…09-19 hold 3,899 NCEDC and 997 SCEDC events beside
ComCat's event of the same id (drop a live `ncedc` / `scedc`-only feature whose `nc` / `ci` id another
live feature lists in `feed.aliases` as `usgs:<id>`); the monthly Release archives before June were
built by the same rules and were not re-checked. NCEDC and SCEDC withdraw an event themselves by re-publishing its id without a
location (see *Retired events*); a ComCat delete of the id does not withdraw their row.

## Turkey (AFAD)

AFAD's event service writes its times in UTC without a zone suffix (`"date": "2026-09-30T19:19:18"`).
Until 2026-10-01 the `afad` adapter read them as Turkish local time (UTC+3), so **every AFAD event
from the source's first day to that date was stored 3 h early**, and EMSC's copy of the same quake
(EMSC republishes AFAD's solution with `auth: "AFAD"`) stood beside it as a second event, 3 h later.
The adapter reads them as UTC since then. A one-time correction (`knowledge/index/correction.json` on
the `data` branch, epoch 1) re-read every AFAD row of the days the manifest did not yet call frozen
(the last 10 event days) from the row's own stored `fields.date` and moved it to its real time: an
`op:observe` line with a `reason` ("correction epoch 1: re-read with the fixed AFAD parser …"), after
the `op:merge` lines of the folds it caused (an AFAD event and EMSC's copy of it, or another source's
report of the same quake, become one event; the AFAD event can move to the next UTC day). An AFAD row
that had joined another source's event at its wrong time left that event (an `op:tombstone` line with
a `reason`) and was placed anew. In a dense cell, where two reports join only on a shared id, EMSC's
copy of an AFAD solution (`auth: "AFAD"`, the same second, place and magnitude) counts as one.

History is never rewritten: every AFAD row of an event day before the correction's `from_day`
(2026-09-20, recorded in `knowledge/index/correction.json`) keeps its 3 h early time, in the frozen
day partitions and the monthly Release archives alike: every AFAD row from 2023-07-06 (the start of
its backfill) to 2026-09-19. The day partitions 2026-06-01…09-19 alone hold 9,621 live AFAD rows
(9,601 events AFAD alone reports, about 3,300 of which have EMSC's AFAD-authored copy as a separate
live event 3 h later) and 20 AFAD rows sitting in another source's event. A consumer of
that history can shift a feature's time by +3 h when its chosen provider is `afad` and its
`feed.event_time` is exactly 3 h before the chosen provenance row's `fields.date` read as UTC, and
drop EMSC's `auth: "AFAD"` copy of it.

## Canada (NRCan)

Earthquakes Canada's FDSN text answer has eight columns
(`EventID|Time|Latitude|Longitude|Depth/km|MagType|Magnitude|EventLocationName`) where most services send the
standard thirteen or fourteen. Until 2026-10-01 the feed read every FDSN text column at its standard position, so
**every `nrcan` row from the source's first day to that date has `mag`, `magType` and `place` null**, although its
`fields` hold `Magnitude`, `MagType` and `EventLocationName` (an event NRCan alone reports was published without a
magnitude or a place). The feed finds the columns by their header name since then, and `place` is the English half of
NRCan's bilingual name ("16 km SSE of Duncan, BC" of "16 km SSE of Duncan, BC/16 km SSE de Duncan, BC"; the original
stays in `fields.EventLocationName`). Every other FDSN text source has these columns at the standard positions, so
nothing changed for them.

A one-time correction (`knowledge/index/correction.json`, epoch 2) re-read every `nrcan` row of the days the manifest
did not yet call frozen (the last 10 event days) from the row's own stored `fields` and filled it where it is: an
`op:observe` line with a `reason` ("correction epoch 2: re-read with the fixed FDSN text parser …") and a new revision
for each, also where another source represents the event (the row is in `feed.provenance`). Nothing moved: the time,
epicentre and depth it re-read are the ones stored before.

NRCan publishes a revised solution under the next id of the same origin minute (`20260720.0647001`, Mw' 4.84, then
`20260720.0647002`, Mw' 4.73) and lists only the newest. Two `nrcan` rows within 2 s and 2 km are one quake whatever
their magnitudes, as they were while the feed stored no NRCan magnitude, and when NRCan represents that event the
higher id (the newer version) is the chosen row.

Since the correction, an event NRCan alone reports carries NRCan's magnitude, so it reaches the magnitude summaries
(`1.0_*`, `2.5_*`, `4.5_*`) and every magnitude filter, where it was left out before. NRCan's place sometimes names a
non-earthquake source ("Blast, …", "Mining event, …", "Suspected industry-related event, …"); its answer has no event
type column, so such rows carry `type: "earthquake"` like the rest (in the 45 days to 2026-10-01: 25 blasts, suspected
blasts and mining events, all below M3; 24 industry-related events, induced earthquakes).

NRCan publishes many events days after their origin (its analysts release them in batches), and until 2026-10-01 the
feed asked it for the last 2 days only, like every FDSN source: of the 435 events NRCan listed for the 44 days to
2026-10-01, 132 (41 of M ≥ 2.5, the largest M3.7) never reached the feed through any source, and 12 of the 57 of the
last 8 days, every one of which NRCan listed at most 5.3 days after its origin. Since then the feed asks NRCan for the
last 7 days (the window in which the feed matches reports by time and place, so a late report joins its event as any
report does): such an event enters the feed in the run after NRCan lists it, in the day partition and day file of its
origin day, with `feed.first_ingest_time` days after `feed.event_time`. In a dry run on 2026-10-01 the first run with
the 7-day window added 13 events (those 12, and an M2.4 whose nearest event is an automatic AEC solution 69 km away),
joined one NRCan report to the AEC event of the same quake (1.9 km apart) and changed nothing else; a second run over
the same answer changed nothing. An event NRCan lists more than 7 days after origin is still missed, and the ones
missed before 2026-10-01 (event days up to 2026-09-24) stay missing: older days are not rewritten.

History is never rewritten: the `nrcan` rows of an event day before the correction's `from_day` keep `mag`, `magType`
and `place` null, in the frozen day partitions and the monthly Release archives alike. A consumer of that history can
read them from the provenance row's `fields` (`Magnitude`, `MagType`, `EventLocationName`), and a feature whose chosen
provider is `nrcan` has its magnitude in the chosen row's `fields.Magnitude`.

## Recipes

```js
// Current week, one CORS-open fetch:
const fc = await (await fetch('https://earthquakes-feed.theshelter.app/v1/all_week.geojson')).json();
const stale = (Date.now() - fc.metadata.generated) / 1000 > 1800;

// Time-slider: fetch a specific recent day
const day = await (await fetch(`https://earthquakes-feed.theshelter.app/v1/events/${isoDate}.geojson`)).json();

// A frozen day immutably:
const m = await (await fetch('https://earthquakes-feed.theshelter.app/v1/manifest.json')).json();
const p = m.partitions.find(x => x.date === '2025-03-14');
const url = p.frozen
  ? `https://cdn.jsdelivr.net/gh/${m.data_repo}@${m.data_commit}/${p.path}`
  : p.url;

// Before 2023-07-06 (the deep history; APIs.md, Deep history): a month's current edition
const h = await (await fetch('https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/knowledge/index/history.json')).json();
const ed = h.editions.filter(e => e.period === '2022-12').sort((a, b) => b.edition - a.edition)[0];
// ed.url: events-2022-12.e<N>.tar.zst, a zstd tar of DD.ndjson day files; check it against ed.sha256
```

## Versioning

Everything is under `/v1/`. Fields are additive within a major version (new optional
fields never break old parsers). A breaking change ships as `/v2/` with `/v1/` kept
for a deprecation window.

## Licensing

Data is [CDLA-Permissive-2.0](LICENSE); each record carries its source's license in
`provenance[].license`. Keep the `metadata.attribution` string when redistributing.
See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) and [TAKEDOWN.md](TAKEDOWN.md).
