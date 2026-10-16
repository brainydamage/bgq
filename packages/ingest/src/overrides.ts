import { type Game, isEligible, type Kp, normalizeKpId, pointsFor } from '@bgq/core';
import { parse } from 'yaml';
import type { Issue } from './types.ts';

/**
 * Применяет overrides.yaml (id → поля КП) поверх результата парсера, на месте.
 * Поле заменяется целиком. Идемпотентно: повторное применение даёт тот же результат.
 */
export function applyOverrides(kps: Kp[], text: string, game: Game): Issue[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return [critical(`overrides.yaml не разобран: ${(e as Error).message}`)];
  }
  if (doc == null) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return [critical('overrides.yaml: ожидается словарь «id КП → поля»')];
  }

  const issues: Issue[] = [];
  const byId = new Map(kps.map((k) => [k.id, k]));
  for (const [key, patch] of Object.entries(doc)) {
    const id = normalizeKpId(key);
    const kp = id ? byId.get(id) : undefined;
    if (!kp) {
      issues.push({
        severity: 'critical',
        code: 'override_unknown_id',
        kpId: key,
        message: `overrides.yaml: КП «${key}» нет в экспорте`,
      });
      continue;
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      issues.push(critical(`overrides.yaml: для «${key}» ожидается словарь полей`, kp.id));
      continue;
    }
    if ('id' in patch) {
      issues.push(critical(`overrides.yaml: id КП «${key}» менять нельзя`, kp.id));
      continue;
    }
    Object.assign(kp, patch);
    if ('number' in patch && !('points' in patch) && typeof kp.number === 'number') {
      kp.points = pointsFor(kp.number, game.pointsRule);
    }
    if (!('eligible' in patch)) kp.eligible = isEligible(kp, game);
  }
  return issues;
}

function critical(message: string, kpId?: string): Issue {
  return { severity: 'critical', code: 'override_invalid', message, ...(kpId && { kpId }) };
}
