import { type Event, projectState } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import { answerHistory } from '../src/answers.ts';
import { type Body, makeEvent } from '../src/events.ts';

const GAME = '2026-10-10';
const TZ = 'Europe/Belgrade';

function run(steps: [kpId: string, body: Body, at: string, device?: string][]): Event[] {
  return steps.map(([kpId, body, at, device], i) =>
    makeEvent(
      GAME,
      kpId,
      body,
      { deviceId: device ?? 'iphone', seq: i },
      new Date(`${GAME}T${at}:00+02:00`),
    ),
  );
}
const answer = (text: string): Body => ({ type: 'answer_changed', answer: text });
const history = (events: Event[], kpId = '64') =>
  answerHistory(events, GAME, kpId, projectState(events, GAME).get(kpId)?.answer, TZ);

describe('история ответа', () => {
  it('стёрли ответ — прошлый вариант виден со временем', () => {
    const events = run([
      ['64', answer('Тесла Никола'), '15:07'],
      ['64', answer(''), '15:20'],
    ]);
    expect(history(events)).toEqual([{ answer: 'Тесла Никола', at: '15:07' }]);
  });

  it('недописанное при наборе не показывается: «Тес» → «Тесла» → «Тесла Никола»', () => {
    const events = run([
      ['64', answer('Тес'), '15:07'],
      ['64', answer('Тесла'), '15:07'],
      ['64', answer('Тесла Никола'), '15:08'],
    ]);
    expect(history(events)).toEqual([]);
  });

  it('переписали на другой ответ — оба прошлых варианта, новые сверху, без повторов', () => {
    const events = run([
      ['64', answer('Тесла'), '15:07'],
      ['64', answer('Пупин'), '15:30', 'android'],
      ['64', answer('Тесла'), '15:40'],
      ['64', answer('Михайло Пупин'), '16:00'],
      ['25', answer('чужой КП'), '16:05'],
    ]);
    expect(history(events)).toEqual([
      { answer: 'Тесла', at: '15:40' },
      { answer: 'Пупин', at: '15:30' },
    ]);
  });

  it('текущий ответ и пустые в историю не попадают; отгадка загадки — тоже вариант', () => {
    const events = run([
      ['62', { type: 'solved', answer: 'tekstil' } as unknown as Body, '14:00'],
      ['62', answer('  '), '14:10'],
      ['62', answer('textil'), '14:20'],
    ]);
    expect(history(events, '62')).toEqual([{ answer: 'tekstil', at: '14:00' }]);
    expect(history(run([['62', answer('textil'), '14:20']]), '62')).toEqual([]);
  });
});
