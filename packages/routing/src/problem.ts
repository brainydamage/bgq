import {
  FINISH_ID,
  type Game,
  type Kp,
  type Params,
  type PointsFile,
  type Problem,
  type ProblemNode,
  START_ID,
} from '@bgq/core';
import type { MatrixFile } from './matrix.ts';

/** Смещение часового пояса на дату игры: «+02:00» (летнее время в Сербии), «+01:00» (зимнее). */
export function tzOffset(date: string, time: string, tz: string): string {
  const probe = new Date(`${date}T${time}:00Z`);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-]\d{2}:\d{2})?/.exec(part ?? '');
  return m?.[1] ?? '+00:00';
}

/** «ЧЧ:ММ» в секундах от «ЧЧ:ММ» старта (может быть < 0). */
export function secondsFrom(start: string, hhmm: string): number {
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return (toMin(hhmm) - toMin(start)) * 60;
}

export function serviceSeconds(kp: Pick<Kp, 'answerKind' | 'serviceMin'>, params: Params): number {
  const min = kp.serviceMin ?? params.serviceMin[kp.answerKind] ?? params.serviceMin.default;
  return Math.round(min * 60);
}

export class ProblemError extends Error {}

/**
 * С такой уверенностью КП идёт в полную цену. Уверенность — точность координат
 * (кружок на карте 0,8–0,9 = «±30–50 м»), а не шанс не найти КП: срезать цену всем на 20%
 * нельзя — штраф за опоздание в настоящих баллах, и солвер недооценил бы КП.
 */
export const FULL_PRIZE_CONFIDENCE = 0.8;

/** Ценность КП: баллы × min(1, уверенность / 0,8) — «только улица» (0,2) стоит четверть. */
export function prizeOf(points: number, confidence: number): number {
  const factor = Math.min(1, confidence / FULL_PRIZE_CONFIDENCE);
  return Math.round(points * factor * 100) / 100;
}

/** Выход на маршрут «ЧЧ:ММ»: после пролога (start.depart), иначе — время старта. */
export function departTime(game: Pick<Game, 'start'>): string {
  return game.start.depart ?? game.start.time;
}

/**
 * Problem для солвера: узлы (старт, финиш, доступные КП), матрица времени пешком
 * (расстояние ÷ скорость из params), дедлайн и окна — в секундах от выхода на маршрут
 * (после пролога; t0 = выход).
 * Ценность КП — prizeOf (баллы, уменьшенные только при неточных координатах).
 */
export function buildProblem(o: {
  game: Game;
  points: PointsFile;
  matrix: MatrixFile;
  params: Params;
}): Problem {
  const { game, points, matrix, params } = o;
  if (matrix.pointsCreatedAt !== points.createdAt) {
    throw new ProblemError(
      'matrix.json посчитана для другой версии points.json — запустите ./bgq matrix',
    );
  }
  if (!points.start || !points.finish) {
    throw new ProblemError('в points.json нет старта или финиша — ./bgq map, затем ./bgq table');
  }
  const index = new Map(matrix.ids.map((id, i) => [id, i]));
  const kps = points.kps.filter((k) => k.eligible && k.loc);
  const missing = [START_ID, FINISH_ID, ...kps.map((k) => k.id)].filter((id) => !index.has(id));
  if (missing.length) {
    throw new ProblemError(
      `в matrix.json нет точек ${missing.join(', ')} — запустите ./bgq matrix`,
    );
  }

  const start = departTime(game);
  if (secondsFrom(game.start.time, start) < 0) {
    throw new ProblemError(`выход ${start} раньше старта ${game.start.time} — проверьте game.json`);
  }
  const clampS = (s: number) => Math.max(0, s);
  const nodes: ProblemNode[] = [
    {
      kpId: null,
      role: 'start',
      lat: points.start.lat,
      lon: points.start.lon,
      points: 0,
      prize: 0,
      serviceS: 0,
    },
    {
      kpId: null,
      role: 'finish',
      lat: points.finish.lat,
      lon: points.finish.lon,
      points: 0,
      prize: 0,
      serviceS: 0,
    },
    ...kps.map((k): ProblemNode => {
      const loc = k.loc as NonNullable<Kp['loc']>;
      return {
        kpId: k.id,
        role: 'kp',
        lat: loc.lat,
        lon: loc.lon,
        points: k.points,
        prize: prizeOf(k.points, loc.confidence),
        serviceS: serviceSeconds(k, params),
        ...(k.window && {
          window: [
            clampS(secondsFrom(start, k.window.from)),
            clampS(secondsFrom(start, k.window.to)),
          ] as [number, number],
        }),
      };
    }),
  ];

  const order = [START_ID, FINISH_ID, ...kps.map((k) => k.id)].map((id) => index.get(id) ?? 0);
  const mps = params.speedKmh / 3.6;
  const durationS = order.map((i) =>
    order.map((j) => Math.round((matrix.distanceM[i]?.[j] ?? 0) / mps)),
  );

  return {
    v: 1,
    gameId: game.id,
    t0: `${game.date}T${start}:00${tzOffset(game.date, start, game.tz)}`,
    nodes,
    matrix: { source: matrix.source, durationS },
    start: 0,
    finish: 1,
    deadlineS: clampS(secondsFrom(start, game.finish.deadline)),
    softLateMaxS: game.finish.graceMin * 60,
    latePenaltyPerMin: game.finish.penaltyPerMin,
    ...(params.restMin > 0 && { rest: [{ durationS: Math.round(params.restMin * 60) }] }),
    speedKmh: params.speedKmh,
  };
}
