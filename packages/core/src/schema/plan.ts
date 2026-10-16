import Type, { type Static } from 'typebox';
import { IsoDateTime, KpId, Uuid } from './common.ts';

const Seconds = Type.Integer({ minimum: 0 });

export const PlanStop = Type.Object(
  {
    kpId: KpId,
    arriveS: Seconds,
    departS: Seconds,
  },
  { additionalProperties: false },
);
export type PlanStop = Static<typeof PlanStop>;

export const Plan = Type.Object(
  {
    v: Type.Literal(1),
    planId: Uuid,
    gameId: Type.String({ minLength: 1 }),
    /** Хэш Problem, из которого построен план. */
    problemHash: Type.String({ minLength: 1 }),
    createdAt: IsoDateTime,
    solver: Type.Enum(['ortools', 'heuristic']),
    solverMs: Type.Integer({ minimum: 0 }),
    t0: IsoDateTime,
    stops: Type.Array(PlanStop),
    finishS: Seconds,
    /** Запас до дедлайна в минутах; отрицательный — опоздание. */
    slackMin: Type.Number(),
    totalPoints: Type.Number({ minimum: 0 }),
    expectedPrize: Type.Number({ minimum: 0 }),
    distanceM: Type.Integer({ minimum: 0 }),
    dropped: Type.Array(KpId),
  },
  { additionalProperties: false },
);
export type Plan = Static<typeof Plan>;
