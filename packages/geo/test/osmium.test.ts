import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bboxAround,
  elementsFromGeojsonSeq,
  gazetteerFromPbf,
  pickPlace,
  placesFromGeojsonSeq,
} from '../src/index.ts';

const RS = '\x1e';
const feature = (geometry: unknown, properties: Record<string, unknown>) =>
  `${RS}${JSON.stringify({ type: 'Feature', geometry, properties })}`;

describe('elementsFromGeojsonSeq', () => {
  const center = [45, 19] as const;
  const seq = [
    feature(
      { type: 'Point', coordinates: [19.0001, 45.0001] },
      {
        '@type': 'node',
        '@id': 1,
        'addr:street': 'Ратарска',
        'addr:housenumber': 3,
      },
    ),
    feature(
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [19.001, 45.001],
              [19.003, 45.001],
              [19.003, 45.003],
              [19.001, 45.001],
            ],
          ],
        ],
      },
      {
        '@type': 'way',
        '@id': 2,
        building: 'yes',
        'addr:street': 'Ратарска',
        'addr:housenumber': '5',
      },
    ),
    feature(
      {
        type: 'LineString',
        coordinates: [
          [19.2, 45.2],
          [19.0, 45.0],
        ],
      },
      {
        '@type': 'way',
        '@id': 3,
        highway: 'residential',
        name: 'Дуга',
      },
    ),
    feature(
      {
        type: 'LineString',
        coordinates: [
          [19.5, 45.5],
          [19.6, 45.6],
        ],
      },
      {
        '@type': 'way',
        '@id': 4,
        highway: 'residential',
        name: 'Далёкая',
      },
    ),
    feature(
      { type: 'Point', coordinates: [19, 45] },
      { '@type': 'node', '@id': 5, railway: 'crossing' },
    ),
    '',
  ].join('\n');
  const els = elementsFromGeojsonSeq(seq, center, 1000);

  it('точка — lat/lon, полигон — центр bbox, теги — строки', () => {
    expect(els[0]).toEqual({
      type: 'node',
      id: 1,
      lat: 45.0001,
      lon: 19.0001,
      tags: { 'addr:street': 'Ратарска', 'addr:housenumber': '3' },
    });
    expect(els[1]).toMatchObject({
      type: 'way',
      id: 2,
      center: { lat: expect.closeTo(45.002, 9), lon: expect.closeTo(19.002, 9) },
    });
  });

  it('улица в радиусе хоть одной вершиной — остаётся; далёкая и лишние объекты — нет', () => {
    expect(els.map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

describe('pickPlace', () => {
  const place = (id: number, place: string, name = 'Х') => ({
    type: 'node' as const,
    id,
    lat: 45 + id,
    lon: 19,
    tags: { place, name },
  });

  it('город важнее деревни-тёзки', () => {
    expect(
      pickPlace([place(1, 'village'), place(2, 'town'), place(3, 'city', 'Другой')], 'Х'),
    ).toEqual({
      lat: 47,
      lon: 19,
    });
  });

  it('не найден / два одинаковых — ошибка', () => {
    expect(() => pickPlace([], 'Х')).toThrow(/не найден/);
    expect(() => pickPlace([place(1, 'town'), place(2, 'town')], 'Х')).toThrow(/несколько/);
  });

  it('placesFromGeojsonSeq берёт только точки-узлы', () => {
    const seq = [
      feature(
        { type: 'Point', coordinates: [19.6, 44.9] },
        { '@type': 'node', '@id': 7, place: 'city', name: 'Х' },
      ),
      feature(
        { type: 'Polygon', coordinates: [] },
        { '@type': 'way', '@id': 8, place: 'city', name: 'Х' },
      ),
    ].join('\n');
    expect(placesFromGeojsonSeq(seq)).toEqual([
      { type: 'node', id: 7, lat: 44.9, lon: 19.6, tags: { place: 'city', name: 'Х' } },
    ]);
  });
});

it('bboxAround: 5 км вокруг центра', () => {
  expect(bboxAround(44.9685558, 19.6083864, 5000)).toBe('19.544901,44.923640,19.671872,45.013471');
});

function hasOsmium(): boolean {
  try {
    execFileSync('osmium', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Настоящий конвейер osmium на крошечном .osm (XML) — без выгрузки Сербии. */
describe.skipIf(!hasOsmium())('gazetteerFromPbf через osmium', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bgq-osmium-test-'));
  const osm = join(dir, 'tiny.osm');
  writeFileSync(
    osm,
    `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test" timestamp="2026-10-15T20:21:00Z">
  <bounds minlat="44.9" minlon="19.5" maxlat="45.1" maxlon="19.7"/>
  <node id="1" version="1" lat="44.9685558" lon="19.6083864">
    <tag k="place" v="city"/><tag k="name" v="Тестоград"/>
  </node>
  <node id="2" version="1" lat="44.9700" lon="19.6100"/>
  <node id="3" version="1" lat="44.9710" lon="19.6110"/>
  <node id="4" version="1" lat="44.9705" lon="19.6105">
    <tag k="addr:street" v="Водна"/><tag k="addr:housenumber" v="45"/>
  </node>
  <node id="5" version="1" lat="45.0900" lon="19.6900">
    <tag k="addr:street" v="Далёкая"/><tag k="addr:housenumber" v="1"/>
  </node>
  <way id="10" version="1">
    <nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="residential"/><tag k="name" v="Водна"/><tag k="name:sr-Latn" v="Vodna"/>
  </way>
</osm>
`,
  );
  const gaz = gazetteerFromPbf(osm, 'Тестоград', 5000, new Date('2026-10-16T12:00:00Z'));

  it('улицы и адреса в радиусе, источник geofabrik', () => {
    expect(gaz).toMatchObject({
      source: 'geofabrik',
      city: 'Тестоград',
      radiusM: 5000,
      fetchedAt: '2026-10-16T12:00:00Z',
      streets: [{ name: 'Водна', aliases: ['Vodna'], center: [44.9705, 19.6105] }],
      addresses: [['Водна', '45', 44.9705, 19.6105]],
    });
  });

  it('неизвестный город — понятная ошибка', () => {
    expect(() => gazetteerFromPbf(osm, 'Нигдеград', 5000)).toThrow(/не найден/);
  });
});
