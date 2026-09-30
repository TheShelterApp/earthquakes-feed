import {
  COMCAT_ID_PROVIDERS,
  COMCAT_PROVIDER,
  GRID_CELL_DEG,
  HOT_WINDOW_DAYS,
  LARGE_EVENT_BASE_KM,
  LARGE_EVENT_KM_PER_MAG,
  LARGE_EVENT_MAG,
  LARGE_EVENT_MAX_DELTA,
  LARGE_EVENT_MAX_KM,
  MAG_MERGE_MAX_DELTA,
  MERGE_MAX_ROUNDS,
  REID_DT_MS,
  REID_KM,
  REID_MAG_DELTA,
  SPATIAL_KM,
  SWARM_CELL_ABSOLUTE,
  TEMPORAL_MS,
} from './config.js';
import { qualityCount } from './canonical.js';
import { gatherCellKeys, gridKey, haversineKm } from './geo.js';
import { isCoordinateless } from './quality.js';
import type { EventNode, ProvenanceRow, ProviderConfig, RawObs } from './types.js';
import { deterministicFeedId } from './ulid.js';
import { knownAliasIdsOf, statusRank } from './util.js';

const REVIEWED_DT_HARD_MS = 30_000;
/** How far lateTwin looks for the event a late report duplicates: the widest identity window. */
const LATE_TWIN_KM = LARGE_EVENT_MAX_KM;
/** Bound on Resolver.heal's passes over the hot window (each pass after the first only picks up
 *  pairs whose mutual best formed during the previous one). */
const HEAL_MAX_PASSES = 4;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** The ComCat ids a report or row names when it comes from ComCat itself: its own id and every id in its `ids`
 *  (`us7000abc` with ids ",us7000abc,aka2026xyz," names both). Empty for any other provider. */
function comcatIdsNamed(provider: string, nativeId: string, fields: Record<string, unknown> | null | undefined): string[] {
  if (provider !== COMCAT_PROVIDER) return [];
  const prefix = `${COMCAT_PROVIDER}:`;
  return [nativeId, ...knownAliasIdsOf(provider, nativeId, fields).map((k) => k.slice(prefix.length))];
}

/** A stored provenance row as the report it was: what an op:tombstone line records for a withdrawn row, and what a
 *  replay feeds back to tombstoneProvider. */
function rowAsReport(row: ProvenanceRow): RawObs {
  return {
    provider: row.provider,
    providerEventId: row.nativeId,
    eventTimeMs: row.eventTimeMs,
    providerUpdatedMs: row.providerUpdatedMs,
    status: row.status,
    lat: row.lat,
    lon: row.lon,
    depth: row.depth,
    mag: row.mag,
    magType: row.magType,
    place: row.place,
    knownAliasIds: knownAliasIdsOf(row.provider, row.nativeId, row.fields),
    fields: row.fields,
  };
}

function richness(r: ProvenanceRow): number {
  let n = 0;
  if (r.mag != null) n++;
  if (r.magType != null) n++;
  n += qualityCount(r.fields);
  return n;
}

/** What the proximity gates read: a fresh report (first sight) or a node's chosen solution
 *  (the merge pass). RawObs, EventNode and ProvenanceRow all have this shape. */
interface Solution {
  eventTimeMs: number;
  lat: number;
  lon: number;
  mag: number | null;
  status: string | null;
}

/** One op:merge — `loser` folded into `survivor` because of `reason`. */
export interface MergeRecord {
  survivor: EventNode;
  loser: EventNode;
  reason: string;
}

export interface IngestResult {
  /** The node the report lives in — after any merge this is the final survivor. */
  node: EventNode;
  changed: boolean;
  revision: number;
  /** Post-revision folds this ingest caused (one op:merge line each), oldest first. */
  merges: MergeRecord[];
  /** Set when a COMCAT_ID_PROVIDERS report was not minted because another agency's live event sits beside it
   *  (Resolver.ingest, PF-5b); `node` is that event, `changed` false. */
  withheld?: { km: number; dtMs: number };
}

/** What reviseOrMintInHotWindow did with one sweep row of a late-publishing catalog. */
export type LateSweepOutcome =
  | { kind: 'revised' | 'minted'; result: IngestResult }
  /** Unknown, inside the hot window, and beside another provider's live event: not minted. */
  | { kind: 'withheld'; near: EventNode; km: number; dtMs: number }
  /** Unknown and below the hot floor (plus one identity window): not minted. */
  | { kind: 'skipped' };

export class Resolver {
  private readonly alias = new Map<string, string>();
  private readonly geo = new Map<string, Set<string>>();
  private readonly hotFloor: number;
  private readonly mergePass: boolean;
  /** Provider keys of tombstoned nodes (the alias map holds live nodes only), so a COMCAT_ID_PROVIDERS report of an
   *  id ComCat deleted is recognised in later runs too (retiredComcatNode). */
  private readonly retired = new Map<string, string>();
  /** ComCat id → the live node whose ComCat row names it (comcatIdsNamed), built on first use: a
   *  COMCAT_ID_PROVIDERS report resolves through it when ComCat prefers another network's id (PF-5b). */
  private comcatIndex: Map<string, string> | null = null;

  constructor(
    readonly eventMap: Map<string, EventNode>,
    private readonly priority: Map<string, number>,
    private readonly cfg: Map<string, ProviderConfig>,
    nowMs: number,
    opts: { hotFloorMs?: number; merge?: boolean } = {},
  ) {
    // Backfill passes hotFloorMs=0 to index events by event-time window (not wall-clock
    // recency), so historical reports dedup against the transient partition index (C2).
    this.hotFloor = opts.hotFloorMs ?? nowMs - HOT_WINDOW_DAYS * 86_400_000;
    // Backfill and onboard pass merge=false: they never append to the observation log, so a
    // fold there would retire a published event with no op:merge line (and, on a run that
    // appended nothing, no change-log line either). Folds happen only on aggregate's logged
    // path; a duplicate those paths leave heals on its next logged revision (hot window only).
    this.mergePass = opts.merge ?? true;
    for (const node of eventMap.values()) {
      if (node.state === 'live') {
        this.alias.set(`${node.chosenProvider}:${node.provenance.find((r) => r.chosen)?.nativeId ?? ''}`, node.feedId);
        for (const a of node.aliases) this.alias.set(a, node.feedId);
        if (node.eventTimeMs >= this.hotFloor) this.indexGeo(node);
      } else if (node.state === 'tombstoned') {
        for (const a of node.aliases) this.retired.set(a, node.feedId);
      }
    }
  }

  private indexGeo(node: EventNode): void {
    let set = this.geo.get(node.geohash);
    if (!set) this.geo.set(node.geohash, (set = new Set()));
    set.add(node.feedId);
  }

  private deindexGeo(hash: string, feedId: string): void {
    this.geo.get(hash)?.delete(feedId);
  }

