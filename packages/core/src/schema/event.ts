import Type, { type Static } from 'typebox';
import { HHMM, IsoDateTime, KpId, Loc, Uuid } from './common.ts';

/**
 * Общие поля события. Порядок — по (clientTs, deviceId, seq): часы двух телефонов
 * могут расходиться, seq монотонен в пределах устройства. id — ключ идемпотентности.
 */
const base = {
  v: Type.Literal(1),
  id: Uuid,
  gameId: Type.String({ minLength: 1 }),
  kpId: KpId,
  deviceId: Type.String({ minLength: 1 }),
  seq: Type.Integer({ minimum: 0 }),
  clientTs: IsoDateTime,
};

const opts = { additionalProperties: false } as const;

export const TakenEvent = Type.Object(
  { ...base, type: Type.Literal('taken'), answerTime: HHMM },
  opts,
);

export const SkippedEvent = Type.Object(
  { ...base, type: Type.Literal('skipped'), reason: Type.Optional(Type.String()) },
  opts,
);

/** Загадка разгадана: появилось место → точку можно маршрутизировать. */
export const SolvedEvent = Type.Object(
  {
    ...base,
    type: Type.Literal('solved'),
    answer: Type.Optional(Type.String()),
    loc: Type.Optional(Loc),
  },
  opts,
);

export const AnswerChangedEvent = Type.Object(
  {
    ...base,
    type: Type.Literal('answer_changed'),
    answer: Type.Optional(Type.String()),
    answerTime: Type.Optional(HHMM),
  },
  opts,
);

/** Отмена «взято»/«пропустить» (ошибочный тап). */
export const ReopenedEvent = Type.Object({ ...base, type: Type.Literal('reopened') }, opts);

/**
 * Переписано в бумажную книжку ответов: снимок того, что переписали. Ответ или время потом
 * поменялись — переписать заново (сравнение со снимком). Пустое поле — не указывается.
 */
export const CopiedEvent = Type.Object(
  {
    ...base,
    type: Type.Literal('copied'),
    answer: Type.Optional(Type.String()),
    answerTime: Type.Optional(HHMM),
  },
  opts,
);

/** Снята галочка «переписано». */
export const UncopiedEvent = Type.Object({ ...base, type: Type.Literal('uncopied') }, opts);

export const Event = Type.Union([
  TakenEvent,
  SkippedEvent,
  SolvedEvent,
  AnswerChangedEvent,
  ReopenedEvent,
  CopiedEvent,
  UncopiedEvent,
]);
export type Event = Static<typeof Event>;
