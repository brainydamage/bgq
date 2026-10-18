// План маршрута и КП на телефоне: чистая логика (тестируется в Node).
import { clock, clockIn, type Kp, type KpState, type Loc, type PhoneGame } from '@bgq/core';

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
  /** Финиш и запас по плану (как посчитал солвер). */
  planFinish: string;
  planSlackMin: number;
  /** Отставание от плана сейчас, мин (0 — идём по плану или раньше). */
  behindMin: number;
  /** С учётом отставания. */
  finish: string;
  slackMin: number;
}

/**
 * Финиш и запас. Отставание — насколько «сейчас» позже прихода по плану к следующей открытой
 * точке (или к финишу); считается только в день игры. Пропуски время не возвращают: матрицы на
 * телефоне нет, точный ответ даст пересчёт.
 */
export function forecast(
  game: Pick<PhoneGame, 'date' | 'tz' | 'plan'>,
  plan: readonly KpRow[],
  now: Date,
): Forecast | null {
  const p = game.plan;
  if (!p) return null;
  const planSlackMin = Math.round(p.slackMin);
  const target = nextStops(plan, 1)[0]?.stop?.arriveS ?? p.finishS;
  const nowS = (now.getTime() - Date.parse(p.t0)) / 1000;
  const today = clockIn(game.tz, now).date === game.date;
  const behindMin = today && nowS > target ? Math.ceil((nowS - target) / 60) : 0;
  return {
    planFinish: clock(p.t0, p.finishS),
    planSlackMin,
    behindMin,
    finish: clock(p.t0, p.finishS + behindMin * 60),
    slackMin: planSlackMin - behindMin,
  };
}

const slackText = (min: number) => (min >= 0 ? `запас ${min} мин` : `опоздание ${-min} мин`);

/** «финиш по плану 19:12, запас 18 мин» (+ «отстаём на 7 мин → 19:19, запас 11 мин»). */
export function forecastText(f: Forecast): string[] {
  const lines = [`финиш по плану ${f.planFinish}, ${slackText(f.planSlackMin)}`];
  if (f.behindMin > 0)
    lines.push(`отстаём на ${f.behindMin} мин → финиш ${f.finish}, ${slackText(f.slackMin)}`);
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
