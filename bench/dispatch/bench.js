'use strict';
// Runs the caby-dispatch spikes in Python (the spikes' own code, run_py.py) and Node (the port,
// run_node.js) on the same fixtures, for every OR-Tools pin, and saves the raw results that
// report.js turns into RESULTS.md.
//
// Setup once (see RESULTS.md for the exact versions used):
//   uv venv --python 3.13 bench/.venv-9.14 && uv pip install --python bench/.venv-9.14/bin/python ortools==9.14.6206 numpy
//   uv venv --python 3.13 bench/.venv-9.15 && uv pip install --python bench/.venv-9.15/bin/python ortools==9.15.6755 numpy
//   ORTOOLS_ROOT=<OR-Tools 9.14 C++> npx cmake-js compile --out build/v9.14     (the 9.15 build is build/)
//   bench/.venv-9.15/bin/python -I -B bench/dispatch/gen_instances.py          (needs CABY_DISPATCH_DIR)
// Run: npm run bench:dispatch -- [--suites t1,t2a] [--flavors spike,exact] [--runs py-9.15,...]
//        [--repeats 5] [--force]     (existing results are kept unless --force; RESULTS.md is rewritten)
// Overrides: DISPATCH_PY_914, DISPATCH_PY_915 (interpreters), DISPATCH_ADDON_914 (addon), BENCH_CPU.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pinnedCpu, hasTaskset, pinned } = require('../lib/cpu');

const ROOT = path.join(__dirname, '..', '..');
const RESULTS = path.join(__dirname, 'results');
const FIXTURES = path.join(__dirname, 'fixtures');

const PY = {
  '9.14': process.env.DISPATCH_PY_914 || path.join(ROOT, 'bench', '.venv-9.14', 'bin', 'python'),
  '9.15': process.env.DISPATCH_PY_915 || path.join(ROOT, 'bench', '.venv-9.15', 'bin', 'python'),
};
const ADDON = {
  '9.14': process.env.DISPATCH_ADDON_914 || path.join(ROOT, 'build', 'v9.14', 'Release', 'ortools_node.node'),
  '9.15': null,
};

/** Every runtime x pin x allowed-vehicles mode. Python's mode is whatever the spike falls back to. */
const RUNS = [
  { label: 'py-9.14', runtime: 'python', version: '9.14' },
  { label: 'py-9.15', runtime: 'python', version: '9.15' },
  { label: 'node-9.14-span', runtime: 'node', version: '9.14', mode: 'span' },
  { label: 'node-9.14-removevalues', runtime: 'node', version: '9.14', mode: 'removevalues' },
  { label: 'node-9.15-span', runtime: 'node', version: '9.15', mode: 'span' },
  { label: 'node-9.15-removevalues', runtime: 'node', version: '9.15', mode: 'removevalues' },
];
/** The spike flavour runs once per pin, in the allowed-vehicles mode Python uses there. */
const SPIKE_RUNS = new Set(['py-9.14', 'py-9.15', 'node-9.14-span', 'node-9.15-removevalues']);
const SUITES = ['t1', 't2a', 't2b', 't2c', 't2d', 't2e', 't2f', 't3', 't4', 't5', 't6', 'cpsat', 'modules'];
const SPIKE_SUITES = new Set(SUITES.filter((s) => s !== 'modules'));
const EXACT_SUITES = new Set(['t1', 't2a', 't2b', 't2c', 't2d', 't3', 't4', 't6', 'cpsat', 'modules']);
/** Suites whose spike flavour measures threads / processes / the event loop: never pinned to one CPU. */
const CONCURRENT = new Set(['t2f', 't4', 't5', 'cpsat']);

const unpinned = (suite, flavor) => flavor === 'spike' && CONCURRENT.has(suite);

function parseArgs(argv) {
  const opts = { suites: SUITES, flavors: ['spike', 'exact'], runs: RUNS.map((r) => r.label), repeats: 5, force: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--force') { opts.force = true; continue; }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--suites') opts.suites = value.split(',');
    else if (flag === '--flavors') opts.flavors = value.split(',');
    else if (flag === '--runs') opts.runs = value.split(',');
    else if (flag === '--repeats') opts.repeats = Number(value);
    else throw new Error(`unknown option ${flag}`);
  }
  for (const s of opts.suites) if (!SUITES.includes(s)) throw new Error(`unknown suite ${s}`);
  for (const r of opts.runs) if (!RUNS.some((x) => x.label === r)) throw new Error(`unknown run ${r}`);
  if (!(Number.isInteger(opts.repeats) && opts.repeats >= 1)) throw new Error('--repeats must be a positive integer');
  return opts;
}

/** The command line for one run of one suite, pinned unless the suite measures concurrency. */
function command(run, suite, flavor, repeats, cpu) {
  const env = { ...process.env, UV_THREADPOOL_SIZE: '8' };
  let cmd, args;
  if (run.runtime === 'python') {
    [cmd, args] = [PY[run.version], ['-I', '-B', path.join(__dirname, 'run_py.py'), suite, flavor, String(repeats), FIXTURES]];
  } else {
    [cmd, args] = [process.execPath, [path.join(__dirname, 'run_node.js'), suite, flavor, String(repeats), FIXTURES, run.mode]];
    if (ADDON[run.version]) env.ORTOOLS_NODE_ADDON = ADDON[run.version];
  }
  [cmd, args] = pinned(unpinned(suite, flavor) ? null : cpu, cmd, args);
  return { cmd, args, env };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(FIXTURES, 't1.json'))) {
    throw new Error(`no fixtures in ${FIXTURES}: run gen_instances.py first (see the header of this file)`);
  }
  const cpu = pinnedCpu();
  const pin = cpu !== null && hasTaskset() ? cpu : null;
  for (const flavor of opts.flavors) {
    for (const suite of opts.suites) {
      if (!(flavor === 'exact' ? EXACT_SUITES : SPIKE_SUITES).has(suite)) continue;
      for (const run of RUNS) {
        if (!opts.runs.includes(run.label) || (flavor === 'spike' && !SPIKE_RUNS.has(run.label))) continue;
        const file = path.join(RESULTS, run.label, `${suite}-${flavor}.json`);
        if (fs.existsSync(file) && !opts.force) continue;
        const { cmd, args, env } = command(run, suite, flavor, opts.repeats, pin);
        const t0 = Date.now();
        process.stderr.write(`${run.label} ${suite} ${flavor} ... `);
        let out;
        try {
          out = execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
        } catch (err) {
          throw new Error(`${run.label} ${suite} ${flavor} failed:\n${String(err.stderr).slice(-4000)}`);
        }
        const result = JSON.parse(out);
        Object.assign(result, { run: run.label, pinned_cpu: unpinned(suite, flavor) ? null : pin, finished: new Date().toISOString() });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(result));
        process.stderr.write(`${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
      }
    }
  }
  require('./report').writeReport(RESULTS);
}

if (require.main === module) main();

module.exports = { RUNS, SUITES, SPIKE_SUITES, EXACT_SUITES, SPIKE_RUNS, CONCURRENT, parseArgs, command };
