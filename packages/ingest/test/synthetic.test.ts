import type { Game } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import { formatSummary, ingest, parseAddress } from '../src/index.ts';
import { codes, kpOf } from './helpers.ts';

const game: Game = {
  id: 'test',
  city: 'Тест',
  date: '2026-01-01',
  tz: 'Europe/Belgrade',
  start: { time: '10:30' },
  finish: { deadline: '19:30', graceMin: 30, penaltyPerMin: 1 },
  category: 'pro',
  mode: 'foot',
  allowedColors: ['red', 'blue'],
  pointsRule: { kind: 'floor_div', divisor: 10 },
};

const run = (md: string, overrides?: string) =>
  ingest({ md, game, ...(overrides !== undefined && { overrides }) });

describe('нормализация', () => {
  it('NBSP в заголовке и адресе', () => {
    const r = run('**10 Улица Водна 45**\n\nВопрос');
    expect(kpOf(r, '10').address).toMatchObject({ street: 'Улица Водна', house: '45' });
  });

  it('латинская буква в номере → кириллическая', () => {
    const r = run('**25A Памятник**\n\nВопрос');
    expect(kpOf(r, '25А').points).toBe(2);
  });

  it('зачёркнутое внутри строки', () => {
    const k = kpOf(run('**12 Родник**\n\nВопрос ~~старый~~ новый'), '12');
    expect(k.description).toEqual(['Вопрос новый']);
    expect(k.struck).toEqual(['старый']);
  });

  it('«только для ПРО и Вело» — без ограничения и без ошибки', () => {
    const r = run('**98 Дом 22 - только для ПРО и Вело**\n\nГод');
    expect(kpOf(r, '98').note).toBeUndefined();
    expect(codes(r, 'critical')).toEqual([]);
  });
});

describe('критичные проблемы', () => {
  it('дубль id: второй сохраняется как 15#2, с номером строки', () => {
    const r = run('**15 Улица А 1**\n\nX\n\n**15 Улица Б 2**\n\nY');
    expect(r.kps.map((k) => k.id)).toEqual(['15', '15#2']);
    expect(r.issues[0]).toMatchObject({ severity: 'critical', code: 'duplicate_id', line: 5 });
  });

  it('неизвестный раздел после КП', () => {
    const r = run('**15 Улица А 1**\n\nX\n\n## Бонусные КП\n\nкакой-то текст');
    expect(codes(r, 'critical')).toEqual(['unknown_section', 'unknown_section']);
    expect(kpOf(r, '15').description).toEqual(['X']);
  });

  it('непонятная пометка категории', () => {
    const r = run('**42 Мост - только для Семейной**\n\nВопрос');
    expect(codes(r, 'critical')).toEqual(['unknown_note']);
  });

  it('строка с номером без жирного внутри КП — возможно потерянный заголовок', () => {
    const r = run('**42 Мост**\n\nВопрос\n\n43 Памятник перед домом\n\nСумма чисел');
    expect(r.issues[0]).toMatchObject({ code: 'possible_missed_header', line: 5 });
  });

  it('неразбираемый номер', () => {
    expect(codes(run('**15D Мост**\n\nВопрос'), 'critical')).toEqual(['bad_kp_id', 'no_kps']);
  });

  it('пустой файл', () => {
    const r = run('');
    expect(codes(r, 'critical')).toEqual(['no_kps']);
    expect(codes(r, 'cosmetic')).toEqual(['finish_missing']);
  });
});

describe('overrides', () => {
  const md = '**41 Мост**\n\nВопрос\n\n**99 Судья**\n\nЗадание судьи';

  it('неизвестный id — критично', () => {
    expect(codes(run(md, '77: { window: { from: "14:00", to: "18:00" } }'), 'critical')).toEqual([
      'override_unknown_id',
    ]);
  });

  it('значение не по схеме — критично, с указанием поля', () => {
    const r = run(md, '99: { window: { from: "2pm", to: "18:00" } }');
    expect(r.issues[0]).toMatchObject({ code: 'schema_invalid', kpId: '99', line: 5 });
    expect(r.issues[0]?.message).toContain('/window/from');
  });

  it('цвет кружка пересчитывает доступность', () => {
    const r = run(md, '41: { mapColor: green }');
    expect(kpOf(r, '41').eligible).toBe(false);
    expect(r.stats.points).toBe(9);
  });

  it('смена номера пересчитывает баллы', () => {
    expect(kpOf(run(md, '41: { number: 47 }'), '41').points).toBe(4);
  });

  it('id менять нельзя; битый YAML — критично', () => {
    expect(codes(run(md, '41: { id: "42" }'), 'critical')).toEqual(['override_invalid']);
    expect(codes(run(md, '41: { window: '), 'critical')).toEqual(['override_invalid']);
  });
});

describe('parseAddress', () => {
  it.each([
    ['Улица Краља Петра I дом 107', 'Улица Краља Петра I', '107'],
    ['Улица Филипа Вишњића98', 'Улица Филипа Вишњића', '98'],
    ['Фрушкогорска улица 8', 'Фрушкогорска улица', '8'],
    ['Улица Жртва Фашизма 16-20', 'Улица Жртва Фашизма', '16-20'],
  ])('%s', (input, street, house) => {
    expect(parseAddress(input)).toEqual({ raw: input, street, house });
  });

  it.each([
    'Родник',
    'Поворот Илирской улицы',
    'Руины базилики святого Димитрия (за стеклом)',
    'Встаньте к крышке https://youtu.be/x 1',
  ])('не адрес: %s', (input) => {
    expect(parseAddress(input)).toBeNull();
  });
});

describe('formatSummary', () => {
  it('статистика, критичные с файлом:строкой, косметика числом', () => {
    const r = run('**15 Улица А 1**\n\nX\n\n**15 Улица Б 2**');
    expect(formatSummary(r, 'export.md')).toBe(
      [
        '2 КП · доступно 2 · баллов 2 · с номером дома 2 · со ссылкой на карту 0',
        '✗ критичных: 1',
        '  ✗ duplicate_id [15] Дубль id 15 (первый — строка 1); сохранён как 15#2 — export.md:5',
        '△ косметика: 2 — подробности в report.json',
      ].join('\n'),
    );
  });
});
