import { createHash } from 'node:crypto';
import { FEED_ID_PREFIX } from './config.js';
import { gridKey } from './geo.js';
import { canonicalJson } from './util.js';

// Crockford base32 (excludes I, L, O, U).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Coarse buckets so slightly-different reports of one event seed the same id. */
const TIME_BUCKET_MS = 30_000;
const LOC_BUCKET_DEG = 0.02;

function encodeTime(ms: number): string {
  let n = Math.max(0, Math.floor(ms));
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeSeed(bytes: Uint8Array): string {
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  bits = bits.slice(0, 80).padEnd(80, '0');
  let out = '';
  for (let i = 0; i < 80; i += 5) out += CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

/**
 * Deterministic, content-*seeded* ULID (design §8.3.1). The id is a function of a
 * coarse event bucket (time + location) ONLY — never of which provider was seen
 * first — so ingest order does not change it (order-independence, §8.10). It is
 * minted once and pinned; later re-reports/relocations resolve via the alias table,
 * so the id never churns. `salt` disambiguates the astronomically rare hash clash.
 */
export function deterministicFeedId(eventTimeMs: number, lat: number, lon: number, salt = 0): string {
  const timeBucket = Math.round(eventTimeMs / TIME_BUCKET_MS) * TIME_BUCKET_MS;
  const seedInput = canonicalJson([timeBucket, gridKey(lat, lon, LOC_BUCKET_DEG), salt]);
  const seed = createHash('sha256').update(seedInput).digest().subarray(0, 10);
  return FEED_ID_PREFIX + encodeTime(timeBucket) + encodeSeed(seed);
}

/** A feed id: the prefix and a 26-character Crockford ULID (the same pattern as the statistics' FEED_ID_RE). */
const FEED_ID = new RegExp(`^${FEED_ID_PREFIX}[0-9A-HJKMNP-TV-Z]{26}$`);

/**
 * The time a feed id encodes: its first 10 ULID characters, the 30 s bucket the id was minted at (deterministicFeedId:
 * the origin time of the minting report, rounded). A hint for the hour, day and year of the event, never its exact
 * time: the bucket can fall in the next hour or day, and a later revision can move the origin while the id stays
 * pinned. Null for a string that is not a feed id.
 */
export function feedIdTimeMs(id: string): number | null {
  if (!FEED_ID.test(id)) return null;
  let ms = 0;
  for (const c of id.slice(FEED_ID_PREFIX.length, FEED_ID_PREFIX.length + 10)) ms = ms * 32 + CROCKFORD.indexOf(c);
  return ms;
}
