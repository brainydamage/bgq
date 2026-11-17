// Пересчёт маршрута на телефоне: что считаем (откуда, когда, до какого дедлайна), «было → стало»
// и принятый план. Чистая логика (тестируется в Node); поиск — @bgq/replan.
import {
  type AcceptedPlan,
  clock,
  clockIn,
  nodeIndex,
  type Pauses,
  type PhoneGame,
  type Plan,
  type PlanStop,
  pausedBefore,
  planDepartS,
} from '@bgq/core';
import { type Replan, type ReplanInput, type RouteScore, replan } from '@bgq/replan';
import { uuid } from './events.ts';
import { type KpRow, type RouteRows, secondsFromT0 } from './route.ts';

/** Сколько ищем на телефоне, мс (на 10.10 хватает 0,5 с — см. packages/replan/scripts/bench.ts). */
export const REPLAN_PHONE_MS = 1000;
/** Варианты «пауза впереди», мин. */
export const PAUSE_CHOICES = [0, 15, 30, 45, 60];

/**
 * План для экранов: принятый на телефоне, если он по той же задаче и новее плана с ноутбука
 * (новый phone.json с новым маршрутом его отменяет). Иначе — план из phone.json.
 */
export function effectivePlan(
  game: PhoneGame,
  accepted: AcceptedPlan | undefined,
): { game: PhoneGame; accepted?: AcceptedPlan } {
  const base = game.plan;
  if (
    !accepted ||
    !base ||
    accepted.plan.problemHash !== base.problemHash ||
    accepted.plan.t0 !== base.t0 ||
    accepted.atMs <= Date.parse(base.createdAt)
  )
    return { game };
  return { game: { ...game, plan: accepted.plan }, accepted };
}

/**
 * Сколько паузы ещё впереди по плану, мин: резерв из params (pauseMin; после принятого плана —
 * выбранное при пересчёте) минус пауза с тех пор.
 */
export function pauseLeftMin(
  game: Pick<PhoneGame, 'problem'>,
  pauses: Pauses,
  now: Date,
  accepted?: AcceptedPlan,
): number {
  const reserveMin = accepted ? accepted.pauseMin : (game.problem?.pauseS ?? 0) / 60;
  const since = accepted ? pausedBefore(pauses, accepted.atMs) : 0;
  const usedMin = (pausedBefore(pauses, now.getTime()) - since) / 60_000;
  return Math.max(0, Math.round(reserveMin - usedMin));
}

/** Варианты паузы: остаток резерва (если не круглый) + 0/15/30/45/60, по возрастанию. */
export function pauseChoices(leftMin: number): number[] {
  return [...new Set([...PAUSE_CHOICES, leftMin])].sort((a, b) => a - b);
}

export interface ReplanSetup {
  input: ReplanInput;
  /** Откуда считаем: «старт» или КП, и с какого времени. */
  fromLabel: string;
  /** Настоящий дедлайн игры, с от t0. */
  deadlineS: number;
  /** Взятые (с временем «взято») и пропущенные — начало принятого плана. */
  done: KpRow[];
  anchorId?: string;
}

/**
 * Что пересчитывать: из последней взятой точки (среди всех КП задачи) в момент «взято» + пауза
 * после него; в день игры первый приход не раньше «сейчас». Дедлайн — настоящий минус пауза
 * впереди. Без задачи или плана в phone.json — текст причины.
 */
export function replanSetup(
  game: PhoneGame,
  rows: RouteRows,
  now: Date,
  pauses: Pauses,
  pauseMin: number,
): ReplanSetup | string {
  const problem = game.problem;
  const plan = game.plan;
  if (!problem || !plan) return 'в phone.json нет задачи — пересчитать можно только на ноутбуке';
  const index = nodeIndex(problem);
  const t0Ms = Date.parse(plan.t0);
  const pausedAt = (s: number) => pausedBefore(pauses, t0Ms + s * 1000) / 1000;
  const all = [...rows.plan, ...rows.rest];

  let from = problem.start;
  let t = planDepartS(problem, plan);
  let anchorId: string | undefined;
  let lastS = Number.NEGATIVE_INFINITY;
  for (const r of all) {
    if (r.status !== 'taken' || !r.answerTime || !index.has(r.kp.id)) continue;
    const s = secondsFromT0(plan.t0, r.answerTime);
    if (s < lastS) continue;
    lastS = s;
    from = index.get(r.kp.id) as number;
    t = s;
    anchorId = r.kp.id;
  }
  const nowS = Math.round((now.getTime() - t0Ms) / 1000);
  const gameDay = clockIn(game.tz, now).date === game.date;
  const departS = Math.round(t + Math.max(0, pausedAt(nowS) - pausedAt(t)));
  const deadlineS = secondsFromT0(plan.t0, game.deadline);
  const exclude = new Set(all.filter((r) => r.status !== 'open').map((r) => r.kp.id));
  // Сделанное — по времени: взятые — по «взято», пропущенные — по уходу по плану.
  const doneAt = (r: KpRow) =>
    r.status === 'taken' && r.answerTime
      ? secondsFromT0(plan.t0, r.answerTime)
      : (r.stop?.departS ?? 0);
  const done = [
    ...rows.plan.filter((r) => r.status !== 'open'),
    ...rows.rest.filter((r) => r.status === 'taken' && r.answerTime),
  ].sort((a, b) => doneAt(a) - doneAt(b));
  return {
    input: {
      problem,
      from,
      departS,
      ...(gameDay && nowS > departS && { notBeforeS: nowS }),
      deadlineS: deadlineS - pauseMin * 60,
      exclude,
      current: rows.plan.filter((r) => r.status === 'open').map((r) => r.kp.id),
      timeMs: REPLAN_PHONE_MS,
    },
    fromLabel: anchorId
      ? `от КП ${anchorId} (${clock(plan.t0, t)})`
      : `от старта (${clock(plan.t0, departS)})`,
    deadlineS,
    done,
    ...(anchorId && { anchorId }),
  };
}

