import type { PointsFile, TableIssue } from '@bgq/core';

const line = (mark: string, i: TableIssue) =>
  `  ${mark} ${i.kpId ? `${i.kpId}: ` : ''}${i.message}`;

/** Сводка таблицы точек: цифры, затем все проблемы — их немного, и каждая важна. */
export function formatTableSummary(t: PointsFile): string {
  const s = t.stats;
  const critical = t.issues.filter((i) => i.severity === 'critical');
  const cosmetic = t.issues.filter((i) => i.severity === 'cosmetic');
  const out = [
    `${s.kps} КП · доступно ${s.eligible} · баллов ${s.points}`,
    `координаты: карта ${s.locFrom.map} · адрес ${s.locFrom.geocode} · вручную ${s.locFrom.manual} · доступных без координат ${s.eligibleWithoutLoc}`,
    `старт: ${t.start ? 'есть' : 'нет'} · финиш: ${t.finish ? 'есть' : 'нет'}`,
    `✗ критичных: ${critical.length}`,
    ...critical.map((i) => line('✗', i)),
    `△ косметика: ${cosmetic.length}`,
    ...cosmetic.map((i) => line('△', i)),
  ];
  return out.join('\n');
}
