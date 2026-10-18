// IndexedDB телефона: игры (phone.json), события (append-only), устройство (deviceId + seq).
import type { Event, PhoneGame } from '@bgq/core';
import { uuid } from './events.ts';

const NAME = 'bgq';
const VERSION = 1;

interface Device {
  deviceId: string;
  /** Следующий seq: монотонен в пределах устройства. */
  seq: number;
}

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('games', { keyPath: 'gameId' });
      d.createObjectStore('events', { keyPath: 'id' }).createIndex('gameId', 'gameId');
      d.createObjectStore('meta');
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

/** Записать событие; deviceId и seq выдаются в той же транзакции. */
export function appendEvent(build: (device: Device) => Event): Promise<Event> {
  return run(['meta', 'events'], 'readwrite', (tx, set) => {
    const meta = tx.objectStore('meta');
    const got = meta.get('device');
    got.onsuccess = () => {
      const device: Device = (got.result as Device | undefined) ?? { deviceId: uuid(), seq: 0 };
      const event = build(device);
      meta.put({ deviceId: device.deviceId, seq: device.seq + 1 }, 'device');
      tx.objectStore('events').add(event);
      set(event);
    };
  });
}
