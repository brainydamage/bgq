import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import { addMinutes, clockIn, DEFAULT_DURATION_MIN, Game, schemaErrors } from '@bgq/core';
import { unzipSync } from 'fflate';
import { parseNotion } from './parse.ts';

export const ORIG_MD = 'notion-export.orig.md';
export const WORK_MD = 'notion-export.md';
/** games/_template/game.json — конфиг-образец (в git); берётся, если прошлых игр нет. */
export const TEMPLATE_DIR = '_template';

/** Каталог игры — дата: games/2026-12-05. Остальное в games/ (osm, _template) — не игры. */
const GAME_DIR_NAME = /^\d{4}-\d{2}-\d{2}$/;

export class InitError extends Error {}

export interface InitOptions {
  /** Каталог игр; экспорт Notion (.zip или .md) кладётся прямо в него. */
  gamesDir: string;
  /** ГГГГ-ММ-ДД — id игры и имя каталога; по умолчанию — сегодня (локальное время). */
  date?: string;
  /**
   * Каталог, откуда взять game.json; по умолчанию — последняя прошлая игра в gamesDir,
   * а если их нет — games/_template.
   */
  from?: string;
  /** Начало пролога «ЧЧ:ММ» — у каждой команды своё; без него берётся из прошлой игры (с пометкой). */
  start?: string;
  /** «Сейчас» — момент получения комплекта (start.depart); для тестов. */
  now?: Date;
}

/** Поле game.json, которое стоит проверить глазами, и откуда взято значение. */
export interface CheckField {
  path: string;
  value: string | undefined;
  origin:
    | 'export'
    | 'previous'
    | 'missing'
    /** из --start */
    | 'arg'
    /** из прошлой игры, хотя у каждой игры своё — вписать */
    | 'stale'
    /** старт + длительность игры */
    | 'computed'
    /** время запуска init — получили комплект */
    | 'now'
    /** в экспорте другое значение, взято не оно — проверить */
    | 'conflict';
}

export interface InitResult {
  date: string;
  gameDir: string;
  /** Куда перенесён исходный экспорт из gamesDir. */
  archived: string;
  /** Откуда взят game.json; null — game.json уже был в каталоге. */
  from: string | null;
  /** «Export.zip › Осенний БеоГеоКвест.md» */
  mdLabel: string;
  check: CheckField[];
}

/**
 * Берёт единственный экспорт Notion (.zip или .md) из gamesDir и создаёт gamesDir/<дата>/:
 * game.json из прошлой игры (id, date, финиш из экспорта), notion-export.orig.md и рабочую
 * копию notion-export.md. Исходный экспорт переносится в каталог игры, чтобы gamesDir
 * оставался чистым. Ничего не перезаписывает; при ошибке ничего не пишет и не переносит.
 */
export function initGame(o: InitOptions): InitResult {
  const date = o.date ?? todayLocal();
  if (!GAME_DIR_NAME.test(date)) {
    throw new InitError(`Дата должна быть в виде ГГГГ-ММ-ДД, получено «${date}»`);
  }
  const gameDir = join(o.gamesDir, date);
  const source = findExport(o.gamesDir);
  const isZip = extname(source).toLowerCase() === '.zip';
  const archived = isZip ? join(gameDir, basename(source)) : join(gameDir, ORIG_MD);
  for (const path of new Set([join(gameDir, ORIG_MD), join(gameDir, WORK_MD), archived])) {
    if (existsSync(path)) {
      throw new InitError(
        `${path} уже есть — не перезаписываю. Если нужно начать заново, удалите файлы экспорта вручную.`,
      );
    }
  }

  const md = readExport(source);
  const gamePath = join(gameDir, 'game.json');
  const existing = existsSync(gamePath);
  let game: Game;
  let from: string | null = null;
  let check: CheckField[];
  if (existing) {
    game = loadGame(gamePath);
    check = [];
  } else {
    from = o.from ?? latestGameDir(o.gamesDir, date);
    if (!from) {
      throw new InitError(
        `В ${o.gamesDir} нет ни прошлой игры, ни ${TEMPLATE_DIR}/game.json — передайте --from <каталог с game.json>`,
      );
    }
    ({ game, check } = gameFromPrevious(loadGame(join(from, 'game.json')), date, md.text, {
      ...(o.start !== undefined && { start: o.start }),
      now: o.now ?? new Date(),
    }));
  }

  mkdirSync(gameDir, { recursive: true });
  if (!existing) writeFileSync(gamePath, `${JSON.stringify(game, null, 2)}\n`);
  if (isZip) writeFileSync(join(gameDir, ORIG_MD), md.text);
  writeFileSync(join(gameDir, WORK_MD), md.text);
  // .md сам становится оригиналом; .zip сохраняем рядом как есть.
  renameSync(source, archived);
  return { date, gameDir, archived, from, mdLabel: md.label, check };
}

