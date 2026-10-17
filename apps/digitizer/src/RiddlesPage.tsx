// Страница «Загадки» (/riddles): ввод загадок с листков, заметки, отгадки координатами.
// Открывается и со второго ноутбука (./bgq map --lan); сохраняет по одной загадке.
import {
  FINISH_ID,
  type LatLon,
  type ParsedSheets,
  parseCoords,
  parseKpId,
  parseRiddleSheets,
  type Riddle,
  type RiddlesFile,
  riddlePoints,
  START_ID,
} from '@bgq/core';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  deleteRiddle,
  fetchRiddles,
  fetchState,
  importRiddles,
  putRiddle,
  sheetUrl,
  uploadSheet,
} from './api.ts';
import type { GameState } from './model.ts';

/** Запрос для ИИ: расшифровка фото листков в формат, который понимает «Вставить списком». */
const AI_PROMPT = [
  'Перепиши текст с фото дословно, без пояснений и без своих отгадок.',
  'Каждое задание — отдельным блоком: первая строка «**<номер> <название>**»',
  '(например «**96 Загадка**»), дальше текст как на листке.',
  'Задания без номера тоже перепиши, первой строкой «**<название>**».',
].join(' ');

const POLL_MS = 4000;
const SAVE_DELAY_MS = 700;

const byNumber = (a: { id: string }, b: { id: string }) =>
  a.id.localeCompare(b.id, 'ru', { numeric: true });
const fmt = (x: number) => x.toFixed(6);
const gmaps = (p: LatLon) => `https://www.google.com/maps?q=${fmt(p.lat)},${fmt(p.lon)}`;
const osm = (p: LatLon) =>
  `https://www.openstreetmap.org/?mlat=${fmt(p.lat)}&mlon=${fmt(p.lon)}#map=18/${fmt(p.lat)}/${fmt(p.lon)}`;

function distanceKm(a: LatLon, b: LatLon): string {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return (2 * 6371 * Math.asin(Math.sqrt(h))).toFixed(1).replace('.', ',');
}

/** Центр игры для проверки отгадок: старт → финиш → середина адресов geo. */
function centerOf(s: GameState): LatLon | undefined {
  const map = new Map((s.map?.results ?? []).map((r) => [r.id, r.loc]));
  const p = s.game.start.loc ?? map.get(START_ID) ?? s.game.finish.loc ?? map.get(FINISH_ID);
  if (p) return { lat: p.lat, lon: p.lon };
  const locs = s.geo.flatMap((g) => (g.loc ? [g.loc] : []));
  if (!locs.length) return undefined;
  return {
    lat: locs.reduce((t, l) => t + l.lat, 0) / locs.length,
    lon: locs.reduce((t, l) => t + l.lon, 0) / locs.length,
  };
}

