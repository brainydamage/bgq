"""Prize-collecting маршрут на OR-Tools: Problem (problem.v1) → порядок КП.

Целевая функция в «микробаллах»: 1 балл = PRIZE_SCALE. Выброшенный КП стоит prize,
секунда опоздания на финиш — latePenaltyPerMin / 60 балла, секунда пути — ARC_COST
(тай-брейк «при равных баллах — короче», ~0,06 балла за час, на выбор КП не влияет).
"""

from __future__ import annotations

import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

PRIZE_SCALE = 60_000
ARC_COST = 1
# Доля лимита поиска на доработку после OR-Tools (improve.py): при --time 10 — ещё 3 с.
IMPROVE_SHARE = 0.3


class ProblemError(ValueError):
    """Problem, по которому нельзя строить маршрут (старт = финиш вне правил, пустые узлы)."""


@dataclass(frozen=True)
class Route:
    """Результат поиска: узлы Problem в порядке обхода (без старта и финиша) и момент отдыха."""

    order: list[int]
    rest_start_s: list[int]
    """Начало каждого блока отдыха по решению солвера (секунды от t0), в порядке problem.rest."""


def horizon_s(problem: dict) -> int:
    return problem["deadlineS"] + problem["softLateMaxS"]


def kp_nodes(problem: dict) -> list[int]:
    return [i for i, n in enumerate(problem["nodes"]) if n["role"] == "kp"]


def reachable(problem: dict, node: int, depart_s: int) -> bool:
    """Можно ли взять КП в одиночку: старт → КП (в окно) → финиш до жёсткого предела."""
    dur = problem["matrix"]["durationS"]
    n = problem["nodes"][node]
    begin = depart_s + dur[problem["start"]][node]
    window = n.get("window")
    if window:
        begin = max(begin, window[0])
        if begin > window[1] - n["serviceS"]:
            return False
    return begin + n["serviceS"] + dur[node][problem["finish"]] <= horizon_s(problem)


# Портфель: локальный поиск OR-Tools на этой задаче сильно зависит от первого решения
# (на 10.10 одиночные стратегии дают 217–251 балла), поэтому несколько стратегий идут
# параллельно в отдельных процессах; каждое решение дорабатывает improve.py, берётся лучшее.
STRATEGIES: list[tuple[str, str]] = [
    ("ALL_UNPERFORMED", "GUIDED_LOCAL_SEARCH"),
    ("ALL_UNPERFORMED", "TABU_SEARCH"),
    ("PARALLEL_CHEAPEST_INSERTION", "GUIDED_LOCAL_SEARCH"),
    ("PARALLEL_CHEAPEST_INSERTION", "TABU_SEARCH"),
    ("LOCAL_CHEAPEST_INSERTION", "TABU_SEARCH"),
    ("PATH_CHEAPEST_ARC", "TABU_SEARCH"),
]


def solve_route(
    problem: dict,
    *,
    depart_s: int = 0,
    time_limit_s: float = 10.0,
    strategies: list[tuple[str, str]] | None = None,
    workers: int | None = None,
) -> Route:
    """Лучший маршрут портфеля стратегий; каждая ищет time_limit_s (параллельно)."""
    _validate(problem, depart_s)
    strategies = strategies or STRATEGIES
    if problem.get("warmStart"):
        strategies = [("WARM_START", "GUIDED_LOCAL_SEARCH"), *strategies]
    jobs = [(problem, depart_s, s, time_limit_s) for s in strategies]
    workers = min(len(jobs), workers or os.cpu_count() or 1)
    if workers <= 1:
        results = [_search(*job) for job in jobs]
    else:
        ctx = multiprocessing.get_context("spawn")
        with ProcessPoolExecutor(max_workers=workers, mp_context=ctx) as pool:
            results = list(pool.map(_search, *zip(*jobs, strict=True)))
    found = [r for r in results if r is not None]
    if not found:
        raise ProblemError("OR-Tools не нашёл даже пустого маршрута — старт → финиш не успеть")
    return min(found, key=lambda r: r[0])[1]


def _validate(problem: dict, depart_s: int) -> None:
    nodes = problem["nodes"]
    dur = problem["matrix"]["durationS"]
    if len(dur) != len(nodes) or any(len(row) != len(nodes) for row in dur):
        raise ProblemError("матрица не совпадает по размеру со списком узлов")
    if problem["start"] == problem["finish"]:
        raise ProblemError("старт и финиш — один узел; нужны разные")
    if depart_s > horizon_s(problem):
        raise ProblemError("выход позже финиша")
    for r, rest in enumerate(problem.get("rest") or []):
        lo = max(rest.get("fromS", depart_s), depart_s)
        if rest.get("toS", horizon_s(problem)) - rest["durationS"] < lo:
            raise ProblemError(f"отдых #{r + 1} не помещается в своё окно")


