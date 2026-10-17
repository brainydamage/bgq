"""Солвер на маленьких задачах: окна, выбрасывание, опоздание, отдых, времена, схема Plan."""

import hashlib
import json
from pathlib import Path

import jsonschema
import pytest

from bgq_solver.cli import depart_offset, main, problem_hash, solve_file
from bgq_solver.model import ProblemError, Route, solve_route
from bgq_solver.plan import build_plan, late_penalty

ROOT = Path(__file__).resolve().parents[2]
PLAN_SCHEMA = json.loads((ROOT / "schemas/plan.v1.schema.json").read_text())
PROBLEM_SCHEMA = json.loads((ROOT / "schemas/problem.v1.schema.json").read_text())

# Маленьким задачам хватает двух стратегий по 0,2 с в одном процессе.
FAST = {
    "time_limit_s": 0.2,
    "workers": 1,
    "strategies": [
        ("ALL_UNPERFORMED", "GUIDED_LOCAL_SEARCH"),
        ("PATH_CHEAPEST_ARC", "TABU_SEARCH"),
    ],
}


def make_problem(kps, dur, *, deadline=3600, late_max=1800, per_min=1, **extra):
    """Узлы: 0 — старт, 1 — финиш, дальше КП (points, serviceS, window?)."""
    nodes = [
        {
            "kpId": None,
            "role": "start",
            "lat": 45,
            "lon": 19.6,
            "points": 0,
            "prize": 0,
            "serviceS": 0,
        },
        {
            "kpId": None,
            "role": "finish",
            "lat": 45,
            "lon": 19.6,
            "points": 0,
            "prize": 0,
            "serviceS": 0,
        },
    ]
    for kp in kps:
        node = {"role": "kp", "lat": 45, "lon": 19.6, "prize": kp["points"], **kp}
        nodes.append(node)
    problem = {
        "v": 1,
        "gameId": "2026-10-10",
        "t0": "2026-10-10T10:30:00+02:00",
        "nodes": nodes,
        "matrix": {"source": "haversine", "durationS": dur},
        "start": 0,
        "finish": 1,
        "deadlineS": deadline,
        "softLateMaxS": late_max,
        "latePenaltyPerMin": per_min,
        "speedKmh": 3.6,
        **extra,
    }
    jsonschema.validate(problem, PROBLEM_SCHEMA)
    return problem


def plan_of(problem, *, depart_s=0, **kw):
    route = solve_route(problem, depart_s=depart_s, **(FAST | kw))
    plan = build_plan(problem, route, depart_s=depart_s, problem_hash="sha256:x", solver_ms=1)
    jsonschema.validate(plan, PLAN_SCHEMA)
    return plan


def uniform(n, s):
    """Все перегоны по s секунд."""
    return [[0 if i == j else s for j in range(n)] for i in range(n)]


def kp(kp_id, points, service=300, **extra):
    return {"kpId": kp_id, "points": points, "serviceS": service, **extra}


def ids(plan):
    return [s["kpId"] for s in plan["stops"]]


def test_all_fit_all_taken():
    p = make_problem([kp("10", 1), kp("20", 2), kp("30", 3)], uniform(5, 300))
    plan = plan_of(p)
    assert sorted(ids(plan)) == ["10", "20", "30"]
    assert plan["dropped"] == []
    assert plan["totalPoints"] == 6
    # 4 перегона по 5 мин + 3 КП по 5 мин
    assert plan["finishS"] == 7 * 300
    assert plan["slackMin"] == (3600 - 2100) / 60
    assert plan["distanceM"] == 4 * 300  # 3,6 км/ч = 1 м/с


def test_drops_cheapest_when_time_is_short():
    # Дедлайн 30 мин, опоздание запрещено: влезают два КП из трёх.
    p = make_problem(
        [kp("10", 1), kp("50", 5), kp("70", 7)], uniform(5, 300), deadline=1800, late_max=0
    )
    plan = plan_of(p)
    assert sorted(ids(plan)) == ["50", "70"]
    assert plan["dropped"] == ["10"]
    assert plan["totalPoints"] == 12
    assert plan["finishS"] <= 1800


def test_late_finish_only_for_valuable_kp():
    # Старт → КП → финиш = 10 мин пути + 5 мин на точке; дедлайн 10 мин — опоздание 5 мин.
    dur = uniform(3, 300)
    rich = plan_of(make_problem([kp("100", 10)], dur, deadline=600))
    assert ids(rich) == ["100"]
    assert rich["slackMin"] == -5
    assert rich["totalPoints"] == 10 - 5
    assert rich["expectedPrize"] == 5

    poor = plan_of(make_problem([kp("30", 3)], dur, deadline=600))
    assert ids(poor) == []
    assert poor["dropped"] == ["30"]
    assert poor["finishS"] == 300


def test_late_never_beyond_soft_max():
    # Опоздание на 5 мин, а можно максимум на 2 — КП не берётся, как бы дорог ни был.
    p = make_problem([kp("990", 99)], uniform(3, 300), deadline=600, late_max=120)
    assert ids(plan_of(p)) == []


def test_window_forces_order_and_waiting():
    # «99» работает с 30-й минуты; «10» — без окна. Сначала 10, потом ждём 99.
    p = make_problem(
        [kp("99", 9, service=900, window=[1800, 3600]), kp("10", 1)],
        uniform(4, 300),
        deadline=7200,
    )
    plan = plan_of(p)
    assert ids(plan) == ["10", "99"]
    s99 = plan["stops"][1]
    assert s99["arriveS"] == 900  # 5 мин путь + 5 мин на 10 + 5 мин путь
    assert s99["departS"] == 1800 + 900  # ждали открытия, потом 15 мин судья


