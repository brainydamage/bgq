import { foldLookalikes } from '@bgq/core';
import { describe, expect, it } from 'vitest';
import { applyOverrides, ingest } from '../src/index.ts';
import { codes, fixtureGame, fixtureMd, fixtureOverrides, kpOf } from './helpers.ts';

const result = ingest({ md: fixtureMd, game: fixtureGame });
const kp = (id: string) => kpOf(result, id);

// biome-ignore format: список номеров читается построчно по десяткам
const EXPECTED_IDS = [
  '10', '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '20', '21', '22', '23', '24', '25', '25А', '26', '27', '28', '29',
  '30', '31', '32', '33', '34', '35', '36', '37', '38', '39',
  '40', '41', '42', '43', '44', '45', '46', '47', '47А', '48', '49',
  '50', '51', '52', '53', '54', '55', '56', '57', '58', '59',
  '61', '63', '64', '65', '65А', '66', '68', '69',
  '70', '71', '71Б', '72', '75А', '76', '79', '79А',
  '81', '82', '83', '85', '86', '88', '93', '94', '97', '99', '101', '120', '110',
];

describe('экспорт 10.10 целиком', () => {
  it('81 КП в порядке документа, без дублей', () => {
    expect(result.kps.map((k) => k.id)).toEqual(EXPECTED_IDS);
  });

  it('статистика', () => {
    expect(result.stats).toEqual({
      kps: 81,
      eligible: 77,
      points: 338,
      withHouseNumber: 34,
      withMapsLink: 4,
      preambleLines: 6,
    });
  });

  it('нет критичных; косметика — только пустое тело 79А', () => {
    expect(codes(result, 'critical')).toEqual([]);
    expect(result.issues).toEqual([
      {
        severity: 'cosmetic',
        code: 'empty_body',
        kpId: '79А',
        line: 401,
        message: 'У КП нет описания',
      },
    ]);
  });

  it('пометки категорий: Вело — 93, 94, 101, 110; ПРО — 41', () => {
    const byNote = (n: string) => result.kps.filter((k) => k.note === n).map((k) => k.id);
    expect(byNote('velo_only')).toEqual(['93', '94', '101', '110']);
    expect(byNote('pro_only')).toEqual(['41']);
    expect(result.kps.filter((k) => !k.eligible).map((k) => k.id)).toEqual([
      '93',
      '94',
      '101',
      '110',
    ]);
  });

  it('снапшот всего результата', () => {
    expect(result).toMatchSnapshot();
  });
});

describe('ловушки из брифа', () => {
  it('1. «**10 октября 2026**» и жирная преамбула — не КП', () => {
    expect(result.kps[0]?.id).toBe('10');
    expect(result.sourceLines['10']).toBe(13);
  });

  it('2. разметка внутри слова: «Виш**њ**ића98»', () => {
    expect(kp('64').address).toEqual({
      raw: 'Улица Филипа Вишњића98',
      street: 'Улица Филипа Вишњића',
      house: '98',
    });
  });

  it('4. латиница в кириллице: исходник сохраняется, свёртка — для поиска', () => {
    const street28 = kp('28').address?.street ?? '';
    const street30 = kp('30').address?.street ?? '';
    expect(street28).toBe('Улица Житна Пиjаца');
    expect(foldLookalikes(street28)).toBe('Улица Житна Пијаца');
    expect(foldLookalikes(street30)).toBe('Улица Стамбело насеље Матје Хуђи');
  });

  it('5. пометки категорий снимаются с заголовка', () => {
    expect(kp('93').title).toBe('Центральные ворота Ипподрома (со стороны улицы)');
    expect(kp('94').title).toBe('Церковь');
    expect(kp('101').title).toBe('Церковь');
    expect(kp('110').title).toBe('Заброшенное здание');
    expect(kp('41').title).toBe('Конец старого моста через Саву. Держите детей за руку!');
  });

  it('6. зачёркнутое — отдельно от описания', () => {
    expect(kp('50').struck).toEqual(['Какой аксессуар присутствует в ипровизированном памятнике']);
    expect(kp('50').description).toEqual([
      'Название школы над входом',
      'Какая буква стала бирюзовой?',
    ]);
  });

  it('7. ссылки: дубли схлопнуты, тип определён, текст очищен', () => {
    for (const id of ['93', '94', '101', '110']) {
      expect(kp(id).links).toHaveLength(1);
      expect(kp(id).links[0]?.kind).toBe('maps');
    }
    expect(kp('93').description).toEqual(['Количество изображенных лошадей']);
    expect(kp('97').links).toEqual([{ url: 'https://youtu.be/d9XSFf3IJ5Q', kind: 'video' }]);
    expect(kp('97').title).toBe('Встаньте к крышке саркофага и откройти видео по ссылке');
  });

  it('8. «+ Сделайте фото…», включая опечатку «Сделйте»', () => {
    const ids = result.kps.filter((k) => k.extraPhoto).map((k) => k.id);
    expect(ids).toEqual(['65', '68', '76', '81', '85', '88', '93', '94', '101', '110']);
    expect(kp('93').extraPhoto).toBe(
      'Сделйте фото всей команды на фоне ипподрома. Не забудьте бейдж',
    );
  });

  it('9. блок финиша', () => {
    expect(result.finish).toEqual({
      place: 'Кафе La Gioia Улица Короля Петра Первого дом 15',
      address: 'Улица Короля Петра Первого дом 15',
      deadline: '19:30',
      graceMin: 30,
      penaltyPerMin: 1,
      line: 507,
    });
  });
});

