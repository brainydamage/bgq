import { describe, expect, it } from 'vitest';
import { foldLookalikes, isEligible, normalizeKpId, parseKpId, pointsFor } from '../src/index.ts';

const rule = { kind: 'floor_div', divisor: 10 } as const;

describe('parseKpId / normalizeKpId', () => {
  it.each([
    ['64', '64', 64],
    ['25А', '25А', 25],
    ['25а', '25А', 25],
    ['25A', '25А', 25], // латинская A
    ['71Б', '71Б', 71],
    ['120', '120', 120],
  ])('%s → %s', (input, id, number) => {
    expect(parseKpId(input)).toEqual({ id, number, suffix: id.replace(/\d+/, '') });
  });

  it.each(['', 'КП', '1234', '25D', '25АБ'])('%s → null', (input) => {
    expect(parseKpId(input)).toBeNull();
  });

  it('slug задания без номера и числовой ключ YAML', () => {
    expect(normalizeKpId('t-letter-to-self')).toBe('t-letter-to-self');
    expect(normalizeKpId(99)).toBe('99');
  });
});

describe('pointsFor', () => {
  it.each([
    [64, 6],
    [120, 12],
    [12, 1],
    [25, 2],
    [84, 8],
    [9, 0],
  ])('%i → %i', (n, p) => {
    expect(pointsFor(n, rule)).toBe(p);
  });
});

describe('foldLookalikes', () => {
  it('меняет латиницу только в словах со смесью алфавитов', () => {
    expect(foldLookalikes('Улица Житна Пиjаца дом 32')).toBe('Улица Житна Пијаца дом 32');
    expect(foldLookalikes('Матje Хуђи 6')).toBe('Матје Хуђи 6');
    expect(foldLookalikes('Кафе La Gioia')).toBe('Кафе La Gioia');
  });
});

describe('isEligible', () => {
  const pro = { category: 'pro', allowedColors: ['red', 'blue'] } as const;
  it.each([
    [{}, true],
    [{ note: 'velo_only' }, false],
    [{ note: 'pro_only' }, true],
    [{ mapColor: 'blue' }, true],
    [{ mapColor: 'green' }, false],
  ] as const)('%o → %s', (kp, expected) => {
    expect(isEligible(kp, pro)).toBe(expected);
  });
});
