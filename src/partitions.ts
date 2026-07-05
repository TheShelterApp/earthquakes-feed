import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDELIVR_BASE, SCHEMA_VERSION, dataPaths } from './config.js';
import { featureToNode, nodeToFeature, writeIfChanged } from './bitemporal.js';
import type { EventNode } from './types.js';
import { isoFromMs } from './util.js';

const DOMAIN = 'https://earthquakes-feed.theshelter.app';
/** Recent days also published to Pages as ready-to-render GeoJSON (map time-slider). */
export const PAGES_DAY_WINDOW = 120;
const FROZEN_AFTER_DAYS = 3;

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
 * Includes ALL node states (live/tombstoned/superseded) so the round-trip is lossless;
 * summaries filter to live elsewhere.
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
    const fc = JSON.stringify({
      type: 'FeatureCollection',
      metadata: {
        generated: opts.nowMs,
        generated_iso: isoFromMs(opts.nowMs),
        title: `earthquakes-feed events ${dayKey}`,
        api: '1',
        count: feats.filter((f) => (f as { properties: { feed: { state: string } } }).properties.feed.state === 'live').length,
        age_seconds: ageSeconds,
        schema_version: SCHEMA_VERSION,
      },
      // Pages day file shows live events only (map layer); tombstoned live in the tree file.
      features: feats.filter((f) => (f as { properties: { feed: { state: string } } }).properties.feed.state === 'live'),
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
 *  45-day event_map load, so deep-history (backfilled) days remain discoverable. */
export function manifestPartitions(inv: Inventory, nowMs: number): ManifestPartition[] {
  const today = dayFromMs(nowMs);
  const pagesFloor = dayFromMs(nowMs - PAGES_DAY_WINDOW * 86_400_000);
  const frozenBefore = dayFromMs(nowMs - FROZEN_AFTER_DAYS * 86_400_000);
  return Object.keys(inv)
    .sort()
    .map((date) => {
      const s = inv[date]!;
      const p = dayToPath(date);
      return {
        date,
        path: `events/${p}.ndjson`,
        url: `${JSDELIVR_BASE}@data/events/${p}.ndjson`,
        ...(date >= pagesFloor ? { pages_url: `${DOMAIN}/v1/events/${date}.geojson` } : {}),
        count: s.count,
        bytes: s.bytes,
        min_mag: s.min_mag,
        max_mag: s.max_mag,
        frozen: date < frozenBefore && date !== today,
      };
    });
}
