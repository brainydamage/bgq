// IndexedDB телефона: игры (phone.json), события (append-only), устройство (deviceId + seq),
// очередь на отправку (outbox: id событий, которых ещё нет на сервере), курсор синхронизации.
import { compareEvents, type Event, type PhoneGame } from '@bgq/core';
import { uuid } from './events.ts';
import type { SyncStore } from './sync.ts';

const NAME = 'bgq';
/** 1 — игры, события, meta; 2 — outbox (синхронизация). */
const VERSION = 2;

interface Device {
  deviceId: string;
  /** Следующий seq: монотонен в пределах устройства. */
  seq: number;
}

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('games', { keyPath: 'gameId' });
        d.createObjectStore('events', { keyPath: 'id' }).createIndex('gameId', 'gameId');
        d.createObjectStore('meta');
      }
      if (e.oldVersion < 2) {
        const outbox = d.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('gameId', 'gameId');
        // События, записанные до синхронизации, тоже уходят на сервер (повтор — не дубль).
        const cursor = req.transaction?.objectStore('events').openCursor();
        if (cursor)
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c) return;
            const ev = c.value as Event;
            outbox.put({ id: ev.id, gameId: ev.gameId });
            c.continue();
          };
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return opening;
}

/** Транзакция целиком: результат — когда она записана (complete), а не когда отработал запрос. */
function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction, set: (v: T) => void) => void,
): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(stores, mode);
        let value: T;
        body(tx, (v) => {
          value = v;
        });
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('транзакция прервана'));
      }),
  );
}

/** Текущая игра и её события. */
export function loadCurrent(): Promise<{ game: PhoneGame | null; events: Event[] }> {
  return run(['meta', 'games', 'events'], 'readonly', (tx, set) => {
    const cur = tx.objectStore('meta').get('currentGameId');
    cur.onsuccess = () => {
      const gameId = cur.result as string | undefined;
      if (!gameId) return set({ game: null, events: [] });
      const game = tx.objectStore('games').get(gameId);
      const events = tx.objectStore('events').index('gameId').getAll(gameId);
      events.onsuccess = () =>
        set({ game: (game.result as PhoneGame | undefined) ?? null, events: events.result });
    };
  });
}

/** Сохранить phone.json и сделать игру текущей; события (и других игр) не трогаются. */
export function saveGame(game: PhoneGame): Promise<void> {
  return run(['meta', 'games'], 'readwrite', (tx, set) => {
    tx.objectStore('games').put(game);
    tx.objectStore('meta').put(game.gameId, 'currentGameId');
    set(undefined);
  });
}

/** Записать событие и поставить в очередь на отправку; deviceId и seq — в той же транзакции. */
export function appendEvent(build: (device: Device) => Event): Promise<Event> {
  return run(['meta', 'events', 'outbox'], 'readwrite', (tx, set) => {
    const meta = tx.objectStore('meta');
    const got = meta.get('device');
    got.onsuccess = () => {
      const device: Device = (got.result as Device | undefined) ?? { deviceId: uuid(), seq: 0 };
      const event = build(device);
      meta.put({ deviceId: device.deviceId, seq: device.seq + 1 }, 'device');
      tx.objectStore('events').add(event);
      tx.objectStore('outbox').put({ id: event.id, gameId: event.gameId });
      set(event);
    };
  });
}

const cursorKey = (gameId: string) => `cursor:${gameId}`;

/** Очередь и курсор синхронизации в IndexedDB. */
export const syncStore: SyncStore = {
  pending(gameId, limit, skip) {
    return run<Event[]>(['outbox', 'events'], 'readwrite', (tx, set) => {
      const outbox = tx.objectStore('outbox');
      const keys = outbox.index('gameId').getAllKeys(gameId);
      keys.onsuccess = () => {
        const ids = (keys.result as string[]).filter((id) => !skip.has(id));
        const found: Event[] = [];
        let left = ids.length;
        if (!left) return set([]);
        for (const id of ids) {
          const got = tx.objectStore('events').get(id);
          got.onsuccess = () => {
            if (got.result) found.push(got.result as Event);
            else outbox.delete(id); // события нет — нечего отправлять
            if (--left === 0) set(found.sort(compareEvents).slice(0, limit));
          };
        }
      };
    });
  },
  pendingCount(gameId) {
    return run<number>(['outbox'], 'readonly', (tx, set) => {
      const n = tx.objectStore('outbox').index('gameId').count(gameId);
      n.onsuccess = () => set(n.result);
    });
  },
  markSent(ids) {
    return run<void>(['outbox'], 'readwrite', (tx, set) => {
      for (const id of ids) tx.objectStore('outbox').delete(id);
      set(undefined);
    });
  },
  saveRemote(events) {
    // События неизменяемы по id: put поверх своего же — то же содержимое.
    return run<void>(['events'], 'readwrite', (tx, set) => {
      for (const e of events) tx.objectStore('events').put(e);
      set(undefined);
    });
  },
  getCursor(gameId) {
    return run<string>(['meta'], 'readonly', (tx, set) => {
      const got = tx.objectStore('meta').get(cursorKey(gameId));
      got.onsuccess = () => set((got.result as string | undefined) ?? '');
    });
  },
  setCursor(gameId, cursor) {
    return run<void>(['meta'], 'readwrite', (tx, set) => {
      tx.objectStore('meta').put(cursor, cursorKey(gameId));
      set(undefined);
    });
  },
};
