import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Plan, type Problem, schemaErrors } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import {
  clock,
  defaultDepart,
  planSummary,
  problemHash,
  runSolver,
  uvAvailable,
} from '../src/index.ts';

const fixture = join(import.meta.dirname, '../../../fixtures/2026-10-10/problem.json');
const node = (kpId: string | null, points: number, extra: object = {}) => ({
  kpId,
  role: kpId ? ('kp' as const) : ('start' as const),
  lat: 45,
  lon: 19.6,
  points,
  prize: points,
  serviceS: 300,
  ...extra,
});
const problem: Problem = {
  v: 1,
  gameId: '2026-10-10',
  t0: '2026-10-10T10:30:00+02:00',
  nodes: [
    node(null, 0),
    { ...node(null, 0), role: 'finish' },
    node('64', 6),
    node('99', 9, { window: [12_600, 27_000] }),
    node('10', 1),
    node('71', 7),
  ],
  matrix: { source: 'haversine', durationS: [] },
  start: 0,
  finish: 1,
  deadlineS: 32_400,
  softLateMaxS: 1800,
  latePenaltyPerMin: 1,
  speedKmh: 4.3,
};
const plan: Plan = {
  v: 1,
  planId: '9bb2d9b2-4d17-4f44-a294-3d359a6aae5f',
  gameId: '2026-10-10',
  problemHash: 'sha256:x',
  createdAt: '2026-10-17T10:00:00.000Z',
  solver: 'ortools',
  solverMs: 10_400,
  t0: problem.t0,
  stops: [
    { kpId: '64', arriveS: 540, departS: 840 },
    { kpId: '99', arriveS: 12_000, departS: 13_500 },
  ],
  finishS: 32_520,
  slackMin: -2,
  totalPoints: 13,
  expectedPrize: 13,
  distanceM: 16_620,
  dropped: ['10', '71'],
};

describe('solve: хэш, время, сводка', () => {
  it('хэш problem.json — sha256 байтов, как в Python', () => {
    expect(problemHash('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('часы: t0 + секунды, местное время', () => {
    expect(clock('2026-10-10T10:30:00+02:00', 0)).toBe('10:30');
    expect(clock('2026-10-10T10:30:00+02:00', 32_400)).toBe('19:30');
    expect(clock('2026-10-10T10:30:00+02:00', 3_629)).toBe('11:30');
  });

  it('сводка: итог с опозданием, порядок с окном, выброшенные по баллам', () => {
    const lines = planSummary(plan, problem);
    expect(lines[0]).toBe(
      'План: 2 КП · 13 б из 23 · 16,6 км · финиш 19:32, опоздание 2 мин (−2 б)',
    );
    expect(lines[1]).toBe('Порядок (первый КП в 10:39): 64 → 99⏰13:50');
    expect(lines[2]).toBe('Не в плане 2 КП, 8 б: 71 (7), 10 (1)');
    expect(lines.at(-1)).toBe('Поиск 10,4 с (ortools)');
  });

  it('сводка: загадки 🧩 в порядке и список нерешённых', () => {
    const kp = (id: string, points: number, loc: boolean) => ({
      id,
      number: Number.parseInt(id, 10),
      kind: 'riddle' as const,
      points,
      eligible: true,
      title: 'Загадка',
      description: [],
      struck: [],
      links: [],
      answerKind: 'text' as const,
      raw: '',
      ...(loc && { loc: { lat: 45, lon: 19.6, source: 'manual' as const, confidence: 0.95 } }),
    });
    const lines = planSummary(plan, problem, [
      kp('99', 9, true),
      kp('95', 9, false),
      kp('73', 7, false),
    ]);
    expect(lines[1]).toBe('Порядок (первый КП в 10:39): 64 → 🧩99⏰13:50');
    expect(lines).toContain('🧩 Не решены 2, 16 б: 95 (9), 73 (7) — решили → ./bgq route');
  });

  it('сводка: запас и ожидаемая ценность, если она меньше баллов', () => {
    const lines = planSummary({ ...plan, slackMin: 12.5, expectedPrize: 11.5 }, problem);
    expect(lines[0]).toContain('запас 12,5 мин');
    expect(lines[1]).toBe('  ожидаемо 11,5 б (с поправкой на неточные координаты)');
  });
});

/** Контракт с Python: план солвера проходит TS-схему Plan. Нужен uv (brew install uv). */
describe.skipIf(!uvAvailable())('solve: OR-Tools на 10.10', () => {
  it('plan.json проходит схему Plan, хэш — от problem.json', () => {
    const planPath = join(mkdtempSync(join(tmpdir(), 'bgq-solve-')), 'plan.json');
    runSolver({ problemPath: fixture, planPath, timeS: 1 });
    const out = JSON.parse(readFileSync(planPath, 'utf8')) as Plan;
    expect(schemaErrors(Plan, out)).toEqual([]);
    expect(out.problemHash).toBe(problemHash(readFileSync(fixture)));
    expect(out.stops.length).toBeGreaterThan(27); // факт 10.10 — 27 КП с карты
    expect(out.stops.length + out.dropped.length).toBe(76);
  }, 60_000);
});

describe('solve: выход по умолчанию', () => {
  const t0 = '2026-10-10T12:30:00+02:00';
  const at = (iso: string) => defaultDepart(t0, 'Europe/Belgrade', new Date(iso));

  it('в день игры после получения комплекта — сейчас + 2 мин (по часам игры)', () => {
    expect(at('2026-10-10T10:47:00Z')).toBe('12:49');
  });

  it('до t0 или в другой день — от t0 задачи', () => {
    expect(at('2026-10-10T10:00:00Z')).toBeUndefined();
    expect(at('2026-10-10T10:30:00Z')).toBeUndefined();
    expect(at('2026-10-17T10:47:00Z')).toBeUndefined();
  });
});
