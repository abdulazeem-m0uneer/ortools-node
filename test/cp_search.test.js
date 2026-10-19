'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CpSolver, IntVarStrategy, IntValueStrategy } = require('..').cp;

const FIRST = IntVarStrategy.CHOOSE_FIRST_UNBOUND;
const MIN = IntValueStrategy.ASSIGN_MIN_VALUE;

// pywrapcp's simple_cp_program: x, y, z in [0, 2], x != y -> 18 solutions.
function simpleProgram() {
  const s = new CpSolver('simple');
  const [x, y, z] = ['x', 'y', 'z'].map((n) => s.intVar(0, 2, n));
  s.add(x.ne(y));
  return { s, x, y, z, db: s.phase([x, y, z], FIRST, MIN) };
}

function queens(n) {
  const s = new CpSolver(`queens${n}`);
  const q = Array.from({ length: n }, (_, i) => s.intVar(0, n - 1, `q${i}`));
  s.add(s.allDifferent(q));
  s.add(s.allDifferent(q.map((v, i) => v.plus(i).var())));
  s.add(s.allDifferent(q.map((v, i) => v.minus(i).var())));
  return { s, q, db: s.phase(q, IntVarStrategy.CHOOSE_MIN_SIZE_LOWEST_MIN, MIN) };
}

test('newSearch / nextSolution iterates every solution, values readable at each', () => {
  const { s, x, y, z, db } = simpleProgram();
  s.newSearch(db);
  const seen = [];
  while (s.nextSolution()) seen.push([x.value(), y.value(), z.value()]);
  s.endSearch();
  assert.equal(seen.length, 18);
  assert.ok(seen.every(([a, b]) => a !== b));
  assert.deepEqual(seen[0], [0, 1, 0]);
  assert.equal(s.solutions(), 18);
  assert.ok(s.branches() > 0);
  assert.ok(s.wallTime() >= 0);
  assert.equal(typeof s.failures(), 'number');
  // Outside the search the variables are free again.
  assert.equal(x.bound(), false);
  assert.throws(() => x.value(), /not bound/);
});

test('SEND + MORE = MONEY has the known unique solution', () => {
  const s = new CpSolver('money');
  const L = Object.fromEntries('SENDMORY'.split('').map((c) => [c, s.intVar(0, 9, c)]));
  const letters = Object.values(L);
  s.add(s.allDifferent(letters));
  s.add(L.S.ne(0));
  s.add(L.M.ne(0));
  const send = s.scalProd([L.S, L.E, L.N, L.D], [1000, 100, 10, 1]);
  const more = s.scalProd([L.M, L.O, L.R, L.E], [1000, 100, 10, 1]);
  const money = s.scalProd([L.M, L.O, L.N, L.E, L.Y], [10000, 1000, 100, 10, 1]);
  s.add(send.plus(more).eq(money));
  const all = s.allSolutionCollector().add(letters);
  assert.equal(s.solve(s.phase(letters, FIRST, MIN), [all]), true);
  assert.equal(all.solutionCount(), 1);
  const value = Object.fromEntries(Object.entries(L).map(([c, v]) => [c, all.value(0, v)]));
  assert.deepEqual(value, { S: 9, E: 5, N: 6, D: 7, M: 1, O: 0, R: 8, Y: 2 });
  assert.ok(all.wallTime(0) >= 0);
  assert.ok(all.branches(0) >= 0);
  assert.ok(all.failures(0) >= 0);
});

test('8 queens has 92 solutions', () => {
  const { s, q, db } = queens(8);
  const all = s.allSolutionCollector().add(q);
  assert.equal(s.solve(db, [all]), true);
  assert.equal(all.solutionCount(), 92);
  for (let n = 0; n < 92; n++) {
    const row = q.map((v) => all.value(n, v));
    assert.equal(new Set(row).size, 8);
  }
});

