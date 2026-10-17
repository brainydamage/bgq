import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Game, Kp, MapFileResults, Plan, PointsFile } from '@bgq/core';
import { buildIndex, type Gazetteer, geocodeAll } from '@bgq/geo';
import { ingest } from '@bgq/ingest';
import { buildTable } from '@bgq/table';
import { describe, expect, it } from 'vitest';
import { buildKml, colorOf, placemarkDescription, placemarkName } from '../src/index.ts';

const fx = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../../fixtures/2026-10-10', name), 'utf8');
const game = JSON.parse(fx('game.json')) as Game;

/** Таблица 10.10 + старт и финиш, как если бы их отметили на карте. */
function table(): PointsFile {
  const { kps } = ingest({ md: fx('notion-export.md'), game, overrides: fx('overrides.yaml') });
  const geo = geocodeAll(kps, buildIndex(JSON.parse(fx('osm-gazetteer.json')) as Gazetteer));
  const map = JSON.parse(fx('map.json')) as MapFileResults;
  const loc = (lat: number, lon: number) => ({ lat, lon, source: 'map' as const, confidence: 0.8 });
  map.results.push(
    { id: 'start', loc: loc(44.9776, 19.601), color: null, photo: 'IMG_7081.jpg' },
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

const t = table();
const kp = (id: string) => t.kps.find((k) => k.id === id) as Kp;

describe('KML для Organic Maps на 10.10', () => {
  const { kml, placemarks, skipped } = buildKml(t, game.city);

  it('старт, финиш и все 76 доступных КП', () => {
    expect(placemarks).toBe(78);
    expect(skipped).toEqual([]);
    expect(kml.match(/<Placemark>/g)).toHaveLength(78);
    expect(kml.match(/<\/Placemark>/g)).toHaveLength(78);
    expect(kml).toContain('<name>СТАРТ</name>');
    expect(kml).toContain('<coordinates>19.601,44.9776</coordinates>');
  });

  it('недоступные (83, вело) — только с --all, серым', () => {
    expect(kml).not.toContain('<name>83 ·');
    const all = buildKml(t, game.city, { includeIneligible: true });
    expect(all.kml).toContain('<name>83 · 8б</name>');
    expect(all.kml).toContain('#placemark-gray');
  });

  it('валидный XML: все & < > экранированы', () => {
    const body = kml.replace(/<\?xml[^>]*\?>/, '');
    expect(body).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(kml).toContain('&quot;Туннель&quot;');
  });
});

describe('подписи и описания', () => {
  it('имя: номер · баллы, окно работы', () => {
    expect(placemarkName(kp('64'))).toBe('64 · 6б');
    expect(placemarkName(kp('99'))).toBe('99 · 9б ⏰14–18');
  });

  it('цвет по баллам: 1–3 жёлтый, 4–5 бирюзовый, 6–7 фиолетовый, 8+ красный', () => {
    const ids = ['12', '35', '47', '51', '64', '75А', '81', '120'];
    expect(ids.map((id) => colorOf(kp(id)))).toEqual([
      'yellow',
      'yellow',
      'cyan',
      'cyan',
      'purple',
      'purple',
      'red',
      'red',
    ]);
  });

  it('стили: только используемые цвета, без пар жёлтый/оранжевый и синий/бирюзовый', () => {
    const { kml } = buildKml(t, game.city);
    const styles = [...kml.matchAll(/<Style id="placemark-([a-z]+)">/g)].map((m) => m[1]);
    expect(styles).toEqual(['red', 'purple', 'cyan', 'yellow', 'green', 'brown', 'gray']);
    expect(kml).toMatch(/<name>ФИНИШ<\/name>[\s\S]*?#placemark-brown/);
  });

  it('описание: задание, окно, откуда координаты и где адрес', () => {
    const d = placemarkDescription(kp('71Б'));
    expect(d.split('\n')[0]).toBe('Лале Станковића 1');
    expect(d).toContain('Спортсмены на фасаде здания');
    expect(d).toMatch(/Координаты по карте; по адресу — в 2\d\d м/);
    expect(placemarkDescription(kp('120'))).toContain('Работает 14–18');
  });
});

describe('KML с планом маршрута', () => {
  const stop = (kpId: string, arriveS: number) => ({ kpId, arriveS, departS: arriveS + 300 });
  const plan: Plan = {
    v: 1,
    planId: '9bb2d9b2-4d17-4f44-a294-3d359a6aae5f',
    gameId: '2026-10-10',
    problemHash: 'sha256:x',
    createdAt: '2026-10-17T10:00:00.000Z',
    solver: 'ortools',
    solverMs: 1000,
    t0: '2026-10-10T10:30:00+02:00',
    stops: [stop('64', 540), stop('99', 12_600), stop('71Б', 15_000)],
    finishS: 32_000,
    slackMin: 6.7,
    totalPoints: 25,
    expectedPrize: 25,
    distanceM: 16_620,
    dropped: [],
  };
  const { kml, placemarks, planMissing } = buildKml(t, game.city, { plan });

  it('линия: старт → КП по порядку → финиш', () => {
    expect(planMissing).toEqual([]);
    expect(kml).toContain('<name>Маршрут: 3 КП · 25 б · 16,6 км · финиш 19:23</name>');
    const line = /<LineString>[\s\S]*?<\/LineString>/.exec(kml)?.[0] ?? '';
    const coords = line.match(/-?\d+\.\d+,-?\d+\.\d+/g) ?? [];
    const at = (id: string) => `${kp(id).loc?.lon},${kp(id).loc?.lat}`;
    expect(coords).toEqual(['19.601,44.9776', at('64'), at('99'), at('71Б'), '19.6093,44.9705']);
    expect(kml).toContain('<styleUrl>#route</styleUrl>');
    expect(kml).toContain('<Style id="route">');
  });

  it('КП плана — по порядку с приходом, остальные — «Не в плане»', () => {
    expect(placemarks).toBe(78);
    expect(kml).toContain('<name>01 · 64 · 6б · 10:39</name>');
    expect(kml).toContain('<name>02 · 99 · 9б ⏰14–18 · 14:00</name>');
    expect(kml).toContain('<name>План (3)</name>');
    expect(kml).toContain('<name>Не в плане (73)</name>');
    expect(kml.indexOf('01 · 64')).toBeLessThan(kml.indexOf('02 · 99'));
    expect(placemarkDescription(kp('64'), { n: 1, stop: stop('64', 540), t0: plan.t0 })).toContain(
      'По плану: 1-й, приход 10:39, уход 10:44 (5 мин на точке)',
    );
  });

  it('план с чужими КП не рисуется', () => {
    const stale = buildKml(t, game.city, { plan: { ...plan, stops: [stop('999', 600)] } });
    expect(stale.planMissing).toEqual(['999']);
    expect(stale.kml).not.toContain('<LineString>');
    expect(stale.kml).toContain('<name>КП (76)</name>');
  });

  it('линия по улицам (OSRM), если передана геометрия', () => {
    const routePath = [
      { lat: 44.9776, lon: 19.601 },
      { lat: 44.975, lon: 19.6031 },
      { lat: 44.9705, lon: 19.6093 },
    ];
    const r = buildKml(t, game.city, { plan, routePath });
    const line = /<LineString>[\s\S]*?<\/LineString>/.exec(r.kml)?.[0] ?? '';
    expect(line.match(/-?\d+\.\d+,-?\d+\.\d+/g)).toEqual([
      '19.601,44.9776',
      '19.6031,44.975',
      '19.6093,44.9705',
    ]);
    expect(r.kml).toContain('линия по улицам (OSRM)');
    expect(kml).toContain('прямые отрезки между точками');
  });

  it('загадки: 🧩 в имени, нерешённые — в описании карты', () => {
    const riddle = (id: string, withLoc: boolean): Kp => ({
      ...kp('64'),
      id,
      number: Number.parseInt(id, 10),
      kind: 'riddle',
      points: 9,
      title: 'Загадка',
      ...(withLoc ? {} : { loc: undefined }),
    });
    const { loc: _l, ...noLoc } = riddle('95', false);
    const r = buildKml({ ...t, kps: [...t.kps, riddle('96', true), noLoc as Kp] }, game.city);
    expect(r.kml).toContain('<name>🧩96 · 9б</name>');
    expect(r.unsolved).toEqual(['95']);
    expect(r.skipped).toEqual([]);
    expect(r.kml).toContain('🧩 не решены: 95 (9 б)');
  });

  it('без плана — как раньше', () => {
    expect(buildKml(t, game.city).kml).not.toContain('Маршрут');
  });
});
