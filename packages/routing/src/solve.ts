import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { addMinutes, clockIn, type Kp, type Plan, type Problem } from '@bgq/core';
import { RoutingError } from './osrm.ts';

/** Python-солвер (OR-Tools, uv-проект). */
export const SOLVER_DIR = resolve(import.meta.dirname, '../../../solver');

/** Хэш problem.json — sha256 байтов файла; так же считает солвер (plan.problemHash). */
export function problemHash(raw: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

export function uvAvailable(): boolean {
  return spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0;
}

/** problem.json → plan.json через `uv run bgq-solve`; ошибка солвера — RoutingError с его текстом. */
export function runSolver(o: {
  problemPath: string;
  planPath: string;
  /** Лимит поиска каждой стратегии портфеля, с. */
  timeS?: number;
  /** Выход на трассу «ЧЧ:ММ», если позже старта. */
  depart?: string;
}): void {
  if (!uvAvailable()) throw new RoutingError('нет uv — установите: brew install uv');
  const args = ['run', '--quiet', '--project', SOLVER_DIR, 'bgq-solve', o.problemPath];
  args.push('-o', o.planPath, '--time', String(o.timeS ?? 10));
  if (o.depart) args.push('--depart', o.depart);
  const r = spawnSync('uv', args, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] });
  if (r.status !== 0) {
    // absl пишет в stderr служебные строки — показываем только суть.
    const text = (r.stderr ?? '')
      .split('\n')
      .filter((l) => l.trim() && !/^(WARNING: All log messages|E\d{4} )/.test(l))
      .join('\n');
    throw new RoutingError(`солвер завершился с кодом ${r.status}: ${text || r.error?.message}`);
  }
}

/** На сборы после расчёта: выход в день игры — «сейчас» + столько минут. */
export const DEPART_LAG_MIN = 2;

/**
 * Выход по умолчанию: в день игры, если t0 (получили комплект) уже прошло, — «сейчас + 2 мин»
 * по часам игры; иначе undefined — от t0 задачи (разбор прошлых игр, расчёт заранее).
 */
export function defaultDepart(t0: string, tz: string, now: Date = new Date()): string | undefined {
  const { date, hhmm } = clockIn(tz, now);
  if (date !== t0.slice(0, 10) || hhmm <= t0.slice(11, 16)) return undefined;
  return addMinutes(hhmm, DEPART_LAG_MIN);
}

/** «ЧЧ:ММ» местного времени: t0 (с часовым поясом игры) + s секунд. */
export function clock(t0: string, s: number): string {
  const total = Number(t0.slice(11, 13)) * 60 + Number(t0.slice(14, 16)) + Math.round(s / 60);
  const h = Math.floor(total / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const km = (m: number) => `${(m / 1000).toFixed(1).replace('.', ',')} км`;
const num = (x: number) => String(Math.round(x * 10) / 10).replace('.', ',');

/**
 * Сводка плана для терминала: итог, порядок, что выброшено. kps (points.json) — чтобы
 * отметить загадки 🧩 и перечислить нерешённые.
 */
export function planSummary(plan: Plan, problem: Problem, kps: Kp[] = []): string[] {
  const riddles = new Set(kps.filter((k) => k.kind === 'riddle').map((k) => k.id));
  const unsolved = kps
    .filter((k) => k.kind === 'riddle' && k.eligible && !k.loc)
    .sort((a, b) => b.points - a.points || a.id.localeCompare(b.id, 'ru', { numeric: true }));
  const mark = (id: string) => (riddles.has(id) ? `🧩${id}` : id);
  const points = new Map(problem.nodes.map((n) => [n.kpId, n.points]));
  const all = problem.nodes.reduce((s, n) => s + n.points, 0);
  const late = -plan.slackMin;
  const finish =
    late > 0
      ? `опоздание ${num(late)} мин (−${Math.ceil(late) * problem.latePenaltyPerMin} б)`
      : `запас ${num(plan.slackMin)} мин`;
  const windows = new Set(problem.nodes.filter((n) => n.window).map((n) => n.kpId));
  const dropped = [...plan.dropped].sort(
    (a, b) =>
      (points.get(b) ?? 0) - (points.get(a) ?? 0) || a.localeCompare(b, 'ru', { numeric: true }),
  );
  const droppedPoints = dropped.reduce((s, id) => s + (points.get(id) ?? 0), 0);
  const first = plan.stops[0];
  const lines = [
    `План: ${plan.stops.length} КП · ${num(plan.totalPoints)} б из ${all} · ${km(plan.distanceM)} · финиш ${clock(plan.t0, plan.finishS)}, ${finish}`,
  ];
  if (plan.expectedPrize !== plan.totalPoints) {
    lines.push(`  ожидаемо ${num(plan.expectedPrize)} б (с поправкой на неточные координаты)`);
  }
  if (first) {
    lines.push(
      `Порядок (первый КП в ${clock(plan.t0, first.arriveS)}): ${plan.stops.map((s) => (windows.has(s.kpId) ? `${mark(s.kpId)}⏰${clock(plan.t0, s.arriveS)}` : mark(s.kpId))).join(' → ')}`,
    );
  }
  if (dropped.length) {
    lines.push(
      `Не в плане ${dropped.length} КП, ${droppedPoints} б: ${dropped.map((id) => `${mark(id)} (${points.get(id) ?? 0})`).join(', ')}`,
    );
  }
  if (unsolved.length) {
    lines.push(
      `🧩 Не решены ${unsolved.length}, ${unsolved.reduce((s, k) => s + k.points, 0)} б: ${unsolved.map((k) => `${k.id} (${k.points})`).join(', ')} — решили → ./bgq route`,
    );
  }
  lines.push(`Поиск ${num(plan.solverMs / 1000)} с (${plan.solver})`);
  return lines;
}
