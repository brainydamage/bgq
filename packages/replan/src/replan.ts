// Пересчёт маршрута на телефоне «отсюда и сейчас»: задача без взятых и пропущенных КП, старт —
// последняя взятая точка, дедлайн — с остатком резерва на паузу. Поиск — порт improve.py.
import { type PlanStop, type Problem, type ProblemNode, schedule } from '@bgq/core';
import { Evaluator, kpNodes, reachable, type SolveProblem } from './evaluator.ts';
import { search } from './improve.ts';

/** Время поиска на телефоне по умолчанию, мс. */
export const REPLAN_MS = 2000;

/**
 * Задача «отсюда»: узел `from` становится стартом (kpId null), КП из `exclude` и сам `from`
 * выпадают, дедлайн — `deadlineS`. `map[i]` — индекс узла исходной задачи.
 */
export function subProblem(
  problem: Problem,
  opts: { from: number; exclude: ReadonlySet<string>; deadlineS: number },
): { problem: Problem; map: number[] } {
  const keep = [opts.from, problem.finish];
  problem.nodes.forEach((n, i) => {
    if (n.role === 'kp' && i !== opts.from && !(n.kpId !== null && opts.exclude.has(n.kpId)))
      keep.push(i);
  });
  const src = problem.nodes[opts.from] as ProblemNode;
  const start: ProblemNode = {
    kpId: null,
    role: 'start',
    lat: src.lat,
    lon: src.lon,
    points: 0,
    prize: 0,
    serviceS: 0,
  };
  const nodes = keep.map((i, k) => (k === 0 ? start : (problem.nodes[i] as ProblemNode)));
  const dur = problem.matrix.durationS;
  const { warmStart: _, rest: __, pauseS: ___, ...base } = problem;
  return {
    problem: {
      ...base,
      nodes,
      matrix: {
        source: problem.matrix.source,
        durationS: keep.map((a) => keep.map((b) => dur[a]?.[b] ?? 0)),
      },
      start: 0,
      finish: 1,
      deadlineS: Math.max(0, Math.round(opts.deadlineS)),
    },
    map: keep,
  };
}

/**
 * Порядок → осуществимый: сначала только кандидаты, потом, пока окна или жёсткий финиш
 * нарушены, выкидываем КП, без которого стоимость лучше (осуществимость важнее).
 */
export function repair(ev: Evaluator, order: readonly number[], candidates: ReadonlySet<number>) {
  let cur = order.filter((i) => candidates.has(i));
  while (cur.length && ev.cost(cur) === null) {
    let pick = cur.length - 1;
    let pickCost: number | null = null;
    let pickRatio = Infinity;
    for (let k = 0; k < cur.length; k++) {
      const trial = cur.filter((_, j) => j !== k);
      const c = ev.cost(trial);
      const ratio = (ev.prize[cur[k] as number] ?? 0) / Math.max(1, ev.savingS(cur, k));
      if (c !== null ? pickCost === null || c < pickCost : pickCost === null && ratio < pickRatio) {
        pick = k;
        pickCost = c;
        pickRatio = ratio;
      }
    }
    cur = cur.filter((_, j) => j !== pick);
  }
  return cur;
}

export interface SolveOptions {
  departS: number;
  /** Первый приход не раньше (с от t0). */
  notBeforeS?: number;
  /** Начальный порядок (узлы задачи), например текущий план. */
  initial?: readonly number[];
  timeMs?: number;
  seed?: number;
  maxRestarts?: number;
  now?: () => number;
}

/** Лучший порядок узлов задачи: кандидаты — КП, которые можно взять хотя бы в одиночку. */
export function solve(problem: SolveProblem, opts: SolveOptions) {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const notBefore = opts.notBeforeS ?? 0;
  const candidates = kpNodes(problem).filter((i) => reachable(problem, i, opts.departS, notBefore));
  const ev = new Evaluator(problem, candidates, opts.departS, notBefore);
  const initial = repair(ev, opts.initial ?? [], new Set(candidates));
  const found = search(ev, initial, candidates, {
    stopAt: started + (opts.timeMs ?? REPLAN_MS),
    now,
    ...(opts.seed !== undefined && { seed: opts.seed }),
    ...(opts.maxRestarts !== undefined && { maxRestarts: opts.maxRestarts }),
  });
  return {
    order: found.order,
    cost: ev.cost(found.order),
    restarts: found.restarts,
    candidates,
    ms: Math.round(now() - started),
  };
}

