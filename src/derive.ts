import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
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
}

const NOTICE =
  'Aggregated by earthquakes-feed (https://earthquakes-feed.theshelter.app). Per-source attribution in each feature properties.feed.provenance[]. Sources include USGS/ANSS (public domain), EMSC/CSEM and FDSN networks (CC-BY-4.0).';

const write = (dirs: string[], name: string, data: string | Buffer): void => {
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), data);
  }
};

function summaries(feats: Feat[], nowMs: number, feedDirs: string[]): Record<string, { path: string; url: string; count: number }> {
  const out: Record<string, { path: string; url: string; count: number }> = {};
  for (const [wKey, wMs] of Object.entries(SUMMARY_WINDOWS)) {
    for (const [tKey, tVal] of Object.entries(SUMMARY_THRESHOLDS)) {
      const name = `${tKey}_${wKey}`;
      // Cap the sub-M1 monthly firehose (design §4.5) so files stay servable.
      const minMag = tKey === 'all' && wKey === 'month' ? 1.0 : tVal;
      const picked = feats.filter(
        (f) => nowMs - f.timeMs <= wMs && (minMag == null || (f.mag != null && f.mag >= minMag)),
      );
      picked.sort((a, b) => b.timeMs - a.timeMs);
      const fc = {
        type: 'FeatureCollection',
        metadata: {
          generated: isoFromMs(nowMs),
          title: `earthquakes-feed ${name}`,
          count: picked.length,
          schema_version: SCHEMA_VERSION,
          attribution: NOTICE,
        },
        features: picked.map((f) => f.feature),
      };
      write(feedDirs, `${name}.geojson`, JSON.stringify(fc));
      out[name] = { path: `v1/${name}.geojson`, url: `https://earthquakes-feed.theshelter.app/v1/${name}.geojson`, count: picked.length };
    }
  }
  return out;
}

function partitions(feats: Feat[], root: string): unknown[] {
  const byDay = new Map<string, Feat[]>();
  for (const f of feats) {
    const d = new Date(f.timeMs);
    const key = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(f);
  }
  const p = dataPaths(root);
  const list: unknown[] = [];
  for (const [key, dayFeats] of [...byDay.entries()].sort()) {
    dayFeats.sort((a, b) => a.timeMs - b.timeMs);
    const ndjson = dayFeats.map((f) => JSON.stringify(f.feature)).join('\n') + '\n';
    const gz = gzipSync(Buffer.from(ndjson), { level: 9 });
    const file = join(p.eventsDir, `${key}.ndjson.gz`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, gz);
    const mags = dayFeats.map((f) => f.mag).filter((m): m is number => m != null);
    list.push({
      date: key.replace(/\//g, '-'),
      path: `events/${key}.ndjson.gz`,
      url: `${JSDELIVR_BASE}@data/events/${key}.ndjson.gz`,
      count: dayFeats.length,
      bytes: gz.length,
      min_mag: mags.length ? Math.min(...mags) : null,
      max_mag: mags.length ? Math.max(...mags) : null,
    });
  }
  return list;
}

function main(): void {
  const nowMs = Date.now();
  const state = loadState(DATA_DIR);
  const live = [...state.eventMap.values()].filter((n: EventNode) => n.state === 'live');
  const feats: Feat[] = live.map((n) => ({ feature: nodeToFeature(n), timeMs: n.eventTimeMs, mag: n.mag }));

  const feedDirs = [dataPaths(DATA_DIR).feedDir, join(PUBLIC_DIR, 'v1')];
  const summ = summaries(feats, nowMs, feedDirs);
  const parts = partitions(feats, DATA_DIR);

  const manifest = {
    schema_version: SCHEMA_VERSION,
    generated: isoFromMs(nowMs),
    head_seq: state.head.seq,
    data_repo: REPO,
    jsdelivr_base: `${JSDELIVR_BASE}@data`,
    event_count: live.length,
    summaries: summ,
    partitions: parts,
  };
  write(feedDirs, 'manifest.json', JSON.stringify(manifest, null, 2));

  console.log(`derive: live=${live.length} summaries=${Object.keys(summ).length} partitions=${parts.length}`);
}

main();
