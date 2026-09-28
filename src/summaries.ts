import { join } from 'node:path';
import { MAX_PUBLISHED_BYTES, SCHEMA_VERSION, SUMMARY_THRESHOLDS, SUMMARY_WINDOWS } from './config.js';
import { nodeToFeature, writeIfChanged } from './bitemporal.js';
import { publishesRetired } from './partitions.js';
import type { EventNode } from './types.js';
import { isoFromMs } from './util.js';

/** The rolling summaries (`v1/<threshold>_<window>.geojson`), written by derive. */

export interface Feat {
  feature: unknown;
  timeMs: number;
  mag: number | null;
  sig: number | null;
  /** false = a retired marker (superseded or tombstoned) published non-live (publishesRetired), not counted. */
  live: boolean;
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
      // Live events only — the retired markers in `features` are not counted.
      count: feats.filter((f) => f.live).length,
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

/** The rolling summaries' candidates: every live event plus, flagged non-live, the ones retired
 *  (superseded by an op:merge, or tombstoned) in the last RETIRED_VISIBLE_MS (publishesRetired),
 *  with no future timestamps. Compact features (no provenance[]). */
export function summaryFeats(nodes: Iterable<EventNode>, nowMs: number): Feat[] {
  const out: Feat[] = [];
  for (const n of nodes) {
    if (!(n.state === 'live' || publishesRetired(n, nowMs)) || n.eventTimeMs > nowMs + FUTURE_LEEWAY_MS) continue;
    const feature = nodeToFeature(n, { compact: true }) as { properties: { mag: number | null; sig: number | null } };
    out.push({ feature, timeMs: n.eventTimeMs, mag: feature.properties.mag, sig: feature.properties.sig, live: n.state === 'live' });
  }
  return out;
}

const isSignificant = (f: Feat): boolean => (f.sig != null && f.sig >= 600) || (f.mag != null && f.mag >= 6);

export function summaries(feats: Feat[], nowMs: number, publicV1: string, headIngestTime: string): Record<string, { path: string; url: string; count: number }> {
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
      // Live events only, like metadata.count — the retired markers ride along uncounted.
      out[name] = { path: `v1/${name}.geojson`, url: `${DOMAIN}/v1/${name}.geojson`, count: picked.filter((f) => f.live).length };
    }
  }
  return out;
}
