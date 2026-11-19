# earthquakes-feed — API reference

A static-file API over a CDN. No server, no keys, no rate limits, full CORS
(`Access-Control-Allow-Origin: *`). Everything is GeoJSON or NDJSON.

**Golden rule:** fetch `manifest.json` first and resolve every other path from it.
Don't hardcode partition/summary paths or `@sha` URLs — they can move (freezing,
archival, redaction).

## Surfaces

| Surface | Base | Use | Cache |
|---|---|---|---|
| Cloudflare Pages | `https://earthquakes-feed.theshelter.app/v1/` | live feed, recent day files, manifest, live index, month index, per-hour detail | summaries + manifest + live index, deltas and month index `max-age=30` + SWR; day files `max-age=300` (today, yesterday) / `3600` (older); live index and month index day files `max-age=0, must-revalidate`; detail hours `max-age=300` |
| Cloudflare Pages | `https://earthquakes-feed.theshelter.app/v1/stats/` | statistics: the index, 61 day tables, the year and area files (*Statistics*; since 2026-11, while `providers/stats.json` has `derive_publish: "on"`) | `max-age=0, must-revalidate` (the index names every file's `sha256`) |
| Cloudflare Pages | `https://earthquakes-feed.theshelter.app/events/` | the unfrozen day partitions (NDJSON, the last 11 days), byte for byte the files derive writes (since 2026-10; from the merge of PR #154 (2026-11-16, the port of #120) their only copy until they freeze), and for one day after it freezes the day that froze last (same date); served as `text/plain; charset=utf-8`, brotli or gzip when the request accepts it (since 2026-10-14; the manifest's `sha256` and `bytes` name the decoded bytes) | `max-age=0, must-revalidate` |
| Cloudflare Pages | `https://earthquakes-feed.theshelter.app/share/event/` | static HTML share pages of significant events, the target of `https://theshelter.app/event/<feed id>` links (*Share pages*; since 2026-11); for people and link-preview bots, not for programs | `max-age=300`; CSP, `nosniff`, `no-referrer`, `noindex` |
| jsDelivr (branch) | `https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/` | full-history partitions; **from the merge of PR #154 (2026-11-16, the port of #120), frozen days only** (*Historical day partitions*); every other path (the statistics year and area files, the index files) as before | ~12 h |
| jsDelivr (`@sha`) | `…@<data_commit>/` | immutable frozen partitions | 1 year, immutable |
| GitHub Releases | `archive-YYYY-MM` assets | very old months (bulk) | immutable, no CORS |
| GitHub Releases | `remediation-YYYY` assets | complete editions of days a source's backfill could not fetch whole, or that the live layer's start left empty (*Remediation editions*) | immutable, no CORS |
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
| `data_commit` | git SHA for building immutable partition URLs (a frozen partition's `url` is already pinned to it) |
| `summaries` | map of `{name: {path, url, count}}` for the 20 rolling feeds (`count` = live events in that file) |
| `partitions[]` | per-day: `{date, path, url, pages_url?, count, bytes, min_mag, max_mag, frozen}`; `url` is the NDJSON: the Pages copy for an unfrozen day (from the merge of PR #154 (2026-11-16, the port of #120) also for the day that froze last, for a day), the immutable jsDelivr `@<data_commit>` copy for a frozen one (*Historical day partitions*). `count` is every feature of the file (all states); since round 26 (2026-10-14) `min_mag` / `max_mag` are the day's **live** events' range, recorded while the day is unfrozen and kept when it freezes (a retired event keeps its last solution: a phantom M8.2 folded into the Panama M7.7 of 2026-10-09 had kept that day at 8.2); days frozen before then keep the range over every feature. A run that rewrites a frozen day's partition (a revision moved an event onto that day) records the live range of the new bytes |
| `archives[]` | rolled-up cold months: `{period, tag, asset, url, bytes, sha256, count, days[]}`; `count` is every line of the asset (all states). Since 2026-11 also `edition` (absent = 1), and for a re-merged month `merge_epoch`, `live`, `superseded`, `built_on`, `remediation[]`, and `previous[]` (the month's earlier assets, never deleted; see *Re-merged history*) |
| `live` | the live index: `{path, url, head_seq, window_days}` (see *Live index* below; since 2026-10) |
| `live_month` | the month index: `{path, url, head_seq, min_mag, window_days}` (see *Month index* below; since 2026-10-14) |
| `event_detail` | the per-hour detail files: `{path_template, url_template, first_hour, last_hour}` (see *Event detail* below; since 2026-10) |
| `stats` | the statistics index: `{path, url, head_seq, format}` (see *Statistics* below; since 2026-11); present only when this run published the statistics and they passed their check |

`partitions[]` overrides `archives[]` for any day present in both.

### `GET /v2/manifest.json` — signed catalog

The same catalog, wrapped so a client can trust it from **any** origin (Pages, jsDelivr,
raw.githubusercontent, a mirror):

```json
{ "payload": "<base64>", "sig": "<base64>", "kid": "feed-2026c" }
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
| `origins[]` | `{id, base, max_object_bytes?, mutable_only?, frozen_only?}` — prefixes a `path` is appended to: `pages`, `jsdelivr-sha`, `raw-sha`, `raw-data` (head only), `release`. For a partition, `pages` serves the unfrozen days (and, from the merge of PR #154 (2026-11-16, the port of #120), for a day, the day that froze last; an older frozen one is a 404 there: take `jsdelivr-sha`); from the merge of PR #154 (2026-11-16, the port of #120) `jsdelivr-sha`, `raw-sha` and `raw-data` serve a day partition only once it is frozen and say so with `frozen_only: true` (*Historical day partitions*); an unfrozen partition is a 404 there: take `pages`. `frozen_only` concerns the day partitions alone: every other path on those origins (the `v1/stats` year and area files iOS mirrors from `jsdelivr-sha` and `raw-sha`, the index files) is served as before |
| `status_url` | where `/v1/status.json` lives |
| `summaries` | v1 entries plus `bytes` and `sha256` of the file |
| `partitions[]` | v1 entries plus `sha256`; `frozen: true` means the bytes never change again (a day is frozen once it is older than the 10 days the 5-minute run can still revise, delete or add to — see *Late publications*) |
| `tiles` | the offline region bundle `{version, url, sizeBytes, sha256}` (from `region-tiles/regions-db.json`), or `null` |
| `stats` | the statistics index `{path, url, bytes, sha256, format}`, or `null` when the run published none (see *Statistics*); the index lists every statistics file's `sha256`, so this one signature covers all of them |

Signing keys (raw Ed25519 public key, base64). Trust the signer and the standby; a retired key must not be trusted:

| `kid` | public key | status |
|---|---|---|
| `feed-2026c` | `XZDJ7WeMnQd1bziaAJGt/tu8n5+Z/taWj+sOjb3cFUo=` | signer since 2026-09-26 (first envelope 04:45 UTC, derive run 36218629756) |
| `feed-2026d` | `NvhpNHdWYEi1cyuc5G51KDRqW//JwRRrqcXtopHzRLc=` | standby (trusted, not signing) |
| `feed-2026a` | `d3VM4u2RaSbJ7BC3HPI8PX9XCS7xTlUHA5hRKID9hKo=` | retired 2026-09-26 (signed from 2026-09-06): do not trust |

Before publishing, each run checks the envelope against the published key of its `kid` (`envelopeKeyCheck` in
`src/manifest-v2.ts`, whose `FEED_PUBLIC_KEYS` this table must match: `tests/manifest-v2.test.ts`). On a mismatch no
v2 manifest is published in that run, v1 still is, and the run fails.

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
(NDJSON, same full-fat Features, one per line). The live events carry `review_status` on every day since 2026-11-08,
the partitions only from a fixed day on (see *Review status*).

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
every window event above it. Two kinds of change move no seq: a revision of a provider row that does not represent its
event can still change the event's compact feature through the fill-only fields (`updated`, `author`, `magAuthor`,
`tsunami`, ...); and the onboarding of a newly added source (README) can add an event to a window day with the head of a run
that appended nothing, which is the previous derive's. derive compares each window event's line with the one the
previous run wrote (an event with no line counts only on a day whose previous lines are known whole) and keeps such
an event for a day in `knowledge/index/live_silent.json` with the previous run's head (`head_before`); every delta whose
`from_seq` is at most `head_before` carries it. The previous run's lines are its day partitions rebuilt from the event
map it read, or, for a day a failed run changed, the previous run's Pages copy, each only when its sha256 is the one
that run recorded (*Repository size*, phase 2). A day without either (a failed derive whose Pages deploy also failed;
the run logs a warning) has no comparison for that run: its silent changes reach the day files (step 3) but not that
run's deltas. Events that leave the window and retired markers that stop being
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

### `GET /v1/live/month.json` — month index (incremental refresh of the month under the week)

The M ≥ 2.5 month that `all_month.geojson` carries, older than the live week, in the live index's form (PRB-2's last
piece, round 27). `all_month` is one ~9.5 MB file (~1.1 MB brotli) whose bytes change on every 5-minute run, so a map
that shows the month under the live week downloaded all of it on every refresh. The index lists `days[]`:
`{date, path, url, count, bytes, sha256}` for each UTC day from the first day the month window reaches (the day of now
− 30 days, `window_days`) through today − 6 (`newest_offset_days`). Each `/v1/live/month/YYYY-MM-DD.geojson` is a
compact `FeatureCollection` with exactly the features `all_month` carries for that day (live events, plus the events
retired in the last 48 h flagged non-live, see *Retired events*) at its floor `min_mag` (2.5; it stays at 2.5 should
`all_month` ever climb the size ladder), for the whole day, with no run clock inside (`metadata.generated` is the newest
`ingest_time` among its features), so its `sha256` changes only when that day's events do. `count` counts live events;
`features_format` is the live index's. There are no deltas.

How to use it: keep the day files you fetched and their `sha256`. On a refresh fetch the index (7 KB, ~1.7 KB
compressed), fetch only the days whose `sha256` differs from your copy, replace those days whole, drop the days that
left the list, and filter by your own window (`time >= now − 30 days`, as `all_month` does: the oldest day reaches a
little further back). Take the week from the live index (or `all_week`). The two oldest days of the live window
(today − 7 and today − 6) are in both on purpose: cut the month at your live set's oldest event and an event the live
set drops between two refreshes of the month (also across a UTC midnight) is already held. A day file that does not
hash to the index's `sha256` (a deploy landed between the two requests) is kept but compared again on the next
refresh. When the manifest names no `live_month`, read `all_month`.

Measured over the 943 derive commits of 2026-10-11 18:00 → 10-14 18:48 UTC (each day rebuilt from the committed
partitions; brotli 4 × 1.078, the ratio Pages served `all_month` at): the first sync is 976 KB; after it a refresh
moves the index and 0.22 changed days on average, 10 KB every 30 minutes, 25 KB after 2 h, 57 KB after 8 h and 93 KB
after 24 h, against ~1,100 KB of `all_month` every time (99 %, 98 %, 95 % and 92 % less). Days newer than today − 6
would add today's and yesterday's files, which change on nearly every run (96–349 KB a refresh). The review replay
(writeLiveMonth itself at 17 derive commits of 2026-10-08 → 10-14, brotli 4 × 1.078) found the same order with more
spread: 30-minute refreshes of 1.7–87 KB (25 KB mean over 7 pairs; 3 of them moved one or two day files of ~40 KB
each), 87 KB after 2 h, 123 KB after 8 h and 165 KB after 24 h on 10-13/14, against 1,051–1,098 KB of `all_month`
(85–99.8 % less); every `all_month` feature of the days was held byte for byte (0 missing, 0 different), the only extra
features are the oldest day's hours before now − 30 d, and Pages served a live day file at 1.049 × brotli 4. Building
the index adds ~0.6 s to derive. `all_month` and the other summaries stay as they are. Schema:
`schema/live-month.schema.json`.

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

**`moved`** (share links, 2026-11): a foreign member of the FeatureCollection, present only when the hour has an
entry: `"moved": {"<feed id>": {"to": "<live feed id>", "hour": "YYYY-MM-DDTHH"}}`, keys in feed-id order. A feed id's
first 10 ULID characters are the time it was minted at (the minting report's origin rounded to 30 s; *Resolving a shared
id* below), so an id names its hour, but only as a hint: the rounding can cross an hour, a revision can move the origin
while the id stays pinned, and an id shared in a quake's first minutes is often retired (`superseded`) when the agencies'
solutions fold together. The file of an id's **ULID hour** therefore lists, under `moved`, every id whose ULID hour it
is but which is not among its features: each retired id whose final live survivor is in a detail file (`to` = that
survivor after following the whole `superseded_by` chain, `hour` = the survivor's hour) and each live event whose origin
hour is another hour (`to` = the id itself). Tombstoned ids, ids retired into a tombstoned or unknown event and ids
whose ULID hour is outside `first_hour` … `last_hour` are not listed. Built from the run's whole event map (45 days,
every state) on every derive, nothing persisted, so any id of the window resolves in at most two hour reads: its ULID
hour, then the hour `moved` names, which holds `to` as a feature. `validate.ts` checks every entry: a feed id whose ULID
hour is the file's, not a feature of the file, `to` a feature of the hour `hour` names.

Measured on `data` ba509fd5a33 (2026-11-09 04:47 UTC; 51,273 event-map nodes, 1,085 hour files): 1,940 entries, 1,492
retired ids and 448 live ids whose origin left their ULID hour, in 632 hour files; 192,560 bytes over all the hour files
(about 300 bytes in an hour that has entries); building the map takes about 50 ms of derive.

Why hours: on 2026-10-06 the 46 published days held about 54k live events; a file per event would be 54k files, past
Cloudflare Pages' 20,000 files per site on the free plan (developers.cloudflare.com/pages/platform/limits, read
2026-10-06); hours are 1,104 files (the deploy goes from 69 to about 1,170 files and from 145 to 258 MB, derive from
2.5 to 3.1 s). A feed id → byte range index into the day files would need no new files, but Pages serves the day
files compressed, and a range of a compressed body is not a range of the JSON.

### `GET /share/event/<feed id>` — share pages

The page a shared event link shows to a person without the app and to a messenger's link-preview bot (share links,
2026-11). The app shares `https://theshelter.app/event/<feed id>`; the site answers that path with one static
`_redirects` rule, a `302` to `https://earthquakes-feed.theshelter.app/share/event/<feed id>` (a fixed host, the id
only in the path), and Pages serves `share/event/<feed id>.html` from this project. Nothing runs anywhere: no Worker or
Pages Function, so a shared link on a big-quake day costs no request quota. With the app installed and the site's
association file claiming `/event/`, the link opens the app and never reaches HTTP.

**Which ids have a page.** Every derive writes one page per **live** event of the detail files' window (*Event
detail*: the event map's days through now + 10 minutes) that is significant: magnitude 4.0 or more as shown (one
decimal), or `felt` ≥ 1, or a tsunami flag, or a PAGER alert (`alert` green, yellow, orange or red). The same bytes are
also written under each **retired** id whose final live survivor has a page, so a link shared before a fold keeps its
preview; its canonical URL is the survivor's. At most `SHARE_PAGE_CAP` = 5,000 pages, the most significant first (PAGER
level, tsunami flag, magnitude, felt reports, then the newer event), an event always with all its retired ids. Every
other path under `/share/event/` gets `share/event/404.html` with status 404, the **fallback page** (below). The ids are case-sensitive (Pages paths are): a lower-case id answers the same fallback page, so a link must carry the id as the feed wrote it (the app emits canonical upper-case links). A page leaves with its event (after about 45 days, a
tombstone, a magnitude revised below 4.0); a link then shows the fallback page.

