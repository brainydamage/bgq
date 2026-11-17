// Поиск маршрута на телефоне — порт solver/src/bgq_solver/improve.py ход в ход (тот же порядок
// перебора и сравнения, поэтому improve() даёт тот же порядок, что и Python):
// - _reorder: убрать КП, relocate, 2-opt;
// - _swap_in: вставить выброшенный КП, убрав 0–2 самых дешёвых по «баллы / сэкономленное время»;
// - search: improve, затем перезапуски (ILS) — выкинуть случайный отрезок и достроить.
import type { Evaluator } from './evaluator.ts';

/** Сколько самых дешёвых КП плана пробовать убрать (по одному и парами) ради вставки. */
export const REMOVE_CANDIDATES = 8;
/** Сколько лучших мест вставки пробовать для каждого выброшенного КП. */
export const INSERT_POSITIONS = 3;

type Found = { order: number[]; cost: number } | null;

export interface SearchOptions {
  /** Остановиться после этого момента (мс по `now`). */
  stopAt: number;
  /** Часы, мс; по умолчанию performance.now. */
  now?: () => number;
}

const clock = () => performance.now();

/** Улучшает порядок, пока есть выгодные ходы; никогда не ухудшает. Неосуществимый — как есть. */
export function improve(
  ev: Evaluator,
  order: readonly number[],
  candidates: readonly number[],
  opts: SearchOptions,
): number[] {
  const now = opts.now ?? clock;
  let best = [...order];
  const initial = ev.cost(best);
  if (initial === null) return [...order];
  let bestCost: number = initial;
  while (now() < opts.stopAt) {
    const found: Found = reorder(ev, best, bestCost) ?? swapIn(ev, best, bestCost, candidates);
    if (!found) break;
    best = found.order;
    bestCost = found.cost;
  }
  return best;
}

/** Генератор случайных чисел с зерном (mulberry32): перезапуски воспроизводимы. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Целое из [lo, hi] включительно. */
const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** improve, затем перезапуски с выкинутым отрезком до stopAt. Не ухудшает. */
export function search(
  ev: Evaluator,
  order: readonly number[],
  candidates: readonly number[],
  opts: SearchOptions & { seed?: number; maxRestarts?: number },
): { order: number[]; restarts: number } {
  const now = opts.now ?? clock;
  let best = improve(ev, order, candidates, opts);
  let bestCost = ev.cost(best);
  if (bestCost === null) return { order: [...order], restarts: 0 };
  const r = rng(opts.seed ?? 0);
  let restarts = 0;
  while (now() < opts.stopAt && best.length > 3 && restarts < (opts.maxRestarts ?? Infinity)) {
    restarts += 1;
    const cur = [...best];
    const length = randInt(r, 2, Math.min(8, cur.length - 1));
    const at = randInt(r, 0, cur.length - length);
    cur.splice(at, length);
    const next = improve(ev, cur, candidates, opts);
    const c = ev.cost(next);
    if (c !== null && c < bestCost) {
      best = next;
      bestCost = c;
    }
  }
  return { order: best, restarts };
}

/** Тот же набор КП, порядок короче: убрать (если опоздание дороже КП), relocate, 2-opt. */
function reorder(ev: Evaluator, order: readonly number[], cost: number): Found {
  let best: Found = null;
  const consider = (cand: number[]) => {
    const c = ev.cost(cand);
    if (c !== null && c < (best ? best.cost : cost)) best = { order: cand, cost: c };
  };
  const n = order.length;
  for (let i = 0; i < n; i++) {
    const rest = [...order.slice(0, i), ...order.slice(i + 1)];
    consider(rest);
    for (let j = 0; j < n; j++) {
      if (j !== i) consider([...rest.slice(0, j), order[i] as number, ...rest.slice(j)]);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j <= n; j++) {
      consider([...order.slice(0, i), ...order.slice(i, j).reverse(), ...order.slice(j)]);
    }
  }
  return best;
}

/** Вставить выброшенный КП, убрав 0–2 самых дешёвых по «баллы / сэкономленное время». */
function swapIn(
  ev: Evaluator,
  order: readonly number[],
  cost: number,
  candidates: readonly number[],
): Found {
  const taken = new Set(order);
  const prize = (i: number) => ev.prize[i] ?? 0;
  const dropped = candidates.filter((c) => !taken.has(c)).sort((a, b) => prize(b) - prize(a));
  let best: Found = null;
  for (const x of dropped) {
    const positions = [...Array(order.length + 1).keys()]
      .map((p) => ({ p, s: ev.addedS(order, p, x) }))
      .sort((a, b) => a.s - b.s)
      .slice(0, INSERT_POSITIONS);
    for (const { p: pos } of positions) {
      const cand = [...order.slice(0, pos), x, ...order.slice(pos)];
      // Дешевле всего убрать: мало баллов за много сэкономленного времени.
      const removable = [...cand.keys()]
        .filter((k) => cand[k] !== x)
        .map((k) => ({ k, r: prize(cand[k] as number) / Math.max(1, ev.savingS(cand, k)) }))
        .sort((a, b) => a.r - b.r)
        .slice(0, REMOVE_CANDIDATES)
        .map((e) => e.k);
      const sets: number[][] = [[], ...removable.map((k) => [k])];
      for (let i = 0; i < removable.length; i++) {
        for (let j = i + 1; j < removable.length; j++) {
          sets.push([removable[i] as number, removable[j] as number]);
        }
      }
      for (const drop of sets) {
        const trial = cand.filter((_, k) => !drop.includes(k));
        const c = ev.cost(trial);
        if (c !== null && c < (best ? best.cost : cost)) best = { order: trial, cost: c };
      }
    }
  }
  return best;
}
