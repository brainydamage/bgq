// События телефона: «сделано»/«взято» = taken, отмена = reopened, заметка/ответ и правка времени =
// answer_changed, «пропустить» (штурман) = skipped, галочка книжки = copied (снимок) / uncopied,
// пауза (обед) = pause_started / pause_ended с kpId «pause», пересчёт маршрута = plan_accepted
// с kpId «plan».
import type { Event, Plan } from '@bgq/core';

export type Body =
  | { type: 'taken'; answerTime: string }
  | { type: 'reopened' }
  | { type: 'skipped' }
  | { type: 'answer_changed'; answer?: string; answerTime?: string }
  | { type: 'copied'; answer?: string; answerTime?: string }
  | { type: 'uncopied' }
  | { type: 'pause_started' }
  | { type: 'pause_ended' }
  | { type: 'plan_accepted'; plan: Plan; pauseMin: number };

/** kpId событий паузы. */
export const PAUSE_ID = 'pause';
/** kpId события «принят пересчитанный план». */
export const PLAN_ID = 'plan';

/** UUID v4; crypto.randomUUID нет вне защищённого контекста (http по LAN). */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function makeEvent(
  gameId: string,
  kpId: string,
  body: Body,
  device: { deviceId: string; seq: number },
  now: Date = new Date(),
): Event {
  return {
    v: 1,
    id: uuid(),
    gameId,
    kpId,
    deviceId: device.deviceId,
    seq: device.seq,
    clientTs: now.toISOString(),
    ...body,
  } as Event;
}

/** Тап по галочке: не сделано → taken со временем «сейчас», сделано → reopened. */
export function toggleBody(done: boolean, nowHhmm: string): Body {
  return done ? { type: 'reopened' } : { type: 'taken', answerTime: nowHhmm };
}
