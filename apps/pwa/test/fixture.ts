// Данные игры 10.10 для тестов телефона: таблица КП, план солвера, задания с листков.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Game,
  type MapFileResults,
  type Plan,
  type PointsFile,
  parseRiddleSheets,
  type SheetTask,
  taskId,
} from '@bgq/core';
import { buildIndex, type Gazetteer, geocodeAll } from '@bgq/geo';
import { ingest } from '@bgq/ingest';
import { buildTable } from '@bgq/table';

export const fx = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../../fixtures/2026-10-10', name), 'utf8');
export const game = JSON.parse(fx('game.json')) as Game;
// План солвера по fixtures/2026-10-10/problem.json: выход 12:30, 37 КП, 207 б.
export const plan = JSON.parse(fx('plan.json')) as Plan;

/** Таблица 10.10 + старт и финиш, как если бы их отметили на карте (как в kml.test.ts). */
export function table(): PointsFile {
  const { kps } = ingest({ md: fx('notion-export.md'), game, overrides: fx('overrides.yaml') });
  const geo = geocodeAll(kps, buildIndex(JSON.parse(fx('osm-gazetteer.json')) as Gazetteer));
  const map = JSON.parse(fx('map.json')) as MapFileResults;
  const loc = (lat: number, lon: number) => ({ lat, lon, source: 'map' as const, confidence: 0.8 });
  map.results.push(
    { id: 'start', loc: loc(44.9776, 19.601), color: null, photo: 'IMG_7081.jpg' },
    { id: 'finish', loc: loc(44.9705, 19.6093), color: null, photo: 'IMG_7081.jpg' },
  );
  return buildTable({
    game,
    kps,
    kpsAt: '2026-10-16T21:12:00.000Z',
    geo: { osmBase: '2026-10-15T20:21:00Z', results: geo },
    map,
    now: new Date('2026-10-16T23:00:00Z'),
  });
}

/** Задания 10.10 из расшифровки листков (как их сохраняет страница «Загадки»): 10 штук, 56 б. */
export function sheetTasks(): SheetTask[] {
  const tasks: SheetTask[] = [];
  for (const t of parseRiddleSheets(fx('sheets.md')).tasks) {
    tasks.push({
      id: taskId(t.title, new Set(tasks.map((x) => x.id))),
      title: t.title,
      text: t.text,
      points: t.points ?? 0,
      ...(t.pointsMax && { pointsMax: t.pointsMax }),
      atFinish: t.atFinish,
      notes: '',
      updatedAt: '2026-10-10T12:30:00+02:00',
    });
  }
  return tasks;
}
