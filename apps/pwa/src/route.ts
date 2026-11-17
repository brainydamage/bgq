// План маршрута и КП на телефоне: чистая логика (тестируется в Node).
import {
  clock,
  clockIn,
  type Kp,
  type KpState,
  type Loc,
  nodeIndex,
  type Pauses,
  type PhoneGame,
  pausedBefore,
  planDepartS,
  schedule,
} from '@bgq/core';

/** Сколько следующих точек показывает штурман. */
export const NEXT_STOPS = 4;

export interface KpRow {
  kp: Kp;
  status: KpState['status'];
  /** Время «взято» «ЧЧ:ММ». */
  answerTime?: string;
  answer: string;
  /** Место в плане: номер по порядку (с 1), приход и уход по плану. */
  stop?: { n: number; arriveS: number; departS: number; arrive: string; depart: string };
}

export interface RouteRows {
  /** КП плана по порядку. */
  plan: KpRow[];
  /** Остальные доступные КП — по номеру (загадки без отгадки тоже здесь). */
  rest: KpRow[];
}

const row = (kp: Kp, state: Map<string, KpState>): KpRow => {
  const s = state.get(kp.id);
  return {
    kp,
    status: s?.status ?? 'open',
    ...(s?.status === 'taken' && s.answerTime ? { answerTime: s.answerTime } : {}),
    answer: s?.answer ?? '',
  };
};

/** Порядок «не в плане»: по номеру, затем по id (25 < 25А); без номера — в конце. */
export function byNumber(a: Kp, b: Kp): number {
  return (
    (a.number ?? Number.POSITIVE_INFINITY) - (b.number ?? Number.POSITIVE_INFINITY) ||
    a.id.localeCompare(b.id, 'ru')
  );
}

/** КП игры + состояние из событий → список плана и «не в плане». КП плана не из kps — пропуск. */
export function routeRows(game: PhoneGame, state: Map<string, KpState>): RouteRows {
  const kps = game.kps ?? [];
  const byId = new Map(kps.map((k) => [k.id, k]));
  const plan: KpRow[] = [];
  const inPlan = new Set<string>();
  for (const stop of game.plan?.stops ?? []) {
    const kp = byId.get(stop.kpId);
    if (!kp || inPlan.has(kp.id)) continue;
    inPlan.add(kp.id);
    const t0 = game.plan?.t0 ?? '';
    plan.push({
      ...row(kp, state),
      stop: {
        n: plan.length + 1,
        arriveS: stop.arriveS,
        departS: stop.departS,
        arrive: clock(t0, stop.arriveS),
        depart: clock(t0, stop.departS),
      },
    });
  }
  const rest = kps
    .filter((k) => !inPlan.has(k.id))
    .sort(byNumber)
    .map((k) => row(k, state));
  return { plan, rest };
}

/** Следующие точки плана для штурмана: без взятых и пропущенных. */
export function nextStops(plan: readonly KpRow[], n = NEXT_STOPS): KpRow[] {
  return plan.filter((r) => r.status === 'open').slice(0, n);
}

export interface Forecast {
  /** Финиш по плану (как посчитал солвер) и запас до настоящего дедлайна, мин. */
  planFinish: string;
  planSlackMin: number;
  /**
   * Отклонение от плана, мин: > 0 — отстаём, < 0 — опережаем. Считается только в день игры;
   * время паузы в него не входит.
   */
  deltaMin: number;
  /** Пауза за игру всего, мин (с идущей). */
  pausedMin: number;
  /** Идущая пауза: с какого времени и сколько уже. */
  pause?: { since: string; min: number };
  /**
   * Прогноз финиша без новых пауз. С задачей в phone.json — прямой проход от последней взятой
   * точки по оставшимся открытым точкам плана (пропуски возвращают время, окна ждём); без неё —
   * план + пауза + отклонение.
   */
  finish: string;
  /** Запас до дедлайна по прогнозу = сколько ещё можно на паузу; < 0 — опоздание. */
  slackMin: number;
}

/** «ЧЧ:ММ» местного времени игры → секунды от t0 плана (t0 — местное время с поясом). */
export function secondsFromT0(t0: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const t0min = Number(t0.slice(11, 13)) * 60 + Number(t0.slice(14, 16));
  return ((h ?? 0) * 60 + (m ?? 0) - t0min) * 60;
}

