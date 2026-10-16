import { type Game, Kp, schemaErrors } from '@bgq/core';
import { applyOverrides } from './overrides.ts';
import { parseNotion } from './parse.ts';
import type { IngestResult, Issue, Stats } from './types.ts';

export interface IngestInput {
  md: string;
  game: Game;
  /** Текст overrides.yaml, если есть. */
  overrides?: string;
}

/** Парсер + overrides + проверка схемой + статистика. Чистая функция. */
export function ingest({ md, game, overrides }: IngestInput): IngestResult {
  const p = parseNotion(md, game);
  const issues = [...p.issues];
  if (overrides) issues.push(...applyOverrides(p.kps, overrides, game));

  for (const kp of p.kps) {
    const errors = schemaErrors(Kp, kp);
    if (errors.length) {
      const line = p.sourceLines[kp.id];
      issues.push({
        severity: 'critical',
        code: 'schema_invalid',
        kpId: kp.id,
        ...(line !== undefined && { line }),
        message: `КП не проходит схему: ${errors.join('; ')}`,
      });
    }
  }
  if (!p.kps.length) {
    issues.push({ severity: 'critical', code: 'no_kps', message: 'Не найдено ни одного КП' });
  }
  if (!p.finish) {
    issues.push({
      severity: 'cosmetic',
      code: 'finish_missing',
      message: 'Блок финиша не найден — берём из game.json',
    });
  }

  return {
    kps: p.kps,
    ...(p.finish && { finish: p.finish }),
    issues: sortIssues(issues),
    stats: computeStats(p.kps, p.preambleLines),
    sourceLines: p.sourceLines,
  };
}

function computeStats(kps: Kp[], preambleLines: number): Stats {
  const eligible = kps.filter((k) => k.eligible);
  return {
    kps: kps.length,
    eligible: eligible.length,
    points: eligible.reduce((sum, k) => sum + k.points, 0),
    withHouseNumber: kps.filter((k) => k.address && (k.address.house || k.address.alt)).length,
    withMapsLink: kps.filter((k) => k.links.some((l) => l.kind === 'maps')).length,
    preambleLines,
  };
}

function sortIssues(issues: Issue[]): Issue[] {
  const rank = (i: Issue) => (i.severity === 'critical' ? 0 : 1);
  return [...issues].sort(
    (a, b) => rank(a) - rank(b) || (a.line ?? Infinity) - (b.line ?? Infinity),
  );
}
