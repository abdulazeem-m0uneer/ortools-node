'use strict';
// CP-SAT model building: Domain, linear expressions, the CpModelProto the JS
// layer produces (checked against Python's cp_model) and argument validation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CpModel, CpSolver, CpLinearExpr, Domain, IntVar, NotBooleanVariable, BoundedLinearExpr, CpConstraint } = require('..');

const INT64_MAX = '9223372036854775807';
const INT64_MIN = '-9223372036854775808';

test('Domain normalises, merges and complements intervals', () => {
  assert.equal(String(Domain.fromValues([5, 1, 2, 3, 9])), '[1,3][5][9]');
  assert.equal(String(Domain.fromIntervals([[0, 2], [3, 5], [7]])), '[0,5][7]');
  assert.equal(String(Domain.fromFlatIntervals([10, 12, 0, 1])), '[0,1][10,12]');
  assert.deepEqual(Domain.fromValues([5]).complement().flattenedIntervals(), [-Infinity, 4, 6, Infinity]);
  assert.equal(Domain.allValues().complement().isEmpty(), true);
  assert.equal(String(new Domain(-Infinity, 3).complement()), '[4,Infinity]');
  assert.equal(new Domain(1, 0).isEmpty(), true);
  assert.equal(Domain.fromValues([]).isEmpty(), true);
  assert.equal(Domain.fromIntervals([[0, 3], [8, 9]]).contains(5), false);
  assert.equal(Domain.fromIntervals([[0, 3], [8, 9]]).contains(8), true);
  assert.equal(new Domain(-2, 7).min(), -2);
  assert.equal(new Domain(-2, 7).max(), 7);
  assert.throws(() => new Domain(1, 0).min(), RangeError);
});

test('Domain keeps int64 values exact and maps the int64 extremes to ±Infinity', () => {
  const big = 2n ** 62n;
  assert.deepEqual(new Domain(big, big + 1n).flattenedIntervals(), [big, big + 1n]);
  assert.deepEqual(new Domain(0, 2n ** 63n - 1n).flattenedIntervals(), [0, Infinity]);
  assert.deepEqual(new Domain(-(2n ** 63n), 0).flattenedIntervals(), [-Infinity, 0]);
  assert.deepEqual(new Domain(2n ** 53n, 2n ** 53n).complement().flattenedIntervals(),
    [-Infinity, Number.MAX_SAFE_INTEGER, 2n ** 53n + 1n, Infinity]);
  // Safe values come back as numbers, so equal values compare with ===.
  assert.deepEqual(new Domain(5n, 6n).flattenedIntervals(), [5, 6]);
});

test('Domain rejects NaN, fractions, unsafe numbers and out-of-range BigInts', () => {
  assert.throws(() => new Domain(NaN, 1), TypeError);
  assert.throws(() => new Domain(0.5, 1), TypeError);
  assert.throws(() => new Domain(0, 2 ** 60), RangeError);
  assert.throws(() => new Domain(0, 2n ** 64n), RangeError);
  assert.throws(() => new Domain('0', 1), TypeError);
  assert.throws(() => Domain.fromValues([1, Infinity]), TypeError);
  assert.throws(() => Domain.fromValues('1'), TypeError);
  assert.throws(() => Domain.fromFlatIntervals([1, 2, 3]), TypeError);
  assert.throws(() => Domain.fromIntervals([[1, 2, 3]]), TypeError);
  assert.throws(() => Domain.fromValues([1]).contains(Infinity), TypeError);
});

test('linear expressions flatten, merge duplicate variables and drop zero terms', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 10, 'x');
  const y = m.newIntVar(0, 10, 'y');
  const b = m.newBoolVar('b');
  m.add(x.plus(y.times(3)).minus(x).plus(b.not()).plus(4).le(20));
  assert.deepEqual(m.toJSON().constraints[0].linear, {
    vars: [1, 2], coeffs: ['3', '-1'], domain: [INT64_MIN, '15'],  // 3y + (1 - b) + 4 <= 20
  });
  assert.equal(String(x.plus(y.times(2)).plus(1)), 'x + 2 * y + 1');
  assert.equal(String(CpLinearExpr.constant(0)), '0');
  assert.ok(x.le(3) instanceof BoundedLinearExpr);
});

