// Экран «Маршрут» (секретарь): КП по порядку плана (пройденные свёрнуты), затем «не в плане».
// Тап — карточка КП.
import { useState } from 'preact/hooks';
import { collapseDone, type KpRow, type RouteRows } from './route.ts';
import { go } from './router.ts';

export function RouteView(props: { rows: RouteRows; hasPlan: boolean }) {
  const { plan, rest } = props.rows;
  // Пройденные свёрнуты: сверху строка «Пройденные · N», дальше — откуда идём и что впереди.
  const [showDone, setShowDone] = useState(false);
  const { hidden, shown } = collapseDone(plan);
  const visible = showDone ? plan : shown;
  return (
    <>
      {!props.hasPlan && (
        <p class="note-msg">
          Плана нет — КП по номерам. На ноутбуке: <code>./bgq route</code>, затем{' '}
          <code>./bgq pwa</code> и «Обновить игру».
        </p>
      )}
      {hidden.length > 0 && (
        <button
          type="button"
          class="done-toggle"
          aria-expanded={showDone}
          onClick={() => setShowDone(!showDone)}
        >
          {showDone ? '▾ Скрыть пройденные' : `▸ Пройденные · ${hidden.length}`}
        </button>
      )}
      {visible.length > 0 && (
        <ul class="kps">
          {visible.map((r) => (
            <KpItem key={r.kp.id} row={r} />
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <>
          <h2 class="section">
            {props.hasPlan ? 'Не в плане' : 'КП'} · {rest.length}
          </h2>
          <ul class="kps">
            {rest.map((r) => (
              <KpItem key={r.kp.id} row={r} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** Значок статуса: ✓ взят, ⏭ пропущен, 🧩 загадка без отгадки. */
export function statusMark(r: KpRow): string {
  if (r.status === 'taken') return '✓';
  if (r.status === 'skipped') return '⏭';
  return r.kp.kind === 'riddle' && !r.kp.loc ? '🧩' : '';
}

function KpItem({ row: r }: { row: KpRow }) {
  return (
    <li class={`kp ${r.status}`}>
      <button type="button" onClick={() => go({ name: 'kp', id: r.kp.id })}>
        <span class="n">{r.stop ? r.stop.n : ''}</span>
        <span class="body">
          <span class="line">
            <span class="id">{r.kp.id}</span>
            {r.kp.kind === 'riddle' && <span>🧩</span>}
            {r.kp.window && (
              <span class="flag">
                ⏰{r.kp.window.from}–{r.kp.window.to}
              </span>
            )}
            <span class="spacer" />
            {r.status === 'taken' && <span class="time">✓ {r.answerTime ?? 'без времени'}</span>}
            {r.status === 'skipped' && <span class="muted">⏭ пропущен</span>}
            {r.status === 'open' && r.stop && <span class="muted">{r.stop.arrive}</span>}
            {r.status === 'open' && !r.stop && statusMark(r) && <span>{statusMark(r)}</span>}
          </span>
          <span class="title-line">{r.kp.title}</span>
          {r.answer && <span class="note-preview">✎ {r.answer}</span>}
        </span>
      </button>
    </li>
  );
}
