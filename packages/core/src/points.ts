import type { PointsRule } from './schema/game.ts';

/** Баллы за номерной КП по правилу игры. Буквы в номере уже отброшены (number — целое). */
export function pointsFor(number: number, rule: PointsRule): number {
  switch (rule.kind) {
    case 'floor_div':
      return Math.floor(number / rule.divisor);
  }
}