test('every comparison maps onto the right domain', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 10, 'x');
  for (const [ble, domain] of [
    [x.le(3), [INT64_MIN, '3']],
    [x.lt(3), [INT64_MIN, '2']],
    [x.ge(3), ['3', INT64_MAX]],
    [x.gt(3), ['4', INT64_MAX]],
    [x.eq(3), ['3', '3']],
    [x.ne(3), [INT64_MIN, '2', '4', INT64_MAX]],
  ]) {
    m.add(ble);
    const { linear } = m.toJSON().constraints.at(-1);
    assert.deepEqual(linear, { vars: [0], coeffs: ['1'], domain }, String(ble));
  }
  m.add(x.neg().le(-3));
  assert.deepEqual(m.toJSON().constraints.at(-1).linear, { vars: [0], coeffs: ['-1'], domain: [INT64_MIN, '-3'] });
});

test('sum, weightedSum, term and affine build the expected expressions', () => {
  const m = new CpModel();
  const [a, b, c] = [m.newIntVar(0, 5, 'a'), m.newIntVar(0, 5, 'b'), m.newIntVar(0, 5, 'c')];
  m.minimize(CpLinearExpr.sum([a, b, c, 7]));
  assert.deepEqual(m.toJSON().objective, { vars: [0, 1, 2], coeffs: ['1', '1', '1'], offset: 7 });
  m.maximize(CpLinearExpr.weightedSum([a, b], [2, -3]).plus(CpLinearExpr.affine(c, 4, 1)).plus(CpLinearExpr.term(a, 1)));
  assert.deepEqual(m.toJSON().objective, {
    vars: [0, 1, 2], coeffs: ['-3', '3', '-4'], offset: -1, scalingFactor: -1,
  });
  assert.throws(() => CpLinearExpr.weightedSum([a, b], [1]), TypeError);
  assert.throws(() => CpLinearExpr.sum(a), TypeError);
});

test('a deep .plus() chain does not overflow the stack', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 1, 'x');
  let e = x;
  for (let i = 0; i < 100000; ++i) e = e.plus(x);
  m.add(e.le(1000000));
  assert.deepEqual(m.toJSON().constraints[0].linear.coeffs, ['100001']);
});

test('expression arithmetic stays exact beyond 2^53 and rejects int64 overflow', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 10, 'x');
  m.add(x.times(2 ** 52).plus(x.times(2 ** 52)).le(0));
  assert.deepEqual(m.toJSON().constraints[0].linear.coeffs, [String(2n ** 53n)]);
  assert.throws(() => m.add(x.times(2n ** 62n).times(4).le(0)), RangeError);
  assert.throws(() => m.add(x.times(2n ** 62n).plus(x.times(2n ** 62n)).le(0)), RangeError);
  assert.throws(() => x.times(1.5), TypeError);
  assert.throws(() => x.plus(NaN), TypeError);
  assert.throws(() => x.plus('1'), TypeError);
  assert.throws(() => x.plus(2 ** 60), RangeError);
});

test('literals: not() only on Boolean variables, and double negation returns the variable', () => {
  const m = new CpModel();
  const b = m.newBoolVar('b');
  const x = m.newIntVar(0, 2, 'x');
  assert.ok(b.not() instanceof NotBooleanVariable);
  assert.equal(b.not().not(), b);
  assert.equal(b.not(), b.not());
  assert.equal(b.not().index, -b.index - 1);
  assert.equal(m.newIntVar(0, 1, 'c').isBoolean, true);
  assert.equal(x.isBoolean, false);
  assert.throws(() => x.not(), TypeError);
  assert.throws(() => m.addBoolOr([x]), TypeError);
  assert.throws(() => m.addBoolOr([1]), TypeError);
  // Booleans become shared constant variables, like Python's True / False.
  m.addBoolOr([true, false]);
  const { variables, constraints } = m.toJSON();
  assert.deepEqual(constraints[0].boolOr.literals, [3, 4]);
  assert.deepEqual(variables[3].domain, ['1', '1']);
  assert.deepEqual(variables[4].domain, ['0', '0']);
  assert.equal(m.newConstant(1), m.newConstant(1n));
});

