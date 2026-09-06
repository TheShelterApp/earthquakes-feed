import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA_DIR,
  EVENT_MAP_HORIZON_DAYS,
  JSDELIVR_BASE,
  MAX_PUBLISHED_BYTES,
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
import { enrichStatusV2, updateProviderHealth, type AggregateStatus, type ProviderHealth } from './status-v2.js';
import { appendChanges } from './changes.js';
import { FRESHNESS_EXPECTED_INTERVAL_SECONDS, FRESHNESS_STALE_AFTER_SECONDS } from './freshness.js';

interface Feat {
  feature: unknown;
  timeMs: number;
  mag: number | null;
  sig: number | null;
}

const DOMAIN = 'https://earthquakes-feed.theshelter.app';
/** Reject future-timestamped events (adapter timezone bugs) beyond this leeway. */
const FUTURE_LEEWAY_MS = 10 * 60_000;

/** Magnitude rungs the size guard climbs; a file only ever escalates above its own name. */
const MAG_LADDER = [1.0, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
/** Shed below the validator's cap, not at it — a file that only just fits is tomorrow's outage. */
const SIZE_CEILING = MAX_PUBLISHED_BYTES * 0.9;
/** Growth is visible here, ~months before it becomes a failed run. */
const SIZE_WARN = MAX_PUBLISHED_BYTES * 0.75;

const NOTICE =
  'Aggregated by earthquakes-feed (https://earthquakes-feed.theshelter.app). Per-source attribution and each provider\'s full solution are in properties.feed.provenance[] of the day files (/v1/events/) and NDJSON partitions; summaries are compact. Sources include USGS/ANSS (public domain), EMSC/CSEM and FDSN networks (CC-BY-4.0).';

function collectionJson(name: string, feats: Feat[], nowMs: number, headIngestTime: string, minMag?: number | null, truncated = false): string {
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
      // Effective magnitude floor of THIS file (may exceed the name's threshold — month
      // files are floored at M≥2.5 to stay servable). Absent = no floor.
      ...(minMag != null ? { min_mag: minMag } : {}),
      // Set only when the size budget forced dropping the OLDEST features (see summaries()):
      // the window is short by design, and consumers can see it instead of guessing.
      ...(truncated ? { truncated: true } : {}),
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
      const sig = tKey === 'significant';
      // Month-window floor (design §4.5): at 38 sources a saturated 30-day M≥1.0 window is
      // ~25 MB even compact — past the Pages 25 MiB hard limit. Floor month files at M≥2.5
      // (mirrored in metadata.min_mag); denser slices live in the per-day files/partitions.
      const minMag = wKey === 'month' && !sig ? Math.max(tVal ?? 2.5, 2.5) : tVal;
      const pick = (floor: number | null): Feat[] =>
        feats
          .filter((f) => nowMs - f.timeMs <= wMs && (sig ? isSignificant(f) : floor == null || (f.mag != null && f.mag >= floor)))
          .sort((a, b) => b.timeMs - a.timeMs);

      let picked = pick(minMag);
      let json = collectionJson(name, picked, nowMs, headIngestTime, sig ? null : minMag);
      let bytes = Buffer.byteLength(json);
      // The size gate lives in the validator, which runs BEFORE the data commit and the Pages
      // deploy — one oversized file kills the whole job (2026-07-14: the roster grew 29→38 and
      // 51 consecutive derive runs failed for ~4h with nothing published at all). So shed here
      // instead: climb one rung above this file's own floor until it fits, and report where we
      // landed in metadata.min_mag so the file stays self-describing. all_week is the exposed
      // one — no name floor at all, so an M0+ aftershock swarm lands on it undiluted.
      let floor = minMag;
      for (const rung of sig ? [] : MAG_LADDER.filter((m) => m > (minMag ?? 0))) {
        if (bytes <= SIZE_CEILING) break;
        floor = rung;
        picked = pick(floor);
        json = collectionJson(name, picked, nowMs, headIngestTime, floor);
        bytes = Buffer.byteLength(json);
      }
      // `significant` is a sig≥600||M≥6 predicate, not a floor, so no ladder applies to it — and
      // a pathological week can outrun even M≥5.0. Last resort: keep the newest slice of the
      // already time-sorted set and flag it, since a visibly short window beats a silent one.
      let truncated = false;
      while (picked.length && bytes > SIZE_CEILING) {
        picked = picked.slice(0, Math.min(picked.length - 1, Math.floor(picked.length * (SIZE_CEILING / bytes))));
        truncated = true;
        json = collectionJson(name, picked, nowMs, headIngestTime, sig ? null : floor, true);
        bytes = Buffer.byteLength(json);
      }
      if (truncated) console.warn(`::warning::v1/${name}.geojson truncated to the newest ${picked.length} feature(s) to fit ${MAX_PUBLISHED_BYTES} bytes`);
      else if (bytes > SIZE_WARN) {
        console.warn(`::warning::v1/${name}.geojson is ${bytes} bytes — ${((bytes / MAX_PUBLISHED_BYTES) * 100).toFixed(1)}% of the ${MAX_PUBLISHED_BYTES}-byte budget`);
      }
      writeIfChanged(join(publicV1, `${name}.geojson`), json);
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
    // v2 manifest (signed envelope, ~KBs): clients revalidate with ETag, the edge absorbs it.
    '/v2/*',
    '  Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=120, stale-if-error=86400',
    '  Access-Control-Allow-Origin: *',
    // change-log: tailed with Range from the last byte offset; short edge cache, Range-friendly.
    '/v1/changes/*',
    '  Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400',
    '  Access-Control-Allow-Origin: *',
    '',
  ].join('\n');
}

