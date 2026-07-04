# Relationship to The Shelter

`earthquakes-feed` is stewarded by [TheShelterApp](https://github.com/TheShelterApp),
the team behind The Shelter earthquake-alerts app. The Shelter is the feed's first
consumer and sponsors its hosting (a Cloudflare subdomain of `theshelter.app`).

**But the feed is built to be neutral and useful to everyone:**

- It is a public open dataset under [CDLA-Permissive-2.0](LICENSE) — anyone may use,
  modify, and redistribute it, with no obligation to The Shelter.
- It carries **no Shelter-specific fields, filtering, or bias** — it aggregates the
  most-complete, deduplicated, attributed view of public seismic data, full stop.
- Its data contract, stability promises, and governance ([GOVERNANCE.md](GOVERNANCE.md))
  are public and independent of any Shelter product decision.

The Shelter consumes the feed exactly like any other third party would. If The
Shelter ever steps back, the feed is designed to keep running on free infrastructure
and to be forkable/transferable without loss (the `data` branch is a self-contained
historized dataset).
