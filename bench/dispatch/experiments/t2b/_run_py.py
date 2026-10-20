"""Runs bench/dispatch/run_py.py as __main__ with the given argv, after the caller has patched ortools."""
import os
import runpy
import sys

RUN_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "run_py.py")


def main(argv):
    sys.argv = [RUN_PY] + argv
    sys.path.append(os.path.dirname(RUN_PY))
    runpy.run_path(RUN_PY, run_name="__main__")
