import { join } from 'node:path';

export const REPO = 'TheShelterApp/earthquakes-feed';
export const DOMAIN = 'earthquakes-feed.theshelter.app';
export const JSDELIVR_BASE = `https://cdn.jsdelivr.net/gh/${REPO}`;

export const SCHEMA_VERSION = 1;
export const FEED_ID_PREFIX = 'efd_';

/** Directory of the checked-out `data` branch (worktree in CI, plain dir locally). */
export const DATA_DIR = process.env.DATA_DIR ?? '.data';
/** Directory uploaded to Cloudflare Pages by derive.yml (not committed). */
export const PUBLIC_DIR = process.env.PUBLIC_DIR ?? 'public';
export const REGISTRY_PATH = process.env.REGISTRY_PATH ?? 'providers/registry.json';
export const SCHEMA_DIR = process.env.SCHEMA_DIR ?? 'schema';

// --- dedup / identity (base windows held identical to the iOS/web clients) ---
export const SPATIAL_KM = 10;
export const TEMPORAL_MS = 60_000;
/** Fixed-degree grid cell size for the spatial index (~22 km at the equator). */
export const GRID_CELL_DEG = 0.2;
/** Swarm guard: a grid cell holding this many live events disables proximity-merge. */
export const SWARM_CELL_ABSOLUTE = 50;
export const MAG_MERGE_MAX_DELTA = 0.8;
/** Large-event proximity. Preliminary epicentres of one M6–7 quake scatter by tens of km
 *  across agencies (Loyalty Islands M7.0, 2026-09-25: 22–62 km, six feed ids), so when BOTH
 *  solutions are ≥ LARGE_EVENT_MAG the spatial window is
 *  clamp(LARGE_EVENT_BASE_KM + LARGE_EVENT_KM_PER_MAG · (min(mag) − LARGE_EVENT_MAG), LARGE_EVENT_BASE_KM, LARGE_EVENT_MAX_KM)
 *  (M5.5 → 20 km, M6.0 → 30, M6.5 → 40, M7.0 → 50; the cap is the alerts gateway's own fold
 *  window) before the usual ΔM shrink. On that widened path a hard |ΔM| ≤ LARGE_EVENT_MAX_DELTA
 *  keeps a large aftershock out of the mainshock's window.
 *  The base was 10 km (= SPATIAL_KM) until 2026-09-28; agencies scatter by 15–35 km at M5.5–5.8
 *  (the Loyalty aftershock M5.5, USGS vs EMSC 16.5 km; Tonga M5.7, 18.7 km). 20 km was measured
 *  by replaying the whole observation log (2026-07-05 … 09-28, 184,629 lines): 57 more groups
 *  folded, 55 fewer live duplicates, no false merge (tests/fixtures/replay-report-pf2.md). */
export const LARGE_EVENT_MAG = 5.5;
export const LARGE_EVENT_BASE_KM = 20;
export const LARGE_EVENT_KM_PER_MAG = 20;
export const LARGE_EVENT_MAX_KM = 50;
export const LARGE_EVENT_MAX_DELTA = 1.0;
/** Moderate-event identity (FEED-1). Agencies' solutions of one M4–5.5 quake scatter by 15–40 km too (GEOFON vs
 *  EMSC/USGS, KAGSR, NCS, BMKG, RéNaSS), and below M5.5 the windows above stop at 10 km, so on 2026-10-02 42 of the 58
 *  live M ≥ 4.5 events had another live event within 60 s and 50 km. When BOTH magnitudes are ≥ MODERATE_EVENT_MAG, a
 *  pair the windows above keep apart is still one event when all of these hold:
 *  - distance ≤ clamp(MODERATE_EVENT_BASE_KM + MODERATE_EVENT_KM_PER_MAG · (min(M) − MODERATE_EVENT_MAG),
 *    MODERATE_EVENT_BASE_KM, LARGE_EVENT_MAX_KM), shrunk by ΔM like the others (M4.0 → 20 km, M4.5 → 30, M5.0 → 40,
 *    M5.5 → 50; the cap is the alerts gateway's own fold window);
 *  - origin times ≤ MODERATE_EVENT_MAX_DT_MS apart and |ΔM| ≤ MODERATE_EVENT_MAX_DELTA;
 *  - no provider on both sides, none of MODERATE_EVENT_EXCLUDED_PROVIDERS on either (Earthquakes Canada's splits with
 *    ComCat are left alone: owner decision 2026-10-02), neither cell dense;
 *  - mutual best: at first sight the report goes to its best-scored such event only when no mergeable neighbour of
 *    that event scores better; in the merge pass every such pair ranks behind every pair the windows above accept.
 *  It applies at first sight only when the windows above find nothing, and in the merge pass (Resolver.whyNotMerged).
 *  Chosen by replaying the whole observation log (2026-07-05..10-04, 202,575 lines) against the rules before it, with
 *  slopes 10 / 20 / 30 per magnitude unit and bases 15 / 20 km: base 20 and slope 20 folded 138 of the 200 pairs of live
 *  M ≥ 4.5 events within 60 s and 50 km in the event map of 2026-09-24..10-04 (slope 10: 114, base 15: 123, slope 30:
 *  138 with 12 more folds to review) and took the share of live M ≥ 4.5 events of those days with such a sibling from
 *  69 % to 31 %. On the event map of 2026-10-04 the merge pass over the hot window folds 91 such pairs (every one
 *  ≤ 15.6 s and ≤ 43.7 km apart, |ΔM| ≤ 0.46). Excluded on purpose: KAGSR's magnitudes run 0.6–0.8 above the others'
 *  (|ΔM| > 0.5 keeps those pairs apart), PHIVOLCS's and JMA's minute-rounded times beyond 20 s, and the same provider
 *  under two ids (SSN, CSN). Known residual: EMSC re-points its own event id to another quake now and then (2026-09-07
 *  off Oregon, M5.3 → its M3.9 foreshock 24 s earlier); a GEOFON row the window had joined to EMSC's then goes along. */
