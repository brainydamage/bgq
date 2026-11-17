import {
  clockIn,
  type Event,
  PhoneGame,
  type Plan,
  clock as planClock,
  projectPauses,
  projectPlan,
  projectState,
  schemaErrors,
} from '@bgq/core';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { answerHistory } from './answers.ts';
import { BookView } from './BookView.tsx';
import {
  type BookRow,
  bookRows,
  bookSummaryText,
  copyBody,
  summarizeBook,
  visibleBook,
} from './book.ts';
import {
  finishReminder,
  summarize,
  summaryText,
  type TaskRow,
  taskRows,
  visibleRows,
} from './checklist.ts';
import { appendEvent, loadCurrent, saveGame, syncStore } from './db.ts';
import { type Body, makeEvent, PAUSE_ID, PLAN_ID, toggleBody } from './events.ts';
import { KpCard } from './KpCard.tsx';
import { NavView } from './NavView.tsx';
import { ReplanPanel } from './ReplanPanel.tsx';
import { RouteView } from './RouteView.tsx';
import { effectivePlan } from './replan.ts';
import { forecast, forecastText, routeRows, takenSummary } from './route.ts';
import { go, type Screen, useScreen } from './router.ts';
import { offlineReady, onUpdate } from './sw-client.ts';
import {
  createSyncer,
  httpSend,
  mergeEvents,
  type Syncer,
  type SyncStatus,
  stuckText,
  syncText,
} from './sync.ts';
import { TasksView } from './TasksView.tsx';

