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
| `partitions[]` | v1 entries plus `sha256`; `frozen: true` means the bytes never change again |
| `tiles` | the offline region bundle `{version, url, sizeBytes, sha256}` (from `region-tiles/regions-db.json`), or `null` |

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

Ready-to-render `FeatureCollection` for one UTC day, live events only, **full-fat**
(complete `feed.provenance[]` incl. `fields`). Exists for the days currently in the live
event-map window (~45 days) — a partition's `pages_url` is present in `manifest.json`
**iff** its day file is actually deployed; for any other day use the partition `url`
(NDJSON, same full-fat Features, one per line).

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