/** Сегодняшняя дата по часам ноутбука: ГГГГ-ММ-ДД. */
export function todayLocal(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Единственный .zip/.md прямо в gamesDir (не в каталогах игр). */
function findExport(gamesDir: string): string {
  const found = existsSync(gamesDir)
    ? readdirSync(gamesDir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(zip|md)$/i.test(e.name))
        .map((e) => e.name)
        .sort()
    : [];
  const [only] = found;
  if (!only) throw new InitError(`Положите экспорт Notion (.zip или .md) в ${gamesDir}/`);
  if (found.length > 1) {
    throw new InitError(`В ${gamesDir}/ несколько экспортов (${found.join(', ')}) — оставьте один`);
  }
  return join(gamesDir, only);
}

/**
 * game.json прошлой игры → новой: id/date, координаты сброшены. Старт — из --start (у каждой
 * команды свой), дедлайн = старт + длительность игры (9 ч), комплект получен — сейчас (если
 * init запущен в день игры после старта); штраф, опоздание и адрес финиша — из экспорта.
 */
function gameFromPrevious(
  prev: Game,
  date: string,
  md: string,
  o: { start?: string; now: Date },
): { game: Game; check: CheckField[] } {
  const finish = parseNotion(md, prev).finish;
  const { address: _prevAddress, loc: _finishLoc, ...prevFinish } = prev.finish;
  const durationMin = prev.durationMin ?? DEFAULT_DURATION_MIN;
  const time = o.start ?? prev.start.time;
  const deadline = addMinutes(time, durationMin);
  const now = clockIn(prev.tz, o.now);
  const depart = now.date === date && now.hhmm >= time ? now.hhmm : undefined;

  const game: Game = {
    ...prev,
    id: date,
    date,
    start: { time, ...(depart && { depart }) },
    durationMin,
    finish: {
      ...prevFinish,
      deadline,
      ...(finish?.graceMin !== undefined && { graceMin: finish.graceMin }),
      ...(finish?.penaltyPerMin !== undefined && { penaltyPerMin: finish.penaltyPerMin }),
      ...(finish?.address && { address: finish.address }),
    },
  };

  const origin = (fromExport: unknown): CheckField['origin'] =>
    fromExport !== undefined ? 'export' : 'previous';
  const check: CheckField[] = [
    { path: 'city', value: game.city, origin: 'previous' },
    { path: 'start.time', value: game.start.time, origin: o.start ? 'arg' : 'stale' },
    { path: 'start.depart', value: game.start.depart, origin: depart ? 'now' : 'missing' },
    { path: 'finish.deadline', value: game.finish.deadline, origin: 'computed' },
    ...(finish?.deadline && finish.deadline !== deadline
      ? [{ path: 'finish.deadline в Notion', value: finish.deadline, origin: 'conflict' as const }]
      : []),
    {
      path: 'finish.graceMin',
      value: String(game.finish.graceMin),
      origin: origin(finish?.graceMin),
    },
    {
      path: 'finish.penaltyPerMin',
      value: String(game.finish.penaltyPerMin),
      origin: origin(finish?.penaltyPerMin),
    },
    {
      path: 'finish.address',
      value: game.finish.address,
      origin: finish?.address ? 'export' : 'missing',
    },
    { path: 'category', value: game.category, origin: 'previous' },
  ];
  return { game, check };
}

function readExport(path: string): { text: string; label: string } {
  if (!existsSync(path)) throw new InitError(`Нет файла ${path}`);
  const ext = extname(path).toLowerCase();
  if (ext === '.md') return { text: readFileSync(path, 'utf8'), label: basename(path) };
  if (ext === '.zip') return fromZip(readFileSync(path), basename(path), 0);
  throw new InitError(`Ожидается .zip или .md экспорта Notion, получено «${basename(path)}»`);
}

const depthOf = (name: string) => name.split('/').length;

/**
 * Имя из zip без флага UTF-8 (так пишет `zip` на macOS) fflate читает как latin1:
 * «Ð—Ð¸Ð¼…». Если байты имени — валидный UTF-8, перекодируем.
 */
export function fixZipName(name: string): string {
  const codes = Array.from(name, (ch) => ch.charCodeAt(0));
  // Только латиница-1 и хотя бы один не-ASCII символ — иначе имя уже нормальное.
  if (codes.some((c) => c > 0xff) || !codes.some((c) => c >= 0x80)) return name;
  const bytes = Uint8Array.from(codes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return name;
  }
}

/** Notion кладёт страницу в zip, иногда — zip внутри zip. Берём единственный .md верхнего уровня. */
function fromZip(
  data: Uint8Array,
  label: string,
  nesting: number,
): { text: string; label: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => !f.name.startsWith('__MACOSX/') && /\.(md|zip)$/i.test(f.name),
    });
  } catch (e) {
    throw new InitError(`${label}: не удалось распаковать (${(e as Error).message})`);
  }
  files = Object.fromEntries(Object.entries(files).map(([n, d]) => [fixZipName(n), d]));

  const mds = Object.keys(files).filter((n) => /\.md$/i.test(n));
  if (mds.length) {
    const top = Math.min(...mds.map(depthOf));
    const candidates = mds.filter((n) => depthOf(n) === top);
    const name = candidates[0];
    if (candidates.length > 1 || !name) {
      throw new InitError(
        `${label}: несколько .md верхнего уровня (${candidates.join(', ')}) — распакуйте и передайте нужный .md`,
      );
    }
    return { text: new TextDecoder().decode(files[name]), label: `${label} › ${name}` };
  }

  const zips = Object.keys(files).filter((n) => /\.zip$/i.test(n));
  const inner = zips[0];
  if (zips.length === 1 && inner && nesting < 2) {
    return fromZip(files[inner] ?? new Uint8Array(), `${label} › ${inner}`, nesting + 1);
  }
  throw new InitError(
    zips.length > 1
      ? `${label}: несколько вложенных архивов (${zips.join(', ')}) — распакуйте и передайте нужный .md`
      : `${label}: в архиве нет .md`,
  );
}

