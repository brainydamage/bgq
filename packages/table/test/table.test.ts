import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Game,
  type Kp,
  type Loc,
  type MapFileResults,
  PointsFile,
  schemaErrors,
} from '@bgq/core';
import { buildIndex, type Gazetteer, type GeoResult, geocodeAll } from '@bgq/geo';
import { ingest } from '@bgq/ingest';
import { describe, expect, it } from 'vitest';
import { buildTable, formatTableSummary } from '../src/index.ts';

const fx = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../../fixtures/2026-10-10', name), 'utf8');
const game = JSON.parse(fx('game.json')) as Game;
const NOW = new Date('2026-10-16T23:00:00Z');

const loc = (lat: number, source: Loc['source'], confidence = 0.9): Loc => ({
  lat,
  lon: 19.6,
  source,
  confidence,
});

function kp(id: string, extra: Partial<Kp> = {}): Kp {
  return {
    id,
    number: Number.parseInt(id, 10),
    kind: 'classic',
    points: Math.floor(Number.parseInt(id, 10) / 10),
    eligible: true,
    title: `КП ${id}`,
    description: [],
    struck: [],
    links: [],
    answerKind: 'text',
    raw: '',
    ...extra,
  };
}

const geoOf = (id: string, l: Loc, method: GeoResult['method'] = 'exact'): GeoResult => ({
  id,
  loc: l,
  method,
});

function mapOf(results: MapFileResults['results']): MapFileResults {
  return { v: 1, gameId: 'g', updatedAt: '2026-10-16T22:00:00.000Z', results };
}

describe('buildTable: правила', () => {
  const t = buildTable({
    game,
    now: NOW,
    kpsAt: '2026-10-16T21:00:00.000Z',
    kps: [
      kp('10', { loc: loc(44.9, 'manual', 1) }), // ручная правка
      kp('20'), // карта + адрес рядом
      kp('30'), // карта + адрес далеко
      kp('40'), // только адрес
      kp('50'), // стрелка зелёная + адрес
      kp('60'), // нет ничего
      kp('70', { mapColor: 'red' }), // override цвета важнее карты
      kp('93', { note: 'velo_only' }), // только вело, координат нет — не ошибка
    ],
    geo: {
      osmBase: '2026-10-15T20:21:00Z',
      results: [
        geoOf('10', loc(44.9505, 'geocode')),
        geoOf('20', loc(44.9701, 'geocode')),
        geoOf('30', loc(44.975, 'geocode')),
        geoOf('40', loc(44.96, 'geocode', 0.5), 'interpolated'),
        geoOf('50', loc(44.99, 'geocode')),
        { id: '60', reason: 'no_address' },
      ],
    },
    map: mapOf([
      { id: '10', loc: loc(44.951, 'map', 0.8), color: 'red', photo: 'a.jpg' },
      { id: '20', loc: loc(44.97, 'map', 0.8), color: 'blue', photo: 'a.jpg' },
      { id: '30', loc: loc(44.97, 'map', 0.8), color: 'red', photo: 'a.jpg' },
      { id: '50', color: 'green', photo: 'a.jpg', arrow: true },
      { id: '70', loc: loc(44.97, 'map', 0.8), color: 'green', photo: 'a.jpg' },
      { id: '77', loc: loc(44.97, 'map', 0.8), color: 'red', photo: 'a.jpg' },
    ]),
  });
  const k = (id: string) => t.kps.find((x) => x.id === id);

  it('координаты: ручная правка → карта → адрес; остальное — в altLocs', () => {
    expect(k('10')?.loc?.source).toBe('manual');
    expect(k('10')?.altLocs?.map((l) => l.source)).toEqual(['map', 'geocode']);
    expect(k('20')?.loc?.source).toBe('map');
    expect(k('20')?.altLocs?.map((l) => l.source)).toEqual(['geocode']);
    expect(k('40')?.loc).toEqual(loc(44.96, 'geocode', 0.5));
    expect(k('40')?.altLocs).toBeUndefined();
    expect(k('60')?.loc).toBeUndefined();
  });

  it('стрелка: цвет с карты, координаты по адресу; зелёный — недоступен', () => {
    expect(k('50')).toMatchObject({
      mapColor: 'green',
      eligible: false,
      loc: { source: 'geocode' },
    });
    expect(k('70')).toMatchObject({ mapColor: 'red', eligible: true });
    expect(k('20')?.mapColor).toBe('blue');
    expect(k('93')?.eligible).toBe(false);
  });

  it('проблемы: критичные первыми', () => {
    expect(t.issues.map((i) => [i.severity, i.code, i.kpId])).toEqual([
      ['critical', 'no_location', '60'],
      ['critical', 'unknown_map_id', '77'],
      ['cosmetic', 'map_geo_mismatch', '30'],
      ['cosmetic', 'not_on_map', '40'],
    ]);
    // 20: карта и адрес в ~11 м — не расхождение.
    expect(t.issues.some((i) => i.kpId === '20')).toBe(false);
  });

  it('статистика, источники, схема', () => {
    expect(t.stats).toEqual({
      kps: 8,
      eligible: 6,
      points: 1 + 2 + 3 + 4 + 6 + 7,
      locFrom: { manual: 1, map: 3, geocode: 2, gmaps_link: 0 },
      eligibleWithoutLoc: 1,
    });
    expect(t.sources).toEqual({
      kps: '2026-10-16T21:00:00.000Z',
      geo: { osmBase: '2026-10-15T20:21:00Z' },
      map: { updatedAt: '2026-10-16T22:00:00.000Z' },
    });
    expect(schemaErrors(PointsFile, t)).toEqual([]);
  });

  it('без geo и map — только ручные правки, остальные доступные без координат', () => {
    const bare = buildTable({ game, now: NOW, kpsAt: t.sources.kps, kps: [kp('10'), kp('20')] });
    expect(bare.stats.eligibleWithoutLoc).toBe(2);
    expect(bare.sources).toEqual({ kps: t.sources.kps });
  });

  it('расхождение не сообщаем у неточного адреса (только улица) и у недоступных КП', () => {
    const far = buildTable({
      game,
      now: NOW,
      kpsAt: t.sources.kps,
      kps: [kp('61'), kp('83'), kp('71')],
      geo: {
        osmBase: 'x',
        results: [
          geoOf('61', loc(44.9, 'geocode', 0.2), 'street'),
          geoOf('83', loc(44.9, 'geocode', 0.95)),
          geoOf('71', loc(44.9, 'geocode', 0.95)),
        ],
      },
      map: mapOf([
        { id: '61', loc: loc(44.97, 'map', 0.8), color: 'red', photo: 'a.jpg' },
        { id: '83', loc: loc(44.97, 'map', 0.8), color: 'green', photo: 'a.jpg' },
        { id: '71', loc: loc(44.97, 'map', 0.8), color: 'blue', photo: 'a.jpg' },
      ]),
    });
    expect(far.issues.map((i) => i.kpId)).toEqual(['71']);
  });
});

