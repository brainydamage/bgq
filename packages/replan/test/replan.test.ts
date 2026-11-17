import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Plan, type Problem, Problem as ProblemSchema, schemaErrors } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import { Evaluator, kpNodes, repair, replan, scoreRoute, solve, subProblem } from '../src/index.ts';

const fx = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../fixtures/2026-10-10', name), 'utf8'),
  ) as unknown;
// Задача и план OR-Tools 10.10: 78 узлов, 37 КП, 207 б, финиш 19:29:47 при дедлайне 19:30.
const problem = fx('problem.json') as Problem;
const plan = fx('plan.json') as Plan;
const index = new Map(problem.nodes.map((n, i) => [n.kpId, i]));
const ids = plan.stops.map((s) => s.kpId);
/** Детерминированно: число перезапусков вместо времени. */
const fixed = { timeMs: Number.POSITIVE_INFINITY, maxRestarts: 10, seed: 0 };

describe('подзадача «отсюда»', () => {
  const from = index.get(ids[9] ?? '') as number;
  const exclude = new Set(ids.slice(0, 10));
  const { problem: sub, map } = subProblem(problem, { from, exclude, deadlineS: 20_000 });

  it('старт — взятая точка, взятых нет, матрица — подматрица; схема Problem', () => {
    expect(sub.nodes[0]).toMatchObject({ role: 'start', kpId: null, points: 0 });
    expect(sub.nodes[1]?.role).toBe('finish');
    expect(sub.nodes.some((n) => n.kpId !== null && exclude.has(n.kpId))).toBe(false);
    expect(sub.nodes).toHaveLength(problem.nodes.length - 10);
    expect(sub.deadlineS).toBe(20_000);
    const [a, b] = [map[0] as number, map[5] as number];
    expect(sub.matrix.durationS[0]?.[5]).toBe(problem.matrix.durationS[a]?.[b]);
    expect(schemaErrors(ProblemSchema, sub)).toEqual([]);
  });
});

describe('repair: неосуществимый порядок → осуществимый', () => {
  it('план 10.10 с выходом на 2 ч позже — выкидываем, пока не влезет', () => {
    const cand = kpNodes(problem);
    const ev = new Evaluator(problem, cand, 7200);
    const start = ids.map((id) => index.get(id) as number);
    expect(ev.cost(start)).toBeNull();
    const fixedOrder = repair(ev, start, new Set(cand));
    expect(ev.cost(fixedOrder)).not.toBeNull();
    expect(fixedOrder.length).toBeLessThan(start.length);
    expect(fixedOrder.length).toBeGreaterThan(20);
  });
});

describe('solve: качество на 10.10', () => {
  it('с пустого маршрута за 10 перезапусков — не хуже 3% от OR-Tools (207 б)', () => {
    const s = solve(problem, { departS: 0, ...fixed });
    const ids2 = s.order.map((i) => problem.nodes[i]?.kpId as string);
    const sc = scoreRoute(problem, ids2, {
      from: problem.start,
      departS: 0,
      deadlineS: problem.deadlineS,
    });
    expect(sc.points - sc.penalty).toBeGreaterThanOrEqual(201);
    expect(s.restarts).toBe(10);
  });
});

describe('replan: было → стало', () => {
  const k = 15;
  const from = index.get(ids[k - 1] ?? '') as number;
  const base = {
    problem,
    from,
    deadlineS: problem.deadlineS,
    current: ids.slice(k),
    ...fixed,
  };

  it('по плану: «было» — остаток плана как есть, «стало» не хуже', () => {
    const departS = plan.stops[k - 1]?.departS ?? 0;
    const r = replan({ ...base, departS, exclude: new Set(ids.slice(0, k)) });
    expect(r.before.order).toEqual(ids.slice(k));
    expect(r.before.stops).toEqual(plan.stops.slice(k));
    expect(r.before.finishS).toBe(plan.finishS);
    expect(r.after.prize).toBeGreaterThanOrEqual(r.before.prize);
  });

  it('отстаём на 40 мин: «было» опаздывает, «стало» выкидывает точки, штраф меньше', () => {
    const departS = (plan.stops[k - 1]?.departS ?? 0) + 2400;
    const r = replan({ ...base, departS, exclude: new Set(ids.slice(0, k)) });
    expect(r.before.penalty).toBeGreaterThan(0);
    expect(r.after.points - r.after.penalty).toBeGreaterThan(r.before.points - r.before.penalty);
    expect(r.after.order.length).toBeLessThan(r.before.order.length);
    // Опоздать на пару минут можно, если КП дороже штрафа (как у OR-Tools).
    expect(r.after.penalty).toBeLessThan(r.before.penalty);
    expect(r.after.penalty).toBeLessThanOrEqual(5);
  });

  it('пропущенные и взятые в «стало» не попадают; время возвращается', () => {
    const departS = plan.stops[k - 1]?.departS ?? 0;
    const skipped = ids.slice(k, k + 3);
    const r = replan({
      ...base,
      departS,
      exclude: new Set([...ids.slice(0, k), ...skipped]),
    });
    expect(r.before.order).toEqual(ids.slice(k + 3));
    for (const id of [...ids.slice(0, k), ...skipped]) expect(r.after.order).not.toContain(id);
    expect(r.after.points).toBeGreaterThanOrEqual(r.before.points);
  });

  it('notBefore: первый приход не раньше «сейчас»', () => {
    const departS = plan.stops[k - 1]?.departS ?? 0;
    const r = replan({
      ...base,
      departS,
      notBeforeS: departS + 1800,
      exclude: new Set(ids.slice(0, k)),
    });
    expect(r.after.stops[0]?.arriveS ?? r.after.finishS).toBeGreaterThanOrEqual(departS + 1800);
  });
});
