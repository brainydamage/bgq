export type XY = readonly [x: number, y: number];

/** Матрица 3×3 построчно: [a b c; d e f; g h i]. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** A·x = b методом Гаусса с выбором главного элемента; null — система вырождена. */
export function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = r;
    }
    const pivotRow = m[pivot];
    const pivotValue = pivotRow?.[col] ?? 0;
    if (!pivotRow || Math.abs(pivotValue) < 1e-12) return null;
    [m[col], m[pivot]] = [pivotRow, m[col] ?? pivotRow];
    for (let r = 0; r < n; r++) {
      const row = m[r];
      if (r === col || !row) continue;
      const f = (row[col] ?? 0) / pivotValue;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c] = (row[c] ?? 0) - f * (pivotRow[c] ?? 0);
    }
  }
  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const at = (m: Mat3, k: number) => m[k] ?? 0;
  const r: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r.push(
        at(a, i * 3) * at(b, j) + at(a, i * 3 + 1) * at(b, 3 + j) + at(a, i * 3 + 2) * at(b, 6 + j),
      );
    }
  }
  return r as unknown as Mat3;
}

/** Обратная 3×3; null — вырождена. */
export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  const k = 1 / det;
  return [
    A * k,
    -(b * i - c * h) * k,
    (b * f - c * e) * k,
    B * k,
    (a * i - c * g) * k,
    -(a * f - c * d) * k,
    C * k,
    -(a * h - b * g) * k,
    (a * e - b * d) * k,
  ];
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
