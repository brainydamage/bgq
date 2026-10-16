import Type, { type Static } from 'typebox';
import { HHMM, KpId, Loc } from './common.ts';
import { MapColor } from './game.ts';

export const KpKind = Type.Enum(['classic', 'riddle', 'task', 'photo']);
export type KpKind = Static<typeof KpKind>;

export const AnswerKind = Type.Enum(['text', 'photo', 'drawing', 'judge', 'video']);
export type AnswerKind = Static<typeof AnswerKind>;

/** Пометка в тексте задания («только для Вело» / «только для ПРО»), независимо от цвета кружка. */
export const KpNote = Type.Enum(['velo_only', 'pro_only']);
export type KpNote = Static<typeof KpNote>;

export const Address = Type.Object(
  {
    /** Как в источнике, без нормализации (латиница в кириллице сохраняется). */
    raw: Type.String(),
    street: Type.String(),
    /** "98", "16А", "16-20"; null — улица без номера дома. */
    house: Type.Union([Type.String(), Type.Null()]),
    /** Адрес в скобках: "Деканске Баште (Водна 16А)" → "Водна 16А". */
    alt: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Address = Static<typeof Address>;

export const Link = Type.Object(
  {
    url: Type.String(),
    kind: Type.Enum(['maps', 'video', 'other']),
  },
  { additionalProperties: false },
);
export type Link = Static<typeof Link>;

export const TimeWindow = Type.Object({ from: HHMM, to: HHMM }, { additionalProperties: false });
export type TimeWindow = Static<typeof TimeWindow>;

/**
 * Точка игры. Статичные данные — состояние (взято/пропущено/ответ) не хранится здесь,
 * а вычисляется из Event[].
 */
export const Kp = Type.Object(
  {
    id: KpId,
    /** null — задания без номера («Письмо себе»). */
    number: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    kind: KpKind,
    points: Type.Number({ minimum: 0 }),
    /** Верхняя граница, если баллы — диапазон (7–9). */
    pointsMax: Type.Optional(Type.Number({ minimum: 0 })),
    mapColor: Type.Optional(MapColor),
    note: Type.Optional(KpNote),
    /** Доступен нашей категории: по note, mapColor и Game. */
    eligible: Type.Boolean(),
    title: Type.String(),
    address: Type.Optional(Address),
    description: Type.Array(Type.String()),
    /** Зачёркнутые (устаревшие) строки — для справки, не для ответа. */
    struck: Type.Array(Type.String()),
    /** «+ Сделайте фото…» — доп. фото на КП. */
    extraPhoto: Type.Optional(Type.String()),
    links: Type.Array(Link),
    answerKind: AnswerKind,
    loc: Type.Optional(Loc),
    /** Другие кандидаты координат (карта vs геокод) — чтобы ловить расхождения. */
    altLocs: Type.Optional(Type.Array(Loc)),
    window: Type.Optional(TimeWindow),
    /** Время на точке; если нет — дефолт из params по kind/answerKind. */
    serviceMin: Type.Optional(Type.Number({ minimum: 0 })),
    /** Исходный markdown блока — карточка может показать его как есть. */
    raw: Type.String(),
  },
  { additionalProperties: false },
);
export type Kp = Static<typeof Kp>;
