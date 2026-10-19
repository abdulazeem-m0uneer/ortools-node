'use strict';
// Node side of the caby-dispatch parity benchmark: a line-for-line port of the spikes (node/*.js) run on
// the fixtures that gen_instances.py wrote.
//
// Usage: node bench/dispatch/run_node.js <suite> <flavor> [repeats] [fixtures_dir] [mode]
//   suite, flavor, repeats, fixtures_dir: as run_py.py
//   mode: span (SetAllowedVehiclesForIndex, default) | removevalues (the spike's Python 9.15 workaround)
// ORTOOLS_NODE_ADDON=/path/ortools_node.node runs another build (e.g. against OR-Tools 9.14).
// Prints one JSON object.

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ortoolsVersion } = require('./node/ortools');
const { DEFAULT_FIXTURES, loadFixture, Exact } = require('./node/common');
const t2 = require('./node/suites_t2');
const other = require('./node/suites_other');
const { exactModules } = require('./node/suites_modules');

const SUITES = {
  t1: [t2.spikeT1, t2.exactT1], t2a: [t2.spikeT2a, t2.exactT2a], t2b: [t2.spikeT2b, t2.exactT2b],
  t2c: [t2.spikeT2c, t2.exactT2c], t2d: [t2.spikeT2d, t2.exactT2d], t2e: [t2.spikeT2e, null], t2f: [t2.spikeT2f, null],
  t3: [other.spikeT3, other.exactT3], t4: [other.spikeT4, other.exactT4], t5: [other.spikeT5, null],
  t6: [other.spikeT6, other.exactT6], cpsat: [other.spikeCpsat, other.exactCpsat], modules: [null, exactModules],
};
const FIXTURE_OF = { t5: 't2d' };
const MODES = ['span', 'removevalues'];

async function main() {
  const [suite, flavor, repeatsArg, fixturesArg, mode = 'span'] = process.argv.slice(2);
  if (!(suite in SUITES) || !['spike', 'exact'].includes(flavor) || !MODES.includes(mode)) {
    throw new Error('usage: run_node.js <suite> <spike|exact> [repeats] [fixtures_dir] [span|removevalues]');
  }
  const repeats = repeatsArg ? Number(repeatsArg) : 5;
  const fixtures = fixturesArg ? path.resolve(fixturesArg) : DEFAULT_FIXTURES;
  const [spike, exact] = SUITES[suite];
  const fx = loadFixture(fixtures, FIXTURE_OF[suite] || suite);
  const out = {
    suite, flavor, runtime: 'node', ortools: ortoolsVersion, node: process.version, mode, fixture_meta: fx.meta,
  };
  const t0 = performance.now();
  if (flavor === 'spike' && spike !== null) {
    Object.assign(out, await spike(fx, mode));
  } else if (flavor === 'spike' || exact === null) {
    throw new Error(`${suite} has no ${flavor} flavor`);
  } else {
    const ex = new Exact(repeats);
    await exact(fx, ex, mode);
    Object.assign(out, ex.result(), { repeats });
  }
  out.wall_s = Math.round((performance.now() - t0) / 10) / 100;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