test('the proto matches what Python cp_model builds for the same model', () => {
  // Generated with ortools 9.15 (cp_model.py), then printed as protobuf JSON.
  const python = {
    variables: [
      { name: 's', domain: ['0', '10'] }, { name: 'e', domain: ['0', '10'] },
      { name: 'z', domain: ['0', '5'] }, { name: 'p', domain: ['0', '1'] },
    ],
    constraints: [
      { name: 'i', interval: { start: { vars: [0], coeffs: ['1'] }, end: { vars: [1], coeffs: ['1'] }, size: { vars: [2], coeffs: ['1'] } } },
      { name: 'o', enforcementLiteral: [3], interval: { start: { vars: [0], coeffs: ['1'] }, end: { vars: [1], coeffs: ['1'] }, size: { offset: '3' } } },
      { name: 'f', interval: { start: { vars: [0], coeffs: ['1'] }, end: { vars: [0], coeffs: ['1'], offset: '4' }, size: { offset: '4' } } },
      { linMax: { target: { vars: [2], coeffs: ['-1'] }, exprs: [{ vars: [0], coeffs: ['-1'] }, { vars: [1], coeffs: ['-1'] }] } },
      { linMax: { target: { vars: [2], coeffs: ['1'] }, exprs: [{ vars: [0, 1], coeffs: ['1', '-1'] }, { vars: [0, 1], coeffs: ['-1', '1'] }] } },
      { element: { linearIndex: { vars: [2], coeffs: ['1'] }, linearTarget: { vars: [1], coeffs: ['1'] }, exprs: [{ vars: [0], coeffs: ['1'] }, { vars: [1], coeffs: ['1'] }, { offset: '3' }] } },
      { boolXor: { literals: [3, -4] } },
      { linear: { vars: [0], coeffs: ['1'], domain: [INT64_MIN, '2', '4', INT64_MAX] } },
      { reservoir: { maxLevel: '5', timeExprs: [{ vars: [0], coeffs: ['1'] }], levelChanges: [{ offset: '2' }] } },
      { enforcementLiteral: [3], boolAnd: { literals: [-4] } },
      { table: { values: ['1', '2', '3', '4'], exprs: [{ vars: [0], coeffs: ['1'] }, { vars: [1], coeffs: ['1'] }] } },
      { circuit: { tails: [0, 1], heads: [1, 0], literals: [3, -4] } },
      { enforcementLiteral: [3], linear: { vars: [0, 1], coeffs: ['1', '2'], domain: ['-5', '7'] } },
      { intProd: { target: { vars: [2], coeffs: ['1'] }, exprs: [{ vars: [0], coeffs: ['1'] }, { vars: [1], coeffs: ['1'] }] } },
      { intDiv: { target: { vars: [2], coeffs: ['1'] }, exprs: [{ vars: [0], coeffs: ['1'] }, { offset: '3' }] } },
      { intMod: { target: { vars: [2], coeffs: ['1'] }, exprs: [{ vars: [0], coeffs: ['1'] }, { offset: '3' }] } },
      { exactlyOne: { literals: [3, -4] } },
      { atMostOne: { literals: [3] } },
      { boolOr: { literals: [3] } },
      { boolAnd: { literals: [-4] } },
      { inverse: { fDirect: [0, 1], fInverse: [1, 0] } },
      { automaton: { finalStates: ['1'], transitionTail: ['0'], transitionHead: ['1'], transitionLabel: ['1'], exprs: [{ vars: [0], coeffs: ['1'] }] } },
    ],
    objective: { vars: [0, 1], offset: -3, scalingFactor: -1, coeffs: ['-1', '-2'] },
    searchStrategy: [{ exprs: [{ vars: [0], coeffs: ['1'] }, { vars: [3], coeffs: ['-1'], offset: '1' }] }],
    solutionHint: { vars: [3], values: ['0'] },
    assumptions: [3],
  };

  const m = new CpModel();
  const s = m.newIntVar(0, 10, 's');
  const e = m.newIntVar(0, 10, 'e');
  const z = m.newIntVar(0, 5, 'z');
  const p = m.newBoolVar('p');
  m.newIntervalVar(s, z, e, 'i');
  m.newOptionalIntervalVar(s, 3, e, p, 'o');
  m.newFixedSizeIntervalVar(s, 4, 'f');
  m.addMinEquality(z, [s, e]);
  m.addAbsEquality(z, s.minus(e));
  m.addElement(z, [s, e, 3], e);
  m.addHint(p.not(), true);
  m.addBoolXor([p, p.not()]);
  m.addDecisionStrategy([s, p.not()], 'CHOOSE_FIRST', 'SELECT_MIN_VALUE');
  m.maximize(s.plus(e.times(2)).plus(3));
  m.add(s.ne(3));
  m.addReservoirConstraint([s], [2], 0, 5);
  m.addImplication(p, p.not());
  m.addAllowedAssignments([s, e], [[1, 2], [3, 4]]);
  m.addCircuit([[0, 1, p], [1, 0, p.not()]]);
  m.addLinearConstraint(s.plus(e.times(2)), -5, 7).onlyEnforceIf(p);
  m.addMultiplicationEquality(z, [s, e]);
  m.addDivisionEquality(z, s, 3);
  m.addModuloEquality(z, s, 3);
  m.addExactlyOne([p, p.not()]);
  m.addAtMostOne([p]);
  m.addBoolOr([p]);
  m.addBoolAnd([p.not()]);
  m.addInverse([s, e], [e, s]);
  m.addAutomaton([s], 0, [1], [[0, 1, 1]]);
  m.addAssumptions([p]);
  assert.deepEqual(withoutDefaults(m.toJSON()), python);
  assert.equal(m.validate(), '');
});

