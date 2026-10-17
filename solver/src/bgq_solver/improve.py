"""Доработка маршрута после OR-Tools: ходы, которые его локальный поиск не делает за один шаг.

OR-Tools за шаг добавляет, убирает или меняет КП один на один. «Взять выброшенный КП и убрать
два дешёвых» требует двух шагов, первый из которых ухудшает план (опоздание), — такие ходы
он пропускает (10.10: +54, −26, −24 — +1 балл). Здесь они перебираются явно, вместе
с перестановками порядка (relocate, 2-opt), пока целевая функция улучшается.

Целевая функция — как у OR-Tools (model.py): выброшенные prize + опоздание + путь, но финиш —
прямым проходом «как можно раньше», а опоздание — за начатую минуту, как в plan.json.

Потом — перезапуски (ILS): выкинуть случайный отрезок маршрута, достроить теми же ходами,
оставить, если лучше. На 10.10 с выходом в 13:30 — ещё +3 б к лучшей стратегии, слабым — до +20.
"""

from __future__ import annotations

import random
import time
from itertools import combinations

from .model import ARC_COST, PRIZE_SCALE, horizon_s

# Сколько самых дешёвых КП плана пробовать убрать (по одному и парами) ради вставки.
REMOVE_CANDIDATES = 8
# Сколько лучших мест вставки пробовать для каждого выброшенного КП.
INSERT_POSITIONS = 3


class Evaluator:
    """Стоимость порядка (меньше — лучше) или None, если он нарушает окна или жёсткий финиш."""

    def __init__(self, problem: dict, candidates: list[int], depart_s: int) -> None:
        self.nodes = problem["nodes"]
        self.dur = problem["matrix"]["durationS"]
        self.start = problem["start"]
        self.finish = problem["finish"]
        self.deadline = problem["deadlineS"]
        self.horizon = horizon_s(problem)
        self.depart = depart_s
        self.late_per_min = round(problem["latePenaltyPerMin"] * PRIZE_SCALE)
        self.prize = {i: round(self.nodes[i]["prize"] * PRIZE_SCALE) for i in candidates}
        self.total_prize = sum(self.prize.values())

    def cost(self, order: list[int]) -> int | None:
        dur, nodes = self.dur, self.nodes
        t, prev, walk, prize = self.depart, self.start, 0, 0
        for node in order:
            leg = dur[prev][node]
            walk += leg
            n = nodes[node]
            begin = t + leg
            window = n.get("window")
            if window:
                begin = max(begin, window[0])
                if begin > window[1] - n["serviceS"]:
                    return None
            t = begin + n["serviceS"]
            prize += self.prize[node]
            prev = node
        leg = dur[prev][self.finish]
        walk += leg
        t += leg
        if t > self.horizon:
            return None
        # Штраф как в протоколе: за каждую начатую минуту (у OR-Tools — посекундно).
        late_min = -(-max(0, t - self.deadline) // 60)
        return (self.total_prize - prize) + late_min * self.late_per_min + walk * ARC_COST

    def added_s(self, order: list[int], pos: int, node: int) -> int:
        """Сколько секунд добавит вставка node перед order[pos] (без учёта ожидания окон)."""
        a = order[pos - 1] if pos > 0 else self.start
        b = order[pos] if pos < len(order) else self.finish
        d = self.dur
        return d[a][node] + self.nodes[node]["serviceS"] + d[node][b] - d[a][b]


def improve(
    problem: dict,
    order: list[int],
    candidates: list[int],
    *,
    depart_s: int,
    time_limit_s: float = 3.0,
) -> list[int]:
    """Улучшает порядок, пока есть выгодные ходы; никогда не ухудшает. С отдыхом — без изменений."""
    if problem.get("rest"):
        return order
    ev = Evaluator(problem, candidates, depart_s)
    best = list(order)
    best_cost = ev.cost(best)
    if best_cost is None:
        return order
    deadline = time.monotonic() + time_limit_s
    while time.monotonic() < deadline:
        found = _reorder(ev, best, best_cost) or _swap_in(ev, best, best_cost, candidates)
        if not found:
            break
        best, best_cost = found
    return best


def search(
    problem: dict,
    order: list[int],
    candidates: list[int],
    *,
    depart_s: int,
    time_limit_s: float,
    seed: int = 0,
) -> list[int]:
    """improve, затем перезапуски с выкинутым отрезком в пределах time_limit_s. Не ухудшает."""
    if problem.get("rest"):
        return order
    stop = time.monotonic() + time_limit_s
    ev = Evaluator(problem, candidates, depart_s)
    best = improve(problem, order, candidates, depart_s=depart_s, time_limit_s=time_limit_s)
    best_cost = ev.cost(best)
    if best_cost is None:
        return order
    rnd = random.Random(seed)
    while time.monotonic() < stop and len(best) > 3:
        cur = list(best)
        length = rnd.randint(2, min(8, len(cur) - 1))
        at = rnd.randrange(len(cur) - length + 1)
        del cur[at : at + length]
        cur = improve(
            problem, cur, candidates, depart_s=depart_s, time_limit_s=stop - time.monotonic()
        )
        c = ev.cost(cur)
        if c is not None and c < best_cost:
            best, best_cost = cur, c
    return best


def _reorder(ev: Evaluator, order: list[int], cost: int) -> tuple[list[int], int] | None:
    """Тот же набор КП, порядок короче: убрать (если опоздание дороже КП), relocate, 2-opt."""
    best: tuple[list[int], int] | None = None

    def consider(cand: list[int]) -> None:
        nonlocal best
        c = ev.cost(cand)
        if c is not None and c < (best[1] if best else cost):
            best = (cand, c)

    n = len(order)
    for i in range(n):
        rest = order[:i] + order[i + 1 :]
        consider(rest)
        for j in range(n):
            if j != i:
                consider([*rest[:j], order[i], *rest[j:]])
    for i in range(n - 1):
        for j in range(i + 2, n + 1):
            consider(order[:i] + order[i:j][::-1] + order[j:])
    return best


def _swap_in(
    ev: Evaluator, order: list[int], cost: int, candidates: list[int]
) -> tuple[list[int], int] | None:
    """Вставить выброшенный КП, убрав 0–2 самых дешёвых по «баллы / сэкономленное время»."""
    taken = set(order)
    dropped = sorted((c for c in candidates if c not in taken), key=lambda c: -ev.prize[c])
    best: tuple[list[int], int] | None = None
    for x in dropped:
        positions = sorted(range(len(order) + 1), key=lambda p: ev.added_s(order, p, x))
        for pos in positions[:INSERT_POSITIONS]:
            cand = [*order[:pos], x, *order[pos:]]
            # Дешевле всего убрать: мало баллов за много сэкономленного времени.
            removable = sorted(
                (k for k in range(len(cand)) if cand[k] != x),
                key=lambda k: ev.prize[cand[k]] / max(1, _saving_s(ev, cand, k)),
            )[:REMOVE_CANDIDATES]
            sets = [(), *((k,) for k in removable), *combinations(removable, 2)]
            for drop in sets:
                trial = [v for k, v in enumerate(cand) if k not in drop]
                c = ev.cost(trial)
                if c is not None and c < (best[1] if best else cost):
                    best = (trial, c)
    return best


def _saving_s(ev: Evaluator, order: list[int], k: int) -> int:
    a = order[k - 1] if k > 0 else ev.start
    b = order[k + 1] if k + 1 < len(order) else ev.finish
    d = ev.dur
    node = order[k]
    return d[a][node] + ev.nodes[node]["serviceS"] + d[node][b] - d[a][b]
