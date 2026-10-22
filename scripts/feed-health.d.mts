// Types for scripts/feed-health.mjs (dependency-free JavaScript, so the health workflow runs it without `npm ci`). Only
// the tests import it from TypeScript.

import type { Finding } from './lib/findings.mjs';

export const FEED_BASE: string;
export const MANIFEST_V1_URL: string;
export const MANIFEST_V2_URL: string;
export const STATUS_V1_URL: string;
/** GitHub's REST API: the only host GH_TOKEN is ever sent to. */
export const GITHUB_API: string;
/** providers/registry.json of the checkout. */
export const REGISTRY_PATH: string;
export const ZIP_MAX_ENTRIES: number;
export const ZIP_MAX_ENTRY_BYTES: number;

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** A manifest as read: its generated time (ms) and its own freshness contract (ms, default 1,800 s). */
export type ManifestRead = { ok: true; generatedMs: number; staleAfterMs: number } | { ok: false; message: string };

export function readManifestV1(json: unknown): ManifestRead;
/** The v2 envelope {payload: base64, sig, kid}: the payload decoded, the signature NOT verified. */
export function decodeManifestV2(json: unknown): ManifestRead;

/** feed:freshness: stale (P2, rule feed:freshness), else unreachable (P2, rule feed:freshness:unreachable), else null. */
export function evaluateFreshness(opts: { nowMs: number; v1: ManifestRead; v2: ManifestRead; queuedMs?: number; reRead?: boolean }): Finding | null;

export interface FailureClass {
  /** http_status 401/403/404/410, error.kind 'schema' or a TLS failure: the 2 h line of feed:source:definite. */
  definite: boolean;
  reason: string;
}
export function classifyFailure(provider: unknown, opts?: { tlsError?: unknown; tlsLeaf?: unknown }): FailureClass;

/** status.json's own time: generatedAt (ms), else Date.parse(generated); null when neither. */
export function statusRefMs(status: unknown): number | null;

/** feed:source:<id>, feed:cert:<id> and feed:systemic of a readable status.json, judged as of `refMs`. */
export function evaluateSources(status: unknown, refMs: number, opts?: { nowMs?: number }): { findings: Finding[]; notes: string[] };

export interface Judged {
  findings: Finding[];
  /** Key patterns not judged this run (reconcile freezes them). */
  unjudged: string[];
  notes: string[];
}
/** feed:size from the data branch's recursive tree listing; null or a body without a tree array: unjudged. */
export function evaluateSizes(tree: unknown): Judged;
/** feed:repo-size from GitHub's repository `size` (KB); not a number: unjudged. */
export function evaluateRepoSize(kb: unknown): Judged;

/** Each non-empty line of a blocked marker, filed under the leftmost whole-word registry id, else 'run'. */
export function parseMarker(text: string, ids: Iterable<string>): Array<{ source: string; line: string }>;

/** The newest non-expired artifact named `name` of an artifacts listing; null when none; throws on a body without a list. */
export function pickMarkerArtifact(listing: unknown, name: string): { id: number; createdAtMs: number; runId: number | null } | null;

/** One walk's marker read: a failed read (listing or zip) leaves `walks:<workflow>:*` unjudged. */
export type WalkRead =
  | { workflow: string; ok: false; message: string }
  | { workflow: string; ok: true; marker: null }
  | { workflow: string; ok: true; marker: { createdAtMs: number; runId: number | null; artifactId?: number; text: string } };

/** walks:<workflow>:<source> for each line of a marker younger than 26 h, lines merged per key. */
export function evaluateWalks(reads: WalkRead[], nowMs: number, ids: Iterable<string>): Judged;

/** The entries of a small zip (stored or deflated; at most 10 entries of 1 MB). Throws on anything else. */
export function readZipEntries(bytes: Uint8Array | ArrayBuffer): Array<{ name: string; data: Buffer }>;

/** The ids of providers/registry.json ({providers: [{id}]} or a bare array). Throws on an unusable file. */
export function registryIds(text: string): string[];

/** What collect() read; evaluateFeed judges it (pure). */
export interface FeedInputs {
  /** The time of the judgement (after the last manifest read). */
  nowMs: number;
  v1: ManifestRead;
  v2: ManifestRead;
  /** Whether both manifests were read again 60 s after the first read. */
  reRead: boolean;
  /** How long this run waited in the runner queue (ms); 0 when unknown. */
  queuedMs: number;
  status: { ok: true; json: unknown } | { ok: false; message: string };
  repoSize: { ok: true; kb: number } | { ok: false; message: string };
  tree: { ok: true; json: unknown } | { ok: false; message: string };
  walks: WalkRead[];
  /** Source ids a marker line is filed under. */
  ids: string[];
  notes: string[];
}

export function evaluateFeed(inputs: FeedInputs): { findings: Finding[]; unjudged: string[]; notes: string[]; summary: string };

export function collect(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchImpl;
  /** A fixed clock (tests); `now` wins when both are given. */
  nowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => string;
}): Promise<FeedInputs>;

export function parseArgs(argv: string[]): { findingsPath: string | null };

export function main(opts?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchImpl;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  readFile?: (path: string) => string;
  writeFile?: (path: string, data: string) => void;
}): Promise<number>;
