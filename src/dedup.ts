import {
  GRID_CELL_DEG,
  HOT_WINDOW_DAYS,
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
import type { EventNode, ProvenanceRow, ProviderConfig, RawObs } from './types.js';
import { deterministicFeedId } from './ulid.js';
import { knownAliasIdsOf, statusRank } from './util.js';

const REVIEWED_DT_HARD_MS = 30_000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

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
}

export class Resolver {
  private readonly alias = new Map<string, string>();
  private readonly geo = new Map<string, Set<string>>();
  private readonly hotFloor: number;
  private readonly mergePass: boolean;

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
        km = clamp(SPATIAL_KM + LARGE_EVENT_KM_PER_MAG * (Math.min(a.mag, b.mag) - LARGE_EVENT_MAG), SPATIAL_KM, LARGE_EVENT_MAX_KM);
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
    return clamp(SPATIAL_KM + LARGE_EVENT_KM_PER_MAG * (s.mag - LARGE_EVENT_MAG), SPATIAL_KM, LARGE_EVENT_MAX_KM);
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

  private resolve(raw: RawObs): string {
    const existing = this.findExisting(raw);
    if (existing) return existing;
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

  /** Ingest a fresh observation (mints a new event if unknown). */
  ingest(raw: RawObs, ingestTime: string): IngestResult {
    return this.applyIngest(this.resolve(raw), raw, ingestTime);
  }

  /** Ingest an `updatedafter` observation as a revision ONLY — never mints a new event
   *  (H2). A revision to an event outside the loaded index is skipped, not duplicated. */
  reviseExisting(raw: RawObs, ingestTime: string): IngestResult | null {
    const fid = this.findExisting(raw);
    return fid ? this.applyIngest(fid, raw, ingestTime) : null;
  }

  private applyIngest(fid: string, raw: RawObs, ingestTime: string): IngestResult {
    const key = `${raw.provider}:${raw.providerEventId}`;
    let node = this.resolveLive(fid);

    if (!node) {
      const row = this.makeRow(raw);
      node = {
        feedId: fid,
        aliases: [key],
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
      // A fresh mint already failed the gates against every neighbour, so no merge pass.
      return { node, changed: true, revision: 1, merges: [] };
    }

    const hadAlias = node.aliases.includes(key);
    const idx = node.provenance.findIndex((r) => r.provider === raw.provider && r.nativeId === raw.providerEventId);
    let structural = false;
    if (idx < 0) {
      node.provenance.push(this.makeRow(raw));
      structural = true;
    } else if (Resolver.solutionEqual(node.provenance[idx]!, raw)) {
      // Unchanged re-report: a pure no-op — no unlogged mutation, replay stays
      // reproducible from the log and cold partitions stay byte-stable (M2).
      if (!hadAlias) {
        node.aliases.push(key);
        structural = true;
      } else {
        return { node, changed: false, revision: node.revision, merges: [] };
      }
    } else {
      node.provenance[idx] = this.makeRow(raw);
    }
    if (!hadAlias && !node.aliases.includes(key)) node.aliases.push(key);

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
      const survivor = this.mergeAround(node, ingestTime, merges);
      return { node: survivor, changed: true, revision: survivor.revision, merges };
    }
    return { node, changed: false, revision: node.revision, merges: [] };
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
    node.provenance.splice(idx, 1);
    node.revision += 1;
    node.lastIngestTime = ingestTime;
    if (node.provenance.length === 0) {
      // Keep the alias so a later re-report can un-hide via the same id.
      node.state = 'tombstoned';
      this.deindexGeo(node.geohash, node.feedId);
      return { node, changed: true, revision: node.revision, merges: [] };
    }
    this.reposition(node);
    const merges: MergeRecord[] = [];
    const survivor = this.mergeAround(node, ingestTime, merges);
    return { node: survivor, changed: true, revision: survivor.revision, merges };
  }

  // --- op:merge — post-revision re-evaluation (design §8.6) ---

  /** Diagnostic: why two live nodes are not one event, or null when the merge pass folds them. */
  whyNotMerged(a: EventNode, b: EventNode): string | null {
    const d = haversineKm(a.lat, a.lon, b.lat, b.lon);
    const dense = this.isDense(a.lat, a.lon);
    const gate = this.reject(a, b, d, dense);
    if (gate) return gate;
    if (Resolver.nodesDistinct(a, b)) return 'same provider under distinct native ids';
    if (dense && !Resolver.nodesShareIdentity(a, b)) return 'dense cell without a shared id';
    return null;
  }

  /** The nearest live neighbour the first-sight gates accept for `node`, with the reason
   *  string the op:merge line carries. */
  private findMergeCandidate(node: EventNode): { node: EventNode; reason: string } | null {
    if (node.eventTimeMs < this.hotFloor) return null;
    let best: EventNode | null = null;
    let bestKm = Infinity;
    for (const fid of this.candidates(node)) {
      if (fid === node.feedId) continue;
      const other = this.eventMap.get(fid);
      if (!other || other.state !== 'live') continue;
      if (this.whyNotMerged(node, other)) continue;
      const d = haversineKm(node.lat, node.lon, other.lat, other.lon);
      if (d < bestKm) {
        bestKm = d;
        best = other;
      }
    }
    if (!best) return null;
    const { km, ms } = this.windows(node, best, this.isDense(node.lat, node.lon));
    const dt = Math.abs(node.eventTimeMs - best.eventTimeMs) / 1000;
    const dM = node.mag != null && best.mag != null ? Math.abs(node.mag - best.mag).toFixed(2) : 'n/a';
    return {
      node: best,
      reason: `proximity: d=${bestKm.toFixed(1)} km dt=${dt.toFixed(1)} s dM=${dM} window=${km.toFixed(1)} km/${(ms / 1000).toFixed(0)} s`,
    };
  }

  /** After a live node changed, match it against its live neighbours with the first-sight
   *  gates; a match folds the pair into one survivor and the chain continues from the
   *  survivor. Bounded: every round retires one node. Returns the node the caller's report
   *  now lives in. Identity is otherwise pinned at first sight, so this is the only place a
   *  duplicate minted from scattered preliminary solutions is ever healed — and only while
   *  the node is inside the hot window (HOT_WINDOW_DAYS of event time, findMergeCandidate):
   *  a duplicate whose next revision comes later stays two ids. Off when merge=false. */
  private mergeAround(node: EventNode, ingestTime: string, merges: MergeRecord[]): EventNode {
    if (!this.mergePass) return node;
    let cur = node;
    for (let round = 0; round < MERGE_MAX_ROUNDS && cur.state === 'live'; round++) {
      const hit = this.findMergeCandidate(cur);
      if (!hit) break;
      cur = this.mergeNodes(cur, hit.node, hit.reason, ingestTime, merges);
    }
    return cur;
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