def _search(
    problem: dict, depart_s: int, strategy: tuple[str, str], time_limit_s: float
) -> tuple[int, Route] | None:
    """Одна стратегия: (целевая функция, маршрут) или None, если решения нет."""
    nodes = problem["nodes"]
    dur = problem["matrix"]["durationS"]
    start, finish = problem["start"], problem["finish"]
    horizon = horizon_s(problem)

    # В модель идут только КП, которые можно взять хотя бы в одиночку: так окна не пустые.
    candidates = [i for i in kp_nodes(problem) if reachable(problem, i, depart_s)]
    local = [start, finish, *candidates]  # локальный индекс → узел Problem
    manager = pywrapcp.RoutingIndexManager(len(local), 1, [0], [1])
    routing = pywrapcp.RoutingModel(manager)

    def node_of(index: int) -> int:
        return local[manager.IndexToNode(index)]

    def travel(i: int, j: int) -> int:
        return dur[node_of(i)][node_of(j)] * ARC_COST

    def transit(i: int, j: int) -> int:
        a = node_of(i)
        return nodes[a]["serviceS"] + dur[a][node_of(j)]

    routing.SetArcCostEvaluatorOfAllVehicles(routing.RegisterTransitCallback(travel))
    transit_cb = routing.RegisterTransitCallback(transit)
    # slack — ожидание открытия окна или отдых.
    routing.AddDimension(transit_cb, horizon, horizon, False, "Time")
    time = routing.GetDimensionOrDie("Time")

    time.CumulVar(routing.Start(0)).SetValue(depart_s)
    end = routing.End(0)
    time.CumulVar(end).SetMax(horizon)
    late_per_s = round(problem["latePenaltyPerMin"] * PRIZE_SCALE / 60)
    time.SetCumulVarSoftUpperBound(end, problem["deadlineS"], late_per_s)

    for k, node in enumerate(candidates, start=2):
        index = manager.NodeToIndex(k)
        n = nodes[node]
        window = n.get("window")
        if window:
            # КП должен быть сделан к закрытию окна.
            time.CumulVar(index).SetRange(max(window[0], depart_s), window[1] - n["serviceS"])
        routing.AddDisjunction([index], round(n["prize"] * PRIZE_SCALE))

    breaks = []
    rests = problem.get("rest") or []
    if rests:
        solver = routing.solver()
        for r, rest in enumerate(rests):
            lo = max(rest.get("fromS", depart_s), depart_s)
            hi = rest.get("toS", horizon) - rest["durationS"]
            breaks.append(
                solver.FixedDurationIntervalVar(lo, hi, rest["durationS"], False, f"rest{r}")
            )
        visits = [nodes[node_of(i)]["serviceS"] for i in range(routing.Size())]
        time.SetBreakIntervalsOfVehicle(breaks, 0, visits)

    first, meta = strategy
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.local_search_metaheuristic = getattr(routing_enums_pb2.LocalSearchMetaheuristic, meta)
    params.time_limit.FromMilliseconds(max(1, round(time_limit_s * 1000)))

    if first == "WARM_START":
        routing.CloseModelWithParameters(params)
        pos = {nodes[node]["kpId"]: k for k, node in enumerate(candidates, start=2)}
        warm = [manager.NodeToIndex(pos[i]) for i in problem["warmStart"] if i in pos]
        initial = routing.solver().Assignment()
        if not routing.RoutesToAssignment([warm], True, False, initial):
            return None
        solution = routing.SolveFromAssignmentWithParameters(initial, params)
    else:
        params.first_solution_strategy = getattr(routing_enums_pb2.FirstSolutionStrategy, first)
        solution = routing.SolveWithParameters(params)
    if solution is None:
        return None

    order = []
    index = solution.Value(routing.NextVar(routing.Start(0)))
    while not routing.IsEnd(index):
        order.append(node_of(index))
        index = solution.Value(routing.NextVar(index))
    rest_start = [solution.StartValue(b) for b in breaks]
    if breaks:  # доработка пока без отдыха — берём решение OR-Tools как есть
        return solution.ObjectiveValue(), Route(order=order, rest_start_s=rest_start)

    # Ходы, которых нет у OR-Tools («взять один, убрать два»), + перестановки; сравнение
    # стратегий — по той же целевой функции с финишем «как можно раньше».
    from .improve import Evaluator, search

    order = search(
        problem, order, candidates, depart_s=depart_s, time_limit_s=time_limit_s * IMPROVE_SHARE
    )
    cost = Evaluator(problem, candidates, depart_s).cost(order)
    return (solution.ObjectiveValue() if cost is None else cost), Route(order, [])
