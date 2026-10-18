// Синхронизация событий между телефонами (POST /sync, packages/sync). Local-first: отметка пишется
// в IndexedDB и в очередь (outbox) сразу, отправка — в фоне с повторами; интерфейс сети не ждёт.
// Состояние — по-прежнему projectState по всем событиям, дубли по id отбрасываются.
import {
  clockIn,
  Event,
  SYNC_BATCH,
  type SyncConfig,
  type SyncRequest,
  SyncResponse,
  schemaErrors,
} from '@bgq/core';

/** Хранилище для синхронизации (IndexedDB — db.ts, память — тесты). */
export interface SyncStore {
  /** Неотправленные события игры, кроме `skip`, не больше `limit`. */
  pending(gameId: string, limit: number, skip: ReadonlySet<string>): Promise<Event[]>;
  pendingCount(gameId: string): Promise<number>;
  /** Убрать из очереди (сервер принял). */
  markSent(ids: string[]): Promise<void>;
  /** Сохранить события с сервера (свои и чужие), не ставя в очередь. */
  saveRemote(events: Event[]): Promise<void>;
  getCursor(gameId: string): Promise<string>;
  setCursor(gameId: string, cursor: string): Promise<void>;
}

export type Send = (req: SyncRequest) => Promise<SyncResponse>;

/** Ошибка запроса; status 0 — нет связи, тайм-аут или ответ не по схеме. */
export class SyncError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Без лишних запросов за один заход: 20 × 100 событий. */
const MAX_ROUNDS = 20;
/** Пока всё отправлено — подтягивать чужие события раз в 20 с. */
export const PERIOD_MS = 20_000;
/** Расхождение часов с сервером, о котором стоит сказать (порядок событий — по clientTs). */
export const SKEW_WARN_MS = 2 * 60_000;

export interface SyncResult {
  received: Event[];
  sent: number;
  /** id, которые сервер не принял (не по его схеме): остаются в очереди. */
  rejected: string[];
}

/**
 * Один заход: отправить очередь пачками, принять события после курсора, сдвинуть курсор.
 * Порядок записи: события сервера → очередь → курсор; оборвалось посередине — следующий заход
 * повторит, всё идемпотентно по id.
 */
export async function syncOnce(
  gameId: string,
  store: SyncStore,
  send: Send,
  skip: ReadonlySet<string> = new Set(),
): Promise<SyncResult> {
  const received: Event[] = [];
  const rejected = new Set(skip);
  let sent = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const events = await store.pending(gameId, SYNC_BATCH, rejected);
    const res = await send({ v: 1, gameId, after: await store.getCursor(gameId), events });
    const accepted = new Set(res.accepted);
    for (const r of res.rejected) rejected.add(r.id);
    if (res.events.length) await store.saveRemote(res.events);
    const done = events.filter((e) => accepted.has(e.id)).map((e) => e.id);
    if (done.length) await store.markSent(done);
    await store.setCursor(gameId, res.cursor);
    received.push(...res.events);
    sent += done.length;
    if (!res.more && events.length < SYNC_BATCH) break;
  }
  return { received, sent, rejected: [...rejected] };
}

/**
 * Ответ сервера: конверт — по схеме, события — по одному; незнакомые (сервер новее оболочки)
 * пропускаются, а не ломают синхронизацию.
 */
export function parseResponse(data: unknown): SyncResponse {
  const events = (data as { events?: unknown } | null)?.events;
  const errors = schemaErrors(SyncResponse, { ...(data as object), events: [] });
  if (errors.length || !Array.isArray(events))
    throw new SyncError(`ответ сервера не по схеме: ${errors.slice(0, 2).join('; ')}`, 0);
  return {
    ...(data as SyncResponse),
    events: events.filter((e) => schemaErrors(Event, e).length === 0) as Event[],
  };
}

/** POST на Function URL с кодом команды; тайм-аут — 15 с. */
export function httpSend(cfg: SyncConfig, timeoutMs = 15_000): Send {
  return async (req) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bgq-code': cfg.code },
        body: JSON.stringify(req),
        cache: 'no-store',
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let error = text.slice(0, 200);
        try {
          error = (JSON.parse(text) as { error?: string }).error ?? error;
        } catch {
          // не JSON — показываем как есть
        }
        throw new SyncError(`${res.status} ${error}`, res.status);
      }
      return parseResponse(JSON.parse(text));
    } catch (e) {
      if (e instanceof SyncError) throw e;
      throw new SyncError(ctrl.signal.aborted ? 'тайм-аут' : 'нет связи', 0);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Пауза перед повтором: 2, 4, 8 … 60 с, со случайным разбросом 50–100%. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(60_000, 2000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.5 + random() * 0.5));
}

