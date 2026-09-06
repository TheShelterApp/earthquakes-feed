import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventNode } from './types.js';
import { geohashEncode } from './geohash.js';
import { round6 } from './util.js';

/**
 * SD-E3 change-log: an append-only NDJSON per UTC day, one line per event change, strictly
 * increasing `seq`. It is the idempotent feed fan-out (Spec 4) reads instead of state — a consumer
 * upserts by `id` when `rev >= known` and drops tombstoned ones, deduping by (id, rev). A line is
 * never rewritten; a later change to the same event appends a NEW line with a higher seq.
 *
 * Pure over its inputs: given the same nodes and the same prior cursor it produces the same bytes.
 */
export interface ChangeRecord {
  id: string;
  seq: number;
  rev: number;
  state: 'live' | 'updated' | 'tombstoned';
  time: number;
  lat: number;
  lon: number;
  depthKm: number | null;
  mag: number | null;
  magType: string | null;
  place: string | null;
  cell3: string;
  tsunami: boolean;
  updatedAt: number;
  tombstonedAt: number | null;
  mergedInto: string | null;
}

const ms = (iso: string): number => Date.parse(iso);

/** Compact EventRecord for the change-log (no provenance — the day partition keeps that). */
export function nodeToChangeRecord(node: EventNode): ChangeRecord {
  const tombstoned = node.state === 'tombstoned' || node.state === 'superseded';
  const chosen = node.provenance.find((r) => r.chosen) ?? node.provenance[0];
  const tsunami = Number(chosen?.fields?.['tsunami'] ?? 0) > 0;
  return {
    id: node.feedId,
    seq: node.lastSeq,
    rev: node.revision,
    state: tombstoned ? 'tombstoned' : node.revision > 1 ? 'updated' : 'live',
    time: node.eventTimeMs,
    lat: round6(node.lat),
    lon: round6(node.lon),
    depthKm: node.depth,
    mag: node.mag,
    magType: node.magType,
    place: node.place,
    cell3: geohashEncode(node.lat, node.lon, 3),
    tsunami,
    updatedAt: ms(node.lastIngestTime),
    tombstonedAt: tombstoned ? ms(node.lastIngestTime) : null,
    mergedInto: node.state === 'superseded' ? node.supersededBy ?? null : null,
  };
}

export interface AppendResult {
  path: string;
  appended: number;
  firstSeq: number | null;
  lastSeq: number | null;
  cursor: number;
}

/**
 * Append every node whose `lastSeq` is newer than `sinceCursor` to `changes/<utcDay>.ndjson`,
 * ordered by seq. Returns the new cursor (max seq written, or the old cursor when nothing changed)
 * so the caller persists it. Re-running with the same cursor appends nothing (idempotent).
 */
export function appendChanges(file: string, nodes: EventNode[], sinceCursor: number): AppendResult {
  const fresh = nodes.filter((n) => n.lastSeq > sinceCursor).sort((a, b) => a.lastSeq - b.lastSeq);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const priorLast = existing ? readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean) : [];
  const firstNewSeq = fresh.length ? fresh[0]!.lastSeq : null;
  const lastNewSeq = fresh.length ? fresh[fresh.length - 1]!.lastSeq : null;

  if (fresh.length) {
    mkdirSync(dirname(file), { recursive: true });
    const lines = fresh.map((n) => JSON.stringify(nodeToChangeRecord(n))).join('\n') + '\n';
    writeFileSync(file, existing + lines);
  }
  // firstSeq of the whole file (for the manifest) — the first line's seq, whether new or prior.
  const firstOfFile = (priorLast[0] ? (JSON.parse(priorLast[0]) as ChangeRecord).seq : firstNewSeq);
  return {
    path: file,
    appended: fresh.length,
    firstSeq: firstOfFile,
    lastSeq: lastNewSeq ?? (priorLast.length ? (JSON.parse(priorLast[priorLast.length - 1]!) as ChangeRecord).seq : null),
    cursor: lastNewSeq ?? sinceCursor,
  };
}
