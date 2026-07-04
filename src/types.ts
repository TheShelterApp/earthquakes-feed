export type Op = 'observe' | 'tombstone' | 'correction' | 'merge' | 'supersede';

export type Extra = Record<string, number | string | null>;

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
  extra: Extra;
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
  extra: Extra;
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
  extra: Extra;
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
  extra: Extra;
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
  refreshSeconds: number;
  license: string;
  attribution: string;
  doi: string | null;
  contact: string;
  params?: Record<string, string>;
  notes?: string;
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
