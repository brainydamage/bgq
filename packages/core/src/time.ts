/** Длительность игры по умолчанию: 9 ч от старта пролога до финиша (дедлайн у каждой команды свой). */
export const DEFAULT_DURATION_MIN = 540;

/** «9:44» / «09:44» → «09:44»; не время суток — null. */
export function normalizeHhmm(s: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** «ЧЧ:ММ» + минуты → «ЧЧ:ММ» (по кругу суток). */
export function addMinutes(hhmm: string, minutes: number): string {
  const total =
    (((Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Дата и время «сейчас» в часовом поясе игры (часы ноутбука могут стоять в другом). */
export function clockIn(tz: string, now: Date = new Date()): { date: string; hhmm: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
  };
}

/** «ЧЧ:ММ» местного времени: t0 (с часовым поясом игры) + s секунд. */
export function clock(t0: string, s: number): string {
  const total = Number(t0.slice(11, 13)) * 60 + Number(t0.slice(14, 16)) + Math.round(s / 60);
  const h = Math.floor(total / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
