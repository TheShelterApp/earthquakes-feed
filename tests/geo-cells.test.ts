import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GRID_CELL_DEG } from '../src/config.js';
import { gatherCellKeys, gridKey, haversineKm, lonSpanDeg } from '../src/geo.js';

// 2026-11-15 audit, dedup L4: gatherCellKeys took the longitude reach as km / (111 cos lat), which falls a cell short at
// high latitudes (80° N with 300 km, 85° N from 150 km, 88° N from 100 km). It now also takes the exact spherical bound.

const R = 6371.0088;
const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

/** The point `km` from (lat, lon) on bearing `brg` (degrees), on haversineKm's sphere. */
function destination(lat: number, lon: number, km: number, brg: number): [number, number] {
  const d = km / R;
  const p1 = rad(lat);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(rad(brg)));
  const l2 = rad(lon) + Math.atan2(Math.sin(rad(brg)) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

/** The reach before the fix, for the superset check. */
function linearKeys(lat: number, lon: number, km: number, cellDeg: number): string[] {
  const n = Math.round(360 / cellDeg);
  const jLat = Math.ceil(km / 111 / cellDeg);
  const jLon = Math.min(Math.ceil(km / (111 * Math.max(Math.cos(rad(lat)), 1e-6)) / cellDeg), Math.floor(n / 2));
  const baseLi = Math.floor((Math.max(-90, Math.min(90, lat)) + 90) / cellDeg);
  const baseLoi = Number(gridKey(lat, lon, cellDeg).split(':')[1]);
  const keys: string[] = [];
  for (let dLat = -jLat; dLat <= jLat; dLat++) {
    const li = baseLi + dLat;
    if (li < 0 || li > Math.floor(180 / cellDeg)) continue;
    for (let dCol = -jLon; dCol <= jLon; dCol++) keys.push(`${li}:${(((baseLoi + dCol) % n) + n) % n}`);
  }
  return keys;
}

test('every point within the radius falls in a gathered cell, up to the poles and across the antimeridian', () => {
  const misses: string[] = [];
  for (const cellDeg of [GRID_CELL_DEG, 1]) {
    for (const lat of [0, 45, 65, 75, 80, 85, 88, 89.5, 89.9, -82.3]) {
      for (const lon of [0.05, 179.97, -179.93]) {
        for (const km of [10, 50, 100, 150, 200, 300]) {
          const keys = new Set(gatherCellKeys(lat, lon, km, cellDeg));
          for (let brg = 0; brg < 360; brg += 0.5) {
            const [pLat, pLon] = destination(lat, lon, km * 0.9999, brg);
            assert.ok(haversineKm(lat, lon, pLat, pLon) <= km);
            if (!keys.has(gridKey(pLat, pLon, cellDeg))) misses.push(`${lat},${lon} ${km} km ${cellDeg}° brg ${brg}`);
          }
        }
      }
    }
  }
  assert.deepEqual(misses.slice(0, 5), []);
});

test('85° N with 150 km: the point at the tangent longitude is found', () => {
  const span = lonSpanDeg(85, 150);
  const tangentLat = deg(Math.asin(Math.sin(rad(85)) / Math.cos(150 / R)));
  // The centre near the eastern edge of its cell, so the extra 0.17° of reach crosses into one more column.
  const [cLat, cLon] = [85, 10.19];
  const [lat, lon] = [tangentLat, cLon + span * 0.9999];
  assert.ok(haversineKm(cLat, cLon, lat, lon) <= 150);
  assert.ok(!linearKeys(cLat, cLon, 150, GRID_CELL_DEG).includes(gridKey(lat, lon, GRID_CELL_DEG)), 'the linear reach missed it');
  assert.ok(gatherCellKeys(cLat, cLon, 150, GRID_CELL_DEG).includes(gridKey(lat, lon, GRID_CELL_DEG)));
});

test('the reach only grows: every cell the linear reach took is still taken, and nothing changes at 65° N', () => {
  for (const lat of [-60, 0, 30, 65, 80, 87.5])
    for (const km of [10, 30, 50, 90, 150, 300]) {
      const now = new Set(gatherCellKeys(lat, 33.3, km, GRID_CELL_DEG));
      const before = linearKeys(lat, 33.3, km, GRID_CELL_DEG);
      for (const k of before) assert.ok(now.has(k), `${lat} ${km}: ${k}`);
      if (Math.abs(lat) <= 65) assert.equal(now.size, new Set(before).size, `${lat} ${km}`);
    }
  assert.equal(lonSpanDeg(89.95, 10), 180, 'the pole inside the radius: the whole ring');
});
