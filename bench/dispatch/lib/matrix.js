'use strict';
// What the dispatch benchmark runs: shared by bench.js (runs it) and report.js (tabulates it).

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
/** Spike suites that record only metrics, no per-case signatures: an empty case list is expected there. */
const METRICS_ONLY = new Set(['t2f', 't4', 't6', 'cpsat']);

module.exports = { RUNS, SPIKE_RUNS, SUITES, SPIKE_SUITES, EXACT_SUITES, CONCURRENT, METRICS_ONLY };
