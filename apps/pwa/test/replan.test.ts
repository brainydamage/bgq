import {
  type Event,
  Plan as PlanSchema,
  phoneGame,
  projectPauses,
  projectPlan,
  projectState,
  schemaErrors,
} from '@bgq/core';
import { describe, expect, it } from 'vitest';
import { makeEvent } from '../src/events.ts';
import {
  acceptedPlan,
  effectivePlan,
  pauseChoices,
  pauseLeftMin,
  type ReplanSetup,
  replanSetup,
  runReplan,
  verdictText,
} from '../src/replan.ts';
import { forecast, routeRows } from '../src/route.ts';
import { game, plan, problem, table } from './fixture.ts';

// 10.10: план солвера построен до игры; задача с резервом на паузу 45 мин (как 16.01).
const basePlan = { ...plan, createdAt: '2026-10-10T10:00:00.000Z' };
const phone = phoneGame(game, null, '2026-10-10T10:20:00.000Z', {
  points: table(),
  plan: basePlan,
  problem: { ...problem, deadlineS: problem.deadlineS - 2700, pauseS: 2700 },
});
const ids = plan.stops.map((s) => s.kpId);
const at = (s: number) => new Date(Date.parse(plan.t0) + s * 1000);
const hhmm = (s: number) =>
  at(s).toLocaleTimeString('ru', {
    timeZone: 'Europe/Belgrade',
    hour: '2-digit',
    minute: '2-digit',
  });

let seq = 0;
function ev(kpId: string, body: Parameters<typeof makeEvent>[2], atS: number): Event {
  seq += 1;
  return makeEvent(game.id, kpId, body, { deviceId: 'iphone', seq }, at(atS));
}
/** Детерминированно: перезапуски вместо времени. */
const fixed = (s: ReplanSetup): ReplanSetup => ({
  ...s,
  input: { ...s.input, timeMs: Number.POSITIVE_INFINITY, maxRestarts: 5, seed: 0 },
});

describe('пауза впереди', () => {
  it('остаток резерва: 45 мин минус пауза; после принятого плана — от выбранного', () => {
    const p = projectPauses(
      [ev('pause', { type: 'pause_started' }, 3600), ev('pause', { type: 'pause_ended' }, 4320)],
      game.id,
    );
    expect(pauseLeftMin(phone, p, at(5000))).toBe(33);
    const accepted = { plan: basePlan, atMs: at(4000).getTime(), pauseMin: 30 };
    // После принятия на паузе ещё 320 с (5 мин) → 25.
    expect(pauseLeftMin(phone, p, at(5000), accepted)).toBe(25);
    expect(pauseLeftMin({}, p, at(5000))).toBe(0);
  });

  it('варианты: 0/15/30/45/60 и остаток, если он не круглый', () => {
    expect(pauseChoices(33)).toEqual([0, 15, 30, 33, 45, 60]);
    expect(pauseChoices(45)).toEqual([0, 15, 30, 45, 60]);
  });
});