**The fallback page** (`share/event/404.html`, `notFoundPageHtml`; owner decision 2026-11-17). Most links that reach it
are real: an event below the bar (under M4.0 as shown, no felt report, no tsunami flag, no PAGER alert), older than the
45-day window, past the cap, or too new for the last derive. So it is a pointer to the app, not a "not found". Its
headline is true for most links, not every one: a link past the app's own resolve window (*Resolving a shared id*,
step 5: an M < 5 older than 61 days, an M5–6 older than the current year and the two before it), a tombstone, or a
mistyped or crafted id lands here too, and the app then says the event is no longer available (the page cannot tell
these apart: it reads nothing from the URL; the copy is the owner's choice). It says
"This earthquake is in the Shelter app"; the web has a detailed page only for significant earthquakes of about the last
45 days (`EVENT_MAP_HORIZON_DAYS`), the app shows every earthquake in its feed; with the app installed the link opens
in it; a "Get Shelter on the App Store" button (`https://apps.apple.com/app/id6767608845`, the link every share page
carries; it answers 404 until the store page is live and needs no change then: an open owner item, checked at release,
since the button is the page's main action), a link to `https://theshelter.app/`,
the Smart App Banner without an `app-argument`, `og:image` `generic.png`, `noindex`, the same stylesheet and headers as
an event page (the CSP allows no script). The page is one constant: it shows no id, no date, no year and nothing else
taken from the URL, so a crafted link gets the same page and can put nothing on a preview; every link is absolute (it
is served at any id's path). English only, like the site. It stays Pages' not-found page for `/share/event/`, so the
status stays **404** (*Limits*: some preview bots draw no card for it; those that do show the fallback's title,
description and the generic card).

**What a page shows**, only from the feed's event, never from the URL: the magnitude (`M 6.4`), the place, the origin
time in UTC (`9 November 2026, 03:34 UTC`), the depth, the number of agencies that reported it, the chosen agency's own
event page when its solution carries a `url` that parses as `https:` on an allow-listed host (exactly
`earthquake.usgs.gov` today: no other source sends a `url`), an "Open in Shelter" link and the Smart App Banner
(`app-id=6767608845, app-argument=https://theshelter.app/event/<id>`), the App Store badge
(`https://apps.apple.com/app/id6767608845`), and a data line naming the chosen agency and the others' count with a link
to `ATTRIBUTIONS.md`. The place is shown only when, after NFC normalization, it is Latin letters (never the fullwidth forms
U+FF00–FFEF, at most two combining diacritical marks U+0300–036F on a letter, no other mark), printable ASCII and a few
typographic marks, at most 80 characters, with no control, format or bidi character (U+200B–200F, U+202A–202E,
U+2066–2069 and the rest of Unicode's `C` categories reject it); otherwise the page shows the coordinates
(`near 10.9°S 165.6°E`, the hemisphere of the rounded value, `0.0°N 0.0°E` at zero). Every value is
HTML-escaped; there is no script and no form. `canonical`, `og:url` and the banner's `app-argument` are
`https://theshelter.app/event/<id>`; `og:image` is the site's static card for the magnitude band,
`https://theshelter.app/og/event/{lt3,3,4,5,6,7}.png` (below 3, then by whole magnitude, 7 and above) or `generic.png`
(1200 × 630); `noindex` in a meta tag and in `X-Robots-Tag`. The bytes hold no run clock: a page changes only when its
event does, so a deploy uploads only the pages that changed.

**Headers** (the `/share/*` rule of `_headers`, `src/pages-headers.ts`; the only rule that reaches `/share/`):
`Cache-Control: public, max-age=300`, `Content-Security-Policy: default-src 'none'; img-src https://theshelter.app;
style-src 'sha256-<hash of the one stylesheet>'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`. The CSP allows the page's
single `<style>` element by its sha256 (`PAGE_CSS` in `src/share-pages.ts`; no element carries a `style` attribute) and
blocks every script on purpose, Cloudflare's injected ones included: never add `script-src`.

**Checks.** A share page never stops the live feed. The page check (`sharePageProblem` in `src/share-pages.ts`) rejects a
page holding a script, a `style` attribute on an element (escaped text that reads `style=` is fine), a stylesheet other
than the hashed one, or, for an event page, no canonical `https://theshelter.app/event/<feed id>` and banner for it;
the fallback page must also name no feed id and show no year. derive leaves out an event whose page the check rejects,
with its retired ids (`::warning::share page <id> left out: <why>`); a throw in the page writer, or a rejected generic
page, drops the run's share pages (`::warning::share pages dropped`) and the links get Pages' plain 404 until the next
run. `validate.ts` (the deploy gate) fails only on more than 5,000 pages or a `_headers` without the hashed CSP; it
re-runs the page check on the deployed files and warns on a page the check rejects or not named by a feed id and on a
missing generic page, and it warns when the deploy's other files plus the full cap would pass 75 % of Pages' 20,000
files.

**Limits.** The fallback page answers with status 404 (`share/event/404.html` is Pages' not-found page for the
directory; a static Pages file cannot choose its status). A person's browser shows the page whatever the status. Some
link-preview bots (Telegram, iMessage, Facebook) draw no card for a 404 and cache that, so a link without a page (and
one shared before its event has a page: an event in its first minutes, before the next derive) may keep no preview
there; bots that read a 404's tags show the fallback's title and the generic card.
Pages treats a project without a top-level `404.html` as a single-page app; the nested `share/event/404.html` lookup was
checked on wrangler's Pages asset server, and an unknown `/share/event/efd_…` on a Pages preview deployment must answer
the generic page before the site's `/event/*` redirect relies on it.

Measured on `data` ba509fd5a33 (2026-11-09 04:47 UTC, the 46 event-map days): 3,437 pages (3,040 live events, 397
retired ids; the cap left none out; the page check rejected none), 138 of them with the coordinates instead of the
place; 17.2 MB in all (6.2 MB gzip, 4.9 MB brotli), a page 4,750–5,268 bytes (median 5,047), the generic page 4,229
bytes (the fallback page 4,429 bytes since 2026-11-17). Writing and checking them adds about 0.4 s to derive (0.5 s with `moved`). The deploy grows from about 1,330 to about 4,770 files (24 % of the 20,000 a
Pages deploy may hold; about 6,330 at the cap).

#### Resolving a shared id

What the app does with `https://theshelter.app/event/<feed id>` (or `theshelter://event/<feed id>`). Only data read
from the feed by the id is ever shown; nothing derived from an id that was not found (a crafted ULID can claim any
date).

1. Accept only `^efd_[0-9A-HJKMNP-TV-Z]{26}$`. Its **ULID time** (the first 10 characters after `efd_`, Crockford
   base32, most significant first, in ms since the epoch) is the 30 s bucket the id was minted at: a hint for the hour,
   day and year, never the event's time.
2. **Hour files** (`manifest.event_detail`, the last ~45 days): read the ULID hour's file. The id is a feature: done.
   It is in `moved`: read `moved[id].hour` and take the feature `moved[id].to` (one hop; `to` is live, show `to`'s
   data). Neither: read the hours either side (the bucket's rounding) and look again, features then `moved`. An hour
   outside `first_hour` … `last_hour` has no file.
3. **Day tables** (`v1/stats/index.json` `days[]`, today − 60 … today): the ULID day's table, and the day either side
   when the ULID time is within an hour of midnight. The id is in `id`: done (a row, all magnitudes). It is a key of
   `collapsed_into`: look up the representative in the same table or the neighbouring day's.
4. **Year M5+ and area M6+ tables** (`years[]` `events`, the current year and the two before it; `area[]` `m6`, 1973 →):
   the ULID year's file, and the year either side when the ULID time is within a day of New Year; the same `id` then
   `collapsed_into` lookup (the representative is a row of the same table). Across New Year an id can be a row of one
   year's table and a `collapsed_into` key of the other's (two reconciliations with different context): take the row.
   Files of builder 2 have no `collapsed_into` (read it as empty).
5. Not found: the event is no longer available (an M < 5 older than 61 days, an M5–6 older than the current year and
   the two before it, a tombstone, an id the reconciliation left out as out of region, or no such event).

### `GET /v1/stats/index.json` — statistics

What a statistics screen reads instead of whole day files or ComCat (since 2026-11; the `providers/stats.json` switch
`derive_publish` is `"off"`, `"shadow"` — built and checked in the runner, never deployed — or `"on"`). Every derive run
writes the index and the day tables; the year and area files are built by the stats builder (`stats.yml`), committed on
the `data` branch at the same path and copied by derive byte for byte, only when the builder's ledger
(`knowledge/stats/state.json`) names their `sha256`. All files are JSON (served brotli; the `sha256` and `bytes` name
the decoded bytes), keys in a fixed order, no run clock inside a table, year or area file: the same events give the same
bytes. Schemas: `schema/stats-index.schema.json`, `stats-table.schema.json`, `stats-year.schema.json`,
`stats-area.schema.json`.

**How to use it.** Verify the v2 manifest, take `stats.url` and check the index's bytes against `stats.sha256` (and
`index.generated == manifest.generated`; the v2 edge cache is 60 s, so on a mismatch read the manifest once more, then
keep your last verified index). Keep the files you fetched with their `sha256`; fetch only the entries whose `sha256`
differs from your copy, drop the files the index no longer lists. A day, year or area file that does not hash to its
entry is not used. Entries marked `mirrorable` are byte for byte the `data` branch file at the same `path`, so the v2
origins `jsdelivr-sha` and `raw-sha` serve them too (a mirror at `data_commit` may hold older or newer bytes: the
`sha256` decides). Day tables exist on Pages only.

**Index** (`v1/stats/index.json`):

| Field | Meaning |
|---|---|
| `schema_version`, `format` | `1`, `1` |
| `generated`, `generated_iso`, `head_seq` | the run, equal to the v1 manifest's |
| `days[]` | `{date, path, count, filtered, bytes, sha256}` for each UTC day today − 60 … today, oldest first; a day missing here is named in `missing_days`. Today's table holds the day so far: before its first event, in the first 30 min after 00:00 UTC, it is an empty table (`count` 0), not a missing day |
| `missing_days[]` | window days with no table this run (neither in the 45-day event map nor as a partition on `data`; today only once it is 30 min past 00:00 UTC without an event): count them as missing, never as quiet |
| `through` | the last day the year and area files cover (the stats builder's last frozen day), or `null` before its first run |
| `years[]` | `{year, path, bytes, sha256, first, through, complete, mirrorable}`: the current year and the two before it (in early January, until the new year's first day freezes, the year before and the two before that: the year of `through` and the two before it) |
| `area[]` | `{year, path, bytes, sha256, min_mag, records, m6, complete, mirrorable}`: one per year from 1973 |
| `completeness[]` | `{from, to, key, min_mag?}`: the completeness regimes (`eraB` 1973–1999 M4.5+ from USGS ComCat, `eraA` 2000 → 2023-07-06 17 sources, `archives` → 2026-07-05, `live` since). A count compared across two regimes is compared on M4.5+ only |
| `attribution` | the licence line |

**Row rule** (`src/stats-table.ts` `statsEventOf`, the same for every table): a feature counts only when
`feed.state == "live"` and not `feed.tombstone`. A live event whose `type` names another kind of event (the app's
`isNonEarthquake`: the EMSC/QuakeML codes `km sm kx sx kn sn kr sr qb ls sb` and the words blast, explosion, quarry,
mining, mine collapse, rock burst, ice quake, landslide, rock slide, sonic boom, collapse, avalanche, meteor, acoustic
noise, not existing, other event, volcanic eruption) is **filtered** (counted by its time). One without a magnitude in
[−2, 10.5], without a valid position, or the 0,0 M0 placeholder (*Retired events*) is **skipped** (counted). Every other
live event is a row: `status` is the review status of its chosen provenance row (*Review status*: 1 reviewed, 0
automatic, null when the source does not say), `upd` is 1 when `updated − time` is more than 3,600,000 ms (0 otherwise,
null without `updated`), `delay` the seconds from origin to the feed's `first_ingest_time`, `intensity` `mmi`, else
`cdi`. Event identity is the feed's merge alone (*Realtime + client dedup*, *Re-merged history*); the year and area
files count an input that is not yet re-merged after running that same merge over it (below). The statistics products
then apply one more step of their own, the reconciliation.

**Reconciliation** (rule `v3`, `reconcileRows` in `src/stats-table.ts`; statistics products only). Even merged, the
feed keeps some quakes as several events: agencies place and size one quake differently, and the merge (an identity
rule: it must never join two real quakes) leaves such reports apart. Counted as they are, they put M6+ 1.2–1.7× above
USGS ComCat. The statistics collapse them at catalogue level, which is explicitly not event identity: the events, the
day partitions, the live map and the detail pages are unchanged. Two live earthquake rows link when all of these hold:
they share no provenance provider (a provider's own catalogue is self-consistent, so two events that share one never
collapse), their origin times are at most 60 s apart, and one of them is M4.5+, with limits in two tiers by the larger
magnitude of the two: below M7.0 epicentres at most 100 km and magnitudes at most 1.0 apart; M7.0 and above (great
quakes, whose locations and magnitudes scatter more between agencies) at most 200 km and 1.5 apart (all on the scaled
integers: `mag × 100`). Rule `v1` (2026-11-08) had the first tier only.

Before any link, rule `v3` applies the **authoritative-region filter**, USGS ComCat's own catalogue practice (a
regional network is authoritative for its own region, a global network everywhere; ComCat prefers a contributing
network's solution only inside that network's authoritative region): an M4.5+ row is left out, counted as
`out_of_region`, when none of its provenance providers is a global network (`usgs`, `emsc`, `isc`, `geofon`; config
`STATS_GLOBAL_PROVIDERS`) and its epicentre lies outside the authoritative region of every provider that reported it.
The regions (config `AUTHORITY_REGIONS`, keyed by catalogue, so RESIF and IPGP are judged by RéNaSS's) are the alerts
gateway's national boxes, plus coarse national boxes for the catalogues the gateway trusts nowhere (RéNaSS: France,
the Lesser Antilles, Réunion and Mayotte; ETHZ, KNMI, LMU, USP, GeoSphere), each widened by 5° on every side so that
an event near a border stays. A provider with no region counts as global. So a row holding a ComCat solution is never
left out, and nothing below M4.5 is (a local network is authoritative for its small quakes). The test is
`src/authority.ts` `outsideAuthority`, the one the merge's authoritative-region window (dedup epoch 2, *Re-merged
history*) uses too, so both agree on which events are a regional agency's solution of a distant quake. These rows are regional
networks' teleseismic solutions of quakes far outside their networks: in 2013 RéNaSS/RESIF solutions of the Santa Cruz
Islands aftershocks at M6.1–6.6 that ComCat lists smaller, or a 2013-10-25 M7.8 twenty minutes off ComCat's M7.1. Links are taken closest first (time gap,
then distance, then ids) and join two groups only while the groups share no provider (single link under that
constraint). Each group keeps one row, its representative: the member holding a `usgs` provenance row (ComCat's
magnitude is the reference), else the member whose chosen provider ranks first in the registry's provider `priority`
(as the merge ranks), then the earliest origin, then the smallest feed id; the others are left out and counted. derive
reconciles the rows of its whole 61-day window together, with the day before the window as context (never a table),
before writing the day tables, so a pair across midnight counts once, the oldest day's too; the stats builder reconciles each year with the day before and the day after it as context. Counters:
`collapsed` and `out_of_region` in each day table, `days.collapsed` and `days.out_of_region` per day and
`reconciled: {rule, collapsed, out_of_region}` in a year file, `reconciled: {rule, collapsed, out_of_region}` in an
area file. Which row a collapsed id folded into: `collapsed_into` in the event tables (below), so a shared id the
reconciliation left out still resolves (*Resolving a shared id*).

**Event table** (format 1, shared by the three file kinds): `{format, kind, t0, count, providers, id, t, lat, lon, mag,
…optional columns}`, rows sorted by (time, id). `id` is the feed id (`efd_…`, the feature id). `t` holds ms deltas:
`time[i] = t0 + t[0] + … + t[i]`. Integer scales: `lat`/`lon` × 10⁴, `mag` × 100, `depth` km × 100, `intensity` × 10,
`rms` × 1000, each `Math.round` (half toward +∞); compare thresholds (M4.5, M5, M6) on the scaled integers. `prov[i]`
indexes `providers` (the sorted chosen providers). Optional columns, an absent one meaning all null: `depth`, `place`,
`prov`, `felt`, `intensity`, `alert`, `tsunami` (0/1), `status`, `upd`, `nst`, `rms`, `delay`. A day table carries all
of them, a year table all but `delay`, an area table `depth`, `place`, `prov`. After the columns, `collapsed_into`
(share links, 2026-11): `{"<feed id>": "<representative's feed id>"}`, keys in feed-id order, for rows the
reconciliation collapsed (never a row of the table itself). A day table lists every collapsed row of the day (its
representative is in that day's table or, across midnight, the neighbouring day's; for the oldest day that can be
the day before the window, which has no table: the event is then no longer available). A year table's `events` (M5+) and
an area table's `m6` (M6+) list every row the year's reconciliation collapsed into one of the year's own rows at or
above the table's floor, whatever the collapsed row's own magnitude (the live map may share a member's id rather than
the representative's): the representative's row is always in that same table. The collapsed row is of the year or,
across New Year, of the day before or after it (the build's context); a row of the year collapsed into a row of the
neighbouring year is listed by the neighbouring year's table, when that year has one (year files cover the year of
`through` and the two before it, area files every year). Absent in year and area files of builder 2:
none listed.

**Day table** (`v1/stats/days/YYYY-MM-DD.json`): the event table of `kind: "day"` with `date` (after `kind`),
`t0` = the day's 00:00 UTC, plus `filtered` (the filtered events' times, ms from `t0` each, ascending), `skipped` (a
count), `collapsed` and `out_of_region` (counts: rows the reconciliation left out) and `attribution`. `count +
filtered.length + skipped + collapsed + out_of_region` = the day's live, non-tombstoned features, and `collapsed_into`
(always present in a day table) has exactly `collapsed` entries: 208 over the 46 event-map days on 2026-11-09, about
70 bytes each (14.6 KB in all). The day tables
of the 45 event-map days are built from the run's own events; today − 60 … today − 46 from the frozen partitions on
`data`. A day's bytes change only when its events do: ~140 KB a day, 8.6 MB for the 61 days on 2026-11-08 (2.8 MB at brotli
quality 4: the random part of the feed ids does not compress), so a first sync is a few MB and a refresh moves the index
and the days that changed (today, yesterday, a revised day).

**Year file** (`v1/stats/year/YYYY.json`): `{format, kind: "year", year, builder, first, through, complete,
mag_edges_e2: [200, 250, 300, 350, 400, 450, 500, 600, 700], provider_names, days: {total, filtered, collapsed, out_of_region,
bins, providers, missing}, events, reconciled, inputs_digest, attribution}`. Per day of the year from `first` through `through`: `total` rows,
`filtered`, `bins` (10 counts: < 2, [2, 2.5), … [6, 7), ≥ 7; `atLeast[m]` is the sum of the bins whose lower edge is
≥ m), `providers` (indexes into `provider_names`), and `missing` (day indexes with no input). `events` is an event table
of the M5+ rows. Days after `through` come from the day tables.

**Area file** (`v1/stats/area/YYYY.json`): `{format, kind: "area", year, builder, min_mag, through, complete, cell_deg:
0.1, records, cell, total, m45, mmax, m6, reconciled, inputs_digest, attribution}`. One record per occupied 0.1° cell: `row =
min(1799, floor((latE4 + 900000) / 1000))`, `col = floor(((lonE4 + 1800000) mod 3600000) / 1000)`, `cell = row × 3600
+ col` (centre `−90 + (row + 0.5) / 10`, `−180 + (col + 0.5) / 10`); `cell` is delta-coded and strictly increasing
below 6,480,000. `total` counts the rows, `m45` the M4.5+ rows, `mmax` the largest `mag × 100`; `m6` is an event table of
the M6+ rows (exact positions). `min_mag: 4.5` (era B) means every record is M4.5+ (`m45 == total`). A radius count over
cell centres is approximate (median 0.5 %, p90 3.4 % at 100 km); the M6+ rows are exact.

**How the year and area files are built** (`stats.yml`, `src/stats-history.ts`, every 6 h while `providers/stats.json`
has `history_enabled: true`). They run through `through`, the last frozen day (today − 11); later days come from the
day tables.

- **Inputs per day, first match wins:** the day's current remediation edition (*Saturated days*; it supersedes the
  archived day and the partition), the frozen day partition on `data` (by its git blob), the archive month that lists the
  day, the current deep-history edition that lists it (*Deep history*; era B editions carry `min_magnitude: 4.5`). A
  year with a day that has no input waits (the era B walk) and is not published.
- **Rebuild:** a year is rebuilt when the digest of its inputs changes: sha256 of the canonical JSON of the builder
  version, the format and reconciliation rule, the re-merge epoch and rules, `through` and every input's `{kind, key, sha256 or blob}` (plus the inputs of
  the 7 days on each side when the year is re-merged in memory). A new frozen day rebuilds the current year; a re-merged
  archive or edition, a new remediation edition or a re-roll rebuilds its year with no other action; a builder bump
  rebuilds them all. The current year and the two before it first, then newest first, at most `max_years_per_run` a run.
  Builder 3 (2026-11, share links) adds `collapsed_into` to the year and area tables: the bump changes every year's
  digest, so the scheduled runs rebuild all 54 years (1973 → 2026) by themselves, 6 a run (`max_years_per_run`), each
  checked against ComCat as usual; the cron delivers about 4 runs a day, so the paced rebuild takes 9 runs, about 2–3
  days. Each run builds 6 years in about 4–8 minutes (the builder 2 rebuild of 2026-11-08 took 1,262 s for 57 year
  builds, 16–102 s a year, the current year the slowest), inside `budget_minutes`. Until a year is rebuilt its files
  stay builder 2, without `collapsed_into`; a year that fails its gate keeps them. Dispatching `stats.yml` with
  `max_years: 60` (not a dry run) instead takes two runs of under 25 minutes each: `budget_minutes` (20) stops a run from
  starting more years (on 2026-11-08 the first such run built 43 years in 18 minutes, the next the other 14).
- **The in-memory re-merge** (owner decision A6): an input below the re-merge epoch or rules (an archive or edition
  without `merge_epoch` ≥ 1 and `merge_rules` ≥ `REMERGE_RULES` — except an edition of a single source, era B, which has nothing to fold —, a remediation edition
  not refreshed on its month's merged asset, every frozen partition) still holds the split
  duplicates the merge-off paths made. The builder runs the feed's own `remergeNodes` (*Re-merged history*) over each
  such month in memory, after the same input normalization (`normalizeRows`, *Re-merged history*: AFAD rows stored 3 h
  early re-timed, untrusted ISC magnitudes dropped) — the month's days as the unit, the 7 days before it as frozen and the 7 days after it as pinned
  context, each read from its own input, the fixed `REMERGE_INGEST_TIME` — and counts the result. The ledger records
  `remerged_in_memory: true` for such a year; once the merged assets are published, their checksums change the digest
  and the year is rebuilt from them. The epoch the statistics count at is at least 1 whatever `REMERGE_EPOCH` says.
- **Known gap across New Year (AFAD):** an event of AFAD rows only that the pre-2026-10-01 parser stored 3 h early
  (*Turkey (AFAD)*) at 21:00–24:00 UTC on 31 December is re-timed into 1 January by the normalization, but stays in
  31 December's input (a merged archive keeps an event in its stored day, `stats.off_day`; the in-memory re-merge reads
  that day only as context of the next year). Neither year counts it: a year leaves out a row timed outside its days,
  and the next year reads 31 December only as context. That is at most the AFAD-only events of three hours a year,
  small Turkish quakes; it is documented rather than counted, since counting them would change how every year reads
  its inputs (a builder bump and a rebuild of all years) for a handful of rows.
- **Era B** (1973–1999, USGS ComCat M4.5+): rows under M4.5 and the filtered events are left out, so `min_mag: 4.5` and
  `m45 == total`. Compare a count across the `completeness` epochs on M4.5+ only: the number of contributing agencies
  grows from one (era B) to 17 (era A, 2000 → 2023-07-05), more with the archives (→ 2026-07-04) and about 40 live.
- **ComCat gate:** before a rebuilt year's files are written, its M6+ (the `m6` rows) and M4.5+ (Σ `m45`) are compared
  with `count?eventtype=earthquake` over `[Y-01-01, min(Y+1-01-01, through + 1 day))`, one request at a time, at most
  0.5 a second. Era B must be within ±2 %, later years within the `gate` bands of `providers/stats.json` (M6+ ratio
  0.85–1.20, M4.5+ 0.85–1.40); the open current year only warns, and its warning names the cause first: `late ComCat`
  below a band (ComCat's late publications, *Late publications*), `split copies` above one. A year that fails keeps its previous files (a first
  build stays absent) and is not retried until its inputs change; every real run names each year whose ledger entry
  failed in its marker `walk-blocked-stats`, which reaches the health board (`walks:stats:run`), and a run with
  nothing blocked uploads a marker with only a `#` line, which resolves the board entry on the next health run. A
  ComCat count that fails (an outage: gate `error`) is no verdict on the year: it keeps its previous files, is retried
  on the next run and is listed under *Deferred* in the run's report, not in the marker (an outage of days stops
  `through` and shows as `feed:stats-through`). An outage never clears a standing gate failure: the year keeps its
  `fail` verdict and stays in the marker; on the inputs that failed it is not deferred, since it is not retried. A dispatch's `years` naming a year with nothing to build (after the
  year of `through`, or with no input on any day) gets a `::warning::STATS_YEARS` line.
- **Ledger** `knowledge/stats/state.json` on `data` (derive reads `through` and each file's `sha256` from it):
  `{version, builder, through, generated, run_id, years: {Y: {inputs_digest, through, complete, area: {bytes, sha256,
  records, m6}, year?: {bytes, sha256}, check: {gate: ok|warn|fail|error, era, window, feed, comcat, ratio, bands},
  remerged_in_memory, collapsed, out_of_region, inputs: {remediation, partition, archive, edition, unmerged_months}, dup_suspects: {count, n45,
  ratio, sample}, months: {YYYY-MM: {n45, m6, dup}}, failed_digest?, error?, waiting?}}}`. `dup_suspects` (diagnostics
  only) counts pairs of M4.5+ rows of different chosen providers within 60 s and 100 km: splits the merge left.
- **Verify:** a dispatch with `verify: sample` (the last 13 months and 6 older ones) or `full` (every month) compares
  each month's M4.5+ and M6+ with ComCat in the run's summary and `report.md`; a failing month adds a
  `stats-verify-failed` line to the marker. A month below ComCat that ends within 45 days of `through` is noted
  `late ComCat, settles within 45 days` (it still fails).

Versioning: a new optional column or field keeps `format: 1`; an incompatible change is a new directory and a new
manifest key `stats2`, with `stats` kept for a deprecation window.

### Historical day partitions (full history)

One Feature per line (NDJSON), all states (`live`/`tombstoned`/`superseded`), every
line full-fat. Resolve the path and freshness from `manifest.partitions[]`:

```bash
# an unfrozen day (the last 11 days): its `url`, the Pages copy, always the current bytes:
curl -s "https://earthquakes-feed.theshelter.app/events/$(date -u +%Y/%m/%d).ndjson"
# immutable (cache forever) — use manifest.data_commit for a frozen day:
curl -s https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@<data_commit>/events/2026/07/04.ndjson
# via branch (12 h cache), any frozen day; jsDelivr can answer 403 here (its `data` package is past its size limit,
# only files it cached still serve), so prefer the @<data_commit> form above:
curl -s https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/events/2026/07/04.ndjson
```

Since 2026-10 every unfrozen day (`frozen: false`: today and the 10 days before it, the days the 5-minute run can
still change) is also on Pages at `/events/YYYY/MM/DD.ndjson`, the bytes of the `data` branch file (the v2 manifest's
`sha256` covers both), and its `url` names that copy (`max-age=0, must-revalidate`: an ETag check, a 304 when
unchanged). A frozen day's `url` is the immutable jsDelivr `@<data_commit>` copy in both published manifests (the v2 one
since 2026-11-15, the v1 one since 2026-11-16; before, v1 named `@data`, where jsDelivr can answer 403 for a file its
branch package no longer holds); the `manifest.json` committed to the `data` branch keeps `@data` and `data_commit:
null`, since it cannot name the commit it is part of. `pages_url`, the
GeoJSON day file, is unchanged.

**From the merge of PR #154 (2026-11-16, the port of #120), `@data/events/...` holds a day only once it is frozen.** The 5-minute run stops committing
the unfrozen days to the `data` branch (*Repository size*, phase 2): a day is committed once, by the first run after it
freezes (and again only on a rare heal, remediation or re-roll), and the first such run deletes the unfrozen days the
branch held (history is not rewritten). For an unfrozen day use the manifest: `url` / `pages_url`, or the v2 `pages`
origin; a jsDelivr `@data` / `@<sha>` or raw.githubusercontent URL of an unfrozen day built by hand answers 404 (or an
old copy from jsDelivr's cache). The v2 origins that read the branch carry `frozen_only: true` (day partitions only: the
statistics files and every other path on them are unchanged). jsDelivr `@data`
resolves the branch to a commit it caches for up to about 12 hours, so for that long after a day freezes `@data` may
not have it yet: the day keeps its Pages copy, and its `url` stays on it, for one day after it freezes
(`frozen: true` from midnight; `@<data_commit>` has it from the first commit after midnight). Frozen days,
`data_commit` and every other path stay as they are.

### `GET /v1/status.json`

