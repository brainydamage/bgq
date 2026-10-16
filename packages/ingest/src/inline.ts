import type { Link } from '@bgq/core';
import { normalizeText } from './lines.ts';

const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s)]+/g;
/** «Заброшенное здание - ссылка», «Место -» — подписи ссылок без смысла. */
const TRAILING_GENERIC = /\s*[-–—:]\s*(?:ссылка|ссылке|ссылку|место)\s*$/iu;
const GENERIC_ONLY = /^(?:ссылка|ссылке|ссылку|место)$/iu;

export function trimSeparators(s: string): string {
  return s.replace(/^[\s\-–—:]+/, '').replace(/[\s\-–—:]+$/, '');
}

/**
 * Достаёт ссылки (markdown и голые URL) и чистит текст:
 * "[Место](u) - u" → "" ; "по [ссылке](u): u" → "по ссылке".
 */
export function extractLinks(text: string): { text: string; urls: string[] } {
  const urls: string[] = [];
  let t = text.replace(MD_LINK, (_m, label: string, url: string) => {
    urls.push(url);
    return label;
  });
  t = t.replace(BARE_URL, (url) => {
    urls.push(url);
    return '';
  });
  t = trimSeparators(normalizeText(t).replace(TRAILING_GENERIC, ''));
  if (GENERIC_ONLY.test(t)) t = '';
  return { text: t, urls };
}

export function classifyLink(url: string): Link['kind'] {
  if (
    /maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps|maps\.google\.|openstreetmap\.org|osm\.org|omaps\.app/i.test(
      url,
    )
  ) {
    return 'maps';
  }
  if (/youtu\.be|youtube\.com|vimeo\.com/i.test(url)) return 'video';
  return 'other';
}

/** Зачёркнутое `~~…~~`: возвращает текст без него и список зачёркнутых фрагментов. */
export function extractStruck(text: string): { text: string; struck: string[] } {
  const struck: string[] = [];
  const t = text.replace(/~~(.+?)~~/g, (_m, s: string) => {
    struck.push(normalizeText(s));
    return '';
  });
  return { text: normalizeText(t), struck };
}
