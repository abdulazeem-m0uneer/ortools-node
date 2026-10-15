"""Python (pywraplp) side of the ortools-node vs Python benchmark.

Usage: python bench/bench.py <workload> <style> <repeats>
Prints one JSON line per run: {buildMs, solveMs, readMs, status, objective, checksum}.
Mirror of bench/bench.js; keep both in step.
"""

import json
import sys
import time

from ortools.linear_solver import pywraplp

INF = pywraplp.Solver.infinity()
STATUS = {
    pywraplp.Solver.OPTIMAL: "OPTIMAL",
    pywraplp.Solver.FEASIBLE: "FEASIBLE",
    pywraplp.Solver.INFEASIBLE: "INFEASIBLE",
    pywraplp.Solver.UNBOUNDED: "UNBOUNDED",
    pywraplp.Solver.ABNORMAL: "ABNORMAL",
    pywraplp.Solver.MODEL_INVALID: "MODEL_INVALID",
    pywraplp.Solver.NOT_SOLVED: "NOT_SOLVED",
}


def rng(seed):
    """mulberry32 with 32-bit wraparound: the same sequence as bench.js."""
    a = seed & 0xFFFFFFFF

    def imul(x, y):
        return (x * y) & 0xFFFFFFFF

    def nxt():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return (t ^ (t >> 14)) & 0xFFFFFFFF

    return nxt


def now():
    return time.perf_counter_ns() / 1e6


def transport_data(S, D):
    r = rng(1)
    supply = [r() % 100 + 50 for _ in range(S)]
    demand = [r() % 100 + 1 for _ in range(D)]
    cost = [[r() % 100 + 1 for _ in range(D)] for _ in range(S)]
    return dict(S=S, D=D, supply=supply, demand=demand, cost=cost)


