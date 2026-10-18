import { Event, projectState, schemaErrors } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import {
  finishReminder,
  pointsLabel,
  summarize,
  summaryText,
  taskRows,
  visibleRows,
} from '../src/checklist.ts';
import { makeEvent, toggleBody, uuid } from '../src/events.ts';
import { sheetTasks } from './fixture.ts';

const GAME = '2026-10-10';
// Задания 10.10 из расшифровки листков: 10 штук, 56 б.
const tasks = sheetTasks();
const id = (title: string) => {
  const t = tasks.find((x) => x.title.startsWith(title));
  if (!t) throw new Error(title);
  return t.id;
};

let seq = 0;
const device = () => ({ deviceId: 'iphone', seq: seq++ });
const at = (hhmm: string) => new Date(`2026-10-10T${hhmm}:00+02:00`);

describe('чек-лист заданий 10.10', () => {
  const events = [
    makeEvent(GAME, id('Письмо себе'), toggleBody(false, '13:10'), device(), at('13:10')),
    makeEvent(GAME, id('Фото: киоска'), toggleBody(false, '13:40'), device(), at('13:40')),
    makeEvent(GAME, id('Фото: магазина'), toggleBody(false, '14:00'), device(), at('14:00')),
    makeEvent(GAME, id('Фото: магазина'), toggleBody(true, '14:01'), device(), at('14:01')),
    makeEvent(
      GAME,
      id('Фото: киоска'),
      { type: 'answer_changed', answer: 'фото у Иры' },
      device(),
      at('13:41'),
    ),
  ];
  const rows = taskRows(tasks, projectState(events, GAME));

  it('события телефона валидны по схеме Event', () => {
    for (const e of events) expect(schemaErrors(Event, e)).toEqual([]);
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('итог: баллы «7–9» — по нижней границе', () => {
    const s = summarize(rows);
    expect(s).toEqual({ total: 10, done: 2, donePoints: 12, left: 8, leftPoints: 44 });
    expect(summaryText(s)).toBe('сделано 2 из 10 · 12 б, осталось 8 · 44 б');
    expect(summaryText(summarize([]))).toBe('заданий нет');
    expect(summaryText(summarize(rows.map((r) => ({ ...r, done: true }))))).toBe(
      'сделано 10 из 10 · 56 б, всё сделано',
    );
  });

  it('строка: время «сделано», заметка; отменённое — не сделано, без времени', () => {
    const kiosk = rows.find((r) => r.task.id === id('Фото: киоска'));
    expect(kiosk).toMatchObject({ done: true, doneAt: '13:40', note: 'фото у Иры' });
    const shop = rows.find((r) => r.task.id === id('Фото: магазина'));
    expect(shop).toMatchObject({ done: false, note: '' });
    expect(shop?.doneAt).toBeUndefined();
  });

  it('фильтр «не сделано» и подпись баллов', () => {
    expect(visibleRows(rows, true)).toHaveLength(8);
    expect(visibleRows(rows, false)).toHaveLength(10);
    const letter = rows.find((r) => r.task.title === 'Письмо себе');
    expect(letter && pointsLabel(letter.task)).toBe('7–9 б');
    expect(rows[2] && pointsLabel(rows[2].task)).toBe('5 б');
  });

  it('напоминание: в день игры за 60 мин до дедлайна — все «сдать на финише», и сделанные', () => {
    const game = { date: GAME, deadline: '19:30' };
    expect(finishReminder(rows, game, { date: GAME, hhmm: '18:29' })).toBeNull();
    const r = finishReminder(rows, game, { date: GAME, hhmm: '18:30' });
    expect(r?.minutesLeft).toBe(60);
    expect(r?.rows.map((x) => [x.task.title, x.done])).toEqual([
      ['В мире животных', false],
      ['Письмо себе', true],
    ]);
    expect(finishReminder(rows, game, { date: GAME, hhmm: '19:45' })?.minutesLeft).toBe(-15);
    expect(finishReminder(rows, game, { date: '2026-10-11', hhmm: '19:00' })).toBeNull();
    const noFinish = rows.filter((x) => !x.task.atFinish);
    expect(finishReminder(noFinish, game, { date: GAME, hhmm: '19:00' })).toBeNull();
  });
});
