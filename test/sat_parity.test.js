'use strict';
// Known results reproduced from OR-Tools' Python examples, plus the semantics
// of every constraint type checked on small models.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CpModel, CpSolver, CpLinearExpr, Domain } = require('..');

// mulberry32: a small seeded generator, so the workload is the same everywhere.
function seededRandom(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function solveSync(model, parameters = {}) {
  const solver = new CpSolver();
  solver.parameters = { numWorkers: 1, ...parameters };
  return { solver, status: solver.solveSync(model) };
}

test('8-queens has 92 solutions (enumerate_all_solutions), like nqueens_sat.py', async () => {
  const n = 8;
  const m = new CpModel();
  const queens = Array.from({ length: n }, (_, i) => m.newIntVar(0, n - 1, `q${i}`));
  m.addAllDifferent(queens);
  m.addAllDifferent(queens.map((q, i) => q.plus(i)));
  m.addAllDifferent(queens.map((q, i) => q.minus(i)));
  const solver = new CpSolver();
  solver.parameters = { enumerateAllSolutions: true };
  const boards = new Set();
  const status = await solver.solve(m, {
    onSolution(s) {
      const rows = queens.map((q) => s.value(q));
      for (let i = 0; i < n; ++i) {
        for (let j = i + 1; j < n; ++j) assert.ok(rows[i] !== rows[j] && Math.abs(rows[i] - rows[j]) !== j - i);
      }
      boards.add(rows.join(','));
    },
  });
  assert.equal(status, 'OPTIMAL');
  assert.equal(boards.size, 92);
});

test('the minimal job shop of minimal_jobshop_sat.py has makespan 11', () => {
  const jobs = [[[0, 3], [1, 2], [2, 2]], [[0, 2], [2, 1], [1, 4]], [[1, 4], [2, 3]]];
  const horizon = jobs.flat().reduce((sum, [, d]) => sum + d, 0);
  const m = new CpModel();
  const perMachine = [[], [], []];
  const tasks = [];
  for (const job of jobs) {
    let previousEnd = null;
    for (const [machine, duration] of job) {
      const start = m.newIntVar(0, horizon, 'start');
      const end = m.newIntVar(0, horizon, 'end');
      perMachine[machine].push(m.newIntervalVar(start, duration, end, 'task'));
      tasks.push({ machine, start, end, duration });
      if (previousEnd) m.add(start.ge(previousEnd));
      previousEnd = end;
    }
  }
  for (const intervals of perMachine) m.addNoOverlap(intervals);
  const makespan = m.newIntVar(0, horizon, 'makespan');
  m.addMaxEquality(makespan, tasks.filter((_, i) => [2, 5, 7].includes(i)).map((t) => t.end));
  m.minimize(makespan);
  const { solver, status } = solveSync(m, { numWorkers: 8 });
  assert.equal(status, 'OPTIMAL');
  assert.equal(solver.objectiveValue, 11);
  for (const a of tasks) {
    assert.equal(solver.value(a.end) - solver.value(a.start), a.duration);
    for (const b of tasks) {
      if (a === b || a.machine !== b.machine) continue;
      assert.ok(solver.value(a.end) <= solver.value(b.start) || solver.value(b.end) <= solver.value(a.start));
    }
  }
});

function assignmentModel(n, seed) {
  const random = seededRandom(seed);
  const costs = Array.from({ length: n }, () => Array.from({ length: n }, () => 1 + Math.floor(random() * 100)));
  const m = new CpModel();
  const x = costs.map((row, i) => row.map((_, j) => m.newBoolVar(`x${i}_${j}`)));
  for (let i = 0; i < n; ++i) {
    m.addExactlyOne(x[i]);
    m.addExactlyOne(x.map((row) => row[i]));
  }
  m.minimize(CpLinearExpr.weightedSum(x.flat(), costs.flat()));
  return { m, x, costs };
}

test('dispatch spike: 40x40 assignment, one worker, short budget, yields a valid assignment', async () => {
  // The spike used a 0.3 s wall-clock limit; a deterministic budget of the
  // same order keeps the test independent of machine load.
  const n = 40;
  const { m, x, costs } = assignmentModel(n, 42);
  const solver = new CpSolver();
  solver.parameters = { maxDeterministicTime: 0.5, numWorkers: 1 };
  const status = await solver.solve(m);
  assert.ok(status === 'OPTIMAL' || status === 'FEASIBLE', status);
  let total = 0;
  for (let i = 0; i < n; ++i) {
    assert.equal(x[i].filter((v) => solver.booleanValue(v)).length, 1, `row ${i}`);
    assert.equal(x.filter((row) => solver.booleanValue(row[i])).length, 1, `column ${i}`);
    for (let j = 0; j < n; ++j) if (solver.booleanValue(x[i][j])) total += costs[i][j];
  }
  assert.equal(solver.objectiveValue, total);
  assert.ok(solver.bestObjectiveBound <= total);
});

test('40x40 assignment reaches the optimum Python finds (197) under a deterministic limit', () => {
  const { m } = assignmentModel(40, 42);
  const { solver, status } = solveSync(m, { maxDeterministicTime: 5 });
  assert.equal(status, 'OPTIMAL');
  assert.equal(solver.objectiveValue, 197);
});

test('element, inverse and all-different', () => {
  const m = new CpModel();
  const index = m.newIntVar(0, 3, 'index');
  const target = m.newIntVar(0, 100, 'target');
  m.addElement(index, [10, 40, 20, 30], target);
  m.maximize(target);
  const { solver } = solveSync(m);
  assert.equal(solver.value(index), 1);
  assert.equal(solver.value(target), 40);

  const m2 = new CpModel();
  const f = Array.from({ length: 4 }, (_, i) => m2.newIntVar(0, 3, `f${i}`));
  const g = Array.from({ length: 4 }, (_, i) => m2.newIntVar(0, 3, `g${i}`));
  m2.addInverse(f, g);
  m2.add(f[0].eq(2));
  m2.add(f[1].eq(3));
  m2.addAllDifferent(f);
  const r = solveSync(m2).solver;
  for (let i = 0; i < 4; ++i) assert.equal(r.value(g[r.value(f[i])]), i);
});

test('min, max, abs, multiplication, division and modulo equalities', () => {
  const m = new CpModel();
  const a = m.newConstant(-17);
  const b = m.newConstant(5);
  const results = {};
  for (const name of ['min', 'max', 'abs', 'prod', 'div', 'mod', 'divNeg', 'modNeg']) {
    results[name] = m.newIntVar(-1000, 1000, name);
  }
  m.addMinEquality(results.min, [a, b, 3]);
  m.addMaxEquality(results.max, [a, b, 3]);
  m.addAbsEquality(results.abs, a);
  m.addMultiplicationEquality(results.prod, a, b, 2);
  m.addDivisionEquality(results.div, CpLinearExpr.constant(17), b);
  m.addModuloEquality(results.mod, 17, b);
  m.addDivisionEquality(results.divNeg, a, b);
  m.addModuloEquality(results.modNeg, a, b);
  const { solver, status } = solveSync(m);
  assert.equal(status, 'OPTIMAL');
  const values = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, solver.value(v)]));
  assert.deepEqual(values, { min: -17, max: 5, abs: 17, prod: -170, div: 3, mod: 2, divNeg: -3, modNeg: -2 });
});