// Drops proto3 default values, as protobuf's JSON printer does.
function withoutDefaults(value) {
  if (Array.isArray(value)) return value.map(withoutDefaults);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    const isDefault = v === '' || v === '0' || v === 0 || v === false ||
      (Array.isArray(v) && v.length === 0) || v === 'CHOOSE_FIRST' || v === 'SELECT_MIN_VALUE';
    if (!isDefault) out[key] = withoutDefaults(v);
  }
  return out;
}

test('constraints take literals and expressions as one Array or as separate arguments', () => {
  const m = new CpModel();
  const [a, b] = [m.newBoolVar('a'), m.newBoolVar('b')];
  m.addBoolOr(a, b.not());
  m.addBoolOr([a, b.not()]);
  m.addAllDifferent(a, b);
  m.addAllDifferent([a, b]);
  m.addMultiplicationEquality(a, a, b);
  m.addMultiplicationEquality(a, [a, b]);
  m.addAssumptions(a, b);
  const c = m.toJSON().constraints;
  assert.deepEqual(c[0], c[1]);
  assert.deepEqual(c[2], c[3]);
  assert.deepEqual(c[4], c[5]);
  assert.deepEqual(m.toJSON().assumptions, [0, 1]);
});

test('CpConstraint: onlyEnforceIf accumulates literals, withName names it', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 10, 'x');
  const [a, b] = [m.newBoolVar('a'), m.newBoolVar('b')];
  const ct = m.add(x.ge(5)).onlyEnforceIf(a).onlyEnforceIf([b.not(), true]).withName('big');
  assert.ok(ct instanceof CpConstraint);
  assert.equal(ct.name, 'big');
  assert.equal(String(ct), 'big');
  assert.deepEqual(m.toJSON().constraints[0].enforcementLiteral, [1, -3, 3]);
  assert.throws(() => ct.withName(5), TypeError);
  assert.throws(() => ct.onlyEnforceIf(x), TypeError);
});

test('variables, intervals and literals from another model are rejected before any change', () => {
  const m1 = new CpModel();
  const m2 = new CpModel();
  const x1 = m1.newIntVar(0, 5, 'x1');
  const b1 = m1.newBoolVar('b1');
  const i1 = m1.newFixedSizeIntervalVar(x1, 2, 'i1');
  const x2 = m2.newIntVar(0, 5, 'x2');
  const before = JSON.stringify(m2.toJSON());
  assert.throws(() => m2.add(x2.plus(x1).le(3)), /different CpModel/);
  assert.throws(() => m2.addBoolOr([b1]), /different CpModel/);
  assert.throws(() => m2.addBoolOr([b1.not()]), /different CpModel/);
  assert.throws(() => m2.addNoOverlap([i1]), /different CpModel/);
  assert.throws(() => m2.minimize(x1), /different CpModel/);
  assert.throws(() => m2.addHint(x1, 1), /different CpModel/);
  assert.throws(() => m2.addInverse([x1], [x2]), /different CpModel/);
  assert.throws(() => m2.addDecisionStrategy([x1], 'CHOOSE_FIRST', 'SELECT_MIN_VALUE'), /different CpModel/);
  assert.throws(() => m2.newFixedSizeIntervalVar(x1, 2), /different CpModel/);
  assert.throws(() => m2.addImplication(x2.isBoolean ? x2 : b1, b1), /different CpModel/);
  assert.equal(JSON.stringify(m2.toJSON()), before);
});

