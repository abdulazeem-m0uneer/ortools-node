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
//        [--repeats 5] [--force] [--results dir]   (existing results are kept unless --force; the report
//        is rewritten: bench/dispatch/RESULTS.md, or <dir>/RESULTS.md with --results)
// Overrides: DISPATCH_PY_914, DISPATCH_PY_915 (interpreters), DISPATCH_ADDON_914 (addon), BENCH_CPU.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pinnedCpu, hasTaskset, pinned } = require('../lib/cpu');
const { RUNS, SPIKE_RUNS, SUITES, SPIKE_SUITES, EXACT_SUITES, CONCURRENT } = require('./lib/matrix');
const { writeReport } = require('./report');

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

const unpinned = (suite, flavor) => flavor === 'spike' && CONCURRENT.has(suite);

function parseArgs(argv) {
  const opts = {
    suites: SUITES, flavors: ['spike', 'exact'], runs: RUNS.map((r) => r.label), repeats: 5, force: false, results: RESULTS,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--force') { opts.force = true; continue; }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--suites') opts.suites = value.split(',');
    else if (flag === '--flavors') opts.flavors = value.split(',');
    else if (flag === '--runs') opts.runs = value.split(',');
    else if (flag === '--repeats') opts.repeats = Number(value);
    else if (flag === '--results') opts.results = path.resolve(value);
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
  const cpu = pinnedCpu();
  const pin = cpu !== null && hasTaskset() ? cpu : null;
  for (const flavor of opts.flavors) {
    for (const suite of opts.suites) {
      if (!(flavor === 'exact' ? EXACT_SUITES : SPIKE_SUITES).has(suite)) continue;
      for (const run of RUNS) {
        if (!opts.runs.includes(run.label) || (flavor === 'spike' && !SPIKE_RUNS.has(run.label))) continue;
        const file = path.join(opts.results, run.label, `${suite}-${flavor}.json`);
        if (fs.existsSync(file) && !opts.force) continue;
        if (!fs.existsSync(path.join(FIXTURES, `${suite === 't5' ? 't2d' : suite}.json`))) {
          throw new Error(`no ${suite} fixture in ${FIXTURES}: run gen_instances.py first (see the header of this file)`);
        }
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
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(result)); // a full disk must not leave a truncated result
        fs.renameSync(`${file}.tmp`, file);
        process.stderr.write(`${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
      }
    }
  }
  // The default results feed the committed RESULTS.md; any other directory gets its own report.
  writeReport(opts.results, opts.results === RESULTS ? undefined : path.join(opts.results, 'RESULTS.md'));
}

if (require.main === module) main();

module.exports = { parseArgs, command };
