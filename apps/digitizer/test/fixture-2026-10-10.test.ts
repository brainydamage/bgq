import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Game } from '@bgq/core';
import { buildIndex, type Gazetteer, type GeoResult, geocodeAll, haversineM } from '@bgq/geo';
import { ingest } from '@bgq/ingest';
import { describe, expect, it } from 'vitest';
import { computeMap } from '../src/compute.ts';
import type { MapFile } from '../src/model.ts';

const dir = join(import.meta.dirname, '../../../fixtures/2026-10-10');
const mapPath = join(dir, 'map.json');

/**
 * Разметка фото карты 10.10 (общее фото + 4 четверти, 16.10), сделанная в ./bgq map.
 * Порог 60 м: у ошибки есть «пол» ~25 м (кружки на бумаге стоят не точно на адресе
 * + ошибка geo), крупнее снимок его не убирает — у четверти 7082 p90 = 54 м.
 */
const P90_LIMIT_M = 60;
const hasMap = existsSync(mapPath);

// Тело describe выполняется и у пропущенного блока (сбор тестов) — читаем файлы, только если они есть.
function load() {
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  const game = JSON.parse(read('game.json')) as Game;
  const { kps } = ingest({ md: read('notion-export.md'), game });
  const geo = geocodeAll(kps, buildIndex(JSON.parse(read('osm-gazetteer.json')) as Gazetteer));
  const map = JSON.parse(read('map.json')) as MapFile;
  return { map, geo, ...computeMap(map.photos, geo) };
}

describe.skipIf(!hasMap)('digitizer на фото карты 10.10', () => {
  const { map, geo, summaries, results } = hasMap
    ? load()
    : {
        map: { photos: [], results: [] } as unknown as MapFile,
        geo: [] as GeoResult[],
        summaries: [],
        results: [],
      };

  it.each(map.photos.map((p) => p.file))(
    `%s: привязка точнее ${P90_LIMIT_M} м (p90 leave-one-out)`,
    (file) => {
      const s = summaries.find((x) => x.file === file);
      expect(s?.reason).toBeUndefined();
      expect(s?.report?.loo?.p90M).toBeLessThanOrEqual(P90_LIMIT_M);
    },
  );

  it('координаты есть у всех отмеченных КП', () => {
    const marked = new Set(map.photos.flatMap((p) => p.marks.map((m) => m.id)));
    expect(new Set(results.map((r) => r.id))).toEqual(marked);
  });

  it('пересчёт совпадает с сохранённым map.json (детерминизм)', () => {
    expect(results).toEqual(map.results);
  });

  it('83 — зелёная стрелка за краем карты: только цвет, без координат', () => {
    expect(results.find((r) => r.id === '83')).toEqual({
      id: '83',
      color: 'green',
      photo: 'IMG_7081.jpg',
      arrow: true,
    });
  });

  it('карта главнее адреса: 71Б — кружок в ~200 м от адреса, координаты с карты', () => {
    // В Notion «Лале Станковића 1», на карте кружок у «1г» — между ними ~200 м.
    // Не опорная: либо выброс по RANSAC, либо выключена вручную («не опорная»).
    const full = summaries.find((s) => s.file === 'IMG_7081.jpg');
    const disabled = map.photos.find((p) => p.file === 'IMG_7081.jpg')?.disabled ?? [];
    expect([...(full?.report?.outliers.map((o) => o.id) ?? []), ...disabled]).toContain('71Б');
    expect(full?.report?.inliers).not.toContain('71Б');
    const fromMap = results.find((r) => r.id === '71Б');
    const fromGeo = geo.find((g) => g.id === '71Б')?.loc;
    const loc = fromMap?.loc;
    expect(loc?.source).toBe('map');
    if (!loc || !fromGeo) throw new Error('нет 71Б');
    const d = haversineM([loc.lat, loc.lon], [fromGeo.lat, fromGeo.lon]);
    expect(d).toBeGreaterThan(150);
  });
});
