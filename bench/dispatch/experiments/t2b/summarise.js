'use strict';
// node summarise.js <label>=<run_py/run_node t2b exact output.json> ... > results.json
// Keeps what the t2b analysis needs from each raw run: phase p50s and the per-case median solve time, in
// fixture case order, so any two configurations can be compared case by case (see ratios.js).
const fs = require('node:fs');
const { median } = require('../../../lib/stats');

const round = (ms) => Math.round(ms * 100) / 100;

/** {cases, repeats, build/solve/read p50 ms, solve_case_median_ms} of one raw t2b exact run. */
function summariseRun(raw) {
  const [workload, timings] = Object.entries(raw.timings)[0] ?? [];
  if (!timings || !raw.cases.length) throw new Error('no t2b timings in this result');
  const n = raw.cases.length;
  const perCase = Array.from({ length: n }, () => []);
  timings.forEach((t, i) => perCase[i % n].push(t[1])); // passes record the cases in the same order
  const phase = (k) => round(median(timings.map((t) => t[k])));
  return {
    workload, runtime: raw.runtime, ortools: raw.ortools, mode: raw.mode, cases: n, repeats: timings.length / n,
    unstable: raw.unstable.length, build_p50_ms: phase(0), solve_p50_ms: phase(1), read_p50_ms: phase(2),
    solve_case_median_ms: perCase.map((xs) => round(median(xs))),
  };
}

function main(args) {
  if (!args.length) throw new Error('usage: node summarise.js <label>=<file.json> ...');
  const out = {};
  for (const arg of args) {
    const at = arg.indexOf('=');
    if (at < 1) throw new Error(`expected <label>=<file.json>, got ${arg}`);
    out[arg.slice(0, at)] = summariseRun(JSON.parse(fs.readFileSync(arg.slice(at + 1), 'utf8')));
  }
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { summariseRun };
