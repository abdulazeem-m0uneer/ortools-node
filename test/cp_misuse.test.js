'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runIsolated } = require('./helpers/isolated');

// Each case reaches an OR-Tools CHECK, a Fail() outside search or a null
// dereference unless the binding guards it first.
test('dangerous CP calls throw JS errors instead of aborting the process', () => {
  const setup = `
    const s = new ortools.cp.CpSolver('misuse');
    const x = s.intVar(0, 5, 'x');
    const y = s.intVar(0, 5, 'y');
    const db = s.phase([x, y], 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE');
    const all = s.allSolutionCollector().add(x);
    s.solve(db, [all]);`;
  const cases = {
    setMaxBelowMin: 'x.setMax(-1)',
    setValueOutside: 'x.setValue(9)',
    removeEveryValue: 'x.removeValues([0, 1, 2, 3, 4, 5])',
    valueUnbound: 'x.value()',
    collectorUnknownVar: 'all.value(0, y)',
    collectorIndexOutOfRange: 'all.value(1000, x)',
    collectorNegativeIndex: 'all.value(-1, x)',
    allocateAtSolution: `s.solve(db, [{ atSolution() { s.intVar(0, 1); } }])`,
    addAtSolution: `s.solve(db, [{ atSolution() { s.add(x.eq(1)); } }])`,
    nextSolutionWithoutSearch: 's.nextSolution()',
    endSearchWithoutSearch: 's.endSearch()',
    bestWithoutObjective: `s.solve(db, [s.bestValueSolutionCollector(true).add(x)])`,
    tupleArity: 's.allowedAssignments([x, y], [[1, 2, 3]])',
    stepZero: 's.minimize(x, 0)',
    logPeriodZero: 's.searchLog(0)',
    minOfNothing: 's.min([])',
    elementOfNothing: 's.element([], x)',
    rawBadExprId: 's._n.exprMin(99)',
    rawBadDbId: 's._n.solve(99, [])',
  };
  const { status, signal, stderr, results } = runIsolated(setup, cases);
  assert.equal(signal, null, `child crashed: ${stderr}`);
  assert.equal(status, 0, `child failed: ${stderr}`);
  for (const name of Object.keys(cases)) {
    assert.equal(typeof results[name], 'string', `${name} did not throw`);
  }
  assert.match(results.setMaxBelowMin, /CP solver failure/);
  assert.match(results.allocateAtSolution, /while a search is open/);
});

// Reading a JS array element can run user code (a getter or a Proxy trap) in
// the middle of a native call. That code may dispose or solve this very solver,
// so bindings read every argument before touching the model.
test('argument getters that dispose, solve or throw cannot crash a CP call', () => {
  const setup = `
    const fresh = () => {
      const s = new ortools.cp.CpSolver();
      const x = s.intVar(0, 9, 'x');
      return { s, x, db: s.phase([x], 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE') };
    };
    const trap = (value, effect) => {
      const array = [value];
      Object.defineProperty(array, 0, { get() { effect(); return value; } });
      return array;
    };`;
  const cases = {
    disposeWhileReadingValues: `const { s, x } = fresh(); x.removeValues(trap(3, () => s.dispose()));`,
    disposeWhileReadingDomain: `const { s } = fresh(); s.intVar(trap(3, () => s.dispose()));`,
    disposeWhileReadingTuples: `const { s, x } = fresh();
      s.allowedAssignments([x], [trap(1, () => s.dispose())]);`,
    disposeWhileReadingCoefficients: `const { s, x } = fresh(); s.scalProd([x], trap(2, () => s.dispose()));`,
    disposeWhileReadingIds: `const { s, x } = fresh(); s._n.sum(trap(x._id, () => s.dispose()));`,
    disposeWhileReadingMonitors: `const { s, db } = fresh();
      s._n.solve(db._id, [], trap({ atSolution() {} }, () => s.dispose()));`,
    solveWhileReadingValues: `const { s, x, db } = fresh();
      x.removeValues(trap(3, () => { s.solveAsync(db); }));`,
    proxyLengthThrows: `const { s } = fresh();
      s._n.sum(new Proxy([], { get(t, k) { if (k === 'length') throw new Error('length trap'); return t[k]; } }));`,
    getterThrows: `const { s, x } = fresh(); x.removeValues(trap(3, () => { throw new Error('getter'); }));`,
    monitorGetterThrows: `const { s, db } = fresh();
      s.solve(db, [{ get atSolution() { throw new Error('monitor getter'); } }]);`,
  };
  const { status, signal, stderr, results } = runIsolated(setup, cases);
  assert.equal(signal, null, `child crashed: ${stderr}`);
  assert.equal(status, 0, `child failed: ${stderr}`);
  for (const name of Object.keys(cases)) {
    assert.equal(typeof results[name], 'string', `${name} did not throw`);
  }
  for (const name of Object.keys(cases).filter((n) => n.startsWith('dispose'))) {
    assert.match(results[name], /disposed/, name);
  }
  assert.match(results.solveWhileReadingValues, /busy/);
  assert.match(results.getterThrows, /getter/);
  assert.match(results.monitorGetterThrows, /monitor getter/);
});
