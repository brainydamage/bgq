import { useEffect, useRef, useState } from 'preact/hooks';
import type { MarkStatus } from './compute.ts';
import type { Mark } from './model.ts';

export interface Hint {
  id: string;
  x: number;
  y: number;
}

interface Props {
  src: string;
  marks: Mark[];
  status: Map<string, MarkStatus>;
  /** Где по адресу «должен быть» ещё не отмеченный КП (после привязки). */
  hints: Hint[];
  selectedId: string | null;
  focus: { id: string; nonce: number } | null;
  /**
   * Клик по пустому месту: координаты на фото и на экране (внутри области просмотра);
   * suggestedId — подсказка geo рядом с кликом (≤ 40 px на экране).
   */
  onAdd(x: number, y: number, sx: number, sy: number, suggestedId: string | null): void;
  onSelect(id: string, sx: number, sy: number): void;
  onMove(id: string, x: number, y: number): void;
}

interface View {
  s: number;
  tx: number;
  ty: number;
}

const CLICK_PX = 4;

/** Обводка — цвет кружка на карте (категория); статус привязки — значком у номера. */
const FILL: Record<string, string> = { red: '#ef4444', blue: '#2563eb', green: '#16a34a' };
const NO_COLOR = '#f59e0b';
const BADGE: Record<MarkStatus, string> = {
  inlier: ' ⌂',
  outlier: ' ✗',
  disabled: ' ⌂ выкл',
  arrow: ' ↗ стрелка',
  plain: '',
};

/** Самое крупное: 1 пиксель фото = 4 пикселя экрана. */
const MAX_SCALE = 4;

/** Safari присылает щипок тачпада как GestureEvent (нет в типах DOM). */
type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

/**
 * Фото карты, навигация как в картах: два пальца на тачпаде / колесо — сдвиг,
 * щипок или ⌘/Ctrl + колесо — масштаб, перетаскивание — сдвиг, клик — отметка,
 * ⌥ + перетаскивание отметки — передвинуть её. Кнопки и клавиши: + − 0, стрелки.
 */
