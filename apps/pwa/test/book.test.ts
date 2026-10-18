import { Event, type KpState, phoneGame, projectState, schemaErrors } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import {
  type BookRow,
  bookRows,
  bookSummaryText,
  copyBody,
  isCopied,
  summarizeBook,
  visibleBook,
} from '../src/book.ts';
import { type Body, makeEvent } from '../src/events.ts';
import { game, plan, sheetTasks, table } from './fixture.ts';

const tasks = sheetTasks();
const phone = {
  ...phoneGame(game, null, '2026-10-10T12:20:00.000Z', { points: table(), plan }),
  tasks,
};
const task = (title: string) => {
  const t = tasks.find((x) => x.title.startsWith(title));
  if (!t) throw new Error(title);
  return t.id;
};

let seq = 0;
const events: Event[] = [];
/** Событие в момент «ЧЧ:ММ» дня игры (+02:00). */
function ev(kpId: string, body: Body, at: string): Event {
  seq += 1;
  const e = makeEvent(
    game.id,
    kpId,
    body,
    { deviceId: 'iphone', seq },
    new Date(`2026-10-10T${at}:00+02:00`),
  );
  events.push(e);
  return e;
}
const book = () => bookRows(phone, projectState(events, game.id));
const row = (id: string): BookRow => {
  const b = book();
  const r = [...b.kps, ...b.tasks].find((x) => x.id === id);
  if (!r) throw new Error(`${id} нет в книжке`);
  return r;
};
/** Тап по галочке строки. */
const tap = (id: string, at: string) => ev(id, copyBody(row(id)), at);

describe('книжка ответов 10.10', () => {
  it('пусто, пока ничего не взято', () => {
    const b = bookRows(phone, new Map());
    expect(b).toEqual({ kps: [], tasks: [] });
    expect(bookSummaryText(summarizeBook(b))).toEqual(['в книжку пока нечего']);
  });

  it('взятые КП — по номеру, как в книжке (25 < 25А < 64); задания — отдельно', () => {
    ev('64', { type: 'taken', answerTime: '12:41' }, '12:41');
    ev('64', { type: 'answer_changed', answer: 'Тесла' }, '12:42');
    ev('25А', { type: 'taken', answerTime: '13:05' }, '13:05');
    ev('25', { type: 'taken', answerTime: '13:20' }, '13:20');
    ev('25', { type: 'answer_changed', answer: '1904' }, '13:21');
    ev(task('Письмо себе'), { type: 'taken', answerTime: '13:30' }, '13:30');
    ev(task('Письмо себе'), { type: 'answer_changed', answer: 'в рюкзаке' }, '13:31');
    const b = book();
    expect(b.kps.map((r) => r.id)).toEqual(['25', '25А', '64']);
    expect(b.tasks.map((r) => r.id)).toEqual([task('Письмо себе')]);
    expect(row('64')).toMatchObject({ answer: 'Тесла', answerTime: '12:41', flags: [] });
    // Заметка задания в книжку не идёт — и «нет ответа» у задания не бывает.
    expect(row(task('Письмо себе'))).toMatchObject({ answer: '', answerTime: '13:30', flags: [] });
  });

  it('подсветка: взят без ответа; ответ есть, а «взято» не нажали — 0 б', () => {
    expect(row('25А').flags).toEqual(['no_answer']);
    ev('71', { type: 'answer_changed', answer: 'лев' }, '13:40');
    expect(book().kps.map((r) => r.id)).toContain('71');
    expect(row('71')).toMatchObject({ status: 'open', flags: ['not_taken'] });
    expect(row('71').answerTime).toBeUndefined();
  });

  it('взят без времени — 0 б (событие со второго телефона, старые данные)', () => {
    const s = new Map<string, KpState>([
      ['64', { kpId: '64', status: 'taken', answer: 'Тесла', solved: false, updatedAt: '' }],
    ]);
    expect(bookRows(phone, s).kps[0]?.flags).toEqual(['no_time']);
  });

  it('ответ не текстом (фото, судья…) — «нет ответа» не подсвечивается', () => {
    const kp = phone.kps?.find((k) => k.answerKind !== 'text');
    if (!kp) throw new Error('в 10.10 нет КП с ответом не текстом');
    const s = new Map<string, KpState>([
      [kp.id, { kpId: kp.id, status: 'taken', answerTime: '14:00', solved: false, updatedAt: '' }],
    ]);
    expect(bookRows(phone, s).kps[0]).toMatchObject({ id: kp.id, flags: [] });
  });

  it('галочка «переписано» — copied со снимком; события проходят схему', () => {
    const e = tap('64', '14:00');
    expect(e).toMatchObject({ type: 'copied', answer: 'Тесла', answerTime: '12:41' });
    expect(schemaErrors(Event, e)).toEqual([]);
    tap(task('Письмо себе'), '14:00');
    expect(events.at(-1)).toMatchObject({ type: 'copied', answerTime: '13:30' });
    expect(events.at(-1)).not.toHaveProperty('answer');
    expect(isCopied(row('64'))).toBe(true);
    expect(summarizeBook(book())).toMatchObject({ total: 5, copied: 2, left: 3, recopy: 0 });
  });

  it('ответ или время поменялись после галочки — «переписать заново»; тап — новый снимок', () => {
    ev('64', { type: 'answer_changed', answer: 'Никола Тесла' }, '14:10');
    expect(row('64')).toMatchObject({ copied: true, flags: ['recopy'] });
    expect(isCopied(row('64'))).toBe(false);
    // Заметка задания — не повод переписывать, время — повод.
    ev(task('Письмо себе'), { type: 'answer_changed', answer: 'отдали Ире' }, '14:11');
    expect(row(task('Письмо себе')).flags).toEqual([]);
    ev(task('Письмо себе'), { type: 'answer_changed', answerTime: '13:25' }, '14:12');
    expect(row(task('Письмо себе')).flags).toEqual(['recopy']);

    expect(bookSummaryText(summarizeBook(book()))).toEqual([
      'переписано 0 из 5, не переписано 5 (заново 2)',
      '0 б: без времени или не взято — 1 · без ответа — 1',
    ]);

    expect(tap('64', '14:20')).toMatchObject({ type: 'copied', answer: 'Никола Тесла' });
    expect(isCopied(row('64'))).toBe(true);
  });

  it('снять галочку — uncopied', () => {
    expect(tap('25', '14:30')).toMatchObject({ type: 'copied' });
    expect(tap('25', '14:31')).toMatchObject({ type: 'uncopied' });
    expect(row('25').copied).toBe(false);
  });

  it('«взято» отменили после галочки — строка остаётся: не взят, переписать', () => {
    ev('64', { type: 'reopened' }, '14:40');
    expect(row('64')).toMatchObject({ status: 'open', copied: true });
    expect(row('64').flags).toEqual(['not_taken', 'recopy']);
    // Без ответа и без галочки отменённый КП из книжки уходит.
    ev('25А', { type: 'reopened' }, '14:41');
    expect(book().kps.map((r) => r.id)).not.toContain('25А');
  });

  it('фильтр «не переписано»', () => {
    tap('25', '14:50');
    const left = visibleBook(book(), true);
    expect(left.kps.map((r) => r.id)).toEqual(['64', '71']);
    expect(left.tasks.map((r) => r.id)).toEqual([task('Письмо себе')]);
    expect(visibleBook(book(), false)).toEqual(book());
  });
});
