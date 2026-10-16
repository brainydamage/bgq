#!/usr/bin/env node
// ./bgq table [--date ГГГГ-ММ-ДД] — kps.json + geo.json + map.json → games/<дата>/points.json.
// Код выхода 1 — есть критичные (доступный КП без координат, неизвестный номер на карте).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Kp, MapFileResults, PointsFile, schemaErrors } from '@bgq/core';
import type { GeoResult } from '@bgq/geo';
import { currentGameDir, InitError, loadGame } from '@bgq/ingest';
import { buildTable } from './build.ts';
import { formatTableSummary } from './report.ts';

const GAMES_DIR = resolve(import.meta.dirname, '../../../games');
const USAGE = 'usage: ./bgq table [--date ГГГГ-ММ-ДД]   kps + geo + map → games/<дата>/points.json';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Путь относительно cwd; вне cwd — абсолютный. */
function rel(path: string): string {
  const r = relative(process.cwd(), path);
  return r.startsWith('..') ? resolve(path) : r || '.';
}

function main(): void {
  let values: { date?: string; games?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        date: { type: 'string' },
        games: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }

  let gameDir: string;
  try {
    gameDir = currentGameDir(resolve(values.games ?? GAMES_DIR), values.date);
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    fail(`✗ ${e.message}`);
  }
  const path = (name: string) => join(gameDir, name);
  if (!existsSync(path('kps.json'))) fail(`✗ Нет ${rel(path('kps.json'))} — сначала ./bgq parse`);

  const game = loadGame(path('game.json'));
  const kps = (JSON.parse(readFileSync(path('kps.json'), 'utf8')) as { kps: Kp[] }).kps;
  const kpsAt = statSync(path('kps.json')).mtime.toISOString();

  let geo: { osmBase: string; results: GeoResult[] } | undefined;
  if (existsSync(path('geo.json'))) {
    const g = JSON.parse(readFileSync(path('geo.json'), 'utf8')) as {
      osm: { osmBase: string };
      results: GeoResult[];
    };
    geo = { osmBase: g.osm.osmBase, results: g.results };
  } else {
    console.log('△ нет geo.json — КП не на карте останутся без координат (./bgq geo)');
  }

  let map: MapFileResults | undefined;
  if (existsSync(path('map.json'))) {
    const m: unknown = JSON.parse(readFileSync(path('map.json'), 'utf8'));
    const errors = schemaErrors(MapFileResults, m);
    if (errors.length) fail(`✗ ${rel(path('map.json'))}: ${errors.join('; ')}`);
    map = m as MapFileResults;
  } else {
    console.log('△ нет map.json — координаты только по адресам (./bgq map)');
  }

  const table = buildTable({ game, kps, kpsAt, ...(geo && { geo }), ...(map && { map }) });
  const errors = schemaErrors(PointsFile, table);
  if (errors.length) fail(`✗ points.json не проходит схему (ошибка в коде): ${errors.join('; ')}`);
  writeFileSync(path('points.json'), `${JSON.stringify(table, null, 2)}\n`);

  console.log(`Игра ${rel(gameDir)}\n`);
  console.log(formatTableSummary(table));
  console.log(`→ ${rel(path('points.json'))}`);
  process.exitCode = table.issues.some((i) => i.severity === 'critical') ? 1 : 0;
}

main();
