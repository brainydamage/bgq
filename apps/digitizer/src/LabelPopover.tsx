import { normalizeKpId } from '@bgq/core';
import { useState } from 'preact/hooks';
import type { CircleColor } from './model.ts';

interface Props {
  sx: number;
  sy: number;
  initialId: string;
  initialColor: CircleColor;
  initialArrow: boolean;
  edit: boolean;
  /** Подсказка: что это за КП (название из Notion). */
  describe(id: string): string | null;
  onSubmit(id: string, color: CircleColor, arrow: boolean): void;
  onDelete(): void;
  onCancel(): void;
}

const COLORS: { c: CircleColor; label: string; key: string }[] = [
  { c: 'red', label: 'красный', key: '1' },
  { c: 'blue', label: 'синий', key: '2' },
  { c: 'green', label: 'зелёный', key: '3' },
];

/**
 * Номер КП + цвет кружка. Enter — сохранить, Esc — отмена, ⌥1/⌥2/⌥3 — цвет,
 * ⌥4 — «стрелка»: КП за краем карты (только цвет, координаты — по адресу).
 */
export function LabelPopover(p: Props) {
  const [text, setText] = useState(p.initialId);
  const [color, setColor] = useState<CircleColor>(p.initialColor);
  const [arrow, setArrow] = useState(p.initialArrow);
  const [error, setError] = useState<string | null>(null);
  const id = normalizeKpId(text);
  const about = id ? p.describe(id) : null;

  const submit = () => {
    if (!id) {
      setError('не номер КП');
      return;
    }
    p.onSubmit(id, color, arrow);
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
        placeholder="номер КП"
        onInput={(e) => {
          setText((e.currentTarget as HTMLInputElement).value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
      />
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
