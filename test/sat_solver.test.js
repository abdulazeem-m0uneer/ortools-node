'use strict';
// CpSolver: statuses, solution access, errors, parameters, busy / dispose,
// stopSearch and concurrent solves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CpModel, CpSolver, CpSolverStatus } = require('..');

function smallModel() {
  const m = new CpModel();
  const x = m.newIntVar(0, 10, 'x');
  const y = m.newIntVar(0, 10, 'y');
  m.add(x.plus(y).le(12));
  m.add(x.ne(5));
  m.maximize(x.plus(y.times(2)).plus(3));
  return { m, x, y };
}

// Many solutions and no way to enumerate them quickly: runs until stopped.
function endlessEnumeration() {
  const m = new CpModel();
  for (let i = 0; i < 40; ++i) m.newBoolVar(`b${i}`);
  return m;
}

test('solve() resolves to OPTIMAL and exposes values, objective and statistics', async () => {
  const { m, x, y } = smallModel();
  const solver = new CpSolver();
  const status = await solver.solve(m);
  assert.equal(status, 'OPTIMAL');
  assert.equal(status, CpSolverStatus.OPTIMAL);
  assert.equal(solver.statusName(), 'OPTIMAL');
  assert.equal(solver.value(x), 2);
  assert.equal(solver.value(y), 10);
  assert.equal(solver.value(x.plus(y)), 12);
  assert.equal(solver.value(7), 7);
  assert.equal(solver.objectiveValue, 25);
  assert.equal(solver.bestObjectiveBound, 25);
  assert.ok(solver.wallTime >= 0);
  assert.ok(solver.userTime >= 0);
  assert.ok(solver.deterministicTime >= 0);
  for (const n of [solver.numBranches, solver.numConflicts, solver.numBooleans]) assert.ok(Number.isInteger(n));
  assert.match(solver.responseStats(), /status: OPTIMAL/);
  assert.equal(typeof solver.solutionInfo(), 'string');
  const proto = solver.responseProto();
  assert.equal(proto.status, 'OPTIMAL');
  assert.deepEqual(proto.solution, ['2', '10']);
});

test('solveSync() gives the same result as solve()', async () => {
  const { m, x } = smallModel();
  const solver = new CpSolver();
  assert.equal(solver.solveSync(m), 'OPTIMAL');
  assert.equal(solver.value(x), 2);
  assert.equal(solver.objectiveValue, 25);
});

test('booleanValue() reads literals, negations and constants', () => {
  const m = new CpModel();
  const a = m.newBoolVar('a');
  const b = m.newBoolVar('b');
  m.addBoolAnd([a, b.not()]);
  const solver = new CpSolver();
  assert.equal(solver.solveSync(m), 'OPTIMAL');
  assert.equal(solver.booleanValue(a), true);
  assert.equal(solver.booleanValue(b), false);
  assert.equal(solver.booleanValue(b.not()), true);
  assert.equal(solver.booleanValue(true), true);
  assert.equal(solver.value(a.not()), 0);
  assert.throws(() => solver.booleanValue(m.newIntVar(0, 5, 'z')), TypeError);
  assert.throws(() => solver.booleanValue(1), TypeError);
  assert.throws(() => solver.value('a'), TypeError);
});

test('an empty model is OPTIMAL with no values', () => {
  const solver = new CpSolver();
  assert.equal(solver.solveSync(new CpModel()), 'OPTIMAL');
  assert.equal(solver.value(3), 3);
  assert.equal(solver.objectiveValue, 0);
  assert.match(solver.responseStats(), /objective: NA/);
});

test('reading results before any solve throws', () => {
  const solver = new CpSolver();
  assert.throws(() => solver.statusName(), /No solve result/);
  assert.throws(() => solver.value(1), /No solve result/);
  assert.throws(() => solver.objectiveValue, /No solve result/);
  assert.throws(() => solver.bestObjectiveBound, /No solve result/);
  assert.throws(() => solver.wallTime, /No solve result/);
  assert.throws(() => solver.numBranches, /No solve result/);
  assert.throws(() => solver.responseStats(), /No solve result/);
  assert.throws(() => solver.responseProto(), /No solve result/);
  assert.throws(() => solver.sufficientAssumptionsForInfeasibility(), /No solve result/);
});

