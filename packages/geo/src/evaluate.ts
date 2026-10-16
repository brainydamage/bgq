import { parse } from 'yaml';
import { haversineM } from './distance.ts';
import type { GeoMethod, GeoResult } from './geocode.ts';

export interface ReferencePoint {
  id: string;
  lat: number;
  lon: number;
}

/** fixtures/<дата>/reference.yaml → точки; пустые coords пропускаются, кривые — ошибка. */
export function parseReference(text: string): ReferencePoint[] {
  const items = parse(text) as { id: string | number; coords?: string | null }[] | null;
  const out: ReferencePoint[] = [];
  for (const it of items ?? []) {
    if (it.coords == null || it.coords === '') continue;
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(it.coords));
    if (!m) throw new Error(`reference: у КП ${it.id} coords не «lat, lon»: «${it.coords}»`);
    out.push({ id: String(it.id), lat: Number(m[1]), lon: Number(m[2]) });
  }
  return out;
}

export interface EvalRow {
  id: string;
  method?: GeoMethod;
  /** Ошибка в метрах; нет — geo не дал точку. */
  errorM?: number;
}

export interface EvalStats {
  rows: EvalRow[];
  total: number;
  located: number;
  medianM: number;
  p90M: number;
  within30: number;
  within50: number;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, i)] ?? Number.NaN;
}

/** Сравнение результата geo с эталоном. */
export function evaluate(results: GeoResult[], reference: ReferencePoint[]): EvalStats {
  const byId = new Map(results.map((r) => [r.id, r]));
  const rows: EvalRow[] = reference.map((ref) => {
    const r = byId.get(ref.id);
    if (!r?.loc) return { id: ref.id, ...(r?.method && { method: r.method }) };
    const errorM = Math.round(haversineM([r.loc.lat, r.loc.lon], [ref.lat, ref.lon]));
    return { id: ref.id, ...(r.method && { method: r.method }), errorM };
  });
  const errors = rows
    .map((r) => r.errorM)
    .filter((e): e is number => e !== undefined)
    .sort((a, b) => a - b);
  return {
    rows,
    total: rows.length,
    located: errors.length,
    medianM: quantile(errors, 0.5),
    p90M: quantile(errors, 0.9),
    within30: errors.filter((e) => e <= 30).length,
    within50: errors.filter((e) => e <= 50).length,
  };
}
