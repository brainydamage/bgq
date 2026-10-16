import Type, { type Static } from 'typebox';
import { HHMM, IsoDate, Loc } from './common.ts';

export const MapColor = Type.Enum(['red', 'blue', 'green']);
export type MapColor = Static<typeof MapColor>;

export const Category = Type.Enum(['pro', 'velo']);
export type Category = Static<typeof Category>;

/** Правило баллов: floor(номер / divisor), буквы в номере игнорируются. */
export const PointsRule = Type.Object(
  {
    kind: Type.Literal('floor_div'),
    divisor: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type PointsRule = Static<typeof PointsRule>;

/** Конфиг игры: games/<id>/game.json. */
export const Game = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    city: Type.String(),
    date: IsoDate,
    tz: Type.String({ minLength: 1 }),
    start: Type.Object({ time: HHMM, loc: Type.Optional(Loc) }, { additionalProperties: false }),
    finish: Type.Object(
      {
        deadline: HHMM,
        graceMin: Type.Integer({ minimum: 0 }),
        penaltyPerMin: Type.Number({ minimum: 0 }),
        address: Type.Optional(Type.String()),
        loc: Type.Optional(Loc),
      },
      { additionalProperties: false },
    ),
    category: Category,
    mode: Type.Enum(['foot', 'bike']),
    /** Цвета кружков на карте, доступные нашей категории (ПРО: красный + синий). */
    allowedColors: Type.Array(MapColor, { minItems: 1, uniqueItems: true }),
    pointsRule: PointsRule,
  },
  { additionalProperties: false },
);
export type Game = Static<typeof Game>;
