import { applyH, fitHomography } from './homography.ts';
import { dist, type Mat3, type XY } from './linalg.ts';

export interface RansacOptions {
  /** Точка — «своя», если после преобразования она ближе к эталону, чем порог (м). */
  thresholdM: number;
  maxIterations: number;
  seed: number;
}

export interface RansacResult {
  h: Mat3;
  inliers: number[];
}

/** Детерминированный ГПСЧ — одни и те же данные всегда дают один и тот же результат. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function choose4(n: number): number {
  return n < 4 ? 0 : (n * (n - 1) * (n - 2) * (n - 3)) / 24;
}

/** Четвёрки индексов: все, если их немного, иначе случайные. */
function* samples(n: number, o: RansacOptions): Generator<number[]> {
  if (choose4(n) <= o.maxIterations) {
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) yield [a, b, c, d];
    return;
  }
  const rnd = mulberry32(o.seed);
  for (let it = 0; it < o.maxIterations; it++) {
    const set = new Set<number>();
    while (set.size < 4) set.add(Math.floor(rnd() * n));
    yield [...set];
  }
}

function inliersOf(h: Mat3, src: readonly XY[], dst: readonly XY[], thr: number) {
  const idx: number[] = [];
  let err = 0;
  for (let i = 0; i < src.length; i++) {
    const p = applyH(h, src[i] as XY);
    const e = p ? dist(p, dst[i] as XY) : Number.POSITIVE_INFINITY;
    if (e <= thr) {
      idx.push(i);
      err += e;
    }
  }
  return { idx, err };
}

/** Гомография, устойчивая к выбросам: лучшая четвёрка → уточнение по всем «своим» (2 раунда). */
export function ransacHomography(
  src: readonly XY[],
  dst: readonly XY[],
  o: RansacOptions,
): RansacResult | null {
  let best: { idx: number[]; err: number } | null = null;
  for (const sample of samples(src.length, o)) {
    const h = fitHomography(
      sample.map((i) => src[i] as XY),
      sample.map((i) => dst[i] as XY),
    );
    if (!h) continue;
    const cand = inliersOf(h, src, dst, o.thresholdM);
    if (
      !best ||
      cand.idx.length > best.idx.length ||
      (cand.idx.length === best.idx.length && cand.err < best.err)
    ) {
      best = cand;
    }
  }
  if (!best || best.idx.length < 4) return null;

  let inliers = best.idx;
  let h: Mat3 | null = null;
  for (let round = 0; round < 2; round++) {
    h = fitHomography(
      inliers.map((i) => src[i] as XY),
      inliers.map((i) => dst[i] as XY),
    );
    if (!h) return null;
    const next = inliersOf(h, src, dst, o.thresholdM).idx;
    if (next.length < 4) break;
    inliers = next;
  }
  h = fitHomography(
    inliers.map((i) => src[i] as XY),
    inliers.map((i) => dst[i] as XY),
  );
  return h ? { h, inliers } : null;
}
