import type { GameState, MapFile } from './model.ts';

async function json<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function fetchState(): Promise<GameState> {
  return json<GameState>(await fetch('/api/state'));
}

export async function uploadPhoto(file: File): Promise<string> {
  const res = await fetch(`/api/photos?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: file,
  });
  return (await json<{ file: string }>(res)).file;
}

export async function saveMap(map: MapFile): Promise<void> {
  await json(
    await fetch('/api/map', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(map),
    }),
  );
}

export const photoUrl = (file: string) => `/api/photos/${encodeURIComponent(file)}`;
