// Данные digitizer — общие для сервера (server/) и браузера (src/).
import type { Game, Kp, MapResult } from '@bgq/core';
import type { GeoResult } from '@bgq/geo';
import type { FitReport } from '@bgq/georef';

/** Итог по КП (контракт с таблицей точек — схема в core). */
export type { MapResult };

export type CircleColor = 'red' | 'blue' | 'green';

/** Отметка кружка КП на фото, в пикселях исходного изображения. */
export interface Mark {
  id: string;
  x: number;
  y: number;
  color: CircleColor | null;
  /** Стрелка «КП за краем карты»: только цвет, не опорная, координаты — по адресу. */
  arrow?: boolean;
}

export interface PhotoLabels {
  file: string;
  marks: Mark[];
  /** Опорные точки, выключенные вручную (id КП). */
  disabled: string[];
}

export interface PhotoFitSummary {
  file: string;
  report: FitReport | null;
  /** Почему привязки нет (мало опорных и т.п.). */
  reason?: string;
}

/** games/<дата>/map.json. Первоисточник — photos[].marks; fits и results пересчитываются. */
export interface MapFile {
  v: 1;
  gameId: string;
  updatedAt: string;
  photos: PhotoLabels[];
  fits: PhotoFitSummary[];
  results: MapResult[];
}

/** Ответ GET /api/state. */
export interface GameState {
  gameDir: string;
  game: Game;
  kps: Kp[];
  geo: GeoResult[];
  map: MapFile | null;
  photos: string[];
}
