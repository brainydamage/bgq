import {
  type AnswerKind,
  type Game,
  isEligible,
  type Kp,
  type KpNote,
  type Link,
  parseKpId,
  pointsFor,
} from '@bgq/core';
import { ADDRESS_LINE, parseAddress } from './address.ts';
import { classifyLink, extractLinks, extractStruck, trimSeparators } from './inline.ts';
import { type Line, splitLines, stripBold } from './lines.ts';
import type { Finish, Issue } from './types.ts';

/** "64 Улица…", "25А Памятник", "93 - Только для Вело". Буква — только сразу за числом. */
const KP_HEADER = /^(\d{1,3}\p{L}?)(?=$|[\s\-–—.,:)])\s*(.*)$/u;
/** Первый жирный блок экспорта — дата игры, не КП. */
const DATE =
  /^\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*(?:\s+\d{4})?$/iu;
const FINISH = /^финиш(?!\p{L})/iu;
const NOTE = /\s*[-–—]?\s*только\s+для\s+(.+?)\s*$/iu;
const EXTRA_PHOTO = /^\+\s*(.+)$/u;

export interface KpHeader {
  idRaw: string;
  rest: string;
}

export function matchKpHeader(text: string): KpHeader | null {
  if (DATE.test(text)) return null;
  const m = KP_HEADER.exec(text);
  if (!m?.[1]) return null;
  return { idRaw: m[1], rest: m[2] ?? '' };
}

interface KpSection extends KpHeader {
  type: 'kp';
  header: Line;
  body: Line[];
  raw: Line[];
}

interface FinishSection {
  type: 'finish';
  header: Line;
  body: Line[];
  raw: Line[];
}

type Section = KpSection | FinishSection;

export interface ParseOutput {
  kps: Kp[];
  finish?: Finish;
  issues: Issue[];
  sourceLines: Record<string, number>;
  preambleLines: number;
}

/**
 * Notion-markdown → КП. Построчный автомат: заголовок КП — жирная строка или заголовок `#`,
 * начинающиеся с номера. Если таких нет совсем (текст скопирован из браузера без разметки),
 * заголовком считается любая строка, начинающаяся с номера.
 */