/** Каталоги игр (имя — дата), в которых есть файл `file`, по возрастанию даты. */
function gameDirs(gamesDir: string, file: string): string[] {
  if (!existsSync(gamesDir)) return [];
  return readdirSync(gamesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && GAME_DIR_NAME.test(d.name))
    .map((d) => d.name)
    .filter((name) => existsSync(join(gamesDir, name, file)))
    .sort();
}

/** Откуда брать game.json: последняя прошлая игра, кроме создаваемой, иначе шаблон. */
function latestGameDir(gamesDir: string, exclude: string): string | null {
  const last = gameDirs(gamesDir, 'game.json')
    .filter((name) => name !== exclude)
    .at(-1);
  if (last) return join(gamesDir, last);
  const template = join(gamesDir, TEMPLATE_DIR);
  return existsSync(join(template, 'game.json')) ? template : null;
}

/**
 * Игра для `bgq parse`: каталог с рабочей копией экспорта — заданный датой
 * или последний по дате (в день игры это сегодняшний).
 */
export function currentGameDir(gamesDir: string, date?: string): string {
  if (date !== undefined) {
    const dir = join(gamesDir, date);
    if (!existsSync(join(dir, WORK_MD))) {
      throw new InitError(`В ${dir} нет ${WORK_MD} — сначала ./bgq init`);
    }
    return dir;
  }
  const last = gameDirs(gamesDir, WORK_MD).at(-1);
  if (!last) throw new InitError(`В ${gamesDir} нет игр с ${WORK_MD} — сначала ./bgq init`);
  return join(gamesDir, last);
}

export function loadGame(path: string): Game {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const errors = schemaErrors(Game, data);
  if (errors.length) throw new InitError(`${path}: ${errors.join('; ')}`);
  return data as Game;
}
