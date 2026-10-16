import type { IngestResult } from './types.ts';

/** Короткая сводка для терминала: статистика, критичные — подробно, косметика — числом. */
export function formatSummary(result: IngestResult, mdPath: string): string {
  const s = result.stats;
  const critical = result.issues.filter((i) => i.severity === 'critical');
  const cosmetic = result.issues.filter((i) => i.severity === 'cosmetic');

  const out = [
    `${s.kps} КП · доступно ${s.eligible} · баллов ${s.points} · с номером дома ${s.withHouseNumber} · со ссылкой на карту ${s.withMapsLink}`,
    `✗ критичных: ${critical.length}`,
  ];
  for (const i of critical) {
    const kp = i.kpId ? ` [${i.kpId}]` : '';
    const where = i.line ? ` — ${mdPath}:${i.line}` : '';
    out.push(`  ✗ ${i.code}${kp} ${i.message}${where}`);
  }
  out.push(
    `△ косметика: ${cosmetic.length}${cosmetic.length ? ' — подробности в report.json' : ''}`,
  );
  return out.join('\n');
}
