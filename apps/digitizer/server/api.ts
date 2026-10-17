// API digitizer поверх dev-сервера Vite: читает и пишет только каталог текущей игры.
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join, parse as parsePath } from 'node:path';
import { type Kp, parseRiddleSheets, riddleToKp } from '@bgq/core';
import type { GeoResult } from '@bgq/geo';
import { loadGame } from '@bgq/ingest';
import type { Plugin } from 'vite';
import type { GameState, MapFile } from '../src/model.ts';
import { createRiddleStore, RiddleError } from './riddles.ts';

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const HEIC_EXT = new Set(['.heic', '.heif']);
const MAX_UPLOAD = 80 * 1024 * 1024;
const CONTENT_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}

/** Имя файла без путей и служебных символов. */
function safeName(raw: string): string {
  const name = basename(decodeURIComponent(raw)).replace(/[^\p{L}\p{N}._\- ()]+/gu, '_');
  if (!name || name.startsWith('.')) throw new HttpError(400, `плохое имя файла: ${raw}`);
  return name;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'файл слишком большой'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

/** Свободное имя: map.jpg → map-2.jpg, если такое уже есть. */
function freeName(dir: string, name: string): string {
  const { name: stem, ext } = parsePath(name);
  let candidate = name;
  for (let n = 2; existsSync(join(dir, candidate)); n++) candidate = `${stem}-${n}${ext}`;
  return candidate;
}

/** Запись через временный файл: при падении на середине старый файл цел. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function createApi(gameDir: string) {
  const photosDir = join(gameDir, 'photos');
  /** Фото листков с загадками — отдельно, чтобы не попасть в разметку карты. */
  const sheetsDir = join(gameDir, 'riddles');
  const mapPath = join(gameDir, 'map.json');
  const game = () => loadGame(join(gameDir, 'game.json'));
  const riddles = createRiddleStore(gameDir, game().id);

  /** КП из Notion + загадки (номер, совпавший с КП Notion, не дублируем — его покажет table). */
  function allKps(): Kp[] {
    const kps = readJson<{ kps: Kp[] }>(join(gameDir, 'kps.json'), { kps: [] }).kps;
    const known = new Set(kps.map((k) => k.id));
    const g = game();
    const extra = riddles
      .read()
      .riddles.filter((r) => !known.has(r.id))
      .map((r) => riddleToKp(r, g));
    return [...kps, ...extra];
  }

  function state(): GameState {
    mkdirSync(photosDir, { recursive: true });
    return {
      gameDir,
      game: game(),
      kps: allKps(),
      riddles: riddles.read(),
      geo: readJson<{ results: GeoResult[] }>(join(gameDir, 'geo.json'), { results: [] }).results,
      map: readJson<MapFile | null>(mapPath, null),
      photos: readdirSync(photosDir)
        .filter((f) => PHOTO_EXT.has(extname(f).toLowerCase()))
        .sort(),
    };
  }

  async function upload(
    req: IncomingMessage,
    rawName: string,
    dir = photosDir,
  ): Promise<{ file: string }> {
    const body = await readBody(req, MAX_UPLOAD);
    if (!body.length) throw new HttpError(400, 'пустой файл');
    mkdirSync(dir, { recursive: true });
    const name = safeName(rawName);
    const ext = extname(name).toLowerCase();
    if (HEIC_EXT.has(ext)) {
      // HEIC с iPhone Chrome не показывает — перегоняем в JPEG встроенной утилитой macOS.
      const tmp = join(dir, `.upload-${Date.now()}${ext}`);
      const out = freeName(dir, `${parsePath(name).name}.jpg`);
      writeFileSync(tmp, body);
      try {
        execFileSync('sips', ['-s', 'format', 'jpeg', tmp, '--out', join(dir, out)], {
          stdio: 'ignore',
        });
      } catch {
        throw new HttpError(415, 'не удалось перевести HEIC в JPEG (нужен macOS sips)');
      } finally {
        rmSync(tmp, { force: true });
      }
      return { file: out };
    }
    if (!PHOTO_EXT.has(ext)) throw new HttpError(415, `не фото: ${name}`);
    const out = freeName(dir, name);
    writeFileSync(join(dir, out), body);
    return { file: out };
  }

  async function saveMap(req: IncomingMessage): Promise<{ savedAt: string }> {
    const map = JSON.parse((await readBody(req, 10 * 1024 * 1024)).toString('utf8')) as MapFile;
    if (map?.v !== 1 || !Array.isArray(map.photos)) throw new HttpError(400, 'не map.json v1');
    writeAtomic(mapPath, `${JSON.stringify(map, null, 2)}\n`);
    return { savedAt: map.updatedAt };
  }

  function servePhoto(res: ServerResponse, dir: string, raw: string): void {
    const name = safeName(raw);
    const path = join(dir, name);
    if (!existsSync(path)) throw new HttpError(404, `нет фото ${name}`);
    res.setHeader(
      'Content-Type',
      CONTENT_TYPE[extname(name).toLowerCase()] ?? 'application/octet-stream',
    );
    createReadStream(path).pipe(res);
  }

  /** /riddles/* — страница «Загадки»: правки по одной загадке, импорт расшифровки, фото листков. */
  async function handleRiddles(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const rest = url.pathname.slice('/riddles'.length);
    if (req.method === 'GET' && rest === '') return sendJson(res, 200, riddles.read());
    if (req.method === 'POST' && rest === '/import') {
      const { text } = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')) as {
        text?: string;
      };
      const parsed = parseRiddleSheets(text ?? '');
      const { file, result } = riddles.importParsed(parsed.riddles);
      return sendJson(res, 200, { file, result, skipped: parsed.skipped });
    }
    if (req.method === 'POST' && rest === '/sheets') {
      const { file } = await upload(req, url.searchParams.get('name') ?? '', sheetsDir);
      return sendJson(res, 200, riddles.addSheet(file));
    }
    if (req.method === 'GET' && rest.startsWith('/sheets/')) {
      return servePhoto(res, sheetsDir, rest.slice('/sheets/'.length));
    }
    const id = decodeURIComponent(rest.slice(1));
    if (req.method === 'PUT' && rest.startsWith('/')) {
      const body: unknown = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      return sendJson(res, 200, riddles.upsert(body, id));
    }
    if (req.method === 'DELETE' && rest.startsWith('/'))
      return sendJson(res, 200, riddles.remove(id));
    throw new HttpError(404, `нет такого API: ${req.method} ${url.pathname}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/state') return sendJson(res, 200, state());
      if (url.pathname === '/riddles' || url.pathname.startsWith('/riddles/')) {
        return await handleRiddles(req, res, url);
      }
      if (req.method === 'PUT' && url.pathname === '/map')
        return sendJson(res, 200, await saveMap(req));
      if (req.method === 'POST' && url.pathname === '/photos') {
        return sendJson(res, 200, await upload(req, url.searchParams.get('name') ?? ''));
      }
      if (req.method === 'GET' && url.pathname.startsWith('/photos/')) {
        return servePhoto(res, photosDir, url.pathname.slice('/photos/'.length));
      }
      throw new HttpError(404, `нет такого API: ${req.method} ${url.pathname}`);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof RiddleError ? 400 : 500;
      sendJson(res, status, { error: (e as Error).message });
    }
  }

  return { handle, state };
}

/** Плагин Vite: /api/* → каталог игры. */
export function bgqApi(gameDir: string): Plugin {
  const api = createApi(gameDir);
  return {
    name: 'bgq-digitizer-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        void api.handle(req, res);
      });
    },
  };
}
