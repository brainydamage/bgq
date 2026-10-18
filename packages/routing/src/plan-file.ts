import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Plan, schemaErrors } from '@bgq/core';
import { problemHash } from './solve.ts';

/**
 * plan.json игры, если он построен по текущему problem.json, а тот — не старее points.json.
 * Нет плана — `{}`; устарел или битый — `why` (KML и телефон тогда идут без маршрута).
 */
export function freshPlan(gameDir: string): { plan?: Plan; why?: string } {
  const planPath = join(gameDir, 'plan.json');
  const problemPath = join(gameDir, 'problem.json');
  const pointsPath = join(gameDir, 'points.json');
  if (!existsSync(planPath)) return {};
  const plan: unknown = JSON.parse(readFileSync(planPath, 'utf8'));
  const errors = schemaErrors(Plan, plan);
  if (errors.length) return { why: `plan.json не проходит схему: ${errors.join('; ')}` };
  if (!existsSync(problemPath)) return { why: 'нет problem.json' };
  if (existsSync(pointsPath) && statSync(pointsPath).mtimeMs > statSync(problemPath).mtimeMs) {
    return { why: 'points.json новее problem.json' };
  }
  if ((plan as Plan).problemHash !== problemHash(readFileSync(problemPath))) {
    return { why: 'problem.json изменился после ./bgq solve' };
  }
  return { plan: plan as Plan };
}
