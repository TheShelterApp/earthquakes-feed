# earthquakes-feed — API reference

A static-file API over a CDN. No server, no keys, no rate limits, full CORS
(`Access-Control-Allow-Origin: *`). Everything is GeoJSON or NDJSON.

**Golden rule:** fetch `manifest.json` first and resolve every other path from it.
Don't hardcode partition/summary paths or `@sha` URLs — they can move (freezing,
archival, redaction).

## Surfaces

| Surface | Base | Use | Cache |
|---|---|---|---|
| Cloudflare Pages | `https://earthquakes-feed.theshelter.app/v1/` | live feed, recent day files, manifest, live index, per-hour detail | summaries + manifest + live index and deltas `max-age=30` + SWR; day files `max-age=300` (today, yesterday) / `3600` (older); live index day files `max-age=0, must-revalidate`; detail hours `max-age=300` |
| jsDelivr (branch) | `https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/` | full-history partitions | ~12 h |
| jsDelivr (`@sha`) | `…@<data_commit>/` | immutable frozen partitions | 1 year, immutable |
| GitHub Releases | `archive-YYYY-MM` assets | very old months (bulk) | immutable, no CORS |
| GitHub Releases | `remediation-YYYY` assets | complete editions of days a source's backfill could not fetch whole (*Saturated days*) | immutable, no CORS |
| GitHub Releases | `first-solutions-YYYY-MM` assets | each source's kept versions per report (*Earliest solutions*) | immutable, no CORS |
| GitHub Releases | `logs-YYYY-MM` assets | finished months of the run logs: status history and daily change logs (*Run logs*) | immutable, no CORS |

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
| `live` | the live index: `{path, url, head_seq, window_days}` (see *Live index* below; since 2026-10) |
| `event_detail` | the per-hour detail files: `{path_template, url_template, first_hour, last_hour}` (see *Event detail* below; since 2026-10) |

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

### `GET /v1/live/index.json` — live index (incremental refresh of the week)

The content of `all_week.geojson` in a form a client can keep up to date without downloading the whole week again
(PRB-2, 2026-10). `all_week` is one ~7.4 MB file (~870 KB brotli) whose bytes change on every 5-minute run, if only
because `metadata.generated` does. The index lists:

- `days[]`: `{date, path, url, count, bytes, sha256}` for each UTC day of the window — today and the 7 days before it
  (`window_days`), and tomorrow while an event within the 10-minute future leeway sits past midnight. Each
  `/v1/live/days/YYYY-MM-DD.geojson` is a compact `FeatureCollection` with exactly the features `all_week` carries for
  that day (live events, plus the events retired in the last 48 h flagged non-live, see *Retired events*), for the
  whole day and without a magnitude floor. It holds no run clock (`metadata.generated` is the newest `ingest_time`
  among its features), so its bytes, and its `sha256`, change only when its events do. `count` counts live events.
- `deltas[]`: `{name, window_seconds, path, url, from_seq, head_seq, count, bytes, sha256}` for `15m`, `1h`, `6h` and
  `24h`. `/v1/live/delta-<name>.geojson` holds the same compact features of **every** window event whose
  `feed.ingest_seq` is above `from_seq`: everything that changed — a new event, a revision, a fold, a withdrawal —
  since about `window_seconds` ago. `count` counts every feature, retired markers included.
- `head_seq`: the knowledge clock all of them reflect (the same in every delta).
- `features_format`: the serialization of the compact features (1 since 2026-10; 2 with `review_status`, see *Review
  status*). It changes when the feed changes what
  a compact feature holds (a new field, another format of one); such a change moves no seq, so no delta carries it to
  the events you already hold: when it differs from the one you hold the window in, drop your cursor and fingerprints
  and re-read every day (step 3).

How to use it: keep the features of the days you fetched and the `head_seq` you got them at (your cursor).

1. Fetch the index (about 4 KB, 1 KB compressed). If its `generated` is the one you hold, you are current.
2. If you have a cursor and some delta has `from_seq <= cursor`, fetch the smallest such delta, check that it hashes to
   the index's `sha256` (a deploy between the two requests serves another run's delta, which may start after your
   cursor: go to step 3 instead), upsert **all** its features by `id` (a silent change, below, keeps its older
   `ingest_seq`, at or below `from_seq`), drop the ones whose `feed.state` is not `live` (as from `all_week`), and set
   the cursor to the delta's `head_seq`. That is exactly the window as of the index's `head_seq`. Do this for every new
   `generated`, even when `head_seq` did not move: a run can change an event without a new seq (below), and its delta
   carries it.
3. Otherwise (no cursor, or more than a day behind) compare each day's `sha256` with the copy you hold, fetch only the
   days that differ, replace those days' features with the file's, drop days that left the window, and set the cursor
   to the index's `head_seq`. If a day file you fetched does not hash to the index's `sha256` (a deploy landed between
   the two requests), keep it but do not take the cursor: the next refresh compares again.
4. Filter by your own time window (`time >= now − 7 days`, as `all_week` does): whole days reach a little further back.

Why a delta is exact: `from_seq` for a window W is the largest `ingest_seq` among the events last changed at least W
ago; sequence numbers grow with ingest time, so everything changed later is above it, and the delta is by definition
every window event above it. One kind of change moves no seq: a revision of a provider row that does not represent its
event can still change the event's compact feature through the fill-only fields (`updated`, `author`, `magAuthor`,
`tsunami`, ...). derive compares each window event's line with the one the previous run committed and keeps such an
event for a day in `knowledge/index/live_silent.json` with the previous run's head (`head_before`); every delta whose
`from_seq` is at most `head_before` carries it. Events that leave the window and retired markers that stop being
published after 48 h are not changes: the first is your time filter, the second repeats a removal you already applied.
Replayed over the 566 real derive commits of 2026-10-04 03:04 → 10-06 02:57 UTC (246 such changes detected), a client
polling every 15 minutes, every hour or every 8 hours held exactly the day files of each run it polled, moving after its
first sync about 5 KB per 15-minute poll, 14 KB per hourly poll and 171 KB per 8-hour poll (brotli 4) against ~846 KB
for the week summary. Without the silent log, 20 events of 11.5 hours kept an older `author` or `updated`.

Measured over the derive commits of 2026-10-04..06 (brotli level 4; what Pages serves is about 6 % larger): the week
summary 846 KB per changed poll; the day files 205 KB per 5-minute run (on average 1.8 of the 8 days change per run:
today in 96.5 % of runs, yesterday 41 %, older days 2–19 % each), 530 KB after an hour away, 786 KB after 8 h; the
deltas 4.0 KB (15 min), 11.1 KB (1 h), 54.7 KB (6 h), 173.8 KB (24 h). So a client that polls every few minutes moves
the index and a 15-minute delta (~5 KB) instead of the week (~870 KB), one back after a night moves the 24-hour delta,
and one away for longer moves the changed days. `all_week` and the other summaries stay as they are. Schema:
`schema/live-index.schema.json`.

### `GET /v1/detail/YYYY-MM-DDTHH.geojson` — event detail (one UTC hour)

A `FeatureCollection` of the **live** events whose origin falls in one UTC hour, full-fat like the day files (every
provider's solution in `feed.provenance[]`; EVT-5, 2026-10). An app that opens one event reads its hour (~95 KB,
~11 KB brotli on average; the largest hour on 2026-10-06 was 296 KB) instead of its day file (~2.3 MB, ~270 KB brotli).
Build the URL by putting the hour key into `manifest.event_detail.url_template`; every hour from `first_hour` to
`last_hour` (the days of the Pages day files, through the current hour) has a file, empty or not, so a missing hour
outside that range means "use the day files". Look for the event by `id`, then by `feed.aliases[]`; when it is not
there (a revision moved its origin time across the hour), read the neighbouring hours. Agencies' solutions of one
quake lie within 60 s of each other: within 60 s of the hour's edge, the neighbouring hour may hold one. Retired
events are not in these files (the day files keep their 48-hour markers). The bytes hold no run clock
(`metadata.generated` is the newest `ingest_time` among the features, or the hour's start), so an hour's file changes
only when its events do and a deploy uploads only the hours that changed.

Why hours: on 2026-10-06 the 46 published days held about 54k live events; a file per event would be 54k files, past
Cloudflare Pages' 20,000 files per site on the free plan (developers.cloudflare.com/pages/platform/limits, read
2026-10-06); hours are 1,104 files (the deploy goes from 69 to about 1,170 files and from 145 to 258 MB, derive from
2.5 to 3.1 s). A feed id → byte range index into the day files would need no new files, but Pages serves the day
files compressed, and a range of a compressed body is not a range of the JSON.

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

