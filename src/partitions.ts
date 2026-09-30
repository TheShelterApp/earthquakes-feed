import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDELIVR_BASE, LIVE_INDEX_DAYS, RETIRED_VISIBLE_MS, SCHEMA_VERSION, dataPaths } from './config.js';
import { featureToNode, nodeToFeature, writeIfChanged } from './bitemporal.js';
import type { EventNode } from './types.js';
import { isoFromMs } from './util.js';

const DOMAIN = 'https://earthquakes-feed.theshelter.app';
/** Recent days also published to Pages as ready-to-render GeoJSON (map time-slider). */
export const PAGES_DAY_WINDOW = 120;
/** A day partition is flagged `frozen` (R2 serves it as immutable, and consumers pin it to
 *  `@<data_commit>` and cache it forever) only once the 5-minute aggregate can no longer touch it.
 *  aggregate loads the event_map shards of the last LIVE_INDEX_DAYS event-days, and any day it
 *  loads can still change: a revision or upstream delete of a known id (the updatedafter and
 *  includedeleted sweeps), a provider's zeroed withdrawal, and since PF-5a a ComCat event first
 *  published days after its origin (minted into its origin day while that is inside the 7-day hot
 *  window). Until 2026-09-30 this was 3 days, so a day kept changing for a week after the manifest
 *  had called it frozen. Deliberate one-off passes still reach older days: a new HEAL_EPOCH and a
 *  new source's onboarding / backfill. */
export const FROZEN_AFTER_DAYS = LIVE_INDEX_DAYS;

export interface PartStat {
  count: number;
  bytes: number;
  min_mag: number | null;
  max_mag: number | null;
}
export type Inventory = Record<string, PartStat>;

const dayToPath = (dayKey: string): string => dayKey.replace(/-/g, '/');
const dayFromMs = (ms: number): string => isoFromMs(ms).slice(0, 10);

export const dayPartitionFile = (root: string, dayKey: string): string =>
  join(dataPaths(root).eventsDir, `${dayToPath(dayKey)}.ndjson`);

/** A retired node — superseded by an op:merge, or tombstoned — that the live surfaces (Pages
 *  day file, rolling summaries) still publish, compact and flagged non-live: within
 *  RETIRED_VISIBLE_MS of its last ingest (the fold or the withdrawal). A poller that treats
 *  absence as "still there" must see the removal once; after that the tree partition alone
 *  keeps it. Tombstones were kept off these files until 2026-09-28, while the alerts gateway's
 *  pages_url path still read them without checking `feed.state`; it filters non-live features
 *  now (platform d321b76), so a deleted event is republished as a removal, never as a quake. */
export const publishesRetired = (n: EventNode, nowMs: number): boolean =>
  n.state !== 'live' && nowMs - Date.parse(n.lastIngestTime) <= RETIRED_VISIBLE_MS;

/** Read an existing day partition back into nodes (the backfill transient index). */
export function readDayPartitionNodes(root: string, dayKey: string): EventNode[] {
  const file = dayPartitionFile(root, dayKey);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => featureToNode(JSON.parse(l)));
}

/**
 * Write one UTC day's partition: plain NDJSON in the tree (git delta-compresses text,
 * byte-compare avoids churn) plus, for recent days, a ready-to-render GeoJSON on Pages.
 * Includes ALL node states (live/tombstoned/superseded) so the round-trip is lossless.
 * The Pages day file carries the live events full-fat plus, in compact form, the recently
 * retired ones (superseded or tombstoned) flagged non-live (publishesRetired) — the summaries
 * follow the same rule.
 */
