"""python -I -B py_hooks.py <none|cb|limit|both> <run_py.py args...>

Adds to every RoutingModel what ortools-node adds to each of its models: an at-solution callback (cb, for
onSolution) and a search limit that never fires (limit, for interrupt()), to price them in Python.
"""
import os
import sys

from ortools.constraint_solver import pywrapcp

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import _run_py  # noqa: E402

VARIANT = sys.argv.pop(1)
if VARIANT not in ("none", "cb", "limit", "both"):
    raise SystemExit(f"unknown variant {VARIANT}: expected none, cb, limit or both")
Base = pywrapcp.RoutingModel


class Hooked(Base):
    def __init__(self, *args):
        super().__init__(*args)
        if VARIANT in ("cb", "both"):
            self.AddAtSolutionCallback(lambda: None)
        if VARIANT in ("limit", "both"):
            # A C++ RegularLimit that never fires; kept alive with the model.
            self._limit = self.solver().Limit(2**62, 2**62, 2**62, 2**62)
            self.AddSearchMonitor(self._limit)


pywrapcp.RoutingModel = Hooked
_run_py.main(sys.argv[1:])