Last run's per-provider health, counts, timings, `degraded[]` (a provider's `via` names the host that answered when it was the
source's fallback host, see *Greece (NOA)*). Counts include `merged`
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
lists (see *Alaska (AEC)*; logged, never retracted). `absent.mexico` does the same for SSN's RSS, which lists only its
last 15 items: only ids younger than the oldest item it still lists are counted. `preliminary_superseded` and
`preliminary_skipped` count SSN preliminary solutions withdrawn or not ingested (see *Mexico (SSN)*).

**Frozen sources (round 14).** A source whose file is still served but no longer regenerated keeps answering `ok` with
rows, so it is never silent. Each run records the newest origin every answer lists (`providers.<id>.newest_origin` in
`status.json`; not in the status history line, see *Run logs*);
a source whose answer has rows but whose newest origin is older than its query window (2 days, or `lookbackDays`) plus
its frozen budget is **frozen**: listed in `frozen` (by id: `newest_origin`, `newest_origin_age_hours`, `window_hours`,
`budget_hours`, `rows`) and counted in `degraded`. The frozen budget is three activity budgets (36 h for an active agency,
so 84 h in all), `frozenBudgetHours` for a source that lists its last N events and legitimately stands still for days
(216 h: BGS, IG-EPN, CWA; their longest quiet spells 2026-07-05 → 10-06 were 180, 168 and 157 h, the longest among the
other sources without a time window CENC's 59.6 h). An answer limited to a time window can never be frozen. The v2
status adds `providers.<id>.frozen` and `frozenProviders`; the health workflow lists frozen sources in the silent
providers issue (`frozen:<id>` in its set line). Pinned sources (FEED-SEC-1) also carry `providers.<id>.tls_leaf` and
`tls_leaves` (of the leaves the host presented in the last week, the first to expire: `not_after`, `days_left`, `issuer`,
`subject`, `seen_at`, `leaves` when more than one; providers/tls/README.md).

**Failing and silent sources.** A provider whose fetch failed has `ok: false` and is in `degraded`. An FDSN answer of
HTTP 204 is an empty success; HTTP 404 is an empty success only for a source whose query asks `nodata=404` (none does
today) and an error otherwise, because it means the query path is gone (before 2026-10-04 every 404 counted as empty).
A source can also answer `ok` with no rows while it has stopped publishing: since 2026-10-04 each run records per
source the last run whose answer had rows (`knowledge/index/provider_activity.json`, seeded once from the status
history), and a source with no rows for longer than its activity budget is **silent**: listed in `silent` (by id:
`last_non_empty_at`, null when none was seen since `counted_from`; `silent_hours`; `budget_hours`) and counted in
`degraded`, while its `providers.<id>.ok` stays true. The budget is 12 h for an active agency (its 2-day query window
is never empty that long), `activityBudgetHours` in `providers/registry.json` for a quiet one (72 h: ETHZ, IPMA, NRCan,
USP) and none for KNMI and LMU (regions that go weeks without an event) or a source the live path does not ask (ISC).
The published v2 status adds `providers.<id>.silent`, `providers.<id>.lastNonEmptyAt` (ms) and `silentProviders`.
On 2026-10-04 three sources were silent the moment this went live: ENSN Egypt (no rows since 2026-07-29), Geoscience
Australia (since 07-30) and TMD (since 08-18). None had stopped publishing: ENSN moved to a new site whose old JSON URL
lists only stations (the feed now reads its RSS, `/en/events/feed.rss`), GA rewrote its RSS descriptions so no item
parsed (both read since round 14, issue #59), and TMD's rows had lost their ids (named by origin second since round 13).

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
unknown, so a strictly typed `[Double]`/`[number]` decoder never trips. **`review_status`**
(`"automatic"` | `"reviewed"`, absent when the source does not say) tells whether the event's solution is its source's
automatic one or one a seismologist reviewed — the same on each `provenance[]` row for that row (see *Review status*;
on the rolling summaries, the live index and the detail hours since 2026-10; the day files and partitions keep their
bytes). Feed data is under `properties.feed`:

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

**What "stable" means for `feed_id`.** Once minted, an event's id never changes; a fold retires
the loser (`superseded_by`) and its provider ids resolve to the survivor. Which id an event gets is
fixed by its first report: the id is seeded by that report's 30 s time bucket and 0.02° place
bucket, so if another agency's report of the quake reaches the feed first, the quake gets another
id. Replaying the observation log in another arrival order measures this (FEED-DQ-2, 2026-10-06; two
3-day slices, 2026-09-20…22 and 09-30…10-02, 6,432 and 8,137 lines, 3,906 and 4,894 live events in
the logged order; each provider id's own lines kept in order):

| arrival order | events grouped as logged | M ≥ 4.5 events grouped as logged | same `feed_id`, events with ≥ 2 providers | same `feed_id`, M ≥ 4.5 |
|---|---|---|---|---|
| each provider id 0–2 runs (0–10 min) late, then the feed's own order within a run | 99.73–99.90 % | 120–122 of 123, 85 of 85 | 94.7–96.6 % | 87–94 % |
| any order (adversarial) | 98.98–99.37 % | 114–117 of 123, 77–80 of 85 | 83.2–87.2 % | 67–83 % |

So a consumer must not derive anything from the id beyond identity, and must not expect a mirror
built from the same reports in another order to carry the same ids; follow `superseded_by` and
`aliases[]` instead. The grouping itself moves for a fraction of a percent of events: a fold needs
each event to be the other's best match, and in a dense cell a join needs a shared id, so the
outcome can depend on what is already there (2026-09-30, The Geysers: when NCEDC's 75441706 arrives
before ComCat's nc75441706 and another NC quake's rows join its event first, ComCat's row of the
same id cannot follow, because that event already holds another ComCat id). Making the id independent
of arrival order would mean re-keying events after first sight, which would break every consumer
that keys on it, so the feed keeps the pinned id.

## Review status

`properties.review_status` and `provenance[].review_status` (2026-10) normalize what each source says about its
solution to `"automatic"` or `"reviewed"`; absent means the source does not say it in what the feed reads. The event's
value is its representative row's (the solution its top-level fields come from). It is computed from the stored row at
publish time, so every row the hot window holds has it, and nothing is fetched or logged for it. The top-level `status`
stays the source's own word (ComCat's `automatic` / `reviewed` / `deleted`, NCS's `Reviewed`, …).

| Source | Where it comes from |
|---|---|
| ComCat (`usgs`) | `status` (`automatic` / `reviewed`) |
| AEC | version 2 or an analyst magnitude = reviewed (see *Alaska (AEC)*) |
| IMO | `evaluation_mode` (`manual` = reviewed) |
| KOERI | a `REVISE` solution = reviewed, `Quick` = automatic |
| OVSICORI, IG-EPN | "revisado" = reviewed |
| GeoSphere Austria | `is_verified` |
| CWA | reviewed reports only |
| NCS (India) | `Reviewed` |
| SSN (Mexico) | a preliminary solution = automatic (see *Mexico (SSN)*) |
| RéNaSS, RESIF, NOA, IPGP, ETHZ | the origin's author in the FDSN text answer (`Author`): an automatic SeisComP locator (`scautoloc…@`, `l1autoloc@`, ETHZ's `…_auloc@`, `…_aloc@`, `…_reloc@`, `…_scloc@`, `scrtdd@`) or the `PhaseNet` picker = automatic, a person's login = reviewed |

The author rule was checked against each service's own QuakeML `evaluationMode` for the same events on 2026-10-06
(starttime 2026-09-26, up to 300 events each): RéNaSS 300 of 300 agree (29 automatic), NOA 300 of 300 (1 automatic),
IPGP 119 of 119 (8 automatic), ETHZ 80 of 80 (all manual: its public service lists reviewed solutions; its automatic
locators' names come from the all-origins answer of 2025-03-10) — `tests/fixtures/fdsn-author-modes-2026-10-06.json`.

Not said by what the feed reads: EMSC (its FDSN JSON has no mode), GEOFON and KNMI (no author in the text answer), INGV
(`SURVEY-INGV` on automatic and reviewed solutions alike), GeoNet, NCEDC and SCEDC (network codes; their events reach the
feed through ComCat, which says it), NRCan, and the remaining custom sources. EMSC's and GEOFON's QuakeML do carry
`evaluationMode` (EMSC, 2026-10-06: 329 automatic and 462 manual of its 791 events of two days): reading it would be a
second query per run (EMSC's `updatedafter` QuakeML for the last 10 minutes was 8.8 KB; the whole two-day window is 1.58 MB
against 430 KB of JSON). On the week of 2026-10-06 the field covers 3,822 of 7,360 live events (the top-level `status`
said automatic or reviewed for 3,192); EMSC represents 1,354 of the rest.

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
before, floating point made 2.3 vs 2.2 count and 1.5 vs 1.4 not). Every other magnitude limit below counts exactly
the same way since 2026-10-06 (the 1.0 of the large-event window, the 0.8 between two reviewed solutions, the 1.5 and
the 1.0 of AEC's location join and withheld reports; before, 5.4 vs 4.6 was more than 0.8 and 8.3 vs 7.3 more than
1.0). When the feed folds two existing ids it
folds a pair only when each is the other's best match (distance and time, relative to the
pair's window), so a report is never welded to a neighbour while its own twin stays apart.

Since FEED-1 (2026-10) two reports of different providers are also one event when both
magnitudes are ≥ 4.0, the origins are ≤ 20 s apart, |ΔM| ≤ 0.5 and the distance is within
`20 + 20·(min(M) − 4.0)` km, capped at 50 km (M4.0 → 20, M4.5 → 30, M5.0 → 40, M5.5 → 50) and
shrunk by the magnitude difference like the others. This moderate-event window holds only
outside dense cells, only when no provider reports both, never for NRCan, and only for each
other's best match; it is tried after the windows above. A report with the same solution as
another provider's row already in an event (≤ 2 s, ≤ 2 km, |ΔM| ≤ 0.1), or as a row of its own
provider under another id (a re-id; not NRCan's, whose new ids are revisions), joins that event. Before
the change 42 of the 58 live M ≥ 4.5 events of 2026-10-02 had another live event within 60 s
and 50 km (agencies' solutions of one M4–5.5 quake scatter by 15–40 km); replaying the
observation log under the new rule leaves about a third with one. A client reconciling a
realtime source may use the same window; the feed keeps apart what KAGSR's high magnitudes,
minute-rounded PHIVOLCS and JMA times beyond 20 s, and one provider's two ids keep apart.
Since 2026-10-06 the window is 50 km whatever |ΔM| when both magnitudes are ≥ 5.0: regional agencies locate distant M5
quakes 38–48 km from where USGS, EMSC and GFZ put them (GeoNet near Tonga and Fiji, Geoscience Australia and RéNaSS in
Kamchatka, USP near Sumbawa), and on that day the hot window held 7 such quakes as two events each. Replaying the
observation log of 2026-07-05…10-06 folds 34 groups (none split), each pair's providers disjoint.

TMD (Thailand) locates the region's moderate quakes 20–50 km from where USGS, EMSC and GFZ put
them (Myanmar, Yunnan, Vietnam, northern Sumatra), with origin times a few seconds and magnitudes
a few tenths apart. Since 2026-10 an event that holds TMD's rows only and an event holding a
USGS, EMSC or GFZ row get the moderate-event window with its distance raised to 50 km at every
magnitude ≥ 4.0 (same 20 s, |ΔM| ≤ 0.5, best-match and dense-cell rules). Replaying the
observation log of 2026-07-05…10-06 folds 7 such pairs (18–46 km, 1–5 s), among them TMD's M4.7
of 2026-09-30 in Vietnam, 34 km from ComCat's M4.4; TMD beside another agency (NCS, CENC, BMKG)
keeps the usual windows.

One exception to "one provider's two ids are two quakes": CSN (Chile) publishes a revised solution
as a new informe, numbered right after the one it replaces, and drops the old one from its day
page, which the feed never sees as a delete. Since 2026-10 two CSN rows whose origins are ≤ 3 s
apart, whose places are ≤ 45 km apart, whose magnitudes differ by ≤ 0.5 and whose informe numbers
differ by ≤ 2 are one quake: the newer report joins the event holding the older one (before any
match by time and place), and two events holding such a pair fold (outside dense cells). Of the 24
pairs of CSN ids within 60 s and 100 km in the observation log of 2026-07-05…10-06, CSN's day pages
list only one id of 14 (all inside these limits) and both of 10; 3 of those 10 are one quake CSN
lists twice (EMSC shows one event for each, and no agency a second quake) and fold too; the other
7 stay apart. The older row stays in the event's provenance.

ComCat's own ids are another exception. ComCat publishes a quake under several ids when several networks locate it
and later associates them into one event, whose `ids` then list every id (`,uu80158431,us6000tzcn,nn00925220,`). A
report naming such an id joined the event at first sight already, but an id the feed had published as an event of its
own before the association stayed one when its solution lay beyond the time-and-place windows. Since 2026-10-06 two live
events of the 7-day hot window are one when a ComCat row of one lists, in its `ids`, the id of ComCat's own row in the
other, whatever the distance (Nevada, 2026-10-03: Utah's automatic `uu80158431` 148 km and 23 s from Nevada's reviewed
`nn00925220`); a provider that holds the two under distinct ids of its own still keeps them apart. The merge after a
ComCat revision and the every-run pass over the hot window make the fold (an `op:merge` line with the reason "exact id:
ComCat … lists …"). In the observation log of 2026-07-05…10-06 this happened 4 times, every one an event ComCat lists as
one today (the Kumamoto M6.8 of 2026-07-28 and PTWC's `pt26209004`, 44.5 s later in ComCat's copy; two Alaska quakes,
15.6 and 79.3 km between AEC's and NEIC's solutions; the Nevada one). Older days keep both events: drop a live
`usgs`-only feature whose id another live feature's `usgs` row lists in `fields.ids`.

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
only for events within 7 days of their origin time (the hot window). Since FEED-6 (2026-10)
every aggregate run also runs that merge pass over every live event of the hot window, at most
100 folds a run (the rest fold in the next runs; status `heal_merged`, and `heal_capped` when a
run stopped at the cap): its folds are ordinary `op:merge` lines, and each survivor gets one
`op:correction` line carrying its new revision, `reason` "heal: absorbed …". So events the feed
split before a rule change, or that no later report touched, fold within a run or two while
inside those 7 days, and stay split once older; a run with nothing to fold writes nothing, and
the pass never reaches a day the manifest calls frozen (10 days). On 2026-09-28 a one-time heal
ran the same pass over every live event in the hot window once (the Loyalty Islands M7.0 of
2026-09-25 was six ids), with `reason` "heal epoch 1: absorbed …"; `knowledge/index/heal.json`
on the `data` branch records it. A second heal (epoch 2) runs the same pass once more when EMSC's copies of IGN, NC and SCSN
solutions start counting as the agency's own report (see *EMSC's copies of agencies'
solutions*). The agencies added to that list on 2026-10-01 and the exact-0.1 magnitude rule
(see *Realtime + client dedup*) came without a heal: they apply to reports and revisions from then on (since
FEED-6 the regular heal also folds what they join inside the hot window). Historical partitions are never rewritten.

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
the sources for recent origins (the FDSN ones for the last 48 h, NRCan and NOA for 7 days), plus ComCat and EMSC for every
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
an event (`twin_withheld` AEC reports, `late_withheld` ComCat reports); that does not change which line is first.

A revision of a row that represents nothing in its event (another source's solution leads it, and the revision moves
nothing) changes the row in `feed.provenance` but not the event: its `revision` and `ingest_seq` stay, so the
change-log has no line for it. Since round 15 (2026-10-06) the log has one: an `op:observe` line with a `reason`
starting "row revised:" that carries the row as stored, at the event's unchanged `revision` (so two lines can carry one
feed id at one revision; `ingest_seq` stays the seq of the line that made the revision). Status counts them as
`rows_revised` (about one a run). Before that such a revision was stored without a line, so a replay of the log kept the
older version: 1,068 of the 11,647 live rows of the hot window on 2026-10-06 (GEOFON's row of the Loyalty Islands M5.3
of 2026-09-29 is M5.3 in the event, M5.71 in its last line). A one-time correction (`knowledge/index/correction.json`,
epoch 3) logged each live row of the 10 days not yet frozen whose stored version its newest line did not carry: one
`op:observe` line each with a `reason` starting "correction epoch 3:", the event unchanged. Older days keep the gap. The
log replays to the stored rows since then; it never did, and still does not, for rows that backfill or a new source's
onboarding wrote (they have no line).

**Filled by backfill.** History before that, and the history of a source added later, comes from `backfill`: one
window per source and run (hourly), walking each source that has a time-range query backwards into the day
partitions and the monthly Release archives. Backfill writes no log lines. A backfilled row is the source's solution
on the day the backfill fetched it (2026-07-05…07-25 for most of history), with the source's update time of that
version where the source gives one: neither the source's first solution nor necessarily its last (ComCat's
`us7000st0n` of 2026-06-15 is held at mb 4.5 from ComCat's version of 07:30 UTC that day; ComCat revised it to 4.4 on
2026-07-06 and 2026-08-31). A backfilled event's `feed.first_ingest_time` is the backfill run's time and its
`first_seen_seq` the log position then. The sources' own version histories, where they keep one, are collected into a side
index for both parts (*Earliest solutions*, below).

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

## Run logs

Two logs record the runs themselves, beside the observation log: the status history (every aggregate run's
`status.json`, one line per run) and `changes/YYYY-MM-DD.ndjson` (derive's change log of each day; the current day's
file is also served as `/v1/changes/<day>.ndjson`). The status history is written to `status/history/YYYY-MM-DD.ndjson`,
one file per UTC day of the run's ingest time, since round 17 (2026-10-06); until then it was one file per month,
`status/history/YYYY-MM.ndjson`, and `status/history/2026-10.ndjson` keeps October's lines from before the switch. Read
a month's lines in write order: the month file first (where there is one), then the day files by date
(`statusHistoryFiles` in src/bitemporal.ts). Until 2026-10-04 both logs stayed on the `data` branch forever. Since then
(LIVE-2) the current month stays in the tree and, from the second day of the next month, the `archive` workflow moves
each finished month's files into the Release `logs-YYYY-MM`, one immutable gzip asset per change-log day
(`changes-YYYY-MM-DD.ndjson.gz`) and one per status-history month (`status-history-YYYY-MM.ndjson.gz`: the month's
files concatenated in write order, the same bytes a single month file would have had); gunzip gives the content byte
for byte. `knowledge/index/log_archives.json` lists every one: `file` (the path of the file it replaces; for the status
history the month's path `status/history/YYYY-MM.ndjson`, also when the month was written as day files), `files` (only
when the asset was rolled from day files: the tree files, in order), `tag`, `asset`, `url`, `bytes` and `sha256` of the
asset, `content_bytes` and `content_sha256` of the content, `lines`, `archived_at`. A tree file goes only after its
uploaded asset was downloaded back and both hashes matched (all of a month's files, or none); an asset is never
replaced (an asset of the same name left by a run that died before its commit is taken only if its content is
identical, otherwise the files stay and the run turns red). History is not rewritten: the files stay in the `data`
branch's past commits.

A status history line is `status.json` without `providers.<id>.newest_origin` and `providers.<id>.tls_leaf` (round 16,
FEED-R15-1): both serve the current run only, a frozen source keeps its newest origin in the line's `frozen`, and the
line keeps `tls_leaves`. From 2026-10-06 01:57Z to the round-16 merge the lines carried both (about 6.5 KB a line);
since then a line is about 4.5 KB: a day file is about 1.3 MB at 12 runs an hour, a month about 40 MB (31 days; it was
about 25 MB in August and September, when a line was about 3.8–4.2 KB). Every aggregate commit rewrites the current
day's file. Until round 17 it rewrote the whole month file, up to about 40 MB at a month's end, against GitHub's
warning for a pushed file above 50 MiB and its rejection above 100 MiB, and each such rewrite left about one
compressed copy of the file in the repository's storage per GitHub repack (*Repository size*, below). The aggregate run
prints a warning once the day file passes 5 MB (`HISTORY_FILE_WARN_BYTES`, src/bitemporal.ts): the line has grown about
fourfold. The `health` watchdog checks the same from outside every 15 minutes (round 17): it reads the `data` branch's
tree from the API, logs the files under `status/history/` (count, total, largest, whatever their layout) and opens the
`[health] data file size` issue while a status-history day file (`YYYY-MM-DD.ndjson`) is over 5 MB or any other file
on the branch over 45 MB (closed when none is; never a red run).

## Repository size

GitHub counts the repository's git objects (Release assets are not counted): 5,498,152 KB on 2026-10-04 11:52 UTC,
5,631,151 KB on 2026-10-06 11:07 UTC (the `health` workflow logs it), about 67 MB a day; the 24 hours to 10-05 12:07
grew 64 MB, those to 10-06 00:07 87 MB, those to 10-06 11:07 79 MB. Nearly all of it is the `data` branch: about 576
commits a day (an aggregate commit and a derive commit per run), each rewriting a few large files whole. The derive
commit rewrites about 2.3 day partitions (`events/YYYY/MM/DD.ndjson`, about 2.4 MB each), the aggregate commit about
2.3 event_map day shards (about 1.7 MB each) and, until round 17, the status history's month file (up to about 40 MB
at a month's end).

Git itself stores such a rewrite as a small delta: a full repack (`git repack -adf`, default window and depth) of the
`data` branch's commits of 2026-09-27 … 10-06 takes about 8 MB a day. GitHub stores a busy repository differently. Each
push becomes a pack, and maintenance rolls the newest packs together from time to time, reusing the deltas the packs
hold. In such a roll-up the oldest version of every rewritten file has its delta base in an older pack, outside the
new one, and the newer versions in the roll-up are deltas on it, so it cannot become a delta of them: it is stored
whole or as a delta against another file of similar name and size, usually another day's partition (25–55 % of its
compressed size). The cost is about one compressed copy of every distinct large file rewritten between two roll-ups,
whatever changed in it.

`scripts/repo-growth/replay.sh` measures that locally: it pushes real `data` commits one by one into a bare repository
that keeps every pushed pack and runs `git repack -d --geometric=2` after every 12 pushes (about hourly), then
attributes the growth by path (`attribute.sh`; `relayout.py` re-creates a range of commits from a shallow checkout,
optionally in another layout). Eight days of commits, 24 hours each, ending 09-29 … 10-06 at 11:47 UTC: 77, 46, 73, 80,
47, 45, 52 and 88 MB, 63 MB a day on average (GitHub: 64 MB for the day to 10-05 12:07, 79 MB to 10-06 11:07). After an
all-into-one repack the day to 10-06 holds 50 MB of day partitions, 32 MB of event_map shards, 1 MB of status history, 1
MB of the observation log and 1 MB of everything else (trees, commits, indexes, change log). The rate follows the number
of distinct large files rewritten per hour, which grew from 2.8 partitions an hour on 10-03 to 4.8 on 10-05/06: more
events landed in, or were revised in, days 2–9 days old (43 rewrites of such partitions on 10-03, 216 on 10-05/06:
ComCat's late publications, ENSN and GA back with older events, late NRCan and GeoSphere events, revisions). Rounds
13–16 did not add commits (derive committed separately before round 14 too), and the files they added
(`provider_activity.json`, `live_silent.json`, `correction.json`) or grew (`history.json`, about 3 commits a day) are
under 0.1 MB a day; the live index and the detail hours of round 15 are Pages-only.

Replays are not exact. Git 2.54's `receive-pack` starts `git maintenance run --auto` in the background after each push,
and its default geometric strategy rolled packs together beside the script's own roll-ups (now and then all into one)
at moments that varied from run to run (`fatal: could not find pack …` in the output, about 10 MB a day between
repeated replays). The figures in this section include those roll-ups. Since the round-17 review `replay.sh` turns that
maintenance off (`receive.autogc false`, `maintenance.auto false`): no race, repeated replays of an hour agree within
about 10 %, and the absolute figures follow the roll-up model alone. The day to 2026-10-06 12:57 UTC replays to 130 MB
in the layout before round 17 and 83 MB in round 17's (36 % less) with a roll-up every 12 pushes, 168 and 99 MB (41 %
less) with one after every push, and 85.5 and 65.0 MB (24 % less) with the background maintenance; GitHub counted
83.4 MB for that day, in the layout before round 17. GitHub's own schedule is not known: compare layouts on one model,
and take the rate from GitHub's `size` (the `health` log).

Round 17 (LANE G) changes what the commits rewrite, never what consumers read, and rewrites no history:

- The status history is written per day (*Run logs*): a commit rewrites a file of at most about 1.3 MB instead of the
  month file. Replayed, the eight days grow 11 % less (56 MB a day on average): 20–26 % on the last days of September,
  when the month file was 23–24 MB (77 MB became 57 on 09-28/29), 1–14 % in early October. With the October file padded
  to 31 MB (as on about 10-24), 107 MB a day becomes 79.
- The event_map (the dedup state aggregate keeps, read by nothing outside this repository's code) is written in shards
  of one UTC hour of each event-day, `knowledge/index/event_map/YYYY-MM-DD-HH.ndjson` (`EVENT_MAP_SHARD_HOURS`,
  src/config.ts; 24 writes one file a day again). A run's changes fall into 1–3 hours of a day, so a commit rewrites
  shards of about 70 KB instead of 1.7 MB days: 777 MB a day of rewritten bytes become 65 (10-05/06). Every reader
  takes the event-day from the name's first 10 characters, as the code before round 17 did, so a reverted deploy still
  reads the hour shards. `loadEventMap` inserts each event-day's nodes in feed-id order whatever the layout, so the map
  iterates exactly as it did with day files (the same 57,991 nodes in the same order on the `data` copy of 10-06 13:02
  UTC); the Resolver's equal-distance tie-break follows that order. The code before round 17 reads hour shards in name
  order (hour, then feed id): the same nodes, another order, so the rollback is `EVENT_MAP_SHARD_HOURS=24` rather than
  a revert. Replayed alone, the event_map's share of the days to 10-04, 10-05 and 10-06 falls from 13, 20
  and 32 MB to 6, 7.5 and 10.

Both together replay to 45 MB a day on average over the eight days instead of 63 (23–42 % less a day, 28 % in all); at
GitHub's 67 MB a day that is about 48 MB. What remains is about three quarters day partitions, which consumers read
(jsDelivr `@data` / `@<data_commit>`, the manifest's `partitions`) and keep their layout. They shrink only by being
rewritten less often, which changes what the `data` branch shows between runs: a partition of a day 2 or more days old
written at most every 3 hours (Pages, the live index and the summaries unchanged) replays the days to 10-04, 10-05 and
10-06 to 19, 30 and 40 MB. That, and how large the repository may grow (GitHub's on-disk limit is 10 GB,
[Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits),
read 2026-10-06), are owner decisions. So is a full repack on GitHub's side, which only GitHub can run: the whole
repository repacked locally (`git repack -adf` of a mirror clone of 2026-10-06, all 808,450 objects, default window and
depth) is 0.69 GiB, against the 5.38 GiB GitHub serves and counts.

## Deep history (before 2023-07-06)

History older than the 3-year layer above is built by a separate walk, `history` (`.github/workflows/history.yml`,
`src/history*.ts`), that never commits a day partition, never touches an `archive-YYYY-MM` Release and never rewrites a
frozen day. It runs only while `providers/history.json` says `"enabled": true`; the first era configured is a pilot,
every magnitude, 2022-07-01 up to the boundary 2023-07-06 (the 3-year layer's first day, which must equal
`knowledge/index/backfill.json` `targetStart`): ComCat (`usgs`) alone in its edition 1 (2026-10-01), then the 16 other
FDSN sources of the 3-year layer (`emsc`, `geofon`, `ingv`, `geonet`, `resif`, `noa`, `usp`, `lmu`, `renass`, `ipgp`,
`ethz`, `nrcan`, `ncedc`, `scedc`, `knmi`, `auspass`; not ISC, whose walk is paused) in its edition 2. The custom
adapters (`afad`, `kagsr`, `imo`, `csn`, …) have no history query yet and are in no era.

**Era A** (owner-approved, round 15) continues with the same 17 sources, every magnitude, from 2022-07-01 back to
2000-01-01: 270 months, walked newest first after the pilot's edition 2, one edition per month. Some catalogues start
later than 2000 (measured 2026-10-06 in the sampled months: NOA's `eida2` has no rows before 2011-03, GEOFON none in
2000-01 and 2004-12, IPGP none before 2018 and a dozen a month in 2018–2019, USP a few a month before 2016); their
earlier months are empty raw assets; the first of them is kept once the source still answers rows of the newer month
(*Pace* below) and is named in the run's `empty_after_rows`. Projection from
the round-15 measurements (ComCat's and EMSC's monthly counts for all 270 months, INGV fetched for all 270, the other 14
sources measured in 35 months and interpolated, about ±30 % for those):

| | Era A (2000-01 → 2022-06) |
|---|---|
| Source rows | about 6.7 M (ComCat 2,834,028, EMSC 1,063,994, INGV 372,513, the other 14 about 2.4 M) |
| Events | about 4.9 M (0.73 events per row, as in the measured months) |
| Release assets | 18 per month, 216 per `history-YYYY` (`history-2022` 222 with the pilot's; the limit is 1,000) |
| Size | raw about 0.37 GB + editions about 0.68 GB; the largest asset about 9 MB (2019-07, Ridgecrest) |
| Requests | about 5,200 (ComCat 558, EMSC 540, INGV 310, the others 270–282 each), one at a time, ≥ 1.1 s apart per host |
| Walk time | about 4 min per month on a runner (requests, 18 uploads read back, the build): about 18 h, about 110 hourly runs, about 5 days; about ten swarm months build for 6–9 min each |
| `knowledge/index/history.json` | about 9.6 KB per month: about 2.7 MB at the end (the commit job's cap is 8 MB) |

The side index of earliest solutions follows the editions back (*Earliest solutions* below): era A gives it about
2.8 M more ComCat reports (one request each), about 1.2 M NCEDC / SCEDC reports read through ComCat and about 0.37 M
INGV reports, at its own hourly pace (about 43,000 ComCat reports a day: about three months).

**Where it lives.** Everything is an immutable asset of a Release `history-YYYY` (the year of the month):

| Asset | What it is |
|---|---|
| `raw-<source>-<YYYY-MM>.ndjson.zst` | one source's answer for one month, normalised by the feed's parser: a header line (`kind: "earthquakes-feed/history-raw"`: the range, the queries' windows, the rows each answered, the source's own count where it has a count service (ComCat, EMSC), `fetched_at`), then one report per line |
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
month that cannot be fetched whole fetched again next run (a source that fails a day of runs turns the run red). The
two sources with a count service, ComCat and EMSC (`fdsnws/event/1/count`, asked in the source's query format: ComCat
`geojson`, EMSC `json`; measured 2026-10-06, none of the other 15 FDSN services the feed reads answers one), are asked
for their count first and every window's rows must equal it. A month is sealed (its next edition built, verified and
uploaded) as soon as its last source arrives, and a run first seals what an earlier run left complete. At most
`maxUnitsPerRun` source months and `maxSecondsPerRun` per hourly run; neither job holds the writer lock (the index
commit pushes through `scripts/push-data.sh`, FEED-OPS-4). A month a source answers empty right before a month of the
same source with rows is either where a catalogue starts (going back) or a service answering empty while it is broken
(NOA's registered node answered 204 to every query for ten days, PF-5j-NOA). The walk tells the two apart before it
keeps anything: it asks the source again for a two-hour window around the newer month's first, middle and last row
(stopping at the first that answers a row). A row there keeps the empty month (the catalogue starts; named in the
run's `report.json` `empty_after_rows` and as a warning); no row, or an error, fails the month like any other failure,
so nothing empty is sealed while the service is down and the month is asked again next run.
The heartbeat Worker dispatches the workflow at `:26` (GitHub delivers this repository's hourly crons only a few times
a day; the workflow's own `:29` cron is the fallback), and a run does nothing unless `providers/history.json` has
`enabled: true`.

**Dry runs.** `gh workflow run history.yml -f dry_run=true` (or `HISTORY_DRY_RUN=1 HISTORY_FORCE=1` locally, with
`DATA_DIR` a copy of the `data` branch's `knowledge/index`) creates no Release, uploads nothing and commits nothing: the
assets go to `history-out/releases/<tag>/` (a 3-day workflow artifact), and the published assets the index lists are
read from the Releases, read only, so a dry run can build a month's next edition. A local dry run continues from its own
`history-out/history.json`. `-f sources=ingv` (`HISTORY_ONLY_SOURCES`) limits a dry run to some sources; it seals
nothing that needs another source. The dry run stays in the walk's concurrency group: it asks the same hosts.

## Saturated days

When even a one-day backfill window filled a source's page cap, the walk kept the capped rows (the day is partial for
that source) and listed the day in its cursor (`saturatedDays` in `knowledge/index/backfill.json`). On 2026-10-04 that
was KAGSR 2025-07-30 (the day after the M8.8 Kamchatka mainshock), 23 AFAD days of the Sındırgı sequences (2025-08-11
to 08-25 and 2025-10-28 to 11-12) and IMO 2023-11-11, 2025-04-01 and 2025-05-24. All of them are frozen and rolled
into `archive-YYYY-MM` Releases, and the feed never rewrites a frozen day or a published asset, so they are not
repaired in place. The `remediate` workflow (manual, `workflow_dispatch`; `src/remediate.ts`) publishes ADDITIVE day
editions instead, Kamchatka first, then the Sındırgı days:

- the source's whole day is asked again in 6-hour windows, each halved while its answer fills the cap (down to
  5 minutes; a window still full there marks the day `partial`), one request at a time, at least 1.1 s apart;
- the archived day and its two neighbours are read back from their archive asset (read only); AFAD rows the archive
  holds 3 h early (before 2026-10-01, see *Turkey (AFAD)*) are re-read at their real time and folded, as the one-time
  correction did for the unfrozen days, so the day has one time base; then the fetched rows go through the ingest
  screen and backfill's Resolver;
- the result is the complete day in the day-partition format, published as `events-<day>.e<N>.ndjson.gz` beside
  `raw-<source>-<day>.ndjson.gz` (a header line, then exactly the rows the source answered) in the Release
  `remediation-YYYY`. Both are immutable; a later remediation of the same day (another source) is the next edition,
  built from the archive and every raw asset of the day. Each upload is read back and its checksum compared;
- an edition replaces ONE archived day while its neighbours stay as archived, so it holds the archived day's events by
  feed id plus the events the remediation minted. An AFAD event re-read across midnight keeps the day its archive gave
  it (its time may then lie up to 3 h into the next day; `stats.off_day`), the AFAD re-read and its folds stay among
  the day's own events, and an event archived on a neighbouring day never enters the edition (a fetched row that
  joins one is counted in `stats.neighbour_joins` and stays unpublished; the event itself stays in its archive). Before
  upload the edition is checked: no report live twice in it, and none it adds live in a neighbouring archived day, so
  reading the edition instead of the archived day never drops an event or publishes one twice.

`knowledge/index/remediation.json` lists every raw asset (`provider`, `day`, `rows`, `requests`, `partial`,
`sha256`, …) and every edition (`day`, `edition`, `url`, `sha256`, `built_on`: the archive asset and its checksum,
`built_from`: the raw assets, and `stats`: events before and after, new, retired, off the day, rows changed /
unchanged, rows that joined a neighbouring day, AFAD rows re-read). The archived day, its `archive-YYYY-MM` asset and `manifest.json` are unchanged: a consumer that wants the
repaired day reads the current edition (the highest `edition` of the day) instead of the archived day.

## Earliest solutions (side index)

What did a source publish *first* for an event, and when? The log answers that since 2026-07-05, up to the polling
interval; backfilled history cannot. Some sources keep a version history of their own, and the
[`first-solutions`](.github/workflows/first-solutions.yml) workflow collects it into a side index, for every report in
the feed's day partitions: the 3-year layer from 2023-07-06, the deep history before it as far back as its monthly
editions reach without a gap (*Deep history* above; that walk builds months newest first), and every day since, once
its partition is frozen (ten days). Nothing in the day partitions, the archives, the deep-history assets or the log
changes.

**Sources** (checked 2026-10-01; one lane each, its own host, one request at a time, at least 1 s apart):

| Source | How | What it keeps | Requests |
|---|---|---|---|
| `usgs` (ComCat) | `eventid=…&includesuperseded=true` per report ([USGS FDSN event](https://earthquake.usgs.gov/fdsnws/event/1/), read 2026-10-01) | every `origin` product version still held, with its `updateTime`; the tsunami centres' (`pt`, `at`) are often minutes before NEIC's (`us7000keq3`, 2023-07-10: 6, 8 and 18 min after origin). Not every first solution: of the 441 events of 2026-06-15, 283 had a reviewed version as their earliest kept one (published hours to days after origin: AK, UU, AV, NC, US and others), and no `usauto` origin is kept | one per report: 429,575 history + 24,774 since 2026-07-05 |
| `ncedc`, `scedc`, `aec` | ComCat's event of the same id (`nc…`, `ci…`, `ak…`), its own network's origin products | as above | none of their own |
| `geonet` | `quake/history/{publicID}` per report ([GeoNet API](https://api.geonet.org.nz/), read 2026-10-01: "Not all quakes have a location history.") | every location version with its `modificationTime` and `quality`, **for 365 days after origin only** (measured 2026-10-01 15:40 UTC: the events of 2025-10-01 before about 15:40 had none, every later one 7–67 versions), so this lane walks oldest first; the 50,534 GeoNet reports before 2025-10-02 have no history left. The first automatic versions can be another quake (`2026p685142`: an M3.5 at 624 km off New Zealand for 26 versions before the M6.0 in the Banda Sea) | one per report: 17,023 still kept + 4,974 since 2026-07-05 |
| `ingv` | QuakeML `includeallorigins` + `includeallmagnitudes`, only with `eventid` | every origin, with `creationTime` and INGV's version number | one per report: 51,455 + 4,039 |
| `ethz`, `usp` | the same, for a whole UTC day | every origin (ETHZ's first seconds after origin, 2023 included) | one per day with a report: 1,082 + 78, 1,071 + 68 |
| `geofon`, `knmi`, `ipgp`, `lmu` | the same, for a whole UTC day | the event's `creationTime` and only later origins (GEOFON 1–3, the others the final manual one): the first publication *time* is known, its values are not | one per day with a report: 1,090 + 78, 397 + 24, 1,032 + 78, 644 + 5 |

Left out: EMSC (its QuakeML origins have no creation time and its event `creationTime` is the last update), RESIF and
RéNaSS (all origins, no creation times), NRCan (creation time is the date only), AusPass (creation time is the import
day), IMO (`/events/{id}` is the current solution only), KAGSR (no QuakeML), NOA (its registered node answered every
query with 204 on 2026-10-01, see *Greece (NOA)*; its second host is not measured yet), ISC (its origins are the contributing agencies', and its walk is paused), AFAD (an update time only,
already in the rows) and the forward-only custom sources: for them the log is all there is.

**Storage.** One gzip NDJSON chunk per source, event month and run, `fs-<source>-<YYYY-MM>-r<run>.ndjson.gz`, in the
GitHub Release `first-solutions-<YYYY-MM>` of the event month (at most 1,000 assets per release, 2 GiB each, no total
or bandwidth limit: [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases),
read 2026-10-01). The `data` branch holds only `knowledge/first_solutions/cursor.json` (where each walk stands) and
`chunks.ndjson` (one line per chunk: source, month, release, asset, records, bytes, sha256, days, run). Measured on
2026-06-15: 608 records; per record ComCat 584 bytes of JSON (60 gzipped), GeoNet 4,151 (249), INGV 758 (78), ETHZ
2,912 (379), USP 2,517 (385), GEOFON 437 (64). For everything listed above that is about 450 MB of NDJSON, 45 MB
gzipped: as plain files in the `data` tree it would grow every 5-minute aggregate checkout by about 70 % (the tree is
620 MB), and even gzipped it would add 45 MB to every checkout and to the history for good; as Release assets it adds
nothing to either. R2 would also keep it out of git, but would make the owner's bucket the only copy of a dataset the
repository otherwise keeps itself (R2 is a derived, additive origin here) and put R2 secrets into another job.

**A record** (one line of a chunk): `provider`, `provider_event_id` (the id the feed holds), `day` (the event day it
was collected for), `method` (`comcat-superseded`, `geonet-history`, `quakeml-all-origins`), `ids` (ComCat: every id
of the event), `created` (the source's creation time of the event, QuakeML), `versions` (each `published`, `time`,
`lat`, `lon`, `depth` km, `mag`, `magType`, `status` = ComCat `review-status` / GeoNet `quality` / QuakeML
`evaluationMode`, `evaluation`, `source` = ComCat product source or QuakeML agency, `version`; oldest publication
first), `deleted` (ComCat), `missing` (why there is no version: `http 404`, `no history`, `not in the day answer`, …)
and `collected` (a version published later is not in it). Each chunk's data carries its source's licence and
attribution (registry, [ATTRIBUTIONS.md](ATTRIBUTIONS.md)).

**Looking it up.** `scripts/first-observations.ts` merges the side index with the log, one answer per report:

```bash
gh release download first-solutions-2026-06 -R TheShelterApp/earthquakes-feed -D fs
FIRST_SOLUTIONS_DIRS=fs DATA_DIR=.data npx tsx scripts/first-observations.ts usgs:us7000st0n
```

`first_solution` is the earliest solution whose values are known, with its provenance: `provider version history`
(`at` = the source's own publication time of that version) or `first seen by the feed` (`at` = when the log first
held it; the source published it then or earlier). The earlier one wins, a tie goes to the history.
`first_published` is the earliest publication time known: the event's creation time (`provider event creation
time`) where that is earlier than every kept origin (GEOFON, KNMI, IPGP, LMU). `provider_history` summarises the kept
versions (`first`, `first_non_automatic`, `last`, `versions`, `via` for a network read through ComCat) and
`feed_first_seen` is the log's first line. A version history is the source's history *as kept on the day it was
collected*: an earliest kept version that is already reviewed bounds the first publication from above only.

Even where the log has the report, the history is usually earlier: for the events of 2026-09-11 (collected
2026-10-01) the source's first kept version was published before the feed first held the report for all 352 ComCat
reports (median 151 s), 49 GeoNet (182 s), 56 INGV (704 s), 5 ETHZ, 3 USP, 4 IPGP and 1 KNMI; for NCEDC and SCEDC (via
ComCat) for 51 of 52 and 41 of 50 (the other ten: the feed saw an automatic solution ComCat no longer keeps); for GEOFON
the creation time came first for all 7 logged reports, its first kept origin after the feed's first sight for 3.

**Order.** GeoNet goes oldest first from the first day it still keeps, ahead of its expiry. Every other source takes
the days since the log began first, oldest first, and then history, from 2026-07-04 back to 2023-07-06 and on into the
deep history's months (a deep month whose current edition was built from other raw assets of the source, because it
joined the era or was fetched again, is collected again: `deep` in the cursor). A history thins out with
time (read on the same day, 2026-10-01, 40 of the 61 AK events of 2026-09-11 still had both an automatic and a reviewed
origin in ComCat, but only 22 of the 76 of 2026-06-15; TX 23 of 33 against 5 of 19), while history before the log no
longer changes. Once caught up, each run takes the newly frozen day first.

**Pace.** Hourly, when the repository variable `FIRST_SOLUTIONS_SCHEDULE` is `on`: the heartbeat Worker dispatches the
workflow at `:48` with `tick=1` (a run so dispatched goes ahead only while the variable is `on`; a manual dispatch always
does), and the workflow's own `:50` cron is the fallback. The Worker is needed: GitHub delivered this repository's hourly
crons about 4 times a day (backfill, derive and health each got 4 scheduled runs between 2026-09-30 16:40 and
2026-10-01 16:40 UTC), which would stretch every estimate below about sixfold. The `collect` job holds no
writer lock (it shares the deep-history walk's group, so the two never ask a host at the same time): up to 30 minutes of
requests, chunks uploaded, then the `commit` job writes the two small files in seconds (a sparse checkout of `knowledge/first_solutions/`; it refuses to write if they changed since the
collect job read them, and refuses to stage any other file). Since round 14 (FEED-OPS-4) it holds no writer lock either:
no other writer touches those files, so its push rebases onto whatever another writer pushed first
(`scripts/push-data.sh`). A lane takes no day of a seventh event month in one run (each month is one chunk upload, so the
uploads stay a few minutes inside the job's 45-minute timeout; a day source would otherwise reach dozens of months a
run). At one request a second a run does up to about 1,750 requests per lane (ComCat answered 441
requests of 2026-06-15 in 450 s), so ComCat's 454,000 reports take about 11 days of hourly runs (and about 4 more for
the deep pilot era's 157,212 ComCat events, 2022-07-01 to 2023-07-06, as its editions appear), INGV's 55,000 about a
day and a half, GeoNet's 22,000 about 13 hours, and the day sources (1–10 s per answer, about six months of days a run) six to eight
hourly runs each; then each run
takes the newly frozen day (about 400 ComCat requests). Failures: three retries per request (2, 8, 30 s, Retry-After
honoured); a lane that still fails stops for the run and resumes there; 50 answers in a row without the event stop a
lane (its streak is asked again); a day source's day answered with 204 or 404 is checked against the last day the node
had content for: content there now means the node is up and the day's reports are recorded as missing at once (USP
answered 204 for 2026-08-25, whose one report it no longer lists); with no such day yet, or with that day empty too (a
node that is down), the day is asked again in the next two runs before it is recorded as missing; any other refusal
stops the lane; a source failing 24 runs in a row warns, from 72 the run turns
red about once a day. A run whose upload fails keeps that source's cursor where it was. A run whose commit job never
lands (until round 14 GitHub cancelled a commit job waiting for the writer lock whenever another writer queued behind
it, 10 of 126 runs in the week to 2026-10-06, run 36909538501 first; now only a failed push or job is left) is taken
over by the next run:
the collect job reads the newest `first-solutions-out` artifact, and when that output was uploaded, was built on
exactly the cursor and chunk list `data` still holds, and every chunk it added is in its Release with the listed size,
the run starts from it, so its commit lands both runs' work and nothing is asked twice.

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
| `HV`, `PR`, `AK`, `TX`, `NN`, `UU`, `UW`, `OK`, `MB` | ComCat's row of that network (`hv…`, `pr…`, `ak…`, `tx…`, `nn…`, `uu…`, `uw…`, `ok…`, `mb…`) | 2026-10 (FEED-4) |
| `NEIC` | ComCat's `us…` row (never moved, see below) | 2026-10 (round 14) |

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
KAGSR's solution), CN (the feed's NRCan rows carry no magnitude) and the agencies with fewer than 50
copies (IPMA, IGP, GA, CWA, IPGP's observatories, BGS, USP, KNMI, AEC). The US networks the feed reads only through ComCat count against ComCat's row whose own
id carries the network's prefix (EMSC's `20261003_0000049`, `auth: "HV"`, is ComCat's `hv75048812`
to EMSC's rounding); ComCat's row of another network for the same quake (`us…`) is another solution
and does not count. Their copies equal the network's ComCat row in time and place in 99–100 % of the
versions the feed saw and in magnitude in 96–100 % (OK and MB had 35 and 11 copies, every one of
them the network's row); in the dense Kilauea cell the HV copies stood beside ComCat's event 10
times in the 11 days to 2026-10-04. NEIC's copies count against ComCat's `us…` row in the same way
(99.9 % of 2,107 versions equal in time and place, 93.0 % in magnitude too; in the dense cell of the
August 2026 Flores sequence 29 M4.4–5.8 quakes stood as an EMSC event and a ComCat event each).

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
event (EMSC's `20260910_0000383` copied OVSICORI 1449691, then 1449690, 41 s later; on 2026-10-03
near Valencia `20261003_0000060` copied IGN `es2026tiyjb`, then `es2026tiyjg`, then `es2026tiyil`).
Until FEED-2 the row stayed in the event it joined, which then showed the other quake's solution
beside the agency's own event of that quake. Now, when a copy (or its revision) copies none of
the other rows of its event and another live event holds the agency row it copies, the row moves
there: an `op:tombstone` line for the event it leaves (`reason` "re-homed: EMSC … copies …, held
by efd_…", the row as it was; that event's id list drops the EMSC id and its solution goes back
to its other rows) and then the row's `op:observe` line in its new event. A copy of an agency
solution no live event holds yet stays where it is until that row is in; then the next run's
listing of the copy, or the pass every run makes over the 7-day hot window (which also moves the
copies left in the wrong event before this rule), moves it. A copy alone in its event is not
moved: the merge pass folds that event into the agency's. Status counts the moves as
`copies_rehomed`. This re-home never moves a NEIC copy: EMSC often takes an event's solution first
from the regional agency (SSN, JMA, CENC) and then from NEIC, which is the same quake under two
agencies' solutions; the row stays, its event moves to NEIC's solution and ComCat's event folds into
it. A NEIC copy left with no row it is one quake with can still move by the re-point rule below.

EMSC also re-points its own event ids, copies of agencies outside these lists (JMA, INPRES under
EMSC's code `NSNA`, GSRAS, BMKG) and NEIC copies to another quake. Since 2026-10 such a row moves too. The
move needs the row to be one quake with none of its event's other rows, more than 10 s from every
one of them, and placed by the usual time-and-place rules in another event holding a row it is
one quake with. The same `op:tombstone` / `op:observe` lines record it, with a reason ending in
"re-pointed, … one quake with efd_…", and status counts these moves as `rows_rehomed`. A revision
never moves at once, only the next listing of the unchanged row or the every-run pass over the
hot window, so a merge the revision causes comes first: when EMSC switches from JMA's
minute-rounded copy to NEIC's solution of the same quake, ComCat's event folds in and nothing
moves. On 2026-10-06 the pass would move 5 rows of the hot window, each an EMSC id 16–32 s and
11–329 km from the quake its event shows. The observation log of 2026-07-05…10-06 replays to 3
such moves (38–90 s).

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

## Mexico (SSN)

SSN's RSS (`http://www.ssn.unam.mx/rss/ultimos-sismos.xml`, its last 15 items, local time UTC−6) first lists a quick
solution titled `Preliminar: M 4.4, 85 km al SUROESTE de MAPASTEPEC, CHIS` and replaces it 5 to 25 minutes later with
the reviewed item (`4.4, 188 km al SUROESTE de MAPASTEPEC, CHIS`). The adapter's id is origin time plus position, so
the two items never share an id: in the log from 2026-07-05 to 2026-10-03, 25 of 29 preliminary items had a reviewed
item 0 to 18 s earlier in origin time and 3 to 111 km away, and each stayed in the feed as an event of its own, without
a magnitude (the title was read for a leading number). Since 2026-10-04 (FEED-5):

- a preliminary item keeps its magnitude and place and is published with `status: automatic`; its `fields.title` is
  SSN's title as sent;
- once a reviewed SSN solution with an origin within 60 s and a position within 150 km is in the feed, the preliminary
  row leaves its event (`op:tombstone` with a reason; an event with no row left is tombstoned and stays published,
  non-live, for 48 h), on days the manifest does not call frozen; a preliminary item that arrives when its reviewed one
  is already known is not ingested, so the pair never flips back;
- the first run after the change withdrew the 6 preliminary rows then in the unfrozen days (dry run on a copy of
  origin/data); older ones stay in the frozen days as they were.

## Greece (NOA)

The node the FDSN registry lists for the National Observatory of Athens
([fdsn.org/datacenters/detail/NOA](https://www.fdsn.org/datacenters/detail/NOA/), read 2026-10-01:
`https://eida.gein.noa.gr/fdsnws/event/1/`) has answered every event query with HTTP 204 since 2026-09-24: its last
answer with rows reached the feed at 11:46:50 UTC (120 rows), two requests timed out, and from 12:01:43 every run got
204. The node is up (SeisComP FDSNWS 1.2.4) and its event database is empty: a query for January 2020 gets 204 too, and
`/catalogs` and `/contributors` are empty lists. No parameter of the feed's query is at fault, and neither NOA's EIDA
page nor the registry announces a move. The feed counted the 204 as a healthy empty answer (`status.json`
`providers.noa`: `ok: true, http_status: 204, events_returned: 0`), so nothing reported it.

NOA's second EIDA host, `eida2.gein.noa.gr` (the same "Access to NOA EIDA Services" page, the same certificate
`*.gein.noa.gr` issued to the National Observatory of Athens, the same server version), serves the catalogue under the
same event ids: on 2026-10-01 all 524 events it listed for 2026-09-17…23 were the `noa` rows the feed had logged from
the registered node, with the same id, place and magnitude. Since PF-5j-NOA the registry asks `eida2` (`base`) and
keeps the registered node as `fallbackBase`: when `base` fails or answers with no rows, the same query goes to the
fallback, whose answer is used only when it has rows; `status.json` then carries `via` with that host. Whichever host
answers, a report keeps its id, so the swap never makes a second event. The deep-history and earliest-solutions walks
ask `base` alone.

**The gap.** From the outage to 2026-10-01 21:00 UTC NOA listed 394 events. 42 of them reached the feed through
another source (EMSC 35, KOERI 19, AFAD 8, INGV, ComCat and GEOFON 2 each; every one of the 9 of M ≥ 3, the largest
M4.0), and 352 through no source (the largest M2.8, 59 of M ≥ 2; 30 to 80 a day). NOA's SeisComP service has no
`updatedafter`, so the live query is the only way one of its rows enters; the feed now asks NOA for the last 7 days
(`lookbackDays`, the window in which reports are matched by time and place), so the first run after the change takes
every NOA row with an origin in the last 7 days: in a dry run on 2026-10-01 that was 368 rows, 37 joining another
source's event and 331 new events (the largest M2.8), each in the day partition and day file of its origin day with
`feed.first_ingest_time` days after `feed.event_time`. A second run over the same answer changed nothing. NOA events
with an origin more than 7 days before that run stay missing (from 2026-09-24 11:47 UTC on): older rows are dropped
at ingest, and frozen days are never rewritten.

## France (RéNaSS, RESIF)

The `renass` source reads RéNaSS (BCSF-RéNaSS, Strasbourg: `api.franceseisme.fr`) and the `resif` source reads
RESIF's FDSN event service (`ws.resif.fr`), which serves the same catalogue under the same event ids (`fr2026…`; the
`Contributor` column names who located each event: RENASS, OMP, OSUNA, BRGM, the overseas observatories OVSM, OVSG,
OVPF and REVOSIMA (Mayotte), IPGP, and EOST's world solutions `EOSTtele`, "(Monde)" in the place). Measured on
2026-10-06: the 26 months both deep-history
walks fetched (2021-06 → 2023-07) hold 34,345 rows each, the same ids, every row identical apart from `provider`;
since 2026-07-05 the live log holds 3,826 ids from both, 7 from RESIF alone (all in the feed's first run) and 6 from
RéNaSS alone (2 of them RéNaSS's second id of a quake it lists twice); RéNaSS had an id first 513 times, RESIF 96
times, both in the same run 3,217 times. Every event of the two therefore carries two provenance rows with one
solution, each with its own source's attribution; count them once when you count independent agencies.

Since round 17 (`CATALOGUE_MIRRORS`, src/config.ts) the feed treats the two rows of one id as one report: a report
joins the event its twin is in, however far the solutions have drifted (one source a revision behind) and however
dense the cell, and a report of one source next to the other source's row of another id is that catalogue's other
quake, as for a single source. Before, where 50 or more events fall into one cell within the hot window (Montagne
Pelée, Mayotte, the Mont Blanc massif, aftershock zones) the feed joins two reports only on a shared id, so the two
rows of one id were published as two events: in the day partitions of 2026-06-01…10-06, 420 ids (403 of them in
June, written by the feed's first run on 2026-07-05). Those days are frozen and keep both events: drop a live
`resif`-only feature whose `resif:<id>` has a twin `renass:<id>` in another live feature's `feed.aliases`, or the
other way round. The deep-history editions sealed before the change (merged 2026-10-06 about 13:05 UTC: the pilot
year's `e1` and `e2` and era A's `e1` of 2022-06 back to 2021-01) keep theirs too (2021-04 e1: 296 ids; 2022-01 e1:
186; 2023-01 e2: 18; 2022-06 e1: 0), and the same consumer rule drops them; a month sealed after it is built with the
rule (rebuilt offline, 2022-01 gives 26,061 events instead of 26,245 and 2021-04 26,437 instead of 26,733, every row
of another source in the same event as before). A later edition of a sealed month would pick it up; nothing builds
one automatically.

## Recipes

```js
// Current week, one CORS-open fetch:
const fc = await (await fetch('https://earthquakes-feed.theshelter.app/v1/all_week.geojson')).json();
const stale = (Date.now() - fc.metadata.generated) / 1000 > 1800;

// Keep the week current: the live index (see Live index) instead of all_week on every change
const m0 = await (await fetch('https://earthquakes-feed.theshelter.app/v1/manifest.json')).json();
const idx = await (await fetch(m0.live.url)).json();
const delta = cursor != null ? idx.deltas.find(d => d.from_seq <= cursor) : null; // smallest first
// delta (its body hashing to delta.sha256) ? upsert all its features by id : refetch the days whose sha256 changed; cursor = idx.head_seq

// One event's full detail: its UTC hour
const hour = new Date(eventTimeMs).toISOString().slice(0, 13);
const detail = await (await fetch(m0.event_detail.url_template.replace('{hour}', hour))).json();

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
