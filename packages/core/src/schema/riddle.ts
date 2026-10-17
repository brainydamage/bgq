import Type, { type Static } from 'typebox';
import { IsoDateTime, KpId } from './common.ts';

/** Отгадка: однозначная точка (координаты, ссылка Google Maps / OSM) и как её ввели. */
export const RiddleAnswer = Type.Object(
  {
    lat: Type.Number({ minimum: -90, maximum: 90 }),
    lon: Type.Number({ minimum: -180, maximum: 180 }),
    /** Что вставили: «44.9714, 19.6101» или ссылка — чтобы перепроверить. */
    raw: Type.String(),
  },
  { additionalProperties: false },
);
export type RiddleAnswer = Static<typeof RiddleAnswer>;

/**
 * Загадка или задание с листка, место которого надо отгадать. Номер — как у КП (баллы по
 * правилу игры), места до отгадки нет. Решённая становится КП с kind: riddle.
 */
export const Riddle = Type.Object(
  {
    id: KpId,
    /** «Загадка», «Полузагадка», «Детская загадка» — как на листке. */
    title: Type.String(),
    /** Текст с листка (расшифровка ИИ), можно править. */
    text: Type.String(),
    /** Заметки по ходу решения. */
    notes: Type.String(),
    answer: Type.Optional(RiddleAnswer),
    updatedAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type Riddle = Static<typeof Riddle>;

/**
 * Задание с листка без места (фото у дерева, письмо, наклейки): пункт чек-листа секретаря.
 * Баллы обязательны — задание без баллов не делаем. Сделано или нет — события на телефоне.
 */
export const SheetTask = Type.Object(
  {
    /** «t-pismo-sebe» — из названия, латиницей. */
    id: KpId,
    title: Type.String({ minLength: 1 }),
    text: Type.String(),
    points: Type.Integer({ minimum: 1 }),
    /** «7–9 баллов» (жюри) — верхняя граница. */
    pointsMax: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Сдать на финише (письмо, пара наклеек) — напомнить перед финишем. */
    atFinish: Type.Boolean(),
    notes: Type.String(),
    updatedAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type SheetTask = Static<typeof SheetTask>;

/** games/<дата>/riddles.json — загадки игры; правится со страницы «Загадки» (./bgq map). */
export const RiddlesFile = Type.Object(
  {
    v: Type.Literal(1),
    gameId: Type.String({ minLength: 1 }),
    /** Фото листков (games/<дата>/riddles/) — оригинал на случай ошибок расшифровки. */
    sheets: Type.Array(Type.String()),
    riddles: Type.Array(Riddle),
    /** Задания без места — чек-лист; нет — пустой (файлы до 18.10). */
    tasks: Type.Optional(Type.Array(SheetTask)),
  },
  { additionalProperties: false },
);
export type RiddlesFile = Static<typeof RiddlesFile>;
