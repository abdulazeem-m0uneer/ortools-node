'use strict';
// The non-dispatch modules against Python (mirror of run_py.py's exact_modules): knapsack, set cover,
// max flow and math_opt on the modules fixture.

const { performance } = require('node:perf_hooks');
const { KnapsackSolver, SimpleMaxFlow, setCover, mathOpt } = require('./ortools');
const { msSince } = require('./common');

const phases = (t0, t1, t2) => [t1 - t0, t2 - t1, msSince(t2)];

async function knapsack(d, kind) {
  const t0 = performance.now();
  const s = new KnapsackSolver(kind, 'kp');
  s.init(d.profits, d.weights, d.capacities);
  const t1 = performance.now(); const profit = await s.solve(); const t2 = performance.now();
  const selected = [];
  for (let i = 0; i < d.profits.length; i++) if (s.bestSolutionContains(i)) selected.push(i);
  const ms = phases(t0, t1, t2);
  s.dispose();
  return [{ profit, selected }, ms];
}

async function setCoverGreedySteepest(d) {
  const t0 = performance.now();
  const m = new setCover.SetCoverModel();
  for (const [cost, elements] of d.subsets) {
    m.addEmptySubset(cost);
    for (const e of elements) m.addElementToLastSubset(e);
  }
  const inv = new setCover.SetCoverInvariant(m);
  const t1 = performance.now();
  await new setCover.GreedySolutionGenerator(inv).nextSolution();
  await new setCover.SteepestSearch(inv).nextSolution();
  const t2 = performance.now();
  const selected = [];
  inv.isSelected().forEach((x, i) => { if (x) selected.push(i); });
  const out = { cost: inv.cost(), selected };
  const ms = phases(t0, t1, t2);
  inv.dispose();
  return [out, ms];
}

async function maxFlowSolve(d) {
  const t0 = performance.now();
  const f = new SimpleMaxFlow();
  f.addArcsWithCapacity(d.tails, d.heads, d.caps);
  const t1 = performance.now(); const st = await f.solve(0, d.nodes - 1); const t2 = performance.now();
  let checksum = 0n;
  f.flows().forEach((x, i) => { checksum += BigInt(i + 1) * BigInt(x); });
  const out = { status: st, flow: f.optimalFlow(), checksum: Number(checksum % 1_000_000_007n) };
  const ms = phases(t0, t1, t2);
  f.dispose();
  return [out, ms];
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

async function mathOptTransport(d) {
  const t0 = performance.now();
  const S = d.supply.length, D = d.demand.length;
  const m = new mathOpt.Model('transport');
  const x = Array.from({ length: S }, () => Array.from({ length: D }, () => m.addVariable({ lb: 0 })));
  for (let i = 0; i < S; i++) m.addLinearConstraint(mathOpt.LinearExpr.sum(x[i]).le(d.supply[i]));
  for (let j = 0; j < D; j++) m.addLinearConstraint(mathOpt.LinearExpr.sum(x.map((row) => row[j])).ge(d.demand[j]));
  m.minimize(mathOpt.LinearExpr.weightedSum(x.flat(), d.cost.flat()));
  const t1 = performance.now(); const r = await mathOpt.solve(m, 'GLOP'); const t2 = performance.now();
  const total = r.variableValues(x.flat()).reduce((a, b) => a + b, 0);
  const out = { reason: r.termination.reason, objective: round6(r.objectiveValue()), shipped: round6(total) };
  return [out, phases(t0, t1, t2)];
}

async function mathOptKnapsack(d) {
  const t0 = performance.now();
  const n = d.profits.length;
  const m = new mathOpt.Model('knapsack');
  const x = Array.from({ length: n }, () => m.addBinaryVariable());
  d.weights.forEach((w, k) => m.addLinearConstraint(mathOpt.LinearExpr.weightedSum(x, w).le(d.capacities[k])));
  m.maximize(mathOpt.LinearExpr.weightedSum(x, d.profits));
  const parameters = { threads: 1, randomSeed: 1 };
  const t1 = performance.now(); const r = await mathOpt.solve(m, 'CP_SAT', { parameters }); const t2 = performance.now();
  return [{ reason: r.termination.reason, objective: round6(r.objectiveValue()) }, phases(t0, t1, t2)];
}

async function exactModules(fx, ex) {
  for (const _ of ex.passes()) {
    ex.record('knapsack 60 items x 3 dims, branch and bound', 'md',
      ...await knapsack(fx.knapsack_md, 'KNAPSACK_MULTIDIMENSION_BRANCH_AND_BOUND_SOLVER'));
    ex.record('knapsack 500 items, dynamic programming', 'dp',
      ...await knapsack(fx.knapsack_dp, 'KNAPSACK_DYNAMIC_PROGRAMMING_SOLVER'));
    ex.record('set cover 1000 x 6000, greedy + steepest', 'cover', ...await setCoverGreedySteepest(fx.set_cover));
    ex.record('max flow 5000 nodes x 50000 arcs', 'flow', ...await maxFlowSolve(fx.max_flow));
    ex.record('math_opt transport 100x100 LP, GLOP', 'lp', ...await mathOptTransport(fx.transport));
    ex.record('math_opt knapsack 60x3 MIP, CP-SAT 1 thread', 'mip', ...await mathOptKnapsack(fx.knapsack_md));
  }
}

module.exports = { exactModules };
