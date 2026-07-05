import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA_DIR,
  JSDELIVR_BASE,
  PUBLIC_DIR,
  REPO,
  SCHEMA_VERSION,
  SUMMARY_THRESHOLDS,
  SUMMARY_WINDOWS,
  dataPaths,
} from './config.js';
import { loadState, nodeToFeature } from './bitemporal.js';
import type { EventNode } from './types.js';
import { isoFromMs } from './util.js';

interface Feat {
  feature: unknown;
  timeMs: number;
  mag: number | null;
  sig: number | null;
}

const DOMAIN = 'https://earthquakes-feed.theshelter.app';
/** Days of per-day GeoJSON published to Pages for the map time-slider. */
const PAGES_DAY_WINDOW = 120;
/** A day older than this is considered frozen (late revisions are rare beyond it). */
const FROZEN_AFTER_DAYS = 3;
/** Reject future-timestamped events (adapter timezone bugs) beyond this leeway. */
const FUTURE_LEEWAY_MS = 10 * 60_000;

const NOTICE =
  'Aggregated by earthquakes-feed (https://earthquakes-feed.theshelter.app). Per-source attribution in each feature properties.feed.provenance[]. Sources include USGS/ANSS (public domain), EMSC/CSEM and FDSN networks (CC-BY-4.0).';

/** Write only when content differs — keeps git blobs and Pages hashes stable. */
function writeIfChanged(file: string, data: string): boolean {
  if (existsSync(file) && readFileSync(file, 'utf8') === data) return false;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, data);
  return true;
}

const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function collectionJson(name: string, feats: Feat[], nowMs: number, headIngestTime: string): string {
  const ageSeconds = headIngestTime ? Math.max(0, Math.round((nowMs - Date.parse(headIngestTime)) / 1000)) : null;
  return JSON.stringify({
    type: 'FeatureCollection',
    metadata: {
      // ms-epoch int (USGS-compatible; the iOS decoder expects Int). ISO mirror alongside.
      generated: nowMs,
      generated_iso: isoFromMs(nowMs),
      title: `earthquakes-feed ${name}`,
      api: '1',
      count: feats.length,
      age_seconds: ageSeconds,
      schema_version: SCHEMA_VERSION,
      attribution: NOTICE,
    },
    features: feats.map((f) => f.feature),
  });
}

const isSignificant = (f: Feat): boolean => (f.sig != null && f.sig >= 600) || (f.mag != null && f.mag >= 6);

function summaries(feats: Feat[], nowMs: number, publicV1: string, headIngestTime: string): Record<string, { path: string; url: string; count: number }> {
  const out: Record<string, { path: string; url: string; count: number }> = {};
  for (const [wKey, wMs] of Object.entries(SUMMARY_WINDOWS)) {
    for (const [tKey, tVal] of Object.entries(SUMMARY_THRESHOLDS)) {
      const name = `${tKey}_${wKey}`;
      // Cap the sub-M1 monthly firehose (design §4.5) so files stay servable.
      const minMag = tKey === 'all' && wKey === 'month' ? 1.0 : tVal;
      const picked = feats.filter(
        (f) =>
          nowMs - f.timeMs <= wMs &&
          (tKey === 'significant' ? isSignificant(f) : minMag == null || (f.mag != null && f.mag >= minMag)),
      );
      picked.sort((a, b) => b.timeMs - a.timeMs);
      writeIfChanged(join(publicV1, `${name}.geojson`), collectionJson(name, picked, nowMs, headIngestTime));
      out[name] = { path: `v1/${name}.geojson`, url: `${DOMAIN}/v1/${name}.geojson`, count: picked.length };
    }
  }
  return out;
}

