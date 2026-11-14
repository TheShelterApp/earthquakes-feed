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
  /** op:merge only — why the loser (this line's feed_id) folded, and the survivor it folded into. */
  reason?: string;
  superseded_by?: string;
}

/** Another catalogue's solutions served by a provider (ProviderConfig.catalogues). */
export interface ProviderCatalogue {
  /** Display name, for NOTICE and ATTRIBUTIONS.md. */
  name: string;
  license: string;
  attribution: string;
  doi: string | null;
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
  /** FDSN sources only: a second host of the same catalogue (same event ids), asked when `base` fails or answers
   *  with no rows; its answer is used only when it has rows (providers.ts fetchFdsn). The deep-history and
   *  earliest-solutions walks ask `base` alone. */
  fallbackBase?: string;
  /** Custom sources whose host serves its leaf certificate without the intermediate: PEM files (paths relative to
   *  providers/, see providers/tls/README.md) trusted beside Node's root store, verification on (FEED-SEC-1). */
  tlsIntermediates?: string[];
  supportsTimeRange: boolean;
  noLimit?: boolean;
  /** Per-provider fetch timeout override (ms) for slow endpoints (e.g. ISC). */
  timeoutMs?: number;
  /** false = skip on the live 5-min path (e.g. a months-delayed catalog); still backfilled. */
  liveActive?: boolean;
  /** Live FDSN path: ask for origins of the last this many days instead of QUERY_LOOKBACK_MS (2 days), for a source
   *  that publishes many events days after their origin (NRCan). Capped at HOT_WINDOW_DAYS: an older row is dropped
   *  at ingest anyway (providers.ts liveLookbackMs). */
  lookbackDays?: number;
  /** Hours the source may answer with no rows before status.json lists it as silent (src/activity.ts, FEED-3):
   *  missing = 12 (an active agency), a number for a quiet one, null = never silent (a region quiet for weeks). */
  activityBudgetHours?: number | null;
  /** Hours past its query window that the newest origin a source still lists may stand still before status.json lists
   *  it as frozen (src/activity.ts): missing = 3 x its activity budget, null = never frozen. Longer for a source that
   *  lists its last N events, whose list legitimately stands still for days in a quiet spell (BGS, IG-EPN, CWA). */
  frozenBudgetHours?: number | null;
  refreshSeconds: number;
  license: string;
  /** The licence text's URL, linked wherever the licence is named (NOTICE, ATTRIBUTIONS.md). */
  licenseUrl?: string;
  attribution: string;
  /** The statement the licence asks for verbatim beside the source's attribution (OGL – Canada 2.0, OGL v3.0 UK),
   *  rendered with the licence URL by scripts/gen-attributions.mjs; never part of the per-row provenance. */
  attributionNotice?: string;
  doi: string | null;
  /** Catalogues this provider distributes whose rows carry their own licence, keyed by the row's `fields.net` in
   *  lower case (ComCat: ISC-GEM's `iscgem`, `iscgemsup`). src/row-license.ts applies them; scripts/gen-attributions.mjs
   *  lists them in NOTICE and ATTRIBUTIONS.md. */
  catalogues?: Record<string, ProviderCatalogue>;
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
  /** The host that answered, when it was the source's `fallbackBase` and not its `base`. */
  via?: string;
  /** ISO time of the newest origin the answer listed (aggregate, FEED-3 frozen check); absent with no rows. */
  newest_origin?: string;
  /** Pinned sources (tlsIntermediates): the leaf certificate the host presented (custom.ts, FEED-SEC-1). */
  tls_leaf?: TlsLeafStatus;
  /** Present when the source was not asked this run: its circuit breaker is open (src/breaker.ts). `ok` is false. */
  skipped?: 'breaker';
  /** Present while the source's circuit breaker is open (src/breaker.ts): skipped, or probed this run without an answer. */
  breaker?: BreakerStatus;
}

/** status.json `providers.<id>.breaker` (src/breaker.ts). */
export interface BreakerStatus {
  /** ISO time of the run that opened it (the first opening of this streak). */
  open_since: string;
  /** ISO time from which the next run probes the source (one request; an answer closes the breaker). */
  next_probe: string;
  /** Consecutive runs without an answer, probes included. */
  failures: number;
  /** Runs it skips before that probe. */
  skip_runs: number;
}

export interface TlsLeafStatus {
  not_after: string;
  days_left: number;
  issuer: string | null;
  subject: string | null;
  /** When the leaf was last read: this run, or an earlier one (this run reached another of the host's leaves, or could
   *  not complete the handshake). */
  seen_at: string;
  /** How many leaves the host presented in the last week, when more than one (the one shown expires first). */
  leaves?: number;
}

export interface State {
  head: Head;
  eventMap: Map<string, EventNode>;
  watermarks: Watermarks;
}
