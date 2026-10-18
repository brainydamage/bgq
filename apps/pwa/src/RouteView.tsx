// Экран «Маршрут» (секретарь): КП по порядку плана, затем «не в плане». Тап — карточка КП.
import type { KpRow, RouteRows } from './route.ts';
import { go } from './router.ts';

export function RouteView(props: { rows: RouteRows; hasPlan: boolean }) {
  const { plan, rest } = props.rows;
  return (
    <>
      {!props.hasPlan && (
        <p class="note-msg">
          Плана нет — КП по номерам. На ноутбуке: <code>./bgq route</code>, затем{' '}
          <code>./bgq pwa</code> и «Обновить игру».
        </p>
      )}
      {plan.length > 0 && (
        <ul class="kps">
          {plan.map((r) => (
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
            <span class="pts">{r.kp.points} б</span>
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
