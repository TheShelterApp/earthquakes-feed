# PF-1 dedup replay — the last 7 days of the observation log (2026-09-21 … 2026-09-27)

Source: `origin/data` c6ed8a01c9 (aggregate seq=183442 @ 2026-09-27T23:58:39Z), files
`knowledge/observations/ingest=2026/09/{21..27}/HH.ndjson` (168 files, 13 972 lines, 9.7 MB). Replayed
through the pre-change Resolver (`c3942dab57:src/dedup.ts`, the baseline) and this branch's Resolver, both
from an empty event_map with `hotFloorMs = 0` (every event indexed), in seq order — the production order.
The log only holds lines that changed something, and replaying them in seq order rebuilds the same event_map
(design §8.10), so the replay is the production decision path.

Reproduce:

```sh
for d in 21 22 23 24 25 26 27; do
  for h in $(git ls-tree --name-only origin/data:knowledge/observations/ingest=2026/09/$d); do
    git show origin/data:knowledge/observations/ingest=2026/09/$d/$h; done; done > /tmp/obs-7d.ndjson
git show c3942dab57:src/dedup.ts | sed "s#from './\([a-z]*\).js'#from '$PWD/src/\1.ts'#" > /tmp/dedup-baseline.ts
npm run replay-dedup -- --logs /tmp/obs-7d.ndjson --baseline /tmp/dedup-baseline.ts --out /tmp/replay-report.md
```

## Reading the numbers

- The logged ids (8 771) exceed the baseline replay (8 605) because part of the slice belongs to events
  minted before 09-21: their first line here is a revision under the older id, which an empty-map replay
  has to mint afresh, and a second provider's revision of the same old event then joins it spatially. That
  is a property of the slice, not of the rules; the rule change is the baseline → after delta:
  **8 605 → 8 583 nodes, of which 8 502 live (−103 duplicate events, −1.2 %) and 81 superseded (op:merge).**
- Folds by survivor magnitude (vs the baseline): M ≥ 5.5: 4, M 4–5.5: 34, M 2.5–4: 21, M < 2.5: 37;
  op:merge lines by survivor magnitude: 5 / 37 / 21 / 18. Rule (c) — re-evaluating a node after its
  solution moved — is general, so most of the healing lands below M5.5: pairs the first-sight rules would
  have merged had the later solution been the first one (a provider's preliminary 15 km out, revised to
  5 km). Every fold passes the first-sight gates (window, ΔM shrink, same-provider-distinct, dense-cell id
  linkage, reviewed guard); the reason column of each `op:merge` row is what the log line carries.
- The Loyalty Islands M7.0 (the diagnosed case): one live event, `efd_01M3D76ES08HGFRSA05T71J8ZF` — the
  id the feed already published for the USGS solution — with 12 ids from 10 providers. Ten ids join at
  first sight under the widened window (the six logged ids of the diagnosis collapse to two mints); only
  RéNaSS's 114-km-deep M5.8 preliminary, 62 km out and |ΔM| > 1, minted a second id, and it folded on
  its first Mwp revision (12 km, ΔM 0.75, window 19 km).
- The same event as production holds it today: the six live ids the feed published under the old rules
  (`loyalty-2026-09-25-published.ndjson`, the six partition lines of `events/2026/09/25.ndjson` at
  c6ed8a01c9) are not rewritten by this change — they fold on the next revision of any of them: five
  `op:merge` lines, one live survivor with the 12 ids, five superseded ids pointing at it
  (`tests/merge.test.ts`, *upgrade*). Which id survives depends on which one revises first (most providers
  leads the survivor rule): the USGS id when USGS or GeoNet revises, the EMSC/GEOFON/RESIF id otherwise.
  (Superseded by PF-2: only mutual best matches fold, so whichever id revises — or the one-time heal —
  the survivor is the USGS id; see `replay-report-pf2.md`.)
  **Bounded by the hot window:** the merge pass only looks at events within `HOT_WINDOW_DAYS` (7) of their
  origin time, so this heal needs the change deployed and one of the six revising before about
  2026-10-02 21:23 UTC; a later revision leaves the six ids as they are (*the heal is bounded* test). This
  replay indexes every event (`hotFloorMs = 0`), so it does not show that bound.
- No fold chain in the 7 days: every `op:merge` retired a node that was never itself a survivor, so no
  `superseded_by` had to be re-pointed (81 op:merge lines = 81 superseded nodes).
