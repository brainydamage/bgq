import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import { Loc } from './schema/common.ts';
import { Event } from './schema/event.ts';
import { Game } from './schema/game.ts';
import { Kp } from './schema/kp.ts';
import { Params } from './schema/params.ts';
import { PhoneGame } from './schema/phone.ts';
import { Plan } from './schema/plan.ts';
import { Problem } from './schema/problem.ts';
import { RiddlesFile } from './schema/riddle.ts';
import { SyncRequest, SyncResponse } from './schema/sync.ts';
import { MapFileResults, PointsFile } from './schema/table.ts';

export const SCHEMA_VERSION = 1;

/** Все контрактные схемы; из них генерируются schemas/<name>.v1.schema.json (контракт с Python). */
export const schemas = {
  game: Game,
  kp: Kp,
  loc: Loc,
  problem: Problem,
  plan: Plan,
  event: Event,
  points: PointsFile,
  map: MapFileResults,
  params: Params,
  riddles: RiddlesFile,
  phone: PhoneGame,
  'sync-request': SyncRequest,
  'sync-response': SyncResponse,
} as const satisfies Record<string, TSchema>;

export type SchemaName = keyof typeof schemas;

export function schemaFileName(name: SchemaName): string {
  return `${name}.v${SCHEMA_VERSION}.schema.json`;
}

/** Содержимое JSON-файлов схем: имя файла → текст. Детерминировано. */
export function renderSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(schemas) as [SchemaName, TSchema][]) {
    const file = schemaFileName(name);
    const doc = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: `https://bgq.local/schemas/${file}`,
      title: name,
      ...schema,
    };
    out[file] = `${JSON.stringify(doc, null, 2)}\n`;
  }
  return out;
}

/** Ошибки валидации в виде "<путь> <сообщение>"; пустой массив — значение валидно. */
export function schemaErrors(schema: TSchema, value: unknown): string[] {
  if (Value.Check(schema, value)) return [];
  return Value.Errors(schema, value).map((e) => `${e.instancePath || '/'} ${e.message}`);
}
