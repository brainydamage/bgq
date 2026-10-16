import type { Category, MapColor } from './schema/game.ts';
import type { Kp } from './schema/kp.ts';

/** Доступен ли КП нашей категории: пометка в тексте + цвет кружка (если уже известен). */
export function isEligible(
  kp: Pick<Kp, 'note' | 'mapColor'>,
  game: { category: Category; allowedColors: readonly MapColor[] },
): boolean {
  if (kp.note === 'velo_only' && game.category !== 'velo') return false;
  if (kp.note === 'pro_only' && game.category !== 'pro') return false;
  if (kp.mapColor && !game.allowedColors.includes(kp.mapColor)) return false;
  return true;
}
