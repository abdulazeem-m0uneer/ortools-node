'use strict';
// The full JS SearchMonitor hook set (pywrapcp's SearchMonitor, camelCased) for
// synchronous classic CP searches: order, return values, throws, re-entrancy,
// interrupt() and worker termination.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { CpSolver, IntVarStrategy, IntValueStrategy } = require('..').cp;

const FIRST = IntVarStrategy.CHOOSE_FIRST_UNBOUND;
const MIN = IntValueStrategy.ASSIGN_MIN_VALUE;
const HOOKS = [
  'enterSearch', 'exitSearch', 'beginNextDecision', 'endNextDecision', 'applyDecision', 'refuteDecision',
  'afterDecision', 'beginFail', 'endFail', 'beginInitialPropagation', 'endInitialPropagation', 'acceptSolution',
  'atSolution', 'noMoreSolutions',
];

// x, y in [0, 2], x != y: 6 solutions, with failures.
function smallProgram() {
  const s = new CpSolver('hooks');
  const x = s.intVar(0, 2, 'x');
  const y = s.intVar(0, 2, 'y');
  s.add(x.ne(y));
  return { s, x, y, db: s.phase([x, y], FIRST, MIN) };
}

// x, y, z in [0, 1], pairwise different: infeasible, found only by failing.
function pigeonProgram() {
  const s = new CpSolver('pigeons');
  const v = ['x', 'y', 'z'].map((n) => s.intVar(0, 1, n));
  s.add(v[0].ne(v[1]));
  s.add(v[1].ne(v[2]));
  s.add(v[0].ne(v[2]));
  return { s, db: s.phase(v, FIRST, MIN) };
}

// A monitor recording every hook call as [name, ...args].
function recorder(overrides = {}) {
  const calls = [];
  const monitor = {};
  for (const name of HOOKS) {
    monitor[name] = (...args) => {
      calls.push([name, ...args]);
      return overrides[name] ? overrides[name](...args) : undefined;
    };
  }
  if (!overrides.atSolution) monitor.atSolution = () => { calls.push(['atSolution']); return true; };
  return { monitor, calls, names: () => calls.map((c) => c[0]) };
}

const count = (names, name) => names.filter((n) => n === name).length;

test('every hook fires in search order with decision descriptions', () => {
  const { s, db } = smallProgram();
  const { monitor, calls, names } = recorder();
  assert.equal(s.solve(db, [monitor]), true);
  const n = names();
  assert.equal(n[0], 'enterSearch');
  assert.equal(n.at(-1), 'exitSearch');
  assert.ok(n.indexOf('beginInitialPropagation') < n.indexOf('endInitialPropagation'));
  assert.ok(n.indexOf('endInitialPropagation') < n.indexOf('beginNextDecision'));
  assert.equal(count(n, 'atSolution'), 6);
  assert.equal(count(n, 'acceptSolution'), 6);
  assert.equal(count(n, 'noMoreSolutions'), 1);
  assert.equal(count(n, 'beginFail'), count(n, 'endFail'));
  assert.ok(count(n, 'beginFail') > 0);
  assert.equal(count(n, 'beginNextDecision'), count(n, 'endNextDecision'));
  for (const [name, ...args] of calls) {
    if (name === 'applyDecision' || name === 'refuteDecision') {
      assert.equal(args.length, 1);
      assert.match(args[0], /\S/, `${name} receives the decision description`);
    }
    if (name === 'endNextDecision') assert.ok(args[0] === null || typeof args[0] === 'string');
    if (name === 'afterDecision') {
      assert.equal(typeof args[0], 'string');
      assert.equal(typeof args[1], 'boolean');
    }
  }
  const applied = calls.filter((c) => c[0] === 'afterDecision' && c[2] === true).length;
  const refuted = calls.filter((c) => c[0] === 'afterDecision' && c[2] === false).length;
  assert.equal(applied, count(n, 'applyDecision'));
  assert.equal(refuted, count(n, 'refuteDecision'));
  // Descriptions are the decision's DebugString(), e.g. '[x(0..2) == 0] or [x(0..2) != 0]'.
  assert.match(calls.find((c) => c[0] === 'applyDecision')[1], /x.*== 0/);
});

test('an object with any single hook is a JS monitor', () => {
  for (const name of HOOKS) {
    const { s, db } = smallProgram();
    assert.equal(s.solve(db, [{ [name]() {} }]), true, name);
  }
});

test('a throwing acceptSolution rejects the solution: no collector records it', () => {
  const { s, db, x } = smallProgram();
  const first = s.firstSolutionCollector().add(x);
  assert.throws(() => s.solve(db, [first, { acceptSolution() { throw new Error('accept'); } }]), /accept/);
  assert.equal(first.solutionCount(), 0);
});

