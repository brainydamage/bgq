#!/usr/bin/env node
// ./bgq kml [--date ГГГГ-ММ-ДД] [--all] — points.json → games/<дата>/points.kml для Organic Maps.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PointsFile, schemaErrors } from '@bgq/core';
import { currentGameDir, InitError, loadGame } from '@bgq/ingest';
import { buildKml, LEGEND } from './kml.ts';

const GAMES_DIR = resolve(import.meta.dirname, '../../../games');
const USAGE = [
  'usage: ./bgq kml [--date ГГГГ-ММ-ДД] [--all]',
  '  points.json → points.kml: старт, финиш и доступные КП для Organic Maps',
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

let values: { date?: string; games?: string; all?: boolean; help?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      date: { type: 'string' },
      games: { type: 'string' },
      all: { type: 'boolean', default: false },
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

const game = loadGame(join(gameDir, 'game.json'));
const { kml, placemarks, skipped } = buildKml(points as PointsFile, game.city, {
  includeIneligible: values.all ?? false,
});
const out = join(gameDir, 'points.kml');
writeFileSync(out, kml);

const t = points as PointsFile;
console.log(
  `Игра ${rel(gameDir)}: меток ${placemarks} (старт ${t.start ? '✓' : '✗'}, финиш ${t.finish ? '✓' : '✗'})`,
);
if (skipped.length) console.log(`△ без координат, на карту не попали: ${skipped.join(', ')}`);
console.log(LEGEND);
console.log(`→ ${rel(out)} — отправьте на телефон (AirDrop) и откройте в Organic Maps`);
