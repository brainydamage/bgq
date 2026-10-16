/** Латинские буквы, которые в кириллическом слове почти наверняка опечатка раскладки. */
const LATIN_TO_CYR: Record<string, string> = {
  a: 'а',
  c: 'с',
  e: 'е',
  j: 'ј',
  o: 'о',
  p: 'р',
  x: 'х',
  y: 'у',
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  J: 'Ј',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
};

const CYR = /\p{Script=Cyrillic}/u;
const LAT = /\p{Script=Latin}/u;

/**
 * Заменяет латинские двойники на кириллицу только в словах со смесью алфавитов:
 * "Пиjаца" → "Пијаца", "Матje" → "Матје"; "La Gioia" не трогает.
 * Для поиска/геокодинга — исходный текст не меняем.
 */
export function foldLookalikes(text: string): string {
  return text.replace(/\p{L}+/gu, (word) =>
    CYR.test(word) && LAT.test(word)
      ? [...word].map((ch) => LATIN_TO_CYR[ch] ?? ch).join('')
      : word,
  );
}
