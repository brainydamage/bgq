import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseKpId, pointsFor } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ingest } from '../src/index.ts';
import { fixtureGame, fixtureMd, fixtureOverrides } from './helpers.ts';

/** Протокол организаторов 10.10 (fixtures/2026-10-10/result.yaml) против разобранного Notion. */
interface Result {
  main: Record<string, number>;
  riddles: string[];
  mainTotal: number;
  kp120: Record<string, number>;
  tasks: Record<string, number>;
  prologue: Record<string, number>;
  protocolSum: number;
  total: number;
}

const result = parse(
  readFileSync(join(import.meta.dirname, '../../../fixtures/2026-10-10/result.yaml'), 'utf8'),
) as Result;
const { kps } = ingest({ md: fixtureMd, game: fixtureGame, overrides: fixtureOverrides });
const byId = new Map(kps.map((k) => [k.id, k]));
const sum = (r: Record<string, number>) => Object.values(r).reduce((s, x) => s + x, 0);

describe('итоги 10.10 по протоколу', () => {
  it('суммы сходятся: основные 114, КП 120 — 10, задания 35, пролог 12, всего 171', () => {
    expect(sum(result.main)).toBe(result.mainTotal);
    expect(result.mainTotal).toBe(114);
    expect(sum(result.kp120)).toBe(10);
    expect(sum(result.tasks)).toBe(35);
    expect(sum(result.prologue)).toBe(12);
    expect(sum(result.kp120) + sum(result.tasks) + sum(result.prologue)).toBe(result.protocolSum);
    expect(result.mainTotal + result.protocolSum).toBe(result.total);
  });

  it('загадки — номера не из Notion; остальные основные — доступные КП Notion', () => {
    for (const id of result.riddles) expect(byId.has(id), id).toBe(false);
    const classic = Object.keys(result.main).filter((id) => !result.riddles.includes(id));
    expect(classic).toHaveLength(26);
    for (const id of classic) expect(byId.get(id)?.eligible, id).toBe(true);
  });

  it('верный ответ = баллы по правилу floor(номер/10), и у КП, и у загадок', () => {
    for (const [id, points] of Object.entries(result.main)) {
      if (points > 0)
        expect(points, id).toBe(pointsFor(parseKpId(id)?.number ?? -1, fixtureGame.pointsRule));
    }
    expect(byId.get('120')?.points).toBe(12);
  });

  it('классика: 27 КП с 120, 76 б (4 неверных ответа — минус 12 б, на 120 — минус 2)', () => {
    const classic = Object.entries(result.main).filter(([id]) => !result.riddles.includes(id));
    const wrong = classic.filter(([, p]) => p === 0).map(([id]) => id);
    expect(wrong).toEqual(['20', '27', '43', '47']);
    expect(classic.reduce((s, [, p]) => s + p, 0) + sum(result.kp120)).toBe(76);
    const riddlePoints = result.riddles.reduce((s, id) => s + (result.main[id] ?? 0), 0);
    expect(riddlePoints).toBe(48);
  });
});
