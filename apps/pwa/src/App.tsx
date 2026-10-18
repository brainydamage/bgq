import { clockIn, type Event, PhoneGame, projectState, schemaErrors } from '@bgq/core';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  finishReminder,
  pointsLabel,
  summarize,
  summaryText,
  type TaskRow,
  taskRows,
  visibleRows,
} from './checklist.ts';
import { appendEvent, loadCurrent, saveGame } from './db.ts';
import { type Body, makeEvent, toggleBody } from './events.ts';
import { offlineReady, onUpdate } from './sw-client.ts';

declare const __BGQ_BUILD__: string;
const BUILD = new Date(__BGQ_BUILD__).toLocaleString('ru', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const FILTER_KEY = 'bgq.onlyOpen';
function readFilter(): boolean {
  try {
    return localStorage.getItem(FILTER_KEY) === '1';
  } catch {
    return false;
  }
}
function writeFilter(v: boolean) {
  try {
    localStorage.setItem(FILTER_KEY, v ? '1' : '0');
  } catch {
    // приватный режим — фильтр просто не запомнится
  }
}

/** Текст phone.json → игра или текст ошибки. */
function parsePhone(text: string): PhoneGame | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return 'Это не JSON — нужен phone.json из ./bgq pwa';
  }
  const errors = schemaErrors(PhoneGame, data);
  return errors.length
    ? `phone.json не подходит: ${errors.slice(0, 3).join('; ')}`
    : (data as PhoneGame);
}