export const MODERATE_EVENT_MAG = 4.0;
export const MODERATE_EVENT_BASE_KM = 20;
export const MODERATE_EVENT_KM_PER_MAG = 20;
export const MODERATE_EVENT_MAX_DT_MS = 20_000;
export const MODERATE_EVENT_MAX_DELTA = 0.5;
export const MODERATE_EVENT_EXCLUDED_PROVIDERS: ReadonlySet<string> = new Set(['nrcan']);
/** A provider re-publishing ONE solution under a second native id (INGV 46714321 / 47246702,
 *  2026-09-25) is a re-id, not a distinct event: rows this close fold instead of minting. */
export const REID_DT_MS = 2_000;
export const REID_KM = 2;
export const REID_MAG_DELTA = 0.1;
/** Floating-point slack on the REID_MAG_DELTA test (Resolver.sameSolution: |ΔM| ≤ REID_MAG_DELTA + REID_MAG_TOLERANCE).
 *  Magnitudes are published in 0.1 or 0.01 steps but held as binary floats, so a difference of exactly 0.1 lands on
 *  either side of 0.1: 1.5 − 1.4 = 0.10000000000000009 failed the bare `≤ 0.1` while 2.3 − 2.2 = 0.09999999999999964
 *  passed (PF-5g). 1e-9 is far above the rounding error of a difference of two magnitudes (about 1e-15) and far below
 *  any published magnitude step (0.01), so every pair 0.1 apart is now one solution and every pair 0.11 apart is not. */
export const REID_MAG_TOLERANCE = 1e-9;
/** Providers that publish a revised solution of a quake under a new native id and drop the old id from their list:
 *  two of their rows within REID_DT_MS and REID_KM are one quake whatever their magnitudes (Resolver.sameSolution
 *  skips its magnitude test for two rows of such a provider). Earthquakes Canada's id is the origin minute and a
 *  sequence number (20260720.0647001, Mw' 4.84; then 20260720.0647002, Mw' 4.73, same origin and place), and its list
 *  keeps the newest version only (on 2026-10-01: 46 of its 47 ids of the last 7 days end in 001). The feed sees no
 *  delete, so the older id stays beside the newer one. Until PF-5h every NRCan row was stored without a magnitude, which
 *  passed the magnitude test for every such pair (none and none), so the versions were one event; with magnitudes,
 *  replaying the whole observation log (2026-07-05..10-01: 44 version pairs within 2 s and 2 km, magnitudes up to 0.6
 *  apart) split 9 events in two. */
export const NEW_ID_PER_REVISION_PROVIDERS: ReadonlySet<string> = new Set(['nrcan']);
/** Bound on the post-revision merge chain one ingest may trigger (each round retires a node). */
export const MERGE_MAX_ROUNDS = 8;
/** A retired event (superseded by an op:merge, or tombstoned: an upstream delete, a provider's
 *  zeroed withdrawal or the feed's own retraction) stays published, compact and flagged
 *  non-live, for this long after its last ingest, so a poller that treats absence as "still
 *  there" sees the removal. Tombstones joined on 2026-09-28, once every consumer that reads the
 *  Pages files without the state filter was fixed (the alerts gateway's pages_url path). */
