import { describe, expect, it } from 'vitest';
import {
  applyH,
  type ControlPoint,
  dist,
  type FitReport,
  fitHomography,
  fitPhoto,
  invert3,
  localProjection,
  type Mat3,
  mapConfidence,
  solveLinear,
  type XY,
} from '../src/index.ts';

const proj = localProjection(44.97, 19.61);

/** Мир (м) → пиксели фото: поворот, масштаб ~0,5 px/м, перспектива (снято под углом). */
const WORLD_TO_PX: Mat3 = [0.49, -0.09, 2000, 0.08, -0.5, 1500, 2e-5, -1.5e-5, 1];

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Синтетические опорные точки: шум geo noiseM, часть с грубой ошибкой outlierM. */
function synth(
  n: number,
  o: { noiseM?: number; outliers?: number; outlierM?: number; bend?: (px: XY) => XY } = {},
) {
  const r = rng(42);
  const points: ControlPoint[] = [];
  for (let i = 0; i < n; i++) {
    const world: XY = [(r() - 0.5) * 5000, (r() - 0.5) * 4000];
    let px = applyH(WORLD_TO_PX, world) as XY;
    if (o.bend) px = o.bend(px);
    const isOutlier = i < (o.outliers ?? 0);
    const noise = o.noiseM ?? 0;
    const shift = isOutlier ? (o.outlierM ?? 400) : 0;
    const geo: XY = [world[0] + gauss(r) * noise + shift, world[1] + gauss(r) * noise];
    points.push({ id: String(10 + i), px, ll: proj.toLatLon(geo) });
  }
  return points;
}

describe('линейная алгебра', () => {
  it('solveLinear / вырожденная система', () => {
    expect(
      solveLinear(
        [
          [2, 1],
          [1, 3],
        ],
        [3, 5],
      )?.map((x) => Math.round(x * 1e9) / 1e9),
    ).toEqual([0.8, 1.4]);
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
  });

  it('invert3 · исходная = единичная', () => {
    const inv = invert3(WORLD_TO_PX) as Mat3;
    const p = applyH(inv, applyH(WORLD_TO_PX, [123, -456]) as XY) as XY;
    expect(p[0]).toBeCloseTo(123, 6);
    expect(p[1]).toBeCloseTo(-456, 6);
  });
});

describe('fitHomography', () => {
  it('без шума восстанавливает преобразование точно', () => {
    const world: XY[] = [
      [0, 0],
      [1000, 0],
      [0, 1000],
      [1000, 1000],
      [400, 700],
      [-800, 300],
    ];
    const px = world.map((w) => applyH(WORLD_TO_PX, w) as XY);
    const h = fitHomography(px, world) as Mat3;
    for (let i = 0; i < world.length; i++) {
      expect(dist(applyH(h, px[i] as XY) as XY, world[i] as XY)).toBeLessThan(1e-6);
    }
  });

  it('три точки на одной прямой из четырёх — вырождено', () => {
    const px: XY[] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ];
    expect(fitHomography(px, px)).toBeNull();
  });
});

describe('fitPhoto', () => {
  it('меньше 4 опорных — понятный отказ', () => {
    const r = fitPhoto(synth(3));
    expect(r).toMatchObject({ ok: false, controls: 3 });
  });

  it('шум geo 10 м + 4 грубых выброса: выбросы найдены, точность ~ шум', () => {
    const r = fitPhoto(synth(30, { noiseM: 10, outliers: 4, outlierM: 400 }));
    if (!r.ok) throw new Error(r.reason);
    expect(r.report.outliers.map((o) => o.id).sort()).toEqual(['10', '11', '12', '13']);
    expect(r.report.outliers.every((o) => o.errorM > 300)).toBe(true);
    expect(r.report.inliers).toHaveLength(26);
    expect(r.report.loo?.medianM).toBeLessThan(15);
  });

  it('predict и toPixel взаимно обратны (без местной поправки)', () => {
    const r = fitPhoto(synth(12), { correction: null });
    if (!r.ok) throw new Error(r.reason);
    const px: XY = [1234, 987];
    const back = r.toPixel(r.predict(px) as [number, number]) as XY;
    expect(dist(back, px)).toBeLessThan(1e-3);
  });

  it('сгиб карты: местная поправка уменьшает ошибку', () => {
    // Сгиб — вертикальная полоса у x≈2000 px, сдвигает точки до 20 px (~40 м).
    const bend = ([x, y]: XY): XY => [x + 20 * Math.exp(-(((x - 2000) / 250) ** 2)), y];
    const points = synth(40, { noiseM: 5, bend });
    const plain = fitPhoto(points, { correction: null });
    const corrected = fitPhoto(points);
    if (!plain.ok || !corrected.ok) throw new Error('fit failed');
    expect(corrected.report.loo?.medianM).toBeLessThan(plain.report.loo?.medianM ?? 0);
  });

  it('детерминирован: те же точки — тот же отчёт', () => {
    const points = synth(25, { noiseM: 10, outliers: 3 });
    const a = fitPhoto(points);
    const b = fitPhoto(points);
    if (!a.ok || !b.ok) throw new Error('fit failed');
    expect(a.report).toEqual(b.report);
  });
});

it('mapConfidence по p90 leave-one-out', () => {
  const rep = (p90M: number | null): FitReport => ({
    controls: 10,
    inliers: [],
    outliers: [],
    loo: p90M === null ? null : { medianM: 0, p90M, maxM: 0, rows: [] },
  });
  expect([rep(25), rep(45), rep(80), rep(200), rep(null)].map(mapConfidence)).toEqual([
    0.9, 0.8, 0.6, 0.4, 0.5,
  ]);
});
