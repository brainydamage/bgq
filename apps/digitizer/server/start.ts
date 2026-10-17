#!/usr/bin/env node
// ./bgq map [--date ГГГГ-ММ-ДД] [--port N] — digitizer для последней игры в браузере.
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { currentGameDir, InitError } from '@bgq/ingest';
import { createServer } from 'vite';
import { bgqApi } from './api.ts';

const APP_DIR = resolve(import.meta.dirname, '..');
const GAMES_DIR = resolve(APP_DIR, '../../games');

const USAGE = [
  'usage: ./bgq map [--date ГГГГ-ММ-ДД] [--port N] [--no-open] [--lan]',
  '  разметка кружков КП на фото карты → games/<дата>/map.json; загадки — /riddles',
  '  --lan — открыть для соседних устройств (второй ноутбук по точке доступа iPhone)',
].join('\n');

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        date: { type: 'string' },
        games: { type: 'string' },
        port: { type: 'string', default: '5173' },
        'no-open': { type: 'boolean', default: false },
        lan: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
  }
})();
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

let gameDir: string;
try {
  gameDir = currentGameDir(resolve(values.games ?? GAMES_DIR), values.date);
} catch (e) {
  if (!(e instanceof InitError)) throw e;
  fail(`✗ ${e.message}`);
}
/** Путь относительно cwd; вне cwd — абсолютный. */
const rel = (p: string) => {
  const r = relative(process.cwd(), p);
  return r.startsWith('..') ? resolve(p) : r || '.';
};
if (!existsSync(join(gameDir, 'kps.json')))
  fail(`✗ Нет ${rel(join(gameDir, 'kps.json'))} — сначала ./bgq parse`);
if (!existsSync(join(gameDir, 'geo.json'))) {
  console.log(
    '△ Нет geo.json — опорных точек не будет, привязка не заработает. Сначала ./bgq geo\n',
  );
}

const server = await createServer({
  configFile: false,
  root: APP_DIR,
  logLevel: 'warn',
  plugins: [bgqApi(gameDir)],
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  // --lan: слушаем все интерфейсы — страницу «Загадки» откроет второй ноутбук в той же сети.
  server: {
    host: values.lan ? true : 'localhost',
    port: Number(values.port),
    open: !values['no-open'],
  },
});
await server.listen();
const url = server.resolvedUrls?.local[0] ?? `http://localhost:${values.port}/`;
console.log(`Игра ${rel(gameDir)} · разметка сохраняется в ${rel(join(gameDir, 'map.json'))}`);
console.log(`Открыто: ${url} · загадки: ${url.replace(/\/$/, '')}/riddles · Ctrl+C — выход`);
if (values.lan) {
  // 127.x — сам ноутбук, второму не пригодится.
  const network = (server.resolvedUrls?.network ?? []).filter((u) => !/\/\/127\./.test(u));
  if (network.length) {
    console.log('Для второго ноутбука (та же сеть, например точка доступа iPhone):');
    for (const u of network) console.log(`  ${u.replace(/\/$/, '')}/riddles`);
    console.log(
      'Брандмауэр macOS: на вопрос «разрешить входящие подключения» для node — «Разрешить»',
    );
    console.log(
      '(или Системные настройки → Сеть → Брандмауэр → Параметры → node: разрешить). Проверьте дома заранее.',
    );
  } else {
    console.log('△ Нет сети — подключите ноутбук к Wi-Fi или точке доступа и перезапустите.');
  }
}