export const RETIRED_VISIBLE_MS = 48 * 3600_000;
/** The one-time heal (src/heal.ts). aggregate runs it once when the data branch's
 *  knowledge/index/heal.json holds a lower epoch (or none): the op:merge pass over every live
 *  node in the hot window (Resolver.heal) and the coordinate-less retraction over the whole
 *  event-map horizon, logged like any other change, then the marker records this epoch in the
 *  same commit. Bump it only to run a new heal on purpose. Epoch 1 (2026-09-28): events split under the pre-PF-1
 *  rules. Epoch 2 (PF-5f): EMSC's copies of IGN, NC and SCSN solutions count as the agency's identity since then
 *  (EMSC_AUTHORED_COPIES), and the ones minted beside the agency's event in a dense cell before (the Granada and The
 *  Geysers cells: 18 IGN and 2 NC pairs in the hot window on 2026-09-30) fold into it; nothing else changed, so the
 *  pass folds only what the current rules already call one event (on 2026-09-30 a heal under the old rules folded one
 *  group). PF-5g (2026-10-01: more EMSC codes in EMSC_AUTHORED_COPIES, REID_MAG_TOLERANCE) keeps epoch 2 on purpose:
 *  a heal under its rules folded 3 groups of the hot window on 2026-10-01 (one IPMA and two AFAD ids published twice,
 *  |ΔM| = 0.1), and a heal run loads the whole event-map horizon, where the sweeps' revisions reach frozen days. */
export const HEAL_EPOCH = 2;
/** The regular heal (FEED-6): every aggregate run that is not an epoch heal runs the same op:merge pass over every live
 *  event of the hot window (Resolver.heal, heal.ts runFeedSideSteps), so a rule change, or a pair a report's merge pass
 *  did not reach (a mint folds nothing; a moderate-event join waits for mutual best), folds on the next run instead of on
 *  a revision that may never come, and HEAL_EPOCH no longer needs a bump for a rule change: an epoch heal is only for a
 *  run that must load the whole event-map horizon (a parser re-read goes through CORRECTION_EPOCH). It is idempotent: a
 *  run whose reports changed nothing folds nothing. At most this many folds a run, so a rule that suddenly folds
 *  hundreds of events spreads them over several runs, each logged and reviewable, instead of rewriting the hot window
 *  in one commit; the rest fold in the next runs (status `heal_capped`). Measured 2026-10-04 on the event map of
 *  origin/data 47f0ed5696: the first run after FEED-1 folds 105 pairs (0.4 s with the coordinate-less retraction and the
 *  copy re-home pass); the next folds none (0.2 s). */
export const HEAL_MAX_FOLDS_PER_RUN = 100;
/** The one-time correction (src/correction.ts). aggregate runs it once when the data branch's
 *  knowledge/index/correction.json holds a lower epoch (or none), before the run's reports, over the days the manifest
 *  does not call frozen (event days from now − LIVE_INDEX_DAYS on; partitions.ts FROZEN_AFTER_DAYS), logged like any
 *  other change; the marker records this epoch in the same commit. Frozen days are never touched: the feed does not
 *  rewrite history. A run makes only the steps of the epochs above the marker's. Epoch 1 (2026-10-01): AFAD rows stored
 *  3 h early are read again with the fixed parser and re-timed (PF-5e), and NCEDC / SCEDC events standing beside
 *  ComCat's row of the same id are folded into it (PF-5d). Epoch 2 (PF-5h): NRCan rows stored without the magnitude,
 *  magnitude type and place their own fields carry (the FDSN text parser read NRCan's 8 columns at the standard
 *  positions) are read again with the fixed parser and filled. Bump it only to run a new correction on purpose, with
 *  that correction's code. */
export const CORRECTION_EPOCH = 2;
/** Only events within this many days are kept in the in-memory dedup index. */
export const HOT_WINDOW_DAYS = 7;
/** aggregate loads only this many days of event_map shards (fast hot path). */
export const LIVE_INDEX_DAYS = Number(process.env.LIVE_INDEX_DAYS ?? 10);
/** derive loads this many days (covers the 30-day month summary + revision tail);
 *  event_map shards older than this are pruned (their identity lives in frozen partitions). */
export const EVENT_MAP_HORIZON_DAYS = Number(process.env.EVENT_MAP_HORIZON_DAYS ?? 45);

