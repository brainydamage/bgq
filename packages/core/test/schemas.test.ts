import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  type Event,
  type Plan,
  type Problem,
  renderSchemas,
  schemaErrors,
  schemas,
} from '../src/index.ts';

const schemasDir = join(import.meta.dirname, '../../../schemas');

describe('schemas/*.schema.json', () => {
  const rendered = renderSchemas();

  it.each(Object.keys(rendered))('%s совпадает с TypeBox (иначе: pnpm schemas)', (file) => {
    expect(readFileSync(join(schemasDir, file), 'utf8')).toBe(rendered[file]);
  });

  it.each(Object.keys(rendered))(
    '%s компилируется сторонним валидатором (Ajv, draft-07)',
    (file) => {
      const ajv = new Ajv({ strict: true, allErrors: true });
      expect(() => ajv.compile(JSON.parse(rendered[file] ?? ''))).not.toThrow();
    },
  );
});

const problem: Problem = {
  v: 1,
  gameId: '2026-10-10',
  t0: '2026-10-10T10:30:00+02:00',
  nodes: [
    { kpId: null, role: 'start', lat: 44.9776, lon: 19.601, points: 0, prize: 0, serviceS: 0 },
    { kpId: '64', role: 'kp', lat: 44.97, lon: 19.61, points: 6, prize: 6, serviceS: 300 },
    {
      kpId: '99',
      role: 'kp',
      lat: 44.96,
      lon: 19.6,
      points: 9,
      prize: 9,
      serviceS: 600,
      window: [12600, 27000],
    },
    { kpId: null, role: 'finish', lat: 44.97, lon: 19.61, points: 0, prize: 0, serviceS: 0 },
  ],
  matrix: {
    source: 'haversine',
    durationS: [
      [0, 600, 900, 700],
      [600, 0, 400, 100],
      [900, 400, 0, 500],
      [700, 100, 500, 0],
    ],
  },
  start: 0,
  finish: 3,
  deadlineS: 32400,
  softLateMaxS: 1800,
  latePenaltyPerMin: 1,
  speedKmh: 4.3,
};

const plan: Plan = {
  v: 1,
  planId: '0b6f7c1e-3a52-4c1e-9d7a-2f5e8a9b1c3d',
  gameId: '2026-10-10',
  problemHash: 'sha256:abc',
  createdAt: '2026-10-10T10:45:00+02:00',
  solver: 'heuristic',
  solverMs: 120,
  t0: '2026-10-10T10:30:00+02:00',
  stops: [{ kpId: '64', arriveS: 600, departS: 900 }],
  finishS: 1000,
  slackMin: 18,
  totalPoints: 6,
  expectedPrize: 6,
  distanceM: 1200,
  dropped: ['99'],
};

const event: Event = {
  v: 1,
  id: '5f0c8a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
  gameId: '2026-10-10',
  kpId: '25А',
  deviceId: 'iphone-uliana',
  seq: 3,
  clientTs: '2026-10-10T12:51:10+02:00',
  type: 'taken',
  answerTime: '12:51',
};

describe('валидация примеров', () => {
  it('корректные Problem / Plan / Event проходят', () => {
    expect(schemaErrors(schemas.problem, problem)).toEqual([]);
    expect(schemaErrors(schemas.plan, plan)).toEqual([]);
    expect(schemaErrors(schemas.event, event)).toEqual([]);
  });

  it('Ajv по сгенерированным файлам согласен с TypeBox', () => {
    const ajv = new Ajv({ strict: true });
    const files = renderSchemas();
    for (const [name, value] of [
      ['problem', problem],
      ['plan', plan],
      ['event', event],
    ] as const) {
      const validate = ajv.compile(JSON.parse(files[`${name}.v1.schema.json`] ?? ''));
      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it.each([
    ['taken без времени', { ...event, answerTime: undefined }],
    ['время не ЧЧ:ММ', { ...event, answerTime: '9:5' }],
    ['лишнее поле', { ...event, extra: 1 }],
    ['неизвестный type', { ...event, type: 'deleted' }],
    ['id не UUID', { ...event, id: 'tap-1' }],
    ['kpId с латинской буквой', { ...event, kpId: '25A' }],
  ])('Event отклоняется: %s', (_name, value) => {
    expect(schemaErrors(schemas.event, value)).not.toEqual([]);
  });

  it('Problem: дробные секунды в матрице отклоняются (OR-Tools — целые)', () => {
    const bad = { ...problem, matrix: { ...problem.matrix, durationS: [[0, 1.5]] } };
    expect(schemaErrors(schemas.problem, bad)).not.toEqual([]);
  });
});
