'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CpSolver, IntVar, IntExpr } = require('..').cp;

test('intVar(min, max, name) exposes its domain', () => {
  const s = new CpSolver('vars');
  const x = s.intVar(0, 5, 'x');
  assert.ok(x instanceof IntVar);
  assert.equal(x.name(), 'x');
  assert.equal(x.min(), 0);
  assert.equal(x.max(), 5);
  assert.equal(x.size(), 6);
  assert.equal(x.bound(), false);
  assert.ok(x.contains(3));
  assert.ok(!x.contains(6));
  assert.equal(String(x), 'x');
});

test('intVar(values) builds a sparse domain', () => {
  const s = new CpSolver();
  const x = s.intVar([1, 3, 7], 'odd');
  assert.equal(x.size(), 3);
  assert.equal(x.min(), 1);
  assert.equal(x.max(), 7);
  assert.ok(!x.contains(2));
  const typed = s.intVar(new Int32Array([4, 2]));
  assert.equal(typed.min(), 2);
});

test('boolVar and intConst', () => {
  const s = new CpSolver();
  const b = s.boolVar('b');
  assert.equal(b.min(), 0);
  assert.equal(b.max(), 1);
  const c = s.intConst(42);
  assert.ok(c.bound());
  assert.equal(c.value(), 42);
});

test('±Infinity bounds map to the int64 extremes and back; BigInt is accepted', () => {
  const s = new CpSolver();
  const x = s.intVar(-Infinity, Infinity, 'free');
  assert.equal(x.min(), -Infinity);
  assert.equal(x.max(), Infinity);
  const y = s.intVar(0n, 10n);
  assert.equal(y.max(), 10);
  assert.throws(() => s.intVar(0, 2n ** 62n).max(), RangeError, 'unsafe values are not rounded');
});

test('bad variable arguments throw instead of reaching OR-Tools', () => {
  const s = new CpSolver();
  assert.throws(() => s.intVar(NaN, 3), TypeError);
  assert.throws(() => s.intVar(0, 1.5), TypeError);
  assert.throws(() => s.intVar('0', 3), TypeError);
  assert.throws(() => s.intVar(3, 2), /min must be <= max/);
  assert.throws(() => s.intVar([]), /must not be empty/);
  assert.throws(() => s.intConst(Infinity), TypeError);
  assert.throws(() => new CpSolver(42), TypeError);
});

test('domain changes narrow the variable outside a search', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 10, 'x');
  x.setMin(2).setMax(8);
  assert.deepEqual([x.min(), x.max()], [2, 8]);
  x.setRange(3, 7);
  x.removeValue(3).removeValues([7, 6]);
  assert.deepEqual([x.min(), x.max(), x.size()], [4, 5, 2]);
  x.setValue(5);
  assert.ok(x.bound());
  assert.equal(x.value(), 5);
});

test('a domain change that empties the domain throws a CP solver failure', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 5, 'x');
  assert.throws(() => x.setMax(-1), /CP solver failure: setMax\(\)/);
  assert.throws(() => x.setMin(6), /CP solver failure/);
  assert.throws(() => x.setValue(9), /CP solver failure/);
  assert.throws(() => x.setRange(7, 9), /CP solver failure/);
  const y = s.intVar(0, 10, 'y');
  assert.throws(() => x.plus(y).setRange(15, 4), /min must be <= max/);
  assert.deepEqual([y.min(), y.max()], [0, 10], 'an empty range is rejected before narrowing anything');
  assert.throws(() => x.removeValues([0, 1, 2, 3, 4, 5]), /CP solver failure/);
  assert.throws(() => s.intConst(1).removeValue(1), /CP solver failure/);
  // The solver stays usable.
  x.setMax(4);
  assert.deepEqual([x.min(), x.max()], [0, 4]);
});

test('value() of an unbound variable throws', () => {
  const s = new CpSolver();
  assert.throws(() => s.intVar(0, 3, 'x').value(), /not bound/);
});

