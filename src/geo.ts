const EARTH_R_KM = 6371.0088;
const toRad = (d: number): number => (d * Math.PI) / 180;
const clampLat = (lat: number): number => Math.max(-90, Math.min(90, lat));

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

const lonIndex = (lon: number, cellDeg: number, n: number): number => {
  const loi = Math.floor(((((lon + 180) % 360) + 360) % 360) / cellDeg);
  return ((loi % n) + n) % n;
};

/** Discrete grid cell key `latIdx:lonIdx` for a fixed-degree grid, wrapping longitude. */
export function gridKey(lat: number, lon: number, cellDeg: number): string {
  const n = Math.round(360 / cellDeg);
  const li = Math.floor((clampLat(lat) + 90) / cellDeg);
  return `${li}:${lonIndex(lon, cellDeg, n)}`;
}

/**
 * Every grid cell whose block can hold a point within `km` of (lat, lon).
 * Neighborhood widens by km (adaptive in longitude near the poles) and wraps
 * the antimeridian — exact coverage, no corner-miss (fixes the grid-sampling bug).
 */
export function gatherCellKeys(lat: number, lon: number, km: number, cellDeg: number): string[] {
  const n = Math.round(360 / cellDeg);
  const jLat = Math.ceil(km / 111 / cellDeg);
  const lonKmPerDeg = 111 * Math.max(Math.cos(toRad(lat)), 1e-6);
  const jLon = Math.min(Math.ceil(km / lonKmPerDeg / cellDeg), Math.floor(n / 2));
  const maxLi = Math.floor(180 / cellDeg);
  const baseLi = Math.floor((clampLat(lat) + 90) / cellDeg);
  const baseLoi = lonIndex(lon, cellDeg, n);
  const keys = new Set<string>();
  for (let dLat = -jLat; dLat <= jLat; dLat++) {
    const li = baseLi + dLat;
    if (li < 0 || li > maxLi) continue;
    for (let dCol = -jLon; dCol <= jLon; dCol++) {
      keys.add(`${li}:${((baseLoi + dCol) % n + n) % n}`);
    }
  }
  return [...keys];
}
