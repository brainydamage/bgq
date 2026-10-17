// Вставка ответа ИИ из чата: «Копировать» кладёт в буфер оформленный текст (HTML), а в
// поле вставляется уже без звёздочек. Возвращаем разметку: жирное → «**…**», заголовки →
// «# …», пункты списка → «- …». Регулярками, без DOM — тестируется в Node.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML из буфера → текст с разметкой для «Разобрать»; null — оформления нет, берём как есть. */
export function htmlToSheetText(html: string): string | null {
  if (!/<(strong|b|h[1-6])[\s>]/i.test(html)) return null;
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h[1-6][^>]*>/gi, '\n\n# ')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<(strong|b)(\s[^>]*)?>/gi, '**')
    .replace(/<\/(strong|b)>/gi, '**')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|tr|blockquote|pre)>/gi, '\n\n')
    .replace(/<hr[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decode(text)
    .replace(/\*\*\s*\*\*/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