test('minimize with best-value and last-solution collectors finds the optimum', () => {
  const s = new CpSolver('opt');
  const x = s.intVar(0, 10, 'x');
  const y = s.intVar(0, 10, 'y');
  s.add(x.plus(y.times(2)).ge(7));
  const cost = x.times(3).plus(y.times(2)).var();
  const best = s.bestValueSolutionCollector(false).add([x, y]).addObjective(cost);
  const last = s.lastSolutionCollector().add([x, y, cost]).addObjective(cost);
  const first = s.firstSolutionCollector().add([x, y]);
  assert.equal(s.solve(s.phase([x, y], FIRST, MIN), [s.minimize(cost, 1), best, last, first]), true);
  // 3x + 2y with x + 2y >= 7: y = 4, x = 0 -> 8 (y = 3.5 is not integral).
  assert.equal(best.objectiveValue(0), 8);
  assert.equal(last.objectiveValue(0), 8);
  assert.equal(last.value(0, cost), 8);
  assert.deepEqual([best.value(0, x), best.value(0, y)], [0, 4]);
  assert.equal(first.solutionCount(), 1);
  assert.throws(() => first.objectiveValue(0), /no objective/);
  assert.throws(() => best.value(1, x), RangeError);
  assert.throws(() => best.value(0, cost), /not added/);
  assert.throws(() => best.value(0, x.plus(1)), TypeError);
  assert.throws(() => best.addObjective(cost), /already has an objective/);
});

test('maximize with a step', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 20, 'x');
  s.add(s.memberCt(x, [1, 4, 9, 16]));
  const best = s.bestValueSolutionCollector(true).add(x).addObjective(x);
  assert.equal(s.solve(s.phase([x], FIRST, MIN), [s.maximize(x, 1), best]), true);
  assert.equal(best.value(0, x), 16);
});

test('a best-value collector without an objective is rejected before searching', () => {
  const { s, db, x } = simpleProgram();
  const best = s.bestValueSolutionCollector(false).add(x);
  assert.throws(() => s.solve(db, [best]), /needs addObjective/);
  assert.throws(() => s.newSearch(db, [best]), /needs addObjective/);
});

test('allowedAssignments, membership and reified constraints', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 5, 'x');
  const y = s.intVar(0, 5, 'y');
  s.add(s.allowedAssignments([x, y], [[1, 2], [3, 4], [5, 0], [9, 9]]));
  s.add(s.notMemberCt(x, [3]));
  const isOne = s.isEqualVar(x, 1);
  const bigger = s.isGreaterVar(x, y);
  const all = s.allSolutionCollector().add([x, y, isOne, bigger]);
  s.solve(s.phase([x, y], FIRST, MIN), [all]);
  const rows = Array.from({ length: all.solutionCount() }, (_, n) =>
    [x, y, isOne, bigger].map((v) => all.value(n, v)));
  assert.deepEqual(rows, [[1, 2, 1, 0], [5, 0, 0, 1]]);
});

test('every reified comparison and isMemberVar', () => {
  const s = new CpSolver();
  const x = s.intVar(2, 2, 'x');
  const y = s.intVar(3, 3, 'y');
  const flags = [
    s.isEqualVar(x, y), s.isDifferentVar(x, 2), s.isLessOrEqualVar(x, y), s.isLessVar(y, x),
    s.isGreaterOrEqualVar(x, 2), s.isGreaterVar(y, 2), s.isMemberVar(x, [1, 2]),
  ];
  const first = s.firstSolutionCollector().add(flags);
  assert.equal(s.solve(s.phase(flags, FIRST, MIN), [first]), true);
  assert.deepEqual(flags.map((f) => first.value(0, f)), [0, 0, 1, 0, 1, 1, 1]);
});

test('reified strict comparisons at the int64 limits do not overflow', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 10, 'x');
  const flags = [s.isLessVar(x, -(2n ** 63n)), s.isGreaterVar(x, 2n ** 63n - 1n),
    s.isLessVar(x, s.intConst(-(2n ** 63n)))];
  const first = s.firstSolutionCollector().add(flags);
  assert.equal(s.solve(s.phase([x, ...flags], FIRST, MIN), [first]), true);
  assert.deepEqual(flags.map((f) => first.value(0, f)), [0, 0, 0]);
});

test('element constraint selects by index', () => {
  const s = new CpSolver();
  const i = s.intVar(0, 3, 'i');
  s.add(s.element([7, 3, 9, 3], i).eq(3));
  const all = s.allSolutionCollector().add(i);
  s.solve(s.phase([i], FIRST, MIN), [all]);
  assert.deepEqual([0, 1].map((n) => all.value(n, i)), [1, 3]);
});

test('comparisons between expressions and constants', () => {
  const s = new CpSolver();
  const x = s.intVar(0, 9, 'x');
  const y = s.intVar(0, 9, 'y');
  for (const ct of [x.lt(y), y.le(4), x.ge(2), y.gt(x.plus(1)), x.eq(x)]) s.add(ct);
  const all = s.allSolutionCollector().add([x, y]);
  s.solve(s.phase([x, y], FIRST, MIN), [all]);
  assert.deepEqual(Array.from({ length: all.solutionCount() }, (_, n) => [all.value(n, x), all.value(n, y)]),
    [[2, 4]]);
});

