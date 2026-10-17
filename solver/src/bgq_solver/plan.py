"""Порядок КП → plan.json (схема plan.v1): времена прямым проходом «как можно раньше»."""

from __future__ import annotations

import itertools
import math
import uuid
from datetime import UTC, datetime

from .model import Route, kp_nodes


def late_penalty(problem: dict, finish_s: int) -> float:
    """Штраф за опоздание в баллах; минута опоздания считается начатой."""
    late_s = max(0, finish_s - problem["deadlineS"])
    return math.ceil(late_s / 60) * problem["latePenaltyPerMin"]


def build_plan(
    problem: dict,
    route: Route,
    *,
    depart_s: int,
    problem_hash: str,
    solver_ms: int,
) -> dict:
    """
    Времена — прямым проходом по порядку: приход = уход с прошлой точки + путь,
    уход = max(приход, открытие окна) + время на точке (+ отдых, если солвер поставил его
    на следующий перегон; не отданный до финиша отдых — перед последним перегоном).
    Не позже, чем в решении солвера, — окна и финиш выполняются.
    """
    nodes = problem["nodes"]
    dur = problem["matrix"]["durationS"]
    rests = problem.get("rest") or []
    pending = sorted(zip(route.rest_start_s, rests, strict=True), key=lambda r: r[0])

    stops = []
    prev, t = problem["start"], depart_s
    for node in [*route.order, problem["finish"]]:
        last = node == problem["finish"]
        while pending and (last or t + dur[prev][node] > pending[0][0]):
            _, rest = pending.pop(0)
            t = max(t, rest.get("fromS", 0)) + rest["durationS"]
        arrive = t + dur[prev][node]
        if last:
            t = arrive
            break
        n = nodes[node]
        begin = max(arrive, n["window"][0]) if n.get("window") else arrive
        t = begin + n["serviceS"]
        stops.append({"kpId": n["kpId"], "arriveS": arrive, "departS": t})
        prev = node
    finish_s = t

    path = [problem["start"], *route.order, problem["finish"]]
    walk_s = sum(dur[a][b] for a, b in itertools.pairwise(path))
    penalty = late_penalty(problem, finish_s)
    taken = set(route.order)
    points = sum(nodes[i]["points"] for i in taken)
    prize = sum(nodes[i]["prize"] for i in taken)

    return {
        "v": 1,
        "planId": str(uuid.uuid4()),
        "gameId": problem["gameId"],
        "problemHash": problem_hash,
        "createdAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "solver": "ortools",
        "solverMs": solver_ms,
        "t0": problem["t0"],
        "stops": stops,
        "finishS": finish_s,
        "slackMin": round((problem["deadlineS"] - finish_s) / 60, 1),
        "totalPoints": max(0, points - penalty),
        "expectedPrize": round(max(0.0, prize - penalty), 2),
        "distanceM": round(walk_s * problem["speedKmh"] / 3.6),
        "dropped": [nodes[i]["kpId"] for i in kp_nodes(problem) if i not in taken],
    }