// --- fetching ---
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 8000);
/** Backfill/onboarding tolerate slower nodes (hourly, not the 5-min hot path). */
export const BACKFILL_FETCH_TIMEOUT_MS = Number(process.env.BACKFILL_FETCH_TIMEOUT_MS ?? 20000);
/** Each run asks providers for events in [now - lookback, now]; dedup absorbs overlap. */
export const QUERY_LOOKBACK_MS = Number(process.env.QUERY_LOOKBACK_MS ?? 2 * 24 * 3600 * 1000);
/** Providers whose `updatedafter` revision sweep may mint (PF-5a, src/sweep.ts). ComCat publishes
 *  many events days after their origin, once analysts release them, past the live query's
 *  lookback: 184 of 693 M ≥ 2.5 events with origins 2026-09-10..20 never reached the feed (a
 *  sample of 21 had been published 2.1–16.8 days after origin), because the sweep, which does
 *  return them, only revised known events. An unknown sweep row of these providers is minted when
 *  its origin is inside the hot window (Resolver.reviseOrMintInHotWindow). */
export const LATE_MINT_PROVIDERS: ReadonlySet<string> = new Set(['usgs']);
/** The provider that reads ComCat, the USGS ANSS catalog (PF-5b). */
export const COMCAT_PROVIDER = 'usgs';
/** Providers whose native event id names the ComCat event id, with the ComCat catalog prefix that turns one into the
 *  other (util.ts comcatIdOf). AEC's `event_name` (`aka2026…`) IS the id ComCat gives the same event once AEC sends
 *  it there (PF-5b). NCEDC's and SCEDC's event ids are the NC and CI networks' own ids, which ComCat carries as
 *  `nc<id>` / `ci<id>` (PF-5d, 2026-10-01: NCEDC 75438707 is ComCat nc75438707, SCEDC 41341119 is ci41341119, the two
 *  rows identical to the millisecond and the metre). Identity with the `usgs` row is exact, whatever the distance
 *  between the two solutions and however dense the cell: a report of theirs names `usgs:<ComCat id>`
 *  (util.ts knownAliasIdsOf), a ComCat report finds their row through the ComCat ids it names, and a node whose
 *  ComCat row lists the id in `ids` claims it even when ComCat prefers another network's id (`us7000…`). Until
 *  PF-5d the NCEDC and SCEDC rows had no link to ComCat's: in a dense cell (The Geysers) a location join needs a
 *  shared id, so 286 NCEDC and 18 SCEDC events stood beside ComCat's copy in the 10 days to 2026-10-01. */
export const COMCAT_ID_PREFIX: ReadonlyMap<string, string> = new Map([
  ['aec', ''],
  ['ncedc', 'nc'],
  ['scedc', 'ci'],
]);
export const COMCAT_ID_PROVIDERS: ReadonlySet<string> = new Set(COMCAT_ID_PREFIX.keys());
/** The COMCAT_ID_PROVIDERS whose event list follows ComCat's lifecycle and is mostly automatic solutions (AEC,
 *  PF-5b). The node that holds such a report carries the alias `usgs:<its id>`; an unmatched report beside another
 *  agency's event is withheld (Resolver.lateTwin); a ComCat delete of the id withdraws their row as well, and a row
 *  of theirs withdrawn that way never comes back while the provider keeps listing the id; and a location join with
 *  another agency's event is held to LOCATION_JOIN_DT_MS / LOCATION_JOIN_MAX_DM. NCEDC and SCEDC are not in it:
 *  they publish their networks' own catalogues and withdraw an id themselves by zeroing it (Resolver.withdrawZeroed),
 *  so a ComCat delete leaves their row alone and a re-located id comes back as before. */
export const COMCAT_LIFECYCLE_PROVIDERS: ReadonlySet<string> = new Set(['aec']);
/** The origin-time and magnitude limits on a location join between a COMCAT_LIFECYCLE_PROVIDERS solution and an event
 *  that holds no row of that provider (Resolver.lifecycleLocationBlocks: first sight and the merge pass alike; exact-id
 *  joins are not affected). PF-5b review: AEC's automatic report joined by location to an AVO event 15 s away gave
 *  that node the alias of AEC's id, so ComCat's later event of the same id welded into it: two quakes shown as one
 *  where ComCat has two; and with a large magnitude gap an automatic M4.5 20 s / 2 km from a reviewed M1.5 was
 *  shown as M1.5 (the ΔM-shrunk windows still allow 3 km / 24 s). Measured 2026-10-01 over 16 days of Alaska: every
 *  same-quake AEC join was ≤ 3.4 s apart (373 exact-id joins ≤ 3.4 s and |ΔM| ≤ 0.2; 11 location joins ≤ 1.9 s and
 *  |ΔM| ≤ 1.25, AEC's automatic ML of small volcanic quakes running high against AVO's reviewed one), while the
 *  `ak` / `av` pairs ComCat keeps as distinct quakes are 13–55 s apart. An AEC report outside the limits is looked at
 *  by lateTwin like any unmatched AEC report (withheld beside a same-size event, else minted). The limits hold only
 *  while the AEC row stands without ComCat's row of its id: once ComCat's row is in the same event (an exact-id join),
 *  that event joins other agencies' reports by the usual rules again, as before AEC was a source (review of PF-5b's
 *  fix: an automatic solution must not keep splitting a quake ComCat has confirmed). */
