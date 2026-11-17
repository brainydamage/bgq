// История ответа КП: события неизменяемы, поэтому прошлые варианты ответа никуда не деваются —
// стёртый или переписанный по ошибке ответ можно вернуть из карточки.
import { clockIn, type Event, orderEvents } from '@bgq/core';

export interface AnswerVersion {
  answer: string;
  /** Когда записан, «ЧЧ:ММ» по часовому поясу игры. */
  at: string;
}

/**
 * Прошлые варианты ответа КП, новые сверху. Без текущего, пустых и «недописанных»: вариант, который
 * продолжен позже (автосохранение во время набора: «Тес» → «Тесла»), не показывается — он целиком
 * есть в следующем. Одинаковый текст — один раз, по последнему времени.
 */
export function answerHistory(
  events: readonly Event[],
  gameId: string,
  kpId: string,
  current: string | undefined,
  tz: string,
): AnswerVersion[] {
  const texts: { answer: string; ts: string }[] = [];
  for (const e of orderEvents(events)) {
    if (e.gameId !== gameId || e.kpId !== kpId) continue;
    if ((e.type === 'answer_changed' || e.type === 'solved') && e.answer !== undefined)
      texts.push({ answer: e.answer, ts: e.clientTs });
  }
  const now = (current ?? '').trim();
  const out: AnswerVersion[] = [];
  const seen = new Set<string>([now]);
  for (let i = texts.length - 1; i >= 0; i--) {
    const v = texts[i] as { answer: string; ts: string };
    const text = v.answer.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const later = [now, ...texts.slice(i + 1).map((t) => t.answer.trim())];
    if (later.some((t) => t.startsWith(text))) continue;
    out.push({ answer: v.answer, at: clockIn(tz, new Date(v.ts)).hhmm });
  }
  return out;
}