describe('buildTable на 10.10: Notion + OSM + разметка карты', () => {
  const { kps } = ingest({ md: fx('notion-export.md'), game, overrides: fx('overrides.yaml') });
  const geo = geocodeAll(kps, buildIndex(JSON.parse(fx('osm-gazetteer.json')) as Gazetteer));
  const map = JSON.parse(fx('map.json')) as MapFileResults;
  const t = buildTable({
    game,
    now: NOW,
    kpsAt: '2026-10-16T21:12:00.000Z',
    kps,
    geo: { osmBase: '2026-10-15T20:21:00Z', results: geo },
    map,
  });
  const k = (id: string) => t.kps.find((x) => x.id === id);

  it('доступно 76 КП на 330 баллов: 83 — зелёная стрелка на карте', () => {
    expect(t.stats).toMatchObject({ kps: 81, eligible: 76, points: 330, eligibleWithoutLoc: 0 });
    expect(k('83')).toMatchObject({
      mapColor: 'green',
      eligible: false,
      loc: { source: 'geocode' },
    });
  });

  it('у всех доступных КП координаты с карты', () => {
    expect(t.kps.filter((x) => x.eligible).every((x) => x.loc?.source === 'map')).toBe(true);
  });

  it('71Б: карта главнее адреса, адрес — в altLocs, расхождение в проблемах', () => {
    expect(k('71Б')?.loc?.source).toBe('map');
    expect(k('71Б')?.altLocs?.[0]?.source).toBe('geocode');
    expect(t.issues).toContainEqual(
      expect.objectContaining({ code: 'map_geo_mismatch', kpId: '71Б', severity: 'cosmetic' }),
    );
    expect(t.issues.filter((i) => i.severity === 'critical')).toEqual([]);
  });

  it('окна времени из overrides сохраняются', () => {
    expect(k('99')?.window).toEqual({ from: '14:00', to: '18:00' });
    expect(k('120')?.window).toEqual({ from: '14:00', to: '18:00' });
  });

  it('проходит схему; сводка', () => {
    expect(schemaErrors(PointsFile, t)).toEqual([]);
    expect(formatTableSummary(t)).toMatchSnapshot();
  });
});
