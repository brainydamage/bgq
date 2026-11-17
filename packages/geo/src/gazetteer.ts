import { centroid, haversineM, type LatLon } from './distance.ts';
import { houseKey, streetKey } from './normalize.ts';

/** Справочник адресов города из OSM — компактный, кэшируется на диск. */
export interface Gazetteer {
  v: 1;
  /** Откуда данные: выгрузка Geofabrik; «overpass» — старые справочники (games/osm_overpass/). */
  source: 'geofabrik' | 'overpass';
  city: string;
  radiusM: number;
  /** Центр выгрузки: `--center` (район игры) или точка города в OSM. В старых справочниках нет. */
  center?: [number, number];
  /**
   * Улицы-тёзки дальше от центра (Земун и центр Белграда): их адреса отброшены, остался
   * ближайший к центру кусок. Есть, только если справочник собран с центром.
   */
  twins?: GazetteerTwin[];
  /** На какой момент данные OSM. */
  osmBase: string;
  fetchedAt: string;
  copyright: string;
  streets: GazetteerStreet[];
  /** [улица (как addr:street), номер дома, lat, lon] */
  addresses: [street: string, house: string, lat: number, lon: number][];
}

export interface GazetteerStreet {
  name: string;
  /** name:sr-Latn, alt_name, old_name, … — для нечёткого поиска. */
  aliases: string[];
  center: [number, number] | null;
}

export interface GazetteerTwin {
  street: string;
  /** Сколько адресов отброшено. */
  addresses: number;
  /** Центр отброшенного куска и его расстояние от центра справочника. */
  at: [number, number];
  distanceM: number;
}

/**
 * Разрыв, после которого одноимённые куски улицы считаются разными улицами. Дома одной улицы
 * идут подряд; Његошева на Врачаре и в Земуне — в 5 км. Запас на парки и пустыри без адресов.
 */
export const TWIN_GAP_M = 1500;

/** Объект OSM: точка — lat/lon, линия или полигон — center (центр bbox). */
export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface GazetteerMeta {
  source: Gazetteer['source'];
  city: string;
  radiusM: number;
  /** С центром — одноимённые улицы дальше TWIN_GAP_M отбрасываются, кроме ближайшей. */
  center?: LatLon;
  osmBase: string;
  fetchedAt: string;
}

const ALIAS_KEYS = [
  'name:sr',
  'name:sr-Latn',
  'int_name',
  'alt_name',
  'alt_name:sr',
  'alt_name:sr-Latn',
  'old_name',
  'old_name:sr',
  'old_name:sr-Latn',
  'short_name',
  'short_name:sr',
  'short_name:sr-Latn',
  'official_name',
  'loc_name',
];

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function coordsOf(e: OsmElement): LatLon | null {
  if (e.lat !== undefined && e.lon !== undefined) return [e.lat, e.lon];
  if (e.center) return [e.center.lat, e.center.lon];
  return null;
}

/** Улицы с названием + объекты с адресом → справочник. Детерминирован. */
export function gazetteerFromOsm(elements: OsmElement[], meta: GazetteerMeta): Gazetteer {
  const streetAliases = new Map<string, Set<string>>();
  const streetCenters = new Map<string, LatLon[]>();
  const addresses = new Map<string, Gazetteer['addresses'][number]>();

  for (const e of elements) {
    const tags = e.tags ?? {};
    const at = coordsOf(e);
    if (tags.highway && tags.name) {
      const aliases = streetAliases.get(tags.name) ?? new Set<string>();
      for (const k of ALIAS_KEYS) {
        const v = tags[k];
        if (v && v !== tags.name) aliases.add(v);
      }
      streetAliases.set(tags.name, aliases);
      if (at) streetCenters.set(tags.name, [...(streetCenters.get(tags.name) ?? []), at]);
    }
    const street = tags['addr:street'];
    const houses = tags['addr:housenumber'];
    if (street && houses && at) {
      // "12;14" / "12, 14" — несколько номеров на одном объекте
      for (const house of houses
        .split(/[;,]/)
        .map((h) => h.trim())
        .filter(Boolean)) {
        const row: Gazetteer['addresses'][number] = [street, house, round6(at[0]), round6(at[1])];
        addresses.set(row.join('|'), row);
      }
    }
  }

  const twins = meta.center ? dropTwins(meta.center, streetCenters, addresses) : [];

  // Улицы, известные только по addr:street, — центр по их адресам.
  for (const [street, , lat, lon] of addresses.values()) {
    if (!streetAliases.has(street)) streetAliases.set(street, new Set());
    if (!streetCenters.has(street)) streetCenters.set(street, []);
    if (!streetCenters.get(street)?.length) streetCenters.set(street, [[lat, lon]]);
  }

  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const streets: GazetteerStreet[] = [...streetAliases.keys()].sort(byName).map((name) => {
    const c = centroid(streetCenters.get(name) ?? []);
    return {
      name,
      aliases: [...(streetAliases.get(name) ?? [])].sort(byName),
      center: c ? [round6(c[0]), round6(c[1])] : null,
    };
  });

  return {
    v: 1,
    source: meta.source,
    city: meta.city,
    radiusM: meta.radiusM,
    ...(meta.center && {
      center: [round6(meta.center[0]), round6(meta.center[1])] as [number, number],
      twins,
    }),
    osmBase: meta.osmBase,
    fetchedAt: meta.fetchedAt,
    copyright: '© OpenStreetMap contributors, ODbL 1.0',
    streets,
    addresses: [...addresses.values()].sort((a, b) => byName(a.join('|'), b.join('|'))),
  };
}