test('after an INFEASIBLE solve, values and objective throw instead of returning 0', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 5, 'x');
  m.add(x.gt(5));
  m.minimize(x);
  const solver = new CpSolver();
  assert.equal(solver.solveSync(m), 'INFEASIBLE');
  assert.throws(() => solver.value(x), /no solution, the last solve ended INFEASIBLE/);
  assert.throws(() => solver.booleanValue(true), /no solution/);
  assert.throws(() => solver.objectiveValue, /no solution/);
  assert.throws(() => solver.bestObjectiveBound, /INFEASIBLE/);
  assert.ok(Number.isInteger(solver.numConflicts));
  assert.equal(solver.statusName(), 'INFEASIBLE');
});

test('a time limit hit before any solution leaves status UNKNOWN and values unavailable', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 1000, 'x');
  m.minimize(x);
  const solver = new CpSolver();
  solver.parameters = { maxTimeInSeconds: 0 };
  assert.equal(solver.solveSync(m), 'UNKNOWN');
  assert.throws(() => solver.value(x), /ended UNKNOWN/);
  assert.equal(typeof solver.bestObjectiveBound, 'number');
});

test('values from another model or added after the solve throw', () => {
  const { m, x } = smallModel();
  const other = smallModel();
  const solver = new CpSolver();
  solver.solveSync(m);
  assert.throws(() => solver.value(other.x), /different CpModel than the one solved/);
  assert.throws(() => solver.value(x.plus(other.y)), /different CpModel/);
  const later = m.newIntVar(0, 1, 'later');
  assert.throws(() => solver.value(later), /created after the solve/);
  assert.throws(() => solver.booleanValue(later), /created after the solve/);
  assert.equal(solver.value(x), 2);  // the rest of the result is untouched
});

test('an invalid model rejects with OR-Tools\' message and clears the previous result', async () => {
  const { m } = smallModel();
  const solver = new CpSolver();
  const assertNoResult = () => {
    assert.throws(() => solver.statusName(), /No solve result/);
    assert.throws(() => solver.value(1), /No solve result/);
    assert.throws(() => solver.objectiveValue, /No solve result/);
  };
  assert.equal(solver.solveSync(m), 'OPTIMAL');
  const bad = new CpModel();
  bad.newIntVar(-Infinity, Infinity, 'unbounded');
  await assert.rejects(solver.solve(bad), /Invalid CpModel: var #0 domain do not fall in/);
  assertNoResult();
  assert.equal(solver.solveSync(m), 'OPTIMAL');
  assert.throws(() => solver.solveSync(bad), /Invalid CpModel/);
  assertNoResult();
  const emptyDomain = new CpModel();
  emptyDomain.newIntVar(5, 3, 'empty');
  assert.throws(() => solver.solveSync(emptyDomain), /Invalid CpModel: var #0 has no domain/);
  const overflow = new CpModel();
  const big = overflow.newIntVar(0, 2n ** 61n, 'big');
  overflow.add(big.times(2n ** 61n).le(5));
  assert.throws(() => solver.solveSync(overflow), /Invalid CpModel: Possible integer overflow/);
  assert.equal(solver.busy, false);
});

test('bad arguments to solve() reject; parameters are validated by OR-Tools', async () => {
  const { m } = smallModel();
  const solver = new CpSolver();
  await assert.rejects(solver.solve({}), TypeError);
  await assert.rejects(solver.solve(m, null), TypeError);
  await assert.rejects(solver.solve(m, { onSolution: 5 }), TypeError);
  assert.throws(() => solver.solveSync(m, { onSolution() {} }), /onSolution needs solve\(\)/);
  solver.parameters = { notAField: 1 };
  await assert.rejects(solver.solve(m), /notAField/);
  solver.parameters = { numWorkers: -3 };
  assert.throws(() => solver.solveSync(m), RangeError);
  solver.parameters = 'fast';
  assert.throws(() => solver.solveSync(m), TypeError);
  solver.parameters = { num_workers: 1, maxTimeInSeconds: 5 };
  assert.equal(solver.solveSync(m), 'OPTIMAL');
});

test('assumptions: sufficientAssumptionsForInfeasibility names the conflicting literals', () => {
  const m = new CpModel();
  const a = m.newBoolVar('a');
  const b = m.newBoolVar('b');
  const c = m.newBoolVar('c');
  m.addImplication(a, b.not());
  m.addAssumptions([a, b, c]);
  const solver = new CpSolver();
  solver.parameters = { numWorkers: 1 };
  assert.equal(solver.solveSync(m), 'INFEASIBLE');
  assert.deepEqual(solver.sufficientAssumptionsForInfeasibility().sort(), [a.index, b.index]);
  m.clearAssumptions();
  assert.equal(solver.solveSync(m), 'OPTIMAL');
  assert.deepEqual(solver.sufficientAssumptionsForInfeasibility(), []);
});

test('hints reach the solver (fixVariablesToTheirHintedValue enforces them)', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 100, 'x');
  m.add(x.ge(10));
  m.addHint(x, 42);
  const solver = new CpSolver();
  solver.parameters = { numWorkers: 1, fixVariablesToTheirHintedValue: true };
  assert.equal(solver.solveSync(m), 'OPTIMAL');
  assert.equal(solver.value(x), 42);
  m.clearHints();
  m.addHint(x, 3);  // violates x >= 10, so fixing it is infeasible
  assert.equal(solver.solveSync(m), 'INFEASIBLE');
});

