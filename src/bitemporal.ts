import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SCHEMA_VERSION, dataPaths } from './config.js';
import type { EventNode, Head, Observation, State, Watermarks } from './types.js';
import { isoFromMs, round6 } from './util.js';

const readJson = <T>(path: string, fallback: T): T =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;

const ensureDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

export function loadState(root: string): State {
  const p = dataPaths(root);
  const head = readJson<Head>(p.head, { seq: 0, ingest_time: '' });
  const watermarks = readJson<Watermarks>(p.watermarks, {});
  const eventMap = new Map<string, EventNode>();
  if (existsSync(p.eventMap)) {
    for (const line of readFileSync(p.eventMap, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const node = JSON.parse(t) as EventNode;
      eventMap.set(node.feedId, node);
    }
  }
  return { head, eventMap, watermarks };
}

/** Append-only: group observations by ingest-hour and append their NDJSON lines. */
export function appendObservations(root: string, obs: Observation[]): void {
  const p = dataPaths(root);
  const byFile = new Map<string, string[]>();
  for (const o of obs) {
    const d = new Date(o.ingest_time);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const file = join(p.observationsDir, `ingest=${yyyy}`, mm, dd, `${hh}.ndjson`);
    const arr = byFile.get(file) ?? [];
    arr.push(JSON.stringify(o));
    byFile.set(file, arr);
  }
  for (const [file, lines] of byFile) {
    ensureDir(file);
    appendFileSync(file, lines.join('\n') + '\n');
  }
}

export function saveState(root: string, state: State, status: unknown): void {
  const p = dataPaths(root);
  ensureDir(p.head);
  writeFileSync(p.head, JSON.stringify(state.head, null, 2) + '\n');
  writeFileSync(p.watermarks, JSON.stringify(state.watermarks, null, 2) + '\n');
  const nodes = [...state.eventMap.values()].sort((a, b) => (a.feedId < b.feedId ? -1 : 1));
  writeFileSync(p.eventMap, nodes.map((n) => JSON.stringify(n)).join('\n') + (nodes.length ? '\n' : ''));
  ensureDir(p.status);
  writeFileSync(p.status, JSON.stringify(status, null, 2) + '\n');
  const now = new Date(state.head.ingest_time || Date.now());
  const histFile = join(p.statusHistoryDir, `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}.ndjson`);
  ensureDir(histFile);
  appendFileSync(histFile, JSON.stringify(status) + '\n');
}

const maxUpdated = (node: EventNode): number | null => {
  let m = -Infinity;
  for (const r of node.provenance) if (r.providerUpdatedMs != null) m = Math.max(m, r.providerUpdatedMs);
  return m === -Infinity ? null : m;
};

/** Materialize a live EventNode into a USGS-GeoJSON-superset Feature. */
export function nodeToFeature(node: EventNode): unknown {
  const updated = maxUpdated(node);
  return {
    type: 'Feature',
    id: node.feedId,
    geometry: { type: 'Point', coordinates: [round6(node.lon), round6(node.lat), node.depth] },
    properties: {
      mag: node.mag,
      magType: node.magType,
      place: node.place,
      time: node.eventTimeMs,
      updated: updated ?? node.eventTimeMs,
      status: node.status,
      tsunami: node.extra['tsunami'] ?? 0,
      sig: node.extra['sig'] ?? null,
      net: node.chosenProvider,
      type: (node.extra['type'] as string) ?? 'earthquake',
      feed: {
        schema_version: SCHEMA_VERSION,
        feed_id: node.feedId,
        event_time: isoFromMs(node.eventTimeMs),
        ingest_time: node.lastIngestTime,
        first_seen_seq: node.firstSeenSeq,
        ingest_seq: node.lastSeq,
        revision: node.revision,
        tombstone: node.state === 'tombstoned',
        chosen_provider: node.chosenProvider,
        aliases: node.aliases,
        provenance: node.provenance.map((r) => ({
          provider: r.provider,
          native_id: r.nativeId,
          mag: r.mag,
          magType: r.magType,
          status: r.status,
          provider_updated: r.providerUpdatedMs != null ? isoFromMs(r.providerUpdatedMs) : null,
          lat: round6(r.lat),
          lon: round6(r.lon),
          depth: r.depth,
          chosen: r.chosen,
          license: r.license,
          attribution: r.attribution,
          doi: r.doi,
        })),
      },
    },
  };
}
