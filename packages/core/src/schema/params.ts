import Type, { type Static } from 'typebox';

const Minutes = Type.Number({ minimum: 0 });

/**
 * Параметры модели маршрута: games/<дата>/params.json (необязательный) поверх DEFAULT_PARAMS.
 * Стартовые значения — из калибровки по игре 10.10 (бриф, раздел 2); потом их уточнит analysis.
 */
export const Params = Type.Object(
  {
    v: Type.Literal(1),
    /** Скорость на ходу, км/ч. */
    speedKmh: Type.Number({ exclusiveMinimum: 0 }),
    /** Время на точке по типу ответа, мин; default — для всего остального. */
    serviceMin: Type.Object(
      {
        default: Minutes,
        text: Type.Optional(Minutes),
        photo: Type.Optional(Minutes),
        drawing: Type.Optional(Minutes),
        judge: Type.Optional(Minutes),
        video: Type.Optional(Minutes),
      },
      { additionalProperties: false },
    ),
    /** Отдых одним блоком, мин; 0 — не закладывать. */
    restMin: Minutes,
  },
  { additionalProperties: false },
);
export type Params = Static<typeof Params>;

export const DEFAULT_PARAMS: Params = {
  v: 1,
  speedKmh: 4.3,
  // КП 4–6 мин; судья/видео дольше (бриф, раздел 2).
  serviceMin: { default: 5, drawing: 6, judge: 15, video: 10 },
  restMin: 0,
};