export const LOCATION_JOIN_DT_MS = 8_000;
export const LOCATION_JOIN_MAX_DM = 1.5;
/** EMSC `auth` codes whose EMSC copy is that feed provider's own solution: EMSC re-publishes the authoring agency's
 *  origin, rounded (2026-09-30: AFAD 730046 at 19:19:18, 38.46667 / 39.21483, ML 0.9 is EMSC 20260930_0000241 at
 *  19:19:18Z, 38.4667 / 39.2148, ml 0.9, auth AFAD). An EMSC row with one of these codes and the same solution
 *  (Resolver.sameSolution: ±2 s, 2 km, |ΔM| ≤ 0.1) as a row of the mapped provider shares that row's identity, the
 *  evidence a dense cell asks for before a location join (PF-5e: without it AFAD's report and EMSC's copy stay two
 *  events in the Sındırgı cell). For a provider with a ComCat network prefix (COMCAT_ID_PREFIX: NCEDC `nc`, SCEDC
 *  `ci`) ComCat's row of that network (`nc75441981`) is the same network's solution and counts as well
 *  (Resolver.authorsRow). Add a code only after checking that EMSC copies the agency's origin unchanged.
 *
 *  Checked 2026-10-01 over the observation log (2026-07-05..09-30) and the live services (PF-5f):
 *  - NC (NCEDC, ComCat `nc`): all 368 copies have the time (to 0.01 s) and place (to EMSC's 4 decimals) of ComCat's
 *    `nc` row, 340 also its magnitude (to EMSC's 0.1), type and depth. The other 28 carry a magnitude ComCat never
 *    had (its first NC origin of nc75407577 and nc75444342 already said 4.24 and 2.51 where EMSC says 3.4 and 2.1):
 *    |ΔM| > 0.1, so they stay unlinked. ComCat's row matters: NCEDC's text service truncates the magnitude
 *    (1.27 → "1.2") where EMSC rounds (1.3), so the NCEDC row alone is 0.1 off in 150 of the 368.
 *  - SCSN (SCEDC, ComCat `ci`): 269 of 317 copies equal a ComCat revision in time, place, magnitude, type and depth.
 *    The other 48 copy CI's first automatic origin, which CI replaced before the feed first read ComCat's row;
 *    ComCat's superseded versions show it for ci40661098 and ci40662378 (EMSC's copy is CI's first origin to the
 *    0.01 s, the fourth decimal and the rounded magnitude).
 *  - IGN: 1,125 of the 1,166 copies that match an IGN row have its place to the fourth decimal and its magnitude
 *    value, a time 0–0.99 s after IGN's (the IGN file cuts the seconds' fraction off) and a depth that IGN's file
 *    rounds to whole km; EMSC labels IGN's mbLg `ml` and IGN's M(mb) `mb`, the values unchanged. In the rest IGN's
 *    row has moved since (a revision); where it moved beyond sameSolution the copy stays unlinked.
 *  Live check 2026-09-30 22:55 UTC, copies of the last 3 days: NC 13 of 14 and SCSN 4 of 5 equal the agency's row in
 *  the same way (the other two: a magnitude the agency revised after EMSC copied it); IGN 25 of 28 (one relocated by
 *  IGN, one 0.1 apart in magnitude, one no longer in IGN's file). No copy was the same solution of two different
 *  events: the only rows one could pair with twice were one agency solution published under two ids (IGN
 *  es2026nowua / es2026nowub; CI 40670850 / 40670858), which sameSolution already treats as one.
 *
 *  Checked 2026-10-01 for every other `auth` code of an agency the feed reads itself (PF-5g), over every version of
 *  each row the feed holds: the observation log (2026-07-05..10-01) and the event map's current rows (event days
 *  08-17..10-01, which also hold the revisions of a row that did not move its event; the log has no line for those).
 *  The bar is the one the four codes above meet on the same data: at least 50 copies beside an agency row; at least
 *  90 % equal to a version of the agency's solution in time (≤ 1 s) and place (to the coarser of the two precisions),
 *  at least 85 % in magnitude too (AFAD 94 / 92 %, IGN 100 / 96, NC 100 / 93, SCSN 91 / 88); no copy within
 *  sameSolution of two distinct agency events, and none linked to an agency event other than the one it equals.
 *  Copies beside an agency row, equal in time and place / and in magnitude:
 *  - CENC (cenc) 168: 100 / 95 %. CSN (csn) 2,660: 99.6 / 98.3 % (EMSC rounds CSN's place to 2 decimals and follows
 *    CSN's revisions). INGV (ingv) 321: 99.7 / 98.1 %. KOERI (koeri) 285: 99.3 / 95.8 % (KOERI's list cuts the
 *    seconds' fraction off; where KOERI also gives Mw the feed's row carries the Mw while EMSC copies KOERI's ML).
 *    NDI (ncs, India) 448: 95.5 / 91.1 %. QUI (igepn) 53: 98.1 / 96.2 %. UNA (ovsicori) 575: 99.8 / 96.2 %. UNM
 *    (mexico, SSN) 2,409: 100 / 99.3 %.
 *  - GNS (geonet) 423: 80 / 74 % against the rows the feed holds, and every one of the other 111 is an earlier GeoNet
 *    origin of the same event to the 0.01 s, the fourth decimal and the rounded magnitude (GeoNet's quake history,
 *    api.geonet.org.nz/quake/history), as SCSN's are CI's superseded origins. EMSC copies GeoNet's origin of the moment
 *    and seldom follows a revision, so a copy links only while GeoNet's row is within sameSolution of that origin.
 *  - Not added: GFZ (geofon) 91.6 / 84.4 %; ReNaSS (renass, resif) 86.8 / 85.1 %; ETHZ 79.7 %, NOA 74.9 %, IMO
 *    72.0 %; BMKG (bmkg) 14.7 % of the 197 copies beside a BMKG row (BMKG's public lists carry another solution);
 *    PIVS (phivolcs) 4.7 % and JMA (jma) 0 % (both lists give the origin to the minute); GSRAS (kagsr) 1.7 % (another
 *    agency than KAGSR); CN (nrcan) equal in time and place, but the feed's NRCan rows carry no magnitude, so no copy
 *    could link; fewer than 50 copies beside an agency row: IPMA, LIM (igp), AUST (ga), CWA, OVSG and OVSM (ipgp),
 *    BGS, USP, KNMI, AK (aec, read since 2026-09-30). The US networks EMSC names (NEIC, PR, HV, TX, …) reach the feed
 *    only through ComCat, whose rows authorsRow maps to a network only for NC and SCSN.
 *  None of these 29 codes had a copy within sameSolution of two distinct agency events or linked to the wrong one. EMSC
 *  does point an event id at another agency event later now and then (over the versions the feed holds: CSN 27, IGN 18,
 *  UNA 6, AFAD 3, GNS 1, some of them an agency's own duplicate ids): the row stays in the event it joined, and the
 *  agency's two ids keep the two events apart (nodesDistinct; OVSICORI 1449691 / 1449690 in the PF-5g test). Live
 *  check 2026-10-01 00:30 UTC, copies of the last 2 days: CENC 5 of 5, CSN 24 of 24, INGV 7 of 7, NDI 10 of 10 (one
 *  more not in NCS's list), QUI 1 of 1, UNM 12 of 12 and UNA 4 of 5 (one relocated by OVSICORI) equal the agency's row;
 *  GNS 8 of 8 are a GeoNet origin (2 the current one, 6 earlier ones); EMSC held no KOERI copy, having replaced all 11
 *  of those 2 days with its own solution (as it does with most of them later: a replaced copy is EMSC's own solution
 *  again and no longer counts). */
