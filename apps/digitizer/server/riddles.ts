// riddles.json игры: правки по одной загадке, чтобы два браузера (Ира и разметка карты)
// не затирали друг друга. Node однопоточный — чтение-изменение-запись не перемешиваются.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeKpId,
  type ParsedRiddle,
  Riddle,
  type RiddlesFile,
  RiddlesFile as RiddlesSchema,
  schemaErrors,
} from '@bgq/core';

export class RiddleError extends Error {}

export interface ImportResult {
  added: string[];
  /** Были без текста — текст и название подставлены. */
  filled: string[];
  /** Уже были с текстом — не трогали (заметки и отгадки целы). */
  kept: string[];
}

export function createRiddleStore(gameDir: string, gameId: string) {
  const path = join(gameDir, 'riddles.json');

  function read(): RiddlesFile {
    if (!existsSync(path)) return { v: 1, gameId, sheets: [], riddles: [] };
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const errors = schemaErrors(RiddlesSchema, data);
    if (errors.length) throw new RiddleError(`riddles.json: ${errors.join('; ')}`);
    return data as RiddlesFile;
  }

  function write(file: RiddlesFile): RiddlesFile {
    const byNumber = (a: Riddle, b: Riddle) => a.id.localeCompare(b.id, 'ru', { numeric: true });
    const sorted = { ...file, riddles: [...file.riddles].sort(byNumber) };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
    renameSync(tmp, path);
    return sorted;
  }

  const now = () => new Date().toISOString();

  /** Добавить или заменить одну загадку целиком (последняя запись побеждает). */
  function upsert(input: unknown, oldId?: string): RiddlesFile {
    const r = input as Riddle;
    const id = typeof r?.id === 'string' ? normalizeKpId(r.id) : null;
    if (!id || !/^\d/.test(id)) throw new RiddleError(`номер загадки: «${String(r?.id)}»`);
    const riddle: Riddle = { ...r, id, updatedAt: now() };
    const errors = schemaErrors(Riddle, riddle);
    if (errors.length) throw new RiddleError(errors.join('; '));
    const file = read();
    if (oldId !== id && file.riddles.some((x) => x.id === id)) {
      throw new RiddleError(`загадка ${id} уже есть`);
    }
    const rest = file.riddles.filter((x) => x.id !== (oldId ?? id));
    return write({ ...file, riddles: [...rest, riddle] });
  }

  function remove(id: string): RiddlesFile {
    const file = read();
    return write({ ...file, riddles: file.riddles.filter((r) => r.id !== id) });
  }

  /** Загадки из расшифровки листков: новые — добавить, пустые — дополнить, остальные не трогать. */
  function importParsed(parsed: ParsedRiddle[]): { file: RiddlesFile; result: ImportResult } {
    const file = read();
    const byId = new Map(file.riddles.map((r) => [r.id, r]));
    const result: ImportResult = { added: [], filled: [], kept: [] };
    for (const p of parsed) {
      const id = normalizeKpId(p.id);
      if (!id) continue;
      const old = byId.get(id);
      if (!old) {
        byId.set(id, { id, title: p.title, text: p.text, notes: '', updatedAt: now() });
        result.added.push(id);
      } else if (!old.text.trim()) {
        byId.set(id, { ...old, title: old.title || p.title, text: p.text, updatedAt: now() });
        result.filled.push(id);
      } else result.kept.push(id);
    }
    return { file: write({ ...file, riddles: [...byId.values()] }), result };
  }

  function addSheet(name: string): RiddlesFile {
    const file = read();
    return write({ ...file, sheets: [...new Set([...file.sheets, name])] });
  }

  return { path, read, upsert, remove, importParsed, addSheet };
}
