// Загадки: разбор расшифровки листков, разбор координат отгадки, загадка → КП. Без DOM и Node.
import { parseKpId } from './ids.ts';
import { pointsFor } from './points.ts';
import type { Game } from './schema/game.ts';
import type { Kp, KpNote } from './schema/kp.ts';
import type { Riddle } from './schema/riddle.ts';

export interface ParsedRiddle {
  id: string;
  title: string;
  text: string;
}

export interface ParsedSheets {
  riddles: ParsedRiddle[];
  /** Заголовки без номера («В мире животных») — не места, в маршрут не идут. */
  skipped: string[];
}

/** Строка-заголовок: «**95 Загадка**», «**74** Посмотрите…», «**77А Загадка — см. врезку…**». */
const HEADER = /^\s*\*\*(.+?)\*\*\s*(.*)$/;
const NUMBERED = /^(\d{1,3}\s*[A-Za-zА-Яа-яЁё]?)(?=$|[\s.:—–-])\s*[.:—–-]?\s*(.*)$/;

/**
 * Расшифровка листков (ответ ИИ: «**<номер> <название>**», дальше текст) → загадки.
 * Заголовки без номера пропускаются; заголовки разделов «#» и пустые строки по краям — тоже.
 */
export function parseRiddleSheets(md: string): ParsedSheets {
  const riddles: ParsedRiddle[] = [];
  const skipped: string[] = [];
  let current: { id: string; title: string; lines: string[] } | null = null;
  const flush = () => {
    if (current) {
      riddles.push({ id: current.id, title: current.title, text: trimLines(current.lines) });
    }
    current = null;
  };

  for (const line of md.split(/\r?\n/)) {
    const h = HEADER.exec(line);
    if (h?.[1]) {
      const head = h[1].trim();
      const n = NUMBERED.exec(head);
      const id = n?.[1] ? parseKpId(n[1].replace(/\s+/g, ''))?.id : undefined;
      if (id) {
        flush();
        current = { id, title: (n?.[2] ?? '').trim(), lines: h[2] ? [h[2].trim()] : [] };
        continue;
      }
      // Жирная строка без номера посреди загадки — часть текста; в начале блока — пропуск.
      if (!current || /^[А-ЯЁA-Z]/.test(head)) {
        flush();
        skipped.push(head);
        continue;
      }
    }
    if (/^\s*#/.test(line)) {
      flush();
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return { riddles: dedupe(riddles), skipped };
}

function trimLines(lines: string[]): string {
  return lines.join('\n').trim();
}

/** Один номер дважды (ИИ повторил блок) — оставляем первый. */
function dedupe(riddles: ParsedRiddle[]): ParsedRiddle[] {
  const seen = new Set<string>();
  return riddles.filter((r) => !seen.has(r.id) && seen.add(r.id));
}

export interface LatLon {
  lat: number;
  lon: number;
}

export type CoordsResult =
  | { ok: true; lat: number; lon: number; note?: string }
  | { ok: false; error: string };

const NUM = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
/** Дальше от центра игры — подозрительно (граф города — 8 км). */
const FAR_M = 20_000;
const SHORT_LINK = /^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//i;

/**
 * Отгадка → точка. Понимает «44.9714, 19.6101», «44,9714 19,6101», geo:-ссылки, Google Maps
 * (!3d…!4d…, @lat,lon, q=/query=/ll=), OpenStreetMap (#map=z/lat/lon, mlat/mlon).
 * near — центр игры: перепутанные широту и долготу переставляем и говорим об этом.
 */
export function parseCoords(input: string, near?: LatLon): CoordsResult {
  const s = input.trim();
  if (!s) return { ok: false, error: 'пусто' };
  if (SHORT_LINK.test(s)) {
    return {
      ok: false,
      error: 'короткая ссылка — откройте её в браузере и скопируйте полную ссылку или координаты',
    };
  }
  const found = fromUrl(s) ?? fromPair(s);
  if (!found) {
    return {
      ok: false,
      error: 'не понял — нужны координаты «44.9714, 19.6101» или ссылка Google Maps / OSM',
    };
  }
  let { lat, lon } = found;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { ok: false, error: `координаты вне Земли: ${lat}, ${lon}` };
  }
  let note: string | undefined;
  if (near) {
    const far = distanceM({ lat, lon }, near) > FAR_M;
    if (far && Math.abs(lon) <= 90 && distanceM({ lat: lon, lon: lat }, near) <= FAR_M) {
      [lat, lon] = [lon, lat];
      note = 'широта и долгота были перепутаны — переставил';
    } else if (far) {
      note = `точка в ${Math.round(distanceM({ lat, lon }, near) / 1000)} км от игры — проверьте`;
    }
  }
  return { ok: true, lat: round6(lat), lon: round6(lon), ...(note && { note }) };
}

function fromUrl(s: string): LatLon | null {
  // OSM: метка (mlat/mlon) точнее центра экрана (#map=).
  const mlat = /[?&]mlat=(-?\d+(?:\.\d+)?)/.exec(s)?.[1];
  const mlon = /[?&]mlon=(-?\d+(?:\.\d+)?)/.exec(s)?.[1];
  if (mlat && mlon) return { lat: Number(mlat), lon: Number(mlon) };
  const patterns = [
    // Google Maps: точка места (!3d!4d) точнее, чем центр экрана (@).
    new RegExp(String.raw`!3d${NUM}!4d${NUM}`),
    new RegExp(String.raw`[?&](?:q|query|ll|daddr|destination)=${NUM}(?:,|%2C)\s*${NUM}`, 'i'),
    new RegExp(String.raw`@${NUM},${NUM}`),
    new RegExp(String.raw`#map=\d+(?:\.\d+)?/${NUM}/${NUM}`),
    new RegExp(String.raw`^geo:${NUM},${NUM}`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m?.[1] && m[2]) return { lat: Number(m[1]), lon: Number(m[2]) };
  }
  return null;
}

/** «44.9714, 19.6101», «44.9714 19.6101», «44,9714 19,6101», «44,9714; 19,6101». */
function fromPair(s: string): LatLon | null {
  const dot = /^\s*(-?\d{1,3}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*$/.exec(s);
  if (dot?.[1] && dot[2]) return { lat: Number(dot[1]), lon: Number(dot[2]) };
  const comma = /^\s*(-?\d{1,3},\d+)\s*[;\s]\s*(-?\d{1,3},\d+)\s*$/.exec(s);
  if (comma?.[1] && comma[2]) {
    return { lat: Number(comma[1].replace(',', '.')), lon: Number(comma[2].replace(',', '.')) };
  }
  return null;
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function distanceM(a: LatLon, b: LatLon): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** «только для Вело» в названии или тексте — недоступно ПРО (как пометки в Notion). */
function riddleNote(r: Pick<Riddle, 'title' | 'text'>): KpNote | undefined {
  const s = `${r.title}\n${r.text}`.toLowerCase();
  if (/только\s+для\s+вело/.test(s)) return 'velo_only';
  if (/только\s+для\s+про(?![а-яё])(?!\s+и\s+вело)/.test(s)) return 'pro_only';
  return undefined;
}

/** Уверенность отгадки, введённой координатами или ссылкой: точнее кружка на карте. */
export const ANSWER_CONFIDENCE = 0.95;

/**
 * Баллы загадки: по правилу игры (96 → 9). Номер меньше делителя (1–9) — это сами баллы:
 * задания с листка без номера, но с баллами в тексте («фото у конины — 5 баллов») заводятся
 * как «5А», «5Б», «7А» — буква только различает задания с одинаковыми баллами.
 */
export function riddlePoints(id: string, game: Pick<Game, 'pointsRule'>): number {
  const parsed = parseKpId(id);
  if (!parsed) return 0;
  const byRule = pointsFor(parsed.number, game.pointsRule);
  return byRule === 0 ? parsed.number : byRule;
}

/** Загадка → КП (kind: riddle): баллы — riddlePoints, координаты — отгадка (source: manual). */
export function riddleToKp(r: Riddle, game: Pick<Game, 'pointsRule'>): Kp {
  const parsed = parseKpId(r.id);
  const note = riddleNote(r);
  return {
    id: r.id,
    number: parsed?.number ?? null,
    kind: 'riddle',
    points: riddlePoints(r.id, game),
    ...(note && { note }),
    eligible: note !== 'velo_only',
    title: r.title || 'Загадка',
    description: r.text ? r.text.split('\n') : [],
    struck: [],
    links: [],
    answerKind: 'text',
    ...(r.answer && {
      loc: {
        lat: r.answer.lat,
        lon: r.answer.lon,
        source: 'manual' as const,
        confidence: ANSWER_CONFIDENCE,
      },
    }),
    raw: r.text,
  };
}
