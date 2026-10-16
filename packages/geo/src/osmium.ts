import { execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { haversineM, type LatLon } from './distance.ts';
import { type Gazetteer, gazetteerFromOsm, type OsmElement } from './gazetteer.ts';

/** Выгрузка Сербии: обновляется ежедневно, тот же файл понадобится OSRM. */
export const GEOFABRIK_SERBIA_URL = 'https://download.geofabrik.de/europe/serbia-latest.osm.pbf';

const USER_AGENT = 'bgq-route-tool/0.1 (BeoGeoQuest route planner)';

export class OsmiumError extends Error {}

type Geometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString' | 'MultiPoint'; coordinates: number[][] }
  | { type: 'Polygon' | 'MultiLineString'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

interface Feature {
  geometry: Geometry;
  properties: Record<string, string | number>;
}

/** Все вершины геометрии как [lat, lon]. */
function vertices(g: Geometry): LatLon[] {
  const flat = (g.coordinates as unknown[]).flat(3) as number[];
  const out: LatLon[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i + 1] ?? 0, flat[i] ?? 0]);
  return out;
}

/** Центр bbox — как `out center` в Overpass. */
function bboxCenter(points: LatLon[]): LatLon {
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  return [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2];
}

/** Разделитель записей GeoJSON Text Sequences (RFC 8142) — RS в начале каждой строки. */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);

function* features(text: string): Generator<Feature> {
  for (const line of text.split('\n')) {
    const json = (line.startsWith(RECORD_SEPARATOR) ? line.slice(1) : line).trim();
    if (json) yield JSON.parse(json) as Feature;
  }
}

/**
 * Вывод `osmium export -f geojsonseq -a type,id` → элементы справочника.
 * Оставляем только улицы с названием и объекты с номером дома, у которых хоть одна
 * вершина в радиусе от центра (как `around` в Overpass).
 */
export function elementsFromGeojsonSeq(
  text: string,
  center: LatLon,
  radiusM: number,
): OsmElement[] {
  const out: OsmElement[] = [];
  for (const f of features(text)) {
    const { '@type': type, '@id': id, ...rest } = f.properties;
    const tags = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]));
    const isStreet = tags.highway && tags.name;
    const isAddress = tags['addr:housenumber'] && tags['addr:street'];
    if (!isStreet && !isAddress) continue;

    const points = vertices(f.geometry);
    if (!points.some((p) => haversineM(p, center) <= radiusM)) continue;
    const base = { type: type as OsmElement['type'], id: Number(id), tags };
    const [first] = points;
    if (f.geometry.type === 'Point' && first) {
      out.push({ ...base, lat: first[0], lon: first[1] });
    } else {
      const [lat, lon] = bboxCenter(points);
      out.push({ ...base, center: { lat, lon } });
    }
  }
  return out;
}

/** Населённые пункты из `osmium export` → узлы place с названием. */
export function placesFromGeojsonSeq(text: string): OsmElement[] {
  const out: OsmElement[] = [];
  for (const f of features(text)) {
    if (f.geometry.type !== 'Point') continue;
    const { '@type': type, '@id': id, ...rest } = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    if (type !== 'node' || lat === undefined || lon === undefined) continue;
    const tags = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]));
    out.push({ type: 'node', id: Number(id), lat, lon, tags });
  }
  return out;
}

const PLACE_RANK: Record<string, number> = { city: 0, town: 1, village: 2 };