test('invalid arguments throw TypeError / RangeError instead of reaching OR-Tools', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 5, 'x');
  const b = m.newBoolVar('b');
  const iv = m.newFixedSizeIntervalVar(x, 2, 'iv');
  const count = () => m.toJSON().constraints.length;
  const before = count();
  assert.throws(() => m.newIntVar(NaN, 5), TypeError);
  assert.throws(() => m.newIntVar(0, 5.5), TypeError);
  assert.throws(() => m.newIntVar(0, 5, 7), TypeError);
  assert.throws(() => m.newIntVarFromDomain([0, 5]), TypeError);
  assert.throws(() => m.add(x), TypeError);
  assert.throws(() => m.add(null), TypeError);
  assert.throws(() => m.addLinearConstraint(x, 0, NaN), TypeError);
  assert.throws(() => m.addLinearExpressionInDomain(x, [0, 1]), TypeError);
  assert.throws(() => m.addElement(x, [], x), RangeError);
  assert.throws(() => m.addElement(5, [1, 2], x), RangeError);
  assert.throws(() => m.addCircuit([]), RangeError);
  assert.throws(() => m.addCircuit([[0, 1]]), TypeError);
  assert.throws(() => m.addCircuit([[-1, 1, b]]), RangeError);
  assert.throws(() => m.addCircuit([[0, 2 ** 31, b]]), RangeError);
  assert.throws(() => m.addCircuit([[0, 0.5, b]]), TypeError);
  assert.throws(() => m.addMultipleCircuit([]), RangeError);
  assert.throws(() => m.addAllowedAssignments([], []), RangeError);
  assert.throws(() => m.addAllowedAssignments([x], [[1, 2]]), TypeError);
  assert.throws(() => m.addForbiddenAssignments([x], [[NaN]]), TypeError);
  assert.throws(() => m.addAutomaton([], 0, [1], [[0, 1, 1]]), RangeError);
  assert.throws(() => m.addAutomaton([x], 0, [], [[0, 1, 1]]), RangeError);
  assert.throws(() => m.addAutomaton([x], 0, [1], []), RangeError);
  assert.throws(() => m.addAutomaton([x], 0, [1], [[0, 1]]), TypeError);
  assert.throws(() => m.addInverse([], []), RangeError);
  assert.throws(() => m.addInverse([x], [x, x]), RangeError);
  assert.throws(() => m.addInverse([x.plus(1)], [x]), TypeError);
  assert.throws(() => m.addReservoirConstraint([x], [1], 1, 5), RangeError);
  assert.throws(() => m.addReservoirConstraint([x], [1], -5, -1), RangeError);
  assert.throws(() => m.addReservoirConstraint([x], [1], 0, -1), RangeError);
  assert.throws(() => m.addReservoirConstraint([x], [1, 2], 0, 5), RangeError);
  assert.throws(() => m.addReservoirConstraintWithActive([x], [1], [], 0, 5), RangeError);
  assert.throws(() => m.addMinEquality(x, []), RangeError);
  assert.throws(() => m.addMaxEquality(x, 'x'), TypeError);
  assert.throws(() => m.addNoOverlap([x]), TypeError);
  assert.throws(() => m.addNoOverlap2D([iv], []), RangeError);
  assert.throws(() => m.addCumulative([iv], [], 1), RangeError);
  assert.throws(() => m.addDecisionStrategy([x], 'NOPE', 'SELECT_MIN_VALUE'), TypeError);
  assert.throws(() => m.addDecisionStrategy([x], 'CHOOSE_FIRST', 'NOPE'), TypeError);
  assert.throws(() => m.addHint(x, 1.5), TypeError);
  assert.throws(() => m.addHint(b.not(), 2), TypeError);
  assert.throws(() => m.addHint(3, 1), TypeError);
  assert.throws(() => m.addAssumption(x), TypeError);
  assert.throws(() => m.minimize('x'), TypeError);
  assert.throws(() => { m.name = 3; }, TypeError);
  assert.equal(count(), before);
});

test('hints, assumptions, objective and strategies can be cleared', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 5, 'x');
  const b = m.newBoolVar('b');
  m.addHint(x, 3);
  m.addHint(b, false);
  m.addHint(b.not(), 0);
  assert.deepEqual(m.toJSON().solutionHint, { vars: [0, 1, 1], values: ['3', '0', '1'] });
  m.addAssumption(b);
  m.minimize(x);
  assert.equal(m.hasObjective(), true);
  m.clearHints();
  m.clearAssumptions();
  m.clearObjective();
  assert.equal(m.hasObjective(), false);
  const proto = m.toJSON();
  assert.equal(proto.solutionHint, undefined);
  assert.equal(proto.assumptions, undefined);
  assert.equal(proto.objective, undefined);
});