- The three groups the new rules "split" are re-groupings, not regressions:
  - Chile M5.2, 09-21 11:48 — the baseline had four live nodes for one event (csn+usp, inpres, geofon,
    emsc+usgs); after: two (emsc+geofon+csn+usgs+inpres, and usp alone). USP's solution is 21.8 km from
    the survivor's USGS representative but 8 km from the CSN row it used to sit with.
  - Croatia M3.2, 09-23 01:07 — GeoSphere published two ids for one quake 4.7 km apart (beyond the 2 km
    re-id tolerance), so both worlds keep two nodes; they differ only in which of the two EMSC rides with.
  - PNG M5.6, 09-26 14:08 — the baseline had three live nodes (geofon+ingv, emsc+renass+resif+usgs,
    geonet); after: three still, but re-grouped (emsc+renass+resif+usgs+geofon, ingv alone, geonet alone):
    GEOFON's revision folded its node into the USGS one, and INGV then arrived 11.6 km from the USGS
    representative against an 11.3 km window (it was 3.4 km from GEOFON's row).
- The six M ≥ 5.5 pairs still apart: Tonga/Samoa M5.7 ×3 (18.7–34.9 km vs a 14 km window), New Caledonia
  M5.5 (16.5 km vs 10 km), PNG M6.2 GeoNet (41.6 km — GeoNet's solutions for distant events are coarse),
  PNG INGV M5.8 (11.6 km vs 11.3 km). At the M5.5 end the formula gives 10–14 km, barely above the plain
  window, while these agencies' preliminary scatter at M5.5–5.8 is 15–35 km. The knobs are
  `LARGE_EVENT_KM_PER_MAG` and the base at `LARGE_EVENT_MAG` (src/config.ts). A further option outside
  this change: match a report against a node's provenance rows rather than only its representative —
  INGV (PNG) and USP (Chile) would fold without any wider window. The iOS client-side collapse hides the
  remaining M ≥ 5.5 duplicates meanwhile.

## Generated report

Lines: 13972 (13970 observe, 2 tombstone), ingest 2026-09-21T00:02:03.617Z → 2026-09-27T23:57:33.001Z, 11515 provider ids.

| | nodes | live | superseded | op:merge | new ids that joined an existing node at first sight |
|---|---|---|---|---|---|
| logged feed ids (production, includes events minted before the slice) | 8771 | 8771 | 0 | 0 | 2744 |
| baseline replay (pre-change rules, empty start) | 8605 | 8605 | 0 | 0 | 2910 |
| after (this checkout, empty start) | 8583 | 8502 | 81 | 81 | 2932 |

op:merge by survivor magnitude: M 2.5–4: 21, M 4–5.5: 37, M < 2.5: 18, M ≥ 5.5: 5.

## Groups the new rules fold together (96; vs baseline replay)

M 2.5–4: 21, M 4–5.5: 34, M < 2.5: 37, M ≥ 5.5: 4.

Each block is one live event after the change; its rows are grouped by the baseline replay they belonged to before. "how" says whether that group joined the survivor at first sight (the widened window / the re-id fold) or was minted and later superseded by op:merge. Distances and Δt are from each row's last logged solution to the survivor's representative.

### efd_01M3D76ES08HGFRSA05T71J8ZF — M6.6 mww reviewed 2026-09-25T21:23:03.309Z 80 km ENE of Tadine, New Caledonia (usgs) — 12 ids from 6 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3D76ES08HGFRSA05T71J8ZF | survivor | usgs:pt26268000 | 7 Mi | 2026-09-25T21:23:05.000Z | -21.246, 168.453 | 17.1 | REVIEWED | 17.3 km | 1.7 s |
| efd_01M3D76ES08HGFRSA05T71J8ZF | survivor | usgs:us6000txpi | 6.6 mww | 2026-09-25T21:23:03.309Z | -21.2982, 168.61 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M3D76ES08HGFRSA05T71J8ZF | survivor | scedc:10254406 | 6.6 w | 2026-09-25T21:23:03.309Z | -21.2982, 168.61 | 10 |  | 0.0 km | 0.0 s |
| efd_01M3D76ES01WZVMZ9XT5M0D1X0 | joined at first sight | geofon:gfz2026svlq | 6.43 mb | 2026-09-25T21:23:05.050Z | -21.215, 168.663 | 10 |  | 10.8 km | 1.7 s |
| efd_01M3D76ES01WZVMZ9XT5M0D1X0 | joined at first sight | emsc:20260925_0000287 | 6.6 mw | 2026-09-25T21:23:03.820Z | -21.2437, 168.6047 | 10 |  | 6.1 km | 0.5 s |
| efd_01M3D76ES01WZVMZ9XT5M0D1X0 | joined at first sight | resif:fr2026urwokh | 6.258332443 Mwp | 2026-09-25T21:23:04.867Z | -21.25663757, 168.5667419 | 10 |  | 6.4 km | 1.6 s |
| efd_01M3D76ES08SQ06R47AQB0V0RJ | joined at first sight | geonet:2026p724036 | 6.6 mB | 2026-09-25T21:23:03.000Z | -21.298, 168.61 | 10 |  | 0.0 km | -0.3 s |
| efd_01M3D77C2GZTT65JP6GD75YXXD | op:merge (proximity: d=11.9 km dt=0.1 s dM=0.75 window=19.4 km/49 s) | renass:fr2026urwokh | 6.207092862 Mwp | 2026-09-25T21:23:04.839Z | -21.21518135, 168.5652466 | 10 |  | 10.3 km | 1.5 s |
| efd_01M3D77C2GZTT65JP6GD75YXXD | op:merge (proximity: d=11.9 km dt=0.1 s dM=0.75 window=19.4 km/49 s) | jma:20260926063141 | 7 Mj | 2026-09-25T21:23:00.000Z | -21.2, 168.5 |  |  | 15.8 km | -3.3 s |
| efd_01M3D77C2GZTT65JP6GD75YXXD | op:merge (proximity: d=11.9 km dt=0.1 s dM=0.75 window=19.4 km/49 s) | cenc:CC.20260926054938.7 | 6.6  | 2026-09-25T21:23:03.000Z | -21.25, 168.45 | 10 |  | 17.4 km | -0.3 s |
| efd_01M3D76ES0A4G81787WNDQ948D | joined at first sight | ingv:46714321 | 6.5 Mwp | 2026-09-25T21:23:05.191Z | -21.2133, 168.721 | 11.7 |  | 14.9 km | 1.9 s |
| efd_01M3D76ES09MMEA9RBS6BG60Y1 | joined at first sight | ingv:47246702 | 6.5 Mwp | 2026-09-25T21:23:05.191Z | -21.2133, 168.721 | 11.7 |  | 14.9 km | 1.9 s |

### efd_01M3F0QJSGMYKKKM095XCJ4AS5 — M5.6 mww reviewed 2026-09-26T14:08:17.704Z 74 km ESE of Kokopo, Papua New Guinea (usgs) — 5 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3F0QJSGMYKKKM095XCJ4AS5 | survivor | emsc:20260926_0000148 | 5.6 mw | 2026-09-26T14:08:17.704Z | -4.6952, 152.8383 | 57.8 |  | 0.0 km | 0.0 s |
| efd_01M3F0QJSGMYKKKM095XCJ4AS5 | survivor | renass:fr2026urzzpv | 5.500896811 mb | 2026-09-26T14:08:22.962Z | -4.619641304, 152.7275238 | 94.186409 |  | 14.9 km | 5.3 s |
| efd_01M3F0QJSGMYKKKM095XCJ4AS5 | survivor | resif:fr2026urzzpv | 5.500896811 mb | 2026-09-26T14:08:22.962Z | -4.619641304, 152.7275238 | 94.186409 |  | 14.9 km | 5.3 s |
| efd_01M3F0QJSGMYKKKM095XCJ4AS5 | survivor | usgs:us6000txtc | 5.6 mww | 2026-09-26T14:08:17.704Z | -4.6952, 152.8383 | 57.78 | reviewed | 0.0 km | 0.0 s |
| efd_01M3F0PNG02986091HQRJX3W7Z | op:merge (proximity: d=7.7 km dt=1.0 s dM=0.01 window=11.8 km/60 s) | geofon:gfz2026swsu | 5.51 Mw | 2026-09-26T14:08:18.310Z | -4.622, 152.881 | 58.9 |  | 9.4 km | 0.6 s |

### efd_01M30T068GFMMS55QG4E40TB42 — M5.5 mb reviewed 2026-09-21T01:41:36.315Z 35 km NNE of Ruteng, Indonesia (usgs) — 6 ids from 3 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M30T068GFMMS55QG4E40TB42 | survivor | renass:fr2026uqywhd | 5.146811704 mb | 2026-09-21T01:41:36.654Z | -8.267144203, 120.5392532 | 10 |  | 6.2 km | 0.3 s |
| efd_01M30T068GFMMS55QG4E40TB42 | survivor | resif:fr2026uqywhd | 5.146811704 mb | 2026-09-21T01:41:36.654Z | -8.267144203, 120.5392532 | 10 |  | 6.2 km | 0.3 s |
| efd_01M30T068GW8CEA7QVTB20ZGK0 | op:merge (proximity: d=6.2 km dt=0.3 s dM=0.35 window=8.9 km/55 s) | emsc:20260921_0000025 | 5.5 mb | 2026-09-21T01:41:36.315Z | -8.307, 120.5793 | 10 |  | 0.0 km | 0.0 s |
| efd_01M30T068GW8CEA7QVTB20ZGK0 | op:merge (proximity: d=6.2 km dt=0.3 s dM=0.35 window=8.9 km/55 s) | usgs:us7000tiur | 5.5 mb | 2026-09-21T01:41:36.315Z | -8.307, 120.5793 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M30T068GZ2NMS02AJMC164BP | op:merge (proximity: d=9.5 km dt=0.5 s dM=0.03 window=9.9 km/60 s) | bmkg:bmkg:20260921T014137Z | 5.3  | 2026-09-21T01:41:37.000Z | -8.33, 120.59 | 10 |  | 2.8 km | 0.7 s |
| efd_01M30T068GZ2NMS02AJMC164BP | op:merge (proximity: d=9.5 km dt=0.5 s dM=0.03 window=9.9 km/60 s) | geofon:gfz2026smqr | 5.07 Mw | 2026-09-21T01:41:35.920Z | -8.275, 120.584 | 10 |  | 3.6 km | -0.4 s |

### efd_01M3DF1A40228JEHF67SXA5J4M — M5.5 mw  2026-09-25T23:39:45.500Z LOYALTY ISLANDS (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3DF1A40228JEHF67SXA5J4M | survivor | emsc:20260925_0000314 | 5.5 mw | 2026-09-25T23:39:45.500Z | -21.2479, 168.5277 | 31 |  | 0.0 km | 0.0 s |
| efd_01M3DF0CTGW4N8KP7443TSPVFP | op:merge (proximity: d=9.4 km dt=1.6 s dM=0.02 window=9.9 km/60 s) | geofon:gfz2026svqd | 5.45 Mw | 2026-09-25T23:39:43.750Z | -21.168, 168.516 | 10 |  | 9.0 km | -1.8 s |

### efd_01M335X2W0JXG8WYN23DR52YPY — M5.3 mb reviewed 2026-09-21T23:48:13.180Z 97 km S of Sarangani, Philippines (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M335X2W0JXG8WYN23DR52YPY | survivor | emsc:20260921_0000420 | 5.2 mb | 2026-09-21T23:48:13.824Z | 4.5722, 125.3746 | 10 |  | 5.6 km | 0.6 s |
| efd_01M335X2W0JXG8WYN23DR52YPY | survivor | usgs:us7000tj1s | 5.3 mb | 2026-09-21T23:48:13.180Z | 4.525, 125.3573 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M335Y05GGFAPCBHGNYPDJJ7D | op:merge (proximity: d=6.9 km dt=1.3 s dM=0.01 window=10.0 km/60 s) | geofon:gfz2026soil | 4.98 Mw | 2026-09-21T23:48:14.460Z | 4.536, 125.419 | 10 |  | 6.9 km | 1.3 s |

### efd_01M36S3030VY145ZDPK53M1TYB — M5.3 mww reviewed 2026-09-23T09:21:14.600Z 51 km WSW of Arauco, Argentina (usgs) — 7 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M36S3030VY145ZDPK53M1TYB | survivor | emsc:20260923_0000107 | 5.3 mw | 2026-09-23T09:21:14.600Z | -28.7298, -67.2912 | 121.5 |  | 0.0 km | 0.0 s |
| efd_01M36S3030VY145ZDPK53M1TYB | survivor | inpres:20260923092115 | 5.6  | 2026-09-23T09:21:15.000Z | -28.78, -67.26 | 132 |  | 6.4 km | 0.4 s |
| efd_01M36S3030VY145ZDPK53M1TYB | survivor | renass:fr2026urkgsm | 5.13517337 mb | 2026-09-23T09:21:21.771Z | -28.74825668, -67.24125671 | 182.3013611 |  | 5.3 km | 7.2 s |
| efd_01M36S3030VY145ZDPK53M1TYB | survivor | resif:fr2026urkgsm | 5.13517337 mb | 2026-09-23T09:21:21.771Z | -28.74825668, -67.24125671 | 182.3013611 |  | 5.3 km | 7.2 s |
| efd_01M36S3030VY145ZDPK53M1TYB | survivor | usgs:us6000tx29 | 5.3 mww | 2026-09-23T09:21:14.600Z | -28.7298, -67.2912 | 121.534 | reviewed | 0.0 km | 0.0 s |
| efd_01M36S3030VY145ZDPK53M1TYB | survivor | usp:usp2026sqwv | 5.400790824632645 mb | 2026-09-23T09:21:15.778Z | -28.701000213623047, -67.20442199707031 | 126 |  | 9.0 km | 1.2 s |
| efd_01M36S3030RDG828MPQ1R6K4T9 | op:merge (proximity: d=2.8 km dt=0.4 s dM=0.14 window=9.6 km/58 s) | geofon:gfz2026sqwv | 5.29 Mw | 2026-09-23T09:21:14.960Z | -28.791, -67.272 | 126.4 |  | 7.1 km | 0.4 s |

### efd_01M31WQMNG5QXQA9CMSDH0GGV1 — M5.2 mb reviewed 2026-09-21T11:48:28.996Z 167 km WNW of Mejillones, Chile (usgs) — 5 ids from 4 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M31WQMNG5QXQA9CMSDH0GGV1 | survivor | emsc:20260921_0000190 | 5.2 mb | 2026-09-21T11:48:28.996Z | -22.3643, -71.8678 | 10 |  | 0.0 km | 0.0 s |
| efd_01M31WQMNG5QXQA9CMSDH0GGV1 | survivor | usgs:us7000tixc | 5.2 mb | 2026-09-21T11:48:28.996Z | -22.3643, -71.8678 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M31WQMNGYDD5DPGJX0Z3JWXK | op:merge (proximity: d=7.4 km dt=0.6 s dM=0.10 window=9.7 km/59 s) | geofon:gfz2026snkr | 4.81 Mw | 2026-09-21T11:48:30.170Z | -22.354, -71.905 | 10 |  | 4.0 km | 1.2 s |
| efd_01M31WQMNG6954HYNH1R0615V5 | op:merge (proximity: d=8.6 km dt=0.9 s dM=0.00 window=10.0 km/60 s) | csn:383933 | 5.3 Mww | 2026-09-21T11:48:30.000Z | -22.29, -71.76 | 10 |  | 13.8 km | 1.0 s |
| efd_01M31WQMNGQ7QJPYAN8T7620TQ | op:merge (proximity: d=5.7 km dt=2.0 s dM=0.20 window=9.4 km/57 s) | inpres:20260921114827 | 5  | 2026-09-21T11:48:27.000Z | -22.404, -71.683 | 18 |  | 19.5 km | -2.0 s |

### efd_01M3CJY8K0CJEV6KBV8QR933FZ — M5.2 mww reviewed 2026-09-25T15:29:09.560Z 62 km SW of San Antonio, Chile (usgs) — 5 ids from 3 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3CJY8K0CJEV6KBV8QR933FZ | survivor | inpres:20260925152908 | 5.2  | 2026-09-25T15:29:08.000Z | -33.9, -72.16 | 10 |  | 8.8 km | -1.6 s |
| efd_01M3CJY8K0CJEV6KBV8QR933FZ | survivor | renass:fr2026urvizc | 5.230081748 mb | 2026-09-25T15:29:07.646Z | -33.92698288, -72.16523743 | 10 |  | 6.8 km | -1.9 s |
| efd_01M3CJY8K0CQTFHVQ2M0VTW5SB | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | resif:fr2026urvizc | 5.230081748 mb | 2026-09-25T15:29:07.646Z | -33.92698288, -72.16523743 | 10 |  | 6.8 km | -1.9 s |
| efd_01M3CJY8K0TEPDR1RWETZNX8SM | op:merge (proximity: d=6.8 km dt=1.9 s dM=0.03 window=9.9 km/60 s) | emsc:20260925_0000199 | 5.2 mw | 2026-09-25T15:29:09.560Z | -33.9661, -72.1079 | 29.1 |  | 0.0 km | 0.0 s |
| efd_01M3CJY8K0TEPDR1RWETZNX8SM | op:merge (proximity: d=6.8 km dt=1.9 s dM=0.03 window=9.9 km/60 s) | usgs:us6000txme | 5.2 mww | 2026-09-25T15:29:09.560Z | -33.9661, -72.1079 | 29.072 | reviewed | 0.0 km | 0.0 s |

### efd_01M32311ZGAZK1PWR6FZMSMEGV — M5 mb reviewed 2026-09-21T13:38:32.404Z 38 km E of Nobeoka, Japan (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M32311ZGAZK1PWR6FZMSMEGV | survivor | geofon:gfz2026snoh | 5.1 mb | 2026-09-21T13:38:28.530Z | 32.462, 131.968 | 10 |  | 18.4 km | -3.9 s |
| efd_01M32311ZGAZK1PWR6FZMSMEGV | survivor | emsc:20260921_0000229 | 5 mb | 2026-09-21T13:38:32.404Z | 32.5978, 132.0805 | 42.7 |  | 0.0 km | 0.0 s |
| efd_01M32311ZGAZK1PWR6FZMSMEGV | survivor | usgs:us7000tixp | 5 mb | 2026-09-21T13:38:32.404Z | 32.5978, 132.0805 | 42.736 | reviewed | 0.0 km | 0.0 s |
| efd_01M32304P0RTSB2X1H62T1YGM1 | op:merge (proximity: d=1.8 km dt=32.4 s dM=0.20 window=9.4 km/57 s) | jma:20260921223838 | 4.8 Mj | 2026-09-21T13:38:00.000Z | 32.6, 132.1 | 30 |  | 1.8 km | -32.4 s |

### efd_01M3BD30TGHYXMY8SABB4C11ET — M5 mb reviewed 2026-09-25T04:27:40.435Z 124 km N of Metinaro, Timor Leste (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3BD30TGHYXMY8SABB4C11ET | survivor | emsc:20260925_0000039 | 5 mb | 2026-09-25T04:27:40.435Z | -7.4036, 125.6985 | 10 |  | 0.0 km | 0.0 s |
| efd_01M3BD30TGHYXMY8SABB4C11ET | survivor | usgs:us6000txim | 5 mb | 2026-09-25T04:27:40.435Z | -7.4036, 125.6985 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M3BD30TGJKPM9YFN9EBCJ916 | op:merge (proximity: d=8.2 km dt=0.7 s dM=0.12 window=9.6 km/58 s) | geofon:gfz2026sued | 5.12 mb | 2026-09-25T04:27:41.140Z | -7.432, 125.63 | 10 |  | 8.2 km | 0.7 s |

### efd_01M3D5Z30GNESGWK2XVV4C4KVB — M5 mb reviewed 2026-09-25T21:01:27.262Z 13 km N of Xunchang, China (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3D5Z30GNESGWK2XVV4C4KVB | survivor | geofon:gfz2026svky | 4.89 mb | 2026-09-25T21:01:29.110Z | 28.614, 104.72 | 10 |  | 4.7 km | 1.8 s |
| efd_01M3D5Z30GNESGWK2XVV4C4KVB | survivor | emsc:20260925_0000282 | 5 mb | 2026-09-25T21:01:27.262Z | 28.5744, 104.7032 | 10 |  | 0.0 km | 0.0 s |
| efd_01M3D5Z30GNESGWK2XVV4C4KVB | survivor | usgs:us6000txpf | 5 mb | 2026-09-25T21:01:27.262Z | 28.5744, 104.7032 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M3D5Z30G3JC0ACBG7C0ZZF9F | op:merge (proximity: d=6.9 km dt=0.3 s dM=0.50 window=8.5 km/53 s) | cenc:CC.20260926050908.8 | 4.5  | 2026-09-25T21:01:27.000Z | 28.52, 104.67 | 5 |  | 6.9 km | -0.3 s |

### efd_01M3DG1BGGYBM15N65GZ5CQK79 — M5 mb reviewed 2026-09-25T23:57:33.361Z 15 km NNW of Xunchang, China (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3DG1BGGYBM15N65GZ5CQK79 | survivor | geofon:gfz2026svqt | 4.89 mb | 2026-09-25T23:57:34.290Z | 28.622, 104.695 | 10 |  | 7.0 km | 0.9 s |
| efd_01M3DG1BGGYBM15N65GZ5CQK79 | survivor | emsc:20260925_0000322 | 5 mb | 2026-09-25T23:57:33.361Z | 28.5792, 104.6428 | 10 |  | 0.0 km | 0.0 s |
| efd_01M3DG1BGGYBM15N65GZ5CQK79 | survivor | usgs:us6000txql | 5 mb | 2026-09-25T23:57:33.361Z | 28.5792, 104.6428 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M3DG1BGGTZYPZ69MT2TGP7CH | op:merge (proximity: d=7.9 km dt=1.4 s dM=0.60 window=8.2 km/51 s) | cenc:CC.20260926080427.7 | 4.4  | 2026-09-25T23:57:32.000Z | 28.51, 104.66 | 5 |  | 7.9 km | -1.4 s |

### efd_01M3EPVQC02QYWGPTX3CQYZ1CZ — M5 mb  2026-09-26T11:16:13.950Z BALLENY ISLANDS REGION (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3EPVQC02QYWGPTX3CQYZ1CZ | survivor | emsc:20260926_0000119 | 5 mb | 2026-09-26T11:16:13.950Z | -63.5192, 148.4576 | 10 |  | 0.0 km | 0.0 s |
| efd_01M3EPVQC0XA4ZCC57EX45PTN3 | op:merge (proximity: d=1.0 km dt=0.0 s dM=0.05 window=9.9 km/59 s) | geofon:gfz2026swnd | 5.05 M | 2026-09-26T11:16:13.930Z | -63.523, 148.475 | 10 |  | 1.0 km | -0.0 s |

### efd_01M30QQVT0V05Q2JRW22NZ78CN — M4.9 mww reviewed 2026-09-21T01:02:04.529Z 26 km SE of Saimbeyli, Turkey (usgs) — 4 ids from 3 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M30QQVT0V05Q2JRW22NZ78CN | survivor | koeri:koeri-20260921010200 | 4.8 Mw | 2026-09-21T01:02:00.000Z | 37.8352, 36.2627 | 5 | automatic | 4.0 km | -4.5 s |
| efd_01M30QQVT01555JQ3XKGNEHA88 | op:merge (proximity: d=5.0 km dt=5.1 s dM=0.10 window=9.7 km/59 s) | emsc:20260921_0000009 | 4.9 mw | 2026-09-21T01:02:03.800Z | 37.8307, 36.206 | 7 |  | 8.4 km | -0.7 s |
| efd_01M30QQVT0FXGV8QD4JYM4N0AY | op:merge (proximity: d=1.2 km dt=4.5 s dM=0.16 window=9.5 km/58 s) | geofon:gfz2026smpj | 4.96 Mw | 2026-09-21T01:02:04.490Z | 37.838, 36.276 | 10 |  | 3.4 km | -0.0 s |
| efd_01M30QQVT0FXGV8QD4JYM4N0AY | op:merge (proximity: d=1.2 km dt=4.5 s dM=0.16 window=9.5 km/58 s) | usgs:us7000tiui | 4.9 mww | 2026-09-21T01:02:04.529Z | 37.8136, 36.2994 | 10 | reviewed | 0.0 km | 0.0 s |

### efd_01M33VTC901WH4WXHXAWF1WEZH — M4.9 mb reviewed 2026-09-22T06:11:10.037Z Volcano Islands, Japan region (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M33VTC901WH4WXHXAWF1WEZH | survivor | emsc:20260922_0000114 | 4.9 mb | 2026-09-22T06:11:10.037Z | 23.003, 142.3395 | 10 |  | 0.0 km | 0.0 s |
| efd_01M33VTC901WH4WXHXAWF1WEZH | survivor | usgs:us7000tj3s | 4.9 mb | 2026-09-22T06:11:10.037Z | 23.003, 142.3395 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M33VTC90NTXWB6MAVGDF27ZQ | op:merge (proximity: d=7.7 km dt=0.7 s dM=0.25 window=9.3 km/56 s) | geofon:gfz2026sovb | 5.15 mb | 2026-09-22T06:11:10.690Z | 22.97, 142.406 | 10 |  | 7.7 km | 0.7 s |

### efd_01M36PVJY00DJTJKQ3153FQ6S1 — M4.9 mb reviewed 2026-09-23T08:41:58.018Z Scotia Sea (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M36PVJY00DJTJKQ3153FQ6S1 | survivor | emsc:20260923_0000104 | 4.9 mb | 2026-09-23T08:41:58.018Z | -60.2661, -47.6004 | 10 |  | 0.0 km | 0.0 s |
| efd_01M36PVJY00DJTJKQ3153FQ6S1 | survivor | usgs:us6000tx23 | 4.9 mb | 2026-09-23T08:41:58.018Z | -60.2661, -47.6004 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M36PVJY0FCQKQXQKXQXF0S1D | op:merge (proximity: d=8.3 km dt=0.9 s dM=0.26 window=9.2 km/56 s) | geofon:gfz2026sqvn | 5.16 mb | 2026-09-23T08:41:58.950Z | -60.341, -47.593 | 10 |  | 8.3 km | 0.9 s |

### efd_01M3FV3PGGA318N97G5ZVM66C5 — M4.9 mb reviewed 2026-09-26T21:49:27.543Z 78 km ESE of Kokopo, Papua New Guinea (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3FV3PGGA318N97G5ZVM66C5 | survivor | geofon:gfz2026sxia | 5.24 mb | 2026-09-26T21:49:21.220Z | -4.59, 152.87 | 10 |  | 6.7 km | -6.3 s |
| efd_01M3FV3PGGA318N97G5ZVM66C5 | survivor | usgs:us6000txv7 | 4.9 mb | 2026-09-26T21:49:27.543Z | -4.6357, 152.9096 | 63.571 | reviewed | 0.0 km | 0.0 s |
| efd_01M3FV3PGG594G8WKSM21KM5RZ | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | emsc:20260926_0000228 | 4.9 mb | 2026-09-26T21:49:27.190Z | -4.6616, 152.8881 | 58 |  | 3.7 km | -0.4 s |

### efd_01M3371PR009S0W2SEYRZAWARY — M4.8 mb reviewed 2026-09-22T00:08:04.893Z 70 km N of Claveria, Philippines (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3371PR009S0W2SEYRZAWARY | survivor | phivolcs:2026_0922_0008 | 3.8  | 2026-09-22T00:08:00.000Z | 19.39, 121.01 | 10 |  | 17.7 km | -4.9 s |
| efd_01M3371PR009S0W2SEYRZAWARY | survivor | emsc:20260922_0000003 | 4.8 mb | 2026-09-22T00:08:04.893Z | 19.2426, 121.0734 | 10 |  | 0.0 km | 0.0 s |
| efd_01M3371PR009S0W2SEYRZAWARY | survivor | usgs:us7000tj21 | 4.8 mb | 2026-09-22T00:08:04.893Z | 19.2426, 121.0734 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M3371PR061SY8V9JPS7VTFJ9 | op:merge (proximity: d=3.6 km dt=0.3 s dM=0.04 window=9.9 km/59 s) | geofon:gfz2026sojc | 4.93 mb | 2026-09-22T00:08:05.800Z | 19.373, 121.155 | 10 |  | 16.8 km | 0.9 s |

### efd_01M3JDHAT07Q09N17CNY3XFW26 — M4.8 mww reviewed 2026-09-27T21:49:47.544Z 11 km W of Guaymate, Dominican Republic (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3JDHAT07Q09N17CNY3XFW26 | survivor | emsc:20260927_0000285 | 4.8 mw | 2026-09-27T21:49:47.544Z | 18.6067, -69.0863 | 107.4 |  | 0.0 km | 0.0 s |
| efd_01M3JDHAT07Q09N17CNY3XFW26 | survivor | geofon:gfz2026szdn | 4.98 mb | 2026-09-27T21:49:47.260Z | 18.527, -69.061 | 100.8 |  | 9.3 km | -0.3 s |
| efd_01M3JDHAT0AHRPEF9QSJPD160H | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | usgs:pt26270050 | 5.2 Mi | 2026-09-27T21:49:46.000Z | 18.483, -69.134 | 109 | REVIEWED | 14.6 km | -1.5 s |
| efd_01M3JDHAT0AHRPEF9QSJPD160H | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | usgs:us6000ty0q | 4.8 mww | 2026-09-27T21:49:47.544Z | 18.6067, -69.0863 | 107.391 | reviewed | 0.0 km | 0.0 s |

### efd_01M31S9S1GS3Q7130BAG6W5ERH — M4.7 mb reviewed 2026-09-21T10:48:16.231Z 95 km ENE of Khorugh, Tajikistan (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M31S9S1GS3Q7130BAG6W5ERH | survivor | emsc:20260921_0000178 | 4.7 mb | 2026-09-21T10:48:15.500Z | 37.97, 72.49 | 110 |  | 5.9 km | -0.7 s |
| efd_01M31S9S1GS3Q7130BAG6W5ERH | survivor | usgs:us7000tiwz | 4.7 mb | 2026-09-21T10:48:16.231Z | 37.9169, 72.4916 | 129.316 | reviewed | 0.0 km | 0.0 s |
| efd_01M31S9S1GE6HXRKWXQ42CD3K5 | op:merge (proximity: d=9.3 km dt=0.0 s dM=0.07 window=9.8 km/59 s) | geofon:gfz2026snir | 4.81 mb | 2026-09-21T10:48:15.940Z | 37.909, 72.636 | 117.1 |  | 12.7 km | -0.3 s |

### efd_01M31YBTK0J4ZQKPGF8TXVPHN2 — M4.7 mb reviewed 2026-09-21T12:17:05.292Z 76 km W of Ollagüe, Chile (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M31YBTK0J4ZQKPGF8TXVPHN2 | survivor | csn:383936 | 4.8 Mw | 2026-09-21T12:17:04.000Z | -21.265, -68.978 | 120 |  | 1.1 km | -1.3 s |
| efd_01M31YBTK0J4ZQKPGF8TXVPHN2 | survivor | emsc:20260921_0000206 | 4.7 mb | 2026-09-21T12:17:05.292Z | -21.2643, -68.9887 | 121.2 |  | 0.0 km | 0.0 s |
| efd_01M31YBTK0J4ZQKPGF8TXVPHN2 | survivor | usgs:us7000tixg | 4.7 mb | 2026-09-21T12:17:05.292Z | -21.2643, -68.9887 | 121.183 | reviewed | 0.0 km | 0.0 s |
| efd_01M31YBTK053CBMN9F4GSP7AAS | op:merge (proximity: d=8.0 km dt=0.3 s dM=0.14 window=9.6 km/58 s) | geofon:gfz2026snlq | 4.56 Mw | 2026-09-21T12:17:05.120Z | -21.317, -68.795 | 105 |  | 20.9 km | -0.2 s |

### efd_01M34EV6PGDWT4FTZFWQ7WBF7V — M4.7 mb reviewed 2026-09-22T11:43:45.547Z 7 km WNW of La Gomera, Guatemala (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M34EV6PGDWT4FTZFWQ7WBF7V | survivor | emsc:20260922_0000209 | 4.7 mb | 2026-09-22T11:43:45.547Z | 14.113, -91.1165 | 88.8 |  | 0.0 km | 0.0 s |
| efd_01M34EV6PGDWT4FTZFWQ7WBF7V | survivor | usgs:us7000tj58 | 4.7 mb | 2026-09-22T11:43:45.547Z | 14.113, -91.1165 | 88.793 | reviewed | 0.0 km | 0.0 s |
| efd_01M34EW4005SFVW704RYBVWCHY | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.03 window=9.9 km/60 s) | geofon:gfz2026spga | 4.67 mb | 2026-09-22T11:43:42.110Z | 14.165, -91.192 | 45 |  | 10.0 km | -3.4 s |

### efd_01M373H5EGQRS9PRNDHE9KQ0AJ — M4.6 mb  2026-09-23T12:23:20.360Z MOLUCCA SEA (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M373H5EGQRS9PRNDHE9KQ0AJ | survivor | emsc:20260923_0000141 | 4.6 mb | 2026-09-23T12:23:20.360Z | 1.2225, 126.4238 | 45 |  | 0.0 km | 0.0 s |
| efd_01M373H5EGJ3EFMEPSCQKJMQF3 | op:merge (proximity: d=6.0 km dt=0.1 s dM=0.00 window=10.0 km/60 s) | geofon:gfz2026srcv | 4.6 mb | 2026-09-23T12:23:20.250Z | 1.227, 126.37 | 42 |  | 6.0 km | -0.1 s |

### efd_01M3EZ0MZGP2S5C7ME4D97Q7FZ — M4.6 mb reviewed 2026-09-26T13:38:15.958Z 145 km NE of Maumere, Indonesia (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3EZ0MZGP2S5C7ME4D97Q7FZ | survivor | emsc:20260926_0000135 | 4.6 mb | 2026-09-26T13:38:14.490Z | -7.8923, 123.2437 | 220 |  | 6.3 km | -1.5 s |
| efd_01M3EZ0MZGP2S5C7ME4D97Q7FZ | survivor | geofon:gfz2026swrv | 4.62 mb | 2026-09-26T13:38:15.140Z | -7.912, 123.15 | 220.1 |  | 16.7 km | -0.8 s |
| efd_01M3EZ0MZGDSXJGKRA2A1QBDBP | op:merge (proximity: d=6.3 km dt=1.5 s dM=0.00 window=10.0 km/60 s) | usgs:us6000txt8 | 4.6 mb | 2026-09-26T13:38:15.958Z | -7.8646, 123.2938 | 235.082 | reviewed | 0.0 km | 0.0 s |

### efd_01M331E8J0C1P61HJ3RKJ01BP1 — M4.5 mb reviewed 2026-09-21T22:29:59.360Z 91 km E of Namie, Japan (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M331E8J0C1P61HJ3RKJ01BP1 | survivor | emsc:20260921_0000418 | 4.5 mb | 2026-09-21T22:29:59.360Z | 37.5214, 142.0382 | 35 |  | 0.0 km | 0.0 s |
| efd_01M331E8J0C1P61HJ3RKJ01BP1 | survivor | usgs:us7000tj1b | 4.5 mb | 2026-09-21T22:29:59.360Z | 37.5214, 142.0382 | 35 | reviewed | 0.0 km | 0.0 s |
| efd_01M331E8J0GA2ZYYYF9VSRNXYH | op:merge (proximity: d=5.9 km dt=0.6 s dM=0.00 window=10.0 km/60 s) | jma:20260922073003 | 4.5 Mj | 2026-09-21T22:30:00.000Z | 37.5, 142.1 | 30 |  | 5.9 km | 0.6 s |
| efd_01M331E8J0GA2ZYYYF9VSRNXYH | op:merge (proximity: d=5.9 km dt=0.6 s dM=0.00 window=10.0 km/60 s) | geofon:gfz2026sofv | 4.76 mb | 2026-09-21T22:29:57.640Z | 37.483, 142.085 | 21.5 |  | 5.9 km | -1.7 s |

### efd_01M3601010KQ4K41RZRGB2V62J — M4.5 mb  2026-09-23T02:02:43.850Z FLORES REGION, INDONESIA (emsc) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3601010KQ4K41RZRGB2V62J | survivor | emsc:20260923_0000014 | 4.5 mb | 2026-09-23T02:02:43.850Z | -8.1969, 120.6228 | 10 |  | 0.0 km | 0.0 s |
| efd_01M3601010KQ4K41RZRGB2V62J | survivor | bmkg:bmkg:20260923T020244Z | 4.7  | 2026-09-23T02:02:44.000Z | -8.21, 120.61 | 9 |  | 2.0 km | 0.1 s |
| efd_01M36002QGG8QAWDBBJ75K2N90 | op:merge (proximity: d=8.5 km dt=0.8 s dM=0.11 window=9.7 km/58 s) | geofon:gfz2026sqij | 4.61 mb | 2026-09-23T02:02:44.210Z | -8.216, 120.563 | 10 |  | 6.9 km | 0.4 s |

### efd_01M3GH4N3G0E8PB65B5KKM9PW1 — M4.5 mb reviewed 2026-09-27T04:14:44.454Z 145 km WNW of Lebu, Chile (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3GH4N3G0E8PB65B5KKM9PW1 | survivor | csn:384595 | 4.3 Mlv | 2026-09-27T04:14:44.000Z | -37.03, -75.27 | 10 |  | 13.7 km | -0.5 s |
| efd_01M3GH4N3G0E8PB65B5KKM9PW1 | survivor | emsc:20260927_0000044 | 4.5 mb | 2026-09-27T04:14:48.930Z | -37.152, -75.1927 | 35 |  | 1.8 km | 4.5 s |
| efd_01M3GH4N3G1N65BF7BWHK8AYA6 | op:merge (proximity: d=1.8 km dt=4.5 s dM=0.00 window=10.0 km/60 s) | usgs:us6000txwk | 4.5 mb | 2026-09-27T04:14:44.454Z | -37.1357, -75.1898 | 10 | reviewed | 0.0 km | 0.0 s |

### efd_01M32GRGFGXRFF1YWQ9FCFX9FH — M4.4 mb reviewed 2026-09-21T17:38:43.165Z 104 km NNE of San Pedro de Atacama, Chile (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M32GRGFGXRFF1YWQ9FCFX9FH | survivor | usgs:us7000tizh | 4.4 mb | 2026-09-21T17:38:43.165Z | -22.0932, -67.6971 | 198.661 | reviewed | 0.0 km | 0.0 s |
| efd_01M32GRGFGXRFF1YWQ9FCFX9FH | survivor | geofon:gfz2026snwf | 4.74 mb | 2026-09-21T17:38:43.250Z | -22.056, -67.626 | 184.5 |  | 8.4 km | 0.1 s |
| efd_01M32GRGFGPQWA722D4NYVWVVF | op:merge (proximity: d=8.1 km dt=0.5 s dM=0.00 window=10.0 km/60 s) | emsc:20260921_0000320 | 4.4 mb | 2026-09-21T17:38:43.630Z | -22.0594, -67.6278 | 200 |  | 8.1 km | 0.5 s |
| efd_01M32GRGFGPQWA722D4NYVWVVF | op:merge (proximity: d=8.1 km dt=0.5 s dM=0.00 window=10.0 km/60 s) | csn:383968 | 4 Mlv | 2026-09-21T17:38:41.000Z | -22.029, -67.856 | 222 |  | 17.9 km | -2.2 s |

### efd_01M348AF0G5ZDGFK00GEC5C9ZH — M4.4 mb reviewed 2026-09-22T09:49:42.085Z 12 km SSW of Dykanka, Ukraine (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M348AF0G5ZDGFK00GEC5C9ZH | survivor | geofon:gfz2026spch | 4.07 mb | 2026-09-22T09:49:42.670Z | 49.756, 34.489 | 10 |  | 4.1 km | 0.6 s |
| efd_01M348AF0G5ZDGFK00GEC5C9ZH | survivor | usgs:us7000tj54 | 4.4 mb | 2026-09-22T09:49:42.085Z | 49.7217, 34.4683 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M348AF0GNHB723PEKQXEV3ZN | op:merge (proximity: d=2.5 km dt=0.3 s dM=0.00 window=10.0 km/60 s) | emsc:20260922_0000183 | 4.4 mb | 2026-09-22T09:49:42.420Z | 49.7443, 34.4657 | 10 |  | 2.5 km | 0.3 s |

### efd_01M3BPXYYGZKPAXQY8K0RZRCS0 — M4.4 mb  2026-09-25T07:19:43.470Z COLOMBIA (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3BPXYYGZKPAXQY8K0RZRCS0 | survivor | emsc:20260925_0000077 | 4.4 mb | 2026-09-25T07:19:43.470Z | 3.7697, -75.7238 | 35 |  | 0.0 km | 0.0 s |
| efd_01M3BPYW80S2WPDVDBRP14607H | op:merge (proximity: d=2.3 km dt=2.1 s dM=0.05 window=9.9 km/59 s) | geofon:gfz2026sujv | 4.45 mb | 2026-09-25T07:19:45.580Z | 3.75, -75.729 | 56.6 |  | 2.3 km | 2.1 s |

### efd_01M347FXD0GG8Q00DH9EHX4WP2 — M4.3 mb reviewed 2026-09-22T09:35:10.144Z 58 km NNE of Calama, Chile (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M347FXD0GG8Q00DH9EHX4WP2 | survivor | csn:384030 | 4.2 Mlv | 2026-09-22T09:35:08.000Z | -21.912, -68.595 | 110 |  | 10.5 km | -2.1 s |
| efd_01M347FXD0GG8Q00DH9EHX4WP2 | survivor | emsc:20260922_0000164 | 4.3 mb | 2026-09-22T09:35:10.330Z | -21.9548, -68.6395 | 118 |  | 3.9 km | 0.2 s |
| efd_01M347FXD0CG86GH1DB4CSSPBF | op:merge (proximity: d=3.9 km dt=0.2 s dM=0.00 window=10.0 km/60 s) | usgs:us7000tj4l | 4.3 mb | 2026-09-22T09:35:10.144Z | -21.9846, -68.6595 | 110.957 | reviewed | 0.0 km | 0.0 s |

### efd_01M393TBH08RC5H1ZDNJR022HS — M4.3 mb reviewed 2026-09-24T07:07:05.252Z 53 km WSW of San Antonio, Chile (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M393TBH08RC5H1ZDNJR022HS | survivor | geofon:gfz2026ssnx | 4.26 ML | 2026-09-24T07:07:03.200Z | -33.847, -72.168 | 10 |  | 6.1 km | -2.1 s |
| efd_01M393TBH08RC5H1ZDNJR022HS | survivor | usgs:us6000tx9m | 4.3 mb | 2026-09-24T07:07:05.252Z | -33.8294, -72.1057 | 31.376 | reviewed | 0.0 km | 0.0 s |
| efd_01M393TBH0ZEZBSFV2PCE3M283 | op:merge (proximity: d=1.7 km dt=0.6 s dM=0.00 window=10.0 km/60 s) | csn:384194 | 4.1 Mlv | 2026-09-24T07:07:04.000Z | -33.874, -72.115 | 11 |  | 5.0 km | -1.3 s |
| efd_01M393TBH0ZEZBSFV2PCE3M283 | op:merge (proximity: d=1.7 km dt=0.6 s dM=0.00 window=10.0 km/60 s) | emsc:20260924_0000078 | 4.3 mb | 2026-09-24T07:07:04.670Z | -33.8397, -72.1194 | 30 |  | 1.7 km | -0.6 s |

### efd_01M3H86JCGEQ9Y1TP9SJZDR3MW — M4.3 mb reviewed 2026-09-27T10:57:07.641Z Iceland region (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3H86JCGEQ9Y1TP9SJZDR3MW | survivor | emsc:20260927_0000125 | 4.3 mb | 2026-09-27T10:57:07.641Z | 68.9242, -17.2234 | 10 |  | 0.0 km | 0.0 s |
| efd_01M3H86JCGEQ9Y1TP9SJZDR3MW | survivor | usgs:us6000txyf | 4.3 mb | 2026-09-27T10:57:07.641Z | 68.9242, -17.2234 | 10 | reviewed | 0.0 km | 0.0 s |
| efd_01M3H85N30H25YNM5PKVJZMS0D | op:merge (proximity: d=7.7 km dt=0.2 s dM=0.27 window=9.2 km/56 s) | geofon:gfz2026syia | 4.57 mb | 2026-09-27T10:57:07.470Z | 68.928, -17.032 | 10 |  | 7.7 km | -0.2 s |

### efd_01M30QJC10NKV84AVVZYFJNEEF — M4.2  reviewed 2026-09-21T00:58:56.000Z 38.0 km al Suroeste de Bahia Ballena de Puntarenas (ovsicori) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M30QJC10NKV84AVVZYFJNEEF | survivor | ovsicori:1450054 | 4.2  | 2026-09-21T00:58:56.000Z | 9.0022, -84.1018 | 26 | reviewed | 0.0 km | 0.0 s |
| efd_01M30QJC10NKV84AVVZYFJNEEF | survivor | emsc:20260921_0000012 | 4.2 m | 2026-09-21T00:58:55.000Z | 8.9562, -84.1498 | 14 |  | 7.3 km | -1.0 s |
| efd_01M30QJC109N8YRW24RJNJ3270 | joined at first sight | ovsicori:1450088 | 4.2  | 2026-09-21T00:58:56.000Z | 9.0077, -84.1058 | 30 | reviewed | 0.8 km | 0.0 s |

### efd_01M363P610WP70E0WKDS6R257E — M4.2 mb reviewed 2026-09-23T03:07:08.275Z 33 km NNW of La Serena, Chile (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M363P610WP70E0WKDS6R257E | survivor | usgs:us6000tx0f | 4.2 mb | 2026-09-23T03:07:08.275Z | -29.6195, -71.3758 | 62.41 | reviewed | 0.0 km | 0.0 s |
| efd_01M363P610WP70E0WKDS6R257E | survivor | geofon:gfz2026sqkm | 4.12 Mw | 2026-09-23T03:07:08.410Z | -29.623, -71.444 | 50 |  | 6.6 km | 0.1 s |
| efd_01M363P610K7ZSVATA7F0NXYC8 | op:merge (proximity: d=7.4 km dt=0.2 s dM=0.00 window=10.0 km/60 s) | csn:384095 | 4.3 Mlv | 2026-09-23T03:07:08.000Z | -29.63, -71.47 | 41 |  | 9.2 km | -0.3 s |
| efd_01M363P610K7ZSVATA7F0NXYC8 | op:merge (proximity: d=7.4 km dt=0.2 s dM=0.00 window=10.0 km/60 s) | emsc:20260923_0000023 | 4.2 mb | 2026-09-23T03:07:08.100Z | -29.6166, -71.4521 | 57.2 |  | 7.4 km | -0.2 s |

### efd_01M3AVF1YGJ99T4R5Z6BMQD963 — M4.2 mb reviewed 2026-09-24T23:19:34.354Z 63 km WSW of Andacollo, Argentina (usgs) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3AVF1YGJ99T4R5Z6BMQD963 | survivor | csn:384320 | 3.9 Mlv | 2026-09-24T23:19:31.000Z | -37.59, -71.16 | 200 |  | 18.4 km | -3.4 s |
| efd_01M3AVF1YGJ99T4R5Z6BMQD963 | survivor | emsc:20260924_0000333 | 4.2 mb | 2026-09-24T23:19:34.350Z | -37.4673, -71.272 | 174.3 |  | 1.9 km | -0.0 s |
| efd_01M3AVF1YGRB5AZ2RYSJVSC8XC | op:merge (proximity: d=1.9 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | usgs:us6000txhl | 4.2 mb | 2026-09-24T23:19:34.354Z | -37.4621, -71.293 | 174.336 | reviewed | 0.0 km | 0.0 s |

### efd_01M3H5A3D0CQFX0TKJ03C6SENV — M4.2 mb reviewed 2026-09-27T10:07:08.075Z 13 km SSW of Bayaguana, Dominican Republic (usgs) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3H5A3D0CQFX0TKJ03C6SENV | survivor | usgs:us6000txya | 4.2 mb | 2026-09-27T10:07:08.075Z | 18.647, -69.6988 | 98.093 | reviewed | 0.0 km | 0.0 s |
| efd_01M3H5A3D0BGSNPEWE5K9BG24W | op:merge (proximity: d=2.9 km dt=1.3 s dM=0.10 window=9.7 km/58 s) | emsc:20260927_0000113 | 4.2 mb | 2026-09-27T10:07:07.720Z | 18.5654, -69.7162 | 97.4 |  | 9.3 km | -0.4 s |

### efd_01M34FDGMGD2ZBHS4X52ANSY6J — M4.1 m  2026-09-22T11:53:21.000Z OFF COAST OF CHIAPAS, MEXICO (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M34FDGMGD2ZBHS4X52ANSY6J | survivor | emsc:20260922_0000205 | 4.1 m | 2026-09-22T11:53:21.000Z | 13.925, -93.039 | 10 |  | 0.0 km | 0.0 s |
| efd_01M34FDGMGWMV41YJAS5GCG1KR | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | mexico:2026-09-22055321_13.925_-93.039 | 4.1  | 2026-09-22T11:53:21.000Z | 13.925, -93.039 | 10 |  | 0.0 km | 0.0 s |

### efd_01M32W7MH063PS1H5NDP5GCZVE — M3.9 ml  2026-09-21T20:59:01.000Z ATACAMA, CHILE (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M32W7MH063PS1H5NDP5GCZVE | survivor | emsc:20260921_0000362 | 3.9 ml | 2026-09-21T20:59:01.000Z | -25.41, -68.86 | 119.9 |  | 0.0 km | 0.0 s |
| efd_01M32W7MH0W051MTY04YZ40Z6F | op:merge (proximity: d=0.7 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | csn:383988 | 3.9 Mlv | 2026-09-21T20:59:01.000Z | -25.415, -68.864 | 120 |  | 0.7 km | 0.0 s |

### efd_01M341DTF0126G50KGM3JWTX0K — M3.9  Reviewed 2026-09-22T07:49:10.000Z Tibet (ncs) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M341DTF0126G50KGM3JWTX0K | survivor | ncs:SzZjVXNwaDN1K3ZIemhBMkJzNlc1UT09 | 3.9  | 2026-09-22T07:49:10.000Z | 28.67, 86.459 | 80 | Reviewed | 0.0 km | 0.0 s |
| efd_01M341DTF04N2VPVZGCXJJ7KX8 | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.10 window=9.7 km/59 s) | emsc:20260922_0000141 | 4 ml | 2026-09-22T07:49:10.000Z | 28.67, 86.459 | 80 |  | 0.0 km | 0.0 s |

### efd_01M3C6KNMG22YDBV80CWMXXKS6 — M3.9  Reviewed 2026-09-25T11:53:28.000Z Leh, Ladakh (ncs) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3C6KNMG22YDBV80CWMXXKS6 | survivor | ncs:NGFBZUJtNnEwUU9oL0g0WS9CcXRiQT09 | 3.9  | 2026-09-25T11:53:28.000Z | 34.751, 77.084 | 180 | Reviewed | 0.0 km | 0.0 s |
| efd_01M3C6KNMG1ZQQ00V69R1KQGKG | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | emsc:20260925_0000138 | 3.9 m | 2026-09-25T11:53:28.000Z | 34.751, 77.084 | 180 |  | 0.0 km | 0.0 s |

### efd_01M31AGEJ06F5KG2DA8NDWE7MD — M3.8 ml  2026-09-21T06:29:47.000Z OFFSHORE ANTOFAGASTA, CHILE (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M31AGEJ06F5KG2DA8NDWE7MD | survivor | emsc:20260921_0000112 | 3.8 ml | 2026-09-21T06:29:47.000Z | -22.97, -70.62 | 25.9 |  | 0.0 km | 0.0 s |
| efd_01M31AFH8GPCHN47XWT32ZENYF | op:merge (proximity: d=0.5 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | csn:383905 | 3.8 Mlv | 2026-09-21T06:29:47.000Z | -22.968, -70.624 | 26 |  | 0.5 km | 0.0 s |

### efd_01M367NE9GEZTP8BS7QJETZX73 — M3.6  Reviewed 2026-09-23T04:16:41.000Z Myanmar (ncs) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M367NE9GEZTP8BS7QJETZX73 | survivor | ncs:NEwweU8xK3ZqNktHQ1ZiVENDYm4vUT09 | 3.6  | 2026-09-23T04:16:41.000Z | 23.462, 93.792 | 50 | Reviewed | 0.0 km | 0.0 s |
| efd_01M367NE9G1GV9ZK9PZJPADVZ8 | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | emsc:20260923_0000042 | 3.6 m | 2026-09-23T04:16:41.000Z | 23.462, 93.792 | 50 |  | 0.0 km | 0.0 s |

### efd_01M3HRBV408S7GSBRRK40WCA2P — M3.55404092525043 mw reviewed 2026-09-27T15:40:01.580Z 6 km WSW of Hermosa Beach, CA (usgs) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3HRBV408S7GSBRRK40WCA2P | survivor | scedc:41339927 | 3.5 lr | 2026-09-27T15:40:01.580Z | 33.84417, -118.4649963 | 11.85 |  | 0.0 km | 0.0 s |
| efd_01M3HRBV408S7GSBRRK40WCA2P | survivor | ncedc:75443132 | 3.7 Ml | 2026-09-27T15:40:01.350Z | 33.84633, -118.4595 | -0.62 |  | 0.6 km | -0.2 s |
| efd_01M3HRBV408S7GSBRRK40WCA2P | survivor | usgs:ci41339927 | 3.55404092525043 mw | 2026-09-27T15:40:01.580Z | 33.844165802002, -118.464996337891 | 11.8500003814697 | reviewed | 0.0 km | 0.0 s |
| efd_01M3HRBV40CT2427NXWXMXCWJZ | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | emsc:20260927_0000195 | 3.5 mw | 2026-09-27T15:40:01.580Z | 33.8442, -118.465 | 11.9 |  | 0.0 km | 0.0 s |

### efd_01M3HM732GDJP6K9JJE0HGK4EF — M3.5 ml  2026-09-27T14:27:33.000Z SALTA, ARGENTINA (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3HM732GDJP6K9JJE0HGK4EF | survivor | emsc:20260927_0000180 | 3.5 ml | 2026-09-27T14:27:33.000Z | -24.13, -67.54 | 230.7 |  | 0.0 km | 0.0 s |
| efd_01M3HM732G3HFCWNMEJXXPNXR4 | op:merge (proximity: d=0.3 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | csn:384643 | 3.5 Mlv | 2026-09-27T14:27:33.000Z | -24.133, -67.54 | 231 |  | 0.3 km | 0.0 s |

### efd_01M32TFSDGXDBGX84806XP73HS — M3.2 ml  2026-09-21T20:28:42.000Z ANTOFAGASTA, CHILE (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M32TFSDGXDBGX84806XP73HS | survivor | emsc:20260921_0000357 | 3.2 ml | 2026-09-21T20:28:42.000Z | -21.55, -68.73 | 128.6 |  | 0.0 km | 0.0 s |
| efd_01M32TFSDG6KAZ850FQ6BXNGGA | op:merge (proximity: d=0.2 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | csn:383984 | 3.2 Mlv | 2026-09-21T20:28:42.000Z | -21.549, -68.729 | 129 |  | 0.2 km | 0.0 s |

### efd_01M33Q2D00SS7P49HB7QJX26MM — M3.2 ml  2026-09-22T04:48:04.310Z SOUTHERN ITALY (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M33Q2D00SS7P49HB7QJX26MM | survivor | emsc:20260922_0000086 | 3.2 ml | 2026-09-22T04:48:04.310Z | 41.5835, 16.0565 | 27.3 |  | 0.0 km | 0.0 s |
| efd_01M33Q2D00450C5KF9FST6HNBH | op:merge (proximity: d=0.0 km dt=1.9 s dM=0.00 window=10.0 km/60 s) | ingv:47219912 | 3.2 ML | 2026-09-22T04:48:02.120Z | 41.5835, 16.0565 | 27.3 |  | 0.0 km | -2.2 s |

### efd_01M341TMM0D3TZATCYYBHCRZQD — M3.2 ml  2026-09-22T07:56:06.000Z ANTOFAGASTA, CHILE (emsc) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M341TMM0D3TZATCYYBHCRZQD | survivor | emsc:20260922_0000144 | 3.2 ml | 2026-09-22T07:56:06.000Z | -24.02, -67.48 | 216.9 |  | 0.0 km | 0.0 s |
| efd_01M341TMM0D3TZATCYYBHCRZQD | survivor | inpres:20260922075605 | 2.8  | 2026-09-22T07:56:05.000Z | -24.23, -67.16 | 205 |  | 40.0 km | -1.0 s |
| efd_01M341TMM07RG0EF3VZWSYW445 | op:merge (proximity: d=0.5 km dt=0.0 s dM=0.50 window=8.5 km/53 s) | csn:384023 | 3.7 Mlv | 2026-09-22T07:56:06.000Z | -24.017, -67.483 | 217 |  | 0.5 km | 0.0 s |

### efd_01M35WTES0M5RGV176MX30QW54 — M3.2 ml automatic 2026-09-23T01:07:06.694Z Crikvenica / Adria (geosphere) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M35WTES0M5RGV176MX30QW54 | survivor | geosphere:53282577 | 3.2 ml | 2026-09-23T01:07:06.694Z | 45.1152, 14.7668 | 4 | automatic | 0.0 km | 0.0 s |
| efd_01M35WTES0XNGR5CS3KZY1MNKY | op:merge (proximity: d=4.3 km dt=1.4 s dM=0.40 window=8.8 km/54 s) | emsc:20260923_0000009 | 2.8 ml | 2026-09-23T01:07:08.120Z | 45.153, 14.755 | 10 |  | 4.3 km | 1.4 s |

### efd_01M39DEWJGX4TDNRYHDVDARE6Q — M3.2 ml reviewed 2026-09-24T09:55:04.538Z 216 km SSE of Akhiok, Alaska (usgs) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M39DEWJGX4TDNRYHDVDARE6Q | survivor | usgs:aka2026sybrit | 3.2 ml | 2026-09-24T09:55:04.538Z | 55.076, -153.225 | 5 | reviewed | 0.0 km | 0.0 s |
| efd_01M39DDZ90CB2W4W2ABM21P8YA | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | emsc:20260924_0000274 | 3.2 ml | 2026-09-24T09:55:04.538Z | 55.076, -153.225 | 5 |  | 0.0 km | 0.0 s |

### efd_01M37GKJ40MRH5N0RPBM2VS249 — M3 ML automatic 2026-09-23T16:11:53.000Z GIRIT ADASI ACIKLARI (MEDITERRANEAN SEA) (koeri) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M37GKJ40MRH5N0RPBM2VS249 | survivor | emsc:20260923_0000205 | 3.1 ml | 2026-09-23T16:11:53.800Z | 34.6518, 26.2208 | 13.2 |  | 7.0 km | 0.8 s |
| efd_01M37GKJ407WAD7MH4BM0WYDCJ | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | noa:noa2026srncc | 3.104727958 MLh | 2026-09-23T16:11:54.850Z | 34.656372, 26.277466 | 31.60766602 |  | 3.5 km | 1.9 s |
| efd_01M37GKJ407WAD7MH4BM0WYDCJ | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | koeri:koeri-20260923161153 | 3 ML | 2026-09-23T16:11:53.000Z | 34.627, 26.2915 | 28.9 | automatic | 0.0 km | 0.0 s |

### efd_01M392X210WZKCPNZ1N73FMN51 — M3 ml  2026-09-24T06:50:47.236Z CRETE, GREECE (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M392X210WZKCPNZ1N73FMN51 | survivor | emsc:20260924_0000079 | 3 ml | 2026-09-24T06:50:47.236Z | 34.9603, 23.6298 | 32.5 |  | 0.0 km | 0.0 s |
| efd_01M392X210TRGXQEGC0JM0PE8D | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.10 window=9.7 km/59 s) | noa:noa2026ssqbz | 2.90390168 MLh | 2026-09-24T06:50:47.236Z | 34.960327, 23.629761 | 32.52042643 |  | 0.0 km | 0.0 s |

### efd_01M338PSZ0G84YPPX2R8BET8QP — M2.9 ml  2026-09-22T00:36:49.140Z GREECE (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M338PSZ0G84YPPX2R8BET8QP | survivor | emsc:20260922_0000008 | 2.9 ml | 2026-09-22T00:36:49.140Z | 39.36, 20.5 | 0 |  | 0.0 km | 0.0 s |
| efd_01M338PSZ01WBPJBPR55VGK17P | op:merge (proximity: d=5.1 km dt=0.3 s dM=0.29 window=9.1 km/56 s) | noa:noa2026somsp | 2.923255975 MLh | 2026-09-22T00:36:50.420Z | 39.361267, 20.475769 | 11.32727051 |  | 2.1 km | 1.3 s |

### efd_01M33QBHZ0J67DCPFRNDCHFKQ6 — M2.7 ML automatic 2026-09-22T04:53:12.000Z AEGEAN SEA (koeri) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M33QBHZ0J67DCPFRNDCHFKQ6 | survivor | noa:noa2026soven | 2.662833658 MLh | 2026-09-22T04:53:13.881Z | 39.289619, 24.816107 | 10 |  | 1.8 km | 1.9 s |
| efd_01M33QBHZ0J67DCPFRNDCHFKQ6 | survivor | koeri:koeri-20260922045312 | 2.7 ML | 2026-09-22T04:53:12.000Z | 39.2968, 24.7972 | 6.2 | automatic | 0.0 km | 0.0 s |
| efd_01M33QCF8GFXKQRJBZSBJ8GBPP | op:merge (proximity: d=2.4 km dt=0.3 s dM=0.00 window=10.0 km/60 s) | emsc:20260922_0000099 | 2.7 ml | 2026-09-22T04:53:12.240Z | 39.3073, 24.7723 | 16.8 |  | 2.4 km | 0.2 s |

### efd_01M3105130Y60BD14B7XW8XZAP — M2.6 ml  2026-09-21T03:29:09.040Z ADRIATIC SEA (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3105130Y60BD14B7XW8XZAP | survivor | emsc:20260921_0000063 | 2.6 ml | 2026-09-21T03:29:09.040Z | 40.34, 19.44 | 4 |  | 0.0 km | 0.0 s |
| efd_01M31051301HXBFRSPJ871S03W | op:merge (proximity: d=3.2 km dt=2.4 s dM=0.06 window=9.8 km/59 s) | noa:noa2026smwxa | 2.595330596 MLh | 2026-09-21T03:29:07.262Z | 40.450745, 19.197693 | 11.66955566 |  | 23.9 km | -1.8 s |

### efd_01M36TP8Q0Z3KRC3KG37C4QXNZ — M2.6 ml  2026-09-23T09:48:55.000Z ANTOFAGASTA, CHILE (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M36TP8Q0Z3KRC3KG37C4QXNZ | survivor | emsc:20260923_0000110 | 2.6 ml | 2026-09-23T09:48:55.000Z | -21.93, -68.45 | 127.2 |  | 0.0 km | 0.0 s |
| efd_01M36TP8Q0CZZD4JC5E2JMR5GX | op:merge (proximity: d=0.3 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | csn:384122 | 2.6 Mlv | 2026-09-23T09:48:55.000Z | -21.927, -68.451 | 127 |  | 0.3 km | 0.0 s |

### efd_01M393EENGVBKE3B47TPEDTW1Q — M2.6 ml automatic 2026-09-24T07:00:35.102Z Crikvenica / Kroatien (geosphere) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M393EENGVBKE3B47TPEDTW1Q | survivor | emsc:20260924_0000076 | 2.1 ml | 2026-09-24T07:00:34.930Z | 45.1638, 14.8009 | 0.9 |  | 4.3 km | -0.2 s |
| efd_01M393EENGVBKE3B47TPEDTW1Q | survivor | geosphere:53282698 | 2.6 ml | 2026-09-24T07:00:35.102Z | 45.1778, 14.75 | 10 | automatic | 0.0 km | 0.0 s |
| efd_01M393EENGTWPKKGRF6CQQ7CH6 | op:merge (proximity: d=6.7 km dt=0.1 s dM=0.70 window=7.9 km/50 s) | ingv:47232942 | 2.6 ML | 2026-09-24T07:00:35.200Z | 45.1483, 14.8523 | 10 |  | 8.7 km | 0.1 s |

### efd_01M3A7BE80NVSG8FJ8CV1RG6R6 — M2.6 ml  2026-09-24T17:27:44.010Z WEST OF GIBRALTAR (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3A7BE80NVSG8FJ8CV1RG6R6 | survivor | emsc:20260924_0000251 | 2.6 ml | 2026-09-24T17:27:44.010Z | 36.5732, -9.7922 | 29.8 |  | 0.0 km | 0.0 s |
| efd_01M3A7BE80DVF0EY801FRYTB51 | op:merge (proximity: d=7.1 km dt=2.0 s dM=0.40 window=8.8 km/54 s) | ign:es2026stlcm | 3 mbLg | 2026-09-24T17:27:46.000Z | 36.6357, -9.8065 | 23 |  | 7.1 km | 2.0 s |

### efd_01M39DSW4G7WAYG9G44ETYDKNA — M2.5 ml  2026-09-24T10:01:16.300Z GREECE (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M39DSW4G7WAYG9G44ETYDKNA | survivor | emsc:20260924_0000131 | 2.5 ml | 2026-09-24T10:01:16.300Z | 39.666, 20.296 | 15 |  | 0.0 km | 0.0 s |
| efd_01M39DSW4G6EFWF5XBGR90179Y | op:merge (proximity: d=5.8 km dt=0.8 s dM=0.39 window=8.8 km/54 s) | noa:noa2026sswjl | 2.109748728 MLh | 2026-09-24T10:01:15.487Z | 39.718266, 20.303301 | 5 |  | 5.8 km | -0.8 s |

### efd_01M37YN2WGH2CV8PPP3PZFKMR2 — M2.4 L  2026-09-23T20:17:19.000Z Falha GLORIA (ipma) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M37YN2WGH2CV8PPP3PZFKMR2 | survivor | emsc:20260923_0000270 | 2.4 ml | 2026-09-23T20:17:19.200Z | 37.2, -24.197 | 15 |  | 0.3 km | 0.2 s |
| efd_01M37YN2WGH2CV8PPP3PZFKMR2 | survivor | ipma:2026-09-23T20:17:19_37.2_-24.197 | 2.4 L | 2026-09-23T20:17:19.000Z | 37.2, -24.197 | 15 |  | 0.3 km | 0.0 s |
| efd_01M37YN2WGXGRVZ8EZZS5VZE3V | joined at first sight | ipma:2026-09-23T20:17:19_37.2_-24.2 | 2.4 L | 2026-09-23T20:17:19.000Z | 37.2, -24.2 | 15 |  | 0.0 km | 0.0 s |

### efd_01M3BTEJF0V4NQVE6DGPXCZYGR — M2.3 L  2026-09-25T08:21:10.000Z N Banco D. João de Castro (ipma) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3BTEJF0V4NQVE6DGPXCZYGR | survivor | ipma:2026-09-25T08:21:10_38.411_-26.801 | 2.3 L | 2026-09-25T08:21:10.000Z | 38.411, -26.801 | 5 |  | 0.1 km | 0.0 s |
| efd_01M3BTEJF0DKQS5ME5DXW1JH64 | joined at first sight | ipma:2026-09-25T08:21:10_38.412_-26.801 | 2.3 L | 2026-09-25T08:21:10.000Z | 38.412, -26.801 | 5 |  | 0.0 km | 0.0 s |

### efd_01M3EBPNK0VZ4RGKBG6AMAW4F6 — M2.3 ML automatic 2026-09-26T08:00:52.000Z ULUKOY-NALLIHAN (ANKARA) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3EBPNK0VZ4RGKBG6AMAW4F6 | survivor | koeri:koeri-20260926080052 | 2.3 ML | 2026-09-26T08:00:52.000Z | 40.1383, 31.7025 | 5 | automatic | 0.0 km | 0.0 s |
| efd_01M3EBPNK0RZ5F3J81CRYPWJJG | op:merge (proximity: d=0.0 km dt=1.0 s dM=0.20 window=9.4 km/57 s) | emsc:20260926_0000078 | 2.1 ml | 2026-09-26T08:00:52.970Z | 40.1383, 31.7025 | 5 |  | 0.0 km | 1.0 s |

### efd_01M33NXS40QSGVYXBH3TX54PQZ — M2.2 L  2026-09-22T04:27:58.000Z Josephine (ipma) — 3 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M33NXS40QSGVYXBH3TX54PQZ | survivor | emsc:20260922_0000075 | 2.2 ml | 2026-09-22T04:27:58.100Z | 36.947, -13.431 | 79.2 |  | 0.9 km | 0.1 s |
| efd_01M33NXS40QSGVYXBH3TX54PQZ | survivor | ipma:2026-09-22T04:27:58_36.947_-13.431 | 2.2 L | 2026-09-22T04:27:58.000Z | 36.947, -13.431 | 79 |  | 0.9 km | 0.0 s |
| efd_01M33NXS40XDD94S4ZCPVBVPMP | joined at first sight | ipma:2026-09-22T04:27:58_36.955_-13.434 | 2.2 L | 2026-09-22T04:27:58.000Z | 36.955, -13.434 | 78 |  | 0.0 km | 0.0 s |

### efd_01M3B679JG0XJRE7GD6JHW7GNQ — M2.2 L  2026-09-25T02:27:22.000Z N Faial (ipma) — 3 ids from 3 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3B679JG0XJRE7GD6JHW7GNQ | survivor | ipma:2026-09-25T02:27:22_38.727_-28.724 | 2.2 L | 2026-09-25T02:27:22.000Z | 38.727, -28.724 | 26 |  | 0.0 km | 0.0 s |
| efd_01M3B679JG49F5VNN2KKMD314S | joined at first sight | ipma:2026-09-25T02:27:22_38.727_-28.727 | 2.2 L | 2026-09-25T02:27:22.000Z | 38.727, -28.727 | 27 |  | 0.3 km | 0.0 s |
| efd_01M3B679JGBP93EYK8A1QV87X3 | joined at first sight | ipma:2026-09-25T02:27:22_38.727_-28.726 | 2.2 L | 2026-09-25T02:27:22.000Z | 38.727, -28.726 | 27 |  | 0.2 km | 0.0 s |

### efd_01M3BCTS50XCK35SD1W9WAG7YR — M2.2 ml  2026-09-25T04:22:51.620Z CROATIA (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3BCTS50XCK35SD1W9WAG7YR | survivor | emsc:20260925_0000036 | 2.2 ml | 2026-09-25T04:22:51.620Z | 45.1372, 14.8125 | 0.9 |  | 0.0 km | 0.0 s |
| efd_01M3BCTS50Q571DKBDDPN281XA | op:merge (proximity: d=7.2 km dt=0.3 s dM=0.90 window=7.3 km/47 s) | ingv:47240472 | 2.8 ML | 2026-09-25T04:22:51.590Z | 45.14, 14.8972 | 3.2 |  | 6.7 km | -0.0 s |

### efd_01M336NSWG5YYJ2RBGXY5HK9CM — M2.1 ML automatic 2026-09-22T00:01:31.000Z MEDITERRANEAN SEA (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M336NSWG5YYJ2RBGXY5HK9CM | survivor | koeri:koeri-20260922000131 | 2.1 ML | 2026-09-22T00:01:31.000Z | 35.446, 27.2407 | 6.8 | automatic | 0.0 km | 0.0 s |
| efd_01M336NSWG8HZ8XQWDERAC3XR4 | op:merge (proximity: d=5.1 km dt=1.3 s dM=0.00 window=10.0 km/60 s) | emsc:20260922_0000062 | 2.1 ml | 2026-09-22T00:01:29.740Z | 35.4201, 27.1941 | 6 |  | 5.1 km | -1.3 s |

### efd_01M2WTZ84GG6X1SSVF9ZZJG8MN — M2.023343  reviewed 2026-09-19T12:41:15.736Z Norðurland (imo) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M2WTZ84GG6X1SSVF9ZZJG8MN | survivor | imo:IMO2026smbtxs | 2.029392  | 2026-09-19T12:41:15.527Z | 66.290588, -18.659334 | 10 | reviewed | 1.3 km | -0.2 s |
| efd_01M2WTZ84GGKETFXFAMWB74E16 | joined at first sight | imo:IMO2026smbtsi | 2.023343  | 2026-09-19T12:41:15.736Z | 66.287315, -18.630857 | 10 | reviewed | 0.0 km | 0.0 s |

### efd_01M3D3PRJ0SSYYHF7DC9XMPWV1 — M2 ML automatic 2026-09-25T20:21:49.000Z SEKLI-BEYPAZARI (ANKARA) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3D3PRJ0SSYYHF7DC9XMPWV1 | survivor | koeri:koeri-20260925202149 | 2 ML | 2026-09-25T20:21:49.000Z | 40.2118, 31.7087 | 3.1 | automatic | 0.0 km | 0.0 s |
| efd_01M3D3PRJ0KJXZARQH16RDQHCA | op:merge (proximity: d=0.0 km dt=0.9 s dM=0.10 window=9.7 km/59 s) | emsc:20260925_0000271 | 1.9 ml | 2026-09-25T20:21:49.900Z | 40.2118, 31.7087 | 3.1 |  | 0.0 km | 0.9 s |

### efd_01M3E7XTD0JZ5K3NFQN5K1GPRM — M2 ML automatic 2026-09-26T06:55:01.000Z RODOS ADASI (MEDITERRANEAN SEA) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3E7XTD0JZ5K3NFQN5K1GPRM | survivor | koeri:koeri-20260926065501 | 2 ML | 2026-09-26T06:55:01.000Z | 35.9813, 27.8368 | 73.6 | automatic | 0.0 km | 0.0 s |
| efd_01M3E7XTD0B8YJQHN8Y00VAC7E | op:merge (proximity: d=4.7 km dt=0.9 s dM=0.10 window=9.7 km/59 s) | emsc:20260926_0000062 | 1.9 ml | 2026-09-26T06:55:01.930Z | 36.0046, 27.8807 | 18.4 |  | 4.7 km | 0.9 s |

### efd_01M37CKCJ0VS7G82X7W1V61J1Q — M1.8 ML automatic 2026-09-23T15:01:58.000Z YUKARIKARAGOZ-PINARBASI (KAYSERI) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M37CKCJ0VS7G82X7W1V61J1Q | survivor | koeri:koeri-20260923150158 | 1.8 ML | 2026-09-23T15:01:58.000Z | 38.7255, 36.5257 | 16.7 | automatic | 0.0 km | 0.0 s |
| efd_01M37CKCJ0PNMVDR0H3GRTABG6 | op:merge (proximity: d=4.4 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | emsc:20260923_0000196 | 1.8 ml | 2026-09-23T15:01:57.960Z | 38.765, 36.5238 | 7 |  | 4.4 km | -0.0 s |

### efd_01M3D6X9T06Z83DX1FVYE19NC2 — M1.8 ML  2026-09-25T21:17:48.800Z 1 km W Salara (RO) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3D6X9T06Z83DX1FVYE19NC2 | survivor | ingv:46714241 | 1.8 ML | 2026-09-25T21:17:48.800Z | 44.986, 11.4147 | 11.1 |  | 0.0 km | 0.0 s |
| efd_01M3D6X9T0146VP37C6F8HNMSX | joined at first sight | ingv:47246642 | 1.8 ML | 2026-09-25T21:17:48.800Z | 44.986, 11.4147 | 11.1 |  | 0.0 km | 0.0 s |

### efd_01M372KVYGWF04Q8MP59B0CPQF — M1.7 ml reviewed 2026-09-23T12:07:28.820Z 40 km ESE of Malaga, New Mexico (usgs) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M372KVYGWF04Q8MP59B0CPQF | survivor | usgs:tx2026stjnme | 1.7 ml | 2026-09-23T12:07:28.903Z | 32.074, -103.68 | 7.7789 | reviewed | 0.3 km | 0.1 s |
| efd_01M372KVYGCNAT7HAMF4HRXWJY | joined at first sight | usgs:tx2026stjnvi | 1.7 ml | 2026-09-23T12:07:28.820Z | 32.071, -103.681 | 8.9325 | reviewed | 0.0 km | 0.0 s |

### efd_01M3HCVSS06QQC5205WK9CTFA3 — M1.7 ML automatic 2026-09-27T12:18:54.000Z OSMANLAR-SINDIRGI (BALIKESIR) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3HCVSS06QQC5205WK9CTFA3 | survivor | koeri:koeri-20260927121854 | 1.7 ML | 2026-09-27T12:18:54.000Z | 39.2393, 28.291 | 16.9 | automatic | 0.0 km | 0.0 s |
| efd_01M3HCVSS09W4JVVQNSVF5XYJB | op:merge (proximity: d=9.3 km dt=1.2 s dM=0.20 window=9.4 km/57 s) | emsc:20260927_0000142 | 1.5 ml | 2026-09-27T12:18:55.160Z | 39.1588, 28.2633 | 8.6 |  | 9.3 km | 1.2 s |

### efd_01M3B4Z0GGR377MTMRTPQTCAEX — M1.6 ML reviewed 2026-09-25T02:05:42.000Z SEKLI-BEYPAZARI (ANKARA) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3B4Z0GGR377MTMRTPQTCAEX | survivor | koeri:koeri-20260925020542 | 1.6 ML | 2026-09-25T02:05:42.000Z | 40.2035, 31.7327 | 4.9 | reviewed | 0.0 km | 0.0 s |
| efd_01M3B4Z0GGWZDTN0877Q9SEDTH | op:merge (proximity: d=2.7 km dt=0.3 s dM=0.20 window=9.4 km/57 s) | emsc:20260925_0000021 | 1.4 ml | 2026-09-25T02:05:42.260Z | 40.185, 31.7528 | 5.5 |  | 2.7 km | 0.3 s |

### efd_01M34F1KS0X88XACJBAMYKVJQ1 — M1.5   2026-09-22T11:46:56.000Z SILVERDALE,LANCASHIRE (bgs) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M34F1KS0X88XACJBAMYKVJQ1 | survivor | bgs:20260922114657 | 1.5  | 2026-09-22T11:46:56.000Z | 54.166, -2.827 | 3 |  | 0.5 km | 0.0 s |
| efd_01M34F1KS07CDFKXRTVNVA1M8T | joined at first sight | bgs:20260922114620 | 1.5  | 2026-09-22T11:46:56.000Z | 54.166, -2.82 | 3 |  | 0.0 km | 0.0 s |

### efd_01M3ETPD50HKJYPT6CN7HQ4AF2 — M1.5 ML automatic 2026-09-26T12:22:54.000Z AMBARCIK-YAZIHAN (MALATYA) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3ETPD50HKJYPT6CN7HQ4AF2 | survivor | koeri:koeri-20260926122254 | 1.5 ML | 2026-09-26T12:22:54.000Z | 38.5907, 38.3488 | 15.2 | automatic | 0.0 km | 0.0 s |
| efd_01M3ETPD50Q571CANDV9GE3GW8 | op:merge (proximity: d=2.6 km dt=1.4 s dM=0.10 window=9.7 km/59 s) | emsc:20260926_0000133 | 1.4 ml | 2026-09-26T12:22:55.420Z | 38.5687, 38.3373 | 17.2 |  | 2.6 km | 1.4 s |

### efd_01M31J8J0GKYNK9RTG92RQKXWB — M1.4 ML automatic 2026-09-21T08:45:25.000Z BAGDAMLARI-MILAS (MUGLA) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M31J8J0GKYNK9RTG92RQKXWB | survivor | koeri:koeri-20260921084525 | 1.4 ML | 2026-09-21T08:45:25.000Z | 37.1508, 27.8552 | 0 | automatic | 0.0 km | 0.0 s |
| efd_01M31J8J0GV14BVJWR5633HBXB | op:merge (proximity: d=6.4 km dt=0.2 s dM=0.10 window=9.7 km/59 s) | emsc:20260921_0000156 | 1.3 ml | 2026-09-21T08:45:25.160Z | 37.0933, 27.8633 | 11.6 |  | 6.4 km | 0.2 s |

### efd_01M38AAM0G83RV46RDRMFAVQEA — M1.4 ML automatic 2026-09-23T23:41:28.000Z GUZELHISAR-ALIAGA (IZMIR) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M38AAM0G83RV46RDRMFAVQEA | survivor | koeri:koeri-20260923234128 | 1.4 ML | 2026-09-23T23:41:28.000Z | 38.7962, 27.0505 | 16.8 | automatic | 0.0 km | 0.0 s |
| efd_01M38AAM0GZ0XB2DA31Q5M7REP | op:merge (proximity: d=9.6 km dt=0.1 s dM=0.10 window=9.7 km/59 s) | emsc:20260923_0000319 | 1.3 ml | 2026-09-23T23:41:28.120Z | 38.7718, 27.1565 | 6.1 |  | 9.6 km | 0.1 s |

### efd_01M39B9A0GMA6XJGZV8HZSA93H — M1.3 ml  2026-09-24T09:17:30.781Z NORTHERN ITALY (emsc) — 4 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M39B9A0GMA6XJGZV8HZSA93H | survivor | emsc:20260924_0000120 | 1.3 ml | 2026-09-24T09:17:30.781Z | 45.8956, 7.0162 | 6 |  | 0.0 km | 0.0 s |
| efd_01M39B9A0GMA6XJGZV8HZSA93H | survivor | ethz:smi:ch.ethz.sed/sc25a/Event/2026syakov | 1.3389923747082946 MLhc | 2026-09-24T09:17:30.781Z | 45.89560310183023, 7.016239769276404 | 6.035986328125001 |  | 0.0 km | 0.0 s |
| efd_01M39B9A0G5P5Q05V8GSF6WFAJ | op:merge (proximity: d=0.9 km dt=0.0 s dM=0.46 window=8.6 km/53 s) | renass:fr2026urpeel | 1.140237539 MLv | 2026-09-24T09:17:31.349Z | 45.82304764, 7.084626198 | 5.352865219 |  | 9.7 km | 0.6 s |
| efd_01M39B9A0G5P5Q05V8GSF6WFAJ | op:merge (proximity: d=0.9 km dt=0.0 s dM=0.46 window=8.6 km/53 s) | resif:fr2026urpeel | 0.8444046488 MLv | 2026-09-24T09:17:30.749Z | 45.88991165, 7.008774757 | 8.28512001 |  | 0.9 km | -0.0 s |

### efd_01M3CZG5XGHVFJTXDANRB6ZCKK — M1.3 ML  2026-09-25T19:08:32.250Z 2 km E Oriolo (CS) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3CZG5XGHVFJTXDANRB6ZCKK | survivor | ingv:46713941 | 1.3 ML | 2026-09-25T19:08:32.250Z | 40.0552, 16.471 | 15.6 |  | 0.0 km | 0.0 s |
| efd_01M3CZG5XGD1185S7425JTH0N4 | joined at first sight | ingv:47246312 | 1.3 ML | 2026-09-25T19:08:32.250Z | 40.0552, 16.471 | 15.6 |  | 0.0 km | 0.0 s |

### efd_01M3D07ZMG6GZH90R7B8XRGWFS — M1.2 ML  2026-09-25T19:21:39.800Z 2 km SE Delianuova (RC) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3D07ZMG6GZH90R7B8XRGWFS | survivor | ingv:46713991 | 1.2 ML | 2026-09-25T19:21:39.800Z | 38.2288, 15.9253 | 11.9 |  | 0.0 km | 0.0 s |
| efd_01M3D07ZMGEN34YWNTPFPEAXMJ | joined at first sight | ingv:47246372 | 1.2 ML | 2026-09-25T19:21:39.800Z | 38.2288, 15.9253 | 11.9 |  | 0.0 km | 0.0 s |

### efd_01M31CBYVGMFKVZB9HBH5X1S4B — M1.1 ML  2026-09-21T07:02:19.260Z 7 km NE Pizzoli (AQ) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M31CBYVGMFKVZB9HBH5X1S4B | survivor | ingv:46684081 | 1.1 ML | 2026-09-21T07:02:19.260Z | 42.4738, 13.3648 | 12.1 |  | 0.0 km | 0.0 s |
| efd_01M31CBYVGCYAWSCK629GHG1ZC | joined at first sight | ingv:47214452 | 1.1 ML | 2026-09-21T07:02:19.260Z | 42.4738, 13.3648 | 12.1 |  | 0.0 km | 0.0 s |

### efd_01M31CEPR04GAY0PE5DJ2C1XEN — M1.1 ML  2026-09-21T07:04:14.560Z 4 km S Cagli (PU) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M31CEPR04GAY0PE5DJ2C1XEN | survivor | ingv:46684101 | 1.1 ML | 2026-09-21T07:04:14.560Z | 43.5137, 12.6597 | 7.7 |  | 0.0 km | 0.0 s |
| efd_01M31CEPR07V75WZ6FZ4VE5S40 | joined at first sight | ingv:47214522 | 1.1 ML | 2026-09-21T07:04:14.560Z | 43.5137, 12.6597 | 7.7 |  | 0.0 km | 0.0 s |

### efd_01M364089GJWXAKZ5QTX61TPFC — M1.1 ML automatic 2026-09-23T03:12:35.000Z KATRANDAGI-EMET (KUTAHYA) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M364089GJWXAKZ5QTX61TPFC | survivor | koeri:koeri-20260923031235 | 1.1 ML | 2026-09-23T03:12:35.000Z | 39.2283, 29.0512 | 16.3 | automatic | 0.0 km | 0.0 s |
| efd_01M364089GGJB43XHR6M7CBAX6 | op:merge (proximity: d=0.0 km dt=0.8 s dM=0.00 window=10.0 km/60 s) | emsc:20260923_0000031 | 1.1 ml | 2026-09-23T03:12:35.800Z | 39.2283, 29.0512 | 16.3 |  | 0.0 km | 0.8 s |

### efd_01M3F0H5Q0FSCKH47J63SMCRC4 — M1.1 ML automatic 2026-09-26T14:05:05.000Z CAYGOREN-SINDIRGI (BALIKESIR) (koeri) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3F0H5Q0FSCKH47J63SMCRC4 | survivor | koeri:koeri-20260926140505 | 1.1 ML | 2026-09-26T14:05:05.000Z | 39.2523, 28.2133 | 9.2 | automatic | 0.0 km | 0.0 s |
| efd_01M3F0H5Q0AYSS3A558J4FXF8X | op:merge (proximity: d=3.1 km dt=0.2 s dM=0.00 window=10.0 km/60 s) | emsc:20260926_0000154 | 1.1 ml | 2026-09-26T14:05:05.220Z | 39.2278, 28.2305 | 16 |  | 3.1 km | 0.2 s |

### efd_01M31BTJ70FJJMBB5T0DE5Y904 — M1 Md  2026-09-21T06:53:05.910Z Vesuvio (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M31BTJ70FJJMBB5T0DE5Y904 | survivor | ingv:46684011 | 1 Md | 2026-09-21T06:53:05.910Z | 40.82, 14.429833 | 0.1 |  | 0.0 km | 0.0 s |
| efd_01M31BTJ70PFJA1K6MEYPYMA25 | joined at first sight | ingv:47214362 | 1 Md | 2026-09-21T06:53:05.910Z | 40.82, 14.429833 | 0.1 |  | 0.0 km | 0.0 s |

### efd_01M32BBFC07FBE0YEVJKRGXXAE — M0.9 m  2026-09-21T16:03:55.100Z IRELAND (emsc) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M32BBFC07FBE0YEVJKRGXXAE | survivor | emsc:20260921_0000443 | 0.9 m | 2026-09-21T16:03:55.100Z | 55.13, -7.74 | 2 |  | 0.0 km | 0.0 s |
| efd_01M32BBFC0CNJXTHQJSZE1G5JE | op:merge (proximity: d=0.0 km dt=1.1 s dM=0.10 window=9.7 km/59 s) | bgs:20260921160345 | 0.8  | 2026-09-21T16:03:54.000Z | 55.13, -7.74 | 5 |  | 0.0 km | -1.1 s |

### efd_01M3D4PSYGXCVCPPBFJ44K78J7 — M0.8 ML  2026-09-25T20:39:35.140Z 10 km E Rose (CS) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3D4PSYGXCVCPPBFJ44K78J7 | survivor | ingv:46714141 | 0.8 ML | 2026-09-25T20:39:35.140Z | 39.3937, 16.412 | 14.2 |  | 0.0 km | 0.0 s |
| efd_01M3D4PSYG1B8V9AZSBNZEWSS9 | joined at first sight | ingv:47246532 | 0.8 ML | 2026-09-25T20:39:35.140Z | 39.3937, 16.412 | 14.2 |  | 0.0 km | 0.0 s |

### efd_01M35BPZ80DM84RH6FF6RBSWBY — M0.75 ml reviewed 2026-09-22T20:07:57.040Z 7 km SE of Valle Vista, CA (usgs) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M35BPZ80DM84RH6FF6RBSWBY | survivor | usgs:ci41337079 | 0.75 ml | 2026-09-22T20:07:57.040Z | 33.7101666666667, -116.8315 | 15.3 | reviewed | 0.0 km | 0.0 s |
| efd_01M35BPZ80DN2CARZHZEP20MDX | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | scedc:41337079 | 0.75 l | 2026-09-22T20:07:57.040Z | 33.71017, -116.8315 | 15.3 |  | 0.0 km | 0.0 s |

### efd_01M319FFW0R7BH3X3GWD7EKDT8 — M0.7 ML  2026-09-21T06:12:00.170Z 7 km SE Gualdo Tadino (PG) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M319FFW0R7BH3X3GWD7EKDT8 | survivor | ingv:46683661 | 0.7 ML | 2026-09-21T06:12:00.170Z | 43.1775, 12.8337 | 12 |  | 0.0 km | 0.0 s |
| efd_01M319FFW0M49D3H8GF1VQP01N | joined at first sight | ingv:47214072 | 0.7 ML | 2026-09-21T06:12:00.170Z | 43.1775, 12.8337 | 12 |  | 0.0 km | 0.0 s |

### efd_01M31A6C9GGFTRJT2ET5YM8H5X — M0.7 ML  2026-09-21T06:24:42.970Z 4 km NE Piobbico (PU) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M31A6C9GGFTRJT2ET5YM8H5X | survivor | ingv:46683731 | 0.7 ML | 2026-09-21T06:24:42.970Z | 43.6083, 12.5492 | 7.8 |  | 0.0 km | 0.0 s |
| efd_01M31A6C9G4T55TAKHXFTTV8P9 | joined at first sight | ingv:47214142 | 0.7 ML | 2026-09-21T06:24:42.970Z | 43.6083, 12.5492 | 7.8 |  | 0.0 km | 0.0 s |

### efd_01M35J4Z1GXCW40H3HFHZQAASD — M0.68 ml reviewed 2026-09-22T22:00:34.000Z 16 km WSW of Johannesburg, CA (usgs) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M35J4Z1GXCW40H3HFHZQAASD | survivor | usgs:ci41337239 | 0.68 ml | 2026-09-22T22:00:34.000Z | 35.3306666666667, -117.8085 | 1.85 | reviewed | 0.0 km | 0.0 s |
| efd_01M35J4Z1GQDH8X77754FEZ484 | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | scedc:41337239 | 0.68 l | 2026-09-22T22:00:34.000Z | 35.33067, -117.8085 | 1.85 |  | 0.0 km | 0.0 s |

### efd_01M333F8MGMHM7F5JZNQS6TAEE — M0.66 ml reviewed 2026-09-21T23:05:39.900Z 5 km NNW of Corona, CA (usgs) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M333F8MGMHM7F5JZNQS6TAEE | survivor | usgs:ci41336423 | 0.66 ml | 2026-09-21T23:05:39.900Z | 33.9068333333333, -117.588666666667 | 3.29 | reviewed | 0.0 km | 0.0 s |
| efd_01M333F8MG6NZM6JR3JBAMY90K | op:merge (proximity: d=0.0 km dt=0.0 s dM=0.00 window=10.0 km/60 s) | scedc:41336423 | 0.66 l | 2026-09-21T23:05:39.900Z | 33.90683, -117.5886667 | 3.29 |  | 0.0 km | 0.0 s |

### efd_01M31AN11GPQ5H4CXFGFPGRTAA — M0.5 ML  2026-09-21T06:32:20.150Z 2 km NW Gagliole (MC) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M31AN11GPQ5H4CXFGFPGRTAA | survivor | ingv:46683791 | 0.5 ML | 2026-09-21T06:32:20.150Z | 43.2508, 13.0442 | 12.4 |  | 0.0 km | 0.0 s |
| efd_01M31AN11GXABKWYGKTXFYRBGR | joined at first sight | ingv:47214182 | 0.5 ML | 2026-09-21T06:32:20.150Z | 43.2508, 13.0442 | 12.4 |  | 0.0 km | 0.0 s |

### efd_01M3D5BVS08Q6YJJ7CJV7MEN0J — M0.4 ML  2026-09-25T20:51:08.990Z 9 km S Pietralunga (PG) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3D5BVS08Q6YJJ7CJV7MEN0J | survivor | ingv:46714191 | 0.4 ML | 2026-09-25T20:51:08.990Z | 43.3605, 12.4528 | 5.8 |  | 0.0 km | 0.0 s |
| efd_01M3D5BVS0136N61GG9V3A0W29 | joined at first sight | ingv:47246582 | 0.4 ML | 2026-09-25T20:51:08.990Z | 43.3605, 12.4528 | 5.8 |  | 0.0 km | 0.0 s |

### efd_01M3D74M60KQ17ZTY75DHN231S — M0.3 ML  2026-09-25T21:22:05.460Z 5 km E Pietralunga (PG) (ingv) — 2 ids from 2 groups

| before | how | provider:id | M | origin | lat, lon | depth | status | d to survivor | Δt |
|---|---|---|---|---|---|---|---|---|---|
| efd_01M3D74M60KQ17ZTY75DHN231S | survivor | ingv:46714281 | 0.3 ML | 2026-09-25T21:22:05.460Z | 43.4332, 12.4948 | 6 |  | 0.0 km | 0.0 s |
| efd_01M3D74M604WK3HEMPTWRV66XQ | joined at first sight | ingv:47246682 | 0.3 ML | 2026-09-25T21:22:05.460Z | 43.4332, 12.4948 | 6 |  | 0.0 km | 0.0 s |

## Groups the new rules split (3; vs baseline replay)

### efd_01M31WQMNG6954HYNH1R0615V5 → efd_01M31WQMNG5QXQA9CMSDH0GGV1, efd_01M31WQMNGNP2PF1J7SEM0DWRV

- csn:383933 → efd_01M31WQMNG5QXQA9CMSDH0GGV1: M5.3 2026-09-21T11:48:30.000Z -22.29, -71.76 depth 10 
- usp:usp2026snkr → efd_01M31WQMNGNP2PF1J7SEM0DWRV: M5.046630803856011 2026-09-21T11:48:31.272Z -22.25763702392578, -71.69034576416016 depth 10 

### efd_01M35WTES0XNGR5CS3KZY1MNKY → efd_01M35WTES0M5RGV176MX30QW54, efd_01M35WTES08F1224V7D4CSJ6QT

- emsc:20260923_0000009 → efd_01M35WTES0M5RGV176MX30QW54: M2.8 2026-09-23T01:07:08.120Z 45.153, 14.755 depth 10 
- geosphere:53282743 → efd_01M35WTES08F1224V7D4CSJ6QT: M3.2 2026-09-23T01:07:05.808Z 45.074, 14.753 depth 10 automatic

### efd_01M3F0PNG02986091HQRJX3W7Z → efd_01M3F0QJSGMYKKKM095XCJ4AS5, efd_01M3F0QJSGBYQVCYAH6D86VPEN

- geofon:gfz2026swsu → efd_01M3F0QJSGMYKKKM095XCJ4AS5: M5.51 2026-09-26T14:08:18.310Z -4.622, 152.881 depth 58.9 
- ingv:47252592 → efd_01M3F0QJSGBYQVCYAH6D86VPEN: M5.8 2026-09-26T14:08:19.884Z -4.59141, 152.852 depth 68 

## Live M ≥ 5.5 pairs within 50 km / 60 s that did NOT fold (6)

- efd_01M37BCY3044TYRZJYKS3CKPH3 (M5.7 usgs 2026-09-23T14:41:02.650Z 180 km NW of Hihifo, Tonga) vs efd_01M37BCY305DAY7Z5FQ6N11E37 (M5.7 emsc 2026-09-23T14:41:02.830Z SAMOA ISLANDS REGION): d=18.7 km dt=0.2 s — d 18.7 km > 14.0 km (widened)
- efd_01M37BCY3044TYRZJYKS3CKPH3 (M5.7 usgs 2026-09-23T14:41:02.650Z 180 km NW of Hihifo, Tonga) vs efd_01M37BCY30ZR81Y0P6BGY52C3X (M5.73 geofon 2026-09-23T14:41:03.890Z Samoa Islands Region): d=34.9 km dt=1.2 s — d 34.9 km > 13.9 km (widened)
- efd_01M37BCY305DAY7Z5FQ6N11E37 (M5.7 emsc 2026-09-23T14:41:02.830Z SAMOA ISLANDS REGION) vs efd_01M37BCY30ZR81Y0P6BGY52C3X (M5.73 geofon 2026-09-23T14:41:03.890Z Samoa Islands Region): d=31.3 km dt=1.1 s — d 31.3 km > 13.9 km (widened)
- efd_01M3DF0CTGHZEE40MQ2AM176SV (M5.5 usgs 2026-09-25T23:39:41.392Z 61 km ENE of Tadine, New Caledonia) vs efd_01M3DF1A40228JEHF67SXA5J4M (M5.5 emsc 2026-09-25T23:39:45.500Z LOYALTY ISLANDS): d=16.5 km dt=4.1 s — d 16.5 km > 10.0 km (widened)
- efd_01M3F12JBGJPPHNVEP45GCGWM0 (M6.2 geonet 2026-09-26T14:08:14.000Z 3925 km north-west of Cape Reinga) vs efd_01M3F0QJSGBYQVCYAH6D86VPEN (M5.8 ingv 2026-09-26T14:08:19.884Z Papua New Guinea [Land]): d=41.6 km dt=5.9 s — d 41.6 km > 14.1 km (widened)
- efd_01M3F0QJSGMYKKKM095XCJ4AS5 (M5.6 usgs 2026-09-26T14:08:17.704Z 74 km ESE of Kokopo, Papua New Guinea) vs efd_01M3F0QJSGBYQVCYAH6D86VPEN (M5.8 ingv 2026-09-26T14:08:19.884Z Papua New Guinea [Land]): d=11.6 km dt=2.2 s — d 11.6 km > 11.3 km (widened)

## Live M ≥ 5.5 events after the change (16)

- efd_01M309JNVG2YH0KYC38VHQJBGM M5.546058357456761 mb  2026-09-20T20:54:38.380Z South of Africa — 1 providers, 1 ids
- efd_01M30T068GFMMS55QG4E40TB42 M5.5 mb reviewed 2026-09-21T01:41:36.315Z 35 km NNE of Ruteng, Indonesia — 6 providers, 6 ids
- efd_01M33XNWJG35A9YZWRM8DG2QWD M5.9  automatic 2026-09-22T06:43:27.000Z 525.5 km al Suroeste de Sierpe de Puntarenas — 1 providers, 1 ids
- efd_01M37BCY3044TYRZJYKS3CKPH3 M5.7 mww reviewed 2026-09-23T14:41:02.650Z 180 km NW of Hihifo, Tonga — 1 providers, 1 ids
- efd_01M37BCY305DAY7Z5FQ6N11E37 M5.7 mw  2026-09-23T14:41:02.830Z SAMOA ISLANDS REGION — 1 providers, 1 ids
- efd_01M37BCY30ZR81Y0P6BGY52C3X M5.73 Mw  2026-09-23T14:41:03.890Z Samoa Islands Region — 2 providers, 2 ids
- efd_01M3D52PT01YSN6HYN7BPTZC4C M5.7 mB  2026-09-25T20:40:19.000Z 2995 km north of Cape Reinga — 1 providers, 1 ids
- efd_01M3D76ES08HGFRSA05T71J8ZF M6.6 mww reviewed 2026-09-25T21:23:03.309Z 80 km ENE of Tadine, New Caledonia — 10 providers, 12 ids
- efd_01M3DF0CTGHZEE40MQ2AM176SV M5.5 mww reviewed 2026-09-25T23:39:41.392Z 61 km ENE of Tadine, New Caledonia — 1 providers, 1 ids
- efd_01M3DF1A40228JEHF67SXA5J4M M5.5 mw  2026-09-25T23:39:45.500Z LOYALTY ISLANDS — 2 providers, 2 ids
- efd_01M3DM70VGSXSYQFFQVZ3PAVZ5 M5.5 mb  2026-09-26T01:10:17.630Z Loyalty Islands — 1 providers, 1 ids
- efd_01M3F12JBGJPPHNVEP45GCGWM0 M6.2 mB  2026-09-26T14:08:14.000Z 3925 km north-west of Cape Reinga — 1 providers, 1 ids
- efd_01M3F0QJSGMYKKKM095XCJ4AS5 M5.6 mww reviewed 2026-09-26T14:08:17.704Z 74 km ESE of Kokopo, Papua New Guinea — 5 providers, 5 ids
- efd_01M3F0QJSGBYQVCYAH6D86VPEN M5.8 Mwp  2026-09-26T14:08:19.884Z Papua New Guinea [Land] — 1 providers, 1 ids
- efd_01M3FVGGNGFS7C8RCEHT4BJA3J M6.1 mB  2026-09-26T21:49:40.000Z 3765 km north-west of Cape Reinga — 1 providers, 1 ids
- efd_01M3HB3YNGM653EY3CGSSSZR6D M5.5 mB  2026-09-27T11:46:25.000Z 775 km south-west of Snares Islands — 1 providers, 1 ids
