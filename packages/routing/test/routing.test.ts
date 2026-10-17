import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PARAMS,
  type Game,
  type MapFileResults,
  type PointsFile,
  Problem,
  schemaErrors,
} from '@bgq/core';
import { buildIndex, type Gazetteer, geocodeAll } from '@bgq/geo';
import { ingest } from '@bgq/ingest';
import { buildTable } from '@bgq/table';
import { describe, expect, it } from 'vitest';
import {
  buildProblem,
  dockerAvailable,
  graphReady,
  haversineTable,
  matrixFile,
  osrmRoute,
  osrmTable,
  ProblemError,
  prizeOf,
  RoutingError,
  routePoints,
  secondsFrom,
  serviceSeconds,
  tzOffset,
  withOsrm,
} from '../src/index.ts';

const fx = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../../fixtures/2026-10-10', name), 'utf8');
const game = JSON.parse(fx('game.json')) as Game;

/** Таблица 10.10 + старт и финиш, как если бы их отметили на карте. */
function points10(): PointsFile {
  const { kps } = ingest({ md: fx('notion-export.md'), game, overrides: fx('overrides.yaml') });
  const geo = geocodeAll(kps, buildIndex(JSON.parse(fx('osm-gazetteer.json')) as Gazetteer));
  const map = JSON.parse(fx('map.json')) as MapFileResults;
  const loc = (lat: number, lon: number) => ({ lat, lon, source: 'map' as const, confidence: 0.8 });
  map.results.push(
    { id: 'start', loc: loc(44.977626, 19.601005), color: null, photo: 'IMG_7081.jpg' },
    { id: 'finish', loc: loc(44.9705, 19.6093), color: null, photo: 'IMG_7081.jpg' },
  );
  return buildTable({
    game,
    kps,
    kpsAt: '2026-10-16T21:12:00.000Z',
    geo: { osmBase: '2026-10-15T20:21:00Z', results: geo },
    map,
    now: new Date('2026-10-16T23:00:00Z'),
  });
}

describe('ценность КП', () => {
  it('уверенность ≥ 0,8 — полная цена, ниже — пропорционально', () => {
    expect(prizeOf(7, 0.8)).toBe(7);
    expect(prizeOf(7, 0.95)).toBe(7);
    expect(prizeOf(8, 0.5)).toBe(5);
    expect(prizeOf(8, 0.2)).toBe(2);
  });
});

describe('время', () => {
  it('часовой пояс игры: летнее и зимнее время Белграда', () => {
    expect(tzOffset('2026-10-10', '10:30', 'Europe/Belgrade')).toBe('+02:00');
    expect(tzOffset('2026-12-05', '10:30', 'Europe/Belgrade')).toBe('+01:00');
  });

  it('секунды от старта', () => {
    expect(secondsFrom('10:30', '14:00')).toBe(12_600);
    expect(secondsFrom('10:30', '19:30')).toBe(32_400);
    expect(secondsFrom('10:30', '09:00')).toBe(-5_400);
  });

  it('время на точке: по типу ответа, своё у КП важнее', () => {
    expect(serviceSeconds({ answerKind: 'text' }, DEFAULT_PARAMS)).toBe(300);
    expect(serviceSeconds({ answerKind: 'judge' }, DEFAULT_PARAMS)).toBe(900);
    expect(serviceSeconds({ answerKind: 'video' }, DEFAULT_PARAMS)).toBe(600);
    expect(serviceSeconds({ answerKind: 'judge', serviceMin: 3 }, DEFAULT_PARAMS)).toBe(180);
  });
});

