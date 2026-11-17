import {
  clock,
  type Event,
  PhoneGame,
  type Plan,
  phoneGame,
  planMissing,
  projectPauses,
  projectState,
  schemaErrors,
} from '@bgq/core';
import { describe, expect, it } from 'vitest';
import { makeEvent } from '../src/events.ts';
import {
  collapseDone,
  forecast,
  forecastText,
  geoUri,
  nextStops,
  routeRows,
  takenSummary,
} from '../src/route.ts';
import { parseHash, screenHash } from '../src/router.ts';
import { game, plan, problem, table } from './fixture.ts';

const points = table();
const phone = phoneGame(game, null, '2026-10-10T12:20:00.000Z', { points, plan, problem });

let seq = 0;
/** Событие в момент «ЧЧ:ММ» дня игры (+02:00). */
function ev(kpId: string, body: Parameters<typeof makeEvent>[2], at: string): Event {
  seq += 1;
  return makeEvent(
    game.id,
    kpId,
    body,
    { deviceId: 'android', seq },
    new Date(`2026-10-10T${at}:00+02:00`),
  );
}

describe('phone.json с КП и планом (10.10)', () => {
  it('доступные КП, старт/финиш и план; схема PhoneGame валидна', () => {
    expect(phone.kps).toHaveLength(76);
    expect(phone.kps?.every((k) => k.eligible)).toBe(true);
    expect(phone.kps?.some((k) => k.id === '83')).toBe(false); // только Вело
    expect(phone.start).toMatchObject({ lat: 44.9776 });
    expect(phone.finish).toMatchObject({ lat: 44.9705 });
    expect(phone.plan?.stops).toHaveLength(37);
    expect(phone.problem?.nodes).toHaveLength(78);
    expect(planMissing(plan, points)).toEqual([]);
    expect(schemaErrors(PhoneGame, phone)).toEqual([]);
  });

  it('без points.json — только задания, как раньше; старый phone.json проходит схему', () => {
    const old = phoneGame(game, null, '2026-10-10T12:20:00.000Z');
    expect(old.kps).toBeUndefined();
    expect(old.plan).toBeUndefined();
    expect(schemaErrors(PhoneGame, old)).toEqual([]);
  });

  it('план не с этой карты — planMissing называет КП', () => {
    const alien = { ...plan, stops: [...plan.stops, { kpId: '999', arriveS: 1, departS: 2 }] };
    expect(planMissing(alien, points)).toEqual(['999']);
  });
});

describe('маршрут: порядок плана и «не в плане»', () => {
  const rows = routeRows(phone, new Map());

  it('КП плана по порядку солвера, номера с 1, приход по часам игры', () => {
    expect(rows.plan.map((r) => r.kp.id)).toEqual(plan.stops.map((s) => s.kpId));
    expect(rows.plan[0]?.stop?.n).toBe(1);
    expect(rows.plan.at(-1)?.stop?.n).toBe(37);
    const first = plan.stops[0] as Plan['stops'][number];
    const min = 12 * 60 + 30 + Math.round(first.arriveS / 60);
    expect(rows.plan[0]?.stop?.arrive).toBe(
      `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`,
    );
  });

  it('«не в плане» — остальные 39 по номеру (25 < 25А < 26)', () => {
    expect(rows.rest).toHaveLength(76 - 37);
    const ids = rows.rest.map((r) => r.kp.id);
    const nums = rows.rest.map((r) => r.kp.number ?? 0);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(ids.indexOf('25')).toBeLessThan(ids.indexOf('25А'));
    expect(ids.indexOf('25А')).toBeLessThan(ids.indexOf('26'));
  });

  it('без плана — все КП в «не в плане»', () => {
    const { plan: _, ...noPlan } = phone;
    const r = routeRows(noPlan, new Map());
    expect(r.plan).toEqual([]);
    expect(r.rest).toHaveLength(76);
  });
});