test('after any hook threw, the next solution is rejected: no collector records it', () => {
  const { s, db } = smallProgram();
  const all = s.allSolutionCollector();
  // endNextDecision(null) runs right before the first solution is accepted.
  const monitor = { endNextDecision(d) { if (d === null) throw new Error('boom'); } };
  assert.throws(() => s.solve(db, [all, monitor]), /boom/);
  assert.equal(all.solutionCount(), 0);
});

test('each hook property is read once per search, getters included', () => {
  const { s, db } = smallProgram();
  let reads = 0;
  const monitor = {};
  Object.defineProperty(monitor, 'atSolution', { get() { reads++; return () => true; } });
  s.solve(db, [monitor]);
  assert.equal(reads, 1);
});

test('hooks the API cannot trigger are not part of a JS monitor', () => {
  const { s, db } = smallProgram();
  for (const name of ['restartSearch', 'acceptNeighbor', 'periodicCheck']) {
    assert.throws(() => s.solve(db, [{ [name]() {} }]), /a monitor must be a SearchMonitor/, name);
  }
});

test('an object with only the new hooks is a JS monitor', () => {
  const { s, db } = smallProgram();
  let fails = 0;
  s.solve(db, [{ beginFail() { fails++; } }, s.allSolutionCollector()]);
  assert.ok(fails > 0);
});

test('acceptSolution returning false rejects the solution; other values accept it', () => {
  const { s, db, x, y } = smallProgram();
  const all = s.allSolutionCollector().add([x, y]);
  s.solve(db, [all, { acceptSolution: () => x.value() !== 1 }]);
  assert.equal(all.solutionCount(), 4);
  for (let i = 0; i < all.solutionCount(); i++) assert.notEqual(all.value(i, x), 1);
  s.solve(db, [all, { acceptSolution: () => undefined }]);
  assert.equal(all.solutionCount(), 6);
});

test('hooks run during newSearch / nextSolution and noMoreSolutions ends it', () => {
  const { s, db } = smallProgram();
  const { monitor, names } = recorder();
  s.newSearch(db, [monitor]);
  assert.equal(s.nextSolution(), true);
  assert.equal(count(names(), 'atSolution'), 1);
  let found = 1;
  while (s.nextSolution()) found++;
  assert.equal(found, 6);
  assert.equal(count(names(), 'noMoreSolutions'), 1);
  s.endSearch();
  assert.equal(names().at(-1), 'exitSearch');
});

for (const hook of ['beginFail', 'applyDecision', 'refuteDecision', 'acceptSolution', 'beginNextDecision',
  'endInitialPropagation']) {
  test(`a throw in ${hook} stops the search, no hook runs after it, and it is rethrown`, () => {
    const { s, db, x } = smallProgram();
    const boom = new Error(hook);
    const { monitor, names } = recorder({ [hook]: () => { throw boom; } });
    assert.throws(() => s.solve(db, [monitor]), (e) => e === boom);
    assert.equal(names().at(-1), hook, 'nothing is called after the throw, not even exitSearch');
    const all = s.allSolutionCollector().add(x);
    assert.equal(s.solve(db, [all, { beginFail() {} }]), true, 'the solver stays usable');
    assert.equal(all.solutionCount(), 6);
  });
}

test('a throw in a hook during nextSolution ends the search and is rethrown there', () => {
  const { s, db } = pigeonProgram();
  let exited = false;
  s.newSearch(db, [{ beginFail() { throw new Error('fail hook'); }, exitSearch() { exited = true; } }]);
  assert.throws(() => s.nextSolution(), /fail hook/);
  assert.throws(() => s.nextSolution(), /no search is open/);
  assert.equal(exited, false, 'no hook runs after a throw');
  assert.equal(s.solve(db), false, 'the solver stays usable');
});

test('hooks may read values but re-entrant searches and model changes are refused', () => {
  const { s, db, x } = smallProgram();
  const errors = {};
  const attempt = (name, fn) => { try { fn(); } catch (e) { errors[name] ??= e.message; } };
  s.solve(db, [{
    atSolution: () => true,
    applyDecision() {
      x.min();
      attempt('solve', () => s.solve(db));
      attempt('newSearch', () => s.newSearch(db));
      attempt('add', () => s.add(x.eq(1)));
      attempt('setMax', () => x.setMax(1));
    },
    beginFail() { attempt('nextSolution', () => s.nextSolution()); attempt('endSearch', () => s.endSearch()); },
  }]);
  assert.match(errors.solve, /while a search is open/);
  assert.match(errors.newSearch, /while a search is open/);
  assert.match(errors.add, /while a search is open/);
  assert.match(errors.setMax, /while a search is open/);
  assert.match(errors.nextSolution, /no search is open|cannot be called from a search monitor/);
  assert.match(errors.endSearch, /no search is open|cannot be called from a search monitor/);
});

