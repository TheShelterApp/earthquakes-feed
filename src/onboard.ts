import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { FETCH_LIMIT, QUERY_LOOKBACK_MS, dataPaths } from './config.js';
import { backfillCfg } from './backfill-cfg.js';
import { eventDayKey, loadEventMap, saveEventMap } from './bitemporal.js';
import { Resolver } from './dedup.js';
import { configMap, fetchProviderWindow, priorityMap, type WindowOutcome } from './providers.js';
import type { Head, ProviderConfig } from './types.js';

const DAY = 86_400_000;
const ONBOARD_CHUNK_DAYS = Number(process.env.ONBOARD_CHUNK_DAYS ?? 7);

interface Pending {
  recentBackTo: string; // walks back from now-lookback toward liveDay
  windowDays: number;
}
interface OnboardState {
  onboarded: string[];
  pending: Record<string, Pending>;
}

const dayStartMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);

type FetchWindow = (p: ProviderConfig, startMs: number, endMs: number, minmag?: number) => Promise<WindowOutcome>;

export interface OnboardResult {
  bootstrapped?: boolean;
  provider?: string;
  filledFrom?: string;
  changed?: number;
  done?: boolean;
  overflow?: boolean;
  note?: string;
}

/**
 * Fill the recent LIVE window [liveDay, now-QUERY_LOOKBACK] for a newly-added source, so it
 * has NO coverage gap between the live 2-day path and deep backfill. One paced chunk per run:
 * fetch the chunk, load the event_map shards it spans, dedup-merge the new source in
 * (load-merge-save — never clobbers aggregate's concurrent live updates), save. Writes only
 * event_map shards ≥ liveDay (never moves the boundary); derive rebuilds their partitions.
 * Marker-seq only (no log append / seq advance), like deep backfill, so it can't bloat the
 * log or break the head.seq/M4 invariant. Bootstrap seeds the current sources as already-
 * onboarded (they grew with the live window from day one); only LATER additions get filled.
 */
export async function onboardStep(
  root: string,
  all: ProviderConfig[],
  providers: ProviderConfig[],
  liveDay: string,
  nowMs: number,
  ingestTime: string,
  fetchWindow: FetchWindow = fetchProviderWindow,
): Promise<OnboardResult> {
  const f = dataPaths(root).onboardCursor;
  mkdirSync(dataPaths(root).indexDir, { recursive: true });
  const eligible = providers.filter((p) => backfillCfg(p) != null).map((p) => p.id);

  if (!existsSync(f)) {
    const st: OnboardState = { onboarded: eligible, pending: {} };
    writeFileSync(f, JSON.stringify(st, null, 2) + '\n');
    return { bootstrapped: true };
  }

  const st = JSON.parse(readFileSync(f, 'utf8')) as OnboardState;
  const recentCeilMs = nowMs - QUERY_LOOKBACK_MS; // the live path owns [now-lookback, now]
  const recentCeilDay = eventDayKey(recentCeilMs);

  // Detect newly-added eligible sources → queue them for recent-window fill.
  for (const id of eligible) {
    if (!st.onboarded.includes(id) && !(id in st.pending)) {
      const cfg = backfillCfg(providers.find((p) => p.id === id)!)!;
      st.pending[id] = { recentBackTo: recentCeilDay, windowDays: cfg.initialWindowDays };
    }
  }

  const save = (): void => writeFileSync(f, JSON.stringify(st, null, 2) + '\n');
  const pendingIds = Object.keys(st.pending).sort();
  if (!pendingIds.length) {
    save();
    return { note: 'nothing pending' };
  }

  // One pending source, one paced chunk this run.
  const id = pendingIds[0]!;
  const p = providers.find((x) => x.id === id);
  const cfg = p ? backfillCfg(p) : null;
  const cur = st.pending[id]!;
  if (!p || !cfg) {
    delete st.pending[id];
    save();
    return { provider: id, note: 'no longer eligible; dropped' };
  }

  const endMs = Math.min(dayStartMs(cur.recentBackTo), recentCeilMs);
  const startMs = Math.max(dayStartMs(liveDay), endMs - cur.windowDays * DAY);
  if (startMs >= endMs) {
    // Reached the live-owned floor: recent window complete. Deep backfill (its cursor is at
    // liveDay) continues older history from here — contiguous, no gap.
    st.onboarded.push(id);
    delete st.pending[id];
    save();
    return { provider: id, done: true };
  }

  const res = await fetchWindow(p, startMs, endMs, cfg.minmag);
  // Overflow with room to narrow: shrink and retry next run (ingest nothing this run).
  if (res.overflow && cur.windowDays > 1) {
    cur.windowDays = Math.max(1, Math.floor(cur.windowDays / 2));
    save();
    return { provider: id, overflow: true, note: `narrowed to ${cur.windowDays}d` };
  }
  if (!res.status.ok) {
    save();
    return { provider: id, note: `fetch failed: ${res.status.error ?? 'unknown'}` };
  }

  // Load the event_map shards spanning the chunk, merge the source in, save (load-merge-save).
  const sinceDays = Math.ceil((nowMs - startMs) / DAY) + 2;
  const map = loadEventMap(root, { sinceDays, nowMs });
  const resolver = new Resolver(map, priorityMap(all), configMap(all), nowMs, { hotFloorMs: 0 });
  const head = JSON.parse(readFileSync(dataPaths(root).head, 'utf8')) as Head;
  const liveFloorMs = dayStartMs(liveDay);
  const raws = res.obs
    .filter((o) => o.eventTimeMs >= liveFloorMs)
    .sort(
      (a, b) =>
        a.eventTimeMs - b.eventTimeMs ||
        (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
        (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0),
    );
  let changed = 0;
  for (const raw of raws) {
    const r = resolver.ingest(raw, ingestTime);
    if (r.changed) {
      r.node.lastSeq = head.seq;
      if (r.node.firstSeenSeq < 0) r.node.firstSeenSeq = head.seq;
      changed++;
    }
  }
  saveEventMap(root, map);

  cur.recentBackTo = eventDayKey(startMs);
  // Saturated day (overflow even at 1-day): accept partial + reset window; else grow when sparse.
  if (res.overflow) cur.windowDays = cfg.initialWindowDays;
  else if (res.obs.length < 0.3 * FETCH_LIMIT) cur.windowDays = Math.min(cfg.maxWindowDays, Math.ceil(cur.windowDays * 1.5));
  save();
  return { provider: id, filledFrom: cur.recentBackTo, changed, overflow: res.overflow };
}
