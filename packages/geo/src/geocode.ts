import type { Kp, Loc } from '@bgq/core';
import { parseAddress } from '@bgq/ingest';
import { centroid, type LatLon } from './distance.ts';
import type { GazetteerIndex } from './gazetteer.ts';
import { houseKey, streetKey } from './normalize.ts';
import { similarity } from './similarity.ts';

export type GeoMethod = 'exact' | 'range' | 'house_base' | 'interpolated' | 'street';

/** Базовая уверенность метода; умножается на похожесть названия улицы. */
export const METHOD_CONFIDENCE: Record<GeoMethod, number> = {
  exact: 0.95,
  range: 0.85,
  house_base: 0.75,
  interpolated: 0.5,
  street: 0.2,
};

/** Ниже этой похожести улица считается не найденной. */
export const MIN_STREET_SCORE = 0.75;

/**
 * Дом ищем только на улицах, почти так же похожих, как лучшая. Иначе «Ратарска 1»
 * (дома 1 нет в OSM) уходит на «Вашарска 1» за 4 км вместо соседнего дома на Ратарской.
 */
export const STREET_TIE = 0.05;

export interface GeoResult {
  id: string;
  /** Что искали: улица и дом из Notion (или из адреса в скобках). */
  query?: { street: string; house: string | null };
  loc?: Loc;
  method?: GeoMethod;
  /** Что нашлось в OSM. */
  matched?: { street: string; score: number; house?: string };
  /** Почему не нашлось. */
  reason?: 'no_address' | 'street_not_found';
}

interface StreetMatch {
  name: string;
  score: number;
  center: LatLon | null;
}

/** Улицы-кандидаты, лучшие первыми. */
export function matchStreet(index: GazetteerIndex, street: string): StreetMatch[] {
  const key = streetKey(street);
  if (!key) return [];
  return index.streets
    .map((s) => ({
      name: s.name,
      score: Math.max(...s.keys.map((k) => similarity(key, k))),
      center: s.center,
    }))
    .filter((m) => m.score >= MIN_STREET_SCORE)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
}

interface HouseHit {
  at: LatLon;
  method: GeoMethod;
  house: string;
}

/** Точный номер → диапазон → номер без буквы. */
function findHouse(byHouse: Map<string, LatLon[]> | undefined, house: string): HouseHit | null {
  if (!byHouse) return null;
  const hk = houseKey(house);
  const exact = centroid(byHouse.get(hk) ?? []);
  if (exact) return { at: exact, method: 'exact', house };

  // «16-20» — дома 16, 18, 20: та же сторона улицы (нечётные бывают в сотнях метров напротив).
  const range = /^(\d+)-(\d+)$/.exec(hk);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    const pts: LatLon[] = [];
    for (const [k, at] of byHouse) {
      const n = Number(/^\d+/.exec(k)?.[0]);
      if (n >= lo && n <= hi && n % 2 === lo % 2) pts.push(...at);
    }
    const c = centroid(pts);
    if (c) return { at: c, method: 'range', house };
  }

  const base = /^\d+/.exec(hk)?.[0];
  if (base && base !== hk) {
    const c = centroid(byHouse.get(base) ?? []);
    if (c) return { at: c, method: 'house_base', house: base };
  }
  return null;
}

/** Между ближайшими номерами той же чётности (та же сторона улицы). */
function interpolateHouse(
  byHouse: Map<string, LatLon[]> | undefined,
  house: string,
): HouseHit | null {
  const n = Number(/^\d+/.exec(houseKey(house))?.[0]);
  if (!byHouse || !Number.isFinite(n)) return null;
  const sameSide = [...byHouse.entries()]
    .map(([k, at]) => ({ n: Number(/^\d+/.exec(k)?.[0]), at: centroid(at) }))
    .filter(
      (h): h is { n: number; at: LatLon } => Number.isFinite(h.n) && h.n % 2 === n % 2 && !!h.at,
    );
  const lower = sameSide.filter((h) => h.n < n).sort((a, b) => b.n - a.n)[0];
  const upper = sameSide.filter((h) => h.n > n).sort((a, b) => a.n - b.n)[0];
  if (lower && upper) {
    const t = (n - lower.n) / (upper.n - lower.n);
    const at: LatLon = [
      lower.at[0] + t * (upper.at[0] - lower.at[0]),
      lower.at[1] + t * (upper.at[1] - lower.at[1]),
    ];
    return { at, method: 'interpolated', house: `${lower.n}…${upper.n}` };
  }
  const near = lower ?? upper;
  if (near && Math.abs(near.n - n) <= 4) {
    return { at: near.at, method: 'interpolated', house: String(near.n) };
  }
  return null;
}

function toLoc(at: LatLon, method: GeoMethod, score: number): Loc {
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    lat: round(at[0]),
    lon: round(at[1]),
    source: 'geocode',
    confidence: Math.round(METHOD_CONFIDENCE[method] * score * 100) / 100,
  };
}

/** Адрес КП → координаты по справочнику. Без адреса — reason: no_address (это работа digitizer). */
export function geocodeKp(kp: Kp, index: GazetteerIndex): GeoResult {
  const a = kp.address;
  if (!a) return { id: kp.id, reason: 'no_address' };

  // Сначала адрес с номером дома, потом адрес в скобках ("Деканске Баште (Водна 16А)").
  const queries: { street: string; house: string | null }[] = [];
  if (a.house) queries.push({ street: a.street, house: a.house });
  const alt = a.alt ? parseAddress(a.alt) : null;
  if (alt?.house) queries.push({ street: alt.street, house: alt.house });
  if (!queries.length) queries.push({ street: a.street, house: null });

  for (const q of queries) {
    if (!q.house) continue;
    const candidates = matchStreet(index, q.street);
    const top = candidates[0]?.score ?? 0;
    for (const m of candidates.filter((c) => c.score >= top - STREET_TIE)) {
      const hit = findHouse(index.houses.get(m.name), q.house);
      if (hit) return result(kp.id, q, m, hit);
    }
  }

  const first = queries[0];
  const best = first ? matchStreet(index, first.street)[0] : undefined;
  if (!first || !best) {
    return { id: kp.id, ...(first && { query: first }), reason: 'street_not_found' };
  }
  const near = first.house ? interpolateHouse(index.houses.get(best.name), first.house) : null;
  if (near) return result(kp.id, first, best, near);
  const center = best.center ?? centroid([...(index.houses.get(best.name)?.values() ?? [])].flat());
  if (!center) return { id: kp.id, query: first, reason: 'street_not_found' };
  return {
    id: kp.id,
    query: first,
    loc: toLoc(center, 'street', best.score),
    method: 'street',
    matched: { street: best.name, score: round2(best.score) },
  };
}

function result(
  id: string,
  query: { street: string; house: string | null },
  m: StreetMatch,
  hit: HouseHit,
): GeoResult {
  return {
    id,
    query,
    loc: toLoc(hit.at, hit.method, m.score),
    method: hit.method,
    matched: { street: m.name, score: round2(m.score), house: hit.house },
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function geocodeAll(kps: Kp[], index: GazetteerIndex): GeoResult[] {
  return kps.map((kp) => geocodeKp(kp, index));
}
