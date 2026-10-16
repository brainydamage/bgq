import { invert3, type Mat3, mul3, solveLinear, type XY } from './linalg.ts';

/** Применить гомографию; null — точка ушла в бесконечность (w≈0). */
export function applyH(h: Mat3, [u, v]: XY): XY | null {
  const w = h[6] * u + h[7] * v + h[8];
  if (Math.abs(w) < 1e-12) return null;
  return [(h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w];
}

/** Нормализация Хартли: центр в 0, среднее расстояние √2 — без неё система плохо обусловлена. */
function normalizer(points: readonly XY[]): { t: Mat3; inv: Mat3 } {
  const n = points.length;
  const cx = points.reduce((s, p) => s + p[0], 0) / n;
  const cy = points.reduce((s, p) => s + p[1], 0) / n;
  const mean = points.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / n || 1;
  const s = Math.SQRT2 / mean;
  return {
    t: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    inv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1],
  };
}

/**
 * Гомография src → dst по ≥4 парам точек (DLT, h33 = 1, наименьшие квадраты).
 * null — точек мало или они вырождены (три на одной прямой и т.п.).
 */
export function fitHomography(src: readonly XY[], dst: readonly XY[]): Mat3 | null {
  if (src.length < 4 || src.length !== dst.length) return null;
  const ns = normalizer(src);
  const nd = normalizer(dst);
  const s = src.map((p) => applyH(ns.t, p) as XY);
  const d = dst.map((p) => applyH(nd.t, p) as XY);

  // Нормальные уравнения AᵀA·h = Aᵀb для 8 неизвестных.
  const ata = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const atb = new Array<number>(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      atb[i] = (atb[i] ?? 0) + (row[i] ?? 0) * rhs;
      const ai = ata[i];
      if (!ai) continue;
      for (let j = 0; j < 8; j++) ai[j] = (ai[j] ?? 0) + (row[i] ?? 0) * (row[j] ?? 0);
    }
  };
  for (let k = 0; k < s.length; k++) {
    const [u, v] = s[k] as XY;
    const [x, y] = d[k] as XY;
    add([u, v, 1, 0, 0, 0, -u * x, -v * x], x);
    add([0, 0, 0, u, v, 1, -u * y, -v * y], y);
  }
  const h = solveLinear(ata, atb);
  if (!h || h.some((x) => !Number.isFinite(x))) return null;
  const hn = [...h, 1] as unknown as Mat3;
  return mul3(mul3(nd.inv, hn), ns.t);
}

export function inverseH(h: Mat3): Mat3 | null {
  return invert3(h);
}
