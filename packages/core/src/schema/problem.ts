import Type, { type Static } from 'typebox';
import { IsoDateTime, KpId } from './common.ts';

const Seconds = Type.Integer({ minimum: 0 });

export const ProblemNode = Type.Object(
  {
    kpId: Type.Union([KpId, Type.Null()]),
    role: Type.Enum(['start', 'finish', 'kp']),
    lat: Type.Number({ minimum: -90, maximum: 90 }),
    lon: Type.Number({ minimum: -180, maximum: 180 }),
    /** Ожидаемая ценность: баллы × уверенность. Солверы правил баллов не знают. */
    prize: Type.Number({ minimum: 0 }),
    serviceS: Seconds,
    /** [открытие, закрытие] в секундах от t0. */
    window: Type.Optional(Type.Tuple([Seconds, Seconds])),
  },
  { additionalProperties: false },
);
export type ProblemNode = Static<typeof ProblemNode>;

export const RestBlock = Type.Object(
  {
    durationS: Seconds,
    fromS: Type.Optional(Seconds),
    toS: Type.Optional(Seconds),
  },
  { additionalProperties: false },
);

/** Единый вход обоих солверов (OR-Tools и TS-эвристика). Все времена — секунды от t0. */
export const Problem = Type.Object(
  {
    v: Type.Literal(1),
    gameId: Type.String({ minLength: 1 }),
    t0: IsoDateTime,
    nodes: Type.Array(ProblemNode, { minItems: 2 }),
    matrix: Type.Object(
      {
        source: Type.Enum(['osrm', 'ors', 'haversine']),
        /** durationS[i][j] — пешком от nodes[i] до nodes[j], целые секунды (OR-Tools). */
        durationS: Type.Array(Type.Array(Seconds)),
      },
      { additionalProperties: false },
    ),
    start: Type.Integer({ minimum: 0 }),
    finish: Type.Integer({ minimum: 0 }),
    deadlineS: Seconds,
    softLateMaxS: Seconds,
    latePenaltyPerMin: Type.Number({ minimum: 0 }),
    rest: Type.Optional(Type.Array(RestBlock)),
    speedKmh: Type.Number({ exclusiveMinimum: 0 }),
    warmStart: Type.Optional(Type.Array(KpId)),
  },
  { additionalProperties: false },
);
export type Problem = Static<typeof Problem>;