export const EMSC_PROVIDER = 'emsc';
export const EMSC_AUTHORED_COPIES: ReadonlyMap<string, string> = new Map([
  ['AFAD', 'afad'],
  ['CENC', 'cenc'],
  ['CSN', 'csn'],
  ['GNS', 'geonet'],
  ['IGN', 'ign'],
  ['INGV', 'ingv'],
  ['KOERI', 'koeri'],
  ['NC', 'ncedc'],
  ['NDI', 'ncs'],
  ['QUI', 'igepn'],
  ['SCSN', 'scedc'],
  ['UNA', 'ovsicori'],
  ['UNM', 'mexico'],
]);
/** EMSC `auth` codes of the US networks the feed reads only through ComCat (FEED-4), each with that network's ComCat id
 *  prefix: an EMSC row with one of these codes and the same solution (Resolver.sameSolution) as ComCat's row whose own
 *  id has the prefix shares that row's identity, as an EMSC_AUTHORED_COPIES copy does with its agency's row
 *  (Resolver.authoredCopy). EMSC re-publishes the network's origin rounded: 2026-10-03, EMSC 20261003_0000049 (auth HV)
 *  is 04:01:12.66Z, 19.4118 / -155.2803, depth -0.5, ml 2.0, and ComCat hv75048812 is 04:01:12.66Z,
 *  19.4118328 / -155.2803347, depth -0.54, ml 2.04; in the dense Kilauea cell the two stood as two events, because a
 *  location join there needs a shared id. ComCat's row of another network (`us…` for an HV quake) is another solution
 *  and does not count.
 *
 *  Checked 2026-10-04 over every version of each row in the observation log (2026-07-05..10-04): EMSC versions with the
 *  code beside a ComCat row of the network (within 60 s and 50 km), how many equal a version of that row in time
 *  (≤ 1 s) and place (≤ 1 km), and how many in magnitude too (|ΔM| ≤ 0.1):
 *  HV 654: 99.8 / 98.6 %. PR 704: 100 / 99.3 %. AK 604: 99.3 / 98.8 %. TX 533: 99.1 / 95.7 %. NN 117: 100 / 100 %.
 *  UU 101: 100 / 98.0 %. UW 74: 100 / 98.6 %. OK 35: 100 / 97.1 %. MB 11: 100 / 100 % (OK and MB below the 50 copies
 *  the codes above were held to, kept because every copy is the network's ComCat row).
 *  No copy is within sameSolution of two distinct ComCat events except TX's: 20 versions match two TexNet ids that are
 *  one solution published twice (tx2026nbcmeq / tx2026nbcmvr, 22 ms and 1 km apart, both M2.3), which sameSolution
 *  already treats as one. In the event map's live events of 2026-09-24..10-04 the copies stood beside their ComCat row
 *  as a separate event 10 times for HV and twice for TX (all in dense cells), and joined it everywhere else.
 *  Not added: NEIC (`us`, 2,076 versions: 99.9 / 93.0 %, one separate event in those 11 days), AV, SE, NM (fewer than
 *  30 versions each). */
