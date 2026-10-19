'use strict';
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { modelBuilder: mb } = require('..');

const { Model, Solver, LinearExpr, BoundedLinearExpression, isSolverSupported } = mb;

function assertNear(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} to be within ${eps} of ${expected}`);
}

const MIP_SOLVERS = ['SCIP', 'CP_SAT', 'CBC', 'HIGHS'].filter(isSolverSupported);
const LP_SOLVERS = ['GLOP', 'PDLP', 'CLP', 'HIGHS'].filter(isSolverSupported);

// simple_lp_program_mb / simple_mip_program_mb from the OR-Tools samples:
// maximize x + 10y  s.t.  x + 7y <= 17.5,  x <= 3.5,  x, y >= 0.
// LP optimum 25 (x = 0, y = 2.5); MIP optimum 23 (x = 3, y = 2).
function sample(integral) {
  const model = new Model('sample');
  const x = model.newVar(0, Infinity, integral, 'x');
  const y = model.newVar(0, Infinity, integral, 'y');
  const c0 = model.add(x.plus(y.times(7)).le(17.5), 'c0');
  const c1 = model.add(x.le(3.5), 'c1');
  model.maximize(x.plus(y.times(10)));
  return { model, x, y, c0, c1 };
}

// Market split (Cornuejols & Dawande): tiny, yet takes CP-SAT seconds to settle.
function marketSplit(m = 4, n = 30) {
  let state = 12345;
  const rand = () => { // mulberry32: deterministic, unlike Math.random
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % 100;
  };
  const model = new Model('market split');
  const x = Array.from({ length: n }, (_, j) => model.newBoolVar(`x${j}`));
  for (let i = 0; i < m; i++) {
    const a = x.map(() => rand());
    model.add(LinearExpr.weightedSum(x, a).eq(Math.floor(a.reduce((p, q) => p + q, 0) / 2)));
  }
  model.minimize(x[0]);
  return model;
}

test('the LP sample solves to 25 off the main thread, with duals, reduced costs and activities', async () => {
  const { model, x, y, c0, c1 } = sample(false);
  const solver = new Solver('GLOP');
  assert.equal(await solver.solve(model), 'OPTIMAL');
  assert.equal(solver.status, 'OPTIMAL');
  assertNear(solver.objectiveValue, 25);
  assertNear(solver.value(x), 0);
  assertNear(solver.value(y), 2.5);
  assertNear(solver.value(x.plus(y.times(10)).plus(1)), 26);
  assert.deepEqual(solver.values([x, 2]).map(Math.round), [0, 2]);
  assertNear(solver.dualValue(c0), 10 / 7);
  assertNear(solver.dualValue(c1), 0);
  assertNear(solver.reducedCost(x), 1 - 10 / 7);
  assertNear(solver.reducedCost(y), 0);
  assertNear(solver.activity(c0), 17.5);
  assertNear(solver.activities([c0, c1])[1], 0);
  assert.ok(solver.wallTime >= 0 && solver.userTime >= 0);
});

test('every LP backend agrees on the LP sample', () => {
  for (const name of LP_SOLVERS) {
    const { model, y } = sample(false);
    const solver = new Solver(name);
    assert.equal(solver.solveSync(model), 'OPTIMAL', name);
    assertNear(solver.objectiveValue, 25, 1e-4);
    assertNear(solver.value(y), 2.5, 1e-4);
  }
});

test('every MIP backend solves the MIP sample to 23', { skip: MIP_SOLVERS.length === 0 && 'no MIP backend' }, () => {
  for (const name of MIP_SOLVERS) {
    const { model, x, y } = sample(true);
    const solver = new Solver(name);
    assert.equal(solver.solveSync(model), 'OPTIMAL', name);
    assertNear(solver.objectiveValue, 23);
    assertNear(solver.value(x), 3);
    assertNear(solver.value(y), 2);
    assertNear(solver.bestObjectiveBound, 23);
  }
});

test('duals are withheld where the backend reports none or reports them wrong', () => {
  for (const name of ['SCIP', 'CP_SAT', 'HIGHS'].filter(isSolverSupported)) {
    const { model, x, c0 } = sample(name !== 'HIGHS');
    const solver = new Solver(name);
    assert.equal(solver.solveSync(model), 'OPTIMAL');
    // OR-Tools' HiGHS wrapper fills dual_value with row activities.
    assert.throws(() => solver.dualValue(c0), new RegExp(`Dual values are not available from ${name}`));
    assert.throws(() => solver.reducedCost(x), /Reduced costs are not available/);
  }
});

test('enforced (indicator) constraints only bind when their indicator holds', () => {
  for (const name of ['SCIP', 'CP_SAT'].filter(isSolverSupported)) {
    const model = new Model();
    const x = model.newNumVar(0, 10, 'x');
    const b = model.newBoolVar('b');
    const ct = model.addEnforced(x.le(2), b, true, 'cap');
    model.maximize(x.plus(b.times(9))); // b = 1 caps x at 2: 11 beats 10
    const solver = new Solver(name);
    assert.equal(solver.solveSync(model), 'OPTIMAL', name);
    assertNear(solver.objectiveValue, 11);
    assert.equal(ct.indicatorVariable, b);
    ct.indicatorValue = false; // now b = 0 caps x: b = 1 with x = 10 gives 19
    assert.equal(solver.solveSync(model), 'OPTIMAL');
    assertNear(solver.objectiveValue, 19);
  }
});

test('a non-Boolean indicator variable makes the model invalid, reported by OR-Tools', () => {
  const model = new Model();
  const x = model.newNumVar(0, 10, 'x');
  model.addEnforced(x.le(2), model.newNumVar(0, 1, 'z'), true);
  const solver = new Solver('SCIP');
  assert.equal(solver.solveSync(model), 'MODEL_INVALID');
  assert.match(solver.statusString, /not Boolean/);
  assert.throws(() => solver.objectiveValue, /No solution available: the last solve ended MODEL_INVALID/);
});

test('infeasible, unbounded and empty models report their status', () => {
  const model = new Model();
  const x = model.newNumVar(0, 1, 'x');
  model.add(x.ge(5));
  model.minimize(x);
  const glop = new Solver('GLOP');
  assert.equal(glop.solveSync(model), 'INFEASIBLE');
  assert.throws(() => glop.value(x), /No solution available/);
  assert.equal(typeof glop.bestObjectiveBound, 'number'); // readable after any solve

  const unbounded = new Model();
  unbounded.maximize(unbounded.newNumVar(0, Infinity, 'y'));
  assert.equal(new Solver('SCIP').solveSync(unbounded), 'UNBOUNDED');

  const empty = new Solver('GLOP');
  assert.equal(empty.solveSync(new Model()), 'OPTIMAL');
  assert.equal(empty.objectiveValue, 0);
});

test('bad solver-specific parameters are reported as a status, not thrown', () => {
  const { model } = sample(false);
  const solver = new Solver('SCIP').setSolverSpecificParameters('garbage = 1');
  assert.equal(solver.solveSync(model), 'INVALID_SOLVER_PARAMETERS');
  assert.match(solver.statusString, /garbage/);
});

test('linear expressions combine, simplify and validate', () => {
  const model = new Model();
  const x = model.newNumVar(0, 1, 'x');
  const y = model.newNumVar(0, 1, 'y');
  const e = LinearExpr.sum([x, y, x, 3]).minus(y.times(2)).times(2).neg().plus(1);
  assert.deepEqual(e.terms(), [[x, -4], [y, 2]]);
  assert.equal(e.constant, -5);
  assert.equal(String(LinearExpr.weightedSum([x, y], [2, 1])), '2 * x + y');
  assert.equal(String(LinearExpr.affine(x, 3, 1)), '3 * x + 1');
  assert.equal(String(LinearExpr.term(y, 0.5)), '0.5 * y');
  assert.equal(String(LinearExpr.constant(4)), '4');
  assert.equal(String(LinearExpr.sum([])), '0');

  const bounded = x.plus(5).le(y.plus(2)); // x - y + 3 <= 0
  assert.ok(bounded instanceof BoundedLinearExpression);
  assert.deepEqual(bounded.expression.terms(), [[x, 1], [y, -1]]);
  assert.equal(bounded.lowerBound, -Infinity);
  assert.equal(bounded.upperBound, -3);
  assert.equal(x.eq(1).lowerBound, 1);
  assert.equal(x.ge(1).upperBound, Infinity);

  for (const bad of [NaN, Infinity, '1']) {
    assert.throws(() => x.times(bad), TypeError);
    assert.throws(() => x.plus(bad), TypeError);
  }
  assert.throws(() => LinearExpr.sum([x, {}]), TypeError);
  assert.throws(() => LinearExpr.sum(x), TypeError);
  assert.throws(() => LinearExpr.weightedSum([x], [1, 2]), RangeError);
  assert.throws(() => LinearExpr.weightedSum([x, x], [Number.MAX_VALUE, Number.MAX_VALUE]), /overflows/);
  assert.throws(() => new BoundedLinearExpression(x, NaN, 1), TypeError);
});

test('variables expose and validate their properties', () => {
  const model = new Model('m');
  const x = model.newIntVar(-2, 7, 'x');
  assert.deepEqual([x.index, x.name, x.lowerBound, x.upperBound, x.isIntegral], [0, 'x', -2, 7, true]);
  x.name = 'renamed';
  x.lowerBound = -Infinity;
  x.upperBound = 3;
  x.isIntegral = false;
  x.objectiveCoefficient = 2;
  assert.deepEqual(model.exportToProto().variable[0], {
    name: 'renamed', lowerBound: -Infinity, upperBound: 3, isInteger: false, objectiveCoefficient: 2,
  });
  assert.equal(String(model.newBoolVar()), 'variable#1');
  assert.throws(() => { x.lowerBound = NaN; }, TypeError);
  assert.throws(() => { x.objectiveCoefficient = Infinity; }, TypeError);
  assert.throws(() => { x.isIntegral = 1; }, TypeError);
  assert.throws(() => { x.name = 3; }, TypeError);
  assert.throws(() => model.newVar(0, 1, 'yes'), TypeError);
  assert.throws(() => model.newNumVar(NaN, 1), TypeError);
  assert.throws(() => model.newNumVar(0, 1, 7), TypeError);
  assert.equal(model.varFromIndex(0), x);
  assert.throws(() => model.varFromIndex(2), RangeError);
  assert.throws(() => model.varFromIndex(0.5), TypeError);
  assert.deepEqual(model.getVariables().map((v) => v.index), [0, 1]);
  assert.equal(model.numVariables, 2);
});

test('constraints expose bounds and terms; a constant moves to the bounds', () => {
  const model = new Model();
  const x = model.newNumVar(0, 1, 'x');
  const y = model.newNumVar(0, 1, 'y');
  const ct = model.addLinearConstraint(x.plus(y).plus(2), 1, 5, 'c');
  assert.deepEqual([ct.index, ct.name, ct.lowerBound, ct.upperBound], [0, 'c', -1, 3]);
  ct.addTerm(x, 2).setCoefficient(y, 4);
  assert.deepEqual(ct.terms(), [[x, 3], [y, 4]]);
  ct.lowerBound = -Infinity;
  ct.upperBound = 10;
  ct.name = 'renamed';
  assert.deepEqual(model.exportToProto().constraint[0], {
    name: 'renamed', lowerBound: -Infinity, upperBound: 10, varIndex: [0, 1], coefficient: [3, 4],
  });
  ct.clearTerms();
  assert.deepEqual(ct.terms(), []);
  assert.equal(model.linearConstraintFromIndex(0), ct);
  assert.deepEqual(model.getLinearConstraints(), [ct]);
  assert.equal(model.numConstraints, 1);
  assert.throws(() => ct.setCoefficient(x, NaN), TypeError);
  assert.throws(() => ct.setCoefficient('x', 1), TypeError);
  assert.throws(() => model.addLinearConstraint(x, NaN, 1), TypeError);
  assert.throws(() => model.add(x), /Expected a BoundedLinearExpression/);
  assert.throws(() => model.addEnforced(x.le(1), x, 1), TypeError);
  assert.throws(() => model.linearConstraintFromIndex(1), RangeError);
});

test('handles from another model, or from before a re-import, are rejected', () => {
  const a = new Model();
  const b = new Model();
  const x = a.newNumVar(0, 1, 'x');
  const y = b.newNumVar(0, 1, 'y');
  assert.throws(() => a.add(x.plus(y).le(1)), /belongs to a different Model/);
  assert.equal(a.numConstraints, 0); // nothing was added
  assert.throws(() => a.maximize(y), /different Model/);
  assert.throws(() => a.addHint(y, 1), /different Model/);
  assert.throws(() => a.addEnforced(x.le(1), y, true), /different Model/);
  a.importFromLpString('min: z;\n');
  assert.throws(() => x.name, /no longer valid/);
  assert.equal(a.varFromIndex(0).name, 'z');
});

test('the objective can be read back, replaced and cleared', () => {
  const model = new Model();
  const x = model.newNumVar(0, 1, 'x');
  const y = model.newNumVar(0, 1, 'y');
  model.maximize(x.times(2).plus(y).plus(3));
  assert.equal(model.maximizing, true);
  assert.equal(model.objectiveOffset, 3);
  assert.deepEqual(model.objectiveExpression().terms(), [[x, 2], [y, 1]]);
  model.minimize(y);
  assert.equal(model.maximizing, false);
  assert.deepEqual(model.objectiveExpression().terms(), [[y, 1]]);
  assert.equal(model.objectiveOffset, 0);
  model.objectiveOffset = 4;
  assert.throws(() => { model.objectiveOffset = NaN; }, TypeError);
  model.clearObjective();
  assert.deepEqual(model.objectiveExpression().terms(), []);
  assert.equal(model.objectiveOffset, 0);
  assert.throws(() => model.setObjective(x, 'max'), TypeError);
});

test('hints are sent to the solver, one per variable', () => {
  const model = new Model();
  const x = model.newIntVar(0, 10, 'x');
  model.maximize(x);
  model.addHint(x, 3).addHint(x, 4);
  assert.deepEqual(model.exportToProto().solutionHint, { varIndex: [0], varValue: [4] });
  assert.equal(new Solver('CP_SAT').solveSync(model), 'OPTIMAL');
  model.clearHints();
  assert.equal(model.exportToProto().solutionHint, undefined);
  assert.throws(() => model.addHint(x, NaN), TypeError);
});

test('LP and MPS export, MPS round trip, LP import and clone', () => {
  const { model } = sample(true);
  const lp = model.exportToLpString();
  assert.match(lp, /Maximize/);
  assert.match(lp, /c0: \+1 x \+7 y\s+<= 17\.5/);
  assert.doesNotMatch(model.exportToLpString(true), /\bx\b/); // obfuscated names
  const mps = model.exportToMpsString();
  assert.match(mps, /ROWS/);

  const imported = new Model().importFromMpsString(mps);
  assert.equal(imported.numVariables, 2);
  assert.equal(imported.varFromIndex(1).name, 'y');
  const solver = new Solver('CP_SAT');
  assert.equal(solver.solveSync(imported), 'OPTIMAL');
  assertNear(solver.objectiveValue, 23);

  const parsed = new Model().importFromLpString('max: 3x + 2y;\nc1: x + y <= 4;\nc2: x + 3y <= 6;\nx <= 3;\nint x;\n');
  assert.equal(parsed.maximizing, true);
  assert.deepEqual(parsed.getLinearConstraints().map((c) => c.name), ['c1', 'c2']);
  assert.equal(parsed.varFromIndex(0).isIntegral, true);
  assert.equal(parsed.varFromIndex(1).upperBound, Infinity);
  assert.equal(solver.solveSync(parsed), 'OPTIMAL');
  assertNear(solver.objectiveValue, 11); // x = 3, y = 1

  const copy = model.clone('copy');
  copy.varFromIndex(0).upperBound = 0;
  assert.equal(model.varFromIndex(0).upperBound, Infinity);
  assert.equal(copy.name, 'copy');
  assert.deepEqual(copy.exportToProto().constraint, model.exportToProto().constraint);
});

test('enforced constraints and hints survive clone()', () => {
  const model = new Model();
  const x = model.newNumVar(0, 10, 'x');
  const b = model.newBoolVar('b');
  model.addEnforced(x.le(2), b, false, 'e');
  model.addHint(b, 1);
  assert.deepEqual(model.clone().exportToProto(), model.exportToProto());
  assert.equal(model.getEnforcedLinearConstraints()[0].indicatorValue, false);
  assert.equal(model.enforcedLinearConstraintFromIndex(0).name, 'e');
  assert.equal(model.numEnforcedConstraints, 1);
});

test('unparsable LP or MPS text throws and leaves the model unchanged', () => {
  const { model, x } = sample(false);
  assert.throws(() => model.importFromLpString('this is :: not lp'), /Cannot parse the LP model/);
  assert.throws(() => model.importFromMpsString('NAME\nGARBAGE'), /Cannot parse the MPS model/);
  assert.throws(() => model.importFromLpString(42), /LP model must be a string/);
  assert.equal(x.name, 'x'); // handles still valid
  assert.equal(model.numConstraints, 2);
});

test('solver names are validated and parameters checked', () => {
  assert.equal(isSolverSupported('GLOP'), true);
  assert.equal(isSolverSupported('glop'), true);
  assert.equal(isSolverSupported('NOPE'), false);
  assert.throws(() => isSolverSupported(1), TypeError);
  assert.throws(() => new Solver('NOPE'), /Unsupported or unavailable solver: 'NOPE'/);
  assert.throws(() => new Solver(), TypeError);
  const solver = new Solver('GLOP');
  assert.throws(() => solver.setTimeLimitInSeconds(-1), RangeError);
  assert.throws(() => solver.setTimeLimitInSeconds(NaN), TypeError);
  assert.throws(() => solver.setSolverSpecificParameters(1), TypeError);
  assert.throws(() => solver.enableOutput('yes'), TypeError);
  assert.throws(() => solver.solveSync({}), /expected a Model/);
  solver.setTimeLimitInSeconds(Infinity).setTimeLimitInSeconds(10).enableOutput(false);
});

test('results need a solve, and only cover the model as it was solved', () => {
  const { model, x, c0 } = sample(false);
  const solver = new Solver('GLOP');
  for (const read of [() => solver.status, () => solver.objectiveValue, () => solver.value(x), () => solver.wallTime,
    () => solver.dualValue(c0), () => solver.activity(c0), () => solver.bestObjectiveBound]) {
    assert.throws(read, /No solve result: call solve\(\) first/);
  }
  solver.solveSync(model);
  const late = model.newNumVar(0, 1, 'late');
  const lateCt = model.add(late.le(1));
  assert.throws(() => solver.value(late), /not part of the solved model/);
  assert.throws(() => solver.dualValue(lateCt), /not part of the solved model/);
  assert.throws(() => solver.value(new Model().newNumVar(0, 1)), /different Model/);
  assert.throws(() => solver.activity(model.addEnforced(x.le(1), model.newBoolVar(), true)), /Expected a LinearConstraint/);
  assertNear(solver.value(x), 0); // earlier handles still read fine
});

test('the solver is busy during solve(); the model may change meanwhile', async () => {
  const { model, x, y } = sample(false);
  const solver = new Solver('GLOP');
  const pending = solver.solve(model);
  assert.equal(solver.busy, true);
  for (const call of [() => solver.solve(model), () => solver.solveSync(model), () => solver.setTimeLimitInSeconds(1),
    () => solver.status, () => solver.value(x), () => solver.dispose()]) {
    assert.throws(call, /Solver is busy/);
  }
  model.add(y.le(1)); // not part of the running solve
  assert.equal(await pending, 'OPTIMAL');
  assert.equal(solver.busy, false);
  assertNear(solver.value(y), 2.5);
  assert.equal(solver.solveSync(model), 'OPTIMAL');
  assertNear(solver.value(y), 1);
});

test('concurrent solves on separate solvers are independent', async () => {
  const lp = sample(false);
  const mip = sample(true);
  const a = new Solver('GLOP');
  const b = new Solver('CP_SAT');
  assert.deepEqual(await Promise.all([a.solve(lp.model), b.solve(mip.model)]), ['OPTIMAL', 'OPTIMAL']);
  assertNear(a.objectiveValue, 25);
  assertNear(b.objectiveValue, 23);
});

test('interrupt() stops an interruptible solve early', async () => {
  // marketSplit() is infeasible and takes CP-SAT about 10 s to prove: under a
  // 2 s limit the reference run uses the full 2 s and finds nothing.
  const reference = new Solver('CP_SAT').setTimeLimitInSeconds(2);
  let started = Date.now();
  assert.equal(reference.solveSync(marketSplit()), 'NOT_SOLVED');
  const limitedMs = Date.now() - started;
  assert.ok(limitedMs >= 1500, `the reference run ended after ${limitedMs} ms: the model is too easy`);

  const solver = new Solver('CP_SAT').setTimeLimitInSeconds(2);
  assert.equal(solver.interrupt(), false); // nothing running
  started = Date.now();
  const pending = solver.solve(marketSplit());
  setTimeout(() => assert.equal(solver.interrupt(), true), 100);
  assert.equal(await pending, 'NOT_SOLVED');
  const interruptedMs = Date.now() - started;
  assert.ok(interruptedMs < limitedMs / 2, `interrupted after ${interruptedMs} ms vs ${limitedMs} ms uninterrupted`);
  assert.equal(solver.interrupt(), false);
});

test('interrupt() returns false for backends that cannot be interrupted', async () => {
  const solver = new Solver('SCIP');
  const pending = solver.solve(sample(true).model);
  assert.equal(solver.interrupt(), false);
  assert.equal(await pending, 'OPTIMAL');
});

test('a time limit stops a hard model early', () => {
  const solver = new Solver('CP_SAT').setTimeLimitInSeconds(0.2);
  const started = Date.now();
  // Proving the model infeasible takes about 10 s: 0.2 s cannot settle it, and
  // a time limit that is not passed on lets it run to INFEASIBLE.
  assert.equal(solver.solveSync(marketSplit()), 'NOT_SOLVED');
  assert.ok(Date.now() - started < 2000, 'time limit ignored');
});

test('dispose() is idempotent and later calls throw', () => {
  const { model } = sample(false);
  const solver = new Solver('GLOP');
  solver.solveSync(model);
  solver.dispose();
  solver.dispose();
  assert.equal(solver.interrupt(), false);
  assert.throws(() => solver.objectiveValue, /disposed/);
  assert.throws(() => solver.solveSync(model), /disposed/);
  const other = new Solver('GLOP');
  other[Symbol.dispose]();
  assert.throws(() => other.solveSync(model), /disposed/);
});

// Runs `body` in a child process, so a native crash fails the test instead of the run.
function runIsolated(body) {
  const script = `const { modelBuilder: mb } = require(${JSON.stringify(require.resolve('..'))});\n${body}`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, `child exited with ${child.status} (${child.signal}): ${child.stderr}`);
  return child.stdout.trim();
}

// A Proxy around a Model runs `onRead` the first time solve() reads the model.
const PROXY_MODEL = `
  function trapped(onRead) {
    const model = new mb.Model();
    model.maximize(model.newNumVar(0, 1, 'x'));
    let fired = false;
    return new Proxy(model, { get(target, key) {
      if (!fired) { fired = true; onRead(); }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }`;

test('code that disposes the solver while solve() reads the model is a JS error', () => {
  const out = runIsolated(`${PROXY_MODEL}
    const solver = new mb.Solver('GLOP');
    try { solver.solveSync(trapped(() => solver.dispose())); console.log('no error'); } catch (e) { console.log(e.message); }`);
  assert.match(out, /disposed/);
});

test('code that starts a solve while solve() reads the model is a JS error', () => {
  const out = runIsolated(`${PROXY_MODEL}
    const solver = new mb.Solver('GLOP');
    let pending;
    const other = new mb.Model();
    other.maximize(other.newNumVar(0, 2, 'y'));
    try { solver.solveSync(trapped(() => { pending = solver.solve(other); })); console.log('no error'); }
    catch (e) { console.log(e.message); }
    pending.then((status) => console.log(status, solver.objectiveValue));`);
  assert.match(out, /Solver is busy/);
  assert.match(out, /OPTIMAL 2/);
});

test('a solution hint is safe with HiGHS (OR-Tools crashes on it; the hint is dropped)', { skip: !isSolverSupported('HIGHS') && 'no HiGHS' }, () => {
  const out = runIsolated(`
    for (const integral of [false, true]) {
      const model = new mb.Model();
      const x = model.newVar(0, 10, integral, 'x');
      model.add(x.le(7.5));
      model.maximize(x);
      model.addHint(x, 3);
      const solver = new mb.Solver('HIGHS');
      console.log('sync', solver.solveSync(model), solver.objectiveValue);
      solver.solve(model).then((status) => console.log('async', status, solver.objectiveValue));
    }`);
  assert.deepEqual(out.split('\n').filter((l) => /^(sync|async)/.test(l)).sort(),
    ['async OPTIMAL 7', 'async OPTIMAL 7.5', 'sync OPTIMAL 7', 'sync OPTIMAL 7.5']);
});
