import type { Loc } from './schema/common.ts';
import type { Event } from './schema/event.ts';

/** Состояние КП (или задания без места), вычисленное из событий. В `Kp` статуса нет. */
export interface KpState {
  kpId: string;
  /** open — не взят (или «взято» отменили), taken — взят, skipped — пропущен. */
  status: 'open' | 'taken' | 'skipped';
  /** Время взятия «ЧЧ:ММ» (в книжку); при отмене стирается. */
  answerTime?: string;
  /** Ответ на КП; у задания без места — заметка («фото у Иры»). */
  answer?: string;
  /** Загадка разгадана (≠ взята). */
  solved: boolean;
  loc?: Loc;
  /** clientTs последнего события. */
  updatedAt: string;
}

/** Порядок событий: (clientTs, deviceId, seq); часы двух телефонов могут расходиться. */
export function compareEvents(a: Event, b: Event): number {
  return (
    Date.parse(a.clientTs) - Date.parse(b.clientTs) ||
    (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0) ||
    a.seq - b.seq
  );
}

/** Без дублей по id (двойной тап, повторный sync) и по порядку compareEvents. */
export function orderEvents(events: readonly Event[]): Event[] {
  const byId = new Map<string, Event>();
  for (const e of events) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort(compareEvents);
}

/** События → состояние по kpId; учитываются только события этой игры. */
export function projectState(events: readonly Event[], gameId: string): Map<string, KpState> {
  const state = new Map<string, KpState>();
  for (const e of orderEvents(events)) {
    if (e.gameId !== gameId) continue;
    const s = state.get(e.kpId) ?? { kpId: e.kpId, status: 'open', solved: false, updatedAt: '' };
    s.updatedAt = e.clientTs;
    switch (e.type) {
      case 'taken':
        s.status = 'taken';
        s.answerTime = e.answerTime;
        break;
      case 'skipped':
        s.status = 'skipped';
        break;
      case 'reopened':
        s.status = 'open';
        delete s.answerTime;
        break;
      case 'answer_changed':
        if (e.answer !== undefined) s.answer = e.answer;
        if (e.answerTime !== undefined) s.answerTime = e.answerTime;
        break;
      case 'solved':
        s.solved = true;
        if (e.answer !== undefined) s.answer = e.answer;
        if (e.loc !== undefined) s.loc = e.loc;
        break;
    }
    state.set(e.kpId, s);
  }
  return state;
}