test('compose runs decision builders in order', () => {
  const { s, x, y, z } = simpleProgram();
  const db = s.compose(s.phase([z], FIRST, IntValueStrategy.ASSIGN_MAX_VALUE), s.phase([x, y], FIRST, MIN));
  const first = s.firstSolutionCollector().add([x, y, z]);
  s.solve(db, [first]);
  assert.deepEqual([x, y, z].map((v) => first.value(0, v)), [0, 1, 2]);
  assert.throws(() => s.compose([]), /at least one/);
});

test('search limits stop the search deterministically', () => {
  const { s, db, x } = simpleProgram();
  const all = s.allSolutionCollector().add(x);
  s.solve(db, [all, s.solutionsLimit(3)]);
  assert.equal(all.solutionCount(), 3);
  s.solve(db, [all, s.limit({ solutions: 5, branches: 1000 })]);
  assert.equal(all.solutionCount(), 5);
});

// Each limit must be what ends the search: 8 queens has 92 solutions, so a
// search that ignored its limit would collect all of them.
test('failure, branch and time limits stop a feasible search early', () => {
  const runs = [
    ['failuresLimit', (s) => s.failuresLimit(10), (s) => s.failures() <= 12],
    ['branchesLimit', (s) => s.branchesLimit(20), (s) => s.branches() <= 22],
    ['timeLimit', (s) => s.timeLimit(0), () => true],
  ];
  const full = queens(8);
  const everything = full.s.allSolutionCollector().add(full.q);
  full.s.solve(full.db, [everything]);
  assert.equal(everything.solutionCount(), 92);
  for (const [name, limit, withinLimit] of runs) {
    const { s, q, db } = queens(8);
    const all = s.allSolutionCollector().add(q);
    s.solve(db, [all, limit(s)]);
    assert.ok(all.solutionCount() < 92, `${name}: ${all.solutionCount()} solutions, the limit did not stop the search`);
    assert.ok(withinLimit(s), `${name}: ${s.failures()} failures, ${s.branches()} branches`);
  }
});

test('searchLog is accepted as a monitor', () => {
  const { s, db, x } = simpleProgram();
  assert.equal(s.solve(db, [s.searchLog(1000), s.searchLog(1000, x)]), true);
});

test('JS monitors: enter/exit once, atSolution per solution', () => {
  const { s, db } = simpleProgram();
  const events = [];
  const monitor = {
    enterSearch: () => events.push('enter'),
    exitSearch: () => events.push('exit'),
    atSolution: () => { events.push('sol'); return true; },
  };
  assert.equal(s.solve(db, [monitor]), true);
  assert.equal(events[0], 'enter');
  assert.equal(events.at(-1), 'exit');
  assert.equal(events.filter((e) => e === 'sol').length, 18);
});

test('JS monitor atSolution returning false stops the search', () => {
  const { s, db, x } = simpleProgram();
  const all = s.allSolutionCollector().add(x);
  let calls = 0;
  const stopper = { atSolution() { calls++; return calls < 4 ? true : false; } };
  s.solve(db, [all, stopper]);
  assert.equal(calls, 4);
  assert.equal(all.solutionCount(), 4);
  // The next search is not affected (the all-solution collector asks for more).
  s.solve(db, [all]);
  assert.equal(all.solutionCount(), 18);
  const first = s.firstSolutionCollector().add(x);
  s.solve(db, [first, { atSolution() {} }]);
  assert.equal(first.solutionCount(), 1, 'undefined leaves the decision to the other monitors');
});

test('JS monitors may read values but not change the model', () => {
  const { s, db, x, y } = simpleProgram();
  const read = [];
  let mutationError;
  s.solve(db, [{
    atSolution() {
      read.push(x.value() + 10 * y.value());
      try { s.intVar(0, 1); } catch (e) { mutationError = e; }
      return false;
    },
  }]);
  assert.deepEqual(read, [10]);
  assert.match(mutationError.message, /while a search is open/);
});

