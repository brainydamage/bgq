import type { Loc } from './schema/common.ts';
import type { Event } from './schema/event.ts';
import type { Plan } from './schema/plan.ts';

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
  /** Переписано в книжку: что переписали (сравнить с текущим — не переписать ли заново). */
  copied?: { answer?: string; answerTime?: string };
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
    if (e.type === 'pause_started' || e.type === 'pause_ended' || e.type === 'plan_accepted')
      continue;
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
      case 'copied':
        s.copied = {
          ...(e.answer !== undefined ? { answer: e.answer } : {}),
          ...(e.answerTime !== undefined ? { answerTime: e.answerTime } : {}),
        };
        break;
      case 'uncopied':
        delete s.copied;
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

/** Паузы игры: закрытые [начало, конец] и начатая, мс (Date). */
export interface Pauses {
  closed: [startMs: number, endMs: number][];
  /** Начало идущей паузы; нет — сейчас не на паузе. */
  openSince?: number;
}

/** События → паузы. «Закончили» без «начали» и второе «начали» подряд не считаются. */
export function projectPauses(events: readonly Event[], gameId: string): Pauses {
  const closed: Pauses['closed'] = [];
  let openSince: number | undefined;
  for (const e of orderEvents(events)) {
    if (e.gameId !== gameId) continue;
    const at = Date.parse(e.clientTs);
    if (e.type === 'pause_started' && openSince === undefined) openSince = at;
    else if (e.type === 'pause_ended' && openSince !== undefined) {
      closed.push([openSince, Math.max(openSince, at)]);
      openSince = undefined;
    }
  }
  return openSince === undefined ? { closed } : { closed, openSince };
}

/** Сколько мс паузы пришлось на время до `untilMs` (идущая пауза — по `untilMs`). */
export function pausedBefore(p: Pauses, untilMs: number): number {
  let ms = 0;
  for (const [a, b] of p.closed) ms += Math.max(0, Math.min(b, untilMs) - a);
  if (p.openSince !== undefined) ms += Math.max(0, untilMs - p.openSince);
  return ms;
}

/** Принятый на телефоне план: сам план, когда приняли (мс) и сколько паузы он оставил впереди. */
export interface AcceptedPlan {
  plan: Plan;
  atMs: number;
  pauseMin: number;
}

/** Последний принятый план игры (по порядку событий); нет — undefined. */
export function projectPlan(events: readonly Event[], gameId: string): AcceptedPlan | undefined {
  let last: AcceptedPlan | undefined;
  for (const e of orderEvents(events)) {
    if (e.gameId === gameId && e.type === 'plan_accepted')
      last = { plan: e.plan, atMs: Date.parse(e.clientTs), pauseMin: e.pauseMin };
  }
  return last;
}
