// Standard base-32 geohash — the bit-exact twin of ShelterShared `Geohash.swift` and the TS
// `@shelter/domain` geohash (same bisection, same `>=` comparisons on IEEE-754 doubles → identical
// strings on every language). Used for `cell3` in the change-log so fan-out (Spec 4) buckets events
// the same way the clients do.
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function geohashEncode(latitude: number, longitude: number, precision: number): string {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let hash = '';
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (longitude >= mid) {
        idx = idx * 2 + 1;
        lonMin = mid;
      } else {
        idx = idx * 2;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (latitude >= mid) {
        idx = idx * 2 + 1;
        latMin = mid;
      } else {
        idx = idx * 2;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    bit += 1;
    if (bit === 5) {
      hash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return hash;
}