export interface RouteScore {
  /** КП по порядку (kpId). */
  order: string[];
  stops: PlanStop[];
  finishS: number;
  /** Баллы КП маршрута (без штрафа) и штраф за опоздание к дедлайну задачи. */
  points: number;
  penalty: number;
  /** Ожидаемая ценность (prize) за вычетом штрафа. */
  prize: number;
  distanceM: number;
}

/** Времена и баллы порядка КП (kpId) — из `from` в `departS`; `null` — КП не из задачи. */
export function scoreRoute(
  problem: Problem,
  kpIds: readonly string[],
  opts: { from: number; departS: number; notBeforeS?: number; deadlineS: number },
): RouteScore {
  const s = schedule(problem, kpIds, opts.departS, {
    from: opts.from,
    ...(opts.notBeforeS !== undefined && { notBeforeS: opts.notBeforeS }),
  });
  const byId = new Map(problem.nodes.map((n) => [n.kpId, n]));
  let points = 0;
  let prize = 0;
  for (const id of kpIds) {
    points += byId.get(id)?.points ?? 0;
    prize += byId.get(id)?.prize ?? 0;
  }
  const penalty =
    Math.ceil(Math.max(0, s.finishS - opts.deadlineS) / 60) * problem.latePenaltyPerMin;
  return {
    order: [...kpIds],
    stops: s.stops,
    finishS: s.finishS,
    points,
    penalty,
    prize: Math.round((prize - penalty) * 100) / 100,
    distanceM: Math.round((s.walkS * problem.speedKmh) / 3.6),
  };
}

export interface ReplanInput {
  problem: Problem;
  /** Откуда: индекс узла задачи (старт или последняя взятая точка). */
  from: number;
  /** Выход оттуда, с от t0 (с учётом пауз). */
  departS: number;
  /** Первый приход не раньше — «сейчас», с от t0. */
  notBeforeS?: number;
  /** Дедлайн пересчёта, с от t0: настоящий минус неизрасходованный резерв на паузу. */
  deadlineS: number;
  /** Взятые и пропущенные КП — в пересчёт не идут. */
  exclude: ReadonlySet<string>;
  /** Текущий порядок оставшихся КП (kpId) — начальное решение и «было». */
  current: readonly string[];
  timeMs?: number;
  seed?: number;
  maxRestarts?: number;
  now?: () => number;
}

export interface Replan {
  before: RouteScore;
  after: RouteScore;
  /** Перестановки ILS и время поиска. */
  restarts: number;
  ms: number;
}

/** Пересчёт оставшегося маршрута: «было» (текущий порядок) и «стало» (поиск от него). */
export function replan(input: ReplanInput): Replan {
  const { problem: sub, map } = subProblem(input.problem, {
    from: input.from,
    exclude: input.exclude,
    deadlineS: input.deadlineS,
  });
  const local = new Map<string, number>();
  sub.nodes.forEach((n, i) => {
    if (n.kpId !== null) local.set(n.kpId, i);
  });
  const current = input.current.filter((id) => local.has(id));
  const found = solve(sub, {
    departS: input.departS,
    ...(input.notBeforeS !== undefined && { notBeforeS: input.notBeforeS }),
    initial: current.map((id) => local.get(id) as number),
    ...(input.timeMs !== undefined && { timeMs: input.timeMs }),
    ...(input.seed !== undefined && { seed: input.seed }),
    ...(input.maxRestarts !== undefined && { maxRestarts: input.maxRestarts }),
    ...(input.now && { now: input.now }),
  });
  const ids = (order: readonly number[]) =>
    order.map((i) => input.problem.nodes[map[i] as number]?.kpId as string);
  const opts = {
    from: input.from,
    departS: input.departS,
    deadlineS: input.deadlineS,
    ...(input.notBeforeS !== undefined && { notBeforeS: input.notBeforeS }),
  };
  return {
    before: scoreRoute(input.problem, current, opts),
    after: scoreRoute(input.problem, ids(found.order), opts),
    restarts: found.restarts,
    ms: found.ms,
  };
}
