'use strict';
// node counters.js [span|removevalues]: branches, failures, solutions and wall ms of the first 4 t2b solves
// (Node); compare with counters.py, which solves the same cases in Python.
const path = require('node:path');

const NODE = path.join(__dirname, '..', '..', 'node');
const caby = require(path.join(NODE, 'caby_model'));
const { instance, loadFixture, DEFAULT_FIXTURES } = require(path.join(NODE, 'common'));
const { RoutingModel } = require(path.join(NODE, 'ortools'));

const mode = process.argv[2] || 'removevalues';
for (const name of ['solveWithParameters', 'solveFromAssignmentWithParameters']) {
  const solve = RoutingModel.prototype[name];
  RoutingModel.prototype[name] = async function counted(...args) {
    const out = await solve.apply(this, args);
    const s = this.solver();
    console.log('node', s.branches(), s.failures(), s.solutions(), s.wallTime());
    return out;
  };
}

(async () => {
  const fx = loadFixture(DEFAULT_FIXTURES, 't2b');
  for (const c of fx.cases.slice(0, 4)) {
    const [buses, newcomers] = instance(c);
    await caby.solve(buses, newcomers, { warm: true, timeLimitMs: 5000, ls: 'GUIDED_LOCAL_SEARCH', solutionLimit: 50, mode });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
