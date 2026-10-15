'use strict';
// Node side of the ortools-node vs Python (pywraplp) benchmark.
// Usage: node bench/bench.js <workload> <style> <repeats>
// Prints one JSON line per run: { buildMs, solveMs, readMs, status, objective, checksum }.
// bench/bench.py must stay a line-for-line mirror of this file.

const { Solver } = require('..');

// mulberry32: same integer sequence as the Python port, so both build identical models.
function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const now = () => Number(process.hrtime.bigint()) / 1e6;

function transportData(S, D) {
  const r = rng(1);
  const supply = Array.from({ length: S }, () => (r() % 100) + 50);
  const demand = Array.from({ length: D }, () => (r() % 100) + 1);
  const cost = Array.from({ length: S }, () => Array.from({ length: D }, () => (r() % 100) + 1));
  return { S, D, supply, demand, cost };
}

function knapsackData(n, m) {
  const r = rng(2);
  const value = Array.from({ length: n }, () => (r() % 100) + 1);
  const weight = Array.from({ length: m }, () => Array.from({ length: n }, () => (r() % 100) + 1));
  const capacity = weight.map((w) => Math.floor(w.reduce((p, q) => p + q, 0) / 2));
  return { n, m, value, weight, capacity };
}

function smallLpData(count) {
  const r = rng(3);
  return Array.from({ length: count }, () => ({
    obj: Array.from({ length: 10 }, () => (r() % 10) + 1),
    rows: Array.from({ length: 5 }, () => ({
      coef: Array.from({ length: 10 }, () => (r() % 10) + 1),
      rhs: (r() % 50) + 20,
    })),
  }));
}

// Each builder returns { solver, read } where read() sums all variable values.

const transport = {
  idiomatic(d) {
    const s = new Solver('GLOP');
    const x = d.cost.map((row, i) => row.map((_, j) => s.numVar(0, Infinity, `x_${i}_${j}`)));
    for (let i = 0; i < d.S; i++) s.addLessEq(x[i].map((v) => [v, 1]), d.supply[i]);
    for (let j = 0; j < d.D; j++) s.addGreaterEq(x.map((row) => [row[j], 1]), d.demand[j]);
    const obj = [];
    for (let i = 0; i < d.S; i++) for (let j = 0; j < d.D; j++) obj.push([x[i][j], d.cost[i][j]]);
    s.minimize(obj);
    return { solver: s, read: () => x.flat().reduce((acc, v) => acc + v.value(), 0) };
  },
  lowlevel(d) {
    const s = new Solver('GLOP');
    const n = s._n;
    const x = [];
    for (let i = 0; i < d.S; i++) {
      x.push([]);
      for (let j = 0; j < d.D; j++) x[i].push(n.addVariable(0, Infinity, false, `x_${i}_${j}`));
    }
    for (let i = 0; i < d.S; i++) {
      const c = n.addConstraint(-Infinity, d.supply[i], `s${i}`);
      for (let j = 0; j < d.D; j++) n.setConstraintCoefficient(c, x[i][j], 1);
    }
    for (let j = 0; j < d.D; j++) {
      const c = n.addConstraint(d.demand[j], Infinity, `d${j}`);
      for (let i = 0; i < d.S; i++) n.setConstraintCoefficient(c, x[i][j], 1);
    }
    for (let i = 0; i < d.S; i++) for (let j = 0; j < d.D; j++) n.setObjectiveCoefficient(x[i][j], d.cost[i][j]);
    n.setObjectiveSense(false);
    return { solver: s, read: () => x.flat().reduce((acc, vi) => acc + n.variableValue(vi), 0) };
  },
};

