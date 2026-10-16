#!/usr/bin/env node
// Запуск: ./bgq geo | ./bgq osm <город> (скрипт в корне репо).
// geo — координаты адресных КП последней игры по справочнику OSM → games/<дата>/geo.json.
// osm — накануне игры: выгрузка OSM Сербии с Geofabrik → справочник города games/osm/<город>.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Kp } from '@bgq/core';
import { currentGameDir, InitError, loadGame } from '@bgq/ingest';
import { evaluate, parseReference } from './evaluate.ts';
import { buildIndex, type Gazetteer, serializeGazetteer } from './gazetteer.ts';
import { geocodeAll } from './geocode.ts';
import { toAsciiLatin } from './normalize.ts';
import { downloadPbf, gazetteerFromPbf, OsmiumError } from './osmium.ts';
import { formatEval, formatGeoSummary } from './report.ts';

const GAMES_DIR = resolve(import.meta.dirname, '../../../games');
const RADIUS_M = 5000;
const PBF_NAME = 'serbia-latest.osm.pbf';

const USAGE = [
  'usage:',
  '  ./bgq osm <город> [--refresh]   накануне игры: справочник адресов OSM → games/osm/',
  '                                  (--refresh — заново скачать выгрузку Сербии, ~240 МБ)',
  '  ./bgq geo [--date ГГГГ-ММ-ДД] [--reference <reference.yaml>]',
  '                                  координаты адресных КП последней игры → geo.json',
].join('\n');

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
  if (command === 'osm') {
    const city = rest.join(' ').trim();
    if (!city) fail(`Укажите город: ./bgq osm "Сремска Митровица"\n${USAGE}`);
    await loadGazetteer(gamesDir, city, { rebuild: true, redownload: args.values.refresh });
    return;
  }
  if (command === 'geo') {
    if (rest.length) fail(`geo не принимает аргументов, получено: ${rest.join(' ')}\n${USAGE}`);
    process.exitCode = await runGeo(gamesDir, args.values);
    return;
  }
  fail(USAGE);
}

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      date: { type: 'string' },
      refresh: { type: 'boolean', default: false },
      reference: { type: 'string' },
      games: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

async function runGeo(gamesDir: string, o: { date?: string; reference?: string }): Promise<number> {
  let gameDir: string;
  try {
    gameDir = currentGameDir(gamesDir, o.date);
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    fail(`✗ ${e.message}`);
  }
  const kpsPath = join(gameDir, 'kps.json');
  if (!existsSync(kpsPath)) fail(`✗ Нет ${rel(kpsPath)} — сначала ./bgq parse`);
  const game = loadGame(join(gameDir, 'game.json'));
  const { kps } = JSON.parse(readFileSync(kpsPath, 'utf8')) as { kps: Kp[] };

  const gaz = await loadGazetteer(gamesDir, game.city, { rebuild: false, redownload: false });
  const results = geocodeAll(kps, buildIndex(gaz));
  const outPath = join(gameDir, 'geo.json');
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        gameId: game.id,
        osm: { city: gaz.city, osmBase: gaz.osmBase, fetchedAt: gaz.fetchedAt },
        results,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Игра ${rel(gameDir)} · OSM: ${gaz.city}, данные на ${gaz.osmBase.slice(0, 10)}\n`);
  console.log(formatGeoSummary(results));
  if (o.reference) {
    console.log(
      `\n${formatEval(evaluate(results, parseReference(readFileSync(o.reference, 'utf8'))))}`,
    );
  }
  console.log(`→ ${rel(outPath)}`);
  return 0;
}

/**
 * games/osm/<город>.json. Если его нет (или rebuild) — собираем из выгрузки Сербии
 * games/osm/serbia-latest.osm.pbf; выгрузку качаем, только если её нет (или redownload).
 */
async function loadGazetteer(
  gamesDir: string,
  city: string,
  o: { rebuild: boolean; redownload: boolean },
): Promise<Gazetteer> {
  const osmDir = join(gamesDir, 'osm');
  const slug = toAsciiLatin(city)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const path = join(osmDir, `${slug}.json`);
  if (existsSync(path) && !o.rebuild && !o.redownload) {
    return JSON.parse(readFileSync(path, 'utf8')) as Gazetteer;
  }

  mkdirSync(osmDir, { recursive: true });
  const pbf = join(osmDir, PBF_NAME);
  if (!existsSync(pbf) || o.redownload) {
    console.log('Качаю выгрузку OSM Сербии с Geofabrik (~240 МБ)…');
    const t0 = Date.now();
    try {
      await downloadPbf(pbf);
    } catch (e) {
      fail(`✗ ${(e as Error).message}`);
    }
    console.log(`✓ за ${Math.round((Date.now() - t0) / 1000)} с → ${rel(pbf)}`);
  }

  console.log(`Собираю справочник: ${city}, радиус ${RADIUS_M / 1000} км…`);
  let gaz: Gazetteer;
  try {
    gaz = gazetteerFromPbf(pbf, city, RADIUS_M);
  } catch (e) {
    if (!(e instanceof OsmiumError)) throw e;
    fail(`✗ ${e.message}`);
  }
  writeFileSync(path, serializeGazetteer(gaz));
  console.log(
    `✓ улиц ${gaz.streets.length}, адресов ${gaz.addresses.length}, данные OSM на ${gaz.osmBase.slice(0, 10)} → ${rel(path)}\n`,
  );
  return gaz;
}

/** Путь относительно cwd; вне cwd — абсолютный. */
function rel(path: string): string {
  const r = relative(process.cwd(), path);
  return r.startsWith('..') ? resolve(path) : r || '.';
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

await main();