interface PartitionEntry {
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

function partitions(feats: Feat[], nowMs: number, publicV1: string, headIngestTime: string): { list: PartitionEntry[]; written: number } {
  const byDay = new Map<string, Feat[]>();
  for (const f of feats) {
    const key = dayKey(f.timeMs);
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(f);
  }
  const p = dataPaths(DATA_DIR);
  const today = dayKey(nowMs);
  const pagesFloor = dayKey(nowMs - PAGES_DAY_WINDOW * 86_400_000);
  const frozenBefore = dayKey(nowMs - FROZEN_AFTER_DAYS * 86_400_000);
  const list: PartitionEntry[] = [];
  let written = 0;
  for (const [key, dayFeats] of [...byDay.entries()].sort()) {
    dayFeats.sort((a, b) => a.timeMs - b.timeMs);
    const pathKey = key.replace(/-/g, '/');
    // Committed partition: plain NDJSON (git delta-compresses text; CDNs compress on the wire).
    const ndjson = dayFeats.map((f) => JSON.stringify(f.feature)).join('\n') + '\n';
    if (writeIfChanged(join(p.eventsDir, `${pathKey}.ndjson`), ndjson)) written++;
    // Pages copy for the map time-slider: a ready-to-render GeoJSON FeatureCollection.
    const inPagesWindow = key >= pagesFloor;
    if (inPagesWindow) {
      writeIfChanged(join(publicV1, 'events', `${key}.geojson`), collectionJson(`events ${key}`, dayFeats, nowMs, headIngestTime));
    }
    const mags = dayFeats.map((f) => f.mag).filter((m): m is number => m != null);
    list.push({
      date: key,
      path: `events/${pathKey}.ndjson`,
      url: `${JSDELIVR_BASE}@data/events/${pathKey}.ndjson`,
      ...(inPagesWindow ? { pages_url: `${DOMAIN}/v1/events/${key}.geojson` } : {}),
      count: dayFeats.length,
      bytes: Buffer.byteLength(ndjson),
      min_mag: mags.length ? Math.min(...mags) : null,
      max_mag: mags.length ? Math.max(...mags) : null,
      frozen: key < frozenBefore && key !== today,
    });
  }
  return { list, written };
}

function headers(todayKey: string): string {
  return [
    '/v1/*',
    '  Cache-Control: public, max-age=30, stale-while-revalidate=120',
    '  Access-Control-Allow-Origin: *',
    '/v1/events/*',
    '  Cache-Control: public, max-age=3600',
    '  Access-Control-Allow-Origin: *',
    `/v1/events/${todayKey}.geojson`,
    '  Cache-Control: public, max-age=300, stale-while-revalidate=600',
    '  Access-Control-Allow-Origin: *',
    '',
  ].join('\n');
}

function main(): void {
  const nowMs = Date.now();
  const state = loadState(DATA_DIR);
  const publicV1 = join(PUBLIC_DIR, 'v1');
  const live = [...state.eventMap.values()].filter((n: EventNode) => n.state === 'live');
  const feats: Feat[] = live
    .map((n) => ({
      feature: nodeToFeature(n),
      timeMs: n.eventTimeMs,
      mag: n.mag,
      sig: typeof n.extra['sig'] === 'number' ? (n.extra['sig'] as number) : null,
    }))
    .filter((f) => f.timeMs <= nowMs + FUTURE_LEEWAY_MS);
  const dropped = live.length - feats.length;

  const summ = summaries(feats, nowMs, publicV1, state.head.ingest_time);
  const parts = partitions(feats, nowMs, publicV1, state.head.ingest_time);

  const manifest = JSON.stringify(
    {
      schema_version: SCHEMA_VERSION,
      generated: nowMs,
      generated_iso: isoFromMs(nowMs),
      head_seq: state.head.seq,
      event_count: feats.length,
      freshness: { expected_interval_seconds: 300, stale_after_seconds: 1800 },
      data_repo: REPO,
      jsdelivr_base: `${JSDELIVR_BASE}@data`,
      summaries: summ,
      partitions: parts.list,
      archives: [],
    },
    null,
    2,
  );
  // Canonical manifest on Pages; a copy at the data-branch root for jsDelivr discovery.
  writeIfChanged(join(publicV1, 'manifest.json'), manifest);
  writeIfChanged(join(DATA_DIR, 'manifest.json'), manifest);
  writeIfChanged(join(PUBLIC_DIR, '_headers'), headers(dayKey(nowMs)));

  console.log(
    `derive: live=${feats.length} summaries=${Object.keys(summ).length} partitions=${parts.list.length} rewritten=${parts.written}` +
      (dropped ? ` future_dropped=${dropped}` : ''),
  );
}

main();