test('toJSON returns a copy; JSON.stringify(model) gives the proto JSON', () => {
  const m = new CpModel();
  m.name = 'copy';
  m.newIntVar(0, 5, 'x');
  const proto = m.toJSON();
  proto.variables.push({ domain: ['9', '9'] });
  assert.equal(m.toJSON().variables.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m.toJSON());
  assert.equal(m.name, 'copy');
});

test('IntVar and IntervalVar expose their definition', () => {
  const m = new CpModel();
  const x = m.newIntVarFromDomain(Domain.fromValues([1, 3, 5]), 'x');
  assert.ok(x instanceof IntVar);
  assert.equal(String(x.domain), '[1][3][5]');
  assert.equal(x.name, 'x');
  assert.equal(String(m.newIntVar(0, 1)), 'x1');
  assert.throws(() => { x.index = 7; }, TypeError);
  const p = m.newBoolVar('p');
  const iv = m.newOptionalFixedSizeIntervalVar(x, 4, p, 'task');
  assert.equal(iv.name, 'task');
  assert.equal(String(iv.startExpr()), 'x');
  assert.equal(String(iv.sizeExpr()), '4');
  assert.equal(String(iv.endExpr()), 'x + 4');
  assert.equal(iv.presenceLiteral(), p);
  assert.equal(m.newIntervalVar(x, 1, x.plus(1)).presenceLiteral(), null);
});

test('validate() returns OR-Tools\' message for invalid models and modelStats() describes the model', () => {
  const m = new CpModel();
  assert.equal(m.validate(), '');
  m.newIntVar(-Infinity, Infinity, 'huge');
  assert.match(m.validate(), /domain do not fall in/);
  const ok = new CpModel();
  ok.addExactlyOne([ok.newBoolVar('a'), ok.newBoolVar('b')]);
  assert.match(ok.modelStats(), /kExactlyOne: 1/);
});

test('modelStats() validates first: an out-of-range index throws instead of crashing', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const native = require(${JSON.stringify(require('node:path').join(__dirname, '..', 'lib', 'native'))});
    const { CpModel } = require(${JSON.stringify(require('node:path').join(__dirname, '..'))});
    const results = [];
    for (const vars of [[100000000], [7]]) {
      const json = JSON.stringify({ variables: [{ domain: ['0', '1'] }], objective: { vars, coeffs: ['1'] } });
      try { native.cpModelStats(json); results.push('no error'); } catch (e) { results.push(e.message); }
    }
    const model = new CpModel();
    model.newBoolVar('b');
    model._proto.constraints.push({ boolOr: { literals: [5] } });
    try { model.modelStats(); results.push('no error'); } catch (e) { results.push(e.message); }
    console.log(JSON.stringify(results));
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  for (const message of JSON.parse(child.stdout)) assert.match(message, /^Invalid CpModel: /);
});

test('Domain.fromValues and contains() treat the int64 extremes like every other factory', () => {
  const M = 2n ** 63n - 1n;
  const m = -(2n ** 63n);
  assert.deepEqual(Domain.fromValues([M]).flattenedIntervals(), [Infinity, Infinity]);
  assert.equal(Domain.fromValues([M]).max(), new Domain(0, M).max());
  assert.equal(String(Domain.fromValues([M]).complement()), String(new Domain(M, M).complement()));
  assert.deepEqual(Domain.fromValues([M]).complement().flattenedIntervals(), [-Infinity, M - 1n]);
  assert.equal(Domain.fromValues([M]).complement().contains(M), false);
  assert.deepEqual(Domain.fromValues([m]).complement().flattenedIntervals(), [m + 1n, Infinity]);
  assert.equal(Domain.fromValues([m]).complement().contains(m), false);
  assert.deepEqual(Domain.fromValues([M - 1n, M]).complement().flattenedIntervals(), [-Infinity, M - 2n]);
  assert.equal(Domain.fromValues([M]).contains(M), true);
  assert.equal(new Domain(-Infinity, 0).contains(m), true);
  assert.throws(() => Domain.fromValues([Infinity]), TypeError);
  assert.throws(() => Domain.fromValues([M]).contains(-Infinity), TypeError);
});

