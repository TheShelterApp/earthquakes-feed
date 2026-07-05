# earthquakes-feed — API reference

A static-file API over a CDN. No server, no keys, no rate limits, full CORS
(`Access-Control-Allow-Origin: *`). Everything is GeoJSON or NDJSON.

**Golden rule:** fetch `manifest.json` first and resolve every other path from it.
Don't hardcode partition/summary paths or `@sha` URLs — they can move (freezing,
archival, redaction).

## Surfaces

| Surface | Base | Use | Cache |
|---|---|---|---|
| Cloudflare Pages | `https://earthquakes-feed.theshelter.app/v1/` | live feed, recent day files, manifest | `max-age=30` + SWR |
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
| `summaries` | map of `{name: {path, url, count}}` for the 20 rolling feeds |
| `partitions[]` | per-day: `{date, path, url, pages_url?, count, bytes, min_mag, max_mag, frozen}` |
| `archives[]` | rolled-up cold months: `{period, tag, asset, url, bytes, sha256, count, days[]}` |

`partitions[]` overrides `archives[]` for any day present in both.

### `GET /v1/{threshold}_{window}.geojson` — rolling summaries

`threshold ∈ {all, 1.0, 2.5, 4.5, significant}`, `window ∈ {hour, day, week, month}`
(20 files, USGS-style). A `FeatureCollection` with `metadata` (`generated` ms,
`age_seconds`, `count`, `attribution`). `all_month` is capped at M≥1.0; `significant`
is `sig≥600 || mag≥6`.

```bash
curl -s https://earthquakes-feed.theshelter.app/v1/all_day.geojson
```

### `GET /v1/events/YYYY-MM-DD.geojson` — recent day (map time-slider)

Ready-to-render `FeatureCollection` for one UTC day, last 120 days, live events only.
Same Feature shape as the summaries.

### Historical day partitions (full history)

One Feature per line (NDJSON), all states (`live`/`tombstoned`). Resolve the path and
freshness from `manifest.partitions[]`:

```bash
# via branch (12 h cache):
curl -s https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/events/2026/07/04.ndjson
# immutable (cache forever) — use manifest.data_commit for a frozen day:
curl -s https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@<data_commit>/events/2026/07/04.ndjson
```

### `GET /v1/status.json`

Last run's per-provider health, counts, timings, `degraded[]`.

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
| `state` / `tombstone` | `live`\|`tombstoned`\|`superseded` (filter `state==='live'` for a map) |
| `chosen_provider` | which provenance row won the top-level fields |
| `aliases[]` | every `provider:native_id` for this event (for realtime dedup) |
| `provenance[]` | every reporting provider with its solution + `license`/`attribution`/`doi`, and `fields` = that provider's **complete original vocabulary** (nothing dropped) |

## Freshness contract

Scheduled runs are best-effort. A consumer should compute
`age = (Date.now() - metadata.generated) / 1000` and, if it exceeds
`manifest.freshness.stale_after_seconds`, mark the layer **degraded** and fall back to
its own realtime source (e.g. the EMSC WebSocket) if it has one.

## Realtime + client dedup

The feed is a near-real-time *archive*, not a millisecond bus. Clients that also run
the EMSC WebSocket should reconcile: index `feed.aliases[]`, and treat a WebSocket
event as the same quake if it shares an alias or falls within **±60 s / ±10 km**.

## Recipes

```js
// Current week, one CORS-open fetch:
const fc = await (await fetch('https://earthquakes-feed.theshelter.app/v1/all_week.geojson')).json();
const stale = (Date.now() - fc.metadata.generated) / 1000 > 1800;

// Time-slider: fetch a specific recent day
const day = await (await fetch(`https://earthquakes-feed.theshelter.app/v1/events/${isoDate}.geojson`)).json();

// Deep history immutably:
const m = await (await fetch('https://earthquakes-feed.theshelter.app/v1/manifest.json')).json();
const p = m.partitions.find(x => x.date === '2025-03-14');
const url = p.frozen
  ? `https://cdn.jsdelivr.net/gh/${m.data_repo}@${m.data_commit}/${p.path}`
  : p.url;
```

## Versioning

Everything is under `/v1/`. Fields are additive within a major version (new optional
fields never break old parsers). A breaking change ships as `/v2/` with `/v1/` kept
for a deprecation window.

## Licensing

Data is [CDLA-Permissive-2.0](LICENSE); each record carries its source's license in
`provenance[].license`. Keep the `metadata.attribution` string when redistributing.
See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) and [TAKEDOWN.md](TAKEDOWN.md).