describe('матрица', () => {
  const t = points10();
  const route = routePoints(t);

  it('точки: старт, финиш, затем 76 доступных КП по номерам', () => {
    expect(route).toHaveLength(78);
    expect(route.slice(0, 4).map((p) => p.id)).toEqual(['start', 'finish', '10', '11']);
  });

  it('без старта/финиша — понятная ошибка', () => {
    const { start: _s, ...noStart } = t;
    expect(() => routePoints(noStart as PointsFile)).toThrow(/старта или финиша/);
  });

  it('по прямой ×1,3: симметрична, на диагонали 0', () => {
    const { distanceM, snapM } = haversineTable(route.slice(0, 3));
    expect(distanceM[0]?.[0]).toBe(0);
    expect(distanceM[0]?.[1]).toBe(distanceM[1]?.[0]);
    expect(snapM).toEqual([0, 0, 0]);
  });

  it('OSRM /table: разбор ответа, недостижимые пары — ошибка', async () => {
    const reply = (body: unknown) => async () => new Response(JSON.stringify(body));
    const pts = route.slice(0, 2);
    const ok = await osrmTable(
      'http://x',
      pts,
      reply({
        code: 'Ok',
        distances: [
          [0, 1474.1],
          [1474.1, 0],
        ],
        sources: [{ distance: 31.6 }, { distance: 11.2 }],
      }),
    );
    expect(ok).toEqual({
      distanceM: [
        [0, 1474],
        [1474, 0],
      ],
      snapM: [32, 11],
    });
    await expect(
      osrmTable(
        'http://x',
        pts,
        reply({
          code: 'Ok',
          distances: [
            [0, null],
            [null, 0],
          ],
          sources: [{ distance: 0 }, { distance: 0 }],
        }),
      ),
    ).rejects.toThrow(RoutingError);
    await expect(osrmTable('http://x', pts, reply({ code: 'InvalidQuery' }))).rejects.toThrow(
      /InvalidQuery/,
    );
  });

  it('OSRM /route: линия по дорожкам, каждый отрезок — от точки до точки, без повторов', async () => {
    const reply = (body: unknown) => async () => new Response(JSON.stringify(body));
    const a = { lat: 45, lon: 19.6 };
    const b = { lat: 45.01, lon: 19.61 };
    const c = { lat: 45.02, lon: 19.6 };
    const step = (...coords: [number, number][]) => ({ geometry: { coordinates: coords } });
    const r = await osrmRoute(
      'http://x',
      [a, b, c],
      reply({
        code: 'Ok',
        routes: [
          {
            distance: 2512.4,
            legs: [
              {
                steps: [
                  step([19.6001, 45], [19.605, 45.005]),
                  step([19.605, 45.005], [19.6099, 45.01]),
                ],
              },
              { steps: [step([19.6099, 45.01], [19.6, 45.0199])] },
            ],
          },
        ],
      }),
    );
    expect(r.distanceM).toBe(2512);
    expect(r.path).toEqual([
      a,
      { lat: 45, lon: 19.6001 },
      { lat: 45.005, lon: 19.605 },
      { lat: 45.01, lon: 19.6099 },
      b,
      { lat: 45.01, lon: 19.6099 },
      { lat: 45.0199, lon: 19.6 },
      c,
    ]);
    await expect(osrmRoute('http://x', [a, b], reply({ code: 'NoRoute' }))).rejects.toThrow(
      /NoRoute/,
    );
    await expect(osrmRoute('http://x', [a], reply({}))).rejects.toThrow(RoutingError);
  });
});

