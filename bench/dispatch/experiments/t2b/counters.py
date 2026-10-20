"""python -I -B counters.py: branches, failures, solutions and wall ms of the first 4 t2b solves (Python)."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.join(HERE, "..", ".."))
sys.argv = [sys.argv[0]]
import run_py  # noqa: E402
from ortools.constraint_solver import pywrapcp  # noqa: E402


def counted(fn):
    def wrapper(self, *args):
        out = fn(self, *args)
        s = self.solver()
        print("python", s.Branches(), s.Failures(), s.Solutions(), s.WallTime(), flush=True)
        return out
    return wrapper


for _name in ("SolveWithParameters", "SolveFromAssignmentWithParameters"):
    setattr(pywrapcp.RoutingModel, _name, counted(getattr(pywrapcp.RoutingModel, _name)))
fx = run_py.load("t2b")
for case in fx["cases"][:4]:
    buses, newcomers = run_py.instance(case)
    run_py.solve(buses, newcomers, warm=True, time_limit_ms=5000, ls="GUIDED_LOCAL_SEARCH", solution_limit=50)