describe('штурман: следующие точки', () => {
  const ids = plan.stops.map((s) => s.kpId);
  const [a, b, c, d, e] = ids as [string, string, string, string, string];

  it('первые 4 точки плана, пока ничего не взято', () => {
    const rows = routeRows(phone, new Map());
    expect(nextStops(rows.plan).map((r) => r.kp.id)).toEqual([a, b, c, d]);
  });

  it('взятые и пропущенные выпадают; reopened возвращает точку', () => {
    const events = [
      ev(a, { type: 'taken', answerTime: '12:40' }, '12:40'),
      ev(b, { type: 'skipped' }, '12:41'),
    ];
    let rows = routeRows(phone, projectState(events, game.id));
    expect(nextStops(rows.plan).map((r) => r.kp.id)).toEqual([c, d, e, ids[5]]);
    expect(rows.plan[0]).toMatchObject({ status: 'taken', answerTime: '12:40' });
    expect(takenSummary(rows)).toMatchObject({ taken: 1, skipped: 1 });

    events.push(ev(b, { type: 'reopened' }, '12:42'));
    rows = routeRows(phone, projectState(events, game.id));
    expect(nextStops(rows.plan)[0]?.kp.id).toBe(b);
  });

  it('ответ КП — answer_changed, сохраняется и после отмены «взято»', () => {
    const events = [
      ev(a, { type: 'taken', answerTime: '12:40' }, '12:40'),
      ev(a, { type: 'answer_changed', answer: 'Тесла' }, '12:41'),
      ev(a, { type: 'answer_changed', answerTime: '12:38' }, '12:42'),
      ev(a, { type: 'reopened' }, '12:43'),
    ];
    const s = projectState(events, game.id);
    expect(routeRows(phone, s).plan[0]).toMatchObject({ status: 'open', answer: 'Тесла' });
    expect(routeRows(phone, s).plan[0]?.answerTime).toBeUndefined();
    const taken = projectState(events.slice(0, 3), game.id);
    expect(routeRows(phone, taken).plan[0]?.answerTime).toBe('12:38');
  });

  it('всё взято — следующих нет (дальше финиш)', () => {
    const events = ids.map((id) => ev(id, { type: 'taken', answerTime: '15:00' }, '15:00'));
    expect(nextStops(routeRows(phone, projectState(events, game.id)).plan)).toEqual([]);
  });
});