declare const __BGQ_BUILD__: string;
const BUILD = new Date(__BGQ_BUILD__).toLocaleString('ru', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const FILTER_KEY = 'bgq.onlyOpen';
const BOOK_FILTER_KEY = 'bgq.book.onlyLeft';
function readFilter(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeFilter(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
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
  const [onlyOpen, setOnlyOpen] = useState(() => readFilter(FILTER_KEY));
  const [onlyLeft, setOnlyLeft] = useState(() => readFilter(BOOK_FILTER_KEY));
  const [now, setNow] = useState(() => new Date());
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [offline, setOffline] = useState(false);
  const [update, setUpdate] = useState<(() => void) | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [replanOpen, setReplanOpen] = useState(false);
  const syncer = useRef<Syncer | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hashScreen = useScreen();
  // Откуда открыли карточку КП — туда и «назад».
  const [tab, setTab] = useState<KpTab>('route');

  async function importText(text: string) {
    const parsed = parsePhone(text);
    if (typeof parsed === 'string') return setError(parsed);
    const same = (await loadCurrent()).game?.gameId === parsed.gameId;
    await saveGame(parsed);
    const cur = await loadCurrent();
    setGame(cur.game);
    setEvents(cur.events);
    setError('');
    const plan = parsed.plan
      ? `, план ${parsed.plan.stops.length} КП`
      : parsed.kps
        ? ', без плана'
        : '';
    setMessage(
      `${same ? 'Обновлено' : 'Загружено'}: ${parsed.city}, ${parsed.date} — заданий ${parsed.tasks.length}` +
        (parsed.kps ? `, КП ${parsed.kps.length}${plan}` : '') +
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
          history.replaceState(null, '', location.pathname + location.hash);
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

  const state = useMemo(
    () => (game ? projectState(events, game.gameId) : new Map()),
    [game, events],
  );
  const rows = useMemo(() => (game ? taskRows(game.tasks, state) : []), [game, state]);
  // План: принятый на телефоне (пересчёт), если он новее плана из phone.json.
  const eff = useMemo(
    () => (game ? effectivePlan(game, projectPlan(events, game.gameId)) : null),
    [game, events],
  );
  const route = useMemo(
    () => (eff ? routeRows(eff.game, state) : { plan: [], rest: [] }),
    [eff, state],
  );
  const book = useMemo(
    () => (game ? bookRows(game, state) : { kps: [], tasks: [] }),
    [game, state],
  );
  const bookSummary = summarizeBook(book);
  const summary = summarize(rows);
  const clock = game ? clockIn(game.tz, now) : null;
  const reminder = game && clock ? finishReminder(rows, game, clock) : null;
  const stuck = game ? stuckText(sync, now, game.tz) : null;
  const pauses = useMemo(
    () => (game ? projectPauses(events, game.gameId) : { closed: [] }),
    [game, events],
  );
  const onPause = pauses.openSince !== undefined;
  const fc = eff ? forecast(eff.game, route.plan, now, pauses, eff.accepted?.atMs) : null;
  const canReplan = Boolean(fc && eff?.game.problem);
  const taken = takenSummary(route);

  // Экран: из хэша; по умолчанию — маршрут, если в игре есть КП, иначе задания.
  const hasKps = Boolean(game?.kps);
  const screen: Screen = hashScreen ?? { name: hasKps ? 'route' : 'tasks' };
  const kpRow =
    screen.name === 'kp'
      ? [...route.plan, ...route.rest].find((r) => r.kp.id === screen.id)
      : undefined;
  useEffect(() => {
    if (screen.name === 'route' || screen.name === 'nav' || screen.name === 'book')
      setTab(screen.name);
  }, [screen.name]);

  // Синхронизация с другим телефоном — если в phone.json есть адрес; пересоздаётся при смене игры
  // или адреса/кода. Отметки сети не ждут: запись в IndexedDB, отправка — в фоне.
  const syncKey = game?.sync ? JSON.stringify([game.gameId, game.sync.url, game.sync.code]) : '';
  useEffect(() => {
    if (!syncKey) {
      setSync(null);
      return;
    }
    const [gameId, url, code] = JSON.parse(syncKey) as [string, string, string];
    const s = createSyncer({
      gameId,
      store: syncStore,
      send: httpSend({ url, code }),
      onStatus: setSync,
      onEvents: (got) => setEvents((prev) => mergeEvents(prev, got)),
    });
    syncer.current = s;
    s.kick();
    const wake = () => {
      if (document.visibilityState === 'visible') s.kick();
    };
    addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      s.stop();
      syncer.current = null;
      removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [syncKey]);

  async function record(kpId: string, body: Body) {
    if (!game) return;
    try {
      const e = await appendEvent((device) => makeEvent(game.gameId, kpId, body, device));
      setEvents((prev) => [...prev, e]);
      // Прогноз — от свежего «сейчас», не от последнего тика в 30 с (нажали «Пауза»).
      setNow(new Date());
      syncer.current?.kick();
    } catch (e) {
      setError(`Не сохранилось: ${(e as Error).message}`);
    }
  }
  const nowHhmm = () => (game ? clockIn(game.tz).hhmm : '');

  function toggle(row: TaskRow) {
    void record(row.task.id, toggleBody(row.done, nowHhmm()));
  }

  function setFilter(v: boolean) {
    setOnlyOpen(v);
    writeFilter(FILTER_KEY, v);
  }
  function setBookFilter(v: boolean) {
    setOnlyLeft(v);
    writeFilter(BOOK_FILTER_KEY, v);
  }

  async function onFile(e: globalThis.Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await importText(await file.text());
  }

  const title =
    screen.name === 'kp'
      ? `КП ${screen.id}`
      : screen.name === 'nav'
        ? 'Штурман'
        : screen.name === 'route'
          ? 'Маршрут'
          : screen.name === 'book'
            ? 'Книжка ответов'
            : 'Задания';

  return (
    <div class={`app${game ? ' with-tabs' : ''}`}>
      {update && (
        <button type="button" class="update" onClick={update}>
          Есть новая версия — обновить
        </button>
      )}
      {game && stuck && (
        <p class="stuck" role="alert">
          {stuck}
        </p>
      )}
      <header class="top">
        <div class="title">
          {screen.name === 'kp' && (
            <button type="button" class="back" onClick={() => go({ name: tab })}>
              ← {TAB_LABEL[tab]}
            </button>
          )}
          <h1>{title}</h1>
          {/* В игре на «Маршруте» и «Штурмане» город и дату не показываем: дедлайн — в прогнозе. */}
          {game &&
            screen.name !== 'kp' &&
            !(fc && (screen.name === 'route' || screen.name === 'nav')) && (
              <span class="muted">
                {game.city} · {game.date} · финиш {game.deadline}
              </span>
            )}
        </div>
        {game && (screen.name === 'route' || screen.name === 'nav') && (
          <div class="summary">
            {fc ? (
              forecastText(fc).map((line) => (
                <p
                  key={line.text}
                  class={`fc-${line.kind}${line.tone ? ` fc-${line.tone}` : ''}${line.kind === 'detail' ? ' muted small' : ''}`}
                >
                  {line.text}
                </p>
              ))
            ) : (
              <p>финиш до {game.deadline}</p>
            )}
            {fc && (
              <div class="summary-actions">
                <button
                  type="button"
                  class={`pause-btn${onPause ? ' on' : ''}`}
                  onClick={() =>
                    void record(PAUSE_ID, { type: onPause ? 'pause_ended' : 'pause_started' })
                  }
                >
                  {onPause ? '▶ Закончить паузу' : '☕ Начать паузу'}
                </button>
                {canReplan && (
                  <button
                    type="button"
                    class={`pause-btn${replanOpen ? ' on' : ''}`}
                    onClick={() => setReplanOpen(!replanOpen)}
                  >
                    ⟳ Пересчитать
                  </button>
                )}
              </div>
            )}
            {screen.name === 'route' && (
              <p class="muted small">
                взято {taken.taken} · {taken.points} б
                {taken.skipped ? ` · пропущено ${taken.skipped}` : ''}
              </p>
            )}
          </div>
        )}
        {game && screen.name === 'tasks' && (
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
        {game && screen.name === 'book' && (
          <>
            <div class="summary">
              {bookSummaryText(bookSummary).map((line, i) => (
                <p key={line} class={i ? 'warn' : ''}>
                  {line}
                </p>
              ))}
            </div>
            <div class="filter">
              <button type="button" aria-pressed={!onlyLeft} onClick={() => setBookFilter(false)}>
                Все · {bookSummary.total}
              </button>
              <button type="button" aria-pressed={onlyLeft} onClick={() => setBookFilter(true)}>
                Не переписано · {bookSummary.left}
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

      {eff && replanOpen && canReplan && (screen.name === 'route' || screen.name === 'nav') && (
        <ReplanPanel
          game={eff.game}
          rows={route}
          now={now}
          pauses={pauses}
          accepted={eff.accepted}
          onClose={() => setReplanOpen(false)}
          onAccept={(plan: Plan, pauseMin: number) => {
            setReplanOpen(false);
            const done = new Set(
              [...route.plan, ...route.rest].filter((r) => r.status !== 'open').map((r) => r.kp.id),
            );
            const left = plan.stops.filter((s) => !done.has(s.kpId)).length;
            void record(PLAN_ID, { type: 'plan_accepted', plan, pauseMin }).then(() =>
              setMessage(
                `Новый план: впереди ${left} КП, финиш ${planClock(plan.t0, plan.finishS)}, пауза впереди ${pauseMin} мин`,
              ),
            );
          }}
        />
      )}

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

      {game && screen.name === 'tasks' && (
        <TasksView
          rows={visibleRows(rows, onlyOpen)}
          onToggle={toggle}
          onNote={(kpId, answer) => record(kpId, { type: 'answer_changed', answer })}
          onTime={(kpId, answerTime) => record(kpId, { type: 'answer_changed', answerTime })}
        />
      )}
      {game && screen.name === 'book' && (
        <BookView
          book={visibleBook(book, onlyLeft)}
          all={bookSummary.total}
          onToggle={(r: BookRow) => record(r.id, copyBody(r))}
        />
      )}
      {game && screen.name === 'route' && (
        <RouteView rows={route} hasPlan={Boolean(eff?.game.plan)} />
      )}
      {game && screen.name === 'nav' && (
        <NavView
          plan={route.plan}
          hasPlan={Boolean(eff?.game.plan)}
          finish={game.finish}
          onSkip={(kpId) => record(kpId, { type: 'skipped' })}
          onReopen={(kpId) => record(kpId, { type: 'reopened' })}
        />
      )}
      {game && screen.name === 'kp' && !kpRow && (
        <p class="note-msg">КП {screen.id} нет в этой игре.</p>
      )}
      {game && kpRow && (
        <KpCard
          key={kpRow.kp.id}
          row={kpRow}
          history={answerHistory(events, game.gameId, kpRow.kp.id, kpRow.answer, game.tz)}
          onTaken={() => record(kpRow.kp.id, { type: 'taken', answerTime: nowHhmm() })}
          onReopen={() => record(kpRow.kp.id, { type: 'reopened' })}
          onSkip={() => record(kpRow.kp.id, { type: 'skipped' })}
          onAnswer={(answer) => record(kpRow.kp.id, { type: 'answer_changed', answer })}
          onTime={(answerTime) => record(kpRow.kp.id, { type: 'answer_changed', answerTime })}
        />
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
        {game && (
          <p
            class={`muted small sync${sync && sync.state !== 'offline' && sync.state !== 'denied' ? '' : ' warn'}`}
          >
            {syncText(sync, game.tz)}
          </p>
        )}
        {!isStandalone() && (
          <p class="muted small">
            На iPhone: «Поделиться» → «На экран „Домой“» и открывать оттуда — у значка своё
            хранилище, отдельно от Safari.
          </p>
        )}
      </footer>

      {game && (
        <nav class="tabs">
          {hasKps && (
            <>
              <TabButton screen={screen} name="route" label="Маршрут" icon="🗺" tab={tab} />
              <TabButton screen={screen} name="nav" label="Штурман" icon="🧭" tab={tab} />
            </>
          )}
          <TabButton screen={screen} name="tasks" label="Задания" icon="☑︎" tab={tab} />
          <TabButton screen={screen} name="book" label="Книжка" icon="✍︎" tab={tab} />
        </nav>
      )}
    </div>
  );
}

/** Вкладки, с которых открывается карточка КП (туда — «назад»). */
type KpTab = 'route' | 'nav' | 'book';
const TAB_LABEL: Record<KpTab, string> = { route: 'Маршрут', nav: 'Штурман', book: 'Книжка' };

function TabButton(props: {
  screen: Screen;
  name: 'route' | 'nav' | 'tasks' | 'book';
  label: string;
  icon: string;
  tab: KpTab;
}) {
  // Карточка КП — часть вкладки, с которой её открыли.
  const active =
    props.screen.name === props.name || (props.screen.name === 'kp' && props.tab === props.name);
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={() => go({ name: props.name })}
    >
      <span aria-hidden="true">{props.icon}</span>
      {props.label}
    </button>
  );
}
