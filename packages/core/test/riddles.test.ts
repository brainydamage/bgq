import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCoords, parseRiddleSheets, type Riddle, riddleToKp } from '../src/index.ts';

const sheets = readFileSync(
  join(import.meta.dirname, '../../../fixtures/2026-10-10/sheets.md'),
  'utf8',
);
const center = { lat: 44.97, lon: 19.61 };

describe('расшифровка листков → загадки', () => {
  const { riddles, skipped } = parseRiddleSheets(sheets);
  const byId = new Map(riddles.map((r) => [r.id, r]));

  it('10.10: 11 загадок, 4 задания и 2 фотозагадки с номером; без номера — пропущены', () => {
    expect(riddles.map((r) => r.id)).toEqual([
      '95',
      '96',
      '77А',
      '72А',
      '84',
      '98',
      '90',
      '62',
      '91',
      '73',
      '78',
      '92',
      '74',
      '60',
      '89',
      '67',
      '87',
    ]);
    expect(skipped).toEqual(['В мире животных', 'Письмо себе', 'Любовь это…', 'Моя чесма']);
  });

  it('название — после номера, текст — до следующего заголовка', () => {
    expect(byId.get('95')?.title).toBe('Загадка');
    expect(byId.get('72А')?.title).toBe('Полузагадка');
    expect(byId.get('96')?.text).toMatch(/^Между ними ровно пять\./);
    expect(byId.get('96')?.text).toMatch(/Какое имя встречается чаще всего\?$/);
    expect(byId.get('78')?.text).toContain('железнодорожного вокзала');
  });

  it('«**74** Посмотрите видео…» — текст на той же строке, название пустое', () => {
    expect(byId.get('74')?.title).toBe('');
    expect(byId.get('74')?.text).toMatch(/^Посмотрите видео/);
  });

  it('заголовки разделов и фотозадания списком не попадают в текст', () => {
    expect(byId.get('89')?.text).not.toContain('Фото всей команды');
    expect(byId.get('78')?.text).not.toContain('## Задания');
  });

  it('ответ ИИ: лишние пробелы, латинская буква, повтор блока', () => {
    const r = parseRiddleSheets('Вот текст:\n\n**25a Загадка**\nТекст\n\n**25А Загадка**\nПовтор');
    expect(r.riddles).toEqual([{ id: '25А', title: 'Загадка', text: 'Текст' }]);
  });
});

describe('координаты отгадки', () => {
  const ok = (s: string) => {
    const r = parseCoords(s, center);
    return r.ok ? [r.lat, r.lon] : r.error;
  };

  it('пара чисел: точка, запятая, пробел', () => {
    expect(ok('44.9714, 19.6101')).toEqual([44.9714, 19.6101]);
    expect(ok('44.9714 19.6101')).toEqual([44.9714, 19.6101]);
    expect(ok(' 44,9714 19,6101 ')).toEqual([44.9714, 19.6101]);
  });

  it('Google Maps: точка места (!3d!4d) важнее центра экрана (@)', () => {
    expect(
      ok(
        'https://www.google.com/maps/place/Crkva/@44.9700,19.6000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d44.9714!4d19.6101',
      ),
    ).toEqual([44.9714, 19.6101]);
    expect(ok('https://www.google.com/maps/@44.9714,19.6101,18z')).toEqual([44.9714, 19.6101]);
    expect(ok('https://maps.google.com/?q=44.9714,19.6101')).toEqual([44.9714, 19.6101]);
    expect(ok('https://www.google.com/maps/search/?api=1&query=44.9714%2C19.6101')).toEqual([
      44.9714, 19.6101,
    ]);
  });

  it('OpenStreetMap и geo:', () => {
    expect(ok('https://www.openstreetmap.org/#map=18/44.97140/19.61010')).toEqual([
      44.9714, 19.6101,
    ]);
    expect(
      ok('https://www.openstreetmap.org/?mlat=44.9714&mlon=19.6101#map=19/44.97/19.61'),
    ).toEqual([44.9714, 19.6101]);
    expect(ok('geo:44.9714,19.6101')).toEqual([44.9714, 19.6101]);
  });

  it('перепутанные широта и долгота — переставляем и говорим', () => {
    const r = parseCoords('19.6101, 44.9714', center);
    expect(r).toEqual({
      ok: true,
      lat: 44.9714,
      lon: 19.6101,
      note: 'широта и долгота были перепутаны — переставил',
    });
  });

  it('ошибки: короткая ссылка, адрес текстом, далеко от игры', () => {
    expect(ok('https://maps.app.goo.gl/AbCdEf123')).toMatch(/короткая ссылка/);
    expect(ok('Улица Светог Стефана 29')).toMatch(/не понял/);
    expect(parseCoords('45.2671, 19.8335', center)).toMatchObject({
      ok: true,
      note: expect.stringMatching(/в \d+ км от игры/),
    });
  });
});

describe('загадка → КП', () => {
  const game = { pointsRule: { kind: 'floor_div' as const, divisor: 10 } };
  const riddle = (over: Partial<Riddle>): Riddle => ({
    id: '96',
    title: 'Загадка',
    text: 'Между ними ровно пять.\nКаменный крест.',
    notes: '',
    updatedAt: '2026-10-10T10:40:00.000Z',
    ...over,
  });

  it('баллы по правилу, без отгадки — без координат', () => {
    const kp = riddleToKp(riddle({}), game);
    expect(kp).toMatchObject({ id: '96', number: 96, kind: 'riddle', points: 9, eligible: true });
    expect(kp.loc).toBeUndefined();
    expect(kp.description).toEqual(['Между ними ровно пять.', 'Каменный крест.']);
  });

  it('отгадка — координаты с source: manual', () => {
    const kp = riddleToKp(
      riddle({ answer: { lat: 44.97, lon: 19.61, raw: '44.97, 19.61' } }),
      game,
    );
    expect(kp.loc).toEqual({ lat: 44.97, lon: 19.61, source: 'manual', confidence: 0.95 });
  });

  it('«только для Вело» — недоступна; «только для ПРО и Вело» — доступна', () => {
    expect(riddleToKp(riddle({ title: 'Загадка — только для Вело' }), game).eligible).toBe(false);
    expect(riddleToKp(riddle({ title: 'Загадка — только для ПРО и Вело' }), game).eligible).toBe(
      true,
    );
    expect(riddleToKp(riddle({ id: '72А' }), game).points).toBe(7);
  });

  it('однозначный номер — сами баллы: «5А» фото у конины — 5 б', () => {
    expect(riddleToKp(riddle({ id: '5А', title: 'Конина' }), game).points).toBe(5);
    expect(riddleToKp(riddle({ id: '7' }), game).points).toBe(7);
    expect(riddleToKp(riddle({ id: '10' }), game).points).toBe(1);
  });
});
