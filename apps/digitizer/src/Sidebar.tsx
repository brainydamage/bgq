import { FINISH_ID, type Kp, START_ID, type TimeWindow } from '@bgq/core';
import type { GeoResult } from '@bgq/geo';
import { CONTROL_METHODS, type PhotoFit } from './compute.ts';
import type { MapResult, PhotoLabels } from './model.ts';

interface FitPanelProps {
  fit: PhotoFit | undefined;
  labels: PhotoLabels | undefined;
  onToggleControl(id: string): void;
}

/** Точность привязки активного фото и выбросы. */
export function FitPanel({ fit, labels, onToggleControl }: FitPanelProps) {
  if (!fit || !labels)
    return <section class="panel">Нет фото — перетащите снимки карты в окно.</section>;
  const f = fit.fit;
  return (
    <section class="panel">
      <h3>Привязка: {fit.file}</h3>
      {f.ok ? (
        <>
          <p>
            опорных {f.report.controls} · свои {f.report.inliers.length} · выбросы{' '}
            {f.report.outliers.length}
          </p>
          {f.report.loo ? (
            <p class={f.report.loo.p90M > 50 ? 'warn' : 'good'}>
              точность: медиана {f.report.loo.medianM} м · 90% ≤ {f.report.loo.p90M} м · макс{' '}
              {f.report.loo.maxM} м
            </p>
          ) : (
            <p class="warn">точность появится от 5 опорных точек</p>
          )}
          {f.report.controls < 6 && <p class="warn">мало опорных — отметьте ещё адресные КП (⌂)</p>}
        </>
      ) : (
        <p class="warn">{f.reason}. Отметьте адресные КП (⌂ в списке).</p>
      )}
      {f.ok &&
        f.report.outliers.map((o) => (
          // Карта главнее адреса: кружок не там, где адрес, — обычное дело (71Б: в Notion «1»,
          // на карте «1г» в 200 м). Координаты КП всё равно берутся с карты.
          <p key={o.id} class="outlier">
            ✗ {o.id}: кружок в {o.errorM} м от адреса — координаты берём с карты, как опорная не
            используется. Проверьте номер; если верный — так нарисовано на карте.{' '}
            <button type="button" onClick={() => onToggleControl(o.id)}>
              не опорная
            </button>
          </p>
        ))}
      {labels.disabled.map((id) => (
        <p key={id} class="muted">
          {id} выключена как опорная{' '}
          <button type="button" onClick={() => onToggleControl(id)}>
            вернуть
          </button>
        </p>
      ))}
    </section>
  );
}

interface KpListProps {
  kps: Kp[];
  geo: Map<string, GeoResult>;
  photos: PhotoLabels[];
  results: Map<string, MapResult>;
  activeFile: string | undefined;
  todoOnly: boolean;
  onTodoOnly(v: boolean): void;
  onPick(id: string): void;
}

const byId = (a: string, b: string) => a.localeCompare(b, 'ru', { numeric: true });

/** Всплывающая подсказка строки: полный текст КП — помогает найти кружок на карте. */
function kpTooltip(k: Kp): string {
  const lines = [`${k.id} · ${k.points} б. · ${k.title}`];
  if (k.address) {
    const alt = k.address.alt ? ` (${k.address.alt})` : '';
    const shown = k.address.raw === k.title || k.description.includes(k.address.raw);
    if (!shown) lines.push(`адрес: ${k.address.raw}${alt}`);
  }
  lines.push(...k.description);
  if (k.extraPhoto) lines.push(`+ ${k.extraPhoto}`);
  return lines.join('\n');
}

/** Все КП: где отмечены, есть ли адрес, итог. */
export function KpList(p: KpListProps) {
  const markedOn = new Map<string, string[]>();
  for (const ph of p.photos) {
    for (const m of ph.marks) markedOn.set(m.id, [...(markedOn.get(m.id) ?? []), ph.file]);
  }
  const known = new Set(p.kps.map((k) => k.id));
  const specials = [
    { id: START_ID, label: 'Старт' },
    { id: FINISH_ID, label: 'Финиш' },
  ];
  const unknown = [...markedOn.keys()].filter(
    (id) => !known.has(id) && id !== START_ID && id !== FINISH_ID,
  );
  const windowOn = new Map<string, TimeWindow>();
  for (const ph of p.photos) for (const m of ph.marks) if (m.window) windowOn.set(m.id, m.window);
  const eligible = p.kps.filter((k) => k.eligible);
  const done = eligible.filter((k) => p.results.has(k.id)).length;
  const rows = [...p.kps]
    .sort((a, b) => byId(a.id, b.id))
    .filter((k) => !p.todoOnly || (k.eligible && !markedOn.has(k.id)));

  return (
    <section class="panel list">
      <h3>
        КП: координаты у {done} из {eligible.length} доступных
      </h3>
      <label>
        <input
          type="checkbox"
          checked={p.todoOnly}
          onChange={(e) => p.onTodoOnly((e.currentTarget as HTMLInputElement).checked)}
        />{' '}
        только неразмеченные
      </label>
      <ul>
        {specials.map((s) => {
          const on = markedOn.get(s.id) ?? [];
          return (
            <li
              key={s.id}
              class={on.length ? 'special' : 'special missing'}
              onClick={() => on.length && p.onPick(s.id)}
              onKeyDown={() => {}}
              title="Отметьте на фото: клик → «с» (старт) или «ф» (финиш). Нужно для маршрута."
            >
              <b>{s.label}</b>
              <span class="tags">{on.length ? '●' : ''}</span>
              <span class="title">{on.length ? 'отмечен' : 'не отмечен — нужен для маршрута'}</span>
            </li>
          );
        })}
        {rows.map((k) => {
          const g = p.geo.get(k.id);
          const isControl = !!g?.method && CONTROL_METHODS.has(g.method);
          const on = markedOn.get(k.id) ?? [];
          return (
            <li
              key={k.id}
              title={kpTooltip(k)}
              class={`${k.eligible ? '' : 'muted'} ${on.includes(p.activeFile ?? '') ? 'here' : ''}`}
              onClick={() => on.length && p.onPick(k.id)}
              onKeyDown={() => {}}
            >
              <b>{k.id}</b>
              <span class="tags">
                {isControl && <span title="адрес найден geo — опорная точка">⌂</span>}
                {on.length > 0 && (
                  <span title={on.join(', ')}>●{on.length > 1 ? on.length : ''}</span>
                )}
                {!k.eligible && <span title="недоступен нашей категории">вело</span>}
                {(k.window ?? windowOn.get(k.id)) && <span title="есть окно работы">⏰</span>}
              </span>
              <span class="title">{k.title}</span>
            </li>
          );
        })}
        {unknown.map((id) => (
          <li key={id} class="unknown" onClick={() => p.onPick(id)} onKeyDown={() => {}}>
            <b>{id}</b> <span class="title">нет в Notion</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
