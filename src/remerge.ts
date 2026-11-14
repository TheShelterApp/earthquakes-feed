import { eventDayKey, nodeToFeature } from './bitemporal.js';
import { GRID_CELL_DEG, HOT_WINDOW_DAYS, MAX_PAIR_DT_MS, REMERGE_RULES, SWARM_CELL_ABSOLUTE, identityRules } from './config.js';
import { type RowNormalizeCounts, normalizeRows } from './row-normalize.js';
import { Resolver } from './dedup.js';
import { gridKey, haversineKm } from './geo.js';
import { feedSideSteps } from './heal.js';
import { configMap, priorityMap } from './providers.js';
import type { EventNode, ProviderConfig } from './types.js';

/**
 * The offline re-merge (APIs.md, Re-merged history; config REMERGE_EPOCH). Events published by the paths that ingest
 * with the merge pass off (backfill, the deep-history build, onboarding, the remediation editions) keep every split a
 * quake's first-sight identity made: on 2024-06 one M5.8 was five feed events. Live heals such splits every run inside
 * the hot window (heal.ts, FEED-6); `remergeNodes` replays exactly those feed-side identity steps (feedSideSteps, with
 * the two row withdrawals off) over a published unit (a month, or a remediation day) in sliding daily "virtual now"
 * windows of HOT_WINDOW_DAYS, as live judged every event in the seven runs after it:
 *
 *  - every window N (one per day from the unit's first day + 1 to its end + 7 days) holds the events with an origin in
 *    [N − 7 d, N), so a cell's density is counted over the same seven days live counted it over;
 *  - the older neighbour's last seven days are `frozen` context: they count for density and never fold;
 *  - the newer neighbour's first seven days are `pinned` context, like the unit's own events an older unit already
 *    points into (`anchored`): such an event may survive a fold (the loser then points across the boundary, listed in
 *    `intoNewer`) but never loses one;
 *  - no id is minted and none dropped: a loser becomes `superseded` with `superseded_by` and keeps a frozen copy of its
 *    rows, so no row leaves any asset; no row is withdrawn.
 *
 * The windows run the identity rules of the epoch the unit is merged to (config identityRules): from epoch 2 also ISC's
 * copies of NEIC's, GFZ's, GA's and the Puerto Rico network's origins, the authoritative-region window, and a pair's cell density counted as of the pair
 * (swarmCellsAsOf) instead of as of the window's end.
 *
 * Deterministic: the same input gives the same output bytes (ingest time REMERGE_INGEST_TIME, never the clock).
 */

export const REMERGE_WINDOW_DAYS = HOT_WINDOW_DAYS;
const DAY = 86_400_000;
/** The re-merged assets carry the normalized review status (owner decision A4: they are new assets). */
export const REMERGED_FEATURE_OPTS = { reviewStatus: true } as const;

export interface RemergeInput {
  /** The unit's lines, every state, featureToNode'd; changed in place. */
  own: EventNode[];
  /** feedId → the day member it was read from. */
  memberDay: Map<string, string>;
  /** The unit's days, [startMs, endMs). */
  startMs: number;
  endMs: number;
  /** Up to 7 days before startMs (clones): frozen. */
  older: EventNode[];
  /** Up to 7 days from endMs (clones): pinned. */
  newer: EventNode[];
  /** Own ids an older published unit points to (its into_newer survivors): pinned. */
  anchored: ReadonlySet<string>;
  registry: ProviderConfig[];
  /** REMERGE_INGEST_TIME, never Date.now(). */
  ingestTime: string;
  /** The epoch the unit is merged to: its identity rules (config identityRules) are the windows' rules. */
  epoch: number;
}

export interface RemergeMerge {
  loser: string;
  survivor: string;
  reason: string;
}