test('arithmetic expressions propagate bounds', () => {
  const s = new CpSolver();
  const x = s.intVar(1, 3, 'x');
  const y = s.intVar(-2, 4, 'y');
  const cases = [
    [x.plus(y), -1, 7],
    [x.plus(10), 11, 13],
    [x.minus(y), -3, 5],
    [x.minus(1), 0, 2],
    [x.times(3), 3, 9],
    [x.times(y), -6, 12],
    [y.abs(), 0, 4],
    [y.square(), 0, 16],
    [x.opposite(), -3, -1],
    [s.sum([x, y, x]), 0, 10],
    [s.scalProd([x, y], [2, -1]), -2, 8],
    [s.min(x, y), -2, 3],
    [s.max(x, 2), 2, 3],
    [s.min([x, y]), -2, 3],
    [s.max([x, y]), 1, 4],
  ];
  for (const [expr, lo, hi] of cases) {
    assert.ok(expr instanceof IntExpr);
    assert.deepEqual([expr.min(), expr.max()], [lo, hi]);
  }
  assert.equal(s.sum([]).max(), 0);
});

test('element over constants and over variables', () => {
  const s = new CpSolver();
  const i = s.intVar(0, 2, 'i');
  const e = s.element([10, 30, 20], i);
  assert.deepEqual([e.min(), e.max()], [10, 30]);
  const a = s.intVar(0, 1);
  const b = s.intVar(5, 6);
  const ev = s.element([a, b], s.intVar(0, 1));
  assert.deepEqual([ev.min(), ev.max()], [0, 6]);
});

test('expression builders validate their arguments', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 3, 'x');
  assert.throws(() => x.plus('1'), TypeError);
  assert.throws(() => x.plus(1.5), TypeError);
  assert.throws(() => x.minus(-(2n ** 63n)), /greater than -2\^63/);
  assert.throws(() => s.scalProd([x], [1, 2]), /same length/);
  assert.throws(() => s.min([]), /at least one/);
  assert.throws(() => s.min([x], x), TypeError);
  assert.throws(() => s.element([], x), /must not be empty/);
  assert.throws(() => s.sum(x), TypeError);
  assert.throws(() => s.allowedAssignments([x, x], [[1]]), /one value per variable/);
  assert.throws(() => s.allowedAssignments([], [[1]]), /must not be empty/);
  assert.throws(() => s.add(x), TypeError);
  assert.throws(() => s.phase([x], 'CHOOSE_PATH', 'ASSIGN_MIN_VALUE'), /unknown variable strategy/);
  assert.throws(() => s.phase([x], 'CHOOSE_FIRST_UNBOUND', 'NOPE'), /unknown value strategy/);
  assert.throws(() => s.minimize(x, 0), /step must be > 0/);
  assert.throws(() => s.searchLog(0), /period/);
  assert.throws(() => s.limit({ branches: -1 }), /branches must be >= 0/);
  assert.throws(() => s.limit({ timeMs: NaN }), /timeMs/);
  assert.throws(() => s.bestValueSolutionCollector(), TypeError);
});

