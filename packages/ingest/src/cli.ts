#!/usr/bin/env node
// Запуск: ./bgq <команда> (скрипт в корне репо).
// init  — берёт экспорт Notion из games/, заводит games/<сегодня>/ и делает первый прогон.
// parse — прогон последней игры с пересчётом при каждом сохранении.
// <notion.md> [--game <games/дата>] [--out <каталог>] [--watch] — произвольный файл.
// Пишет <out>/kps.json и <out>/report.json, печатает сводку. Код выхода 1 — есть критичные.
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Game } from '@bgq/core';
import { ingest } from './ingest.ts';
import {
  type CheckField,
  currentGameDir,
  InitError,
  type InitOptions,
  initGame,
  loadGame,
  ORIG_MD,
  WORK_MD,
} from './init.ts';
import { formatSummary } from './report.ts';

/** games/ в корне репозитория — не зависит от каталога, откуда запущена команда. */
const GAMES_DIR = resolve(import.meta.dirname, '../../../games');

const USAGE = [
  'usage:',
  '  ./bgq init    экспорт Notion (.zip или .md) из games/ → games/<сегодня>/ + первый прогон',
  '  ./bgq parse   прогон последней игры, пересчёт при каждом сохранении (Ctrl+C — выход)',
  '  ./bgq <notion.md> [--game <games/дата>] [--out <каталог>] [--watch]',
  '',
  'опции init/parse: --date ГГГГ-ММ-ДД (по умолчанию сегодня / последняя игра),',
  '                  --games <каталог>, --from <games/прошлая> (только init)',
  '--game по умолчанию — каталог .md, если в нём есть game.json.',
].join('\n');

function main(): void {
  let args: ReturnType<typeof parse>;
  try {
    args = parse();
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
  }
  if (args.values.help) {
    console.log(USAGE);
    return;
  }
  const [first, ...rest] = args.positionals;
  if (first === 'init') {
    if (rest.length) fail(`init не принимает аргументов, получено: ${rest.join(' ')}\n${USAGE}`);
    const { date, from, games } = args.values;
    process.exitCode = runInit({
      gamesDir: resolve(games ?? GAMES_DIR),
      ...(date !== undefined && { date }),
      ...(from !== undefined && { from: resolve(from) }),
    });
    return;
  }
  if (first === 'parse') {
    if (rest.length) fail(`parse не принимает аргументов, получено: ${rest.join(' ')}\n${USAGE}`);
    let gameDir: string;
    try {
      gameDir = currentGameDir(resolve(args.values.games ?? GAMES_DIR), args.values.date);
    } catch (e) {
      if (!(e instanceof InitError)) throw e;
      fail(`✗ ${e.message}`);
    }
    console.log(`Игра ${rel(gameDir)}\n`);
    start(join(gameDir, WORK_MD), gameDir, gameDir, true);
    return;
  }
  if (!first) fail(USAGE);

  const mdPath = resolve(first);
  const gameDir = resolve(args.values.game ?? defaultGameDir(mdPath));
  start(mdPath, gameDir, resolve(args.values.out ?? gameDir), args.values.watch);
}

/** Один прогон или прогон + слежение за .md, game.json и overrides.yaml. */
function start(mdPath: string, gameDir: string, outDir: string, watchMode: boolean): void {
  const run = () => runOnce(mdPath, gameDir, outDir);
  if (!watchMode) {
    process.exitCode = run();
    return;
  }
  run();
  watchFiles([mdPath, join(gameDir, 'game.json'), join(gameDir, 'overrides.yaml')], run);
}

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      game: { type: 'string' },
      out: { type: 'string' },
      watch: { type: 'boolean', default: false },
      date: { type: 'string' },
      from: { type: 'string' },
      games: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

function defaultGameDir(mdPath: string): string {
  const dir = dirname(mdPath);
  if (existsSync(join(dir, 'game.json'))) return dir;
  fail(`Рядом с ${rel(mdPath)} нет game.json — укажите --game <games/дата>`);
}