export interface SyncStatus {
  /** idle — ждёт, syncing — идёт заход, offline — нет связи/ошибка, denied — сервер не принял код. */
  state: 'idle' | 'syncing' | 'offline' | 'denied';
  pending: number;
  lastOk?: Date;
  /** Часы сервера минус часы телефона, мс. */
  skewMs?: number;
  /** Сколько событий сервер не принял (остаются в очереди). */
  rejected: number;
  error?: string;
}

export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Syncer {
  /** Синхронизировать сейчас (после отметки, при появлении сети, при возврате в приложение). */
  kick(): void;
  stop(): void;
}

/** Фоновая синхронизация: заходы по kick() и раз в PERIOD_MS, при ошибке — повтор с паузой. */
export function createSyncer(deps: {
  gameId: string;
  store: SyncStore;
  send: Send;
  onStatus: (s: SyncStatus) => void;
  /** События с сервера (могут быть уже известные — сливать по id). */
  onEvents: (events: Event[]) => void;
  now?: () => number;
  timer?: Timer;
  random?: () => number;
}): Syncer {
  const now = deps.now ?? Date.now;
  const timer = deps.timer ?? realTimer;
  let status: SyncStatus = { state: 'idle', pending: 0, rejected: 0 };
  let running = false;
  let again = false;
  let stopped = false;
  let attempt = 0;
  let handle: unknown = null;
  let rejected = new Set<string>();

  const emit = (patch: Partial<SyncStatus>) => {
    status = { ...status, ...patch };
    if (!stopped) deps.onStatus(status);
  };

  const schedule = (ms: number) => {
    if (handle !== null) timer.clear(handle);
    handle = timer.set(() => {
      handle = null;
      void run();
    }, ms);
  };

  // Замер расхождения часов: серверное время против середины запроса.
  const send: Send = async (req) => {
    const t0 = now();
    const res = await deps.send(req);
    const mid = (t0 + now()) / 2;
    emit({ skewMs: Date.parse(res.serverTime) - mid });
    return res;
  };

  async function run(): Promise<void> {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    let ok = false;
    try {
      emit({ state: 'syncing', pending: await deps.store.pendingCount(deps.gameId) });
      const res = await syncOnce(deps.gameId, deps.store, send, rejected);
      rejected = new Set(res.rejected);
      if (res.received.length && !stopped) deps.onEvents(res.received);
      attempt = 0;
      ok = true;
      emit({
        state: 'idle',
        pending: await deps.store.pendingCount(deps.gameId),
        lastOk: new Date(now()),
        rejected: rejected.size,
        error: undefined,
      });
    } catch (e) {
      attempt++;
      const code = e instanceof SyncError ? e.status : 0;
      emit({
        state: code === 401 || code === 403 ? 'denied' : 'offline',
        pending: await deps.store.pendingCount(deps.gameId).catch(() => status.pending),
        error: (e as Error).message,
      });
    } finally {
      running = false;
    }
    if (stopped) return;
    if (again && ok) {
      again = false;
      return run();
    }
    again = false;
    schedule(ok ? PERIOD_MS : backoffMs(attempt, deps.random));
  }

  return {
    kick() {
      if (stopped) return;
      if (handle !== null) {
        timer.clear(handle);
        handle = null;
      }
      void run();
    },
    stop() {
      stopped = true;
      if (handle !== null) timer.clear(handle);
      handle = null;
    },
  };
}

/** Новые по id события — в конец списка; ничего нового — тот же массив (без перерисовки). */
export function mergeEvents(prev: Event[], incoming: readonly Event[]): Event[] {
  const have = new Set(prev.map((e) => e.id));
  const add: Event[] = [];
  for (const e of incoming) {
    if (have.has(e.id)) continue;
    have.add(e.id);
    add.push(e);
  }
  return add.length ? [...prev, ...add] : prev;
}

/** Строка для подвала. null — в phone.json нет адреса синхронизации. */
export function syncText(s: SyncStatus | null, tz: string): string {
  if (!s) return '△ без синхронизации — в phone.json нет адреса (games/sync.json)';
  const last = s.lastOk ? clockIn(tz, s.lastOk).hhmm : null;
  const queue = s.pending ? ` · в очереди ${s.pending}` : '';
  let text: string;
  if (s.state === 'denied') text = `✗ сервер не принял код — обновите phone.json${queue}`;
  else if (s.state === 'offline') text = `△ нет связи${queue}${last ? ` · было в ${last}` : ''}`;
  else if (s.pending) text = `⟳ в очереди ${s.pending}`;
  else if (last) text = `✓ синхронизировано ${last}`;
  else text = '⟳ синхронизация…';
  if (s.rejected) text += ` · △ сервер не принял ${s.rejected} (обновите сервер)`;
  if (s.skewMs !== undefined && Math.abs(s.skewMs) > SKEW_WARN_MS) {
    const min = Math.round(Math.abs(s.skewMs) / 60_000);
    text += ` · △ часы телефона ${s.skewMs < 0 ? 'спешат' : 'отстают'} на ${min} мин`;
  }
  return text;
}
