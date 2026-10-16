import { dist, type XY } from './linalg.ts';

export interface CorrectionOptions {
  /** Сколько ближайших опорных точек учитывать. */
  k: number;
  /**
   * Сглаживание, м: вес 1 / (d² + soft²). Не даёт поправке в точности повторять остаток
   * у опорной точки — в нём есть и шум геокодинга, а не только сгиб карты.
   */
  softM: number;
}

/**
 * Местная поправка после гомографии: остатки опорных точек (эталон − предсказание)
 * интерполируются по ближайшим. Сгиб карты или неровная земля дают плавный местный сдвиг.
 */
export function makeCorrection(
  predicted: readonly XY[],
  actual: readonly XY[],
  o: CorrectionOptions,
): (p: XY) => XY {
  const residuals = predicted.map((p, i) => ({
    at: p,
    r: [(actual[i]?.[0] ?? 0) - p[0], (actual[i]?.[1] ?? 0) - p[1]] as const,
  }));
  return (p) => {
    if (!residuals.length) return p;
    const nearest = residuals
      .map((x) => ({ ...x, d: dist(x.at, p) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, o.k);
    let wx = 0;
    let wy = 0;
    let ws = 0;
    for (const n of nearest) {
      const w = 1 / (n.d * n.d + o.softM * o.softM);
      wx += w * n.r[0];
      wy += w * n.r[1];
      ws += w;
    }
    return [p[0] + wx / ws, p[1] + wy / ws];
  };
}