export function parseNotion(md: string, game: Game): ParseOutput {
  const lines = splitLines(md);
  const marked = lines.some(
    (l) => (l.kind === 'bold' || l.kind === 'heading') && matchKpHeader(l.text),
  );
  const isCandidate = (l: Line) =>
    marked ? l.kind === 'bold' || l.kind === 'heading' : l.kind !== 'blank';

  const issues: Issue[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  let state: 'preamble' | 'kp' | 'finish' | 'unknown' = 'preamble';
  let preambleLines = 0;

  for (const l of lines) {
    if (l.kind === 'blank') {
      current?.raw.push(l);
      continue;
    }
    if (isCandidate(l)) {
      const h = matchKpHeader(l.text);
      if (h) {
        current = { type: 'kp', header: l, ...h, body: [], raw: [l] };
        sections.push(current);
        state = 'kp';
        continue;
      }
      if (state !== 'finish' && FINISH.test(l.text)) {
        current = { type: 'finish', header: l, body: [], raw: [l] };
        sections.push(current);
        state = 'finish';
        continue;
      }
      if (l.kind === 'heading' && state !== 'preamble') {
        current = null;
        state = 'unknown';
        issues.push({
          severity: 'critical',
          code: 'unknown_section',
          line: l.no,
          message: `Неизвестный раздел «${l.text}» — его строки не попали ни в один КП`,
        });
        continue;
      }
    }
    if (state === 'preamble') {
      preambleLines++;
      continue;
    }
    if (state === 'unknown' || !current) {
      issues.push({
        severity: 'critical',
        code: 'unknown_section',
        line: l.no,
        message: `Строка вне КП: «${l.text}»`,
      });
      continue;
    }
    current.body.push(l);
    current.raw.push(l);
    if (marked && current.type === 'kp' && l.kind === 'text' && matchKpHeader(l.text)) {
      issues.push({
        severity: 'critical',
        code: 'possible_missed_header',
        line: l.no,
        message: `Строка начинается с номера, но не жирная — пропущенный КП? «${l.text}»`,
      });
    }
  }

  const kps: Kp[] = [];
  const sourceLines: Record<string, number> = {};
  let finish: Finish | undefined;
  for (const s of sections) {
    if (s.type === 'finish') {
      finish = buildFinish(s, issues);
      continue;
    }
    const kp = buildKp(s, game, issues);
    if (!kp) continue;
    const firstLine = sourceLines[kp.id];
    if (firstLine !== undefined) {
      let n = 2;
      while (sourceLines[`${kp.id}#${n}`] !== undefined) n++;
      const dupId = `${kp.id}#${n}`;
      issues.push({
        severity: 'critical',
        code: 'duplicate_id',
        kpId: kp.id,
        line: s.header.no,
        message: `Дубль id ${kp.id} (первый — строка ${firstLine}); сохранён как ${dupId}`,
      });
      kp.id = dupId;
    }
    sourceLines[kp.id] = s.header.no;
    kps.push(kp);
  }

  return { kps, ...(finish && { finish }), issues, sourceLines, preambleLines };
}

function buildKp(s: KpSection, game: Game, issues: Issue[]): Kp | null {
  const parsed = parseKpId(s.idRaw);
  if (!parsed) {
    issues.push({
      severity: 'critical',
      code: 'bad_kp_id',
      line: s.header.no,
      message: `Не разобран номер КП «${s.idRaw}»`,
    });
    return null;
  }

  const urls: string[] = [];
  const head = extractLinks(s.rest);
  urls.push(...head.urls);
  let title = head.text;

  let note: KpNote | undefined;
  const n = NOTE.exec(title);
  if (n?.[1]) {
    title = title.slice(0, n.index);
    const v = n[1].toLowerCase();
    const velo = v.includes('вело');
    const pro = /(^|[^\p{L}])про($|[^\p{L}])/u.test(v);
    if (velo && !pro) note = 'velo_only';
    else if (pro && !velo) note = 'pro_only';
    else if (!(velo && pro)) {
      issues.push({
        severity: 'critical',
        code: 'unknown_note',
        kpId: parsed.id,
        line: s.header.no,
        message: `Непонятная пометка категории «только для ${n[1]}»`,
      });
    }
  }
  title = trimSeparators(title);

  const description: string[] = [];
  const struck: string[] = [];
  const photos: string[] = [];
  for (const l of s.body) {
    const st = extractStruck(l.kind === 'text' ? stripBold(l.text) : l.text);
    struck.push(...st.struck);
    if (!st.text) continue;
    const ph = EXTRA_PHOTO.exec(st.text);
    if (ph?.[1]) {
      photos.push(ph[1]);
      continue;
    }
    const lk = extractLinks(st.text);
    urls.push(...lk.urls);
    if (lk.text) description.push(lk.text);
  }
  // «93 - Только для Вело»: в заголовке только номер — название берём из первой строки.
  if (!title && description.length) title = description.shift() ?? '';

  let address = parseAddress(title) ?? undefined;
  if (!address) {
    for (const d of description) {
      if (!ADDRESS_LINE.test(d)) continue;
      address = parseAddress(d) ?? undefined;
      if (address) break;
    }
  }

  const links: Link[] = [...new Set(urls)].map((url) => ({ url, kind: classifyLink(url) }));

  if (!description.length) {
    issues.push({
      severity: 'cosmetic',
      code: 'empty_body',
      kpId: parsed.id,
      line: s.header.no,
      message: 'У КП нет описания',
    });
  }

  const raw = s.raw
    .map((l) => l.raw)
    .join('\n')
    .trimEnd();

  return {
    id: parsed.id,
    number: parsed.number,
    kind: 'classic',
    points: pointsFor(parsed.number, game.pointsRule),
    ...(note && { note }),
    eligible: isEligible({ note }, game),
    title,
    ...(address && { address }),
    description,
    struck,
    ...(photos.length ? { extraPhoto: photos.join('\n') } : {}),
    links,
    answerKind: detectAnswerKind(title, description, links),
    raw,
  };
}

function detectAnswerKind(title: string, description: string[], links: Link[]): AnswerKind {
  const all = [title, ...description].join('\n');
  if (/судь/iu.test(all)) return 'judge';
  if (links.some((l) => l.kind === 'video')) return 'video';
  if (/перерисуй/iu.test(all)) return 'drawing';
  if (description.some((d) => /^фото(?!\p{L})/iu.test(d))) return 'photo';
  return 'text';
}

function buildFinish(s: FinishSection, issues: Issue[]): Finish {
  const place = s.header.text.replace(/^финиш\.?\s*/iu, '');
  const body = s.body.map((l) => l.text).join(' ');
  const f: Finish = { place, line: s.header.no };

  const addr = /(?:улица|ул\.|булевар)\s.*$/iu.exec(place);
  if (addr) f.address = addr[0];
  const dl = /до\s+(\d{1,2})[:.](\d{2})/u.exec(body);
  if (dl?.[1] && dl[2]) f.deadline = `${dl[1].padStart(2, '0')}:${dl[2]}`;
  const gr = /опоздать\s+на\s+(полчаса|час|(\d+)\s*мин)/iu.exec(body);
  if (gr?.[1]) f.graceMin = gr[2] ? Number(gr[2]) : gr[1].toLowerCase() === 'час' ? 60 : 30;
  const pn = /(\d+)\s*минут\p{L}*\s*=\s*[-−–]?\s*(\d+(?:[.,]\d+)?)\s*балл/iu.exec(body);
  if (pn?.[1] && pn[2]) f.penaltyPerMin = Number(pn[2].replace(',', '.')) / Number(pn[1]);

  for (const field of ['address', 'deadline', 'graceMin', 'penaltyPerMin'] as const) {
    if (f[field] === undefined) {
      issues.push({
        severity: 'cosmetic',
        code: 'finish_field_missing',
        line: s.header.no,
        message: `Финиш: не найдено «${field}» — берём из game.json`,
      });
    }
  }
  return f;
}
