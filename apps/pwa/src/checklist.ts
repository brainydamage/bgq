// Чек-лист заданий без места: чистая логика (тестируется в Node).
import type { KpState, SheetTask } from '@bgq/core';

/** За сколько минут до дедлайна напоминать о «сдать на финише». */
export const FINISH_REMINDER_MIN = 60;

export interface TaskRow {
  task: SheetTask;
  done: boolean;
  /** Время «сделано» «ЧЧ:ММ». */
  doneAt?: string;
  note: string;
}

export interface Summary {
  total: number;
  done: number;
  donePoints: number;
  left: number;
  leftPoints: number;
}

/** Задания + состояние из событий → строки чек-листа (порядок — как на листке). */
export function taskRows(tasks: readonly SheetTask[], state: Map<string, KpState>): TaskRow[] {
  return tasks.map((task) => {
    const s = state.get(task.id);
    const done = s?.status === 'taken';
    return {
      task,
      done,
      ...(done && s?.answerTime ? { doneAt: s.answerTime } : {}),
      note: s?.answer ?? '',
    };
  });
}

/** Баллы — по нижней границе («7–9 б» → 7): сколько дадут сверх, решит жюри. */
export function summarize(rows: readonly TaskRow[]): Summary {
  const s: Summary = { total: rows.length, done: 0, donePoints: 0, left: 0, leftPoints: 0 };
  for (const r of rows) {
    if (r.done) {
      s.done += 1;
      s.donePoints += r.task.points;
    } else {
      s.left += 1;
      s.leftPoints += r.task.points;
    }
  }
  return s;
}

/** «сделано 4 из 10 · 23 б, осталось 6 · 33 б». */
export function summaryText(s: Summary): string {
  const head = `сделано ${s.done} из ${s.total} · ${s.donePoints} б`;
  if (s.left === 0) return s.total ? `${head}, всё сделано` : 'заданий нет';
  return `${head}, осталось ${s.left} · ${s.leftPoints} б`;
}

/** «5 б» / «7–9 б». */
export function pointsLabel(task: SheetTask): string {
  return task.pointsMax && task.pointsMax > task.points
    ? `${task.points}–${task.pointsMax} б`
    : `${task.points} б`;
}

export function visibleRows(rows: readonly TaskRow[], onlyOpen: boolean): TaskRow[] {
  return onlyOpen ? rows.filter((r) => !r.done) : [...rows];
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Напоминание перед финишем: в день игры, за FINISH_REMINDER_MIN до дедлайна и позже, — все
 * задания «сдать на финише» (сделанные тоже: их ещё сдать). Не время или нечего сдавать — null.
 */
export function finishReminder(
  rows: readonly TaskRow[],
  game: { date: string; deadline: string },
  now: { date: string; hhmm: string },
  leadMin = FINISH_REMINDER_MIN,
): { minutesLeft: number; rows: TaskRow[] } | null {
  const atFinish = rows.filter((r) => r.task.atFinish);
  if (!atFinish.length || now.date !== game.date) return null;
  const minutesLeft = minutes(game.deadline) - minutes(now.hhmm);
  return minutesLeft <= leadMin ? { minutesLeft, rows: atFinish } : null;
}
