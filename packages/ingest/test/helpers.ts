import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Game, Kp } from '@bgq/core';
import type { IngestResult } from '../src/index.ts';

const root = join(import.meta.dirname, '../../..');

export const fixtureMd = readFileSync(join(root, 'fixtures/2026-10-10/notion-export.md'), 'utf8');
export const fixtureGame = JSON.parse(
  readFileSync(join(root, 'games/2026-10-10/game.json'), 'utf8'),
) as Game;
export const fixtureOverrides = readFileSync(join(root, 'games/2026-10-10/overrides.yaml'), 'utf8');

export function kpOf(result: Pick<IngestResult, 'kps'>, id: string): Kp {
  const kp = result.kps.find((k) => k.id === id);
  if (!kp) throw new Error(`КП ${id} не найден`);
  return kp;
}

export function codes(result: Pick<IngestResult, 'issues'>, severity?: 'critical' | 'cosmetic') {
  return result.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);
}