test('a throw in atSolution finishes the search and is rethrown; the solver stays usable', () => {
  const { s, db, x } = simpleProgram();
  const boom = new Error('boom');
  let calls = 0;
  assert.throws(() => s.solve(db, [{ atSolution() { calls++; throw boom; } }, s.minimize(x, 1)]), (e) => e === boom);
  assert.equal(calls, 1);
  const all = s.allSolutionCollector().add(x);
  assert.equal(s.solve(db, [all, { atSolution: () => true }]), true);
  assert.equal(all.solutionCount(), 18);
});

test('non-Error throws are rethrown as-is', () => {
  const { s, db } = simpleProgram();
  assert.throws(() => s.solve(db, [{ enterSearch() { throw 'plain'; } }]), (e) => e === 'plain');
});

test('starting a search from a monitor is refused', () => {
  const { s, db } = simpleProgram();
  assert.throws(() => s.solve(db, [{ atSolution() { s.solve(db); } }]), /while a search is open/);
  s.newSearch(db, [{ atSolution() { s.nextSolution(); } }]);
  assert.throws(() => s.nextSolution(), /cannot be called from a search monitor/);
  assert.throws(() => s.nextSolution(), /no search is open/);
});

test('enterSearch / exitSearch throws surface on nextSolution / endSearch', () => {
  const { s, db } = simpleProgram();
  s.newSearch(db, [{ enterSearch() { throw new Error('enter'); } }]);
  assert.throws(() => s.nextSolution(), /enter/);
  s.newSearch(db, [{ exitSearch() { throw new Error('exit'); } }]);
  assert.equal(s.nextSolution(), true);
  assert.throws(() => s.endSearch(), /exit/);
  assert.throws(() => s.endSearch(), /no search is open/);
});

test('the model cannot change while a newSearch is open', () => {
  const { s, db, x } = simpleProgram();
  s.newSearch(db);
  assert.equal(s.nextSolution(), true);
  assert.throws(() => s.add(x.eq(1)), /while a search is open/);
  assert.throws(() => x.setMax(1), /while a search is open/);
  assert.throws(() => s.intVar(0, 1), /while a search is open/);
  assert.throws(() => s.newSearch(db), /while a search is open/);
  assert.throws(() => s.dispose(), /while a search is open/);
  s.endSearch();
  s.add(x.eq(1));
  assert.throws(() => s.endSearch(), /no search is open/);
});

test('interrupt() stops an open newSearch', () => {
  const { s, db } = simpleProgram();
  s.newSearch(db);
  assert.equal(s.nextSolution(), true);
  assert.equal(s.interrupt(), true);
  assert.equal(s.nextSolution(), false);
  s.endSearch();
  assert.equal(s.interrupt(), false);
});

test('solveAsync runs on the threadpool and fills collectors', async () => {
  const { s, q, db } = queens(8);
  const all = s.allSolutionCollector().add(q);
  const pending = s.solveAsync(db, [all]);
  assert.equal(s.busy, true);
  assert.throws(() => s.intVar(0, 1), /busy/);
  assert.throws(() => all.solutionCount(), /busy/);
  assert.throws(() => s.solveAsync(db), /busy/);
  assert.throws(() => s.dispose(), /busy/);
  assert.equal(await pending, true);
  assert.equal(s.busy, false);
  assert.equal(all.solutionCount(), 92);
});

test('solveAsync rejects JS monitors', () => {
  const { s, db } = simpleProgram();
  assert.throws(() => s.solveAsync(db, [{ atSolution() {} }]), /JS search monitors/);
  assert.throws(() => s.solve(db, [{}]), /a monitor must be/);
  assert.throws(() => s.solve(db, 'x'), /must be an array/);
});

// 13 queens has 73712 solutions and takes seconds to enumerate: the interrupt
// must end it early, and a lost interrupt fails on the timeout instead of hanging.
test('interrupt() stops a running solveAsync', { timeout: 15000 }, async () => {
  const { s, q, db } = queens(13);
  const all = s.allSolutionCollector().add(q);
  const pending = s.solveAsync(db, [all]);
  assert.equal(s.interrupt(), true);
  await pending;
  assert.ok(all.solutionCount() < 73712, `${all.solutionCount()} solutions: the interrupt did not stop the search`);
  assert.equal(s.interrupt(), false);
});

test('concurrent solveAsync calls on separate solvers', async () => {
  const runs = [6, 7, 8].map((n) => {
    const { s, q, db } = queens(n);
    const all = s.allSolutionCollector().add(q);
    return s.solveAsync(db, [all]).then(() => all.solutionCount());
  });
  assert.deepEqual(await Promise.all(runs), [4, 40, 92]);
});
