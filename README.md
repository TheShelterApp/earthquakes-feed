# earthquakes-feed

**An open, free, worldwide earthquake feed.** A GitHub Actions job aggregates
earthquakes from many seismic networks every few minutes into one most-complete,
deduplicated feed, and **Git preserves the full history** so anyone can replay both
*what happened* and *what the feed knew* at any past moment. Free for the whole world.

- 🌐 Feed: `https://earthquakes-feed.theshelter.app` *(Cloudflare Pages — enabled once configured)*
- 📦 Also servable free via jsDelivr straight from the `data` branch (see below)
- 🧭 Format: a **USGS-GeoJSON superset** — any USGS-GeoJSON parser works unchanged
- 🆓 $0 to run (public repo → free Actions) and $0 to consume (CDN + full CORS)

> This repo is an open community dataset stewarded by
> [TheShelterApp](https://github.com/TheShelterApp); see [GOVERNANCE.md](GOVERNANCE.md)
> and [RELATIONSHIP.md](RELATIONSHIP.md).

## Consuming the feed

Everything is plain GeoJSON/NDJSON over a CDN with `Access-Control-Allow-Origin: *`.

```bash
# The current day, all sources deduped (one CORS-open request):
curl -s https://earthquakes-feed.theshelter.app/v1/all_day.geojson

# The catalog of everything available (rolling feeds + historical partitions):
curl -s https://earthquakes-feed.theshelter.app/v1/manifest.json

# One historical day (event-time), straight from the data branch via jsDelivr
# (note: branch refs are cached ~12h at the CDN — resolve paths via the manifest):
curl -s https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/events/2026/07/04.ndjson

# The same day as ready-to-render GeoJSON on Pages (last 120 days):
curl -s https://earthquakes-feed.theshelter.app/v1/events/2026-07-04.geojson
```

### Rolling summary feeds (USGS-style matrix)

`{threshold}_{window}.geojson`, where `threshold ∈ {all, 1.0, 2.5, 4.5, significant}`
and `window ∈ {hour, day, week, month}` — e.g. `4.5_week.geojson`, `all_hour.geojson`.
(`all_month` is capped at M≥1.0 to stay small.)

### Historical event-time slices

Two shapes per UTC day, same Features:
- `/v1/events/YYYY-MM-DD.geojson` (Pages, last 120 days) — ready-to-render
  FeatureCollection for map time-sliders.
- `events/YYYY/MM/DD.ndjson` (data branch / jsDelivr, full history) — one Feature
  per line. Discover paths and freshness via `manifest.json` (`partitions[]`,
  `frozen`, `pages_url`).

### The Feature shape

Top-level `properties` is populated USGS-style (`mag`, `place`, `time`, `updated`,
`status`, …). Everything feed-specific lives under `properties.feed`:

```jsonc
{
  "type": "Feature",
  "id": "efd_01KWQM1FJ06ZG64AHRSAVXS7CW",      // stable, feed-assigned, never churns
  "geometry": { "type": "Point", "coordinates": [lon, lat, depthKm] },
  "properties": {
    "mag": 4.6, "magType": "ml", "place": "…", "time": 1783204207460, "updated": 1783204304415,
    "status": "reviewed", "net": "usgs", "type": "earthquake",
    "feed": {
      "feed_id": "efd_…",
      "event_time": "…Z", "ingest_time": "…Z",   // the two clocks
      "first_seen_seq": 1516, "ingest_seq": 1702, "revision": 3,
      "chosen_provider": "usgs",
      "aliases": ["usgs:us7000nabc", "emsc:20260704_0000117"],
      "provenance": [ { "provider": "usgs", "native_id": "…", "mag": 4.6, "status": "reviewed",
                        "license": "US-PD", "attribution": "…", "doi": null, "chosen": true }, … ]
    }
  }
}
```

## Sources

**18 networks active**, via [`providers/registry.json`](providers/registry.json)
(add more — see [CONTRIBUTING.md](CONTRIBUTING.md)). A server runner has no CORS limit,
so the feed carries national sources a browser can't reach directly, down to very small
local magnitudes. Full credits: [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

- **Global / multi-region (FDSN):** USGS/ANSS, EMSC/CSEM, GEOFON.
- **Europe (FDSN):** INGV (Italy), RESIF (France), NOA (Greece), ETHZ (Switzerland), KNMI (Netherlands).
- **Americas / Oceania (FDSN):** NCEDC + SCEDC (California), NRCan (Canada), GeoNet (New Zealand), AusPass (Australia).
- **National APIs (custom adapters, fill gaps USGS misses):** AFAD (Turkey, to ~M0.6), CENC (China), NCS (India), TMD (Thailand **+ Myanmar**), KAGSR (Russia — Kamchatka/Kurils).

**Honest coverage gaps:** Kazakhstan, Kyrgyzstan, Uzbekistan, Tajikistan, Turkmenistan,
Belarus, Ukraine, Iran, Pakistan have **no open real-time earthquake API** (KNDC is
CTBTO-restricted; others expose only delayed waveforms). Those regions are covered
only via the global catalogs (USGS/EMSC/GEOFON) until an open source appears.

## Architecture (short version)

- **Source of truth** = an append-only **observation log** (`knowledge/observations/…`),
  one bitemporal atom per provider report, with a global monotonic `seq`.
- Everything consumers read (rolling feeds, day partitions, `manifest.json`) is a
  **rebuildable derived view** of that log.
- **Two phases:** `aggregate` (fetch → dedup → append log, fail-open per source) →
  `derive` (rebuild views, publish). Data lives on an append-only **`data` branch**
  that is never force-pushed.
- **Serving:** immutable history via jsDelivr `@sha`; the fresh live feed via
  Cloudflare Pages **Direct Upload** (which does *not* count against the 500-builds
  free cap). Never `raw.githubusercontent.com` (60 req/hr/IP).

## Develop / run locally

Requires Node 20+.

```bash
npm install
npm test              # unit tests (identity / dedup / order-independence)
npm run typecheck

# Run the pipeline against a scratch data dir (hits live public APIs, read-only):
DATA_DIR=.data npm run aggregate                      # fetch → dedup → append log
DATA_DIR=.data PUBLIC_DIR=public npm run derive       # summaries + partitions + manifest
DATA_DIR=.data npm run validate                       # schema + size gate
```

## Deploy (one-time setup)

1. **Bootstrap the data branch:** `bash scripts/bootstrap-data-branch.sh && git push -u origin data`
2. **Enable Actions** — `aggregate` runs every 5 min, `derive` after it.
3. **(Optional) live domain:** create a Cloudflare Pages project named
   `earthquakes-feed`, point `earthquakes-feed.theshelter.app` at it, and add repo
   secrets `CF_API_TOKEN` + `CF_ACCOUNT_ID`. Until then the feed serves free via jsDelivr.

## Licensing & takedowns

The compilation is **[CDLA-Permissive-2.0](LICENSE)**; each record carries its source's
own license in `provenance[].license`. We publish factual seismic parameters (not
copyrightable expression) and honor removal requests reactively — see
[TAKEDOWN.md](TAKEDOWN.md) and [SECURITY.md](SECURITY.md).

## Status

**Live.** Working end-to-end: 18 sources, stateful dedup, bitemporal log, 20 rolling
feeds, day partitions, manifest, CI, Cloudflare Pages serving. Not yet built: more
national adapters (Caucasus/SE-Asia HTML sources), hourly knowledge-snapshots + replay
endpoint, `op:merge` survivor selection, Releases archival, and `backfill`.
Contributions welcome.
