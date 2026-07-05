# Contributing

Thanks for helping build an open, free earthquake feed. The most valuable
contribution is **adding a seismic source**.

## Adding a provider

### FDSN sources (no code needed)

Most seismic agencies expose an [FDSN `event` web service](https://www.fdsn.org/webservices/).
Adding one is a single entry in [`providers/registry.json`](providers/registry.json):

```jsonc
{
  "id": "ethz", "name": "ETH Zürich (Switzerland)", "priority": 16, "active": true,
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
- **License & attribution are required** — put the source's real terms and any DOI.

Then regenerate credits and run the checks:

```bash
node scripts/gen-attributions.mjs
DATA_DIR=.data npm run aggregate   # confirm it fetches & parses (check status.json)
npm run typecheck && npm test
```

### Custom (non-FDSN) sources

For sources with a bespoke JSON/HTML format (AFAD, CENC, TMD, …), add a `CustomAdapter`
in [`src/custom.ts`](src/custom.ts) and register it in the `CUSTOM_ADAPTERS` map (keyed
by the provider `id`); set `"adapter": "custom"` in the registry. Return `RawObs[]`,
stay fail-open, convert the source's timezone to UTC, and reuse the shared `getText`
helper (browser UA by default; `insecure: true` for gov endpoints with a broken TLS
chain). The existing adapters (AFAD/CENC/TMD/KAGSR/NCS) are the templates.

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