describe('ловушки, найденные в фикстуре', () => {
  it('10. буквенные суффиксы', () => {
    const pts = Object.fromEntries(
      ['25А', '47А', '65А', '75А', '79А', '71Б'].map((id) => [id, kp(id).points]),
    );
    expect(pts).toEqual({ '25А': 2, '47А': 4, '65А': 6, '75А': 7, '79А': 7, '71Б': 7 });
  });

  it('11. двойной пробел в заголовке', () => {
    expect(kp('25').title).toBe('Чесма');
  });

  it('12. жирная строка внутри КП — тело, не новый КП', () => {
    expect(kp('99').description).toEqual(['Задание судьи']);
    expect(kp('99').answerKind).toBe('judge');
  });

  it('14. КП 120: адрес в теле, окна в Notion нет', () => {
    expect(kp('120').address).toEqual({
      raw: 'Улица Светог Стефана 29',
      street: 'Улица Светог Стефана',
      house: '29',
    });
    expect(kp('120').window).toBeUndefined();
  });

  it('15. порядок документа сохраняется (120 раньше 110)', () => {
    const ids = result.kps.map((k) => k.id);
    expect(ids.indexOf('120')).toBeLessThan(ids.indexOf('110'));
  });

  it('16–18. форматы адресов', () => {
    const a = (id: string) => {
      const { street, house, alt } = kp(id).address ?? {};
      return alt ? { street, house, alt } : { street, house };
    };
    expect(a('11')).toEqual({ street: 'Улица Краља Петра I', house: '24' });
    expect(a('38')).toEqual({ street: 'Улица Краља Петра I', house: '107' });
    expect(a('16')).toEqual({ street: 'Улица Жртва Фашизма', house: '16-20' });
    expect(a('51')).toEqual({ street: 'Улица Светог Димитрја', house: '38-42' });
    expect(a('39')).toEqual({
      street: 'Улица Стамбено Насеље Деканске Баште',
      house: null,
      alt: 'Водна 16А',
    });
    expect(a('21')).toEqual({ street: 'Пушкинова улица', house: '1' });
    expect(a('71Б')).toEqual({ street: 'Лале Станковића', house: '1' });
    expect(a('66')).toEqual({ street: 'Мачвански кеј', house: '77' });
    expect(a('58')).toEqual({ street: 'Улица Стевана Сремца', house: '9А' });
  });

  it('19. не адреса', () => {
    expect(kp('97').address).toBeUndefined();
    expect(kp('36').address).toBeUndefined();
    expect(kp('61').address?.house).toBeNull();
  });

  it('20. хвостовые пробелы', () => {
    expect(kp('79').description[0]).toBe('Верхний плакат - плакат теперь у забора');
  });

  it('тип ответа', () => {
    const kinds = Object.fromEntries(
      result.kps.filter((k) => k.answerKind !== 'text').map((k) => [k.id, k.answerKind]),
    );
    expect(kinds).toEqual({
      '33': 'photo',
      '65А': 'drawing',
      '82': 'drawing',
      '94': 'drawing',
      '97': 'video',
      '99': 'judge',
      '120': 'judge',
    });
  });
});

describe('устойчивость', () => {
  it('повторный запуск даёт тот же результат', () => {
    expect(ingest({ md: fixtureMd, game: fixtureGame })).toEqual(result);
  });

  it('overrides 10.10: окна 99 и 120; повторное применение ничего не меняет', () => {
    const withOv = ingest({ md: fixtureMd, game: fixtureGame, overrides: fixtureOverrides });
    expect(codes(withOv, 'critical')).toEqual([]);
    expect(kpOf(withOv, '99').window).toEqual({ from: '14:00', to: '18:00' });
    expect(kpOf(withOv, '120').window).toEqual({ from: '14:00', to: '18:00' });

    const before = structuredClone(withOv.kps);
    expect(applyOverrides(withOv.kps, fixtureOverrides, fixtureGame)).toEqual([]);
    expect(withOv.kps).toEqual(before);
  });

  it('текст, скопированный из браузера (без markdown): те же КП и баллы', () => {
    const plain = fixtureMd
      .replace(/\*\*/g, '')
      .replace(/~~/g, '')
      .replace(/^#+\s*/gm, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    const r = ingest({ md: plain, game: fixtureGame });
    expect(r.kps.map((k) => k.id)).toEqual(EXPECTED_IDS);
    expect(r.stats.eligible).toBe(77);
    expect(r.stats.points).toBe(338);
    expect(codes(r, 'critical')).toEqual([]);
    expect(r.finish?.deadline).toBe('19:30');
  });

  it('CRLF не меняет результат', () => {
    const r = ingest({ md: fixtureMd.replace(/\n/g, '\r\n'), game: fixtureGame });
    expect(r.kps.map(({ raw: _raw, ...k }) => k)).toEqual(
      result.kps.map(({ raw: _raw, ...k }) => k),
    );
  });
});
