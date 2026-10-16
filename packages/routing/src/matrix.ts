import { FINISH_ID, type PointsFile, START_ID } from '@bgq/core';
import { haversineM } from '@bgq/geo';
import type { TableResult } from './osrm.ts';

/** Без OSRM: прямая × 1,3 — грубо, но маршрут посчитать можно (бриф, раздел 4). */
export const DETOUR_FACTOR = 1.3;
/** Точку пришлось тащить к дорожке дальше — стоит посмотреть, где она (парк, пляж, двор). */
export const SNAP_WARN_M = 50;

/** games/<дата>/matrix.json — расстояния пешком между точками маршрута. */
export interface MatrixFile {
  v: 1;
  gameId: string;
  createdAt: string;
  /** Для какой таблицы точек считана (points.json createdAt) — чтобы ловить устаревание. */
  pointsCreatedAt: string;
  source: 'osrm' | 'haversine';
  osrm?: { image: string; osmBase: string };
  detourFactor?: number;
  /** start, finish, затем доступные КП с координатами. */
  ids: string[];
  points: { lat: number; lon: number }[];
  distanceM: number[][];
  snapM: number[];
}

export interface MatrixPoint {
  id: string;
  lat: number;
  lon: number;
}

const byId = (a: string, b: string) => a.localeCompare(b, 'ru', { numeric: true });

/** Точки маршрута из таблицы: старт, финиш, доступные КП с координатами. */
export function routePoints(t: PointsFile): MatrixPoint[] {
  if (!t.start || !t.finish) {
    throw new Error(
      'в points.json нет старта или финиша — отметьте их в ./bgq map и пересоберите ./bgq table',
    );
  }
  const kps = t.kps
    .filter((k) => k.eligible && k.loc)
    .sort((a, b) => byId(a.id, b.id))
    .map((k) => ({ id: k.id, lat: k.loc?.lat ?? 0, lon: k.loc?.lon ?? 0 }));
  return [
    { id: START_ID, lat: t.start.lat, lon: t.start.lon },
    { id: FINISH_ID, lat: t.finish.lat, lon: t.finish.lon },
    ...kps,
  ];
}

/** Запасная матрица: прямая × DETOUR_FACTOR. */
export function haversineTable(points: readonly MatrixPoint[]): TableResult {
  return {
    distanceM: points.map((a) =>
      points.map((b) => Math.round(haversineM([a.lat, a.lon], [b.lat, b.lon]) * DETOUR_FACTOR)),
    ),
    snapM: points.map(() => 0),
  };
}

export function matrixFile(o: {
  points: PointsFile;
  route: MatrixPoint[];
  table: TableResult;
  source: MatrixFile['source'];
  osrm?: MatrixFile['osrm'];
  now?: Date;
}): MatrixFile {
  return {
    v: 1,
    gameId: o.points.gameId,
    createdAt: (o.now ?? new Date()).toISOString(),
    pointsCreatedAt: o.points.createdAt,
    source: o.source,
    ...(o.osrm && { osrm: o.osrm }),
    ...(o.source === 'haversine' && { detourFactor: DETOUR_FACTOR }),
    ids: o.route.map((p) => p.id),
    points: o.route.map((p) => ({ lat: p.lat, lon: p.lon })),
    distanceM: o.table.distanceM,
    snapM: o.table.snapM,
  };
}
