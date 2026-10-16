import type { Kp } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  type Gazetteer,
  gazetteerFromOsm,
  geocodeKp,
  houseKey,
  type OsmElement,
  serializeGazetteer,
  similarity,
  streetKey,
  toAsciiLatin,
} from '../src/index.ts';

describe('нормализация', () => {
  it.each([
    ['Филипа Вишњића', 'filipa visnjica'],
    ['Žrtava Fašizma', 'zrtava fasizma'],
    ['Браће Ћулибрк', 'brace culibrk'],
    ['Караџића', 'karadzica'],
    ['Đorđa', 'djordja'],
    ['Старый Шор', 'starij sor'],
    ['Пиjаца', 'pijaca'], // латинская j в кириллическом слове
  ])('toAsciiLatin(%s) = %s', (input, expected) => {
    expect(toAsciiLatin(input)).toBe(expected);
  });

  it('тип улицы и «дом» не влияют на ключ', () => {
    expect(streetKey('Улица Светог Стефана')).toBe(streetKey('Трг Светог Стефана'));
    expect(streetKey('Булевар Константина Великог')).toBe('konstantina velikog');
    expect(streetKey('Пушкинова улица')).toBe('puskinova');
  });

  it('номер дома: регистр и алфавит буквы не важны', () => {
    expect(houseKey('16А')).toBe('16a');
    expect(houseKey('16a')).toBe('16a');
    expect(houseKey('16 A')).toBe('16a');
  });

  it('похожесть', () => {
    expect(similarity('stari sor', 'stari sor')).toBe(1);
    expect(similarity('starij sor', 'stari sor')).toBe(0.9);
    expect(similarity('', '')).toBe(1);
  });
});

const elements: OsmElement[] = [
  {
    type: 'way',
    id: 1,
    center: { lat: 45, lon: 19 },
    tags: { highway: 'residential', name: 'Ратарска', 'name:sr-Latn': 'Ratarska' },
  },
  {
    type: 'way',
    id: 2,
    center: { lat: 45.002, lon: 19 },
    tags: { highway: 'residential', name: 'Ратарска', old_name: 'Стара Ратарска' },
  },
  {
    type: 'node',
    id: 3,
    lat: 45.0001,
    lon: 19.0001,
    tags: { 'addr:street': 'Ратарска', 'addr:housenumber': '3' },
  },
  {
    type: 'way',
    id: 4,
    center: { lat: 45.0003, lon: 19.0001 },
    tags: { building: 'yes', 'addr:street': 'Ратарска', 'addr:housenumber': '7;9' },
  },
  {
    type: 'node',
    id: 5,
    lat: 45.1,
    lon: 19.1,
    tags: { 'addr:street': 'Вашарска', 'addr:housenumber': '1' },
  },
  {
    type: 'node',
    id: 6,
    lat: 45.1,
    lon: 19.1,
    tags: { 'addr:street': 'Вашарска', 'addr:housenumber': '1' },
  },
  { type: 'way', id: 7, tags: { highway: 'service' } },
];

const gaz = gazetteerFromOsm(elements, {
  source: 'geofabrik',
  city: 'Тест',
  radiusM: 1000,
  osmBase: '2026-10-16T00:00:00Z',
  fetchedAt: '2026-10-16T00:00:00Z',
});

describe('gazetteerFromOsm', () => {
  it('улицы склеиваются по названию; псевдонимы, центр', () => {
    expect(gaz.streets).toEqual([
      { name: 'Вашарска', aliases: [], center: [45.1, 19.1] },
      { name: 'Ратарска', aliases: ['Ratarska', 'Стара Ратарска'], center: [45.001, 19] },
    ]);
  });

  it('«7;9» — два адреса; дубли схлопываются; сортировка стабильна', () => {
    expect(gaz.addresses).toEqual([
      ['Вашарска', '1', 45.1, 19.1],
      ['Ратарска', '3', 45.0001, 19.0001],
      ['Ратарска', '7', 45.0003, 19.0001],
      ['Ратарска', '9', 45.0003, 19.0001],
    ]);
  });

  it('serializeGazetteer — валидный JSON, тот же справочник', () => {
    expect(JSON.parse(serializeGazetteer(gaz))).toEqual(gaz);
  });
});

