// Времена маршрута прямым проходом — как solver/src/bgq_solver/plan.py (build_plan), без блоков
// отдыха (`rest`): паузу на телефоне задают события, а не солвер. Без DOM — Node и браузер.
import type { PlanStop } from './schema/plan.ts';
import type { Problem } from './schema/problem.ts';

export interface Schedule {
  stops: PlanStop[];
  /** Приход на финиш, с от t0. */
  finishS: number;
  /** Чистое время в пути, с (без ожидания окон и времени на точках). */
  walkS: number;
}

/** kpId → индекс узла задачи. */
export function nodeIndex(problem: Pick<Problem, 'nodes'>): Map<string, number> {
  const index = new Map<string, number>();
  problem.nodes.forEach((n, i) => {
    if (n.kpId !== null && !index.has(n.kpId)) index.set(n.kpId, i);
  });
  return index;
}

/**
 * Прямой проход «как можно раньше»: из узла `from` (по умолчанию старт) в момент `departS` по КП
 * `kpIds` → финиш. Приход = уход с прошлой точки + путь (не раньше `notBeforeS` — для первого
 * перегона на телефоне: сейчас позже, чем вышло бы по матрице); уход = max(приход, открытие окна)
 * + время на точке. КП не из задачи — ошибка.
 */
export function schedule(
  problem: Pick<Problem, 'nodes' | 'matrix' | 'start' | 'finish'>,
  kpIds: readonly string[],
  departS: number,
  opts: { from?: number; notBeforeS?: number; index?: Map<string, number> } = {},
): Schedule {
  const index = opts.index ?? nodeIndex(problem);
  const dur = problem.matrix.durationS;
  const leg = (a: number, b: number) => dur[a]?.[b] ?? 0;
  const stops: PlanStop[] = [];
  let prev = opts.from ?? problem.start;
  let t = departS;
  let walkS = 0;
  for (const kpId of kpIds) {
    const node = index.get(kpId);
    if (node === undefined) throw new Error(`КП ${kpId} нет в задаче`);
    walkS += leg(prev, node);
    let arrive = t + leg(prev, node);
    if (!stops.length && opts.notBeforeS !== undefined) arrive = Math.max(arrive, opts.notBeforeS);
    const n = problem.nodes[node];
    const begin = n?.window ? Math.max(arrive, n.window[0]) : arrive;
    t = begin + (n?.serviceS ?? 0);
    stops.push({ kpId, arriveS: arrive, departS: t });
    prev = node;
  }
  walkS += leg(prev, problem.finish);
  let finishS = t + leg(prev, problem.finish);
  if (!stops.length && opts.notBeforeS !== undefined) finishS = Math.max(finishS, opts.notBeforeS);
  return { stops, finishS, walkS };
}

/** Выход со старта по плану: приход к первой точке минус путь до неё (без точек — finishS − путь). */
export function planDepartS(
  problem: Pick<Problem, 'nodes' | 'matrix' | 'start' | 'finish'>,
  plan: { stops: readonly PlanStop[]; finishS: number },
): number {
  const first = plan.stops[0];
  const node = first ? nodeIndex(problem).get(first.kpId) : problem.finish;
  const legS = node === undefined ? 0 : (problem.matrix.durationS[problem.start]?.[node] ?? 0);
  return (first?.arriveS ?? plan.finishS) - legS;
}