/**
 * Одноимённые улицы в разных районах (в Белграде — Земун и центр) склеились бы в одну:
 * у «Његошева 10а» два дома в 5 км, и геокодер взял бы середину. Делим точки улицы
 * (центры её линий и адреса) на куски с разрывом > TWIN_GAP_M и оставляем ближайший к центру.
 */
function dropTwins(
  center: LatLon,
  streetCenters: Map<string, LatLon[]>,
  addresses: Map<string, Gazetteer['addresses'][number]>,
): GazetteerTwin[] {
  const rowsByStreet = new Map<string, [string, Gazetteer['addresses'][number]][]>();
  for (const [key, row] of addresses) {
    rowsByStreet.set(row[0], [...(rowsByStreet.get(row[0]) ?? []), [key, row]]);
  }
  const twins: GazetteerTwin[] = [];
  for (const street of new Set([...streetCenters.keys(), ...rowsByStreet.keys()])) {
    const lines = streetCenters.get(street) ?? [];
    const rows = rowsByStreet.get(street) ?? [];
    const points: LatLon[] = [...lines, ...rows.map(([, r]) => [r[2], r[3]] as const)];
    const groups = clusters(points, TWIN_GAP_M);
    if (groups.length < 2) continue;
    const dist = (g: number[]) =>
      Math.min(...g.map((i) => haversineM(points[i] as LatLon, center)));
    const [keep, ...drop] = [...groups].sort((a, b) => dist(a) - dist(b));
    const kept = new Set(keep);
    streetCenters.set(
      street,
      lines.filter((_, i) => kept.has(i)),
    );
    for (const [j, [key]] of rows.entries()) {
      if (!kept.has(lines.length + j)) addresses.delete(key);
    }
    for (const g of drop) {
      const at = centroid(g.map((i) => points[i] as LatLon)) as LatLon;
      twins.push({
        street,
        addresses: g.filter((i) => i >= lines.length).length,
        at: [round6(at[0]), round6(at[1])],
        distanceM: Math.round(haversineM(at, center)),
      });
    }
  }
  const byName = (a: GazetteerTwin, b: GazetteerTwin) =>
    a.street < b.street ? -1 : a.street > b.street ? 1 : a.distanceM - b.distanceM;
  return twins.sort(byName);
}

/** Связные группы точек: соседи ближе gapM — в одной группе (одиночная связь). Индексы точек. */
export function clusters(points: readonly LatLon[], gapM: number): number[][] {
  const parent = points.map((_, i) => i);
  const root = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    while (parent[i] !== r) [parent[i], i] = [r, parent[i] as number];
    return r;
  };
  // Быстрый отсев по широте: точки отсортированы, дальше gapM по широте — не соседи.
  const order = points
    .map((_, i) => i)
    .sort((a, b) => (points[a]?.[0] ?? 0) - (points[b]?.[0] ?? 0));
  const dLat = gapM / 111_320;
  for (let x = 0; x < order.length; x++) {
    const i = order[x] as number;
    const pi = points[i] as LatLon;
    for (let y = x + 1; y < order.length; y++) {
      const j = order[y] as number;
      const pj = points[j] as LatLon;
      if (pj[0] - pi[0] > dLat) break;
      if (root(i) !== root(j) && haversineM(pi, pj) <= gapM) parent[root(i)] = root(j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < points.length; i++) {
    const r = root(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  return [...groups.values()];
}

/** JSON справочника: шапка читаемо, улицы и адреса — по одному на строку (диффы в git). */
export function serializeGazetteer(g: Gazetteer): string {
  const { streets, addresses, twins, ...head } = g;
  const lines = (rows: unknown[]) => rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n');
  const list = (name: string, rows: unknown[]) =>
    rows.length ? `  "${name}": [\n${lines(rows)}\n  ]` : `  "${name}": []`;
  const headJson = JSON.stringify(head, null, 2)
    .slice(0, -2)
    .replace(/("center": )\[\s+(\S+),\s+(\S+)\s+\]/, '$1[$2, $3]');
  const parts = [
    headJson,
    ...(twins ? [list('twins', twins)] : []),
    list('streets', streets),
    list('addresses', addresses),
  ];
  return `${parts.join(',\n')}\n}\n`;
}

/** Индекс для поиска: ключи названий улиц и номера домов по улицам. */
export interface GazetteerIndex {
  streets: { name: string; keys: string[]; center: LatLon | null }[];
  houses: Map<string, Map<string, LatLon[]>>;
}

export function buildIndex(g: Gazetteer): GazetteerIndex {
  const houses = new Map<string, Map<string, LatLon[]>>();
  for (const [street, house, lat, lon] of g.addresses) {
    const byHouse = houses.get(street) ?? new Map<string, LatLon[]>();
    const k = houseKey(house);
    byHouse.set(k, [...(byHouse.get(k) ?? []), [lat, lon]]);
    houses.set(street, byHouse);
  }
  const streets = g.streets.map((s) => ({
    name: s.name,
    keys: [...new Set([s.name, ...s.aliases].map(streetKey).filter(Boolean))],
    center: s.center,
  }));
  return { streets, houses };
}
