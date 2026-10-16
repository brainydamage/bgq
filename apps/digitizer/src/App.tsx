import { FINISH_ID, START_ID } from '@bgq/core';
import type { GeoResult } from '@bgq/geo';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchState, photoUrl, saveMap, uploadPhoto } from './api.ts';
import { CONTROL_METHODS, computeMap } from './compute.ts';
import { formatWindow, LabelPopover, type LabelValue } from './LabelPopover.tsx';
import type { CircleColor, GameState, MapFile, Mark, PhotoLabels } from './model.ts';
import { type Hint, PhotoView } from './PhotoView.tsx';
import { FitPanel, KpList } from './Sidebar.tsx';

interface Popover {
  edit: boolean;
  x: number;
  y: number;
  sx: number;
  sy: number;
  value: LabelValue;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Фото из папки + разметка из map.json (новые фото — с пустой разметкой). */
function mergePhotos(state: GameState, current: PhotoLabels[]): PhotoLabels[] {
  const known = new Map([...(state.map?.photos ?? []), ...current].map((p) => [p.file, p]));
  return state.photos.map((file) => known.get(file) ?? { file, marks: [], disabled: [] });
}

export function App() {
  const [data, setData] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<PhotoLabels[]>([]);
  const [active, setActive] = useState(0);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [lastColor, setLastColor] = useState<CircleColor>('red');
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [todoOnly, setTodoOnly] = useState(false);
  const [save, setSave] = useState<{ state: SaveState; at?: string; error?: string }>({
    state: 'idle',
  });
  const [dropping, setDropping] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    fetchState()
      .then((s) => {
        setData(s);
        setPhotos(mergePhotos(s, []));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const geo = useMemo(
    () => new Map<string, GeoResult>((data?.geo ?? []).map((g) => [g.id, g])),
    [data],
  );
  const computed = useMemo(() => computeMap(photos, data?.geo ?? []), [photos, data]);
  const results = useMemo(() => new Map(computed.results.map((r) => [r.id, r])), [computed]);

  // Автосохранение: любое изменение разметки → map.json (целиком, с задержкой 400 мс).
  useEffect(() => {
    if (!data) return;
    if (!loaded.current) {
      loaded.current = true;
      return;
    }
    setSave({ state: 'saving' });
    const t = setTimeout(() => {
      const map: MapFile = {
        v: 1,
        gameId: data.game.id,
        updatedAt: new Date().toISOString(),
        photos,
        fits: computed.summaries,
        results: computed.results,
      };
      saveMap(map)
        .then(() => setSave({ state: 'saved', at: new Date().toLocaleTimeString('ru-RU') }))
        .catch((e: Error) => setSave({ state: 'error', error: e.message }));
    }, 400);
    return () => clearTimeout(t);
  }, [photos]);

  // Esc закрывает окно отметки, даже если фокус ушёл из поля ввода.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopover(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Перетаскивание фото в окно → загрузка в games/<дата>/photos/.
  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDropping(true);
    };
    const leave = () => setDropping(false);
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      setDropping(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      try {
        for (const f of files) await uploadPhoto(f);
        const s = await fetchState();
        setData((d) => (d ? { ...d, photos: s.photos } : s));
        setPhotos((cur) => mergePhotos(s, cur));
      } catch (err) {
        setError((err as Error).message);
      }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  if (error) return <div class="fatal">Ошибка: {error}</div>;
  if (!data) return <div class="fatal">Загрузка…</div>;

  const labels = photos[active];
  const fit = computed.fits[active];
  const updateActive = (f: (p: PhotoLabels) => PhotoLabels) =>
    setPhotos((all) => all.map((p, i) => (i === active ? f(p) : p)));

  const hints: Hint[] = [];
  if (labels && fit?.fit.ok) {
    const marked = new Set(labels.marks.map((m) => m.id));
    for (const g of data.geo) {
      if (!g.loc || marked.has(g.id) || !g.method || !CONTROL_METHODS.has(g.method)) continue;
      const px = fit.fit.toPixel([g.loc.lat, g.loc.lon]);
      if (px) hints.push({ id: g.id, x: px[0], y: px[1] });
    }
  }

  const describe = (id: string) => {
    if (id === START_ID) return 'старт игры';
    if (id === FINISH_ID) return 'финиш игры';
    const kp = data.kps.find((k) => k.id === id);
    if (!kp) return null;
    const g = geo.get(id);
    const where = g?.method && CONTROL_METHODS.has(g.method) ? ' · ⌂ адрес' : '';
    const window = kp.window ? ` · окно ${formatWindow(kp.window)} (overrides)` : '';
    return `${kp.title}${kp.eligible ? '' : ' · только вело'}${where}${window}`;
  };

  const submit = ({ id, color, arrow, window }: LabelValue) => {
    if (!popover) return;
    const special = id === START_ID || id === FINISH_ID;
    if (!special) setLastColor(color);
    updateActive((p) => {
      // Тот же номер уже есть на фото — переносим отметку (исправление), а не дублируем.
      const others = p.marks.filter(
        (m) => m.id !== id && !(popover.edit && m.id === popover.value.id),
      );
      const mark: Mark = {
        id,
        x: popover.x,
        y: popover.y,
        color: special ? null : color,
        ...(arrow && { arrow }),
        ...(window && { window }),
      };
      return { ...p, marks: [...others, mark] };
    });
    setPopover(null);
  };

  return (
    <div class="app">
      <header>
        <strong>
          {data.game.city} · {data.game.id}
        </strong>
        <nav>
          {photos.map((p, i) => (
            <button
              type="button"
              key={p.file}
              class={i === active ? 'active' : ''}
              onClick={() => {
                setActive(i);
                setPopover(null);
              }}
            >
              {p.file} ({p.marks.length})
            </button>
          ))}
        </nav>
        <span class={`save ${save.state}`}>
          {save.state === 'saving' && 'сохраняю…'}
          {save.state === 'saved' && `сохранено ${save.at}`}
          {save.state === 'error' && `ошибка сохранения: ${save.error}`}
        </span>
      </header>
      <main>
        {labels ? (
          <div class="stage">
            <PhotoView
              src={photoUrl(labels.file)}
              marks={labels.marks}
              status={fit?.status ?? new Map()}
              hints={hints}
              selectedId={popover?.edit ? popover.value.id : null}
              focus={focus}
              onAdd={(x, y, sx, sy, suggested) =>
                setPopover({
                  edit: false,
                  x,
                  y,
                  sx,
                  sy,
                  value: { id: suggested ?? '', color: lastColor, arrow: false, window: null },
                })
              }
              onSelect={(id, sx, sy) => {
                const m = labels.marks.find((x) => x.id === id);
                if (m)
                  setPopover({
                    edit: true,
                    x: m.x,
                    y: m.y,
                    sx,
                    sy,
                    value: {
                      id,
                      color: m.color ?? lastColor,
                      arrow: !!m.arrow,
                      window: m.window ?? null,
                    },
                  });
              }}
              onMove={(id, x, y) =>
                updateActive((p) => ({
                  ...p,
                  marks: p.marks.map((m) => (m.id === id ? { ...m, x, y } : m)),
                }))
              }
            />
            {popover && (
              <LabelPopover
                key={`${popover.x}:${popover.y}`}
                sx={popover.sx}
                sy={popover.sy}
                initial={popover.value}
                edit={popover.edit}
                describe={describe}
                onSubmit={submit}
                onDelete={() => {
                  updateActive((p) => ({
                    ...p,
                    marks: p.marks.filter((m) => m.id !== popover.value.id),
                  }));
                  setPopover(null);
                }}
                onCancel={() => setPopover(null)}
              />
            )}
          </div>
        ) : (
          <div class="empty">Перетащите сюда фото карты (общее и/или четверти).</div>
        )}
        <aside>
          <FitPanel
            fit={fit}
            labels={labels}
            onToggleControl={(id) =>
              updateActive((p) => ({
                ...p,
                disabled: p.disabled.includes(id)
                  ? p.disabled.filter((x) => x !== id)
                  : [...p.disabled, id],
              }))
            }
          />
          <KpList
            kps={data.kps}
            geo={geo}
            photos={photos}
            results={results}
            activeFile={labels?.file}
            todoOnly={todoOnly}
            onTodoOnly={setTodoOnly}
            onPick={(id) => {
              const here = labels?.marks.some((m) => m.id === id);
              const idx = here ? active : photos.findIndex((p) => p.marks.some((m) => m.id === id));
              if (idx < 0) return;
              setActive(idx);
              setFocus({ id, nonce: Date.now() });
            }}
          />
        </aside>
      </main>
      {dropping && <div class="dropzone">Отпустите — фото загрузятся в {data.gameDir}/photos</div>}
    </div>
  );
}