const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function App() {
  const [loaded, setLoaded] = useState(false);
  const [game, setGame] = useState<PhoneGame | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(readFilter);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [offline, setOffline] = useState(false);
  const [update, setUpdate] = useState<(() => void) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function importText(text: string) {
    const parsed = parsePhone(text);
    if (typeof parsed === 'string') return setError(parsed);
    const same = (await loadCurrent()).game?.gameId === parsed.gameId;
    await saveGame(parsed);
    const cur = await loadCurrent();
    setGame(cur.game);
    setEvents(cur.events);
    setError('');
    setMessage(
      `${same ? 'Обновлено' : 'Загружено'}: ${parsed.city}, ${parsed.date} — заданий ${parsed.tasks.length}` +
        (same ? ', отметки сохранены' : ''),
    );
  }

  // Один раз при запуске.
  useEffect(() => {
    void (async () => {
      try {
        const cur = await loadCurrent();
        setGame(cur.game);
        setEvents(cur.events);
        // ?load=phone.json — загрузка с того же сервера (./bgq pwa dev); только относительный путь.
        const load = new URLSearchParams(location.search).get('load');
        if (load && !/^[a-z]+:|^\/\//i.test(load)) {
          history.replaceState(null, '', location.pathname);
          const res = await fetch(load, { cache: 'no-store' });
          if (res.ok) await importText(await res.text());
          else setError(`Не загрузилось ${load}: ${res.status}`);
        }
      } catch (e) {
        setError(`Хранилище недоступно: ${(e as Error).message}`);
      } finally {
        setLoaded(true);
      }
    })();
    void navigator.storage?.persist?.().then(setPersisted, () => setPersisted(false));
    void offlineReady().then(setOffline);
    onUpdate((apply) => setUpdate(() => apply));
    const tick = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const rows = useMemo(
    () => (game ? taskRows(game.tasks, projectState(events, game.gameId)) : []),
    [game, events],
  );
  const summary = summarize(rows);
  const clock = game ? clockIn(game.tz, now) : null;
  const reminder = game && clock ? finishReminder(rows, game, clock) : null;

  async function record(kpId: string, body: Body) {
    if (!game) return;
    try {
      const e = await appendEvent((device) => makeEvent(game.gameId, kpId, body, device));
      setEvents((prev) => [...prev, e]);
    } catch (e) {
      setError(`Не сохранилось: ${(e as Error).message}`);
    }
  }

  function toggle(row: TaskRow) {
    if (!game) return;
    void record(row.task.id, toggleBody(row.done, clockIn(game.tz).hhmm));
  }

  function setFilter(v: boolean) {
    setOnlyOpen(v);
    writeFilter(v);
  }

  async function onFile(e: globalThis.Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await importText(await file.text());
  }

  const shown = visibleRows(rows, onlyOpen);

  return (
    <div class="app">
      {update && (
        <button type="button" class="update" onClick={update}>
          Есть новая версия — обновить
        </button>
      )}
      <header class="top">
        <div class="title">
          <h1>Задания</h1>
          {game && (
            <span class="muted">
              {game.city} · {game.date} · финиш {game.deadline}
            </span>
          )}
        </div>
        {game && (
          <>
            <p class="summary">{summaryText(summary)}</p>
            <div class="filter">
              <button type="button" aria-pressed={!onlyOpen} onClick={() => setFilter(false)}>
                Все · {summary.total}
              </button>
              <button type="button" aria-pressed={onlyOpen} onClick={() => setFilter(true)}>
                Не сделано · {summary.left}
              </button>
            </div>
          </>
        )}
      </header>

      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {message && !error && <p class="note-msg">{message}</p>}

      {reminder && (
        <section class="reminder" role="status">
          <strong>
            🏁 Сдать на финише ·{' '}
            {reminder.minutesLeft >= 0
              ? `до дедлайна ${reminder.minutesLeft} мин`
              : `дедлайн прошёл ${-reminder.minutesLeft} мин назад`}
          </strong>
          <ul>
            {reminder.rows.map((r) => (
              <li key={r.task.id}>
                {r.done ? '✓' : '✗'} {r.task.title}
                {!r.done && <span class="warn"> — не сделано</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {loaded && !game && (
        <section class="empty">
          <p>Игры ещё нет.</p>
          <ol>
            <li>
              На ноутбуке: <code>./bgq pwa</code> → <code>games/&lt;дата&gt;/phone.json</code>
            </li>
            <li>AirDrop на iPhone → «Сохранить в Файлы»</li>
            <li>Здесь: «Загрузить игру» → выбрать phone.json</li>
          </ol>
        </section>
      )}

      {game && (
        <ul class="tasks">
          {shown.map((row) => (
            <TaskItem
              key={row.task.id}
              row={row}
              open={expanded === row.task.id}
              onToggle={() => toggle(row)}
              onOpen={() => setExpanded(expanded === row.task.id ? null : row.task.id)}
              onNote={(answer) => record(row.task.id, { type: 'answer_changed', answer })}
              onTime={(answerTime) => record(row.task.id, { type: 'answer_changed', answerTime })}
            />
          ))}
          {!shown.length && <li class="muted all-done">Всё сделано 🎉</li>}
        </ul>
      )}

      <footer class="bottom">
        <button type="button" class="load" onClick={() => fileRef.current?.click()}>
          {game ? 'Обновить игру (phone.json)' : 'Загрузить игру'}
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFile} />
        <p class="muted small">
          {offline ? '✓ работает без сети' : '△ без сети не откроется'}
          {' · '}
          {persisted ? '✓ хранилище постоянное' : '△ Safari может очистить хранилище'}
          {game && ` · phone.json от ${new Date(game.exportedAt).toLocaleString('ru')}`}
          {` · версия ${BUILD}`}
        </p>
        {!isStandalone() && (
          <p class="muted small">
            На iPhone: «Поделиться» → «На экран „Домой“» и открывать оттуда — у значка своё
            хранилище, отдельно от Safari.
          </p>
        )}
      </footer>
    </div>
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
  const [draft, setDraft] = useState(row.note);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useRef(row.note);
  const latest = useRef({ draft, onNote: props.onNote });
  latest.current = { draft, onNote: props.onNote };

  // Заметку обновили извне (повторный импорт, позже — штурман) и мы её не правим — показать.
  useEffect(() => {
    if (!timer.current) setDraft(row.note);
    saved.current = row.note;
  }, [row.note]);

  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const text = latest.current.draft;
    if (text !== saved.current) {
      saved.current = text;
      latest.current.onNote(text);
    }
  }

  // Сохранение при вводе — через 0,7 с тишины; сразу — при уходе в фон и когда строка исчезает
  // (фильтр «не сделано» после галочки).
  function onInput(text: string) {
    setDraft(text);
    latest.current.draft = text;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  }
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, []);

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
            <label class="field">
              Время «сделано»
              <input
                type="time"
                value={row.doneAt ?? ''}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  if (/^\d\d:\d\d$/.test(v) && v !== row.doneAt) props.onTime(v);
                }}
              />
            </label>
          )}
          <label class="field">
            Заметка
            <textarea
              rows={2}
              value={draft}
              placeholder="фото у Иры, письмо в рюкзаке…"
              onInput={(e) => onInput(e.currentTarget.value)}
              onBlur={flush}
            />
          </label>
        </div>
      )}
    </li>
  );
}
