import type { PointsFile } from '@bgq/core';

/** Сводка таблицы точек: цифры, затем все проблемы — их немного, и каждая важна. */
export function formatTableSummary(t: PointsFile): string {
  const s = t.stats;
  const critical = t.issues.filter((i) => i.severity === 'critical');
  const cosmetic = t.issues.filter((i) => i.severity === 'cosmetic');
  const out = [
    `${s.kps} КП · доступно ${s.eligible} · баллов ${s.points}`,
    `координаты: карта ${s.locFrom.map} · адрес ${s.locFrom.geocode} · вручную ${s.locFrom.manual} · доступных без координат ${s.eligibleWithoutLoc}`,
    `✗ критичных: ${critical.length}`,
    ...critical.map((i) => `  ✗ ${i.kpId ?? ''}: ${i.message}`),
    `△ косметика: ${cosmetic.length}`,
    ...cosmetic.map((i) => `  △ ${i.kpId ?? ''}: ${i.message}`),
  ];
  return out.join('\n');
}
