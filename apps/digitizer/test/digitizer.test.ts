import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { GeoResult } from '@bgq/geo';
import { applyH, localProjection, type Mat3, type XY } from '@bgq/georef';
import { describe, expect, it } from 'vitest';
import { createApi } from '../server/api.ts';
import { computeMap } from '../src/compute.ts';
import { formatWindow, parseLabelId, parseWindow } from '../src/LabelPopover.tsx';
import type { MapFile, Mark, PhotoLabels } from '../src/model.ts';

const proj = localProjection(44.97, 19.61);
const WORLD_TO_PX: Mat3 = [0.49, -0.09, 2000, 0.08, -0.5, 1500, 2e-5, -1.5e-5, 1];

/** КП с адресом: координаты geo + точка на фото по известному преобразованию. */
function scene() {
  const world: Record<string, XY> = {
    '10': [-1500, -1000],
    '11': [1500, -1200],
    '12': [1400, 1300],
    '13': [-1300, 1200],
    '14': [0, 0],
    '15': [600, -400],
    '16': [-700, 500],
  };
  const geo: GeoResult[] = Object.entries(world).map(([id, w]) => {
    const [lat, lon] = proj.toLatLon(w);
    return { id, method: 'exact', loc: { lat, lon, source: 'geocode', confidence: 0.95 } };
  });
  geo.push({ id: '20', reason: 'no_address' });
  geo.push({
    id: '21',
    method: 'street',
    loc: { lat: 44.97, lon: 19.61, source: 'geocode', confidence: 0.2 },
  });
  const px = (w: XY) => applyH(WORLD_TO_PX, w) as XY;
  const marks: Mark[] = Object.entries(world).map(([id, w]) => {
    const [x, y] = px(w);
    return { id, x, y, color: 'red' };
  });
  // «Родник» без адреса — его координаты и надо получить с карты.
  const [x20, y20] = px([300, 900]);
  marks.push({ id: '20', x: x20, y: y20, color: 'blue' });
  // «только улица» — не опорная, даже если отмечена.
  const [x21, y21] = px([-200, -300]);
  marks.push({ id: '21', x: x21, y: y21, color: 'red' });
  return { geo, marks };
}

describe('окно отметки: номер и окно работы', () => {
  it.each([
    ['25а', '25А'],
    ['старт', 'start'],
    ['С', 'start'],
    ['finish', 'finish'],
    ['ф', 'finish'],
    ['abc', null],
  ])('parseLabelId(%s) = %s', (text, id) => {
    expect(parseLabelId(text)).toBe(id);
  });

  it.each([
    ['14-18', { from: '14:00', to: '18:00' }],
    ['14–18', { from: '14:00', to: '18:00' }],
    ['с 14 до 18', { from: '14:00', to: '18:00' }],
    ['9:30-12', { from: '09:30', to: '12:00' }],
    ['', null],
    ['18-14', undefined],
    ['25-26', undefined],
    ['после обеда', undefined],
  ])('parseWindow(%s)', (text, w) => {
    expect(parseWindow(text)).toEqual(w);
  });

  it('formatWindow', () => {
    expect(formatWindow({ from: '14:00', to: '18:30' })).toBe('14–18:30');
  });
});

describe('computeMap', () => {
  it('старт/финиш и окно работы доходят до результата; старт не опорная', () => {
    const { geo, marks } = scene();
    const [sx, sy] = applyH(WORLD_TO_PX, [100, 100]) as XY;
    const extra: Mark[] = [
      { id: 'start', x: sx, y: sy, color: null },
      ...marks.map((m) => (m.id === '20' ? { ...m, window: { from: '14:00', to: '18:00' } } : m)),
    ];
    const { fits, results } = computeMap([{ file: 'a.jpg', marks: extra, disabled: [] }], geo);
    const fit = fits[0]?.fit;
    expect(fit?.ok && fit.report.controls).toBe(7);
    expect(results.find((r) => r.id === 'start')?.loc?.source).toBe('map');
    expect(results.find((r) => r.id === '20')?.window).toEqual({ from: '14:00', to: '18:00' });
  });

  it('КП без адреса получает координаты с карты; опорные — только надёжные адреса', () => {
    const { geo, marks } = scene();
    const photos: PhotoLabels[] = [{ file: 'full.jpg', marks, disabled: [] }];
    const { fits, results } = computeMap(photos, geo);
    const fit = fits[0]?.fit;
    if (!fit?.ok) throw new Error('fit failed');
    expect(fit.report.controls).toBe(7);
    expect(fits[0]?.status.get('21')).toBe('plain');

    const r20 = results.find((r) => r.id === '20');
    const truth = proj.toLatLon([300, 900]);
    expect(r20?.loc?.source).toBe('map');
    expect(r20?.color).toBe('blue');
    expect(Math.abs((r20?.loc?.lat ?? 0) - truth[0])).toBeLessThan(1e-5);
    expect(Math.abs((r20?.loc?.lon ?? 0) - truth[1])).toBeLessThan(1e-5);
  });

  it('стрелка за краем карты: не опорная, даёт цвет, координат нет; кружок важнее стрелки', () => {
    const { geo, marks } = scene();
    const arrowMarks = marks.map((m) =>
      m.id === '10' ? { ...m, arrow: true, color: 'green' as const } : m,
    );
    const { fits, results } = computeMap([{ file: 'a.jpg', marks: arrowMarks, disabled: [] }], geo);
    const fit = fits[0]?.fit;
    expect(fit?.ok && fit.report.controls).toBe(6);
    expect(fits[0]?.status.get('10')).toBe('arrow');
    expect(results.find((r) => r.id === '10')).toEqual({
      id: '10',
      color: 'green',
      photo: 'a.jpg',
      arrow: true,
    });
    // На втором фото тот же КП — кружком: он и побеждает.
    const both = computeMap(
      [
        { file: 'a.jpg', marks: arrowMarks, disabled: [] },
        { file: 'b.jpg', marks, disabled: [] },
      ],
      geo,
    ).results.find((r) => r.id === '10');
    expect(both?.photo).toBe('b.jpg');
    expect(both?.loc?.source).toBe('map');
  });

  it('выключенная опорная точка не участвует в привязке', () => {
    const { geo, marks } = scene();
    const { fits } = computeMap([{ file: 'a.jpg', marks, disabled: ['10'] }], geo);
    const fit = fits[0]?.fit;
    expect(fit?.ok && fit.report.controls).toBe(6);
    expect(fits[0]?.status.get('10')).toBe('disabled');
  });

  it('мало опорных — привязки нет, результатов нет, причина понятна', () => {
    const { geo, marks } = scene();
    const { summaries, results } = computeMap(
      [{ file: 'a.jpg', marks: marks.slice(0, 3), disabled: [] }],
      geo,
    );
    expect(summaries[0]?.reason).toMatch(/≥ 4/);
    expect(results).toEqual([]);
  });

  it('КП на двух фото — берётся фото с лучшей точностью', () => {
    const { geo, marks } = scene();
    // Второе фото: тот же КП 20, но опорные точки с шумом → точность хуже.
    const noisy = marks.map((m, i) => (m.id === '20' ? m : { ...m, x: m.x + (i % 2 ? 25 : -25) }));
    const { results } = computeMap(
      [
        { file: 'noisy.jpg', marks: noisy, disabled: [] },
        { file: 'clean.jpg', marks, disabled: [] },
      ],
      geo,
    );
    expect(results.find((r) => r.id === '20')?.photo).toBe('clean.jpg');
  });
});

