import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { bboxAround, pbfTimestamp } from '@bgq/geo';

/** Официальный образ OSRM; версия не моложе пары недель (v26.9.0 собран 2026-09-01). */
export const OSRM_IMAGE = 'ghcr.io/project-osrm/osrm-backend:v26.9.0-debian';
/** Граф с запасом вокруг центра: КП бывают и за 5 км справочника адресов. */
export const GRAPH_RADIUS_M = 8000;

export class RoutingError extends Error {}

export interface GraphMeta {
  image: string;
  center: { lat: number; lon: number };
  radiusM: number;
  osmBase: string;
  builtAt: string;
}

function docker(args: string[], what: string): string {
  try {
    return execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer };
    const stderr = err.stderr?.toString() ?? '';
    if (err.code === 'ENOENT')
      throw new RoutingError('Не найден docker — установите Docker Desktop');
    if (/Cannot connect to the Docker daemon|docker daemon/i.test(stderr)) {
      throw new RoutingError('Docker не запущен — откройте Docker Desktop и повторите');
    }
    throw new RoutingError(`${what}: ${stderr.trim().split('\n').at(-1) ?? err.message}`);
  }
}

export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export function graphReady(dir: string): boolean {
  return existsSync(join(dir, 'city.osrm.mldgr')) && existsSync(join(dir, 'meta.json'));
}

export function readGraphMeta(dir: string): GraphMeta {
  return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as GraphMeta;
}

/**
 * Пешеходный граф OSRM для города: osmium вырезает квадрат из выгрузки, OSRM в Docker
 * готовит граф (extract → partition → customize, профиль foot). Секунды на город.
 * Каталог должен быть внутри /Users — иначе Docker Desktop его не видит.
 */
export function buildGraph(o: {
  pbf: string;
  center: { lat: number; lon: number };
  dir: string;
  radiusM?: number;
  now?: Date;
}): GraphMeta {
  const dir = resolve(o.dir);
  const radiusM = o.radiusM ?? GRAPH_RADIUS_M;
  mkdirSync(dir, { recursive: true });
  const cityPbf = join(dir, 'city.osm.pbf');
  try {
    execFileSync(
      'osmium',
      [
        'extract',
        '-b',
        bboxAround(o.center.lat, o.center.lon, radiusM),
        o.pbf,
        '-o',
        cityPbf,
        '-O',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT')
      throw new RoutingError('Не найден osmium — brew install osmium-tool');
    throw new RoutingError(`osmium extract: ${err.message}`);
  }
  const mount = ['run', '--rm', '-v', `${dir}:/data`, OSRM_IMAGE];
  docker([...mount, 'osrm-extract', '-p', '/opt/foot.lua', '/data/city.osm.pbf'], 'osrm-extract');
  docker([...mount, 'osrm-partition', '/data/city.osrm'], 'osrm-partition');
  docker([...mount, 'osrm-customize', '/data/city.osrm'], 'osrm-customize');
  if (!existsSync(join(dir, 'city.osrm.mldgr'))) {
    throw new RoutingError(`OSRM не создал граф в ${dir} — Docker видит этот каталог?`);
  }
  const meta: GraphMeta = {
    image: OSRM_IMAGE,
    center: o.center,
    radiusM,
    osmBase: pbfTimestamp(o.pbf),
    builtAt: (o.now ?? new Date()).toISOString(),
  };
  writeFileSync(join(dir, 'meta.json.tmp'), `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(join(dir, 'meta.json.tmp'), join(dir, 'meta.json'));
  return meta;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

/** Поднимает osrm-routed на время fn и гарантированно гасит контейнер. */
export async function withOsrm<T>(dir: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const port = await freePort();
  const name = `bgq-osrm-${process.pid}-${port}`;
  docker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-p',
      `127.0.0.1:${port}:5000`,
      '-v',
      `${resolve(dir)}:/data`,
      OSRM_IMAGE,
      'osrm-routed',
      '--algorithm',
      'mld',
      '/data/city.osrm',
    ],
    'osrm-routed',
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const r = await fetch(`${baseUrl}/nearest/v1/foot/0,0`);
        if (r.status < 500) break;
      } catch {}
      if (Date.now() > deadline) throw new RoutingError('OSRM не поднялся за 30 с');
      await new Promise((r) => setTimeout(r, 250));
    }
    return await fn(baseUrl);
  } finally {
    try {
      execFileSync('docker', ['stop', name], { stdio: 'ignore' });
    } catch {}
  }
}

export interface TableResult {
  /** Метры по дорожкам, distanceM[i][j]. */
  distanceM: number[][];
  /** Насколько точку пришлось сдвинуть до ближайшей дорожки, м. */
  snapM: number[];
}

/** Одна матрица расстояний для всех точек (OSRM /table, профиль foot). */
export async function osrmTable(
  baseUrl: string,
  points: readonly { lat: number; lon: number }[],
  fetchFn: typeof fetch = fetch,
): Promise<TableResult> {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const res = await fetchFn(`${baseUrl}/table/v1/foot/${coords}?annotations=distance`);
  const json = (await res.json()) as {
    code: string;
    message?: string;
    distances?: (number | null)[][];
    sources?: { distance: number }[];
  };
  if (json.code !== 'Ok' || !json.distances || !json.sources) {
    throw new RoutingError(`OSRM /table: ${json.code} ${json.message ?? ''}`.trim());
  }
  const unreachable: string[] = [];
  const distanceM = json.distances.map((row, i) =>
    row.map((d, j) => {
      if (d === null) {
        unreachable.push(`${i}→${j}`);
        return 0;
      }
      return Math.round(d);
    }),
  );
  if (unreachable.length) {
    throw new RoutingError(`OSRM: нет пешего пути для пар ${unreachable.slice(0, 5).join(', ')}…`);
  }
  return { distanceM, snapM: json.sources.map((s) => Math.round(s.distance)) };
}
