import type { Game } from './schema/game.ts';
import type { PhoneGame } from './schema/phone.ts';
import type { RiddlesFile } from './schema/riddle.ts';

/** game.json + riddles.json (может не быть) → phone.json. */
export function phoneGame(game: Game, riddles: RiddlesFile | null, exportedAt: string): PhoneGame {
  return {
    v: 1,
    gameId: game.id,
    city: game.city,
    date: game.date,
    tz: game.tz,
    deadline: game.finish.deadline,
    exportedAt,
    tasks: riddles?.tasks ?? [],
  };
}
