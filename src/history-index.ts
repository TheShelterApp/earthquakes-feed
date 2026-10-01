import { type HistoryConfig, type Period, allPeriods, dayKeyOf } from './history-config.js';

/**
 * Deep history (PF-5j): `knowledge/index/history.json` on the `data` branch, the only file history adds there. It
 * lists every raw asset and every events edition in the `history-YYYY` Releases with its checksum and counts, so a
 * consumer finds the deep months without listing Releases, and the walk knows where it stands. It mirrors the
 * Releases: an asset uploaded by a run whose index commit never landed is found and adopted by the next run.
 */

export const HISTORY_INDEX_VERSION = 1;

export interface RawEntry {
  source: string;
  period: string;
  tag: string;
  asset: string;
  url: string;
  sha256: string;
  bytes: number;
  rows: number;
  provider_count: number | null;
  start: string;
  end: string;
  fetch_min_magnitude: number | null;
  fetched_at: string;
}

export interface EditionEntry {
  period: string;
  edition: number;
  era: string;
  tag: string;
  asset: string;
  url: string;
  sha256: string;
  bytes: number;
  events: number;
  days: string[];
  sources: string[];
  min_magnitude: number | null;
  /** The raw assets it was built from. */
  built_from: string[];
  /** Where its frozen newer neighbour came from, or null. */
  context: string | null;
  joined_newer: number;
}

/** An asset the walk does not use: left by a failed upload (incomplete or unreadable), or a second copy of a unit
 *  that already has one. Never deleted, never reused: the walk takes the next free name instead. */
export interface UnusedEntry {
  tag: string;
  asset: string;
  reason: string;
  seen_at: string;
}

/** A source month whose fetch failed, until it succeeds (then the entry goes). */
export interface AttemptEntry {
  failures: number;
  since: string;
  last_error: string;
}

export interface HistoryIndex {
  version: typeof HISTORY_INDEX_VERSION;
  boundary: string;
  raw: RawEntry[];
  editions: EditionEntry[];
  unused: UnusedEntry[];
  /** Keyed `<source>:<YYYY-MM>`. */
  attempts: Record<string, AttemptEntry>;
}

export const emptyIndex = (boundary: string): HistoryIndex => ({ version: HISTORY_INDEX_VERSION, boundary, raw: [], editions: [], unused: [], attempts: {} });

/** Stable order (period, then source / edition), so the file's diff per run is the added lines only. */
export function sortIndex(idx: HistoryIndex): HistoryIndex {
  idx.raw.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.source < b.source ? -1 : a.source > b.source ? 1 : a.asset < b.asset ? -1 : 1));
  idx.editions.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.edition - b.edition));
  idx.unused.sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
  idx.attempts = Object.fromEntries(Object.entries(idx.attempts).sort(([a], [b]) => (a < b ? -1 : 1)));
  return idx;
}

/** One line per entry: a run adds lines and changes none of the others. */
export function indexText(idx: HistoryIndex): string {
  const s = sortIndex(idx);
  const list = (xs: unknown[]): string => (xs.length ? `[\n${xs.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]` : '[]');
  const attempts = Object.entries(s.attempts);
  const att = attempts.length ? `{\n${attempts.map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n  }` : '{}';
  return (
    `{\n  "version": ${s.version},\n  "boundary": ${JSON.stringify(s.boundary)},\n  "raw": ${list(s.raw)},\n` +
    `  "editions": ${list(s.editions)},\n  "unused": ${list(s.unused)},\n  "attempts": ${att}\n}\n`
  );
}

export function parseIndex(text: string): HistoryIndex {
  const idx = JSON.parse(text) as HistoryIndex;
  if (idx.version !== HISTORY_INDEX_VERSION) throw new Error(`history index version ${String(idx.version)} is not ${HISTORY_INDEX_VERSION}`);
  idx.unused ??= [];
  idx.attempts ??= {};
  return idx;
}

export const rawOf = (idx: HistoryIndex, source: string, period: string): RawEntry | undefined =>
  idx.raw.find((r) => r.source === source && r.period === period);

export const currentEdition = (idx: HistoryIndex, period: string): EditionEntry | undefined =>
  idx.editions.filter((e) => e.period === period).sort((a, b) => b.edition - a.edition)[0];

export interface Unit {
  source: string;
  period: Period;
}

/** The source months the walk still has to fetch, newest month first and in the era's source order, so months
 *  complete (and can be sealed) one after another. */
export function pendingUnits(cfg: HistoryConfig, idx: HistoryIndex): Unit[] {
  const out: Unit[] = [];
  for (const p of allPeriods(cfg)) {
    const era = cfg.eras.find((e) => e.id === p.eraId)!;
    for (const s of era.sources) if (!rawOf(idx, s, p.key)) out.push({ source: s, period: p });
  }
  return out;
}

/** True when the period's current edition was built from exactly the raw assets the index lists for its era. */
export function editionIsCurrent(cfg: HistoryConfig, idx: HistoryIndex, p: Period): boolean {
  const e = currentEdition(idx, p.key);
  if (!e) return false;
  const era = cfg.eras.find((x) => x.id === p.eraId)!;
  const raws = era.sources.map((s) => rawOf(idx, s, p.key)?.asset);
  if (raws.some((a) => a == null)) return false;
  return e.built_from.length === raws.length && raws.every((a) => e.built_from.includes(a!));
}

export type Neighbour =
  /** The month ends at the boundary: its newer neighbour is the 3-year layer's first day. */
  | { kind: 'boundary'; day: string }
  /** The newer month is a history month with a current edition. */
  | { kind: 'edition'; day: string; edition: EditionEntry }
  /** The newer month is in no era (a gap): nothing to join. */
  | { kind: 'none' }
  /** The newer month is a history month not yet built: wait. */
  | { kind: 'wait' };

export function newerNeighbour(cfg: HistoryConfig, idx: HistoryIndex, p: Period): Neighbour {
  const day = dayKeyOf(p.endMs);
  if (day === cfg.boundary) return { kind: 'boundary', day };
  const next = allPeriods(cfg).find((q) => q.startMs === p.endMs);
  if (!next) return { kind: 'none' };
  if (!editionIsCurrent(cfg, idx, next)) return { kind: 'wait' };
  return { kind: 'edition', day, edition: currentEdition(idx, next.key)! };
}

/** Periods whose raws are all fetched and whose current edition is missing or stale, newest first. */
export function periodsToSeal(cfg: HistoryConfig, idx: HistoryIndex): Period[] {
  return allPeriods(cfg).filter((p) => {
    const era = cfg.eras.find((e) => e.id === p.eraId)!;
    return era.sources.every((s) => rawOf(idx, s, p.key)) && !editionIsCurrent(cfg, idx, p);
  });
}
