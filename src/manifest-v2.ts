import { createHash } from 'node:crypto';
import { decodeJsonPayload, jcsBytes, openBytes, sealJson, type SignedEnvelope, type Signer, type Verifier } from '@theshelter/signing';
import { DOMAIN, JSDELIVR_BASE, REPO } from './config.js';
import type { ManifestPartition } from './partitions.js';

/**
 * v2 manifest: the v1 catalog carried forward, plus everything a client needs to fetch the
 * same bytes from any origin and prove they are ours — origin templates pinned to the data
 * commit, a sha256 per partition and per summary, the tiles bundle pointer, the status URL —
 * canonicalized (RFC 8785) and wrapped in an Ed25519 envelope {payload, sig, kid}. v1 stays
 * byte-for-byte as it was until every shipped build reads v2.
 *
 * Pure: `buildManifestV2` never touches the network or the clock; every input is a value so a
 * re-run over unchanged input yields identical payload bytes (and therefore an identical sha).
 */

/** The v1 manifest exactly as derive.ts writes it (the fields v2 carries forward). */
export interface ManifestV1 {
  schema_version: number;
  generated: number;
  generated_iso: string;
  head_seq: number;
  event_count: number;
  freshness: { expected_interval_seconds: number; stale_after_seconds: number };
  data_repo: string;
  jsdelivr_base: string;
  data_commit: string | null;
  summaries: Record<string, { path: string; url: string; count: number }>;
  partitions: ManifestPartition[];
  archives: unknown[];
}

/** `regions-db.json` from TheShelterApp/region-tiles — the offline SQLite bundle pointer. */
export interface TilesPointer {
  version: string;
  url: string;
  sizeBytes: number;
  sha256: string;
}

export interface OriginTemplate {
  id: string;
  /** Prefix a manifest `path` is appended to. */
  base: string;
  /** Origins that cap object size (jsDelivr: 20 MB). */
  max_object_bytes?: number;
  /** Serves only the moving head (raw@data) — never used for sha-pinned immutables. */
  mutable_only?: boolean;
}

export interface ChangesRef {
  path: string;
  sha256: string;
  size: number;
  firstSeq: number;
  lastSeq: number;
  urls: string[];
}

export interface ManifestV2 {
  schema_version: 2;
  generated: number;
  generated_iso: string;
  /** generated + stale_after_seconds·1000: past this a client shows "data may be delayed". */
  expires: number;
  head_seq: number;
  event_count: number;
  freshness: { expected_interval_seconds: number; stale_after_seconds: number; offline_after_seconds: number };
  data_repo: string;
  /** The data-branch commit every immutable URL below is pinned to. */
  data_commit: string;
  origins: OriginTemplate[];
  status_url: string;
  summaries: Record<string, { path: string; url: string; count: number; bytes: number; sha256: string }>;
  /** `frozen` doubles as the immutability flag: a frozen partition is never rewritten. */
  partitions: Array<ManifestPartition & { sha256: string; bytes: number }>;
  /** The current UTC day's append-only change-log (SD-E3), tailed with Range; null before the first change. */
  changes: ChangesRef | null;
  tiles: TilesPointer | null;
  archives: unknown[];
}

/** Bytes of one artifact, keyed by the manifest `path` it is listed under. Missing → throw. */
export type ArtifactReader = (path: string, kind: 'partition' | 'summary') => Uint8Array;

export interface BuildInput {
  v1: ManifestV1;
  dataCommit: string;
  read: ArtifactReader;
  tiles?: TilesPointer | null;
  /** The R2 custom-domain base (e.g. https://data-staging.theshelter.app/) — the preferred origin. */
  r2PublicBase?: string;
  /** The current day's change-log bytes + its key (v1/changes/<day>.ndjson), when one exists. */
  changes?: { path: string; bytes: Uint8Array };
  /**
   * The iOS DataFreshness offline threshold (STOP-4: thresholds live only here). Twice the
   * stale window unless overridden — `stale_after` says "delayed", this says "offline".
   */
  offlineAfterSeconds?: number;
}