Last run's per-provider health, counts, timings, `degraded[]` (a provider's `via` names the host that answered when it was the
source's fallback host, see *Greece (NOA)*). Counts include `merged`
(`op:merge` lines), `bad_coords_dropped`, `coordinateless_dropped` (coordinate-less reports
refused at ingest), `coordinateless_withdrawn` (those among them that withdrew a known id, see
below), `coordinateless_retracted`, `late_minted` and `late_withheld` (see *Late publications*), `held_retracted` when a run
withdrew held solutions (since round 26, see *Regional agencies outside their own region*), `rederived` when a run
re-derived an event's representative (since round 27, same section);
the heal run also carries `heal`, and the one-time correction run `correction` (see *Turkey (AFAD)*,
*California (NCEDC, SCEDC)* and *Canada (NRCan)*). `sweeps.updated` / `sweeps.deleted` hold the outcome (`ok`,
`http_status`, `latency_ms`, `events_returned`, `error`) of each source's `updatedafter` revision
query and `includedeleted` delete query in that run, with where the sweep stands: `since` (the
`updatedafter` it asked from), `pages`, `through` (its cursor after the run: the moment the last
complete sweep was sent, so a sweep that did not complete keeps the previous one and the next run
asks for the same window again), `epoch` (the catch-up epoch recorded with that cursor) and
`catch_up: true` on the one-time catch-up run. `sweeps.epoch` is the current catch-up epoch. The cursors live in
`knowledge/index/sweeps.json`; a torn or unreadable file reads as no cursors with a warning, so that run's sweeps catch
up again and it writes a valid file. A damaged heal or correction marker (`knowledge/index/heal.json`,
`correction.json`) stops the run instead, with an error naming the file: reading it as never run would repeat the
one-time step.
A run that loads the whole 45-day event-map horizon (the heal run) asks the sweeps from one day below derive's load
floor (00:00 UTC of the oldest day derive loads); a revision whose origin is below that floor is not applied, since it
would move the event onto a day derive no longer publishes, and the run log names it (`::notice` "Sweep below the derive
floor"). Regular runs ask from 11 days back and never reach it.
`comcat_twins_withdrawn` counts the AEC rows a ComCat delete withdrew in that run,
`twin_withheld` the AEC reports held back beside another source's event, and `absent.aec`
(`count`, the first 20 `ids`) the live AEC ids younger than 10 days that AEC's file no longer
lists (see *Alaska (AEC)*; logged, never retracted). `absent.mexico` does the same for SSN's RSS, which lists only its
last 15 items: only ids younger than the oldest item it still lists are counted. `preliminary_superseded` and
`preliminary_skipped` count SSN preliminary solutions withdrawn or not ingested (see *Mexico (SSN)*). A run dispatched
with the input `recover` also carries `recovered` (see *Late publications*, recovered reports).

**Frozen sources (round 14).** A source whose file is still served but no longer regenerated keeps answering `ok` with
rows, so it is never silent. Each run records the newest origin every answer lists (`providers.<id>.newest_origin` in
`status.json`; not in the status history line, see *Run logs*);
a source whose answer has rows but whose newest origin is older than its query window (2 days, or `lookbackDays`) plus
its frozen budget is **frozen**: listed in `frozen` (by id: `newest_origin`, `newest_origin_age_hours`, `window_hours`,
`budget_hours`, `rows`) and counted in `degraded`. The frozen budget is three activity budgets (36 h for an active agency,
so 84 h in all), `frozenBudgetHours` for a source that lists its last N events and legitimately stands still for days
(216 h: BGS, IG-EPN, CWA; their longest quiet spells 2026-07-05 → 10-06 were 180, 168 and 157 h, the longest among the
other sources without a time window CENC's 59.6 h). An answer limited to a time window can never be frozen. The v2
status adds `providers.<id>.frozen` and `frozenProviders`; the health workflow files a frozen source on the
"[health] feed" board (`feed:source:<id>`, member `frozen`). Pinned sources (FEED-SEC-1) also carry `providers.<id>.tls_leaf` and
`tls_leaves` (of the leaves the host presented in the last week, the first to expire: `not_after`, `days_left`, `issuer`,
`subject`, `seen_at`, `leaves` when more than one; an expired leaf goes once the host presents a valid one), and since
2026-10-13 `tls_errors` (by id: `error`, `since`, `last_at`; a pinned source whose fetch failed on a certificate in the
last 6 hours; while such a source's fetch fails, the health workflow judges it a definite failure, on a 2 h line;
providers/tls/README.md).

**Failing and silent sources.** A provider whose fetch failed has `ok: false` and is in `degraded`. An FDSN answer of
HTTP 204 is an empty success; HTTP 404 is an empty success only for a source whose query asks `nodata=404` (none does
today) and an error otherwise, because it means the query path is gone (before 2026-10-04 every 404 counted as empty).
A custom adapter that asks several files (IPMA's two areas, IGP's year files, BMKG's two lists, CSN's day pages, CWA's
two bundles) fails when every one of them failed, with `<id>: every request failed (<n>; last: <error>)`; some failing
leaves the others' rows, `ok`. IGN fails when its file holds no readable `dias30`. Before 2026-11-16 all of these read as
`ok` with no rows, which only the silence below noticed (FEED-PROV-L3). A source can also answer `ok` with no rows while it has stopped publishing: since 2026-10-04 each run records per
source the last run whose answer had rows (`knowledge/index/provider_activity.json`, seeded once from the status
history), and a source with no rows for longer than its activity budget is **silent**: listed in `silent` (by id:
`last_non_empty_at`, null when none was seen since `counted_from`; `silent_hours`; `budget_hours`) and counted in
`degraded`, while its `providers.<id>.ok` stays true. The budget is 12 h for an active agency (its 2-day query window
is never empty that long), `activityBudgetHours` in `providers/registry.json` for a quiet one (72 h: ETHZ, IPMA, NRCan,
USP) and none for KNMI and LMU (regions that go weeks without an event) or a source the live path does not ask (ISC).
The published v2 status adds `providers.<id>.silent`, `providers.<id>.lastNonEmptyAt` (ms) and `silentProviders`.

**Circuit breaker (SHLTR-147).** A source whose live fetch gets no answer at all (a timeout, an abort, a refused or
reset connection; not an HTTP error status, not an empty answer, not a pinned certificate failure) on 5 runs in a row
(about 25 minutes) is no longer asked: its breaker opens, it is skipped for 2 runs, then one run probes it. An answer of
any kind closes the breaker; no answer opens it again for 3 runs, less a deterministic jitter of 0 or 1 run (a hash of
the source and the run's seq; it only ever shortens a back-off), so a source that comes back is read again within 20
minutes and sources that failed together do not all come back on the same run. The numbers favour freshness over run
time: on the week 2026-11-07 → 11-13 (2,010 runs) the breaker would have skipped 6 source-runs, 4 of which would have
answered (98 with 3 runs to trip and a back-off up to 12), while a host down for a whole day still costs only 86 of its
288 runs. A skipped source costs the run nothing, and is a failing one in
`status.json`: `ok: false`, `skipped: "breaker"`, `error` (`not asked: circuit breaker open after N runs without an
answer (last: …)`), and `breaker` (`open_since`, the run that opened it; `next_probe`, from when a run probes it;
`failures`, the runs without an answer, probes included; `skip_runs`). A probe that gets no answer also carries
`breaker`, without `skipped`. It is in `degraded`, keeps its `lastSuccessAt`, and goes silent like any failing source;
the health workflow files it as `feed:source:<id>` and, after 6 hours open, `feed:breaker:<id>` (README *Health
watchdogs*). Not tracked: the core sources `usgs`, `emsc` and `geofon` (always asked: the sweeps of the first two ask
the same host every run, so a skip would save nothing, and GEOFON's misses come in short streaks between answers) and
the sources the live path does not ask. A run in which more than half of the sources asked got no answer (at least
6 asked) is the runner's network, not theirs: it counts toward no breaker. The state is
`knowledge/index/provider_breakers.json` (committed with the run; a missing or unreadable file, or entry, means closed),
and the run's log names each skip, opening, re-opening and closing (`breaker_skipped=N[ids]` in its summary line).
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
automatic one or one a seismologist reviewed — the same on each `provenance[]` row for that row (see *Review status*:
on the rolling summaries, the live and month indexes and the detail hours since 2026-10, on the Pages day files
`/v1/events/<day>.geojson` of every day since 2026-11-08, and on the NDJSON day partitions of the event days from
`knowledge/index/partition-format.json` `review_status_from` on; the partitions of earlier days keep their bytes, and
archives and deep-history editions follow their partitions; remediation editions built since 2026-11-08 carry it on
every day). Feed data is under `properties.feed`:

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
publish time, so nothing is fetched or logged for it. The top-level `status` stays the source's own word (ComCat's
`automatic` / `reviewed` / `deleted`, NCS's `Reviewed`, …). Where it is published:

- the rolling summaries, the live index (`/v1/live/`), the month index and the detail hours: since 2026-10;
- the Pages day files `/v1/events/<day>.geojson` (every day they cover): since 2026-11-08 (they are rebuilt every run and
  promise no bytes);
- the NDJSON day partitions `events/YYYY/MM/DD.ndjson`: on the event days from `review_status_from` on, as
  `knowledge/index/partition-format.json` on the `data` branch names it (`{"version":1,"review_status_from":"YYYY-MM-DD"}`).
  derive set it once, on its first run after 2026-11-08, to the first unfrozen day of that run, and never moves it, so a
  frozen partition never changed for it. The partitions of earlier days, and the Release archives and deep-history
  editions built from them, do not carry it; a remediation edition built since 2026-11-08 carries it whatever its day
(they are new assets; the editions of 2026-10-04 do not). To read it on an older
  day, take the Pages day file while it exists (the event-map window, ~45 days), or derive it from the row as below.

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
`age = (Date.now() - metadata.generated) / 1000` (a FeatureCollection's `metadata.generated`, or the manifest's top-level `generated`) and, if it exceeds
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

USP (São Paulo) locates moderate quakes of South America and the rest of the world from Brazil. Its origin times and
magnitudes are close to the other agencies', its places scatter: against ComCat's, 26 km at the median, 75 % within
52 km and 90 % within 120 km (South America 30 / 70 / 136 km), with no systematic shift (382 USP solutions of M ≥ 4.0,
2026-06…10). Since round 21 an event that holds USP's rows only and an event holding a USGS, EMSC or GFZ row get the
moderate-event window with its distance raised to 50 km at every magnitude ≥ 4.0, as for TMD (same 20 s, |ΔM| ≤ 0.5,
best-match and dense-cell rules). Replaying the observation log of 2026-07-05…10-06 folds 33 such pairs (none split),
each USP row 22–60 km from ComCat's solution of a quake that ComCat (32) or EMSC (1) lists alone within 60 s and 300 km;
27 of them are in South America, such as the M4.5 of 2026-10-06 in southern Bolivia (USP 29 km and 1.2 s from ComCat's
`us6000tzva`). A USP solution farther out keeps its own event: of the log's 189 USP rows that have a GEOFON row of the
same suffix (below), 52 stay in another event than GEOFON's, 39 of them more than 50 km from that event.

USP's magnitudes of large quakes run low. USP reports body-wave magnitudes (`mb`; `mB` or `Mw(mB)` for some large
quakes), which saturate where ComCat reports moment magnitudes. Matched to the one ComCat quake within 60 s and 300 km,
the 7,330 USP rows of the deep history's raw assets (2019-01…2023-07) sit within 0.5 of ComCat for 93–98 % of the quakes
below M5.5 (median −0.12 to +0.05, both signs), but 0.5–1.0 below it for 26 % of M5.5–6.0, 29 % of M6.0–6.5, 25 % of
M6.5–7.0 and 10 % from M7.0 (USP's `mb` alone: median −0.34, −0.52, −0.67 in the first three); more than 1.0 below for
23 of the 1,577 from M5.5 and more than 0.5 above for 2. GEOFON, measured the same way, stays within 0.5 of ComCat for
98–100 % of every band from M5.0. USP's live solutions (2026-07-05…10-06, 221 matched) show the same pattern less often.
Since round 22, in USP's window, when the partner event's magnitude is at least 5.5 and above USP's, |ΔM| may reach 1.0
(the large-event limit) instead of 0.5; nothing else in the window changes and no other agency gets it. Replaying the
observation log folds 2 pairs and changes nothing else: Papua New Guinea M6.4 of 2026-07-13 (USP `Mw(mB)` 5.88, 25 km)
and western China M5.7 of 2026-07-28 (USP 4.84, 8 km), each the one quake ComCat and EMSC list within 60 s and 300 km.
The log's 3 other USP-only events that |ΔM| > 0.5 keeps from a partner within 20 s and 50 km (partners M4.7–5.1) stay
apart: below M5.5 such a gap is scatter, not saturation. The allowance needs the merge pass, so the backfill and the
deep-history build, which run without it, do not use it. Rebuilt with it, the 53 sealed deep months 2019-02…2023-06
joined 217 groups, each one quake by ComCat, but with no merge pass to fold a USP event minted before its partner's
reports, such an event kept other agencies' reports out of the partner event (62 groups, 151 rows, split off): 13
quakes were shown once more. Without the allowance there, they rebuild byte-identical to the code before. Both days of
the replayed folds are frozen, so the published feed changes only for new quakes. Since round 26 the window's distance
also grows with a large partner's magnitude, from M6.0 by 50 km a unit up to 100 km (see *Regional agencies outside
their own region*).

USP's event ids share GEOFON's suffix (`usp2026toln`, `gfz2026toln`), and that is no identity link: the four letters
number a time slot of about 70 s (26⁴ a year) of the first origin each SeisComP system made. One quake's two ids
usually share it, though not always (7 of the 47 USP rows in one event with a GEOFON row carry the neighbouring slot,
`usp2026owtj` beside `gfz2026owti`), and two quakes in the same slot anywhere on Earth share it too. Of the 282 USP rows of the day partitions
2026-06-01…10-06 that have a GEOFON row of the same suffix, ComCat and EMSC show one quake for 279 and two for 3, each
pair 14,500–17,100 km apart (one row in Chile or the Caribbean, the other on the far side of the Earth). The feed never
reads the suffix; neither should a consumer. Older days keep the pairs they hold as two events (the frozen days are not
rewritten): in those partitions 242 such USP rows sit in another event than GEOFON's row, most of them written before
the moderate-event window existed.

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

PHIVOLCS (Philippines) is a second case of the same rule. Its id is the bulletin's UTC origin stamp, to the minute
(`2026_1114_0919`) or, for most bulletins since about 2026-10-29, to the second (`2026_1114_091912`). A quake's first
bulletin can carry the minute stamp and a later one the seconds stamp; the page then lists only the later one. Since
2026-11-16 a minute-stamped row and a seconds-stamped row of that same minute whose places are ≤ 50 km apart and whose
magnitudes differ by ≤ 0.6 are one quake: the seconds-stamped report joins the event holding the minute id, under the
same limits as CSN's pairs. Two seconds-stamped ids are never paired, so two quakes of one minute stay two events. On
the page of 2026-11-16, 10 of the 70 minute-stamped events the feed held from 2026-10-31 on had been re-issued that way,
12–15 km and 0.1–0.5 M apart.

OVSICORI (Costa Rica) is another: its analyst's review of a quake comes hours later under a new id while the automatic
solution stays listed. Since round 27 (2026-10-14) such an automatic / reviewed pair is one quake (see *Regional
agencies outside their own region*).

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

## Regional agencies outside their own region

Since round 26 (2026-10-14) the feed treats some solutions of a regional agency outside its own region (the box the
alerts gateway gives it: OVSICORI 8–11.5 N, 86–82.5 W; NOA 34–42 N, 19–30 E) differently. The Panama sequence of
2026-10-09 (ComCat `us6000u18k`, M7.7) showed why: OVSICORI (Costa Rica) located it from outside its network. Its
reviewed solutions lay 45–135 km and up to 17 s from ComCat's, with magnitudes 0.5–0.8 higher (1450322 M8.2 for the
M7.7, 1450349 M7.1 for the M6.6, 1450632 M6.8 for the M6.1), and its automatic ones were hundreds of km off, many with no
quake behind them at all (1450556, M6.7 automatic, 2026-10-11 21:18:30 at 4.78 N 78.93 W: ComCat and EMSC list nothing
within 90 s and 400 km). Each stood as an event of its own: OVSICORI-led events were 16 of the 27 live features of
`significant_week`, and the day's `max_mag` read 8.2.

- **OVSICORI's window.** An event that holds OVSICORI's rows only, all outside its region, and an event holding a USGS,
  EMSC or GFZ row (the agency's own solution, not EMSC's copy of OVSICORI's) and no OVSICORI row, of M ≥ 5.5, are one
  quake when the origins are ≤ 30 s apart, |ΔM| ≤ 2.0 and the distance is within `50 + 100·(M − 5.5)` km of the partner's
  magnitude, capped at 200 km (M5.5 → 50, M6.0 → 100, M6.5 → 150, M7.0 and above → 200). Since round 27 a reviewed
  OVSICORI solution also takes a partner of M4.5–5.5: within 50 km when the origins are at most the distance at 6 km/s
  plus 2 s apart, or up to 120 km when the distance over the time difference is 6–10 km/s (1450391, reviewed M6.0,
  joins ComCat's M5.0 `us6000u1ax` 63.5 km and 7.9 s away). Best match only, ranked after
  the windows above; a dense cell does not block it (the M6.1's aftershock cell held 87 events). The partner's solution
  represents the quake: in an event that holds a USGS, EMSC or GFZ solution of its own, an OVSICORI row outside its
  region never represents it, whatever its status (OVSICORI's rows say "reviewed" or "automatic", EMSC's and GFZ's say
  nothing and ComCat's "automatic" until its review).
- **Held solutions.** OVSICORI's automatic solutions of M ≥ 4.0 outside its region and NOA's solutions without a
  magnitude outside Greece (NOA's automatic teleseismic locations) are kept out of the live set unless an event takes
  them: such an event is withdrawn at the end of the run that made it (`state: "tombstoned"`, an `op:tombstone` line
  with `reason` "held: …", status `held_retracted`), so no derive publishes it live, and a report of it changes nothing
  while it is still held. A held solution that a window joins to another agency's event joins it; one that OVSICORI
  reviews later, or NOA gives a magnitude, comes back as its own event (same feed id). OVSICORI's reviewed solutions and
  its solutions inside its region are never held.
- **OVSICORI's review under a new id** (round 27). OVSICORI's automatic solution (`status` "automatic", `Autor`
  "olDbg…") and its analyst's review (`status` "reviewed", "UNA:…"), published hours later under a higher id while
  the automatic one stays listed, are one quake when the two are each other's best such pair among the live rows and
  lie within 4 s, 45 km and |ΔM| 0.5; or, when the reviewed solution lies outside OVSICORI's box, within 40 s, 300 km
  and |ΔM| 2.0 with the distance over the time difference between 6 and 9 km/s and the automatic origin time the later
  one (outside its network OVSICORI's automatic locator moves a quake toward its stations and its origin time later by
  about the P-wave travel time). The
  reviewed report joins the automatic one's event, dense cells included, and the merge pass folds two events holding
  such a pair. The reviewed solution represents the event, or the agency whose event it joined; the automatic one never
  does. 1450630, OVSICORI's automatic M6.5 of 2026-10-12 23:20:56 inside its box, is the M6.1 its review 1450632 placed
  195 km away and 27 s earlier: it joins ComCat's `us6000u1wn` event, and 10-12's `max_mag` reads 6.1.
- **USP against a large quake.** USP's window (see *Realtime + client dedup*) grows from a partner of M6.0 by 50 km a
  magnitude unit up to 100 km (M6.5 → 75 km, M7.0 → 100): USP's solution of the M7.7 (`usp2026tutw`, M7.67, 1 s) lay
  75 km from ComCat's.
- **SCEDC's copies of NEIC.** SCEDC lists distant large quakes with NEIC's solution (`Author` "US"); such a row and
  ComCat's `us…` row of the same solution are one solution, as good as a shared id, also in a dense cell (SCEDC 10256694
  is ComCat's `us6000u1wn`). A place made of placeholders (SCEDC's "###.# km ( ###.# mi) …") is no place: `place` is
  null, `fields.EventLocationName` keeps it.

Replaying the whole observation log (2026-07-05…10-14, 232,188 lines; a fresh Resolver per hour of ingest time over
the production load, then the feed-side steps with the regular heal) against the rules before: 6 groups fold (7 fewer
events per connected group of ids, 0 more; rows in two live events 0). Five are OVSICORI's solutions of the Panama
sequence joining ComCat's event: 1450322 (M8.2, 135 km, 17 s) the M7.7, 1450349 (M7.1, 55 km) the M6.6, 1450632 (M6.8,
45 km) the M6.1, 1450473 (M6.6, 46 km) the M5.8 of 18:37 and 1450399 (automatic M6.3, 62 km) the M6.0 of 10-10; the
M6.1 also takes SCEDC's NEIC copy, the M7.7 USP's solution, and USP's solution of the Chiapas M7.3 of 2026-07-17
(73 km) joins ComCat's event of it, where SSN's solution, which had joined USP's event before, now stands alone (one
regrouping). Every joined row's nearest ComCat quake is the survivor's, with no second ComCat quake within 30 s and
200 km. 161 solutions are held (131 OVSICORI automatic, 30 NOA without a magnitude): for 85 another live event shows a
quake within 60 s and 300 km (NOA's teleseismic rows 11–58 km from the quake's event); for the other 76 ComCat lists no
quake within 90 s and 300 km (69 none within 400 km), and EMSC, asked about those 69, none within 170 km (57 none within
400 km; the others are quakes 175–388 km and 28–73 s away that OVSICORI's automatic system mislocated). On the event map of 2026-10-14 the first run folds 7 events into 5 and
holds 76 (72 OVSICORI, 4 NOA): `significant_week` goes from 27 live events (16 OVSICORI-led) to 11 (2), and the
`max_mag` of 2026-10-09 / 10-11 / 10-12 from 8.2 / 6.7 / 6.8 to 7.7 / 6.2 / 6.5 (ComCat: 7.7 / 6.2 / 6.1; the 6.5 is
OVSICORI's 1450630, below).

The rules run in the aggregate run only (the regular heal and the held withdrawal reach the 7-day hot window), so the
days already frozen keep what they hold. OVSICORI's automatic 1450630 (M6.5 for the M6.1, 159 km and 20 s off) lay
inside its region and stayed an event of its own until round 27 (above); OVSICORI's reviewed solutions of aftershocks no
other agency listed stay events of their own. No other agency was given these rules. In the replayed state the lone live
events of M ≥ 4.5 that other regional agencies place outside their own boxes are another pattern: GeoNet 124 (Tonga,
Kermadec, Vanuatu), SSN 34, GA 18, INGV 14, NCS 11 and fewer for the rest, almost none automatic (IG-EPN and IMO one
each, against OVSICORI's 99); 17 of them (INGV 6, GeoNet 5, GA 2, CENC 2, JMA 1, SSN 1) lie within such a window of a
USGS, EMSC or GFZ event of M ≥ 5.5, with |ΔM| ≤ 0.6: 10 of distant quakes 46–82 km from the partner's place, 6 in the
Flores swarm of 2026-08-14…20 (4–24 km, held apart by its dense cells) and one JMA row 30 s off. Those are splits of
real large quakes the windows themselves leave, not OVSICORI's mislocations and phantoms; after the change OVSICORI
places no automatic solution of M ≥ 4.5 outside its region as an event of its own, and 22 reviewed ones remain (14 with
no other agency's event within 60 s and 300 km).

An event's representative is re-derived from its rows whenever one of them changes. Since round 27 every run also
re-derives, in the hot window, an event whose stored representative is a row these rules rank behind another of its rows
(an OVSICORI row outside its region beside another agency's own solution, or an automatic row beside its review), so an
event positioned before a rule does not keep that row until one of its rows happens to change: an `op:correction` line
with `reason` "representative re-derived: …", status `rederived` when it is not zero (on 2026-10-14, 13 events of the
Panama sequence, e.g. `efd_01M4W5P9F0ZAGGCN86AH8ZGDTR`, OVSICORI's automatic M4.2 174 km from EMSC's own M4.7, which
then also takes GFZ's event of the quake).

Round 27 was measured the same way, over the log of 2026-07-05…10-14 (233,118 lines): the review pairs fold 62 groups
(63 fewer events per connected group of ids), and with the lower partner floor 66 groups fold (68 fewer); 0 more events
anywhere, one regrouping with the same count (two reviews of one quake), rows in two live events 0, the held solutions
unchanged. In 24 of the 66 groups every row's nearest ComCat or EMSC quake is one and the same, with no second quake
within 30 s; ComCat and EMSC list nothing near the other 42 (Costa Rica's M1–3 quakes, and OVSICORI's reviews of
aftershocks nobody else listed). Left apart: an automatic solution EMSC copied (author UNA) whose review joined another
agency's event that holds EMSC's own event of the quake (EMSC's two ids keep them apart: 1450622 beside ComCat's M4.5
`us6000u1w6`), and two reviews of one quake under two ids.

The round 27 review measured how often a distinct quake meets the two new windows: with OVSICORI's 96 reviewed solutions
outside its box moved by ±2–60 min (118 shifts; no real pair survives a shift), the far review window found an automatic
solution 0.60 times a shift and the M4.5 partner floor a USGS, EMSC or GFZ row of M4.5–5.5 0.71 times, against 11 real
far pairs and 6 floor folds in the same log. So the far window asks for the later automatic origin time (all 11 real
pairs are 8–38 s later; 0.26 a shift), and within 50 km the floor caps the time difference at the distance at 6 km/s
plus 2 s (the two folds there are 4.5 s for 35 km and 5.3 s for 39 km; 0.27 a shift). The near window (4 s, 45 km,
|ΔM| 0.5) meets 0.36 a shift among 799 reviewed solutions, against 64 real candidates. Replayed again over 2026-07-05…10-14
(233,207 lines), the reviewed rules give the same events as before the review, node for node: 66 groups fold (68 fewer
events), 0 splits, rows in two live events 0; in 24 groups ComCat and EMSC list one and the same quake near every
member and no second one within 30 s, near the other 42 nothing. Two quakes the global agencies list stay two events
whatever OVSICORI's two ids pair: their own ids keep them apart, and each is led by its own solution.

**Dedup epoch 2: every regional agency outside its region** (config `AUTHORITY_WINDOW`, `Resolver.authorityJoin`;
SHLTR-148; on with `REMERGE_EPOCH` 2, *Re-merged history*). The pattern above — lone events of M ≥ 4.5 that a regional
agency places outside its own box, most of them its solution of a distant quake 50–200 km from where the global agencies
place it, often with a higher magnitude — holds for GeoNet (Tonga, Kermadec, Vanuatu), USP, GA, INGV, RéNaSS/RESIF and
the rest, and the statistics have left such events out since reconciliation rule v3. From epoch 2 the merge joins them:
an event whose rows are all regional agencies' (none of `usgs`, `emsc`, `isc`, `geofon`, `gfz`, `gcmt`), of M4.5+, whose
place lies outside the authoritative region of every one of them (`src/authority.ts` `outsideAuthority`: the
statistics' own test, `AUTHORITY_REGIONS` plus 5° on every side), and an event holding a global agency's own solution
(not EMSC's copy of the regional agency's) and no row of the regional side's catalogues are one quake when the origins
are at most 30 s apart, the places at most 200 km and the magnitudes at most 1.0 (from a larger magnitude of M7.0:
300 km and 1.5). Mutual best, ranked with the moderate-event pairs; a dense cell does not block it; the merge pass only
(the live heal and the re-merge; backfill and the deep-history build stay as they are). OVSICORI keeps its own window
above; NOA, without a window of its own, gets this one. Measured over the published history of 2013 and the archives
2025-08/09 (epoch 1): of 895 such live events of M4.5+, 597 have a global agency's event within the window; moved by
±10–30 min, where the quake's own event is gone, one finds a partner 0.01 times a shift (a 60 s limit would join 11
more at twice that rate, and joined a RESIF M5.1 to ComCat's M4.2 55 s away instead of its M5.0 262 km away). The
others stay events of their own (no global agency lists a quake near them: RéNaSS's automatic `scautoloc2` solutions
of 2013 at M6–7.8 with nothing within 400 km, INGV's M7.2 of 2013-07-07 twelve minutes off ComCat's M7.3); the
statistics still leave them out.

## Retired events

An event can leave the live set in two ways: an upstream delete (`state: "tombstoned"`,
`tombstone: true`) or a fold into another event once revised solutions converge
(`state: "superseded"`, `superseded_by: <feed_id>`, an `op:merge` line in the observation
log). The feed's own withdrawals take the delete's path: the coordinate-less retraction below, and since round 26 a
held solution (`state: "tombstoned"`, an `op:tombstone` line with `reason` "held: …", see *Regional agencies outside
their own region*). Either way the event stays published in the rolling summaries and the Pages day file
for **48 h after it retired** (the fold or the delete) — **compact and non-live** — so a
poller that treats absence as "still there" sees the removal once; after that it lives only
in the day partitions (full-fat, every state). Tombstoned events joined that 48 h
republication on 2026-09-28 (until then they left those files at once). Consumers must drop
every feature whose `feed.state !== "live"` (or whose `tombstone` is true) — never plot one:
a tombstoned marker keeps its last solution, which for a retracted placeholder is 0, 0;
`metadata.count` counts live features only. A tombstoned event comes back under its own feed id when its source lists
the id located again and nothing live claims the report (no other event holds the id or matches it in space): in the
run that tombstoned it and, since 2026-11-15, in any later run (before, a later run minted a second feed id and the old
one, the id share links and alerts name, stayed deleted). An id ComCat deleted still never comes back through AEC
(*Alaska (AEC)*), and a held solution stays tombstoned while it is held. The
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
FEED-6 the regular heal also folds what they join inside the hot window). Historical partitions are never rewritten
in place: the offline re-merge (*Re-merged history* below) publishes new editions and new archive assets beside the old
ones. Since then history and archive lines can be `superseded` too: follow `superseded_by`, which names a live event of
the same asset or, at a month's end, one of the next month's first 7 days (it crosses at most one month boundary).

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

## Re-merged history

The paths that write history with the merge pass off (backfill, the deep-history build, a new source's onboarding,
the remediation editions) never fold two events, so a quake whose agencies' solutions reached them separately stays
several events there: in the archive month 2024-06 one M5.8 was five feed events, and the archives counted 75 % more
M4.5+ events than ComCat. The live feed heals such splits every run inside its hot window (*Retired events*); the
**re-merge** (config `REMERGE_EPOCH`, `src/remerge.ts`) replays exactly those feed-side identity steps
(`src/heal.ts` `feedSideSteps`: the EMSC copy re-home, the re-point guard, the representative re-derivation and the heal)
over published history, in sliding daily windows of 7 days, as live judged every event in the seven runs after it:

- each window holds the events with an origin in the 7 days before its "now", so a grid cell's density (the swarm guard)
  is counted over 7 days, as live counts it;
- the older neighbour's last 7 days are context that counts for density and never folds; the newer neighbour's first
  7 days are context that may absorb an event of the unit (the loser then points across the boundary, listed in
  `merge.into_newer`) but never loses one, and so are the unit's events an older unit already points into
  (`merge.anchored`);
- nothing is minted or dropped: a loser becomes `superseded` with `superseded_by` and keeps a frozen copy of its rows,
  so every source id stays in the asset; no row is withdrawn offline (the coordinate-less retraction and the held
  withdrawal stay live-only), so the 0, 0 placeholders stay live lines a reader drops;
- every unit passes hard checks before anything is uploaded: the same feed ids and line count as its input, every
  source id still there, each source id live in one event at most, every `superseded_by` resolving to a live event of
  the unit or `into_newer` (no chains), the context unchanged, and the ComCat anchor: the distinct ComCat ids of
  M4.5+ (and M6+) rows in live events are unchanged and no new event holds two ComCat events that ComCat's own `ids` do
  not link.

Before the windows, each unit's rows and both context windows are normalized (config `REMERGE_RULES`, recorded as
`merge.rules` and `merge.normalized`) by `src/row-normalize.ts` `normalizeRows`, the function the statistics builder
uses too: since rules 3 the AFAD rows the pre-2026-10-01 parser stored 3 h early (*Turkey (AFAD)*; the one-time
correction reached only the unfrozen days) are re-timed in events of AFAD rows only, so they fold with the other
agencies' events of the quake (the Marmara M6.2 of 2025-04-23 09:49 UTC was archived at 06:49), an AFAD row that joined
another source's event at its wrong time stays and is counted (`afad_joined_kept`), and ISC magnitudes by authors the
feed does not take (Geoscience Australia's automatic Mw) are dropped; each changed event's representative is
re-derived. A unit merged under an older `rules` value is merged again: a new edition / asset, nothing replaced
(`archives.json` and `history.json` record `merge_rules`). Epoch 1 replays today's live rules; a rule round is a new epoch and a new campaign (epoch 2, below). Statistics should count
ComCat-anchored events for global figures: the residual over-count after epoch 1 is documented by
`scripts/remerge-verify.ts` (per month: live M4.5+ and M6+ before and after, the anchored counts, ComCat's count, the
M4.5+ events without a ComCat row near one or not, every M6+ fold).

**What is published.** With `REMERGE_EPOCH` 0 (the kill switch) nothing is re-merged. Epoch 1 is on since 2026-11-08
(`REMERGE_INGEST_TIME` 2026-11-08T00:00:00.000Z, `REMERGE_RULES` 3). The campaign ended 2026-11-09 02:45 UTC: all 36
archive months (2023-07-06 → 2026-06-30) and all 283 deep-history months of eras pilot and A (2000-01 → 2023-07-05)
are merged; era B is single-source and not re-merged. Measured against ComCat (`scripts/remerge-verify.ts --comcat`,
2026-11-08/09): the archives went from 54,267 to 31,920 live M4.5+ events and from 1,574 to 567 M6+ (ComCat 22,476
M4.5+ and 387 M6+ earthquakes; the feed's ComCat-anchored counts 22,485 and 387), the deep history from 199,815 to
197,002 M4.5+ and from 4,487 to 4,269 M6+ (ComCat 162,768 and 3,559; anchored 162,839 and 3,560). The anchored side is
higher where ComCat deleted events since, or types them as non-earthquakes (Kīlauea's 2018 collapse events). The
remaining over-count is events the current rules keep apart (an ISC copy of a NEIC or GFZ origin at 0 km / 0 s, one
agency's distant solution, a large quake's agencies in a swarm cell): epoch 2 (below) is the rule round for it, on since
2026-11-14 (`REMERGE_INGEST_TIME` 2026-11-14T00:00:00.000Z, `REMERGE_RULES` 3). Above 0:

- *Deep history:* the hourly `history` walk gives each month whose current edition is not merged a new edition
  `events-YYYY-MM.e<N+1>.tar.zst`, built from edition N and nothing else, newest month first; a month waits until its
  newer month is merged (the boundary month 2023-07 until `archive-2023-07` is). Its `_edition.json` gains a `merge`
  block, `lines` and `superseded`; `events` counts the live lines; `rows` is unchanged. Its index entry gains
  `merge_epoch`, `merged_from` (the edition, asset and checksum it was merged from), `lines` and `superseded`;
  `built_from` stays (the month is not re-sealed). A month sealed while the epoch is above 0 is merged as it is built.
  A single-source era (era B, ComCat alone; `eraIsRemerged` in [`src/history-index.ts`](src/history-index.ts)) is never
  re-merged: there is nothing to fold (the identity resolution keeps two ids of one source apart, so two ComCat events
  stay two), and its months keep the edition they were sealed with, whatever the epoch was then; such an edition is
  final, so the next older month is sealed against it without waiting for a merge. Only the seam waits: with the epoch
  above 0, 1999-12 is sealed against a merged 2000-01. (The walk sealed 1999-12 back to 1981-04 at epoch 0 on 2026-11-08,
  1999-12 against 2000-01 `e1`, joining 0 rows; the older months were sealed after epoch 1 landed.)
- *Archives:* `remerge.yml` (every 6 h and by hand, outside the writer lock; `src/remerge-archives.ts`) gives each
  archive month below the epoch a new asset `events-YYYY-MM.e<N>.tar.zst` in its `archive-YYYY-MM` Release, newest
  first, holding the day files and `_archive.json` (`kind: "earthquakes-feed/archive-edition"`: `built_on` the asset it
  was merged from, `remediation_days`, the `merge` block, `count`, `live`, `superseded`, `days`). Its remediated days are
  the current remediation editions (the month waits when one was built on another asset). `archives.json`'s entry then
  names the new asset with `edition`, `merge_epoch`, `live`, `superseded`, `built_on`, `remediation`, and lists the
  replaced asset in `previous[]`; the commit applies an entry only when it still has the checksum the merge was built
  on (compare-and-set). Readers of `*.ndjson` members ignore `_archive.json`.
- *Remediation editions:* each remediated day of a merged month gets a refreshed edition (the merged day file, `built_on`
  the new archive asset, `stats.remerge: {epoch, from_edition}`, the fetch fields 0), so "the highest edition replaces
  the archived day" stays true. A remediation edition built while the epoch is above 0 is merged as it is built.
- *Frozen live days* (2026-07 → today) stay as published in `partitions[]` until their month rolls into an archive,
  which is then merged within about 6 h. A month re-rolled later (a backfill fill, `needs_reroll`) gets a new asset
  without `merge_epoch` and is merged again.

**Epoch 2** (SHLTR-148; config `identityRules`; `REMERGE_EPOCH` 2 since 2026-11-14). The epoch is one switch for the live
feed and the re-merge: the live Resolver (aggregate's merge pass and regular heal, backfill, the deep-history build, the
remediation editions) runs the rules of `REMERGE_EPOCH`, and the re-merge of a unit runs the rules of the epoch it
merges the unit to, so raising the epoch changes both at once and the archives, the history and the live hot window
agree. Epoch 2 adds four rules to epoch 1's:

- *ISC's copies* (`iscCopies`, *ISC*): an ISC row that re-publishes NEIC's, GFZ's, GA's or the Puerto Rico network's
  origin (its `Author`, within 1 s and 5 km of that agency's own row) is that agency's solution, as good as a shared id,
  also in a swarm cell; such a row no longer keeps two events apart as "ISC under two ids".
- *The authoritative-region window* (`authorityWindow`, *Regional agencies outside their own region*): a regional-only
  M4.5+ event outside every one of its agencies' authoritative regions joins the global agencies' event of the quake
  (30 s, 200 km, |ΔM| 1.0; from M7.0 300 km and 1.5), by the statistics' own region test (`src/authority.ts`).
- *Large quakes in swarm cells* (`largeQuakesInSwarms`): two events both of M5.5 or more are judged in a dense cell as
  in any other cell — the base and large-event windows without the dense caps, the moderate-event window and a regional
  window (USP's large-quake window) — without the swarm guard's shared-id demand (a swarm is made of small quakes).
  The Sındırgı M6.1 of 2025-08-10, in a cell with 64 events in the week before it, was ten events of the archive after
  epoch 1 (AFAD, ComCat, ISC's NEIC copy, SCEDC's NEIC copy, GEOFON, GA, USP, EMSC, INGV, RéNaSS); it is one.
- *Density as of the pair* (`densityAsOfPair`, the re-merge only): a pair's cell density is counted over the seven days
  up to the later of its two origins (`src/remerge.ts` `swarmCellsAsOf`, over the unit's input), close to what live saw
  when the reports arrived, instead of over the seven days before the window's end, where a quake's own aftershocks had
  made its cell a swarm cell. It is somewhat looser than live, which counts every loaded event of the cell over ten
  days (`LIVE_INDEX_DAYS`) and any aftershock already in when the pair is judged. Capped in time
  (`DENSITY_AS_OF_PAIR_MAX_DT_MS`, 15 s): a pair whose cells are swarm cells by the window's count, which that count's
  swarm guard keeps apart, folds through this rule only when its origins are less than 15 s apart. Of the dry runs' 2,051
  folds by this rule, 21 were 15 s or more apart; 7 of them attached a small non-ComCat solution (M3.2 or less) to the
  wrong small quake. With the cap 20 of the 21 stay apart (the 21st, NOA's M1.9 30.5 s from AFAD's event, folds in a
  later window by epoch 1's windows, its cell sparse there), two of the three M4.5+ ones join ComCat's event 1.3 and
  1.7 s from them instead, and one (EMSC's M4.8 of 2024-04-22, 30.1 s) stays a duplicate: a wrong fold loses a distinct
  quake, a missed one keeps a duplicate. A pair the merge pass joins without this rule is not capped.

Nothing else changes: the hard checks, the ComCat anchor (no ComCat id lost, no two ComCat events welded), the context,
the windows of epoch 1. Dry runs of 2026-11-14 (local, read-only, `scripts/remerge-verify.ts --comcat`): the 36
archive months go from 31,920 to 29,358 live M4.5+ and from 567 to 456 M6+ events (ComCat 22,476 and 387; the anchored
counts unchanged in every month, no new weld), 4,872 folds (1,947 by the authoritative-region window, 417 ISC copies,
50 large quakes in swarm cells, 1,733 by the density as of the pair with its 15 s cap, and 725 by epoch 1's windows,
pairs another fold made reachable; without the cap 4,890 and 29,357); 29 history months
(2005-06, 2009-05, 2013, 2022-05 → 2023-07) from 427 to 376 M6+ (ComCat 311). What stays above ComCat at M6+ is
regional agencies' own solutions inside their regions at a higher magnitude (KAGSR's Kamchatka aftershocks), regional
solutions outside their regions with no global agency's event in the window, and global agencies' second ids of one
quake; the statistics still collapse or leave those out. The first live run after the switch folds 17 pairs of the hot
window (event map of 2026-11-14), all through the authoritative-region window.

The switch (2026-11-14, after the dry runs above): `REMERGE_EPOCH` 2 with `REMERGE_INGEST_TIME`. From the next
aggregate run the live regular heal folds the hot window's pairs under the new rules (at most `HEAL_MAX_FOLDS_PER_RUN` a
run; 17 on the event map of 2026-11-14, all by the authoritative-region window, `scripts/heal-dryrun.ts --regular --epoch
2`: raising `REMERGE_EPOCH` does not raise `HEAL_EPOCH`), and backfill, onboarding, the remediation editions and the
deep-history build ingest under them. The campaign then merges every unit to epoch 2 in this order, each from its
current epoch-1 asset or edition (a new asset or edition each, nothing replaced):

1. *Archives:* `remerge.yml`, 4 months a run (`REMERGE_MONTHS_PER_RUN`), newest first, each run committed before the
   next is dispatched (a month waits until its newer month is merged): 9 runs for the 36 months, about 5–8 min each on
   the runner (61–75 s a month in the dry run of 2026-11-14, run 43626370955), plus the cron every 6 h. Each remediated
   day of a merged month gets a refreshed edition.
2. *Deep history:* the hourly `history` walk, once `archive-2023-07` is at epoch 2 (2023-07 waits for it), newest
   first, 10–20 months a run as at epoch 1: the 283 era-A / pilot months in about 18–25 runs. Era B is not re-merged.
3. *Statistics:* their digests carry the epoch, so every year rebuilds; until a year's inputs are merged the builder
   re-merges them in memory at epoch 2 (the same rules, the same counts). Once the history is done, every year is
   rebuilt from the merged assets and checked month by month against ComCat (`stats.yml` `verify=full`).

Progress is the count of `archives.json` entries and of current `history.json` editions with `merge_epoch` 2 (36 and
283 when done). A blocked unit (a hard check failed) stops nothing else and is filed on the "[health] feed" board
(`walk-blocked-remerge`, `walk-blocked-history`, `walk-blocked-stats`). The rollback is the one below: `REMERGE_EPOCH`
back to 1 (with its ingest time) first, then `remerge.yml` with `rollback: 2` (the archive entries go back to their
epoch-1 assets, the epoch-2 history editions and refreshed remediation editions are withdrawn); the live folds made
under epoch 2 stay, as every live fold does. Dry runs of a later round work as they did for this one: `remerge.yml` /
`src/remerge-archives.ts` with `REMERGE_DRY_RUN=1` and `REMERGE_EPOCH_OVERRIDE` (locally also `REMERGE_NO_WAIT=1`),
`src/history.ts` with `HISTORY_DRY_RUN=1`, `HISTORY_REMERGE_EPOCH` and `HISTORY_REMERGE_NO_WAIT=1`, each read by
`scripts/remerge-verify.ts --comcat`, and `scripts/heal-dryrun.ts --regular --epoch <n>` for the live side. The statistics' reconciliation stays as a safety
net (*Statistics*, Reconciliation): epoch 2 joins in the feed what the authoritative-region filter and the collapse
leave out of the counts where a global agency's event is within the window, and the rest (regional solutions with no
global event near them, phantoms of automatic teleseismic locators) stays an event of its own that the statistics still
leave out.

The `merge` block: `{epoch, ingest_time, code, window_days, from: {edition, asset, sha256} | null, older_context,
newer_context: {label, sha256, days} | null, anchored[], steps: {rehomed, stranded, rederived, folds, windows},
into_newer: [{loser, survivor}], off_unit[], external[]?, merges: [{loser, survivor, reason}], live_before,
live_after}`. `merges[]` with the fold reasons is the audit trail (there is no observation log offline). `off_unit`
lists events whose solution moved out of the unit: they stay in the day file they were in (backfill keeps them there
too). `external` lists superseded lines published before the re-merge whose pointer leaves the unit (live-era folds);
they are kept as they were. The changed lines carry `ingest_time` = `merge.ingest_time` and a new `revision`, and every
line of a merged asset carries the normalized `review_status` (*Review status*).

**Never rewritten, never deleted.** Every earlier edition and asset stays where it was: history editions in
`history.json` `editions`, archive assets in `previous[]`, remediation editions in `remediation.json`. An upload whose
index commit never landed is taken over by the next run (history: `adoptOrphans` when it was merged from the month's
current edition; archives: the output is deterministic, so the next run's identical asset is adopted by checksum);
any other is listed in `unused`. A rollback (`remerge.yml` input `rollback: <epoch>[:YYYY-MM,...]`,
`scripts/remerge-rollback.ts`; first set `REMERGE_EPOCH` below the epoch rolled back: 1 for epoch 2, 0 for epoch 1) changes only the indexes: each archive entry goes back
to `previous[0]` (the merged asset stays listed with `withdrawn_at` and a reason), and each merged history edition and
refreshed remediation edition gets `withdrawn: {at, reason}`, which a reader skips: the current edition is the highest
one not withdrawn.

**Reading merged history:** keep the lines whose `feed.state` is `live` (as everywhere in the feed), drop the 0, 0
placeholders, and resolve a `superseded` id through `superseded_by` (at most one month boundary away).

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

**ComCat settles within about 45 days.** ComCat keeps publishing after that: NEIC's reviewed solutions of M4.5+
quakes far from a regional network often appear 10–22 days after the origin (us6000tz4j, M4.6 New Caledonia of
2026-09-26: first published 22.0 days later; us6000u2u4, M4.6 Panama of 10-09: 21.1 days; us7000tv8m, M4.8 Tuamotu of
10-24: 15.3 days), and it revises others across M4.5. A frozen day keeps ComCat's set as it was when it froze, so
ComCat's counts for the live era (since 2026-07-05) are not final for a day younger than about **45 days**. Measured
on 2026-11-14 over the 126 frozen days 2026-07-01…11-03, the `usgs` M4.5+ rows of each day against ComCat's M4.5+
count for it now: 0.67 (July), 0.70 (August), 0.75 (September), 0.77 (October), 2,291 rows against 3,158 quakes; 962
of ComCat's M4.5+ quakes had no `usgs` row at all (most were in the feed through EMSC, GEOFON or another source,
without ComCat's solution), 39 rows had crossed M4.5 upwards since, 80 downwards, 26 had moved by 0.3 or more and 2
were no longer listed. 124 of the 126 days had changed (33 of the 35 days 09-30…11-03). The days are completed by
`late_usgs` remediation editions (*Remediation editions*), not in place.

**Recovered reports.** Some sources publish only a rolling list: TMD's file holds its last 20 events (about 2.5 days).
When the feed cannot read such a list for longer than that, events leave it unread. TMD keeps a page per event
(`https://eq.tmd.go.th/EQ<id>`, the `path` its file names), so an aggregate run dispatched by hand with the input
`recover` (`tmd:17182-17198`: ids of at most 9 digits and ranges, at most 50 ids; `src/recover.ts`) reads those pages,
one request every 1.2 s or slower, after the run's live fetches, and ingests them in that run exactly like the
source's live rows (the same parser, dedup windows and day partitions). Their `op:observe` lines carry a `reason`
("recovered from the provider's event page …, N d after origin"), and that run's `status.json` has `recovered`
(`asked`, `rows` (the ids ingested), `empty`, `held_as`, `outside_window`, `failed`, `unasked`). Only reports inside
the 7-day matching window are ingested, so frozen days never change; a report the feed already holds changes nothing,
so the run can be repeated, for example for the ids listed as `failed` or `unasked`. A report TMD named by origin
second while its ids were empty (`t2026…`, 2026-08-18 → 10-13) is not taken again under its number (`held_as`). A
recovered report reaches the alerts gateway like any late report: it alerts only on origins of the last 6 hours (it
reads today's partition and origins of the last 7 hours), so a report recovered later than that is never alerted,
while one recovered sooner (a burst of aftershocks can push events out of a 20-row file within hours) can be. On
2026-10-14 this recovered TMD's 17182–17198 (2026-10-09 11:32 → 10-10 15:02 UTC, 3.6–4.7 days old), the events its
file listed while the feed could not read it (2026-10-09 02:00 → 10-13 18:26: a renewed certificate under another
intermediate, then a moved file): 10 new events and 7 joined (6 to EMSC's copies of TMD's own solutions, 0 km and 0 s
apart; the M4.5 of 10-10 01:23 to the event of CENC's solution and EMSC's copy of it, 26 km and 3 s apart). A second
run with the same input, made on a copy of the data branch after it, appended nothing. TMD's events of 2026-08-18
04:34 → 09-30 02:37 UTC (its 16978–17148, 171 events, while its file had empty ids and the feed dropped every row) lie
in frozen days and are not in the feed.

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

The forward-only sources' first lists matter for the walk too: their rows of up to a week before the first live run
set the live floor (the earliest `event_map` day, 2026-06-28), and backfill walks only below it. See the seam below.

**The seam of 2026-06-28 → 07-03 05:42 UTC.** The first live run (2026-07-05 05:42) asked the time-range sources for
their last 48 hours only, so they reached back to 07-03 05:42, while the forward-only lists (NCS, CENC, TMD, AFAD's
list) reached 06-28 and set the floor there. Backfill filled only before 06-28, and the onboarding bootstrap seeded
the 15 sources then present (`usgs`, `emsc`, `geofon`, `ingv`, `geonet`, `resif`, `noa`, `ethz`, `nrcan`, `ncedc`,
`scedc`, `knmi`, `auspass`, `afad`, `kagsr`) as complete. So none of them was ever asked for [06-28 00:00,
07-03 05:42): about 4,900 events were missing, the days held only RéNaSS, ISC, CSN, IPGP, IGP, IMO, USP (onboarded
later, through `pending`) and the forward-only lists. Measured on 2026-11-08:

| Day | Events | usgs rows | emsc rows | ComCat count | EMSC count |
|---|---|---|---|---|---|
| 06-27 (backfilled, for comparison) | 1,021 | 278 | 376 | 343 | 403 |
| 06-28 | 158 | 0 | 0 | 384 | 424 |
| 06-29 | 158 | 1 | 1 | 337 | 430 |
| 06-30 | 191 | 1 | 2 | 356 | 384 |
| 07-01 | 200 | 5 | 0 | 371 | 428 |
| 07-02 | 189 | 2 | 1 | 384 | 454 |
| 07-03 | 830 | 207 | 279 | 425 | 430 |

The days are repaired by remediation editions with `reason: "seam"` (*Remediation editions*), not in place: 06-28…06-30
were already in `archive-2026-06`, and 07-01…07-03 are frozen and wait in the refill queue for July's archive. Since
2026-11-08 the onboarding bootstrap seeds a source as complete only when its live lookback reaches the floor, and
queues the others like a source added later, so a new `data` branch cannot open the same gap.

**Dispatching windows by hand.** A dispatch with `starttime` and `endtime` (and `providers`) fills that range once and
does not move the walk's cursor. Pace them: at most 2 writer runs wait for the `earthquakes-feed-writer` group at a time
(README.md, *Writer group*). A third dispatch is refused in seconds by the workflow's `gate` job with an `::error::`
naming what waits (dispatch it again once one has finished, or with `force=true`, which every aggregate run then waits
behind); the hourly walk is refused with a warning only and walks on at its next tick. A backfill run holds the group for
seconds: it checks out only the index files and the months of its windows (SHLTR-149, after 47 dispatches of a usgs
refill held the live feed 1 h 47 min on 2026-11-08). A dispatch with `dry_run=true` only prints the plan (each window
to fetch, and each provider and day with `fetch` or `retention`) and writes, asks and uploads nothing; it takes no
writer lock.

**Retention.** A source whose registry entry has `retentionDays` (AFAD: 7, *Turkey (AFAD)*) answers a time-range query
only for that many recent days; an older window answers no rows, which used to be recorded as filled. The planner
(`src/backfill-plan.ts` `planWindows`) never asks such a source for a day before its retention: the window, or the part
of it before the edge, is skipped with the reason `retention` (a `::notice::` line per window), a walk whose next
window lies wholly before the edge is done (`stoppedBy: "retention"`), and an open dispatched window before the edge is
closed. Nothing of it reaches the health board: it is not a block, nothing more can be fetched.

A source's walk reports its failures: a window that fails is halved for the next run (a window whose answer is too
large to stream within the timeout fails as a timeout, never as an overflow), each failure is logged with its error,
the cursor keeps `lastError` and `failingSince`, a streak of 24 runs adds a warning to every run, and from 72 runs at a
one-day window the stall is a block on the run's marker (`walks:backfill:<source>`) on every run while it lasts.
Before 2026-10-01 a failing walk stayed silent and kept its
window: ISC's 21-day window (more than 5,000 rows, about 35 s against ISC's 30 s timeout) failed 1,861 runs in a row,
all green, from July to 2026-10-01. ISC's walk is paused since (`backfill.enabled: false` in the registry): every
day it has left before the target lies in a frozen month already rolled to a Release, and finishing it means pulling
those 26 monthly archives back (2023-07…2025-08, about 760 days), adding about a fifth more events to them (ISC's own small events: a local test of the window
2025-07-29…08-02 added 1,695 events to its 8,869 and an ISC row to 1,249 others) and re-rolling every archive. That is
a deliberate one-off, like a heal, not an automatic step.

## Run logs

Two logs record the runs themselves, beside the observation log: the status history (every aggregate run's
`status.json`, one line per run) and `changes/YYYY-MM-DD.ndjson` (derive's change log of each day; the current day's
file is also served as `/v1/changes/<day>.ndjson` from its first line on, by every deploy whether or not that run
appended to it (before 2026-11-16 only by a run that did), compressed like the day partitions on Pages, always whole: a
Range request gets the full body). The status history is written to `status/history/YYYY-MM-DD.ndjson`,
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
tree from the API, logs the files under `status/history/` (count, total, largest, whatever their layout) and files
`feed:size` on the "[health] feed" board while a status-history day file (`YYYY-MM-DD.ndjson`) is over 5 MB or any other
file on the branch over 45 MB (resolved when none is; never a red run). A tree read that fails leaves `feed:size` as it
was and files `watcher:feed-github`; a truncated listing is judged as far as it goes, with a `Data file size` warning (a
file over the line in it is filed; with none, `feed:size` is left as it was, never resolved on a partial listing).

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
(`provider_activity.json`, `live_silent.json`, `correction.json`) or grew (`history.json`, about 3 commits a day; one an
hour during era A, round 24 moved its per-run failure counts to the small `history-state.json`) are
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
  and 32 MB to 6, 7.5 and 10. A save rewrites only the days the run's map holds. Aggregate loads the event_map from a
  floor day back and passes that floor to `saveEventMap` (`floorDay`): a day below it that a revision moved a node onto
  (an `updatedafter` sweep reaches further back than the loaded window) is merged with its shards on disk, upserted by
  feed id, never rewritten from the run's nodes alone, which would drop the day's other events (2026-11-15 audit).
  Storage phase 3 (below) keeps the hour shards for as long as git tracks the event map (phase 3a) and writes one file
  per day once it does not (phase 3b); the knob `EVENT_MAP_SHARD_HOURS` is gone, its rollback lever with it.

Both together replay to 45 MB a day on average over the eight days instead of 63 (23–42 % less a day, 28 % in all); at
GitHub's 67 MB a day that is about 48 MB. What remains is about three quarters day partitions, which consumers read
(jsDelivr `@data` / `@<data_commit>`, the manifest's `partitions`) and keep their layout. They shrink only by being
rewritten less often, which changes what the `data` branch shows between runs: a partition of a day 2 or more days old
written at most every 3 hours (Pages, the live index and the summaries unchanged) replays the days to 10-04, 10-05 and
10-06 to 19, 30 and 40 MB. That, and how large the repository may grow (GitHub recommends at most 10 GB on disk,
[Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits),
read 2026-10-06; a recommendation, not an enforced limit, see round 25 below), are owner decisions. So is a full
repack on GitHub's side, which only GitHub can run: the whole
repository repacked locally (`git repack -adf` of a mirror clone of 2026-10-06, all 808,450 objects, default window and
depth) is 0.69 GiB, against the 5.38 GiB GitHub serves and counts.

**Round 25 (2026-10-14): what is unlimited, and the plan.** GitHub counted 6,098,544 KB on 10-14 07:17 UTC: 59 MB a
day since 10-06 12:52, 87 MB a day over the 42 hours before (the deep-history index `history.json`, committed hourly
until era A finished at 10-14 00:37, and more late revisions of days 2–9 days old). The limits, read that day:

- Release assets (deep history, archives, first solutions, run logs, remediation: about 1.39 GB in 7,186 assets) are
  not counted in `size`, and GitHub sets no limit on a release's total size or bandwidth: 2 GiB per file, 1,000 assets
  per release ([About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)).
  The fair-use policies still apply (Acceptable Use §9, bandwidth; the Actions terms: not a CDN).
- Cloudflare Pages holds only the rolling window: Free plan 20,000 files per deploy and 25 MiB per file
  ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/)). A deploy is about 1,183 files and 306 MB
  with the partitions below; `validate` logs both and fails past either limit.
- The git repository is not unlimited: GitHub recommends at most 10 GB on disk and, for a repository, "less than 5 GB
  is strongly recommended"; above that it warns of degraded repository health and may ask the owner to take corrective
  action ([About large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)).
  Only 100 MB per file and 2 GB per push are enforced. At 55–90 MB a day 10 GB comes between late November and late
  December 2026. The `health` line (`feed:repo-size`) is 8,000,000 KB since round 25 (22 days before 10 GB at 90 MB a
  day).

The cause is the 5-minute views committed to git: every run rewrites the unfrozen day partitions (2.5–2.8 MB each),
about 79 % of the bytes GitHub keeps. The fix (storage option 4) takes them out of git without rewriting anything:

- Phase 1 (round 25, nothing changes for a consumer): each unfrozen day's partition is also deployed to Pages, byte for
  byte, at `/events/YYYY/MM/DD.ndjson`, the path the v2 `pages` origin builds, and the manifest's `url` names that copy
  (*Historical day partitions*); derive's silent-change check reads the previous run's lines from the event map instead
  of the committed partitions (`src/live-baseline.ts`, beside the old check until phase 2). The commits still hold the
  partitions as before, plus the 1 KB `knowledge/index/live_baseline.json`.
- Phase 2 (from the merge of PR #154 (2026-11-16, the port of #120); announced for 2026-11-04, merged after a port onto the November
  code): derive stops committing the unfrozen days. Every writer that stages day partitions (derive-publish and backfill
  with the pathspec `.`, archive with its paths) stages through `src/stage-data.ts`: `git add -A` of its paths, then
  every `events/YYYY/MM/DD.ndjson` of a day not frozen at that moment leaves the index (`git rm --cached --sparse`:
  backfill's checkout is sparse since SHLTR-149, and a backfill that commits first after the merge drops the unfrozen
  days the branch still tracks outside its cone). Every other writer names its own paths, never `events/`
  (`tests/stage-data.test.ts` reads every workflow and action). The files
  stay on disk in the job for `sign-manifest.ts` (it hashes them for the v2 `sha256` and throws on a missing one),
  `validate.ts` and `publish-r2.ts`; the first phase-2 run deletes the 11 unfrozen days from the branch (history is
  never rewritten). A day is committed once, by the first run after it freezes: derive writes every day of the event
  map's 45-day horizon into a checkout that lacks it, and the staging reads the clock after derive, so a day that froze
  between the two is committed by that run. remediate commits only its index, as before. `scripts/push-data.sh`
  stashes the untracked day partitions around its rebase: git refuses to rebase over an untracked file at a path the
  other commit tracks, which is the first phase-2 run's case when a side-index job pushed onto the branch that still
  holds the unfrozen days (round 27 review). The old silent-change check
  goes: the previous run's lines come from the event-map snapshot or, for a day a failed derive changed, from that
  derive's Pages copy, each only when its sha256 is the one `knowledge/index/live_baseline.json` records; a day with
  neither has no baseline for that run (a warning). The day that froze last keeps its Pages copy and its `url` for one
  day (`PAGES_PARTITION_GRACE_DAYS`, `src/partitions.ts`), since jsDelivr `@data` may not have it for about 12 hours,
  and first-solutions reads it from the event map; a frozen day missing from the tree inside the event map's horizon
  (no derive commit for over a day) is also rebuilt from the event map, never read as empty. The v2 origins
  `jsdelivr-sha`, `raw-sha` and `raw-data` carry `frozen_only: true` (day partitions only; the statistics files on them
  are unchanged). Rollback: a revert; its first run commits the unfrozen days again.

  Rehearsed before the merge (round 27, 2026-10-14) on local copies of `data`, never pushed (`scripts/phase2/dryrun.sh`,
  a clock of choice from `scripts/phase2/fake-clock.mjs`, a throwaway signing key), replaying production's aggregate
  commits of 18:27–18:57 UTC as if they ran at 23:54–00:26: the first run left the 11 unfrozen days out (they left the
  branch in its commit, 18 paths and 0.6 MB of new blobs); a day froze between derive (23:59:59) and the staging
  (00:00:01) and was committed by that run, once; with the staging before midnight the first run after it committed
  the day; later runs committed 6–8 paths and about 0.1 MB of new blobs each, against 4.8–7.6 MB for production's
  derive commits of the same aggregates. validate and sign-manifest passed every run, every partition on disk was byte
  for byte production's (136 of 136), and the silent changes equalled production's. A derive that failed: without the
  Pages copies the next run lost a silent change of the two days the failed run changed; with them it found it.
  `scripts/live-baseline-replay.ts` over the 115 derive commits of 10-14 10:00–18:48 UTC: 114 of 114 runs equal to the
  committed partitions' check and to production, every window day from the snapshot; as if every previous derive had
  failed, 113 of 113 equal, 223 of 904 window days from the Pages copies, none without a baseline (without the Pages
  copies those 223 days had no baseline and 44 of the 113 runs missed silent changes: 13 found instead of 83).
  The round 27 review repeated both on its own sample, at a real midnight: production's aggregate commits of 10-11
  23:57 – 10-12 00:07 UTC replayed at their own times (the transition run: 133 of 133 partitions production's; the
  first run after midnight committed 10-01 once, byte for byte production's frozen file, and so did a run with derive
  at 23:59:59 and the staging at 00:00:01; the next run committed no day; the silent changes equal to production's),
  and `live-baseline-replay.ts` over the 75 derive commits of 10-12 00:02–06:07 UTC: 72 of 72 runs equal to the old
  check and to production; as if every previous derive had failed, 69 of 69 equal, 136 of 552 window days from the
  Pages copies; without them 25 of the 69 runs missed silent changes (4 found instead of 60). It fixed two things: the
  first phase-2 run's push retry (above), and a day the previous derive wrote no partition of (the new UTC day after a
  failed derive at 00:07) counted as a day without a baseline, a warning with no effect on the deltas.

  Rehearsed again on the port (2026-11-16), on local copies of `data` (a blobless, shallow fetch of the commits of
  2026-11-15 22:00 UTC on; never pushed; a throwaway signing key), with `scripts/phase2/dryrun.sh`, which now pins the
  manifest with `src/pin-manifest.ts` as derive-publish does, runs publish-r2 on its off path and fails when a commit
  leaves an unfrozen day tracked. Production's aggregate commits of 2026-11-15 23:47 – 11-16 00:18 UTC at their own
  times, from the derive commit 05fce32eb61 (23:43): the first run (the transition) deleted the 11 unfrozen days
  (11-05 … 11-15) from the branch, 17 paths and 0.6 MB of new blobs; derive at 23:59:59 and the staging at 00:00:01
  committed 11-05 as a new file (`A`), byte for byte production's frozen 11-05, and no later run committed it again;
  with the staging at 23:59:59 instead, the first run after midnight committed it, the same bytes. validate,
  pin-manifest and sign-manifest passed every run; every partition on disk was byte for byte production's (138 or 139
  of them each run) and `live_silent.json` equalled production's but for the run time. The manifests: the grace day
  11-04 kept its Pages `url` until midnight, then `@<data_commit>`; 11-05 kept Pages through the next day; the git
  origins carry `frozen_only`. A derive that failed at 00:13: the next run took 11-15 and 11-16 from the previous
  derive's Pages copies (a local server with its deploy) and found both silent changes production found at 00:13 and
  00:18. The derive commits added 0.2–0.6 MB of new blobs (the freeze commit 2.9 MB, the day itself) against 1.8–4.1 MB
  for production's commits of the same aggregates. `live-baseline-replay.ts` over the 49 derive commits of
  11-15 22:03 – 11-16 01:58 UTC: 48 of 48 runs equal to the committed partitions' check and to production (9 silent
  changes); as if every previous derive had failed, 47 of 47 equal, 65 window days from the Pages copies; without them
  12 of the 47 runs missed silent changes (2 found instead of 15). Backfill's staging on sparse checkouts of the data
  commit 23036ba (11-16 03:21 UTC), with backfill.yml's own line: no month checked out, exit 0, the 11 unfrozen days deleted,
  the cursor staged; one month checked out with a day rewritten, the same plus that day; a new file outside the cone,
  exit 1 with nothing staged. GitHub counted 6,786,555 KB on 2026-11-16 02:21 UTC, about 21 MB a day since 10-14
  (14 MB a day over 11-12 … 11-16): the 8,000,000 KB `health` line is about 2026-12-29 at 28 MB a day, 2027-01-12 at
  21 and 2027-02-10 at 14, without phase 2.

  Growth, replayed with `scripts/repo-growth/replay.sh` (a roll-up every 12 pushes) over four 24-hour windows ending
  18:48 UTC (the first one replayed by the round 27 review), in today's layout and in phase 2's
  (`relayout.py --frozen-only 10`):

  | Window | Pushes | Today | Phase 2 | Less | Day partitions after an all-into-one repack |
  |---|---|---|---|---|---|
  | to 10-11 | 634 | 12.8 MB | 6.5 MB | 49 % | 4.8 → 0.32 MB |
  | to 10-12 | 630 | 23.9 MB | 8.9 MB | 63 % | 14.1 → 0.34 MB |
  | to 10-13 | 616 | 27.3 MB | 10.5 MB | 61 % | 18.5 → 0.33 MB |
  | to 10-14 (doubled dispatches 04:40–10:05) | 749 | 35.5 MB | 10.0 MB | 72 % | 23.8 → 0.30 MB |

  The day partitions drop to the one day written at its freeze; what remains is mostly the event_map hour shards
  (2.9–6.1 MB a day in both layouts, about half to 60 % of phase 2's growth), then the manifest, inventory and status
  files. Applied to GitHub's rate (55–60 MB a day before the doubled dispatches; 6,098,544 KB at 07:17 and
  6,150,505 KB at 19:17 UTC on 10-14, about 100 MB a day over hours that include them), phase 2 grows the repository by
  about 15–30 MB a day: the target of 15 MB a day or less holds only at the low end. The `health` log measures it over
  the first week; the event_map shards are the next lever if it is needed. After that a full repack by GitHub would
  bring the repository to about 0.8 GB; it is an owner request, and on the Free plan GitHub Support may decline it.

Readers of the committed unfrozen partitions, and what phases 1 and 2 did with them: derive's silent-change check
(switched to the event map in phase 1, with the previous derive's Pages copy after a failed derive in phase 2); the
first-solutions one-off slice (`FIRST_SOLUTIONS_DAYS` naming an unfrozen day: switched to the event map; the walk
itself stops at the last frozen day, which from phase 2 it also reads from the event map until a grace day has
passed); `writeDayPartition`'s byte compare (only avoids a rewrite); `validate.ts`, `sign-manifest.ts`,
`publish-r2.ts` (they read the files derive just wrote: kept on disk); derive's statistics (`writeStats` reads the
stats days older than the event map from the data checkout's frozen files); `stats-history.ts` and remediate's
`late_usgs` (they read frozen days by blob from the `data` HEAD: the day that froze at midnight appears with the first
derive commit after it; `stats-history` waits for that commit, and `late_usgs` leaves out the day before it, whose next
day is its context, until a run after that commit);
`scripts/first-observations.ts` (reads
`events/` only for an event the observation log no longer holds, a frozen one). They never read an unfrozen day:
backfill (days before the earliest event_map shard), archive (months over 120 days old), onboard and heal (they write
the event map), remediate (frozen days, from the Release archives), the deep history and the heartbeat Worker. The
in-house consumers read Pages: iOS builds 437–587 take `pages_url` for every day that has one (all unfrozen days do),
`@<data_commit>` for an older frozen day and `url` only for an unfrozen day without `pages_url`; the alerts gateway
takes `pages_url` and falls back to `url`, checked against the signed `sha256`; the iOS statistics mirror reads the
`v1/stats` year and area files from `jsdelivr-sha` and `raw-sha`, which phase 2 does not change.


### Storage phase 3: the event map out of git

**Where the repository stands (2026-11-16).** GitHub counted 6,788,660 KB at 05:39 UTC: 5 GB is passed, and 10 GB,
GitHub's recommendation and this repository's ceiling (nothing is ever rewritten: no history rewrite, no force-push,
owner decision of 2026-11-16), is about 3.2 GB away. Phase 2 brought the growth to about 14–15 MB a day. Of what the
5-minute commits still add, about 58 % is the event map's hour shards (2.9 MB a day packed locally, about 5.0 MB a day
in all; GitHub keeps 1.5–2 times a local pack). The budget, per phase, at GitHub's rate:

| | MB a day | 10 GB reached |
|---|---|---|
| phase 2 (today) | 14–15 | about 0.6 years |
| phase 3a (the soak: git still tracks the event map, in hour shards) | 14–15, plus the generation document's one-line diffs | about 0.6 years |
| phase 3 (the event map out of git) | 8–10.7 | about 0.8–1.1 years (2027-09 … 2028-01) |
| phase 4 (the generation under a ref; about 1 commit a day) | 6.6–8.8 | about 1–1.3 years |
| phase 4 + phase 5 (the rewrite fixes below) | 1.5–2 | about 4.4–5.8 years |

`feed:repo-growth` (P3) files a 7-day growth over the current phase's budget: 16 MB a day through phase 3a, lowered to
11 by the phase-3b PR (`maxMbPerDay`, scripts/lib/findings.mjs); `feed:repo-size` stays at 8,000,000 KB.

**The end state.** Git's `data` holds only what consumers fetch from git: the frozen day partitions and small signed
catalogs, about one commit a day (phase 4). The working state lives in one R2 bucket of content-addressed blobs, with
(phase 4) one compare-and-swap ref to a generation document. Phase 5 takes the public logs out of git (the observation
log and status history to Releases as they close; `v1/stats` delta-friendly or served from elsewhere once the iOS
origin contract allows it; `history.json` and `chunks.ndjson` append-once). Escape route, for when `size` nears 9 GB: a
new data repository for the frozen partitions, added as a new manifest origin; this one is frozen read-only, nothing
rewritten.

**Phase 3, as built.** The event map (45 event-days, about 78 MB of NDJSON, 50,233 nodes on 2026-11-16) leaves git
without rewriting anything. Its day files are blobs in the state store, and the generation document
`knowledge/index/generation.json` names them. The generation is committed in the aggregate commit and the derive
commit, beside `head.json`, `sweeps.json`, `watermarks.json`, the correction and heal markers and `onboard.json`, so
the one `git push` stays the atomic commit and the compare-and-swap of the whole state. Phase 4 moves the same document
to the ref.

- *The store* (`state/`, its README): the Worker `earthquakes-feed-state` at `feed-state.theshelter.app` in front of the
  R2 bucket `earthquakes-feed-state` (staging: `-staging` for both). The key is `cas/sha256/<first 2 hex>/<hex>`, where
  the hex is the sha256 of the stored bytes (the gzip, level 9, of a day's canonical NDJSON: about 0.26 MB a day, 12.1
  MB for the 46 days). No static secret exists. Every request carries a GitHub Actions OIDC token for the audience
  `earthquakes-feed-state`. The Worker admits only this repository's numeric id, `refs/heads/main` (any branch on
  staging), github-hosted runners, `schedule` and `workflow_dispatch`, and per route an allow-list of workflow files.
- *The contract* (protocol 1). Every request sends `Authorization: Bearer <OIDC JWT>`,
  `User-Agent: earthquakes-feed-state-client/1` and `x-feed-state-protocol: 1`.
  - `PUT /v1/cas/sha256/<hex>`: the gzip, with `Content-Length`, at most 25 MiB. Answers 200
    `{key, size, uploaded}`; 411 without a length, 413 over the limit, 400 when R2's sha256 check fails. Always
    written: the same key holds the same bytes, and the write refreshes `uploaded`.
  - `POST /v1/cas:batchGet` `{"shas": [...]}` (1–40): a framed 200 stream. Each blob is `BLOB <hex> <length>\n`, its
    bytes and `\n`; a missing one is `MISSING <hex>\n`; the stream ends with `END <count>\n`. The client fails closed
    on a `MISSING`, a missing trailer, or any length or sha256 mismatch.
  - `POST /v1/gc` `{keep, current, cursor, minAgeDays, maxDeletes, dryRun}`: one listing page; `keep` 1–10,000 blobs,
    `current` 1–40 on the first page and none later (400 otherwise: the client checks before sending, and `state-gc`
    skips a run whose current generation names no blob, as a hold); 409 unless `current` ⊆ `keep` and every `current`
    blob exists. A generation of more than 40 blobs (about 46) goes in chunks of 40 sorted by sha256: each chunk but
    the last in a dry-run first page of its own (one more listing, its counts unused), the last with the real pass's
    first page. The answer counts every listed key once (`kept` in keep, `young`, `capped`, `foreign`,
    `wouldDelete` with `bytesWouldDelete`); `deleted` / `bytesDeleted` are what the call removed, 0 in a dry run.
  - `GET /v1/budget`: `{day, used: {class_a, class_b, bytes_written, requests, refused}, stored_bytes,
    stored_seeded_at, gc_pass_open, ceilings: {class_a, class_b, bytes_written, stored_bytes}}`.
  - The other statuses are 400 (`checksum mismatch` on a PUT is an integrity failure; any other 400 a client bug),
    401 (a token), 403 (a workflow the route does not allow), 426 (a protocol too old), 429 `{"error":"budget"}` (a
    free-tier ceiling) and 500 `misconfigured` (a deploy error). The client (`src/state-store.ts`) retries network
    errors, any other 5xx and any other 429, at most 4 attempts with jittered backoff (or the answer's Retry-After when
    it is at most 60 s; a longer one ends the retries) and at most 90 s of waiting in all, a 20 s timeout each; it
    never retries a 4xx, the budget or a 500 `misconfigured`. A 503 `{"error":"unavailable"}` (the Worker's isolate
    has no GitHub signing key: GitHub's JWKS unreachable and no copy in the isolate, the colo cache or the bucket) is
    retried after at most 3 s whatever its Retry-After (`KEYS_UNAVAILABLE_WAIT_MS`; the Worker refetches a keyless
    isolate's keys within 2 s), inside the step's deadline: with Retry-After 30 a shadow step used to give up at once
    (runs 43907386794 and 43964170954, 2026-11-16). Phase 3a's shadow steps use a tighter policy
    (`SHADOW_RETRY_POLICY`): 2 attempts of at most 15 s (a hydrate batch: 4, below), 8 s of backoff, and a deadline over
    the whole step, OIDC token requests included (hydrate 30 s, persist 60 s), so a hanging store adds at most about
    90 s to an aggregate run; each step writes a `killed` marker when it starts, which its report overwrites, so a step
    its timeout kills still reads as failed. It mints a fresh OIDC token unless the cached one has more than 60 s left
    (concurrent requests share one token request). `FsBackend` is the same contract on a directory (tests,
    `scripts/phase3/dryrun.sh`, a disaster replay).
  - *Blob reads* (`getBlobs`, since 2026-11-19). One batchGet of 40 day blobs is about 10 MB streamed through the
    Worker in one answer, and a stall anywhere in it lost the whole answer: the shadow hydrate failed about once in
    200 runs (runs 44043134871 and 44177064278 on 2026-11-17, a 40-blob body stalled until the 15 s timeout, twice;
    44403949467 on 2026-11-18, a 6-blob request that never answered, twice), each a `feed:state-shadow` row for about
    15 minutes, and phase 3b's hydrate, which fails closed, would have stopped those runs. The client now asks for at
    most 2.5 MB of blobs a request (`BATCH_MAX_BYTES`, by the generation's `blob_bytes`: about 9 day blobs, the 46
    days in 6 requests), 3 in flight (`BATCH_CONCURRENCY`). Each batch has its own 4 attempts (`BATCH_ATTEMPTS`), each
    attempt a timeout of 5 s plus 2 s a MB it asks for (`batchTimeoutMs`: 10 s for a full batch, 5.6 s for one day; at
    most the policy's timeout), and reads the answer as a stream: the blobs that arrived whole and verified are kept,
    and a retry asks only for the rest. A stream that delivered every blob is complete even if its trailer was cut.
    The first batch that fails for good (its attempts or the deadline used up, or a MISSING, an integrity failure, the
    budget, a 1027, none of them retried) fails the whole read: the batches in flight are cancelled and none starts
    after it.
- *The generation* (format 1) is canonical text: one day per line in ascending order, `{"sha256", "bytes", "nodes",
  "blob", "blob_bytes"}` (the NDJSON's sha256, size and node count; the gzip's sha256 and size), plus `head_seq` and
  `parent` (the sha256 of the previous document). The `parent` line changes on every write, so two writers that both
  rewrote it conflict in git instead of merging line by line. A reader refuses an unknown `format`, `layout` or
  `node_schema`, and any bytes that are not the canonical form.
- *The layout* follows git. While git tracks the event map (phase 3a) `saveEventMap` keeps round 17's hour shards,
  `knowledge/index/event_map/YYYY-MM-DD-HH.ndjson`: a commit rewrites ~70 KB shards, where day files of ~1.7 MB would
  add about 7–22 MB a day to the repository for as long as the soak lasts, for ever (round 17's replay: the event map's
  share 13/20/32 MB a day with day files against 6/7.5/10 with hour shards). Once git no longer holds the files
  (phase 3b) it writes one file per day, `YYYY-MM-DD.ndjson`, the store's layout (`eventMapShardHours`), and aggregate
  moves any day left in shards (`moveToDayLayout`); the authoritative hydrate writes day files anyway, so nothing of
  that reaches git. A day's store bytes are `canonicalDay` of its files, whatever their layout: every node once (a
  duplicate keeps the higher `lastSeq`, the later file on a tie), the original JSON lines, in feed-id order, a
  trailing newline, byte for byte the day file `saveEventMap` writes at 24 hours.
- *aggregate* has three steps for the store:
  - The shadow hydrate (before the silent-change snapshot): every checked-out day is compared with its generation
    entry (no network: a difference is a mismatch whatever the store holds). The store is then exercised with the
    days that differ plus a rotating sample of 4 (`SHADOW_SAMPLE_DAYS`, `shadowSample`): consecutive run numbers
    (`GITHUB_RUN_NUMBER`) take consecutive slices of the sorted days, so any 12 consecutive aggregate runs (an hour)
    verify all 46; each fetched blob is checked (the gzip's sha256 by the client, the NDJSON's sha256, size and node
    count). The summary names the changed and the sampled days. Until 2026-11-19 it fetched all 46 days every run
    (12.2 MB, 13,000 Class B a day), which verified the same blobs twelve times an hour; a blob the store lost is now
    found within the hour instead of within 5 minutes, which phase 3a (git is the truth) affords, and phase 3b's
    hydrate fetches every day anyway.
  - Persist (after the Aggregate step): each day whose canonical sha256 differs from its entry is PUT, then the new
    generation is written. A day the previous generation lists that the checkout lacks throws, unless it is below the
    45-day horizon; a removal is never inferred from a missing file. On any store error nothing is written, so a
    generation only ever names blobs that exist, and the next run uploads again.
  - The staging check of every commit that stages `knowledge`: `stage` after aggregate's `git add`, and
    `src/stage-data.ts` for derive-publish, backfill and archive.
- *derive's prune* edits the generation locally (`pruneGeneration`, no network) beside deleting the day files below the
  horizon.
- *Absence is never empty or "today"* (the 2026-11-16 design review):
  - `loadEventMap` throws when the generation lists a day of the load's window that the checkout lacks, or when there
    is neither a map nor a generation (`EVENT_MAP_BOOTSTRAP=1`, or the empty generation `bootstrap-data-branch.sh`
    writes, starts a fresh branch).
  - The floor merge of `saveEventMap` never writes a generation day from moved nodes alone.
  - `liveFloor` (backfill's floor, onboard's live day, archive's refusal) takes the generation's oldest day, else the
    checkout's oldest file, else the oldest name in git's tree (backfill's sparse checkout); an empty generation with
    no event-map file anywhere (a fresh or reset branch before its first aggregate run) or `EVENT_MAP_BOOTSTRAP=1`
    gives today; anything else throws.
  - first-solutions stops on a missing map instead of finishing a day empty.
- *Permissions*: `id-token: write` is held at job level only, by exactly these jobs (tests/stage-data.test.ts names
  them): aggregate, derive.yml, first-solutions' collect, `state-gc.yml`, `state-backup.yml`, `state-rehearsal.yml` and
  health's feed job. Each job-level block restates everything the job needs. The Worker's write list is aggregate (and
  state-rehearsal on staging). derive.yml never writes: its prune is local.

**Phase 3a (this merge): dual write, shadow-verified.** Git still tracks the event map (its hour shards) and stays the truth. The two
aggregate steps are `continue-on-error`: a mismatch or a store error is reported (the step summary, a `::warning::`,
the markers of the artifact `state-shadow`) and never stops the feed (`feed:state-shadow`, P2). The hour shards stay
in git; the repository grows as in phase 2 (the budget table above) plus the generation document's one-line diffs.

**The phase-3a rollout: PR #155 merged inert, a second commit switched the store on.** The production jobs read the
store's switch as `${{ vars.FEED_STATE_BACKEND || 'worker' }}` (aggregate's two state steps, derive.yml's hydrate,
`state-gc.yml`, `state-backup.yml` and health's feed job): on by default since that commit, and the repository variable
`FEED_STATE_BACKEND=off` is phase 3a's kill switch (no commit needed). Off (as in #155 itself, where the jobs read the
variable alone), every state step reports `off` and touches nothing,
GC and the backup complete with an `off` marker, and health judges none of `feed:state-shadow`, `feed:state-gc`,
`feed:state-backup` and `feed:state-budget` (a note). The Worker deploys only from `main` (`state/deploy.sh`), and
`state-rehearsal.yml` can be dispatched only once its file is on the default branch, so, in order:
1. Merge #155 (the store off: the jobs read the unset variable).
2. The owner setup of state/README.md (bucket, zone rules); deploy staging (`state/deploy.sh --env staging`),
   dispatch `state-rehearsal.yml`, check it green.
3. Deploy production (`state/deploy.sh`) and run the checks of state/README.md "Verify".
4. Dispatch `state-backup.yml` and `state-gc.yml` once while the store is still off: each writes its `off`
   marker, so health has a run on record when it starts judging (a backup marker that names no day is aged by its own
   date on the 36 h / 7 d lines, GC's by the 3-day line) instead of filing "none on record".
5. Merge the switch commit (`|| 'worker'`). The next aggregate run persists all 46 days, the one after
   compares them (its shadow hydrate).
6. After that first persist, dispatch `state-backup.yml` and `state-gc.yml` (`dry_run`, the default) and check both
   green; the scheduled runs take over: the heartbeat Worker's dispatches (state-backup at 00:31 and 06:31,
   state-gc at 03:33 UTC; GitHub delivered neither job's cron on 2026-11-16 or 11-17), with the crons (00:41 and 03:23
   UTC) as the fallback.
Switching the store off again in phase 3a is `gh variable set FEED_STATE_BACKEND --body off`; from phase 3b the store
is required (3b removes the kill switch).

Rehearsed on the event map of `origin/data` 1f12e4461c8 (2026-11-16 05:53 UTC; `git archive` of the directory, a
directory store):
- the 1,086 hour shards moved to 46 day files in 1.0 s (the phase-3b layout move);
- the map read from either layout held the same 50,233 nodes in the same order, and `saveEventMap` of the hour-shard
  map wrote 46 of 46 day files byte for byte as the move: `canonicalDay` of each day's hour shards is its day file;
- persist uploaded 46 blobs (12.1 MB) in 1.5 s;
- the shadow hydrate verified all 46 against the checkout in 0.6 s;
- an authoritative hydrate into an empty directory gave the 46 files byte for byte.

`scripts/phase3/dryrun.sh` replays whole cycles (shadow hydrate, snapshot, a real aggregate commit's changes, persist,
the staging check (no day file staged: git keeps the hour shards), an injected lockless commit and its rebase, derive with its generation
prune, validate, stage-data, a closing shadow hydrate and an authoritative one) on a local worktree of `data` with
`FEED_STATE_BACKEND=fs:<dir>`.

**The daily jobs.**
- `state-gc.yml` runs in the writer group (gated, `scripts/writer-queue.mjs` WRITERS), so no persist can re-reference a
  blob while it runs. It keeps:
  - the current generation;
  - the generation at the last data commit before each of the last 31 UTC midnights (GitHub's
    `commits?sha=data&until=` and `contents?ref=`);
  - every daily generation since the first day the backup has not copied.

  It deletes only blobs older than 30 days, at most 600 per listing page, and nothing at all without a readable backup
  marker. A dispatch defaults to `dry_run`; the scheduled run follows `STATE_GC_SCHEDULED` (`dry-run` until the first
  dry runs' counts are reviewed, then `delete` by a commit). The scheduled run is the heartbeat Worker's daily dispatch
  at 03:33 UTC with `tick=1` (which counts as scheduled), or the 03:23 cron when GitHub delivers it. `feed:state-gc` (P2) fires after 3 days without a
  completed run.
- `state-backup.yml` copies each day's state to a draft Release `state-YYYY-MM`, published once the month is over and
  complete. The state of day D is the generation at the last data commit before 00:00 UTC of D, that commit's
  cursors and every blob the generation names. It is one deterministic ustar (sorted members, mtime 0, uid/gid 0)
  compressed with zstd level 19, as the asset `state-D.tar.zst`. The job never uses `--clobber`: an incomplete asset
  is followed by `.g2`. Every upload is checked against GitHub's sha256 digest. The job catches up 25 days, or back
  to the first day its previous marker had not copied (at most 120 days, GC's window: GC keeps those days for it), so
  a longer stall loses no daily state. A month it cannot publish (a tag ruleset, say) stays a draft and is retried; it
  never costs the run its marker. Only a marker of a scheduled or dispatched `state-backup.yml` run on this
  repository's `main` counts, for GC and for health alike: the repository is public, and a pull request's run (a
  fork's included) can upload an artifact of any name. A marker that names no day (no generation yet, or the store
  off) holds GC (nothing deleted) and is aged by its own date in health.
  `feed:state-backup` is P2 past 36 h and P1 past 7 days. The heartbeat Worker dispatches it twice a day, at 00:31 and
  06:31 UTC, so one lost dispatch or failed run is retried hours before the P2 line (12:00 UTC of the next day); the
  00:41 cron is the fallback, and a later run of the day finds every day done. 00:31 leaves the 23:55 aggregate run,
  if it queued behind the writer group, time to push midnight's last commit before the day's archive, which is never
  replaced.
- `state-rehearsal.yml` (dispatch, any branch, staging only, synthetic data only) runs the client's whole path:
  persist, a shadow and an authoritative hydrate, a restore from a backup archive, a GC dry run and the budget.

**Retention.** Every intra-day version of a day stays restorable for 30 days (GC's minimum age), and one state a day
for ever (the Releases). Until phase 3, git kept every 5-minute version for ever; the owner's design decision of
2026-11-16 traded that for the daily copies.

**Cost and budgets (never pay: Workers Free and R2's free tier, enforced in the Worker).**
- Requests (state/README.md has the breakdown): in phase 3a a run makes about 2.4 Worker requests (one batchGet of
  the shadow sample, about 1.4 PUTs), about 830 a day with health's budget reads, the backups and GC. Phase 3b reads
  all 46 days in 6 batchGets a run (and 6 per first-solutions collect): about 2,400 a day, and about 8,000 if every
  batch of every run needed all 4 attempts. That is about 1–2.5 % (at most 8 %) of the account's 100,000 Workers
  requests a day, which the platform's API shares.
- Operations: about 1,200 Class B a day in phase 3a (4 sampled blob reads a run), about 14,400 in phase 3b (46 a run;
  batching does not change it, a blob is one GET), and 400 Class A.
- Storage: about 0.1 GB written a day, about 3.3 GB held at GC's 30-day age, against the account's 10 GB, which the
  platform shares (about 0.4 GB).
- The Worker refuses (429 budget) above its ceilings: 20,000 Class A and 200,000 Class B a day, 1 GiB written a day,
  6 GiB stored. Since phase 4.0 the ceilings have priority lanes: background work (GC, backup, history,
  first-solutions, stats, health) is refused above 60 % of any of them, the feed (aggregate, derive, the restore)
  only above 95 %. `feed:state-budget` fires at 60 % (P2) and on any refusal of the feed's own lane (P1).
- The coupling to the shared request cap: when the account reaches 100,000 requests a day (Error 1027 until 00:00
  UTC), the store refuses with it. In phase 3a that is a `feed:state-shadow` row. From phase 3b the feed stops until
  then; the 30-minute freshness contract is broken, and `feed:freshness` fires. `feed:state-quota` (P1) names the
  cause: health's own budget read, or a job's state step, met a 1027 or a platform 429.

**Outage budget (from phase 3b).** A store outage stops the feed: aggregate fails closed at its hydrate, Pages goes
stale, and `feed:freshness` fires at 30 minutes. No data is lost for about 48 hours: the sources' live query windows
(2 days, `QUERY_LOOKBACK_MS`) and the sweeps' cursors hold what happened meanwhile. Past that, rows older than a
source's own window are lost until a backfill or a `SWEEP_EPOCH` catch-up (7 days). In phase 3a an outage costs
nothing but the shadow.

**Restore** (a store that lost blobs or was corrupted; never a routine rollback).
1. `gh release download state-YYYY-MM -p state-D.tar.zst`.
2. `npx tsx scripts/state-restore.ts state-D.tar.zst --out restored/` verifies every blob the generation names and
   unpacks the archive.
3. Refill the bucket: the owner runs `rclone copy restored/cas r2:earthquakes-feed-state/cas` with their own
   credentials. That is the only production path: the Worker's production write allow-list is `aggregate.yml` alone,
   which never runs the restore, so `--put` through the Worker would need a workflow of its own on that list and a
   Worker redeploy. `--put` through the Worker is the staging path, which `state-rehearsal.yml` rehearses.
4. Bump `SWEEP_EPOCH` on main first: a restored generation is older than the cursors git holds, and the 7-day catch-up
   re-asks the sources for what changed since.
5. Commit the generation under the writer lock: `--data-dir` writes it into a fresh checkout of `data`.

Exit path: the bucket is plain S3 keys; `rclone` it to any S3 store and add an S3 backend beside `FsBackend`.

**Phase 3b (a later PR): untrack.**
- *Gate*:
  - at least 24 hours of phase 3a with no `feed:state-shadow` row;
  - GC (dry runs) and backups green, and the staging rehearsal green;
  - no writer run created before the 3a merge still queued (`node scripts/writer-queue.mjs status`);
  - and from then on, never re-run a run from before 3b.
- *The PR*:
  - Set `EVENT_MAP_STORE_AUTHORITATIVE = true` in `src/event-map-store.ts`. Its effects:
    - aggregate's hydrate replaces the checkout's event map with the generation's days, every day already identical
      on disk kept, and fails on anything;
    - a persist failure fails the run;
    - `EVENT_MAP_IN_GIT` defaults to 0, and with it the commit step's `stage` makes the transition: the
      `.gitignore` lines `knowledge/index/event_map/*` and `!knowledge/index/event_map/0000-00-00.ndjson`,
      `git rm --cached` of every tracked event-map file (phase 3a's hour shards; they stay on disk), and the tracked
      sentinel `0000-00-00.ndjson`;
    - `saveEventMap` writes one file per day (`eventMapShardHours` is 24 once git no longer tracks the map) and
      aggregate moves any day left in shards (`moveToDayLayout`): the layout move happens off git;
    - every later commit refuses a staged event-map file;
    - derive-publish's hydrate after the push restores any day a push retry's rebase removed;
    - first-solutions' collect hydrates before it reads.
  - Remove `continue-on-error` from aggregate's and derive.yml's two state steps. The hydrate then runs with
    `AUTHORITATIVE_HYDRATE_POLICY`: all 46 days (12.2 MB, a fresh checkout has none) in 6 batches, 3 in flight, 4
    attempts a batch of at most 20 s each (10 s for a full batch), 15 s of backoff a request, and a 60 s deadline
    over the step, after which it fails closed (the run stops; the next one tries again 5 minutes later). A run needs
    2–4 s, a stalled batch about 15 s more. Its 2-minute `timeout-minutes` stays the backstop. Persist runs with the
    client's default policy (`SHADOW_RETRY_POLICY` applies only while `EVENT_MAP_STORE_AUTHORITATIVE` is false), up to
    about 87 s a request, so raise its `timeout-minutes` to 4.
  - Lower `feed:repo-growth`'s `maxMbPerDay` to 11 (scripts/lib/findings.mjs).
- *The sentinel* is one line that is not JSON. Code from before 3a that parses it throws instead of reading an
  untracked map as empty, and its live floor becomes `0000-00-00`, so an old backfill writes nothing. New code skips
  it.
- *Rollback after 3b*: a revert to 3a, which fails closed on a checkout without day files, so the revert must restore
  the tracked files first. Hydrate authoritatively, commit the day files with the sentinel and the ignore lines
  removed, then revert.

**Phase 4.0: the Worker's protocol 2, inert.** The state Worker gained one compare-and-swap ref per writer lane
(`refs/main`, `refs/main-shadow`, `refs/first-solutions`, `refs/history`) and a create-only reflog
(`gen/<lane>/<seq>`), the mechanism phases 4.1–4.5 move the mutable state onto (state/README.md "Protocol 2"). A ref
names a generation blob and its place in the chain (seq, parent, head_seq, data_commit, the writer run with a nonce);
the Worker swaps it only to the direct successor of the version the writer read (If-Match), answers 412 with the current
ref otherwise (the writer fails closed, no automatic rebase), and keeps every version in the reflog, the future GC root
set, backup index and restore index. Allow-lists are (repository_id, workflow) pairs, ready for the escape route's
second repository; a restore is admitted only for `state-restore.yml` in the GitHub Environment `state-restore`, which
the owner creates with a required reviewer before that workflow lands (state/README.md, Owner setup). The
step changes nothing in production: no job calls the new routes, `MIN_PROTOCOL` stays 1, and the blob routes are
unchanged apart from the priority lanes above. Its gate is `state-rehearsal.yml` on staging: R2's create-only
precondition, two racing writers (exactly one 412), the ambiguous-answer reconcile, the reflog repair and at most 5
store operations per ref PUT, each reported in the job summary. If the race shows R2's conditional put is not atomic,
the refs move to a row of the Worker's Durable Object (`REF_BACKEND = "do"`) behind the same API; if the binding does
not honour the configured create-only form, `CREATE_ONLY_FORM` moves to the form the probe proved (or `"off"`, with
every lane bootstrapped by the runbook).

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

The side index of earliest solutions follows the editions back to 2000-01-01, no further (*Earliest solutions* below):
era A gives it about
2.8 M more ComCat reports (one request each), about 1.2 M NCEDC / SCEDC reports read through ComCat and about 0.37 M
INGV reports, at its own hourly pace (about 43,000 ComCat reports a day: about three months).

**Era B** (owner decision 2026-11-08) goes on from 1999-12 back to 1973-01 with ComCat (`usgs`) alone, M ≥ 4.5 only:
324 months, walked newest first after era A, one edition per month (the PDE, the USGS Preliminary Determination of
Epicenters, as ComCat serves it: US public domain). Measured 2026-11-08 with ComCat's own `count` service:

| | Era B (1973-01 → 1999-12) |
|---|---|
| Events (= rows: one source) | 106,270 M ≥ 4.5 (160,001 M ≥ 4.0); 194–651 per month (1973-05 the fewest, 1994-10 the most); no month empty |
| Event types | earthquake 105,708, nuclear explosion 541, explosion 14, mine collapse 5, rock burst 2 (kept as ComCat has them, so the counts match ComCat's; a reader counting earthquakes drops the 562) |
| Preferred origin (`provenance[].fields.net`) | `us` (PDE) 98.80 %; the ANSS regional networks ComCat serves (`nc`, `ak`, `ci`, `uw`, `hv`, …) 1.02 %, `US-PD` as live; ISC-GEM (`iscgem`, `iscgemsup`) 175 rows, 0.165 %, under their own licence (*Licensing*); `gcmt` 13 |
| Release assets | 24 per `history-YYYY` (12 raw + 12 editions), 648 in 27 new Releases `history-1973` … `history-1999`: about 7.8 MB raw + 15.5 MB editions |
| Requests | 648 (ComCat's `count` and one query per month, each answering in about 1 s) |
| Walk time | about 15–25 s per month on a runner: about 8–14 hourly runs |
| `knowledge/index/history.json` | about 1.4 KB per month: about +444 KB |

Its entry in `providers/history.json` is `{"id":"B","from":"1973-01-01","to":"2000-01-01","minMagnitude":4.5,
"fetchMarginMag":0,"expectRows":true,"sources":["usgs"]}`. With one source an event's largest magnitude is its only row's,
so the margin below the floor that a multi-source era needs (*Pace*) would only fetch rows the build drops: era B asks
ComCat from M4.5 exactly (`fetch_min_magnitude: 4.5`), and every fetched row is written. Every month has rows, so an
empty answer fails the month (`expectRows`) instead of being sealed. **A reader must honour `min_magnitude`:** an era-B
edition (`era: "B"`, `min_magnitude: 4.5`) holds only M4.5+ events and is never comparable with an all-magnitude month;
PDE's M4.5+ completeness also grows over the period (about 25.6k, 39.5k and 43.1k events per decade). Era B meets era A
only at the seam: 1999-12 is built against the first day of 2000-01's current edition like any month (*How a month is
built*; the dry run of 2026-11-08 joined 0 rows there), and a later edition of 2000-01 does not rebuild it. Nothing
before 1973: ComCat's older records are the ISC-GEM catalogue's (CC BY-SA 3.0). The side index of earliest solutions
does not follow era B (`DEEP_WALK_FLOOR`, *Earliest solutions*).

**Where it lives.** Everything is an immutable asset of a Release `history-YYYY` (the year of the month):

| Asset | What it is |
|---|---|
| `raw-<source>-<YYYY-MM>.ndjson.zst` | one source's answer for one month, normalised by the feed's parser: a header line (`kind: "earthquakes-feed/history-raw"`: the range, the queries' windows, the rows each answered, the source's own count where it has a count service (ComCat, EMSC), `fetched_at`), then one report per line |
| `events-<YYYY-MM>.e<N>.tar.zst` | the month's events: `DD.ndjson` day files in the day partitions' feature format (the same as `archive-YYYY-MM`), plus `_edition.json` (sources, the raw assets it was built from with their checksums, row counts, `joined_newer`) |

An asset is never overwritten or deleted. A failed upload leaves its name behind as `unused` and the walk takes the next
free name (`raw-usgs-2022-12.g2.ndjson.zst`); when a source joins an era, each month gets a new edition (`e2`) built
from all its raw assets, newest month first, and the older edition stays. The index of all of it is the walk's one file
for readers on the `data` branch: `knowledge/index/history.json` (read it through jsDelivr pinned to the manifest's
`data_commit`, `https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@<data_commit>/knowledge/index/history.json`;
jsDelivr's `@data` can answer 403 for a file its branch package no longer holds). It lists each raw asset
(`url`, `sha256`, `bytes`, `rows`, `provider_count`, `fetched_at`) and each edition (`url`, `sha256`, `events`, `days`,
`sources`, `built_from`); a month's current edition is its highest `edition` not `withdrawn`. A re-merged edition also
has `merge_epoch`, `merged_from`, `lines` and `superseded` (*Re-merged history*). It changes only when the walk publishes or
takes over an asset. Its `attempts` is always `{}` since round 24 (2026-10-13): the walk's bookkeeping is in its other
file, `knowledge/index/history-state.json` (a few hundred bytes, written in the same commit): `attempts`, keyed
`<source>:<YYYY-MM>`, each source month whose fetch failed (`failures` in a row, `since`, `last_error`, `not_before`
for a Retry-After), and `stall`, the run of no-progress runs (`since`, `runs`, `unexplained`, `alarmed_at`; null while
the walk moves). Before, each run in which a month failed rewrote the whole index to count one more failure (about 150
commits of the 2.3 MB file in the week of EMSC's 2017-12); now such a run commits only the small file, and a run that
changes neither commits nothing. Each `_edition.json` names its newer
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
time it named, `attempts[].not_before` in `history-state.json`), a window that fills the page or times out split in
two, a month that cannot be fetched whole fetched again next run (a month that has failed a day of runs turns the run
red, once). A month's first failure stops its source for the run, and so does a rate limit (that pause, or HTTP 429
through every retry); a month that failed before no longer holds back the
source's older months, which go on (at most three failed months per source a run), so one bad month never stalls the
source's walk again (round 23: EMSC's 2017-12 held it six days), though no older month is sealed until it is fetched.
The two sources with a count service, ComCat and EMSC (`fdsnws/event/1/count`, asked in the source's query format: ComCat
`geojson`, EMSC `json`; measured 2026-10-06, none of the other 15 FDSN services the feed reads answers one), are asked
for their count first and every window's rows must equal it. One exception, measured and checked against that count:
EMSC answers some events it counts as empty elements of its json `features` array (`},,{`), and leaves them out of
`format=text` too, so no format answers them (2017-12: count 3,803, 3,793 events in json and in text, ten empty
elements on 12-11 and 12-22). Such a window is narrowed by halves down to an hour and kept only when its rows plus its
empty elements equal the source's count: the raw header says how many (`unserialized_rows`, and `unserialized` per
window) and the index entry lists each such window with its count (`raw[].unserialized`: an explicit gap; the month's
other rows are complete). Any other unreadable answer still fails the month. The live fetch and the EMSC revision sweep
read such an answer too, with no count to check: the empty elements are left out and still take their places on the page,
so a page they fill to the limit is full and the sweep asks for the next one (round 25). A month is sealed (its next edition built, verified and
uploaded) as soon as its last source arrives, and a run first seals what an earlier run left complete. At most
`maxUnitsPerRun` source months and `maxSecondsPerRun` per hourly run; neither job holds the writer lock (the index
commit pushes through `scripts/push-data.sh`, FEED-OPS-4). A month a source answers empty right before a month of the
same source with rows is either where a catalogue starts (going back) or a service answering empty while it is broken
(NOA's registered node answered 204 to every query for ten days, PF-5j-NOA). The walk tells the two apart before it
keeps anything: it asks the source again for a two-hour window around the newer month's first, middle and last row
(stopping at the first that answers a row). A row there keeps the empty month (the catalogue starts; named in the
run's `report.json` `empty_after_rows` and as a warning); no row, or an error, fails the month like any other failure,
so nothing empty is sealed while the service is down and the month is asked again next run. An era whose every month
has rows sets `expectRows: true` in `providers/history.json`: an empty answer there fails the month at once, without
that check. An era with a magnitude floor (`minMagnitude`) fetches rows from the floor minus `fetchMarginMag` (default
0.5, so a quake one agency puts just over the floor and another just under keeps both rows; a single-source era sets 0):
the raw header's `fetch_min_magnitude` records it, and the edition's `min_magnitude` is the floor its events reach.
The heartbeat Worker dispatches the workflow at `:26` (GitHub delivers this repository's hourly crons only a few times
a day), and a run does nothing unless `providers/history.json` has `enabled: true`. The walk and first-solutions'
`collect` job (dispatched at `:48`) take turns in one concurrency group, so they never ask a host at the same time: a
history run held it 5.4–17.8 minutes (20 era-A runs, 2026-10-06), a first-solutions collect job 31.2–33.2 minutes (53
runs), and the Worker's runs start 25–44 s after their minute, so each turn ends about 4 minutes before the other's
begins. Neither workflow has a cron of its own (round 22, R16-FOLLOWUPS (7)): GitHub delivered each one's hourly cron 8
times in the 48 hours to 10-06 20:20 UTC, at whatever minute it reached it, and every delivery was a second run in the
hour. A cron-started first-solutions run queued behind the Worker's and then held the group from about `:20` to `:52`,
across history's turn: 10 of the 48 Worker-started history runs waited 2.2–31 minutes (9 behind a cron-started or
delayed first-solutions run, 1 behind a cron-started history run), and GitHub, which keeps one pending run or job per
group, cancelled 3 cron-started runs while they waited. Replayed without those deliveries, the same 48 hours have no
wait and no cancellation in the group. Since the 2026-11-15 audit both sides of the group (history.yml's workflow-level
group and the `collect` job's) set `queue: max`, so a run or job that waits for the group is kept until its turn, in
arrival order, instead of being cancelled by the next one to arrive. The fallback for a Worker outage is `walk-fallback.yml`
(`scripts/walk-fallback.mjs`): on its `:29` and `:50` crons it reads the walk's newest `workflow_dispatch` run and
dispatches the walk as the Worker does only when that run is more than 2 h 5 min old (two missed ticks; the Worker
missed 1 of 48 first-solutions ticks in those 48 hours, 10-06 19:48, and a single miss costs one hour of the walk). It
holds a group of its own, so a delivery that finds nothing to do never waits behind a walk or cancels one. Its `:45`
cron does the same for `backfill.yml`'s backward walk (the Worker dispatches it at `:41`), which lost its own hourly
cron for the same reason (2026-11-15: 4 of 30 backfill runs were cron deliveries, each a second walk in its hour that
took a writer-queue slot the gate counts).

**When the walk stops.** A run with work left (source months to fetch, or complete months to seal) that fetches, seals
and takes over nothing is a no-progress run. It is explained when it only waited for a source's Retry-After, was
rate-limited, or ran out of its time budget, and nothing failed for another reason. The 24th unexplained no-progress run
in a row (a day of hourly runs), or the 72nd of any kind (a walk that only ever waits, or a month never fetched whole
within `maxSecondsPerRun`, has stopped too), is a block with what is left and the months that keep failing, stated in
the walk's marker (`walks:history:run`) by every run while it lasts (SHLTR-151; until then one run a day, 23 h apart,
and the 26 h hold carried the board in between; `alarmed_at` still records that daily repeat); the streak is `stall`
in `history-state.json`. A source month that has failed 24 runs is a block of its own (`walks:history:<source>`) on
every run until it is fetched. Progress, or no work left, ends the stall. Round 24 added it: since round 23 a month that never succeeds lets its source's older months go on,
so its own alarm (one red run, at its 24th failure) came long before the walk ran out of other work, and the walk then
stopped silently once only that month was left. A month whose seal or re-merge throws (an asset unreadable for now or
no longer matching its index checksum, a line that does not parse, a failed upload) is a block of that month for the run
(`history: sealing|re-merging YYYY-MM failed: …`), tried once a run; the fetches and the other months go on, and its
older months wait for it as they wait for any newer month (2026-11-15; before, the throw stopped the whole walk, the
fetches included). Only an upload that reads back with other bytes still stops the run.

**Dry runs.** `gh workflow run history.yml -f dry_run=true` (or `HISTORY_DRY_RUN=1 HISTORY_FORCE=1` locally, with
`DATA_DIR` a copy of the `data` branch's `knowledge/index`) creates no Release, uploads nothing and commits nothing: the
assets go to `history-out/releases/<tag>/` (a 3-day workflow artifact), and the published assets the index lists are
read from the Releases, read only, so a dry run can build a month's next edition. A local dry run continues from its own
`history-out/history.json` and `history-out/history-state.json` (a run writes both every time). `-f sources=ingv` (`HISTORY_ONLY_SOURCES`) limits a dry run to some sources; it seals
nothing that needs another source. The dry run stays in the walk's concurrency group: it asks the same hosts.

## Remediation editions (saturated days and the 2026-07 seam)

Three kinds of days are incomplete for some sources although they are frozen:

- **Saturated days.** When even a one-day backfill window filled a source's page cap, the walk kept the capped rows
  (the day is partial for that source) and listed the day in its cursor (`saturatedDays` in
  `knowledge/index/backfill.json`). On 2026-10-04 that was KAGSR 2025-07-30 (the day after the M8.8 Kamchatka
  mainshock), 23 AFAD days of the Sındırgı sequences (2025-08-11 to 08-25 and 2025-10-28 to 11-12) and IMO 2023-11-11,
  2025-04-01 and 2025-05-24. All but KAGSR 2025-07-30 got their editions on 2026-10-04 (dispatches named their days;
  the scheduled run then took the refill queue only). KAGSR 2025-07-30, measured read only on 2026-11-14: KAGSR's
  answer for the whole day holds 676 events (and one for 2025-07-29 .. 08-01, 1,004: KAGSR applies no 500-row cap; the
  backfill's custom-source rule, an answer of 490 rows or more in the window is an overflow, marked the day), the 24 hour windows of
  the day sum to the same 676 ids, and the archived day (`archive-2025-07`, `events-2025-07.e3.tar.zst`) holds 578 of
  them: 98 KAGSR events of the day are missing (60 with ids above the newest one archived: KAGSR added them after the
  backfill fetched the day in July 2026). Since SHLTR-151 such a day is a block on backfill's marker
  (`walks:backfill:<source>`) on every run until an edition completes it (a raw asset of the source and day, not
  partial, in the day's current edition), and the daily scheduled run takes the saturated days too: those of an
  archived month (a frozen day whose month is not archived yet waits for it), never a day older than the source's
  retention (a warning instead), and a day whose raws were uploaded without an edition is built again from them.
- **The seam** 2026-06-28 → 07-03 05:42 UTC, which 15 sources never fetched (*History and backfill*).
- **Late ComCat** (since 2026-11, SHLTR-150): ComCat's M4.5+ solutions published or revised after the live day froze
  (*Late publications*).

The feed never rewrites a frozen day or a published asset, so they are not repaired in place. The `remediate`
workflow (`src/remediate.ts`) publishes ADDITIVE day editions instead, for archived days (the first two kinds) and for
frozen days not archived yet (late ComCat):

- the saturated days are its default tasks on a dispatch; an explicit refill (inputs `refill`, a range of at most 31
  days, and `providers`, a comma list or `bootstrap-2026-07-05` for the 15 seam sources) is added to the PERSISTENT
  refill queue, `refill_queue` in the index (`range`, `providers`, `reason`, `queued_at`). Every run, and a scheduled
  run once a day (04:43 UTC: the queue and, since SHLTR-151, the saturated days, at most 3 days a run), takes the
  queue's days whose month is archived and leaves the others
  queued; a day leaves the queue once every source of its entry has a raw asset of it and its current edition is
  built from all of the day's raws. 2026-07-01…07-03 are queued so and are taken by the first scheduled run after
  `archive` rolls July (on or after 2026-11-29). A source the day is older than the retention of (registry
  `retentionDays`; AFAD, SHLTR-146) is not asked and needs no raw asset: the day is built from its other sources and
  the edition names it in `not_fetched` (`provider`, `reason: "retention"`, `retained_from`, `note`), so 2026-07-01…07-03
  carry `usgs`, `emsc` and the other 12 sources, not AFAD;
- a run works day by day (ascending, at most `max_days`); each source of the day is asked again for the whole day in
  6-hour windows (a saturated day in 1-hour windows, since SHLTR-151), each halved while its answer fills the cap (down to 5 minutes; a window still full there marks the
  day `partial`), one request at a time, at least 1.1 s apart. When a source fails, the day's successful raw assets are
  uploaded and indexed, and no edition is built: the next run asks only the sources that have no raw asset of the day
  yet and builds the edition from all of them;
- the archived day is read back from its archive asset (read only), and each neighbour as a consumer reads it: its
  current remediation edition when it has one, else its archived day. AFAD rows the archive holds 3 h early (before
  2026-10-01, see *Turkey (AFAD)*) are re-read at their real time and folded, as the one-time correction did for the
  unfrozen days, so the day has one time base; then the fetched rows, and the rows of every other raw asset of the day
  the index lists, go through the ingest screen and backfill's Resolver;
- the result is ONE edition per day, whatever the number of sources: the complete day in the day-partition format,
  published as `events-<day>.e<N>.ndjson.gz` beside one `raw-<source>-<day>.ndjson.gz` per source (a header line, then
  exactly the rows the source answered) in the Release `remediation-YYYY`. Editions built since 2026-11-08 carry
  `review_status` on their lines where the event's rows give one; the editions of 2026-10-04 do not and keep their
  bytes. All assets are immutable; a later remediation of the same day is the next edition, built from the archive
  and every raw asset of the day. Each upload is read back and its checksum compared; a day whose upload or read
  throws is a failed day (the run goes on, writes the index with what every other day uploaded, then ends red; after 3
  such days in a row it starts no further day);
- an edition replaces ONE archived day while its neighbours stay as archived, so it holds the archived day's events by
  feed id plus the events the remediation minted. An AFAD event re-read across midnight keeps the day its archive gave
  it (its time may then lie up to 3 h into the next day; `stats.off_day`), the AFAD re-read and its folds stay among
  the day's own events, and an event archived on a neighbouring day never enters the edition (a fetched row that
  joins one is counted in `stats.neighbour_joins` and stays unpublished; the event itself stays in its archive). Before
  upload the edition is checked: no report live twice in it, and none it adds live in a neighbouring archived day, so
  reading the edition instead of the archived day never drops an event or publishes one twice.
- **Late ComCat** (`reason: "late_usgs"`): once a day the scheduled run asks ComCat (the `usgs` source) again for every
  frozen day the archive has not rolled yet, from 45 days ago to the last frozen day whose next day is frozen too
  (12–45 days old: the live run owns the 11 newest, and mints late ComCat events of its first 7 itself) and on the
  `data` branch or archived (a day that froze at midnight is committed by the first derive run after it: until then the
  day before it waits for a later run; a day missing behind newer committed ones is a gap and holds nothing back), one whole-day
  fetch in 6-hour windows per day, at least 1.1 s apart. It compares ComCat's M4.5+ set with the `usgs` rows the day
  holds (the `usgs` raw asset its current edition was built from, else the current edition, else the frozen partition;
  ids matched through ComCat's `ids` too): the day changed when ComCat lists an M4.5+ solution the day holds no row of
  or holds below M4.5, a solution moved by 0.3 or more, or one the day holds at M4.5+ is now below it. A changed day
  gets an edition built like every other but on the day's **frozen partition** (`built_on`: `{"tag": "data", "asset":
  "events/YYYY/MM/DD.ndjson", "sha256", "blob"}`; neighbours read as consumers read them, a frozen partition counting as
  the neighbour's archived day), with ComCat's whole answer of the day as its raw asset; an unchanged day publishes
  nothing. Each refresh of a day builds on the partition again with ComCat's newest answer, and is compared next time
  with that answer, so a day gets a new edition only when ComCat changed again since its last one. The index keeps one
  `late_usgs` entry per day: a new one replaces the day's earlier `late_usgs` editions and their raw assets in
  `remediation.json` and names the editions it replaced in `superseded` (their assets stay in the Release). Unlike the other editions
  it does not re-read the partition's AFAD rows stored 3 h early (before 2026-10-01): it adds ComCat's rows and moves
  nothing else (the month's re-merge re-times them). A row ComCat no longer
  lists (deleted upstream) is reported (`gone`) and kept: an edition never removes a row. Before upload, beyond the
  checks above, every event and every report of the partition must be in the edition and every other source's live
  report must still be live in it. The mode of the scheduled run is `LATE_USGS_SCHEDULED` in `src/remediation.ts`
  (`plan`: ask and compare, publish nothing, the log lists what `on` would build; `on`; `off`); a dispatch with
  `late_usgs` (`plan` or `on`) runs it at once — a dispatch is a dry run unless `dry_run` is false: it builds into
  the run's artifact only, publishes nothing and ends with a `DRY RUN` warning — over `late_usgs_range` (at most
  31 days) instead of the last 45 for the frozen days older than that (the one-time catch-up of 2026-07…10). When the
  month rolls, the archive holds the partition byte for byte, so the edition still replaces the day: the archive
  re-merge (*Re-merged history*) takes an edition built on the partition whose archived file has the same sha256. A
  day older than 45 days whose current `late_usgs` edition is built on another blob than its partition holds now (a
  backfill rewrites the days below the live floor, about 45 days back, exactly the days that just left the window) is
  asked again by the scheduled run whatever its age, after the window's days so they keep the run's cap
  (`late_usgs.stale` in the report), and rebuilt on the current
  partition, so the edition never shadows the backfilled rows and the month's re-merge is not blocked at the roll.
  The scheduled run comes from GitHub's cron alone (the heartbeat Worker does not dispatch `remediate`, `remerge` or
  `stats`; README, *Cron-only workflows*): a late or dropped delivery delays a day's refresh and loses nothing, since
  every day stays in the 12–45-day window for 33 daily runs.

`knowledge/index/remediation.json` lists every raw asset (`provider`, `day`, `rows`, `requests`, `partial`,
`sha256`, `reason`, …) and every edition (`day`, `edition`, `url`, `sha256`, `built_on`: the archive asset and its
checksum, `built_from`: the raw assets, `reason`: `saturated` or `seam` (absent on the entries of 2026-10-04: `saturated`),
`context`: by day, the archive asset or the neighbour's edition the build read, with its checksum (absent on the
entries of 2026-10-04: archives only), and `stats`: events before and after, new, retired, off the day, rows changed /
unchanged, rows that joined a neighbouring day, AFAD rows re-read, rows per source before and after; `reason`
`late_usgs` on the late ComCat entries; `not_fetched`, the sources of the day's tasks not asked, on an edition built
without one). The archived day, its `archive-YYYY-MM` asset, the frozen partition and the
manifests (`manifest.json` and the signed v2 manifest, which list neither) are unchanged: a consumer that wants the
repaired day reads the current edition (the highest `edition` of the day not `withdrawn`) instead of the archived day or
the frozen partition, as the statistics builder does.
When the archive month is re-merged (*Re-merged history*), each of its remediated days gets a refreshed edition built
on the new archive asset (`built_on`), with `stats.remerge` set.

## Earliest solutions (side index)

What did a source publish *first* for an event, and when? The log answers that since 2026-07-05, up to the polling
interval; backfilled history cannot. Some sources keep a version history of their own, and the
[`first-solutions`](.github/workflows/first-solutions.yml) workflow collects it into a side index, for every report in
the feed's day partitions: the 3-year layer from 2023-07-06, the deep history before it as far back as its monthly
editions reach without a gap (*Deep history* above; that walk builds months newest first), but never before 2000-01-01
(`DEEP_WALK_FLOOR` in [`src/first-solutions-collect.ts`](src/first-solutions-collect.ts)), and every day since, once its
partition is frozen (ten days). The floor is there because ComCat's records before 2000 are catalogues loaded into it
years later (the PDE): their version history holds bulk reloads (2014–2022 on a sampled 1985 event), not earliest
solutions, and walking it would cost about 106,000 ComCat requests and download every pre-2000 edition for nothing. Nothing in the day partitions, the archives, the deep-history assets or the log
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
does); `walk-fallback.yml` dispatches it the same way only after the Worker has missed two ticks in a row (the
workflow's own `:50` cron, removed in round 22, started a second run in the hour across the deep-history walk's `:26`
turn; see *Deep history*). The Worker is needed: GitHub delivered this repository's hourly
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
honoured); a lane that still fails stops for the run and resumes there; a corrupt line of the day partition the lane
reads its ids from is skipped with a warning, not a stop; 50 answers in a row without the event stop a
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
carry another solution), PHIVOLCS and JMA (their lists gave the origin to the minute when this was measured), GFZ,
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
location (see *Retired events*); a ComCat delete of the id does not withdraw their row. SCEDC also lists distant large
quakes with NEIC's solution (`Author` "US", `GT` "t"): since round 26 such a row and ComCat's `us…` row of the same
solution count as one solution even in a dense cell, and SCEDC's placeholder place for them ("###.# km ( ###.# mi) …")
is read as no place (see *Regional agencies outside their own region*).

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
drop EMSC's `auth: "AFAD"` copy of it. The feed's own readers of that history (the offline re-merge, the statistics
builder) apply this through `normalizeRows` (src/row-normalize.ts, below *ISC*): an AFAD row in an event of AFAD's
rows only is re-timed; one that joined another source's event at its wrong time is left there.

**Retention (SHLTR-146).** AFAD's event service (`apiv2/event/filter`) answers a time-range query from its newest
1,000 events only. Measured on 2026-11-14 16:34 UTC with one-day queries 1.5 s apart: every day from 2026-11-03 on
answered in full (37 to 117 rows a day), 2026-11-02 answered its last 11 events (21:18:10 on), every older day
(2026-11-01, 10-31, 10-28, 10-24, 10-17, 09-30, 08-01, 2025-08-11) answered 0 rows with HTTP 200; the days from
2026-11-02 21:18 on sum to exactly 1,000 rows, a query for 2026-11-02 .. 11-15 with `limit=2000` returns exactly those
1,000, and one for 2026-01-01 .. 11-02 21:00 with `minmag=4` returns none. At AFAD's rate then (about 85 events a day)
that is about 11.8 days; a swarm shortens it (the Sındırgı sequence listed 400–600 events a day). On 2026-10-04 the
same service still answered 2025-08 in full (the remediation of 23 Sındırgı days), so the limit is newer than that;
on 2026-11-08 the seam days 2026-06-28..30 already answered 0 rows. The registry says `retentionDays: 7` for `afad`
(src/retention.ts): backfill and remediation never ask it for a day before the last 7 whole days. A backfill window
older than that is skipped with the reason `retention` (the run's log and the dry run's plan list it day by day; a walk
whose next window lies wholly before it is done with `stoppedBy: "retention"` in `knowledge/index/backfill.json`; a
dispatched window that is still open there is closed), and a remediation day older than that is built without AFAD,
its edition naming it in `not_fetched` (*Remediation editions*). Neither is a block on the health board: nothing more
can be fetched. A swarm can shorten the store below the 7 days (FEED-DI-2), so since 2026-11-16 every AFAD window query
first asks the store over [window start, now] with `limit=1000`: when that answer holds 1,000 events and its oldest is
more than 60 s after the window start, the window fails (`afad: its newest 1000 events, all it answers for, begin at
…`) instead of reading as filled; backfill halves a walk's window or blocks on a dispatched one, as for any failure (on
2026-11-16 the store began 2026-11-04 01:50:49 UTC, 12 days back). The live path asks AFAD for its last 2 days, with
no such query, and is not affected. Since every backfill window lies
before the live floor (the oldest `event_map` day, about 45 days back) and every queued refill day is archived, AFAD's
history before the live floor can no longer be refilled from AFAD at all: what the archives and frozen partitions hold
is all there is. The AFAD raw assets of the seam editions of 2026-06-28..30 (`raw-afad-2026-06-2{8,9}`,
`raw-afad-2026-06-30`, 0 rows each, fetched 2026-11-08) are such retention answers, not quiet days.

## ISC (International Seismological Centre)

`isc` reads ISC's FDSN event service (`format=text`), one row per event: ISC's preferred hypocentre and magnitude.
The live path does not ask it (`liveActive: false`: ISC publishes with a delay of months) and its backfill walk is
paused (*History and backfill*), so ISC rows exist only in the archived months it walked: 2024-05, 2025-02 and
2025-08-03 onward (until 2026-06 in the archives).

**Two bulletins.** For the months ISC's analysts have reviewed, the preferred hypocentre is mostly ISC's own (`Author`
`ISC`: 1,981 of the 4,160 ISC rows of 2024-05). For the later months ISC serves its preliminary bulletin: each event's
hypocentre and magnitude are contributed agencies' (no `ISC`-authored row in 2025-02, 2025-08, 2025-09, 2025-12 or
2026-03), the magnitude often from another agency than the hypocentre (`Author` / `MagAuthor`).

**Geoscience Australia's Mw is not taken.** In the preliminary bulletin the preferred magnitude is often Geoscience
Australia's automatic moment magnitude (`MagAuthor` `AUST`, `MagType` `Mw`/`Mww`), which runs high, most of all in a
large quake's aftershock sequence. Checked 2026-11-08 against ISC's own answer (the stored row is ISC's answer byte for
byte, the time included; ISC's QuakeML with all origins and magnitudes shows where the value comes from):

| ISC event | Stored | What it is |
|---|---|---|
| 644158618 | 2025-09-18 19:08:09.91, DSN hypocentre east of the Kuril Islands, "Mw 8.22 AUST" | an aftershock NEIC puts at mb 5.2–5.8, 10 minutes after the Kamchatka mainshock (644156780, 18:58:14.94, Mw 7.86 GCMT); AUST's own origin is 19:08:24.82 |
| 643915176 | 2025-08-22 05:18:56.64, GFZ hypocentre, "Mw 7.02 AUST" | a Drake Passage aftershock, three hours after the Mw 7.5 (02:16:18); ComCat us6000r2z8 mb 5.1, NEIC mb 5.1 in ISC's own event |
| 643915158 | 2025-08-22 03:17:23.77, IDC hypocentre, "Mw 6.22 AUST" | ComCat us6000r2yx, mb 5.1 |
| 644818774 | 2025-12-08 22:07:19.37, GFZ hypocentre, "Mw 7.20 AUST" | an aftershock of the Aomori Mw 7.6 of 14:15: ComCat us6000rtin, 22:07:18.80, mb 5.0 |

Over the archives 2025-08 and 2025-09, ISC's preferred magnitudes of M4.5+ against ComCat's of the same quake (±10 s,
50 km): AUST Mw (90 rows, 73 matched) median +0.14, p90 +0.83, 19 rows +0.5 or more, 6 +1.0 or more; NEIC mb (475) and
NEIC Mw (119) p90 0.00, GCMT Mw (135) p90 +0.26, NIED, IPGP and GFZ within +0.4. The times are right: the ISC rows of
large quakes that matched no ComCat event within 120 s were real (mostly aftershock) origins whose magnitude was AUST's.
Since 2026-11-08 the parser reads such a row without `mag` and `magType` (`iscUntrustedMagnitude`, src/fdsn.ts); the
row's `fields` keep `Magnitude`, `MagType` and `MagAuthor` as sent. The published archives keep the old rows; the
re-merge and the statistics builder correct them as they read them (`normalizeRows`, src/row-normalize.ts: also AFAD's
3 h, above). Per archive: 2025-02 28 rows (16 representing their event), 2025-08 64 (33), 2025-09 29 (19), 2025-12 16
(4), 2026-03 35 (5), 2024-05 none; the live M6+ events of 2025-08 go from 76 to 72 and of 2025-09 from 50 to 44
before any fold.

**Split copies.** ISC's preliminary rows re-publish the contributing agency's origin: 110 of the 116 ISC-represented
M5+ events of 2025-08 and 2025-09 have another live event within 60 s and 150 km, many at 0 km and 0.0 s (NEIC's
origin beside ComCat's `us…` row, GFZ's beside GEOFON's). Backfill ingests with the merge pass off, so they stay two
events until a re-merge folds them, and in a swarm cell (a quake's own aftershocks) the merge joined them only on a
shared id. **Dedup epoch 2** (config `ISC_ORIGIN_COPIES`, `Resolver.iscCopy`; *Re-merged history*) makes such a row a
copy, as good as a shared id, also in a swarm cell: an ISC row whose `Author` is `NEIC`, `GFZ`, `AUST` or `RSPR` and
whose origin lies within 1 s and 5 km of that agency's own row (ComCat's `us…` row, GEOFON's, GA's through AusPass,
ComCat's `pr…` row), whatever the two magnitudes (ISC's preferred magnitude is often another agency's); and an ISC row
of another author within 1 s and 5 km of NEIC's or GFZ's row with the magnitudes within 1.0. Over the archives
2025-08/09: 1,773 of the 2,026 `NEIC` rows lie at 0.0 s / 0.0 km of a `us…` row, all 246 `GFZ` rows at 0.0 s / 0.0 km
of GEOFON's, 34 of 62 `AUST` rows of GA's, all 35 `RSPR` rows of a `pr…` row. ISC's preliminary bulletin also lists one
quake under several ISC ids, one per contributing agency's origin (the Kamchatka M6.0 of 2025-08-09 14:04 as NEIC's
origin 643893330 and IDC's 643893547), so from epoch 2 an ISC row that is such a copy no longer keeps two events apart as
"ISC under two ids".

## Canada (NRCan)

NRCan's data is under the Open Government Licence – Canada 2.0, which asks for this statement and a link to the
licence: "Contains information licensed under the Open Government Licence – Canada"
(https://open.canada.ca/en/open-government-licence-canada). The feed carries it in `metadata.attribution`, NOTICE and
ATTRIBUTIONS.md.

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

NOA's automatic system also locates large quakes far from Greece (`Author` `scautoloc@sc3-prime`), without a magnitude.
Since round 26 such a solution outside Greece is held: it joins the quake's event when a window takes it, and is
otherwise kept out of the live set (see *Regional agencies outside their own region*).

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

## Australia (GA, AusPass)

The `ga` source reads Geoscience Australia's RSS of its last 7 days (`earthquakes.ga.gov.au`, ids `ga2026tgusvy`) and
the `auspass` source reads AusPass's FDSN event service (`auspass.edu.au`, ANU), which serves GA's catalogue under GA's
ids with the prefix `smi:local/` (`smi:local/ga2026tgusvy`). Measured on 2026-10-06: AusPass's 6,811 events of 2024-01 →
2026-09 all carry `Author` "GA (via ANU)", `Contributor` "Geoscience Australia" and an id `smi:local/ga…`; the 214
AusPass ids of 2026-07-05 → 07-28 (while the feed read GA's RSS) are all among GA's 219 ids of those days (GA's RSS
listed 5 more); the 12 ids both sources gave the feed (origins 2026-09-29/30) are 12 events holding both rows. The two
solutions of one id can differ, one source holding an earlier one: of the 214 July pairs, GA's RSS solution and
AusPass's today are 0.05 km apart at the median, 63 more than 1 km and 6 more than 10 km (up to 31.7 km, an M5.0 south
of the Kermadec Islands); GA's FIRST RSS solution of those ids was 2.3 km from AusPass's at the median, 30 more than
10 km and up to 83.4 km (an M5.0 off Honshu, revised to AusPass's position by the RSS the next day; review). AusPass imports GA's solutions in batches days after the origin, and the feed asks it for the
last 2 days, so few of its events reach the feed through it: 18 ids since 2026-07-05, against 689 AusPass events of
2026-07-05 → 09-30. GA's RSS is the source that carries GA's catalogue in time (silent from 2026-07-30 until the parser
fix of 2026-10-06, issue #59; of the 71 Australian events of 2026-07-05 → 09-30 with neither row, 65 reached the feed
through another source, 63 of them through EMSC, and 6 small ones, at most M2.8, did not). The deep history reads
AusPass alone (GA has no event service for the past), so its editions hold AusPass rows and no GA row.

Since round 20 (`CATALOGUE_MIRRORS` with `CATALOGUE_MIRROR_ID_PREFIX`, src/config.ts) the feed treats AusPass's and GA's
rows of one GA id as one report, as it treats RESIF's and RéNaSS's (*France*): a report joins the event its twin is in
however far a revision has moved it and however dense the cell, the merge pass may fold two events holding the twins,
and an id is compared in GA's own form, so AusPass's row of one GA id beside GA's row of another is that catalogue's
other quake. Before, the two rows joined only by place: a replay of the whole observation log (2026-07-05 → 10-06,
210,615 lines) gives the same events either way, since the 12 pairs it holds joined by place; with AusPass's 214 July
rows added to it (each 24 h after its origin, as AusPass imports late), the rules before round 20 leave 5 GA ids in two
events each (four AusPass rows in an event of their own: two 24 and 32 km from GA's RSS solution, two 3 and 7 km from it
in dense cells, the Taupō area and the Kumamoto aftershock zone; and one in the other event of an M6.3 off Mexico the
feed holds as two), these rules none, and no event holds two GA ids either way; nothing else changes but the event GA's
row of the Kermadec M5.0 sits in (AusPass's twin instead of GeoNet's M4.5, one quake in two events either way). Both
rows stay in the event, each with its own attribution and licence; count them once when you count independent agencies.
Nothing about the published or stored shape changes, and the deep-history editions build as before (no GA row to pair
with).

## Sources looked at and not added

The monthly discovery (`discover.yml`, src/discover.ts) lists every FDSN event service in the
[FDSN data centre registry](https://www.fdsn.org/ws/datacenters/1/query) that answers with rows and is not yet a
source. Its suggested registry entry claims no licence (`license: "unknown"`): the probe reads none. A service looked
at and declined goes into `DECLINED` in src/discover.ts with the issue that holds the evidence, so the next run does
not list it again. ComCat's regional networks, PNSN among them, were looked at in 2026-09; only Alaska's AEC was
added then (*Alaska (AEC)*). California's NCEDC and SCEDC, also ANSS regional networks, were sources from the start
(2026-07-05).

**GeoShake (`api.geoshake.org`, issue #38), declined 2026-10-06.** All pages and the service read 2026-10-06.

- Who: the GeoShake Global Seismic Network, FDSN network `GW` (start 2026, DOI
  [10.7914/ft1b-4x43](https://doi.org/10.7914/ft1b-4x43); [fdsn.org/networks/detail/GW](https://fdsn.org/networks/detail/GW/),
  operator GeoShake, Türkiye), community-hosted stations with uncalibrated low-cost MEMS accelerometers and no instrument
  response, which the network page itself says is not equivalent to a calibrated strong-motion or broadband network. Its
  data centre `GEOSHAKE` ([fdsn.org/datacenters/detail/GEOSHAKE](https://www.fdsn.org/datacenters/detail/GEOSHAKE/),
  updated 2026-09-06) serves fdsnws-station, fdsnws-event and SeedLink. The site's terms name APPFLOWS TEKNOLOJİ ANONİM
  ŞİRKETİ (Antalya, Türkiye) as the operator ([geoshake.org/terms](https://geoshake.org/terms), last updated 2026-10-02);
  the developer page signs as "GeoShake Collective" ([api.geoshake.org/developer](https://api.geoshake.org/developer)).
- The event service (version 1.0.0; its WADL lists time, box, magnitude, `limit`, `format` xml / text and `nodata`, no
  `updatedafter`, no `eventid`; `/catalogs` and `/contributors` answer 404) is the site's web application, served on
  both `api.geoshake.org` and `map.geoshake.org`. Its whole catalogue is four events, ids 10–13, 2026-09-18 → 10-03, all
  in western Puerto Rico (ids 1–9 are gone, without a delete marker). Each is GeoShake's own automatic origin from three
  stations (`usedStationCount` 3, `standardError` 42–1,702), with no depth, and its "magnitude" is a Modified Mercalli
  intensity estimated from the peak ground acceleration, type `MMI`, which the QuakeML itself calls "NOT a seismic
  magnitude" (the [open-data page](https://geoshake.org/open-data) and the
  [catalogue on Zenodo](https://zenodo.org/records/21313786) say the same). They are not copies of another agency's
  solutions.
- Against the feed's events (the `data` branch, 2026-10-06): event 10 (09-18 13:19:36.7, MMI 3.7) is the M4.8 near
  Guánica (ComCat `pr2026261000` / `us7000tiar`, EMSC), 1.6 s and 9 km from it; event 11 (19:28:36.9, MMI 1) is ComCat's
  M3.0 `pr71532618`, 3.7 s and 25 km; event 13 (10-03 10:35:46.6, MMI 2.4) is the M3.85 north-west of Rincón (ComCat
  `pr2026276000` / `us6000tzc3`, EMSC), 8.3 s and 29 km. Event 12 (09-27 21:50:45.7, 18.37° N 67.30° W, MMI 1) has no
  other quake within 400 km and 30 minutes in the feed, nor within 10 minutes in ComCat between 16–21° N and 64–70° W,
  than the M4.8 in the Dominican Republic (`us6000ty0q`, 21:49:47.5, 185 km west): the waves of that quake, located at
  the stations, 58 s late. So: no event the feed lacks, and one of four mislocated.
- Speed: neither format carries a creation or publication time, so no first-solution time can be measured from the
  catalogue, and no new event appeared while it was polled (below). The feed had the three real quakes 6.9 min (M4.8),
  51 min (M3.0) and 11.6 min (M3.85) after their origins, through ComCat and EMSC.
- Terms: the data is CC BY 4.0 by the registry page, the open-data page (citing the network DOI) and Zenodo, and the
  event service is open to programs: the FDSN data centre entry says all data is served anonymously under CC BY 4.0
  with no registration, API key or rate agreement, and the developer page offers the FDSN services without a key
  (100 requests per 5 minutes per IP, ObsPy named). Against that, the site's general terms forbid automated access
  (bots, scrapers) to its services without GeoShake's consent and reproducing or distributing its content without
  authorisation, and `map.geoshake.org/robots.txt` disallows `/fdsnws/` and `/api/` for every crawler (the same
  application answers `/fdsnws/` there; `api.geoshake.org/robots.txt` redirects to the map's home page, so that host
  has no robots file of its own). Read together (review, 2026-10-06): the FDSN pages are the consent the general terms
  ask for, so the licence would allow an adapter with attribution; the terms are not why GeoShake was declined.
  GeoShake says it is not an official early-warning service.
- Uptime: 40 polls 2 minutes apart, 2026-10-06 16:28–17:46 UTC: every one answered (30 with the four events, 10 with
  HTTP 204 for a 3-day window that holds none), in 1.5 s on average and 15.8 s at most; no new event in that time.
  Nothing older is known: the registry page was last updated 2026-09-06 and the monthly discovery first saw the node
  on 2026-10-01. The review's re-probe (17:53 UTC, text and QuakeML of the whole catalogue) got the same four events in
  0.65 s, and matched them against ComCat and EMSC itself (the same pairs, 1.6–8.3 s and 8.5–29 km; event 12 58 s and
  185 km from `us6000ty0q`).

Why not: no event the feed does not already have, no faster solution that can be shown, a magnitude field that is not a
magnitude (it would put an M4.8 into the summaries as 3.7 and break the magnitude gates of the event matching), no
depth, and one of four events mislocated by 185 km. Look again if the network starts publishing seismic magnitudes,
depths and creation times and lists quakes no agency has; then read its terms again (above). `DECLINED` also holds
`map.geoshake.org`, the same service under the map's host name.

**NIEP / INFP Romania (`eida-sc3.infp.ro`, issue #136), declined 2026-11-16.**

- Where it comes from: not from the FDSN registry. NIEP's data centre entry there lists dataselect, station,
  availability, wfcatalog and psd on `https://eida-sc3.infp.ro`, and no fdsnws-event. The event service is the curated
  lead `http://eida-sc3.infp.ro/fdsnws/event/1/query` in src/discover.ts: an unadvertised SeisComP event service on
  NIEP's EIDA waveform host.
- Reachability: it answered 1 of 3 monthly probes (2026-11-01, over http, 3 events as text; whether it serves https is
  unconfirmed) and timed out on 2026-11-16 together with every other infp.ro host.
- Terms: no licence or terms of use found for the event service.
- Coverage: NIEP's solutions already reach the feed through EMSC, which carries NIEP as the author: 6 of the 11 Romanian
  events of 2026-11-01..15 on the `data` branch (the other five: EMSC 4, MCSM 1).

Why not: no event or solution the feed lacks can be shown, the service is unadvertised and not reliably reachable, and
its licence is unknown. Look again if NIEP registers an fdsnws-event service with stated terms. The curated lead stays
in src/discover.ts, so removing the `DECLINED` entry brings the monthly probe back.

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
const h = await (await fetch(`https://cdn.jsdelivr.net/gh/${m.data_repo}@${m.data_commit}/knowledge/index/history.json`)).json();
const ed = h.editions.filter(e => e.period === '2022-12' && !e.withdrawn).sort((a, b) => b.edition - a.edition)[0];
// ed.url: events-2022-12.e<N>.tar.zst, a zstd tar of DD.ndjson day files; check it against ed.sha256.
// Keep feed.state === 'live' only: a re-merged edition also holds superseded lines (Re-merged history).
// ed.min_magnitude: the edition's floor (era B, 1973-1999: 4.5); never count such a month as all magnitudes.
```

## Versioning

Everything is under `/v1/`. Fields are additive within a major version (new optional
fields never break old parsers). A breaking change ships as `/v2/` with `/v1/` kept
for a deprecation window. The statistics (*Statistics*) version on their own: a new optional column keeps
`format: 1`; an incompatible change is a new directory and the manifest key `stats2`.

## Licensing

Data is [CDLA-Permissive-2.0](LICENSE); each record carries its source's license in
`provenance[].license`. Keep the `metadata.attribution` string when redistributing.
See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) and [TAKEDOWN.md](TAKEDOWN.md).

**Records under another catalogue's license.** A source can distribute another catalogue's solutions: ComCat's preferred
origin is sometimes the ISC-GEM Global Instrumental Earthquake Catalogue's (`fields.net` `iscgem` or `iscgemsup`), which
is [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Such a provenance row carries that catalogue's
license (`CC-BY-SA-3.0`), attribution ("ISC-GEM Global Instrumental Earthquake Catalogue (International Seismological
Centre and GEM Foundation), via U.S. Geological Survey (ANSS ComCat)") and DOI
([10.31905/D808B825](https://doi.org/10.31905/D808B825)) instead of ComCat's `US-PD`: check `provenance[].license` per
row, not per source. The list lives in `providers/registry.json` (`catalogues` of a provider, keyed by `fields.net`;
[`src/row-license.ts`](src/row-license.ts)) and in [ATTRIBUTIONS.md](ATTRIBUTIONS.md). The ANSS regional networks ComCat
serves (`nc`, `ci`, `ak`, …) stay `US-PD`, as ComCat distributes them. A row keeps the license it was minted with: rows
already stored (day partitions, archives, history editions) change only when they are built again. The Global CMT
Project licenses nothing but asks to be cited (its moment magnitudes are in many ComCat records): the citation is in
[NOTICE](NOTICE).

Two licences ask for a fixed statement and a link beside the source's attribution, and `metadata.attribution` carries
both: NRCan's rows (`OGL-Canada-2.0`): "Contains information licensed under the Open Government Licence – Canada"
([licence](https://open.canada.ca/en/open-government-licence-canada)); BGS's rows (`OGL-3.0`): "Contains public sector
information licensed under the Open Government Licence v3.0"
([licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)). A redistribution that keeps
`metadata.attribution`, or NOTICE, keeps both.
