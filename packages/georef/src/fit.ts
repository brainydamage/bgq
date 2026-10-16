import { type CorrectionOptions, makeCorrection } from './correct.ts';
import { applyH, fitHomography, inverseH } from './homography.ts';
import { dist, type XY } from './linalg.ts';
import { type LatLon, projectionFor } from './project.ts';
import { ransacHomography } from './ransac.ts';

/** Опорная точка: кружок КП на фото (пиксели) + его координаты из geo. */
export interface ControlPoint {
  id: string;
  px: XY;
  ll: LatLon;
}

export interface FitOptions {
  /** Порог RANSAC, м: дальше — выброс (перепутанный номер, ошибка geo). */
  thresholdM: number;
  maxIterations: number;
  seed: number;
  /** Местная поправка от сгибов; null — только гомография. */
  correction: CorrectionOptions | null;
  /** Поправку включаем, только если опорных точек достаточно. */
  minForCorrection: number;
}

export const DEFAULT_FIT: FitOptions = {
  thresholdM: 60,
  maxIterations: 1000,
  seed: 1,
  correction: { k: 6, softM: 40 },
  minForCorrection: 6,
};

export interface ErrorRow {
  id: string;
  errorM: number;
}

export interface FitReport {
  controls: number;
  inliers: string[];
  outliers: ErrorRow[];
  /** Точность по leave-one-out: каждая «своя» точка предсказана по остальным. null — точек < 5. */
  loo: { medianM: number; p90M: number; maxM: number; rows: ErrorRow[] } | null;
}

export type FitResult =
  | {
      ok: true;
      report: FitReport;
      /** Пиксель фото → координаты. */
      predict(px: XY): LatLon | null;
      /** Координаты → пиксель фото (без местной поправки) — показать, где «должен быть» КП. */
      toPixel(ll: LatLon): XY | null;
    }
  | { ok: false; reason: string; controls: number };

function quantile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] ?? Number.NaN;
}

function buildModel(src: readonly XY[], dst: readonly XY[], o: FitOptions) {
  const h = fitHomography(src, dst);
  if (!h) return null;
  let correct = (p: XY) => p;
  if (o.correction && src.length >= o.minForCorrection) {
    const predicted = src.map((p) => applyH(h, p) ?? p);
    correct = makeCorrection(predicted, dst, o.correction);
  }
  return {
    h,
    forward: (px: XY): XY | null => {
      const p = applyH(h, px);
      return p ? correct(p) : null;
    },
  };
}

/** Привязка одного фото по опорным точкам. Детерминирована. */
export function fitPhoto(
  points: readonly ControlPoint[],
  options: Partial<FitOptions> = {},
): FitResult {
  const o = { ...DEFAULT_FIT, ...options };
  if (points.length < 4) {
    return {
      ok: false,
      reason: `нужно ≥ 4 опорных точек, сейчас ${points.length}`,
      controls: points.length,
    };
  }
  const proj = projectionFor(points.map((p) => p.ll));
  const src = points.map((p) => p.px);
  const dst = points.map((p) => proj.toXY(p.ll));

  const ransac = ransacHomography(src, dst, o);
  if (!ransac) {
    return {
      ok: false,
      reason: 'не удалось привязать: точки почти на одной прямой или слишком много выбросов',
      controls: points.length,
    };
  }
  const inSet = new Set(ransac.inliers);
  const inSrc = ransac.inliers.map((i) => src[i] as XY);
  const inDst = ransac.inliers.map((i) => dst[i] as XY);
  const model = buildModel(inSrc, inDst, o);
  if (!model) return { ok: false, reason: 'вырожденная привязка', controls: points.length };

  const errorAt = (forward: (px: XY) => XY | null, i: number) => {
    const p = forward(src[i] as XY);
    return p ? Math.round(dist(p, dst[i] as XY)) : Number.POSITIVE_INFINITY;
  };

  const outliers = points
    .map((p, i) => ({ id: p.id, i }))
    .filter(({ i }) => !inSet.has(i))
    .map(({ id, i }) => ({ id, errorM: errorAt(model.forward, i) }));

  let loo: FitReport['loo'] = null;
  if (ransac.inliers.length >= 5) {
    const rows: ErrorRow[] = [];
    for (const i of ransac.inliers) {
      const rest = ransac.inliers.filter((j) => j !== i);
      const m = buildModel(
        rest.map((j) => src[j] as XY),
        rest.map((j) => dst[j] as XY),
        o,
      );
      rows.push({
        id: points[i]?.id ?? '',
        errorM: m ? errorAt(m.forward, i) : Number.POSITIVE_INFINITY,
      });
    }
    const sorted = rows.map((r) => r.errorM).sort((a, b) => a - b);
    loo = {
      medianM: quantile(sorted, 0.5),
      p90M: quantile(sorted, 0.9),
      maxM: sorted.at(-1) ?? Number.NaN,
      rows,
    };
  }

  const inverse = inverseH(model.h);
  return {
    ok: true,
    report: {
      controls: points.length,
      inliers: ransac.inliers.map((i) => points[i]?.id ?? ''),
      outliers,
      loo,
    },
    predict: (px) => {
      const p = model.forward(px);
      return p ? proj.toLatLon(p) : null;
    },
    toPixel: (ll) => (inverse ? applyH(inverse, proj.toXY(ll)) : null),
  };
}

/** Уверенность координат с карты по точности привязки (p90 leave-one-out). */
export function mapConfidence(report: FitReport): number {
  const p90 = report.loo?.p90M;
  if (p90 === undefined) return 0.5;
  if (p90 <= 30) return 0.9;
  if (p90 <= 50) return 0.8;
  if (p90 <= 100) return 0.6;
  return 0.4;
}
