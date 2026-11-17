import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan, Problem, ProblemNode } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import {
  Evaluator,
  improve,
  kpNodes,
  pyRound,
  reachable,
  rng,
  type SolveProblem,
  search,
} from '../src/index.ts';

// Те же задачи, что в solver/tests/test_improve.py: 0 — старт, 1 — финиш, дальше КП.
function makeProblem(
  kps: Partial<ProblemNode>[],
  dur: number[][],
  { deadline = 3600, lateMax = 1800, perMin = 1 } = {},
): SolveProblem {
  const base = { lat: 45, lon: 19.6, points: 0, prize: 0, serviceS: 0 };
  return {
    nodes: [
      { ...base, kpId: null, role: 'start' },
      { ...base, kpId: null, role: 'finish' },
      ...kps.map((k) => ({ ...base, role: 'kp' as const, kpId: 'x', ...k })),
    ],
    matrix: { source: 'haversine', durationS: dur },
    start: 0,
    finish: 1,
    deadlineS: deadline,
    softLateMaxS: lateMax,
    latePenaltyPerMin: perMin,
  };
}
const uniform = (n: number, s: number) =>
  Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : s)));
const kp = (kpId: string, points: number, serviceS = 300, extra: Partial<ProblemNode> = {}) => ({
  kpId,
  points,
  prize: points,
  serviceS,
  ...extra,
});
const forever = { stopAt: Infinity };

describe('improve: как improve.py', () => {
  it('берёт один дорогой вместо двух дешёвых', () => {
    const p = makeProblem([kp('10', 1), kp('11', 1), kp('50', 5, 1200)], uniform(5, 300), {
      deadline: 1800,
      lateMax: 0,
    });
    const ev = new Evaluator(p, [2, 3, 4], 0);
    expect(improve(ev, [2, 3], [2, 3, 4], forever)).toEqual([4]);
  });

  it('не ухудшает и сохраняет хороший маршрут', () => {
    const p = makeProblem([kp('10', 1), kp('20', 2), kp('30', 3)], uniform(5, 300));
    const ev = new Evaluator(p, [2, 3, 4], 0);
    const found = search(ev, [2, 3, 4], [2, 3, 4], { stopAt: performance.now() + 200 });
    expect([...found.order].sort()).toEqual([2, 3, 4]);
    expect(ev.cost(found.order) ?? Infinity).toBeLessThanOrEqual(ev.cost([2, 3, 4]) ?? 0);
  });

  it('переставляет в более короткий порядок', () => {
    const dur = [
      [0, 100, 900, 100],
      [100, 0, 100, 900],
      [900, 100, 0, 100],
      [100, 900, 100, 0],
    ];
    const p = makeProblem([kp('10', 1), kp('20', 2)], dur, { deadline: 7200 });
    expect(improve(new Evaluator(p, [2, 3], 0), [2, 3], [2, 3], forever)).toEqual([3, 2]);
  });

  it('минута опоздания — целая: КП на 1 б с 10 с опоздания не берём', () => {
    const p = makeProblem([kp('10', 1)], uniform(3, 300), { deadline: 890 });
    const ev = new Evaluator(p, [2], 0);
    expect(ev.cost([2]) ?? 0).toBeGreaterThan(ev.cost([]) ?? 0);
    expect(improve(ev, [2], [2], forever)).toEqual([]);
  });

  it('нарушение окна — неосуществимо', () => {
    const p = makeProblem([kp('99', 9, 300, { window: [0, 700] }), kp('10', 1)], uniform(4, 300), {
      deadline: 7200,
    });
    const ev = new Evaluator(p, [2, 3], 0);
    expect(ev.cost([3, 2])).toBeNull();
    expect(ev.cost([2, 3])).not.toBeNull();
  });

  it('notBefore: первый приход не раньше — окно может закрыться', () => {
    const p = makeProblem([kp('99', 9, 300, { window: [0, 700] })], uniform(3, 300), {
      deadline: 7200,
    });
    expect(new Evaluator(p, [2], 0).cost([2])).not.toBeNull();
    expect(new Evaluator(p, [2], 0, 500).cost([2])).toBeNull();
    expect(reachable(p, 2, 0, 500)).toBe(false);
  });

  it('pyRound — половина к чётному, как round() в Python', () => {
    expect([0.5, 1.5, 2.5, -0.5, 2.4, 2.6].map(pyRound)).toEqual([0, 2, 2, -0, 2, 3]);
  });

  it('rng с зерном воспроизводим', () => {
    const a = rng(7);
    const b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('10.10: тот же порядок, что у improve.py', () => {
  const fx = (name: string) =>
    JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../fixtures/2026-10-10', name), 'utf8'),
    ) as unknown;
  const problem = fx('problem.json') as Problem;
  const plan = fx('plan.json') as Plan;
  const index = new Map(problem.nodes.map((n, i) => [n.kpId, i]));
  const cand = kpNodes(problem).filter((i) => reachable(problem, i, 0));
  const ev = new Evaluator(problem, cand, 0);

  // uv run python: improve(problem, start, candidates, depart_s=0) — без перезапусков.
  const PY_FROM_EMPTY = [
    41, 44, 60, 28, 24, 34, 76, 73, 74, 66, 64, 72, 59, 77, 75, 56, 67, 63, 46, 69, 65, 68, 70, 71,
    62,
  ];
  const PY_FROM_PLAN = [
    31, 36, 37, 50, 62, 71, 70, 68, 65, 61, 54, 46, 69, 48, 39, 43, 40, 42, 38, 45, 26, 22, 77, 13,
    27, 35, 49, 73, 74, 66, 53, 64, 72, 59, 51, 58, 75,
  ];

  it('с пустого маршрута — 25 КП, стоимость как в Python', () => {
    const order = improve(ev, [], cand, forever);
    expect(order).toEqual(PY_FROM_EMPTY);
    expect(ev.cost(order)).toBe(9736090);
  });

  it('с плана солвера — 37 КП, стоимость как в Python', () => {
    const start = plan.stops.map((s) => index.get(s.kpId) as number);
    const order = improve(ev, start, cand, forever);
    expect(order).toEqual(PY_FROM_PLAN);
    expect(ev.cost(order)).toBe(7393067);
  });
});
