/** Латинские двойники кириллических букв в суффиксе номера: "25A" ≡ "25А". */
const SUFFIX_LATIN_TO_CYR: Record<string, string> = {
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
  Y: 'У',
};

const NUMBERED = /^(\d{1,3})(\p{L})?$/u;
const SLUG = /^[a-z][a-z0-9-]*$/;

export interface ParsedKpId {
  id: string;
  number: number;
  /** Кириллическая заглавная буква или "". */
  suffix: string;
}

/** "25а" / "25A" / "25А" → { id: "25А", number: 25, suffix: "А" }. Неизвестная латинская буква → null. */
export function parseKpId(input: string): ParsedKpId | null {
  const m = NUMBERED.exec(input.trim());
  if (!m?.[1]) return null;
  const number = Number(m[1]);
  let suffix = (m[2] ?? '').toUpperCase();
  suffix = SUFFIX_LATIN_TO_CYR[suffix] ?? suffix;
  if (suffix && !/^[А-ЯЁ]$/.test(suffix)) return null;
  return { id: `${number}${suffix}`, number, suffix };
}

/** Канонический id: номерной КП или slug задания без номера; иначе null. */
export function normalizeKpId(input: string | number): string | null {
  const s = String(input).trim();
  if (SLUG.test(s)) return s;
  return parseKpId(s)?.id ?? null;
}
