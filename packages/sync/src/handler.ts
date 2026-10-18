// POST /sync (Lambda Function URL): события телефона → хранилище, в ответ — события игры после
// курсора. Доступ — общий код команды в заголовке x-bgq-code. CORS отвечает сам Function URL.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Event, SyncEnvelope, type SyncResponse, schemaErrors } from '@bgq/core';
import type { EventStore } from './store.ts';

/** Запрос Function URL (payload 2.0) — только нужные поля. */
export interface UrlRequest {
  requestContext: { http: { method: string } };
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface UrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Предел тела запроса: 100 событий с ответами — десятки КБ. */
export const MAX_BODY = 256 * 1024;
/**
 * Чтение — с запасом назад от курсора: запись, получившая время прихода чуть раньше, могла
 * закончиться после того, как телефон прочитал более позднюю. Повторы телефон отбрасывает по id.
 */
export const OVERLAP_MS = 60_000;
/** Событий в одном ответе; больше — `more: true`. */
export const PAGE = 500;
/** Одновременных записей в хранилище. */
const PUT_CONCURRENCY = 10;

const json = (statusCode: number, body: unknown): UrlResponse => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});
const fail = (statusCode: number, error: string) => json(statusCode, { error });

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Сравнение кода за постоянное время. */
function codeMatches(given: string | undefined, code: string): boolean {
  return given !== undefined && timingSafeEqual(digest(given), digest(code));
}

/** Нижняя граница чтения: курсор минус OVERLAP_MS; без курсора — с начала ('0' < любой ISO). */
export function readFrom(after: string): string {
  if (!after) return '0';
  const t = Date.parse(after.slice(0, after.indexOf('#')));
  return new Date(t - OVERLAP_MS).toISOString();
}

async function eachLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function createHandler(deps: { store: EventStore; code: string; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return async (req: UrlRequest): Promise<UrlResponse> => {
    if (req.requestContext.http.method !== 'POST') return fail(405, 'нужен POST');
    if (!codeMatches(req.headers?.['x-bgq-code'], deps.code)) return fail(401, 'неверный код');

    const raw = req.isBase64Encoded
      ? Buffer.from(req.body ?? '', 'base64').toString('utf8')
      : (req.body ?? '');
    if (Buffer.byteLength(raw) > MAX_BODY) return fail(413, `тело больше ${MAX_BODY} байт`);
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return fail(400, 'тело — не JSON');
    }
    const errors = schemaErrors(SyncEnvelope, data);
    if (errors.length) return fail(400, errors.slice(0, 3).join('; '));
    const body = data as { gameId: string; after: string; events: unknown[] };

    // Каждое событие — отдельно: незнакомое не задерживает остальные.
    const valid: Event[] = [];
    const rejected: SyncResponse['rejected'] = [];
    for (const e of body.events) {
      const id = String((e as { id?: unknown } | null)?.id ?? '?');
      const bad = schemaErrors(Event, e);
      if (bad.length) rejected.push({ id, error: bad.slice(0, 3).join('; ') });
      else if ((e as Event).gameId !== body.gameId)
        rejected.push({ id, error: `другая игра (${(e as Event).gameId})` });
      else valid.push(e as Event);
    }

    // Время прихода — одно на запрос; ключ уникален за счёт id.
    const receivedAt = now().toISOString();
    await eachLimit(valid, PUT_CONCURRENCY, async (e) => {
      await deps.store.put(body.gameId, `${receivedAt}#${e.id}`, e);
    });

    const { items, more } = await deps.store.list(body.gameId, readFrom(body.after), PAGE);
    const last = items.at(-1)?.r ?? '';
    const res: SyncResponse = {
      v: 1,
      accepted: valid.map((e) => e.id),
      rejected,
      events: items.map((s) => s.event),
      // Курсор не откатывается назад: всё, что вернулось из запаса, уже было у телефона.
      cursor: last > body.after ? last : body.after,
      more,
      serverTime: now().toISOString(),
    };
    return json(200, res);
  };
}