  private isDense(lat: number, lon: number): boolean {
    return (this.geo.get(gridKey(lat, lon, GRID_CELL_DEG))?.size ?? 0) >= SWARM_CELL_ABSOLUTE;
  }

  /** Id-level linkage ONLY (design §8.4): in a dense cell the sole trustworthy evidence
   *  that two reports are one event is a shared identifier — never bare provider equality. */
  private sharesIdentity(raw: RawObs, node: EventNode): boolean {
    return raw.knownAliasIds.some((a) => node.aliases.includes(a));
  }

  /** Node-to-node form of sharesIdentity: one node's own report names the other's id (USGS `ids`). */
  private static nodesShareIdentity(a: EventNode, b: EventNode): boolean {
    const named = (n: EventNode): string[] => n.provenance.flatMap((r) => knownAliasIdsOf(r.provider, r.nativeId, r.fields));
    return named(a).some((k) => b.aliases.includes(k)) || named(b).some((k) => a.aliases.includes(k));
  }

  /** One solution re-published under a second native id (INGV 46714321 / 47246702 on
   *  2026-09-25: byte-identical origin, depth and magnitude): the same event, not a distinct one. */
  private static sameSolution(a: Solution, b: Solution): boolean {
    if (Math.abs(a.eventTimeMs - b.eventTimeMs) > REID_DT_MS) return false;
    if (haversineKm(a.lat, a.lon, b.lat, b.lon) > REID_KM) return false;
    if (a.mag == null || b.mag == null) return a.mag == null && b.mag == null;
    return Math.abs(a.mag - b.mag) <= REID_MAG_DELTA;
  }

  /** A provider re-reporting the SAME event resolves via alias; the same provider using a
   *  DIFFERENT native id means its pipeline considers these distinct events — never merge —
   *  unless the provider itself links the two ids (USGS `ids`, read from either side: the
   *  report's own list, or a node row that names the report) or the two rows are one solution
   *  under two ids (sameSolution). */
  private sameProviderDistinct(raw: RawObs, node: EventNode): boolean {
    const key = `${raw.provider}:${raw.providerEventId}`;
    return node.provenance.some(
      (r) =>
        r.provider === raw.provider &&
        r.nativeId !== raw.providerEventId &&
        !raw.knownAliasIds.includes(`${r.provider}:${r.nativeId}`) &&
        !knownAliasIdsOf(r.provider, r.nativeId, r.fields).includes(key) &&
        !Resolver.sameSolution(r, raw),
    );
  }

  /** Node-to-node form of sameProviderDistinct: a provider present in both nodes under
   *  different native ids blocks the fold, unless its own `ids` link them or the two rows
   *  are one re-published solution. */
  private static nodesDistinct(a: EventNode, b: EventNode): boolean {
    for (const ra of a.provenance) {
      const linked = knownAliasIdsOf(ra.provider, ra.nativeId, ra.fields);
      for (const rb of b.provenance) {
        if (rb.provider !== ra.provider || rb.nativeId === ra.nativeId) continue;
        if (linked.includes(`${rb.provider}:${rb.nativeId}`)) continue;
        if (knownAliasIdsOf(rb.provider, rb.nativeId, rb.fields).includes(`${ra.provider}:${ra.nativeId}`)) continue;
        if (Resolver.sameSolution(ra, rb)) continue;
        return true;
      }
    }
    return false;
  }

  /** ±60 s / ±10 km, shrunk by the magnitude difference. When BOTH solutions are large the
   *  spatial base first widens with the smaller magnitude (config LARGE_EVENT_*): agencies'
   *  preliminary epicentres of one M6–7 quake scatter by tens of km. */
  private windows(a: Solution, b: Solution, dense: boolean): { km: number; ms: number; widened: boolean } {
    let km = SPATIAL_KM;
    let ms = TEMPORAL_MS;
    let widened = false;
    if (a.mag != null && b.mag != null) {
      if (a.mag >= LARGE_EVENT_MAG && b.mag >= LARGE_EVENT_MAG) {
        widened = true;
        km = Resolver.largeEventKm(Math.min(a.mag, b.mag));
      }
      const dM = Math.abs(a.mag - b.mag);
      km *= clamp(1 - 0.3 * dM, 0.3, 1);
      ms *= clamp(1 - 0.25 * dM, 0.4, 1);
    }
    if (dense) {
      km = Math.min(km, 3);
      ms = Math.min(ms, 20_000);
    }
    return { km, ms, widened };
  }

  /** The widest spatial window `s` can get against any neighbour — the candidate gather radius. */
  private static maxWindowKm(s: Solution): number {
    if (s.mag == null || s.mag < LARGE_EVENT_MAG) return SPATIAL_KM;
    return Resolver.largeEventKm(s.mag);
  }

  /** The widened spatial base for a pair whose smaller magnitude is `minMag` (≥ LARGE_EVENT_MAG). */
  private static largeEventKm(minMag: number): number {
    return clamp(LARGE_EVENT_BASE_KM + LARGE_EVENT_KM_PER_MAG * (minMag - LARGE_EVENT_MAG), LARGE_EVENT_BASE_KM, LARGE_EVENT_MAX_KM);
  }

  private magGuardBlocks(a: Solution, b: Solution): boolean {
    if (statusRank(a.status) >= 3 && statusRank(b.status) >= 3) {
      if (a.mag != null && b.mag != null && Math.abs(a.mag - b.mag) > MAG_MERGE_MAX_DELTA) return true;
      if (Math.abs(a.eventTimeMs - b.eventTimeMs) > REVIEWED_DT_HARD_MS) return true;
    }
    return false;
  }

  /** The proximity gates shared by first-sight matching and the merge pass: null when `a`
   *  and `b` are one event, else the gate that says otherwise (the replay report's wording). */
  private reject(a: Solution, b: Solution, d: number, dense: boolean): string | null {
    const { km, ms, widened } = this.windows(a, b, dense);
    const dt = Math.abs(a.eventTimeMs - b.eventTimeMs);
    if (dt > ms) return `dt ${(dt / 1000).toFixed(1)} s > ${(ms / 1000).toFixed(1)} s`;
    if (d > km) return `d ${d.toFixed(1)} km > ${km.toFixed(1)} km${widened ? ' (widened)' : ''}`;
    if (widened && Math.abs(a.mag! - b.mag!) > LARGE_EVENT_MAX_DELTA) {
      return `dM ${Math.abs(a.mag! - b.mag!).toFixed(2)} > ${LARGE_EVENT_MAX_DELTA} on the widened window`;
    }
    if (this.magGuardBlocks(a, b)) return 'reviewed-vs-reviewed mag/time guard';
    return null;
  }

  /** Live feed ids in every grid cell the widest window of `s` can reach. */
  private candidates(s: Solution): Set<string> {
    const cand = new Set<string>();
    for (const cell of gatherCellKeys(s.lat, s.lon, Resolver.maxWindowKm(s), GRID_CELL_DEG)) {
      const set = this.geo.get(cell);
      if (set) for (const fid of set) cand.add(fid);
    }
    return cand;
  }

