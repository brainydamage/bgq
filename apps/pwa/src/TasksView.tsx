// Экран «Задания»: чек-лист заданий без места.
import { useState } from 'preact/hooks';
import { useAutosave } from './autosave.ts';
import { pointsLabel, type TaskRow } from './checklist.ts';

export function TasksView(props: {
  rows: TaskRow[];
  onToggle: (row: TaskRow) => void;
  onNote: (kpId: string, note: string) => void;
  onTime: (kpId: string, hhmm: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <ul class="tasks">
      {props.rows.map((row) => (
        <TaskItem
          key={row.task.id}
          row={row}
          open={expanded === row.task.id}
          onToggle={() => props.onToggle(row)}
          onOpen={() => setExpanded(expanded === row.task.id ? null : row.task.id)}
          onNote={(note) => props.onNote(row.task.id, note)}
          onTime={(hhmm) => props.onTime(row.task.id, hhmm)}
        />
      ))}
      {!props.rows.length && <li class="muted all-done">Всё сделано 🎉</li>}
    </ul>
  );
}

function TaskItem(props: {
  row: TaskRow;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onNote: (note: string) => void;
  onTime: (hhmm: string) => void;
}) {
  const { row, open } = props;
  const { task } = row;
  // Сохраняется и когда строка исчезает (фильтр «не сделано» после галочки).
  const note = useAutosave(row.note, props.onNote);

  return (
    <li class={`task${row.done ? ' done' : ''}`}>
      <div class="row">
        <label class="check">
          <input
            type="checkbox"
            checked={row.done}
            aria-label={`${task.title}: сделано`}
            onChange={props.onToggle}
          />
          <span aria-hidden="true">{row.done ? '✓' : ''}</span>
        </label>
        <button type="button" class="head" aria-expanded={open} onClick={props.onOpen}>
          <span class="name">{task.title}</span>
          <span class="meta">
            <span class="pts">{pointsLabel(task)}</span>
            {task.atFinish && <span class="flag">🏁 сдать на финише</span>}
            {row.done && row.doneAt && <span class="time">✓ {row.doneAt}</span>}
          </span>
          {!open && row.note && <span class="note-preview">✎ {row.note}</span>}
        </button>
      </div>
      {open && (
        <div class="details">
          {task.text && <p class="text">{task.text}</p>}
          {row.done && (
            <TimeField label="Время «сделано»" value={row.doneAt} onTime={props.onTime} />
          )}
          <label class="field">
            Заметка
            <textarea
              rows={2}
              value={note.draft}
              placeholder="фото у Иры, письмо в рюкзаке…"
              onInput={(e) => note.onInput(e.currentTarget.value)}
              onBlur={note.flush}
            />
          </label>
        </div>
      )}
    </li>
  );
}

/** Правка времени «ЧЧ:ММ» — событие только на настоящее изменение. */
export function TimeField(props: {
  label: string;
  value: string | undefined;
  onTime: (hhmm: string) => void;
}) {
  return (
    <label class="field">
      {props.label}
      <input
        type="time"
        value={props.value ?? ''}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (/^\d\d:\d\d$/.test(v) && v !== props.value) props.onTime(v);
        }}
      />
    </label>
  );
}
