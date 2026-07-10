# earthquakes-feed

An open, free earthquake feed. A GitHub Actions job aggregates earthquakes from 38
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

# The current day, all 38 sources deduped (one CORS-open request):
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

For an **immutable, cache-forever** copy of a `frozen` partition, pin it to the
manifest's `data_commit` (a git SHA) instead of the `@data` branch ref:
`https://cdn.jsdelivr.net/gh/TheShelterApp/earthquakes-feed@<data_commit>/events/YYYY/MM/DD.ndjson`.
Very old months live in Release tarballs — see `manifest.archives[]` (`partitions[]`
overrides `archives[]` for any day in both).

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
WebSocket event that shares an alias or falls within ±60 s / ±10 km.

## Sources

38 networks, configured in [`providers/registry.json`](providers/registry.json)
(add more — see [CONTRIBUTING.md](CONTRIBUTING.md)). A server runner has no CORS limit,
so the feed carries national sources a browser can't reach directly, down to small
local magnitudes. Full credits: [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

- **Global (FDSN):** USGS/ANSS, EMSC/CSEM, GEOFON, ISC (reviewed but months-delayed — backfill-only).
- **Europe (FDSN):** INGV (Italy), RESIF + RéNaSS + IPGP (France), NOA (Greece), ETHZ (Switzerland), KNMI (Netherlands), LMU (Germany/Bavaria).
- **Americas / Oceania (FDSN):** NCEDC + SCEDC (California), NRCan (Canada), GeoNet (New Zealand), AusPass (Australia), USP (Brazil).
- **National APIs (custom adapters):** AFAD (Turkey, to ~M0.6), CENC (China), JMA (Japan), NCS (India), TMD (Thailand + Myanmar), CWA (Taiwan), KAGSR (Russia — Kamchatka/Kurils), BMKG (Indonesia), IGN (Spain), IMO (Iceland), IPMA (Portugal + Azores), BGS (UK), ENSN (Egypt), SSN (Mexico), IGP (Peru), OVSICORI (Costa Rica), IG-EPN (Ecuador), CSN (Chile), INPRES (Argentina), GA (Australia).

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
  views, publish). Each source fetch is fail-open — one dead source loses nothing.
- **History & growth:** `backfill` walks each source backward (paced, idempotent, ~3-yr
  target), and `archive` rolls cold months (>120 d) to GitHub Releases (un-metered) and
  prunes the tree — so the `data` branch stays bounded. `event_map` is sharded by
  event-day and pruned to a 45-day dedup horizon; identity older than that lives in the
  frozen day partitions.
- **A newly-added source fills in automatically:** its recent live window is onboarded
  into the `event_map`, deep history is backfilled, and already-archived months are
  pulled from their Release, merged, and re-rolled — no manual steps, no gaps.
- **Serving split:** the live surface (summaries + recent day files + manifest) is
  published to **Cloudflare Pages** via Direct Upload (which doesn't consume the
  500 git-builds/month cap); full-history partitions serve from the `data` branch via
  **jsDelivr** (branch refs cache ~12 h — resolve through the manifest). Never
  `raw.githubusercontent.com` (60 req/hr/IP).

## Run locally

Requires Node 22+.

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

Live end-to-end: 38 sources, stateful field-level dedup (superset model — every source
field preserved), bitemporal log, 20 rolling feeds, per-day partitions + Pages day
files, manifest, CI, and Cloudflare Pages serving. `event_map` is sharded by day and
pruned to a 45-day dedup horizon, with older identity preserved in the day partitions.

Running in production: `updatedafter` revision + `includedeleted` tombstone sweeps,
`@sha` immutable partition URLs, paced historical **backfill** (~3-yr target) with
monthly **Release archival** of cold months (and re-roll when a new source backfills
into one), automatic **new-source onboarding** of the recent window, an external
5-minute Cloudflare-Worker **heartbeat**, and a monthly source **discovery-assist**.

**Roadmap:** `op:merge` survivor selection (heals residual cross-provider duplicates);
knowledge-time snapshots; empirical swarm-guard calibration. Contributions welcome.