export function RiddlesPage() {
  const [state, setState] = useState<GameState | null>(null);
  const [file, setFile] = useState<RiddlesFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'solved'>('all');
  const dirty = useRef(new Set<string>());

  // Обновление раз в несколько секунд: правки со второго ноутбука и точки с карты.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await fetchState();
        if (!alive) return;
        setState(s);
        setFile((cur) => mergeRemote(cur, s.riddles, dirty.current));
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const center = useMemo(() => (state ? centerOf(state) : undefined), [state]);
  const onMap = useMemo(
    () => new Map((state?.map?.results ?? []).map((r) => [r.id, r.loc])),
    [state],
  );

  if (!state || !file) return <div class="fatal">{error ?? 'Загрузка…'}</div>;

  const pointsOf = (id: string) => riddlePoints(id, state.game);
  const notionIds = new Set(state.kps.filter((k) => k.kind !== 'riddle').map((k) => k.id));
  const whereOf = (r: Riddle) =>
    r.answer
      ? { p: r.answer, how: 'координаты' }
      : onMap.get(r.id)
        ? { p: onMap.get(r.id) as LatLon, how: 'по карте' }
        : null;
  const riddles = [...file.riddles].sort(byNumber);
  const solved = riddles.filter((r) => whereOf(r));
  const shown = riddles.filter((r) =>
    filter === 'all' ? true : filter === 'solved' ? whereOf(r) : !whereOf(r),
  );

  const save = async (oldId: string, r: Riddle) => {
    try {
      setFile(await putRiddle(oldId, r));
      dirty.current.delete(oldId);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div class="riddles-page">
      <header>
        <strong>
          Загадки · {state.game.city} · {state.game.id}
        </strong>
        <span class="muted">
          решено {solved.length} из {riddles.length} · обновляется само
        </span>
        <a href="/" target="_blank" rel="noreferrer">
          разметка карты ↗
        </a>
      </header>
      {error && <div class="error">⚠ {error}</div>}

      <ImportBox
        onImported={(f) => setFile(f)}
        onError={setError}
        existing={new Set(riddles.map((r) => r.id))}
        pointsOf={pointsOf}
      />
      <AddOne onAdd={(r) => save(r.id, r)} exists={(id) => riddles.some((r) => r.id === id)} />
      <Sheets file={file} onUploaded={setFile} onError={setError} />

      <section class="panel">
        <h3>
          Загадки
          <span class="tabs">
            {(['all', 'open', 'solved'] as const).map((f) => (
              <button
                type="button"
                key={f}
                class={filter === f ? 'active' : ''}
                onClick={() => setFilter(f)}
              >
                {{ all: 'все', open: 'не решены', solved: 'решены' }[f]}
              </button>
            ))}
          </span>
        </h3>
        {!shown.length && <p class="muted">Пока пусто — вставьте расшифровку листков выше.</p>}
        {shown.map((r) => (
          <RiddleCard
            key={r.id}
            riddle={r}
            points={pointsOf(r.id)}
            center={center}
            onMap={onMap.get(r.id)}
            conflict={notionIds.has(r.id)}
            onEdit={() => dirty.current.add(r.id)}
            onSave={(next) => save(r.id, next)}
            onDelete={async () => {
              if (!confirm(`Удалить загадку ${r.id}?`)) return;
              try {
                setFile(await deleteRiddle(r.id));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        ))}
      </section>

      <section class="panel">
        <h3>Отгаданные ({solved.length})</h3>
        <table class="solved">
          <tbody>
            {solved.map((r) => {
              const w = whereOf(r);
              if (!w) return null;
              return (
                <tr key={r.id}>
                  <td>
                    <b>{r.id}</b>
                  </td>
                  <td>{r.title || 'Загадка'}</td>
                  <td>
                    <a href={gmaps(w.p)} target="_blank" rel="noreferrer">
                      {fmt(w.p.lat)}, {fmt(w.p.lon)}
                    </a>
                  </td>
                  <td class="muted">{w.how}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** Свежие данные с сервера, кроме загадок, которые сейчас правят здесь. */
function mergeRemote(
  cur: RiddlesFile | null,
  remote: RiddlesFile,
  dirty: Set<string>,
): RiddlesFile {
  if (!cur || !dirty.size) return remote;
  const local = new Map(cur.riddles.map((r) => [r.id, r]));
  const riddles = remote.riddles.map((r) => (dirty.has(r.id) ? (local.get(r.id) ?? r) : r));
  return { ...remote, riddles };
}

function ImportBox(p: {
  existing: Set<string>;
  pointsOf: (id: string) => number;
  onImported: (f: RiddlesFile) => void;
  onError: (e: string) => void;
}) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ParsedSheets | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <section class="panel">
      <h3>Вставить списком (расшифровка листков от ИИ)</h3>
      <p class="muted">
        Сфотографируйте листки, отправьте фото в ChatGPT или Claude с запросом ниже и вставьте ответ
        целиком.
      </p>
      <div class="prompt">
        <code>{AI_PROMPT}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(AI_PROMPT).then(() => setCopied(true));
          }}
        >
          {copied ? 'скопировано ✓' : 'скопировать запрос'}
        </button>
      </div>
      <textarea
        rows={6}
        placeholder={'**96 Загадка**\nМежду ними ровно пять…'}
        value={text}
        onInput={(e) => {
          setText((e.currentTarget as HTMLTextAreaElement).value);
          setPreview(null);
          setReport(null);
        }}
      />
      <div class="row">
        <button
          type="button"
          disabled={!text.trim()}
          onClick={() => setPreview(parseRiddleSheets(text))}
        >
          Разобрать
        </button>
        {preview && preview.riddles.length > 0 && (
          <button
            type="button"
            class="primary"
            onClick={async () => {
              try {
                const r = await importRiddles(text);
                p.onImported(r.file);
                setReport(
                  `добавлено ${r.result.added.length}` +
                    (r.result.filled.length ? `, дополнено ${r.result.filled.length}` : '') +
                    (r.result.kept.length
                      ? `, уже были (не трогал): ${r.result.kept.join(', ')}`
                      : ''),
                );
                setText('');
                setPreview(null);
              } catch (e) {
                p.onError((e as Error).message);
              }
            }}
          >
            Сохранить {preview.riddles.length}
          </button>
        )}
        {report && <span class="good">✓ {report}</span>}
      </div>
      {preview && (
        <div class="preview">
          {!preview.riddles.length && <p class="bad">Не нашёл ни одного «**номер название**».</p>}
          <ul>
            {preview.riddles.map((r) => (
              <li key={r.id}>
                <b>{r.id}</b> · {p.pointsOf(r.id)} б · {r.title || '—'}{' '}
                <span class="muted">{r.text.slice(0, 90)}…</span>
                {p.existing.has(r.id) && <span class="warn"> уже есть</span>}
              </li>
            ))}
          </ul>
          {preview.skipped.length > 0 && (
            <p class="muted">Без номера — не места, пропущены: {preview.skipped.join(', ')}</p>
          )}
        </div>
      )}
    </section>
  );
}

function AddOne(p: { onAdd: (r: Riddle) => void; exists: (id: string) => boolean }) {
  const [num, setNum] = useState('');
  const [title, setTitle] = useState('');
  const id = parseKpId(num)?.id;
  return (
    <section class="panel row">
      <b>+ одна загадка</b>
      <input
        placeholder="96, или 5А — задание на 5 б"
        value={num}
        size={8}
        onInput={(e) => setNum(e.currentTarget.value)}
      />
      <input
        placeholder="название, «зелёный листок»"
        value={title}
        onInput={(e) => setTitle(e.currentTarget.value)}
      />
      <button
        type="button"
        disabled={!id || p.exists(id)}
        onClick={() => {
          if (!id) return;
          p.onAdd({ id, title, text: '', notes: '', updatedAt: new Date().toISOString() });
          setNum('');
          setTitle('');
        }}
      >
        Добавить
      </button>
      {num && !id && <span class="bad">номер вида 96, 72А или 5А (однозначный номер — баллы)</span>}
      {id && p.exists(id) && <span class="warn">{id} уже есть</span>}
    </section>
  );
}

function Sheets(p: {
  file: RiddlesFile;
  onUploaded: (f: RiddlesFile) => void;
  onError: (e: string) => void;
}) {
  return (
    <section class="panel">
      <h3>Фото листков ({p.file.sheets.length})</h3>
      <input
        type="file"
        accept="image/*,.heic"
        multiple
        onChange={async (e) => {
          const files = [...(e.currentTarget.files ?? [])];
          try {
            for (const f of files) p.onUploaded(await uploadSheet(f));
          } catch (err) {
            p.onError((err as Error).message);
          }
        }}
      />
      <div class="sheets">
        {p.file.sheets.map((s) => (
          <a key={s} href={sheetUrl(s)} target="_blank" rel="noreferrer">
            <img src={sheetUrl(s)} alt={s} />
          </a>
        ))}
      </div>
    </section>
  );
}

function RiddleCard(p: {
  riddle: Riddle;
  points: number;
  center: LatLon | undefined;
  onMap: LatLon | undefined;
  conflict: boolean;
  onEdit: () => void;
  onSave: (r: Riddle) => void;
  onDelete: () => void;
}) {
  const r = p.riddle;
  const [draft, setDraft] = useState(r);
  const [answer, setAnswer] = useState(r.answer?.raw ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Пришло с сервера (второй ноутбук) — показываем, если тут ничего не правят.
  useEffect(() => {
    if (!timer.current) {
      setDraft(r);
      setAnswer(r.answer?.raw ?? '');
    }
  }, [r.updatedAt]);

  const edit = (next: Riddle) => {
    setDraft(next);
    p.onEdit();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      p.onSave(next);
    }, SAVE_DELAY_MS);
  };

  const parsed = answer.trim() ? parseCoords(answer, p.center) : null;
  const saved = draft.answer;
  const changed = (saved?.raw ?? '') !== answer.trim();

  return (
    <article class={`riddle ${saved || p.onMap ? 'solved' : ''}`}>
      <div class="head">
        <b class="num">{r.id}</b>
        <span>{p.points} б</span>
        <input
          class="title"
          value={draft.title}
          placeholder="название"
          onInput={(e) => edit({ ...draft, title: e.currentTarget.value })}
        />
        {saved ? (
          <span class="good">✓ отгадана</span>
        ) : p.onMap ? (
          <span class="good">✓ точка на карте</span>
        ) : (
          <span class="muted">не решена</span>
        )}
        <button type="button" class="danger" onClick={p.onDelete}>
          удалить
        </button>
      </div>
      {p.conflict && (
        <p class="bad">Номер {r.id} уже есть среди КП Notion — проверьте номер загадки.</p>
      )}
      <label>
        Текст
        <textarea
          rows={Math.min(8, Math.max(2, draft.text.split('\n').length + 1))}
          value={draft.text}
          onInput={(e) => edit({ ...draft, text: e.currentTarget.value })}
        />
      </label>
      <label>
        Заметки
        <textarea
          rows={2}
          value={draft.notes}
          placeholder="до чего дошли…"
          onInput={(e) => edit({ ...draft, notes: e.currentTarget.value })}
        />
      </label>
      <div class="answer">
        <label>
          Отгадка — координаты или ссылка Google Maps / OpenStreetMap
          <input
            value={answer}
            placeholder="44.9714, 19.6101"
            onInput={(e) => setAnswer(e.currentTarget.value)}
          />
        </label>
        {parsed && !parsed.ok && <span class="bad">✗ {parsed.error}</span>}
        {parsed?.ok && (
          <span class="good">
            ✓ {fmt(parsed.lat)}, {fmt(parsed.lon)}
            {p.center && ` · ${distanceKm(parsed, p.center)} км от старта`}{' '}
            <a href={gmaps(parsed)} target="_blank" rel="noreferrer">
              проверить в Google Maps
            </a>{' '}
            ·{' '}
            <a href={osm(parsed)} target="_blank" rel="noreferrer">
              OSM
            </a>
            {parsed.note && <span class="warn"> · {parsed.note}</span>}
          </span>
        )}
        <div class="row">
          <button
            type="button"
            class="primary"
            disabled={!parsed?.ok || !changed}
            onClick={() => {
              if (!parsed?.ok) return;
              const next = {
                ...draft,
                answer: { lat: parsed.lat, lon: parsed.lon, raw: answer.trim() },
              };
              setDraft(next);
              p.onSave(next);
            }}
          >
            Сохранить отгадку
          </button>
          {saved && (
            <button
              type="button"
              onClick={() => {
                const { answer: _a, ...rest } = draft;
                setDraft(rest);
                setAnswer('');
                p.onSave(rest);
              }}
            >
              убрать отгадку
            </button>
          )}
          {p.onMap && !saved && (
            <span class="muted">
              точка на карте:{' '}
              <a href={gmaps(p.onMap)} target="_blank" rel="noreferrer">
                {fmt(p.onMap.lat)}, {fmt(p.onMap.lon)}
              </a>
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