/** Город важнее посёлка; два одинаково крупных тёзки — ошибка, а не случайный выбор. */
export function pickPlace(places: OsmElement[], city: string): { lat: number; lon: number } {
  const named = places.filter(
    (p) => p.lat !== undefined && p.lon !== undefined && p.tags?.name === city,
  );
  if (!named.length) {
    throw new OsmiumError(`«${city}» не найден в OSM (place=city|town|village с таким name)`);
  }
  const rank = (p: OsmElement) => PLACE_RANK[p.tags?.place ?? ''] ?? 9;
  const best = Math.min(...named.map(rank));
  const top = named.filter((p) => rank(p) === best);
  const [only] = top;
  if (!only || top.length > 1 || only.lat === undefined || only.lon === undefined) {
    const list = top.map((p) => `${p.tags?.place} ${p.lat},${p.lon}`).join('; ');
    throw new OsmiumError(`«${city}»: несколько одинаковых мест в OSM (${list})`);
  }
  return { lat: only.lat, lon: only.lon };
}

/** bbox «minlon,minlat,maxlon,maxlat» вокруг центра с запасом на радиус. */
export function bboxAround(lat: number, lon: number, radiusM: number): string {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((x) => x.toFixed(6)).join(',');
}

function osmium(args: string[]): void {
  try {
    execFileSync('osmium', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer };
    if (err.code === 'ENOENT') {
      throw new OsmiumError('Не найден osmium — установите: brew install osmium-tool');
    }
    throw new OsmiumError(`osmium ${args[0]}: ${err.stderr?.toString().trim() || err.message}`);
  }
}

/** Дата данных выгрузки (osmosis_replication_timestamp из заголовка PBF). */
export function pbfTimestamp(pbfPath: string): string {
  try {
    const out = execFileSync('osmium', ['fileinfo', '-g', 'header.option.timestamp', pbfPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.toString().trim();
  } catch {
    return '';
  }
}

/** Центр города (узел place=city|town|village с таким name) по выгрузке .osm.pbf. */
export function cityCenter(pbfPath: string, city: string): { lat: number; lon: number } {
  const dir = mkdtempSync(join(tmpdir(), 'bgq-osmium-'));
  try {
    const places = join(dir, 'places.osm.pbf');
    const geojson = join(dir, 'places.geojsonseq');
    osmium(['tags-filter', pbfPath, 'n/place=city,town,village', '-o', places, '-O']);
    osmium(['export', places, '-f', 'geojsonseq', '-a', 'type,id', '-o', geojson, '-O']);
    return pickPlace(placesFromGeojsonSeq(readFileSync(geojson, 'utf8')), city);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Справочник города из выгрузки .osm.pbf через osmium (экспорт → фильтр → GeoJSON). */
export function gazetteerFromPbf(
  pbfPath: string,
  city: string,
  radiusM: number,
  now: Date = new Date(),
): Gazetteer {
  const dir = mkdtempSync(join(tmpdir(), 'bgq-osmium-'));
  try {
    const center = cityCenter(pbfPath, city);

    const area = join(dir, 'area.osm.pbf');
    const filtered = join(dir, 'filtered.osm.pbf');
    const geojson = join(dir, 'filtered.geojsonseq');
    osmium([
      'extract',
      '-b',
      bboxAround(center.lat, center.lon, radiusM),
      pbfPath,
      '-o',
      area,
      '-O',
    ]);
    osmium(['tags-filter', area, 'w/highway', 'nwr/addr:housenumber', '-o', filtered, '-O']);
    osmium(['export', filtered, '-f', 'geojsonseq', '-a', 'type,id', '-o', geojson, '-O']);

    const elements = elementsFromGeojsonSeq(
      readFileSync(geojson, 'utf8'),
      [center.lat, center.lon],
      radiusM,
    );
    return gazetteerFromOsm(elements, {
      source: 'geofabrik',
      city,
      radiusM,
      osmBase: pbfTimestamp(pbfPath),
      fetchedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Скачивает выгрузку целиком во временный файл и только потом подменяет старую. */
export async function downloadPbf(path: string, url = GEOFABRIK_SERBIA_URL): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new OsmiumError(`Geofabrik: HTTP ${res.status} для ${url}`);
  const partial = `${path}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(partial));
  renameSync(partial, path);
}

export function pbfExists(path: string): boolean {
  return existsSync(path);
}
