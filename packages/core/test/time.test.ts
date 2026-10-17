import { describe, expect, it } from 'vitest';
import { addMinutes, clockIn, normalizeHhmm } from '../src/index.ts';

describe('время суток', () => {
  it('«9:44» → «09:44»; не время — null', () => {
    expect(normalizeHhmm('9:44')).toBe('09:44');
    expect(normalizeHhmm(' 10:30 ')).toBe('10:30');
    expect(normalizeHhmm('24:00')).toBeNull();
    expect(normalizeHhmm('9.44')).toBeNull();
  });

  it('старт + 9 ч = дедлайн', () => {
    expect(addMinutes('10:30', 540)).toBe('19:30');
    expect(addMinutes('09:44', 540)).toBe('18:44');
    expect(addMinutes('23:30', 60)).toBe('00:30');
  });

  it('«сейчас» — по часовому поясу игры, а не ноутбука', () => {
    const now = new Date('2026-10-10T10:47:00Z');
    expect(clockIn('Europe/Belgrade', now)).toEqual({ date: '2026-10-10', hhmm: '12:47' });
    expect(clockIn('Europe/Belgrade', new Date('2026-12-05T08:44:00Z')).hhmm).toBe('09:44');
    expect(clockIn('UTC', new Date('2026-10-10T23:30:00Z'))).toEqual({
      date: '2026-10-10',
      hhmm: '23:30',
    });
  });
});