function runInit(options: InitOptions): number {
  let result: ReturnType<typeof initGame>;
  try {
    result = initGame(options);
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    console.error(`✗ ${e.message}`);
    return 2;
  }

  const dir = rel(result.gameDir);
  const gameJsonNote = result.from
    ? `из ${rel(result.from)} (id и date обновлены)`
    : 'уже был, не трогал';
  const archivedName = basename(result.archived);
  const lines = [
    `✓ ${dir}`,
    `  game.json              ← ${gameJsonNote}`,
    `  notion-export.orig.md  ← ${result.mdLabel} — не трогать`,
    `  ${WORK_MD}       ← рабочая копия, правки — здесь`,
  ];
  if (archivedName !== ORIG_MD)
    lines.push(`  ${archivedName}  ← перенесён из ${rel(options.gamesDir)}/`);
  console.log(lines.join('\n'));
  if (result.check.length)
    console.log(`\nПроверьте ${dir}/game.json:\n${formatCheck(result.check)}`);

  console.log('\nПервый прогон:');
  const code = runOnce(
    resolve(result.gameDir, WORK_MD),
    resolve(result.gameDir),
    resolve(result.gameDir),
  );
  console.log('\nДальше: ./bgq parse — прогон с пересчётом при каждом сохранении');
  return code;
}

const ORIGIN: Record<CheckField['origin'], string> = {
  export: 'из экспорта',
  previous: 'из прошлой игры',
  missing: 'не найдено в экспорте — впишите',
};

function formatCheck(fields: CheckField[]): string {
  const w = Math.max(...fields.map((f) => f.path.length));
  const v = Math.max(...fields.map((f) => (f.value ?? '—').length));
  return fields
    .map((f) => `  ${f.path.padEnd(w)}  ${(f.value ?? '—').padEnd(v)}  ${ORIGIN[f.origin]}`)
    .join('\n');
}

function runOnce(mdPath: string, gameDir: string, outDir: string): number {
  let game: Game;
  let md: string;
  let overrides: string | undefined;
  try {
    game = loadGame(join(gameDir, 'game.json'));
    md = readFileSync(mdPath, 'utf8');
    const overridesPath = join(gameDir, 'overrides.yaml');
    overrides = existsSync(overridesPath) ? readFileSync(overridesPath, 'utf8') : undefined;
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    return 2;
  }

  const result = ingest({ md, game, ...(overrides !== undefined && { overrides }) });
  const source = rel(mdPath);
  const kpsPath = join(outDir, 'kps.json');
  const reportPath = join(outDir, 'report.json');
  mkdirSync(outDir, { recursive: true });
  writeJson(kpsPath, { gameId: game.id, source, kps: result.kps, finish: result.finish });
  writeJson(reportPath, {
    source,
    stats: result.stats,
    issues: result.issues,
    sourceLines: result.sourceLines,
  });
  console.log(formatSummary(result, source));
  console.log(`→ ${rel(kpsPath)}, ${rel(reportPath)}`);
  return result.issues.some((i) => i.severity === 'critical') ? 1 : 0;
}

/** Путь относительно cwd; вне cwd — абсолютный (не «../../../..»). */
function rel(path: string): string {
  const r = relative(process.cwd(), path);
  if (r.startsWith('..')) return resolve(path);
  return r || '.';
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** Следим за каталогами, а не файлами: редакторы сохраняют через rename. */
function watchFiles(files: string[], run: () => number): void {
  const targets = new Set(files.map((f) => resolve(f)));
  let timer: NodeJS.Timeout | undefined;
  for (const dir of new Set(files.map((f) => dirname(resolve(f))))) {
    watch(dir, (_event, name) => {
      if (!name || !targets.has(join(dir, name))) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        console.log(`\n— ${new Date().toLocaleTimeString('ru-RU')} —`);
        run();
      }, 150);
    });
  }
  console.log('\nслежу за изменениями… (Ctrl+C — выход)');
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

main();