/**
 * Финиш по прогнозу прямым проходом (с задачей в phone.json): из последней взятой точки плана в
 * момент «взято» (+ пауза после него) по открытым точкам плана к финишу; к первой — не раньше
 * «сейчас». Нет взятых — со старта по плану. Точки плана нет в задаче — null (считаем по-старому).
 */
function forwardFinishS(
  problem: NonNullable<PhoneGame['problem']>,
  p: NonNullable<PhoneGame['plan']>,
  plan: readonly KpRow[],
  nowS: number,
  pausedS: (atS: number) => number,
): number | null {
  const index = nodeIndex(problem);
  let from = problem.start;
  let t = planDepartS(problem, p);
  let lastTakenS = Number.NEGATIVE_INFINITY;
  for (const r of plan) {
    if (r.status !== 'taken' || !r.answerTime) continue;
    const takenS = secondsFromT0(p.t0, r.answerTime);
    const node = index.get(r.kp.id);
    if (takenS < lastTakenS || node === undefined) continue;
    lastTakenS = takenS;
    from = node;
    t = takenS;
  }
  const open = plan.filter((r) => r.status === 'open').map((r) => r.kp.id);
  if (open.some((id) => !index.has(id))) return null;
  const departS = t + Math.max(0, pausedS(nowS) - pausedS(t));
  return schedule(problem, open, departS, { from, notBeforeS: nowS, index }).finishS;
}

/**
 * Финиш, запас и отклонение от плана.
 * - Время паузы сдвигает весь план: оно не отставание, а трата резерва (запаса до дедлайна).
 * - Отклонение — худшее из двух: насколько позже плана отметили «взято» последнюю взятую точку
 *   плана (время «взято» — когда закончили, сравниваем с уходом по плану; раньше — опережение),
 *   и насколько «сейчас» позже прихода к следующей открытой точке (или к финишу).
 * - Запас — до настоящего дедлайна игры: резерв на паузу (план солвер строил на столько раньше),
 *   плюс запас самого плана, минус пауза, минус отставание (плюс опережение); с задачей в
 *   phone.json финиш — прямым проходом, и пропуск точки возвращает время.
 */
export function forecast(
  game: Pick<PhoneGame, 'date' | 'tz' | 'plan' | 'deadline' | 'problem'>,
  plan: readonly KpRow[],
  now: Date,
  pauses: Pauses = { closed: [] },
  /**
   * План принят на телефоне в этот момент (мс): его времена уже включают паузы до него, поэтому
   * в отклонении и сдвиге считаются только паузы после.
   */
  planAtMs?: number,
): Forecast | null {
  const p = game.plan;
  if (!p) return null;
  const t0Ms = Date.parse(p.t0);
  const nowS = (now.getTime() - t0Ms) / 1000;
  const base = planAtMs === undefined ? 0 : pausedBefore(pauses, planAtMs);
  const pausedS = (atS: number) => (pausedBefore(pauses, t0Ms + atS * 1000) - base) / 1000;
  const deadlineS = secondsFromT0(p.t0, game.deadline);

  let deltaS = 0;
  let forwardS: number | null = null;
  if (clockIn(game.tz, now).date === game.date) {
    const target = nextStops(plan, 1)[0]?.stop?.arriveS ?? p.finishS;
    const late = nowS - (target + pausedS(nowS));
    let last: number | undefined;
    let lastTakenS = Number.NEGATIVE_INFINITY;
    for (const r of plan) {
      if (r.status !== 'taken' || !r.answerTime || !r.stop) continue;
      const takenS = secondsFromT0(p.t0, r.answerTime);
      if (takenS < lastTakenS) continue;
      lastTakenS = takenS;
      last = takenS - (r.stop.departS + pausedS(takenS));
    }
    deltaS = last === undefined ? Math.max(0, late) : Math.max(last, late);
    if (game.problem) forwardS = forwardFinishS(game.problem, p, plan, nowS, pausedS);
  }
  const deltaMin = Math.round(deltaS / 60) + 0; // + 0: без «-0»
  const pausedMin = Math.round(pausedBefore(pauses, now.getTime()) / 60_000);
  const finishS = forwardS ?? p.finishS + Math.round(pausedS(nowS)) + deltaMin * 60;
  return {
    planFinish: clock(p.t0, p.finishS),
    planSlackMin: Math.round((deadlineS - p.finishS) / 60),
    deltaMin,
    pausedMin,
    ...(pauses.openSince !== undefined && {
      pause: {
        since: clock(p.t0, (pauses.openSince - t0Ms) / 1000),
        min: Math.max(0, Math.round((now.getTime() - pauses.openSince) / 60_000)),
      },
    }),
    finish: clock(p.t0, finishS),
    // + 0: без «-0» после округления.
    slackMin: Math.round((deadlineS - finishS) / 60) + 0,
  };
}