test('handles from another solver are rejected', () => {
  const a = new CpSolver('a');
  const b = new CpSolver('b');
  const x = a.intVar(0, 1, 'x');
  const y = b.intVar(0, 1, 'y');
  assert.throws(() => b.add(x.eq(1)), /different CpSolver/);
  assert.throws(() => x.plus(y), /different CpSolver/);
  assert.throws(() => b.sum([x]), /different CpSolver/);
  assert.throws(() => b.solve(a.phase([x], 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE')), /different CpSolver/);
  const collector = a.allSolutionCollector();
  assert.throws(() => b.solve(b.phase([y], 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE'), [collector]),
    /different CpSolver/);
});

test('dispose frees the solver; later calls and old handles throw', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 3, 'x');
  s.dispose();
  s.dispose(); // idempotent
  assert.throws(() => x.min(), /no longer valid/);
  assert.throws(() => s.intVar(0, 1), /disposed/);
  assert.throws(() => s.wallTime(), /disposed/);
});

test('`using` disposes the solver', () => {
  let leaked;
  {
    const s = new CpSolver();
    leaked = s;
    s[Symbol.dispose]();
  }
  assert.throws(() => leaked.boolVar(), /disposed/);
});

test('raw native ids are range checked', () => {
  const s = new CpSolver();
  s.intVar(0, 1);
  assert.throws(() => s._n.exprMin(5), RangeError);
  assert.throws(() => s._n.exprMin(-1), RangeError);
  assert.throws(() => s._n.exprMin(0.5), TypeError);
  assert.throws(() => s._n.add(0), RangeError);
  assert.throws(() => s._n.collectorCount(0), RangeError);
  assert.throws(() => s._n.solve(0, []), RangeError);
  s.intVar(0, 1);
  const e = s._n.binary('plus', 0, 1); // x + y is an expression, not a variable
  assert.equal(s._n.exprIsVar(e), false);
  assert.throws(() => s._n.varValue(e), /must be an IntVar/);
  assert.throws(() => s._n.binary('nope', 0, 0), /unknown binary/);
  assert.throws(() => s._n.unary('nope', 0), /unknown unary/);
  assert.throws(() => s._n.compare('nope', 0, 0), /comparison must be/);
  assert.throws(() => s._n.member('nope', 0, [1]), /unknown membership/);
  assert.throws(() => s._n.collector('nope'), /unknown collector/);
});

test('wide domains still allow bound removals and narrow membership', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 1e10, 'x');
  x.removeValue(0).removeValues([1, 2, 1e10]);
  assert.deepEqual([x.min(), x.max()], [3, 1e10 - 1], 'values at the bounds only move the bounds');
  s.add(s.memberCt(x, [5, 9, 11]));
  const all = s.allSolutionCollector().add(x);
  s.solve(s.phase([x], 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE'), [all]);
  assert.deepEqual([0, 1, 2].map((n) => all.value(n, x)), [5, 9, 11]);
  const y = s.intVar(0, 100);
  y.removeValue(50);
  assert.equal(y.contains(50), false, 'narrow domains keep their holes');
  assert.throws(() => x.removeValue(7), RangeError);
});

// A regression here aborts the process (OR-Tools' "Bitset too large" CHECK),
// so each case runs in a child process and must exit cleanly.
test('removeValues() on a wide domain accepts bound values in any order', () => {
  const { spawnSync } = require('node:child_process');
  const root = JSON.stringify(require('node:path').join(__dirname, '..'));
  const cases = [
    ['[2 ** 40 - 1, 2 ** 40]', [0, 2 ** 40 - 2]],
    ['[1, 0]', [2, 2 ** 40]],
    ['[3, 2, 1, 0]', [4, 2 ** 40]],
    ['[2 ** 40 - 3, 2 ** 40 - 2, 2 ** 40 - 1, 2 ** 40]', [0, 2 ** 40 - 4]],
    ['[2 ** 40, 1, -5, 0, 2 ** 40 - 1, 1]', [2, 2 ** 40 - 2]],
  ];
  for (const [values, bounds] of cases) {
    const script = `const { CpSolver } = require(${root}).cp;
      const x = new CpSolver().intVar(0, 2 ** 40).removeValues(${values});
      console.log(JSON.stringify([x.min(), x.max()]));`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${values}: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), bounds, values);
  }
});

test('a refused wide-domain membership names the public method', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 2 ** 40);
  assert.throws(() => s.memberCt(x, [0, 5, 2 ** 40]), /^RangeError: memberCt\(\): OR-Tools cannot make holes/);
  assert.throws(() => s.notMemberCt(x, [5]), /^RangeError: notMemberCt\(\): OR-Tools cannot make holes/);
  assert.throws(() => s.isMemberVar(x, [5]), /^RangeError: isMemberVar\(\): OR-Tools cannot make holes/);
});