  /** Resolve to an existing feed_id (alias → cross-alias → spatial), or null. Never mints. */
  private findExisting(raw: RawObs): string | null {
    return this.findById(raw) ?? this.findNear(raw);
  }

  /** The id half of findExisting: the report's own alias, then the ids it names (USGS `ids`, the ComCat id of a
   *  COMCAT_ID_PROVIDERS report), then, for such a report, the live node whose ComCat row lists its id. */
  private findById(raw: RawObs): string | null {
    const key = `${raw.provider}:${raw.providerEventId}`;
    const hit = this.alias.get(key);
    if (hit) return hit;
    for (const alt of raw.knownAliasIds) {
      const h = this.alias.get(alt);
      if (h) {
        this.alias.set(key, h);
        return h;
      }
    }
    if (COMCAT_ID_PROVIDERS.has(raw.provider)) {
      const lister = this.comcatListing(raw.providerEventId);
      if (lister) {
        this.alias.set(key, lister.feedId);
        return lister.feedId;
      }
    }
    return null;
  }

  /** The spatial half of findExisting (hot window only). */
  private findNear(raw: RawObs): string | null {
    const key = `${raw.provider}:${raw.providerEventId}`;
    if (raw.eventTimeMs >= this.hotFloor) {
      const dense = this.isDense(raw.lat, raw.lon);
      let best: string | null = null;
      let bestKm = Infinity;
      for (const fid of this.candidates(raw)) {
        const node = this.eventMap.get(fid);
        if (!node || node.state !== 'live') continue;
        const d = haversineKm(raw.lat, raw.lon, node.lat, node.lon);
        if (this.reject(raw, node, d, dense)) continue;
        if (this.sameProviderDistinct(raw, node)) continue;
        if (dense && !this.sharesIdentity(raw, node)) continue;
        if (d < bestKm) {
          bestKm = d;
          best = fid;
        }
      }
      if (best) {
        this.alias.set(key, best);
        return best;
      }
    }
    return null;
  }

  /** The ComCat index (comcatIndex), built from every live node on first use. */
  private comcat(): Map<string, string> {
    if (!this.comcatIndex) {
      this.comcatIndex = new Map();
      for (const node of this.eventMap.values()) {
        if (node.state !== 'live') continue;
        for (const r of node.provenance) for (const id of comcatIdsNamed(r.provider, r.nativeId, r.fields)) this.comcatIndex.set(id, node.feedId);
      }
    }
    return this.comcatIndex;
  }

  /** The live node whose ComCat row names `id` (its own id or one in `ids`), or undefined. The index can lag a row
   *  whose `ids` changed, so the hit is checked against the node's rows. */
  private comcatListing(id: string): EventNode | undefined {
    const fid = this.comcat().get(id);
    const node = fid ? this.resolveLive(fid) : undefined;
    if (!node || node.state !== 'live') return undefined;
    return node.provenance.some((r) => comcatIdsNamed(r.provider, r.nativeId, r.fields).includes(id)) ? node : undefined;
  }

  /** The tombstoned node a COMCAT_ID_PROVIDERS report belongs to when nothing live claims it by id: its own id, or
   *  the ComCat id it names, retired with a node (ComCat deleted the event, and withdrawComcatTwins withdrew the
   *  report's row with it). Such a report is not ingested: the provider still listing a deleted id must not bring
   *  the event back, neither into the tombstoned node nor as a new one beside the other agencies' copies. */
  private retiredComcatNode(raw: RawObs): EventNode | undefined {
    if (!COMCAT_ID_PROVIDERS.has(raw.provider)) return undefined;
    for (const k of [`${raw.provider}:${raw.providerEventId}`, `${COMCAT_PROVIDER}:${raw.providerEventId}`]) {
      const node = this.eventMap.get(this.retired.get(k) ?? '');
      if (node?.state === 'tombstoned') return node;
    }
    return undefined;
  }

  /** A COMCAT_ID_PROVIDERS report `node` must not take: the node is tombstoned (ComCat deleted the event), or it
   *  held this very report once and lost it to a ComCat delete (withdrawComcatTwins; no other path withdraws such a
   *  row), while other agencies keep the node live. */
  private static withdrawnFrom(node: EventNode, raw: RawObs): boolean {
    if (node.state === 'tombstoned') return true;
    const key = `${raw.provider}:${raw.providerEventId}`;
    return node.aliases.includes(key) && !node.provenance.some((r) => r.provider === raw.provider && r.nativeId === raw.providerEventId);
  }

  /** A fresh feed id for a report findExisting could not place, registered under its alias. */
  private mintId(raw: RawObs): string {
    let fid = deterministicFeedId(raw.eventTimeMs, raw.lat, raw.lon);
    for (let salt = 1; this.eventMap.has(fid); salt++) {
      fid = deterministicFeedId(raw.eventTimeMs, raw.lat, raw.lon, salt);
    }
    this.alias.set(`${raw.provider}:${raw.providerEventId}`, fid);
    return fid;
  }

  /** The live node behind a feed id. The alias map only ever points at live nodes (it is
   *  re-pointed on merge and rebuilt from live nodes per run), so a superseded hit cannot
   *  happen; should one ever surface, follow the chain rather than grow a retired node. */
  private resolveLive(fid: string): EventNode | undefined {
    let node = this.eventMap.get(fid);
    for (let hops = 0; node && node.state === 'superseded' && node.supersededBy && hops < MERGE_MAX_ROUNDS; hops++) {
      const next = this.eventMap.get(node.supersededBy);
      if (!next) break;
      node = next;
    }
    return node;
  }

  private makeRow(raw: RawObs): ProvenanceRow {
    const c = this.cfg.get(raw.provider);
    return {
      provider: raw.provider,
      nativeId: raw.providerEventId,
      eventTimeMs: raw.eventTimeMs,
      mag: raw.mag,
      magType: raw.magType,
      status: raw.status,
      providerUpdatedMs: raw.providerUpdatedMs,
      lat: raw.lat,
      lon: raw.lon,
      depth: raw.depth,
      place: raw.place,
      chosen: false,
      license: c?.license ?? 'unknown',
      attribution: c?.attribution ?? raw.provider,
      doi: c?.doi ?? null,
      fields: raw.fields,
    };
  }

  /** reviewed > provisional > automatic, then richer solution, then newer, then priority, then id (total order). */
  private preferred(rows: ProvenanceRow[]): ProvenanceRow {
    const rank = (p: string): number => this.priority.get(p) ?? 9999;
    return [...rows].sort((a, b) => {
      const sr = statusRank(b.status) - statusRank(a.status);
      if (sr) return sr;
      const ri = richness(b) - richness(a);
      if (ri) return ri;
      const up = (b.providerUpdatedMs ?? -Infinity) - (a.providerUpdatedMs ?? -Infinity);
      if (up) return up;
      const pr = rank(a.provider) - rank(b.provider);
      if (pr) return pr;
      return a.nativeId < b.nativeId ? -1 : a.nativeId > b.nativeId ? 1 : 0;
    })[0]!;
  }