def test_window_closes_before_service_ends_is_dropped():
    # Дойти можно к 5-й минуте, но окно до 10-й, а на точке 15 мин — КП не сделать.
    p = make_problem([kp("99", 9, service=900, window=[0, 600])], uniform(3, 300))
    plan = plan_of(p)
    assert plan["stops"] == []
    assert plan["dropped"] == ["99"]


def test_depart_later_than_t0():
    p = make_problem([kp("10", 1)], uniform(3, 300), deadline=7200)
    plan = plan_of(p, depart_s=3600)
    assert plan["stops"][0]["arriveS"] == 3600 + 300
    assert plan["finishS"] == 3600 + 900


def test_rest_block_is_kept():
    p = make_problem(
        [kp("10", 1), kp("20", 2)],
        uniform(4, 300),
        deadline=7200,
        rest=[{"durationS": 1800, "fromS": 600, "toS": 3600}],
    )
    plan = plan_of(p)
    assert sorted(ids(plan)) == ["10", "20"]
    # 3 перегона + 2 КП + 30 мин отдыха
    assert plan["finishS"] == 5 * 300 + 1800


def test_rest_that_does_not_fit_is_an_error():
    p = make_problem(
        [kp("10", 1)], uniform(3, 300), rest=[{"durationS": 1800, "fromS": 0, "toS": 600}]
    )
    with pytest.raises(ProblemError, match="отдых"):
        solve_route(p, **FAST)


def test_warm_start_and_unknown_ids():
    p = make_problem([kp("10", 1), kp("20", 2)], uniform(4, 300), warmStart=["20", "999", "10"])
    assert sorted(ids(plan_of(p))) == ["10", "20"]


def test_forward_times_ignore_solver_delays():
    # Порядок задан вручную: времена — как можно раньше, по матрице.
    p = make_problem(
        [kp("10", 1), kp("20", 2, service=60)],
        [
            [0, 100, 200, 300],
            [100, 0, 400, 500],
            [200, 400, 0, 600],
            [300, 500, 600, 0],
        ],
        deadline=7200,
    )
    plan = build_plan(
        p, Route(order=[2, 3], rest_start_s=[]), depart_s=0, problem_hash="h", solver_ms=0
    )
    assert plan["stops"] == [
        {"kpId": "10", "arriveS": 200, "departS": 500},
        {"kpId": "20", "arriveS": 1100, "departS": 1160},
    ]
    assert plan["finishS"] == 1160 + 500
    assert plan["distanceM"] == 200 + 600 + 500


def test_late_penalty_counts_started_minute():
    p = make_problem([], uniform(2, 0), deadline=600, per_min=1)
    assert late_penalty(p, 600) == 0
    assert late_penalty(p, 601) == 1
    assert late_penalty(p, 660) == 1
    assert late_penalty(p, 661) == 2


def test_depart_offset():
    t0 = "2026-10-10T10:30:00+02:00"
    assert depart_offset(t0, "10:30") == 0
    assert depart_offset(t0, "12:20") == 110 * 60
    with pytest.raises(ProblemError):
        depart_offset(t0, "10:00")
    with pytest.raises(ProblemError):
        depart_offset(t0, "полдень")


def test_bad_matrix_is_an_error():
    p = make_problem([kp("10", 1)], uniform(3, 300))
    p["matrix"]["durationS"] = uniform(2, 300)
    with pytest.raises(ProblemError, match="матрица"):
        solve_route(p, **FAST)


def test_cli_writes_plan_next_to_problem(tmp_path):
    p = make_problem([kp("10", 1)], uniform(3, 300))
    path = tmp_path / "problem.json"
    path.write_text(json.dumps(p))
    assert main([str(path), "--time", "0.3"]) == 0
    plan = json.loads((tmp_path / "plan.json").read_text())
    jsonschema.validate(plan, PLAN_SCHEMA)
    assert plan["problemHash"] == "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    assert plan["problemHash"] == problem_hash(path.read_bytes())
    assert plan["solver"] == "ortools"


def test_cli_reports_bad_input(tmp_path, capsys):
    assert main([str(tmp_path / "нет.json")]) == 2
    assert "✗" in capsys.readouterr().err


def test_fixture_2026_10_10():
    """10.10 целиком (76 КП, OSRM, выход после пролога 12:30): быстро и больше факта (27 КП)."""
    plan = solve_file(ROOT / "fixtures/2026-10-10/problem.json", time_limit_s=5)
    jsonschema.validate(plan, PLAN_SCHEMA)
    assert plan["solverMs"] < 30_000
    assert len(plan["stops"]) >= 33
    assert plan["totalPoints"] >= 200  # 201 без доработки, 207 с ней (--time 10)
    assert plan["slackMin"] >= -30
    assert len(plan["stops"]) + len(plan["dropped"]) == 76
    by_id = {s["kpId"]: s for s in plan["stops"]}
    for w in ("99", "120"):  # окна 14–18 → 5400–19800 с от выхода в 12:30
        if w in by_id:
            assert by_id[w]["departS"] <= 19_800
            assert by_id[w]["departS"] - by_id[w]["arriveS"] >= 300
