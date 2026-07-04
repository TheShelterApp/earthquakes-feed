# Takedown & redaction

We publish factual seismic parameters (origin time, location, depth, magnitude,
place) aggregated from public networks. Facts are not copyrightable (*Feist v.
Rural*, 499 U.S. 340). We do **not** copy free-text testimonies, curated prose,
proprietary intensity products, or logos. Even so, we honor removal requests
reactively and promptly.

## How to request removal

Email **takedown@earthquakes-feed.theshelter.app** (or open an issue with the
`takedown` label) with: the source/network, the affected `feed_id`(s) or a
description, and the legal basis. For DMCA notices, see [SECURITY.md](SECURITY.md).

## What we do (and how fast)

Removal is layered defense-in-depth. Each layer clears a broader set of access paths:

| Step | Action | Effect | Latency |
|---|---|---|---|
| 1 | Append a forward `op:tombstone`/`op:correction` (whole event, specific fields, or a whole source), and set the source `active:false` so nothing new ingests. | Content leaves the current state; the append-only log stays intact for audit. | same day |
| 2 | Regenerate the rolling summaries + hot partitions. | The **live feed is clean** within one edge TTL. | ≤ ~10 min |
| 3 | The serving edge honors a **redaction denylist**: the canonical domain returns `410 Gone` for a redacted id and refuses to redirect to a denylisted historical file. | **Our domain never serves it again**, worldwide. | seconds |
| 4 | Rebuild-and-repin the affected historical partition/snapshot; `manifest.json` points only at the clean copy. | Removed from the path consumers actually follow (manifest-mediated). | ≤ 7 days |
| 5 | For any hardcoded, pre-capture immutable `@sha` jsDelivr/`raw` URL, file a GitHub-origin removal + best-effort jsDelivr purge. | Starves remaining CDN copies. | eventual / best-effort |

## Honest residual

Immutable `cdn.jsdelivr.net/gh/...@<sha>/...` URLs **cannot be reliably purged**. We
mitigate by never *advertising* `@sha` URLs (always resolve through `manifest.json`;
do not hardcode a SHA), by the edge denylist on our own domain, and by GitHub-origin
removal. A copy captured from a hardcoded SHA before redaction may persist beyond our
control. We disclose this rather than over-promise a guaranteed global purge.

We honor DMCA counter-notices so a bad-faith or over-broad claim cannot permanently
strip legitimate public facts.