  private applyRepr(node: EventNode): void {
    const chosen = this.preferred(node.provenance);
    for (const r of node.provenance) r.chosen = r === chosen;
    node.eventTimeMs = chosen.eventTimeMs;
    node.lat = chosen.lat;
    node.lon = chosen.lon;
    node.depth = chosen.depth;
    node.mag = chosen.mag;
    node.magType = chosen.magType;
    node.status = chosen.status;
    node.place = chosen.place;
    node.chosenProvider = chosen.provider;
  }

  /** Re-derive the representative solution and keep the spatial index in step with it. */
  private reposition(node: EventNode): void {
    const beforeHash = node.geohash;
    this.applyRepr(node);
    node.geohash = gridKey(node.lat, node.lon, GRID_CELL_DEG);
    if (beforeHash !== node.geohash) {
      this.deindexGeo(beforeHash, node.feedId);
      if (node.eventTimeMs >= this.hotFloor) this.indexGeo(node);
    }
  }

  private static solutionEqual(a: ProvenanceRow, r: RawObs): boolean {
    return (
      a.mag === r.mag &&
      a.magType === r.magType &&
      a.status === r.status &&
      a.lat === r.lat &&
      a.lon === r.lon &&
      a.depth === r.depth &&
      a.eventTimeMs === r.eventTimeMs &&
      a.place === r.place
    );
  }

  private static sig(node: EventNode): string {
    return [node.mag, node.magType, node.status, node.lat.toFixed(4), node.lon.toFixed(4), node.depth, node.chosenProvider, node.eventTimeMs, node.place].join('|');
  }

  /** Ingest a fresh observation (mints a new event if unknown). Two exceptions for a COMCAT_ID_PROVIDERS report
   *  (PF-5b), both changing nothing: an id ComCat deleted (retiredComcatNode), and a report that would mint beside
   *  another agency's live event (lateTwin: ±60 s, ≤ 50 km, |ΔM| ≤ 1, no row of its own provider). The regional
   *  network lists every Alaska quake once, so when it has no row in that event, its unmatched solution is most likely
   *  the same quake located differently (an automatic AEC solution 15 km from AVO's reviewed one), which the feed
   *  already shows; it is withheld (`withheld` on the result) and looked at again every run, and ComCat publishing
   *  its id joins it by id at once. */
  ingest(raw: RawObs, ingestTime: string): IngestResult {
    const byId = this.findById(raw);
    if (byId) return this.applyIngest(byId, raw, ingestTime);
    const retired = this.retiredComcatNode(raw);
    if (retired) return { node: retired, changed: false, revision: retired.revision, merges: [] };
    const near = this.findNear(raw);
    if (near) return this.applyIngest(near, raw, ingestTime);
    if (COMCAT_ID_PROVIDERS.has(raw.provider)) {
      const twin = this.lateTwin(raw);
      if (twin) return { node: twin.near, changed: false, revision: twin.near.revision, merges: [], withheld: { km: twin.km, dtMs: twin.dtMs } };
    }
    return this.applyIngest(this.mintId(raw), raw, ingestTime);
  }

  /** Ingest an `updatedafter` observation as a revision ONLY — never mints a new event
   *  (H2). A revision to an event outside the loaded index is skipped, not duplicated. */
  reviseExisting(raw: RawObs, ingestTime: string): IngestResult | null {
    const fid = this.findExisting(raw);
    return fid ? this.applyIngest(fid, raw, ingestTime) : null;
  }

  /** True when the feed already holds this provider's report of the event (found by id only) with
   *  a later update stamp than `raw`'s: `raw` is an older copy. The sweeps are issued before the
   *  live fetches (PF-5c), so a sweep's answer can predate the live query's in the same run, and
   *  applying it after the live row would roll the event back for a run. */
  isOlderThanStored(raw: RawObs): boolean {
    if (raw.providerUpdatedMs == null) return false;
    const fid = this.alias.get(`${raw.provider}:${raw.providerEventId}`);
    const node = fid ? this.resolveLive(fid) : undefined;
    const row = node?.provenance.find((r) => r.provider === raw.provider && r.nativeId === raw.providerEventId);
    return row?.providerUpdatedMs != null && raw.providerUpdatedMs < row.providerUpdatedMs;
  }

  /** An `updatedafter` observation from a catalog that may publish an event days after its
   *  origin (ComCat, PF-5a). A report findExisting places is a revision, exactly as in
   *  reviseExisting. An unknown one is minted, like a live report, when its origin is inside the
   *  hot window, where findExisting has just matched it by space against every live event; below
   *  the hot floor only ids match, so a mint could duplicate another provider's copy: skipped, as
   *  before. Inside the window one more check: the identity windows (±60 s / ±10 km below M5.5)
   *  leave agencies' solutions of one quake 15–20 km apart as two events, a split the live path
   *  shares; days later the other agencies' copy is all the feed shows of the quake, so a late
   *  report beside it is withheld rather than minted (lateTwin). */
  reviseOrMintInHotWindow(raw: RawObs, ingestTime: string): LateSweepOutcome {
    const fid = this.findExisting(raw);
    if (fid) return { kind: 'revised', result: this.applyIngest(fid, raw, ingestTime) };
    // The floor keeps one identity window (TEMPORAL_MS) of margin: only live events at or above
    // the hot floor are in the spatial index, so a copy of this quake less than 60 s older than
    // a row at the floor itself would be invisible to findExisting and lateTwin alike.
    if (raw.eventTimeMs < this.hotFloor + TEMPORAL_MS) return { kind: 'skipped' };
    const twin = this.lateTwin(raw);
    if (twin) return { kind: 'withheld', ...twin };
    return { kind: 'minted', result: this.applyIngest(this.mintId(raw), raw, ingestTime) };
  }

  /** The live event a late report (or an unmatched COMCAT_ID_PROVIDERS report, see ingest) most likely duplicates,
   *  or null: within ±TEMPORAL_MS and
   *  LATE_TWIN_KM (the widest identity window, and the alerts gateway's fold window), with no row
   *  of the report's own provider (one would be a distinct event by that provider's own ids, like
   *  two small quakes seconds apart in a Southern California swarm) and, when both magnitudes are
   *  known, |ΔM| ≤ LARGE_EVENT_MAX_DELTA (a much smaller or larger event is a different one).
   *  The nearest in space wins. */
  private lateTwin(raw: RawObs): { near: EventNode; km: number; dtMs: number } | null {
    let best: { near: EventNode; km: number; dtMs: number } | null = null;
    for (const cell of gatherCellKeys(raw.lat, raw.lon, LATE_TWIN_KM, GRID_CELL_DEG)) {
      for (const fid of this.geo.get(cell) ?? []) {
        const node = this.eventMap.get(fid);
        if (!node || node.state !== 'live') continue;
        const dtMs = node.eventTimeMs - raw.eventTimeMs;
        if (Math.abs(dtMs) > TEMPORAL_MS) continue;
        const km = haversineKm(raw.lat, raw.lon, node.lat, node.lon);
        if (km > LATE_TWIN_KM) continue;
        if (node.provenance.some((r) => r.provider === raw.provider)) continue;
        if (raw.mag != null && node.mag != null && Math.abs(raw.mag - node.mag) > LARGE_EVENT_MAX_DELTA) continue;
        if (!best || km < best.km || (km === best.km && node.feedId < best.near.feedId)) best = { near: node, km, dtMs };
      }
    }
    return best;
  }

