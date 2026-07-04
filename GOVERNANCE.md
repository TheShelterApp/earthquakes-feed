# Governance

`earthquakes-feed` is an open, community-oriented public dataset stewarded by
[TheShelterApp](https://github.com/TheShelterApp). It is intended to be useful to
anyone, not only to The Shelter apps (see [RELATIONSHIP.md](RELATIONSHIP.md)).

## Decision-making

- Maintainers (listed in [`.github/CODEOWNERS`](.github/CODEOWNERS)) review and merge
  changes. Adding a well-documented, redistributable FDSN source is expected to be a
  fast, low-friction merge.
- Changes to the **data contract** (schema, `feed` block, feed ID rules) require a
  maintainer review and a version bump, and must be backward compatible within a
  major version.

## Data contract & versioning

- Feeds are served under a version prefix (`/v1/…`); `schema/VERSION` and each
  Feature's `properties.feed.schema_version` track it.
- **Additive-only within a major version** — new optional fields never break existing
  parsers.
- A breaking change ships as a new prefix (`/v2/…`) with the previous version kept for
  a deprecation window announced in the release notes.

## Stability promises

- The `data` branch is **append-only and never force-pushed**.
- `feed_id`s are stable; an event is only ever hidden via an explicit, reversible
  tombstone/redaction, never a physical delete.
- Attribution and per-record licensing travel with the data and are not dropped.

## Getting involved

Open an issue or PR. Provider additions, adapter fixes, and documentation are all
welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
