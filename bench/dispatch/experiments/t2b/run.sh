#!/usr/bin/env bash
# Reproduces bench/dispatch/experiments/t2b/results.json: why Node's routing solve is slower than Python's
# on t2b (20 buses, GLS sl=50), OR-Tools 9.15 only. Run from the repository root on an idle machine, with
# the 9.15 addon built (build/) and the fixtures generated; about 2 hours. Recorded on an i7-12700H, glibc
# 2.43, Node v24.21.0, Python 3.13.16, ortools 9.15.6755.
#   PY=<python with ortools 9.15> CABY_DISPATCH_DIR=<caby-dispatch checkout> bench/dispatch/experiments/t2b/run.sh <out_dir>
set -euo pipefail
: "${PY:?set PY to a Python with ortools 9.15.6755}"
: "${CABY_DISPATCH_DIR:?set CABY_DISPATCH_DIR to the caby-dispatch checkout}"
OUT=${1:?usage: run.sh <out_dir>}
HERE=bench/dispatch/experiments/t2b
FX=bench/dispatch/fixtures
WHEEL_LIBS=$("$PY" -I -c 'import ortools, os; print(os.path.join(os.path.dirname(ortools.__file__), ".libs"))')
TCACHE=glibc.malloc.tcache_count=1000
pin() { taskset -c "${BENCH_CPU:-0}" "$@"; }
mkdir -p "$OUT"
export UV_THREADPOOL_SIZE=8

pin "$PY" -I -B bench/dispatch/run_py.py t2b exact 5 "$FX" > "$OUT/py.json"
pin node bench/dispatch/run_node.js t2b exact 5 "$FX" removevalues > "$OUT/node-async.json"
pin node -r "./$HERE/sync_patch.js" bench/dispatch/run_node.js t2b exact 5 "$FX" removevalues > "$OUT/node-sync.json"
LD_LIBRARY_PATH=$WHEEL_LIBS pin node bench/dispatch/run_node.js t2b exact 5 "$FX" removevalues > "$OUT/node-wheellib.json"
pin "$PY" -I -B "$HERE/py_thread.py" t2b exact 3 "$FX" > "$OUT/py-thread.json"
GLIBC_TUNABLES=$TCACHE pin "$PY" -I -B bench/dispatch/run_py.py t2b exact 3 "$FX" > "$OUT/py-tcache.json"
GLIBC_TUNABLES=$TCACHE pin node bench/dispatch/run_node.js t2b exact 3 "$FX" removevalues > "$OUT/node-tcache.json"
GLIBC_TUNABLES=$TCACHE pin node -r "./$HERE/sync_patch.js" bench/dispatch/run_node.js t2b exact 3 "$FX" removevalues > "$OUT/node-sync-tcache.json"
for v in none cb limit both; do
  pin "$PY" -I -B "$HERE/py_hooks.py" "$v" t2b exact 2 "$FX" > "$OUT/hook-$v.json"
done
{ pin "$PY" -I -B "$HERE/counters.py"; pin node "$HERE/counters.js" removevalues; } > "$OUT/counters.txt"

labels=(py node-async node-sync node-wheellib py-thread py-tcache node-tcache node-sync-tcache hook-none hook-cb hook-limit hook-both)
args=(); for l in "${labels[@]}"; do args+=("$l=$OUT/$l.json"); done
node "$HERE/summarise.js" "${args[@]}" > "$OUT/results.json"
node "$HERE/ratios.js" "$OUT/results.json"