test('removeValues() moves bounds and keeps holes when given in any order', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 10).removeValues([10, 5, 0, 5]);
  assert.deepEqual([x.min(), x.max(), x.contains(5), x.contains(4)], [1, 9, false, true]);
  const y = s.intVar(0, 1);
  assert.throws(() => y.removeValues([1, 0]), /CP solver failure: removeValues\(\)/);
  assert.deepEqual([y.min(), y.max()], [0, 1], 'a failed removal changes nothing');
});

const domainOf = (x) => {
  const values = [];
  for (let v = x.min(); v <= x.max(); v++) if (x.contains(v)) values.push(v);
  return values;
};

test('removeValues() that empties a domain with holes changes nothing', () => {
  const s = new CpSolver();
  const x = s.intVar(-2, 2).removeValue(1).removeValue(0);
  assert.throws(() => x.removeValues([-1, -2, 2]), /CP solver failure: removeValues\(\)/);
  assert.deepEqual(domainOf(x), [-2, -1, 2]);
  const y = s.intVar([0, 5, 10]);
  assert.throws(() => y.removeValues([0, 5, 10]), /CP solver failure: removeValues\(\)/);
  assert.deepEqual(domainOf(y), [0, 5, 10]);
});

test('removeValues() on the full int64 domain removes only what is listed', () => {
  const [MIN, MAX] = [-(2n ** 63n), 2n ** 63n - 1n];
  const s = new CpSolver();
  const x = s.intVar(MIN, MAX).removeValues([]);
  assert.deepEqual([x.contains(MIN), x.contains(0), x.contains(MAX)], [true, true, true], 'an empty removal is a no-op');
  x.removeValues([MAX]);
  assert.deepEqual([x.contains(MAX), x.contains(MAX - 1n), x.contains(MIN)], [false, true, true]);
  x.removeValues([MIN]);
  assert.deepEqual([x.contains(MIN), x.contains(MIN + 1n)], [false, true]);
  const y = s.intVar(MIN, MAX);
  assert.throws(() => y.removeValues([0]), /^RangeError: removeValues\(\): OR-Tools cannot make holes/);
  assert.deepEqual([y.contains(0), y.contains(MIN), y.contains(MAX)], [true, true, true], 'a refused hole changes nothing');
});

test('size() of a domain wider than int64 is Infinity, never a wrapped 0', () => {
  const s = new CpSolver();
  assert.equal(s.intVar(-(2n ** 63n), 2n ** 63n - 1n).size(), Infinity, 'the full int64 domain holds 2^64 values');
  assert.equal(s.intVar(-(2n ** 63n) + 1n, 2n ** 63n - 1n).size(), Infinity);
});

test('removeValues() matches a removeValue() loop, and a failed call changes nothing', () => {
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let i = 0; i < 4000; i++) {
    const lo = rand(7) - 3;
    const hi = lo + rand(7);
    const pre = Array.from({ length: rand(3) }, () => lo + rand(hi - lo + 1));
    const values = Array.from({ length: rand(7) }, () => lo - 2 + rand(hi - lo + 5));
    const make = () => {
      const x = new CpSolver().intVar(lo, hi);
      for (const v of pre) if (x.size() > 1) x.removeValue(v);
      return x;
    };
    const naive = make();
    const before = domainOf(naive);
    let naiveFailed = false;
    try {
      for (const v of values) naive.removeValue(v);
    } catch {
      naiveFailed = true;
    }
    const x = make();
    const label = JSON.stringify({ lo, hi, pre, values });
    if (naiveFailed) {
      assert.throws(() => x.removeValues(values), /CP solver failure: removeValues\(\)/, label);
      assert.deepEqual(domainOf(x), before, label);
    } else {
      x.removeValues(values);
      assert.deepEqual(domainOf(x), domainOf(naive), label);
    }
  }
});