test('a re-entrant call that throws out of a hook is rethrown after the search unwinds', () => {
  const { s, db } = smallProgram();
  assert.throws(() => s.solve(db, [{ beginNextDecision() { s.solve(db); } }]), /while a search is open/);
  assert.equal(s.solve(db), true);
});

test('interrupt() from a hook stops the search without an error', () => {
  const { s, db, x } = smallProgram();
  const all = s.allSolutionCollector().add(x);
  let decisions = 0;
  const found = s.solve(db, [all, { applyDecision() { if (++decisions === 3) s.interrupt(); } }]);
  assert.equal(typeof found, 'boolean');
  assert.ok(all.solutionCount() < 6);
  assert.equal(s.solve(db, [all]), true);
  assert.equal(all.solutionCount(), 6, 'the next search is not interrupted');
});

test('hooks are read once when the search starts', () => {
  const { s, db } = pigeonProgram();
  let original = 0;
  const monitor = { beginFail() { original++; } };
  s.newSearch(db, [monitor]);
  monitor.beginFail = () => { throw new Error('replaced hook must not run'); };
  assert.equal(s.nextSolution(), false);
  s.endSearch();
  assert.ok(original > 0);
});

test('a throwing hook getter is reported when the search starts', () => {
  const { s, db } = smallProgram();
  const monitor = { atSolution() {} };
  Object.defineProperty(monitor, 'beginFail', { get() { throw new Error('getter'); } });
  assert.throws(() => s.solve(db, [monitor]), /getter/);
  assert.equal(s.solve(db), true, 'nothing was left open');
});

test('a hook that is neither undefined nor a function is a TypeError naming it', () => {
  const { s, db } = smallProgram();
  const cases = [[{ atSolution: 42 }, 'atSolution'], [{ atSolution: null }, 'atSolution'],
    [{ beginNextDecision: 'x' }, 'beginNextDecision'], [{ atSolution() {}, beginFail: {} }, 'beginFail']];
  for (const [monitor, hook] of cases) {
    assert.throws(() => s.solve(db, [monitor]),
      (e) => e instanceof TypeError && e.message === `search monitor hook '${hook}' must be a function`);
    assert.throws(() => s.newSearch(db, [monitor]), TypeError);
  }
  assert.equal(s.solve(db), true, 'nothing was left open');
});

test('hook keys set to undefined make a monitor with no hooks', () => {
  const { s, db, x } = smallProgram();
  const all = s.allSolutionCollector().add(x);
  assert.equal(s.solve(db, [all, { atSolution: undefined }]), true);
  assert.equal(all.solutionCount(), 6);
});

test('solveAsync rejects JS monitors with only new hooks', () => {
  const { s, db } = smallProgram();
  assert.throws(() => s.solveAsync(db, [{ beginFail() {} }]), /not solveAsync/);
  assert.throws(() => s.solve(db, [{ beginfail() {} }]), /a monitor must be a SearchMonitor/);
});

test('terminating a worker inside a busy sync hook does not crash the process', async () => {
  const root = path.join(__dirname, '..');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { CpSolver } = require(workerData.root).cp;
    const s = new CpSolver();
    const p = Array.from({ length: 12 }, () => s.intVar(0, 10));
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) s.add(p[i].ne(p[j]));
    let sent = false;
    s.solve(s.phase(p, 'CHOOSE_FIRST_UNBOUND', 'ASSIGN_MIN_VALUE'), [{
      beginFail() { if (!sent) { sent = true; parentPort.postMessage('solving'); } },
    }]);
    parentPort.postMessage('finished');
  `, { eval: true, workerData: { root } });
  const first = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  assert.equal(first, 'solving');
  assert.equal(await worker.terminate(), 1);
});

test('hooks called tens of thousands of times in one solve() do not exhaust handles', () => {
  const n = 9;  // 9 pigeons, 8 holes: 80640 failures
  const s = new CpSolver('volume');
  const p = Array.from({ length: n }, () => s.intVar(0, n - 2));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) s.add(p[i].ne(p[j]));
  let fails = 0;
  let applied = 0;
  assert.equal(s.solve(s.phase(p, FIRST, MIN), [{ beginFail() { fails++; }, applyDecision() { applied++; } }]), false);
  assert.equal(fails, s.failures());
  assert.ok(applied > 0);
});
