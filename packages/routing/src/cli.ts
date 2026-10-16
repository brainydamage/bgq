#!/usr/bin/env node
// ./bgq osm <город> — (после справочника адресов) пешеходный граф OSRM для города.
// ./bgq matrix [--date] [--haversine] — points.json → matrix.json (расстояния пешком).
// ./bgq problem [--date] — points.json + matrix.json + params → problem.json для солвера.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_PARAMS,
  type Game,
  type Params,
  Params as ParamsSchema,
  PointsFile,
  Problem,
  schemaErrors,
} from '@bgq/core';
import { cityCenter, citySlug } from '@bgq/geo';
import { currentGameDir, InitError, loadGame } from '@bgq/ingest';
import { haversineTable, type MatrixFile, matrixFile, routePoints, SNAP_WARN_M } from './matrix.ts';
import {
  buildGraph,
  dockerAvailable,
  graphReady,
  OSRM_IMAGE,
  osrmTable,
  RoutingError,
  readGraphMeta,
  withOsrm,
} from './osrm.ts';
import { buildProblem, ProblemError } from './problem.ts';

const GAMES_DIR = resolve(import.meta.dirname, '../../../games');
const PBF_NAME = 'serbia-latest.osm.pbf';

const USAGE = [
  'usage:',
  '  ./bgq matrix [--date ГГГГ-ММ-ДД] [--haversine]   расстояния пешком → matrix.json',
  '  ./bgq problem [--date ГГГГ-ММ-ДД]               задача для солвера → problem.json',
  '  (граф OSRM готовит ./bgq osm <город> — накануне игры; нужен Docker Desktop)',
].join('\n');

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Путь относительно cwd; вне cwd — абсолютный. */
function rel(path: string): string {
  const r = relative(process.cwd(), path);
  return r.startsWith('..') ? resolve(path) : r || '.';
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const graphDir = (gamesDir: string, city: string) =>
  join(gamesDir, 'osm', `osrm-${citySlug(city)}`);
const km = (m: number) => `${(m / 1000).toFixed(1).replace('.', ',')} км`;

function gameDirOf(gamesDir: string, date?: string): string {
  try {
    return currentGameDir(gamesDir, date);
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    fail(`✗ ${e.message}`);
  }
}

function loadPoints(gameDir: string): PointsFile {
  const path = join(gameDir, 'points.json');
  if (!existsSync(path)) fail(`✗ Нет ${rel(path)} — сначала ./bgq table`);
  const data: unknown = readJson(path);
  const errors = schemaErrors(PointsFile, data);
  if (errors.length) fail(`✗ ${rel(path)}: ${errors.join('; ')} — пересоберите ./bgq table`);
  return data as PointsFile;
}

/** Граф OSRM для города; если нет — собрать из выгрузки Сербии. */
function ensureGraph(gamesDir: string, city: string, rebuild: boolean): string {
  const dir = graphDir(gamesDir, city);
  if (graphReady(dir) && !rebuild) return dir;
  const pbf = join(gamesDir, 'osm', PBF_NAME);
  if (!existsSync(pbf)) throw new RoutingError(`нет ${rel(pbf)} — сначала ./bgq osm "${city}"`);
  console.log(`Готовлю пешеходный граф OSRM: ${city}…`);
  const t0 = Date.now();
  const meta = buildGraph({ pbf, center: cityCenter(pbf, city), dir });
  console.log(
    `✓ за ${Math.round((Date.now() - t0) / 1000)} с, данные OSM на ${meta.osmBase.slice(0, 10)} → ${rel(dir)}`,
  );
  return dir;
}

/** ./bgq osm — явная подготовка накануне: граф пересобираем всегда (секунды). */
async function runOsm(gamesDir: string, city: string): Promise<number> {
  if (!dockerAvailable()) {
    console.log('△ Docker не запущен — граф OSRM не готов. Маршрут посчитается по прямой ×1,3.');
    console.log('  Запустите Docker Desktop и повторите ./bgq osm, чтобы считать по улицам.');
    return 0;
  }
  try {
    ensureGraph(gamesDir, city, true);
  } catch (e) {
    if (!(e instanceof RoutingError)) throw e;
    fail(`✗ ${e.message}`);
  }
  return 0;
}

async function runMatrix(
  gamesDir: string,
  o: { date?: string; haversine?: boolean },
): Promise<number> {
  const gameDir = gameDirOf(gamesDir, o.date);
  const game = loadGame(join(gameDir, 'game.json'));
  const points = loadPoints(gameDir);
  let route: ReturnType<typeof routePoints>;
  try {
    route = routePoints(points);
  } catch (e) {
    fail(`✗ ${(e as Error).message}`);
  }

  let file: MatrixFile | undefined;
  let why = '';
  if (!o.haversine) {
    try {
      if (!dockerAvailable()) throw new RoutingError('Docker не запущен (откройте Docker Desktop)');
      const dir = ensureGraph(gamesDir, game.city, false);
      const meta = readGraphMeta(dir);
      const table = await withOsrm(dir, (url) => osrmTable(url, route));
      file = matrixFile({
        points,
        route,
        table,
        source: 'osrm',
        osrm: { image: OSRM_IMAGE, osmBase: meta.osmBase },
      });
    } catch (e) {
      if (!(e instanceof RoutingError)) throw e;
      why = e.message;
    }
  }
  const m =
    file ?? matrixFile({ points, route, table: haversineTable(route), source: 'haversine' });
  const outPath = join(gameDir, 'matrix.json');
  writeFileSync(outPath, `${JSON.stringify(m)}\n`);

  console.log(`Игра ${rel(gameDir)}`);
  if (m.source === 'haversine') {
    console.log(`△ по прямой ×1,3${why ? `: ${why}` : ''} — грубо, лучше по улицам (OSRM)`);
  }
  const sf = m.distanceM[0]?.[1] ?? 0;
  console.log(
    `${m.ids.length} точек (старт, финиш, КП ${m.ids.length - 2}) · ${m.source === 'osrm' ? 'по улицам (OSRM)' : 'по прямой ×1,3'} · старт → финиш ${km(sf)}`,
  );
  const far = m.ids.map((id, i) => ({ id, d: m.snapM[i] ?? 0 })).filter((x) => x.d > SNAP_WARN_M);
  for (const f of far) console.log(`  △ ${f.id}: до ближайшей дорожки ${f.d} м — проверьте место`);
  console.log(`→ ${rel(outPath)}`);
  return 0;
}

function loadParams(gameDir: string): Params {
  const path = join(gameDir, 'params.json');
  if (!existsSync(path)) return DEFAULT_PARAMS;
  const raw = readJson<Partial<Params>>(path);
  const merged = {
    ...DEFAULT_PARAMS,
    ...raw,
    serviceMin: { ...DEFAULT_PARAMS.serviceMin, ...raw.serviceMin },
  };
  const errors = schemaErrors(ParamsSchema, merged);
  if (errors.length) fail(`✗ ${rel(path)}: ${errors.join('; ')}`);
  return merged;
}

function runProblem(gamesDir: string, o: { date?: string }): number {
  const gameDir = gameDirOf(gamesDir, o.date);
  const game: Game = loadGame(join(gameDir, 'game.json'));
  const points = loadPoints(gameDir);
  const matrixPath = join(gameDir, 'matrix.json');
  if (!existsSync(matrixPath)) fail(`✗ Нет ${rel(matrixPath)} — сначала ./bgq matrix`);
  const params = loadParams(gameDir);

  let problem: Problem;
  try {
    problem = buildProblem({ game, points, matrix: readJson<MatrixFile>(matrixPath), params });
  } catch (e) {
    if (!(e instanceof ProblemError)) throw e;
    fail(`✗ ${e.message}`);
  }
  const errors = schemaErrors(Problem, problem);
  if (errors.length) fail(`✗ problem.json не проходит схему (ошибка в коде): ${errors.join('; ')}`);
  const outPath = join(gameDir, 'problem.json');
  writeFileSync(outPath, `${JSON.stringify(problem)}\n`);

  const kps = problem.nodes.filter((n) => n.role === 'kp');
  const prize = kps.reduce((s, n) => s + n.prize, 0);
  const hhmm = (s: number) => {
    const [h, m] = game.start.time.split(':').map(Number);
    const total = (h ?? 0) * 60 + (m ?? 0) + Math.round(s / 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  const windows = kps
    .filter((n) => n.window)
    .map((n) => `${n.kpId} ${hhmm(n.window?.[0] ?? 0)}–${hhmm(n.window?.[1] ?? 0)}`);
  console.log(`Игра ${rel(gameDir)}`);
  console.log(
    `КП ${kps.length} · ценность ${Math.round(prize * 10) / 10} (баллы; меньше — только у КП с неточными координатами) · матрица ${problem.matrix.source}`,
  );
  console.log(
    `старт ${game.start.time} · финиш до ${game.finish.deadline} (+${game.finish.graceMin} мин, −${game.finish.penaltyPerMin} б/мин) · скорость ${params.speedKmh} км/ч · на точке ${params.serviceMin.default} мин`,
  );
  if (windows.length) console.log(`окна: ${windows.join(', ')}`);
  console.log(`→ ${rel(outPath)}`);
  return 0;
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse();
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
  }
  const [command, ...rest] = args.positionals;
  if (args.values.help || !command) {
    console.log(USAGE);
    return;
  }
  const gamesDir = resolve(args.values.games ?? GAMES_DIR);
  try {
    if (command === 'osm') {
      const city = rest.join(' ').trim();
      if (!city) fail(`Укажите город: ./bgq osm "Сремска Митровица"`);
      process.exitCode = await runOsm(gamesDir, city);
    } else if (command === 'matrix') {
      process.exitCode = await runMatrix(gamesDir, args.values);
    } else if (command === 'problem') {
      process.exitCode = runProblem(gamesDir, args.values);
    } else {
      fail(USAGE);
    }
  } catch (e) {
    if (!(e instanceof RoutingError)) throw e;
    fail(`✗ ${e.message}`);
  }
}

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      date: { type: 'string' },
      games: { type: 'string' },
      haversine: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

await main();
