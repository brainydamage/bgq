import type { Game } from './schema/game.ts';
import type { PhoneGame } from './schema/phone.ts';
import type { Plan } from './schema/plan.ts';
import type { RiddlesFile } from './schema/riddle.ts';
import type { PointsFile } from './schema/table.ts';

/**
 * game.json + riddles.json (может не быть) + points.json и свежий plan.json (могут не быть) →
 * phone.json. На телефон идут только доступные КП; план — как есть (проверьте planMissing).
 */
export function phoneGame(
  game: Game,
  riddles: RiddlesFile | null,
  exportedAt: string,
  route: { points: PointsFile; plan?: Plan } | null = null,
): PhoneGame {
  return {
    v: 1,
    gameId: game.id,
    city: game.city,
    date: game.date,
    tz: game.tz,
    deadline: game.finish.deadline,
    exportedAt,
    tasks: riddles?.tasks ?? [],
    ...(route && {
      kps: route.points.kps.filter((k) => k.eligible),
      ...(route.points.start && { start: route.points.start }),
      ...(route.points.finish && { finish: route.points.finish }),
      ...(route.plan && { plan: route.plan }),
    }),
  };
}

/** КП плана, которых нет среди доступных КП с координатами (план не с этой карты). */
export function planMissing(plan: Plan, points: PointsFile): string[] {
  const located = new Set(points.kps.filter((k) => k.eligible && k.loc).map((k) => k.id));
  return plan.stops.map((s) => s.kpId).filter((id) => !located.has(id));
}