test('a decision strategy steers a fixed search', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 9, 'x');
  const y = m.newIntVar(0, 9, 'y');
  m.add(x.plus(y).eq(9));
  m.addDecisionStrategy([x], 'CHOOSE_FIRST', 'SELECT_MAX_VALUE');
  const solver = new CpSolver();
  solver.parameters = {
    numWorkers: 1, searchBranching: 'FIXED_SEARCH', cpModelPresolve: false, stopAfterFirstSolution: true,
  };
  solver.solveSync(m);
  assert.equal(solver.value(x), 9);
  assert.equal(solver.value(y), 0);
});

test('int64 values beyond 2^53 come back exact as BigInts, safe ones as numbers', async () => {
  const m = new CpModel();
  const big = 2n ** 60n;
  const x = m.newIntVar(big, big + 5n, 'x');
  const y = m.newIntVar(-5, 5, 'y');
  m.maximize(x.minus(y));
  const solver = new CpSolver();
  assert.equal(solver.solveSync(m), 'OPTIMAL');
  assert.equal(solver.value(x), big + 5n);
  assert.equal(solver.value(y), -5);
  assert.deepEqual(solver.responseProto().solution, [String(big + 5n), '-5']);
  assert.equal(solver.value(x.minus(big)), 5);  // safe results are numbers again
  assert.equal(solver.value(x.minus(big).plus(y)), 0);
  assert.equal(solver.value(x.times(-1)), -(big + 5n));
  assert.equal(solver.value(2n ** 60n), 2n ** 60n);
  assert.equal(solver.value(2n ** 52n), 2 ** 52);
  const seen = [];
  await new CpSolver().solve(m, { onSolution: (s) => seen.push(s.value(x)) });
  assert.equal(seen.at(-1), big + 5n);
});

test('value() stays exact when products exceed 2^53 but the result does not', () => {
  const m = new CpModel();
  const x = m.newIntVar(2 ** 40, 2 ** 40, 'x');
  const solver = new CpSolver();
  solver.solveSync(m);
  assert.equal(solver.value(x.times(2 ** 20).minus(x.times(2 ** 20))), 0);
  assert.equal(solver.value(x.times(2 ** 20).minus(2n ** 60n).plus(1)), 1);
});

