import Type, { type Static } from 'typebox';
import { IsoDateTime, Uuid } from './common.ts';
import { Event } from './event.ts';

/** Адрес синхронизации и общий код команды — в phone.json (`games/sync.json` → `./bgq pwa`). */
export const SyncConfig = Type.Object(
  {
    /** Lambda Function URL `https://….lambda-url.<регион>.on.aws/`; `http://localhost:…` — проверка без AWS. */
    url: Type.String({ pattern: '^(https://|http://localhost[:/])' }),
    code: Type.String({ minLength: 16 }),
  },
  { additionalProperties: false },
);
export type SyncConfig = Static<typeof SyncConfig>;

/** Сколько событий телефон отправляет за один запрос. */
export const SYNC_BATCH = 100;

/**
 * Курсор чтения: `<время прихода на сервер, ISO>#<id события>` последнего полученного события;
 * '' — с начала игры. Время — серверное: событие из очереди, отправленное с опозданием, не теряется.
 */
export const SyncCursor = Type.String({
  pattern: '^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z#[0-9a-f-]{36})?$',
});

const envelope = {
  v: Type.Literal(1),
  gameId: Type.String({ pattern: '^[\\w.-]{1,64}$' }),
  after: SyncCursor,
};

/** POST /sync: свои неотправленные события + чужие (и свои) после курсора. */
export const SyncRequest = Type.Object(
  { ...envelope, events: Type.Array(Event, { maxItems: SYNC_BATCH }) },
  { additionalProperties: false },
);
export type SyncRequest = Static<typeof SyncRequest>;

/**
 * Запрос без проверки событий: сервер проверяет каждое отдельно. Событие, которого сервер не знает
 * (новый тип с телефона новее сервера), уходит в `rejected` и не задерживает остальные.
 */
export const SyncEnvelope = Type.Object(
  { ...envelope, events: Type.Array(Type.Unknown(), { maxItems: SYNC_BATCH }) },
  { additionalProperties: false },
);

export const SyncResponse = Type.Object(
  {
    v: Type.Literal(1),
    /** id принятых событий, включая уже бывшие на сервере (повторная отправка). */
    accepted: Type.Array(Uuid),
    /** Не принятые: не по схеме сервера или другой игры. Телефон держит их в очереди. */
    rejected: Type.Array(
      Type.Object({ id: Type.String(), error: Type.String() }, { additionalProperties: false }),
    ),
    /**
     * События игры после курсора (с запасом назад) — и свои: после очистки хранилища вернутся.
     * Телефон проверяет их по одному и пропускает незнакомые (сервер новее телефона).
     */
    events: Type.Array(Event),
    cursor: SyncCursor,
    /** Есть ещё события после cursor — повторить запрос. */
    more: Type.Boolean(),
    /** Часы сервера: телефон сверяет свои (порядок событий — по clientTs). */
    serverTime: IsoDateTime,
  },
  { additionalProperties: false },
);
export type SyncResponse = Static<typeof SyncResponse>;