export function writeDayPartition(
  root: string,
  dayKey: string,
  nodes: EventNode[],
  opts: { publicV1?: string; nowMs: number; headIngestTime: string },
): { written: boolean; stat: PartStat } {
  const sorted = [...nodes].sort((a, b) => a.eventTimeMs - b.eventTimeMs || (a.feedId < b.feedId ? -1 : 1));
  const feats = sorted.map((n) => nodeToFeature(n));
  const ndjson = feats.map((f) => JSON.stringify(f)).join('\n') + (feats.length ? '\n' : '');
  const written = writeIfChanged(dayPartitionFile(root, dayKey), ndjson);

  if (opts.publicV1 && dayKey >= dayFromMs(opts.nowMs - PAGES_DAY_WINDOW * 86_400_000)) {
    const ageSeconds = opts.headIngestTime ? Math.max(0, Math.round((opts.nowMs - Date.parse(opts.headIngestTime)) / 1000)) : null;
    // Pages day file (map layer): live events full-fat; a recently retired one (superseded or
    // tombstoned) rides along compact and non-live so a poller sees the removal; older retired
    // ones stay in the tree file only.
    const published: unknown[] = [];
    let live = 0;
    sorted.forEach((n, i) => {
      if (n.state === 'live') {
        published.push(feats[i]);
        live++;
      } else if (publishesRetired(n, opts.nowMs)) {
        published.push(nodeToFeature(n, { compact: true }));
      }
    });
    const fc = JSON.stringify({
      type: 'FeatureCollection',
      metadata: {
        generated: opts.nowMs,
        generated_iso: isoFromMs(opts.nowMs),
        title: `earthquakes-feed events ${dayKey}`,
        api: '1',
        // Live events only — the retired markers in `features` are not counted.
        count: live,
        age_seconds: ageSeconds,
        schema_version: SCHEMA_VERSION,
      },
      features: published,
    });
    writeIfChanged(join(opts.publicV1, 'events', `${dayKey}.geojson`), fc);
  }

  const mags = sorted.map((n) => n.mag).filter((m): m is number => m != null);
  return {
    written,
    stat: { count: nodes.length, bytes: Buffer.byteLength(ndjson), min_mag: mags.length ? Math.min(...mags) : null, max_mag: mags.length ? Math.max(...mags) : null },
  };
}

export function loadInventory(root: string): Inventory {
  const f = dataPaths(root).partitionsIndex;
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Inventory) : {};
}

export function saveInventory(root: string, inv: Inventory): void {
  const sorted: Inventory = {};
  for (const k of Object.keys(inv).sort()) sorted[k] = inv[k]!;
  writeIfChanged(dataPaths(root).partitionsIndex, JSON.stringify(sorted) + '\n');
}

export interface ManifestPartition {
  date: string;
  path: string;
  url: string;
  pages_url?: string;
  count: number;
  bytes: number;
  min_mag: number | null;
  max_mag: number | null;
  frozen: boolean;
}

/** Full partition catalog for the manifest — from the durable inventory, not the
 *  45-day event_map load, so deep-history (backfilled) days remain discoverable.
 *
 *  `pagesDays` = the days whose GeoJSON day file was actually written into public/ by
 *  THIS run. Each Direct Upload deploy is a full snapshot — files not in it 404 — so
 *  pages_url is advertised ONLY for those days (previously the whole 120-day window was
 *  advertised while only the ~45-day event-map load existed on Pages: 104/121 were 404s).
 *  Older days resolve through `url` (jsDelivr NDJSON, full-fat). */
export function manifestPartitions(inv: Inventory, nowMs: number, pagesDays?: ReadonlySet<string>): ManifestPartition[] {
  const today = dayFromMs(nowMs);
  const pagesFloor = dayFromMs(nowMs - PAGES_DAY_WINDOW * 86_400_000);
  const frozenBefore = dayFromMs(nowMs - FROZEN_AFTER_DAYS * 86_400_000);
  return Object.keys(inv)
    .sort()
    .map((date) => {
      const s = inv[date]!;
      const p = dayToPath(date);
      const onPages = pagesDays ? pagesDays.has(date) : date >= pagesFloor;
      return {
        date,
        path: `events/${p}.ndjson`,
        url: `${JSDELIVR_BASE}@data/events/${p}.ndjson`,
        ...(onPages && date >= pagesFloor ? { pages_url: `${DOMAIN}/v1/events/${date}.geojson` } : {}),
        count: s.count,
        bytes: s.bytes,
        min_mag: s.min_mag,
        max_mag: s.max_mag,
        frozen: date < frozenBefore && date !== today,
      };
    });
}