/** Минимальная имитация запроса/ответа node:http для обработчика API. */
async function call(
  api: ReturnType<typeof createApi>,
  method: string,
  url: string,
  body?: Buffer | string,
): Promise<{ status: number; json: unknown; body: Buffer }> {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(body)],
  ) as unknown as IncomingMessage;
  Object.assign(req, { method, url });
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      write(c: Buffer) {
        chunks.push(Buffer.from(c));
        return true;
      },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
        const buf = Buffer.concat(chunks);
        let json: unknown = null;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch {}
        resolve({ status: (res as { statusCode: number }).statusCode, json, body: buf });
      },
      on() {
        return res;
      },
      once() {
        return res;
      },
      emit() {
        return true;
      },
    } as unknown as ServerResponse;
    void api.handle(req, res);
  });
}

describe('API digitizer', () => {
  function gameDir() {
    const dir = mkdtempSync(join(tmpdir(), 'bgq-digitizer-'));
    const game = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../fixtures/2026-10-10/game.json'), 'utf8'),
    );
    writeFileSync(join(dir, 'game.json'), JSON.stringify(game));
    writeFileSync(join(dir, 'kps.json'), JSON.stringify({ kps: [] }));
    return dir;
  }

  it('state: игра, пустые geo/map, фото из папки', async () => {
    const dir = gameDir();
    mkdirSync(join(dir, 'photos'));
    writeFileSync(join(dir, 'photos', 'b.jpg'), 'x');
    writeFileSync(join(dir, 'photos', 'notes.txt'), 'x');
    const r = await call(createApi(dir), 'GET', '/state');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ geo: [], map: null, photos: ['b.jpg'], kps: [] });
  });

  it('загрузка фото: имя без путей, повтор — с суффиксом', async () => {
    const api = createApi(gameDir());
    const a = await call(
      api,
      'POST',
      `/photos?name=${encodeURIComponent('../../evil.jpg')}`,
      'jpg',
    );
    const b = await call(api, 'POST', '/photos?name=evil.jpg', 'jpg');
    expect(a.json).toEqual({ file: 'evil.jpg' });
    expect(b.json).toEqual({ file: 'evil-2.jpg' });
    const notPhoto = await call(api, 'POST', '/photos?name=a.txt', 'x');
    expect(notPhoto.status).toBe(415);
  });

  it('map.json: сохраняется и читается обратно; мусор — 400', async () => {
    const dir = gameDir();
    const api = createApi(dir);
    const map: MapFile = {
      v: 1,
      gameId: '2026-10-10',
      updatedAt: '2026-10-16T20:00:00.000Z',
      photos: [{ file: 'a.jpg', marks: [{ id: '20', x: 1, y: 2, color: 'red' }], disabled: [] }],
      fits: [],
      results: [],
    };
    expect((await call(api, 'PUT', '/map', JSON.stringify(map))).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, 'map.json'), 'utf8'))).toEqual(map);
    expect((await call(api, 'GET', '/state')).json).toMatchObject({ map });
    expect((await call(api, 'PUT', '/map', '{"v":2}')).status).toBe(400);
  });

  it('чтение фото за пределами папки невозможно', async () => {
    const r = await call(
      createApi(gameDir()),
      'GET',
      `/photos/${encodeURIComponent('../game.json')}`,
    );
    expect(r.status).toBe(404);
  });
});
