import type { EvalStats } from './evaluate.ts';
import type { GeoMethod, GeoResult } from './geocode.ts';

const METHOD_LABEL: Record<GeoMethod, string> = {
  exact: 'точно',
  range: 'диапазон',
  house_base: 'дом без буквы',
  interpolated: 'соседний дом',
  street: 'только улица',
};

/** Сводка geo: сколько найдено каким способом; сомнительные — построчно. */
export function formatGeoSummary(results: GeoResult[]): string {
  const withAddress = results.filter((r) => r.reason !== 'no_address');
  const noAddress = results.length - withAddress.length;
  const counts = (Object.keys(METHOD_LABEL) as GeoMethod[])
    .map((m) => [m, withAddress.filter((r) => r.method === m).length] as const)
    .filter(([, n]) => n > 0)
    .map(([m, n]) => `${METHOD_LABEL[m]} ${n}`);
  const notFound = withAddress.filter((r) => !r.loc);
  counts.push(`не найдено ${notFound.length}`);

  const out = [
    `${withAddress.length} КП с адресом: ${counts.join(' · ')}`,
    `${noAddress} КП без адреса — их разметит digitizer`,
  ];
  const doubtful = withAddress.filter(
    (r) =>
      !r.loc ||
      r.method === 'street' ||
      r.method === 'interpolated' ||
      (r.matched?.score ?? 1) < 0.85,
  );
  for (const r of doubtful) {
    const q = r.query ? `«${r.query.street}${r.query.house ? ` ${r.query.house}` : ''}»` : '';
    const found = r.matched
      ? `→ ${r.matched.street}${r.matched.house ? ` ${r.matched.house}` : ''} (${r.method ? METHOD_LABEL[r.method] : ''}, похожесть ${r.matched.score}, уверенность ${r.loc?.confidence})`
      : '→ улица не найдена';
    out.push(`  △ ${r.id} ${q} ${found}`);
  }
  return out.join('\n');
}

export function formatEval(stats: EvalStats): string {
  const out = [
    `Эталон: точек ${stats.total}, найдено ${stats.located} · медиана ${stats.medianM} м · 90% ≤ ${stats.p90M} м · ≤30 м: ${stats.within30} · ≤50 м: ${stats.within50}`,
  ];
  for (const r of stats.rows.filter((r) => r.errorM === undefined || r.errorM > 50)) {
    out.push(`  ✗ ${r.id}: ${r.errorM === undefined ? 'нет точки' : `${r.errorM} м`}`);
  }
  return out.join('\n');
}
