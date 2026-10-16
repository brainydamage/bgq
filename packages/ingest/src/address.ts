import type { Address } from '@bgq/core';

/** Номер дома: 98, 16А, 9А, 16-20, 38-42. */
const HOUSE = String.raw`(\d+\p{L}?(?:\s*[-–/]\s*\d+\p{L}?)?)`;
const STREET_HOUSE = new RegExp(String.raw`^(.*?\p{L}.*?)\s+(?:дом\s+|д\.\s*)?${HOUSE}$`, 'u');
const TRAILING_PARENS = /\s*\(([^()]*\d[^()]*)\)\s*$/u;
/** Улица без номера: «Батутова улица», «Улица Х». «Поворот Илирской улицы» — не адрес. */
const STREET_ONLY = /^улица\s+\S|\s+улица$/iu;
/** Строка тела КП, которую стоит пробовать как адрес (КП 120: адрес не в заголовке). */
export const ADDRESS_LINE = /^(?:улица|ул\.|булевар)\s/iu;

/**
 * Разбирает адрес из заголовка/строки. Исходник сохраняется в raw как есть.
 * Возвращает null, если строка не похожа на адрес.
 */
export function parseAddress(input: string): Address | null {
  const raw = input.trim();
  if (!raw || raw.length > 80 || /https?:\/\//.test(raw)) return null;

  // «Вишњића98» → «Вишњића 98»
  let s = raw.replace(/(\p{L})(\d)/gu, '$1 $2');
  let alt: string | undefined;
  const p = TRAILING_PARENS.exec(s);
  if (p?.[1]) {
    alt = p[1].trim();
    s = s.slice(0, p.index).trim();
  }

  const m = STREET_HOUSE.exec(s);
  let street: string;
  let house: string | null;
  if (m?.[1] && m[2]) {
    street = m[1].replace(/\s+дом$/u, '').trim();
    house = m[2].replace(/\s+/g, '');
  } else if (alt || STREET_ONLY.test(s)) {
    street = s;
    house = null;
  } else {
    return null;
  }
  return alt ? { raw, street, house, alt } : { raw, street, house };
}