function main(): void {
  const nowMs = Date.now();
  const state = loadState(DATA_DIR, { sinceDays: EVENT_MAP_HORIZON_DAYS, nowMs });
  const publicV1 = join(PUBLIC_DIR, 'v1');
  const allNodes = [...state.eventMap.values()];

  // Summaries: live events only, no future timestamps. Compact features (no provenance[])
  // — the full superset stays in the day files/partitions written below.
  const liveFeats: Feat[] = allNodes
    .filter((n: EventNode) => n.state === 'live' && n.eventTimeMs <= nowMs + FUTURE_LEEWAY_MS)
    .map((n) => {
      const feature = nodeToFeature(n, { compact: true }) as { properties: { mag: number | null; sig: number | null } };
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
  // Days whose Pages day file exists in THIS deploy snapshot (drives truthful pages_url).
  const pagesDays = new Set(byDay.keys());

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
      partitions: manifestPartitions(inv, nowMs, pagesDays),
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
  const paths = dataPaths(DATA_DIR);
  if (existsSync(paths.status)) {
    const raw = JSON.parse(readFileSync(paths.status, 'utf8')) as AggregateStatus;
    const generatedMs = Date.parse(raw.generated) || nowMs;
    // SD-E3: per-provider last-success history lives here (derive-owned), so lag is real.
    const prevHealth: ProviderHealth = existsSync(paths.providerHealth) ? (JSON.parse(readFileSync(paths.providerHealth, 'utf8')) as ProviderHealth) : {};
    const health = updateProviderHealth(prevHealth, raw.providers, generatedMs);
    writeIfChanged(paths.providerHealth, JSON.stringify(health) + '\n');
    const v2 = enrichStatusV2(raw, {
      generatedMs,
      expectedIntervalSeconds: FRESHNESS_EXPECTED_INTERVAL_SECONDS,
      staleAfterSeconds: FRESHNESS_STALE_AFTER_SECONDS,
      health,
      ...(process.env.RUN_ID ? { runId: process.env.RUN_ID } : {}),
    });
    writeIfChanged(join(publicV1, 'status.json'), JSON.stringify(v2, null, 2));
  }

  // SD-E3: append the idempotent change-log for this run (fan-out reads this, not state).
  const changesDay = isoFromMs(nowMs).slice(0, 10);
  const cursor = existsSync(paths.changesCursor) ? (JSON.parse(readFileSync(paths.changesCursor, 'utf8')) as { seq: number }).seq : 0;
  const changesFile = join(paths.changesDir, `${changesDay}.ndjson`);
  const changed = appendChanges(changesFile, allNodes, cursor);
  if (changed.appended > 0) {
    writeIfChanged(paths.changesCursor, JSON.stringify({ seq: changed.cursor, day: changesDay }) + '\n');
    // Mirror the day's change-log to Pages/R2 for hot tailing (Range from the last byte).
    mkdirSync(join(publicV1, 'changes'), { recursive: true });
    writeFileSync(join(publicV1, 'changes', `${changesDay}.ndjson`), readFileSync(changesFile));
  }
  console.log(`derive: status v2 + changes appended=${changed.appended} (seq→${changed.cursor})`);

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
