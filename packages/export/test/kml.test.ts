import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Game, Kp, MapFileResults, PointsFile } from '@bgq/core';
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
