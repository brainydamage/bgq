// Экран «Книжка» (секретарь): переписывание в бумажную книжку ответов — по номерам, как в книжке.
import { type Book, type BookRow, FLAG_TEXT, isCopied } from './book.ts';
import { pointsLabel } from './checklist.ts';
import { go } from './router.ts';

export function BookView(props: { book: Book; onToggle: (row: BookRow) => void; all: number }) {
  const { kps, tasks } = props.book;
  if (!props.all)
    return <p class="note-msg">Взятых КП и сделанных заданий пока нет — переписывать нечего.</p>;
  return (
    <>
      {kps.length > 0 && (
        <ul class="book">
          {kps.map((r) => (
            <BookItem key={r.id} row={r} onToggle={() => props.onToggle(r)} />
          ))}
        </ul>
      )}
      {tasks.length > 0 && (
        <>
          <h2 class="section">Задания без номера · {tasks.length}</h2>
          <ul class="book">
            {tasks.map((r) => (
              <BookItem key={r.id} row={r} onToggle={() => props.onToggle(r)} />
            ))}
          </ul>
        </>
      )}
      {!kps.length && !tasks.length && <p class="muted all-done">Всё переписано ✍️</p>}
    </>
  );
}

function BookItem(props: { row: BookRow; onToggle: () => void }) {
  const { row: r } = props;
  const done = isCopied(r);
  const zero = r.flags.includes('not_taken') || r.flags.includes('no_time');
  const chips = r.flags.filter((f) => f !== 'no_answer'); // «нет ответа» — в строке ответа
  const name = r.kp ? `КП ${r.id}` : (r.task?.title ?? r.id);
  const cls = ['bookrow', done && 'done', zero && 'zero', !zero && r.flags.length > 0 && 'attn']
    .filter(Boolean)
    .join(' ');
  return (
    <li class={cls}>
      <label class="check">
        <input
          type="checkbox"
          checked={done}
          aria-label={`${name}: переписано`}
          onChange={props.onToggle}
        />
        <span aria-hidden="true">{done ? '✓' : r.copied ? '↻' : ''}</span>
      </label>
      <button
        type="button"
        class="head"
        disabled={!r.kp}
        onClick={() => r.kp && go({ name: 'kp', id: r.id })}
      >
        <span class="line">
          {r.kp ? <span class="id">{r.id}</span> : <span class="name">{name}</span>}
          <span class="pts">{r.task ? pointsLabel(r.task) : `${r.points} б`}</span>
          <span class="spacer" />
          <span class={r.answerTime ? 'book-time' : 'book-time missing'}>
            {r.answerTime ?? '—:—'}
          </span>
        </span>
        {r.kp && (
          <span class={r.answer.trim() ? 'book-answer' : 'book-answer missing'}>
            {r.answer.trim() || (r.kp.answerKind === 'text' ? 'нет ответа' : 'ответ не текстом')}
          </span>
        )}
        {chips.length > 0 && (
          <span class="book-flags">
            {chips.map((f) => (
              <span key={f} class={f === 'recopy' ? 'flag' : 'bad'}>
                {FLAG_TEXT[f]}
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  );
}