describe('прогноз: опережение, отставание, пауза', () => {
  const rows = routeRows(phone, new Map());
  const [first, second] = plan.stops as [Plan['stops'][number], Plan['stops'][number]];
  const at = (s: number) => new Date(Date.parse(plan.t0) + s * 1000);
  const hhmm = (s: number) => clock(plan.t0, s);
  /** «ЧЧ:ММ» → секунды от t0 (12:30). */
  const sOf = (t: string) => (Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) - 750) * 60;
  const takenFirst = (time: string) =>
    routeRows(
      phone,
      projectState([ev(first.kpId, { type: 'taken', answerTime: time }, time)], game.id),
    ).plan;
  const pauseEv = (type: 'pause_started' | 'pause_ended', s: number) =>
    makeEvent(game.id, 'pause', { type }, { deviceId: 'iphone', seq: 900 + s }, at(s));
  type F = NonNullable<ReturnType<typeof forecast>>;
  /** Дедлайн 19:30 от t0 12:30. */
  const DEADLINE_S = 7 * 3600;

  it('по плану: финиш солвера и запас до настоящего дедлайна', () => {
    const f = forecast(phone, rows.plan, at(0)) as F;
    expect(f).toMatchObject({ deltaMin: 0, pausedMin: 0, slackMin: 0, planSlackMin: 0 });
    expect(forecastText(f)).toEqual([
      { text: `Финиш ≈ ${f.planFinish} · запас 0 мин`, warn: false, kind: 'main' },
    ]);
  });

  it('позже прихода к следующей точке — отставание сдвигает финиш и съедает запас', () => {
    const f = forecast(phone, rows.plan, at(first.arriveS + 7 * 60 + 10)) as F;
    expect(f.deltaMin).toBe(7);
    expect(f.slackMin).toBe(-7);
    expect(f.finish).toBe(hhmm(plan.finishS + 7 * 60));
    expect(forecastText(f)).toEqual([
      { text: `Финиш ≈ ${f.finish} · на 7 мин позже дедлайна`, warn: true, kind: 'main' },
      { text: 'отстаём от плана на 7 мин · нажмите ⟳ Пересчитать', warn: false, kind: 'detail' },
    ]);
  });

  it('«взято» раньше ухода по плану — опережение, запас растёт', () => {
    const time = hhmm(first.departS - 12 * 60);
    const lead = Math.round((sOf(time) - first.departS) / 60);
    const f = forecast(phone, takenFirst(time), at(sOf(time))) as F;
    expect(lead).toBeLessThanOrEqual(-11);
    expect(f.deltaMin).toBe(lead);
    // Прямой проход — в секундах: запас плана 13 с + опережение.
    const slack = Math.round((DEADLINE_S - plan.finishS - (sOf(time) - first.departS)) / 60);
    expect(slack).toBeGreaterThanOrEqual(-lead);
    expect(f.slackMin).toBe(slack);
    expect(forecastText(f)).toEqual([
      { text: `Финиш ≈ ${f.finish} · запас ${slack} мин`, warn: false, kind: 'main' },
      { text: `опережаем план на ${-lead} мин`, warn: false, kind: 'detail' },
    ]);
  });

  it('после «взято» вовремя — сравниваем со следующей точкой', () => {
    const r = takenFirst(hhmm(first.departS));
    expect(forecast(phone, r, at(second.arriveS))?.deltaMin).toBe(0);
    expect(forecast(phone, r, at(second.arriveS + 60))?.deltaMin).toBe(1);
  });

  it('пауза — не отставание: тратит запас, план сдвигается', () => {
    const now = first.arriveS + 7 * 60 + 10;
    const open = projectPauses([pauseEv('pause_started', first.arriveS - 300)], game.id);
    const f = forecast(phone, rows.plan, at(now), open) as F;
    expect(f).toMatchObject({ deltaMin: 0, pausedMin: 12, slackMin: -12 });
    expect(f.pause).toEqual({ since: hhmm(first.arriveS - 300), min: 12 });
    expect(forecastText(f)[0]).toEqual({
      text: `☕ пауза с ${hhmm(first.arriveS - 300)} · 12 мин`,
      warn: false,
      kind: 'pause',
    });
    // Идущая пауза — без «нажмите ⟳ Пересчитать»: сначала закончить.
    expect(forecastText(f).map((l) => l.kind)).toEqual(['pause', 'main']);

    // Резерв 45 мин (план строился до 18:45, дедлайн 19:30): после паузы на 12 мин — ещё 33.
    const reserve = { ...phone, deadline: '20:15' };
    const closed = projectPauses(
      [pauseEv('pause_started', first.arriveS - 300), pauseEv('pause_ended', now)],
      game.id,
    );
    const g = forecast(reserve, rows.plan, at(now + 60), closed) as F;
    expect(g).toMatchObject({ deltaMin: 0, pausedMin: 12, slackMin: 33, planSlackMin: 45 });
    expect(g.pause).toBeUndefined();
    expect(forecastText(g)).toEqual([
      { text: `Финиш ≈ ${g.finish} · запас 33 мин`, warn: false, kind: 'main' },
      { text: 'отдыхали 12 мин', warn: false, kind: 'detail' },
    ]);
  });

  it('пропуск возвращает время: финиш прямым проходом раньше, запас больше', () => {
    const third = plan.stops[2] as Plan['stops'][number];
    const skipped = routeRows(
      phone,
      projectState(
        [
          ev(first.kpId, { type: 'taken', answerTime: hhmm(first.departS) }, hhmm(first.departS)),
          ev(second.kpId, { type: 'skipped' }, hhmm(first.departS)),
        ],
        game.id,
      ),
    ).plan;
    const f = forecast(phone, skipped, at(first.departS + 60)) as F;
    expect(f.deltaMin).toBe(0);
    const saved = second.departS - first.departS + (third.arriveS - second.departS);
    expect(f.slackMin).toBeGreaterThan(5);
    expect(f.slackMin).toBeLessThan(Math.round(saved / 60));
    // Без задачи в phone.json — по-старому: пропуск времени не возвращает.
    const { problem: _, ...noProblem } = phone;
    expect(forecast(noProblem, skipped, at(first.departS + 60))?.slackMin).toBe(0);
  });

  it('окно КП 120 (с 14:00) — ожидание съедает опережение до него', () => {
    const k = plan.stops.findIndex((s) => s.kpId === '120');
    const before = plan.stops[k - 1] as Plan['stops'][number];
    const r = routeRows(
      phone,
      projectState(
        plan.stops
          .slice(0, k)
          .map((s) => ev(s.kpId, { type: 'taken', answerTime: hhmm(s.departS) }, hhmm(s.departS))),
        game.id,
      ),
    ).plan;
    // Пришли к 120 вовремя: окно уже открыто, финиш — по плану.
    const onTime = forecast(phone, r, at(before.departS)) as F;
    expect(onTime.slackMin).toBe(0);
  });

  it('не в день игры — без отклонения; без плана — null', () => {
    const f = forecast({ ...phone, date: '2026-10-11' }, rows.plan, at(first.arriveS + 3600));
    expect(f?.deltaMin).toBe(0);
    const { plan: _, ...noPlan } = phone;
    expect(forecast(noPlan, rows.plan, at(0))).toBeNull();
  });
});