function kp(id: string, street: string, house: string | null, alt?: string): Kp {
  return {
    id,
    number: Number.parseInt(id, 10),
    kind: 'classic',
    points: 1,
    eligible: true,
    title: '',
    address: { raw: '', street, house, ...(alt && { alt }) },
    description: [],
    struck: [],
    links: [],
    answerKind: 'text',
    raw: '',
  };
}

const g2: Gazetteer = {
  ...gaz,
  streets: [
    { name: 'Ратарска', aliases: [], center: [45, 19] },
    { name: 'Вашарска', aliases: [], center: [46, 20] },
    { name: 'Жртава фашизма', aliases: [], center: [45.5, 19.5] },
  ],
  addresses: [
    ['Ратарска', '3', 45.0003, 19],
    ['Ратарска', '7', 45.0007, 19],
    ['Ратарска', '9a', 45.0009, 19],
    ['Вашарска', '1', 46, 20],
    ['Жртава фашизма', '16', 45.5016, 19.5],
    ['Жртава фашизма', '17', 45.6, 19.6],
    ['Жртава фашизма', '18', 45.5018, 19.5],
  ],
};
const index = buildIndex(g2);

describe('geocodeKp', () => {
  it('точный номер; уверенность = метод × похожесть улицы', () => {
    expect(geocodeKp(kp('10', 'Улица Ратарска', '7'), index)).toMatchObject({
      method: 'exact',
      loc: { lat: 45.0007, lon: 19, source: 'geocode', confidence: 0.95 },
      matched: { street: 'Ратарска', score: 1, house: '7' },
    });
  });

  it('нет дома на лучшей улице — соседний дом там же, а не похожая улица', () => {
    const r = geocodeKp(kp('45', 'Улица Ратарска', '1'), index);
    expect(r).toMatchObject({
      method: 'interpolated',
      matched: { street: 'Ратарска', house: '3' },
    });
  });

  it('между соседними номерами — интерполяция', () => {
    const r = geocodeKp(kp('11', 'Ратарска', '5'), index);
    expect(r.method).toBe('interpolated');
    expect(r.loc?.lat).toBeCloseTo(45.0005, 6);
  });

  it('диапазон — только своя сторона улицы', () => {
    const r = geocodeKp(kp('16', 'Жртва Фашизма', '16-20'), index);
    expect(r).toMatchObject({ method: 'range', loc: { lat: 45.5017, lon: 19.5 } });
  });

  it('номер с буквой → без буквы', () => {
    expect(geocodeKp(kp('12', 'Ратарска', '9'), index).method).toBe('interpolated');
    expect(geocodeKp(kp('13', 'Ратарска', '7б'), index)).toMatchObject({
      method: 'house_base',
      matched: { house: '7' },
    });
  });

  it('адрес в скобках, если основной без номера', () => {
    const r = geocodeKp(kp('39', 'Стамбено насеље', null, 'Ратарска 3'), index);
    expect(r).toMatchObject({ method: 'exact', query: { street: 'Ратарска', house: '3' } });
  });

  it('только улица — центр улицы, низкая уверенность', () => {
    expect(geocodeKp(kp('61', 'Вашарска улица', null), index)).toMatchObject({
      method: 'street',
      loc: { lat: 46, lon: 20, confidence: 0.2 },
    });
  });

  it('нет адреса / улица не найдена', () => {
    const noAddress = { ...kp('12', '', null) };
    delete noAddress.address;
    expect(geocodeKp(noAddress, index)).toEqual({ id: '12', reason: 'no_address' });
    expect(geocodeKp(kp('14', 'Булевар Неизвестный', '5'), index)).toMatchObject({
      reason: 'street_not_found',
    });
  });
});
