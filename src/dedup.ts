import {
  GRID_CELL_DEG,
  HOT_WINDOW_DAYS,
  MAG_MERGE_MAX_DELTA,
  SPATIAL_KM,
  SWARM_CELL_ABSOLUTE,
  TEMPORAL_MS,
} from './config.js';
import { gatherCellKeys, gridKey, haversineKm } from './geo.js';
import type { EventNode, ProvenanceRow, ProviderConfig, RawObs } from './types.js';
import { deterministicFeedId } from './ulid.js';
import { statusRank } from './util.js';

const REVIEWED_DT_HARD_MS = 30_000;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

function richness(r: ProvenanceRow): number {
  let n = 0;
  if (r.mag != null) n++;
  if (r.magType != null) n++;
  for (const k of ['nst', 'gap', 'dmin', 'rms']) if (r.extra[k] != null) n++;
  return n;
}

export interface IngestResult {
  node: EventNode;
  changed: boolean;
  revision: number;
}

export class Resolver {
  private readonly alias = new Map<string, string>();
  private readonly geo = new Map<string, Set<string>>();
  private readonly hotFloor: number;

  constructor(
    readonly eventMap: Map<string, EventNode>,
    private readonly priority: Map<string, number>,
    private readonly cfg: Map<string, ProviderConfig>,
    nowMs: number,
    opts: { hotFloorMs?: number } = {},
  ) {
    // Backfill passes hotFloorMs=0 to index events by event-time window (not wall-clock
    // recency), so historical reports dedup against the transient partition index (C2).
    this.hotFloor = opts.hotFloorMs ?? nowMs - HOT_WINDOW_DAYS * 86_400_000;
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

  /** A provider re-reporting the SAME event resolves via alias; the same provider using a
   *  DIFFERENT native id means its pipeline considers these distinct events — never merge. */
  private sameProviderDistinct(raw: RawObs, node: EventNode): boolean {
    return node.provenance.some((r) => r.provider === raw.provider && r.nativeId !== raw.providerEventId);
  }

  private windows(raw: RawObs, node: EventNode, dense: boolean): { km: number; ms: number } {
    let km = SPATIAL_KM;
    let ms = TEMPORAL_MS;
    if (raw.mag != null && node.mag != null) {
      const dM = Math.abs(raw.mag - node.mag);
      km *= clamp(1 - 0.3 * dM, 0.3, 1);
      ms *= clamp(1 - 0.25 * dM, 0.4, 1);
    }
    if (dense) {
      km = Math.min(km, 3);
      ms = Math.min(ms, 20_000);
    }
    return { km, ms };
  }

  private magGuardBlocks(raw: RawObs, node: EventNode): boolean {
    if (statusRank(raw.status) >= 3 && statusRank(node.status) >= 3) {
      if (raw.mag != null && node.mag != null && Math.abs(raw.mag - node.mag) > MAG_MERGE_MAX_DELTA) return true;
      if (Math.abs(raw.eventTimeMs - node.eventTimeMs) > REVIEWED_DT_HARD_MS) return true;
    }
    return false;
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
      const cand = new Set<string>();
      for (const cell of gatherCellKeys(raw.lat, raw.lon, SPATIAL_KM, GRID_CELL_DEG)) {
        const s = this.geo.get(cell);
        if (s) for (const fid of s) cand.add(fid);
      }
      let best: string | null = null;
      let bestKm = Infinity;
      for (const fid of cand) {
        const node = this.eventMap.get(fid);
        if (!node || node.state !== 'live') continue;
        const { km, ms } = this.windows(raw, node, dense);
        if (Math.abs(raw.eventTimeMs - node.eventTimeMs) > ms) continue;
        const d = haversineKm(raw.lat, raw.lon, node.lat, node.lon);
        if (d > km) continue;
        if (this.sameProviderDistinct(raw, node)) continue;
        if (dense && !this.sharesIdentity(raw, node)) continue;
        if (this.magGuardBlocks(raw, node)) continue;
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
      extra: raw.extra,
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
    node.extra = chosen.extra;
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
    let node = this.eventMap.get(fid);

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
        extra: raw.extra,
      };
      this.applyRepr(node);
      node.geohash = gridKey(node.lat, node.lon, GRID_CELL_DEG);
      this.eventMap.set(fid, node);
      if (node.eventTimeMs >= this.hotFloor) this.indexGeo(node);
      return { node, changed: true, revision: 1 };
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
        return { node, changed: false, revision: node.revision };
      }
    } else {
      node.provenance[idx] = this.makeRow(raw);
    }
    if (!hadAlias && !node.aliases.includes(key)) node.aliases.push(key);

    const beforeSig = Resolver.sig(node);
    const beforeHash = node.geohash;
    this.applyRepr(node);
    node.geohash = gridKey(node.lat, node.lon, GRID_CELL_DEG);
    if (beforeHash !== node.geohash) {
      this.deindexGeo(beforeHash, node.feedId);
      if (node.eventTimeMs >= this.hotFloor) this.indexGeo(node);
    }

    if (structural || Resolver.sig(node) !== beforeSig) {
      node.revision += 1;
      node.lastIngestTime = ingestTime;
      return { node, changed: true, revision: node.revision };
    }
    return { node, changed: false, revision: node.revision };
  }
}
