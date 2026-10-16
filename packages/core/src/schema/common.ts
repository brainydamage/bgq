import Type, { type Static } from 'typebox';

/** Локальное время «ЧЧ:ММ» — так оно пишется в книжку и на карте. */
export const HHMM = Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' });

/**
 * Номерной КП: число + необязательная кириллическая буква ("25А"), дубль из отчёта — "25А#2".
 * Задание без номера — slug ("t-letter-to-self").
 */
export const KpId = Type.String({ pattern: '^(\\d{1,3}[А-ЯЁ]?(#\\d+)?|[a-z][a-z0-9-]*)$' });
export type KpId = Static<typeof KpId>;

export const LocSource = Type.Enum(['geocode', 'map', 'manual', 'gmaps_link']);

export const Loc = Type.Object(
  {
    lat: Type.Number({ minimum: -90, maximum: 90 }),
    lon: Type.Number({ minimum: -180, maximum: 180 }),
    source: LocSource,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);
export type Loc = Static<typeof Loc>;

/** ISO 8601 с явной зоной: "2026-10-10T10:30:00+02:00". Паттерн, а не format — одинаково в TypeBox, Ajv и Python. */
export const IsoDateTime = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$',
});

export const IsoDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

export const Uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});