export interface RemergeResult {
  /** Every fold this run made, the survivor followed to the live end (the final repoint). */
  merges: RemergeMerge[];
  /** Own losers whose live end is a pinned event of the newer neighbour. */
  intoNewer: { loser: string; survivor: string }[];
  /** Own ids whose time left [start, end): they stay in their member day. */
  offUnit: string[];
  /** feedId → the day file every own event is written to. */
  dayOf: Map<string, string>;
  /** Own superseded lines whose pointer names an event outside the unit and its context and that this run did not
   *  change (a live-era fold published before the re-merge): kept as they are. */
  external: { loser: string; survivor: string }[];
  steps: { rehomed: number; stranded: number; rederived: number; folds: number; windows: number; slowest_ms: number };
  live_before: number;
  live_after: number;
}

export class RemergeError extends Error {}

/** Where a unit's context came from (C8). */
export interface ContextMeta {
  label: string;
  sha256: string | null;
  days: string[];
}

/** The `merge` block of a re-merged unit (`_edition.json`, `_archive.json`; APIs.md, Re-merged history). */
export interface MergeMeta {
  epoch: number;
  /** config REMERGE_RULES when merged (absent = 1: no input normalization). */
  rules?: number;
  /** What the input normalization changed (normalizeUnit), absent when nothing. */
  normalized?: NormalizeCounts;
  ingest_time: string;
  /** The feed commit that merged it (GITHUB_SHA), or null locally. */
  code: string | null;
  window_days: number;
  /** What it was merged from: the previous edition or archive asset; null when merged as it was built (buildEdition). */
  from: { edition: number; asset: string; sha256: string } | null;
  older_context: ContextMeta | null;
  newer_context: ContextMeta | null;
  anchored: string[];
  steps: { rehomed: number; stranded: number; rederived: number; folds: number; windows: number };
  into_newer: { loser: string; survivor: string }[];
  off_unit: string[];
  /** Pre-existing pointers out of the unit, kept (RemergeResult.external); absent when none. */
  external?: { loser: string; survivor: string }[];
  merges: RemergeMerge[];
  live_before: number;
  live_after: number;
}

/** The merge block of a result (C8). */
export function mergeMeta(
  res: RemergeResult,
  o: { epoch: number; ingestTime: string; from: MergeMeta['from']; older: ContextMeta | null; newer: ContextMeta | null; anchored: ReadonlySet<string>; normalized?: NormalizeCounts },
): MergeMeta {
  const { slowest_ms: _slowest, ...steps } = res.steps;
  const normalized = o.normalized && Object.values(o.normalized).some((v) => v > 0) ? o.normalized : undefined;
  return {
    epoch: o.epoch,
    rules: REMERGE_RULES,
    ...(normalized ? { normalized } : {}),
    ingest_time: o.ingestTime,
    code: process.env.GITHUB_SHA ?? null,
    window_days: REMERGE_WINDOW_DAYS,
    from: o.from,
    older_context: o.older,
    newer_context: o.newer,
    anchored: [...o.anchored].sort(),
    steps,
    into_newer: res.intoNewer,
    off_unit: res.offUnit,
    ...(res.external.length ? { external: res.external } : {}),
    merges: res.merges,
    live_before: res.live_before,
    live_after: res.live_after,
  };
}

/**
 * The re-merge's cell density as of a time (epoch 2, `densityAsOfPair`): a grid cell (GRID_CELL_DEG) is a swarm cell at
 * `atMs` when at least SWARM_CELL_ABSOLUTE of the input's live events (the unit's and both contexts', as read) have an
 * origin in it within the HOT_WINDOW_DAYS up to `atMs`. Live judges a cell's density when a quake's reports arrive,
 * minutes after the origin and before its aftershocks; a window of the re-merge holds the seven days before its end, so
 * without this a quake's own aftershocks turn its cell into a swarm cell, where only a shared id joins two events, and
 * the agencies' solutions of a large quake stay apart (the Sındırgı M6.1 of 2025-08-10: ten events after epoch 1). Read
 * from the input, not from the folds the windows make, so every window sees the same counts.
 */