  private applyIngest(fid: string, raw: RawObs, ingestTime: string): IngestResult {
    const key = `${raw.provider}:${raw.providerEventId}`;
    let node = this.resolveLive(fid);
    // A COMCAT_ID_PROVIDERS report also puts the ComCat id it names on the node (PF-5b), so a later ComCat row of
    // that id, or one whose `ids` carry it under another preferred id, resolves here by alias.
    const comcatKey = COMCAT_ID_PROVIDERS.has(raw.provider) ? `${COMCAT_PROVIDER}:${raw.providerEventId}` : null;
    if (node && comcatKey && Resolver.withdrawnFrom(node, raw)) return { node, changed: false, revision: node.revision, merges: [] };

    if (!node) {
      const row = this.makeRow(raw);
      node = {
        feedId: fid,
        aliases: comcatKey ? [key, comcatKey] : [key],
        eventTimeMs: raw.eventTimeMs,
        firstIngestTime: ingestTime,
        lastIngestTime: ingestTime,
        lat: raw.lat,
        lon: raw.lon,
        depth: raw.depth,
        mag: raw.mag,
        magType: raw.magType,
        status: raw.status,
        place: raw.place,
        chosenProvider: raw.provider,
        provenance: [row],
        revision: 1,
        firstSeenSeq: -1,
        lastSeq: -1,
        state: 'live',
        geohash: gridKey(raw.lat, raw.lon, GRID_CELL_DEG),
      };
      this.applyRepr(node);
      node.geohash = gridKey(node.lat, node.lon, GRID_CELL_DEG);
      this.eventMap.set(fid, node);
      if (node.eventTimeMs >= this.hotFloor) this.indexGeo(node);
      if (comcatKey && !this.alias.has(comcatKey)) this.alias.set(comcatKey, fid);
      this.indexComcat(raw, node);
      // A fresh mint already failed the gates against every neighbour, and every id it names
      // resolved nowhere, so no merge pass.
      return { node, changed: true, revision: 1, merges: [] };
    }

    const hadAlias = node.aliases.includes(key);
    const needsComcatAlias = comcatKey != null && !node.aliases.includes(comcatKey);
    const idx = node.provenance.findIndex((r) => r.provider === raw.provider && r.nativeId === raw.providerEventId);
    let structural = false;
    if (idx < 0) {
      node.provenance.push(this.makeRow(raw));
      structural = true;
    } else if (Resolver.solutionEqual(node.provenance[idx]!, raw)) {
      // Unchanged re-report: a pure no-op — no unlogged mutation, replay stays
      // reproducible from the log and cold partitions stay byte-stable (M2).
      if (!hadAlias || needsComcatAlias) {
        if (!hadAlias) node.aliases.push(key);
        structural = true;
      } else if (this.namesComcatTwin(raw, node)) {
        // Same solution, but ComCat's `ids` now carry the id of an AEC report that minted its own event: store the
        // row (its `ids` changed) and let foldComcatTwins join the two (PF-5b).
        node.provenance[idx] = this.makeRow(raw);
        structural = true;
      } else {
        return { node, changed: false, revision: node.revision, merges: [] };
      }
    } else {
      node.provenance[idx] = this.makeRow(raw);
    }
    if (!hadAlias && !node.aliases.includes(key)) node.aliases.push(key);
    if (comcatKey && needsComcatAlias) {
      node.aliases.push(comcatKey);
      structural = true;
    }
    if (comcatKey && !this.alias.has(comcatKey)) this.alias.set(comcatKey, node.feedId);
    this.indexComcat(raw, node);

    // A live observation to a retired event un-hides it (design §8.6) — a tombstoned one by
    // design; a superseded one only on the cannot-happen path resolveLive() describes.
    const unhidden = node.state !== 'live';
    if (unhidden) {
      node.state = 'live';
      delete node.supersededBy;
    }

    const beforeSig = Resolver.sig(node);
    this.reposition(node);
    // A retired node left the spatial index; back on the map it must be findable again.
    if (unhidden && node.eventTimeMs >= this.hotFloor) this.indexGeo(node);

    if (structural || unhidden || Resolver.sig(node) !== beforeSig) {
      node.revision += 1;
      node.lastIngestTime = ingestTime;
      const merges: MergeRecord[] = [];
      const survivor = this.mergeAround(this.foldComcatTwins(node, ingestTime, merges), ingestTime, merges);
      return { node: survivor, changed: true, revision: survivor.revision, merges };
    }
    return { node, changed: false, revision: node.revision, merges: [] };
  }

  /** A ComCat report whose ids name a COMCAT_ID_PROVIDERS report held by another live node foldComcatTwins may join
   *  to `node` (merge pass on only). */
  private namesComcatTwin(raw: RawObs, node: EventNode): boolean {
    if (!this.mergePass) return false;
    for (const id of comcatIdsNamed(raw.provider, raw.providerEventId, raw.fields)) {
      for (const p of COMCAT_ID_PROVIDERS) {
        const fid = this.alias.get(`${p}:${id}`);
        const other = fid ? this.resolveLive(fid) : undefined;
        if (!other || other === node || other.state !== 'live') continue;
        if (other.provenance.some((r) => r.provider === p && r.nativeId === id) && !Resolver.nodesDistinct(node, other)) return true;
      }
    }
    return false;
  }

  /** Keep the ComCat index (once built) in step with a ComCat report that landed in `node`. */
  private indexComcat(raw: RawObs, node: EventNode): void {
    if (!this.comcatIndex) return;
    for (const id of comcatIdsNamed(raw.provider, raw.providerEventId, raw.fields)) this.comcatIndex.set(id, node.feedId);
  }

