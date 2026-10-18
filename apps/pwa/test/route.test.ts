import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Event,
  type Game,
  type MapFileResults,
  PhoneGame,
  type Plan,
  type PointsFile,
  phoneGame,
  planMissing,
  projectState,
  schemaErrors,
} from '@bgq/core';
import { buildIndex, type Gazetteer, geocodeAll } from '@bgq/geo';
import { ingest } from '@bgq/ingest';
import { buildTable } from '@bgq/table';
import { describe, expect, it } from 'vitest';
import { makeEvent } from '../src/events.ts';
import {
  forecast,
  forecastText,
  geoUri,
  nextStops,
  routeRows,
  takenSummary,
} from '../src/route.ts';
import { parseHash, screenHash } from '../src/router.ts';

const fx = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../../fixtures/2026-10-10', name), 'utf8');
const game = JSON.parse(fx('game.json')) as Game;
// План солвера по fixtures/2026-10-10/problem.json: выход 12:30, 37 КП, 207 б.
const plan = JSON.parse(fx('plan.json')) as Plan;

/** Таблица 10.10 + старт и финиш, как если бы их отметили на карте (как в kml.test.ts). */
function table(): PointsFile {
  const { kps } = ingest({ md: fx('notion-export.md'), game, overrides: fx('overrides.yaml') });
  const geo = geocodeAll(kps, buildIndex(JSON.parse(fx('osm-gazetteer.json')) as Gazetteer));
  const map = JSON.parse(fx('map.json')) as MapFileResults;
  const loc = (lat: number, lon: number) => ({ lat, lon, source: 'map' as const, confidence: 0.8 });
  map.results.push(
    { id: 'start', loc: loc(44.9776, 19.601), color: null, photo: 'IMG_7081.jpg' },
    { id: 'finish', loc: loc(44.9705, 19.6093), color: null, photo: 'IMG_7081.jpg' },
  );
  return buildTable({
    game,
    kps,
    kpsAt: '2026-10-16T21:12:00.000Z',
    geo: { osmBase: '2026-10-15T20:21:00Z', results: geo },
    map,
    now: new Date('2026-10-16T23:00:00Z'),
  });
}

const points = table();
const phone = phoneGame(game, null, '2026-10-10T12:20:00.000Z', { points, plan });

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

describe('запас: финиш по плану и отставание', () => {
  const rows = routeRows(phone, new Map());
  const firstArrive = (plan.stops[0] as Plan['stops'][number]).arriveS;
  const at = (s: number) => new Date(Date.parse(plan.t0) + s * 1000);

  it('по плану: финиш и запас солвера', () => {
    const f = forecast(phone, rows.plan, at(0));
    expect(f).toMatchObject({ behindMin: 0, slackMin: Math.round(plan.slackMin) });
    expect(forecastText(f as NonNullable<typeof f>)).toEqual([
      `финиш по плану ${f?.planFinish}, запас ${Math.round(plan.slackMin)} мин`,
    ]);
  });

  it('позже прихода к следующей точке — отставание сдвигает финиш и съедает запас', () => {
    const f = forecast(phone, rows.plan, at(firstArrive + 7 * 60 + 10)) as NonNullable<
      ReturnType<typeof forecast>
    >;
    expect(f.behindMin).toBe(8); // минута начатая
    expect(f.slackMin).toBe(Math.round(plan.slackMin) - 8);
    expect(forecastText(f)[1]).toMatch(/^отстаём на 8 мин → финиш \d\d:\d\d, опоздание \d+ мин$/);
  });

  it('следующая — по статусам: первая взята, сравниваем со второй', () => {
    const s = projectState(
      [ev(plan.stops[0]?.kpId ?? '', { type: 'taken', answerTime: '12:40' }, '12:40')],
      game.id,
    );
    const r = routeRows(phone, s);
    const second = (plan.stops[1] as Plan['stops'][number]).arriveS;
    expect(forecast(phone, r.plan, at(second))?.behindMin).toBe(0);
    expect(forecast(phone, r.plan, at(second + 60))?.behindMin).toBe(1);
  });

  it('не в день игры — без отставания; без плана — null', () => {
    const f = forecast({ ...phone, date: '2026-10-11' }, rows.plan, at(firstArrive + 3600));
    expect(f?.behindMin).toBe(0);
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
    expect(parseHash('')).toBeNull();
    expect(parseHash('#что-то')).toBeNull();
    const kp = { name: 'kp', id: '25А' } as const;
    expect(parseHash(screenHash(kp))).toEqual(kp);
  });
});
