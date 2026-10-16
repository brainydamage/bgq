import { foldLookalikes } from '@bgq/core';

/** Сербская кириллица → латиница без диакритики (č/ć → c, š → s, ž → z, đ → dj). */
const SR_CYR_TO_LAT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  ђ: 'dj',
  е: 'e',
  ж: 'z',
  з: 'z',
  и: 'i',
  ј: 'j',
  к: 'k',
  л: 'l',
  љ: 'lj',
  м: 'm',
  н: 'n',
  њ: 'nj',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  ћ: 'c',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'c',
  џ: 'dz',
  ш: 's',
  // Русские буквы — организаторы пишут адреса по-русски: «Старый Шор», «Савы».
  ы: 'i',
  й: 'j',
  э: 'e',
  ё: 'e',
  я: 'ja',
  ю: 'ju',
  щ: 'sc',
  ъ: '',
  ь: '',
};

/** Тип улицы — отбрасываем: «Улица Светог Стефана» в Notion ↔ «Трг Светог Стефана» в OSM. */
const STREET_TYPE_WORDS = new Set(['ulica', 'ul', 'trg', 'bulevar', 'dom']);

/** Латиница без диакритики, нижний регистр. */
export function toAsciiLatin(text: string): string {
  const lower = foldLookalikes(text).toLowerCase();
  let out = '';
  for (const ch of lower) out += SR_CYR_TO_LAT[ch] ?? ch;
  // NFD раскладывает «č» на «c» + диакритический знак (категория Unicode M) — знаки убираем.
  return out.replace(/đ/g, 'dj').normalize('NFD').replace(/\p{M}/gu, '');
}

/** Имя файла для города: «Сремска Митровица» → «sremska-mitrovica». */
export function citySlug(city: string): string {
  return toAsciiLatin(city)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Ключ улицы для сравнения: латиница, без типа улицы и пунктуации. */
export function streetKey(name: string): string {
  return toAsciiLatin(name)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !STREET_TYPE_WORDS.has(w))
    .join(' ');
}

/** Ключ номера дома: "16А" / "16a" / "16 A" → "16a". */
export function houseKey(house: string): string {
  return toAsciiLatin(house).replace(/\s+/g, '');
}
