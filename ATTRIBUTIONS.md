# Attributions

> Generated from `providers/registry.json` — do not edit by hand; run `node scripts/gen-attributions.mjs`.

The seismic parameters in this feed are facts aggregated from the networks below.
Every Feature preserves its full source list under `properties.feed.provenance[]`,
each row carrying `license`, `attribution`, and `doi`.

## Active sources

- **USGS (ANSS ComCat)** (`usgs`) — US-PD, DOI [10.5066/F7MS3QZH](https://doi.org/10.5066/F7MS3QZH) — U.S. Geological Survey (ANSS ComCat)
- **EMSC / CSEM (seismicportal)** (`emsc`) — CC-BY-4.0 — EMSC/CSEM, https://www.emsc-csem.org
- **GEOFON / GFZ Potsdam** (`geofon`) — CC-BY-4.0, DOI [10.14470/TR560404](https://doi.org/10.14470/TR560404) — GEOFON Program, GFZ German Research Centre for Geosciences
- **INGV (Italy)** (`ingv`) — CC-BY-4.0, DOI [10.13127/iside](https://doi.org/10.13127/iside) — Istituto Nazionale di Geofisica e Vulcanologia (INGV)
- **GeoNet (New Zealand)** (`geonet`) — CC-BY-4.0 — GeoNet (GNS Science / Toka Tū Ake EQC), New Zealand
- **RESIF (France)** (`resif`) — CC-BY-4.0, DOI [10.15778/RESIF.FR](https://doi.org/10.15778/RESIF.FR) — RESIF / Réseau Sismologique et géodésique Français
- **NOA (Greece)** (`noa`) — CC-BY-4.0 — National Observatory of Athens (NOA), Institute of Geodynamics

## Configured but inactive

- **BMKG (Indonesia)** (`bmkg`) — restricted — Badan Meteorologi, Klimatologi, dan Geofisika (BMKG)
- **JMA (Japan, via p2pquake mirror)** (`jma`) — restricted — Japan Meteorological Agency (JMA) via P2P地震情報
- **Raspberry Shake** (`raspberryshake`) — CC-BY-4.0 — Raspberry Shake, S.A. citizen-science network

## The compilation

The selection, normalization, deduplication, and arrangement of these sources into
one feed is the original contribution of **earthquakes-feed**, licensed
[CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/). See [LICENSE](LICENSE) and
[TAKEDOWN.md](TAKEDOWN.md).
