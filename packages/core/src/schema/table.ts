import Type, { type Static } from 'typebox';
import { IsoDateTime, KpId, Loc } from './common.ts';
import { MapColor } from './game.ts';
import { Kp, TimeWindow } from './kp.ts';

/** Особые отметки на карте: старт и финиш игры (id вместо номера КП). */
export const START_ID = 'start';
export const FINISH_ID = 'finish';

/**
 * Итог digitizer по КП (map.json → results); id — номер КП или start/finish.
 * Стрелка за краем карты — без координат.
 */
export const MapResult = Type.Object(
  {
    id: KpId,
    loc: Type.Optional(Loc),
    color: Type.Union([MapColor, Type.Null()]),
    photo: Type.String(),
    /** Стрелка «КП за краем карты»: даёт только цвет (категорию), координаты — по адресу. */
    arrow: Type.Optional(Type.Boolean()),
    /** Окно работы КП, подписанное на карте («с 14 до 18»). overrides.yaml важнее. */
    window: Type.Optional(TimeWindow),
  },
  { additionalProperties: false },
);
export type MapResult = Static<typeof MapResult>;

/** map.json глазами потребителей: только итог; отметки и привязки — внутреннее дело digitizer. */
export const MapFileResults = Type.Object({
  v: Type.Literal(1),
  gameId: Type.String(),
  updatedAt: IsoDateTime,
  results: Type.Array(MapResult),
});
export type MapFileResults = Static<typeof MapFileResults>;

export const TableIssue = Type.Object(
  {
    severity: Type.Enum(['critical', 'cosmetic']),
    code: Type.Enum([
      'no_location',
      'unknown_map_id',
      'map_geo_mismatch',
      'not_on_map',
      'no_start',
      'no_finish',
      /** Загадка без отгадки — не ошибка: в маршрут не идёт, пока не решена. */
      'riddle_unsolved',
      /** Номер загадки совпал с КП из Notion. */
      'riddle_id_conflict',
      /** Отгадка (координаты) и точка на карте расходятся. */
      'riddle_map_mismatch',
    ]),
    kpId: Type.Optional(Type.String()),
    message: Type.String(),
  },
  { additionalProperties: false },
);
export type TableIssue = Static<typeof TableIssue>;

const Count = Type.Integer({ minimum: 0 });

/**
 * games/<дата>/points.json — таблица точек: КП из Notion + координаты (ручная правка → карта →
 * адрес) + доступность по пометке и цвету кружка. Вход для маршрута и телефонов.
 */
export const PointsFile = Type.Object(
  {
    v: Type.Literal(1),
    gameId: Type.String({ minLength: 1 }),
    createdAt: IsoDateTime,
    /** Из чего собрано — чтобы видеть, что таблица устарела. */
    sources: Type.Object(
      {
        kps: IsoDateTime,
        geo: Type.Optional(
          Type.Object({ osmBase: Type.String() }, { additionalProperties: false }),
        ),
        map: Type.Optional(
          Type.Object({ updatedAt: IsoDateTime }, { additionalProperties: false }),
        ),
        /** riddles.json — загадки со страницы «Загадки». */
        riddles: Type.Optional(
          Type.Object({ updatedAt: IsoDateTime }, { additionalProperties: false }),
        ),
      },
      { additionalProperties: false },
    ),
    /** Старт и финиш: game.json (вручную) → отметка СТАРТ/ФИНИШ на карте. Нужны маршруту. */
    start: Type.Optional(Loc),
    finish: Type.Optional(Loc),
    kps: Type.Array(Kp),
    stats: Type.Object(
      {
        kps: Count,
        eligible: Count,
        /** Сумма баллов доступных КП. */
        points: Type.Number({ minimum: 0 }),
        /** Откуда координаты (по всем КП с координатами). */
        locFrom: Type.Object(
          { manual: Count, map: Count, geocode: Count, gmaps_link: Count },
          { additionalProperties: false },
        ),
        eligibleWithoutLoc: Count,
      },
      { additionalProperties: false },
    ),
    issues: Type.Array(TableIssue),
  },
  { additionalProperties: false },
);
export type PointsFile = Static<typeof PointsFile>;
