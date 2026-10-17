#!/usr/bin/env node
// ./bgq kml [--date ГГГГ-ММ-ДД] [--all] — points.json (+ plan.json) → games/<дата>/points.kml для Organic Maps.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Plan, PointsFile, schemaErrors } from '@bgq/core';
import { citySlug } from '@bgq/geo';
import { currentGameDir, InitError, loadGame } from '@bgq/ingest';
import {
  cityGraphDir,
  dockerAvailable,
  graphReady,
  osrmRoute,
  problemHash,
  RoutingError,
  withOsrm,
} from '@bgq/routing';
import { buildKml, LEGEND, PLAN_LEGEND } from './kml.ts';

const GAMES_DIR = resolve(import.meta.dirname, '../../../games');
const USAGE = [
  'usage: ./bgq kml [--date ГГГГ-ММ-ДД] [--all] [--straight]',
  '  points.json → points.kml: старт, финиш и доступные КП для Organic Maps',
  '  есть свежий plan.json (./bgq solve) — ещё линия маршрута по улицам (OSRM в Docker)',
  '  и номера КП по порядку; без Docker или с --straight — линия прямыми отрезками',
  '  --all — добавить недоступные КП (вело) серым',
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

let values: { date?: string; games?: string; all?: boolean; straight?: boolean; help?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      date: { type: 'string' },
      games: { type: 'string' },
      all: { type: 'boolean', default: false },
      straight: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  fail(`${(e as Error).message}\n${USAGE}`);
}
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
const pointsPath = join(gameDir, 'points.json');
if (!existsSync(pointsPath)) fail(`✗ Нет ${rel(pointsPath)} — сначала ./bgq table`);
const points: unknown = JSON.parse(readFileSync(pointsPath, 'utf8'));
const errors = schemaErrors(PointsFile, points);
if (errors.length) fail(`✗ ${rel(pointsPath)}: ${errors.join('; ')} — пересоберите ./bgq table`);

/** plan.json, если он построен по текущему problem.json, а тот — не старее points.json. */
function loadPlan(): { plan?: Plan; why?: string } {
  const planPath = join(gameDir, 'plan.json');
  const problemPath = join(gameDir, 'problem.json');
  if (!existsSync(planPath)) return {};
  const plan: unknown = JSON.parse(readFileSync(planPath, 'utf8'));
  const errors = schemaErrors(Plan, plan);
  if (errors.length) return { why: `plan.json не проходит схему: ${errors.join('; ')}` };
  if (!existsSync(problemPath)) return { why: 'нет problem.json' };
  if (statSync(pointsPath).mtimeMs > statSync(problemPath).mtimeMs) {
    return { why: 'points.json новее problem.json' };
  }
  if ((plan as Plan).problemHash !== problemHash(readFileSync(problemPath))) {
    return { why: 'problem.json изменился после ./bgq solve' };
  }
  return { plan: plan as Plan };
}

/** Линия маршрута по улицам: OSRM в Docker поднимается на один запрос (~1 с). */
async function streetPath(
  t: PointsFile,
  p: Plan,
): Promise<{ path?: { lat: number; lon: number }[]; why?: string }> {
  const loc = new Map(t.kps.flatMap((k) => (k.eligible && k.loc ? [[k.id, k.loc] as const] : [])));
  const stops = p.stops.map((s) => loc.get(s.kpId));
  if (!t.start || !t.finish || stops.some((s) => !s)) return {};
  const dir = cityGraphDir(resolve(values.games ?? GAMES_DIR), citySlug(game.city));
  try {
    if (!graphReady(dir))
      throw new RoutingError(`нет графа ${rel(dir)} — ./bgq osm "${game.city}"`);
    if (!dockerAvailable()) throw new RoutingError('Docker не запущен (откройте Docker Desktop)');
    const pts = [t.start, ...(stops as { lat: number; lon: number }[]), t.finish];
    return { path: (await withOsrm(dir, (url) => osrmRoute(url, pts))).path };
  } catch (e) {
    if (!(e instanceof RoutingError)) throw e;
    return { why: e.message };
  }
}

const game = loadGame(join(gameDir, 'game.json'));
const { plan, why } = loadPlan();
const street = plan && !values.straight ? await streetPath(points as PointsFile, plan) : {};
const { kml, placemarks, skipped, planMissing, unsolved } = buildKml(
  points as PointsFile,
  game.city,
  {
    includeIneligible: values.all ?? false,
    plan,
    ...(street.path && { routePath: street.path }),
  },
);
const out = join(gameDir, 'points.kml');
writeFileSync(out, kml);

const t = points as PointsFile;
console.log(
  `Игра ${rel(gameDir)}: меток ${placemarks} (старт ${t.start ? '✓' : '✗'}, финиш ${t.finish ? '✓' : '✗'})`,
);
if (skipped.length) console.log(`△ без координат, на карту не попали: ${skipped.join(', ')}`);
if (unsolved.length) console.log(`🧩 загадки не решены (не на карте): ${unsolved.join(', ')}`);
if (why) console.log(`△ план устарел (${why}) — маршрут не добавлен; ./bgq problem && ./bgq solve`);
if (planMissing.length) {
  console.log(`△ в плане КП не с этой карты: ${planMissing.join(', ')} — маршрут не добавлен`);
}
if (plan && !planMissing.length) {
  console.log(
    `маршрут: ${plan.stops.length} КП · ${plan.totalPoints} б · ${(plan.distanceM / 1000).toFixed(1).replace('.', ',')} км · ${street.path ? 'линия по улицам (OSRM)' : 'линия — прямые отрезки'}`,
  );
  if (street.why) console.log(`△ по улицам не нарисовать: ${street.why}`);
}
console.log(LEGEND);
if (plan && !planMissing.length) console.log(PLAN_LEGEND);
console.log(`→ ${rel(out)} — отправьте на телефон (AirDrop) и откройте в Organic Maps`);
