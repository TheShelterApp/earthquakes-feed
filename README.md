# earthquakes-feed

An open, free earthquake feed. A GitHub Actions job aggregates earthquakes from 18
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
Start from the manifest; don't hardcode paths.

```bash
# Catalog: every summary + partition, with freshness and cache hints:
curl -s https://earthquakes-feed.theshelter.app/v1/manifest.json

# The current day, all 18 sources deduped (one CORS-open request):
curl -s https://earthquakes-feed.theshelter.app/v1/all_day.geojson

# One recent day as a ready-to-render FeatureCollection (Pages, last 120 days):
curl -s https://earthquakes-feed.theshelter.app/v1/events/2026-07-04.geojson

# Any historical day as NDJSON, straight from the data branch (full history):
curl -s https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@data/events/2026/07/04.ndjson
```

### Rolling summary feeds (USGS-style matrix)

`/v1/{threshold}_{window}.geojson`, `threshold ∈ {all, 1.0, 2.5, 4.5, significant}`,
`window ∈ {hour, day, week, month}` — e.g. `4.5_week.geojson`, `all_hour.geojson`.
`all_month` is capped at M≥1.0 to stay small; `significant` is `sig≥600` or `mag≥6`.

### Historical day slices

Same Features, two shapes per UTC day:

- `/v1/events/YYYY-MM-DD.geojson` — FeatureCollection on Cloudflare Pages, last 120
  days. Convenient for map time-sliders.
- `events/YYYY/MM/DD.ndjson` — one Feature per line, full history, on the `data`
  branch (via jsDelivr `@data`). Discover paths, counts, and `frozen`/`pages_url`
  through `manifest.json`.

### The Feature shape

Top-level `properties` is USGS-style (`mag`, `place`, `time` in ms, `updated`,
`status`, `net`, …). Feed-specific data lives under `properties.feed`:

```jsonc
{
  "type": "Feature",
  "id": "efd_01KWQM1FJ06ZG64AHRSAVXS7CW",     // stable feed id, never churns
  "geometry": { "type": "Point", "coordinates": [lon, lat, depthKm] },
  "properties": {
    "mag": 4.6, "magType": "ml", "place": "…", "time": 1783204207460,
    "updated": 1783204304415, "status": "reviewed", "net": "usgs", "type": "earthquake",
    "feed": {
      "feed_id": "efd_…",
      "event_time": "…Z", "ingest_time": "…Z",   // the two clocks
      "first_seen_seq": 1516, "ingest_seq": 1702, "revision": 3, "tombstone": false,
      "chosen_provider": "usgs",
      "aliases": ["usgs:us7000nabc", "emsc:20260704_0000117"],
      "provenance": [ { "provider": "usgs", "native_id": "us7000nabc", "mag": 4.6,
        "status": "reviewed", "license": "US-PD", "attribution": "…", "chosen": true }, … ]
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
WebSocket event that shares an alias or falls within ±60 s / ±10 km.

## Sources

18 networks, configured in [`providers/registry.json`](providers/registry.json)
(add more — see [CONTRIBUTING.md](CONTRIBUTING.md)). A server runner has no CORS limit,
so the feed carries national sources a browser can't reach directly, down to small
local magnitudes. Full credits: [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

- **Global (FDSN):** USGS/ANSS, EMSC/CSEM, GEOFON.
- **Europe (FDSN):** INGV (Italy), RESIF (France), NOA (Greece), ETHZ (Switzerland), KNMI (Netherlands).
- **Americas / Oceania (FDSN):** NCEDC + SCEDC (California), NRCan (Canada), GeoNet (New Zealand), AusPass (Australia).
- **National APIs (custom adapters):** AFAD (Turkey, to ~M0.6), CENC (China), NCS (India), TMD (Thailand + Myanmar), KAGSR (Russia — Kamchatka/Kurils).

Kazakhstan, Kyrgyzstan, Uzbekistan, Tajikistan, Turkmenistan, Belarus, Ukraine, Iran,
and Pakistan have no open real-time earthquake API (KNDC is CTBTO-restricted; others
publish only delayed waveforms). Those regions are covered only via the global
catalogs until an open source appears.

## Architecture

- **Source of truth** is an append-only **observation log**
  (`knowledge/observations/…`) on the `data` branch — one bitemporal record per
  provider report, with a global monotonic `seq`. It is never rewritten.
- Everything consumers read (summaries, day partitions, `manifest.json`) is a
  **rebuildable derived view** of that log.
- **Two phases:** `aggregate` (fetch → dedup → append the log) → `derive` (rebuild
  views, publish). Each source fetch is fail-open — one dead source loses nothing.
- **Serving split:** the live surface (summaries + recent day files + manifest) is
  published to **Cloudflare Pages** via Direct Upload (which doesn't consume the
  500 git-builds/month cap); full-history partitions serve from the `data` branch via
  **jsDelivr** (branch refs cache ~12 h — resolve through the manifest). Never
  `raw.githubusercontent.com` (60 req/hr/IP).

## Run locally

Requires Node 20+.

```bash
npm install
npm test          # identity / dedup / swarm-guard / revision tests
npm run typecheck

# Run the pipeline against a scratch dir (hits live public APIs, read-only):
DATA_DIR=.data npm run aggregate                 # fetch → dedup → append log
DATA_DIR=.data PUBLIC_DIR=public npm run derive  # summaries + day files + partitions + manifest
DATA_DIR=.data PUBLIC_DIR=public npm run validate
```

## Deploy (for a fork)

1. **Bootstrap the data branch:** `bash scripts/bootstrap-data-branch.sh && git push -u origin data`
2. **Cloudflare Pages** (for the live surface): create a Direct-Upload Pages project,
   point your domain at it, and add repo secrets `CF_API_TOKEN` + `CF_ACCOUNT_ID`.
3. **Enable Actions.** `aggregate` runs on a cron; `derive` runs after it and on its
   own cron fallback. Because GitHub throttles low-activity schedules, an external
   5-minute heartbeat (`workflow_dispatch`) is recommended for tight freshness.

## Licensing & takedowns

The compilation is [CDLA-Permissive-2.0](LICENSE); each record carries its source's
own license in `provenance[].license`. We publish factual seismic parameters (not
copyrightable expression) and honor removal requests reactively — see
[TAKEDOWN.md](TAKEDOWN.md) and [SECURITY.md](SECURITY.md).

## Status

Live end-to-end: 18 sources, stateful dedup, bitemporal log, 20 rolling feeds,
per-day partitions + Pages day files, manifest, CI, and Cloudflare Pages serving.
State scales: `event_map` is sharded by day and pruned to a 45-day dedup horizon,
with older identity preserved in the day partitions.

Historical **backfill** (paced, idempotent, ~3-year target) and monthly **Release
archival** of cold months are implemented (`backfill.yml` is dispatch-only and the
auto-fill cron turns on once archival is confirmed rolling).

**Roadmap:** `updatedafter` revision/tombstone tracking; `@sha` immutable partition
URLs; `op:merge` survivor selection; knowledge-time snapshots; an external 5-minute
heartbeat for tighter freshness. Contributions welcome.