def knapsack_data(n, m):
    r = rng(2)
    value = [r() % 100 + 1 for _ in range(n)]
    weight = [[r() % 100 + 1 for _ in range(n)] for _ in range(m)]
    capacity = [sum(w) // 2 for w in weight]
    return dict(n=n, m=m, value=value, weight=weight, capacity=capacity)


def small_lp_data(count):
    r = rng(3)
    models = []
    for _ in range(count):
        obj = [r() % 10 + 1 for _ in range(10)]
        rows = []
        for _ in range(5):
            coef = [r() % 10 + 1 for _ in range(10)]
            rows.append(dict(coef=coef, rhs=r() % 50 + 20))
        models.append(dict(obj=obj, rows=rows))
    return models


# Each builder returns (solver, read) where read() sums all variable values.


def transport_idiomatic(d):
    s = pywraplp.Solver.CreateSolver("GLOP")
    S, D = d["S"], d["D"]
    x = [[s.NumVar(0, INF, f"x_{i}_{j}") for j in range(D)] for i in range(S)]
    for i in range(S):
        s.Add(s.Sum([x[i][j] for j in range(D)]) <= d["supply"][i])
    for j in range(D):
        s.Add(s.Sum([x[i][j] for i in range(S)]) >= d["demand"][j])
    s.Minimize(s.Sum([d["cost"][i][j] * x[i][j] for i in range(S) for j in range(D)]))
    return s, lambda: sum(v.solution_value() for row in x for v in row)


def transport_lowlevel(d):
    s = pywraplp.Solver.CreateSolver("GLOP")
    S, D = d["S"], d["D"]
    x = [[s.NumVar(0, INF, f"x_{i}_{j}") for j in range(D)] for i in range(S)]
    for i in range(S):
        c = s.Constraint(-INF, d["supply"][i], f"s{i}")
        for j in range(D):
            c.SetCoefficient(x[i][j], 1)
    for j in range(D):
        c = s.Constraint(d["demand"][j], INF, f"d{j}")
        for i in range(S):
            c.SetCoefficient(x[i][j], 1)
    obj = s.Objective()
    for i in range(S):
        for j in range(D):
            obj.SetCoefficient(x[i][j], d["cost"][i][j])
    obj.SetMinimization()
    return s, lambda: sum(v.solution_value() for row in x for v in row)


def knapsack_idiomatic(d):
    s = pywraplp.Solver.CreateSolver("SCIP")
    n, m = d["n"], d["m"]
    x = [s.BoolVar(f"x{j}") for j in range(n)]
    for k in range(m):
        s.Add(s.Sum([d["weight"][k][j] * x[j] for j in range(n)]) <= d["capacity"][k])
    s.Maximize(s.Sum([d["value"][j] * x[j] for j in range(n)]))
    return s, lambda: sum(v.solution_value() for v in x)


def knapsack_lowlevel(d):
    s = pywraplp.Solver.CreateSolver("SCIP")
    n, m = d["n"], d["m"]
    x = [s.IntVar(0, 1, f"x{j}") for j in range(n)]
    for k in range(m):
        c = s.Constraint(-INF, d["capacity"][k], f"c{k}")
        for j in range(n):
            c.SetCoefficient(x[j], d["weight"][k][j])
    obj = s.Objective()
    for j in range(n):
        obj.SetCoefficient(x[j], d["value"][j])
    obj.SetMaximization()
    return s, lambda: sum(v.solution_value() for v in x)


def small_lp_idiomatic(m):
    s = pywraplp.Solver.CreateSolver("GLOP")
    x = [s.NumVar(0, 10, f"x{j}") for j in range(10)]
    for row in m["rows"]:
        s.Add(s.Sum([row["coef"][j] * x[j] for j in range(10)]) <= row["rhs"])
    s.Maximize(s.Sum([m["obj"][j] * x[j] for j in range(10)]))
    return s, lambda: sum(v.solution_value() for v in x)


def small_lp_lowlevel(m):
    s = pywraplp.Solver.CreateSolver("GLOP")
    x = [s.NumVar(0, 10, f"x{j}") for j in range(10)]
    for k, row in enumerate(m["rows"]):
        c = s.Constraint(-INF, row["rhs"], f"c{k}")
        for j in range(10):
            c.SetCoefficient(x[j], row["coef"][j])
    obj = s.Objective()
    for j in range(10):
        obj.SetCoefficient(x[j], m["obj"][j])
    obj.SetMaximization()
    return s, lambda: sum(v.solution_value() for v in x)


BUILDERS = {
    "transport": {"idiomatic": transport_idiomatic, "lowlevel": transport_lowlevel},
    "knapsack": {"idiomatic": knapsack_idiomatic, "lowlevel": knapsack_lowlevel},
    "small": {"idiomatic": small_lp_idiomatic, "lowlevel": small_lp_lowlevel},
}


def run_one(builder, data):
    """One measured run of a single model: build, solve, read back."""
    t0 = now()
    solver, read = builder(data)
    t1 = now()
    status = solver.Solve()
    t2 = now()
    checksum = read()
    t3 = now()
    feasible = status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE)
    return dict(
        buildMs=t1 - t0,
        solveMs=t2 - t1,
        readMs=t3 - t2,
        status=STATUS[status],
        objective=solver.Objective().Value() if feasible else float("nan"),
        checksum=checksum,
    )


def many_small(style):
    models = small_lp_data(2000)

    def run():
        total = dict(buildMs=0, solveMs=0, readMs=0, status="OPTIMAL", objective=0, checksum=0)
        for m in models:
            r = run_one(BUILDERS["small"][style], m)
            for key in ("buildMs", "solveMs", "readMs", "objective", "checksum"):
                total[key] += r[key]
            if r["status"] != "OPTIMAL":
                total["status"] = r["status"]
        return total

    return run


WORKLOADS = {
    "transport-100": lambda style: (lambda d: lambda: run_one(BUILDERS["transport"][style], d))(transport_data(100, 100)),
    "transport-400": lambda style: (lambda d: lambda: run_one(BUILDERS["transport"][style], d))(transport_data(400, 400)),
    "knapsack-scip": lambda style: (lambda d: lambda: run_one(BUILDERS["knapsack"][style], d))(knapsack_data(50, 5)),
    "small-lp-x2000": many_small,
}


def main():
    args = sys.argv[1:]
    if len(args) < 2 or args[0] not in WORKLOADS or args[1] not in ("idiomatic", "lowlevel"):
        print(f"usage: bench.py <{'|'.join(WORKLOADS)}> <idiomatic|lowlevel> [repeats]", file=sys.stderr)
        sys.exit(2)
    workload, style = args[0], args[1]
    repeats = int(args[2]) if len(args) > 2 else 5
    run = WORKLOADS[workload](style)  # data generation is not timed
    run()  # warm-up
    for _ in range(repeats):
        print(json.dumps(run()), flush=True)


if __name__ == "__main__":
    main()