export function PhotoView(p: Props) {
  const box = useRef<HTMLDivElement>(null);
  // Размер привязан к файлу: при смене фото старый размер не используется, а сброс
  // через эффект не нужен (он гонялся с onLoad картинки из кэша).
  const [loaded, setLoaded] = useState<{ src: string; w: number; h: number } | null>(null);
  const size = loaded?.src === p.src ? loaded : null;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [view, setViewState] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  /**
   * Вид обновляем и в ref сразу: тачпад шлёт события чаще перерисовки, и каждое
   * следующее должно считаться от предыдущего, а не от последнего отрисованного.
   */
  const setView = (v: View) => {
    viewRef.current = v;
    setViewState(v);
  };
  /** Масштаб «фото целиком»; меньше половины его отдалять незачем. */
  const fitScale = useRef(1);
  /** Вписать фото, как только у области просмотра появится размер. */
  const needsFit = useRef(true);
  const drag = useRef<{
    x0: number;
    y0: number;
    view: View;
    markId: string | null;
    /** С ⌥ — двигаем отметку; без — всегда сдвиг карты. */
    moveMark: boolean;
    moved: boolean;
  } | null>(null);
  const [dragMark, setDragMark] = useState<{ id: string; x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);

  const fit = () => {
    const r = box.current?.getBoundingClientRect();
    const sz = sizeRef.current;
    // Пока область просмотра без размера (скрыта, ещё не разложена) — ждём ResizeObserver.
    if (!r || !sz || r.width <= 0 || r.height <= 0) return;
    const s = Math.min(r.width / sz.w, r.height / sz.h);
    fitScale.current = s;
    needsFit.current = false;
    setView({ s, tx: (r.width - sz.w * s) / 2, ty: (r.height - sz.h * s) / 2 });
  };

  /** Масштаб вокруг точки экрана (cx, cy) — она остаётся на месте. */
  const zoomAt = (cx: number, cy: number, factor: number) => {
    const v = viewRef.current;
    const s = Math.min(MAX_SCALE, Math.max(fitScale.current * 0.5, v.s * factor));
    const f = s / v.s;
    setView({ s, tx: cx - (cx - v.tx) * f, ty: cy - (cy - v.ty) * f });
  };
  const zoomCenter = (factor: number) => {
    const r = box.current?.getBoundingClientRect();
    if (r) zoomAt(r.width / 2, r.height / 2, factor);
  };
  const panBy = (dx: number, dy: number) => {
    const v = viewRef.current;
    setView({ ...v, tx: v.tx + dx, ty: v.ty + dy });
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (needsFit.current) fit();
    });
    ro.observe(el);

    // Колесо/тачпад — с preventDefault, поэтому слушатель не passive.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        // Щипок на тачпаде (Chrome) приходит как колесо с ctrlKey; ⌘/Ctrl + колесо мыши — так же.
        // Шаг ограничен: одно деление колеса мыши (deltaY ~100) — не больше ×1,65.
        const d = Math.max(-50, Math.min(50, e.deltaY));
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-d * 0.01));
      } else {
        const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
        panBy(-e.deltaX * k, -e.deltaY * k);
      }
    };
    // Щипок в Safari.
    let gestureBase = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureBase = viewRef.current.s;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      const r = el.getBoundingClientRect();
      zoomAt(g.clientX - r.left, g.clientY - r.top, (gestureBase * g.scale) / viewRef.current.s);
    };

    // Клавиши — только когда не печатаем номер КП.
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const step = 120;
      const actions: Record<string, () => void> = {
        '+': () => zoomCenter(1.5),
        '=': () => zoomCenter(1.5),
        '-': () => zoomCenter(1 / 1.5),
        '0': fit,
        ArrowLeft: () => panBy(step, 0),
        ArrowRight: () => panBy(-step, 0),
        ArrowUp: () => panBy(0, step),
        ArrowDown: () => panBy(0, -step),
      };
      const action = actions[e.key];
      if (action) {
        e.preventDefault();
        action();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    window.addEventListener('keydown', onKey);
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Показать отметку из списка КП.
  useEffect(() => {
    const m = p.focus && p.marks.find((x) => x.id === p.focus?.id);
    const r = box.current?.getBoundingClientRect();
    if (!m || !r) return;
    // Приблизить, чтобы отметку было видно, но не отдалять, если уже крупно.
    const s = Math.min(MAX_SCALE, Math.max(viewRef.current.s, fitScale.current * 3));
    setView({ s, tx: r.width / 2 - m.x * s, ty: r.height / 2 - m.y * s });
  }, [p.focus]);

  const toImage = (clientX: number, clientY: number) => {
    const r = box.current?.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - (r?.left ?? 0) - v.tx) / v.s,
      y: (clientY - (r?.top ?? 0) - v.ty) / v.s,
      sx: clientX - (r?.left ?? 0),
      sy: clientY - (r?.top ?? 0),
    };
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = (e.target as Element).closest('[data-id]');
    const markId = target?.getAttribute('data-id') ?? null;
    drag.current = {
      x0: e.clientX,
      y0: e.clientY,
      view: viewRef.current,
      markId,
      moveMark: !!markId && e.altKey,
      moved: false,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < CLICK_PX) return;
    d.moved = true;
    if (d.moveMark && d.markId) {
      const { x, y } = toImage(e.clientX, e.clientY);
      setDragMark({ id: d.markId, x, y });
    } else {
      setPanning(true);
      setView({ ...d.view, tx: d.view.tx + dx, ty: d.view.ty + dy });
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    if (!d) return;
    const at = toImage(e.clientX, e.clientY);
    if (d.moveMark && d.markId && d.moved) {
      p.onMove(d.markId, at.x, at.y);
      setDragMark(null);
    } else if (d.moved) {
      // Сдвиг карты — ничего не отмечаем.
    } else if (d.markId) {
      p.onSelect(d.markId, at.sx, at.sy);
    } else {
      const near = p.hints
        .map((h) => ({ id: h.id, d: Math.hypot(h.x - at.x, h.y - at.y) * viewRef.current.s }))
        .filter((h) => h.d <= 40)
        .sort((a, b) => a.d - b.d)[0];
      p.onAdd(at.x, at.y, at.sx, at.sy, near?.id ?? null);
    }
  };

  const k = 1 / view.s;
  // Радиус отметки — 11 px на экране при любом масштабе.
  const r = 11 * k;
  return (
    <div
      class={`viewport${panning ? ' panning' : ''}`}
      ref={box}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        class="canvas"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}
      >
        <img
          src={p.src}
          alt="карта"
          draggable={false}
          onLoad={(e) => {
            // Вписать фото в окно при загрузке или смене.
            const img = e.currentTarget as HTMLImageElement;
            const sz = { src: p.src, w: img.naturalWidth, h: img.naturalHeight };
            setLoaded(sz);
            sizeRef.current = sz;
            needsFit.current = true;
            fit();
          }}
        />
        {size && (
          <svg width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}>
            <title>Отметки КП на карте</title>
            {p.hints.map((h) => (
              <g key={`hint-${h.id}`} class="hint">
                <circle
                  cx={h.x}
                  cy={h.y}
                  r={r}
                  stroke-width={2 * k}
                  stroke-dasharray={`${4 * k}`}
                />
                <text x={h.x + r * 1.2} y={h.y - r} font-size={13 * k} stroke-width={3 * k}>
                  {h.id}?
                </text>
              </g>
            ))}
            {p.marks.map((m) => {
              const pos = dragMark?.id === m.id ? dragMark : m;
              const st = p.status.get(m.id) ?? 'plain';
              const selected = p.selectedId === m.id;
              return (
                <g key={m.id} data-id={m.id} class={`mark ${st}${selected ? ' selected' : ''}`}>
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={r * (selected ? 1.4 : 1)}
                    fill={m.color ? FILL[m.color] : NO_COLOR}
                    fill-opacity={0.25}
                    stroke={st === 'disabled' ? '#9ca3af' : m.color ? FILL[m.color] : NO_COLOR}
                    stroke-width={(st === 'inlier' ? 4 : 2.5) * k}
                    stroke-dasharray={st === 'arrow' ? `${4 * k}` : undefined}
                  />
                  {st === 'outlier' && (
                    <path
                      d={`M${pos.x - r} ${pos.y - r}L${pos.x + r} ${pos.y + r}M${pos.x + r} ${pos.y - r}L${pos.x - r} ${pos.y + r}`}
                      stroke="#dc2626"
                      stroke-width={3 * k}
                    />
                  )}
                  <text
                    x={pos.x + r * 1.2}
                    y={pos.y - r * 0.6}
                    font-size={15 * k}
                    stroke-width={3.5 * k}
                    class={st}
                  >
                    {m.id}
                    {BADGE[st]}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <div class="zoom" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" title="крупнее (+)" onClick={() => zoomCenter(1.5)}>
          +
        </button>
        <button type="button" title="мельче (−)" onClick={() => zoomCenter(1 / 1.5)}>
          −
        </button>
        <button type="button" title="фото целиком (0)" onClick={fit}>
          ⤢
        </button>
      </div>
      <div class="help">
        два пальца / колесо — сдвиг · щипок или ⌘ + колесо — масштаб · перетаскивание — сдвиг · клик
        — отметка · ⌥ + перетащить отметку — передвинуть
      </div>
    </div>
  );
}