describe('Problem на 10.10', () => {
  const t = points10();
  const route = routePoints(t);
  const matrix = matrixFile({
    points: t,
    route,
    table: haversineTable(route),
    source: 'haversine',
  });
  const p = buildProblem({ game, points: t, matrix, params: DEFAULT_PARAMS });
  const node = (id: string) => p.nodes.find((n) => n.kpId === id);

  it('проходит схему; старт 0, финиш 1, 76 КП', () => {
    expect(schemaErrors(Problem, p)).toEqual([]);
    expect([p.start, p.finish]).toEqual([0, 1]);
    expect(p.nodes.filter((n) => n.role === 'kp')).toHaveLength(76);
  });

  it('время от выхода после пролога: t0 12:30, дедлайн через 7 ч, мягкое опоздание 30 мин', () => {
    expect(p.t0).toBe('2026-10-10T12:30:00+02:00');
    expect(p.deadlineS).toBe(25_200);
    expect(p.softLateMaxS).toBe(1800);
    expect(p.latePenaltyPerMin).toBe(1);
  });

  it('окна 99 и 120 (14–18) в секундах; судья — 15 мин на точке', () => {
    expect(node('99')).toMatchObject({ window: [5400, 19_800], serviceS: 900 });
    expect(node('120')?.window).toEqual([5400, 19_800]);
    expect(node('64')?.serviceS).toBe(300);
  });

  it('ценность: КП с карты — в полную цену, 330 баллов на 76 КП', () => {
    expect(node('71Б')).toMatchObject({ points: 7, prize: 7 });
    expect(p.nodes.reduce((s, n) => s + n.prize, 0)).toBe(330);
    expect(p.nodes.reduce((s, n) => s + n.points, 0)).toBe(330);
  });

  it('время = расстояние ÷ 4,3 км/ч', () => {
    const d = matrix.distanceM[0]?.[1] ?? 0;
    expect(p.matrix.durationS[0]?.[1]).toBe(Math.round(d / (4.3 / 3.6)));
  });

  it('матрица от другой версии points.json — ошибка «пересчитайте»', () => {
    const stale = { ...matrix, pointsCreatedAt: '2026-01-01T00:00:00.000Z' };
    expect(() => buildProblem({ game, points: t, matrix: stale, params: DEFAULT_PARAMS })).toThrow(
      ProblemError,
    );
  });

  it('без пролога (нет start.depart) — от старта; выход раньше старта — ошибка', () => {
    const noPrologue = { ...game, start: { time: '10:30' } };
    const q = buildProblem({ game: noPrologue, points: t, matrix, params: DEFAULT_PARAMS });
    expect(q.t0).toBe('2026-10-10T10:30:00+02:00');
    expect(q.deadlineS).toBe(32_400);
    expect(q.nodes.find((n) => n.kpId === '99')?.window).toEqual([12_600, 27_000]);
    const early = { ...game, start: { time: '10:30', depart: '10:00' } };
    expect(() => buildProblem({ game: early, points: t, matrix, params: DEFAULT_PARAMS })).toThrow(
      ProblemError,
    );
  });
});

const graph = join(import.meta.dirname, '../../../games/osm/osrm-sremska-mitrovica');
const canOsrm = graphReady(graph) && dockerAvailable();

/** Настоящий OSRM в Docker — только если граф собран (./bgq osm) и Docker запущен. */
describe.skipIf(!canOsrm)('OSRM в Docker на 10.10', () => {
  it('по улицам длиннее прямой, но не в разы; привязка к дорожкам — метры', async () => {
    const route = routePoints(points10()).slice(0, 12);
    const table = await withOsrm(graph, (url) => osrmTable(url, route));
    const straight = haversineTable(route).distanceM;
    const ratios = table.distanceM.flatMap((row, i) =>
      row.flatMap((d, j) =>
        i !== j && (straight[i]?.[j] ?? 0) > 300 ? [d / ((straight[i]?.[j] ?? 1) / 1.3)] : [],
      ),
    );
    const median = [...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)] ?? 0;
    expect(median).toBeGreaterThan(1);
    expect(median).toBeLessThan(1.6);
    expect(Math.max(...table.snapM)).toBeLessThan(150);
  }, 60_000);

  it('/route через точки: длина = сумма расстояний матрицы, линия — сотни точек', async () => {
    const route = routePoints(points10()).slice(0, 6);
    const { geo, table } = await withOsrm(graph, async (url) => ({
      geo: await osrmRoute(url, route),
      table: await osrmTable(url, route),
    }));
    const sum = route.slice(1).reduce((s, _, i) => s + (table.distanceM[i]?.[i + 1] ?? 0), 0);
    expect(Math.abs(geo.distanceM - sum)).toBeLessThan(10);
    expect(geo.path.length).toBeGreaterThan(route.length * 3);
    expect(geo.path[0]).toEqual({ lat: route[0]?.lat, lon: route[0]?.lon });
  }, 60_000);
});
