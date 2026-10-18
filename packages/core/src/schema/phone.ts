import Type, { type Static } from 'typebox';
import { HHMM, IsoDate, IsoDateTime } from './common.ts';
import { SheetTask } from './riddle.ts';

/**
 * games/<дата>/phone.json — данные игры для телефона (`./bgq pwa`, на iPhone — по AirDrop).
 * Сборка PWA данных игры не содержит; отметки на телефоне — события, не этот файл.
 */
export const PhoneGame = Type.Object(
  {
    v: Type.Literal(1),
    gameId: Type.String({ minLength: 1 }),
    city: Type.String(),
    date: IsoDate,
    /** Часовой пояс игры: время «сделано» и напоминание перед финишем. */
    tz: Type.String({ minLength: 1 }),
    /** Дедлайн финиша «ЧЧ:ММ» (старт + 9 ч). */
    deadline: HHMM,
    exportedAt: IsoDateTime,
    /** Задания без места — чек-лист секретаря. */
    tasks: Type.Array(SheetTask),
  },
  { additionalProperties: false },
);
export type PhoneGame = Static<typeof PhoneGame>;
