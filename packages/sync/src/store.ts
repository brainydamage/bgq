import type { Event } from '@bgq/core';

/** Событие на сервере: `r` — ключ чтения `<время прихода ISO>#<id>`, растёт по приходу. */
export interface StoredEvent {
  r: string;
  event: Event;
}

/** Хранилище событий игры: DynamoDB в Lambda, память в тестах. */
export interface EventStore {
  /** Записать, если события с таким id в игре ещё нет (идемпотентно по id). */
  put(gameId: string, r: string, event: Event): Promise<'stored' | 'duplicate'>;
  /** События игры с ключом больше `after`, по возрастанию ключа, не больше `limit`. */
  list(
    gameId: string,
    after: string,
    limit: number,
  ): Promise<{ items: StoredEvent[]; more: boolean }>;
}

/** Хранилище в памяти — тесты обработчика без AWS. */
export function memoryStore(): EventStore & { games: Map<string, Map<string, StoredEvent>> } {
  const games = new Map<string, Map<string, StoredEvent>>();
  return {
    games,
    async put(gameId, r, event) {
      const game = games.get(gameId) ?? new Map<string, StoredEvent>();
      games.set(gameId, game);
      if (game.has(event.id)) return 'duplicate';
      game.set(event.id, { r, event: structuredClone(event) });
      return 'stored';
    },
    async list(gameId, after, limit) {
      const all = [...(games.get(gameId)?.values() ?? [])]
        .filter((s) => s.r > after)
        .sort((a, b) => (a.r < b.r ? -1 : 1));
      return {
        items: all.slice(0, limit).map((s) => structuredClone(s)),
        more: all.length > limit,
      };
    },
  };
}
