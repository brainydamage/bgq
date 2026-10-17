"""bgq-solve <problem.json> [-o plan.json] [--time С] [--depart ЧЧ:ММ] — маршрут OR-Tools."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

from .model import ProblemError, solve_route
from .plan import build_plan


def problem_hash(raw: bytes) -> str:
    """sha256 байтов problem.json — так же считает TS (проверка, что план не устарел)."""
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def depart_offset(t0: str, hhmm: str) -> int:
    """«ЧЧ:ММ» выхода → секунды от t0 (время t0 — местное, как в problem.json)."""
    try:
        h, m = (int(x) for x in hhmm.split(":"))
    except ValueError:
        raise ProblemError(f"--depart: ожидается ЧЧ:ММ, получено «{hhmm}»") from None
    t0_min = int(t0[11:13]) * 60 + int(t0[14:16])
    offset = (h * 60 + m - t0_min) * 60
    if offset < 0:
        raise ProblemError(f"--depart {hhmm} раньше выхода по задаче {t0[11:16]}")
    return offset


def solve_file(
    problem_path: Path, *, time_limit_s: float = 10.0, depart: str | None = None
) -> dict:
    raw = problem_path.read_bytes()
    problem = json.loads(raw)
    depart_s = depart_offset(problem["t0"], depart) if depart else 0
    started = time.monotonic()
    route = solve_route(problem, depart_s=depart_s, time_limit_s=time_limit_s)
    solver_ms = round((time.monotonic() - started) * 1000)
    return build_plan(
        problem, route, depart_s=depart_s, problem_hash=problem_hash(raw), solver_ms=solver_ms
    )


def write_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="bgq-solve", description="problem.json → plan.json")
    ap.add_argument("problem", type=Path)
    ap.add_argument("-o", "--out", type=Path, help="по умолчанию plan.json рядом с problem.json")
    ap.add_argument(
        "--time", type=float, default=10.0, help="лимит поиска каждой стратегии, с (10)"
    )
    ap.add_argument(
        "--depart", help="выход на трассу ЧЧ:ММ (по умолчанию — t0 задачи: выход после пролога)"
    )
    args = ap.parse_args(argv)

    try:
        plan = solve_file(args.problem, time_limit_s=args.time, depart=args.depart)
    except (ProblemError, OSError, json.JSONDecodeError, KeyError) as e:
        print(f"✗ {e}", file=sys.stderr)
        return 2
    out = args.out or args.problem.with_name("plan.json")
    write_atomic(out, plan)
    print(
        f"ortools: {len(plan['stops'])} КП, {plan['totalPoints']} б, "
        f"запас {plan['slackMin']} мин, {plan['solverMs'] / 1000:.1f} с → {out}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
