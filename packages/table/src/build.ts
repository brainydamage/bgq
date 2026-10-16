import {
  type Game,
  isEligible,
  type Kp,
  type Loc,
  type MapFileResults,
  type PointsFile,
  type TableIssue,
} from '@bgq/core';
import { type GeoResult, haversineM } from '@bgq/geo';

/** Карта и адрес расходятся больше — показываем оба места (71Б на 10.10: 223 м). */
export const MISMATCH_M = 60;
/** Ниже — адрес неточный сам по себе (соседний дом 0,5, только улица 0,2): не сравниваем. */
export const MISMATCH_MIN_CONFIDENCE = 0.6;

export interface TableInput {
  game: Game;
  /** kps.json (после overrides): ручные правки координат — loc с source: manual. */
  kps: Kp[];
  /** Когда собран kps.json. */
  kpsAt: string;
  geo?: { osmBase: string; results: GeoResult[] };
  map?: MapFileResults;
  now?: Date;
}

const byId = (a: string, b: string) => a.localeCompare(b, 'ru', { numeric: true });
const iso = (d: Date) => d.toISOString();

/**
 * Таблица точек. Координаты: ручная правка → кружок на карте → адрес (geo) → нет.
 * Остальные найденные места — в altLocs. Доступность — по пометке в Notion и цвету кружка
 * (override цвета в overrides.yaml важнее карты). Чистая функция.
 */
export function buildTable(input: TableInput): PointsFile {
  const geo = new Map((input.geo?.results ?? []).filter((g) => g.loc).map((g) => [g.id, g]));
  const map = new Map((input.map?.results ?? []).map((r) => [r.id, r]));
  const known = new Set(input.kps.map((k) => k.id));
  const issues: TableIssue[] = [];

  for (const id of [...map.keys()].filter((id) => !known.has(id)).sort(byId)) {
    issues.push({
      severity: 'critical',
      code: 'unknown_map_id',
      kpId: id,
      message: `на карте отмечен КП ${id}, которого нет в Notion — опечатка в номере?`,
    });
  }

  const kps = input.kps.map((kp): Kp => {
    const { loc: own, altLocs: _altLocs, mapColor: overrideColor, ...base } = kp;
    const m = map.get(kp.id);
    const g = geo.get(kp.id);
    const manual = own?.source === 'manual' ? own : undefined;
    const candidates = [manual, m?.loc, g?.loc, manual ? undefined : own].filter(
      (l): l is Loc => !!l,
    );
    const seen = new Set<string>();
    const unique = candidates.filter((l) => !seen.has(l.source) && seen.add(l.source));
    const [loc, ...altLocs] = unique;

    const mapColor = overrideColor ?? m?.color ?? undefined;
    const eligible = isEligible(
      { ...(kp.note && { note: kp.note }), ...(mapColor && { mapColor }) },
      input.game,
    );

    // Расхождение интересно только у доступных КП с точным адресом: у «только улица»
    // (61 «Батутова улица» — центр улицы) сотни метров — норма, а недоступные не важны.
    if (eligible && m?.loc && g?.loc && g.loc.confidence >= MISMATCH_MIN_CONFIDENCE) {
      const d = Math.round(haversineM([m.loc.lat, m.loc.lon], [g.loc.lat, g.loc.lon]));
      if (d > MISMATCH_M) {
        issues.push({
          severity: 'cosmetic',
          code: 'map_geo_mismatch',
          kpId: kp.id,
          message: `кружок в ${d} м от адреса — берём карту`,
        });
      }
    }
    if (eligible && !loc) {
      issues.push({
        severity: 'critical',
        code: 'no_location',
        kpId: kp.id,
        message: 'нет координат: не отмечен на карте и адрес не найден',
      });
    } else if (eligible && loc?.source === 'geocode') {
      const how = g?.method ? ` (${g.method}, уверенность ${loc.confidence})` : '';
      issues.push({
        severity: 'cosmetic',
        code: 'not_on_map',
        kpId: kp.id,
        message: `${m?.arrow ? 'стрелка за краем карты' : 'нет на карте'} — координаты по адресу${how}`,
      });
    }

    return {
      ...base,
      ...(mapColor && { mapColor }),
      eligible,
      ...(loc && { loc }),
      ...(altLocs.length ? { altLocs } : {}),
    };
  });

  const eligibleKps = kps.filter((k) => k.eligible);
  const locFrom = { manual: 0, map: 0, geocode: 0, gmaps_link: 0 };
  for (const k of kps) if (k.loc) locFrom[k.loc.source]++;

  return {
    v: 1,
    gameId: input.game.id,
    createdAt: iso(input.now ?? new Date()),
    sources: {
      kps: input.kpsAt,
      ...(input.geo && { geo: { osmBase: input.geo.osmBase } }),
      ...(input.map && { map: { updatedAt: input.map.updatedAt } }),
    },
    kps,
    stats: {
      kps: kps.length,
      eligible: eligibleKps.length,
      points: eligibleKps.reduce((s, k) => s + k.points, 0),
      locFrom,
      eligibleWithoutLoc: eligibleKps.filter((k) => !k.loc).length,
    },
    issues: issues.sort(
      (a, b) =>
        (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1) ||
        byId(a.kpId ?? '', b.kpId ?? ''),
    ),
  };
}
