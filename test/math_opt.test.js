'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mathOpt } = require('..');

const { Model, LinearExpr, SolveInterrupter, SolverType, TerminationReason, solve, solveSync } = mathOpt;

function assertNear(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} to be within ${eps} of ${expected}`);
}

const MIP_SOLVERS = ['GSCIP', 'CP_SAT', 'HIGHS'].filter((t) => t in SolverType);

// The MathOpt getting-started LP: maximize x + 2y s.t. x + y <= 1.5,
// x in [-1, 1.5], y in [0, 1]. Optimum 2.5 at x = 0.5, y = 1.
function gettingStarted() {
  const model = new Model('getting_started_lp');
  const x = model.addVariable({ lb: -1, ub: 1.5, name: 'x' });
  const y = model.addVariable({ lb: 0, ub: 1, name: 'y' });
  const c = model.addLinearConstraint(x.plus(y).le(1.5), 'c');
  model.maximize(x.plus(y.times(2)));
  return { model, x, y, c };
}

// simple_mip_program: maximize x + 10y s.t. x + 7y <= 17.5, x <= 3.5; optimum 23 at (3, 2).
function simpleMip() {
  const model = new Model('simple_mip');
  const x = model.addIntegerVariable({ lb: 0, name: 'x' });
  const y = model.addIntegerVariable({ lb: 0, name: 'y' });
  model.addLinearConstraint(x.plus(y.times(7)).le(17.5));
  model.addLinearConstraint({ expr: x, ub: 3.5 });
  model.maximize(x.plus(y.times(10)));
  return { model, x, y };
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
  const x = Array.from({ length: n }, () => model.addBinaryVariable());
  for (let i = 0; i < m; i++) {
    const a = x.map(() => rand());
    model.addLinearConstraint(LinearExpr.weightedSum(x, a).eq(Math.floor(a.reduce((p, q) => p + q, 0) / 2)));
  }
  model.minimize(x[0]);
  return model;
}

test('the getting-started LP solves to 2.5 off the main thread', async () => {
  const { model, x, y, c } = gettingStarted();
  const result = await solve(model, 'GLOP');
  assert.equal(result.termination.reason, TerminationReason.OPTIMAL);
  assert.equal(result.termination.problemStatus.primalStatus, 'FEASIBLE');
  assert.equal(result.hasPrimalFeasibleSolution(), true);
  assert.equal(result.hasDualFeasibleSolution(), true);
  assertNear(result.objectiveValue(), 2.5);
  assertNear(result.bestObjectiveBound(), 2.5);
  assertNear(result.termination.objectiveBounds.primalBound, 2.5);
  assert.deepEqual(result.variableValues([x, y]), [0.5, 1]);
  assertNear(result.variableValues(x), 0.5);
  assert.deepEqual([...result.variableValues().keys()], [x, y]);
  assertNear(result.dualValues(c), 1);
  assert.deepEqual(result.reducedCosts([x, y]).map((v) => Math.abs(v)), [0, 1]);
  assert.ok(result.solveTime() >= 0);
  assert.equal(typeof result.solveStats.simplexIterations, 'number');
});

test('every available solver agrees on the getting-started LP', () => {
  for (const type of Object.keys(SolverType)) {
    const { model, y } = gettingStarted();
    const result = solveSync(model, type);
    assert.equal(result.termination.reason, 'OPTIMAL', type);
    assertNear(result.objectiveValue(), 2.5, 1e-4);
    assertNear(result.variableValues(y), 1, 1e-4);
  }
});

test('MIP solvers find 23 on simple_mip_program', { skip: MIP_SOLVERS.length === 0 && 'no MIP solver' }, () => {
  for (const type of MIP_SOLVERS) {
    const { model, x, y } = simpleMip();
    const result = solveSync(model, type);
    assert.equal(result.termination.reason, 'OPTIMAL', type);
    assertNear(result.objectiveValue(), 23);
    assertNear(result.variableValues(x), 3);
    assertNear(result.variableValues(y), 2);
    if (type === 'CP_SAT') assert.throws(() => result.dualValues(), /No dual feasible solution/);
  }
});

test('MathOpt rejects what a solver cannot handle, as a JS error', () => {
  assert.throws(() => solveSync(simpleMip().model, 'GLOP'), /INVALID_ARGUMENT: Glop does not support integer variables/);
  assert.throws(() => solveSync(gettingStarted().model, 'CP_SAT', { parameters: { lpAlgorithm: 'BARRIER' } }),
    /lp_algorithm .* is not supported for CP_SAT/);
  assert.throws(() => solveSync(gettingStarted().model, 'GLOP', { parameters: { threads: -3 } }), /threads = -3/);
  const dup = new Model();
  dup.addVariable({ name: 'a' });
  dup.addVariable({ name: 'a' });
  assert.throws(() => solveSync(dup, 'GLOP'), /duplicate name/);
  const crossed = new Model();
  crossed.addVariable({ lb: 5, ub: 1 });
  assert.throws(() => solveSync(crossed, 'GLOP'), /lower_bound > upper_bound/);
});

test('infeasible, unbounded and empty models report their termination', async () => {
  const model = new Model();
  const v = model.addVariable({ lb: 0, ub: 1 });
  model.addLinearConstraint(v.ge(3));
  const infeasible = solveSync(model, 'GLOP');
  assert.equal(infeasible.termination.reason, 'INFEASIBLE');
  assert.equal(infeasible.hasPrimalFeasibleSolution(), false);
  assert.throws(() => infeasible.objectiveValue(), /No primal feasible solution \(termination: INFEASIBLE\)/);
  assert.throws(() => infeasible.variableValues(v), /No primal feasible solution/);

  const unbounded = new Model();
  unbounded.maximize(unbounded.addVariable({ lb: 0 }));
  assert.ok(['UNBOUNDED', 'INFEASIBLE_OR_UNBOUNDED'].includes(solveSync(unbounded, 'GLOP').termination.reason));

  const empty = await solve(new Model(), 'GLOP');
  assert.equal(empty.termination.reason, 'OPTIMAL');
  assert.equal(empty.objectiveValue(), 0);
  assert.deepEqual(empty.variableValues(), new Map());
});

test('solve parameters: friendly values, proto names and validation', () => {
  const { model } = gettingStarted();
  for (const parameters of [
    { timeLimit: 10, lpAlgorithm: 'DUAL_SIMPLEX', presolve: 'OFF', scaling: 'LOW' },
    { timeLimit: '2.5s', lpAlgorithm: 'LP_ALGORITHM_PRIMAL_SIMPLEX', enableOutput: false, threads: 1 },
    { timeLimit: Infinity, iterationLimit: 1000, glop: { useDualSimplex: true } },
  ]) {
    assert.equal(solveSync(model, 'GLOP', { parameters }).termination.reason, 'OPTIMAL');
  }
  assert.throws(() => solveSync(model, 'GLOP', { parameters: { nope: 1 } }), { name: 'TypeError', message: /no\s+such\s+field:\s+'nope'/ });
  assert.throws(() => solveSync(model, 'GLOP', { parameters: { lpAlgorithm: 'FASTEST' } }), TypeError);
  assert.throws(() => solveSync(model, 'GLOP', { parameters: { timeLimit: -1 } }), RangeError);
  assert.throws(() => solveSync(model, 'GLOP', { parameters: { timeLimit: NaN } }), TypeError);
  assert.throws(() => solveSync(model, 'GLOP', { parameters: 'fast' }), /plain object/);
  assert.throws(() => solveSync(model, 'GLOP', null), /plain object/);
});

test('an iteration limit ends the solve with a FEASIBLE or NO_SOLUTION_FOUND termination', () => {
  const result = solveSync(marketSplit(), 'GSCIP', { parameters: { nodeLimit: 1 } });
  assert.ok(['FEASIBLE', 'NO_SOLUTION_FOUND', 'INFEASIBLE'].includes(result.termination.reason), result.termination.reason);
  if (result.termination.reason !== 'INFEASIBLE') assert.equal(result.termination.limit, 'NODE');
});

test('solver types are validated', () => {
  const { model } = gettingStarted();
  assert.ok(Object.isFrozen(SolverType));
  assert.equal(SolverType.GLOP, 'GLOP');
  assert.throws(() => solveSync(model, 'NOPE'), /Unsupported or unregistered math_opt solver type: 'NOPE'/);
  assert.throws(() => solveSync(model, 'UNSPECIFIED'), /unregistered/);
  for (const missing of ['GLPK', 'OSQP', 'ECOS', 'SCS', 'SANTORINI', 'GUROBI', 'XPRESS'].filter((t) => !(t in SolverType))) {
    assert.throws(() => solveSync(model, missing), /unregistered/);
  }
  assert.throws(() => solveSync(model, 3), TypeError);
  assert.throws(() => solveSync({}, 'GLOP'), /expected a Model/);
});

test('variables: options, accessors, deletion and ids', () => {
  const model = new Model('m');
  const x = model.addVariable();
  assert.deepEqual([x.id, x.lowerBound, x.upperBound, x.integer, x.name], [0, -Infinity, Infinity, false, '']);
  const b = model.addBinaryVariable({ name: 'b' });
  const i = model.addIntegerVariable({ lb: -3, ub: 3 });
  assert.deepEqual([b.lowerBound, b.upperBound, b.integer, i.integer], [0, 1, true, true]);
  x.name = 'x';
  x.lowerBound = 0;
  x.upperBound = 4;
  x.integer = true;
  assert.equal(String(x), 'x');
  const ct = model.addLinearConstraint({ lb: 1, expr: x.plus(b).plus(i), name: 'sum' });
  model.maximize(x.plus(b.times(2)));
  model.deleteVariable(b);
  assert.throws(() => b.name, /Variable 1 was deleted/);
  assert.deepEqual(ct.terms(), [[x, 1], [i, 1]]);
  assert.deepEqual(model.objectiveExpression().terms(), [[x, 1]]);
  assert.equal(model.addVariable().id, 3); // ids are never reused
  assert.deepEqual(model.variables().map((v) => v.id), [0, 2, 3]);
  assert.equal(model.getVariable(2), i);
  assert.throws(() => model.getVariable(1), RangeError);
  assert.equal(model.numVariables, 3);
  assert.throws(() => model.deleteVariable(b), /was deleted/);
  assert.throws(() => model.addVariable({ lb: NaN }), TypeError);
  assert.throws(() => model.addVariable({ isInteger: 1 }), TypeError);
  assert.throws(() => model.addVariable({ name: 7 }), TypeError);
  assert.throws(() => model.addVariable('x'), /plain object/);
  assert.throws(() => { x.upperBound = NaN; }, TypeError);
});

test('constraints: both forms, coefficients, deletion', () => {
  const model = new Model();
  const x = model.addVariable({ name: 'x' });
  const y = model.addVariable({ name: 'y' });
  const c = model.addLinearConstraint(x.plus(y).plus(2).ge(5), 'c');
  assert.deepEqual([c.id, c.name, c.lowerBound, c.upperBound], [0, 'c', 3, Infinity]);
  const d = model.addLinearConstraint();
  assert.deepEqual([d.lowerBound, d.upperBound, d.terms()], [-Infinity, Infinity, []]);
  c.setCoefficient(x, 3).setCoefficient(y, 0);
  assert.equal(c.getCoefficient(x), 3);
  assert.equal(c.getCoefficient(y), 0);
  assert.deepEqual(c.terms(), [[x, 3]]);
  c.lowerBound = -1;
  c.upperBound = 1;
  c.name = 'renamed';
  assert.equal(model.getLinearConstraint(0).name, 'renamed');
  model.deleteLinearConstraint(d);
  assert.throws(() => d.lowerBound, /LinearConstraint 1 was deleted/);
  assert.deepEqual(model.linearConstraints(), [c]);
  assert.equal(model.numLinearConstraints, 1);
  assert.throws(() => model.getLinearConstraint(1), RangeError);
  assert.throws(() => c.setCoefficient(x, Infinity), TypeError);
  assert.throws(() => model.addLinearConstraint({ lb: NaN }), TypeError);
  assert.throws(() => model.addLinearConstraint({ expr: {} }), TypeError);
});

test('the objective can be read back and edited', () => {
  const model = new Model();
  const x = model.addVariable({ name: 'x' });
  model.minimize(x.times(2).plus(5));
  assert.equal(model.isMaximize, false);
  assert.equal(model.objectiveOffset, 5);
  assert.equal(model.objectiveCoefficient(x), 2);
  model.setObjectiveCoefficient(x, 0);
  assert.deepEqual(model.objectiveExpression().terms(), []);
  model.isMaximize = true;
  model.objectiveOffset = 1;
  assert.throws(() => { model.objectiveOffset = Infinity; }, TypeError);
  assert.throws(() => { model.isMaximize = 'yes'; }, TypeError);
});

test('exportModel() produces a sorted ModelProto', () => {
  const model = new Model('e');
  const x = model.addVariable({ lb: 0, name: 'x' });
  const y = model.addIntegerVariable({ ub: 3, name: 'y' });
  model.addLinearConstraint(y.plus(x).le(4), 'c');
  model.maximize(y.plus(x.times(2)));
  assert.deepEqual(model.exportModel(), {
    name: 'e',
    variables: { ids: [0, 1], lowerBounds: [0, -Infinity], upperBounds: [Infinity, 3], integers: [false, true], names: ['x', 'y'] },
    objective: { maximize: true, offset: 0, linearCoefficients: { ids: [0, 1], values: [2, 1] } },
    linearConstraints: { ids: [0], lowerBounds: [-Infinity], upperBounds: [4], names: ['c'] },
    linearConstraintMatrix: { rowIds: [0, 0], columnIds: [0, 1], coefficients: [1, 1] },
  });
});

test('handles from another model are rejected', () => {
  const a = new Model();
  const b = new Model();
  const x = a.addVariable();
  const y = b.addVariable();
  assert.throws(() => a.addLinearConstraint(x.plus(y).le(1)), /belongs to a different Model/);
  assert.equal(a.numLinearConstraints, 0);
  assert.throws(() => a.maximize(y), /different Model/);
  assert.throws(() => a.objectiveCoefficient(y), /different Model/);
  const result = solveSync(b, 'GLOP');
  assert.throws(() => result.variableValues(x), /not part of the solved model/);
  assert.throws(() => result.variableValues('x'), TypeError);
});

test('model parameters: hints and priorities by Variable, filters as proto JSON', () => {
  const { model, x, y } = simpleMip();
  const hinted = solveSync(model, 'GSCIP', {
    modelParameters: { solutionHints: [new Map([[y, 2], [x, 3]])], branchingPriorities: new Map([[y, 2]]) },
  });
  assertNear(hinted.objectiveValue(), 23);
  const filtered = solveSync(model, 'GSCIP', {
    modelParameters: { variableValuesFilter: { filterByIds: true, filteredIds: [x.id] } },
  });
  assert.deepEqual([...filtered.variableValues().keys()], [x]);
  assert.throws(() => filtered.variableValues(y), /No value for Variable 1/);
  assert.throws(() => solveSync(model, 'GSCIP', { modelParameters: { branchingPriorities: new Map([[y, 1.5]]) } }),
    /must be an integer/);
  assert.throws(() => solveSync(model, 'GSCIP', { modelParameters: { solutionHints: [new Map([[new Model().addVariable(), 1]])] } }),
    /different Model/);
  assert.throws(() => solveSync(model, 'GSCIP', { modelParameters: { variableValuesFilter: { filterByIds: true, filteredIds: [99] } } }),
    /missing from model IDs/);
});

test('results cover the model as it was solved; the model may change during solve()', async () => {
  const { model, x, y, c } = gettingStarted();
  const pending = solve(model, 'GLOP');
  model.deleteVariable(y);
  const late = model.addVariable({ name: 'late' });
  const result = await pending;
  assertNear(result.objectiveValue(), 2.5);
  assertNear(result.variableValues(y), 1); // still part of the solved snapshot
  assert.throws(() => result.variableValues(late), /not part of the solved model/);
  assertNear(result.dualValues(c), 1);
  assertNear(solveSync(model, 'GLOP').variableValues(x), 1.5);
});

test('concurrent solves are independent', async () => {
  const lp = gettingStarted();
  const mip = simpleMip();
  const [a, b] = await Promise.all([solve(lp.model, 'GLOP'), solve(mip.model, 'CP_SAT')]);
  assertNear(a.objectiveValue(), 2.5);
  assertNear(b.objectiveValue(), 23);
});

test('a SolveInterrupter stops a running solve and stays interrupted', async () => {
  // Reference: the same hard model under a 2 s limit runs the full 2 s.
  const parameters = { timeLimit: 2 };
  let started = Date.now();
  const limited = solveSync(marketSplit(), 'CP_SAT', { parameters });
  const limitedMs = Date.now() - started;
  assert.notEqual(limited.termination.limit, 'INTERRUPTED');
  assert.ok(limitedMs >= 1500, `the reference run ended after ${limitedMs} ms: the model is too easy`);

  const interrupter = new SolveInterrupter();
  assert.equal(interrupter.interrupted, false);
  started = Date.now();
  const pending = solve(marketSplit(), 'CP_SAT', { parameters, interrupter });
  setTimeout(() => interrupter.interrupt(), 100);
  const result = await pending;
  const interruptedMs = Date.now() - started;
  assert.equal(interrupter.interrupted, true);
  assert.equal(result.termination.limit, 'INTERRUPTED');
  assert.equal(result.termination.reason, 'NO_SOLUTION_FOUND');
  assert.ok(interruptedMs < limitedMs / 2, `interrupted after ${interruptedMs} ms vs ${limitedMs} ms uninterrupted`);

  // Already interrupted: the next solve stops at once.
  started = Date.now();
  const again = await solve(marketSplit(), 'CP_SAT', { parameters, interrupter });
  assert.equal(again.termination.limit, 'INTERRUPTED');
  assert.ok(Date.now() - started < limitedMs / 2);
  assert.throws(() => solve(gettingStarted().model, 'GLOP', { interrupter: {} }), /interrupter must be a SolveInterrupter/);
});

test('a time limit stops a hard model early', () => {
  const started = Date.now();
  const result = solveSync(marketSplit(), 'CP_SAT', { parameters: { timeLimit: 0.2 } });
  // Proving the model infeasible takes CP-SAT about 10 s: 0.2 s cannot settle it.
  assert.equal(result.termination.reason, 'NO_SOLUTION_FOUND');
  assert.ok(['TIME', 'UNDETERMINED'].includes(result.termination.limit), result.termination.limit);
  assert.ok(Date.now() - started < 2000, 'time limit ignored');
});

// Runs `body` in a child process, so a native crash fails the test instead of the run.
function runIsolated(body) {
  const script = `const { mathOpt } = require(${JSON.stringify(require.resolve('..'))});\n${body}`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 0, `child exited with ${child.status} (${child.signal}): ${child.stderr}`);
  return child.stdout.trim();
}

test('getters that change the model or start a solve while options are read are safe', () => {
  const out = runIsolated(`
    const model = new mathOpt.Model();
    const x = model.addVariable({ lb: 0, ub: 1, name: 'x' });
    model.maximize(x);
    let inner;
    const parameters = {};
    Object.defineProperty(parameters, 'threads', { enumerable: true, get() {
      model.deleteVariable(x);                          // the model changes before it is copied
      inner = mathOpt.solve(model, 'GLOP');             // and a nested solve starts
      return 1;
    } });
    mathOpt.solve(model, 'GLOP', { parameters }).then(async (outer) => {
      console.log('outer', outer.termination.reason, outer.variableValues().size);
      console.log('inner', (await inner).termination.reason);
    }, (e) => console.log('error', e.message));`);
  assert.match(out, /outer OPTIMAL 0/);
  assert.match(out, /inner OPTIMAL/);
});
