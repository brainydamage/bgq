import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeIndex, type Plan, type Problem, planDepartS, schedule } from '../src/index.ts';

const fx = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../fixtures/2026-10-10', name), 'utf8'),
  ) as unknown;
// План солвера (plan.py) по задаче 10.10: выход 12:30, 37 КП.
const problem = fx('problem.json') as Problem;
const plan = fx('plan.json') as Plan;
const order = plan.stops.map((s) => s.kpId);

describe('прямой проход: как plan.py', () => {
  it('план 10.10 — до секунды: приход, уход, финиш', () => {
    const depart = planDepartS(problem, plan);
    expect(depart).toBe(0);
    const s = schedule(problem, order, depart);
    expect(s.stops).toEqual(plan.stops);
    expect(s.finishS).toBe(plan.finishS);
    expect(Math.round((s.walkS * problem.speedKmh) / 3.6)).toBe(plan.distanceM);
  });

  it('в плане есть КП с окном — ждём открытия', () => {
    const index = nodeIndex(problem);
    const windowed = order.filter((id) => problem.nodes[index.get(id) ?? -1]?.window);
    expect(windowed.length).toBeGreaterThan(0);
  });

  it('из середины: от взятой точки в её время ухода — те же времена дальше', () => {
    const k = 10;
    const from = nodeIndex(problem).get(order[k] ?? '');
    const s = schedule(problem, order.slice(k + 1), plan.stops[k]?.departS ?? 0, {
      ...(from !== undefined && { from }),
    });
    expect(s.stops).toEqual(plan.stops.slice(k + 1));
    expect(s.finishS).toBe(plan.finishS);
  });

  it('пропуск возвращает время: без КП финиш раньше', () => {
    const s = schedule(
      problem,
      order.filter((_, i) => i !== 5),
      0,
    );
    expect(s.finishS).toBeLessThan(plan.finishS);
    expect(s.stops).toHaveLength(order.length - 1);
  });

  it('notBeforeS: первый приход не раньше «сейчас», дальше — сдвиг', () => {
    const late = (plan.stops[0]?.arriveS ?? 0) + 600;
    const s = schedule(problem, order, 0, { notBeforeS: late });
    expect(s.stops[0]?.arriveS).toBe(late);
    expect(s.finishS).toBeGreaterThan(plan.finishS);
    expect(s.finishS).toBeLessThanOrEqual(plan.finishS + 600);
    // Без точек — к финишу не раньше «сейчас».
    expect(schedule(problem, [], 0, { notBeforeS: 99_999 }).finishS).toBe(99_999);
  });

  it('КП не из задачи — ошибка', () => {
    expect(() => schedule(problem, ['нет такого'], 0)).toThrow('нет в задаче');
  });
});
