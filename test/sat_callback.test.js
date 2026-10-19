'use strict';
// solve(model, { onSolution }): solutions reach JS while the search runs. A
// leaked thread-safe function would keep the event loop (and this file) alive.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CpModel, CpSolver, CpLinearExpr, SolutionSnapshot, native } = require('..');

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
  // A 15x15 assignment with spread-out costs: one worker finds several
  // improving solutions before proving the optimum.
  const n = 15;
  const m = new CpModel();
  const x = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => m.newBoolVar(`x${i}_${j}`)));
  for (let i = 0; i < n; ++i) {
    m.addExactlyOne(x[i]);
    m.addExactlyOne(x.map((row) => row[i]));
  }
  const costs = x.flat().map((_, k) => ((k * 7919) % 997) + 1);
  const objective = CpLinearExpr.weightedSum(x.flat(), costs);
  m.minimize(objective);
  const solver = new CpSolver();
  solver.parameters = { numWorkers: 1 };
  const snapshots = [];
  assert.equal(await solver.solve(m, { onSolution: (s) => snapshots.push(s) }), 'OPTIMAL');
  assert.ok(snapshots.length >= 2, `${snapshots.length} solution(s): the improvement check needs several`);
  for (let i = 0; i < snapshots.length; ++i) {
    const s = snapshots[i];
    assert.equal(s.solutionIndex, i);
    for (let r = 0; r < n; ++r) assert.equal(x[r].filter((v) => s.booleanValue(v)).length, 1);
    assert.equal(s.objectiveValue, s.value(objective));
    assert.ok(s.bestObjectiveBound <= s.objectiveValue);
    assert.ok(s.wallTime >= 0 && s.userTime >= 0 && s.deterministicTime >= 0);
    if (i > 0) assert.ok(s.objectiveValue < snapshots[i - 1].objectiveValue);
  }
  const last = snapshots.at(-1);
  assert.equal(last.objectiveValue, solver.objectiveValue);
  assert.equal(last.value(objective), solver.value(objective));
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

// SolutionChannel counts every snapshot queued for JS and delivered, and the
// most snapshots of one solve ever queued and not yet delivered (native
// _testing hooks). A solver thread waits until its callback ran, so that
// maximum is 1: no solution is found while a callback holds the main thread.
const { solutionChannelStats, resetSolutionChannelStats } = native._testing;

/** Solves with an onSolution that holds the main thread for holdMs; returns the count and stats. */
async function solveHolding(m, parameters, holdMs, check = () => {}) {
  resetSolutionChannelStats();
  const solver = new CpSolver();
  solver.parameters = parameters;
  let solutions = 0;
  const status = await solver.solve(m, {
    onSolution(s) {
      solutions += 1;
      check(s);
      const until = performance.now() + holdMs;
      while (performance.now() < until) { /* hold the main thread */ }
    },
  });
  solver.dispose();
  return { status, solutions, stats: solutionChannelStats() };
}

test('each solution waits for its callback: exactly one delivery pending at a time', async () => {
  // Every assignment of 6 Booleans is a solution: 64 deliveries, guaranteed.
  const { m } = boolModel(6);
  const { status, solutions, stats } = await solveHolding(m, { enumerateAllSolutions: true, numWorkers: 1 }, 1);
  assert.equal(status, 'OPTIMAL');
  assert.equal(solutions, 64);
  assert.deepEqual(stats, { issued: 64, delivered: 64, maxPending: 1 });
});

test('a multi-worker search also waits for each callback (smoke check)', async () => {
  // The 64-solution test above carries the guarantee. This one checks the same
  // invariant with 8 workers: they keep searching while a callback holds the
  // main thread, so without the wait improving solutions would queue up and
  // maxPending would exceed 1. Whether one lands inside a given hold is up to
  // the scheduler, so a pass shows no violation, not that one was provoked.
  const n = 30;
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const m = new CpModel();
  const x = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => m.newBoolVar(`x${i}_${j}`)));
  for (let i = 0; i < n; ++i) {
    m.addExactlyOne(x[i]);
    m.addExactlyOne(x.map((row) => row[i]));
  }
  m.minimize(CpLinearExpr.weightedSum(x.flat(), x.flat().map(() => 1 + Math.floor(random() * 1000))));
  const { status, solutions, stats } = await solveHolding(m, { numWorkers: 8, maxTimeInSeconds: 5 }, 30, (s) => {
    for (let i = 0; i < n; ++i) assert.equal(x[i].filter((v) => s.booleanValue(v)).length, 1);
  });
  assert.ok(status === 'OPTIMAL' || status === 'FEASIBLE', status);
  // A random 30 x 30 assignment improves several times (3 or more in practice);
  // with a single solution there would be nothing for maxPending to catch.
  assert.ok(solutions >= 2, `only ${solutions} solution(s): the check needs several`);
  assert.deepEqual(stats, { issued: solutions, delivered: solutions, maxPending: 1 });
});

test('solutionChannelStats counts nothing without onSolution and resets to zero', async () => {
  resetSolutionChannelStats();
  const { m } = boolModel(3);
  const solver = new CpSolver();
  assert.equal(await solver.solve(m), 'OPTIMAL');
  solver.dispose();
  assert.deepEqual(solutionChannelStats(), { issued: 0, delivered: 0, maxPending: 0 });
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

test('a C++ exception while delivering a solution is reported as RunGuarded does: out of memory is a RangeError', () => {
  const { publishSolutionFailure } = native._testing;
  assert.equal(publishSolutionFailure('ok'), false);
  assert.throws(() => publishSolutionFailure('bad_alloc'),
    (e) => e.constructor === RangeError && e.message === 'onSolution: out of memory (the input is too large)');
  assert.throws(() => publishSolutionFailure('runtime'), (e) => e.constructor === Error && e.message === 'onSolution: boom');
});