const knapsack = {
  idiomatic(d) {
    const s = new Solver('SCIP');
    const x = d.value.map((_, j) => s.boolVar(`x${j}`));
    for (let k = 0; k < d.m; k++) s.addLessEq(x.map((v, j) => [v, d.weight[k][j]]), d.capacity[k]);
    s.maximize(x.map((v, j) => [v, d.value[j]]));
    return { solver: s, read: () => x.reduce((acc, v) => acc + v.value(), 0) };
  },
  lowlevel(d) {
    const s = new Solver('SCIP');
    const n = s._n;
    const x = d.value.map((_, j) => n.addVariable(0, 1, true, `x${j}`));
    for (let k = 0; k < d.m; k++) {
      const c = n.addConstraint(-Infinity, d.capacity[k], `c${k}`);
      for (let j = 0; j < d.n; j++) n.setConstraintCoefficient(c, x[j], d.weight[k][j]);
    }
    for (let j = 0; j < d.n; j++) n.setObjectiveCoefficient(x[j], d.value[j]);
    n.setObjectiveSense(true);
    return { solver: s, read: () => x.reduce((acc, vi) => acc + n.variableValue(vi), 0) };
  },
};

const smallLp = {
  idiomatic(m) {
    const s = new Solver('GLOP');
    const x = m.obj.map((_, j) => s.numVar(0, 10, `x${j}`));
    for (const row of m.rows) s.addLessEq(x.map((v, j) => [v, row.coef[j]]), row.rhs);
    s.maximize(x.map((v, j) => [v, m.obj[j]]));
    return { solver: s, read: () => x.reduce((acc, v) => acc + v.value(), 0) };
  },
  lowlevel(m) {
    const s = new Solver('GLOP');
    const n = s._n;
    const x = m.obj.map((_, j) => n.addVariable(0, 10, false, `x${j}`));
    m.rows.forEach((row, k) => {
      const c = n.addConstraint(-Infinity, row.rhs, `c${k}`);
      for (let j = 0; j < 10; j++) n.setConstraintCoefficient(c, x[j], row.coef[j]);
    });
    for (let j = 0; j < 10; j++) n.setObjectiveCoefficient(x[j], m.obj[j]);
    n.setObjectiveSense(true);
    return { solver: s, read: () => x.reduce((acc, vi) => acc + n.variableValue(vi), 0) };
  },
};

// One measured run of a single model: build, solve, read back.
function runOne(builder, data) {
  const t0 = now();
  const { solver, read } = builder(data);
  const t1 = now();
  const r = solver.solveSync();
  const t2 = now();
  const checksum = read();
  const t3 = now();
  solver.dispose();  // untimed; Python frees its solver by refcount at the same point
  return { buildMs: t1 - t0, solveMs: t2 - t1, readMs: t3 - t2, status: r.status, objective: r.objectiveValue, checksum };
}

const WORKLOADS = {
  'transport-100': (style) => { const d = transportData(100, 100); return () => runOne(transport[style], d); },
  'transport-400': (style) => { const d = transportData(400, 400); return () => runOne(transport[style], d); },
  'knapsack-scip': (style) => { const d = knapsackData(50, 5); return () => runOne(knapsack[style], d); },
  'small-lp-x2000': (style) => {
    const models = smallLpData(2000);
    return () => {
      const total = { buildMs: 0, solveMs: 0, readMs: 0, status: 'OPTIMAL', objective: 0, checksum: 0 };
      for (const m of models) {
        const r = runOne(smallLp[style], m);
        total.buildMs += r.buildMs; total.solveMs += r.solveMs; total.readMs += r.readMs;
        total.objective += r.objective; total.checksum += r.checksum;
        if (r.status !== 'OPTIMAL') total.status = r.status;
      }
      return total;
    };
  },
};

function main() {
  const [workload, style, repeats = '5'] = process.argv.slice(2);
  if (!WORKLOADS[workload] || !transport[style]) {
    console.error(`usage: bench.js <${Object.keys(WORKLOADS).join('|')}> <idiomatic|lowlevel> [repeats]`);
    process.exit(2);
  }
  const run = WORKLOADS[workload](style);  // data generation is not timed
  run();  // warm-up
  for (let i = 0; i < Number(repeats); i++) console.log(JSON.stringify(run()));
}

main();