export const EMSC_COMCAT_NETWORK_COPIES: ReadonlyMap<string, string> = new Map([
  ['AK', 'ak'],
  ['HV', 'hv'],
  ['MB', 'mb'],
  ['NN', 'nn'],
  ['OK', 'ok'],
  ['PR', 'pr'],
  ['TX', 'tx'],
  ['UU', 'uu'],
  ['UW', 'uw'],
]);
/** Rolling-file sources whose ids are watched for disappearing (PF-5b, log only): a row younger than
 *  ABSENCE_WATCH_DAYS that the feed holds and a complete file no longer lists is counted in status `absent`. AEC's
 *  file spans ~14 days, so a younger id that vanishes was most likely deleted upstream; whether to retract on absence
 *  is decided after a week of these counts. 10 days, the event map's default load (LIVE_INDEX_DAYS), because AEC
 *  deletes late: of the 22 `ak` events ComCat deleted from 2026-09-15 to 09-30, 10 went 5.5 to 9.5 days after origin
 *  (AEC's analyst review runs about 8 to 9 days behind), which a 5-day watch never saw. Still well inside the file's
 *  span (its oldest rows were 14.5 to 15.8 days old on 2026-09-30), so a row aging out is never counted.
 *  Mexico (FEED-5, 2026-10-04): SSN's RSS lists only its last 15 items (about half a day), and a preliminary item
 *  leaves it when the reviewed one arrives; only ids younger than the oldest item listed are counted
 *  (ABSENCE_LAST_ITEMS_PROVIDERS), so an item that merely aged out is never counted. */
export const ABSENCE_WATCH_PROVIDERS: readonly string[] = ['aec', 'mexico'];
/** Watched sources whose file is their last N items rather than a time span (absence.ts). */
export const ABSENCE_LAST_ITEMS_PROVIDERS: ReadonlySet<string> = new Set(['mexico']);
export const ABSENCE_WATCH_DAYS = 10;
export const FETCH_LIMIT = Number(process.env.FETCH_LIMIT ?? 5000);

// --- sweeps (src/sweep-cursor.ts, PF-5c) ---
/** Sources whose `updatedafter` revision sweep runs every aggregate: the two FDSN nodes whose rows
 *  carry an update stamp (ComCat `updated`, EMSC `lastupdate`). */