describe('вести и экраны', () => {
  it('geo: URI для Organic Maps — координаты и подпись', () => {
    expect(geoUri({ lat: 44.9776, lon: 19.601 }, '64 · 6 б')).toBe(
      'geo:44.977600,19.601000?q=44.977600,19.601000(64%20%C2%B7%206%20%D0%B1)',
    );
  });

  it('хэш ↔ экран; КП с буквой', () => {
    expect(parseHash('#route')).toEqual({ name: 'route' });
    expect(parseHash('#nav')).toEqual({ name: 'nav' });
    expect(parseHash('#book')).toEqual({ name: 'book' });
    expect(parseHash('')).toBeNull();
    expect(parseHash('#что-то')).toBeNull();
    const kp = { name: 'kp', id: '25А' } as const;
    expect(parseHash(screenHash(kp))).toEqual(kp);
  });
});

describe('пройденные КП свёрнуты', () => {
  const ids = plan.stops.map((st) => st.kpId);
  const id = (i: number) => ids[i] as string;

  it('видны последняя взятая и открытые по плану; скрыты остальные взятые и пропущенные', () => {
    const state = projectState(
      [
        ev(id(0), { type: 'taken', answerTime: '12:46' }, '12:46'),
        ev(id(1), { type: 'skipped' }, '12:50'),
        ev(id(2), { type: 'taken', answerTime: '13:05' }, '13:05'),
        // Взяли точку дальше по плану раньше по времени — «откуда идём» всё равно последняя по времени.
        ev(id(5), { type: 'taken', answerTime: '12:58' }, '12:58'),
      ],
      game.id,
    );
    const { hidden, shown } = collapseDone(routeRows(phone, state).plan);
    expect(hidden.map((r) => r.kp.id)).toEqual([id(0), id(1), id(5)]);
    expect(shown.slice(0, 4).map((r) => r.kp.id)).toEqual([id(2), id(3), id(4), id(6)]);
    expect(shown.length + hidden.length).toBe(ids.length);
  });

  it('ничего не взято — сворачивать нечего', () => {
    const rows = routeRows(phone, projectState([], game.id)).plan;
    expect(collapseDone(rows)).toEqual({ hidden: [], shown: rows });
  });
});
