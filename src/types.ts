export type Op = 'observe' | 'tombstone' | 'correction' | 'merge' | 'supersede';

/** A scalar field-map: one provider's complete original vocabulary, flattened (nested
 *  objects -> dotted keys, arrays -> JSON strings). Never an allowlist — capture all. */
export type Extra = Record<string, number | string | boolean | null>;

/** A normalized single provider report, before identity resolution. */
export interface RawObs {
  provider: string;
  providerEventId: string;
  eventTimeMs: number;
  providerUpdatedMs: number | null;
  status: string | null;
  lat: number;
  lon: number;
  depth: number | null;
  mag: number | null;
  magType: string | null;
  place: string | null;
  knownAliasIds: string[];
  /** The provider's COMPLETE original field vocabulary (nothing dropped). */
  fields: Extra;
}

/** One provider's contribution to a merged event, preserved forever. */
export interface ProvenanceRow {
  provider: string;
  nativeId: string;
  eventTimeMs: number;
  mag: number | null;
  magType: string | null;
  status: string | null;
  providerUpdatedMs: number | null;
  lat: number;
  lon: number;
  depth: number | null;
  place: string | null;
  chosen: boolean;
  license: string;
  attribution: string;
  doi: string | null;
  /** This provider's COMPLETE original field vocabulary for this report. */
  fields: Extra;
}

/** The persisted per-event state (node of the event_map). */
export interface EventNode {
  feedId: string;
  aliases: string[];
  eventTimeMs: number;
  firstIngestTime: string;
  lastIngestTime: string;
  lat: number;
  lon: number;
  depth: number | null;
  mag: number | null;
  magType: string | null;
  status: string | null;
  place: string | null;
  chosenProvider: string;
  provenance: ProvenanceRow[];
  revision: number;
  firstSeenSeq: number;
  lastSeq: number;
  state: 'live' | 'tombstoned' | 'superseded';
  supersededBy?: string;
  geohash: string;
}

/** One append-only line of the observation log. */
export interface Observation {
  seq: number;
  op: Op;
  feed_id: string;
  revision: number;
  ingest_time: string;
  event_time: string;
  provider: string;
  provider_event_id: string;
  provider_updated: string | null;
  status: string | null;
  lat: number;
  lon: number;
  depth: number | null;
  mag: number | null;
  magType: string | null;
  place: string | null;
  backfilled?: boolean;
  /** The reporting provider's COMPLETE original field vocabulary. */
  fields: Extra;
}

export interface ProviderConfig {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  adapter: string;
  parse: 'geojson' | 'text' | 'custom';
  queryFormat: string;
  base: string;
  supportsTimeRange: boolean;
  noLimit?: boolean;
  /** Per-provider fetch timeout override (ms) for slow endpoints (e.g. ISC). */
  timeoutMs?: number;
  /** false = skip on the live 5-min path (e.g. a months-delayed catalog); still backfilled. */
  liveActive?: boolean;
  refreshSeconds: number;
  license: string;
  attribution: string;
  doi: string | null;
  contact: string;
  params?: Record<string, string>;
  notes?: string;
  backfill?: {
    enabled?: boolean;
    earliest?: string;
    minmag?: number;
    maxWindowDays?: number;
    initialWindowDays?: number;
  };
}

export interface Head {
  seq: number;
  ingest_time: string;
}

export type Watermarks = Record<string, number>;

export interface ProviderStatus {
  ok: boolean;
  http_status?: number;
  latency_ms?: number;
  events_returned?: number;
  error?: string;
}

export interface State {
  head: Head;
  eventMap: Map<string, EventNode>;
  watermarks: Watermarks;
}
