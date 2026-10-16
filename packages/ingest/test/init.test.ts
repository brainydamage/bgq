import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Game } from '@bgq/core';
import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  currentGameDir,
  fixZipName,
  InitError,
  initGame,
  ORIG_MD,
  todayLocal,
  WORK_MD,
} from '../src/index.ts';
import { fixtureGame, fixtureMd } from './helpers.ts';

const DATE = '2026-12-05';
const MD_NAME = 'Зимний БеоГеоКвест 1a2b3c.md';
const loc = { lat: 44.97, lon: 19.61, source: 'manual', confidence: 1 } as const;

let gamesDir: string;

function writeGame(dir: string, game: Game) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'game.json'), JSON.stringify(game));
}

/** Кладёт экспорт прямо в games/, как это делает пользователь. */
function dropExport(name: string, data: Uint8Array | string): string {
  const path = join(gamesDir, name);
  writeFileSync(path, data);
  return path;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const gameDir = () => join(gamesDir, DATE);
const exportZip = (files: Record<string, Uint8Array>) =>
  dropExport('Export-1a2b.zip', zipSync(files));

beforeEach(() => {
  gamesDir = join(mkdtempSync(join(tmpdir(), 'bgq-init-')), 'games');
  writeGame(join(gamesDir, '2026-10-10'), {
    ...fixtureGame,
    start: { ...fixtureGame.start, loc },
    finish: { ...fixtureGame.finish, loc },
  });
});

describe('initGame', () => {
  it('zip из games/: каталог игры, оригинал, рабочая копия, архив перенесён', () => {
    const zip = exportZip({
      [MD_NAME]: strToU8(fixtureMd),
      'Зимний БеоГеоКвест 1a2b3c/map.png': new Uint8Array([1, 2, 3]),
    });
    const r = initGame({ gamesDir, date: DATE });

    expect(r.gameDir).toBe(gameDir());
    expect(r.from).toBe(join(gamesDir, '2026-10-10'));
    expect(r.mdLabel).toBe(`Export-1a2b.zip › ${MD_NAME}`);
    expect(readFileSync(join(gameDir(), ORIG_MD), 'utf8')).toBe(fixtureMd);
    expect(readFileSync(join(gameDir(), WORK_MD), 'utf8')).toBe(fixtureMd);

    expect(existsSync(zip)).toBe(false);
    expect(r.archived).toBe(join(gameDir(), 'Export-1a2b.zip'));
    expect(existsSync(r.archived)).toBe(true);
    expect(readdirSync(gamesDir).sort()).toEqual(['2026-10-10', DATE]);
  });

  it('game.json: id/date новые, координаты сброшены, финиш из экспорта', () => {
    dropExport('e.md', fixtureMd);
    initGame({ gamesDir, date: DATE });
    const game = readJson(join(gameDir(), 'game.json'));
    expect(game).toMatchObject({ id: DATE, date: DATE, city: 'Сремска Митровица' });
    expect(game.start).toEqual({ time: '10:30' });
    expect(game.finish).toEqual({
      deadline: '19:30',
      graceMin: 30,
      penaltyPerMin: 1,
      address: 'Улица Короля Петра Первого дом 15',
    });
  });

  it('.md из games/ сам становится оригиналом', () => {
    const md = dropExport('Экспорт.md', fixtureMd);
    const r = initGame({ gamesDir, date: DATE });
    expect(existsSync(md)).toBe(false);
    expect(r.archived).toBe(join(gameDir(), ORIG_MD));
    expect(r.mdLabel).toBe('Экспорт.md');
    expect(readdirSync(gameDir()).sort()).toEqual(['game.json', WORK_MD, ORIG_MD].sort());
  });

  it('дата по умолчанию — сегодня', () => {
    dropExport('e.md', fixtureMd);
    const r = initGame({ gamesDir });
    expect(r.date).toBe(todayLocal());
    expect(r.gameDir).toBe(join(gamesDir, todayLocal()));
  });

  it('todayLocal — локальная дата, не UTC', () => {
    expect(todayLocal(new Date(2026, 11, 5, 0, 30))).toBe('2026-12-05');
  });

  it('список полей для проверки — с источником значения', () => {
    dropExport('e.md', fixtureMd);
    const r = initGame({ gamesDir, date: DATE });
    expect(Object.fromEntries(r.check.map((f) => [f.path, f.origin]))).toEqual({
      city: 'previous',
      'start.time': 'previous',
      'finish.deadline': 'export',
      'finish.graceMin': 'export',
      'finish.penaltyPerMin': 'export',
      'finish.address': 'export',
      category: 'previous',
    });
  });

  it('без блока финиша: адрес прошлой игры не переносится', () => {
    dropExport('e.md', '**10 Улица Водна 45**\n\nВопрос');
    const r = initGame({ gamesDir, date: DATE });
    const game = readJson(join(gameDir(), 'game.json'));
    expect(game.finish.address).toBeUndefined();
    expect(game.finish.deadline).toBe('19:30');
    expect(r.check.find((f) => f.path === 'finish.address')?.origin).toBe('missing');
    expect(r.check.find((f) => f.path === 'finish.deadline')?.origin).toBe('previous');
  });

  it('zip внутри zip', () => {
    const inner = zipSync({ [MD_NAME]: strToU8(fixtureMd) });
    exportZip({ 'Export-abc-Part-1.zip': inner });
    const r = initGame({ gamesDir, date: DATE });
    expect(r.mdLabel).toBe(`Export-1a2b.zip › Export-abc-Part-1.zip › ${MD_NAME}`);
    expect(readFileSync(join(gameDir(), WORK_MD), 'utf8')).toBe(fixtureMd);
  });

  it('подстраницы глубже верхнего уровня игнорируются', () => {
    exportZip({
      [MD_NAME]: strToU8(fixtureMd),
      'Зимний БеоГеоКвест 1a2b3c/Подстраница 9f.md': strToU8('другое'),
    });
    initGame({ gamesDir, date: DATE });
    expect(readFileSync(join(gameDir(), WORK_MD), 'utf8')).toBe(fixtureMd);
  });

  it('последняя по дате прошлая игра берётся по умолчанию; from перекрывает', () => {
    writeGame(join(gamesDir, '2026-11-01'), { ...fixtureGame, id: '2026-11-01', city: 'Шабац' });
    dropExport('e.md', fixtureMd);
    expect(initGame({ gamesDir, date: DATE }).from).toBe(join(gamesDir, '2026-11-01'));

    dropExport('e.md', fixtureMd);
    const other = initGame({ gamesDir, date: '2026-12-06', from: join(gamesDir, '2026-10-10') });
    expect(readJson(join(other.gameDir, 'game.json')).city).toBe('Сремска Митровица');
  });

  it('game.json уже подготовлен заранее — не трогаем', () => {
    const prepared = { ...fixtureGame, id: DATE, date: DATE, city: 'Нови Сад' };
    writeGame(gameDir(), prepared);
    dropExport('e.md', fixtureMd);
    const r = initGame({ gamesDir, date: DATE });
    expect(r.from).toBeNull();
    expect(r.check).toEqual([]);
    expect(readJson(join(gameDir(), 'game.json'))).toEqual(prepared);
  });
});

describe('currentGameDir (./bgq parse)', () => {
  it('последняя по дате игра с рабочей копией; игры без экспорта пропускаются', () => {
    dropExport('e.md', fixtureMd);
    initGame({ gamesDir, date: '2026-11-01' });
    dropExport('e.md', fixtureMd);
    initGame({ gamesDir, date: DATE });
    writeGame(join(gamesDir, '2027-01-01'), fixtureGame); // game.json без экспорта
    expect(currentGameDir(gamesDir)).toBe(gameDir());
  });

  it('конкретная дата', () => {
    dropExport('e.md', fixtureMd);
    initGame({ gamesDir, date: '2026-11-01' });
    dropExport('e.md', fixtureMd);
    initGame({ gamesDir, date: DATE });
    expect(currentGameDir(gamesDir, '2026-11-01')).toBe(join(gamesDir, '2026-11-01'));
  });

  it('нет ни одной игры с экспортом / нет экспорта на дату — подсказка про init', () => {
    expect(() => currentGameDir(gamesDir)).toThrow(/сначала \.\/bgq init/);
    expect(() => currentGameDir(gamesDir, '2026-10-10')).toThrow(/сначала \.\/bgq init/);
  });
});

describe('fixZipName', () => {
  it('UTF-8 имя, прочитанное как latin1, восстанавливается', () => {
    const mojibake = Buffer.from(MD_NAME, 'utf8').toString('latin1');
    expect(fixZipName(mojibake)).toBe(MD_NAME);
  });

  it.each([MD_NAME, 'Export.md', 'café.md'])('нормальное имя не меняется: %s', (name) => {
    expect(fixZipName(name)).toBe(name);
  });
});

describe('initGame: отказы ничего не пишут и не переносят', () => {
  it('в games/ нет экспорта', () => {
    expect(() => initGame({ gamesDir, date: DATE })).toThrow(/Положите экспорт/);
    expect(existsSync(gameDir())).toBe(false);
  });

  it('несколько экспортов в games/', () => {
    const a = dropExport('a.zip', zipSync({ 'a.md': strToU8('a') }));
    const b = dropExport('b.md', 'b');
    expect(() => initGame({ gamesDir, date: DATE })).toThrow(/a\.zip, b\.md.*оставьте один/);
    expect(existsSync(a) && existsSync(b)).toBe(true);
    expect(existsSync(gameDir())).toBe(false);
  });

  it('повторный запуск не затирает рабочую копию, новый экспорт остаётся в games/', () => {
    dropExport('e.md', fixtureMd);
    initGame({ gamesDir, date: DATE });
    writeFileSync(join(gameDir(), WORK_MD), 'правки');
    const again = dropExport('e.md', fixtureMd);
    expect(() => initGame({ gamesDir, date: DATE })).toThrow(/уже есть/);
    expect(readFileSync(join(gameDir(), WORK_MD), 'utf8')).toBe('правки');
    expect(existsSync(again)).toBe(true);
  });

  it('дата не ГГГГ-ММ-ДД', () => {
    const md = dropExport('e.md', fixtureMd);
    expect(() => initGame({ gamesDir, date: '5.12.2026' })).toThrow(/ГГГГ-ММ-ДД/);
    expect(existsSync(md)).toBe(true);
  });

  it('несколько .md верхнего уровня в архиве', () => {
    const zip = exportZip({ 'a.md': strToU8('a'), 'b.md': strToU8('b') });
    expect(() => initGame({ gamesDir, date: DATE })).toThrow(InitError);
    expect(existsSync(zip)).toBe(true);
    expect(existsSync(gameDir())).toBe(false);
  });

  it('в архиве нет .md', () => {
    exportZip({ 'map.png': new Uint8Array([1]) });
    expect(() => initGame({ gamesDir, date: DATE })).toThrow(/нет \.md/);
  });

  it('нет прошлой игры', () => {
    const empty = join(mkdtempSync(join(tmpdir(), 'bgq-init-')), 'games');
    mkdirSync(empty);
    writeFileSync(join(empty, 'e.md'), fixtureMd);
    expect(() => initGame({ gamesDir: empty, date: DATE })).toThrow(/--from/);
    expect(existsSync(join(empty, DATE))).toBe(false);
    expect(existsSync(join(empty, 'e.md'))).toBe(true);
  });
});