/** Строка прогноза и нужно ли её выделить (плохая новость). */
export interface ForecastLine {
  text: string;
  warn: boolean;
  /** pause — идущая пауза, main — главная строка (финиш и запас), detail — подробности мелко. */
  kind: 'pause' | 'main' | 'detail';
}

/**
 * Главное — одна строка: «Финиш ≈ 18:50 · запас 40 мин» (запас — сколько ещё можно отдыхать) или
 * красным «Финиш ≈ 19:41 · на 11 мин позже дедлайна». Над ней — идущая пауза, под ней мелко — из
 * чего сложилось: «отстаём от плана на 4 мин · отдыхали 55 мин · нажмите ⟳ Пересчитать».
 * Пока идём ровно по плану и не отдыхали — финиш и запас плана.
 */
export function forecastText(f: Forecast): ForecastLine[] {
  const lines: ForecastLine[] = [];
  if (f.pause)
    lines.push({
      text: `☕ пауза с ${f.pause.since} · ${f.pause.min} мин`,
      warn: false,
      kind: 'pause',
    });
  const asPlanned = f.deltaMin === 0 && !f.pausedMin && !f.pause;
  const finish = asPlanned ? f.planFinish : f.finish;
  const slack = asPlanned ? f.planSlackMin : f.slackMin;
  lines.push(
    slack >= 0
      ? { text: `Финиш ≈ ${finish} · запас ${slack} мин`, warn: false, kind: 'main' }
      : { text: `Финиш ≈ ${finish} · на ${-slack} мин позже дедлайна`, warn: true, kind: 'main' },
  );
  const details: string[] = [];
  if (f.deltaMin > 0) details.push(`отстаём от плана на ${f.deltaMin} мин`);
  else if (f.deltaMin < 0) details.push(`опережаем план на ${-f.deltaMin} мин`);
  if (f.pausedMin > 0 && !f.pause) details.push(`отдыхали ${f.pausedMin} мин`);
  if (slack < 0 && !f.pause) details.push('нажмите ⟳ Пересчитать');
  if (details.length) lines.push({ text: details.join(' · '), warn: false, kind: 'detail' });
  return lines;
}

/** «64 · 6 б» — подпись КП. */
export function kpLabel(kp: Kp): string {
  return `${kp.id} · ${kp.points} б`;
}

/**
 * Пройденные КП плана — свернуть, чтобы список начинался со следующей точки. Видны: последняя
 * взятая (откуда идём; по времени «взято», при равном — дальше по плану) и открытые по порядку
 * плана. Скрыты остальные взятые и пропущенные.
 */
export function collapseDone(plan: readonly KpRow[]): { hidden: KpRow[]; shown: KpRow[] } {
  let last: KpRow | undefined;
  for (const r of plan) {
    if (r.status !== 'taken') continue;
    if (!last || (r.answerTime ?? '') >= (last.answerTime ?? '')) last = r;
  }
  const hidden = plan.filter((r) => r.status !== 'open' && r !== last);
  const open = plan.filter((r) => r.status === 'open');
  return { hidden, shown: last ? [last, ...open] : open };
}

/** Взято / всего по плану и баллы взятых (всех КП). */
export function takenSummary(rows: RouteRows): { taken: number; points: number; skipped: number } {
  let taken = 0;
  let points = 0;
  let skipped = 0;
  for (const r of [...rows.plan, ...rows.rest]) {
    if (r.status === 'taken') {
      taken += 1;
      points += r.kp.points;
    } else if (r.status === 'skipped') skipped += 1;
  }
  return { taken, points, skipped };
}

/** Ссылка «вести»: geo: URI — Organic Maps на Android открывает точку с подписью. */
export function geoUri(loc: Pick<Loc, 'lat' | 'lon'>, label: string): string {
  const ll = `${loc.lat.toFixed(6)},${loc.lon.toFixed(6)}`;
  return `geo:${ll}?q=${ll}(${encodeURIComponent(label)})`;
}