test('circuit: a 4-city tour of minimal length', () => {
  const dist = [[0, 2, 9, 10], [1, 0, 6, 4], [15, 7, 0, 8], [6, 3, 12, 0]];
  const m = new CpModel();
  const arcs = [];
  const terms = [];
  for (let i = 0; i < 4; ++i) {
    for (let j = 0; j < 4; ++j) {
      if (i === j) continue;
      const lit = m.newBoolVar(`${i}->${j}`);
      arcs.push([i, j, lit]);
      terms.push(lit.times(dist[i][j]));
    }
  }
  m.addCircuit(arcs);
  m.minimize(CpLinearExpr.sum(terms));
  const { solver } = solveSync(m);
  assert.equal(solver.objectiveValue, 21);  // 0 -> 2 -> 3 -> 1 -> 0
  assert.equal(arcs.filter(([, , lit]) => solver.booleanValue(lit)).length, 4);
});

test('multiple circuit: two routes leave the depot, every other node is visited once', () => {
  const m = new CpModel();
  const arcs = [];
  for (let i = 0; i < 4; ++i) for (let j = 0; j < 4; ++j) if (i !== j) arcs.push([i, j, m.newBoolVar(`${i}-${j}`)]);
  m.addMultipleCircuit(arcs);
  const arc = (t, h) => arcs.find(([a, b]) => a === t && b === h)[2];
  m.add(arc(0, 1).eq(1));  // two routes through the depot: infeasible for a single circuit
  m.add(arc(0, 2).eq(1));
  assert.deepEqual(m.toJSON().constraints[0], {
    routes: { tails: arcs.map(([t]) => t), heads: arcs.map(([, h]) => h), literals: arcs.map(([, , l]) => l.index) },
  });
  const { solver, status } = solveSync(m);
  assert.equal(status, 'OPTIMAL');
  assert.equal(arcs.filter(([t, , lit]) => t === 0 && solver.booleanValue(lit)).length, 2);
  for (let node = 1; node < 4; ++node) {
    assert.equal(arcs.filter(([t, , lit]) => t === node && solver.booleanValue(lit)).length, 1);
    assert.equal(arcs.filter(([, h, lit]) => h === node && solver.booleanValue(lit)).length, 1);
  }
});

test('allowed and forbidden assignments', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 9, 'x');
  const y = m.newIntVar(0, 9, 'y');
  m.addAllowedAssignments([x, y], [[1, 2], [3, 4], [5, 6]]);
  m.addForbiddenAssignments([x, y], [[5, 6]]);
  m.maximize(x);
  const { solver } = solveSync(m);
  assert.deepEqual([solver.value(x), solver.value(y)], [3, 4]);
});

