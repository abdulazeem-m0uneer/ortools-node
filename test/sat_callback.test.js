'use strict';
// solve(model, { onSolution }): solutions reach JS while the search runs. A
// leaked thread-safe function would keep the event loop (and this file) alive.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CpModel, CpSolver, CpLinearExpr, SolutionSnapshot } = require('..');

function boolModel(n) {
  const m = new CpModel();
  const vars = Array.from({ length: n }, (_, i) => m.newBoolVar(`b${i}`));
  return { m, vars };
}

test('every solution of an enumeration reaches the callback before solve() resolves', async () => {
  const { m, vars } = boolModel(10);
  const solver = new CpSolver();
  solver.parameters = { enumerateAllSolutions: true };
  const seen = new Set();
  const indices = [];
  const status = await solver.solve(m, {
    onSolution(s) {
      assert.ok(s instanceof SolutionSnapshot);
      indices.push(s.solutionIndex);
      seen.add(vars.map((v) => (s.booleanValue(v) ? 1 : 0)).join(''));
    },
  });
  assert.equal(status, 'OPTIMAL');
  assert.equal(seen.size, 1024);
  assert.deepEqual(indices, Array.from({ length: 1024 }, (_, i) => i));
});

test('snapshots carry objective, bound, timing and values that stay readable later', async () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 50, 'x');
  const y = m.newIntVar(0, 50, 'y');
  m.add(x.plus(y).ge(30));
  m.minimize(x.times(3).plus(y.times(2)));
  const solver = new CpSolver();
  solver.parameters = { numWorkers: 1 };
  const snapshots = [];
  assert.equal(await solver.solve(m, { onSolution: (s) => snapshots.push(s) }), 'OPTIMAL');
  assert.ok(snapshots.length >= 1);
  for (let i = 0; i < snapshots.length; ++i) {
    const s = snapshots[i];
    assert.equal(s.solutionIndex, i);
    assert.ok(s.value(x) + s.value(y) >= 30);
    assert.equal(s.objectiveValue, s.value(x.times(3).plus(y.times(2))));
    assert.ok(s.bestObjectiveBound <= s.objectiveValue);
    assert.ok(s.wallTime >= 0 && s.userTime >= 0 && s.deterministicTime >= 0);
    if (i > 0) assert.ok(s.objectiveValue < snapshots[i - 1].objectiveValue);
  }
  const last = snapshots.at(-1);
  assert.equal(last.objectiveValue, solver.objectiveValue);
  assert.equal(last.value(x), solver.value(x));
  assert.throws(() => { last.objectiveValue = 0; }, TypeError);
  assert.throws(() => last.value(new CpModel().newIntVar(0, 1, 'z')), /different CpModel/);
});

test('stopSearch() inside the callback stops before the next solution', async () => {
  const { m } = boolModel(20);
  const solver = new CpSolver();
  solver.parameters = { enumerateAllSolutions: true };
  let count = 0;
  const status = await solver.solve(m, {
    onSolution() {
      count += 1;
      if (count === 3) assert.equal(solver.stopSearch(), true);
    },
  });
  assert.equal(status, 'FEASIBLE');
  assert.equal(count, 3);
});

test('a callback that throws stops the search and rejects with that exception', async () => {
  const { m } = boolModel(20);
  const solver = new CpSolver();
  solver.parameters = { enumerateAllSolutions: true };
  const boom = new Error('boom');
  let count = 0;
  await assert.rejects(solver.solve(m, { onSolution() { count += 1; throw boom; } }), (e) => e === boom);
  assert.equal(count, 1);
  assert.equal(solver.busy, false);
  assert.throws(() => solver.statusName(), /No solve result/);
  // The solver is usable again.
  assert.equal(await solver.solve(boolModel(2).m), 'OPTIMAL');
});

test('a thrown non-Error value is passed through as the rejection reason', async () => {
  const solver = new CpSolver();
  await assert.rejects(solver.solve(boolModel(2).m, { onSolution() { throw 'plain string'; } }),
    (e) => e === 'plain string');
});

test('reading the solver inside the callback throws busy (use the snapshot instead)', async () => {
  const { m, vars } = boolModel(2);
  const solver = new CpSolver();
  let message;
  await solver.solve(m, {
    onSolution(s) {
      try {
        solver.value(vars[0]);
      } catch (e) {
        message = e.message;
      }
      s.booleanValue(vars[0]);
    },
  });
  assert.match(message, /busy/);
});

test('callbacks from a multi-worker search arrive one at a time with improving objectives', async () => {
  const n = 12;
  const m = new CpModel();
  const x = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => m.newBoolVar(`x${i}_${j}`)));
  for (let i = 0; i < n; ++i) {
    m.addExactlyOne(x[i]);
    m.addExactlyOne(x.map((row) => row[i]));
  }
  const cost = (i, j) => ((i * 7 + j * 13) % 17) + 1;
  m.minimize(CpLinearExpr.weightedSum(x.flat(), x.flatMap((row, i) => row.map((_, j) => cost(i, j)))));
  const solver = new CpSolver();
  solver.parameters = { numWorkers: 8, maxTimeInSeconds: 10 };
  const objectives = [];
  let inCallback = false;
  const status = await solver.solve(m, {
    onSolution(s) {
      assert.equal(inCallback, false);
      inCallback = true;
      objectives.push(s.objectiveValue);
      for (let i = 0; i < n; ++i) assert.equal(x[i].filter((v) => s.booleanValue(v)).length, 1);
      inCallback = false;
    },
  });
  assert.equal(status, 'OPTIMAL');
  assert.ok(objectives.length >= 1);
  for (let i = 1; i < objectives.length; ++i) assert.ok(objectives[i] < objectives[i - 1]);
  assert.equal(objectives.at(-1), solver.objectiveValue);
});

test('concurrent solves each deliver to their own callback', async () => {
  const runs = [3, 4, 5].map((n) => {
    const { m } = boolModel(n);
    const solver = new CpSolver();
    solver.parameters = { enumerateAllSolutions: true };
    const run = { n, count: 0 };
    run.pending = solver.solve(m, { onSolution: () => { run.count += 1; } });
    return run;
  });
  for (const run of runs) {
    assert.equal(await run.pending, 'OPTIMAL');
    assert.equal(run.count, 2 ** run.n);
  }
});

test('an infeasible or invalid model never calls the callback', async () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 3, 'x');
  m.add(x.gt(3));
  const solver = new CpSolver();
  let called = false;
  assert.equal(await solver.solve(m, { onSolution: () => { called = true; } }), 'INFEASIBLE');
  const bad = new CpModel();
  bad.newIntVar(3, 1, 'empty');
  await assert.rejects(solver.solve(bad, { onSolution: () => { called = true; } }), /Invalid CpModel/);
  assert.equal(called, false);
});
