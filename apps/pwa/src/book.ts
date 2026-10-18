// Книжка ответов: переписывание с телефона на бумагу. Чистая логика (тестируется в Node).
// Строка книжки — номер КП, ответ, время «ЧЧ:ММ»; без времени — 0 баллов.
import type { Kp, KpState, PhoneGame, SheetTask } from '@bgq/core';
import type { Body } from './events.ts';
import { byNumber } from './route.ts';

/**
 * Что не так со строкой: not_taken — в книжке, но не взят (время пустое → 0 б); no_time — взят
 * без времени (0 б); no_answer — нет ответа; recopy — после галочки поменялись ответ или время.
 */
export type BookFlag = 'not_taken' | 'no_time' | 'no_answer' | 'recopy';

export interface BookRow {
  id: string;
  points: number;
  kp?: Kp;
  task?: SheetTask;
  status: KpState['status'];
  /** Ответ КП; у задания — пусто (заметка в книжку не идёт). */
  answer: string;
  answerTime?: string;
  /** Галочка «переписано» стоит (может быть устаревшей — см. recopy). */
  copied: boolean;
  flags: BookFlag[];
}

export interface Book {
  /** КП и загадки по номеру, как в книжке (25 < 25А < 26). */
  kps: BookRow[];
  /** Задания без номера — отдельным блоком, как на листке. */
  tasks: BookRow[];
}

/** Ответ не текстом — фото, рисунок, судья, видео: «нет ответа» не подсвечиваем. */
const textAnswer = (kp: Kp) => kp.answerKind === 'text';

function flags(r: Omit<BookRow, 'flags'>, s: KpState | undefined): BookFlag[] {
  const out: BookFlag[] = [];
  if (r.status !== 'taken') out.push('not_taken');
  else if (!r.answerTime) out.push('no_time');
  if (r.kp && textAnswer(r.kp) && !r.answer.trim()) out.push('no_answer');
  const c = s?.copied;
  if (
    c &&
    ((c.answerTime ?? '') !== (r.answerTime ?? '') || (r.kp && (c.answer ?? '') !== r.answer))
  )
    out.push('recopy');
  return out;
}

function bookRow(
  base: { id: string; points: number; kp?: Kp; task?: SheetTask },
  s: KpState | undefined,
): BookRow {
  const r = {
    ...base,
    status: s?.status ?? 'open',
    answer: base.kp ? (s?.answer ?? '') : '',
    ...(s?.status === 'taken' && s.answerTime ? { answerTime: s.answerTime } : {}),
    copied: Boolean(s?.copied),
  };
  return { ...r, flags: flags(r, s) };
}

/**
 * В книжку: взятые КП, а также невзятые с ответом (забыли «✓ Взято» или отменили) и с галочкой
 * (уже в книжке — зачеркнуть или взять заново); задания — сделанные или с галочкой.
 */
export function bookRows(game: PhoneGame, state: Map<string, KpState>): Book {
  const kps = [...(game.kps ?? [])]
    .sort(byNumber)
    .filter((kp) => {
      const s = state.get(kp.id);
      return s && (s.status === 'taken' || Boolean(s.answer?.trim()) || Boolean(s.copied));
    })
    .map((kp) => bookRow({ id: kp.id, points: kp.points, kp }, state.get(kp.id)));
  const tasks = game.tasks
    .filter((task) => {
      const s = state.get(task.id);
      return s && (s.status === 'taken' || Boolean(s.copied));
    })
    .map((task) => bookRow({ id: task.id, points: task.points, task }, state.get(task.id)));
  return { kps, tasks };
}

/** Переписано и не устарело. */
export const isCopied = (r: BookRow) => r.copied && !r.flags.includes('recopy');

export interface BookSummary {
  total: number;
  copied: number;
  left: number;
  /** Из «не переписано» — с устаревшей галочкой. */
  recopy: number;
  /** 0 баллов: взяты без времени или не взяты. */
  zero: number;
  noAnswer: number;
}

export function summarizeBook(book: Book): BookSummary {
  const rows = [...book.kps, ...book.tasks];
  const has = (f: BookFlag) => rows.filter((r) => r.flags.includes(f)).length;
  const copied = rows.filter(isCopied).length;
  return {
    total: rows.length,
    copied,
    left: rows.length - copied,
    recopy: has('recopy'),
    zero: rows.filter((r) => r.flags.includes('not_taken') || r.flags.includes('no_time')).length,
    noAnswer: has('no_answer'),
  };
}

/** «переписано 5 из 8, не переписано 3 (заново 1)» + строка о проблемах, если есть. */
export function bookSummaryText(s: BookSummary): string[] {
  if (!s.total) return ['в книжку пока нечего'];
  const head =
    `переписано ${s.copied} из ${s.total}` +
    (s.left ? `, не переписано ${s.left}` : ', всё переписано') +
    (s.recopy ? ` (заново ${s.recopy})` : '');
  const issues = [
    s.zero ? `0 б: без времени или не взято — ${s.zero}` : '',
    s.noAnswer ? `без ответа — ${s.noAnswer}` : '',
  ].filter(Boolean);
  return issues.length ? [head, issues.join(' · ')] : [head];
}

/** Подписи флагов в строке. */
export const FLAG_TEXT: Record<BookFlag, string> = {
  not_taken: 'не взят — 0 б',
  no_time: 'нет времени — 0 б',
  no_answer: 'нет ответа',
  recopy: '↻ переписать заново',
};

/** Тап по галочке: переписано (и не устарело) → uncopied, иначе → copied со снимком. */
export function copyBody(r: BookRow): Body {
  if (isCopied(r)) return { type: 'uncopied' };
  return {
    type: 'copied',
    ...(r.kp && r.answer ? { answer: r.answer } : {}),
    ...(r.answerTime ? { answerTime: r.answerTime } : {}),
  };
}

export function visibleBook(book: Book, onlyLeft: boolean): Book {
  if (!onlyLeft) return book;
  const left = (rows: BookRow[]) => rows.filter((r) => !isCopied(r));
  return { kps: left(book.kps), tasks: left(book.tasks) };
}
