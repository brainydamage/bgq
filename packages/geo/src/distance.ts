export type LatLon = readonly [lat: number, lon: number];

const R = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Расстояние по большому кругу, метры. */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function centroid(points: readonly LatLon[]): LatLon | null {
  if (!points.length) return null;
  const lat = points.reduce((s, p) => s + p[0], 0) / points.length;
  const lon = points.reduce((s, p) => s + p[1], 0) / points.length;
  return [lat, lon];
}
