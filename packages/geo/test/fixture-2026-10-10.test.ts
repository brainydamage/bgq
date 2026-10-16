import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Game } from '@bgq/core';
import { ingest } from '@bgq/ingest';
import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  evaluate,
  formatEval,
  formatGeoSummary,
  type Gazetteer,
  geocodeAll,
  parseReference,
} from '../src/index.ts';

const dir = join(import.meta.dirname, '../../../fixtures/2026-10-10');
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

const game = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../games/2026-10-10/game.json'), 'utf8'),
) as Game;
const { kps } = ingest({ md: read('notion-export.md'), game });
const gaz = JSON.parse(read('osm-gazetteer.json')) as Gazetteer;
const results = geocodeAll(kps, buildIndex(gaz));
const reference = parseReference(read('reference.yaml'));
const stats = evaluate(results, reference);
const byId = new Map(results.map((r) => [r.id, r]));

describe('geo на 10.10 против эталона', () => {
  it('критерий брифа: ошибка < 30–50 м', () => {
    expect(stats.total).toBe(34);
    expect(stats.located).toBe(34);
    expect(stats.medianM).toBeLessThanOrEqual(25);
    expect(stats.p90M).toBeLessThanOrEqual(30);
    expect(stats.within50).toBeGreaterThanOrEqual(33);
  });

  it('по каждому КП: способ и ошибка (регрессии видны в диффе снапшота)', () => {
    expect(stats.rows).toMatchSnapshot();
  });

  it.each([
    ['30', 'Стамбено насеље Матија Хуђи'], // «Стамбело … Матje» — опечатки + латиница
    ['19', 'Стари шор'], // «Старый» — по-русски
    ['37', 'Саве Ковачевића'], // «Савы»
    ['47А', 'Сремских диверзаната'], // «Диверсантов»
    ['64', 'Филипа Вишњића'], // в Google переименована, в OSM — как в Notion
    ['83', 'Петра Кочића'], // «Коћића»: ћ вместо ч
    ['120', 'Трг Светог Стефана'], // «Улица» в Notion, «Трг» в OSM
  ])('КП %s → %s', (id, street) => {
    expect(byId.get(id)?.matched?.street).toBe(street);
  });

  it('адрес в скобках: 39 «Деканске Баште (Водна 16А)»', () => {
    expect(byId.get('39')).toMatchObject({
      method: 'exact',
      matched: { street: 'Водна', house: '16А' },
    });
  });

  it('дома нет в OSM: 45 «Ратарска 1» → соседний дом на той же улице', () => {
    expect(byId.get('45')).toMatchObject({
      method: 'interpolated',
      matched: { street: 'Ратарска' },
    });
  });

  it('без номера дома: 61 «Батутова улица» → центр улицы, низкая уверенность', () => {
    expect(byId.get('61')).toMatchObject({ method: 'street', loc: { confidence: 0.2 } });
  });

  it('КП без адреса не геокодируются', () => {
    expect(results.filter((r) => r.reason === 'no_address')).toHaveLength(81 - 35);
  });

  it('сводка для терминала', () => {
    expect(formatGeoSummary(results)).toMatchSnapshot();
    expect(formatEval(stats)).toMatchSnapshot();
  });
});
