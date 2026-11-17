#!/usr/bin/env node
// Сравнение пересчёта на телефоне (TS) с OR-Tools на задаче 10.10:
//   node packages/replan/scripts/bench.ts [--time МС] [--ortools С]
// Сценарии — как в поле: от текущего плана, с опозданием/опережением, после пропусков; OR-Tools
// решает ту же подзадачу (uv run в solver/, 6 стратегий + improve.py). Нужен uv.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Plan, Problem } from '@bgq/core';
import { scoreRoute, solve, subProblem } from '../src/index.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const { values } = parseArgs({
  options: {
    time: { type: 'string', default: '2000' },
    ortools: { type: 'string', default: '10' },
  },
});
const fx = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, 'fixtures/2026-10-10', name), 'utf8')) as unknown;
const problem = fx('problem.json') as Problem;
const plan = fx('plan.json') as Plan;
const index = new Map(problem.nodes.map((n, i) => [n.kpId, i]));
const ids = plan.stops.map((s) => s.kpId);

interface Scenario {
  name: string;
  /** Взято первых k точек плана; последняя — «откуда». */
  taken: number;
  /** Сдвиг относительно плана, с: > 0 — опаздываем. */
  shiftS: number;
  skipped?: string[];
  /** Резерв на паузу, с: дедлайн пересчёта раньше настоящего. */
  reserveS?: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'старт, выход на 60 мин позже', taken: 0, shiftS: 3600 },
  { name: 'после 10 КП, отстаём на 30 мин', taken: 10, shiftS: 1800 },
  { name: 'после 10 КП, опережаем на 30 мин', taken: 10, shiftS: -1800 },
  { name: 'после 15 КП, пропущено 3 следующих', taken: 15, shiftS: 0, skipped: ids.slice(15, 18) },
  { name: 'после 20 КП, отстаём на 45 мин', taken: 20, shiftS: 2700 },
  { name: 'после 20 КП, резерв 45 мин', taken: 20, shiftS: 0, reserveS: 2700 },
  { name: 'после 30 КП, отстаём на 20 мин', taken: 30, shiftS: 1200 },
];

function ortools(sub: Problem, departS: number): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'bgq-bench-'));
  const path = join(dir, 'problem.json');
  writeFileSync(path, JSON.stringify(sub));
  const py = [
    'import json, sys',
    'from bgq_solver.model import solve_route',
    'p = json.load(open(sys.argv[1]))',
    'r = solve_route(p, depart_s=int(sys.argv[2]), time_limit_s=float(sys.argv[3]))',
    'print(json.dumps([p["nodes"][i]["kpId"] for i in r.order]))',
  ].join('\n');
  const out = execFileSync(
    'uv',
    ['run', 'python', '-c', py, path, String(departS), String(values.ortools)],
    { cwd: join(ROOT, 'solver'), encoding: 'utf8' },
  );
  return JSON.parse(out) as string[];
}

const rows: string[][] = [['сценарий', 'КП ост.', 'OR-Tools', 'TS', 'разница', 'TS, мс']];
let worst = 0;
for (const sc of SCENARIOS) {
  const fromStop = sc.taken > 0 ? plan.stops[sc.taken - 1] : undefined;
  const from = fromStop ? (index.get(fromStop.kpId) as number) : problem.start;
  const departS = Math.max(0, (fromStop?.departS ?? 0) + sc.shiftS);
  const exclude = new Set([...ids.slice(0, sc.taken), ...(sc.skipped ?? [])]);
  const deadlineS = problem.deadlineS - (sc.reserveS ?? 0);
  const { problem: sub } = subProblem(problem, { from, exclude, deadlineS });
  const local = new Map(sub.nodes.map((n, i) => [n.kpId, i]));
  const current = ids.filter((id) => !exclude.has(id)).map((id) => local.get(id) as number);

  const ts = solve(sub, { departS, initial: current, timeMs: Number(values.time) });
  const tsIds = ts.order.map((i) => sub.nodes[i]?.kpId as string);
  const orIds = ortools(sub, departS);
  const score = (o: string[]) => scoreRoute(sub, o, { from: 0, departS, deadlineS });
  const a = score(orIds);
  const b = score(tsIds);
  const total = (s: ReturnType<typeof score>) => s.points - s.penalty;
  const gap = total(a) > 0 ? (total(b) - total(a)) / total(a) : 0;
  worst = Math.min(worst, gap);
  rows.push([
    sc.name,
    String(current.length),
    `${total(a)} б (${a.order.length} КП)`,
    `${total(b)} б (${b.order.length} КП)`,
    `${(gap * 100).toFixed(1)}%`,
    String(ts.ms),
  ]);
}
const width = rows[0]?.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length))) ?? [];
for (const r of rows) console.log(r.map((x, c) => x.padEnd(width[c] ?? 0)).join('  '));
console.log(`\nхудшее: ${(worst * 100).toFixed(1)}% (цель — не хуже −10%)`);
