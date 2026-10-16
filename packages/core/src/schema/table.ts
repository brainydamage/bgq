import Type, { type Static } from 'typebox';
import { IsoDateTime, KpId, Loc } from './common.ts';
import { MapColor } from './game.ts';
import { Kp } from './kp.ts';

/** Итог digitizer по КП (map.json → results). Стрелка за краем карты — без координат. */
export const MapResult = Type.Object(
  {
    id: KpId,
    loc: Type.Optional(Loc),
    color: Type.Union([MapColor, Type.Null()]),
    photo: Type.String(),
    /** Стрелка «КП за краем карты»: даёт только цвет (категорию), координаты — по адресу. */
    arrow: Type.Optional(Type.Boolean()),
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
    code: Type.Enum(['no_location', 'unknown_map_id', 'map_geo_mismatch', 'not_on_map']),
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
      },
      { additionalProperties: false },
    ),
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