test('automaton: words over {0, 1} with no two consecutive 1s', () => {
  const m = new CpModel();
  const letters = Array.from({ length: 6 }, (_, i) => m.newIntVar(0, 1, `l${i}`));
  // state 0: last letter 0; state 1: last letter 1
  m.addAutomaton(letters, 0, [0, 1], [[0, 0, 0], [0, 1, 1], [1, 0, 0]]);
  m.maximize(CpLinearExpr.sum(letters));
  const { solver } = solveSync(m);
  assert.equal(solver.objectiveValue, 3);
  const word = letters.map((l) => solver.value(l)).join('');
  assert.ok(!word.includes('11'), word);
});

test('reservoir: the level never drops below 0', () => {
  const m = new CpModel();
  const fill = m.newIntVar(0, 10, 'fill');
  const drain = m.newIntVar(0, 10, 'drain');
  m.addReservoirConstraint([fill, drain], [5, -5], 0, 5);
  m.minimize(drain);
  assert.equal(solveSync(m).solver.value(drain), 0);  // both at time 0: the level stays at 0
  m.add(fill.eq(4));
  assert.equal(solveSync(m).solver.value(drain), 4);

  const m2 = new CpModel();
  const t = m2.newIntVar(0, 10, 't');
  const on = m2.newBoolVar('on');
  m2.addReservoirConstraintWithActive([t], [-3], [on], -2, 0);  // draining 3 below -2 is only possible inactive
  m2.maximize(on);
  const r = solveSync(m2).solver;
  assert.equal(r.booleanValue(on), false);
});

test('cumulative and optional intervals', () => {
  const m = new CpModel();
  const tasks = [3, 2, 4].map((size, i) => {
    const start = m.newIntVar(0, 10, `s${i}`);
    return { start, size, interval: m.newFixedSizeIntervalVar(start, size, `t${i}`) };
  });
  m.addCumulative(tasks.map((t) => t.interval), [2, 2, 2], 4);
  const end = m.newIntVar(0, 20, 'end');
  m.addMaxEquality(end, tasks.map((t) => t.start.plus(t.size)));
  m.minimize(end);
  assert.equal(solveSync(m).solver.objectiveValue, 5);  // two machines' worth: {3, 2} and {4}

  const m2 = new CpModel();
  const s = m2.newIntVar(0, 5, 's');
  const present = m2.newBoolVar('present');
  const optional = m2.newOptionalFixedSizeIntervalVar(s, 4, present, 'optional');
  const fixed = m2.newFixedSizeIntervalVar(m2.newConstant(0), 6, 'fixed');
  m2.addNoOverlap([optional, fixed]);
  m2.maximize(present);  // starting at s <= 5, it would overlap the fixed block [0, 6)
  assert.equal(solveSync(m2).solver.booleanValue(present), false);
});

test('NoOverlap2D packs two 2x2 squares into a 4x2 box', () => {
  const m = new CpModel();
  const boxes = [0, 1].map((i) => {
    const x = m.newIntVar(0, 2, `x${i}`);
    const y = m.newIntVar(0, 0, `y${i}`);
    return { x, y, xi: m.newFixedSizeIntervalVar(x, 2, `xi${i}`), yi: m.newFixedSizeIntervalVar(y, 2, `yi${i}`) };
  });
  m.addNoOverlap2D(boxes.map((b) => b.xi), boxes.map((b) => b.yi));
  const { solver, status } = solveSync(m);
  assert.equal(status, 'OPTIMAL');
  assert.equal(Math.abs(solver.value(boxes[0].x) - solver.value(boxes[1].x)), 2);
});

test('linear constraints over a Domain with holes', () => {
  const m = new CpModel();
  const x = m.newIntVarFromDomain(Domain.fromIntervals([[0, 3], [7, 9]]), 'x');
  m.addLinearExpressionInDomain(x.times(2), Domain.fromValues([4, 6, 14, 20]));
  m.maximize(x);
  assert.equal(solveSync(m).solver.value(x), 7);
});

test('Boolean constraints: xor, implications and enforcement', () => {
  const m = new CpModel();
  const [a, b, c] = ['a', 'b', 'c'].map((n) => m.newBoolVar(n));
  m.addBoolXor([a, b, c]);
  m.addImplication(a, b);
  m.addAtMostOne([b, c]);
  const x = m.newIntVar(0, 10, 'x');
  m.add(x.eq(7)).onlyEnforceIf(c);
  m.add(x.eq(3)).onlyEnforceIf(c.not());
  m.maximize(x.plus(CpLinearExpr.weightedSum([a, b, c], [1, 1, 1])));
  const { solver } = solveSync(m);
  // xor is odd: {c} alone (x = 7) beats {a, b, c} (excluded by at-most-one).
  assert.deepEqual([a, b, c].map((v) => solver.booleanValue(v)), [false, false, true]);
  assert.equal(solver.value(x), 7);
});
