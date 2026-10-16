import type { XY } from './linalg.ts';

export type LatLon = readonly [lat: number, lon: number];

const R = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * Локальные метры вокруг центра (равнопромежуточная проекция): x — на восток, y — на север.
 * В пределах города (несколько км) искажение — доли процента, подгонку делаем в метрах.
 */
export interface LocalProjection {
  toXY(ll: LatLon): XY;
  toLatLon(xy: XY): LatLon;
}

export function localProjection(lat0: number, lon0: number): LocalProjection {
  const k = Math.cos(rad(lat0));
  return {
    toXY: ([lat, lon]) => [R * rad(lon - lon0) * k, R * rad(lat - lat0)],
    toLatLon: ([x, y]) => [lat0 + deg(y / R), lon0 + deg(x / (R * k))],
  };
}

/** Проекция с центром в среднем точек. */
export function projectionFor(points: readonly LatLon[]): LocalProjection {
  const n = points.length || 1;
  const lat0 = points.reduce((s, p) => s + p[0], 0) / n;
  const lon0 = points.reduce((s, p) => s + p[1], 0) / n;
  return localProjection(lat0, lon0);
}