  /** PF-5b: fold into `node` every live node that is the same event by exact ComCat id — one holds a
   *  COMCAT_ID_PROVIDERS row whose native id a ComCat row of the other names (its own id or one in `ids`) — unless a
   *  provider present in both under distinct ids says otherwise (nodesDistinct). Exact identity, so neither the
   *  proximity windows nor the dense-cell rule apply: an automatic AEC solution can sit tens of km from the solution
   *  ComCat prefers. It heals the one split first sight cannot prevent: ComCat listing the AEC id in a node's `ids`
   *  only after the AEC report had minted its own node. Bounded like mergeAround; off when merge=false. */
  private foldComcatTwins(node: EventNode, ingestTime: string, merges: MergeRecord[]): EventNode {
    if (!this.mergePass) return node;
    let cur = node;
    for (let round = 0; round < MERGE_MAX_ROUNDS && cur.state === 'live'; round++) {
      const twin = this.comcatTwin(cur);
      if (!twin) break;
      cur = this.mergeNodes(cur, twin.node, twin.reason, ingestTime, merges);
    }
    return cur;
  }

  /** The first live node linked to `node` by an exact ComCat id (foldComcatTwins), with its op:merge reason. */
  private comcatTwin(node: EventNode): { node: EventNode; reason: string } | null {
    const seen = new Set<string>([node.feedId]);
    const consider = (fid: string | undefined, id: string): { node: EventNode; reason: string } | null => {
      const other = fid ? this.resolveLive(fid) : undefined;
      if (!other || other.state !== 'live' || seen.has(other.feedId)) return null;
      seen.add(other.feedId);
      const link = Resolver.comcatLink(node, other, id) ?? Resolver.comcatLink(other, node, id);
      if (!link || Resolver.nodesDistinct(node, other)) return null;
      return { node: other, reason: `exact id: ComCat ${link} names ${id}, the id of the ${Resolver.comcatHolder(node, other, id)} report` };
    };
    for (const r of node.provenance) {
      if (COMCAT_ID_PROVIDERS.has(r.provider)) {
        const hit = consider(this.alias.get(`${COMCAT_PROVIDER}:${r.nativeId}`), r.nativeId) ?? consider(this.comcat().get(r.nativeId), r.nativeId);
        if (hit) return hit;
      }
      for (const id of comcatIdsNamed(r.provider, r.nativeId, r.fields)) {
        for (const p of COMCAT_ID_PROVIDERS) {
          const hit = consider(this.alias.get(`${p}:${id}`), id);
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  /** The native id of `lister`'s ComCat row that names `id` while `holder` holds a COMCAT_ID_PROVIDERS row of `id`,
   *  or null. */
  private static comcatLink(holder: EventNode, lister: EventNode, id: string): string | null {
    if (!holder.provenance.some((r) => COMCAT_ID_PROVIDERS.has(r.provider) && r.nativeId === id)) return null;
    return lister.provenance.find((r) => comcatIdsNamed(r.provider, r.nativeId, r.fields).includes(id))?.nativeId ?? null;
  }

  private static comcatHolder(a: EventNode, b: EventNode, id: string): string {
    return [...a.provenance, ...b.provenance].find((r) => COMCAT_ID_PROVIDERS.has(r.provider) && r.nativeId === id)?.provider ?? 'aec';
  }

  /** Upstream delete signal for one provider's contribution. Drops that provenance row;
   *  tombstones the event if no provider is left, else recomputes the preferred solution.
   *  Never mints — a delete for an unknown event is a no-op. */
  tombstoneProvider(raw: RawObs, ingestTime: string): IngestResult | null {
    const fid = this.findExisting(raw);
    if (!fid) return null;
    const node = this.eventMap.get(fid);
    if (!node || node.state !== 'live') return null;
    const idx = node.provenance.findIndex((r) => r.provider === raw.provider && r.nativeId === raw.providerEventId);
    if (idx < 0) return null;
    return this.withdrawRow(node, idx, ingestTime);
  }

  /** PF-5b: a ComCat delete (the usgs `includedeleted` sweep) also withdraws the COMCAT_ID_PROVIDERS rows of the same
   *  id: AEC's id is the ComCat id, and AEC is where an `ak` delete comes from. Found by id only (the provider's own
   *  alias), never mints; the node is tombstoned when no row is left, else re-derives its solution, like
   *  tombstoneProvider. A later report of the id from the same provider changes nothing (withdrawnFrom,
   *  retiredComcatNode), so a file that keeps listing a deleted id cannot bring the event back. Each entry's `raw` is
   *  the withdrawn row as a report: what its op:tombstone line records and what a replay feeds back to
   *  tombstoneProvider. Idempotent: a repeated delete finds no row. */
  withdrawComcatTwins(raw: RawObs, ingestTime: string): { raw: RawObs; result: IngestResult }[] {
    if (raw.provider !== COMCAT_PROVIDER) return [];
    const out: { raw: RawObs; result: IngestResult }[] = [];
    for (const p of [...COMCAT_ID_PROVIDERS].sort()) {
      const fid = this.alias.get(`${p}:${raw.providerEventId}`);
      const node = fid ? this.resolveLive(fid) : undefined;
      if (!node || node.state !== 'live') continue;
      const idx = node.provenance.findIndex((r) => r.provider === p && r.nativeId === raw.providerEventId);
      if (idx < 0) continue;
      const withdrawn = rowAsReport(node.provenance[idx]!);
      out.push({ raw: withdrawn, result: this.withdrawRow(node, idx, ingestTime) });
    }
    return out;
  }

  /** A provider's own withdrawal by zeroing: SCEDC and NCEDC retract an event (deleted, or
   *  folded into another of their ids) by re-publishing its id with no location — exactly lat 0 /
   *  lon 0 with magnitude 0 or none (quality.ts `isCoordinateless`, magType `un` / `MU`). They have
   *  no `includedeleted` sweep, so this is the only delete signal they send (2026-07..09: nine ids
   *  located first and zeroed later, none ever located again). The ingest screen keeps such a
   *  report off the map; for an id the feed already holds it withdraws that provider's row
   *  exactly like tombstoneProvider does for an upstream delete (the node is tombstoned when no
   *  row is left, else re-derives its solution). Found by id only — the provider's own id through
   *  the alias map, never the spatial match (a report at 0,0 has no position to match on) — and
   *  never mints, so an unknown placeholder stays a no-op and changes nothing. null when the
   *  report is not coordinate-less, the id is unknown, or its row is already gone (idempotent).
   *  A later located report of the same id un-hides the node, as after any tombstone. */
  withdrawZeroed(raw: RawObs, ingestTime: string): IngestResult | null {
    if (!isCoordinateless(raw)) return null;
    const fid = this.alias.get(`${raw.provider}:${raw.providerEventId}`);
    if (!fid) return null;
    const node = this.resolveLive(fid);
    if (!node || node.state !== 'live') return null;
    const idx = node.provenance.findIndex((r) => r.provider === raw.provider && r.nativeId === raw.providerEventId);
    if (idx < 0) return null;
    return this.withdrawRow(node, idx, ingestTime);
  }

  /** The feed's own retraction of coordinate-less rows (quality.ts `isCoordinateless`: exactly
   *  lat 0 / lon 0 with magnitude 0 or none — NCEDC's unlocated placeholders), through the same
   *  path as an upstream delete: the row leaves its live node, a node left with no row is
   *  tombstoned (the summaries and the Pages day files carry it only as a non-live marker, for
   *  48 h), one with other rows re-derives its solution. Ingest drops such reports at the door
   *  (a zeroed report of a KNOWN id withdraws that row through withdrawZeroed instead of
   *  replacing it), so this only clears what was published before the rule; it is idempotent
   *  (a retired node is never revisited). Deterministic order (event time, feed id, then row),
   *  so the log lines replay. Each entry's `raw` is the withdrawn row as a report — what the
   *  op:tombstone line records and what a replay feeds back to tombstoneProvider. */
  retractCoordinateless(ingestTime: string): { raw: RawObs; result: IngestResult }[] {
    const out: { raw: RawObs; result: IngestResult }[] = [];
    const nodes = [...this.eventMap.values()]
      .filter((n) => n.state === 'live' && n.provenance.some(isCoordinateless))
      .sort((a, b) => a.eventTimeMs - b.eventTimeMs || (a.feedId < b.feedId ? -1 : a.feedId > b.feedId ? 1 : 0));
    for (const node of nodes) {
      const rows = node.provenance
        .filter(isCoordinateless)
        .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) || (a.nativeId < b.nativeId ? -1 : a.nativeId > b.nativeId ? 1 : 0));
      for (const row of rows) {
        // A fold triggered by an earlier withdrawal can retire this node; its rows then live on
        // the survivor, which the next retraction pass (the next run) clears.
        if (node.state !== 'live') break;
        const idx = node.provenance.indexOf(row);
        if (idx < 0) continue;
        out.push({ raw: rowAsReport(row), result: this.withdrawRow(node, idx, ingestTime) });
      }
    }
    return out;
  }

  /** Drop one provenance row from a live node: tombstone it when none is left, else re-derive
   *  the representative and run the merge pass (the solution may have moved). */
  private withdrawRow(node: EventNode, idx: number, ingestTime: string): IngestResult {
    node.provenance.splice(idx, 1);
    node.revision += 1;
    node.lastIngestTime = ingestTime;
    if (node.provenance.length === 0) {
      // Keep the alias so a later re-report can un-hide via the same id.
      node.state = 'tombstoned';
      this.deindexGeo(node.geohash, node.feedId);
      for (const a of node.aliases) this.retired.set(a, node.feedId);
      return { node, changed: true, revision: node.revision, merges: [] };
    }
    this.reposition(node);
    const merges: MergeRecord[] = [];
    const survivor = this.mergeAround(node, ingestTime, merges);
    return { node: survivor, changed: true, revision: survivor.revision, merges };
  }

  // --- op:merge — post-revision re-evaluation (design §8.6) ---

  /** Diagnostic: why two live nodes are not one event, or null when the merge pass may fold
   *  them. Symmetric, so the mutual-best check reads the same pair the same way from both
   *  sides: the dense-cell rule applies when BOTH nodes sit in dense cells (never stricter than
   *  judging from the non-dense side — an M6.8 mainshock's second id must still fold after its
   *  own aftershocks filled the cell, Kumamoto 2026-07-28). */
  whyNotMerged(a: EventNode, b: EventNode): string | null {
    const d = haversineKm(a.lat, a.lon, b.lat, b.lon);
    const dense = this.pairDense(a, b);
    const gate = this.reject(a, b, d, dense);
    if (gate) return gate;
    if (Resolver.nodesDistinct(a, b)) return 'same provider under distinct native ids';
    if (dense && !Resolver.nodesShareIdentity(a, b)) return 'dense cell without a shared id';
    return null;
  }

  private pairDense(a: EventNode, b: EventNode): boolean {
    return this.isDense(a.lat, a.lon) && this.isDense(b.lat, b.lon);
  }

  /** How far apart two solutions are relative to the windows their pair gets: d/km + |dt|/ms
   *  (0 = one solution, < 2 inside both windows). It ranks a neighbour that matches in space AND
   *  time ahead of one that is merely near. */
  private score(a: EventNode, b: EventNode): number {
    const { km, ms } = this.windows(a, b, this.pairDense(a, b));
    return haversineKm(a.lat, a.lon, b.lat, b.lon) / km + Math.abs(a.eventTimeMs - b.eventTimeMs) / ms;
  }

  /** Every live neighbour `node` may fold with (whyNotMerged passes), best score first, ties
   *  by feed id. Empty outside the hot window. */
  private mergeableNeighbours(node: EventNode): { node: EventNode; score: number }[] {
    if (node.eventTimeMs < this.hotFloor) return [];
    const out: { node: EventNode; score: number }[] = [];
    for (const fid of this.candidates(node)) {
      if (fid === node.feedId) continue;
      const other = this.eventMap.get(fid);
      if (!other || other.state !== 'live') continue;
      if (this.whyNotMerged(node, other)) continue;
      out.push({ node: other, score: this.score(node, other) });
    }
    return out.sort((x, y) => x.score - y.score || (x.node.feedId < y.node.feedId ? -1 : x.node.feedId > y.node.feedId ? 1 : 0));
  }

  /** The next fold the merge pass around `node` makes, with the reason string its op:merge
   *  line carries. Only mutual best matches fold: `node` with a mergeable neighbour whose own
   *  best partner is `node`; or, when that neighbour's best is a third node that returns the
   *  favour, that neighbour pair first (they are one event; `node` is looked at again against
   *  the result). A neighbour with a better partner is never folded into `node`: that would weld
   *  two events together while the twin stays apart (Puerto Rico, 2026-09-27: EMSC's M2.0 at
   *  06:06:03 is USGS pr71534788 to the millisecond, yet it was also the nearest node to USGS's
   *  M1.2 22.6 s earlier, and the nearest-only rule folded it there). */
  private nextFold(node: EventNode): { a: EventNode; b: EventNode; reason: string } | null {
    for (const { node: other } of this.mergeableNeighbours(node)) {
      const best = this.mergeableNeighbours(other)[0]?.node;
      if (best === node) return { a: node, b: other, reason: this.foldReason(node, other) };
      if (best && this.mergeableNeighbours(best)[0]?.node === other) return { a: other, b: best, reason: this.foldReason(other, best) };
    }
    return null;
  }

  private foldReason(a: EventNode, b: EventNode): string {
    const d = haversineKm(a.lat, a.lon, b.lat, b.lon);
    const { km, ms } = this.windows(a, b, this.pairDense(a, b));
    const dt = Math.abs(a.eventTimeMs - b.eventTimeMs) / 1000;
    const dM = a.mag != null && b.mag != null ? Math.abs(a.mag - b.mag).toFixed(2) : 'n/a';
    return `proximity: d=${d.toFixed(1)} km dt=${dt.toFixed(1)} s dM=${dM} window=${km.toFixed(1)} km/${(ms / 1000).toFixed(0)} s`;
  }

  /** After a live node changed, match it against its live neighbours with the first-sight
   *  gates; a match folds the pair into one survivor and the chain continues from the
   *  survivor. Bounded: every round retires one node. Returns the node the caller's report
   *  now lives in. Identity is otherwise pinned at first sight, so this is the only place a
   *  duplicate minted from scattered preliminary solutions is ever healed — and only while
   *  the node is inside the hot window (HOT_WINDOW_DAYS of event time, mergeableNeighbours):
   *  a duplicate whose next revision comes later stays two ids. Off when merge=false. */
  private mergeAround(node: EventNode, ingestTime: string, merges: MergeRecord[]): EventNode {
    if (!this.mergePass) return node;
    let cur = node;
    for (let round = 0; round < MERGE_MAX_ROUNDS && cur.state === 'live'; round++) {
      const fold = this.nextFold(cur);
      if (!fold) break;
      const survivor = this.mergeNodes(fold.a, fold.b, fold.reason, ingestTime, merges);
      if (fold.a === cur || fold.b === cur) cur = survivor;
    }
    return cur;
  }

  /** The one-time heal (aggregate, `HEAL_EPOCH`): the op:merge pass over EVERY live node inside
   *  the hot window, not only the one a report just moved. Events split under the pre-PF-1
   *  rules otherwise heal only on a revision that may never come (the Loyalty Islands M7.0,
   *  2026-09-25: six live ids). Same gates, survivor rule and bounded chain as after a report;
   *  nodes in event-time order (then feed id), so the pass is deterministic. One `merges` list
   *  for the whole pass, so a node folded early whose survivor folds later has its pending
   *  op:merge re-aimed instead of logged twice. Returns the folds (in order) and the live
   *  survivors whose revision moved, in event-time order. A no-op when merge=false. */
  heal(ingestTime: string): { merges: MergeRecord[]; survivors: EventNode[] } {
    const merges: MergeRecord[] = [];
    if (!this.mergePass) return { merges, survivors: [] };
    const byTimeThenId = (a: EventNode, b: EventNode): number =>
      a.eventTimeMs - b.eventTimeMs || (a.feedId < b.feedId ? -1 : a.feedId > b.feedId ? 1 : 0);
    // Passes until one folds nothing: a node visited before its mutual partner formed (that
    // partner was still paired with a better match) gets another look. Bounded.
    for (let pass = 0; pass < HEAL_MAX_PASSES; pass++) {
      const before = merges.length;
      const nodes = [...this.eventMap.values()].filter((n) => n.state === 'live' && n.eventTimeMs >= this.hotFloor).sort(byTimeThenId);
      for (const node of nodes) if (node.state === 'live') this.mergeAround(node, ingestTime, merges);
      if (merges.length === before) break;
    }
    const survivors = [...new Set(merges.map((m) => m.survivor))].filter((n) => n.state === 'live').sort(byTimeThenId);
    return { merges, survivors };
  }

  /** Survivor = most providers → higher status → richer chosen solution → lower priority
   *  number → smaller feed id (a total order, so the pair folds the same way whichever side
   *  moved). */
  private survivorFirst(x: EventNode, y: EventNode): [EventNode, EventNode] {
    const providers = (n: EventNode): number => new Set(n.provenance.map((r) => r.provider)).size;
    const chosenRichness = (n: EventNode): number => {
      const c = n.provenance.find((r) => r.chosen);
      return c ? richness(c) : 0;
    };
    const rank = (p: string): number => this.priority.get(p) ?? 9999;
    const cmp =
      providers(y) - providers(x) ||
      statusRank(y.status) - statusRank(x.status) ||
      chosenRichness(y) - chosenRichness(x) ||
      rank(x.chosenProvider) - rank(y.chosenProvider) ||
      (x.feedId < y.feedId ? -1 : x.feedId > y.feedId ? 1 : 0);
    return cmp <= 0 ? [x, y] : [y, x];
  }

  /** Fold two live nodes into one. The survivor takes every provenance row and alias — the
   *  loser's ids resolve to it from now on, in this run (alias map re-pointed) and every later
   *  one (the constructor registers a live node's aliases). The loser keeps a frozen COPY of
   *  its rows, so its partition line stays full-fat and says what it was, and is retired:
   *  state 'superseded', supersededBy, out of the spatial index. Both revisions bump, so a
   *  consumer keyed on (id, revision) sees both changes. The survivor's first-seen facts
   *  become the earlier of the two — the feed learned of this event when it saw either id. */
  private mergeNodes(x: EventNode, y: EventNode, reason: string, ingestTime: string, merges: MergeRecord[]): EventNode {
    const [survivor, loser] = this.survivorFirst(x, y);
    const frozen = loser.provenance.map((r) => ({ ...r }));
    for (const r of loser.provenance) {
      if (!survivor.provenance.some((s) => s.provider === r.provider && s.nativeId === r.nativeId)) survivor.provenance.push(r);
    }
    for (const k of loser.aliases) if (!survivor.aliases.includes(k)) survivor.aliases.push(k);
    for (const [k, v] of this.alias) if (v === loser.feedId) this.alias.set(k, survivor.feedId);
    if (loser.firstIngestTime < survivor.firstIngestTime) survivor.firstIngestTime = loser.firstIngestTime;
    if (loser.firstSeenSeq >= 0 && (survivor.firstSeenSeq < 0 || loser.firstSeenSeq < survivor.firstSeenSeq)) {
      survivor.firstSeenSeq = loser.firstSeenSeq;
    }
    this.reposition(survivor);
    survivor.revision += 1;
    survivor.lastIngestTime = ingestTime;

    this.deindexGeo(loser.geohash, loser.feedId);
    loser.provenance = frozen;
    loser.state = 'superseded';
    loser.supersededBy = survivor.feedId;
    loser.revision += 1;
    loser.lastIngestTime = ingestTime;
    merges.push({ survivor, loser, reason });
    this.repointRetired(loser, survivor, ingestTime, merges);
    return survivor;
  }

  /** `superseded_by` always names the event that is live when the line is written. When an
   *  earlier survivor retires in its turn, every node folded into it follows to the new
   *  survivor: one retired in this same ingest just has its pending op:merge re-aimed (no
   *  second revision); one retired in an earlier run moves a revision and gets its own
   *  op:merge line, so its partition line and the change-log say where it went. */
  private repointRetired(retired: EventNode, survivor: EventNode, ingestTime: string, merges: MergeRecord[]): void {
    for (const n of this.eventMap.values()) {
      if (n.state !== 'superseded' || n.supersededBy !== retired.feedId) continue;
      n.supersededBy = survivor.feedId;
      const pending = merges.find((m) => m.loser === n);
      if (pending) {
        pending.survivor = survivor;
        pending.reason += `; then ${retired.feedId} folded into ${survivor.feedId}`;
        continue;
      }
      n.revision += 1;
      n.lastIngestTime = ingestTime;
      merges.push({ survivor, loser: n, reason: `re-point: ${retired.feedId} folded into ${survivor.feedId}` });
    }
  }
}
