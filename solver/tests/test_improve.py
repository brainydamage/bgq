"""Доработка после OR-Tools: ходы «взять один — убрать два», порядок, честный штраф."""

from test_solver import kp, make_problem, uniform

from bgq_solver.improve import Evaluator, improve, search


def test_takes_one_expensive_instead_of_two_cheap():
    # A и B по 1 б; X — 5 б, но 20 мин на точке. До дедлайна влезают либо A+B, либо X.
    # Вставить X можно, только убрав сразу оба — за один ход OR-Tools так не умеет.
    p = make_problem(
        [kp("10", 1), kp("11", 1), kp("50", 5, service=1200)],
        uniform(5, 300),
        deadline=1800,
        late_max=0,
    )
    assert improve(p, [2, 3], [2, 3, 4], depart_s=0) == [4]


def test_never_worse_and_keeps_good_route():
    p = make_problem([kp("10", 1), kp("20", 2), kp("30", 3)], uniform(5, 300))
    ev = Evaluator(p, [2, 3, 4], 0)
    order = [2, 3, 4]
    new = search(p, order, [2, 3, 4], depart_s=0, time_limit_s=0.2)
    assert sorted(new) == [2, 3, 4]
    assert ev.cost(new) <= ev.cost(order)


def test_reorders_to_shorter_route():
    # Старт 0, финиш 1; КП 2 и 3: 0→3→2→1 короче, чем 0→2→3→1.
    dur = [
        [0, 100, 900, 100],
        [100, 0, 100, 900],
        [900, 100, 0, 100],
        [100, 900, 100, 0],
    ]
    p = make_problem([kp("10", 1), kp("20", 2)], dur, deadline=7200)
    assert improve(p, [2, 3], [2, 3], depart_s=0) == [3, 2]


def test_late_minute_is_counted_whole():
    # КП на 1 б даёт 10 с опоздания — по протоколу это −1 б, брать незачем.
    p = make_problem([kp("10", 1)], uniform(3, 300), deadline=890)
    ev = Evaluator(p, [2], 0)
    assert ev.cost([2]) > ev.cost([])
    assert improve(p, [2], [2], depart_s=0) == []


def test_window_violation_is_infeasible():
    p = make_problem([kp("99", 9, window=[0, 700]), kp("10", 1)], uniform(4, 300), deadline=7200)
    ev = Evaluator(p, [2, 3], 0)
    assert ev.cost([3, 2]) is None  # к 99 придём в 15 мин, а начать надо до 6 мин 40 с
    assert ev.cost([2, 3]) is not None


def test_rest_disables_improvement():
    p = make_problem(
        [kp("10", 1), kp("11", 1), kp("50", 5, service=1200)],
        uniform(5, 300),
        deadline=1800,
        late_max=0,
        rest=[{"durationS": 60}],
    )
    assert search(p, [2, 3], [2, 3, 4], depart_s=0, time_limit_s=0.1) == [2, 3]
