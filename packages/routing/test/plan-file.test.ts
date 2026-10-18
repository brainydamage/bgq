import { copyFileSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freshPlan } from '../src/index.ts';

const FX = join(import.meta.dirname, '../../../fixtures/2026-10-10');

/** Каталог игры: problem.json и plan.json 10.10 (план построен по этому problem.json). */
function gameDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgq-plan-'));
  copyFileSync(join(FX, 'problem.json'), join(dir, 'problem.json'));
  copyFileSync(join(FX, 'plan.json'), join(dir, 'plan.json'));
  writeFileSync(join(dir, 'points.json'), '{}');
  const t = new Date('2026-10-10T12:00:00Z');
  utimesSync(join(dir, 'points.json'), t, t);
  return dir;
}

describe('freshPlan: plan.json не устарел', () => {
  it('план по текущему problem.json — берётся', () => {
    const { plan, why } = freshPlan(gameDir());
    expect(why).toBeUndefined();
    expect(plan?.stops).toHaveLength(37);
  });

  it('нет plan.json — ни плана, ни причины', () => {
    expect(freshPlan(mkdtempSync(join(tmpdir(), 'bgq-plan-')))).toEqual({});
  });

  it('points.json новее problem.json — устарел', () => {
    const dir = gameDir();
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'points.json'), later, later);
    expect(freshPlan(dir)).toEqual({ why: 'points.json новее problem.json' });
  });

  it('problem.json изменился после solve — хэш не совпал', () => {
    const dir = gameDir();
    writeFileSync(join(dir, 'problem.json'), '{}\n');
    expect(freshPlan(dir).why).toBe('problem.json изменился после ./bgq solve');
  });

  it('битый plan.json — причина со схемой', () => {
    const dir = gameDir();
    writeFileSync(join(dir, 'plan.json'), '{"v":1}');
    expect(freshPlan(dir).why).toMatch(/^plan\.json не проходит схему/);
  });
});
