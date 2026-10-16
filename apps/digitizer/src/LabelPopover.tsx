import { FINISH_ID, parseKpId, START_ID, type TimeWindow } from '@bgq/core';
import { useState } from 'preact/hooks';
import type { CircleColor } from './model.ts';

export interface LabelValue {
  id: string;
  color: CircleColor;
  arrow: boolean;
  window: TimeWindow | null;
}

interface Props {
  sx: number;
  sy: number;
  initial: LabelValue;
  edit: boolean;
  /** Подсказка: что это за КП (название из Notion). */
  describe(id: string): string | null;
  onSubmit(value: LabelValue): void;
  onDelete(): void;
  onCancel(): void;
}

const COLORS: { c: CircleColor; label: string; key: string }[] = [
  { c: 'red', label: 'красный', key: '1' },
  { c: 'blue', label: 'синий', key: '2' },
  { c: 'green', label: 'зелёный', key: '3' },
];

/** Номер КП, «старт»/«финиш» (или с/ф). */
export function parseLabelId(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (['старт', 'start', 'с', 's'].includes(t)) return START_ID;
  if (['финиш', 'finish', 'ф', 'f'].includes(t)) return FINISH_ID;
  return parseKpId(text)?.id ?? null;
}

const pad = (h: string, m?: string) => `${h.padStart(2, '0')}:${m ?? '00'}`;

/** «14-18», «14–18», «14:30-18», «с 14 до 18» → { from, to }; пусто → null; иначе undefined (ошибка). */
export function parseWindow(text: string): TimeWindow | null | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const m = /^(?:с\s*)?(\d{1,2})(?::(\d{2}))?\s*(?:[-–—]|до)\s*(\d{1,2})(?::(\d{2}))?$/u.exec(t);
  if (!m?.[1] || !m[3]) return undefined;
  const from = pad(m[1], m[2]);
  const to = pad(m[3], m[4]);
  const ok = (x: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
  return ok(from) && ok(to) && from < to ? { from, to } : undefined;
}

export function formatWindow(w: TimeWindow): string {
  const short = (x: string) => (x.endsWith(':00') ? String(Number(x.slice(0, 2))) : x);
  return `${short(w.from)}–${short(w.to)}`;
}

/**
 * Номер КП + цвет кружка (+ окно работы, если подписано на карте). Enter — сохранить,
 * Esc — отмена, ⌥1/⌥2/⌥3 — цвет, ⌥4 — «стрелка» (КП за краем карты). «с»/«ф» — старт/финиш.
 */
export function LabelPopover(p: Props) {
  const [text, setText] = useState(p.initial.id);
  const [color, setColor] = useState<CircleColor>(p.initial.color);
  const [arrow, setArrow] = useState(p.initial.arrow);
  const [windowText, setWindowText] = useState(
    p.initial.window ? formatWindow(p.initial.window) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const id = parseLabelId(text);
  const special = id === START_ID || id === FINISH_ID;
  const about = id ? p.describe(id) : null;

  const submit = () => {
    if (!id) {
      setError('не номер КП (или «старт»/«финиш»)');
      return;
    }
    const window = special ? null : parseWindow(windowText);
    if (window === undefined) {
      setError('окно — в виде 14-18 или 14:30-18:00');
      return;
    }
    p.onSubmit({ id, color, arrow: !special && arrow, window });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      p.onCancel();
    } else if (e.altKey && e.code === 'Digit4') {
      e.preventDefault();
      setArrow((a) => !a);
    } else if (e.altKey) {
      const c = COLORS.find((x) => e.code === `Digit${x.key}`);
      if (c) {
        e.preventDefault();
        setColor(c.c);
      }
    }
  };

  return (
    <div
      class="popover"
      style={{ left: `${p.sx + 14}px`, top: `${p.sy + 14}px` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: поле открывается по клику ради ввода номера
        autoFocus
        value={text}
        placeholder="номер КП, «с» — старт, «ф» — финиш"
        onInput={(e) => {
          setText((e.currentTarget as HTMLInputElement).value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
      />
      <div class="specials">
        <button type="button" onClick={() => setText('старт')}>
          Старт
        </button>
        <button type="button" onClick={() => setText('финиш')}>
          Финиш
        </button>
      </div>
      {!special && (
        <>
          <div class="colors">
            {COLORS.map((x) => (
              <button
                type="button"
                key={x.c}
                class={`color ${x.c}${color === x.c ? ' active' : ''}`}
                title={`${x.label} (⌥${x.key})`}
                onClick={() => setColor(x.c)}
              />
            ))}
          </div>
          <label class="arrow" title="⌥4">
            <input
              type="checkbox"
              checked={arrow}
              onChange={(e) => setArrow((e.currentTarget as HTMLInputElement).checked)}
            />{' '}
            стрелка — КП за краем карты (координаты по адресу)
          </label>
          <label class="window">
            окно работы:{' '}
            <input
              value={windowText}
              placeholder="напр. 14-18"
              onInput={(e) => {
                setWindowText((e.currentTarget as HTMLInputElement).value);
                setError(null);
              }}
              onKeyDown={onKeyDown}
            />
          </label>
        </>
      )}
      <div class="about">
        {error ?? (text && !id ? 'не номер КП' : (about ?? (id ? 'нет в Notion' : '')))}
      </div>
      <div class="actions">
        <button type="button" onClick={submit}>
          OK ⏎
        </button>
        {p.edit && (
          <button type="button" class="danger" onClick={p.onDelete}>
            Удалить
          </button>
        )}
        <button type="button" onClick={p.onCancel}>
          Esc
        </button>
      </div>
    </div>
  );
}
