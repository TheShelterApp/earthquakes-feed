import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA_DIR,
  EVENT_MAP_HORIZON_DAYS,
  JSDELIVR_BASE,
  PUBLIC_DIR,
  REPO,
  SCHEMA_VERSION,
  SUMMARY_THRESHOLDS,
  SUMMARY_WINDOWS,
  dataPaths,
} from './config.js';
import { loadState, nodeToFeature, pruneEventMapShards, writeIfChanged } from './bitemporal.js';
import {
  loadInventory,
  manifestPartitions,
  saveInventory,
  writeDayPartition,
  type Inventory,
} from './partitions.js';
import type { EventNode } from './types.js';
import { eventDayKey } from './bitemporal.js';
import { isoFromMs } from './util.js';

interface Feat {
  feature: unknown;
  timeMs: number;
  mag: number | null;
  sig: number | null;
}

const DOMAIN = 'https://earthquakes-feed.theshelter.app';
/** Reject future-timestamped events (adapter timezone bugs) beyond this leeway. */
const FUTURE_LEEWAY_MS = 10 * 60_000;

const NOTICE =
  'Aggregated by earthquakes-feed (https://earthquakes-feed.theshelter.app). Per-source attribution in each feature properties.feed.provenance[]. Sources include USGS/ANSS (public domain), EMSC/CSEM and FDSN networks (CC-BY-4.0).';

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
  const state = loadState(DATA_DIR, { sinceDays: EVENT_MAP_HORIZON_DAYS, nowMs });
  const publicV1 = join(PUBLIC_DIR, 'v1');
  const allNodes = [...state.eventMap.values()];

  // Summaries: live events only, no future timestamps.
  const liveFeats: Feat[] = allNodes
    .filter((n: EventNode) => n.state === 'live' && n.eventTimeMs <= nowMs + FUTURE_LEEWAY_MS)
    .map((n) => {
      const feature = nodeToFeature(n) as { properties: { mag: number | null; sig: number | null } };
      return { feature, timeMs: n.eventTimeMs, mag: feature.properties.mag, sig: feature.properties.sig };
    });
  const summ = summaries(liveFeats, nowMs, publicV1, state.head.ingest_time);

  // Partitions: every state, one file per event-day, only for the days we loaded.
  const byDay = new Map<string, EventNode[]>();
  for (const n of allNodes) (byDay.get(eventDayKey(n.eventTimeMs)) ?? byDay.set(eventDayKey(n.eventTimeMs), []).get(eventDayKey(n.eventTimeMs))!).push(n);
  const inv: Inventory = loadInventory(DATA_DIR);
  let rewritten = 0;
  for (const [day, nodes] of byDay) {
    const { written, stat } = writeDayPartition(DATA_DIR, day, nodes, { publicV1, nowMs, headIngestTime: state.head.ingest_time });
    if (written) rewritten++;
    inv[day] = stat;
  }
  saveInventory(DATA_DIR, inv);

  const manifest = JSON.stringify(
    {
      schema_version: SCHEMA_VERSION,
      generated: nowMs,
      generated_iso: isoFromMs(nowMs),
      head_seq: state.head.seq,
      event_count: liveFeats.length,
      freshness: { expected_interval_seconds: 300, stale_after_seconds: 1800 },
      data_repo: REPO,
      jsdelivr_base: `${JSDELIVR_BASE}@data`,
      // Injected post-commit into the Pages manifest (derive.yml). For an immutable copy
      // of any frozen partition: `${jsdelivr_base%@data}@<data_commit>/<partition.path>`.
      data_commit: null,
      summaries: summ,
      partitions: manifestPartitions(inv, nowMs),
      archives: loadArchives(),
    },
    null,
    2,
  );
  writeIfChanged(join(publicV1, 'manifest.json'), manifest);
  writeIfChanged(join(DATA_DIR, 'manifest.json'), manifest);
  writeIfChanged(join(PUBLIC_DIR, '_headers'), headers(eventDayKey(nowMs)));

  // Publish the last aggregate's per-provider health onto Pages so /v1/status.json is a
  // real endpoint (documented in APIs.md, read by the health watchdog). It's written to
  // DATA_DIR by aggregate; without this copy it only lived on the data branch → 404.
  const statusSrc = dataPaths(DATA_DIR).status;
  if (existsSync(statusSrc)) writeIfChanged(join(publicV1, 'status.json'), readFileSync(statusSrc, 'utf8'));

  const pruned = pruneEventMapShards(DATA_DIR, nowMs - EVENT_MAP_HORIZON_DAYS * 86_400_000);

  console.log(
    `derive: live=${liveFeats.length} summaries=${Object.keys(summ).length} partitions=${byDay.size} rewritten=${rewritten}` +
      (pruned.length ? ` pruned_shards=${pruned.length}` : ''),
  );
}

/** Archive catalog (regenerated from archives.json, source of truth written by archive.ts). */
function loadArchives(): unknown[] {
  const f = dataPaths(DATA_DIR).archivesIndex;
  if (!existsSync(f)) return [];
  return (JSON.parse(readFileSync(f, 'utf8')) as { list?: unknown[] }).list ?? [];
}

main();
