// Целевая функция маршрута — порт solver/src/bgq_solver/improve.py (Evaluator) и model.py
// (reachable): те же «микробаллы», финиш прямым проходом, опоздание за начатую минуту.
import type { Problem } from '@bgq/core';

/** 1 балл = PRIZE_SCALE «микробаллов» (как в model.py). */
export const PRIZE_SCALE = 60_000;
/** Секунда пути — тай-брейк «при равных баллах — короче». */
export const ARC_COST = 1;

/** round() Python: половина — к чётному (для совпадения с солвером до единицы). */
export function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export type SolveProblem = Pick<
  Problem,
  'nodes' | 'matrix' | 'start' | 'finish' | 'deadlineS' | 'softLateMaxS' | 'latePenaltyPerMin'
>;

export function horizonS(problem: Pick<Problem, 'deadlineS' | 'softLateMaxS'>): number {
  return problem.deadlineS + problem.softLateMaxS;
}

export function kpNodes(problem: Pick<Problem, 'nodes'>): number[] {
  const out: number[] = [];
  problem.nodes.forEach((n, i) => {
    if (n.role === 'kp') out.push(i);
  });
  return out;
}

/** Можно ли взять КП в одиночку: старт → КП (в окно) → финиш до жёсткого предела. */
export function reachable(
  problem: SolveProblem,
  node: number,
  departS: number,
  notBeforeS = 0,
): boolean {
  const dur = problem.matrix.durationS;
  const n = problem.nodes[node];
  if (!n) return false;
  let begin = Math.max(departS + (dur[problem.start]?.[node] ?? 0), notBeforeS);
  if (n.window) {
    begin = Math.max(begin, n.window[0]);
    if (begin > n.window[1] - n.serviceS) return false;
  }
  return begin + n.serviceS + (dur[node]?.[problem.finish] ?? 0) <= horizonS(problem);
}

/** Стоимость порядка (меньше — лучше) или null, если он нарушает окна или жёсткий финиш. */
export class Evaluator {
  readonly problem: SolveProblem;
  readonly dur: number[][];
  readonly start: number;
  readonly finish: number;
  readonly deadline: number;
  readonly horizon: number;
  readonly depart: number;
  /** Первый приход — не раньше (телефон: «сейчас» позже, чем вышло бы по матрице). */
  readonly notBefore: number;
  readonly latePerMin: number;
  /** prize в микробаллах по индексу узла (не кандидаты — 0). */
  readonly prize: number[];
  readonly totalPrize: number;

  constructor(
    problem: SolveProblem,
    candidates: readonly number[],
    departS: number,
    notBeforeS = 0,
  ) {
    this.problem = problem;
    this.dur = problem.matrix.durationS;
    this.start = problem.start;
    this.finish = problem.finish;
    this.deadline = problem.deadlineS;
    this.horizon = horizonS(problem);
    this.depart = departS;
    this.notBefore = notBeforeS;
    this.latePerMin = pyRound(problem.latePenaltyPerMin * PRIZE_SCALE);
    this.prize = problem.nodes.map(() => 0);
    let total = 0;
    for (const i of candidates) {
      const p = pyRound((problem.nodes[i]?.prize ?? 0) * PRIZE_SCALE);
      this.prize[i] = p;
      total += p;
    }
    this.totalPrize = total;
  }

  /** Время на точке узла. */
  service(node: number): number {
    return this.problem.nodes[node]?.serviceS ?? 0;
  }

  leg(a: number, b: number): number {
    return this.dur[a]?.[b] ?? 0;
  }

  cost(order: readonly number[]): number | null {
    const nodes = this.problem.nodes;
    let t = this.depart;
    let prev = this.start;
    let walk = 0;
    let prize = 0;
    let first = true;
    for (const node of order) {
      const leg = this.leg(prev, node);
      walk += leg;
      const n = nodes[node];
      if (!n) return null;
      let begin = t + leg;
      if (first) {
        begin = Math.max(begin, this.notBefore);
        first = false;
      }
      if (n.window) {
        begin = Math.max(begin, n.window[0]);
        if (begin > n.window[1] - n.serviceS) return null;
      }
      t = begin + n.serviceS;
      prize += this.prize[node] ?? 0;
      prev = node;
    }
    const leg = this.leg(prev, this.finish);
    walk += leg;
    t += leg;
    if (first) t = Math.max(t, this.notBefore);
    if (t > this.horizon) return null;
    const lateMin = Math.ceil(Math.max(0, t - this.deadline) / 60);
    return this.totalPrize - prize + lateMin * this.latePerMin + walk * ARC_COST;
  }

  /** Сколько секунд добавит вставка node перед order[pos] (без учёта ожидания окон). */
  addedS(order: readonly number[], pos: number, node: number): number {
    const a = pos > 0 ? (order[pos - 1] as number) : this.start;
    const b = pos < order.length ? (order[pos] as number) : this.finish;
    return this.leg(a, node) + this.service(node) + this.leg(node, b) - this.leg(a, b);
  }

  /** Сколько секунд сэкономит удаление order[k]. */
  savingS(order: readonly number[], k: number): number {
    const a = k > 0 ? (order[k - 1] as number) : this.start;
    const b = k + 1 < order.length ? (order[k + 1] as number) : this.finish;
    const node = order[k] as number;
    return this.leg(a, node) + this.service(node) + this.leg(node, b) - this.leg(a, b);
  }
}
