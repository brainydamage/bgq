import { centroid, type LatLon } from './distance.ts';
import { houseKey, streetKey } from './normalize.ts';

/** Справочник адресов города из OSM — компактный, кэшируется на диск. */
export interface Gazetteer {
  v: 1;
  /** Откуда данные: выгрузка Geofabrik; «overpass» — старые справочники (games/osm_overpass/). */
  source: 'geofabrik' | 'overpass';
  city: string;
  radiusM: number;
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
    osmBase: meta.osmBase,
    fetchedAt: meta.fetchedAt,
    copyright: '© OpenStreetMap contributors, ODbL 1.0',
    streets,
    addresses: [...addresses.values()].sort((a, b) => byName(a.join('|'), b.join('|'))),
  };
}

/** JSON справочника: шапка читаемо, улицы и адреса — по одному на строку (диффы в git). */
export function serializeGazetteer(g: Gazetteer): string {
  const { streets, addresses, ...head } = g;
  const lines = (rows: unknown[]) => rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n');
  const headJson = JSON.stringify(head, null, 2).slice(0, -2);
  return `${headJson},\n  "streets": [\n${lines(streets)}\n  ],\n  "addresses": [\n${lines(addresses)}\n  ]\n}\n`;
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