describe('пересчёт отсюда и сейчас (10.10)', () => {
  const k = 10;
  const anchor = plan.stops[k - 1] as (typeof plan.stops)[number];
  const late = anchor.departS + 1800;
  // Взяли первые 10 точек плана, последнюю — на 30 мин позже плана.
  const events = ids.slice(0, k).map((id, i) => {
    const s = i === k - 1 ? late : (plan.stops[i]?.departS ?? 0);
    return ev(id, { type: 'taken', answerTime: hhmm(s) }, s);
  });
  const state = projectState(events, game.id);
  const rows = routeRows(phone, state);
  const now = at(late + 60);

  it('откуда и до какого дедлайна: последняя взятая, «сейчас», настоящий дедлайн − пауза', () => {
    const setup = replanSetup(phone, rows, now, { closed: [] }, 45) as ReplanSetup;
    expect(setup.anchorId).toBe(ids[k - 1]);
    expect(setup.fromLabel).toMatch(new RegExp(`^от КП ${ids[k - 1]} \\(`));
    expect(setup.input.exclude).toEqual(new Set(ids.slice(0, k)));
    expect(setup.input.current).toEqual(ids.slice(k));
    expect(setup.deadlineS).toBe(7 * 3600);
    expect(setup.input.deadlineS).toBe(7 * 3600 - 45 * 60);
    expect(setup.input.notBeforeS).toBe(late + 60);
    expect(setup.done.map((r) => r.kp.id)).toEqual(ids.slice(0, k));
  });

  it('без задачи в phone.json — причина вместо пересчёта', () => {
    const { problem: _, ...old } = phone;
    expect(replanSetup(old, rows, now, { closed: [] }, 45)).toMatch(/нет задачи/);
  });

  it('отстаём на 30 мин, обед 45 не отдаём: «было» опаздывает, «стало» успевает с паузой', () => {
    const setup = fixed(replanSetup(phone, rows, now, { closed: [] }, 45) as ReplanSetup);
    const { view } = runReplan(setup, plan.t0);
    expect(view.before.slackMin).toBeLessThan(45);
    expect(view.after.slackMin).toBeGreaterThanOrEqual(43);
    expect(view.after.kps).toBeLessThan(view.before.kps);
    expect(view.removed.length).toBeGreaterThan(0);
    expect(view.next).toHaveLength(4);
    // Обед 45 сохранили ценой точек: баллов меньше, чем у «было» с опозданием.
    expect(verdictText(view, 45)).toBe(
      `на ${view.before.points - view.after.points} б меньше — цена паузы 45 мин: убрать ${view.removed.join(', ')}`,
    );
  });

  it('итог одной строкой', () => {
    const side = (points: number) => ({ kps: 1, points, finish: '19:00', slackMin: 0 });
    const v = (b: number, a: number, added: string[], removed: string[]) =>
      verdictText({ before: side(b), after: side(a), added, removed });
    expect(v(131, 136, [], ['57'])).toBe('лучше на 5 б: убрать 57');
    expect(v(100, 100, ['99'], ['57', '61'])).toBe('баллы те же: убрать 57, 61, добавить 99');
    expect(v(100, 97, [], ['57'])).toBe('на 3 б меньше: убрать 57');
    expect(
      verdictText({ before: side(100), after: side(97), added: [], removed: ['57'] }, 30),
    ).toBe('на 3 б меньше — цена паузы 30 мин: убрать 57');
    expect(v(100, 100, [], [])).toBe('');
    expect(v(100, 102, [], [])).toBe('лучше на 2 б');
  });

  it('меньше паузы — больше точек', () => {
    const p45 = runReplan(
      fixed(replanSetup(phone, rows, now, { closed: [] }, 45) as ReplanSetup),
      plan.t0,
    );
    const p0 = runReplan(
      fixed(replanSetup(phone, rows, now, { closed: [] }, 0) as ReplanSetup),
      plan.t0,
    );
    expect(p0.view.after.points).toBeGreaterThan(p45.view.after.points);
    expect(p0.view.after.slackMin).toBeLessThan(15);
  });

  it('«Принять»: план со сделанным в начале; после него — по графику и пауза = выбранной', () => {
    const setup = fixed(replanSetup(phone, rows, now, { closed: [] }, 30) as ReplanSetup);
    const { result } = runReplan(setup, plan.t0);
    const accepted = acceptedPlan(phone, setup, result, now, 30);
    expect(schemaErrors(PlanSchema, accepted)).toEqual([]);
    expect(accepted.solver).toBe('heuristic');
    expect(accepted.problemHash).toBe(plan.problemHash);
    expect(accepted.stops.slice(0, k).map((s) => s.kpId)).toEqual(ids.slice(0, k));
    expect(accepted.stops.slice(k).map((s) => s.kpId)).toEqual(result.after.order);

    // Событие plan_accepted → план для экранов; прогноз — без отставания, на паузу ~30 мин.
    const e = ev('plan', { type: 'plan_accepted', plan: accepted, pauseMin: 30 }, late + 90);
    const eff = effectivePlan(phone, projectPlan([...events, e], game.id));
    expect(eff.accepted?.pauseMin).toBe(30);
    expect(eff.game.plan?.planId).toBe(accepted.planId);
    const r2 = routeRows(eff.game, state);
    const f = forecast(eff.game, r2.plan, at(late + 120), { closed: [] }, eff.accepted?.atMs);
    expect(f?.deltaMin).toBe(0);
    expect(f?.slackMin).toBeGreaterThanOrEqual(28);
    expect(f?.slackMin).toBeLessThanOrEqual(31);
  });

  it('план с ноутбука новее принятого или с другой задачей — принятый не действует', () => {
    const setup = fixed(replanSetup(phone, rows, now, { closed: [] }, 30) as ReplanSetup);
    const accepted = acceptedPlan(phone, setup, runReplan(setup, plan.t0).result, now, 30);
    const a = { plan: accepted, atMs: now.getTime(), pauseMin: 30 };
    expect(effectivePlan(phone, a).accepted).toBe(a);
    const newer = { ...phone, plan: { ...basePlan, createdAt: '2026-10-10T20:00:00.000Z' } };
    expect(effectivePlan(newer, a).accepted).toBeUndefined();
    const other = { ...phone, plan: { ...basePlan, problemHash: 'sha256:другая' } };
    expect(effectivePlan(other, a).game.plan?.problemHash).toBe('sha256:другая');
    expect(effectivePlan(phone, undefined).game).toBe(phone);
  });
});