test('busy: a second solve rejects, results throw, dispose throws until it settles', async () => {
  const m = endlessEnumeration();
  const solver = new CpSolver();
  solver.parameters = { enumerateAllSolutions: true, maxTimeInSeconds: 10 };
  const pending = solver.solve(m);
  assert.equal(solver.busy, true);
  await assert.rejects(solver.solve(m), /busy/);
  assert.throws(() => solver.solveSync(m), /busy/);
  assert.throws(() => solver.statusName(), /busy/);
  assert.throws(() => solver.dispose(), /busy/);
  assert.equal(solver.stopSearch(), true);
  assert.ok(['FEASIBLE', 'UNKNOWN'].includes(await pending));  // UNKNOWN if stopped before a first solution
  assert.equal(solver.busy, false);
  assert.equal(solver.stopSearch(), false);
});

test('stopSearch() interrupts a long search well before its time limit', async () => {
  const solver = new CpSolver();
  solver.parameters = { enumerateAllSolutions: true, maxTimeInSeconds: 60 };
  const started = Date.now();
  const pending = solver.solve(endlessEnumeration());
  setTimeout(() => solver.stopSearch(), 50);
  assert.ok(['FEASIBLE', 'UNKNOWN'].includes(await pending));
  assert.ok(Date.now() - started < 10000, 'the search stopped long before its 60 s limit');
  assert.ok(solver.wallTime < 10);
});

test('a stop requested before a solve does not affect it', async () => {
  const { m } = smallModel();
  const solver = new CpSolver();
  assert.equal(solver.stopSearch(), false);
  assert.equal(await solver.solve(m), 'OPTIMAL');
});

test('a time limit ends the search with the best solution found', () => {
  const solver = new CpSolver();
  solver.parameters = { enumerateAllSolutions: true, maxTimeInSeconds: 0.2 };
  assert.equal(solver.solveSync(endlessEnumeration()), 'FEASIBLE');
  assert.ok(solver.wallTime < 5);
});

test('concurrent solves of different models on different solvers', async () => {
  const runs = Array.from({ length: 6 }, (_, k) => {
    const m = new CpModel();
    const x = m.newIntVar(0, 100, 'x');
    m.add(x.le(k * 10));
    m.maximize(x);
    const solver = new CpSolver();
    solver.parameters = { numWorkers: 2 };
    return { k, x, solver, pending: solver.solve(m) };
  });
  for (const { k, x, solver, pending } of runs) {
    assert.equal(await pending, 'OPTIMAL');
    assert.equal(solver.value(x), k * 10);
  }
});

test('one model solved by two solvers at once, then changed after the solve started', async () => {
  const { m, x } = smallModel();
  const a = new CpSolver();
  const b = new CpSolver();
  const both = Promise.all([a.solve(m), b.solve(m)]);
  m.add(x.eq(0));  // does not affect the solves already started
  assert.deepEqual(await both, ['OPTIMAL', 'OPTIMAL']);
  assert.equal(a.value(x), 2);
  assert.equal(b.value(x), 2);
  assert.equal(a.solveSync(m), 'OPTIMAL');
  assert.equal(a.value(x), 0);
});

test('dispose(): later solves and reads throw, stopSearch() is false and busy is false', () => {
  const { m } = smallModel();
  const solver = new CpSolver();
  solver.solveSync(m);
  solver.dispose();
  solver.dispose();
  assert.throws(() => solver.statusName(), /disposed/);
  assert.throws(() => solver.solveSync(m), /disposed/);
  assert.throws(() => solver.value(1), /disposed/);
  assert.throws(() => solver.wallTime, /disposed/);
  assert.equal(solver.stopSearch(), false);
  assert.equal(solver.busy, false);
});

test('Symbol.dispose disposes the solver', { skip: typeof Symbol.dispose !== 'symbol' && 'no Symbol.dispose' }, () => {
  const solver = new CpSolver();
  solver[Symbol.dispose]();
  assert.throws(() => solver.solveSync(new CpModel()), /disposed/);
});
