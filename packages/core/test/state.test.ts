import { describe, expect, it } from 'vitest';
import {
  type Event,
  type Game,
  orderEvents,
  PhoneGame,
  phoneGame,
  projectState,
  schemaErrors,
} from '../src/index.ts';

const GAME = '2026-10-10';
let n = 0;
/** Событие с уникальным id; clientTs — «ЧЧ:ММ:СС» дня игры. */
function ev(
  type: Event['type'],
  kpId: string,
  at: string,
  extra: Record<string, unknown> = {},
): Event {
  n += 1;
  return {
    v: 1,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    gameId: GAME,
    kpId,
    deviceId: 'iphone',
    seq: n,
    clientTs: `2026-10-10T${at}+02:00`,
    type,
    ...extra,
  } as Event;
}

describe('projectState: события → состояние', () => {
  it('taken → взято со временем; reopened стирает время, заметка остаётся', () => {
    const events = [
      ev('taken', 't-pismo-sebe', '14:05:00', { answerTime: '14:05' }),
      ev('answer_changed', 't-pismo-sebe', '14:06:00', { answer: 'в рюкзаке' }),
      ev('reopened', 't-pismo-sebe', '14:07:00'),
    ];
    const s = projectState(events, GAME).get('t-pismo-sebe');
    expect(s).toMatchObject({ status: 'open', answer: 'в рюкзаке', solved: false });
    expect(s?.answerTime).toBeUndefined();
    expect(s?.updatedAt).toBe('2026-10-10T14:07:00+02:00');
  });

  it('answer_changed правит время «сделано» и заметку, пустая заметка — стирает', () => {
    const events = [
      ev('taken', 't-x', '14:05:00', { answerTime: '14:05' }),
      ev('answer_changed', 't-x', '14:10:00', { answerTime: '13:58' }),
      ev('answer_changed', 't-x', '14:11:00', { answer: 'фото у Иры' }),
      ev('answer_changed', 't-x', '14:12:00', { answer: '' }),
    ];
    expect(projectState(events, GAME).get('t-x')).toMatchObject({
      status: 'taken',
      answerTime: '13:58',
      answer: '',
    });
  });

  it('порядок — по clientTs, а не по порядку прихода; при равенстве — deviceId, затем seq', () => {
    const taken = ev('taken', 't-x', '14:05:00', { answerTime: '14:05' });
    const reopened = ev('reopened', 't-x', '14:01:00');
    expect(projectState([taken, reopened], GAME).get('t-x')?.status).toBe('taken');

    const a = ev('taken', 't-y', '14:00:00', { answerTime: '14:00', deviceId: 'android', seq: 9 });
    const b = ev('reopened', 't-y', '14:00:00', { deviceId: 'iphone', seq: 1 });
    expect(projectState([b, a], GAME).get('t-y')?.status).toBe('open');
    const c = ev('taken', 't-z', '14:00:00', { answerTime: '14:00', seq: 2 });
    const d = ev('reopened', 't-z', '14:00:00', { seq: 1 });
    expect(projectState([c, d], GAME).get('t-z')?.status).toBe('taken');
  });

  it('одинаковое время в разных зонах сравнивается как момент', () => {
    const taken = ev('taken', 't-x', '12:05:00', { answerTime: '14:05' });
    const reopened = { ...ev('reopened', 't-x', '14:01:00'), clientTs: '2026-10-10T12:01:00Z' };
    // 12:05+02:00 = 10:05Z — раньше, чем 12:01Z.
    expect(projectState([taken, reopened], GAME).get('t-x')?.status).toBe('open');
  });

  it('дубли по id (двойной тап, повторный sync) учитываются один раз', () => {
    const taken = ev('taken', 't-x', '14:05:00', { answerTime: '14:05' });
    const reopened = ev('reopened', 't-x', '14:06:00');
    expect(orderEvents([taken, reopened, taken, reopened])).toHaveLength(2);
    expect(projectState([taken, reopened, { ...taken }], GAME).get('t-x')?.status).toBe('open');
  });

  it('события другой игры не учитываются; skipped и solved', () => {
    const events = [
      { ...ev('taken', 't-x', '14:05:00', { answerTime: '14:05' }), gameId: '2026-01-01' },
      ev('skipped', '64', '14:06:00'),
      ev('solved', '95', '14:07:00', { answer: 'чесма' }),
    ];
    const state = projectState(events, GAME);
    expect(state.has('t-x')).toBe(false);
    expect(state.get('64')?.status).toBe('skipped');
    expect(state.get('95')).toMatchObject({ status: 'open', solved: true, answer: 'чесма' });
  });
});

describe('phoneGame: phone.json для телефона', () => {
  const game = {
    id: GAME,
    city: 'Сремска Митровица',
    date: GAME,
    tz: 'Europe/Belgrade',
    start: { time: '10:30' },
    finish: { deadline: '19:30', graceMin: 30, penaltyPerMin: 1 },
    category: 'pro',
    mode: 'foot',
    allowedColors: ['red', 'blue'],
    pointsRule: { kind: 'floor_div', divisor: 10 },
  } as Game;

  it('дедлайн и пояс из game.json; без riddles.json — пустой список, схема валидна', () => {
    const phone = phoneGame(game, null, '2026-10-10T12:00:00.000Z');
    expect(phone).toMatchObject({ gameId: GAME, deadline: '19:30', tz: 'Europe/Belgrade' });
    expect(phone.tasks).toEqual([]);
    expect(schemaErrors(PhoneGame, phone)).toEqual([]);
  });
});
