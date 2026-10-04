# Contributing

Thanks for helping build an open, free earthquake feed. The most valuable
contribution is **adding a seismic source**.

## Adding a provider

### FDSN sources (no code needed)

Most seismic agencies expose an [FDSN `event` web service](https://www.fdsn.org/webservices/).
Adding one is a single entry in [`providers/registry.json`](providers/registry.json):

```jsonc
{
  "id": "ethz", "name": "ETH Zürich / Swiss Seismological Service", "priority": 12, "active": true,
  "adapter": "fdsn", "parse": "text", "queryFormat": "text",
  "base": "https://eida.ethz.ch/fdsnws/event/1/query",
  "supportsTimeRange": true, "refreshSeconds": 600,
  "license": "CC-BY-4.0", "attribution": "Swiss Seismological Service (SED) at ETH Zürich",
  "doi": null, "contact": "https://www.seismo.ethz.ch"
}
```

- `parse`: `geojson` (USGS/EMSC-style) or `text` (FDSN pipe-delimited bulletin).
- `queryFormat`: the value sent as the FDSN `format=` query param.
- Add `"noLimit": true` if the service rejects the `limit` param (e.g. GeoNet).
- `priority`: lower = more authoritative; it's the preferred-pick tiebreak.
- `"timeoutMs": 20000` for a slow endpoint (default 8 s on the live path).
- `"liveActive": false` for a months-delayed catalog (e.g. ISC) — skipped on the 5-min
  live path but still backfilled for historical depth.
- `"lookbackDays": 7` for an FDSN source that publishes many events days after their origin
  (e.g. NRCan) — the live path asks it for that many days instead of 2 (at most 7, the
  window in which reports are matched by time and place).
- `"fallbackBase": "<query URL>"` for an FDSN source with a second host of the same catalogue
  under the same event ids (NOA) — asked when `base` fails or answers with no rows.
- `"activityBudgetHours": 72` for a source that is often quiet for a day or two, `null` for one
  that can go weeks without an event — the hours it may answer with no rows before `status.json`
  lists it as silent (default 12; see APIs.md *Failing and silent sources*).
- **License & attribution are required** — put the source's real terms and any DOI.

Once merged and enabled, the source **fills in automatically**: its recent window is
onboarded into the live `event_map`, deep history is backfilled toward the ~3-year
target, and any already-archived months are pulled from their Release, merged, and
re-rolled. No manual steps, no gaps.

Then regenerate credits and run the checks:

```bash
node scripts/gen-attributions.mjs
DATA_DIR=.data npm run aggregate   # confirm it fetches & parses (check status.json)
npm run typecheck && npm test
```

### Custom (non-FDSN) sources

For sources with a bespoke JSON/HTML/RSS format (AFAD, CENC, JMA, IPMA, …), add a
`CustomAdapter` in [`src/custom.ts`](src/custom.ts) and register it in the
`CUSTOM_ADAPTERS` map (keyed by the provider `id`); set `"adapter": "custom"` in the
registry. Return `RawObs[]`, stay fail-open, convert the source's timezone to UTC, and
reuse the shared `getText` helper (browser UA by default, a 45 s deadline over all attempts).
TLS verification is never turned off: for a host that serves its leaf certificate without
the intermediate, pin the intermediate in [`providers/tls/`](providers/tls/README.md), name it in
the entry's `"tlsIntermediates"` and pass `ca: pinnedCa(cfg)`. **Set `fields: flattenScalars(rawRecord)`** so the
provider's *entire* original vocabulary is preserved (never an allowlist — the feed's
promise is that no source field is dropped). The existing adapters (AFAD/CENC/TMD/KAGSR/
NCS/JMA/IPMA/IGP/mexico/egypt/BGS) are the templates.

## Ground rules

- **Facts only.** Copy numeric parameters and a short factual place string — never
  verbatim prose, testimonies, logos, or a bulk clone of one source's catalog.
- **Fail-open.** A source being down must never lose or corrupt existing data.
- Keep it deterministic — no `Date.now()` inside dedup/identity resolution.

## Dev workflow

```bash
npm install
npm test          # identity / dedup / order-independence
npm run typecheck
```

Open a PR against `main`; `validate.yml` runs typecheck + tests. By contributing you
agree your contribution is licensed under [CDLA-Permissive-2.0](LICENSE) (data) and
that any source you add is redistributable as factual data (see [TAKEDOWN.md](TAKEDOWN.md)).
