import Type, { type Static } from 'typebox';
import { HHMM, IsoDate, IsoDateTime, Loc } from './common.ts';
import { Kp } from './kp.ts';
import { Plan } from './plan.ts';
import { SheetTask } from './riddle.ts';
import { SyncConfig } from './sync.ts';

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
    /** Доступные КП из points.json (с загадками) — карточки секретаря. Нет — только чек-лист. */
    kps: Type.Optional(Type.Array(Kp)),
    start: Type.Optional(Loc),
    finish: Type.Optional(Loc),
    /** Свежий plan.json (не старее problem.json и points.json); устаревший не кладётся. */
    plan: Type.Optional(Plan),
    /** Синхронизация событий между телефонами (`games/sync.json`). Нет — отметки только локально. */
    sync: Type.Optional(SyncConfig),
  },
  { additionalProperties: false },
);
export type PhoneGame = Static<typeof PhoneGame>;
