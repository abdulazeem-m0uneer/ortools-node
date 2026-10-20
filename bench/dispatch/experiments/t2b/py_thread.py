"""python -I -B py_thread.py <run_py.py args...>: run_py.py with one idle thread, as in any server process.

glibc malloc takes a lock-free fast path only while a process has a single thread; this measures what
Python loses without it (a Node process always has several threads).
"""
import os
import sys
import threading
import time

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import _run_py  # noqa: E402

threading.Thread(target=time.sleep, args=(86400,), daemon=True).start()
_run_py.main(sys.argv[1:])
