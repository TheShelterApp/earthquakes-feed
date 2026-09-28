# PF-2 dedup replay — mutual-best folds and the 20 km large-event base (2026-09-28)

Source: `origin/data` c5979bafbe (aggregate seq=184629 @ 2026-09-28T13:42:16Z). Two slices of the observation
log, replayed from an empty event_map with `hotFloorMs = 0`, in seq order:

- **7 days** — `ingest=2026/09/{21..28}`: 15,159 lines, 12,492 provider ids.
- **85 days (the whole log)** — `ingest=2026/07/05` … `2026/09/28`: 184,629 lines (184,411 observe, 208 tombstone,
  10 merge not replayed), 143,803 provider ids.

Reproduce (the baseline is another `dedup.ts` with its relative imports pointed at a checkout, as in
`replay-report.md`):

```sh
git archive origin/data knowledge/observations | tar -x -C /tmp/obs
find /tmp/obs -name '*.ndjson' | sort | xargs cat > /tmp/obs-all.ndjson
git show 1816a99bb7:src/dedup.ts | sed "s#from './\([a-z0-9-]*\).js'#from '$PWD/src/\1.ts'#" > /tmp/dedup-pr21.ts
node --max-old-space-size=8192 --import tsx scripts/replay-dedup.ts --logs /tmp/obs-all.ndjson --baseline /tmp/dedup-pr21.ts --out /tmp/r.md
```

## 1. The merge pass folds mutual best matches only

The heal dry run (`scripts/heal-dryrun.ts` on the same data) found one wrong fold under the PR #21 pass, which takes
the node's nearest mergeable neighbour: Puerto Rico, 2026-09-27, in the dense Guánica cell. USGS pr71534823 M1.2 at
06:05:40.79 took EMSC 20260927_0000066 M2.0 at 06:06:03.38 (1.7 km, 22.6 s, inside the ΔM-shrunk 48 s window), yet
that EMSC row is USGS pr71534788 M2.01 to the millisecond and the metre, which sat in a third node. The same fold
would have happened on the report path as soon as the M1.2 revised. Now a pair folds only when each is the other's
best-scored mergeable neighbour (score = d/km + |dt|/ms of the pair's own window); when a neighbour's best is a third
node that returns the favour, that pair folds first. The dense-cell rule reads a pair the same from both sides
(dense when both cells are dense), so the mutual check is symmetric and never stricter than PR #21 judging from the
non-dense side.

| rules (no heal pass) | slice | nodes | live | op:merge |
|---|---|---|---|---|
| PR #21 (1816a99bb7) | 7 d | 9,294 | 9,199 | 95 |
| mutual best | 7 d | 9,294 | 9,199 | 95 |
| PR #21 (1816a99bb7) | 85 d | 117,044 | 115,915 | 998 |
| mutual best | 85 d | 117,041 | 115,902 | 1,008 |

Over 85 days: 15 groups fold that PR #21 left apart (every one within 3.3 s and 9.9 km, the same event: EMSC or
KOERI vs GEOFON / NOA / USGS stragglers at M0.8–5.0) and 4 regroupings, of which two undo a PR #21 false merge — a
Pinnacles, CA doublet 53 s apart (M2.9 at 02:39:02 and M2.9 at 02:39:55, 2026-08-10) that PR #21 welded into one
node — and two are borderline pairs that no longer fold (JMA's minute-rounded 11:29:00 vs GEOFON 11:29:35.7,
2026-07-06, Δt 35.7 s; INPRES M3.6 vs CSN / EMSC / USGS M4.3–4.5, |ΔM| 0.9, 8.5 km, 2026-07-17).

## 2. The large-event base at M5.5: 10 → 20 km

`windows()` widens the spatial window when both magnitudes are ≥ 5.5:
`clamp(BASE + 20·(min(M) − 5.5), BASE, 50)`, then the ΔM shrink and the hard |ΔM| ≤ 1. At BASE = 10 the M5.5–5.8
window (10–16 km) is below the agencies' preliminary scatter at those magnitudes (15–35 km). Candidates, each replayed
against the mutual-best rules above (the baseline):

| candidate | M5.5 / 5.7 / 6.0 / 6.5 window | 85 d: groups folded | regrouped | live Δ | M ≥ 5.5 pairs ≤ 50 km / 60 s still apart |
|---|---|---|---|---|---|
| baseline: base 10, 20 km/M | 10 / 14 / 20 / 30 | — | — | — | 172 |
| c2: base 10, 40 km/M | 10 / 18 / 30 / 50 | 27 | 4 | −26 | 135 |
| c4: base 15, 30 km/M | 15 / 21 / 30 / 45 | 48 | 7 | −46 | 111 |
| **c1: base 20, 20 km/M (shipped)** | **20 / 24 / 30 / 40** | **57** | **9** | **−55** | **98** |
| c5: base 20, 30 km/M | 20 / 26 / 35 / 50 | 62 | 10 | −61 | 91 |

False-merge review of every added fold (each pair of pre-change groups inside a fold: the closest rows' Δt, distance
and ΔM): no fold joins rows more than 10 s apart in c1 and c4; the one ΔM flag (Vanuatu 2026-07-08, RéNaSS's
preliminary M5.1 vs GeoNet M5.9, 1.3 s apart, inside a fold of USGS / EMSC / GEOFON / GA / INGV) is one event. c2 and
c5 also chain a GeoNet solution 100–150 km off into the Sarangani M6.3 of 2026-08-05 — the same event, but only
because the wider slopes let a far preliminary join through intermediate rows. The regroupings are stragglers moving
between nodes of one event (e.g. GA's M5.9 of the Kermadec deep M5.8 of 2026-07-15 joins the INGV node instead of the
USGS one; three nodes either way). c1 is the smallest change that covers the diagnosed cases:

| case (7-day slice) | before | c1 |
|---|---|---|
| Loyalty aftershock M5.5, 2026-09-25 23:39, USGS vs EMSC 16.5 km | split (10 km) | one event |
| Tonga/Samoa M5.7, 2026-09-23 14:41, USGS vs EMSC 18.7 km | split (14 km) | one event |
| Tonga/Samoa M5.7, GEOFON+INGV vs the others 31–35 km | split | split (24 km) |
| PNG M5.6–5.8, 2026-09-26 14:08, INGV 11.6 km | split (11.3 km) | one event |
| PNG, GeoNet M6.2 52.8 km off | split | split (beyond the 50 km cap) |

7 days, c1 vs baseline: 3 groups folded (those three), 0 regrouped, M ≥ 5.5 pairs still apart 6 → 1.
