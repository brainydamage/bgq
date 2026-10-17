import type { PointsFile, TableIssue } from '@bgq/core';

const line = (mark: string, i: TableIssue) =>
  `  ${mark} ${i.kpId ? `${i.kpId}: ` : ''}${i.message}`;

/** Сводка таблицы точек: цифры, затем все проблемы — их немного, и каждая важна. */
export function formatTableSummary(t: PointsFile): string {
  const s = t.stats;
  const critical = t.issues.filter((i) => i.severity === 'critical');
  // Нерешённые загадки — одной строкой: их много и это не ошибка.
  const unsolved = t.issues.filter((i) => i.code === 'riddle_unsolved');
  const cosmetic = t.issues.filter(
    (i) => i.severity === 'cosmetic' && i.code !== 'riddle_unsolved',
  );
  const riddles = t.kps.filter((k) => k.kind === 'riddle' && k.eligible);
  const solved = riddles.filter((k) => k.loc);
  const out = [
    `${s.kps} КП · доступно ${s.eligible} · баллов ${s.points}`,
    ...(riddles.length
      ? [
          `загадки: решено ${solved.length} из ${riddles.length} (${solved.reduce((x, k) => x + k.points, 0)} из ${riddles.reduce((x, k) => x + k.points, 0)} б)`,
        ]
      : []),
    `координаты: карта ${s.locFrom.map} · адрес ${s.locFrom.geocode} · вручную ${s.locFrom.manual} · доступных без координат ${s.eligibleWithoutLoc}`,
    `старт: ${t.start ? 'есть' : 'нет'} · финиш: ${t.finish ? 'есть' : 'нет'}`,
    `✗ критичных: ${critical.length}`,
    ...critical.map((i) => line('✗', i)),
    `△ косметика: ${cosmetic.length}`,
    ...cosmetic.map((i) => line('△', i)),
    ...(unsolved.length
      ? [`🧩 не решены (в маршрут не идут): ${unsolved.map((i) => i.kpId).join(', ')}`]
      : []),
  ];
  return out.join('\n');
}
