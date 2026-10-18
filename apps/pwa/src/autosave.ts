// Текст, сохраняемый при вводе (заметка задания, ответ КП): событие — через 0,7 с тишины, сразу —
// при уходе в фон, потере фокуса и когда поле исчезает (фильтр, другой экран).
import { useEffect, useRef, useState } from 'preact/hooks';

export const AUTOSAVE_MS = 700;

export function useAutosave(
  value: string,
  save: (text: string) => void,
): { draft: string; onInput: (text: string) => void; flush: () => void } {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useRef(value);
  const latest = useRef({ draft, save });
  latest.current = { draft, save };

  // Текст обновили извне (повторный импорт, позже — второй телефон) и мы его не правим — показать.
  useEffect(() => {
    if (!timer.current) setDraft(value);
    saved.current = value;
  }, [value]);

  function flush() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const text = latest.current.draft;
    if (text !== saved.current) {
      saved.current = text;
      latest.current.save(text);
    }
  }

  function onInput(text: string) {
    setDraft(text);
    latest.current.draft = text;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  }

  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, []);

  return { draft, onInput, flush };
}