export const DEFAULT_KID = 'feed-2026a';
export const PAGES_BASE = `https://${DOMAIN}/`;

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function changesRef(c: { path: string; bytes: Uint8Array }): ChangesRef {
  const lines = new TextDecoder().decode(c.bytes).trimEnd().split('\n').filter(Boolean);
  const seqOf = (line: string): number => (JSON.parse(line) as { seq: number }).seq;
  return {
    path: c.path,
    sha256: sha256Hex(c.bytes),
    size: c.bytes.byteLength,
    firstSeq: lines.length ? seqOf(lines[0]!) : 0,
    lastSeq: lines.length ? seqOf(lines[lines.length - 1]!) : 0,
    urls: [`${PAGES_BASE}${c.path}`],
  };
}

/** Origin templates for a given data commit. When `r2Base` is set (SD-E2) the R2 custom domain is
 *  the preferred `cdn` origin, ahead of Pages and the GitHub mirrors. */
export function originsFor(dataCommit: string, r2Base?: string): OriginTemplate[] {
  return [
    ...(r2Base ? [{ id: 'cdn', base: r2Base.endsWith('/') ? r2Base : `${r2Base}/` }] : []),
    { id: 'pages', base: PAGES_BASE },
    { id: 'jsdelivr-sha', base: `${JSDELIVR_BASE}@${dataCommit}/`, max_object_bytes: 20_000_000 },
    { id: 'raw-sha', base: `https://raw.githubusercontent.com/${REPO}/${dataCommit}/` },
    { id: 'raw-data', base: `https://raw.githubusercontent.com/${REPO}/data/`, mutable_only: true },
    { id: 'release', base: `https://github.com/${REPO}/releases/download/` },
  ];
}

export function buildManifestV2(input: BuildInput): ManifestV2 {
  const { v1, dataCommit, read } = input;
  if (!/^[0-9a-f]{40}$/.test(dataCommit)) throw new Error(`manifest v2: data_commit must be a full git sha, got "${dataCommit}"`);
  const staleAfter = v1.freshness.stale_after_seconds;

  const summaries: ManifestV2['summaries'] = {};
  for (const name of Object.keys(v1.summaries).sort()) {
    const s = v1.summaries[name]!;
    const bytes = read(s.path, 'summary');
    summaries[name] = { path: s.path, url: s.url, count: s.count, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
  }

  const partitions = v1.partitions.map((p) => {
    const bytes = read(p.path, 'partition');
    return { ...p, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
  });

  return {
    schema_version: 2,
    generated: v1.generated,
    generated_iso: v1.generated_iso,
    expires: v1.generated + staleAfter * 1000,
    head_seq: v1.head_seq,
    event_count: v1.event_count,
    freshness: {
      expected_interval_seconds: v1.freshness.expected_interval_seconds,
      stale_after_seconds: staleAfter,
      offline_after_seconds: input.offlineAfterSeconds ?? staleAfter * 2,
    },
    data_repo: v1.data_repo,
    data_commit: dataCommit,
    origins: originsFor(dataCommit, input.r2PublicBase),
    status_url: `${PAGES_BASE}v1/status.json`,
    summaries,
    partitions,
    changes: input.changes ? changesRef(input.changes) : null,
    tiles: input.tiles ?? null,
    archives: v1.archives,
  };
}

/** The exact bytes that get signed. */
export const manifestV2Bytes = (m: ManifestV2): Uint8Array => jcsBytes(m);

export async function signManifestV2(m: ManifestV2, signer: Signer): Promise<SignedEnvelope> {
  return sealJson(signer, m);
}

/** Verify + decode; throws EnvelopeError (UnknownKid | BadSignature | Malformed). */
export async function verifyManifestV2(envelope: SignedEnvelope, verifier: Verifier): Promise<ManifestV2> {
  return decodeJsonPayload<ManifestV2>(await openBytes(verifier, envelope));
}
