import type { GeoResult } from '@bgq/geo';
import { type ControlPoint, type FitResult, fitPhoto, mapConfidence } from '@bgq/georef';
import type { MapResult, Mark, PhotoFitSummary, PhotoLabels } from './model.ts';

/** Опорными становятся только надёжные точки geo: дом найден по номеру. */
export const CONTROL_METHODS = new Set(['exact', 'range', 'house_base']);

export type MarkStatus = 'inlier' | 'outlier' | 'disabled' | 'arrow' | 'plain';

export interface PhotoFit {
  file: string;
  fit: FitResult;
  status: Map<string, MarkStatus>;
}

/** Отметки фото, у которых есть надёжные координаты geo, → опорные точки. */
export function controlPoints(labels: PhotoLabels, geo: Map<string, GeoResult>): ControlPoint[] {
  const disabled = new Set(labels.disabled);
  const out: ControlPoint[] = [];
  for (const m of labels.marks) {
    const g = geo.get(m.id);
    if (m.arrow || disabled.has(m.id)) continue;
    if (!g?.loc || !g.method || !CONTROL_METHODS.has(g.method)) continue;
    out.push({ id: m.id, px: [m.x, m.y], ll: [g.loc.lat, g.loc.lon] });
  }
  return out;
}

function statusOf(
  m: Mark,
  labels: PhotoLabels,
  fit: FitResult,
  geo: Map<string, GeoResult>,
): MarkStatus {
  if (m.arrow) return 'arrow';
  if (labels.disabled.includes(m.id)) return 'disabled';
  if (!fit.ok) return 'plain';
  if (fit.report.inliers.includes(m.id)) return 'inlier';
  if (fit.report.outliers.some((o) => o.id === m.id)) return 'outlier';
  const g = geo.get(m.id);
  return g?.method && CONTROL_METHODS.has(g.method) ? 'outlier' : 'plain';
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const p90 = (f: FitResult) =>
  f.ok ? (f.report.loo?.p90M ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;

/**
 * Привязка каждого фото и координаты всех отмеченных КП. Если КП отмечен на нескольких
 * фото, берём фото с лучшей точностью (p90 leave-one-out); кружок важнее стрелки.
 * Стрелка даёт только цвет — без координат. Детерминировано.
 */
export function computeMap(
  photos: PhotoLabels[],
  geoResults: GeoResult[],
): { fits: PhotoFit[]; summaries: PhotoFitSummary[]; results: MapResult[] } {
  const geo = new Map(geoResults.map((g) => [g.id, g]));
  const fits: PhotoFit[] = photos.map((labels) => {
    const fit = fitPhoto(controlPoints(labels, geo));
    const status = new Map(labels.marks.map((m) => [m.id, statusOf(m, labels, fit, geo)]));
    return { file: labels.file, fit, status };
  });

  // Ранг: [0 — кружок с координатами, 1 — стрелка], затем p90 привязки фото.
  const best = new Map<string, { result: MapResult; rank: number; p90: number }>();
  const offer = (result: MapResult, rank: number, score: number) => {
    const prev = best.get(result.id);
    if (prev && (prev.rank < rank || (prev.rank === rank && prev.p90 <= score))) return;
    best.set(result.id, { result, rank, p90: score });
  };
  photos.forEach((labels, i) => {
    const fit = fits[i]?.fit;
    for (const m of labels.marks) {
      if (m.arrow) {
        offer(
          { id: m.id, color: m.color, photo: labels.file, arrow: true },
          1,
          Number.POSITIVE_INFINITY,
        );
        continue;
      }
      if (!fit?.ok) continue;
      const ll = fit.predict([m.x, m.y]);
      if (!ll) continue;
      const loc = {
        lat: round6(ll[0]),
        lon: round6(ll[1]),
        source: 'map' as const,
        confidence: mapConfidence(fit.report),
      };
      offer({ id: m.id, loc, color: m.color, photo: labels.file }, 0, p90(fit));
    }
  });

  const summaries: PhotoFitSummary[] = fits.map((f) =>
    f.fit.ok
      ? { file: f.file, report: f.fit.report }
      : { file: f.file, report: null, reason: f.fit.reason },
  );
  const results = [...best.values()]
    .map((b) => b.result)
    .sort((a, b) => a.id.localeCompare(b.id, 'ru', { numeric: true }));
  return { fits, summaries, results };
}
