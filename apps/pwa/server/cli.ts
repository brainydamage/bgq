#!/usr/bin/env node
// ./bgq pwa [dev|build|preview] — данные игры для телефона (phone.json) и PWA на ноутбуке.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type PhoneGame, phoneGame, RiddlesFile, schemaErrors } from '@bgq/core';
import { currentGameDir, InitError, loadGame } from '@bgq/ingest';
import { build, createServer, type Plugin, preview } from 'vite';

const APP_DIR = resolve(import.meta.dirname, '..');
const GAMES_DIR = resolve(APP_DIR, '../../games');
const CONFIG = join(APP_DIR, 'vite.config.ts');

const USAGE = [
  'usage: ./bgq pwa [dev|build|preview] [--date ГГГГ-ММ-ДД] [--port N] [--lan] [--no-open]',
  '  (без команды) game.json + riddles.json → games/<дата>/phone.json — на iPhone по AirDrop',
  '  dev      — приложение на ноутбуке с пересборкой (без офлайна); phone.json подгружается сам',
  '  build    — сборка в apps/pwa/dist (то же, что выкладывает GitHub Actions на Pages)',
  '  preview  — сборка + раздача на localhost: проверка офлайна (service worker)',
  '  --lan    — открыть телефону в той же сети; по http без офлайна — только посмотреть',
].join('\n');

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        date: { type: 'string' },
        games: { type: 'string' },
        port: { type: 'string', default: '5174' },
        'no-open': { type: 'boolean', default: false },
        lan: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
  }
})();
const [command = 'export', ...extra] = positionals;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (extra.length || !['export', 'dev', 'build', 'preview'].includes(command))
  fail(`✗ Неизвестная команда: ${[command, ...extra].join(' ')}\n${USAGE}`);

/** Путь относительно cwd; вне cwd — абсолютный. */
const rel = (p: string) => {
  const r = relative(process.cwd(), p);
  return r.startsWith('..') ? resolve(p) : r || '.';
};

/** phone.json текущей игры (пишется заново при каждом запуске). */
function exportPhone(): { path: string; phone: PhoneGame } {
  let gameDir: string;
  try {
    gameDir = currentGameDir(resolve(values.games ?? GAMES_DIR), values.date);
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    fail(`✗ ${e.message}`);
  }
  const game = loadGame(join(gameDir, 'game.json'));
  const riddlesPath = join(gameDir, 'riddles.json');
  let riddles: RiddlesFile | null = null;
  if (existsSync(riddlesPath)) {
    const data: unknown = JSON.parse(readFileSync(riddlesPath, 'utf8'));
    const errors = schemaErrors(RiddlesFile, data);
    if (errors.length) fail(`✗ ${rel(riddlesPath)}: ${errors.slice(0, 5).join('; ')}`);
    riddles = data as RiddlesFile;
  }
  const phone = phoneGame(game, riddles, new Date().toISOString());
  const path = join(gameDir, 'phone.json');
  writeFileSync(path, `${JSON.stringify(phone, null, 2)}\n`);
  return { path, phone };
}

function printExport({ path, phone }: { path: string; phone: PhoneGame }) {
  const points = phone.tasks.reduce((s, t) => s + t.points, 0);
  const atFinish = phone.tasks.filter((t) => t.atFinish).length;
  console.log(
    `${rel(path)}: ${phone.city}, ${phone.date} · финиш ${phone.deadline} · заданий ${phone.tasks.length} (${points} б, сдать на финише ${atFinish})`,
  );
  if (!phone.tasks.length)
    console.log('△ Заданий без места нет — заведите их на странице «Загадки» (./bgq map)');
}

/** /phone.json на dev/preview-сервере — текущая игра; открыть приложение с ?load=phone.json. */
function phoneJson(path: string): Plugin {
  const serve = (res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(path));
  };
  return {
    name: 'bgq-phone-json',
    configureServer(server) {
      server.middlewares.use('/phone.json', (_req, res) => serve(res));
    },
    configurePreviewServer(server) {
      server.middlewares.use('/phone.json', (_req, res) => serve(res));
    },
  };
}

function printUrls(urls: { local: string[]; network: string[] } | null, offline: boolean) {
  const local = urls?.local[0] ?? `http://localhost:${values.port}/`;
  console.log(`Открыто: ${local}?load=phone.json · Ctrl+C — выход`);
  if (!values.lan) return;
  const network = (urls?.network ?? []).filter((u) => !/\/\/127\./.test(u));
  if (!network.length) {
    console.log('△ Нет сети — подключите ноутбук к Wi-Fi или точке доступа и перезапустите.');
    return;
  }
  console.log('Для телефона в той же сети:');
  for (const u of network) console.log(`  ${u}?load=phone.json`);
  console.log(
    offline
      ? '△ По http service worker не работает: без сети не откроется. Для поля — GitHub Pages + phone.json по AirDrop.'
      : '△ По http без офлайна — только посмотреть. Для поля — GitHub Pages + phone.json по AirDrop.',
  );
  console.log('Брандмауэр macOS: входящие подключения для node — «Разрешить».');
}

const server = {
  host: values.lan ? true : 'localhost',
  port: Number(values.port),
  open: values['no-open'] ? false : '/?load=phone.json',
} as const;

if (command === 'export') {
  printExport(exportPhone());
  console.log(
    'На iPhone: AirDrop → «Сохранить в Файлы» → в приложении BGQ «Загрузить игру» → phone.json',
  );
} else if (command === 'build') {
  await build({ configFile: CONFIG, logLevel: 'warn' });
  console.log(`Сборка: ${rel(join(APP_DIR, 'dist'))}`);
} else if (command === 'dev') {
  const exported = exportPhone();
  printExport(exported);
  const dev = await createServer({
    configFile: CONFIG,
    logLevel: 'warn',
    plugins: [phoneJson(exported.path)],
    server,
  });
  await dev.listen();
  printUrls(dev.resolvedUrls, false);
} else {
  const exported = exportPhone();
  printExport(exported);
  await build({ configFile: CONFIG, logLevel: 'warn' });
  const prev = await preview({
    configFile: CONFIG,
    logLevel: 'warn',
    plugins: [phoneJson(exported.path)],
    preview: server,
  });
  printUrls(prev.resolvedUrls, true);
}