export function swarmCellsAsOf(nodes: Iterable<EventNode>): (lat: number, lon: number, atMs: number) => boolean {
  const cells = new Map<string, number[]>();
  for (const n of nodes) {
    if (n.state !== 'live') continue;
    const k = gridKey(n.lat, n.lon, GRID_CELL_DEG);
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(n.eventTimeMs);
  }
  for (const ts of cells.values()) ts.sort((a, b) => a - b);
  const firstAbove = (ts: number[], x: number, inclusive: boolean): number => {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (inclusive ? ts[mid]! <= x : ts[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const windowMs = HOT_WINDOW_DAYS * DAY;
  return (lat, lon, atMs) => {
    const ts = cells.get(gridKey(lat, lon, GRID_CELL_DEG));
    if (!ts || ts.length < SWARM_CELL_ABSOLUTE) return false;
    return firstAbove(ts, atMs, true) - firstAbove(ts, atMs - windowMs, false) >= SWARM_CELL_ABSOLUTE;
  };
}

const byTimeThenId = (a: EventNode, b: EventNode): number => a.eventTimeMs - b.eventTimeMs || (a.feedId < b.feedId ? -1 : a.feedId > b.feedId ? 1 : 0);

/** Re-merge one unit (see the module comment). Throws RemergeError on a broken invariant; the caller publishes nothing
 *  then. */
export function remergeNodes(input: RemergeInput): RemergeResult {
  const fail = (m: string): never => {
    throw new RemergeError(`remerge: ${m}`);
  };
  const all = new Map<string, EventNode>();
  const add = (n: EventNode, what: string): void => {
    if (all.has(n.feedId)) fail(`${n.feedId} is in the input twice (${what})`);
    all.set(n.feedId, n);
  };
  const own = [...input.own].sort(byTimeThenId);
  const older = [...input.older].sort(byTimeThenId);
  const newer = [...input.newer].sort(byTimeThenId);
  for (const n of older) add(n, 'older context');
  for (const n of own) add(n, 'own');
  for (const n of newer) add(n, 'newer context');
  const ownIds = new Set(own.map((n) => n.feedId));
  for (const id of input.anchored) if (!ownIds.has(id)) fail(`anchored ${id} is not an event of the unit`);
  const frozen = new Set(older.map((n) => n.feedId));
  const pinned = new Set([...newer.map((n) => n.feedId), ...input.anchored]);
  const ctxState = new Map([...older, ...newer].map((n) => [n.feedId, { state: n.state, rows: n.provenance.length }]));
  const pointerBefore = new Map(own.filter((n) => n.state === 'superseded').map((n) => [n.feedId, n.supersededBy ?? '']));
  const liveBefore = own.filter((n) => n.state === 'live').length;
  const prio = priorityMap(input.registry);
  const cfg = configMap(input.registry);
  // One fixed iteration order for every window (the Resolver's own passes sort by time, then id, too).
  const order = [...older, ...own, ...newer].sort(byTimeThenId);
  const rules = identityRules(input.epoch);
  const densityAt = rules.densityAsOfPair ? swarmCellsAsOf(order) : undefined;

  const merges: { loser: EventNode; survivor: EventNode; reason: string }[] = [];
  const steps = { rehomed: 0, stranded: 0, rederived: 0, folds: 0, windows: 0, slowest_ms: 0 };
  const windowMs = REMERGE_WINDOW_DAYS * DAY;
  const firstNow = Math.floor(input.startMs / DAY) * DAY + DAY;
  for (let now = firstNow; now <= input.endMs + windowMs; now += DAY) {
    const floor = now - windowMs;
    const w = new Map<string, EventNode>();
    let ownLive = false;
    for (const n of order) {
      if (n.eventTimeMs < floor || n.eventTimeMs >= now) continue;
      w.set(n.feedId, n);
      if (!ownLive && n.state === 'live' && ownIds.has(n.feedId)) ownLive = true;
    }
    if (!ownLive) continue;
    const t0 = performance.now();
    const r = new Resolver(w, prio, cfg, now, { hotFloorMs: floor, pinned, frozen, pairPrefilterMs: MAX_PAIR_DT_MS, rules, ...(densityAt ? { densityAt } : {}) });
    const s = feedSideSteps(r, input.ingestTime, { healDue: true, maxFolds: Infinity, withdrawals: false });
    steps.windows++;
    steps.rehomed += s.rehomed.length;
    steps.stranded += s.stranded.length;
    steps.rederived += s.rederived.length;
    steps.folds += s.heal.merges.filter((m) => !m.reason.startsWith('re-point:')).length;
    for (const m of [...s.rehomed.flatMap((x) => [...(x.result.rehomed?.from.merges ?? []), ...x.result.merges]), ...s.stranded.flatMap((x) => [...(x.result.rehomed?.from.merges ?? []), ...x.result.merges]), ...s.heal.merges]) {
      if (m.reason.startsWith('re-point:')) continue;
      merges.push({ loser: m.loser, survivor: m.survivor, reason: m.reason });
    }
    steps.slowest_ms = Math.max(steps.slowest_ms, Math.round(performance.now() - t0));
  }

  // Final repoint: every own loser names the live end of its chain (no revision: nothing is logged offline).
  const liveEnd = (n: EventNode): EventNode | null => {
    let cur: EventNode | undefined = n;
    for (let hops = 0; cur && cur.state === 'superseded' && hops < 1000; hops++) cur = cur.supersededBy ? all.get(cur.supersededBy) : undefined;
    return cur && cur.state === 'live' ? cur : null;
  };
  const intoNewer: RemergeResult['intoNewer'] = [];
  const external: RemergeResult['external'] = [];
  for (const n of own) {
    if (n.state !== 'superseded') continue;
    const end = liveEnd(n);
    if (!end) {
      const before = pointerBefore.get(n.feedId);
      if (before != null && before === (n.supersededBy ?? '') && !all.has(before)) {
        external.push({ loser: n.feedId, survivor: before });
        continue;
      }
      fail(`${n.feedId} points to ${n.supersededBy ?? 'nothing'}, which leads to no live event of the unit or its newer neighbour`);
    }
    if (ownIds.has(end!.feedId)) {
      n.supersededBy = end!.feedId;
      continue;
    }
    if (newer.some((x) => x.feedId === end!.feedId)) {
      n.supersededBy = end!.feedId;
      intoNewer.push({ loser: n.feedId, survivor: end!.feedId });
      continue;
    }
    fail(`${n.feedId} folded into ${end!.feedId}, an event of the frozen older neighbour`);
  }

  // Context check: no pinned or frozen event changed state; no frozen event gained or lost a row.
  for (const [id, before] of ctxState) {
    const n = all.get(id)!;
    if (n.state !== before.state) fail(`context event ${id} went ${before.state} -> ${n.state}`);
    if (frozen.has(id) && n.provenance.length !== before.rows) fail(`frozen context event ${id} went ${before.rows} -> ${n.provenance.length} rows`);
  }
  for (const id of input.anchored) if (all.get(id)!.state !== 'live') fail(`anchored ${id} is no longer live`);

  // Day membership: inside the unit by origin time, else the member day it was read from.
  const dayOf = new Map<string, string>();
  const offUnit: string[] = [];
  for (const n of own) {
    if (n.eventTimeMs >= input.startMs && n.eventTimeMs < input.endMs) {
      dayOf.set(n.feedId, eventDayKey(n.eventTimeMs));
      continue;
    }
    const d = input.memberDay.get(n.feedId);
    if (!d) fail(`${n.feedId} is outside the unit and has no member day`);
    dayOf.set(n.feedId, d!);
    offUnit.push(n.feedId);
  }

  // One entry per loser, its survivor the live end (a loser folded twice keeps its last reason).
  const byLoser = new Map<string, RemergeMerge>();
  for (const m of merges) {
    if (!ownIds.has(m.loser.feedId)) continue;
    const end = m.loser.state === 'superseded' ? liveEnd(m.loser) : null;
    if (!end) continue;
    byLoser.set(m.loser.feedId, { loser: m.loser.feedId, survivor: end.feedId, reason: m.reason });
  }
  const mergesOut = [...byLoser.values()].sort((a, b) => (a.loser < b.loser ? -1 : 1));
  return {
    merges: mergesOut,
    intoNewer: intoNewer.sort((a, b) => (a.loser < b.loser ? -1 : 1)),
    offUnit: offUnit.sort(),
    dayOf,
    external: external.sort((a, b) => (a.loser < b.loser ? -1 : 1)),
    steps,
    live_before: liveBefore,
    live_after: own.filter((n) => n.state === 'live').length,
  };
}

/** The day files of a unit after remergeNodes: every own event in its day (dayOf), in the day partitions' order (event
 *  time, then feed id), serialized with the review status (REMERGED_FEATURE_OPTS). */
export function remergedDayFiles(own: EventNode[], dayOf: ReadonlyMap<string, string>): Map<string, string> {
  const byDay = new Map<string, EventNode[]>();
  for (const n of own) {
    const d = dayOf.get(n.feedId)!;
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(n);
  }
  const out = new Map<string, string>();
  for (const d of [...byDay.keys()].sort()) {
    const sorted = byDay.get(d)!.sort(byTimeThenId);
    out.set(d, sorted.map((n) => JSON.stringify(nodeToFeature(n, REMERGED_FEATURE_OPTS))).join('\n') + '\n');
  }
  return out;
}

// --- gates (C9) ---

const rowKey = (r: { provider: string; nativeId: string }): string => `${r.provider}:${r.nativeId}`;

/** What the gates compare: taken before remergeNodes changes the unit. */
export interface UnitSnapshot {
  ids: Set<string>;
  keys: Set<string>;
  lines: number;
  anchor: AnchorCounts;
}

/** The ComCat anchor (C9): `u45` distinct `usgs` ids with a row magnitude ≥ 4.5 in live events; `e45` live events
 *  holding one; `welds45` live events holding two such ids that ComCat's own `ids` do not link; `siblings45` live events
 *  holding two such ids that ComCat links (one quake ComCat published under two ids). The same at M6. */
export interface AnchorCounts {
  u45: number;
  e45: number;
  welds45: number;
  siblings45: number;
  u6: number;
  e6: number;
  welds6: number;
  siblings6: number;
}

function usgsLinks(rows: { provider: string; nativeId: string; fields: Record<string, unknown> }[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.provider !== 'usgs') continue;
    const ids = r.fields['ids'];
    const set = out.get(r.nativeId) ?? out.set(r.nativeId, new Set([r.nativeId])).get(r.nativeId)!;
    if (typeof ids === 'string') for (const t of ids.split(',')) if (t.trim()) set.add(t.trim());
  }
  return out;
}

export function anchorCounts(nodes: Iterable<EventNode>): AnchorCounts {
  const c: AnchorCounts = { u45: 0, e45: 0, welds45: 0, siblings45: 0, u6: 0, e6: 0, welds6: 0, siblings6: 0 };
  const u45 = new Set<string>();
  const u6 = new Set<string>();
  for (const n of nodes) {
    if (n.state !== 'live') continue;
    for (const [floor, u, e, weld, sib] of [
      [4.5, u45, 'e45', 'welds45', 'siblings45'],
      [6, u6, 'e6', 'welds6', 'siblings6'],
    ] as const) {
      const rows = n.provenance.filter((r) => r.provider === 'usgs' && r.mag != null && r.mag >= floor - 1e-9);
      if (!rows.length) continue;
      c[e]++;
      for (const r of rows) u.add(r.nativeId);
      if (rows.length < 2) continue;
      // Components of the event's usgs ids under ComCat's own `ids` linkage.
      const links = usgsLinks(rows);
      const ids = [...links.keys()];
      const parent = new Map(ids.map((i) => [i, i]));
      const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
      for (const a of ids) for (const b of ids) if (a < b && (links.get(a)!.has(b) || links.get(b)!.has(a))) parent.set(find(a), find(b));
      const comps = new Set(ids.map(find)).size;
      if (comps > 1) c[weld]++;
      else c[sib]++;
    }
  }
  c.u45 = u45.size;
  c.u6 = u6.size;
  return c;
}

export function snapshotUnit(own: Iterable<EventNode>): UnitSnapshot {
  const ids = new Set<string>();
  const keys = new Set<string>();
  let lines = 0;
  const list = [...own];
  for (const n of list) {
    lines++;
    ids.add(n.feedId);
    for (const r of n.provenance) keys.add(rowKey(r));
  }
  return { ids, keys, lines, anchor: anchorCounts(list) };
}

/** The hard gates of a re-merged unit (C9), checked before anything is uploaded: empty when it may be published. */
export function remergeGateProblems(before: UnitSnapshot, own: EventNode[], res: RemergeResult): string[] {
  const p: string[] = [];
  const push = (m: string): void => {
    if (p.length < 50) p.push(m);
  };
  const ids = new Set(own.map((n) => n.feedId));
  if (ids.size !== own.length) push('a feed id is in the unit twice');
  for (const id of before.ids) if (!ids.has(id)) push(`${id} was lost`);
  for (const id of ids) if (!before.ids.has(id)) push(`${id} was minted`);
  if (own.length !== before.lines) push(`${before.lines} lines in, ${own.length} out`);
  const keys = new Set(own.flatMap((n) => n.provenance.map(rowKey)));
  let lost = 0;
  for (const k of before.keys) if (!keys.has(k)) lost++;
  if (lost) push(`${lost} provenance row(s) lost`);
  const byId = new Map(own.map((n) => [n.feedId, n]));
  const newer = new Set(res.intoNewer.map((x) => x.survivor));
  const external = new Set(res.external.map((x) => x.loser));
  for (const n of own) {
    if (n.state !== 'superseded' || external.has(n.feedId)) continue;
    const to = n.supersededBy ?? '';
    const t = byId.get(to);
    if (t ? t.state !== 'live' : !newer.has(to)) push(`${n.feedId} -> ${to} does not resolve to a live event of the unit or into_newer (or is a chain)`);
  }
  const liveKey = new Map<string, string>();
  for (const n of own) {
    if (n.state !== 'live') continue;
    for (const r of n.provenance) {
      const k = rowKey(r);
      const o = liveKey.get(k);
      if (o && o !== n.feedId) push(`${k} is live in ${o} and ${n.feedId}`);
      liveKey.set(k, n.feedId);
    }
  }
  const a = anchorCounts(own);
  const b = before.anchor;
  if (a.u45 !== b.u45) push(`ComCat anchor: ${b.u45} usgs ids >= M4.5 live before, ${a.u45} after`);
  if (a.u6 !== b.u6) push(`ComCat anchor: ${b.u6} usgs ids >= M6 live before, ${a.u6} after`);
  if (a.welds45 > b.welds45) push(`ComCat anchor: ${a.welds45 - b.welds45} new event(s) holding two ComCat events >= M4.5`);
  if (a.welds6 > b.welds6) push(`ComCat anchor: ${a.welds6 - b.welds6} new event(s) holding two ComCat events >= M6`);
  return p;
}

// --- counts for the review table (scripts/remerge-verify.ts) ---

const NONEQ_CODES = new Set(['km', 'sm', 'kx', 'sx', 'kn', 'sn', 'kr', 'sr', 'qb', 'ls', 'sb']);
const NONEQ_WORDS = ['blast', 'explosion', 'quarry', 'mining', 'mine collapse', 'rock burst', 'rockburst', 'ice quake', 'icequake', 'landslide', 'rockslide', 'rock slide', 'sonic boom', 'collapse', 'avalanche', 'meteor', 'acoustic noise', 'not existing', 'other event', 'volcanic eruption'];
/** A non-earthquake event type (the feed's `type`, any source's vocabulary). */
export function nonEarthquakeType(t: unknown): boolean {
  if (typeof t !== 'string') return false;
  const s = t.trim().toLowerCase();
  return !!s && (NONEQ_CODES.has(s) || NONEQ_WORDS.some((w) => s.includes(w)));
}
/** The 0,0 placeholder some sources publish for an unlocated event (a live line readers exclude, owner decision A2). */
export const zeroPlaceholder = (n: EventNode): boolean => n.lat === 0 && n.lon === 0 && (n.mag == null || n.mag === 0);

export interface MagnitudeCounts {
  live: number;
  superseded: number;
  /** Live earthquakes by the event's magnitude. */
  m45: number;
  m6: number;
  /** By the usgs row's magnitude when the event has one, else the event's ("usgs-anchored"). */
  m45u: number;
  m6u: number;
}

export function magnitudeCounts(nodes: Iterable<EventNode>): MagnitudeCounts {
  const c: MagnitudeCounts = { live: 0, superseded: 0, m45: 0, m6: 0, m45u: 0, m6u: 0 };
  for (const n of nodes) {
    if (n.state === 'superseded') c.superseded++;
    if (n.state !== 'live' || zeroPlaceholder(n)) continue;
    const type = (nodeToFeature(n, { compact: true }) as { properties: { type?: unknown } }).properties.type;
    if (nonEarthquakeType(type)) continue;
    c.live++;
    const m = n.mag;
    const u = n.provenance.find((r) => r.provider === 'usgs' && r.mag != null)?.mag ?? m;
    if (m != null && m >= 4.5 - 1e-9) c.m45++;
    if (m != null && m >= 6 - 1e-9) c.m6++;
    if (u != null && u >= 4.5 - 1e-9) c.m45u++;
    if (u != null && u >= 6 - 1e-9) c.m6u++;
  }
  return c;
}

/** Live M4.5+ earthquakes without a usgs row (the residual over-count a review looks at): `near` those within 120 s and
 *  300 km of a live event holding a usgs row (likely the same quake, kept apart by the rules), `far` the rest. */
export function usgsResidual(nodes: Iterable<EventNode>): { near: number; far: number } {
  const live = [...nodes].filter((n) => n.state === 'live' && !zeroPlaceholder(n));
  const usgs = live.filter((n) => n.provenance.some((r) => r.provider === 'usgs')).sort((a, b) => a.eventTimeMs - b.eventTimeMs);
  const times = usgs.map((n) => n.eventTimeMs);
  let near = 0;
  let far = 0;
  for (const n of live) {
    if (n.mag == null || n.mag < 4.5 - 1e-9 || n.provenance.some((r) => r.provider === 'usgs')) continue;
    const type = (nodeToFeature(n, { compact: true }) as { properties: { type?: unknown } }).properties.type;
    if (nonEarthquakeType(type)) continue;
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! < n.eventTimeMs - 120_000) lo = mid + 1;
      else hi = mid;
    }
    let hit = false;
    for (let i = lo; i < usgs.length && times[i]! <= n.eventTimeMs + 120_000; i++) {
      if (haversineKm(n.lat, n.lon, usgs[i]!.lat, usgs[i]!.lon) <= 300) {
        hit = true;
        break;
      }
    }
    if (hit) near++;
    else far++;
  }
  return { near, far };
}

// --- input normalization (config REMERGE_RULES) ---

export type NormalizeCounts = RowNormalizeCounts;

/**
 * The re-merge's input normalization (REMERGE_RULES 3): row-normalize.ts normalizeRows, the one function the statistics
 * builder uses too (the AFAD rows stored 3 h early re-timed in AFAD-only events, ISC magnitudes by untrusted authors
 * dropped, each changed event's representative re-derived; nothing minted, folded or withdrawn). Replaces the changed
 * nodes in `nodes` (copies) and returns the counts.
 */
export function normalizeUnit(nodes: EventNode[], registry: ProviderConfig[]): NormalizeCounts {
  const res = normalizeRows(nodes, registry);
  for (let i = 0; i < nodes.length; i++) nodes[i] = res.rows[i]!;
  return res.counts;
}