test('addHint on a negated literal takes booleans, 0 / 1 and 0n / 1n', () => {
  const m = new CpModel();
  const b = m.newBoolVar('b');
  m.addHint(b.not(), 1n);
  m.addHint(b.not(), 0n);
  m.addHint(b.not(), true);
  assert.deepEqual(m.toJSON().solutionHint, { vars: [0, 0, 0], values: ['0', '1', '0'] });
  assert.throws(() => m.addHint(b.not(), 2n), TypeError);
});

test('eq/ge at INT64_MAX and eq/le at INT64_MIN are rejected as in Python', () => {
  const MIN = -(2n ** 63n);
  const MAX = 2n ** 63n - 1n;
  const m = new CpModel();
  const x = m.newIntVar(0, 10, 'x');
  // x + 5 == INT64_MAX would otherwise export x == INT64_MAX: the offset is
  // lost on the unbounded end.
  for (const make of [
    () => x.eq(MAX), () => x.eq(MIN), () => x.ge(MAX), () => x.le(MIN),
    () => x.plus(5).eq(MAX), () => x.plus(5).ge(Infinity), () => x.minus(5).eq(MIN), () => x.minus(5).le(-Infinity),
  ]) {
    assert.throws(make, RangeError, String(make));
  }
  assert.equal(m.toJSON().constraints.length, 0);
  assert.deepEqual(x.plus(5).ge(MIN).toString(), x.plus(5).ge(-Infinity).toString());
  assert.deepEqual(x.plus(5).le(MAX).toString(), x.plus(5).le(Infinity).toString());
});

test('CpLinearExpr cannot be constructed directly', () => {
  assert.throws(() => new CpLinearExpr(), /CpLinearExpr\.sum\(\)/);
  assert.ok(CpLinearExpr.constant(3) instanceof CpLinearExpr);
});

test('comparisons with the int64 extremes become unbounded or exact domains', () => {
  const MIN = -(2n ** 63n);
  const MAX = 2n ** 63n - 1n;
  const m = new CpModel();
  const z = m.newIntVar(0, 1, 'z');
  const cases = [
    [z.ge(MIN), [INT64_MIN, INT64_MAX]],
    [z.le(MAX), [INT64_MIN, INT64_MAX]],
    [z.gt(MIN), [String(MIN + 1n), INT64_MAX]],
    [z.lt(MAX), [INT64_MIN, String(MAX - 1n)]],
    [z.ne(MIN), [String(MIN + 1n), INT64_MAX]],
    [z.lt(MIN), []],
    [z.plus(5).le(7), [INT64_MIN, '2']],
  ];
  for (const [ble, domain] of cases) {
    m.add(ble);
    assert.deepEqual(m.toJSON().constraints.at(-1).linear.domain, domain, String(ble));
  }
  const ok = new CpModel();
  const y = ok.newIntVar(0, 1, 'y');
  ok.add(y.ge(MIN));
  ok.add(y.le(MAX));
  assert.equal(new CpSolver().solveSync(ok), 'OPTIMAL');
});

test('names must be well-formed Unicode: lone surrogates are rejected where they enter', () => {
  const m = new CpModel();
  const x = m.newIntVar(0, 5, 'x');
  const before = JSON.stringify(m.toJSON());
  assert.throws(() => m.newIntVar(0, 1, 'a\ud800'), /Variable name must be well-formed Unicode/);
  assert.throws(() => m.newBoolVar('\udc00'), /Variable name must be well-formed Unicode/);
  assert.throws(() => m.newIntervalVar(x, 1, x.plus(1), 'i\ud800'), /Interval name must be well-formed Unicode/);
  assert.throws(() => m.add(x.le(3)).withName('\udc00'), /withName\(name\): name must be well-formed Unicode/);
  assert.throws(() => { m.name = 'm\ud800'; }, /CpModel name must be well-formed Unicode/);
  m.name = 'model \u{1F600}';  // a surrogate pair is fine
  m.newBoolVar('ok \u{1F600}');
  assert.equal(m.validate(), '');
  assert.equal(m.toJSON().constraints.length, JSON.parse(before).constraints.length + 1);  // only the add() above
});

test('CpLinearExpr cannot be subclassed outside the library', () => {
  class Mine extends CpLinearExpr {}
  assert.throws(() => new Mine(), /CpLinearExpr is closed/);
});