export const UPDATED_SWEEP_PROVIDERS: readonly string[] = ['usgs', 'emsc'];
/** Sources whose `includedeleted=only` delete sweep runs every aggregate. */
export const DELETE_SWEEP_PROVIDERS: readonly string[] = ['usgs'];
/** One sweep's time budget, every page included (each page's timeout is what is left of it).
 *  Measured 2026-09-30: the 7-day catch-up is one page per source (ComCat 2,337 rows in 2.0 s,
 *  EMSC 3,064 rows in 3.4 s), a normal 5-minute sweep returns tens of rows in about a second,
 *  and a cold name lookup on the runner takes up to 3.1 s with UV_THREADPOOL_SIZE=64: 30 s is
 *  about ten times the largest page. The sweeps run alongside the live fetches, which already
 *  take 12–17 s (median) and up to a minute when a custom adapter retries, so a run whose sweeps
 *  use the whole budget keeps the Aggregate step near 40 s and the job (about 100 s, most of it
 *  the data checkout) far inside its 5-minute timeout and the heartbeat's 5-minute interval.
 *  The live FDSN fetches keep FETCH_TIMEOUT_MS (or the source's own timeoutMs). */
export const SWEEP_TIMEOUT_MS = Number(process.env.SWEEP_TIMEOUT_MS ?? 30_000);
/** A sweep asks from this long before its cursor: an update can reach the provider's search index
 *  after the moment it is stamped with, and the runner's clock is not the provider's. Rows seen
 *  twice change nothing (an unchanged re-report is a no-op). */
export const SWEEP_OVERLAP_MS = 10 * 60_000;
/** Consecutive pages of one sweep overlap by this many records, so an event that leaves the
 *  result set between two page requests (an upstream delete) cannot push a row past both pages. */
export const SWEEP_PAGE_OVERLAP = 100;
/** At most this many pages per sweep and run (8 × FETCH_LIMIT = 40,000 rows, far above the ~2,300
 *  (ComCat) and ~3,100 (EMSC) of a 7-day window); a sweep that needs more stays unfinished. */
export const SWEEP_MAX_PAGES = 8;
/** The one-time sweep catch-up. A sweep whose cursor is absent or carries a lower epoch asks from
 *  now − HOT_WINDOW_DAYS instead of from its cursor, once; its first complete sweep records this
 *  epoch with the cursor (knowledge/index/sweeps.json), so the catch-up does not repeat. Epoch 1
 *  (2026-09-30): the sweeps had aborted in almost every run since they were added (PF-5c), and the
 *  live rows had moved the shared watermark past every failed window; the 7-day catch-up held 191
 *  revisions, 66 late events and 14 upstream deletes. Bump it only to run a new catch-up. */
export const SWEEP_EPOCH = 1;

// --- derived views ---
export const MAX_PUBLISHED_BYTES = 18 * 1024 * 1024;
export const SUMMARY_WINDOWS: Record<string, number> = {
  hour: 3600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};
/** null threshold = "all". */
export const SUMMARY_THRESHOLDS: Record<string, number | null> = {
  all: null,
  '1.0': 1.0,
  '2.5': 2.5,
  '4.5': 4.5,
  significant: 4.5,
};

export function dataPaths(root = DATA_DIR) {
  return {
    root,
    observationsDir: join(root, 'knowledge', 'observations'),
    snapshotsDir: join(root, 'knowledge', 'snapshots'),
    indexDir: join(root, 'knowledge', 'index'),
    head: join(root, 'knowledge', 'index', 'head.json'),
    eventMapDir: join(root, 'knowledge', 'index', 'event_map'),
    eventMapLegacy: join(root, 'knowledge', 'index', 'event_map.ndjson'),
    watermarks: join(root, 'knowledge', 'index', 'watermarks.json'),
    backfillCursor: join(root, 'knowledge', 'index', 'backfill.json'),
    onboardCursor: join(root, 'knowledge', 'index', 'onboard.json'),
    healMarker: join(root, 'knowledge', 'index', 'heal.json'),
    correctionMarker: join(root, 'knowledge', 'index', 'correction.json'),
    sweepCursors: join(root, 'knowledge', 'index', 'sweeps.json'),
    archivesIndex: join(root, 'knowledge', 'index', 'archives.json'),
    partitionsIndex: join(root, 'knowledge', 'index', 'partitions.json'),
    providerHealth: join(root, 'knowledge', 'index', 'provider_health.json'),
    providerActivity: join(root, 'knowledge', 'index', 'provider_activity.json'),
    changesCursor: join(root, 'knowledge', 'index', 'changes.json'),
    changesDir: join(root, 'changes'),
    eventsDir: join(root, 'events'),
    feedDir: join(root, 'v1'),
    manifest: join(root, 'manifest.json'),
    status: join(root, 'status.json'),
    statusHistoryDir: join(root, 'status', 'history'),
  };
}
