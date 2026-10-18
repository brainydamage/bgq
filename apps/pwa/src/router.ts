// Экраны по location.hash: #route, #nav, #tasks, #book, #kp/<id>. Без библиотеки.
import { useEffect, useState } from 'preact/hooks';

export type Screen =
  | { name: 'route' }
  | { name: 'nav' }
  | { name: 'tasks' }
  | { name: 'book' }
  | { name: 'kp'; id: string };

/** Хэш → экран; пустой или неизвестный — null (экран по умолчанию выбирает App). */
export function parseHash(hash: string): Screen | null {
  const h = hash.replace(/^#\/?/, '');
  if (h === 'route' || h === 'nav' || h === 'tasks' || h === 'book') return { name: h };
  const kp = /^kp\/(.+)$/.exec(h);
  if (kp?.[1]) return { name: 'kp', id: decodeURIComponent(kp[1]) };
  return null;
}

export function screenHash(s: Screen): string {
  return s.name === 'kp' ? `#kp/${encodeURIComponent(s.id)}` : `#${s.name}`;
}

export function useScreen(): Screen | null {
  const [screen, setScreen] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setScreen(parseHash(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return screen;
}

export function go(s: Screen) {
  location.hash = screenHash(s);
}
