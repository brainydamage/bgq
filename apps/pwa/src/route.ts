// План маршрута и КП на телефоне: чистая логика (тестируется в Node).
import {
  clock,
  clockIn,
  type Kp,
  type KpState,
  type Loc,
  type Pauses,
  type PhoneGame,
  pausedBefore,
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
  /** Прогноз финиша без новых пауз: план + пауза + отклонение. */
  finish: string;
  /** Запас до дедлайна по прогнозу = сколько ещё можно на паузу; < 0 — опоздание. */
  slackMin: number;
}

/** «ЧЧ:ММ» местного времени игры → секунды от t0 плана (t0 — местное время с поясом). */
function secondsFromT0(t0: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const t0min = Number(t0.slice(11, 13)) * 60 + Number(t0.slice(14, 16));
  return ((h ?? 0) * 60 + (m ?? 0) - t0min) * 60;
}

/**
 * Финиш, запас и отклонение от плана.
 * - Время паузы сдвигает весь план: оно не отставание, а трата резерва (запаса до дедлайна).
 * - Отклонение — худшее из двух: насколько позже плана отметили «взято» последнюю взятую точку
 *   плана (время «взято» — когда закончили, сравниваем с уходом по плану; раньше — опережение),
 *   и насколько «сейчас» позже прихода к следующей открытой точке (или к финишу).
 * - Запас — до настоящего дедлайна игры: резерв на паузу (план солвер строил на столько раньше),
 *   плюс запас самого плана, минус пауза, минус отставание (плюс опережение).
 * Пропуски время не возвращают напрямую: к следующей точке просто приходим раньше.
 */
export function forecast(
  game: Pick<PhoneGame, 'date' | 'tz' | 'plan' | 'deadline'>,
  plan: readonly KpRow[],
  now: Date,
  pauses: Pauses = { closed: [] },
): Forecast | null {
  const p = game.plan;
  if (!p) return null;
  const t0Ms = Date.parse(p.t0);
  const nowS = (now.getTime() - t0Ms) / 1000;
  const pausedS = (atS: number) => pausedBefore(pauses, t0Ms + atS * 1000) / 1000;
  const deadlineS = secondsFromT0(p.t0, game.deadline);

  let deltaS = 0;
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
  }
  const deltaMin = Math.round(deltaS / 60);
  const pausedMin = Math.round(pausedS(nowS) / 60);
  const finishS = p.finishS + pausedMin * 60 + deltaMin * 60;
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
    slackMin: Math.round((deadlineS - finishS) / 60),
  };
}

/** Строка прогноза и нужно ли её выделить (плохая новость). */
export interface ForecastLine {
  text: string;
  warn: boolean;
}

/**
 * Пауза: «☕ пауза с 16:40 · 23 мин». Отклонение: «опережаем на 12 мин» / «отстаём на 8 мин».
 * Итог: «на паузу ещё 57 мин · ожидаемый финиш 18:07» или «опоздание 6 мин · ожидаемый финиш 19:10».
 * До старта плана и не в день игры отклонения нет — только финиш по плану и запас.
 */
export function forecastText(f: Forecast): ForecastLine[] {
  const lines: ForecastLine[] = [];
  if (f.pause)
    lines.push({ text: `☕ пауза с ${f.pause.since} · ${f.pause.min} мин`, warn: false });
  if (f.deltaMin > 0) lines.push({ text: `отстаём на ${f.deltaMin} мин`, warn: true });
  else if (f.deltaMin < 0) lines.push({ text: `опережаем на ${-f.deltaMin} мин`, warn: false });
  const paused = f.pausedMin > 0 && !f.pause ? ` · пауза была ${f.pausedMin} мин` : '';
  lines.push(
    f.slackMin >= 0
      ? {
          text: `на паузу ещё ${f.slackMin} мин · ожидаемый финиш ${f.finish}${paused}`,
          warn: false,
        }
      : { text: `опоздание ${-f.slackMin} мин · ожидаемый финиш ${f.finish}${paused}`, warn: true },
  );
  if (f.deltaMin === 0 && !f.pausedMin && !f.pause) {
    const slack =
      f.planSlackMin >= 0 ? `на паузу ${f.planSlackMin} мин` : `опоздание ${-f.planSlackMin} мин`;
    lines[lines.length - 1] = {
      text: `финиш по плану ${f.planFinish}, ${slack}`,
      warn: f.planSlackMin < 0,
    };
  }
  return lines;
}

/** «64 · 6 б» — подпись КП. */
export function kpLabel(kp: Kp): string {
  return `${kp.id} · ${kp.points} б`;
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