/** Одна сторона «было/стало» для экрана. */
export interface ReplanSide {
  kps: number;
  /** Баллы маршрута минус штраф за опоздание к настоящему дедлайну. */
  points: number;
  finish: string;
  /** До настоящего дедлайна: > 0 — столько можно на паузу, < 0 — опоздание. */
  slackMin: number;
}

export interface ReplanView {
  before: ReplanSide;
  after: ReplanSide;
  added: string[];
  removed: string[];
  /** Первые точки нового порядка. */
  next: string[];
}

function side(score: RouteScore, t0: string, deadlineS: number, perMin: number): ReplanSide {
  const lateMin = Math.ceil(Math.max(0, score.finishS - deadlineS) / 60);
  return {
    kps: score.order.length,
    points: score.points - lateMin * perMin,
    finish: clock(t0, score.finishS),
    slackMin: Math.floor((deadlineS - score.finishS) / 60),
  };
}

export function replanView(setup: ReplanSetup, r: Replan, t0: string): ReplanView {
  const perMin = setup.input.problem.latePenaltyPerMin;
  const before = new Set(r.before.order);
  const after = new Set(r.after.order);
  return {
    before: side(r.before, t0, setup.deadlineS, perMin),
    after: side(r.after, t0, setup.deadlineS, perMin),
    added: r.after.order.filter((id) => !before.has(id)),
    removed: r.before.order.filter((id) => !after.has(id)),
    next: r.after.order.slice(0, 4),
  };
}

/** Пересчёт целиком: setup → поиск → «было/стало». */
export function runReplan(setup: ReplanSetup, t0: string): { result: Replan; view: ReplanView } {
  const result = replan(setup.input);
  return { result, view: replanView(setup, result, t0) };
}

/**
 * Принятый план: сделанное (взятые — со временем «взято», последняя — с выходом из неё,
 * пропущенные — как были) + новый порядок. Солвер — heuristic, задача та же (problemHash).
 */
export function acceptedPlan(
  game: PhoneGame,
  setup: ReplanSetup,
  r: Replan,
  now: Date,
  pauseMin: number,
): Plan {
  const base = game.plan as Plan;
  const problem = setup.input.problem;
  const doneStops: PlanStop[] = setup.done.map((row) => {
    if (row.status === 'taken' && row.answerTime) {
      const s = Math.max(0, secondsFromT0(base.t0, row.answerTime));
      return {
        kpId: row.kp.id,
        arriveS: s,
        departS: row.kp.id === setup.anchorId ? Math.max(s, setup.input.departS) : s,
      };
    }
    return {
      kpId: row.kp.id,
      arriveS: row.stop?.arriveS ?? 0,
      departS: row.stop?.departS ?? 0,
    };
  });
  const stops = [...doneStops, ...r.after.stops];
  const inPlan = new Set(stops.map((s) => s.kpId));
  const takenPoints = setup.done
    .filter((row) => row.status === 'taken')
    .reduce((sum, row) => sum + row.kp.points, 0);
  const planDeadlineS = setup.deadlineS - pauseMin * 60;
  return {
    v: 1,
    planId: uuid(),
    gameId: base.gameId,
    problemHash: base.problemHash,
    createdAt: now.toISOString(),
    solver: 'heuristic',
    solverMs: Math.max(0, r.ms),
    t0: base.t0,
    stops,
    finishS: Math.max(0, r.after.finishS),
    slackMin: Math.round(((planDeadlineS - r.after.finishS) / 60) * 10) / 10,
    totalPoints: Math.max(0, takenPoints + r.after.points - r.after.penalty),
    expectedPrize: Math.max(0, takenPoints + r.after.prize),
    distanceM: r.after.distanceM,
    dropped: problem.nodes
      .filter((n) => n.role === 'kp' && n.kpId !== null && !inPlan.has(n.kpId))
      .map((n) => n.kpId as string),
  };
}
