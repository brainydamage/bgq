export type LineKind = 'blank' | 'heading' | 'bold' | 'text';

export interface Line {
  /** Номер строки в файле, с 1. */
  no: number;
  raw: string;
  kind: LineKind;
  /** Нормализованный текст; для heading/bold — без маркеров и без `**`. */
  text: string;
}

/** NFC, неразрывные/нулевые пробелы → обычные, схлопывание пробелов, trim. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[   \t]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function stripBold(s: string): string {
  return normalizeText(s.replace(/\*\*/g, ''));
}

const HEADING = /^(#{1,6})\s+(.*)$/;
/** Вся строка в `**…**`; внутри могут быть ещё `**` (разметка внутри слова: `Виш**њ**ића`). */
const BOLD = /^\*\*(.+)\*\*$/;

export function splitLines(md: string): Line[] {
  return md.split(/\r?\n/).map((raw, i) => {
    const norm = normalizeText(raw);
    const no = i + 1;
    if (!norm) return { no, raw, kind: 'blank', text: '' };
    const h = HEADING.exec(norm);
    if (h) return { no, raw, kind: 'heading', text: stripBold(h[2] ?? '') };
    const b = BOLD.exec(norm);
    if (b) return { no, raw, kind: 'bold', text: stripBold(b[1] ?? '') };
    return { no, raw, kind: 'text', text: norm };
  });
}
