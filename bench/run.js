'use strict';
// Runs bench/bench.js (ortools-node) and bench/bench.py (Python pywraplp) on the
// same models and prints median timings as a Markdown table.
// Setup once:  uv venv bench/.venv && uv pip install --python bench/.venv/bin/python -r bench/requirements.txt
// Run:         npm run bench            (override the interpreter with BENCH_PYTHON=/path/to/python)
// Both runtimes are pinned to one CPU (BENCH_CPU, default: the first performance core on
// hybrid Intel CPUs, else CPU 0) so neither lands on a slower core; needs Linux `taskset`.

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { pinnedCpu, hasTaskset, pinned } = require('./lib/cpu');
const { median } = require('./lib/stats');

const PYTHON = process.env.BENCH_PYTHON || path.join(__dirname, '.venv', 'bin', 'python');
const REPEATS = 7;
const WORKLOADS = ['transport-100', 'transport-400', 'knapsack-scip', 'small-lp-x2000'];
const STYLES = ['idiomatic', 'lowlevel'];

const CPU = pinnedCpu();
const PIN = CPU !== null && hasTaskset();

function runs(cmd, args) {
  [cmd, args] = pinned(PIN ? CPU : null, cmd, args);
  const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24 });
  return out.trim().split('\n').map((line) => JSON.parse(line));
}

function summarise(rs) {
  const pick = (k) => median(rs.map((r) => r[k]));
  const buildMs = pick('buildMs'), solveMs = pick('solveMs'), readMs = pick('readMs');
  return { buildMs, solveMs, readMs, totalMs: median(rs.map((r) => r.buildMs + r.solveMs + r.readMs)), first: rs[0] };
}

// Both sides must have built the same model, or the timings mean nothing.
function assertSameModel(workload, style, node, py) {
  const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  const ok = node.status === py.status && close(node.objective, py.objective) && close(node.checksum, py.checksum);
  if (!ok) {
    throw new Error(`${workload}/${style}: results differ\n  node   ${JSON.stringify(node)}\n  python ${JSON.stringify(py)}`);
  }
}

const fmt = (ms) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));
const ratio = (py, node) => `${(py / node).toFixed(2)}×`;

function main() {
  const pyVersion = execFileSync(PYTHON, ['-I', '-c', 'import ortools,sys;print(ortools.__version__, sys.version.split()[0])'], { encoding: 'utf8' }).trim();
  const [ortoolsVersion, pythonVersion] = pyVersion.split(' ');
  console.log(`Machine: ${os.cpus()[0].model.trim()}, ${os.cpus().length} logical CPUs, ${os.type()} ${os.release()}`);
  console.log(`Runtimes: Node ${process.version}; Python ${pythonVersion} with ortools ${ortoolsVersion} (pywraplp)`);
  console.log(PIN ? `Both runtimes pinned to CPU ${CPU}.` : 'Not pinned to a CPU (no taskset); expect more variance.');
  console.log(`Median of ${REPEATS} runs after one warm-up. Ratio = Python time / Node time (>1 means Node is faster).\n`);
  console.log('| Workload | API style | Phase | Node ms | Python ms | Ratio |');
  console.log('|---|---|---|--:|--:|--:|');
  for (const workload of WORKLOADS) {
    for (const style of STYLES) {
      const node = summarise(runs(process.execPath, [path.join(__dirname, 'bench.js'), workload, style, String(REPEATS)]));
      const py = summarise(runs(PYTHON, ['-I', path.join(__dirname, 'bench.py'), workload, style, String(REPEATS)]));
      assertSameModel(workload, style, node.first, py.first);
      for (const phase of ['build', 'solve', 'read', 'total']) {
        const k = `${phase}Ms`;
        const label = phase === 'total' ? '**total**' : phase;
        console.log(`| ${workload} | ${style} | ${label} | ${fmt(node[k])} | ${fmt(py[k])} | ${ratio(py[k], node[k])} |`);
      }
    }
  }
}

main();
