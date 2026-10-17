import type { Riddle, RiddlesFile, SheetTask } from '@bgq/core';
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

// Загадки: правка по одной, чтобы два браузера не затирали друг друга.
export async function fetchRiddles(): Promise<RiddlesFile> {
  return json<RiddlesFile>(await fetch('/api/riddles'));
}

export async function putRiddle(oldId: string, riddle: Riddle): Promise<RiddlesFile> {
  return json<RiddlesFile>(
    await fetch(`/api/riddles/${encodeURIComponent(oldId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(riddle),
    }),
  );
}

export async function deleteRiddle(id: string): Promise<RiddlesFile> {
  return json<RiddlesFile>(
    await fetch(`/api/riddles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  );
}

export interface ImportReply {
  file: RiddlesFile;
  result: {
    added: string[];
    filled: string[];
    kept: string[];
    tasksAdded: string[];
    tasksKept: string[];
    needPoints: string[];
  };
}

/** Расшифровка листков; taskPoints — баллы, вписанные вручную заданиям, у которых их не нашлось. */
export async function importRiddles(
  text: string,
  taskPoints: Record<string, number> = {},
): Promise<ImportReply> {
  return json<ImportReply>(
    await fetch('/api/riddles/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, taskPoints }),
    }),
  );
}

/** Задание без места: id — пустой для нового. */
export async function putTask(id: string, task: SheetTask): Promise<RiddlesFile> {
  return json<RiddlesFile>(
    await fetch(`/api/riddles/tasks/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task),
    }),
  );
}

export async function deleteTask(id: string): Promise<RiddlesFile> {
  return json<RiddlesFile>(
    await fetch(`/api/riddles/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  );
}

export async function uploadSheet(file: File): Promise<RiddlesFile> {
  const res = await fetch(`/api/riddles/sheets?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: file,
  });
  return json<RiddlesFile>(res);
}

export const sheetUrl = (file: string) => `/api/riddles/sheets/${encodeURIComponent(file)}`;
